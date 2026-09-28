/**
 * Pure derivations for the project home page: which threads belong to the
 * project group, the coordinator rows, the checklist grouped by who has to
 * move next, the board as working columns, the one-line status sentence, and
 * the two-week activity strip. Kept free of React and atoms so the rules stay
 * unit-testable.
 *
 * @module components/project-home/ProjectHomePage.logic
 */
import type {
  EnvironmentId,
  KanbanCard,
  KanbanCardId,
  KanbanStatus,
  ProjectEntry,
  ProjectId,
  Schedule,
  ThreadId,
} from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  groupWorkersByCoordinator,
  resolveCoordinatorStatus,
  workerSummary,
  type SidebarThreadStatus,
} from "@t3tools/client-runtime/state/thread-nesting";

import { upcomingSchedules } from "../dashboard/DashboardPage.logic";
import {
  firstValidTimestampMs,
  parseTimestampMs,
  resolveSidebarThreadStatus,
  resolveThreadStatusPill,
  resolveWorkingStartedAt,
} from "../Sidebar.logic";

export const PROJECT_HOME_COORDINATOR_LIMIT = 6;
export const PROJECT_HOME_CHECKLIST_GROUP_LIMIT = 6;
export const PROJECT_HOME_RECENT_LIMIT = 6;
export const PROJECT_HOME_SCHEDULE_LIMIT = 3;
export const PROJECT_HOME_COLUMN_CARD_LIMIT = 6;
export const PROJECT_HOME_ACTIVITY_DAYS = 14;

/** Minimal shape of a project-group member, as exposed by sidebar snapshots. */
export interface ProjectHomeMember {
  readonly environmentId: string;
  readonly id: string;
}

export function projectMemberKeys(members: readonly ProjectHomeMember[]): ReadonlySet<string> {
  return new Set(members.map((member) => `${member.environmentId}:${member.id}`));
}

function ownsThread(keys: ReadonlySet<string>, thread: EnvironmentThreadShell): boolean {
  return keys.has(`${thread.environmentId}:${thread.projectId}`);
}

/** A thread shell plus the client-side visit time the sidebar uses for unread completion. */
export type ProjectHomeThread = EnvironmentThreadShell & {
  readonly lastVisitedAt?: string | undefined;
};

