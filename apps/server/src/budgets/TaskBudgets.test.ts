import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { TestClock } from "effect/testing";
import {
  CommandId,
  DelegationId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  TaskBudgetConfiguration,
  ThreadId,
  TurnId,
  type TaskBudgetPolicy,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { createEmptyReadModel } from "../orchestration/projector.ts";
import * as TaskBudgets from "./TaskBudgets.ts";

const encodeConfiguration = Schema.encodeEffect(Schema.fromJsonString(TaskBudgetConfiguration));
const root = ThreadId.make("budget-root");
const child = ThreadId.make("budget-child");
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "luna" };
const timestamp = "2030-01-01T00:00:00.000Z";
const model = { ...createEmptyReadModel(timestamp), delegations: [] };
const policy: TaskBudgetPolicy = {
  rootThreadId: root,
  maxCalls: 8,
  maxConsultations: 1,
  maxConcurrentWorkers: 2,
  deadline: "2040-01-01T00:00:00.000Z",
  maxTokens: 8000,
  models: [
    { ...selection, consultation: false, reserveTokens: 1000 },
    { instanceId: selection.instanceId, model: "astra", consultation: true, reserveTokens: 2000 },
  ],
};
const testLayer = () =>
  SqlitePersistenceMemory.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "task-budgets-" })),
    Layer.provideMerge(NodeServices.layer),
  );
const setup = Effect.fn("test.setup")(function* (overrides: Partial<TaskBudgetPolicy> = {}) {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const budgets = yield* TaskBudgets.make;
  const write = (policies: ReadonlyArray<TaskBudgetPolicy>) =>
    encodeConfiguration({
      version: 1,
      policies,
    }).pipe(
      Effect.flatMap((text) => fs.writeFileString(`${config.stateDir}/task-budgets.json`, text)),
    );
  yield* write([{ ...policy, ...overrides }]);
  return {
    budgets,
    fs,
    config,
    sql,
    write,
    apply: (command: OrchestrationCommand) =>
      sql.withTransaction(budgets.applyCommand(command, model)),
  };
});
const start = (
  id: string,
  threadId = root,
  modelSelection = selection,
): Extract<OrchestrationCommand, { type: "thread.turn.start" }> => ({
  type: "thread.turn.start",
  commandId: CommandId.make(id),
  threadId,
  message: {
    messageId: MessageId.make(id),
    role: "user",
    text: "Please do the work",
    attachments: [],
  },
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: timestamp,
});
const request = (
  id: string,
  requester = root,
  modelSelection = selection,
): OrchestrationCommand => ({
  type: "delegation.request",
  commandId: CommandId.make(`request-${id}`),
  delegationId: DelegationId.make(id),
  projectId: ProjectId.make("project"),
  requester: { kind: "thread", threadId: requester, requestId: id },
  target: { kind: "newThread", modelSelection },
  title: "Review",
  task: "Review the change",
  createdAt: timestamp,
});
const bind = (id: string, threadId = child): OrchestrationCommand => ({
  type: "delegation.provision.start",
  commandId: CommandId.make(`bind-${id}`),
  delegationId: DelegationId.make(id),
  targetThreadId: threadId,
  createdAt: timestamp,
});
const delegatedStart = (id: string, threadId = child): OrchestrationCommand => ({
  ...start(`start-${id}`, threadId),
  delegationId: DelegationId.make(id),
});
const activity = (
  kind: string,
  threadId: ThreadId,
  turn: string,
  payload: unknown = {},
): OrchestrationCommand => ({
  type: "thread.activity.append",
  commandId: CommandId.make(`${kind}-${turn}`),
  threadId,
  createdAt: timestamp,
  activity: {
    id: EventId.make(`${kind}-${turn}`),
    kind,
    summary: kind,
    tone: "info",
    turnId: TurnId.make(turn),
    createdAt: timestamp,
    payload,
  },
});

it.effect(
  "keeps the coordinator slot separate and atomically reserves pending worker capacity",
  () =>
    Effect.gen(function* () {
      const { apply, budgets } = yield* setup({ maxConcurrentWorkers: 1 });
      yield* apply(start("root-start"));
      const results = yield* Effect.all(
        ["a", "b"].map((id) => apply(request(id)).pipe(Effect.exit)),
        { concurrency: "unbounded" },
      );
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
      const status = yield* budgets.read(root);
      expect(status).toMatchObject({
        calls: 2,
        activeWorkers: 1,
        activeCoordinator: 1,
        committedTokens: 2000,
      });
    }).pipe(Effect.provide(testLayer())),
);

