import {
  CommandId,
  DelegationId,
  type Delegation,
  type KanbanCard,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { OrchestrationDispatchError } from "./Errors.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { threadHasQueuedTurnStart } from "./ThreadSettlementPolicy.ts";

const OPEN_DELEGATION_STATES = new Set<Delegation["state"]>([
  "requested",
  "provisioning",
  "turnRequested",
  "running",
]);

export interface KanbanDelegationReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly reconcile: () => Effect.Effect<
    void,
    OrchestrationDispatchError | ProjectionRepositoryError | PlatformError.PlatformError
  >;
}

export class KanbanDelegationReactor extends Context.Service<
  KanbanDelegationReactor,
  KanbanDelegationReactorShape
>()("t3/orchestration/KanbanDelegationReactor") {}

export function kanbanDelegationId(card: KanbanCard): DelegationId {
  return DelegationId.make(`kanban:${card.id}:${card.revision}`);
}

export function kanbanDelegationTask(card: KanbanCard): string {
  return card.description.length === 0 ? card.title : `${card.title}\n\n${card.description}`;
}

export function isAvailableKanbanBot(input: {
  readonly card: KanbanCard;
  readonly thread: OrchestrationThreadShell | undefined;
  readonly projectWorkspaceRoot: string | undefined;
  readonly delegations: ReadonlyArray<Delegation>;
  readonly reservedTargetIds?: ReadonlySet<string>;
  readonly now: string;
}): boolean {
  const { card, thread, projectWorkspaceRoot, delegations } = input;
  if (
    thread === undefined ||
    thread.id !== card.assigneeThreadId ||
    thread.projectId !== card.projectId ||
    thread.archivedAt !== null ||
    thread.botProfile == null ||
    thread.worktreePath === null ||
    (projectWorkspaceRoot !== undefined &&
      normalizeProjectPathForComparison(thread.worktreePath) ===
        normalizeProjectPathForComparison(projectWorkspaceRoot))
  ) {
    return false;
  }
  if (thread.latestTurn?.state === "running" || thread.latestTurn?.state === "error") return false;
  if (
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.session?.status === "error"
  ) {
    return false;
  }
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.backgroundLiveness != null) return false;
  if (threadHasQueuedTurnStart(thread, input.now)) return false;
  if (input.reservedTargetIds?.has(thread.id) === true) return false;
  return !delegations.some(
    (delegation) =>
      delegation.targetThreadId === thread.id && OPEN_DELEGATION_STATES.has(delegation.state),
  );
}

function isReconcileEvent(event: OrchestrationEvent): boolean {
  if (event.type === "thread.activity-appended") {
    const { kind, payload } = event.payload.activity;
    const status =
      typeof payload === "object" && payload !== null && "status" in payload
        ? payload.status
        : undefined;
    return (
      kind === "approval.requested" ||
      kind === "approval.resolved" ||
      kind === "user-input.requested" ||
      kind === "user-input.resolved" ||
      kind === "task.started" ||
      kind === "task.updated" ||
      kind === "task.completed" ||
      (kind === "task.progress" && typeof status === "string")
    );
  }
  return (
    event.type.startsWith("kanban.") ||
    event.type.startsWith("delegation.") ||
    event.type === "thread.session-set" ||
    event.type === "thread.turn-start-requested" ||
    event.type === "thread.turn-interrupt-requested" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.bot-configured" ||
    event.type === "thread.bot-disabled" ||
    event.type === "thread.archived" ||
    event.type === "thread.unarchived" ||
    event.type === "thread.deleted"
  );
}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const reconcile = Effect.fn("KanbanDelegationReactor.reconcile")(function* () {
    const [model, shellSnapshot] = yield* Effect.all([
      snapshots.getCommandReadModel(),
      snapshots.getShellSnapshot(),
    ]);
    const cards = (model.kanbanCards ?? []).filter((card) => card.deletedAt === null);
    const delegations = model.delegations ?? [];
    const reservedTargetIds = new Set(
      delegations.flatMap((delegation) =>
        delegation.targetThreadId !== null && OPEN_DELEGATION_STATES.has(delegation.state)
          ? [delegation.targetThreadId]
          : [],
      ),
    );

    for (const card of cards) {
      if (card.delegationId !== null) {
        const delegation = delegations.find((entry) => entry.id === card.delegationId);
        if (delegation?.state === "running" && card.status === "ready") {
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          yield* engine.dispatch({
            type: "kanban.card.delegation.start",
            commandId: CommandId.make(`server:kanban-start:${card.id}:${delegation.id}`),
            cardId: card.id,
            delegationId: delegation.id,
            createdAt,
          });
        } else if (
          (delegation?.state === "completed" &&
            (card.status === "ready" || card.status === "inProgress")) ||
          ((delegation?.state === "failed" || delegation?.state === "interrupted") &&
            card.status === "inProgress")
        ) {
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          yield* engine.dispatch({
            type: "kanban.card.delegation.complete",
            commandId: CommandId.make(`server:kanban-complete:${card.id}:${delegation.id}`),
            cardId: card.id,
            delegationId: delegation.id,
            createdAt,
          });
        }
        continue;
      }

      if (card.status !== "ready" || card.assigneeThreadId === null) continue;

      const existing = delegations.find(
        (delegation) =>
          delegation.requester.kind === "kanban" &&
          delegation.requester.cardId === card.id &&
          delegation.requester.cardRevision === card.revision,
      );
      if (existing !== undefined) {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        yield* engine.dispatch({
          type: "kanban.card.delegation.link",
          commandId: CommandId.make(`server:kanban-link:${card.id}:${card.revision}`),
          cardId: card.id,
          expectedRevision: card.revision,
          delegationId: existing.id,
          createdAt,
        });
        continue;
      }

      const thread = shellSnapshot.threads.find(
        (candidate) => candidate.id === card.assigneeThreadId,
      );
      const project = model.projects.find((candidate) => candidate.id === card.projectId);
      if (thread === undefined) continue;
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      if (
        !isAvailableKanbanBot({
          card,
          thread,
          projectWorkspaceRoot: project?.workspaceRoot,
          delegations,
          reservedTargetIds,
          now: createdAt,
        })
      ) {
        continue;
      }

      const delegationId = kanbanDelegationId(card);
      const attemptId = yield* crypto.randomUUIDv4;
      yield* engine
        .dispatch({
          type: "delegation.request",
          commandId: CommandId.make(`server:kanban-request:${delegationId}:${attemptId}`),
          delegationId,
          projectId: card.projectId,
          requester: { kind: "kanban", cardId: card.id, cardRevision: card.revision },
          target: { kind: "existingThread", threadId: thread.id },
          title: card.title,
          task: kanbanDelegationTask(card),
          createdAt,
        })
        .pipe(Effect.catchTag("OrchestrationCommandInvariantError", () => Effect.void));
      reservedTargetIds.add(thread.id);
    }
  });

  const reconcileSafely = reconcile().pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Kanban delegation reconciliation failed", {
            cause: Cause.pretty(cause),
          }),
    ),
  );

  const start: KanbanDelegationReactorShape["start"] = Effect.fn("KanbanDelegationReactor.start")(
    function* () {
      const events = yield* engine.subscribeDomainEvents;
      yield* reconcileSafely;
      yield* forkParked(
        Stream.runForEach(events.pipe(Stream.filter(isReconcileEvent)), () => reconcileSafely),
      );
    },
  );

  return KanbanDelegationReactor.of({ start, reconcile });
});

export const layer = Layer.effect(KanbanDelegationReactor, make);
