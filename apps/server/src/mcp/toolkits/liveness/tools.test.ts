import { assert, it } from "@effect/vitest";
import { DelegationId, EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { AgentLiveness } from "../../../mesh/AgentLiveness.ts";
import { LivenessToolkitRegistrationLive } from "../../McpHttpServer.ts";
import {
  McpInvocationContext,
  type McpCapability,
  type McpInvocationScope,
} from "../../McpInvocationContext.ts";

const caller = ThreadId.make("parent");
const delegationId = DelegationId.make("owned-work");
const invocation: McpInvocationScope = {
  environmentId: EnvironmentId.make("env"),
  threadId: caller,
  providerSessionId: "session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["agents.read"]),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "liveness-test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "liveness-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const calls: ThreadId[] = [];
const dependencies = LivenessToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(
    Layer.mock(AgentLiveness)({
      read: (threadId, input) =>
        Effect.sync(() => {
          calls.push(threadId);
          assert.deepEqual(input.delegationIds, [delegationId]);
          return {
            transport: "disabled",
            scope: "local-owned-delegations",
            observations: [{ delegationId, observation: null, freshness: "unknown" }],
          };
        }),
    }),
  ),
);

it.effect("liveness MCP uses only the credential caller and enforces agents.read", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = server
      .callTool({ name: "agents_liveness", arguments: { delegationIds: [delegationId] } })
      .pipe(Effect.provideService(McpSchema.McpServerClient, client));
    const result = yield* call.pipe(Effect.provideService(McpInvocationContext, invocation));
    assert.isFalse(result.isError ?? false);
    assert.deepEqual(calls, [caller]);
    const denied = yield* call.pipe(
      Effect.provideService(McpInvocationContext, {
        ...invocation,
        capabilities: new Set<McpCapability>(),
      }),
    );
    assert.isTrue(denied.isError);
    assert.deepEqual(calls, [caller]);
    const oversized = yield* server
      .callTool({
        name: "agents_liveness",
        arguments: { delegationIds: Array.from({ length: 9 }, () => delegationId) },
      })
      .pipe(
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provideService(McpInvocationContext, invocation),
        Effect.flip,
      );
    assert.include(oversized.message, "at most 8");
    assert.deepEqual(calls, [caller]);
  }).pipe(Effect.provide(dependencies)),
);
