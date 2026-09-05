import * as Effect from "effect/Effect";

import * as AgentMesh from "../../AgentMesh.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { AgentsToolkit } from "./tools.ts";

const handlers = {
  agents_list: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.requireAgentCapability("agents.read", "list");
      const mesh = yield* AgentMesh.AgentMesh;
      return yield* mesh.list({ threadId: invocation.threadId }, input);
    }),
  agents_read: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.requireAgentCapability("agents.read", "read");
      const mesh = yield* AgentMesh.AgentMesh;
      return yield* mesh.read({ threadId: invocation.threadId }, input);
    }),
  agents_send: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.requireAgentCapability("agents.send", "send");
      const mesh = yield* AgentMesh.AgentMesh;
      return yield* mesh.send({ threadId: invocation.threadId }, input);
    }),
  agents_spawn: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.requireAgentCapability("agents.send", "spawn");
      const mesh = yield* AgentMesh.AgentMesh;
      return yield* mesh.spawn({ threadId: invocation.threadId }, input);
    }),
  agents_wait: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.requireAgentCapability("agents.read", "wait");
      const mesh = yield* AgentMesh.AgentMesh;
      return yield* mesh.wait({ threadId: invocation.threadId }, input);
    }),
  agents_interrupt: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.requireAgentCapability(
        "agents.control",
        "interrupt",
      );
      const mesh = yield* AgentMesh.AgentMesh;
      return yield* mesh.interrupt({ threadId: invocation.threadId }, input);
    }),
} satisfies Parameters<typeof AgentsToolkit.toLayer>[0];

export const AgentsToolkitHandlersLive = AgentsToolkit.toLayer(handlers);
