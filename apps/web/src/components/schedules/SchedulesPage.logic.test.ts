import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduleId,
  ThreadId,
} from "@t3tools/contracts";

import {
  buildScheduleRecurrence,
  datetimeLocalToUtcIso,
  formatRecurrenceSummary,
  formatTimeInput,
  groupSchedulesByProject,
  isValidIanaTimeZone,
  mergeCapableSnapshots,
  parseTimeInput,
  utcIsoToDatetimeLocal,
  type EnvironmentSchedule,
} from "./SchedulesPage.logic";

describe("isValidIanaTimeZone", () => {
  it("accepts IANA zones and rejects empty or invented names", () => {
    expect(isValidIanaTimeZone("UTC")).toBe(true);
    expect(isValidIanaTimeZone("America/New_York")).toBe(true);
    expect(isValidIanaTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidIanaTimeZone("")).toBe(false);
    expect(isValidIanaTimeZone("   ")).toBe(false);
  });
});

describe("datetimeLocalToUtcIso", () => {
  it("interprets wall-clock time in the chosen zone", () => {
    // 15:00 in New York on 2026-09-12 is EDT (UTC-4).
    expect(datetimeLocalToUtcIso("2026-09-12T15:00", "America/New_York")).toBe(
      "2026-09-12T19:00:00.000Z",
    );
    expect(datetimeLocalToUtcIso("2026-09-12T09:00", "UTC")).toBe("2026-09-12T09:00:00.000Z");
  });

  it("rejects malformed datetime-local strings", () => {
    expect(datetimeLocalToUtcIso("not-a-date", "UTC")).toBeNull();
    expect(datetimeLocalToUtcIso("2026-09-12T15:00", "Mars/Olympus")).toBeNull();
  });
});

describe("utcIsoToDatetimeLocal", () => {
  it("round-trips an instant back to the zone's wall clock", () => {
    expect(utcIsoToDatetimeLocal("2026-09-12T19:00:00.000Z", "America/New_York")).toBe(
      "2026-09-12T15:00",
    );
  });
});

describe("parseTimeInput", () => {
  it("parses padded and unpadded times", () => {
    expect(parseTimeInput("09:00")).toEqual({ hour: 9, minute: 0 });
    expect(parseTimeInput("17:30")).toEqual({ hour: 17, minute: 30 });
    expect(parseTimeInput("9:05")).toEqual({ hour: 9, minute: 5 });
    expect(parseTimeInput("09:00:00")).toEqual({ hour: 9, minute: 0 });
    expect(parseTimeInput("24:00")).toBeNull();
    expect(parseTimeInput("")).toBeNull();
  });
});

describe("formatTimeInput", () => {
  it("zero-pads hour and minute", () => {
    expect(formatTimeInput({ hour: 9, minute: 0 })).toBe("09:00");
    expect(formatTimeInput({ hour: 17, minute: 5 })).toBe("17:05");
  });
});

describe("formatRecurrenceSummary", () => {
  it("describes once, daily, weekly, and monthly recurrences", () => {
    expect(
      formatRecurrenceSummary({ kind: "once", at: "2026-09-12T19:00:00.000Z" }, "America/New_York"),
    ).toBe("Once on Sep 12, 2026 at 3:00 PM");
    expect(
      formatRecurrenceSummary({ kind: "daily", time: { hour: 9, minute: 0 } }, "America/New_York"),
    ).toBe("Daily at 9:00 AM America/New_York");
    expect(
      formatRecurrenceSummary(
        { kind: "weekly", weekday: 1, time: { hour: 17, minute: 0 } },
        "America/New_York",
      ),
    ).toBe("Weekly on Monday at 5:00 PM America/New_York");
    expect(
      formatRecurrenceSummary(
        { kind: "monthly", day: 15, time: { hour: 8, minute: 0 } },
        "America/New_York",
      ),
    ).toBe("Monthly on day 15 at 8:00 AM America/New_York");
  });
});

