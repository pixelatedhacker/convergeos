import { describe, expect, it } from "@effect/vitest";
import { KanbanCardId, ProjectId, type KanbanCard } from "@t3tools/contracts";

import { applyKanbanBoardStreamItem, type KanbanBoardState } from "./kanban.ts";

const projectId = ProjectId.make("project-kanban");
const card: KanbanCard = {
  id: KanbanCardId.make("card-one"),
  projectId,
  title: "Build board",
  description: "",
  status: "backlog",
  orderKey: "U",
  assigneeThreadId: null,
  revision: 1,
  createdAt: "2026-09-03T20:00:00.000Z",
  updatedAt: "2026-09-03T20:00:00.000Z",
  deletedAt: null,
};

describe("Kanban board stream reducer", () => {
  it("hydrates, upserts, and removes cards", () => {
    const empty: KanbanBoardState = { projectId: null, cards: [] };
    const hydrated = applyKanbanBoardStreamItem(empty, {
      kind: "snapshot",
      snapshot: { projectId, cards: [card] },
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
    expect(removed).toEqual({ projectId, cards: [] });
  });
});
