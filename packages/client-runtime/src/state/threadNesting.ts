import type { EnvironmentId, OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";

/**
 * What a thread row is doing right now. Color is reserved for "act now"
 * (approval), "in motion" (working), and "broken" (failed); ready is the
 * resting state.
 */
export type SidebarThreadStatus =
  | "approval"
  | "input"
  | "working"
  | "monitoring"
  | "failed"
  | "ready";

export type SidebarThreadStatusInput = Pick<
  OrchestrationThreadShell,
  "hasPendingApprovals" | "hasPendingUserInput" | "session" | "backgroundLiveness"
>;

export function resolveSidebarThreadStatus(thread: SidebarThreadStatusInput): SidebarThreadStatus {
  if (thread.hasPendingApprovals) {
    return "approval";
  }
  if (thread.hasPendingUserInput) {
    return "input";
  }
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "working";
  }
  // A failed session outranks lingering background liveness: the user must
  // see the failure, not a stale Working.
  if (thread.session?.status === "error") {
    return "failed";
  }
  // Background work outlives the turn: fleets read as working; monitoring
  // only when watch loops are the sole live work.
  if (thread.backgroundLiveness === "working") {
    return "working";
  }
  if (thread.backgroundLiveness === "monitoring") {
    return "monitoring";
  }
  return "ready";
}

/**
 * Rollup order for a group of threads. Mirrors the web sidebar's
 * THREAD_STATUS_PRIORITY: attention states, then active work, then passive
 * monitoring. Failed sits where that table ranks the actionable plan prompt,
 * so a broken worker surfaces over quiet ones but never over one that needs
 * the user.
 */
export const THREAD_STATUS_ROLLUP_PRIORITY: Record<SidebarThreadStatus, number> = {
  approval: 6,
  input: 5,
  working: 4,
  failed: 3,
  monitoring: 2,
  ready: 0,
};

export function statusOutranks(candidate: SidebarThreadStatus, current: SidebarThreadStatus) {
  return THREAD_STATUS_ROLLUP_PRIORITY[candidate] > THREAD_STATUS_ROLLUP_PRIORITY[current];
}

export interface NestableThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly parentThreadId?: ThreadId | null | undefined;
}

function keyOf(thread: Pick<NestableThread, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

export interface WorkerNesting<T> {
  /** Children in their partition order, keyed by the coordinator's scoped key. */
  readonly childrenByCoordinator: ReadonlyMap<string, ReadonlyArray<T>>;
  /** Scoped keys of threads that render under a coordinator instead of top-level. */
  readonly nestedKeys: ReadonlySet<string>;
  /** Workers whose coordinator is not visible in the pinned or active blocks. */
  readonly orphans: ReadonlyArray<T>;
}

/**
 * Groups mesh workers under the coordinator that spawned them, one level
 * deep. Callers pass the already-partitioned pinned and active blocks, so
 * every lifecycle rule falls out of the partition:
 *
 * - Only active workers nest. A pinned worker stays pinned (pin wins); a
 *   settled or snoozed worker is on its shelf, and shelves stay flat.
 * - A worker nests only under a coordinator in the pinned or active block.
 *   A settled, snoozed, archived, or deleted coordinator is absent here, so
 *   its workers render as ordinary top-level rows (orphans).
 * - A nested worker cannot itself be a coordinator; its own workers stay
 *   top-level.
 */
export function groupWorkersByCoordinator<T extends NestableThread>(input: {
  readonly pinned: ReadonlyArray<T>;
  readonly active: ReadonlyArray<T>;
}): WorkerNesting<T> {
  const visible = new Map<string, T>();
  for (const thread of input.pinned) visible.set(keyOf(thread), thread);
  for (const thread of input.active) visible.set(keyOf(thread), thread);

  const activeKeys = new Set(input.active.map(keyOf));
  const parentKeyOf = (thread: T): string | null =>
    thread.parentThreadId == null
      ? null
      : keyOf({ environmentId: thread.environmentId, id: thread.parentThreadId });

  // Resolved lazily so a chain (coordinator -> worker -> sub-worker) keeps
  // one level: the worker nests, the sub-worker's parent is nested, so it
  // stays top-level. `visiting` breaks malformed cycles.
  const nested = new Map<string, boolean>();
  const visiting = new Set<string>();
  const isNested = (key: string): boolean => {
    const known = nested.get(key);
    if (known !== undefined) return known;
    const thread = visible.get(key);
    const parentKey = thread === undefined ? null : parentKeyOf(thread);
    let result = false;
    if (
      thread !== undefined &&
      parentKey !== null &&
      parentKey !== key &&
      activeKeys.has(key) &&
      visible.has(parentKey) &&
      !visiting.has(key)
    ) {
      visiting.add(key);
      result = !isNested(parentKey);
      visiting.delete(key);
    }
    nested.set(key, result);
    return result;
  };

  const childrenByCoordinator = new Map<string, T[]>();
  const nestedKeys = new Set<string>();
  const orphans: T[] = [];
  for (const thread of [...input.pinned, ...input.active]) {
    const parentKey = parentKeyOf(thread);
    if (parentKey === null) continue;
    const key = keyOf(thread);
    if (!isNested(key)) {
      orphans.push(thread);
      continue;
    }
    nestedKeys.add(key);
    const children = childrenByCoordinator.get(parentKey);
    if (children === undefined) childrenByCoordinator.set(parentKey, [thread]);
    else children.push(thread);
  }
  return { childrenByCoordinator, nestedKeys, orphans };
}

export interface WorkerSummary {
  readonly total: number;
  readonly running: number;
  readonly needsYou: number;
  readonly failed: number;
  /** Highest-priority child status, for a collapsed coordinator. */
  readonly rollupStatus: SidebarThreadStatus;
  /** "3 workers · 1 running · 1 needs you" */
  readonly text: string;
}

export function workerSummary(children: ReadonlyArray<SidebarThreadStatusInput>): WorkerSummary {
  let running = 0;
  let needsYou = 0;
  let failed = 0;
  let rollupStatus: SidebarThreadStatus = "ready";
  for (const child of children) {
    const status = resolveSidebarThreadStatus(child);
    if (status === "working" || status === "monitoring") running += 1;
    else if (status === "approval" || status === "input") needsYou += 1;
    else if (status === "failed") failed += 1;
    if (statusOutranks(status, rollupStatus)) rollupStatus = status;
  }
  const total = children.length;
  const parts = [`${total} ${total === 1 ? "worker" : "workers"}`];
  if (running > 0) parts.push(`${running} running`);
  if (needsYou > 0) parts.push(`${needsYou} ${needsYou === 1 ? "needs" : "need"} you`);
  if (failed > 0) parts.push(`${failed} failed`);
  return { total, running, needsYou, failed, rollupStatus, text: parts.join(" · ") };
}

/**
 * The status a coordinator row shows. Collapsed, a child's status surfaces
 * when it outranks the coordinator's own, so an approval-waiting worker is
 * never hidden behind a quiet parent. Expanded, each row speaks for itself.
 */
export function resolveCoordinatorStatus(input: {
  readonly own: SidebarThreadStatus;
  readonly rollup: SidebarThreadStatus | null;
  readonly expanded: boolean;
}): SidebarThreadStatus {
  if (input.expanded || input.rollup === null) return input.own;
  return statusOutranks(input.rollup, input.own) ? input.rollup : input.own;
}
