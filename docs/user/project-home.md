# Project home

Selecting a project in the web or desktop sidebar opens its Project Home. The page combines the
project's coordinators, a status checklist, board, bots, recent threads, schedules, and 14-day
activity in one view.

The header has three project actions:

- **New thread.** Starts a thread in the project.
- **Board.** Opens the full Kanban board.
- **Project settings.** Opens the project's settings.

Under the name, a status line counts what is waiting on you, how many agents are working, and how
many board tasks are in play.

**Coordinators** lists threads that run agent mesh workers, one row each, with a short status such
as "Working · 3 workers · 1 needs you" and when anything in the group last moved. When the
coordinator is following a plan, its current step replaces the status word. The dot takes the most
urgent state in the group, so a worker waiting for approval is not hidden behind a busy
coordinator. The section is hidden when no thread has workers.

**Checklist** groups threads and board cards by who has to move next:

- **Waiting on you**: pending approvals, questions waiting for an answer, plans ready to review,
  and failed sessions.
- **In progress**: threads that are working, connecting, or monitoring, and cards in
  **In progress**.
- **Ready**: finished threads you have not opened since, and cards in **Ready** or **Review**.

Each group shows its newest items first and summarizes the rest as "+N more". Select a thread to
open it, or a card to open the board. Snoozed and settled threads stay out of **Waiting on you**
and **Ready** but still show while they work.

**Project bots** appears when the project has active bots. Each bot card shows its current state and
the number of open board tasks assigned to it. If the bot has a description, the card shows it
above the task count. Select a bot to open its thread.

Decisions needing you and recent work appear above bots and the board.
An empty board shows only the task field. Once it has cards, the preview shows the five columns. Add a task to the backlog, or drag a card to
another column. Select **Open board** to edit card details and assignments.

**Recent threads** lists recent threads. **Upcoming** shows the project's next scheduled runs and
links to the full Schedules page. **Activity** counts threads touched during the last 14 days.

Below Activity, an **AGENTS.md** row opens the project root's `AGENTS.md` in your editor. Agents
read it for project instructions. When the project root has none, the row says so. For a project
that spans several environments, the file comes from the project's primary environment.

Pages lists saved reports, documents, and website links for each environment in the project.
Choose a page to open it, rename it, publish an update, or archive it. Show archived pages to
restore one. See [Saved pages](pages.md).