function threadKey(thread: Pick<EnvironmentThreadShell, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

/**
 * The project group's threads, each with its last visit from the UI state
 * store (keyed like the sidebar), so completion reads as unseen exactly when
 * the sidebar says so.
 */
export function projectHomeThreads(
  threads: readonly EnvironmentThreadShell[],
  keys: ReadonlySet<string>,
  lastVisitedAtById: Readonly<Record<string, string>>,
): readonly ProjectHomeThread[] {
  const owned: ProjectHomeThread[] = [];
  for (const thread of threads) {
    if (!ownsThread(keys, thread)) continue;
    owned.push({ ...thread, lastVisitedAt: lastVisitedAtById[threadKey(thread)] });
  }
  return owned;
}

function isSnoozed(thread: EnvironmentThreadShell, nowMs: number): boolean {
  if (thread.snoozedUntil == null) return false;
  const until = Date.parse(thread.snoozedUntil);
  return !Number.isNaN(until) && until > nowMs;
}

/** Live means on the active list: not archived, settled, or snoozed. */
function isLive(thread: EnvironmentThreadShell, nowMs: number): boolean {
  return (
    thread.archivedAt === null && thread.settledOverride !== "settled" && !isSnoozed(thread, nowMs)
  );
}

export type ChecklistGroupId = "waiting" | "inProgress" | "ready";

export interface ThreadChecklistState {
  readonly group: ChecklistGroupId;
  /** Short label, e.g. "Pending approval", "Working", "Completed". */
  readonly label: string;
  /** Color family for the row's dot, shared with the sidebar's status model. */
  readonly tone: SidebarThreadStatus;
}

/**
 * Where a thread sits on the checklist, from the sidebar's own status pill so
 * the two surfaces never disagree. Failed comes from the sidebar status model
 * (the pill has no failed state) and ranks with the other attention states.
 * Threads with nothing to report (idle, already seen) return null.
 */
export function resolveThreadChecklistState(
  thread: ProjectHomeThread,
): ThreadChecklistState | null {
  const pill = resolveThreadStatusPill({ thread });
  if (pill?.label === "Pending Approval") {
    return { group: "waiting", label: "Pending approval", tone: "approval" };
  }
  if (pill?.label === "Awaiting Input") {
    return { group: "waiting", label: "Awaiting input", tone: "input" };
  }
  if (resolveSidebarThreadStatus(thread) === "failed") {
    return { group: "waiting", label: "Failed", tone: "failed" };
  }
  switch (pill?.label) {
    case "Plan Ready":
      return { group: "waiting", label: "Plan ready", tone: "input" };
    case "Working":
    case "Connecting":
      return { group: "inProgress", label: pill.label, tone: "working" };
    case "Monitoring":
      return { group: "inProgress", label: "Monitoring", tone: "monitoring" };
    case "Completed":
      return { group: "ready", label: "Completed", tone: "ready" };
    default:
      return null;
  }
}

/** The running plan step, when the provider reports one. */
function planStepLabel(thread: EnvironmentThreadShell): string | null {
  const progress = thread.planProgress;
  if (progress == null) return null;
  if (progress.totalSteps === 0) return progress.step;
  const current = Math.min(progress.completedSteps + 1, progress.totalSteps);
  return `${progress.step} (${current}/${progress.totalSteps})`;
}

/** What a thread is doing now in a few words, the plan step when it has one. */
function threadStatusText(thread: ProjectHomeThread): string {
  const state = resolveThreadChecklistState(thread);
  if (state?.group === "inProgress") return planStepLabel(thread) ?? state.label;
  return state?.label ?? "Idle";
}

export interface CoordinatorRow {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  /** "Working · 3 workers · 1 needs you": own status first, then the workers. */
  readonly prose: string;
  /** Dot color. A worker that outranks the coordinator surfaces here. */
  readonly tone: SidebarThreadStatus;
  /** Latest update across the coordinator and its workers. */
  readonly activityAt: string;
}

export interface CoordinatorSection {
  readonly rows: readonly CoordinatorRow[];
  readonly overflow: number;
}

function latestTimestamp(first: string, rest: readonly string[]): string {
  let latest = first;
  let latestMs = firstValidTimestampMs(first);
  for (const value of rest) {
    const ms = firstValidTimestampMs(value);
    if (ms > latestMs) {
      latest = value;
      latestMs = ms;
    }
  }
  return latest;
}

function coordinatorProse(
  thread: ProjectHomeThread,
  workers: readonly EnvironmentThreadShell[],
): string {
  const summary = workerSummary(workers);
  const parts = [
    threadStatusText(thread),
    `${summary.total} ${summary.total === 1 ? "worker" : "workers"}`,
  ];
  if (summary.needsYou > 0) {
    parts.push(`${summary.needsYou} ${summary.needsYou === 1 ? "needs" : "need"} you`);
  }
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  return parts.join(" · ");
}

/**
 * Live threads with live mesh workers nested under them, by the sidebar's
 * nesting rule, most recent activity across the group first. Empty when the
 * project has no coordinators; Recent threads covers the rest.
 */
export function buildCoordinatorSection(
  threads: readonly ProjectHomeThread[],
  now: Date,
  limit = PROJECT_HOME_COORDINATOR_LIMIT,
): CoordinatorSection {
  const nowMs = now.getTime();
  const live = threads.filter((thread) => isLive(thread, nowMs));
  const { childrenByCoordinator } = groupWorkersByCoordinator({ pinned: [], active: live });
  const rows: CoordinatorRow[] = [];
  for (const thread of live) {
    const key = threadKey(thread);
    const workers = childrenByCoordinator.get(key);
    if (workers === undefined) continue;
    const own = resolveThreadChecklistState(thread)?.tone ?? resolveSidebarThreadStatus(thread);
    rows.push({
      key,
      environmentId: thread.environmentId,
      threadId: thread.id,
      title: thread.title,
      prose: coordinatorProse(thread, workers),
      tone: resolveCoordinatorStatus({
        own,
        rollup: workerSummary(workers).rollupStatus,
        expanded: false,
      }),
      activityAt: latestTimestamp(
        thread.updatedAt,
        workers.map((worker) => worker.updatedAt),
      ),
    });
  }
  rows.sort((a, b) => firstValidTimestampMs(b.activityAt) - firstValidTimestampMs(a.activityAt));
  return { rows: rows.slice(0, limit), overflow: Math.max(0, rows.length - limit) };
}

export type ChecklistItem =
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly title: string;
      readonly status: string;
      readonly tone: SidebarThreadStatus;
      readonly sortAt: string;
    }
  | {
      readonly kind: "card";
      readonly key: string;
      readonly cardId: KanbanCardId;
      readonly title: string;
      readonly status: string;
      readonly sortAt: string;
    };

