/**
 * Pure derivations for the dashboard page: which threads are running, which
 * need attention, how quota reports collapse into rows, and which schedules
 * fire next. Kept free of React and atoms so the rules stay unit-testable.
 *
 * @module components/dashboard/DashboardPage.logic
 */
import {
  subscriptionQuotaRemainingPercent,
  type EnvironmentId,
  type ProjectId,
  type Schedule,
  type SubscriptionQuotaReport,
  type ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import {
  parseTimestampMs,
  resolveSidebarThreadStatus,
  resolveWorkingStartedAt,
  type SidebarThreadStatus,
} from "../Sidebar.logic";

export const DASHBOARD_RUNNING_LIMIT = 6;
export const DASHBOARD_ATTENTION_LIMIT = 6;
export const DASHBOARD_SCHEDULE_LIMIT = 5;
export const DASHBOARD_RUN_LIMIT = 5;

export interface DashboardThreadRow {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly status: SidebarThreadStatus;
  /** Why an attention row is listed; null for running rows. */
  readonly attentionReason: "approval" | "input" | "plan" | "failed" | null;
  /** Turn start for running rows; recency anchor for attention rows. */
  readonly sortAt: string;
}

function isSnoozed(thread: EnvironmentThreadShell, nowMs: number): boolean {
  if (thread.snoozedUntil == null) return false;
  const until = Date.parse(thread.snoozedUntil);
  return !Number.isNaN(until) && until > nowMs;
}

function attentionReason(
  thread: EnvironmentThreadShell,
  status: SidebarThreadStatus,
): DashboardThreadRow["attentionReason"] {
  if (status === "approval") return "approval";
  if (status === "input") return "input";
  if (status === "failed") return "failed";
  if (thread.hasActionableProposedPlan) return "plan";
  return null;
}

export interface DashboardThreads {
  readonly running: readonly DashboardThreadRow[];
  readonly attention: readonly DashboardThreadRow[];
}

/**
 * Buckets visible threads for the two fleet cards. Archived threads never
 * appear. Snoozed threads still count as running (snooze mutes badging, not
 * the fact of work) but never appear as needing attention — that is the
 * snooze promise.
 */
export function partitionDashboardThreads(
  threads: readonly EnvironmentThreadShell[],
  now: Date,
): DashboardThreads {
  const nowMs = now.getTime();
  const running: DashboardThreadRow[] = [];
  const attention: DashboardThreadRow[] = [];
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const status = resolveSidebarThreadStatus(thread);
    if (status === "working" || status === "monitoring") {
      running.push({
        environmentId: thread.environmentId,
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        status,
        attentionReason: null,
        sortAt: resolveWorkingStartedAt(thread) ?? thread.updatedAt,
      });
      continue;
    }
    if (isSnoozed(thread, nowMs)) continue;
    const reason = attentionReason(thread, status);
    if (reason === null) continue;
    attention.push({
      environmentId: thread.environmentId,
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      status,
      attentionReason: reason,
      sortAt: thread.updatedAt,
    });
  }
  running.sort((a, b) => parseTimestampMs(b.sortAt) - parseTimestampMs(a.sortAt));
  attention.sort((a, b) => parseTimestampMs(b.sortAt) - parseTimestampMs(a.sortAt));
  return {
    running: running.slice(0, DASHBOARD_RUNNING_LIMIT),
    attention: attention.slice(0, DASHBOARD_ATTENTION_LIMIT),
  };
}

export interface DashboardQuotaRow {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly subjectId: string;
  readonly provider: string;
  readonly plan: string | null;
  readonly accountLabel: string | null;
  readonly status: "fresh" | "stale" | "unavailable" | "failed";
  /** Lowest remaining allowance across the subject's windows. */
  readonly worstWindowLabel: string | null;
  readonly worstWindowRemainingPercent: number | null;
  readonly worstWindowResetsAt: string | null;
  readonly creditsRemaining: number | null;
}

