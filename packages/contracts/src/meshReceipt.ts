import * as Schema from "effect/Schema";

import {
  DelegationId,
  EnvironmentId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { DelegationFailure, DelegationState } from "./orchestration.ts";

/**
 * Versioned signed-receipt contract for agent-mesh export.
 *
 * A receipt is the exported, signed representation of one persisted
 * orchestration event (or a stream checkpoint). The contract lives here so
 * clients can verify history without importing server internals; transport
 * (Nostr envelope, tags, keys) stays at the server's mesh adapter boundary.
 *
 * Only receipt types with an implemented, tested source mapping are members of
 * the union. A type is added after its mapping emits real records; verifiers
 * reject unknown `type` discriminators because the union is closed.
 */
export const MESH_RECEIPT_PROTOCOL = "convergeos.mesh";
export const MESH_RECEIPT_VERSION = 1;

/** How ConvergeOS came to know the recorded fact. Verifier assessments live in
    their own receipt payloads, never by upgrading this class. */
export const MeshEvidenceClass = Schema.Literals([
  "runtime-observed",
  "provider-reported",
  "agent-claimed",
]);
export type MeshEvidenceClass = typeof MeshEvidenceClass.Type;

export const MeshSha256 = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[0-9a-f]{64}$/),
).pipe(Schema.brand("MeshSha256"));
export type MeshSha256 = typeof MeshSha256.Type;

export const MeshKeyId = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("MeshKeyId"),
);
export type MeshKeyId = typeof MeshKeyId.Type;

export const MeshExportEpoch = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type MeshExportEpoch = typeof MeshExportEpoch.Type;

/** Reference to an exact persisted source record. `sourceSequence` is local to
    the issuing environment's database and orders nothing globally. */
export const MeshOriginQualifiedEventRef = Schema.Struct({
  environmentId: EnvironmentId,
  sourceEventId: EventId,
  sourceSequence: NonNegativeInt,
});
export type MeshOriginQualifiedEventRef = typeof MeshOriginQualifiedEventRef.Type;

/** A referenced output artifact. The digest is over the exact exported bytes;
    `complete` means all bytes were captured, `truncated` means a prefix was,
    and `unavailable` means the bytes are no longer retrievable. An empty
    completed stream is `complete` with `byteLength` 0 — it is not the same as
    output that was never captured. */
export const MeshArtifactReference = Schema.Struct({
  sha256: MeshSha256,
  byteLength: NonNegativeInt,
  mediaType: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  completeness: Schema.Literals(["complete", "truncated", "unavailable"]),
});
export type MeshArtifactReference = typeof MeshArtifactReference.Type;

const MeshReceiptBase = {
  protocol: Schema.Literal(MESH_RECEIPT_PROTOCOL),
  version: Schema.Literal(MESH_RECEIPT_VERSION),
  /** The issuing environment's enrolled signer. Verifying a receipt binds this
      identity to the transport-level public key outside this event. */
  issuerEnvironmentId: EnvironmentId,
  keyId: MeshKeyId,
  /** Origin-qualified project and agent identity. The stream is per project. */
  projectId: ProjectId,
  /** The agent address (thread) this activity belongs to. Required for all
      current receipt types. */
  threadId: ThreadId,
  /** Execution instance references, when known to the source event. */
  providerInstanceId: Schema.optionalKey(TrimmedNonEmptyString),
  sessionId: Schema.optionalKey(TrimmedNonEmptyString),
  turnId: Schema.optionalKey(TurnId),
  /** Applicable execution references. */
  delegationId: Schema.optionalKey(DelegationId),
  commandId: Schema.optionalKey(TrimmedNonEmptyString),
  actionId: Schema.optionalKey(TrimmedNonEmptyString),
  /** Exact persisted source record this receipt exports. */
  sourceEventId: EventId,
  sourceSequence: NonNegativeInt,
  /** Ordered export stream: one stream per project and capture epoch, with
      contiguous sequence numbers assigned after filtering. */
  exportEpoch: MeshExportEpoch,
  streamId: ProjectId,
  streamSequence: PositiveInt,
  /** Nostr event id of the preceding signed record in this stream, or null at
      the head. Local source ids never masquerade as Nostr event ids. */
  previousEventId: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  /** What caused this record: an origin-qualified source record or another
      signed receipt. An unresolved remote cause stays unresolved. */
  cause: MeshOriginQualifiedEventRef,
  /** Observation time and durable recording time. Neither orders globally. */
  occurredAt: IsoDateTime,
  recordedAt: IsoDateTime,
  evidence: MeshEvidenceClass,
  /** Output artifact references. Digests, never bytes or bearer URLs. */
  outputs: Schema.optionalKey(Schema.Array(MeshArtifactReference)),
} as const;