export interface ChecklistGroup {
  readonly id: ChecklistGroupId;
  readonly items: readonly ChecklistItem[];
  /** Items past the cap, summarized as "+N more". */
  readonly overflow: number;
}

export interface ProjectChecklist {
  readonly waiting: ChecklistGroup;
  readonly inProgress: ChecklistGroup;
  readonly ready: ChecklistGroup;
  readonly total: number;
  /** Uncapped counts for the header's status line. */
  readonly counts: {
    readonly waiting: number;
    /** Threads working, connecting, or monitoring. */
    readonly runningThreads: number;
    /** Kanban cards in progress, ready, or in review. */
    readonly openCards: number;
  };
}

const CARD_CHECKLIST: Partial<
  Record<KanbanCard["status"], { readonly group: ChecklistGroupId; readonly status: string }>
> = {
  inProgress: { group: "inProgress", status: "In progress" },
  ready: { group: "ready", status: "Ready to start" },
  review: { group: "ready", status: "In review" },
};

/**
 * Everything in the project that is waiting on the user, moving, or ready
 * for them, newest first within each group:
 *
 * - Waiting on you: pending approval, awaiting input, plan ready, failed.
 * - In progress: working or monitoring threads, and in-progress Kanban cards.
 * - Ready: completed threads not opened since, and Kanban cards in Ready or
 *   Review.
 *
 * Pass threads already scoped with `projectHomeThreads`. Archived threads
 * never appear. Snoozed and settled threads stay off the waiting and ready
 * groups (snooze mutes attention, settle means done) but still show as in
 * progress while they work.
 */
export function buildProjectChecklist(input: {
  readonly threads: readonly ProjectHomeThread[];
  readonly cards: readonly KanbanCard[];
  readonly now: Date;
  readonly limit?: number;
}): ProjectChecklist {
  const nowMs = input.now.getTime();
  const limit = input.limit ?? PROJECT_HOME_CHECKLIST_GROUP_LIMIT;
  const buckets: Record<ChecklistGroupId, ChecklistItem[]> = {
    waiting: [],
    inProgress: [],
    ready: [],
  };
  let runningThreads = 0;
  let openCards = 0;
  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    const state = resolveThreadChecklistState(thread);
    if (state === null) continue;
    const inProgress = state.group === "inProgress";
    if (!inProgress && !isLive(thread, nowMs)) continue;
    if (inProgress) runningThreads += 1;
    buckets[state.group].push({
      kind: "thread",
      key: `thread:${threadKey(thread)}`,
      environmentId: thread.environmentId,
      threadId: thread.id,
      title: thread.title,
      status: inProgress ? threadStatusText(thread) : state.label,
      tone: state.tone,
      sortAt: inProgress ? (resolveWorkingStartedAt(thread) ?? thread.updatedAt) : thread.updatedAt,
    });
  }
  for (const card of input.cards) {
    if (card.deletedAt !== null) continue;
    const placement = CARD_CHECKLIST[card.status];
    if (placement === undefined) continue;
    openCards += 1;
    buckets[placement.group].push({
      kind: "card",
      key: `card:${card.id}`,
      cardId: card.id,
      title: card.title,
      status: placement.status,
      sortAt: card.updatedAt,
    });
  }
  const group = (id: ChecklistGroupId): ChecklistGroup => {
    const items = buckets[id].toSorted(
      (a, b) => firstValidTimestampMs(b.sortAt) - firstValidTimestampMs(a.sortAt),
    );
    return { id, items: items.slice(0, limit), overflow: Math.max(0, items.length - limit) };
  };
  return {
    waiting: group("waiting"),
    inProgress: group("inProgress"),
    ready: group("ready"),
    total: buckets.waiting.length + buckets.inProgress.length + buckets.ready.length,
    counts: { waiting: buckets.waiting.length, runningThreads, openCards },
  };
}