it.effect("inherits a root through provision, direct sends and grandchildren", () =>
  Effect.gen(function* () {
    const { apply, budgets, write } = yield* setup({ maxCalls: 3 });
    yield* apply(start("root-start"));
    yield* apply(request("a"));
    yield* apply(bind("a"));
    yield* write([policy, { ...policy, rootThreadId: child, maxCalls: 999 }]);
    yield* apply(delegatedStart("a"));
    yield* apply(request("grandchild", child));
    expect((yield* budgets.read(child)).rootThreadId).toBe(root);
    yield* write([
      { ...policy, maxCalls: 3 },
      { ...policy, rootThreadId: child, maxCalls: 999 },
    ]);
    const denied = yield* apply(request("escape", child)).pipe(Effect.exit);
    expect(denied._tag).toBe("Failure");
    expect((yield* budgets.read(root)).calls).toBe(3);
  }).pipe(Effect.provide(testLayer())),
);

it.effect("checks deadlines against host time at both reservation and turn admission", () =>
  Effect.gen(function* () {
    const deadline = "2030-01-01T00:00:01.000Z";
    yield* TestClock.setTime(Date.parse(timestamp));
    const { apply, budgets } = yield* setup({ deadline });
    yield* apply(request("a"));
    yield* apply(bind("a"));
    yield* TestClock.adjust("1 second");
    expect((yield* apply(delegatedStart("a")).pipe(Effect.exit))._tag).toBe("Failure");
    expect((yield* apply(start("old-caller-time")).pipe(Effect.exit))._tag).toBe("Failure");
    expect((yield* budgets.read(root)).deadlineExceeded).toBe(true);
  }).pipe(Effect.provide(testLayer())),
);

it.effect("classifies consultations by provider model and rejects unlisted models", () =>
  Effect.gen(function* () {
    const { apply, budgets } = yield* setup();
    yield* apply(request("a", root, { ...selection, model: "astra" }));
    expect(
      (yield* apply(request("b", root, { ...selection, model: "astra" })).pipe(Effect.exit))._tag,
    ).toBe("Failure");
    expect(
      (yield* apply(request("c", root, { ...selection, model: "unlisted" })).pipe(Effect.exit))
        ._tag,
    ).toBe("Failure");
    expect((yield* budgets.read(root)).consultations).toBe(1);
  }).pipe(Effect.provide(testLayer())),
);

it.effect(
  "retains policy, counters and pending reservations after service recreation and file removal",
  () =>
    Effect.gen(function* () {
      const { apply, fs, config, sql } = yield* setup({ maxCalls: 1 });
      yield* apply(request("a"));
      yield* fs.remove(`${config.stateDir}/task-budgets.json`);
      const restarted = yield* TaskBudgets.make;
      expect((yield* restarted.read(root)).calls).toBe(1);
      expect(
        (yield* sql.withTransaction(restarted.applyCommand(request("b"), model)).pipe(Effect.exit))
          ._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(testLayer())),
);

it.effect("rolls back reservations if the enclosing event transaction fails", () =>
  Effect.gen(function* () {
    const { sql, budgets } = yield* setup();
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* budgets.applyCommand(request("a"), model);
          return yield* Effect.fail("projector failed");
        }),
      )
      .pipe(Effect.exit);
    expect((yield* budgets.read(root)).calls).toBe(0);
  }).pipe(Effect.provide(testLayer())),
);

it.effect(
  "never releases dispatched work for an interrupt request or uncertain delegation failure",
  () =>
    Effect.gen(function* () {
      const { apply, budgets } = yield* setup();
      yield* apply(request("a"));
      yield* apply(bind("a"));
      yield* apply(delegatedStart("a"));
      yield* apply({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("interrupt"),
        threadId: child,
        createdAt: timestamp,
      });
      yield* apply({
        type: "delegation.complete",
        commandId: CommandId.make("failed"),
        delegationId: DelegationId.make("a"),
        outcome: "failed",
        failure: { code: "uncertain", detail: "Launch uncertain" },
        createdAt: timestamp,
      });
      expect((yield* budgets.read(root)).activeWorkers).toBe(1);
    }).pipe(Effect.provide(testLayer())),
);

