import {
  DelegationId,
  EnvironmentId,
  EventId,
  MeshReceipt,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as PubSub from "effect/PubSub";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  meshRelayDestinationDigest,
  MESH_RECEIPT_EXPORT_ENABLED_SECRET,
  MESH_RECEIPT_QUOTA_BYTES_SECRET,
  MESH_RECEIPT_RELAY_URL_SECRET,
} from "./MeshReceiptConfig.ts";
import * as MeshReceiptExportReactor from "./MeshReceiptExportReactor.ts";
import * as MeshReceiptExportStore from "./MeshReceiptExportStore.ts";
import * as MeshReceiptSigner from "./MeshReceiptSigner.ts";
import { NostrRelay, type NostrPublishOutcome } from "./NostrRelay.ts";
import { decodeMeshReceiptContent, verifyNostrEvent } from "./nostr.ts";

const ENVIRONMENT_ID = EnvironmentId.make("env-test");

const stringToBytes = (value: string) => new TextEncoder().encode(value);

/** Relay behavior shared with the layer below. Tests flip the mode before a
    sweep; the fake answers with the corresponding NIP-01 outcome. The suite
    shares one database across its tests, so every test works on its own
    project/thread/delegation id prefix and resets the relay mode. */
const relayBehavior: {
  mode: "accept" | "transient" | "reject";
  seen: ReadonlyArray<string>;
  reset: () => void;
} = {
  mode: "accept",
  seen: [],
  reset: () => {
    relayBehavior.mode = "accept";
    relayBehavior.seen = [];
  },
};

const relayLayer = Layer.succeed(NostrRelay, {
  publish: (_relayUrl: string, eventJson: string) =>
    Effect.sync(() => {
      relayBehavior.seen = [...relayBehavior.seen, eventJson];
      const outcome: NostrPublishOutcome =
        relayBehavior.mode === "accept"
          ? { _tag: "Accepted" }
          : relayBehavior.mode === "reject"
            ? { _tag: "Rejected", reason: "invalid: nope" }
            : { _tag: "Transient", reason: "relay unreachable" };
      return outcome;
    }),
} satisfies NostrRelay["Service"]);

/** The stub engine reports the persisted watermark from the event store, so
    enable and re-enable semantics behave like production without the full
    orchestration stack. */
const engineLayer = Layer.effect(
  OrchestrationEngine.OrchestrationEngineService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const latestSequence = sql<{ readonly max: number }>`
      SELECT COALESCE(MAX(sequence), 0) AS max FROM orchestration_events
    `.pipe(
      Effect.map((rows) => rows[0]?.max ?? 0),
      Effect.orDie,
    );
    return OrchestrationEngine.OrchestrationEngineService.of({
      readEvents: () => Stream.empty,
      readThreadEvents: () => Stream.empty,
      getThreadReplayStats: () => Effect.die("thread replay stats are not stubbed in this test"),
      dispatch: () => Effect.die("dispatch is not stubbed in this test"),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
      latestSequence,
    });
  }),
);

const identityLayer = Layer.succeed(ServerEnvironmentIdentity, {
  getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
});

