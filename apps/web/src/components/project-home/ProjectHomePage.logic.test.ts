import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  KanbanCardId,
  ProjectId,
  ProviderInstanceId,
  ScheduleId,
  ThreadId,
  TurnId,
  type KanbanCard,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import {
  activityByDay,
  boardColumns,
  botRoster,
  partitionProjectActivity,
  projectMemberKeys,
  recentProjectThreads,
  statusLine,
  upcomingProjectSchedules,
} from "./ProjectHomePage.logic";

const NOW = new Date("2026-09-06T15:00:00.000Z");
const ENV = EnvironmentId.make("env-local");
const PROJECT = ProjectId.make("project-1");
const KEYS = projectMemberKeys([{ environmentId: ENV, id: PROJECT }]);

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
    projectId: PROJECT,
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

function makeCard(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: KanbanCardId.make(`card-${Math.random().toString(36).slice(2)}`),
    projectId: PROJECT,
    title: "Card",
    description: "",
    status: "backlog",
    orderKey: "a0",
    assigneeThreadId: null,
    delegationId: null,
    revision: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  } as KanbanCard;
}

describe("partitionProjectActivity", () => {
  it("scopes running and attention rows to the project group", () => {
    const running = makeThread({
      session: makeSession(ThreadId.make("thread-running"), {
        status: "running",
        activeTurnId: TurnId.make("turn-running"),
        updatedAt: "2026-09-06T14:30:00.000Z",
      }),
      latestTurn: makeRunningTurn("2026-09-06T14:30:00.000Z"),
    });
    const approval = makeThread({ hasPendingApprovals: true });
    const otherProject = makeThread({
      projectId: ProjectId.make("project-elsewhere"),
      hasPendingApprovals: true,
    });
    const { running: runningRows, attention } = partitionProjectActivity(
      [running, approval, otherProject],
      KEYS,
      NOW,
    );
    expect(runningRows.map((row) => row.threadId)).toEqual([running.id]);
    expect(attention.map((row) => row.threadId)).toEqual([approval.id]);
  });

  it("never lists archived threads", () => {
    const archived = makeThread({
      hasPendingApprovals: true,
      archivedAt: "2026-09-05T00:00:00.000Z",
    });
    const { attention } = partitionProjectActivity([archived], KEYS, NOW);
    expect(attention).toEqual([]);
  });
});

describe("recentProjectThreads", () => {
  it("orders by recency and skips archived and foreign threads", () => {
    const oldest = makeThread({ updatedAt: "2026-09-01T10:00:00.000Z" });
    const newest = makeThread({ updatedAt: "2026-09-06T12:00:00.000Z" });
    const archived = makeThread({
      updatedAt: "2026-09-06T13:00:00.000Z",
      archivedAt: "2026-09-06T13:30:00.000Z",
    });
    const foreign = makeThread({
      projectId: ProjectId.make("project-elsewhere"),
      updatedAt: "2026-09-06T14:00:00.000Z",
    });
    const recent = recentProjectThreads([oldest, newest, archived, foreign], KEYS);
    expect(recent.map((thread) => thread.id)).toEqual([newest.id, oldest.id]);
  });

  it("caps the resume list", () => {
    const threads = Array.from({ length: 10 }, (_, index) =>
      makeThread({ updatedAt: `2026-09-0${(index % 9) + 1}T10:00:00.000Z` }),
    );
    expect(recentProjectThreads(threads, KEYS)).toHaveLength(6);
  });
});

describe("boardColumns", () => {
  it("groups cards into columns in board order", () => {
    const cards = [
      makeCard({ title: "done-1", status: "done", orderKey: "a1" }),
      makeCard({ title: "ready-late", status: "ready", orderKey: "b2" }),
      makeCard({ title: "wip", status: "inProgress", orderKey: "c1" }),
      makeCard({ title: "ready-early", status: "ready", orderKey: "b1" }),
      makeCard({ title: "backlog-1", status: "backlog", orderKey: "d1" }),
    ];
    const board = boardColumns(cards);
    expect(board.total).toBe(5);
    expect(board.counts).toEqual({ backlog: 1, ready: 2, inProgress: 1, review: 0, done: 1 });
    const ready = board.columns.find((column) => column.status === "ready");
    expect(ready?.cards.map((card) => card.title)).toEqual(["ready-early", "ready-late"]);
    expect(ready?.overflow).toBe(0);
  });

  it("caps long columns and reports the overflow", () => {
    const cards = Array.from({ length: 9 }, (_, index) =>
      makeCard({ title: `card-${index}`, status: "backlog", orderKey: `a${index}` }),
    );
    const backlog = boardColumns(cards).columns.find((column) => column.status === "backlog");
    expect(backlog?.cards).toHaveLength(6);
    expect(backlog?.overflow).toBe(3);
  });

  it("handles an empty board", () => {
    const board = boardColumns([]);
    expect(board.total).toBe(0);
    expect(board.columns).toHaveLength(5);
    expect(board.counts.backlog).toBe(0);
  });
});

