# Signed agent-mesh receipts over Nostr

Outbound, signed export of delegated-work history to one private Nostr relay per
environment. ConvergeOS orchestration and its persisted events stay
authoritative for execution; the relay only carries signed, verifiable records
of what already happened. Remote action requests (inbound dispatch driven by
relay messages) are a separate, unbuilt phase and grant nothing today: receipt
publication carries no execution permission.

## What ships today

- A versioned receipt contract in `packages/contracts/src/meshReceipt.ts`
  (protocol `convergeos.mesh`, version 1) with a closed union of receipt types.
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
- `t3 mesh-export enable|disable|status` to control it.

The feature is disabled until `t3 mesh-export enable <relay-url>` writes its
secrets. Disabling pauses capture and publication at a recorded stop watermark;
pending signed receipts are retained, never discarded. Re-enabling starts a new
capture epoch from the current watermark — no historical backfill.

## Receipt contract

Every receipt is one signed Nostr event (kind 9901, a regular stored kind,
unassigned in the kind registry as of 2026-09; pinned in
`apps/server/src/mesh/nostr.ts`). The versioned contract lives in the event
`content`; a `t` tag carries the `convergeos.mesh` discriminator and an `e` tag
references the previous event in the stream. Application schemas remain
mandatory even though the numeric kind is pinned: transport acceptance never
implies contract validity.

The union currently contains exactly the types with implemented, tested source
mappings:

| Receipt type | Source event | Meaning |
| --- | --- | --- |
| `delegation.accepted` | `delegation.requested` | The queue-owned reservation: requester delegated work to a worker. Kanban-requested delegations are intentionally excluded (no agent thread to attribute). |
| `turn.started` | `thread.turn-start-requested` | A turn was requested on a thread. |
| `artifact.available` | `thread.message-sent` (final assistant text) | Output evidence is retained and addressable by SHA-256 digest; bytes stay local. |
| `delegation.terminal` | `delegation.completed` / `.failed` / `.interrupted` | Terminal delegation state with the observed worker turn id when bound. |

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
  `sourceSequence` — local to the issuing database) and an origin-qualified
  `cause`. `occurredAt` is observation time; `recordedAt` is durable recording
  time and pins the Nostr `created_at`, so retries resend byte-identical
  events.
- Output artifacts are referenced by SHA-256, byte length, media type, and
  completeness (`complete` / `truncated` / `unavailable`). Bytes are stored
  once, content-addressed, in `mesh_artifacts`, and resolve through the
  environment with project authorization — never bearer URLs or filesystem
  paths. Retention may expire bytes without erasing receipts; readers then
  show the bytes as unavailable.

## Export mechanics

One export stream per (capture epoch, project). Stream sequence numbers are
contiguous after filtering: allowlisted-but-unattributable events (for example
a thread deleted before export) are intentional exclusions and leave no gap.
Capture commits — signing, outbox insert, stream-chain advance, cursor
advance — in one local transaction, so a crash before the commit replays the
source events and a crash after publication but before acknowledgement resends
the same event id. Uniqueness on (epoch, receipt type, source event) keeps one
stable logical receipt per business action.

Relay acknowledgement (NIP-01 `OK`) is only a transport milestone: it is not
recipient delivery, action acceptance, or action completion. Transient
failures retry with bounded backoff (at most four publications in flight);
explicit relay rejections are retained with their reason. Local execution
never waits on the relay, and capture pauses without advancing its cursor when
the pending backlog exceeds the configured quota (`mesh-receipt-quota-bytes`
secret, default 8 MiB). Batch sizes: at most 100 source events per sweep,
signed events capped at 32 KiB — receipt payloads are bounded upstream, and
identity fields are never truncated to fit.

Verified reading (signature, enrollment, schema, project authorization) exists
at the codec level (`verifyNostrEvent`, `decodeMeshReceiptContent`); stream
checkpoints, completeness boundaries, and user-facing trace display are the
next phase. A relay can omit an unseen tail, so a locally consistent chain
alone never means all work is accounted for.

## Operations

- `t3 mesh-export enable <relay-url>` — write the relay URL and enable. The
  next sweep (live or within 15 seconds) records the capture epoch and starts.
- `t3 mesh-export disable` — pause at a stop watermark; signed pending
  receipts are retained.
- `t3 mesh-export status` — show the current state.
- Quota pressure pauses capture and logs; raising
  `mesh-receipt-quota-bytes` resumes capture without a new epoch.
- The descriptor capability `agentMeshReceiptExport` advertises an enabled
  environment to clients.

Restoring an environment database from a snapshot counts as a new capture
epoch: enable again and the fresh watermark prevents sequence reuse from
looking like continuous history. Source events are the retention dependency —
export replays them, so pruning source events before capture loses those
records from the export.

## Deliberately not built yet

- Verified receipt queries, stream checkpoints, trace display, and artifact
  retrieval endpoints (next phase, with web/desktop/mobile surfaces).
- Remote action requests: durable inbox, authorization, and dispatch. Incoming
  events must stay inert until that phase ships.
- Per-provider tool evidence and verifier assessment receipts.
- Public discovery, federation, and per-token relay streaming: one explicitly
  configured private relay per environment is the whole transport surface.
