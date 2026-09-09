import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MeshKeyId,
  MeshSha256,
  OrchestrationEvent,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { mapSourceEventToDraft, type MeshReceiptSourceResolver } from "./receiptMapping.ts";

const now = "2026-09-06T00:00:00.000Z";
const environmentId = EnvironmentId.make("environment-1");
const keyId = MeshKeyId.make("mk_test");
const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);
const sourceBase = {
  sequence: 12,
  eventId: "completion-1",
  aggregateKind: "thread",
  aggregateId: "worker-1",
  occurredAt: now,
  commandId: "provider:complete-1",
  causationEventId: null,
  correlationId: null,
  metadata: {},
};
const sources: MeshReceiptSourceResolver = {
  resolveProjectIdForThread: () => Effect.succeed(Option.some(ProjectId.make("project-1"))),
  readAssistantTextAt: () => Effect.succeed(Option.some("Retained answer 🌙")),
  resolveSourceEvent: () => Effect.succeed(Option.none()),
};

const messageEvent = (streaming: boolean, text: string) =>
  decodeEvent({
    ...sourceBase,
    type: "thread.message-sent",
    payload: {
      threadId: "worker-1",
      messageId: "message-1",
      role: "assistant",
      text,
      streaming,
      turnId: "worker-turn-1",
      createdAt: now,
      updatedAt: now,
    },
  });

const delegationEvent = (
  state: "requested" | "completed" | "failed",
  targetThreadId: string | null,
) =>
  decodeEvent({
    ...sourceBase,
    aggregateKind: "delegation",
    aggregateId: "delegation-1",
    type:
      state === "requested"
        ? "delegation.requested"
        : state === "completed"
          ? "delegation.completed"
          : "delegation.failed",
    payload: {
      delegation: {
        id: "delegation-1",
        projectId: "project-1",
        requester: { kind: "thread", threadId: "requester-1", requestId: "request-1" },
        target: { kind: "newThread", modelSelection: { instanceId: "codex", model: "test-model" } },
        title: "Audit",
        task: "Audit the implementation.",
        state,
        targetThreadId,
        turnId: state === "requested" ? null : "worker-turn-1",
        assistantMessageId: null,
        failure: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
    },
  });

it.effect("hashes retained output at the completion sequence instead of its empty marker", () =>
  Effect.gen(function* () {
    const delta = yield* mapSourceEventToDraft(
      messageEvent(true, "Retained answer 🌙"),
      environmentId,
      keyId,
      sources,
    );
    assert.equal(delta, null);
    const mapped = yield* mapSourceEventToDraft(messageEvent(false, ""), environmentId, keyId, {
      ...sources,
      readAssistantTextAt: ({ sequenceInclusive }) =>
        Effect.succeed(
          Option.some(sequenceInclusive === 12 ? "Retained answer 🌙" : "A later replacement"),
        ),
    });
    assert.equal(mapped?.artifact?.content, "Retained answer 🌙");
    assert.equal(mapped?.draft.version, 2);
    assert.deepEqual(mapped?.draft.outputs, [
      {
        sha256: MeshSha256.make(
          NodeCrypto.createHash("sha256").update("Retained answer 🌙", "utf8").digest("hex"),
        ),
        byteLength: Buffer.byteLength("Retained answer 🌙", "utf8"),
        mediaType: "text/plain; charset=utf-8",
        completeness: "complete",
      },
    ]);
    assert.equal(mapped?.draft.turnId, "worker-turn-1");
  }),
);

it.effect("distinguishes completed empty output from unavailable retained bytes", () =>
  Effect.gen(function* () {
    const empty = yield* mapSourceEventToDraft(messageEvent(false, ""), environmentId, keyId, {
      ...sources,
      readAssistantTextAt: () => Effect.succeed(Option.some("")),
    });
    assert.equal(empty?.artifact?.reference.byteLength, 0);
    assert.equal(empty?.artifact?.reference.completeness, "complete");
    const unavailable = yield* Effect.result(
      mapSourceEventToDraft(messageEvent(false, ""), environmentId, keyId, {
        ...sources,
        readAssistantTextAt: () => Effect.succeed(Option.none()),
      }),
    );
    assert.equal(unavailable._tag, "Failure");
    if (unavailable._tag === "Failure") {
      assert.equal(unavailable.failure.operation, "readAssistantTextAt");
    }
  }),
);

it.effect("preserves the requester and newly provisioned worker in terminal receipts", () =>
  Effect.gen(function* () {
    const accepted = yield* mapSourceEventToDraft(
      delegationEvent("requested", null),
      environmentId,
      keyId,
      sources,
    );
    assert.equal(accepted?.draft.threadId, "requester-1");
    const terminal = yield* mapSourceEventToDraft(
      delegationEvent("completed", "worker-1"),
      environmentId,
      keyId,
      sources,
    );
    assert.equal(terminal?.draft.threadId, "worker-1");
    assert.equal(terminal?.draft.turnId, "worker-turn-1");
    assert.equal(terminal?.draft.delegationId, accepted?.draft.delegationId);
    assert.deepEqual(terminal?.draft.payload, {
      requesterThreadId: "requester-1",
      targetThreadId: "worker-1",
      state: "completed",
      failure: null,
    });
  }),
);

it.effect("does not attach an unbound worker turn to the requester on provisioning failure", () =>
  Effect.gen(function* () {
    const mapped = yield* mapSourceEventToDraft(
      delegationEvent("failed", null),
      environmentId,
      keyId,
      sources,
    );
    assert.equal(mapped?.draft.threadId, "requester-1");
    assert.equal(mapped?.draft.turnId, undefined);
    assert.deepEqual(mapped?.draft.payload, {
      requesterThreadId: "requester-1",
      targetThreadId: null,
      state: "failed",
      failure: null,
    });
  }),
);

it.effect("exports the source cause and command, keeping unresolved references explicit", () =>
  Effect.gen(function* () {
    const event = decodeEvent({ ...messageEvent(false, ""), causationEventId: "request-event" });
    const mapped = yield* mapSourceEventToDraft(event, environmentId, keyId, {
      ...sources,
      resolveSourceEvent: () =>
        Effect.succeed(Option.some({ eventId: EventId.make("request-event"), sequence: 4 })),
    });
    assert.deepEqual(mapped?.draft.cause, {
      environmentId,
      sourceEventId: EventId.make("request-event"),
      sourceSequence: 4,
    });
    assert.equal(mapped?.draft.commandId, "provider:complete-1");
    const unresolved = yield* mapSourceEventToDraft(event, environmentId, keyId, sources);
    assert.deepEqual(unresolved?.draft.cause, {
      environmentId,
      sourceEventId: EventId.make("request-event"),
    });
    const root = yield* mapSourceEventToDraft(
      messageEvent(false, ""),
      environmentId,
      keyId,
      sources,
    );
    assert.equal(root?.draft.cause, null);
  }),
);
