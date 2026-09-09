import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import {
  DelegationId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderDriverKind,
  type AgentLivenessObservation,
  type Delegation,
  type ProviderSession,
} from "@t3tools/contracts";
import { schnorr } from "@noble/curves/secp256k1";
import { LIVENESS_KIND, LIVENESS_TAG, LIVENESS_TTL_MS, NostrLivenessEvent } from "./liveness.ts";
import { signNostrEvent } from "./nostr.ts";

const decodeLivenessEvent = Schema.decodeUnknownSync(NostrLivenessEvent);

export const secretKey = Uint8Array.from({ length: 32 }, () => 1);
export const publicKeyHex = Array.from(schnorr.getPublicKey(secretKey), (b) =>
  b.toString(16).padStart(2, "0"),
).join("");
export const nowMs = Date.parse("2026-09-06T00:00:30.000Z");
export const delegation: Delegation = {
  id: DelegationId.make("delegation"),
  projectId: ProjectId.make("project"),
  requester: { kind: "thread", threadId: ThreadId.make("parent"), requestId: "request" },
  target: { kind: "existingThread", threadId: ThreadId.make("child") },
  title: "Task",
  task: "Fix it",
  state: "running",
  targetThreadId: ThreadId.make("child"),
  turnId: TurnId.make("turn"),
  assistantMessageId: null,
  failure: null,
  revision: 1,
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
};
export const observation: AgentLivenessObservation = {
  version: 1,
  exportEpoch: "epoch",
  destinationDigest: "0".repeat(64),
  environmentId: EnvironmentId.make("env"),
  keyId: `mk_${publicKeyHex.slice(0, 16)}`,
  projectId: delegation.projectId,
  delegationId: delegation.id,
  requesterThreadId: ThreadId.make("parent"),
  targetThreadId: ThreadId.make("child"),
  turnId: TurnId.make("turn"),
  sequence: nowMs,
  observedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
  expiresAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs + LIVENESS_TTL_MS)),
  providerActivityAt: null,
  state: "running",
};
export const session: ProviderSession = {
  provider: ProviderDriverKind.make("codex"),
  threadId: ThreadId.make("child"),
  activeTurnId: TurnId.make("turn"),
  status: "running",
  runtimeMode: "approval-required",
  createdAt: delegation.createdAt,
  updatedAt: delegation.createdAt,
};
export const keys = [{ keyId: observation.keyId, environmentId: "env", publicKeyHex }];
export const signed = (value = observation) =>
  decodeLivenessEvent(
    signNostrEvent(
      {
        pubkey: publicKeyHex,
        created_at: Math.floor(Date.parse(value.observedAt) / 1_000),
        kind: LIVENESS_KIND,
        tags: [
          ["t", LIVENESS_TAG],
          ["d", value.delegationId],
        ],
        content: JSON.stringify(value),
      },
      secretKey,
    ),
  );
