# Agent mesh architecture

Agent mesh is a capability-gated MCP view over existing durable threads. It does not introduce a
second agent registry, broker, queue, or persistence model.

## Boundaries

`AgentMesh` resolves the caller from its provider-scoped MCP credential. Reads use
`ProjectionSnapshotQuery` and are restricted to the caller's project. Mutations go only through
`OrchestrationEngineService`, so command receipts, events, projections, reactors, provider routing,
and checkpoints remain authoritative.

Two internal commands represent peer mutations:

- `thread.peer-turn.start`
- `thread.peer-turn.interrupt`

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
one-turn detail window and caps assistant text. It never returns user messages.

The current Effect MCP registry has a process-wide tool catalog, so a session may discover a tool
name that its credential cannot invoke. Every handler still enforces its capability at call time.
Codex prompt construction reads the credential's preview capability directly, so mesh-only
credentials do not receive browser steering. A future transport-level catalog filter can improve
discovery without changing the authorization boundary.

## Mutation invariants

Every peer send has a bounded request ID. The source thread, target thread, operation, and request ID
produce a stable command ID, so the existing command-receipt path deduplicates retries. The visible
message also names its source thread.

The decider rejects a peer send when:

- source and target are the same thread;
- either thread or their project is unavailable, deleted, or archived;
- the threads belong to different projects;
- their effective workspaces are shared;
- the target is running, starting, queued, or waiting for approval or user input.

An interrupt carries the exact turn ID observed by the caller. The decider rejects it if the target
has moved to another turn before dispatch.

Bots may later create isolated, reusable endpoints. Kanban may later schedule work onto those
endpoints. Neither feature should bypass these orchestration invariants.
