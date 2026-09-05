import {
  WS_METHODS,
  type KanbanCard,
  type KanbanBoardStreamItem,
  type KanbanDelegationSummary,
  type OrchestrationThreadShell,
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
  retryKanbanCard,
  updateKanbanCard,
  type CreateKanbanCardInput,
  type DeleteKanbanCardInput,
  type MoveKanbanCardInput,
  type RetryKanbanCardInput,
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
    const removed = board.cards.find((card) => card.id === item.cardId);
    return {
      ...board,
      cards: board.cards.filter((card) => card.id !== item.cardId),
      delegations:
        removed?.delegationId == null
          ? board.delegations
          : board.delegations.filter((delegation) => delegation.id !== removed.delegationId),
    };
  }
  if (item.kind === "delegation-upserted") {
    return {
      ...board,
      delegations: [
        ...board.delegations.filter((delegation) => delegation.id !== item.delegation.id),
        item.delegation,
      ],
    };
  }
  const previous = board.cards.find((card) => card.id === item.card.id);
  return {
    ...board,
    cards: [...board.cards.filter((card) => card.id !== item.card.id), item.card],
    delegations:
      previous?.delegationId == null || previous.delegationId === item.card.delegationId
        ? board.delegations
        : board.delegations.filter((delegation) => delegation.id !== previous.delegationId),
  };
}

export interface KanbanBoardState {
  readonly projectId: ProjectId | null;
  readonly cards: ReadonlyArray<KanbanCard>;
  readonly delegations: ReadonlyArray<KanbanDelegationSummary>;
}

export type KanbanCardExecutionStatus =
  | "queued"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "interrupted";

export function deriveKanbanCardExecutionStatus(input: {
  readonly card: KanbanCard;
  readonly delegation: KanbanDelegationSummary | null;
  readonly assignee: Pick<
    OrchestrationThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput"
  > | null;
}): KanbanCardExecutionStatus | null {
  if (input.card.assigneeThreadId === null || input.card.status === "backlog") return null;
  if (input.delegation === null) {
    const assignee = input.assignee;
    const blocked =
      assignee !== null && (assignee.hasPendingApprovals || assignee.hasPendingUserInput);
    return blocked ? "blocked" : "queued";
  }
  switch (input.delegation.state) {
    case "requested":
    case "provisioning":
    case "turnRequested":
      return "queued";
    case "running": {
      const assignee = input.assignee;
      return assignee !== null && (assignee.hasPendingApprovals || assignee.hasPendingUserInput)
        ? "blocked"
        : "running";
    }
    case "completed":
    case "failed":
    case "interrupted":
      return input.delegation.state;
  }
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
            { projectId: null, cards: [], delegations: [] } satisfies KanbanBoardState,
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
    retryCard: createEnvironmentCommand(runtime, {
      label: "environment-data:kanban:retry-card",
      execute: (input: RetryKanbanCardInput) => retryKanbanCard(input),
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
