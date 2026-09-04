import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { AgentMeshListInput, AgentMeshSendInput } from "./agentMesh.ts";
import { ClientOrchestrationCommand, OrchestrationCommand } from "./orchestration.ts";

const decodeListInput = Schema.decodeUnknownEffect(AgentMeshListInput);
const decodeSendInput = Schema.decodeUnknownEffect(AgentMeshSendInput);
const decodeCommand = Schema.decodeUnknownEffect(OrchestrationCommand);
const decodeClientCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);

it.effect("accepts bounded agent list requests", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* decodeListInput({}), {});
    assert.deepStrictEqual(yield* decodeListInput({ limit: 100 }), { limit: 100 });
    assert(Exit.isFailure(yield* Effect.exit(decodeListInput({ limit: 101 }))));
  }),
);

it.effect("rejects empty and oversized mesh messages", () =>
  Effect.gen(function* () {
    assert(
      Exit.isFailure(
        yield* Effect.exit(
          decodeSendInput({
            requestId: "request-1",
            targetThreadId: "thread-target",
            message: "   ",
          }),
        ),
      ),
    );
    assert(
      Exit.isFailure(
        yield* Effect.exit(
          decodeSendInput({
            requestId: "request-1",
            targetThreadId: "thread-target",
            message: "x".repeat(120_001),
          }),
        ),
      ),
    );
  }),
);

it.effect("requires a bounded retry-safe request identifier", () =>
  Effect.gen(function* () {
    assert(
      Exit.isFailure(
        yield* Effect.exit(
          decodeSendInput({
            requestId: "contains spaces",
            targetThreadId: "thread-target",
            message: "Review this.",
          }),
        ),
      ),
    );
  }),
);

it.effect("accepts peer turns only at the internal orchestration boundary", () =>
  Effect.gen(function* () {
    const command = {
      type: "thread.peer-turn.start",
      commandId: "provider:agent-mesh:send:request-1",
      requestId: "request-1",
      sourceThreadId: "thread-source",
      threadId: "thread-target",
      messageId: "message-peer-request",
      message: "Review this.",
    };

    assert.strictEqual((yield* decodeCommand(command)).type, "thread.peer-turn.start");
    assert(Exit.isFailure(yield* Effect.exit(decodeClientCommand(command))));
  }),
);
