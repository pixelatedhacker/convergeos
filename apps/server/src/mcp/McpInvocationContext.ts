import {
  AgentMeshError,
  type AgentMeshOperation,
  type EnvironmentId,
  McpCapabilityUnavailableError,
  PreviewAutomationUnavailableError,
  KanbanMcpError,
  type KanbanMcpOperation,
  SubscriptionQuotaMcpUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type McpCapability =
  | "preview"
  | "device"
  | "pull-requests"
  | "usage.read"
  | "agents.read"
  | "agents.send"
  | "agents.control"
  | "kanban.read"
  | "kanban.write";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

/** The error a missing capability surfaces as; preview keeps its own so the broker can route it. */
export type McpCapabilityError<C extends McpCapability> = C extends "preview"
  ? PreviewAutomationUnavailableError
  : McpCapabilityUnavailableError;

const missingCapability = (
  invocation: McpInvocationScope,
  capability: McpCapability,
): PreviewAutomationUnavailableError | McpCapabilityUnavailableError => {
  const fields = {
    environmentId: invocation.environmentId,
    threadId: invocation.threadId,
    providerSessionId: invocation.providerSessionId,
    providerInstanceId: invocation.providerInstanceId,
  };
  return capability === "preview"
    ? new PreviewAutomationUnavailableError({ capability, ...fields })
    : new McpCapabilityUnavailableError({ capability, ...fields });
};

export const requireMcpCapability = <const C extends McpCapability>(
  capability: C,
): Effect.Effect<McpInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  Effect.flatMap(McpInvocationContext, (invocation) =>
    invocation.capabilities.has(capability)
      ? Effect.succeed(invocation)
      : // The conditional type narrows what the literal argument decided at runtime.
        Effect.fail(missingCapability(invocation, capability) as McpCapabilityError<C>),
  ).pipe(Effect.withSpan("mcp.requireCapability"));

export const requireAgentCapability = Effect.fn("mcp.requireAgentCapability")(function* (
  capability: "agents.read" | "agents.send" | "agents.control",
  operation: AgentMeshOperation,
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    return yield* new AgentMeshError({
      operation,
      reason: "capabilityDenied",
      targetThreadId: null,
    });
  }
  return invocation;
});

export const requireKanbanCapability = Effect.fn("mcp.requireKanbanCapability")(function* (
  capability: "kanban.read" | "kanban.write",
  operation: KanbanMcpOperation,
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    return yield* new KanbanMcpError({
      operation,
      reason: "capabilityDenied",
      detail: "MCP credential does not grant Kanban access.",
    });
  }
  return invocation;
});

export const requireUsageCapability = Effect.fn("mcp.requireUsageCapability")(function* () {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has("usage.read")) {
    return yield* new SubscriptionQuotaMcpUnavailableError({
      capability: "usage.read",
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return invocation;
});