describe("statusLine", () => {
  it("joins the in-flight signals with separators", () => {
    expect(statusLine({ attention: 2, running: 1, ready: 2, inProgress: 1 })).toBe(
      "2 waiting on you · 1 agent working · 3 tasks in play",
    );
  });

  it("returns null when nothing is in flight", () => {
    expect(statusLine({ attention: 0, running: 0, ready: 0, inProgress: 0 })).toBeNull();
  });

  it("omits quiet signals instead of padding with zeros", () => {
    expect(statusLine({ attention: 0, running: 0, ready: 1, inProgress: 0 })).toBe(
      "1 task in play",
    );
  });
});

describe("activityByDay", () => {
  it("buckets threads by local day, oldest first, keeping zero days", () => {
    const today = makeThread({ updatedAt: "2026-09-06T09:00:00.000Z" });
    const alsoToday = makeThread({ updatedAt: "2026-09-06T21:30:00.000Z" });
    const older = makeThread({ updatedAt: "2026-09-01T12:00:00.000Z" });
    const foreign = makeThread({
      projectId: ProjectId.make("project-elsewhere"),
      updatedAt: "2026-09-06T10:00:00.000Z",
    });
    const series = activityByDay([today, alsoToday, older, foreign], KEYS, NOW, 14);
    expect(series).toHaveLength(14);
    const byDay = new Map(series.map((entry) => [entry.day, entry.count]));
    // Anchor on the actual timestamps so the expectation holds in any test TZ.
    const dayOf = (iso: string) => {
      const date = new Date(iso);
      return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
    };
    expect(byDay.get(dayOf(today.updatedAt))).toBe(2);
    expect(byDay.get(dayOf(older.updatedAt))).toBe(1);
    expect(series[series.length - 1]?.day).toBe(dayOf(NOW.toISOString()));
  });
});

describe("botRoster", () => {
  function makeBot(
    name: string,
    overrides: Partial<EnvironmentThreadShell> = {},
  ): EnvironmentThreadShell {
    return makeThread({
      botProfile: {
        displayName: name,
        description: null,
        revision: 1,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
      ...overrides,
    } as Partial<EnvironmentThreadShell>);
  }

  it("lists project bots with live state and open task counts, decision-needy first", () => {
    const worker = makeBot("Scout", {
      session: makeSession(ThreadId.make("thread-bot-working"), {
        status: "running",
        activeTurnId: TurnId.make("turn-bot"),
      }),
    });
    const stuck = makeBot("Archivist", { hasPendingApprovals: true });
    const idle = makeBot("Muse", {});
    const notABot = makeThread({ hasPendingApprovals: true });
    const archivedBot = makeBot("Ghost", { archivedAt: "2026-09-05T00:00:00.000Z" });
    const cards = [
      makeCard({ status: "ready", assigneeThreadId: worker.id }),
      makeCard({ status: "inProgress", assigneeThreadId: worker.id }),
      makeCard({ status: "done", assigneeThreadId: worker.id }),
      makeCard({ status: "backlog", assigneeThreadId: null }),
    ];
    const roster = botRoster([worker, stuck, idle, notABot, archivedBot], cards, KEYS);
    expect(roster.map((bot) => bot.displayName)).toEqual(["Archivist", "Scout", "Muse"]);
    expect(roster[0]?.state).toBe("waiting");
    expect(roster[1]?.state).toBe("working");
    expect(roster[1]?.openTasks).toBe(2);
    expect(roster[2]?.state).toBe("idle");
  });
});

describe("upcomingProjectSchedules", () => {
  function makeSchedule(overrides: {
    id: string;
    projectId?: ProjectId;
    enabled?: boolean;
    nextRunAt: string | null;
  }) {
    return {
      environmentId: ENV,
      id: ScheduleId.make(overrides.id),
      projectId: overrides.projectId ?? PROJECT,
      title: overrides.id,
      enabled: overrides.enabled ?? true,
      nextRunAt: overrides.nextRunAt,
      timeZone: "UTC",
    };
  }

  it("keeps only enabled future runs in the project, soonest first", () => {
    const soon = makeSchedule({ id: "soon", nextRunAt: "2026-09-06T16:00:00.000Z" });
    const later = makeSchedule({ id: "later", nextRunAt: "2026-09-07T16:00:00.000Z" });
    const disabled = makeSchedule({
      id: "disabled",
      enabled: false,
      nextRunAt: "2026-09-06T15:30:00.000Z",
    });
    const noRun = makeSchedule({ id: "no-run", nextRunAt: null });
    const foreign = makeSchedule({
      id: "foreign",
      projectId: ProjectId.make("project-elsewhere"),
      nextRunAt: "2026-09-06T15:15:00.000Z",
    });
    const rows = upcomingProjectSchedules([later, disabled, noRun, foreign, soon], KEYS);
    expect(rows.map((row) => row.scheduleId)).toEqual([soon.id, later.id]);
  });
});
