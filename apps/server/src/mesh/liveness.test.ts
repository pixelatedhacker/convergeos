import * as DateTime from "effect/DateTime";
import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId, TurnId, type AgentLivenessObservation } from "@t3tools/contracts";
import {
  LIVENESS_TTL_MS,
  newestObservation,
  observeDelegationState,
  verifyLiveness,
} from "./liveness.ts";
import { delegation, keys, nowMs, observation, session, signed } from "./livenessTestFixtures.ts";

it("requires a live exact-turn provider runtime, not projected running state", () => {
  assert.equal(observeDelegationState(delegation, undefined, undefined), "unknown");
  assert.equal(
    observeDelegationState(delegation, { ...session, activeTurnId: TurnId.make("old") }, undefined),
    "unknown",
  );
  assert.equal(
    observeDelegationState(delegation, { ...session, status: "ready" }, undefined),
    "unknown",
  );
  assert.equal(observeDelegationState(delegation, session, undefined), "running");
  assert.equal(
    observeDelegationState({ ...delegation, state: "completed" }, session, undefined),
    "completed",
  );
});

it("rejects untrusted issuers, different ownership, altered bytes, invalid timestamps and expired observations", () => {
  const input = {
    event: signed(),
    delegation,
    environmentId: "env",
    exportEpoch: observation.exportEpoch,
    destinationDigest: observation.destinationDigest,
    keys,
    nowMs,
  };
  assert.deepEqual(verifyLiveness(input), observation);
  assert.isNull(verifyLiveness({ ...input, keys: [] }));
  assert.isNull(verifyLiveness({ ...input, environmentId: "another-environment" }));
  assert.isNull(
    verifyLiveness({ ...input, delegation: { ...delegation, projectId: ProjectId.make("other") } }),
  );
  assert.isNull(
    verifyLiveness({
      ...input,
      delegation: {
        ...delegation,
        requester: { kind: "thread", threadId: ThreadId.make("other"), requestId: "r" },
      },
    }),
  );
  assert.isNull(
    verifyLiveness({ ...input, delegation: { ...delegation, turnId: TurnId.make("other") } }),
  );
  assert.isNull(
    verifyLiveness({
      ...input,
      event: { ...input.event, content: input.event.content.replace("running", "completed") },
    }),
  );
  assert.isNull(verifyLiveness({ ...input, nowMs: nowMs + LIVENESS_TTL_MS }));
  assert.isNull(verifyLiveness({ ...input, nowMs: nowMs - 6000 }));
  assert.isNull(
    verifyLiveness({ ...input, event: signed({ ...observation, expiresAt: "invalid" }) }),
  );
  assert.isNull(
    verifyLiveness({ ...input, event: signed({ ...observation, providerActivityAt: "invalid" }) }),
  );
  assert.isNull(
    verifyLiveness({
      ...input,
      event: signed({
        ...observation,
        providerActivityAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs + 1)),
      }),
    }),
  );
});

it("ignores duplicate and reordered heartbeats and never revives a terminal turn", () => {
  const later = {
    ...observation,
    sequence: nowMs + 1,
    observedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs + 1)),
  };
  assert.equal(newestObservation(later, observation), later);
  assert.equal(newestObservation(later, { ...later, sequence: 1 }), later);
  const completed = { ...observation, state: "completed" } satisfies AgentLivenessObservation;
  assert.equal(newestObservation(completed, later), completed);
  assert.equal(newestObservation(later, completed), completed);
  assert.equal(
    newestObservation(completed, { ...later, turnId: TurnId.make("new") }).turnId,
    "new",
  );
});
