# Agent mesh architecture

Agent mesh is a capability-gated MCP view over durable threads. It reuses the thread and provider
runtime, with one small `Delegation` aggregate for each assigned turn; it does not introduce a
second agent registry or execution engine.

## Boundaries

`AgentMesh` resolves the caller from its provider-scoped MCP credential. Reads use
`ProjectionSnapshotQuery` and are restricted to the caller's project. Mutations go only through
`OrchestrationEngineService`, so command receipts, events, projections, reactors, provider routing,
and checkpoints remain authoritative.

Internal commands represent peer mutations and the durable delegation lifecycle:

- `thread.peer-turn.start`
- `thread.peer-turn.interrupt`
- `delegation.request`
- `delegation.provision.start`
- `delegation.target.bind`
- `delegation.turn.request`
- `delegation.turn.bind`
- `delegation.complete`

They are members of `InternalOrchestrationCommand`, not `ClientOrchestrationCommand`. WebSocket and
HTTP clients therefore cannot claim peer-agent provenance. The decider validates source and target
threads atomically against its command read model, then emits the existing turn-start or interrupt
events. Peer command IDs begin with `provider:agent-mesh:`, so the event store attributes them to a
provider rather than a user client.

## Authorization

`enableAgentMeshAccess` defaults to false and is independent from browser automation. New provider
sessions receive `agents.read`, `agents.send`, and `agents.control` only when that setting is on.
The bearer credential fixes the calling environment and thread. Tool parameters can select only a
target thread; project scope is derived server-side.

The setting is exposed by the shared web settings surface used by web and desktop. Mobile does not
currently expose integration settings, so it can observe mesh-driven thread activity but cannot
toggle this server permission yet.

Cross-project and missing targets deliberately collapse to the same error. `agents_read` uses a
one-turn detail window and caps assistant text. It never returns user messages. `agents_wait`
accepts at most eight delegation IDs, caps returned assistant text, and waits on event streams with
a bounded timeout rather than polling.

Projected sessions retain the provider's MCP attachment outcome. `agents_list` exposes
`attached`, `notRequested`, or `leafOnly`, allowing the mesh to distinguish a worker that can only
receive work from one where recursive access may be granted. Attachment alone is not treated as a
grant: every tool call still checks the credential's capabilities.

The current Effect MCP registry has a process-wide tool catalog, so a session may discover a tool
name that its credential cannot invoke. Every handler still enforces its capability at call time.
Codex prompt construction reads the credential's preview capability directly, so mesh-only
credentials do not receive browser steering. A future transport-level catalog filter can improve
discovery without changing the authorization boundary.

## Mutation invariants

Every spawn or peer send has a bounded request ID. The caller and request ID produce a stable
delegation ID; each lifecycle step also has a deterministic command and message ID. The existing
command-receipt path therefore resumes retries and restart recovery without creating a second turn.
The delegation projection records its requester, target, target thread, turn, terminal outcome, and
revision.

`agents_spawn` provisions a deterministic worker thread and isolated worktree from the caller's
branch, then starts one normal turn. `agents_send` assigns one turn to an existing bot inbox. The
same reconciliation path repairs a crash between reservation, worktree preparation, turn request,
and turn binding. Completion follows the target turn's projected lifecycle.

The decider rejects a peer send when:

- source and target are the same thread;
- either thread or their project is unavailable, deleted, or archived;
- the threads belong to different projects;
- their effective workspaces are shared;
- the target is running, starting, queued, or waiting for approval or user input.

The delegation request is the queue-owned reservation point. It also rejects a second open
delegation for the same target, so concurrent Kanban and mesh callers cannot both pass a stale
availability check.

An interrupt carries the exact turn ID observed by the caller. The decider rejects it if the target
has moved to another turn before dispatch.

## Bot profiles

A bot profile belongs to exactly one thread; the thread ID is the bot's address and canonical
inbox. This deliberately avoids a second identity registry. A profile has a display name,
description, revision, and timestamps. Configuration uses compare-and-swap revisions so two
clients cannot silently overwrite one another.

Only an active thread with a distinct worktree can become a bot. Two active bots cannot claim the
same normalized worktree. An active bot inbox cannot be archived or deleted until its profile is
disabled; disabling preserves the thread, history, and worktree.

The profile is stored on the thread projection and travels with normal shell snapshots, so local,
remote, relay, web, desktop, and mobile clients share the same state. `agents_list` accepts
`onlyBots` and includes profile metadata in results. Sends still target the underlying thread and
therefore keep every agent-mesh authorization and workspace invariant above.

Kanban cards may name bot inboxes as assignees. A Ready assignment creates the same delegation
aggregate and starts through the same thread path, preserving the authorization, exclusivity, and
workspace invariants above.
