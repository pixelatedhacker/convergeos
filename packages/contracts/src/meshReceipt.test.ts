import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  MESH_RECEIPT_PROTOCOL,
  MESH_RECEIPT_VERSION,
  MeshReceipt,
  MeshReceiptFromJsonString,
} from "./index.ts";

const decodeReceipt = Schema.decodeUnknownEffect(MeshReceipt);
const encodeReceiptJson = Schema.encodeEffect(MeshReceiptFromJsonString);
const decodeReceiptJson = Schema.decodeEffect(MeshReceiptFromJsonString);

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
          {
            sha256: SHA256,
            byteLength: 11,
            mediaType: "text/plain; charset=utf-8",
            completeness: "complete",
          },
        ],
        payload: {},
      },
      {
        ...baseReceipt,
        type: "delegation.terminal",
        evidence: "runtime-observed",
        turnId: "turn-1",
        sourceEventId: "evt-4",
        payload: {
          requesterThreadId: "thread-1",
          targetThreadId: "thread-2",
          state: "completed",
          failure: null,
        },
      },
    ];
    for (const receipt of receipts) {
      const decoded = yield* decodeReceipt(receipt);
      const encoded = yield* encodeReceiptJson(decoded);
      const reparsed = yield* decodeReceiptJson(encoded);
      assert.deepEqual(reparsed, decoded);
    }
  }),
);

it.effect("rejects unknown protocol, version, and type discriminators", () =>
  Effect.gen(function* () {
    const wrongProtocol = yield* Effect.result(
      decodeReceipt({ ...acceptedReceipt, protocol: "other.mesh" }),
    );
    assert.equal(wrongProtocol._tag, "Failure");

    const wrongVersion = yield* Effect.result(decodeReceipt({ ...acceptedReceipt, version: 99 }));
    assert.equal(wrongVersion._tag, "Failure");

    const unknownType = yield* Effect.result(
      decodeReceipt({
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
      decodeReceipt({
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
      decodeReceipt({
        ...acceptedReceipt,
        payload: { ...acceptedReceipt.payload, title: "x".repeat(161) },
      }),
    );
    assert.equal(oversizedTitle._tag, "Failure");

    const zeroSequence = yield* Effect.result(
      decodeReceipt({ ...acceptedReceipt, streamSequence: 0 }),
    );
    assert.equal(zeroSequence._tag, "Failure");
  }),
);

it.effect("accepts absent and unresolved causes without inventing a source sequence", () =>
  Effect.gen(function* () {
    for (const cause of [null, { environmentId: "env-1", sourceEventId: "missing-event" }]) {
      const decoded = yield* decodeReceipt({ ...acceptedReceipt, cause });
      assert.deepEqual(decoded.cause, cause);
    }
  }),
);

it.effect("requires delegation identity and terminal requester and worker references", () =>
  Effect.gen(function* () {
    const { delegationId: _delegationId, ...withoutDelegationId } = acceptedReceipt;
    const missingAcceptedId = yield* Effect.result(decodeReceipt(withoutDelegationId));
    assert.equal(missingAcceptedId._tag, "Failure");
    const terminal = {
      ...acceptedReceipt,
      type: "delegation.terminal",
      payload: {
        requesterThreadId: "thread-1",
        targetThreadId: "thread-2",
        state: "completed",
        failure: null,
      },
    };
    const { delegationId: _terminalId, ...withoutTerminalId } = terminal;
    const missingTerminalId = yield* Effect.result(decodeReceipt(withoutTerminalId));
    assert.equal(missingTerminalId._tag, "Failure");
    const missingWorker = yield* Effect.result(
      decodeReceipt({
        ...terminal,
        payload: { requesterThreadId: "thread-1", state: "completed", failure: null },
      }),
    );
    assert.equal(missingWorker._tag, "Failure");
  }),
);

it.effect(
  "rejects version 1 receipts even when their remaining fields match the current schema",
  () =>
    Effect.gen(function* () {
      const legacy = yield* Effect.result(decodeReceipt({ ...acceptedReceipt, version: 1 }));
      assert.equal(legacy._tag, "Failure");
      const current = yield* decodeReceipt(acceptedReceipt);
      assert.equal(current.version, 2);
    }),
);