describe("buildScheduleRecurrence", () => {
  it("builds each kind from editor fields", () => {
    expect(
      buildScheduleRecurrence({
        kind: "once",
        onceLocal: "2026-09-12T15:00",
        time: "09:00",
        weekday: 1,
        monthDay: 1,
        timeZone: "America/New_York",
      }),
    ).toEqual({ ok: true, recurrence: { kind: "once", at: "2026-09-12T19:00:00.000Z" } });
    expect(
      buildScheduleRecurrence({
        kind: "daily",
        onceLocal: "",
        time: "09:00",
        weekday: 1,
        monthDay: 1,
        timeZone: "UTC",
      }),
    ).toEqual({ ok: true, recurrence: { kind: "daily", time: { hour: 9, minute: 0 } } });
    expect(
      buildScheduleRecurrence({
        kind: "weekly",
        onceLocal: "",
        time: "17:00",
        weekday: 1,
        monthDay: 1,
        timeZone: "UTC",
      }),
    ).toEqual({
      ok: true,
      recurrence: { kind: "weekly", weekday: 1, time: { hour: 17, minute: 0 } },
    });
    expect(
      buildScheduleRecurrence({
        kind: "monthly",
        onceLocal: "",
        time: "08:00",
        weekday: 1,
        monthDay: 15,
        timeZone: "UTC",
      }),
    ).toEqual({
      ok: true,
      recurrence: { kind: "monthly", day: 15, time: { hour: 8, minute: 0 } },
    });
  });

  it("rejects missing once times and out-of-range monthly days", () => {
    expect(
      buildScheduleRecurrence({
        kind: "once",
        onceLocal: "",
        time: "09:00",
        weekday: 1,
        monthDay: 1,
        timeZone: "UTC",
      }).ok,
    ).toBe(false);
    expect(
      buildScheduleRecurrence({
        kind: "monthly",
        onceLocal: "",
        time: "08:00",
        weekday: 1,
        monthDay: 32,
        timeZone: "UTC",
      }).ok,
    ).toBe(false);
  });
});

describe("mergeCapableSnapshots", () => {
  it("merges only capable environments and drops deleted schedules", () => {
    const environmentId = EnvironmentId.make("env-1");
    const otherId = EnvironmentId.make("env-old");
    const live = scheduleFixture({
      id: "sched-live",
      environmentId,
      title: "Live",
      deletedAt: null,
    });
    const deleted = scheduleFixture({
      id: "sched-gone",
      environmentId,
      title: "Gone",
      deletedAt: "2026-09-01T00:00:00.000Z",
    });
    const merged = mergeCapableSnapshots([
      {
        environmentId,
        supportsSchedules: true,
        snapshot: {
          schedules: [deleted, live],
          runs: [
            {
              scheduleId: live.id,
              threadId: ThreadId.make("thread-1"),
              firedAt: "2026-09-11T13:00:00.000Z",
            },
          ],
        },
      },
      {
        environmentId: otherId,
        supportsSchedules: false,
        snapshot: { schedules: [live], runs: [] },
      },
    ]);
    expect(merged.schedules.map((schedule) => schedule.title)).toEqual(["Live"]);
    expect(merged.runs).toHaveLength(1);
    expect(merged.runs[0]?.environmentId).toBe(environmentId);
  });
});

describe("groupSchedulesByProject", () => {
  it("groups by environment and project, then sorts by project name", () => {
    const env = EnvironmentId.make("env-1");
    const alpha = ProjectId.make("alpha");
    const beta = ProjectId.make("beta");
    const schedules = [
      scheduleFixture({ id: "s2", environmentId: env, projectId: beta, title: "Zebra" }),
      scheduleFixture({ id: "s1", environmentId: env, projectId: alpha, title: "Ada" }),
      scheduleFixture({ id: "s3", environmentId: env, projectId: alpha, title: "Zed" }),
    ];
    const groups = groupSchedulesByProject(
      schedules,
      new Map([
        [`${env}:${alpha}`, "Alpha"],
        [`${env}:${beta}`, "Beta"],
      ]),
    );
    expect(groups.map((group) => group.name)).toEqual(["Alpha", "Beta"]);
    expect(groups[0]?.schedules.map((schedule) => schedule.title)).toEqual(["Ada", "Zed"]);
  });
});

function scheduleFixture(input: {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly projectId?: ReturnType<typeof ProjectId.make>;
  readonly deletedAt?: string | null;
}): EnvironmentSchedule {
  return {
    id: ScheduleId.make(input.id),
    projectId: input.projectId ?? ProjectId.make("project-1"),
    title: input.title,
    prompt: "Do the work",
    recurrence: { kind: "daily", time: { hour: 9, minute: 0 } },
    timeZone: "UTC",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    enabled: true,
    nextRunAt: "2026-09-12T09:00:00.000Z",
    lastRunAt: null,
    revision: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    deletedAt: input.deletedAt ?? null,
    environmentId: input.environmentId,
  };
}
