import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { AgentLiveness, layer } from "./AgentLiveness.ts";
import { MeshReceiptExportStore } from "./MeshReceiptExportStore.ts";
import * as MeshReceiptSigner from "./MeshReceiptSigner.ts";
import {
  MESH_RECEIPT_SIGNING_KEY_SECRET,
  meshRelayDestinationDigest,
} from "./MeshReceiptConfig.ts";
import { readNostrLiveness } from "./NostrLivenessReader.ts";
import { LIVENESS_TTL_MS, NostrLivenessEvent, verifyLiveness } from "./liveness.ts";
import {
  delegation,
  keys,
  nowMs,
  observation,
  secretKey,
  session,
  signed,
} from "./livenessTestFixtures.ts";

const shell = (id: ThreadId): OrchestrationThreadShell => ({
  id,
  projectId: delegation.projectId,
  title: id,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  linkedPullRequest: null,
  latestTurn: null,
  createdAt: delegation.createdAt,
  updatedAt: delegation.updatedAt,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  unsettledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});
const decodePublish = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Tuple([Schema.Literal("EVENT"), NostrLivenessEvent])),
);
const decodeRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Tuple([Schema.Literal("REQ"), Schema.String, Schema.Unknown])),
);

const makeRelay = Effect.gen(function* () {
  const events: Array<typeof NostrLivenessEvent.Type> = [];
  const countWaiters: Array<{ count: number; resolve: () => void }> = [];
  let mode: "normal" | "close" | "ack-only" | "flood" = "normal";
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSocket.NodeWS.WebSocketServer({ host: "127.0.0.1", port: 0 })),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            for (const client of server.clients) client.terminate();
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
  );
  server.on("connection", (socket) =>
    socket.on("message", (data) => {
      if (mode === "close") {
        socket.close();
        return;
      }
      const raw = data.toString();
      const publication = decodePublish(raw);
      if (Option.isSome(publication)) {
        if (mode !== "ack-only") {
          events.push(publication.value[1]);
          for (const waiter of countWaiters) if (events.length >= waiter.count) waiter.resolve();
        }
        socket.send(JSON.stringify(["OK", publication.value[1].id, true, ""]));
        return;
      }
      const request = decodeRequest(raw);
      if (Option.isNone(request)) return;
      if (mode === "flood") {
        socket.send("x".repeat(5000));
        return;
      }
      for (const event of events) socket.send(JSON.stringify(["EVENT", request.value[1], event]));
      socket.send(JSON.stringify(["EOSE", request.value[1]]));
    }),
  );
  yield* Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    return yield* Effect.die("Expected local relay address");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    events,
    awaitCount: (count: number) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            if (events.length >= count) resolve();
            else countWaiters.push({ count, resolve });
          }),
      ),
    setMode: (value: typeof mode) => {
      mode = value;
    },
  };
});

const makeHarness = Effect.gen(function* () {
  yield* TestClock.setTime(nowMs);
  const relay = yield* makeRelay;
  const runtime = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const activitySeen = yield* Deferred.make<void>();
  const state = {
    delegation,
    session: Option.some(session),
    shell: shell(ThreadId.make("child")),
    keys,
    enabled: true,
    epoch: "epoch",
  };
  const parent = shell(ThreadId.make("parent"));
  const secrets = new Map<string, Uint8Array>([
    [MESH_RECEIPT_SIGNING_KEY_SECRET, secretKey],
    ["mesh-receipt-export-enabled", new TextEncoder().encode("true")],
    ["mesh-receipt-relay-url", new TextEncoder().encode(relay.url)],
  ]);
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env")),
    }),
    Layer.mock(ServerSecretStore)({
      get: (name) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(name))),
    }),
    Layer.mock(OrchestrationEngineService)({ subscribeDomainEvents: Effect.succeed(Stream.empty) }),
    Layer.mock(ProviderService)({
      listSessions: () =>
        Effect.sync(() => (Option.isSome(state.session) ? [state.session.value] : [])),
      streamEvents: Stream.fromPubSub(runtime).pipe(
        Stream.tap(() => Deferred.succeed(activitySeen, undefined)),
      ),
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (id) =>
        Effect.succeed(id === parent.id ? Option.some(parent) : Option.none()),
      getCommandReadModel: () =>
        Effect.sync(() => ({
          delegations: [state.delegation],
          projects: [],
          threads: [],
          snapshotSequence: 1,
          updatedAt: delegation.updatedAt,
        })),
      getShellSnapshot: () =>
        Effect.sync(() => ({
          threads: [parent, state.shell],
          projects: [],
          snapshotSequence: 1,
          updatedAt: delegation.updatedAt,
        })),
    }),
    Layer.mock(MeshReceiptExportStore)({
      readExportState: Effect.sync(() =>
        state.enabled
          ? {
              status: "active",
              exportEpoch: state.epoch,
              destinationDigest: meshRelayDestinationDigest(relay.url),
              cursorSequence: 0,
              quotaBytes: 10000,
              stopWatermark: null,
            }
          : null,
      ),
      listActiveKeys: Effect.sync(() => state.keys),
    }),
  );
  const context = yield* Layer.build(
    layer.pipe(Layer.provide(MeshReceiptSigner.layer), Layer.provide(dependencies)),
  );
  const service = yield* AgentLiveness.pipe(Effect.provide(context));
  return {
    state,
    relay,
    service,
    runtime,
    activitySeen,
    read: () => service.read(parent.id, { delegationIds: [delegation.id] }),
  };
});

