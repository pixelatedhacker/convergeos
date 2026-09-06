import type { IsoDateTime, MeshArtifactReference } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import type { OrchestrationEventStoreError } from "../persistence/Errors.ts";
import { forkParked } from "../serverActivation.ts";
import {
  readMeshReceiptExportConfig,
  meshRelayDestinationDigest,
  type MeshReceiptExportConfig,
} from "./MeshReceiptConfig.ts";
import { MeshReceiptExportStore, MeshReceiptExportStoreError } from "./MeshReceiptExportStore.ts";
import { MeshReceiptSigner } from "./MeshReceiptSigner.ts";
import { NostrRelay } from "./NostrRelay.ts";
import { mapSourceEventToDraft, type MeshReceiptDraft } from "./receiptMapping.ts";

/**
 * Publishes signed agent-mesh receipts from a durable outbox.
 *
 * Capture replays committed source events through a durable cursor — live
 * notifications only wake the worker; replay provides recovery. Signing,
 * outbox insert, stream-sequence allocation, and cursor advance happen in one
 * local transaction, so a crash at any point replays into the same logical
 * receipt. Publication resends the stored signed bytes until the relay
 * acknowledges them. Local execution never waits for the relay: every failure
 * here retries with backoff or retains a visible rejection reason.
 */
/** Everything one sweep can fail with. The background loop recovers from all
    of it with backoff and logging; local execution is never blocked. */
export type MeshReceiptExportSweepError =
  | MeshReceiptExportStoreError
  | OrchestrationEventStoreError
  | PlatformError.PlatformError;

export class MeshReceiptExportReactor extends Context.Service<
  MeshReceiptExportReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
    readonly sweep: () => Effect.Effect<{ readonly captured: number }, MeshReceiptExportSweepError>;
  }
>()("t3/mesh/MeshReceiptExportReactor") {}

