# Signed agent-mesh receipts over Nostr

Outbound, signed export of delegated-work history to one private Nostr relay per
environment. ConvergeOS orchestration and its persisted events stay
authoritative for execution; the relay only carries signed, verifiable records
of what already happened. Remote action requests (inbound dispatch driven by
relay messages) are a separate, unbuilt phase and grant nothing today: receipt
publication carries no execution permission.

## What ships today

- A versioned receipt contract in `packages/contracts/src/meshReceipt.ts`
  (protocol `convergeos.mesh`, version 2) with a closed union of receipt types.
- An environment-owned signing key (secp256k1, BIP-340 Schnorr — the Nostr
  requirement) stored in server secret storage. The signature means "this
  environment recorded this event for this agent"; it does not claim the agent
  holds a key or that any external action succeeded.
- A durable outbox in the environment database (migration 054): export state,
  per-project stream chains, signed-event outbox, signer enrollment, and
  content-addressed artifact retention.
- A background export worker (`apps/server/src/mesh/MeshReceiptExportReactor.ts`)
  that replays committed source events through a durable cursor and publishes
  exact signed bytes until the relay acknowledges them.
- `t3 mesh-export enable|disable|status|resume|discard` to control it.

The feature is disabled until `t3 mesh-export enable <relay-url>` writes its
secrets. Disabling pauses capture and publication at a recorded stop watermark;
pending signed receipts remain retained with publication paused. Re-enabling starts a new
capture epoch from the current watermark. Historical epochs require an explicit resume
against their original relay. Discarding an epoch retains its records but disables publication.

## Receipt contract

Version 2 makes causal gaps and terminal requester/worker attribution explicit.
Legacy version 1 signatures and bytes remain retained unchanged. The version 2
codec rejects version 1 records instead of interpreting them under the new schema.

Every receipt is one signed Nostr event (kind 9901, a regular stored kind,
unassigned in the kind registry as of 2026-09; pinned in
`apps/server/src/mesh/nostr.ts`). The versioned contract lives in the event
`content`; a `t` tag carries the `convergeos.mesh` discriminator and an `e` tag
references the previous event in the stream. Application schemas remain
mandatory even though the numeric kind is pinned: transport acceptance never
implies contract validity.

The union currently contains exactly the types with implemented, tested source
mappings:

