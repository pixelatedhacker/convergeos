import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  DelegationId,
  DelegationTransitionPayload,
  KanbanCardCreatedPayload,
  KanbanCardDelegationLinkedPayload,
  KanbanCardDeletedPayload,
  KanbanCardId,
  KanbanCardMovedPayload,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type KanbanCard,
  type Delegation,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-09-03T20:00:00.000Z";
const projectId = ProjectId.make("project-kanban");
const botThreadId = ThreadId.make("thread-planner-bot");

const botThread: OrchestrationThread = {
  id: botThreadId,
  projectId,
  title: "Planner",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "codex/planner",
  worktreePath: "/worktrees/planner",
  linkedPullRequest: null,
  botProfile: {
    displayName: "Planner",
    description: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  },
  latestTurn: null,
  createdAt: NOW,
  updatedAt: NOW,
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
};

const readModel = (cards: ReadonlyArray<KanbanCard> = []): OrchestrationReadModel => ({
  snapshotSequence: 0,
  projects: [
    {
      id: projectId,
      title: "Kanban",
      workspaceRoot: "/workspace/project",
      repositoryIdentity: null,
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      autoPull: false,
      faviconPath: null,
      projectIcon: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    },
  ],
  threads: [botThread],
  kanbanCards: cards,
  updatedAt: NOW,
});

const card = (overrides: Partial<KanbanCard> = {}): KanbanCard => ({
  id: KanbanCardId.make("card-one"),
  projectId,
  title: "Ship the board",
  description: "",
  status: "backlog",
  orderKey: "U",
  assigneeThreadId: botThreadId,
  delegationId: null,
  revision: 1,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...overrides,
});

const requestDelegationFor = (
  requesterCard: KanbanCard,
): Extract<OrchestrationCommand, { type: "delegation.request" }> => ({
  type: "delegation.request",
  commandId: CommandId.make(`request-${requesterCard.id}-${requesterCard.revision}`),
  delegationId: DelegationId.make(`delegation-${requesterCard.id}-${requesterCard.revision}`),
  projectId,
  requester: {
    kind: "kanban",
    cardId: requesterCard.id,
    cardRevision: requesterCard.revision,
  },
  target: { kind: "existingThread", threadId: botThreadId },
  title: requesterCard.title,
  task: requesterCard.description.length === 0 ? requesterCard.title : requesterCard.description,
  createdAt: NOW,
});

