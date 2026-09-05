import { describe, expect, it } from "@effect/vitest";
import {
  DelegationId,
  KanbanCardId,
  ProjectId,
  ThreadId,
  type KanbanCard,
} from "@t3tools/contracts";

import {
  applyKanbanBoardStreamItem,
  deriveKanbanCardExecutionStatus,
  type KanbanBoardState,
} from "./kanban.ts";

const projectId = ProjectId.make("project-kanban");
const card: KanbanCard = {
  id: KanbanCardId.make("card-one"),
  projectId,
  title: "Build board",
  description: "",
  status: "backlog",
  orderKey: "U",
  assigneeThreadId: null,
  delegationId: null,
  revision: 1,
  createdAt: "2026-09-03T20:00:00.000Z",
  updatedAt: "2026-09-03T20:00:00.000Z",
  deletedAt: null,
};

describe("Kanban board stream reducer", () => {
  it("hydrates, upserts, and removes cards", () => {
    const empty: KanbanBoardState = { projectId: null, cards: [], delegations: [] };
    const hydrated = applyKanbanBoardStreamItem(empty, {
      kind: "snapshot",
      snapshot: { projectId, cards: [card], delegations: [] },
    });
    const updated = applyKanbanBoardStreamItem(hydrated, {
      kind: "card-upserted",
      sequence: 1,
      card: { ...card, title: "Ship board", revision: 2 },
    });
    const removed = applyKanbanBoardStreamItem(updated, {
      kind: "card-removed",
      sequence: 2,
      projectId,
      cardId: card.id,
    });

    expect(updated.cards).toHaveLength(1);
    expect(updated.cards[0]?.title).toBe("Ship board");
    expect(removed).toEqual({ projectId, cards: [], delegations: [] });
  });

  it("retains linked delegation state from live updates", () => {
    const delegationId = DelegationId.make("delegation-one");
    const board = applyKanbanBoardStreamItem(
      { projectId, cards: [{ ...card, delegationId }], delegations: [] },
      {
        kind: "delegation-upserted",
        projectId,
        sequence: 3,
        delegation: { id: delegationId, state: "running", targetThreadId: null },
      },
    );

    expect(board.delegations).toEqual([
      { id: delegationId, state: "running", targetThreadId: null },
    ]);

    const retried = applyKanbanBoardStreamItem(board, {
      kind: "card-upserted",
      sequence: 4,
      card: { ...card, delegationId: null, revision: 2 },
    });
    expect(retried.delegations).toEqual([]);
  });

  it("derives queued, running, and terminal states from the linked delegation", () => {
    const delegationId = DelegationId.make("delegation-one");
    const assignedCard = {
      ...card,
      status: "ready" as const,
      assigneeThreadId: ThreadId.make("thread-bot"),
      delegationId,
    };
    const statusFor = (state: "requested" | "running" | "failed") =>
      deriveKanbanCardExecutionStatus({
        card: assignedCard,
        delegation: { id: delegationId, state, targetThreadId: assignedCard.assigneeThreadId },
        assignee: null,
      });

    expect(statusFor("requested")).toBe("queued");
    expect(statusFor("running")).toBe("running");
    expect(statusFor("failed")).toBe("failed");
    expect(
      deriveKanbanCardExecutionStatus({
        card: assignedCard,
        delegation: {
          id: delegationId,
          state: "running",
          targetThreadId: assignedCard.assigneeThreadId,
        },
        assignee: { hasPendingApprovals: true, hasPendingUserInput: false },
      }),
    ).toBe("blocked");
  });
});