it.effect(
  "publishes host observations through a real relay and returns verified scoped observations",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.service.sweep();
      assert.equal(h.relay.events.length, 1);
      const result = yield* h.read();
      assert.equal(result.transport, "queried");
      assert.equal(result.observations[0]?.freshness, "fresh");
      assert.equal(result.observations[0]?.observation?.state, "running");
      assert.isNull(result.observations[0]?.observation?.providerActivityAt);
      assert.equal(
        verifyLiveness({
          event: h.relay.events[0]!,
          delegation,
          environmentId: "env",
          exportEpoch: h.state.epoch,
          destinationDigest: meshRelayDestinationDigest(h.relay.url),
          keys,
          nowMs,
        })?.state,
        "running",
      );
      yield* h.service.sweep();
      assert.equal(h.relay.events.length, 1);
      yield* TestClock.adjust("30 seconds");
      yield* h.service.sweep();
      assert.equal(h.relay.events.length, 2);
      h.state.session = Option.none();
      yield* TestClock.adjust("1 second");
      yield* h.service.sweep();
      assert.equal((yield* h.read()).observations[0]?.observation?.state, "unknown");
      h.state.session = Option.some(session);
      h.state.shell = { ...h.state.shell, hasPendingApprovals: true };
      yield* TestClock.adjust("1 second");
      yield* h.service.sweep();
      assert.equal((yield* h.read()).observations[0]?.observation?.state, "waiting");
      h.state.delegation = {
        ...delegation,
        state: "completed",
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      };
      yield* TestClock.adjust("1 second");
      yield* h.service.sweep();
      h.relay.events.push(
        signed({
          ...observation,
          destinationDigest: meshRelayDestinationDigest(h.relay.url),
          sequence: nowMs + 999999,
          observedAt: DateTime.formatIso(yield* DateTime.now),
          expiresAt: DateTime.formatIso(
            DateTime.add(yield* DateTime.now, { milliseconds: LIVENESS_TTL_MS }),
          ),
        }),
      );
      assert.equal((yield* h.read()).observations[0]?.observation?.state, "completed");
      h.relay.setMode("close");
      yield* TestClock.adjust("91 seconds");
      const stale = yield* h.read();
      assert.equal(stale.transport, "unavailable");
      assert.equal(stale.observations[0]?.freshness, "stale");
      h.state.keys = [];
      assert.equal((yield* h.read()).observations[0]?.freshness, "unknown");
    }).pipe(Effect.scoped),
);

it.effect(
  "relay acceptance does not fabricate receipt delivery and caller ownership is mandatory",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      h.relay.setMode("ack-only");
      yield* h.service.sweep();
      assert.equal((yield* h.read()).observations[0]?.freshness, "unknown");
      h.state.delegation = {
        ...delegation,
        requester: { kind: "thread", threadId: ThreadId.make("someone-else"), requestId: "r" },
      };
      const denied = yield* Effect.flip(h.read());
      assert.equal(denied.reason, "targetUnavailable");
      h.state.enabled = false;
      yield* h.service.sweep();
      assert.equal(h.relay.events.length, 0);
    }).pipe(Effect.scoped),
);

it.effect("reader bounds oversized relay responses", () =>
  Effect.gen(function* () {
    const relay = yield* makeRelay;
    relay.setMode("flood");
    const result = yield* readNostrLiveness({
      relayUrl: relay.url,
      authors: [],
      delegationIds: [delegation.id],
      since: 0,
    });
    assert.isFalse(result.queried);
    assert.deepEqual(result.events, []);
  }).pipe(Effect.scoped),
);

it.effect("periodic heartbeats preserve last provider activity and never dispatch model work", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    yield* h.service.start();
    yield* h.relay.awaitCount(1);
    yield* h.service.drain;
    yield* TestClock.adjust("5 seconds");
    yield* PubSub.publish(h.runtime, {
      type: "content.delta",
      eventId: EventId.make("content-event"),
      provider: session.provider,
      threadId: session.threadId,
      turnId: delegation.turnId!,
      createdAt: delegation.createdAt,
      payload: { streamKind: "assistant_text", delta: "private output" },
    });
    yield* Deferred.await(h.activitySeen);
    assert.equal(h.relay.events.length, 1);
    yield* TestClock.adjust("25 seconds");
    yield* h.relay.awaitCount(2);
    yield* h.service.drain;
    const status = (yield* h.read()).observations[0]?.observation;
    assert.equal(status?.observedAt, "2026-09-06T00:01:00.000Z");
    assert.equal(status?.providerActivityAt, "2026-09-06T00:00:35.000Z");
    assert.isFalse(h.relay.events.some((event) => event.content.includes("private output")));
  }).pipe(Effect.scoped),
);

it.effect(
  "retries terminal publication after relay failure and invalidates disabled or changed export bindings",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      h.state.delegation = {
        ...delegation,
        state: "completed",
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      };
      h.relay.setMode("close");
      yield* h.service.sweep();
      assert.equal(h.relay.events.length, 0);
      h.relay.setMode("normal");
      yield* TestClock.adjust("30 seconds");
      yield* h.service.sweep();
      assert.equal((yield* h.read()).observations[0]?.observation?.state, "completed");
      h.state.enabled = false;
      assert.equal((yield* h.read()).observations[0]?.freshness, "unknown");
      h.state.enabled = true;
      h.state.epoch = "new-epoch";
      h.relay.setMode("close");
      assert.equal((yield* h.read()).observations[0]?.freshness, "unknown");
    }).pipe(Effect.scoped),
);
