import { expect, it } from "@effect/vitest";
import {
  RuntimeTaskId,
  DelegationId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  DelegationUsageResult,
  type Delegation,
  type InvocationUsageReport,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { runtimeEventToActivities } from "../orchestration/Layers/ProviderRuntimeIngestion.ts";
import { ProjectionThreadActivityRepository } from "../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "../persistence/Layers/ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as DelegationUsageService from "./DelegationUsageService.ts";

const isUsageResult = Schema.is(DelegationUsageResult);
const encodeUsageResult = Schema.encodeEffect(Schema.fromJsonString(DelegationUsageResult));

const projectId = ProjectId.make("usage-project");
const callerId = ThreadId.make("usage-caller");
const workerId = ThreadId.make("usage-worker");
const instanceId = ProviderInstanceId.make("claude-personal");
const startedAt = "2026-09-06T12:00:00.000Z";
const finishedAt = "2026-09-06T12:00:02.000Z";
const caller: OrchestrationThreadShell = {
  id: callerId,
  projectId,
  title: "Caller",
  modelSelection: { instanceId, model: "requested-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  linkedPullRequest: null,
  latestTurn: null,
  createdAt: startedAt,
  updatedAt: startedAt,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  unsettledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  titleRegeneration: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  backgroundLiveness: null,
  planProgress: null,
};
const delegation = (id: string, overrides: Partial<Delegation> = {}): Delegation => ({
  id: DelegationId.make(id),
  projectId,
  requester: { kind: "thread", threadId: callerId, requestId: id },
  target: { kind: "existingThread", threadId: workerId },
  title: "Worker",
  task: "Private prompt should never enter the usage response",
  state: "completed",
  targetThreadId: workerId,
  turnId: TurnId.make(id),
  assistantMessageId: null,
  failure: null,
  revision: 1,
  createdAt: startedAt,
  updatedAt: finishedAt,
  ...overrides,
});
const modelUsage = {
  model: "executed-model",
  inputTokens: 100,
  outputTokens: 20,
  cachedInputTokens: 60,
  cacheCreationTokens: 10,
  reasoningTokens: null,
  costUsd: 0.01,
};
const report: InvocationUsageReport = {
  source: "test.provider",
  attribution: "turn",
  completeness: "reported",
  nativeSubagentUsage: "included",
  models: [modelUsage],
};
const baseEvent = {
  provider: ProviderDriverKind.make("claude"),
  providerInstanceId: instanceId,
  threadId: workerId,
};
const persist = Effect.fn(function* (event: ProviderRuntimeEvent) {
  const repository = yield* ProjectionThreadActivityRepository;
  for (const activity of runtimeEventToActivities(event)) {
    const { id, ...fields } = activity;
    yield* repository.upsert({ ...fields, activityId: id, threadId: event.threadId });
  }
});
const makeLayer = (records: readonly Delegation[]) =>
  Layer.mergeAll(DelegationUsageService.layer, ProjectionThreadActivityRepositoryLive).pipe(
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getThreadShellById: (id) =>
          Effect.succeed(id === callerId ? Option.some(caller) : Option.none()),
        getDelegations: (ids) => Effect.succeed(records.filter(({ id }) => ids.includes(id))),
      }),
    ),
    Layer.provide(SqlitePersistenceMemory),
  );

