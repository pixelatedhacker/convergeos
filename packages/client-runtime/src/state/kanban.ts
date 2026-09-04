import {
  WS_METHODS,
  type KanbanCard,
  type KanbanBoardStreamItem,
  type ProjectId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createKanbanCard,
  deleteKanbanCard,
  moveKanbanCard,
  updateKanbanCard,
  type CreateKanbanCardInput,
  type DeleteKanbanCardInput,
  type MoveKanbanCardInput,
  type UpdateKanbanCardInput,
} from "../operations/commands.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function applyKanbanBoardStreamItem(
  board: KanbanBoardState,
  item: KanbanBoardStreamItem,
): KanbanBoardState {
  if (item.kind === "snapshot") return item.snapshot;
  if (item.kind === "card-removed") {
    return { ...board, cards: board.cards.filter((card) => card.id !== item.cardId) };
  }
  return {
    ...board,
    cards: [...board.cards.filter((card) => card.id !== item.card.id), item.card],
  };
}

export interface KanbanBoardState {
  readonly projectId: ProjectId | null;
  readonly cards: ReadonlyArray<KanbanCard>;
}

export function createKanbanEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  return {
    board: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:kanban:board",
      tag: WS_METHODS.kanbanSubscribeBoard,
      idleTtlMs: 0,
      transform: (stream) =>
        stream.pipe(
          Stream.scan(
            { projectId: null, cards: [] } satisfies KanbanBoardState,
            applyKanbanBoardStreamItem,
          ),
        ),
    }),
    createCard: createEnvironmentCommand(runtime, {
      label: "environment-data:kanban:create-card",
      execute: (input: CreateKanbanCardInput) => createKanbanCard(input),
      scheduler,
      concurrency,
    }),
    updateCard: createEnvironmentCommand(runtime, {
      label: "environment-data:kanban:update-card",
      execute: (input: UpdateKanbanCardInput) => updateKanbanCard(input),
      scheduler,
      concurrency,
    }),
    moveCard: createEnvironmentCommand(runtime, {
      label: "environment-data:kanban:move-card",
      execute: (input: MoveKanbanCardInput) => moveKanbanCard(input),
      scheduler,
      concurrency,
    }),
    deleteCard: createEnvironmentCommand(runtime, {
      label: "environment-data:kanban:delete-card",
      execute: (input: DeleteKanbanCardInput) => deleteKanbanCard(input),
      scheduler,
      concurrency,
    }),
  };
}