/** The agent-instructions file the page links to, relative to the workspace root. */
export const PROJECT_INSTRUCTIONS_FILE = "AGENTS.md";

/** True when the workspace root holds the agent-instructions file. */
export function hasProjectInstructionsFile(entries: readonly ProjectEntry[]): boolean {
  return entries.some((entry) => entry.kind === "file" && entry.path === PROJECT_INSTRUCTIONS_FILE);
}

/** Most recently touched live threads first — the resume list. */
export function recentProjectThreads(
  threads: readonly EnvironmentThreadShell[],
  keys: ReadonlySet<string>,
  limit = PROJECT_HOME_RECENT_LIMIT,
): readonly EnvironmentThreadShell[] {
  return threads
    .filter((thread) => thread.archivedAt === null && ownsThread(keys, thread))
    .toSorted((a, b) => parseTimestampMs(b.updatedAt) - parseTimestampMs(a.updatedAt))
    .slice(0, limit);
}

export const BOARD_STATUSES = [
  "backlog",
  "ready",
  "inProgress",
  "review",
  "done",
] as const satisfies readonly KanbanStatus[];

export interface BoardColumnView {
  readonly status: KanbanStatus;
  /** Board order, capped for the home page. */
  readonly cards: readonly KanbanCard[];
  /** Cards beyond the cap, summarized as a "+N more" affordance. */
  readonly overflow: number;
}

export interface BoardView {
  readonly total: number;
  readonly counts: Readonly<Record<KanbanStatus, number>>;
  readonly columns: readonly BoardColumnView[];
}

export function boardColumns(cards: readonly KanbanCard[]): BoardView {
  const counts: Record<KanbanStatus, number> = {
    backlog: 0,
    ready: 0,
    inProgress: 0,
    review: 0,
    done: 0,
  };
  for (const card of cards) {
    counts[card.status] += 1;
  }
  const columns = BOARD_STATUSES.map((status): BoardColumnView => {
    const columnCards = cards
      .filter((card) => card.status === status)
      .sort((left, right) => left.orderKey.localeCompare(right.orderKey));
    return {
      status,
      cards: columnCards.slice(0, PROJECT_HOME_COLUMN_CARD_LIMIT),
      overflow: Math.max(0, columnCards.length - PROJECT_HOME_COLUMN_CARD_LIMIT),
    };
  });
  return { total: cards.length, counts, columns };
}

/**
 * The one-line answer to "what's going on here", from the checklist: what's
 * waiting on the human, what's working, what's workable. Returns null when
 * nothing is in flight so the header can fall back to a calmer line.
 */