const layer = it.layer(
  Layer.empty.pipe(
    Layer.provideMerge(MeshReceiptExportReactor.layer),
    Layer.provideMerge(MeshReceiptExportStore.layer),
    Layer.provideMerge(MeshReceiptSigner.layer),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "mesh-receipt-test" })),
    Layer.provideMerge(identityLayer),
    Layer.provideMerge(engineLayer),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(relayLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

interface TestIds {
  readonly project: ProjectId;
  readonly requester: ThreadId;
  readonly worker: ThreadId;
  readonly delegationId: DelegationId;
}

const makeIds = (prefix: string): TestIds => ({
  project: ProjectId.make(`project-${prefix}`),
  requester: ThreadId.make(`thread-a-${prefix}`),
  worker: ThreadId.make(`thread-b-${prefix}`),
  delegationId: DelegationId.make(`agent-mesh:9:thread-a-${prefix}:req-1`),
});

const seedThreadRow = (threadId: ThreadId, projectId: ProjectId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT OR IGNORE INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
      VALUES (${threadId}, ${projectId}, 'Thread', '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z')
    `;
  });

const enableExport = (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  options: { quotaBytes?: string; relayUrl?: string } = {},
) =>
  Effect.gen(function* () {
    const store = yield* MeshReceiptExportStore.MeshReceiptExportStore;
    const crypto = yield* Crypto.Crypto;
    const relayUrl = options.relayUrl ?? "wss://relay.test";
    yield* secrets.set(MESH_RECEIPT_RELAY_URL_SECRET, stringToBytes(relayUrl));
    yield* secrets.set(MESH_RECEIPT_EXPORT_ENABLED_SECRET, stringToBytes("true"));
    if (options.quotaBytes !== undefined) {
      yield* secrets.set(MESH_RECEIPT_QUOTA_BYTES_SECRET, stringToBytes(options.quotaBytes));
    }
    yield* store.enableExport({
      exportEpoch: yield* crypto.randomUUIDv4,
      destinationDigest: meshRelayDestinationDigest(relayUrl),
      startWatermark: yield* store.latestSourceSequence,
      quotaBytes: Number(options.quotaBytes ?? 8 * 1024 * 1024),
      at: DateTime.formatIso(yield* DateTime.now),
    });
  });

const disableExport = (secrets: ServerSecretStore.ServerSecretStore["Service"]) =>
  Effect.gen(function* () {
    const store = yield* MeshReceiptExportStore.MeshReceiptExportStore;
    yield* secrets.remove(MESH_RECEIPT_EXPORT_ENABLED_SECRET);
    yield* store.disableExport({
      stopWatermark: yield* store.latestSourceSequence,
      at: DateTime.formatIso(yield* DateTime.now),
    });
  });

const event = (
  id: string,
  aggregateKind: OrchestrationEvent["aggregateKind"],
  aggregateId: string,
  type: OrchestrationEvent["type"],
  payload: unknown,
  occurredAt = "2026-09-05T00:00:01.000Z",
) => ({
  eventId: EventId.make(id),
  aggregateKind,
  aggregateId: aggregateId as never,
  type,
  occurredAt,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  payload: payload as never,
});

const delegationPayload = (
  ids: TestIds,
  state: "requested" | "completed" | "failed" | "interrupted",
  turnId: string | null,
) => ({
  delegation: {
    id: ids.delegationId,
    projectId: ids.project,
    requester: { kind: "thread", threadId: ids.requester, requestId: "req-1" },
    target: { kind: "existingThread", threadId: ids.worker },
    title: "Audit the mesh",
    task: "Please audit.",
    state,
    targetThreadId: ids.worker,
    turnId,
    assistantMessageId: null,
    failure: null,
    revision: state === "requested" ? 1 : 2,
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:05.000Z",
  },
});

/** The full delegated-turn story for one prefix: lifecycle noise, delegation
    accepted, worker turn requested, final assistant output, terminal. */
const appendDelegatedTurnStory = (eventStore: OrchestrationEventStore["Service"], ids: TestIds) =>
  Effect.gen(function* () {
    yield* seedThreadRow(ids.worker, ids.project);
    yield* eventStore.append(
      event(`${ids.project}-noise`, "thread", ids.worker, "thread.meta-updated", {
        threadId: ids.worker,
        title: "x",
        updatedAt: "2026-09-05T00:00:00.000Z",
      }),
    );
    yield* eventStore.append(
      event(
        `${ids.project}-accepted`,
        "delegation",
        ids.delegationId,
        "delegation.requested",
        delegationPayload(ids, "requested", null),
        "2026-09-05T00:00:01.000Z",
      ),
    );
    yield* eventStore.append(
      event(
        `${ids.project}-turn-start`,
        "thread",
        ids.worker,
        "thread.turn-start-requested",
        {
          threadId: ids.worker,
          messageId: MessageId.make(`message-1-${ids.project}`),
          createdAt: "2026-09-05T00:00:02.000Z",
        },
        "2026-09-05T00:00:02.000Z",
      ),
    );
    yield* eventStore.append(
      event(
        `${ids.project}-assistant`,
        "thread",
        ids.worker,
        "thread.message-sent",
        {
          threadId: ids.worker,
          messageId: MessageId.make(`message-2-${ids.project}`),
          role: "assistant",
          text: "Audit complete.",
          turnId: TurnId.make(`turn-1-${ids.project}`),
          streaming: true,
          createdAt: "2026-09-05T00:00:03.000Z",
          updatedAt: "2026-09-05T00:00:03.000Z",
        },
        "2026-09-05T00:00:03.000Z",
      ),
    );
    yield* eventStore.append(
      event(`${ids.project}-assistant-complete`, "thread", ids.worker, "thread.message-sent", {
        threadId: ids.worker,
        messageId: MessageId.make(`message-2-${ids.project}`),
        role: "assistant",
        text: "",
        turnId: TurnId.make(`turn-1-${ids.project}`),
        streaming: false,
        createdAt: "2026-09-05T00:00:03.000Z",
        updatedAt: "2026-09-05T00:00:03.000Z",
      }),
    );
    yield* eventStore.append(
      event(
        `${ids.project}-terminal`,
        "delegation",
        ids.delegationId,
        "delegation.completed",
        delegationPayload(ids, "completed", TurnId.make(`turn-1-${ids.project}`)),
        "2026-09-05T00:00:04.000Z",
      ),
    );
  });

const readOutbox = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly exportEpoch: string;
    readonly streamId: string;
    readonly streamSequence: number;
    readonly receiptType: string;
    readonly sourceEventId: string;
    readonly status: string;
    readonly attempts: number;
    readonly nextAttemptAt: string | null;
    readonly rejectionReason: string | null;
    readonly eventJson: string;
  }>`
    SELECT export_epoch AS "exportEpoch", stream_id AS "streamId", stream_sequence AS "streamSequence",
           receipt_type AS "receiptType", source_event_id AS "sourceEventId", status, attempts,
           next_attempt_at AS "nextAttemptAt", rejection_reason AS "rejectionReason",
           event_json AS "eventJson"
    FROM mesh_receipt_outbox ORDER BY export_epoch, stream_id, stream_sequence
  `;
});

const readExportState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly status: string;
    readonly exportEpoch: string;
    readonly cursorSequence: number;
    readonly stopWatermark: number | null;
  }>`
    SELECT status, export_epoch AS "exportEpoch", cursor_sequence AS "cursorSequence",
           stop_watermark AS "stopWatermark"
    FROM mesh_export_state WHERE id = 1
  `;
  return rows[0] ?? null;
});

describe("MeshReceiptExport", () => {
  layer("signer", (it) => {
    it.effect("keeps one stable environment-owned signing key", () =>
      Effect.gen(function* () {
        const signer = yield* MeshReceiptSigner.MeshReceiptSigner;
        assert.isTrue(signer.keyId.startsWith("mk_"));
        assert.equal(signer.keyId, `mk_${signer.publicKeyHex.slice(0, 16)}`);

        const rebuilt = yield* MeshReceiptSigner.make.pipe(Effect.provide(ServerSecretStore.layer));
        assert.equal(rebuilt.publicKeyHex, signer.publicKeyHex);
        assert.equal(rebuilt.keyId, signer.keyId);
      }),
    );
  });

  layer("capture and publish", (it) => {
    it.effect("traces a delegated turn from requester to worker to output digest", () =>
      Effect.gen(function* () {
        relayBehavior.reset();
        const ids = makeIds("trace");
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const eventStore = yield* OrchestrationEventStore;
        const reactor = yield* MeshReceiptExportReactor.MeshReceiptExportReactor;
        const store = yield* MeshReceiptExportStore.MeshReceiptExportStore;
        yield* enableExport(secrets);

        // Enabling records the capture boundary at the current watermark, so
        // start the export before the story's events exist.
        yield* reactor.sweep();
        yield* appendDelegatedTurnStory(eventStore, ids);

        const { captured } = yield* reactor.sweep();
        assert.equal(captured, 4);

        const rows = (yield* readOutbox).filter((row) => row.streamId === ids.project);
        assert.deepEqual(
          rows.map((row) => [row.streamSequence, row.receiptType, row.status]),
          [
            [1, "delegation.accepted", "accepted"],
            [2, "turn.started", "accepted"],
            [3, "artifact.available", "accepted"],
            [4, "delegation.terminal", "accepted"],
          ],
        );

        // The relay received the exact signed bytes; every event verifies and
        // the chain links through previousEventId with origin-qualified causes.
        assert.equal(relayBehavior.seen.length, 4);
        const expectedTypes = [
          "delegation.accepted",
          "turn.started",
          "artifact.available",
          "delegation.terminal",
        ];
        // @effect-diagnostics preferSchemaOverJson:off
        const parseFrame = (text: string): { readonly id: string; readonly content: string } =>
          JSON.parse(text);
        let previousEventId: string | null = null;
        for (const [index, eventJson] of relayBehavior.seen.entries()) {
          assert.equal(eventJson, rows[index]?.eventJson);
          const parsed = parseFrame(eventJson);
          assert.isTrue(verifyNostrEvent(parsed as never));
          const receipt = decodeMeshReceiptContent(parsed.content) as MeshReceipt;
          assert.equal(receipt.type, expectedTypes[index]);
          assert.equal(receipt.issuerEnvironmentId, ENVIRONMENT_ID);
          assert.equal(receipt.projectId, ids.project);
          assert.equal(receipt.previousEventId, previousEventId);
          assert.equal(receipt.cause, null);
          previousEventId = parsed.id;
        }
        assert.isNotNull(previousEventId);

        // Output evidence is content-addressed, stored once, bytes exact, and
        // the receipt references it by digest only.
        const artifacts = yield* store.listArtifacts;
        assert.equal(artifacts.length, 1);
        assert.equal(artifacts[0]?.content, "Audit complete.");
        assert.equal(artifacts[0]?.byteLength, "Audit complete.".length);
        assert.equal(artifacts[0]?.completeness, "complete");
        const artifactReceipt = decodeMeshReceiptContent(
          parseFrame(rows[2]?.eventJson ?? "{}").content,
        ) as MeshReceipt;
        assert.isTrue(artifactReceipt.type === "artifact.available");
        assert.isTrue(
          artifactReceipt.type === "artifact.available" &&
            artifactReceipt.outputs?.[0]?.sha256 === artifacts[0]?.sha256,
        );

        const state = yield* readExportState;
        assert.equal(state?.status, "active");
        assert.equal(state?.cursorSequence, 6);
      }),
    );

    it.effect("a crash replay or second sweep produces one stable logical receipt set", () =>
      Effect.gen(function* () {
        relayBehavior.reset();
        const ids = makeIds("replay");
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const eventStore = yield* OrchestrationEventStore;
        const reactor = yield* MeshReceiptExportReactor.MeshReceiptExportReactor;
        yield* enableExport(secrets);
        yield* reactor.sweep();
        yield* appendDelegatedTurnStory(eventStore, ids);
        yield* reactor.sweep();

        const second = yield* reactor.sweep();
        assert.equal(second.captured, 0);
        assert.equal(relayBehavior.seen.length, 4);
        const rows = (yield* readOutbox).filter((row) => row.streamId === ids.project);
        assert.equal(rows.length, 4);
      }),
    );

    it.effect("relay rejection is retained and transient failures retry the same bytes", () =>
      Effect.gen(function* () {
        relayBehavior.reset();
        const ids = makeIds("reject");
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const eventStore = yield* OrchestrationEventStore;
        const reactor = yield* MeshReceiptExportReactor.MeshReceiptExportReactor;
        yield* enableExport(secrets);
        yield* reactor.sweep();
        yield* seedThreadRow(ids.worker, ids.project);
        relayBehavior.mode = "reject";
        yield* reactor.sweep(); // arms the export boundary; nothing captured yet
        yield* eventStore.append(
          event(
            `${ids.project}-e1`,
            "delegation",
            ids.delegationId,
            "delegation.requested",
            delegationPayload(ids, "requested", null),
          ),
        );
        yield* reactor.sweep();
        const afterReject = yield* readOutbox;
        const rejected = afterReject.find((row) =>
          row.sourceEventId.startsWith(`${ids.project}-e1`),
        );
        assert.equal(rejected?.status, "rejected");
        assert.equal(rejected?.rejectionReason, "invalid: nope");

        relayBehavior.mode = "transient";
        yield* eventStore.append(
          event(
            `${ids.project}-e2`,
            "delegation",
            ids.delegationId,
            "delegation.completed",
            delegationPayload(ids, "completed", TurnId.make(`turn-${ids.project}`)),
            "2026-09-05T00:00:02.000Z",
          ),
        );
        yield* reactor.sweep();
        const afterTransient = yield* readOutbox;
        const retried = afterTransient.find((row) =>
          row.sourceEventId.startsWith(`${ids.project}-e2`),
        );
        assert.equal(retried?.status, "pending");
        assert.equal(retried?.attempts, 1);
        assert.isNotNull(retried?.nextAttemptAt);

        // Recovery republishes the same stored bytes, not a re-signature.
        const stored = retried?.eventJson;
        relayBehavior.mode = "accept";
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE mesh_receipt_outbox SET next_attempt_at = NULL`;
        relayBehavior.seen = [];
        yield* reactor.sweep();
        const afterRecovery = yield* readOutbox;
        const recovered = afterRecovery.find((row) =>
          row.sourceEventId.startsWith(`${ids.project}-e2`),
        );
        assert.equal(recovered?.status, "accepted");
        assert.equal(recovered?.eventJson, stored);
        assert.equal(relayBehavior.seen[0], stored);
      }),
    );

    it.effect("quota pressure pauses capture with the cursor intact and resumes after", () =>
      Effect.gen(function* () {
        relayBehavior.reset();
        relayBehavior.mode = "transient";
        const ids = makeIds("quota");
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const eventStore = yield* OrchestrationEventStore;
        const reactor = yield* MeshReceiptExportReactor.MeshReceiptExportReactor;
        yield* enableExport(secrets);
        yield* reactor.sweep();
        yield* appendDelegatedTurnStory(eventStore, ids);
        yield* reactor.sweep(); // captured; publish blocked so the backlog counts
        yield* secrets.set(MESH_RECEIPT_QUOTA_BYTES_SECRET, stringToBytes("10"));

        const before = yield* readExportState;
        yield* eventStore.append(
          event(
            `${ids.project}-extra`,
            "delegation",
            ids.delegationId,
            "delegation.failed",
            delegationPayload(ids, "failed", TurnId.make(`turn-1-${ids.project}`)),
            "2026-09-05T00:00:06.000Z",
          ),
        );
        const stalled = yield* reactor.sweep();
        assert.equal(stalled.captured, 0);
        const after = yield* readExportState;
        assert.equal(after?.cursorSequence, before?.cursorSequence);

        // Raising the quota resumes capture exactly where it paused.
        yield* secrets.remove(MESH_RECEIPT_QUOTA_BYTES_SECRET);
        const resumed = yield* reactor.sweep();
        assert.equal(resumed.captured, 1);
        const rows = yield* readOutbox;
        assert.equal(
          rows.filter(
            (row) => row.streamId === ids.project && row.receiptType === "delegation.terminal",
          ).length,
          2,
        );
      }),
    );

    it.effect("disable records a stop watermark and re-enabling starts a new epoch", () =>
      Effect.gen(function* () {
        relayBehavior.reset();
        const ids = makeIds("disable");
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const eventStore = yield* OrchestrationEventStore;
        const reactor = yield* MeshReceiptExportReactor.MeshReceiptExportReactor;
        yield* enableExport(secrets);
        yield* reactor.sweep();
        yield* eventStore.append(
          event(
            `${ids.project}-e1`,
            "delegation",
            ids.delegationId,
            "delegation.requested",
            delegationPayload(ids, "requested", null),
          ),
        );
        yield* reactor.sweep();
        const first = yield* readExportState;

        yield* disableExport(secrets);
        yield* eventStore.append(
          event(
            `${ids.project}-e2`,
            "delegation",
            ids.delegationId,
            "delegation.completed",
            delegationPayload(ids, "completed", TurnId.make(`turn-${ids.project}`)),
            "2026-09-05T00:00:02.000Z",
          ),
        );
        const disabled = yield* reactor.sweep();
        assert.equal(disabled.captured, 0);
        const stopped = yield* readExportState;
        assert.equal(stopped?.status, "disabled");
        assert.isNotNull(stopped?.stopWatermark);
        assert.equal(stopped?.exportEpoch, first?.exportEpoch);

        // Re-enabling starts a fresh capture epoch from the current watermark;
        // records behind the boundary are not silently backfilled.
        yield* enableExport(secrets);
        yield* reactor.sweep(); // re-arms at the current watermark with a new epoch
        yield* eventStore.append(
          event(
            `${ids.project}-e3`,
            "delegation",
            ids.delegationId,
            "delegation.interrupted",
            delegationPayload(ids, "interrupted", TurnId.make(`turn-${ids.project}`)),
            "2026-09-05T00:00:03.000Z",
          ),
        );
        const reenabled = yield* reactor.sweep();
        assert.equal(reenabled.captured, 1);
        const restarted = yield* readExportState;
        assert.equal(restarted?.status, "active");
        assert.notEqual(restarted?.exportEpoch, first?.exportEpoch);
        const rows = yield* readOutbox;
        const firstEpochFirstRow = rows.find((row) => row.exportEpoch === first?.exportEpoch);
        const newEpochRows = rows.filter((row) => row.exportEpoch === restarted?.exportEpoch);
        assert.equal(firstEpochFirstRow?.streamSequence, 1);
        assert.equal(newEpochRows.length, 1);
        assert.equal(newEpochRows[0]?.streamSequence, 1);
        // All terminal outcomes share the delegation.terminal receipt type;
        // the outcome itself is in the signed payload.
        assert.equal(newEpochRows[0]?.receiptType, "delegation.terminal");
      }),
    );

    it.effect("a missing thread projection is an intentional exclusion, not a gap", () =>
      Effect.gen(function* () {
        relayBehavior.reset();
        const ids = makeIds("orphan");
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const eventStore = yield* OrchestrationEventStore;
        const reactor = yield* MeshReceiptExportReactor.MeshReceiptExportReactor;
        yield* enableExport(secrets);
        yield* reactor.sweep();
        const orphan = ThreadId.make(`thread-gone-${ids.project}`);
        yield* eventStore.append(
          event(`${ids.project}-orphan`, "thread", orphan, "thread.turn-start-requested", {
            threadId: orphan,
            messageId: MessageId.make(`message-x-${ids.project}`),
            createdAt: "2026-09-05T00:00:02.000Z",
          }),
        );
        const { captured } = yield* reactor.sweep();
        assert.equal(captured, 0);
        const rows = yield* readOutbox;
        assert.equal(rows.filter((row) => row.streamId === orphan).length, 0);
      }),
    );
  });
});

