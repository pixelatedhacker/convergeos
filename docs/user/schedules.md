# Schedules

A schedule runs a prompt on a timer. Open **Schedules** from the sidebar (or the command palette's
**Open schedules**) to see every schedule across your connected environments, grouped by project.

Each fire starts a fresh thread in the schedule's project, so every run is inspectable on its own
and no thread's context grows without bound. Recent runs are listed at the bottom of the page and
open the thread that ran.

## Creating a schedule

Choose **New schedule** and pick a project, title, prompt, and model. Four recurrence kinds are
available:

- **Once** — a single run at a date and time.
- **Daily** — every day at a wall-clock time.
- **Weekly** — one weekday per week at a wall-clock time.
- **Monthly** — one day of the month at a wall-clock time. Months without that day are skipped, so
  day 31 never fires in February.

Wall-clock schedules evaluate in the schedule's time zone, which defaults to yours. A 9:00 AM
schedule in `America/New_York` keeps firing at 9:00 AM across daylight-saving changes.

## Pausing and editing

The switch on each row pauses a schedule without deleting it; paused schedules keep their history
and remember nothing about missed runs — re-enabling schedules the next future occurrence. Editing
timing (recurrence, time zone, or re-enabling) recomputes the next run from now. A **Once** schedule
that has fired stays on the page with no next run until you delete it.

Edits use revisions to prevent one client from silently overwriting another. If a save says the
revision changed, reopen the schedule and retry.

## Server version

Schedules run on the server, with no client required to be open. Environments running an older
server are listed at the top of the page and cannot manage schedules until updated.
