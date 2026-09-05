import { expect, it } from "@effect/vitest";
import {
  DelegationId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type Delegation,
  type OrchestrationMessage,
} from "@t3tools/contracts";

import { latestDelegationAssistant } from "./DelegationService.ts";

const now = "2026-09-05T00:00:00.000Z";
const priorTurnId = TurnId.make("turn-prior");
const delegatedTurnId = TurnId.make("turn-delegated");

const delegation = (turnId: TurnId | null): Delegation => ({
  id: DelegationId.make("delegation-output"),
  projectId: ProjectId.make("project-output"),
  requester: {
    kind: "thread",
    threadId: ThreadId.make("thread-caller"),
    requestId: "output-check",
  },
  target: {
    kind: "newThread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-test",
    },
  },
  title: "Output check",
  task: "Return only owned output.",
  state: turnId === null ? "turnRequested" : "running",
  targetThreadId: ThreadId.make("thread-worker"),
  turnId,
  assistantMessageId: null,
  failure: null,
  revision: turnId === null ? 3 : 4,
  createdAt: now,
  updatedAt: now,
});

const assistant = (id: string, turnId: TurnId, text: string): OrchestrationMessage => ({
  id: MessageId.make(id),
  role: "assistant",
  text,
  attachments: [],
  turnId,
  streaming: false,
  createdAt: now,
  updatedAt: now,
});

it("does not expose a target thread's prior assistant before the delegation turn is bound", () => {
  const result = latestDelegationAssistant(
    delegation(null),
    [assistant("assistant-prior", priorTurnId, "private prior output")],
    1_000,
  );

  expect(result).toBeNull();
});

it("returns and bounds output from the exact delegated turn", () => {
  const result = latestDelegationAssistant(
    delegation(delegatedTurnId),
    [
      assistant("assistant-prior", priorTurnId, "private prior output"),
      assistant("assistant-owned", delegatedTurnId, `opening-${"x".repeat(300)}-ending`),
    ],
    256,
  );

  expect(result?.messageId).toBe(MessageId.make("assistant-owned"));
  expect(result?.text.endsWith("-ending")).toBe(true);
  expect(result?.text).toHaveLength(256);
  expect(result?.truncated).toBe(true);
});