const prepareReview = Effect.gen(function* () {
  relayBehavior.reset();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM mesh_export_state`;
  yield* sql`DELETE FROM mesh_export_epochs`;
  yield* sql`DELETE FROM mesh_receipt_outbox`;
  yield* sql`DELETE FROM mesh_export_streams`;
  yield* sql`DELETE FROM mesh_artifacts`;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  yield* secrets.remove(MESH_RECEIPT_QUOTA_BYTES_SECRET);
  const eventStore = yield* OrchestrationEventStore;
  const reactor = yield* MeshReceiptExportReactor.MeshReceiptExportReactor;
  const store = yield* MeshReceiptExportStore.MeshReceiptExportStore;
  yield* enableExport(secrets);
  yield* reactor.sweep();
  return { sql, secrets, eventStore, reactor, store };
});

describe("review regressions", () => {
  layer("actual production scenarios", (it) => {
    it.effect("advances beyond a full page of excluded events", () =>
      Effect.gen(function* () {
        const { eventStore, reactor } = yield* prepareReview;
        const ids = makeIds("review-excluded");
        for (let i = 0; i < 100; i++) {
          yield* eventStore.append(
            event(`excluded-${i}`, "thread", ids.worker, "thread.meta-updated", {
              threadId: ids.worker,
              title: "x",
              updatedAt: "2026-09-05T00:00:00.000Z",
            }),
          );
        }
        yield* eventStore.append(
          event(
            "after-excluded",
            "delegation",
            ids.delegationId,
            "delegation.requested",
            delegationPayload(ids, "requested", null),
          ),
        );
        yield* reactor.sweep();
        yield* reactor.sweep();
        const rows = yield* readOutbox;
        assert.equal(rows.length, 1, "The eligible event after the excluded page must be exported");
      }),
    );

    it.effect("retains real delta and completion output bytes", () =>
      Effect.gen(function* () {
        const { eventStore, reactor, store } = yield* prepareReview;
        const ids = makeIds("review-output");
        yield* seedThreadRow(ids.worker, ids.project);
        const common = {
          threadId: ids.worker,
          messageId: MessageId.make("review-real-message"),
          role: "assistant",
          turnId: TurnId.make("review-real-turn"),
          createdAt: "2026-09-05T00:00:03.000Z",
          updatedAt: "2026-09-05T00:00:03.000Z",
        };
        yield* eventStore.append(
          event("real-delta", "thread", ids.worker, "thread.message-sent", {
            ...common,
            text: "Actual answer from the provider.",
            streaming: true,
          }),
        );
        yield* eventStore.append(
          event("real-complete", "thread", ids.worker, "thread.message-sent", {
            ...common,
            text: "",
            streaming: false,
          }),
        );
        yield* reactor.sweep();
        const artifacts = yield* store.listArtifacts;
        assert.equal(artifacts[0]?.content, "Actual answer from the provider.");
      }),
    );

    it.effect("does not publish retained pending records on re-enable without resume", () =>
      Effect.gen(function* () {
        const { eventStore, reactor, secrets, sql } = yield* prepareReview;
        const ids = makeIds("review-reenable");
        relayBehavior.mode = "transient";
        yield* eventStore.append(
          event(
            "old-pending",
            "delegation",
            ids.delegationId,
            "delegation.requested",
            delegationPayload(ids, "requested", null),
          ),
        );
        yield* reactor.sweep();
        yield* disableExport(secrets);
        yield* reactor.sweep();
        yield* sql`UPDATE mesh_receipt_outbox SET next_attempt_at = NULL`;
        relayBehavior.reset();
        yield* enableExport(secrets, { relayUrl: "wss://different-relay.test" });
        yield* reactor.sweep();
        assert.equal(
          relayBehavior.seen.length,
          0,
          "Old pending receipts require an explicit resume choice",
        );
      }),
    );

    it.effect("preserves the originating command's causal reference", () =>
      Effect.gen(function* () {
        const { eventStore, reactor } = yield* prepareReview;
        const ids = makeIds("review-cause");
        yield* seedThreadRow(ids.worker, ids.project);
        const parent = yield* eventStore.append(
          event("review-parent", "thread", ids.worker, "thread.message-sent", {
            threadId: ids.worker,
            messageId: MessageId.make("review-parent-msg"),
            role: "user",
            text: "Do the work",
            turnId: null,
            streaming: false,
            createdAt: "2026-09-05T00:00:01.000Z",
            updatedAt: "2026-09-05T00:00:01.000Z",
          }),
        );
        yield* eventStore.append({
          ...event("review-child", "thread", ids.worker, "thread.turn-start-requested", {
            threadId: ids.worker,
            messageId: MessageId.make("review-parent-msg"),
            createdAt: "2026-09-05T00:00:01.000Z",
          }),
          causationEventId: parent.eventId,
        });
        yield* reactor.sweep();
        const rows = yield* readOutbox;
        const receipt = decodeMeshReceiptContent(JSON.parse(rows[0]!.eventJson).content);
        assert.equal(receipt.cause?.sourceEventId, parent.eventId);
      }),
    );

    it.effect("drains a backlog larger than four without advancing time", () =>
      Effect.gen(function* () {
        const { eventStore, reactor } = yield* prepareReview;
        for (let i = 0; i < 25; i++) {
          const ids = makeIds(`backlog-${i}`);
          yield* eventStore.append(
            event(
              `backlog-event-${i}`,
              "delegation",
              ids.delegationId,
              "delegation.requested",
              delegationPayload(ids, "requested", null),
            ),
          );
        }
        const result = yield* reactor.sweep();
        assert.equal(result.captured, 25);
        assert.equal(relayBehavior.seen.length, 25);
        assert.isTrue((yield* readOutbox).every((row) => row.status === "accepted"));
      }),
    );

    it.effect(
      "resumes only the original destination and global disable pauses resumed epochs",
      () =>
        Effect.gen(function* () {
          const { eventStore, reactor, secrets, sql, store } = yield* prepareReview;
          const ids = makeIds("explicit-resume");
          relayBehavior.mode = "transient";
          yield* eventStore.append(
            event(
              "explicit-resume-event",
              "delegation",
              ids.delegationId,
              "delegation.requested",
              delegationPayload(ids, "requested", null),
            ),
          );
          yield* reactor.sweep();
          const epoch = (yield* readExportState)!.exportEpoch;
          yield* disableExport(secrets);
          yield* reactor.sweep();
          yield* enableExport(secrets);
          yield* reactor.sweep();
          const denied = yield* store
            .setEpochPublication({
              exportEpoch: epoch,
              destinationDigest: meshRelayDestinationDigest("wss://wrong.test"),
              publication: "active",
            })
            .pipe(Effect.flip);
          assert.equal(denied.operation, "setEpochPublication");
          yield* store.setEpochPublication({
            exportEpoch: epoch,
            destinationDigest: meshRelayDestinationDigest("wss://relay.test"),
            publication: "active",
          });
          yield* store.disableExport({
            stopWatermark: yield* store.latestSourceSequence,
            at: "2026-09-06T00:00:00.000Z",
          });
          assert.isTrue((yield* store.listEpochs).every((entry) => entry.publication === "paused"));
          yield* enableExport(secrets);
          yield* reactor.sweep();
          yield* store.setEpochPublication({
            exportEpoch: epoch,
            destinationDigest: meshRelayDestinationDigest("wss://relay.test"),
            publication: "active",
          });
          yield* sql`UPDATE mesh_receipt_outbox SET next_attempt_at = NULL`;
          relayBehavior.reset();
          yield* reactor.sweep();
          assert.equal(relayBehavior.seen.length, 1);
          assert.equal((yield* readOutbox)[0]?.status, "accepted");
        }),
    );

    it.effect("reconstructs text only through the source completion sequence", () =>
      Effect.gen(function* () {
        const { eventStore, store } = yield* prepareReview;
        const ids = makeIds("output-boundary");
        const messageId = MessageId.make("output-boundary-message");
        const payload = {
          threadId: ids.worker,
          messageId,
          role: "assistant",
          turnId: null,
          createdAt: "2026-09-05T00:00:00.000Z",
          updatedAt: "2026-09-05T00:00:00.000Z",
        };
        yield* eventStore.append(
          event("boundary-delta", "thread", ids.worker, "thread.message-sent", {
            ...payload,
            text: "original",
            streaming: true,
          }),
        );
        const complete = yield* eventStore.append(
          event("boundary-complete", "thread", ids.worker, "thread.message-sent", {
            ...payload,
            text: "",
            streaming: false,
          }),
        );
        yield* eventStore.append(
          event("boundary-later", "thread", ids.worker, "thread.message-sent", {
            ...payload,
            text: "changed",
            streaming: false,
          }),
        );
        const retained = yield* store.readAssistantTextAt({
          threadId: ids.worker,
          messageId,
          sequenceInclusive: complete.sequence,
        });
        assert.deepEqual(retained, Option.some("original"));
      }),
    );
    it.effect("a stale disabled configuration cannot pause a newly enabled epoch", () =>
      Effect.gen(function* () {
        const { reactor, secrets, store } = yield* prepareReview;
        const before = yield* store.readExportState;
        yield* secrets.remove(MESH_RECEIPT_EXPORT_ENABLED_SECRET);
        yield* reactor.sweep();
        assert.deepEqual(yield* store.readExportState, before);
        yield* secrets.set(MESH_RECEIPT_EXPORT_ENABLED_SECRET, stringToBytes("true"));
        assert.equal((yield* store.readExportState)?.status, "active");
      }),
    );
    it.effect("reconstructs a message across multiple bounded source pages", () =>
      Effect.gen(function* () {
        const { eventStore, reactor, store } = yield* prepareReview;
        const ids = makeIds("paged-output");
        yield* seedThreadRow(ids.worker, ids.project);
        const payload = {
          threadId: ids.worker,
          messageId: MessageId.make("paged-message"),
          role: "assistant",
          turnId: null,
          createdAt: "2026-09-05T00:00:00.000Z",
          updatedAt: "2026-09-05T00:00:00.000Z",
        };
        for (let i = 0; i < 250; i++) {
          yield* eventStore.append(
            event(`paged-delta-${i}`, "thread", ids.worker, "thread.message-sent", {
              ...payload,
              text: "é",
              streaming: true,
            }),
          );
        }
        yield* eventStore.append(
          event("paged-complete", "thread", ids.worker, "thread.message-sent", {
            ...payload,
            text: "",
            streaming: false,
          }),
        );
        assert.equal((yield* reactor.sweep()).captured, 1);
        const output = (yield* store.listArtifacts)[0];
        assert.equal(output?.content, "é".repeat(250));
        assert.equal(output?.byteLength, 500);
      }),
    );

    it.effect("rejects a stale resume request after global disable", () =>
      Effect.gen(function* () {
        const { store, secrets } = yield* prepareReview;
        const epoch = (yield* store.readExportState)!.exportEpoch;
        yield* disableExport(secrets);
        const result = yield* store
          .setEpochPublication({
            exportEpoch: epoch,
            destinationDigest: meshRelayDestinationDigest("wss://relay.test"),
            publication: "active",
          })
          .pipe(Effect.flip);
        assert.equal(result.operation, "setEpochPublication");
        assert.equal(
          (yield* store.listEpochs).find((entry) => entry.exportEpoch === epoch)?.publication,
          "paused",
        );
      }),
    );

    it.effect(
      "background publication recovers on a new event after acknowledgement persistence fails",
      () =>
        Effect.gen(function* () {
          const { store, eventStore } = yield* prepareReview;
          const engine = yield* OrchestrationEngine.OrchestrationEngineService;
          const notifications = yield* PubSub.unbounded<OrchestrationEvent>();
          yield* Effect.addFinalizer(() => PubSub.shutdown(notifications));
          const subscribed = yield* Deferred.make<void>();
          const failed = yield* Deferred.make<void>();
          const recovered = yield* Deferred.make<void>();
          const nextCompleted = yield* Deferred.make<void>();
          let failOnce = true;
          let accepted = 0;
          const reactor = yield* MeshReceiptExportReactor.make.pipe(
            Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
              ...engine,
              subscribeDomainEvents: PubSub.subscribe(notifications).pipe(
                Effect.tap(() => Deferred.succeed(subscribed, undefined)),
                Effect.map(Stream.fromSubscription),
              ),
            }),
            Effect.provideService(MeshReceiptExportStore.MeshReceiptExportStore, {
              ...store,
              markAccepted: (input) =>
                Effect.gen(function* () {
                  if (failOnce) {
                    failOnce = false;
                    yield* Deferred.succeed(failed, undefined);
                    return yield* new MeshReceiptExportStore.MeshReceiptExportStoreError({
                      operation: "markAccepted",
                      cause: new Error("injected acknowledgement persistence failure"),
                    });
                  }
                  yield* store.markAccepted(input);
                  accepted += 1;
                  yield* Deferred.succeed(accepted === 1 ? recovered : nextCompleted, undefined);
                }),
            }),
          );
          const ids = makeIds("background-recovery");
          const first = yield* eventStore.append(
            event(
              "background-first",
              "delegation",
              ids.delegationId,
              "delegation.requested",
              delegationPayload(ids, "requested", null),
            ),
          );
          yield* reactor.start();
          yield* Deferred.await(subscribed);
          yield* Deferred.await(failed);
          yield* reactor.drain;
          assert.equal(relayBehavior.seen.length, 1);
          yield* PubSub.publish(notifications, first);
          yield* Deferred.await(recovered);
          yield* reactor.drain;
          assert.equal(relayBehavior.seen.length, 2);
          const second = yield* eventStore.append(
            event(
              "background-second",
              "delegation",
              ids.delegationId,
              "delegation.completed",
              delegationPayload(ids, "completed", TurnId.make("background-turn")),
            ),
          );
          yield* PubSub.publish(notifications, second);
          yield* Deferred.await(nextCompleted);
          yield* reactor.drain;
          assert.equal(relayBehavior.seen.length, 3);
          assert.isTrue((yield* readOutbox).every((row) => row.status === "accepted"));
        }).pipe(Effect.scoped),
    );
  });
});
