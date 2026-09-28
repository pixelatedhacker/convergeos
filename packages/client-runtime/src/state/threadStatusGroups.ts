import type { OrchestrationThreadShell } from "@t3tools/contracts";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";
import {
  resolveCoordinatorStatus,
  resolveSidebarThreadStatus,
  statusOutranks,
  type NestableThread,
  type SidebarThreadStatus,
  type SidebarThreadStatusInput,
} from "./threadNesting.ts";
import {
  resolveThreadActivityTimestamp,
  toSortableTimestamp,
  type ThreadActivityTimestampInput,
} from "./threadSort.ts";

/**
 * Status groups for the active thread list when it is grouped by status
 * instead of the manual order. Pinned rows and the snoozed/settled shelves
 * are never grouped; callers pass only the top-level active rows.
 *
 * - `needs-you`: pending approval, awaiting input, plan ready, failed
 * - `working`: working, connecting, monitoring
 * - `review`: completed and not yet seen
 * - `done`: completed and seen
 * - `ready`: `review` and `done` folded together, for clients without
 *   unread tracking
 */
export type ThreadStatusGroupId = "needs-you" | "working" | "review" | "done" | "ready";

/**
 * How finished threads split. `unseen` separates Ready to review from Done
 * and needs an `isUnseen` predicate; `folded` puts every finished thread in
 * one Ready group (mobile, which has no unread tracking).
 */
export type ThreadStatusGroupReadiness = "unseen" | "folded";

export const THREAD_STATUS_GROUP_LABELS: Record<ThreadStatusGroupId, string> = {
  "needs-you": "Needs you",
  working: "Working",
  review: "Ready to review",
  done: "Done",
  ready: "Ready",
};

const GROUP_ORDER: ReadonlyArray<ThreadStatusGroupId> = [
  "needs-you",
  "working",
  "review",
  "done",
  "ready",
];

export type ThreadStatusGroupInput = SidebarThreadStatusInput &
  Pick<OrchestrationThreadShell, "interactionMode" | "hasActionableProposedPlan" | "latestTurn">;

/** Plan mode finished with a proposal the user has not acted on. */
export function isThreadPlanReady(thread: ThreadStatusGroupInput): boolean {
  if (thread.hasPendingUserInput || thread.interactionMode !== "plan") return false;
  if (!thread.hasActionableProposedPlan) return false;
  const turn = thread.latestTurn;
  if (!turn?.startedAt || !turn.completedAt) return false;
  return thread.session?.status !== "running" && thread.session?.status !== "starting";
}

export function resolveThreadStatusGroup(input: {
  /** Row status; a coordinator passes its rolled-up status. */
  readonly status: SidebarThreadStatus;
  readonly planReady: boolean;
  readonly unseen: boolean;
  readonly readiness: ThreadStatusGroupReadiness;
}): ThreadStatusGroupId {
  switch (input.status) {
    case "approval":
    case "input":
    case "failed":
      return "needs-you";
    case "working":
    case "monitoring":
      // A plan is only ready once the turn settled, so a working plan-ready
      // thread is lingering background work; the decision outranks it.
      return input.planReady ? "needs-you" : "working";
    case "ready":
      if (input.planReady) return "needs-you";
      if (input.readiness === "folded") return "ready";
      return input.unseen ? "review" : "done";
  }
}

export interface ThreadStatusGroup<T> {
  readonly id: ThreadStatusGroupId;
  readonly label: string;
  /** Top-level rows, most recent activity first. Workers stay with their coordinator. */
  readonly threads: ReadonlyArray<T>;
}

type GroupableThread = ThreadStatusGroupInput & NestableThread & ThreadActivityTimestampInput;

/**
 * Splits the top-level active rows into non-empty status groups in display
 * order. A coordinator groups by its collapsed rollup, the status its row
 * shows, so it does not jump groups when expanded; its workers are not
 * grouped on their own and keep riding under it.
 */
export function groupThreadsByStatus<T extends GroupableThread>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly childrenByCoordinator?:
    | ReadonlyMap<string, ReadonlyArray<SidebarThreadStatusInput>>
    | undefined;
  readonly readiness: ThreadStatusGroupReadiness;
  readonly isUnseen?: (thread: T) => boolean;
}): ThreadStatusGroup<T>[] {
  const buckets = new Map<ThreadStatusGroupId, { thread: T; activityMs: number }[]>();
  for (const thread of input.threads) {
    const own = resolveSidebarThreadStatus(thread);
    const children = input.childrenByCoordinator?.get(
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    );
    let rollup: SidebarThreadStatus | null = null;
    if (children !== undefined) {
      rollup = "ready";
      for (const child of children) {
        const status = resolveSidebarThreadStatus(child);
        if (statusOutranks(status, rollup)) rollup = status;
      }
    }
    const group = resolveThreadStatusGroup({
      status: resolveCoordinatorStatus({ own, rollup, expanded: false }),
      planReady: isThreadPlanReady(thread),
      unseen: input.readiness === "unseen" && input.isUnseen?.(thread) === true,
      readiness: input.readiness,
    });
    const activity = resolveThreadActivityTimestamp(thread);
    const entry = { thread, activityMs: toSortableTimestamp(activity ?? undefined) ?? 0 };
    const bucket = buckets.get(group);
    if (bucket === undefined) buckets.set(group, [entry]);
    else bucket.push(entry);
  }
  const groups: ThreadStatusGroup<T>[] = [];
  for (const id of GROUP_ORDER) {
    const bucket = buckets.get(id);
    if (bucket === undefined) continue;
    bucket.sort(
      (left, right) =>
        right.activityMs - left.activityMs ||
        (left.thread.id < right.thread.id ? -1 : left.thread.id > right.thread.id ? 1 : 0),
    );
    groups.push({
      id,
      label: THREAD_STATUS_GROUP_LABELS[id],
      threads: bucket.map((e) => e.thread),
    });
  }
  return groups;
}
