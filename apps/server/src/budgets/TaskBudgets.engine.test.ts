import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DelegationId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  TaskBudgetConfiguration,
  ThreadId,
} from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import {
  SqlitePersistenceMemory,
  makeSqlitePersistenceLive,
} from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { createEmptyReadModel } from "../orchestration/projector.ts";
import * as TaskBudgets from "./TaskBudgets.ts";

const encodeConfiguration = Schema.encodeEffect(Schema.fromJsonString(TaskBudgetConfiguration));
const threadId = ThreadId.make("root");
const projectId = ProjectId.make("project");
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "luna" };
const createdAt = "2030-01-01T00:00:00.000Z";
const hostLayer = ServerConfig.layerTest(process.cwd(), { prefix: "budget-engine-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const engineLayer = OrchestrationEngineLive.pipe(
  Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(OrchestrationProjectionPipelineLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(hostLayer),
);
const configure = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const text = yield* encodeConfiguration({
    version: 1,
    policies: [
      {
        rootThreadId: threadId,
        maxCalls: 1,
        maxConsultations: 0,
        maxConcurrentWorkers: 1,
        maxTokens: 1000,
        deadline: "2040-01-01T00:00:00.000Z",
        models: [{ ...selection, consultation: false, reserveTokens: 1000 }],
      },
    ],
  });
  yield* fs.writeFileString(`${config.stateDir}/task-budgets.json`, text);
});

it.effect(
  "gates real engine dispatch, freezes the admitted selection, and reuses accepted command receipts",
  () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      yield* configure;
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("project"),
        projectId,
        title: "Budget test",
        workspaceRoot: "/tmp/budget-test",
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("thread"),
        threadId,
        projectId,
        title: "Root",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      const command = {
        type: "thread.turn.start" as const,
        commandId: CommandId.make("start"),
        threadId,
        message: {
          messageId: MessageId.make("message"),
          role: "user" as const,
          text: "Please work",
          attachments: [],
        },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        createdAt,
      };
      const first = yield* engine.dispatch(command);
      const replay = yield* engine.dispatch(command);
      expect(replay).toEqual(first);
      expect(yield* sql`SELECT reservation_id FROM task_budget_reservations`).toHaveLength(1);
      const events = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_events WHERE event_type = 'thread.turn-start-requested'`;
      expect(events[0]?.payload_json).toContain(
        '"modelSelection":{"instanceId":"codex","model":"luna"}',
      );
      const error = yield* engine
        .dispatch({
          type: "delegation.request",
          commandId: CommandId.make("child"),
          delegationId: DelegationId.make("child"),
          projectId,
          requester: { kind: "thread", threadId, requestId: "child" },
          target: { kind: "newThread", modelSelection: selection },
          title: "Review",
          task: "Review it",
          createdAt,
        })
        .pipe(Effect.flip);
      expect(error.message).toContain("call allowance");
      expect(yield* sql`SELECT reservation_id FROM task_budget_reservations`).toHaveLength(1);
    }).pipe(Effect.provide(engineLayer)),
);

it.effect("keeps admitted charges after closing and reopening the SQLite database", () =>
  Effect.gen(function* () {
    yield* configure;
    const config = yield* ServerConfig;
    yield* Effect.gen(function* () {
      const budget = yield* TaskBudgets.make;
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        budget.applyCommand(
          {
            type: "delegation.request",
            commandId: CommandId.make("child"),
            delegationId: DelegationId.make("child"),
            projectId,
            requester: { kind: "thread", threadId, requestId: "child" },
            target: { kind: "newThread", modelSelection: selection },
            title: "Review",
            task: "Review it",
            createdAt,
          },
          { ...createEmptyReadModel(createdAt), delegations: [] },
        ),
      );
    }).pipe(Effect.provide(makeSqlitePersistenceLive(config.dbPath)));
    yield* Effect.gen(function* () {
      const budget = yield* TaskBudgets.make;
      expect(yield* budget.read(threadId)).toMatchObject({
        calls: 1,
        activeWorkers: 1,
        committedTokens: 1000,
      });
    }).pipe(Effect.provide(makeSqlitePersistenceLive(config.dbPath)));
  }).pipe(Effect.provide(hostLayer)),
);
