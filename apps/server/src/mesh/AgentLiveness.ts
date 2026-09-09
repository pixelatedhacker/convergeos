import {
  AgentMeshError,
  type AgentLivenessInput,
  type AgentLivenessResult,
  type AgentLivenessObservation,
  type Delegation,
  type DelegationId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { forkParked } from "../serverActivation.ts";
import { MeshReceiptSigner } from "./MeshReceiptSigner.ts";
import { MeshReceiptExportStore } from "./MeshReceiptExportStore.ts";
import { readMeshReceiptExportConfig, meshRelayDestinationDigest } from "./MeshReceiptConfig.ts";
import { publishSignedEvent } from "./NostrRelay.ts";
import { readNostrLiveness } from "./NostrLivenessReader.ts";
import {
  encodeLivenessEvent,
  isTerminalLiveness,
  LIVENESS_INTERVAL_MS,
  LIVENESS_TTL_MS,
  LIVENESS_MAX_TRACKED,
  newestObservation,
  observeDelegationState,
  verifyLiveness,
} from "./liveness.ts";

export class AgentLiveness extends Context.Service<
  AgentLiveness,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
    readonly sweep: () => Effect.Effect<void>;
    readonly read: (
      callerThreadId: ThreadId,
      input: AgentLivenessInput,
    ) => Effect.Effect<AgentLivenessResult, AgentMeshError>;
  }
