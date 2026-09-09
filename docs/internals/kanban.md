# Kanban architecture

Kanban is a project-owned collection of independent card aggregates. A small reconciliation reactor
turns Ready assignments into durable delegations; it is not a second project model or a general job
queue.

## Domain model

A card has a project ID, title, description, fixed status, server-generated order key, optional bot
thread ID, optional delegation ID, compare-and-swap revision, and timestamps. The five statuses are
`backlog`, `ready`, `inProgress`, `review`, and `done`.

Clients express placement as first, last, before another card, or after another card. The decider
validates the referenced card and generates the order key. Clients never author canonical order
keys. Create, update, move, retry, and delete are normal orchestration commands with command receipts
and events. Each card is its own `kanban-card` aggregate, so unrelated cards do not serialize behind
a board-wide revision.

An assignee is the thread ID of an active bot in the same project. The decider validates this when
creating a card or changing its assignee. A later bot disable preserves the existing assignment as
historical context.

## Projection and transport

Migration 049 creates `projection_kanban_cards`; migration 051 adds the delegation link. Migration
050 stores the per-run delegation aggregate. The command read model includes cards and delegations
so the pure decider can validate revisions, placement, assignments, and one-open-run-per-bot
exclusivity. Ordinary client snapshots include only the linked delegation summaries needed by the
board.

Interactive clients subscribe to `kanban.subscribeBoard` only while a board is open. The server
acquires the live event subscription before reading the initial snapshot, then filters events to
the requested project. This closes the snapshot-to-subscription race without adding board data to
the high-frequency shell stream.

## Bot dispatch

The Kanban delegation reactor subscribes before its initial reconciliation. An assigned Ready card
reserves an available isolated bot through `delegation.request`; the decider is the authoritative
serialization point, so concurrent mesh and Kanban requests cannot reserve the same target. The
reactor uses deterministic command and message IDs to resume a crash between reservation and turn
start without creating a duplicate turn.

The card remains Ready while queued, moves to In progress only after its delegation is running, and
moves to Review on completion. Failure or interruption returns it to Ready with the terminal result
still linked. An explicit retry clears that link and increments the card revision, producing a new
delegation identity for the next attempt.

## MCP boundary

`agentKanbanAccess` defaults to `none`. New provider sessions receive `kanban.read` at the `read`
level and both `kanban.read` and `kanban.write` at the `write` level. Write authority always
includes read authority. The MCP handler derives the project from the credential's calling thread,
ignores caller-supplied project selection, and sends every mutation through
`OrchestrationEngineService`. Stable request IDs become stable command IDs for retry deduplication.

The MCP board snapshot includes the same linked delegation summaries as web and mobile, so an agent
can distinguish queued, running, completed, failed, and interrupted assignments without reading the
worker thread.