it.effect(
  "links exact turns, supports repeated reads and replaces duplicate terminal snapshots",
  () => {
    const first = delegation("usage-first");
    const second = delegation("usage-second");
    return Effect.gen(function* () {
      const service = yield* DelegationUsageService.DelegationUsageService;
      const turnId = TurnId.make("usage-first");
      yield* persist({
        ...baseEvent,
        type: "turn.started",
        eventId: EventId.make("start"),
        createdAt: startedAt,
        turnId,
        payload: {},
      });
      yield* persist({
        ...baseEvent,
        type: "turn.started",
        eventId: EventId.make("duplicate-start"),
        createdAt: "2026-09-06T12:00:01.000Z",
        turnId,
        payload: {},
      });
      const completed = {
        ...baseEvent,
        type: "turn.completed",
        eventId: EventId.make("complete"),
        createdAt: finishedAt,
        turnId,
        payload: { state: "completed", invocationUsage: report },
      } satisfies ProviderRuntimeEvent;
      yield* persist(completed);
      yield* persist({ ...completed, eventId: EventId.make("duplicate-completion") });
      yield* persist({
        ...completed,
        eventId: EventId.make("duplicate-without-usage"),
        createdAt: "2026-09-06T12:00:10.000Z",
        payload: { state: "completed" },
      });
      yield* persist({
        ...completed,
        turnId: TurnId.make("prior-turn"),
        payload: {
          state: "completed",
          invocationUsage: { ...report, models: [{ ...modelUsage, inputTokens: 999999 }] },
        },
      });
      yield* persist({
        ...baseEvent,
        type: "task.progress",
        eventId: EventId.make("native-child"),
        createdAt: finishedAt,
        payload: {
          taskId: RuntimeTaskId.make("child"),
          description: "Child",
          typedUsage: { totalTokens: 9999 },
        },
      });
      const response = yield* service.read(callerId, { delegationIds: [first.id, second.id] });
      expect(isUsageResult(response)).toBe(true);
      expect(response.delegations[0]).toMatchObject({
        requester: first.requester,
        targetThreadId: workerId,
        turnId,
        durationMs: 2000,
        usage: { status: "recorded", providerInstanceId: instanceId, report },
      });
      expect(response.delegations[1]?.usage).toEqual({
        status: "unavailable",
        reason: "notRecorded",
      });
      const serialized = yield* encodeUsageResult(response);
      expect(serialized).not.toContain("Private prompt");
      expect(serialized).not.toContain("9999");
      // Re-reading must not consume or increment usage.
      const reread = yield* service.read(callerId, { delegationIds: [first.id] });
      expect(reread.delegations[0]).toEqual(response.delegations[0]);
    }).pipe(Effect.provide(makeLayer([first, second])));
  },
);

it.effect("keeps unsupported, interrupted and unstarted usage explicit", () => {
  const unsupported = delegation("unsupported");
  const interrupted = delegation("interrupted", { state: "interrupted" });
  const pending = delegation("pending", { state: "requested", targetThreadId: null, turnId: null });
  return Effect.gen(function* () {
    const service = yield* DelegationUsageService.DelegationUsageService;
    yield* persist({
      ...baseEvent,
      type: "turn.completed",
      eventId: EventId.make("unsupported"),
      turnId: TurnId.make("unsupported"),
      createdAt: finishedAt,
      payload: { state: "completed" },
    });
    yield* persist({
      ...baseEvent,
      type: "turn.aborted",
      eventId: EventId.make("interrupted"),
      turnId: TurnId.make("interrupted"),
      createdAt: finishedAt,
      payload: { reason: "cancelled", invocationUsage: { ...report, completeness: "partial" } },
    });
    const response = yield* service.read(callerId, {
      delegationIds: [unsupported.id, interrupted.id, pending.id],
    });
    expect(response.delegations[0]?.usage).toMatchObject({ status: "recorded", report: null });
    expect(response.delegations[1]?.usage).toMatchObject({
      status: "recorded",
      state: "interrupted",
      report: { completeness: "partial" },
    });
    expect(response.delegations[1]?.durationMs).toBeNull();
    expect(response.delegations[2]?.usage).toEqual({ status: "unavailable", reason: "notStarted" });
  }).pipe(Effect.provide(makeLayer([unsupported, interrupted, pending])));
});

it.effect("rejects cross-project, missing and duplicate delegations", () => {
  const own = delegation("owned");
  const foreign = delegation("foreign", { projectId: ProjectId.make("another-project") });
  return Effect.gen(function* () {
    const service = yield* DelegationUsageService.DelegationUsageService;
    for (const ids of [
      [foreign.id],
      [own.id, foreign.id],
      [own.id, own.id],
      [DelegationId.make("missing")],
    ]) {
      const error = yield* service.read(callerId, { delegationIds: ids }).pipe(Effect.flip);
      expect(error.reason).toBe("unavailable");
    }
    const absentCaller = yield* service
      .read(ThreadId.make("absent"), { delegationIds: [own.id] })
      .pipe(Effect.flip);
    expect(absentCaller.reason).toBe("unavailable");
  }).pipe(Effect.provide(makeLayer([own, foreign])));
});
