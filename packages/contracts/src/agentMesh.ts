import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import {
  AgentMeshRequestId,
  BotProfile,
  OrchestrationLatestTurnState,
  OrchestrationSessionStatus,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const AgentMeshOperation = Schema.Literals(["list", "read", "send", "interrupt"]);
export type AgentMeshOperation = typeof AgentMeshOperation.Type;

export const AgentMeshAgent = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  sessionStatus: Schema.NullOr(OrchestrationSessionStatus),
  latestTurnState: Schema.NullOr(OrchestrationLatestTurnState),
  activeTurnId: Schema.NullOr(TurnId),
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  backgroundLiveness: Schema.NullOr(Schema.Literals(["working", "monitoring"])),
  workspaceIsolation: Schema.Literals(["shared", "isolated"]),
  updatedAt: IsoDateTime,
  current: Schema.Boolean,
  botProfile: Schema.optional(BotProfile),
});
export type AgentMeshAgent = typeof AgentMeshAgent.Type;

export const AgentMeshListInput = Schema.Struct({
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  onlyBots: Schema.optional(Schema.Boolean),
});
export type AgentMeshListInput = typeof AgentMeshListInput.Type;

export const AgentMeshListResult = Schema.Struct({
  projectId: ProjectId,
  agents: Schema.Array(AgentMeshAgent),
  hasMore: Schema.Boolean,
});
export type AgentMeshListResult = typeof AgentMeshListResult.Type;

export const AgentMeshSendInput = Schema.Struct({
  requestId: AgentMeshRequestId,
  targetThreadId: ThreadId,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
});
export type AgentMeshSendInput = typeof AgentMeshSendInput.Type;

export const AgentMeshInterruptInput = Schema.Struct({
  requestId: AgentMeshRequestId,
  targetThreadId: ThreadId,
  observedTurnId: TurnId,
});
export type AgentMeshInterruptInput = typeof AgentMeshInterruptInput.Type;

export const AgentMeshReadInput = Schema.Struct({
  targetThreadId: ThreadId,
  maxChars: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 256, maximum: 32_000 }))),
});
export type AgentMeshReadInput = typeof AgentMeshReadInput.Type;

export const AgentMeshReadResult = Schema.Struct({
  agent: AgentMeshAgent,
  latestAssistant: Schema.NullOr(
    Schema.Struct({
      messageId: MessageId,
      turnId: Schema.NullOr(TurnId),
      text: Schema.String,
      truncated: Schema.Boolean,
      updatedAt: IsoDateTime,
    }),
  ),
});
export type AgentMeshReadResult = typeof AgentMeshReadResult.Type;

export const AgentMeshDispatchReceipt = Schema.Struct({
  targetThreadId: ThreadId,
  commandId: CommandId,
  messageId: Schema.optional(MessageId),
  sequence: NonNegativeInt,
});
export type AgentMeshDispatchReceipt = typeof AgentMeshDispatchReceipt.Type;

export class AgentMeshError extends Schema.TaggedErrorClass<AgentMeshError>()("AgentMeshError", {
  operation: AgentMeshOperation,
  reason: Schema.Literals([
    "capabilityDenied",
    "callerUnavailable",
    "targetUnavailable",
    "selfTarget",
    "workspaceShared",
    "dispatchFailed",
  ]),
  targetThreadId: Schema.NullOr(ThreadId),
}) {
  override get message(): string {
    switch (this.reason) {
      case "capabilityDenied":
        return `MCP credential does not grant permission to ${this.operation} agents.`;
      case "callerUnavailable":
        return "The calling agent thread is unavailable.";
      case "targetUnavailable":
        return "The target agent is unavailable in this project.";
      case "selfTarget":
        return "An agent cannot target its own active thread.";
      case "workspaceShared":
        return "The target agent shares this thread's mutable workspace.";
      case "dispatchFailed":
        return `The agent ${this.operation} command could not be accepted.`;
    }
  }
}
