import { assert, it } from "@effect/vitest";

import {
  MESH_NOSTR_EVENT_KIND,
  MESH_NOSTR_PROTOCOL_TAG,
  MAX_NOSTR_EVENT_BYTES,
  computeNostrEventId,
  encodeEventPublishMessage,
  encodeMeshReceiptContent,
  meshTagsFor,
  nostrEventByteLength,
  parseNostrRelayMessage,
  serializeNostrEventIdPayload,
  signNostrEvent,
  verifyNostrEvent,
} from "./nostr.ts";

const SECRET_KEY = Uint8Array.from({ length: 32 }, () => 1);
const PUBLIC_KEY = "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f";

const params = {
  pubkey: PUBLIC_KEY,
  created_at: 1_757_040_000,
  kind: MESH_NOSTR_EVENT_KIND,
  tags: meshTagsFor(null),
  content: encodeMeshReceiptContent({
    protocol: "convergeos.mesh",
    version: 1,
    issuerEnvironmentId: "env-1",
    keyId: "mk_1b84c5567b126440",
    projectId: "project-1",
    threadId: "thread-1",
    sourceEventId: "evt-1",
    sourceSequence: 41,
    exportEpoch: "epoch-1",
    streamId: "project-1",
    streamSequence: 1,
    previousEventId: null,
    cause: { environmentId: "env-1", sourceEventId: "evt-0", sourceSequence: 40 },
    occurredAt: "2026-09-05T00:00:00.000Z",
    recordedAt: "2026-09-05T00:00:01.000Z",
    evidence: "runtime-observed",
    type: "delegation.accepted",
    payload: { requesterThreadId: "thread-1", targetThreadId: "thread-2", title: "Audit" },
  } as never),
};

it("pins the kind, protocol tag, and event size ceiling", () => {
  assert.equal(MESH_NOSTR_EVENT_KIND, 9901);
  assert.equal(MESH_NOSTR_PROTOCOL_TAG, "convergeos.mesh");
  assert.equal(MAX_NOSTR_EVENT_BYTES, 32_768);
});

it("serializes the canonical NIP-01 id payload and derives a stable id", () => {
  assert.equal(
    serializeNostrEventIdPayload(params),
    JSON.stringify([
      0,
      params.pubkey,
      params.created_at,
      MESH_NOSTR_EVENT_KIND,
      [["t", MESH_NOSTR_PROTOCOL_TAG]],
      params.content,
    ]),
  );
  assert.equal(computeNostrEventId(params), computeNostrEventId({ ...params }));
  assert.notEqual(computeNostrEventId(params), computeNostrEventId({ ...params, created_at: params.created_at + 1 }));
});

it("signs and verifies, and fails verification on any content byte change", () => {
  const event = signNostrEvent(params, SECRET_KEY);
  assert.equal(event.pubkey, PUBLIC_KEY);
  assert.isTrue(verifyNostrEvent(event));

  const tampered = { ...event, content: `${event.content.slice(0, -2)}"}X` };
  assert.isFalse(verifyNostrEvent(tampered));

  const tamperedId = { ...event, id: "0".repeat(64) };
  assert.isFalse(verifyNostrEvent(tamperedId));

  const foreignSignature = signNostrEvent(params, Uint8Array.from({ length: 32 }, (_, i) => 32 - i));
  assert.isFalse(verifyNostrEvent({ ...event, sig: foreignSignature.sig }));
});

it("bounds encoded events under the size ceiling for receipt-shaped content", () => {
  const event = signNostrEvent(
    { ...params, content: "x".repeat(8_000) },
    SECRET_KEY,
  );
  assert.isBelow(nostrEventByteLength(event), MAX_NOSTR_EVENT_BYTES);
});

it("round-trips the publish handshake frames", () => {
  const event = signNostrEvent(params, SECRET_KEY);
  assert.equal(JSON.parse(encodeEventPublishMessage(event))[0], "EVENT");

  const accepted = parseNostrRelayMessage(`["OK","${event.id}",true,""]`);
  assert.equal(accepted._tag, "Ok");
  assert.isTrue(accepted._tag === "Ok" && accepted.accepted && accepted.eventId === event.id);

  const rejected = parseNostrRelayMessage(`["OK","${event.id}",false,"invalid: bad"]`);
  assert.equal(rejected._tag, "Ok");
  assert.isTrue(rejected._tag === "Ok" && !rejected.accepted && rejected.message === "invalid: bad");

  assert.equal(parseNostrRelayMessage('["NOTICE","relay is saturated"]')._tag, "Notice");
  assert.equal(parseNostrRelayMessage("not json")._tag, "Other");
  assert.equal(parseNostrRelayMessage('["REQ","sub",{}]')._tag, "Other");
});