it.effect(
  "charges known token overruns once, never refunds partial reports, and matches terminal turns exactly",
  () =>
    Effect.gen(function* () {
      const { apply, budgets } = yield* setup({ maxTokens: 3500 });
      yield* apply(request("a"));
      yield* apply(bind("a"));
      yield* apply(delegatedStart("a"));
      yield* budgets.claimDispatch({
        threadId: child,
        commandId: "start-a",
        modelSelection: selection,
      });
      yield* apply({
        type: "thread.session.set",
        commandId: CommandId.make("session"),
        threadId: child,
        createdAt: timestamp,
        session: {
          threadId: child,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-a"),
          lastError: null,
          updatedAt: timestamp,
        },
      });
      const report = {
        source: "test",
        attribution: "reportingWindow",
        completeness: "partial",
        nativeSubagentUsage: "included",
        models: [
          {
            model: "luna",
            inputTokens: 2000,
            outputTokens: 1000,
            cachedInputTokens: 1000,
            cacheCreationTokens: null,
            reasoningTokens: 100,
            costUsd: null,
          },
        ],
      };
      yield* apply(activity("invocation.usage", child, "turn-a", { report }));
      yield* apply(activity("invocation.usage", child, "turn-a", { report }));
      yield* apply(activity("invocation.finished", child, "old-turn"));
      expect(yield* budgets.read(root)).toMatchObject({ committedTokens: 3000, activeWorkers: 1 });
      expect((yield* apply(request("b")).pipe(Effect.exit))._tag).toBe("Failure");
      yield* apply(activity("invocation.finished", child, "turn-a"));
      yield* apply(
        activity("invocation.usage", child, "turn-a", {
          report: { ...report, models: [{ ...report.models[0], inputTokens: 1, outputTokens: 1 }] },
        }),
      );
      expect(yield* budgets.read(root)).toMatchObject({ committedTokens: 3000, activeWorkers: 0 });
    }).pipe(Effect.provide(testLayer())),
);

it.effect("reuses a pending delegation reservation but rejects a second dispatch ID", () =>
  Effect.gen(function* () {
    const { apply, budgets } = yield* setup();
    yield* apply(request("a"));
    yield* apply(request("a"));
    yield* apply(bind("a"));
    yield* apply(delegatedStart("a"));
    expect((yield* budgets.read(root)).calls).toBe(1);
    expect((yield* apply(delegatedStart("a")).pipe(Effect.exit))._tag).toBe("Failure");
  }).pipe(Effect.provide(testLayer())),
);

it.effect("fails closed on malformed policy without modifying the ledger", () =>
  Effect.gen(function* () {
    const { apply, fs, config, sql } = yield* setup();
    yield* fs.writeFileString(`${config.stateDir}/task-budgets.json`, "{bad");
    expect((yield* apply(request("a")).pipe(Effect.exit))._tag).toBe("Failure");
    expect(yield* sql`SELECT * FROM task_budget_reservations`).toHaveLength(0);
  }).pipe(Effect.provide(testLayer())),
);

it.effect("releases a known pre-dispatch failure but keeps its call/token charge", () =>
  Effect.gen(function* () {
    const { apply, budgets } = yield* setup();
    yield* apply(request("a"));
    yield* apply({
      type: "delegation.complete",
      commandId: CommandId.make("failed"),
      delegationId: DelegationId.make("a"),
      outcome: "failed",
      failure: { code: "setup", detail: "No turn dispatched" },
      createdAt: timestamp,
    });
    expect(yield* budgets.read(root)).toMatchObject({
      calls: 1,
      activeWorkers: 0,
      committedTokens: 1000,
    });
  }).pipe(Effect.provide(testLayer())),
);

