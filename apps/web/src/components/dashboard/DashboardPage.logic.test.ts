import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduleId,
  ThreadId,
  TurnId,
  type SubscriptionQuotaReport,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import {
  partitionDashboardThreads,
  recentRunRows,
  summarizeQuotaReport,
  upcomingSchedules,
} from "./DashboardPage.logic";

const NOW = new Date("2026-09-06T15:00:00.000Z");
const ENV = EnvironmentId.make("env-local");

let threadCounter = 0;

function makeSession(
  threadId: ThreadId,
  overrides: Partial<EnvironmentThreadShell["session"] & object> = {},
): NonNullable<EnvironmentThreadShell["session"]> {
  return {
    threadId,
    status: "ready",
    providerName: null,
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-09-06T14:00:00.000Z",
    ...overrides,
  } as NonNullable<EnvironmentThreadShell["session"]>;
}

function makeRunningTurn(startedAt: string): NonNullable<EnvironmentThreadShell["latestTurn"]> {
  return {
    turnId: TurnId.make(`turn-${startedAt}`),
    state: "running",
    requestedAt: startedAt,
    startedAt,
    completedAt: null,
    assistantMessageId: null,
  };
}

function makeThread(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  threadCounter += 1;
  return {
    environmentId: ENV,
    id: ThreadId.make(`thread-${threadCounter}`),
    projectId: ProjectId.make("project-1"),
    title: `Thread ${threadCounter}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-06T14:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } as EnvironmentThreadShell;
}

describe("partitionDashboardThreads", () => {
  it("lists working and monitoring threads as running, newest start first", () => {
    const older = makeThread({
      session: makeSession(ThreadId.make("thread-older"), {
        status: "running",
        activeTurnId: TurnId.make("turn-1"),
        updatedAt: "2026-09-06T13:00:00.000Z",
      }),
      latestTurn: makeRunningTurn("2026-09-06T13:00:00.000Z"),
    });
    const newer = makeThread({
      backgroundLiveness: "monitoring",
      session: makeSession(ThreadId.make("thread-newer"), {
        updatedAt: "2026-09-06T14:30:00.000Z",
      }),
    });
    const idle = makeThread();

    const { running, attention } = partitionDashboardThreads([older, newer, idle], NOW);

    expect(running.map((row) => row.threadId)).toEqual([newer.id, older.id]);
    expect(attention).toEqual([]);
  });

  it("flags approvals, input, plan, and failures as needing attention", () => {
    const approval = makeThread({ hasPendingApprovals: true });
    const input = makeThread({ hasPendingUserInput: true });
    const plan = makeThread({ hasActionableProposedPlan: true });
    const failed = makeThread({
      session: makeSession(ThreadId.make("thread-failed"), { status: "error" }),
    });

    const { attention } = partitionDashboardThreads([approval, input, plan, failed], NOW);

    expect(attention.map((row) => row.attentionReason).sort()).toEqual([
      "approval",
      "failed",
      "input",
      "plan",
    ]);
  });

  it("hides archived threads and snoozed attention, but keeps snoozed work visible", () => {
    const archived = makeThread({
      hasPendingApprovals: true,
      archivedAt: "2026-09-05T00:00:00.000Z",
    });
    const snoozedApproval = makeThread({
      hasPendingApprovals: true,
      snoozedUntil: "2026-09-06T16:00:00.000Z",
    });
    const snoozedWorking = makeThread({
      snoozedUntil: "2026-09-06T16:00:00.000Z",
      session: makeSession(ThreadId.make("thread-snoozed-work"), {
        status: "running",
        activeTurnId: TurnId.make("turn-9"),
      }),
    });
    const expiredSnooze = makeThread({
      hasPendingUserInput: true,
      snoozedUntil: "2026-09-06T14:00:00.000Z",
    });

    const { running, attention } = partitionDashboardThreads(
      [archived, snoozedApproval, snoozedWorking, expiredSnooze],
      NOW,
    );

    expect(running.map((row) => row.threadId)).toEqual([snoozedWorking.id]);
    expect(attention.map((row) => row.threadId)).toEqual([expiredSnooze.id]);
  });
});

function makeQuotaReport(subjects: SubscriptionQuotaReport["subjects"]): SubscriptionQuotaReport {
  return {
    contractVersion: 1,
    environmentId: ENV,
    readAt: "2026-09-06T15:00:00.000Z",
    subjects,
    collectors: [],
  };
}

describe("summarizeQuotaReport", () => {
  it("keeps the tightest window per subject and skips unread windows", () => {
    const report = makeQuotaReport([
      {
        subjectId: "subject-1",
        provider: ProviderDriverKind.make("codex"),
        binding: { status: "exact", providerInstanceIds: [] },
        source: { collectorId: "codexbar", transport: "cli", reportedSource: null },
        status: "fresh",
        plan: "pro",
        accountLabel: "acct@example.com",
        observedAt: null,
        staleAt: null,
        windows: [
          { id: "w-week", label: "Weekly", usedPercent: 40, resetsAt: null, synthetic: false },
          {
            id: "w-day",
            label: "Daily",
            usedPercent: 82,
            resetsAt: "2026-09-07T00:00:00.000Z",
            synthetic: false,
          },
          { id: "w-unread", label: "Unknown", usedPercent: null, resetsAt: null, synthetic: true },
        ],
        credits: { remaining: 12.5, currency: "USD" },
        warning: null,
      },
    ]);

    const rows = summarizeQuotaReport(report, "Local");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      environmentLabel: "Local",
      provider: ProviderDriverKind.make("codex"),
      plan: "pro",
      worstWindowLabel: "Daily",
      worstWindowRemainingPercent: 18,
      worstWindowResetsAt: "2026-09-07T00:00:00.000Z",
      creditsRemaining: 12.5,
    });
  });

  it("reports null windows when nothing is readable", () => {
    const report = makeQuotaReport([
      {
        subjectId: "subject-2",
        provider: ProviderDriverKind.make("codex"),
        binding: { status: "unbound", providerInstanceIds: [] },
        source: { collectorId: "codexbar", transport: "cli", reportedSource: null },
        status: "unavailable",
        plan: null,
        accountLabel: null,
        observedAt: null,
        staleAt: null,
        windows: [],
        credits: null,
        warning: null,
      },
    ]);

    const rows = summarizeQuotaReport(report, "Local");

    expect(rows[0]).toMatchObject({
      worstWindowLabel: null,
      worstWindowRemainingPercent: null,
      creditsRemaining: null,
    });
  });
});

describe("upcomingSchedules", () => {
  const base = {
    environmentId: ENV,
    projectId: ProjectId.make("project-1"),
    timeZone: "UTC",
  };

  it("sorts by next run and skips disabled or exhausted schedules", () => {
    const later = {
      ...base,
      id: ScheduleId.make("s-later"),
      title: "Later",
      enabled: true,
      nextRunAt: "2026-09-08T09:00:00.000Z",
    };
    const sooner = {
      ...base,
      id: ScheduleId.make("s-sooner"),
      title: "Sooner",
      enabled: true,
      nextRunAt: "2026-09-07T09:00:00.000Z",
    };
    const disabled = {
      ...base,
      id: ScheduleId.make("s-off"),
      title: "Off",
      enabled: false,
      nextRunAt: "2026-09-06T09:00:00.000Z",
    };
    const exhausted = {
      ...base,
      id: ScheduleId.make("s-done"),
      title: "Done",
      enabled: true,
      nextRunAt: null,
    };

    const rows = upcomingSchedules([later, disabled, sooner, exhausted]);

    expect(rows.map((row) => row.title)).toEqual(["Sooner", "Later"]);
  });
});

describe("recentRunRows", () => {
  it("annotates runs with live schedule titles and tolerates deleted schedules", () => {
    const runs = [
      {
        environmentId: ENV,
        scheduleId: ScheduleId.make("s-1"),
        threadId: ThreadId.make("t-run-1"),
        firedAt: "2026-09-06T13:00:00.000Z",
      },
      {
        environmentId: ENV,
        scheduleId: ScheduleId.make("s-deleted"),
        threadId: ThreadId.make("t-run-2"),
        firedAt: "2026-09-06T12:00:00.000Z",
      },
    ];
    const schedules = [
      { environmentId: ENV, id: ScheduleId.make("s-1"), title: "Morning briefing" },
    ];

    const rows = recentRunRows(runs, schedules);

    expect(rows.map((row) => row.scheduleTitle)).toEqual(["Morning briefing", null]);
  });
});
