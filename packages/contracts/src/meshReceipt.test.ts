import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  MESH_RECEIPT_PROTOCOL,
  MESH_RECEIPT_VERSION,
  MeshReceipt,
  MeshReceiptFromJsonString,
} from "./index.ts";

const SHA256 = "a".repeat(64);
const PREVIOUS_EVENT_ID = "b".repeat(64);

const baseReceipt = {
  protocol: MESH_RECEIPT_PROTOCOL,
  version: MESH_RECEIPT_VERSION,
  issuerEnvironmentId: "env-1",
  keyId: "mk_aabbccddeeff0011",
  projectId: "project-1",
  threadId: "thread-1",
  delegationId: "agent-mesh:10:caller-thread:request-1",
  sourceEventId: "evt-1",
  sourceSequence: 41,
  exportEpoch: "epoch-1",
  streamId: "project-1",
  streamSequence: 3,
  previousEventId: PREVIOUS_EVENT_ID,
  cause: { environmentId: "env-1", sourceEventId: "evt-0", sourceSequence: 40 },
  occurredAt: "2026-09-05T00:00:00.000Z",
  recordedAt: "2026-09-05T00:00:01.000Z",
};

const acceptedReceipt = {
  ...baseReceipt,
  type: "delegation.accepted",
  evidence: "runtime-observed",
  payload: { requesterThreadId: "thread-1", targetThreadId: "thread-2", title: "Audit" },
};

it.effect("round-trips every receipt type through JSON", () =>
  Effect.gen(function* () {
    const receipts: ReadonlyArray<unknown> = [
      acceptedReceipt,
      {
        ...baseReceipt,
        type: "turn.started",
        evidence: "runtime-observed",
        turnId: "turn-1",
        sourceEventId: "evt-2",
        payload: { messageId: "message-1", turnId: "turn-1" },
      },
      {
        ...baseReceipt,
        type: "artifact.available",
        evidence: "runtime-observed",
        turnId: "turn-1",
        sourceEventId: "evt-3",
        outputs: [
          { sha256: SHA256, byteLength: 11, mediaType: "text/plain; charset=utf-8", completeness: "complete" },
        ],
        payload: {},
      },
      {
        ...baseReceipt,
        type: "delegation.terminal",
        evidence: "runtime-observed",
        turnId: "turn-1",
        sourceEventId: "evt-4",
        payload: { state: "completed", failure: null },
      },
    ];
    for (const receipt of receipts) {
      const decoded = yield* Schema.decodeUnknownEffect(MeshReceipt)(receipt);
      const encoded = yield* Schema.encodeEffect(MeshReceiptFromJsonString)(decoded);
      const reparsed = yield* Schema.decodeEffect(MeshReceiptFromJsonString)(encoded);
      assert.deepEqual(reparsed, decoded);
    }
  }),
);

it.effect("rejects unknown protocol, version, and type discriminators", () =>
  Effect.gen(function* () {
    const wrongProtocol = yield* Effect.result(
      Schema.decodeUnknownEffect(MeshReceipt)({ ...acceptedReceipt, protocol: "other.mesh" }),
    );
    assert.equal(wrongProtocol._tag, "Failure");

    const wrongVersion = yield* Effect.result(
      Schema.decodeUnknownEffect(MeshReceipt)({ ...acceptedReceipt, version: 2 }),
    );
    assert.equal(wrongVersion._tag, "Failure");

    const unknownType = yield* Effect.result(
      Schema.decodeUnknownEffect(MeshReceipt)({
        ...acceptedReceipt,
        type: "tool.result",
        payload: {},
      }),
    );
    assert.equal(unknownType._tag, "Failure");
  }),
);

it.effect("rejects malformed digests, oversized fields, and non-positive stream sequences", () =>
  Effect.gen(function* () {
    const badDigest = yield* Effect.result(
      Schema.decodeUnknownEffect(MeshReceipt)({
        ...acceptedReceipt,
        type: "artifact.available",
        evidence: "runtime-observed",
        sourceEventId: "evt-3",
        outputs: [
          { sha256: "ZZ", byteLength: 1, mediaType: "text/plain", completeness: "complete" },
        ],
        payload: {},
      }),
    );
    assert.equal(badDigest._tag, "Failure");

    const oversizedTitle = yield* Effect.result(
      Schema.decodeUnknownEffect(MeshReceipt)({
        ...acceptedReceipt,
        payload: { ...acceptedReceipt.payload, title: "x".repeat(161) },
      }),
    );
    assert.equal(oversizedTitle._tag, "Failure");

    const zeroSequence = yield* Effect.result(
      Schema.decodeUnknownEffect(MeshReceipt)({ ...acceptedReceipt, streamSequence: 0 }),
    );
    assert.equal(zeroSequence._tag, "Failure");
  }),
);
