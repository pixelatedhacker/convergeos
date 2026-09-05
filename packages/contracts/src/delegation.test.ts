import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CommandId,
  DelegationId,
  OrchestrationCommand,
  ProviderInstanceId,
  ThreadId,
} from "./index.ts";

it.effect("decodes durable delegation commands and enforces terminal failure shape", () =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(OrchestrationCommand)({
      type: "delegation.request",
      commandId: CommandId.make("delegation-request"),
      delegationId: DelegationId.make("delegation-1"),
      projectId: "project-1",
      requester: { kind: "thread", threadId: ThreadId.make("parent"), requestId: "audit-1" },
      target: {
        kind: "newThread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" },
      },
      title: "Audit",
      task: "Audit the change.",
      createdAt: "2026-09-05T00:00:00.000Z",
    });
    assert.equal(request.type, "delegation.request");

    const invalid = yield* Effect.result(
      Schema.decodeUnknownEffect(OrchestrationCommand)({
        type: "delegation.complete",
        commandId: "delegation-complete",
        delegationId: "delegation-1",
        outcome: "failed",
        failure: null,
        createdAt: "2026-09-05T00:00:01.000Z",
      }),
    );
    assert.equal(invalid._tag, "Failure");
  }),
);
