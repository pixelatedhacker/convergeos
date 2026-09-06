import * as Schema from "effect/Schema";

import {
  CommandId,
  DelegationId,
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
  DelegationFailure,
  DelegationState,
  ModelSelection,
  RuntimeMode,
  OrchestrationLatestTurnState,
  OrchestrationSessionStatus,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "./orchestration.ts";
import { ServerProviderAuthStatus, ServerProviderModel, ServerProviderState } from "./server.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const AgentMeshOperation = Schema.Literals([
  "models",
  "list",
  "read",
  "spawn",
  "send",
  "wait",
  "interrupt",
]);
export type AgentMeshOperation = typeof AgentMeshOperation.Type;

export const AgentMeshAgent = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  sessionStatus: Schema.NullOr(OrchestrationSessionStatus),
  latestTurnState: Schema.NullOr(OrchestrationLatestTurnState),
  activeTurnId: Schema.NullOr(TurnId),
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  mcpAttachment: Schema.NullOr(Schema.Literals(["attached", "notRequested", "leafOnly"])),
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  backgroundLiveness: Schema.NullOr(Schema.Literals(["working", "monitoring"])),
  workspaceIsolation: Schema.Literals(["shared", "isolated"]),
  updatedAt: IsoDateTime,
  current: Schema.Boolean,
  botProfile: Schema.optional(BotProfile),
});
export type AgentMeshAgent = typeof AgentMeshAgent.Type;

export const AgentMeshModelsInput = Schema.Struct({
  instanceId: Schema.optional(ProviderInstanceId),
  query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
  offset: Schema.optional(NonNegativeInt),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type AgentMeshModelsInput = typeof AgentMeshModelsInput.Type;

export const AgentMeshModelsResult = Schema.Struct({
  projectId: ProjectId,
  models: Schema.Array(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      driver: ProviderDriverKind,
      enabled: Schema.Boolean,
      installed: Schema.Boolean,
      status: ServerProviderState,
      authStatus: ServerProviderAuthStatus,
      checkedAt: IsoDateTime,
      supportedRuntimeModes: Schema.NullOr(Schema.Array(RuntimeMode)),
      model: ServerProviderModel,
    }),
  ),
  nextOffset: Schema.NullOr(NonNegativeInt),
});
export type AgentMeshModelsResult = typeof AgentMeshModelsResult.Type;

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

export const AgentMeshSpawnInput = Schema.Struct({
  requestId: AgentMeshRequestId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  modelSelection: Schema.optional(ModelSelection),
});
export type AgentMeshSpawnInput = typeof AgentMeshSpawnInput.Type;

export const AgentMeshWaitInput = Schema.Struct({
  delegationIds: Schema.Array(DelegationId).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  timeoutMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50_000 }))),
  maxChars: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 256, maximum: 32_000 }))),
});
export type AgentMeshWaitInput = typeof AgentMeshWaitInput.Type;

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

export const AgentMeshAssistantOutput = Schema.Struct({
  messageId: MessageId,
  turnId: Schema.NullOr(TurnId),
  text: Schema.String,
  truncated: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type AgentMeshAssistantOutput = typeof AgentMeshAssistantOutput.Type;

export const AgentMeshReadResult = Schema.Struct({
  agent: AgentMeshAgent,
  latestAssistant: Schema.NullOr(AgentMeshAssistantOutput),
});
export type AgentMeshReadResult = typeof AgentMeshReadResult.Type;

export const AgentMeshDispatchReceipt = Schema.Struct({
  targetThreadId: ThreadId,
  commandId: CommandId,
  messageId: Schema.optional(MessageId),
  sequence: NonNegativeInt,
});
export type AgentMeshDispatchReceipt = typeof AgentMeshDispatchReceipt.Type;

export const AgentMeshDelegationDispatchReceipt = Schema.Struct({
  delegationId: DelegationId,
  targetThreadId: Schema.NullOr(ThreadId),
  commandId: CommandId,
  messageId: MessageId,
  sequence: NonNegativeInt,
  state: DelegationState,
});
export type AgentMeshDelegationDispatchReceipt = typeof AgentMeshDelegationDispatchReceipt.Type;

export const AgentMeshDelegationView = Schema.Struct({
  delegationId: DelegationId,
  targetThreadId: Schema.NullOr(ThreadId),
  state: DelegationState,
  turnId: Schema.NullOr(TurnId),
  failure: Schema.NullOr(DelegationFailure),
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  latestAssistant: Schema.NullOr(AgentMeshAssistantOutput),
  updatedAt: IsoDateTime,
});
export type AgentMeshDelegationView = typeof AgentMeshDelegationView.Type;

export const AgentMeshWaitResult = Schema.Struct({
  reason: Schema.Literals(["completed", "failed", "interrupted", "attention", "timeout"]),
  delegations: Schema.Array(AgentMeshDelegationView),
  cursor: NonNegativeInt,
});
export type AgentMeshWaitResult = typeof AgentMeshWaitResult.Type;

export class AgentMeshError extends Schema.TaggedErrorClass<AgentMeshError>()("AgentMeshError", {
  operation: AgentMeshOperation,
  reason: Schema.Literals([
    "capabilityDenied",
    "callerUnavailable",
    "targetUnavailable",
    "targetNotBot",
    "targetBusy",
    "selfTarget",
    "workspaceShared",
    "repositoryUnavailable",
    "delegationUnavailable",
    "provisionFailed",
    "waitFailed",
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
      case "targetNotBot":
        return "The target thread is not an active bot.";
      case "targetBusy":
        return "The target bot is already working or waiting for input.";
      case "selfTarget":
        return "An agent cannot target its own active thread.";
      case "workspaceShared":
        return "The target agent shares this thread's mutable workspace.";
      case "repositoryUnavailable":
        return "A new agent requires a Git-backed project with a resolvable base branch.";
      case "delegationUnavailable":
        return "The requested delegation is unavailable in this project.";
      case "provisionFailed":
        return "The delegated worker could not be provisioned.";
      case "waitFailed":
        return "Delegation state could not be read while waiting.";
      case "dispatchFailed":
        return `The agent ${this.operation} command could not be accepted.`;
    }
  }
}
