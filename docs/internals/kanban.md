# Kanban architecture

Kanban is a project-owned collection of independent card aggregates. It deliberately does not add a
second project model, an agent scheduler, or a task queue.

## Domain model

A card has a project ID, title, description, fixed status, server-generated order key, optional bot
thread ID, compare-and-swap revision, and timestamps. The five statuses are `backlog`, `ready`,
`inProgress`, `review`, and `done`.

Clients express placement as first, last, before another card, or after another card. The decider
validates the referenced card and generates the order key. Clients never author canonical order
keys. Create, update, move, and delete are normal orchestration commands with command receipts and
events. Each card is its own `kanban-card` aggregate, so unrelated cards do not serialize behind a
board-wide revision.

An assignee is the thread ID of an active bot in the same project. The decider validates this when
creating a card or changing its assignee. A later bot disable preserves the existing assignment as
historical context.

## Projection and transport

Migration 049 creates `projection_kanban_cards`. The command read model includes cards so the pure
decider can validate revisions, placement, and assignments. Full snapshots also include them for
replay and diagnostics.

Interactive clients subscribe to `kanban.subscribeBoard` only while a board is open. The server
acquires the live event subscription before reading the initial snapshot, then filters events to
the requested project. This closes the snapshot-to-subscription race without adding board data to
the high-frequency shell stream.

## MCP boundary

`enableAgentKanbanAccess` defaults to false. New provider sessions receive `kanban.read` and
`kanban.write` only when it is enabled. The MCP handler derives the project from the credential's
calling thread, ignores caller-supplied project selection, and sends every mutation through
`OrchestrationEngineService`. Stable request IDs become stable command IDs for retry deduplication.

The first release does not automatically dispatch cards to bots. Assignment is planning metadata;
an agent or user still starts work explicitly through the normal thread and mesh paths.
