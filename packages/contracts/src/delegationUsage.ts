import * as Schema from "effect/Schema";
import { DelegationId, IsoDateTime, NonNegativeInt, ThreadId, TurnId } from "./baseSchemas.ts";
import { DelegationRequester, DelegationState } from "./orchestration.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { InvocationUsageReport } from "./invocationUsage.ts";

export const InvocationUsageActivity = Schema.Struct({
  provider: ProviderDriverKind,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  state: Schema.Literals(["completed", "failed", "interrupted", "cancelled"]),
  report: Schema.NullOr(InvocationUsageReport),
});
export type InvocationUsageActivity = typeof InvocationUsageActivity.Type;

export const DelegationUsageInput = Schema.Struct({
  delegationIds: Schema.Array(DelegationId).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});
export type DelegationUsageInput = typeof DelegationUsageInput.Type;

export const DelegationUsageEntry = Schema.Struct({
  delegationId: DelegationId,
  requester: DelegationRequester,
  targetThreadId: Schema.NullOr(ThreadId),
  turnId: Schema.NullOr(TurnId),
  state: DelegationState,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  durationMs: Schema.NullOr(NonNegativeInt),
  usage: Schema.Union([
    Schema.Struct({
      status: Schema.Literal("recorded"),
      ...InvocationUsageActivity.fields,
    }),
    Schema.Struct({
      status: Schema.Literal("unavailable"),
      reason: Schema.Literals(["notStarted", "awaitingCompletion", "notRecorded"]),
    }),
  ]),
});
export type DelegationUsageEntry = typeof DelegationUsageEntry.Type;

export const DelegationUsageResult = Schema.Struct({
  contractVersion: Schema.Literal(1),
  delegations: Schema.Array(DelegationUsageEntry).check(Schema.isMaxLength(8)),
});
export type DelegationUsageResult = typeof DelegationUsageResult.Type;

export class DelegationUsageError extends Schema.TaggedError<DelegationUsageError>()(
  "DelegationUsageError",
  { reason: Schema.Literals(["unavailable", "readFailed"]) },
) {
  override get message(): string {
    return this.reason === "unavailable"
      ? "The requested delegation usage is unavailable in this project."
      : "Delegation usage could not be read.";
  }
}