export function statusLine(counts: ProjectChecklist["counts"]): string | null {
  const parts: string[] = [];
  if (counts.waiting > 0) {
    parts.push(`${counts.waiting} waiting on you`);
  }
  if (counts.runningThreads > 0) {
    parts.push(
      `${counts.runningThreads} ${counts.runningThreads === 1 ? "agent" : "agents"} working`,
    );
  }
  if (counts.openCards > 0) {
    parts.push(`${counts.openCards} ${counts.openCards === 1 ? "task" : "tasks"} in play`);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

export interface ActivityDay {
  /** Local calendar day, yyyy-mm-dd. */
  readonly day: string;
  readonly count: number;
}

function localDayKey(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Threads touched per local day, oldest to newest, ending today. A thread
 * counts once per day no matter how often it moved. Zero-count days stay in
 * the series so the strip reads as a timeline, not a histogram.
 */
export function activityByDay(
  threads: readonly EnvironmentThreadShell[],
  keys: ReadonlySet<string>,
  now: Date,
  days = PROJECT_HOME_ACTIVITY_DAYS,
): readonly ActivityDay[] {
  const counts = new Map<string, number>();
  for (const thread of threads) {
    if (thread.archivedAt !== null || !ownsThread(keys, thread)) continue;
    const ms = parseTimestampMs(thread.updatedAt);
    if (Number.isNaN(ms)) continue;
    const key = localDayKey(new Date(ms));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const series: ActivityDay[] = [];
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  cursor.setDate(cursor.getDate() - (days - 1));
  for (let index = 0; index < days; index += 1) {
    const key = localDayKey(cursor);
    series.push({ day: key, count: counts.get(key) ?? 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return series;
}

export type BotState = "working" | "monitoring" | "waiting" | "failed" | "idle";

export interface BotRosterEntry {
  readonly environmentId: EnvironmentId;
  readonly threadId: EnvironmentThreadShell["id"];
  readonly displayName: string;
  readonly description: string | null;
  readonly state: BotState;
  /** Assigned board cards not yet done. */
  readonly openTasks: number;
}

const BOT_STATE_RANK: Record<BotState, number> = {
  waiting: 0,
  working: 1,
  monitoring: 2,
  failed: 3,
  idle: 4,
};

/**
 * The project's bot team: live bot threads with what each is doing right now
 * and how much of the board is on their plate. Bots that need a human
 * decision or are actively working sort first.
 */
export function botRoster(
  threads: readonly EnvironmentThreadShell[],
  cards: readonly KanbanCard[],
  keys: ReadonlySet<string>,
): readonly BotRosterEntry[] {
  const openByAssignee = new Map<string, number>();
  for (const card of cards) {
    if (card.assigneeThreadId === null || card.status === "done" || card.deletedAt !== null) {
      continue;
    }
    openByAssignee.set(card.assigneeThreadId, (openByAssignee.get(card.assigneeThreadId) ?? 0) + 1);
  }
  return threads
    .filter(
      (thread) =>
        thread.botProfile != null && thread.archivedAt === null && ownsThread(keys, thread),
    )
    .map((thread): BotRosterEntry => {
      const status = resolveSidebarThreadStatus(thread);
      const state: BotState =
        status === "approval" || status === "input"
          ? "waiting"
          : status === "working"
            ? "working"
            : status === "monitoring"
              ? "monitoring"
              : status === "failed"
                ? "failed"
                : "idle";
      return {
        environmentId: thread.environmentId,
        threadId: thread.id,
        displayName: thread.botProfile?.displayName ?? thread.title,
        description: thread.botProfile?.description ?? null,
        state,
        openTasks: openByAssignee.get(thread.id) ?? 0,
      };
    })
    .sort(
      (left, right) =>
        BOT_STATE_RANK[left.state] - BOT_STATE_RANK[right.state] ||
        left.displayName.localeCompare(right.displayName),
    );
}

/** Enabled schedules belonging to the project group with a future run, soonest first. */
export function upcomingProjectSchedules<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly id: Schedule["id"];
    readonly projectId: ProjectId;
    readonly title: string;
    readonly enabled: boolean;
    readonly nextRunAt: string | null;
    readonly timeZone: string;
  },
>(schedules: readonly T[], keys: ReadonlySet<string>, limit = PROJECT_HOME_SCHEDULE_LIMIT) {
  return upcomingSchedules(
    schedules.filter((schedule) => keys.has(`${schedule.environmentId}:${schedule.projectId}`)),
    limit,
  );
}