/**
 * Collapses one environment's quota report into card rows, one per subject,
 * keeping only the tightest window — the dashboard answers "how close am I
 * to the wall", not "list every window".
 */
export function summarizeQuotaReport(
  report: SubscriptionQuotaReport,
  environmentLabel: string,
): readonly DashboardQuotaRow[] {
  return report.subjects.map((subject) => {
    let worst: {
      readonly label: string;
      readonly remainingPercent: number;
      readonly resetsAt: string | null;
    } | null = null;
    for (const window of subject.windows) {
      const remainingPercent = subscriptionQuotaRemainingPercent(window.usedPercent);
      if (remainingPercent === null) continue;
      if (worst === null || remainingPercent < worst.remainingPercent) {
        worst = { label: window.label, remainingPercent, resetsAt: window.resetsAt };
      }
    }
    return {
      environmentId: report.environmentId,
      environmentLabel,
      subjectId: subject.subjectId,
      provider: subject.provider,
      plan: subject.plan,
      accountLabel: subject.accountLabel,
      status: subject.status,
      worstWindowLabel: worst?.label ?? null,
      worstWindowRemainingPercent: worst?.remainingPercent ?? null,
      worstWindowResetsAt: worst?.resetsAt ?? null,
      creditsRemaining: subject.credits?.remaining ?? null,
    };
  });
}

export interface DashboardScheduleRow {
  readonly environmentId: EnvironmentId;
  readonly scheduleId: Schedule["id"];
  readonly projectId: ProjectId;
  readonly title: string;
  readonly nextRunAt: string;
  readonly timeZone: string;
}

/** Enabled schedules with a future run, soonest first. */
export function upcomingSchedules<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly id: Schedule["id"];
    readonly projectId: ProjectId;
    readonly title: string;
    readonly enabled: boolean;
    readonly nextRunAt: string | null;
    readonly timeZone: string;
  },
>(schedules: readonly T[], limit = DASHBOARD_SCHEDULE_LIMIT): readonly DashboardScheduleRow[] {
  return schedules
    .flatMap((schedule) => {
      if (!schedule.enabled || schedule.nextRunAt === null) return [];
      return [
        {
          environmentId: schedule.environmentId,
          scheduleId: schedule.id,
          projectId: schedule.projectId,
          title: schedule.title,
          nextRunAt: schedule.nextRunAt,
          timeZone: schedule.timeZone,
        },
      ];
    })
    .sort((a, b) => parseTimestampMs(a.nextRunAt) - parseTimestampMs(b.nextRunAt))
    .slice(0, limit);
}

export interface DashboardRunRow {
  readonly environmentId: EnvironmentId;
  readonly scheduleId: Schedule["id"];
  readonly threadId: ThreadId;
  readonly firedAt: string;
  readonly scheduleTitle: string | null;
}

/**
 * Most recent runs first, annotated with the schedule title when the schedule
 * still exists (a deleted schedule's runs keep their thread link but lose the
 * title).
 */
export function recentRunRows<
  TRun extends {
    readonly environmentId: EnvironmentId;
    readonly scheduleId: Schedule["id"];
    readonly threadId: ThreadId;
    readonly firedAt: string;
  },
>(
  runs: readonly TRun[],
  schedules: readonly {
    readonly environmentId: EnvironmentId;
    readonly id: Schedule["id"];
    readonly title: string;
  }[],
  limit = DASHBOARD_RUN_LIMIT,
): readonly DashboardRunRow[] {
  const titles = new Map(
    schedules.map((schedule) => [`${schedule.environmentId}:${schedule.id}`, schedule.title]),
  );
  return runs.slice(0, limit).map((run) => ({
    environmentId: run.environmentId,
    scheduleId: run.scheduleId,
    threadId: run.threadId,
    firedAt: run.firedAt,
    scheduleTitle: titles.get(`${run.environmentId}:${run.scheduleId}`) ?? null,
  }));
}
