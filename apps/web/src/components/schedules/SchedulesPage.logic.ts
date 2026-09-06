import type {
  EnvironmentId,
  Schedule,
  ScheduleListSnapshot,
  ScheduleRecurrence,
  ScheduleRun,
  ScheduleTimeOfDay,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export type RecurrenceKind = ScheduleRecurrence["kind"];

export type EnvironmentSchedule = Schedule & {
  readonly environmentId: EnvironmentId;
};

export type EnvironmentScheduleRun = ScheduleRun & {
  readonly environmentId: EnvironmentId;
};

export interface ScheduleProjectGroup {
  readonly key: string;
  readonly name: string;
  readonly schedules: readonly EnvironmentSchedule[];
}

export type RecurrenceBuildResult =
  | { readonly ok: true; readonly recurrence: ScheduleRecurrence }
  | { readonly ok: false; readonly error: string };

export function projectRefKey(environmentId: EnvironmentId, projectId: string): string {
  return `${environmentId}:${projectId}`;
}

export function isValidIanaTimeZone(timeZone: string): boolean {
  if (timeZone.trim().length === 0) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function defaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function listIanaTimeZones(): readonly string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

export function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatTimeInput(time: ScheduleTimeOfDay): string {
  return `${pad2(time.hour)}:${pad2(time.minute)}`;
}

export function parseTimeInput(value: string): ScheduleTimeOfDay | null {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function formatWallClockTime(time: ScheduleTimeOfDay): string {
  const suffix = time.hour < 12 ? "AM" : "PM";
  const hour12 = time.hour % 12 === 0 ? 12 : time.hour % 12;
  return `${hour12}:${pad2(time.minute)} ${suffix}`;
}

function parseDatetimeLocal(value: string): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
} | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second)
  ) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return null;
  }
  return { year, month, day, hour, minute, second, millisecond: 0 };
}

/**
 * Interprets a datetime-local wall clock in `timeZone` and returns a UTC ISO
 * instant. Uses Effect's zoned constructor so DST gaps are not offset-math.
 */
export function datetimeLocalToUtcIso(value: string, timeZone: string): string | null {
  const parts = parseDatetimeLocal(value);
  if (parts === null) return null;
  const zone = DateTime.zoneMakeNamed(timeZone);
  if (Option.isNone(zone)) return null;
  const zoned = DateTime.makeZoned(parts, {
    timeZone: zone.value,
    adjustForTimeZone: true,
    disambiguation: "compatible",
  });
  if (Option.isNone(zoned)) return null;
  return DateTime.formatIso(zoned.value);
}

