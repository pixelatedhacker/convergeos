import type { ScheduleRecurrence, ScheduleTimeZone } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export function isValidScheduleTimeZone(timeZone: string): boolean {
  return Option.isSome(DateTime.zoneMakeNamed(timeZone));
}

// Daily needs 2 candidates, weekly 8; the cap only bounds pathological zones.
const MAX_DAY_CANDIDATES = 14;
// A monthly day of 31 skips February, so the worst case is a 2-month gap.
const MAX_MONTH_CANDIDATES = 26;

function daysInMonth(year: number, month: number): number | null {
  const first = DateTime.make({ year, month, day: 1 });
  if (Option.isNone(first)) return null;
  return DateTime.toPartsUtc(
    first.value.pipe(DateTime.add({ months: 1 }), DateTime.subtract({ days: 1 })),
  ).day;
}

/**
 * Next instant a recurrence should fire, strictly after `fromIso`, or null
 * when it can never fire again (a "once" in the past) or the zone is invalid.
 * Wall-clock kinds are evaluated in `timeZone`; DST gaps and repeats resolve
 * with "compatible" disambiguation, so a nonexistent 02:30 fires at the later
 * interpretation and a repeated one at the earlier.
 */
export function nextRunAfter(
  recurrence: ScheduleRecurrence,
  timeZone: ScheduleTimeZone,
  fromIso: string,
): string | null {
  const from = DateTime.make(fromIso);
  if (Option.isNone(from)) return null;
  const fromMs = DateTime.toEpochMillis(from.value);

  if (recurrence.kind === "once") {
    const at = DateTime.make(recurrence.at);
    if (Option.isNone(at)) return null;
    return DateTime.toEpochMillis(at.value) > fromMs ? DateTime.formatIso(at.value) : null;
  }

  const zone = DateTime.zoneMakeNamed(timeZone);
  if (Option.isNone(zone)) return null;
  const fromZoned = from.value.pipe(DateTime.setZone(zone.value));
  const fromParts = DateTime.toParts(fromZoned);

  if (recurrence.kind === "monthly") {
    const monthStart = DateTime.make({
      year: fromParts.year,
      month: fromParts.month,
      day: 1,
    });
    if (Option.isNone(monthStart)) return null;
    for (let offset = 0; offset < MAX_MONTH_CANDIDATES; offset += 1) {
      const monthParts = DateTime.toPartsUtc(
        monthStart.value.pipe(DateTime.add({ months: offset })),
      );
      const monthLength = daysInMonth(monthParts.year, monthParts.month);
      if (monthLength === null || recurrence.day > monthLength) continue;
      const candidate = DateTime.makeZoned(
        {
          year: monthParts.year,
          month: monthParts.month,
          day: recurrence.day,
          hour: recurrence.time.hour,
          minute: recurrence.time.minute,
          second: 0,
          millisecond: 0,
        },
        { timeZone: zone.value, adjustForTimeZone: true, disambiguation: "compatible" },
      );
      if (Option.isNone(candidate)) continue;
      if (DateTime.toEpochMillis(candidate.value) > fromMs) {
        return DateTime.formatIso(candidate.value);
      }
    }
    return null;
  }

  const dayStart = DateTime.make({
    year: fromParts.year,
    month: fromParts.month,
    day: fromParts.day,
  });
  if (Option.isNone(dayStart)) return null;
  for (let offset = 0; offset < MAX_DAY_CANDIDATES; offset += 1) {
    const dayParts = DateTime.toPartsUtc(dayStart.value.pipe(DateTime.add({ days: offset })));
    const candidate = DateTime.makeZoned(
      {
        year: dayParts.year,
        month: dayParts.month,
        day: dayParts.day,
        hour: recurrence.time.hour,
        minute: recurrence.time.minute,
        second: 0,
        millisecond: 0,
      },
      { timeZone: zone.value, adjustForTimeZone: true, disambiguation: "compatible" },
    );
    if (Option.isNone(candidate)) continue;
    if (
      recurrence.kind === "weekly" &&
      DateTime.toParts(candidate.value).weekDay !== recurrence.weekday
    ) {
      continue;
    }
    if (DateTime.toEpochMillis(candidate.value) > fromMs) {
      return DateTime.formatIso(candidate.value);
    }
  }
  return null;
}
