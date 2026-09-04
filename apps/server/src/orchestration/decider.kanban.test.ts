import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  KanbanCardCreatedPayload,
  KanbanCardDeletedPayload,
  KanbanCardId,
  KanbanCardMovedPayload,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type KanbanCard,
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
  revision: 1,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...overrides,
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
});