>()("t3/mesh/AgentLiveness") {}

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore;
  const signer = yield* MeshReceiptSigner;
  const store = yield* MeshReceiptExportStore;
  const query = yield* ProjectionSnapshotQuery;
  const providers = yield* ProviderService;
  const engine = yield* OrchestrationEngineService;
  const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
  const published = new Map<DelegationId, AgentLivenessObservation>();
  const terminalAccepted = new Set<DelegationId>();
  let binding: string | null = null;
  const received = new Map<DelegationId, AgentLivenessObservation>();
  const activity = new Map<string, string>();
  const readBusy = yield* Ref.make(false);
  let lastSequence = 0;
  let lastReadAt = Number.NEGATIVE_INFINITY;

  const configForExport = Effect.gen(function* () {
    const config = yield* readMeshReceiptExportConfig(secrets);
    if (!config.enabled || !config.relayUrl) return null;
    const state = yield* store.readExportState;
    if (
      !state ||
      state.status !== "active" ||
      state.destinationDigest !== meshRelayDestinationDigest(config.relayUrl)
    )
      return null;
    return {
      relayUrl: config.relayUrl,
      binding: `${state.exportEpoch}:${state.destinationDigest}`,
      exportEpoch: state.exportEpoch,
      destinationDigest: meshRelayDestinationDigest(config.relayUrl),
    };
  });

  const reconcileBinding = (nextBinding: string | null) => {
    if (binding === nextBinding) return;
    binding = nextBinding;
    received.clear();
    published.clear();
    terminalAccepted.clear();
  };

  const sweepUnsafe = Effect.gen(function* () {
    const config = yield* configForExport;
    reconcileBinding(config?.binding ?? null);
    if (!config) return;
    const [model, shells, sessions, keys] = yield* Effect.all([
      query.getCommandReadModel(),
      query.getShellSnapshot(),
      providers.listSessions(),
      store.listActiveKeys,
    ]);
    if (
      !keys.some(
        (key) =>
          key.environmentId === environmentId &&
          key.keyId === signer.keyId &&
          key.publicKeyHex === signer.publicKeyHex,
      )
    )
      return;
    const now = yield* DateTime.now;
    const nowMs = now.epochMilliseconds;
    const all = (model.delegations ?? []).filter(
      (d) => d.requester.kind === "thread" && d.targetThreadId && d.turnId,
    );
    // Retain active work and recent terminal observations; no historical heartbeat replay.
    const candidates = all
      .filter(
        (d) =>
          !isTerminalLiveness(
            d.state === "completed" || d.state === "failed" || d.state === "interrupted"
              ? d.state
              : "unknown",
          ) || nowMs - Date.parse(d.updatedAt) < LIVENESS_TTL_MS,
      )
      .slice(0, LIVENESS_MAX_TRACKED);
    const ids = new Set(candidates.map((d) => d.id));
    for (const id of published.keys())
      if (!ids.has(id)) {
        published.delete(id);
        terminalAccepted.delete(id);
      }
    for (const key of activity.keys())
      if (!candidates.some((d) => `${d.targetThreadId}:${d.turnId}` === key)) activity.delete(key);
    const observations: AgentLivenessObservation[] = [];
    for (const delegation of candidates) {
      if (
        delegation.requester.kind !== "thread" ||
        !delegation.targetThreadId ||
        !delegation.turnId
      )
        continue;
      const state = observeDelegationState(
        delegation,
        sessions.find((s) => s.threadId === delegation.targetThreadId),
        shells.threads.find((t) => t.id === delegation.targetThreadId),
      );
      const previous = published.get(delegation.id);
      if (
        previous &&
        (terminalAccepted.has(delegation.id) ||
          nowMs - Date.parse(previous.observedAt) <
            (previous.state === state ? LIVENESS_INTERVAL_MS : 1_000))
      )
        continue;
      lastSequence = Math.max(lastSequence + 1, nowMs);
      const observation: AgentLivenessObservation = {
        version: 1,
        exportEpoch: config.exportEpoch,
        destinationDigest: config.destinationDigest,
        environmentId,
        keyId: signer.keyId,
        projectId: delegation.projectId,
        delegationId: delegation.id,
        requesterThreadId: delegation.requester.threadId,
        targetThreadId: delegation.targetThreadId,
        turnId: delegation.turnId,
        sequence: lastSequence,
        observedAt: DateTime.formatIso(now),
        expiresAt: DateTime.formatIso(DateTime.add(now, { milliseconds: LIVENESS_TTL_MS })),
        providerActivityAt:
          activity.get(`${delegation.targetThreadId}:${delegation.turnId}`) ?? null,
        state,
      };
      published.set(delegation.id, observation);
      observations.push(observation);
    }
    // Fixed concurrency, no durable outbox: retry only a newly observed heartbeat on the next sweep.
    yield* Effect.forEach(
      observations,
      (observation) =>
        Effect.gen(function* () {
          const event = signer.signLivenessSync(observation);
          if (
            !event ||
            Date.parse(observation.expiresAt) <= (yield* DateTime.now).epochMilliseconds
          )
            return;
          const outcome = yield* publishSignedEvent(
            config.relayUrl,
            encodeLivenessEvent(event),
            1_000,
          );
          if (
            outcome._tag === "Accepted" &&
            isTerminalLiveness(observation.state) &&
            binding === config.binding
          )
            terminalAccepted.add(observation.delegationId);
        }),
      { concurrency: 4, discard: true },
    );
  });
  const sweep = () =>
    sweepUnsafe.pipe(
      Effect.catchCause(() =>
        Effect.logWarning("Agent liveness sweep unavailable; local work continues"),
      ),
    );

  const read: AgentLiveness["Service"]["read"] = Effect.fn("AgentLiveness.read")(
    function* (callerThreadId, input) {
      const caller = yield* query.getThreadShellById(callerThreadId).pipe(
        Effect.mapError(
          () =>
            new AgentMeshError({
              operation: "read",
              reason: "callerUnavailable",
              targetThreadId: null,
            }),
        ),
      );
      if (Option.isNone(caller))
        return yield* new AgentMeshError({
          operation: "read",
          reason: "callerUnavailable",
          targetThreadId: null,
        });
      const model = yield* query.getCommandReadModel().pipe(
        Effect.mapError(
          () =>
            new AgentMeshError({
              operation: "read",
              reason: "callerUnavailable",
              targetThreadId: null,
            }),
        ),
      );
      const owned: Delegation[] = [];
      for (const id of input.delegationIds) {
        const d = model.delegations?.find((entry) => entry.id === id);
        if (
          !d ||
          d.projectId !== caller.value.projectId ||
          d.requester.kind !== "thread" ||
          d.requester.threadId !== callerThreadId
        )
          return yield* new AgentMeshError({
            operation: "read",
            reason: "targetUnavailable",
            targetThreadId: null,
          });
        owned.push(d);
      }
      const config = yield* configForExport.pipe(Effect.orElseSucceed(() => null));
      reconcileBinding(config?.binding ?? null);
      const keys = yield* store.listActiveKeys.pipe(Effect.orElseSucceed(() => []));
      const nowMs = (yield* DateTime.now).epochMilliseconds;
      let transport: AgentLivenessResult["transport"] = config ? "unavailable" : "disabled";
      if (config && nowMs - lastReadAt >= 1_000 && !(yield* Ref.getAndSet(readBusy, true))) {
        lastReadAt = nowMs;
        const result = yield* readNostrLiveness({
          relayUrl: config.relayUrl,
          authors: keys
            .filter((k) => k.environmentId === environmentId)
            .map((k) => k.publicKeyHex)
            .slice(0, 8),
          delegationIds: input.delegationIds,
          since: Math.floor((nowMs - LIVENESS_TTL_MS) / 1000),
        }).pipe(Effect.ensuring(Ref.set(readBusy, false)));
        transport = result.queried ? "queried" : "unavailable";
        const current = yield* configForExport.pipe(Effect.orElseSucceed(() => null));
        reconcileBinding(current?.binding ?? null);
        if (current?.binding !== config.binding) transport = "unavailable";
        for (const event of current?.binding === config.binding ? result.events : []) {
          for (const delegation of owned) {
            const observation = verifyLiveness({
              event,
              delegation,
              environmentId,
              exportEpoch: config.exportEpoch,
              destinationDigest: config.destinationDigest,
              keys,
              nowMs: (yield* DateTime.now).epochMilliseconds,
            });
            if (!observation) continue;
            received.set(
              delegation.id,
              newestObservation(received.get(delegation.id), observation),
            );
          }
        }
      }
      while (received.size > LIVENESS_MAX_TRACKED) {
        const first = received.keys().next();
        if (first.done) break;
        received.delete(first.value);
      }
      const readAt = (yield* DateTime.now).epochMilliseconds;
      return {
        transport,
        scope: "local-owned-delegations",
        observations: owned.map((d) => {
          const cached = received.get(d.id);
          const observation =
            cached &&
            cached.turnId === d.turnId &&
            keys.some(
              (k) => k.keyId === cached.keyId && k.environmentId === cached.environmentId,
            ) &&
            (!(d.state === "completed" || d.state === "failed" || d.state === "interrupted") ||
              cached.state === d.state)
              ? cached
              : null;
          return {
            delegationId: d.id,
            observation,
            freshness: observation
              ? Date.parse(observation.expiresAt) > readAt
                ? "fresh"
                : "stale"
              : "unknown",
          };
        }),
      };
    },
  );

  const pending = yield* Ref.make(false);
  const worker = yield* makeDrainableWorker(() =>
    Ref.set(pending, false).pipe(Effect.andThen(sweep())),
  );
  const wake = Ref.getAndSet(pending, true).pipe(
    Effect.flatMap((wasPending) => (wasPending ? Effect.void : worker.enqueue(undefined))),
  );
  const start = Effect.fn("AgentLiveness.start")(function* () {
    yield* forkParked(
      Stream.runForEach(providers.streamEvents, (event) =>
        Effect.gen(function* () {
          if (event.turnId) {
            const key = `${event.threadId}:${event.turnId}`;
            if (activity.has(key) || activity.size < LIVENESS_MAX_TRACKED)
              activity.set(key, DateTime.formatIso(yield* DateTime.now));
          }
          if (
            [
              "turn.started",
              "turn.completed",
              "turn.aborted",
              "session.exited",
              "session.state.changed",
              "request.opened",
              "request.resolved",
              "user-input.requested",
              "user-input.resolved",
            ].includes(event.type)
          )
            yield* wake;
        }),
      ),
    );
    yield* forkParked(
      Effect.gen(function* () {
        const events = yield* engine.subscribeDomainEvents;
        yield* Stream.runForEach(events, (event) =>
          event.type.startsWith("delegation.") ? wake : Effect.void,
        );
      }),
    );
    yield* forkParked(
      wake.pipe(
        Effect.andThen(worker.drain),
        Effect.repeat(Schedule.spaced("30 seconds")),
        Effect.asVoid,
      ),
    );
  });
  return AgentLiveness.of({ start, drain: worker.drain, sweep, read });
});
export const layer = Layer.effect(AgentLiveness, make);