export function utcIsoToDatetimeLocal(iso: string, timeZone: string): string | null {
  const instant = DateTime.make(iso);
  const zone = DateTime.zoneMakeNamed(timeZone);
  if (Option.isNone(instant) || Option.isNone(zone)) return null;
  const parts = DateTime.toParts(instant.value.pipe(DateTime.setZone(zone.value)));
  return `${String(parts.year).padStart(4, "0")}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

export function formatScheduleInstant(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
}

function formatOnceInstant(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const options = { timeZone } as const;
  try {
    const datePart = new Intl.DateTimeFormat("en-US", {
      ...options,
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(date);
    const timePart = new Intl.DateTimeFormat("en-US", {
      ...options,
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
    return `${datePart} at ${timePart}`;
  } catch {
    return formatScheduleInstant(iso, timeZone);
  }
}

export function formatRecurrenceSummary(recurrence: ScheduleRecurrence, timeZone: string): string {
  switch (recurrence.kind) {
    case "once":
      return `Once on ${formatOnceInstant(recurrence.at, timeZone)}`;
    case "daily":
      return `Daily at ${formatWallClockTime(recurrence.time)} ${timeZone}`;
    case "weekly": {
      const weekday = WEEKDAY_LABELS[recurrence.weekday] ?? "unknown";
      return `Weekly on ${weekday} at ${formatWallClockTime(recurrence.time)} ${timeZone}`;
    }
    case "monthly":
      return `Monthly on day ${recurrence.day} at ${formatWallClockTime(recurrence.time)} ${timeZone}`;
    default: {
      const _exhaustive: never = recurrence;
      return _exhaustive;
    }
  }
}

export function buildScheduleRecurrence(input: {
  readonly kind: RecurrenceKind;
  readonly onceLocal: string;
  readonly time: string;
  readonly weekday: number;
  readonly monthDay: number;
  readonly timeZone: string;
}): RecurrenceBuildResult {
  if (input.kind === "once") {
    const at = datetimeLocalToUtcIso(input.onceLocal, input.timeZone);
    if (at === null) return { ok: false, error: "Enter a valid date and time." };
    return { ok: true, recurrence: { kind: "once", at } };
  }

  const time = parseTimeInput(input.time);
  if (time === null) return { ok: false, error: "Enter a valid time." };

  if (input.kind === "daily") {
    return { ok: true, recurrence: { kind: "daily", time } };
  }
  if (input.kind === "weekly") {
    if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) {
      return { ok: false, error: "Pick a weekday." };
    }
    return { ok: true, recurrence: { kind: "weekly", weekday: input.weekday, time } };
  }
  if (!Number.isInteger(input.monthDay) || input.monthDay < 1 || input.monthDay > 31) {
    return { ok: false, error: "Day must be between 1 and 31." };
  }
  return { ok: true, recurrence: { kind: "monthly", day: input.monthDay, time } };
}

export function mergeCapableSnapshots(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly supportsSchedules: boolean;
    readonly snapshot: ScheduleListSnapshot | null;
  }>,
): {
  readonly schedules: EnvironmentSchedule[];
  readonly runs: EnvironmentScheduleRun[];
} {
  const schedules: EnvironmentSchedule[] = [];
  const runs: EnvironmentScheduleRun[] = [];
  for (const environment of environments) {
    if (!environment.supportsSchedules || environment.snapshot === null) continue;
    for (const schedule of environment.snapshot.schedules) {
      if (schedule.deletedAt !== null) continue;
      schedules.push({ ...schedule, environmentId: environment.environmentId });
    }
    for (const run of environment.snapshot.runs) {
      runs.push({ ...run, environmentId: environment.environmentId });
    }
  }
  schedules.sort((left, right) => left.title.localeCompare(right.title));
  runs.sort((left, right) => right.firedAt.localeCompare(left.firedAt));
  return { schedules, runs };
}

export function groupSchedulesByProject(
  schedules: readonly EnvironmentSchedule[],
  projectNameByRef: ReadonlyMap<string, string>,
): ScheduleProjectGroup[] {
  const groups = new Map<string, EnvironmentSchedule[]>();
  for (const schedule of schedules) {
    const key = projectRefKey(schedule.environmentId, schedule.projectId);
    const members = groups.get(key);
    if (members) members.push(schedule);
    else groups.set(key, [schedule]);
  }
  return [...groups.entries()]
    .map(([key, members]) => ({
      key,
      name: projectNameByRef.get(key) ?? "Unknown project",
      schedules: members.toSorted((left, right) => left.title.localeCompare(right.title)),
    }))
    .toSorted(
      (left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key),
    );
}

export function recurrenceEditorValues(
  recurrence: ScheduleRecurrence,
  timeZone: string,
): {
  readonly kind: RecurrenceKind;
  readonly onceLocal: string;
  readonly time: string;
  readonly weekday: number;
  readonly monthDay: number;
} {
  switch (recurrence.kind) {
    case "once":
      return {
        kind: "once",
        onceLocal: utcIsoToDatetimeLocal(recurrence.at, timeZone) ?? "",
        time: "09:00",
        weekday: 1,
        monthDay: 1,
      };
    case "daily":
      return {
        kind: "daily",
        onceLocal: "",
        time: formatTimeInput(recurrence.time),
        weekday: 1,
        monthDay: 1,
      };
    case "weekly":
      return {
        kind: "weekly",
        onceLocal: "",
        time: formatTimeInput(recurrence.time),
        weekday: recurrence.weekday,
        monthDay: 1,
      };
    case "monthly":
      return {
        kind: "monthly",
        onceLocal: "",
        time: formatTimeInput(recurrence.time),
        weekday: 1,
        monthDay: recurrence.day,
      };
    default: {
      const _exhaustive: never = recurrence;
      return _exhaustive;
    }
  }
}
