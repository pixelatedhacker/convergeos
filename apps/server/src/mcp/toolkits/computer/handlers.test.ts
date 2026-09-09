import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as BotComputer from "../../../botComputer/BotComputerService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const environmentId = EnvironmentId.make("environment-computer-mcp");
const invocationThreadId = ThreadId.make("thread-computer-mcp");
const otherThreadId = ThreadId.make("thread-other");
let observedThreadId = otherThreadId;

const running = {
  threadId: invocationThreadId,
  status: "running",
  containerId: "container-id",
  viewerAccess: "authenticated-remote",
  isolation: "container",
  networkAccess: "outbound",
  warning: "This computer uses container isolation. It is not containment for hostile code.",
} as const;

const computer = BotComputer.BotComputerService.of({
  inspect: () => Effect.succeed(running),
  start: () => Effect.succeed(running),
  suspend: () => Effect.succeed({ ...running, status: "suspended" as const }),
  resume: () => Effect.succeed(running),
  reset: () => Effect.succeed(running),
  destroy: () => Effect.succeed({ ...running, status: "absent" as const }),
  viewerTarget: () => Effect.succeed({ containerId: "container-id", viewerPort: 49152 }),
  computerStatus: ({ threadId }) => {
    observedThreadId = threadId;
    return Effect.succeed({ ...running, threadId });
  },
  snapshot: ({ threadId }) => {
    observedThreadId = threadId;
    return Effect.succeed({
      mimeType: "image/png" as const,
      data: Buffer.from("png").toString("base64"),
      width: 10,
      height: 5,
    });
  },
  click: ({ threadId }) => {
    observedThreadId = threadId;
    return Effect.succeed({});
  },
  type: () => Effect.succeed({}),
  press: () => Effect.succeed({}),
  scroll: () => Effect.succeed({}),
});

const TestLayer = McpHttpServer.ComputerToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(Layer.succeed(BotComputer.BotComputerService, computer)),
);

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "computer-test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "computer-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const invocation = {
  environmentId,
  threadId: invocationThreadId,
  providerSessionId: "session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};

it.layer(TestLayer)("Bot computer MCP toolkit", (it) => {
  it.effect("registers annotations and returns snapshot image content", () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      for (const { tool } of server.tools) {
        expect(tool.inputSchema.type, `${tool.name} input schema`).toBe("object");
      }
      const statusTool = server.tools.find(({ tool }) => tool.name === "computer_status");
      const clickTool = server.tools.find(({ tool }) => tool.name === "computer_click");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);

      const snapshot = yield* server
        .callTool({ name: "computer_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some(({ type }) => type === "image")).toBe(true);
      expect(snapshot.structuredContent).toEqual({ mimeType: "image/png", width: 10, height: 5 });
    }),
  );

  it.effect("uses only the invocation thread and denies credentials without preview", () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      yield* server
        .callTool({ name: "computer_click", arguments: { x: 1, y: 2, button: "left" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(observedThreadId).toBe(invocationThreadId);

      const denied = yield* server.callTool({ name: "computer_status", arguments: {} }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...invocation,
          capabilities: new Set<"preview">(),
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
      expect(denied).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "MCP credential does not grant the preview capability." }],
      });
    }),
  );
});