const CAPTURE_BATCH_SIZE = 100;
const MAX_IN_FLIGHT_PUBLICATIONS = 4;
const SWEEP_INTERVAL_SECONDS = 15;
const MAX_RETRY_BACKOFF_SECONDS = 60;

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const eventStore = yield* OrchestrationEventStore;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const store = yield* MeshReceiptExportStore;
  const signer = yield* MeshReceiptSigner;
  const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  const relay = yield* NostrRelay;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const captureNext = Effect.fn("MeshReceiptExportReactor.captureNext")(function* (
    state: {
      readonly exportEpoch: string;
      readonly cursorSequence: number;
      readonly quotaBytes: number;
    },
    config: MeshReceiptExportConfig,
    at: IsoDateTime,
  ) {
    const pending = yield* store.pendingBytes;
    if (pending >= config.quotaBytes) {
      yield* Effect.logWarning("mesh receipt export paused: outbox backlog reached its quota", {
        pendingBytes: pending,
        quotaBytes: config.quotaBytes,
      });
      return { captured: 0, advanced: false };
    }
    const batch = yield* Stream.runCollect(
      eventStore.readFromSequence(state.cursorSequence, CAPTURE_BATCH_SIZE),
    ).pipe(Effect.map((chunk) => Array.from(chunk)));
    if (batch.length === 0) return { captured: 0, advanced: false };
    const cursorTo = batch[batch.length - 1]!.sequence;

    const drafts: Array<MeshReceiptDraft> = [];
    const artifacts: Array<{ reference: MeshArtifactReference; content: string }> = [];
    for (const event of batch) {
      const mapped = yield* mapSourceEventToDraft(event, environmentId, signer.keyId, store);
      if (mapped === null) continue;
      drafts.push(mapped.draft);
      if (mapped.artifact !== null) artifacts.push(mapped.artifact);
    }

    const result = yield* store.captureBatch({
      exportEpoch: state.exportEpoch,
      cursorFrom: state.cursorSequence,
      cursorTo,
      at,
      drafts,
      artifacts,
      signer,
    });
    return { captured: result.captured, advanced: cursorTo > state.cursorSequence };
  });

  const backoffSecondsFor = (attempts: number) =>
    Math.min(MAX_RETRY_BACKOFF_SECONDS, 2 ** Math.min(attempts, 6));

  const publishOne = Effect.fn("MeshReceiptExportReactor.publishOne")(function* (
    relayUrl: string,
    row: { readonly nostrEventId: string; readonly eventJson: string; readonly attempts: number },
  ) {
    const outcome = yield* relay.publish(relayUrl, row.eventJson);
    switch (outcome._tag) {
      case "Accepted":
        yield* store.markAccepted({ nostrEventId: row.nostrEventId });
        return;
      case "Rejected":
        // Retained with a visible reason; an explicit re-publish path can
        // reset it later. Relay rejection is never a local failure.
        yield* store.markRejected({ nostrEventId: row.nostrEventId, reason: outcome.reason });
        return;
      case "Transient": {
        const nextAttemptAt = DateTime.formatIso(
          DateTime.add(yield* DateTime.now, {
            milliseconds: backoffSecondsFor(row.attempts) * 1_000,
          }),
        );
        yield* store.markRetry({ nostrEventId: row.nostrEventId, nextAttemptAt });
        return;
      }
    }
  });

  const publishDue = Effect.fn("MeshReceiptExportReactor.publishDue")(function* (
    relayUrl: string,
    now: IsoDateTime,
  ) {
    const rows = yield* store.listDuePending({
      now,
      destinationDigest: meshRelayDestinationDigest(relayUrl),
      limit: MAX_IN_FLIGHT_PUBLICATIONS,
    });
    yield* Effect.forEach(rows, (row) => publishOne(relayUrl, row), {
      concurrency: MAX_IN_FLIGHT_PUBLICATIONS,
      discard: true,
    });
    return rows.length;
  });

  const sweep: MeshReceiptExportReactor["Service"]["sweep"] = Effect.fn(
    "MeshReceiptExportReactor.sweep",
  )(function* () {
    let captured = 0;
    while (true) {
      const config = yield* readMeshReceiptExportConfig(secrets);
      if (!config.enabled || config.relayUrl === null) return { captured };
      const state = yield* store.readExportState;
      if (
        state === null ||
        state.status !== "active" ||
        state.destinationDigest !== meshRelayDestinationDigest(config.relayUrl)
      )
        return { captured };
      const capture = yield* captureNext(state, config, yield* nowIso);
      captured += capture.captured;
      const published = yield* publishDue(config.relayUrl, yield* nowIso);
      if (!capture.advanced && published === 0) return { captured };
      yield* Effect.yieldNow;
    }
  });

  const runSweep = sweep().pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("mesh receipt export sweep failed", { cause: Cause.pretty(cause) }),
    ),
  );
  const wakePending = yield* Ref.make(false);
  const worker = yield* makeDrainableWorker(() =>
    Effect.gen(function* () {
      yield* Ref.set(wakePending, false);
      yield* runSweep;
    }),
  );

  const start: MeshReceiptExportReactor["Service"]["start"] = Effect.fn(
    "MeshReceiptExportReactor.start",
  )(function* () {
    const at = yield* nowIso;
    yield* store
      .enrollKey({
        keyId: signer.keyId,
        environmentId,
        publicKeyHex: signer.publicKeyHex,
        at,
      })
      .pipe(Effect.catch((cause) => Effect.logWarning("mesh signer enrollment failed", { cause })));

    yield* forkParked(
      Effect.gen(function* () {
        const domainEvents = yield* engine.subscribeDomainEvents;
        yield* Stream.runForEach(domainEvents, () =>
          Ref.getAndSet(wakePending, true).pipe(
            Effect.flatMap((wasPending) => (wasPending ? Effect.void : worker.enqueue(undefined))),
          ),
        );
      }),
    );

    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue(undefined);
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced(`${SWEEP_INTERVAL_SECONDS} seconds`)), Effect.asVoid),
    );
  });

  return {
    start,
    drain: worker.drain,
    sweep,
  } satisfies MeshReceiptExportReactor["Service"];
});

export const layer = Layer.effect(MeshReceiptExportReactor, make);
