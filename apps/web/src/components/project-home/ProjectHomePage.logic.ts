/**
 * Pure derivations for the project home page: which threads belong to the
 * project group, what needs a human, the board as working columns, the
 * one-line status sentence, and the two-week activity strip. Kept free of
 * React and atoms so the rules stay unit-testable.
 *
 * @module components/project-home/ProjectHomePage.logic
 */
import type {
  EnvironmentId,
  KanbanCard,
  KanbanStatus,
  ProjectId,
  Schedule,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import {
  partitionDashboardThreads,
  upcomingSchedules,
  type DashboardThreadRow,
} from "../dashboard/DashboardPage.logic";
import { parseTimestampMs, resolveSidebarThreadStatus } from "../Sidebar.logic";

export const PROJECT_HOME_RUNNING_LIMIT = 4;
export const PROJECT_HOME_ATTENTION_LIMIT = 6;
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

export interface ProjectActivity {
  readonly running: readonly DashboardThreadRow[];
  readonly attention: readonly DashboardThreadRow[];
}

/**
 * The dashboard's fleet partition, scoped to one project group and capped
 * tighter: a project home answers "what here needs me", not "list everything".
 */
export function partitionProjectActivity(
  threads: readonly EnvironmentThreadShell[],
  keys: ReadonlySet<string>,
  now: Date,
): ProjectActivity {
  const owned = threads.filter((thread) => ownsThread(keys, thread));
  const { running, attention } = partitionDashboardThreads(owned, now);
  return {
    running: running.slice(0, PROJECT_HOME_RUNNING_LIMIT),
    attention: attention.slice(0, PROJECT_HOME_ATTENTION_LIMIT),
  };
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
 * The one-line answer to "what's going on here": what's waiting on the human,
 * what's working, what's workable. Returns null when nothing is in flight so
 * the header can fall back to a calmer line.
 */
export function statusLine(input: {
  readonly attention: number;
  readonly running: number;
  readonly ready: number;
  readonly inProgress: number;
}): string | null {
  const parts: string[] = [];
  if (input.attention > 0) {
    parts.push(`${input.attention} waiting on you`);
  }
  if (input.running > 0) {
    parts.push(`${input.running} ${input.running === 1 ? "agent" : "agents"} working`);
  }
  const workable = input.ready + input.inProgress;
  if (workable > 0) {
    parts.push(`${workable} ${workable === 1 ? "task" : "tasks"} in play`);
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
    .filter((thread) => thread.botProfile != null && thread.archivedAt === null && ownsThread(keys, thread))
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