it.effect("rejects direct unlabelled worker turns after the inherited allowance is exhausted", () =>
  Effect.gen(function* () {
    const { apply, budgets } = yield* setup({ maxCalls: 1 });
    yield* apply(request("a"));
    yield* apply(bind("a"));
    yield* apply({
      type: "delegation.complete",
      commandId: CommandId.make("failed"),
      delegationId: DelegationId.make("a"),
      outcome: "failed",
      failure: { code: "setup", detail: "No turn dispatched" },
      createdAt: timestamp,
    });
    expect((yield* apply(start("direct", child)).pipe(Effect.exit))._tag).toBe("Failure");
    expect(yield* budgets.read(child)).toMatchObject({ rootThreadId: root, calls: 1 });
  }).pipe(Effect.provide(testLayer())),
);

it.effect(
  "rechecks deadline at dispatch after preparation and releases only known unlaunched work",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(timestamp));
      const { apply, budgets } = yield* setup({ deadline: "2030-01-01T00:00:01.000Z" });
      yield* apply(request("a"));
      yield* apply(bind("a"));
      yield* apply(delegatedStart("a"));
      yield* TestClock.adjust("1 second");
      const result = yield* budgets
        .claimDispatch({ threadId: child, commandId: "start-a", modelSelection: selection })
        .pipe(Effect.exit);
      expect(result._tag).toBe("Failure");
      yield* budgets.releaseUnlaunched(child, "wrong-command");
      expect((yield* budgets.read(root)).activeWorkers).toBe(1);
      yield* budgets.releaseUnlaunched(child, "start-a");
      expect(yield* budgets.read(root)).toMatchObject({
        calls: 1,
        activeWorkers: 0,
        committedTokens: 1000,
      });
    }).pipe(Effect.provide(testLayer())),
);

it.effect("refuses duplicate dispatch after restart and retains uncertain claimed capacity", () =>
  Effect.gen(function* () {
    const { apply, budgets } = yield* setup();
    yield* apply(request("a"));
    yield* apply(bind("a"));
    yield* apply(delegatedStart("a"));
    yield* budgets.claimDispatch({
      threadId: child,
      commandId: "start-a",
      modelSelection: selection,
    });
    const restarted = yield* TaskBudgets.make;
    expect(
      (yield* restarted
        .claimDispatch({ threadId: child, commandId: "start-a", modelSelection: selection })
        .pipe(Effect.exit))._tag,
    ).toBe("Failure");
    yield* restarted.releaseUnlaunched(child, "start-a");
    expect((yield* restarted.read(root)).activeWorkers).toBe(1);
  }).pipe(Effect.provide(testLayer())),
);

it.effect("still records terminal acknowledgement when the policy file is invalid", () =>
  Effect.gen(function* () {
    const { apply, budgets, fs, config, sql } = yield* setup();
    yield* apply(request("a"));
    yield* apply(bind("a"));
    yield* apply(delegatedStart("a"));
    yield* budgets.claimDispatch({
      threadId: child,
      commandId: "start-a",
      modelSelection: selection,
    });
    yield* apply({
      type: "thread.session.set",
      commandId: CommandId.make("session"),
      threadId: child,
      createdAt: timestamp,
      session: {
        threadId: child,
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: TurnId.make("turn-a"),
        lastError: null,
        updatedAt: timestamp,
      },
    });
    yield* fs.writeFileString(`${config.stateDir}/task-budgets.json`, "invalid");
    yield* apply(activity("invocation.finished", child, "turn-a"));
    expect(
      (yield* sql<{ phase: string }>`SELECT phase FROM task_budget_reservations`)[0]?.phase,
    ).toBe("finished");
  }).pipe(Effect.provide(testLayer())),
);

it.effect("refuses initial activation on a root with existing delegation history", () =>
  Effect.gen(function* () {
    const { budgets, sql } = yield* setup();
    const old = {
      id: DelegationId.make("old"),
      projectId: ProjectId.make("project"),
      requester: { kind: "thread" as const, threadId: root, requestId: "old" },
      target: { kind: "newThread" as const, modelSelection: selection },
      title: "Old work",
      task: "Already done",
      state: "completed" as const,
      targetThreadId: child,
      turnId: null,
      assistantMessageId: null,
      failure: null,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const result = yield* sql
      .withTransaction(
        budgets.applyCommand(start("late-activation"), { ...model, delegations: [old] }),
      )
      .pipe(Effect.exit);
    expect(result._tag).toBe("Failure");
    expect(yield* sql`SELECT * FROM task_budget_policies`).toHaveLength(0);
  }).pipe(Effect.provide(testLayer())),
);
