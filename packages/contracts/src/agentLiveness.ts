import * as Schema from "effect/Schema";
import {
  DelegationId,
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TurnId,
} from "./baseSchemas.ts";

export const AgentLivenessObservation = Schema.Struct({
  version: Schema.Literal(1),
  exportEpoch: Schema.String.check(Schema.isMaxLength(120)),
  destinationDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  environmentId: EnvironmentId,
  keyId: Schema.String.check(Schema.isMaxLength(80)),
  projectId: ProjectId,
  delegationId: DelegationId,
  requesterThreadId: ThreadId,
  targetThreadId: ThreadId,
  turnId: TurnId,
  sequence: NonNegativeInt,
  observedAt: IsoDateTime,
  expiresAt: IsoDateTime,
  providerActivityAt: Schema.NullOr(IsoDateTime),
  state: Schema.Literals(["running", "waiting", "unknown", "completed", "failed", "interrupted"]),
});
export type AgentLivenessObservation = typeof AgentLivenessObservation.Type;

export const AgentLivenessInput = Schema.Struct({
  delegationIds: Schema.Array(DelegationId).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});
export type AgentLivenessInput = typeof AgentLivenessInput.Type;

export const AgentLivenessResult = Schema.Struct({
  transport: Schema.Literals(["disabled", "unavailable", "queried"]),
  scope: Schema.Literal("local-owned-delegations"),
  observations: Schema.Array(
    Schema.Struct({
      delegationId: DelegationId,
      freshness: Schema.Literals(["fresh", "stale", "unknown"]),
      observation: Schema.NullOr(AgentLivenessObservation),
    }),
  ),
});
export type AgentLivenessResult = typeof AgentLivenessResult.Type;
