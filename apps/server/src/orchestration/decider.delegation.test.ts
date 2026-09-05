import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  CommandId,
  DelegationId,
  KanbanCardId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  type DelegationCommandReadModel,
  projectCommandEvent,
} from "../delegation/commandReadModel.ts";
import { delegationCommandIdFor } from "../delegation/DelegationService.ts";
import { inferActorKind } from "../persistence/Layers/OrchestrationEventStore.ts";
import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-09-05T00:00:00.000Z";
const projectId = ProjectId.make("project-delegation");
const parentThreadId = ThreadId.make("thread-parent");
const targetThreadId = ThreadId.make("thread-target");
const delegationId = DelegationId.make("delegation-audit");

const thread = (id: ThreadId): OrchestrationThread => ({
  id,
  projectId,
  title: id === parentThreadId ? "Parent" : "Worker",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: `/worktrees/${id}`,
  linkedPullRequest: null,
  botProfile:
    id === targetThreadId
      ? {
          displayName: "Worker",
          description: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        }
      : null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  unsettledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  titleRegeneration: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
});

const initialModel = (): DelegationCommandReadModel => ({
  snapshotSequence: 0,
  projects: [
    {
      id: projectId,
      title: "Project",
      workspaceRoot: "/workspace/project",
      repositoryIdentity: null,
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      autoPull: false,
      faviconPath: null,
      projectIcon: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  threads: [thread(parentThreadId), thread(targetThreadId)],
  kanbanCards: [],
  delegations: [],
  updatedAt: now,
});

const decideOne = Effect.fn("decideDelegationTestCommand")(function* (
  model: DelegationCommandReadModel,
  command: OrchestrationCommand,
) {
  const decided = yield* decideOrchestrationCommand({ command, readModel: model });
  const event = (Array.isArray(decided) ? decided[0] : decided) as Omit<
    OrchestrationEvent,
    "sequence"
  >;
  const committed = { ...event, sequence: model.snapshotSequence + 1 } as OrchestrationEvent;
  return {
    event: committed,
    model: yield* projectCommandEvent(model, committed),
  };
});

it.layer(NodeServices.layer)("delegation decider", (it) => {
  it.effect("moves one existing-thread delegation through its durable lifecycle", () =>
    Effect.gen(function* () {
      let model = initialModel();
      const requested = yield* decideOne(model, {
        type: "delegation.request",
        commandId: delegationCommandIdFor(delegationId, "request"),
        delegationId,
        projectId,
        requester: { kind: "thread", threadId: parentThreadId, requestId: "audit-1" },
        target: { kind: "existingThread", threadId: targetThreadId },
        title: "Audit",
        task: "Audit the change.",
        createdAt: now,
      });
      model = requested.model;
      assert.equal(requested.event.type, "delegation.requested");
      assert.equal(inferActorKind(requested.event), "server");
      assert.equal(model.delegations?.[0]?.state, "requested");
      assert.equal(model.delegations?.[0]?.targetThreadId, targetThreadId);

      const turnRequested = yield* decideOne(model, {
        type: "delegation.turn.request",
        commandId: CommandId.make("turn-request"),
        delegationId,
        createdAt: "2026-09-05T00:00:01.000Z",
      });
      model = turnRequested.model;
      assert.equal(model.delegations?.[0]?.state, "turnRequested");

      model = {
        ...model,
        threads: model.threads.map((entry) =>
          entry.id === targetThreadId
            ? {
                ...entry,
                latestTurn: {
                  turnId: TurnId.make("turn-1"),
                  state: "running" as const,
                  requestedAt: now,
                  startedAt: now,
                  completedAt: null,
                  assistantMessageId: MessageId.make("assistant-1"),
                },
              }
            : entry,
        ),
      };

      const running = yield* decideOne(model, {
        type: "delegation.turn.bind",
        commandId: CommandId.make("turn-bind"),
        delegationId,
        turnId: TurnId.make("turn-1"),
        assistantMessageId: MessageId.make("assistant-1"),
        createdAt: "2026-09-05T00:00:02.000Z",
      });
      model = running.model;
      assert.equal(model.delegations?.[0]?.state, "running");
      assert.equal(model.delegations?.[0]?.revision, 3);

      const completed = yield* decideOne(model, {
        type: "delegation.complete",
        commandId: CommandId.make("complete"),
        delegationId,
        outcome: "completed",
        failure: null,
        createdAt: "2026-09-05T00:00:03.000Z",
      });
      assert.equal(completed.event.type, "delegation.completed");
      assert.equal(completed.model.delegations?.[0]?.state, "completed");
      assert.equal(completed.model.delegations?.[0]?.revision, 4);
    }),
  );

  it.effect("rejects duplicate requester identities and invalid transitions", () =>
    Effect.gen(function* () {
      const requested = yield* decideOne(initialModel(), {
        type: "delegation.request",
        commandId: CommandId.make("request"),
        delegationId,
        projectId,
        requester: { kind: "thread", threadId: parentThreadId, requestId: "audit-1" },
        target: { kind: "existingThread", threadId: targetThreadId },
        title: "Audit",
        task: "Audit the change.",
        createdAt: now,
      });

      const duplicate = yield* decideOrchestrationCommand({
        readModel: requested.model,
        command: {
          type: "delegation.request",
          commandId: CommandId.make("request-duplicate"),
          delegationId: DelegationId.make("delegation-other"),
          projectId,
          requester: { kind: "thread", threadId: parentThreadId, requestId: "audit-1" },
          target: { kind: "existingThread", threadId: targetThreadId },
          title: "Audit again",
          task: "Duplicate task.",
          createdAt: now,
        },
      }).pipe(Effect.flip);
      expect(duplicate.message).toContain("already belongs");

      const invalidComplete = yield* decideOrchestrationCommand({
        readModel: requested.model,
        command: {
          type: "delegation.complete",
          commandId: CommandId.make("complete-too-soon"),
          delegationId,
          outcome: "completed",
          failure: null,
          createdAt: now,
        },
      }).pipe(Effect.flip);
      expect(invalidComplete.message).toContain("cannot become completed from requested");
    }),
  );

  it.effect("rejects stale turns and assistant output from another target turn", () =>
    Effect.gen(function* () {
      const requested = yield* decideOne(initialModel(), {
        type: "delegation.request",
        commandId: CommandId.make("request-turn-ownership"),
        delegationId,
        projectId,
        requester: { kind: "thread", threadId: parentThreadId, requestId: "ownership-1" },
        target: { kind: "existingThread", threadId: targetThreadId },
        title: "Audit",
        task: "Audit the change.",
        createdAt: now,
      });
      const turnRequested = yield* decideOne(requested.model, {
        type: "delegation.turn.request",
        commandId: CommandId.make("turn-request-ownership"),
        delegationId,
        createdAt: now,
      });
      const model = {
        ...turnRequested.model,
        threads: [
          ...turnRequested.model.threads.map((entry) =>
            entry.id === targetThreadId
              ? {
                  ...entry,
                  latestTurn: {
                    turnId: TurnId.make("turn-current"),
                    state: "running" as const,
                    requestedAt: now,
                    startedAt: now,
                    completedAt: null,
                    assistantMessageId: MessageId.make("assistant-current"),
                  },
                }
              : entry,
          ),
          {
            ...thread(ThreadId.make("thread-other-worker")),
            latestTurn: {
              turnId: TurnId.make("turn-stale"),
              state: "running" as const,
              requestedAt: now,
              startedAt: now,
              completedAt: null,
              assistantMessageId: null,
            },
          },
        ],
      };

      const stale = yield* decideOrchestrationCommand({
        readModel: model,
        command: {
          type: "delegation.turn.bind",
          commandId: CommandId.make("turn-bind-stale"),
          delegationId,
          turnId: TurnId.make("turn-stale"),
          assistantMessageId: null,
          createdAt: now,
        },
      }).pipe(Effect.flip);
      expect(stale.message).toContain("is not the latest turn");

      const wrongAssistant = yield* decideOrchestrationCommand({
        readModel: model,
        command: {
          type: "delegation.turn.bind",
          commandId: CommandId.make("turn-bind-wrong-assistant"),
          delegationId,
          turnId: TurnId.make("turn-current"),
          assistantMessageId: MessageId.make("assistant-other"),
          createdAt: now,
        },
      }).pipe(Effect.flip);
      expect(wrongAssistant.message).toContain("does not belong");
    }),
  );

  it.effect("atomically rejects a second open delegation for the same bot", () =>
    Effect.gen(function* () {
      const first = yield* decideOne(initialModel(), {
        type: "delegation.request",
        commandId: CommandId.make("request-first-owner"),
        delegationId,
        projectId,
        requester: { kind: "thread", threadId: parentThreadId, requestId: "owner-1" },
        target: { kind: "existingThread", threadId: targetThreadId },
        title: "First owner",
        task: "Run the first audit.",
        createdAt: now,
      });

      const rejected = yield* decideOrchestrationCommand({
        readModel: first.model,
        command: {
          type: "delegation.request",
          commandId: CommandId.make("request-second-owner"),
          delegationId: DelegationId.make("delegation-second-owner"),
          projectId,
          requester: { kind: "thread", threadId: parentThreadId, requestId: "owner-2" },
          target: { kind: "existingThread", threadId: targetThreadId },
          title: "Second owner",
          task: "Race the first audit.",
          createdAt: now,
        },
      }).pipe(Effect.flip);

      expect(rejected.message).toContain("already owns delegation");
    }),
  );

  it.effect("rejects a Kanban delegation to a bot on the project checkout", () =>
    Effect.gen(function* () {
      const cardId = KanbanCardId.make("card-shared-bot");
      const model = initialModel();
      const rejected = yield* decideOrchestrationCommand({
        readModel: {
          ...model,
          threads: model.threads.map((entry) =>
            entry.id === targetThreadId ? { ...entry, worktreePath: "/workspace/project" } : entry,
          ),
          kanbanCards: [
            {
              id: cardId,
              projectId,
              title: "Shared checkout work",
              description: "Must not run on the project checkout.",
              status: "ready",
              orderKey: "a",
              assigneeThreadId: targetThreadId,
              delegationId: null,
              revision: 1,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          ],
        },
        command: {
          type: "delegation.request",
          commandId: CommandId.make("request-kanban-shared"),
          delegationId: DelegationId.make("delegation-kanban-shared"),
          projectId,
          requester: { kind: "kanban", cardId, cardRevision: 1 },
          target: { kind: "existingThread", threadId: targetThreadId },
          title: "Shared checkout work",
          task: "Run on the assigned bot.",
          createdAt: now,
        },
      }).pipe(Effect.flip);

      expect(rejected.message).toContain("does not own an isolated worktree");
    }),
  );

  it.effect("rejects an ordinary turn that would supersede a running delegation", () =>
    Effect.gen(function* () {
      const requested = yield* decideOne(initialModel(), {
        type: "delegation.request",
        commandId: CommandId.make("request-owned-turn"),
        delegationId,
        projectId,
        requester: { kind: "thread", threadId: parentThreadId, requestId: "owned-turn" },
        target: { kind: "existingThread", threadId: targetThreadId },
        title: "Owned turn",
        task: "Keep this turn reserved.",
        createdAt: now,
      });
      const turnRequested = yield* decideOne(requested.model, {
        type: "delegation.turn.request",
        commandId: CommandId.make("request-owned-turn-start"),
        delegationId,
        createdAt: now,
      });
      const turnId = TurnId.make("turn-owned");
      const assistantMessageId = MessageId.make("assistant-owned");
      const runningModel = {
        ...turnRequested.model,
        threads: turnRequested.model.threads.map((entry) =>
          entry.id === targetThreadId
            ? {
                ...entry,
                latestTurn: {
                  turnId,
                  state: "running" as const,
                  requestedAt: now,
                  startedAt: now,
                  completedAt: null,
                  assistantMessageId,
                },
              }
            : entry,
        ),
      };
      const running = yield* decideOne(runningModel, {
        type: "delegation.turn.bind",
        commandId: CommandId.make("bind-owned-turn"),
        delegationId,
        turnId,
        assistantMessageId,
        createdAt: now,
      });

      const rejected = yield* decideOrchestrationCommand({
        readModel: running.model,
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("superseding-turn"),
          threadId: targetThreadId,
          message: {
            messageId: MessageId.make("superseding-message"),
            role: "user",
            text: "Ignore the delegated work.",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        },
      }).pipe(Effect.flip);

      expect(rejected.message).toContain(`reserved by delegation ${delegationId}`);
    }),
  );

  it.effect("revalidates the assigned bot when a Kanban turn is requested", () =>
    Effect.gen(function* () {
      const cardId = KanbanCardId.make("card-disabled-bot");
      const model = initialModel();
      const requested = yield* decideOne(
        {
          ...model,
          kanbanCards: [
            {
              id: cardId,
              projectId,
              title: "Disabled bot race",
              description: "The bot changes after reservation.",
              status: "ready",
              orderKey: "a",
              assigneeThreadId: targetThreadId,
              delegationId: null,
              revision: 1,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
            },
          ],
        },
        {
          type: "delegation.request",
          commandId: CommandId.make("request-before-disable"),
          delegationId,
          projectId,
          requester: { kind: "kanban", cardId, cardRevision: 1 },
          target: { kind: "existingThread", threadId: targetThreadId },
          title: "Disabled bot race",
          task: "Do not start after disable.",
          createdAt: now,
        },
      );
      const disabledModel = {
        ...requested.model,
        threads: requested.model.threads.map((entry) =>
          entry.id === targetThreadId ? { ...entry, botProfile: null } : entry,
        ),
      };

      const rejected = yield* decideOrchestrationCommand({
        readModel: disabledModel,
        command: {
          type: "delegation.turn.request",
          commandId: CommandId.make("turn-after-disable"),
          delegationId,
          createdAt: now,
        },
      }).pipe(Effect.flip);

      expect(rejected.message).toContain("no longer an active isolated bot");
    }),
  );

  it.effect("reserves a spawned worker before creation and rejects a root-workspace bind", () =>
    Effect.gen(function* () {
      const workerId = ThreadId.make("thread-reserved-worker");
      const requested = yield* decideOne(initialModel(), {
        type: "delegation.request",
        commandId: CommandId.make("request-reserved-worker"),
        delegationId,
        projectId,
        requester: { kind: "thread", threadId: parentThreadId, requestId: "spawn-reserved" },
        target: {
          kind: "newThread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-test",
          },
        },
        title: "Reserved worker",
        task: "Keep the worker reserved while it starts.",
        createdAt: now,
      });
      const provisioned = yield* decideOne(requested.model, {
        type: "delegation.provision.start",
        commandId: CommandId.make("provision-reserved-worker"),
        delegationId,
        targetThreadId: workerId,
        createdAt: now,
      });
      expect(provisioned.model.delegations?.[0]?.targetThreadId).toBe(workerId);

      const withWorker = {
        ...provisioned.model,
        threads: [
          ...provisioned.model.threads,
          { ...thread(workerId), worktreePath: "/workspace/project", botProfile: null },
        ],
      };
      const superseding = yield* decideOrchestrationCommand({
        readModel: withWorker,
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("steer-reserved-worker"),
          threadId: workerId,
          message: {
            messageId: MessageId.make("steer-reserved-message"),
            role: "user",
            text: "Supersede setup.",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        },
      }).pipe(Effect.flip);
      expect(superseding.message).toContain(`reserved by delegation ${delegationId}`);

      const invalidBind = yield* decideOrchestrationCommand({
        readModel: withWorker,
        command: {
          type: "delegation.target.bind",
          commandId: CommandId.make("bind-root-worker"),
          delegationId,
          targetThreadId: workerId,
          createdAt: now,
        },
      }).pipe(Effect.flip);
      expect(invalidBind.message).toContain("does not own an isolated worktree");
    }),
  );

  it.effect("rejects a delegated final turn after its reservation terminalizes", () =>
    Effect.gen(function* () {
      const workerId = ThreadId.make("thread-terminalized-worker");
      const requested = yield* decideOne(initialModel(), {
        type: "delegation.request",
        commandId: CommandId.make("request-terminalized-worker"),
        delegationId,
        projectId,
        requester: { kind: "thread", threadId: parentThreadId, requestId: "terminal-race" },
        target: {
          kind: "newThread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-test",
          },
        },
        title: "Terminalized worker",
        task: "Do not start after the reservation fails.",
        createdAt: now,
      });
      const provisioned = yield* decideOne(requested.model, {
        type: "delegation.provision.start",
        commandId: CommandId.make("provision-terminalized-worker"),
        delegationId,
        targetThreadId: workerId,
        createdAt: now,
      });
      const withWorker = {
        ...provisioned.model,
        threads: [
          ...provisioned.model.threads,
          { ...thread(workerId), worktreePath: "/worktrees/terminalized-worker", botProfile: null },
        ],
      };
      const bound = yield* decideOne(withWorker, {
        type: "delegation.target.bind",
        commandId: CommandId.make("bind-terminalized-worker"),
        delegationId,
        targetThreadId: workerId,
        createdAt: now,
      });
      const terminal = yield* decideOne(bound.model, {
        type: "delegation.complete",
        commandId: CommandId.make("fail-terminalized-worker"),
        delegationId,
        outcome: "failed",
        failure: {
          code: "provision_failed",
          detail: "injected failure before final turn",
        },
        createdAt: now,
      });

      const rejected = yield* decideOrchestrationCommand({
        readModel: terminal.model,
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("start-terminalized-worker"),
          threadId: workerId,
          delegationId,
          message: {
            messageId: MessageId.make("message-terminalized-worker"),
            role: "user",
            text: "This turn must not start.",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        },
      }).pipe(Effect.flip);

      expect(rejected.message).toContain("does not own an active turn reservation");
    }),
  );
});
