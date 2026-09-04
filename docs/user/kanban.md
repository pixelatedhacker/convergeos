# Kanban

Each project has a shared Kanban board with five columns: **Backlog**, **Ready**, **In progress**,
**Review**, and **Done**. Open the project picker and choose the columns button beside a project to
open its board. On mobile, open **Settings → Kanban** and choose a project.

Add a task with the field above the board. A card can hold a title, description, and optional bot
assignment. Use its arrow controls to move it to the adjacent stage, or edit it to change the text
and assignee. Deleting a card asks for confirmation.

The board belongs to one environment-local project. Its updates travel through the same connection
as threads, so web, desktop, and mobile clients see the same state without loading the board into
the normal sidebar stream.

## Agent access

Agent access is off by default. Turn on **Settings → Integrations → Agents → Agent Kanban access**
to give newly started sessions the `kanban_read` and `kanban_write` tools. An agent can access only
the project containing its own thread. It cannot name a different project.

Mutations use revisions to prevent one client from silently overwriting another. When a write says
the revision changed, read the board again and retry against the current card. Reuse the same
request ID only when retrying the same write.

A card can be assigned only to an active bot in that project. Disabling a bot does not erase old
assignments, but new assignments require an active bot.
