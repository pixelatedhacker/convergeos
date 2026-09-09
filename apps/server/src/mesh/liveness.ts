import {
  AgentLivenessObservation,
  type Delegation,
  type ProviderSession,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { verifyNostrEvent, type NostrEvent } from "./nostr.ts";

export const LIVENESS_KIND = 9902;
export const LIVENESS_TAG = "convergeos.liveness.v1";
export const LIVENESS_INTERVAL_MS = 30_000;
export const LIVENESS_TTL_MS = 90_000;
export const LIVENESS_MAX_BYTES = 4_096;
export const LIVENESS_MAX_TRACKED = 64;

export const isTerminalLiveness = (state: AgentLivenessObservation["state"]) =>
  state === "completed" || state === "failed" || state === "interrupted";

export function observeDelegationState(
  delegation: Delegation,
  session: ProviderSession | undefined,
  shell: OrchestrationThreadShell | undefined,
): AgentLivenessObservation["state"] {
  if (
    delegation.state === "completed" ||
    delegation.state === "failed" ||
    delegation.state === "interrupted"
  )
    return delegation.state;
  if (!session || session.activeTurnId !== delegation.turnId || session.status !== "running")
    return "unknown";
  return shell?.hasPendingApprovals || shell?.hasPendingUserInput ? "waiting" : "running";
}

export const NostrLivenessEvent = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  pubkey: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  sig: Schema.String.check(Schema.isPattern(/^[0-9a-f]{128}$/)),
  created_at: Schema.Int,
  kind: Schema.Literal(LIVENESS_KIND),
  tags: Schema.Array(Schema.Array(Schema.String)),
  content: Schema.String,
});
export const encodeLivenessEvent = Schema.encodeSync(Schema.fromJsonString(NostrLivenessEvent));
const decodeContent = Schema.decodeUnknownOption(Schema.fromJsonString(AgentLivenessObservation));

export function verifyLiveness(input: {
  event: NostrEvent;
  delegation: Delegation;
  environmentId: string;
  exportEpoch: string;
  destinationDigest: string;
  keys: ReadonlyArray<{ keyId: string; environmentId: string; publicKeyHex: string }>;
  nowMs: number;
}): AgentLivenessObservation | null {
  const { event, delegation, nowMs } = input;
  if (
    new TextEncoder().encode(JSON.stringify(event)).length > LIVENESS_MAX_BYTES ||
    event.kind !== LIVENESS_KIND
  )
    return null;
  const content = decodeContent(event.content);
  if (Option.isNone(content)) return null;
  const value = content.value;
  if (
    delegation.requester.kind !== "thread" ||
    value.environmentId !== input.environmentId ||
    value.exportEpoch !== input.exportEpoch ||
    value.destinationDigest !== input.destinationDigest ||
    value.delegationId !== delegation.id ||
    value.projectId !== delegation.projectId ||
    value.requesterThreadId !== delegation.requester.threadId ||
    value.targetThreadId !== delegation.targetThreadId ||
    value.turnId !== delegation.turnId ||
    !input.keys.some(
      (key) =>
        key.keyId === value.keyId &&
        key.environmentId === value.environmentId &&
        key.publicKeyHex === event.pubkey,
    )
  )
    return null;
  const observed = Date.parse(value.observedAt);
  const expires = Date.parse(value.expiresAt);
  if (
    !Number.isFinite(observed) ||
    !Number.isFinite(expires) ||
    (value.providerActivityAt !== null && !Number.isFinite(Date.parse(value.providerActivityAt))) ||
    observed > nowMs + 5_000 ||
    expires <= nowMs ||
    expires - observed !== LIVENESS_TTL_MS ||
    observed < Date.parse(delegation.createdAt) ||
    event.created_at !== Math.floor(observed / 1_000) ||
    (value.providerActivityAt !== null && Date.parse(value.providerActivityAt) > observed) ||
    !event.tags.some((tag) => tag[0] === "t" && tag[1] === LIVENESS_TAG) ||
    !event.tags.some((tag) => tag[0] === "d" && tag[1] === delegation.id) ||
    !verifyNostrEvent(event)
  )
    return null;
  return value;
}

export function newestObservation(
  previous: AgentLivenessObservation | undefined,
  next: AgentLivenessObservation,
) {
  if (!previous || previous.turnId !== next.turnId) return next;
  if (isTerminalLiveness(previous.state)) return previous;
  if (isTerminalLiveness(next.state)) return next;
  if (
    Date.parse(next.observedAt) < Date.parse(previous.observedAt) ||
    next.sequence <= previous.sequence
  )
    return previous;
  return next;
}
