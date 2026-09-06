# Schedules architecture

A schedule is a project-owned aggregate that fires a prompt on a recurrence. Each fire creates a
fresh thread through the same bootstrap path the composer uses; the run ledger is the schedule's
`schedule.fired` events, not a second job model.

## Domain model

A schedule has a project ID, title, prompt, recurrence, IANA time zone, model selection, runtime
and interaction modes, an enabled flag, `nextRunAt`/`lastRunAt`, a compare-and-swap revision, and
timestamps. Recurrences are `once` (an absolute instant) or wall-clock `daily`/`weekly`/`monthly`
evaluated in the schedule's zone, so daylight-saving changes never shift a 9 AM schedule. Months
lacking a monthly day are skipped.

Create, update, and delete are ordinary client commands. The decider validates the zone against
`Intl`, computes `nextRunAt` on creation and whenever timing changes, and rejects an enabled
schedule with no future run. Unrelated edits to an exhausted `once` schedule stay legal; only a
timing edit can make a schedule unfireable.

## Firing

The scheduler reactor sweeps once a minute. For each due schedule it dispatches `schedule.fire`, a
server-only command whose decider case revalidates that the occurrence is still due and atomically
advances `nextRunAt`. The fire is the claim on the occurrence; the accepted event is what
authorizes the reactor to follow with a `thread.turn.start` (bootstrap createThread) on a
deterministic thread ID, `scheduled-run:{scheduleId}:{occurrence}`.

All command and entity IDs are deterministic per occurrence
(`server:schedule-fire:{scheduleId}:{occurrence}`), so a crash between claim and launch replays
into engine command-receipt dedup instead of a second run, and overlapping sweeps cannot
double-fire. A schedule whose project is gone is skipped with a warning, not retried forever.

## Projection and transport

Migration 053 creates `projection_schedules` and `projection_schedule_runs`. The command read
model carries schedules so the decider can validate revisions and due-ness. Clients poll
`orchestration.listSchedules` (active schedules plus the ten most recent runs per schedule) rather
than subscribing; schedule state changes too rarely to justify a slot in the high-frequency shell
stream. Servers advertise the `scheduledTurns` capability so older environments are excluded from
multi-environment schedule views instead of failing their queries.

## Recurrence computation

`SchedulePolicy.nextRunAfter` is the only place date arithmetic lives. It builds zoned candidates
with `DateTime.makeZoned` (`adjustForTimeZone`, `compatible` disambiguation) and scans forward a
bounded number of days or months, so DST gaps and short months need no hand-rolled offset math.
The decider and reactor both anchor on explicit instants, and tests pin the clock with
`TestClock`.