| Receipt type          | Source event                                        | Meaning                                                                                                                                                    |
| --------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delegation.accepted` | `delegation.requested`                              | The queue-owned reservation: requester delegated work to a worker. Kanban-requested delegations are intentionally excluded (no agent thread to attribute). |
| `turn.started`        | `thread.turn-start-requested`                       | A turn was requested on a thread.                                                                                                                          |
| `artifact.available`  | `thread.message-sent` (assistant completion)        | Reconstructs message bytes through the completion sequence; bytes stay local and the receipt carries their SHA-256 digest.                                 |
| `delegation.terminal` | `delegation.completed` / `.failed` / `.interrupted` | Terminal state with requester and worker identities; worker turn IDs belong to the worker thread.                                                          |

Evidence class is `runtime-observed` throughout: ConvergeOS directly observed
these lifecycle facts. `provider-reported` and `agent-claimed` exist in the
evidence enum but nothing emits them; tool evidence and verifier assessments
wait for per-provider mappings and must not be inferred from prose. Unknown
discriminators, versions, and protocols fail contract decoding.

## Attribution and identity

- The agent address is the existing thread id, qualified by the issuing
  environment id (`issuerEnvironmentId`) — two environments with overlapping
  local ids never merge.
- `keyId` (`mk_<first 16 hex of the public key>`) resolves against the
  `mesh_signer_keys` enrollment table, which lives outside the signed event.
  Historical keys stay listed across rotation with `revoked_at` separate from
  signature validity.
- Each receipt cites its exact source record (`sourceEventId`,
  `sourceSequence` — local to the issuing database) and the actual origin-qualified
  `cause`, or null when no causation was recorded. Missing source events retain
  their original ID with an unresolved sequence. `occurredAt` is observation time; `recordedAt` is durable recording
  time and pins the Nostr `created_at`, so retries resend byte-identical
  events.
- Output artifacts are referenced by SHA-256, byte length, media type, and
  completeness (`complete` / `truncated` / `unavailable`). Bytes are stored
  once, content-addressed, in `mesh_artifacts`. An authenticated retrieval
  endpoint and retention controls remain unbuilt. Receipt references contain
  neither bearer URLs nor filesystem paths.

## Export mechanics

One export stream per (capture epoch, project). Stream sequence numbers are
contiguous after filtering: allowlisted-but-unattributable events (for example
a thread deleted before export) are intentional exclusions and leave no gap.
Capture commits signing, outbox insertion, stream-chain advancement, and cursor
advancement in one local transaction, including when filtering produces no receipts, so a crash before the commit replays the
source events and a crash after publication but before acknowledgement resends
the same event id. Uniqueness on (epoch, receipt type, source event) keeps one
stable logical receipt per business action.

Relay acknowledgement (NIP-01 `OK`) is only a transport milestone: it is not
recipient delivery, action acceptance, or action completion. Transient
failures retry with bounded backoff and at most four publications in flight;
explicit relay rejections are retained with their reason. Malformed acknowledgements
do not change delivery state. The worker drains available batches immediately;
the timer wakes delayed retries and checks configuration. Persistence failures
end the current drain and retain its source or publication state for recovery. Local execution
never waits on the relay, and capture pauses without advancing its cursor when
the pending backlog exceeds the configured quota (`mesh-receipt-quota-bytes`
secret, default 8 MiB). Batch sizes: at most 100 source events per sweep,
signed events capped at 32 KiB — receipt payloads are bounded upstream, and
identity fields are never truncated to fit.

The codec separately exposes signature verification (`verifyNostrEvent`) and
content decoding (`decodeMeshReceiptContent`). Enrollment and project authorization
checks, stream checkpoints, completeness boundaries, and trace display remain
part of the unbuilt verified reader. A relay can omit an unseen tail, so a locally consistent chain
alone never means all work is accounted for.

## Operations

- `t3 mesh-export enable <relay-url>` records a new capture epoch and current source watermark in SQLite.
- `t3 mesh-export disable` immediately pauses capture and all publication epochs in SQLite.
- `t3 mesh-export status` lists each epoch's publication state and pending and rejected counts.
- `t3 mesh-export resume <epoch>` authorizes a paused epoch against the configured original relay.
- `t3 mesh-export discard <epoch>` retains records but removes that paused epoch's publication permission.

SQLite owns capture and publication state. Secrets provide enablement and the relay URL.
The worker requires both to agree, so a configuration change cannot redirect existing
records. Migration 055 pauses legacy epochs whose destination was never recorded.
Their records remain available for inspection and discard, but cannot be resumed
without a known original destination.

The pending quota counts publication-enabled epochs. Raising `mesh-receipt-quota-bytes`
resumes capture without starting a new epoch. Paused historical records remain on disk
but do not consume the active backlog quota. The environment descriptor capability
`agentMeshReceiptExport` reports support for export controls. Use CLI status for
live capture and publication state.

After restoring a database snapshot, explicitly enable a fresh capture epoch before
resuming export. Restore detection is not automatic. Source records are a retention
dependency. Message reconstruction reads only the relevant thread incarnation through
the source completion sequence, so later updates do not change old output evidence.

## Deliberately not built yet

- Verified receipt queries, stream checkpoints, trace display, and artifact
  retrieval endpoints (next phase, with web/desktop/mobile surfaces).
- Remote action requests: durable inbox, authorization, and dispatch. Incoming
  events must stay inert until that phase ships.
- Per-provider tool evidence and verifier assessment receipts.
- Public discovery, federation, and per-token relay streaming: one explicitly
  configured private relay per environment is the whole transport surface.

## Delegated worker liveness

`AgentLiveness` is a separate, expiring Nostr channel (kind `9902`, protocol
`convergeos.liveness.v1`). It uses the existing export-enabled flag, private relay
URL, active export epoch/destination binding, and enrolled environment signer.
Nothing enables it or changes live relay configuration automatically.

A background sampler observes up to 64 locally owned thread delegations. It
checks `ProviderService.listSessions()` for a running runtime session with the
exact worker thread and turn; persisted `running` state or a `turn.started`
receipt alone is insufficient. Pending approval or input becomes `waiting` only
while that matching runtime is present. Missing runtime means `unknown`, not
failed. Terminal delegation state is authoritative for that exact turn. A
separate `providerActivityAt` records the last locally received, turn-tagged
provider runtime event. It stays null until observed and is not refreshed by a
heartbeat. A running runtime may still be stuck; these are host observations,
not proof of ongoing model inference or tool progress.

Unchanged observations publish on a 30-second schedule; relevant runtime and
delegation transitions also request a sample, coalesced to one pending sweep.
Per-delegation publication is limited to once a second for transitions. There
are at most four concurrent publications, each with a one-second timeout, so a
64-item sweep cannot queue work beyond its 90-second validity window. The timer
waits for the preceding sweep to drain: a slow relay can extend the interval to
about 46 seconds. Excess delegations can remain unobserved while the first 64
remain active. Parents must treat those absent observations as unknown.

Liveness has no durable publication backlog. Failed live observations are
replaced by a new host sample on a later sweep. Terminal publication failures
retry while the terminal change is less than 90 seconds old; accepted terminal
publications stop. The original observation and expiry are signed and never
rewritten on delivery. Relay acceptance is only an acknowledgement; it cannot
populate the parent-side receipt cache.

`agents_liveness` requires `agents.read` and accepts one to eight delegation IDs.
The credential caller must own each delegation and share its project. A bounded
NIP-01 historical subscription receives at most 64 events (128 frames/256 KiB,
4 KiB per event, two-second timeout). Only one query can be active, and new
queries are limited to one per second per environment. Busy or rate-limited
reads report `unavailable` and can return previously verified observations.
The reader verifies NIP-01 hash/signature, active signer enrollment, environment,
export epoch, destination digest, project, parent, worker, turn, sequence,
observation time and expiry. It accepts only locally known delegations issued
by this environment; this adds no federation or remote dispatch authority.

The bounded cache distinguishes `fresh`, `stale` (previously verified but
expired), and `unknown` (no usable observation). Lower-sequence/older observations
cannot replace newer ones, and a terminal observation cannot be revived within
the same turn. Current local terminal state rejects incompatible cached running
observations. Disabled export, epoch/destination changes and revoked signer keys
invalidate usable cached observations. Restart loses this optional cache; recent
signed observations can be queried again while valid.

Routine heartbeats neither create orchestration events nor wake a parent model.
They contain no prompt, output delta, tool argument, or usage counter. Parents
explicitly read liveness as needed; `agents_wait` continues to handle normal
completion and attention. Relay outages never block local execution, and silence
never proves failure or successful cancellation. Heartbeats do not extend task
budgets or deadlines.