/** delegation.accepted — the queue-owned reservation point was durably
    recorded: a requester delegated work to a worker. */
export const MeshReceiptDelegationAccepted = Schema.Struct({
  ...MeshReceiptBase,
  type: Schema.Literal("delegation.accepted"),
  evidence: Schema.Literal("runtime-observed"),
  payload: Schema.Struct({
    requesterThreadId: ThreadId,
    targetThreadId: Schema.NullOr(ThreadId),
    title: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  }),
});
export type MeshReceiptDelegationAccepted = typeof MeshReceiptDelegationAccepted.Type;

/** turn.started — a turn was requested on a thread. */
export const MeshReceiptTurnStarted = Schema.Struct({
  ...MeshReceiptBase,
  type: Schema.Literal("turn.started"),
  evidence: Schema.Literal("runtime-observed"),
  payload: Schema.Struct({
    messageId: MessageId,
    turnId: Schema.NullOr(TurnId),
  }),
});
export type MeshReceiptTurnStarted = typeof MeshReceiptTurnStarted.Type;

/** artifact.available — output evidence is retained and addressable by digest.
    The reference travels in `outputs`; content stays local and is resolved
    through an authenticated environment endpoint with project authorization. */
export const MeshReceiptArtifactAvailable = Schema.Struct({
  ...MeshReceiptBase,
  type: Schema.Literal("artifact.available"),
  evidence: Schema.Literal("runtime-observed"),
  payload: Schema.Struct({}),
});
export type MeshReceiptArtifactAvailable = typeof MeshReceiptArtifactAvailable.Type;

/** delegation.terminal — the delegation reached a terminal state, carrying the
    observed worker turn id when one was bound. */
export const MeshReceiptDelegationTerminal = Schema.Struct({
  ...MeshReceiptBase,
  type: Schema.Literal("delegation.terminal"),
  evidence: Schema.Literal("runtime-observed"),
  payload: Schema.Struct({
    state: Schema.Literals(["completed", "failed", "interrupted"]),
    failure: Schema.NullOr(DelegationFailure),
  }),
});
export type MeshReceiptDelegationTerminal = typeof MeshReceiptDelegationTerminal.Type;

/** Export stream checkpoints (a signed completeness boundary per stream) join
    the union together with the verified reader that consumes them, so every
    member of this union has a live source mapping. */

export const MeshReceipt = Schema.Union([
  MeshReceiptDelegationAccepted,
  MeshReceiptTurnStarted,
  MeshReceiptArtifactAvailable,
  MeshReceiptDelegationTerminal,
]);
export type MeshReceipt = typeof MeshReceipt.Type;

export const MeshReceiptFromJsonString = Schema.fromJsonString(MeshReceipt);

/** Terminal delegation states that export. Non-terminal states never export:
    lifecycle noise stays local. */
export const MESH_RECEIPT_TERMINAL_DELEGATION_STATES: ReadonlyArray<
  Extract<DelegationState, "completed" | "failed" | "interrupted">
> = ["completed", "failed", "interrupted"];

export const isMeshReceipt = Schema.is(MeshReceipt);
