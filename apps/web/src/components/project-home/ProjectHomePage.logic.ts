/**
 * Pure derivations for the project home page: which threads belong to the
 * project group, what needs a human, what the board looks like at a glance,
 * and which schedules fire next. Kept free of React and atoms so the rules
 * stay unit-testable.
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
import { parseTimestampMs } from "../Sidebar.logic";

export const PROJECT_HOME_RUNNING_LIMIT = 4;
export const PROJECT_HOME_ATTENTION_LIMIT = 6;
export const PROJECT_HOME_RECENT_LIMIT = 6;
export const PROJECT_HOME_SCHEDULE_LIMIT = 3;
export const PROJECT_HOME_BOARD_SPOTLIGHT_LIMIT = 4;

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

export interface BoardGlance {
  readonly total: number;
  readonly counts: Readonly<Record<KanbanStatus, number>>;
  /** Cards worth acting on: in progress first, then ready, board order kept. */
  readonly spotlight: readonly KanbanCard[];
}

export function summarizeProjectBoard(cards: readonly KanbanCard[]): BoardGlance {
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
  const byOrder = (left: KanbanCard, right: KanbanCard) =>
    left.orderKey.localeCompare(right.orderKey);
  const spotlight = [
    ...cards.filter((card) => card.status === "inProgress").sort(byOrder),
    ...cards.filter((card) => card.status === "ready").sort(byOrder),
  ].slice(0, PROJECT_HOME_BOARD_SPOTLIGHT_LIMIT);
  return { total: cards.length, counts, spotlight };
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
