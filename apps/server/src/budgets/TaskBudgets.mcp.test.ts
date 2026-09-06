import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { McpSchema, McpServer } from "effect/unstable/ai";
import {
  EnvironmentId,
  ProviderInstanceId,
  TaskBudgetConfiguration,
  TaskBudgetStatus,
  ThreadId,
} from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";

const decodeStatus = Schema.decodeUnknownEffect(TaskBudgetStatus);
const encodeConfiguration = Schema.encodeEffect(Schema.fromJsonString(TaskBudgetConfiguration));
const threadId = ThreadId.make("budget-root");
const testLayer = Layer.mergeAll(
  McpHttpServer.UsageToolkitRegistrationLive,
  McpHttpServer.KanbanToolkitRegistrationLive,
).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "budget-mcp-" })),
  Layer.provideMerge(NodeServices.layer),
);
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "budget-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const invocation = {
  environmentId: EnvironmentId.make("environment"),
  threadId,
  providerSessionId: "session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["usage.read", "kanban.write"] as const),
  issuedAt: 1,
};
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  const encoded = yield* encodeConfiguration({
    version: 1,
    policies: [
      {
        rootThreadId: threadId,
        maxCalls: 2,
        maxConsultations: 0,
        maxConcurrentWorkers: 1,
        maxTokens: 2000,
        deadline: "2040-01-01T00:00:00.000Z",
        models: [
          {
            instanceId: ProviderInstanceId.make("codex"),
            model: "luna",
            consultation: false,
            reserveTokens: 1000,
          },
        ],
      },
    ],
  });
  yield* fs.writeFileString(`${config.stateDir}/task-budgets.json`, encoded);
});

it.effect("exposes only the calling thread budget and denies reads without usage capability", () =>
  Effect.gen(function* () {
    yield* setup;
    const server = yield* McpServer.McpServer;
    const call = server
      .callTool({ name: "budget_status", arguments: {} })
      .pipe(Effect.provideService(McpSchema.McpServerClient, client));
    const result = yield* call.pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    );
    expect(result.isError).toBe(false);
    const status = yield* decodeStatus(result.structuredContent);
    expect(status).toMatchObject({ threadId, rootThreadId: threadId, calls: 0 });
    const denied = yield* call.pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...invocation,
        capabilities: new Set<McpInvocationContext.McpCapability>(),
      }),
    );
    expect(denied.isError).toBe(true);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("blocks budgeted MCP Kanban mutations before they can create detached work", () =>
  Effect.gen(function* () {
    yield* setup;
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "kanban_write",
        arguments: {
          action: "delete",
          requestId: "delete-card",
          cardId: "card",
          expectedRevision: 1,
        },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("Budgeted agents cannot change Kanban cards"),
        }),
      ]),
    );
  }).pipe(Effect.provide(testLayer)),
);
