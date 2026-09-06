import { describe, expect, it } from "vite-plus/test";

import { isValidScheduleTimeZone, nextRunAfter } from "./SchedulePolicy.ts";

describe("isValidScheduleTimeZone", () => {
  it("accepts IANA zones and rejects others", () => {
    expect(isValidScheduleTimeZone("UTC")).toBe(true);
    expect(isValidScheduleTimeZone("America/New_York")).toBe(true);
    expect(isValidScheduleTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidScheduleTimeZone("")).toBe(false);
  });
});

describe("nextRunAfter", () => {
  it("returns the instant for a future once schedule", () => {
    expect(
      nextRunAfter(
        { kind: "once", at: "2026-09-06T09:00:00.000Z" },
        "UTC",
        "2026-09-05T15:00:00.000Z",
      ),
    ).toBe("2026-09-06T09:00:00.000Z");
  });

  it("returns null for a once schedule in the past", () => {
    expect(
      nextRunAfter(
        { kind: "once", at: "2026-09-05T09:00:00.000Z" },
        "UTC",
        "2026-09-05T15:00:00.000Z",
      ),
    ).toBeNull();
  });

  it("rolls a daily schedule to the next day once today's time has passed", () => {
    // 2026-09-05T15:00:00Z is 11:00 in New York (EDT), so 09:00 today is gone.
    expect(
      nextRunAfter(
        { kind: "daily", time: { hour: 9, minute: 0 } },
        "America/New_York",
        "2026-09-05T15:00:00.000Z",
      ),
    ).toBe("2026-09-06T13:00:00.000Z");
  });

  it("keeps a daily schedule on the same day when the time is still ahead", () => {
    // 2026-09-05T12:00:00Z is 08:00 in New York (EDT); 09:00 today is 13:00Z.
    expect(
      nextRunAfter(
        { kind: "daily", time: { hour: 9, minute: 0 } },
        "America/New_York",
        "2026-09-05T12:00:00.000Z",
      ),
    ).toBe("2026-09-05T13:00:00.000Z");
  });

  it("keeps wall-clock time across the spring-forward boundary", () => {
    // DST starts 2026-03-08 in America/New_York (UTC-5 -> UTC-4). From after
    // 09:30 EST on March 7, a 09:30 daily must fire at 09:30 EDT on March 8,
    // i.e. 13:30Z not 14:30Z.
    expect(
      nextRunAfter(
        { kind: "daily", time: { hour: 9, minute: 30 } },
        "America/New_York",
        "2026-03-07T15:00:00.000Z",
      ),
    ).toBe("2026-03-08T13:30:00.000Z");
  });

  it("lands on the next matching weekday for weekly schedules", () => {
    // 2026-09-04 is a Friday; the next Wednesday is 2026-09-09.
    expect(
      nextRunAfter(
        { kind: "weekly", weekday: 3, time: { hour: 17, minute: 0 } },
        "UTC",
        "2026-09-04T00:00:00.000Z",
      ),
    ).toBe("2026-09-09T17:00:00.000Z");
  });

  it("fires a weekly schedule later the same day when the time is ahead", () => {
    // 2026-09-09 is a Wednesday.
    expect(
      nextRunAfter(
        { kind: "weekly", weekday: 3, time: { hour: 17, minute: 0 } },
        "UTC",
        "2026-09-09T16:00:00.000Z",
      ),
    ).toBe("2026-09-09T17:00:00.000Z");
  });

  it("skips a weekly occurrence whose time already passed today", () => {
    expect(
      nextRunAfter(
        { kind: "weekly", weekday: 3, time: { hour: 17, minute: 0 } },
        "UTC",
        "2026-09-09T18:00:00.000Z",
      ),
    ).toBe("2026-09-16T17:00:00.000Z");
  });

  it("computes monthly schedules within the current month", () => {
    expect(
      nextRunAfter(
        { kind: "monthly", day: 15, time: { hour: 0, minute: 0 } },
        "UTC",
        "2026-09-05T00:00:00.000Z",
      ),
    ).toBe("2026-09-15T00:00:00.000Z");
  });

  it("treats the fire instant as strictly after the reference time", () => {
    expect(
      nextRunAfter(
        { kind: "monthly", day: 5, time: { hour: 0, minute: 0 } },
        "UTC",
        "2026-09-05T00:00:00.000Z",
      ),
    ).toBe("2026-10-05T00:00:00.000Z");
  });

  it("skips months that lack the monthly day", () => {
    // February 2026 has 28 days, so day 31 next lands on March 31.
    expect(
      nextRunAfter(
        { kind: "monthly", day: 31, time: { hour: 12, minute: 0 } },
        "UTC",
        "2026-02-01T00:00:00.000Z",
      ),
    ).toBe("2026-03-31T12:00:00.000Z");
  });

  it("returns null for an invalid zone on wall-clock recurrences", () => {
    expect(
      nextRunAfter(
        { kind: "daily", time: { hour: 9, minute: 0 } },
        "Mars/Olympus",
        "2026-09-05T15:00:00.000Z",
      ),
    ).toBeNull();
  });
});