it.layer(NodeServices.layer)("kanban decider", (it) => {
  it.effect("creates a card assigned to an active project bot", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "kanban.card.create",
          commandId: CommandId.make("create-card"),
          cardId: KanbanCardId.make("card-new"),
          projectId,
          title: "Write release notes",
          description: "Cover bots and boards.",
          assigneeThreadId: botThreadId,
          placement: { status: "ready", relation: "last" },
          createdAt: NOW,
        },
        readModel: readModel(),
      });

      expect("type" in event && event.type).toBe("kanban.card-created");
      if (!("type" in event) || event.type !== "kanban.card-created") return;
      const payload = yield* Schema.decodeUnknownEffect(KanbanCardCreatedPayload)(event.payload);
      expect(event.aggregateKind).toBe("kanban-card");
      expect(payload.card).toMatchObject({
        title: "Write release notes",
        status: "ready",
        assigneeThreadId: botThreadId,
        revision: 1,
      });
    }),
  );

  it.effect("rejects non-bot assignments and stale revisions", () =>
    Effect.gen(function* () {
      const assignmentError = yield* decideOrchestrationCommand({
        command: {
          type: "kanban.card.create",
          commandId: CommandId.make("bad-assignment"),
          cardId: KanbanCardId.make("card-new"),
          projectId,
          title: "Invalid assignment",
          description: "",
          assigneeThreadId: ThreadId.make("not-a-bot"),
          placement: { status: "backlog", relation: "last" },
          createdAt: NOW,
        },
        readModel: readModel(),
      }).pipe(Effect.flip);
      expect(assignmentError.message).toContain("not an active bot");

      const revisionError = yield* decideOrchestrationCommand({
        command: {
          type: "kanban.card.update",
          commandId: CommandId.make("stale-update"),
          cardId: card().id,
          expectedRevision: 2,
          title: "Stale",
          createdAt: NOW,
        },
        readModel: readModel([card()]),
      }).pipe(Effect.flip);
      expect(revisionError.message).toContain("revision changed");
    }),
  );

  it.effect("moves and deletes cards through projected revisions", () =>
    Effect.gen(function* () {
      const initial = readModel([card()]);
      const moved = yield* decideOrchestrationCommand({
        command: {
          type: "kanban.card.move",
          commandId: CommandId.make("move-card"),
          cardId: card().id,
          expectedRevision: 1,
          placement: { status: "inProgress", relation: "last" },
          createdAt: NOW,
        },
        readModel: initial,
      });
      expect("type" in moved && moved.type).toBe("kanban.card-moved");
      if (!("type" in moved) || moved.type !== "kanban.card-moved") return;
      const movedPayload = yield* Schema.decodeUnknownEffect(KanbanCardMovedPayload)(moved.payload);
      expect(movedPayload.card).toMatchObject({ status: "inProgress", revision: 2 });

      const projected = yield* projectEvent(initial, {
        ...moved,
        type: "kanban.card-moved",
        payload: movedPayload,
        sequence: 1,
      });
      const deleted = yield* decideOrchestrationCommand({
        command: {
          type: "kanban.card.delete",
          commandId: CommandId.make("delete-card"),
          cardId: card().id,
          expectedRevision: 2,
          createdAt: NOW,
        },
        readModel: projected,
      });
      expect("type" in deleted && deleted.type).toBe("kanban.card-deleted");
      if (!("type" in deleted) || deleted.type !== "kanban.card-deleted") return;
      const deletedPayload = yield* Schema.decodeUnknownEffect(KanbanCardDeletedPayload)(
        deleted.payload,
      );

      const afterDelete = yield* projectEvent(projected, {
        ...deleted,
        type: "kanban.card-deleted",
        payload: deletedPayload,
        sequence: 2,
      });
      expect(afterDelete.kanbanCards?.[0]).toMatchObject({
        revision: 3,
        deletedAt: deletedPayload.deletedAt,
      });
    }),
  );

  it.effect("generates canonical order keys for relative placement", () =>
    Effect.gen(function* () {
      const moving = card({ id: KanbanCardId.make("card-moving"), assigneeThreadId: null });
      const first = card({
        id: KanbanCardId.make("card-first"),
        status: "ready",
        orderKey: "n",
      });
      const last = card({
        id: KanbanCardId.make("card-last"),
        status: "ready",
        orderKey: "t",
      });
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "kanban.card.move",
          commandId: CommandId.make("move-between"),
          cardId: moving.id,
          expectedRevision: moving.revision,
          placement: { status: "ready", relation: "before", cardId: last.id },
          createdAt: NOW,
        },
        readModel: readModel([moving, first, last]),
      });
      if (!("type" in event) || event.type !== "kanban.card-moved") return;
      const payload = yield* Schema.decodeUnknownEffect(KanbanCardMovedPayload)(event.payload);

      expect(payload.card.orderKey > first.orderKey).toBe(true);
      expect(payload.card.orderKey < last.orderKey).toBe(true);
    }),
  );

  it.effect("links, settles, and explicitly retries failed bot work", () =>
    Effect.gen(function* () {
      const delegationId = DelegationId.make("kanban-card-one-1");
      const ready = card({ status: "ready" });
      const requested: Delegation = {
        id: delegationId,
        projectId,
        requester: { kind: "kanban", cardId: ready.id, cardRevision: ready.revision },
        target: { kind: "existingThread", threadId: botThreadId },
        title: ready.title,
        task: ready.title,
        state: "requested",
        targetThreadId: botThreadId,
        turnId: null,
        assistantMessageId: null,
        failure: null,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      const linked = yield* decideOrchestrationCommand({
        command: {
          type: "kanban.card.delegation.link",
          commandId: CommandId.make("link-card"),
          cardId: ready.id,
          expectedRevision: ready.revision,
          delegationId,
          createdAt: NOW,
        },
        readModel: { ...readModel([ready]), delegations: [requested] },
      });
      if (
        !("type" in linked) ||
        linked.type !== "kanban.card-delegation-linked" ||
        !("card" in linked.payload)
      ) {
        return;
      }
      expect(linked.payload.card).toMatchObject({
        status: "ready",
        delegationId,
        revision: 2,
      });

      const failed: Delegation = {
        ...requested,
        state: "failed",
        failure: { code: "worker_failed", detail: "Nope" },
        revision: 2,
      };
      const settled = yield* decideOrchestrationCommand({
        command: {
          type: "kanban.card.delegation.complete",
          commandId: CommandId.make("settle-card"),
          cardId: ready.id,
          delegationId,
          createdAt: NOW,
        },
        readModel: {
          ...readModel([{ ...linked.payload.card, status: "inProgress" }]),
          delegations: [failed],
        },
      });
      if (
        !("type" in settled) ||
        settled.type !== "kanban.card-delegation-completed" ||
        !("card" in settled.payload)
      ) {
        return;
      }
      expect(settled.payload.card).toMatchObject({
        status: "ready",
        delegationId,
        revision: 3,
      });

      const retried = yield* decideOrchestrationCommand({
        command: {
          type: "kanban.card.retry",
          commandId: CommandId.make("retry-card"),
          cardId: ready.id,
          expectedRevision: settled.payload.card.revision,
          createdAt: NOW,
        },
        readModel: { ...readModel([settled.payload.card]), delegations: [failed] },
      });
      if (
        !("type" in retried) ||
        retried.type !== "kanban.card-retried" ||
        !("card" in retried.payload)
      ) {
        return;
      }
      expect(retried.payload.card).toMatchObject({
        status: "ready",
        delegationId: null,
        revision: 4,
      });
    }),
  );

  it.effect("reserves and links a ready card in one decision", () =>
    Effect.gen(function* () {
      const ready = card({ status: "ready" });
      const decided = yield* decideOrchestrationCommand({
        command: requestDelegationFor(ready),
        readModel: { ...readModel([ready]), delegations: [] },
      });
      const events = Array.isArray(decided) ? decided : [decided];

      expect(events.map((event) => event.type)).toEqual([
        "delegation.requested",
        "kanban.card-delegation-linked",
      ]);
      const requestedEvent = events[0];
      const linkedEvent = events[1];
      if (requestedEvent === undefined || linkedEvent === undefined) return;
      const requested = yield* Schema.decodeUnknownEffect(DelegationTransitionPayload)(
        requestedEvent.payload,
      );
      const linked = yield* Schema.decodeUnknownEffect(KanbanCardDelegationLinkedPayload)(
        linkedEvent.payload,
      );
      expect(linked.card).toMatchObject({
        status: "ready",
        delegationId: requested.delegation.id,
        revision: ready.revision + 1,
      });
    }),
  );

  it.effect("rejects stale reservation attempts after edit, reassignment, or deletion wins", () =>
    Effect.gen(function* () {
      const ready = card({ status: "ready" });
      const request = requestDelegationFor(ready);
      const changedCards = [
        { ...ready, title: "Edited first", revision: ready.revision + 1 },
        { ...ready, assigneeThreadId: null, revision: ready.revision + 1 },
        { ...ready, deletedAt: NOW, revision: ready.revision + 1 },
      ];

      for (const changedCard of changedCards) {
        const error = yield* decideOrchestrationCommand({
          command: request,
          readModel: { ...readModel([changedCard]), delegations: [] },
        }).pipe(Effect.flip);
        expect(error.message).toMatch(/revision|not active/);
      }
    }),
  );

  it.effect("blocks edits, reassignment, and deletion after reservation wins", () =>
    Effect.gen(function* () {
      const ready = card({ status: "ready" });
      const decided = yield* decideOrchestrationCommand({
        command: requestDelegationFor(ready),
        readModel: { ...readModel([ready]), delegations: [] },
      });
      const events = Array.isArray(decided) ? decided : [decided];
      const requestedEvent = events[0];
      const linkedEvent = events[1];
      if (requestedEvent === undefined || linkedEvent === undefined) return;
      const requested = yield* Schema.decodeUnknownEffect(DelegationTransitionPayload)(
        requestedEvent.payload,
      );
      const linked = yield* Schema.decodeUnknownEffect(KanbanCardDelegationLinkedPayload)(
        linkedEvent.payload,
      );
      const lockedModel = {
        ...readModel([linked.card]),
        delegations: [requested.delegation],
      };
      const commands: ReadonlyArray<OrchestrationCommand> = [
        {
          type: "kanban.card.update",
          commandId: CommandId.make("edit-after-reservation"),
          cardId: linked.card.id,
          expectedRevision: linked.card.revision,
          title: "Too late",
          createdAt: NOW,
        },
        {
          type: "kanban.card.update",
          commandId: CommandId.make("reassign-after-reservation"),
          cardId: linked.card.id,
          expectedRevision: linked.card.revision,
          assigneeThreadId: null,
          createdAt: NOW,
        },
        {
          type: "kanban.card.delete",
          commandId: CommandId.make("delete-after-reservation"),
          cardId: linked.card.id,
          expectedRevision: linked.card.revision,
          createdAt: NOW,
        },
      ];

      for (const command of commands) {
        const error = yield* decideOrchestrationCommand({ command, readModel: lockedModel }).pipe(
          Effect.flip,
        );
        expect(error.message).toContain("active delegated work");
      }
    }),
  );

  it.effect("releases completed cards for reuse but keeps failed work behind retry", () =>
    Effect.gen(function* () {
      const delegationId = DelegationId.make("kanban-card-one-1");
      const linkedCard = card({
        status: "review",
        delegationId,
        revision: 2,
      });
      const completed: Delegation = {
        id: delegationId,
        projectId,
        requester: { kind: "kanban", cardId: linkedCard.id, cardRevision: 1 },
        target: { kind: "existingThread", threadId: botThreadId },
        title: linkedCard.title,
        task: linkedCard.title,
        state: "completed",
        targetThreadId: botThreadId,
        turnId: null,
        assistantMessageId: null,
        failure: null,
        revision: 3,
        createdAt: NOW,
        updatedAt: NOW,
      };
      const moved = yield* decideOrchestrationCommand({
        command: {
          type: "kanban.card.move",
          commandId: CommandId.make("reuse-completed-card"),
          cardId: linkedCard.id,
          expectedRevision: linkedCard.revision,
          placement: { status: "backlog", relation: "last" },
          createdAt: NOW,
        },
        readModel: { ...readModel([linkedCard]), delegations: [completed] },
      });
      if (!("type" in moved) || moved.type !== "kanban.card-moved") return;
      const movedPayload = yield* Schema.decodeUnknownEffect(KanbanCardMovedPayload)(moved.payload);
      expect(movedPayload.card).toMatchObject({ status: "backlog", delegationId: null });

      const failed = {
        ...completed,
        state: "failed" as const,
        failure: { code: "worker_failed", detail: "Nope" },
      };
      const moveError = yield* decideOrchestrationCommand({
        command: {
          type: "kanban.card.move",
          commandId: CommandId.make("move-failed-card"),
          cardId: linkedCard.id,
          expectedRevision: linkedCard.revision,
          placement: { status: "backlog", relation: "last" },
          createdAt: NOW,
        },
        readModel: {
          ...readModel([{ ...linkedCard, status: "ready" }]),
          delegations: [failed],
        },
      }).pipe(Effect.flip);
      expect(moveError.message).toContain("retried explicitly");
    }),
  );
});
