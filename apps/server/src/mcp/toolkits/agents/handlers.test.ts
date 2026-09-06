import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { vi } from "vite-plus/test";

import * as AgentMesh from "../../AgentMesh.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const threadId = ThreadId.make("thread-caller");
const list = vi.fn<AgentMesh.AgentMeshShape["list"]>();
const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-agents-mcp"),
  threadId,
  providerSessionId: "session-agents-mcp",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["agents.read"]),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "agents-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const TestLayer = McpHttpServer.AgentsToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(
    Layer.succeed(
      AgentMesh.AgentMesh,
      AgentMesh.AgentMesh.of({
        models: () => Effect.die("unused"),
        list: (scope, input) => list(scope, input),
        read: () => Effect.die("unused"),
        spawn: () => Effect.die("unused"),
        send: () => Effect.die("unused"),
        wait: () => Effect.die("unused"),
        interrupt: () => Effect.die("unused"),
      }),
    ),
  ),
);

it.effect("passes the credential-bound caller thread to the agent mesh", () =>
  Effect.gen(function* () {
    list.mockReturnValueOnce(
      Effect.succeed({ projectId: ProjectId.make("project-1"), agents: [], hasMore: false }),
    );
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "agents_list", arguments: { limit: 12 } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(result.isError).toBe(false);
    expect(list).toHaveBeenCalledWith({ threadId }, { limit: 12 });
  }).pipe(Effect.provide(TestLayer)),
);
