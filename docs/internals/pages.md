# Pages architecture

Pages are durable homes for generated websites, interactive reports, and small
tools that an agent produced during a turn. A page is a saved result that keeps
working while agents come and go: the environment stores and serves the
document independently of the producing bot's process and working directory.
A page belongs to one environment and, optionally, to one project. Pages with
no project are *Unfiled* and can be assigned to a project later.

## Domain model

A `Page` carries an optional project ID, title, kind (`htmlDocument` or
`hostedUrl`), an optional source-thread reference (provenance: the
conversation that produced it), an optional maintainer-thread reference, the
current content revision ID and number, a separate metadata revision number,
and timestamps. Archive is reversible: `archivedAt` hides a page from active
lists and blocks new publications without destroying content or history.

Metadata and content revisions are separate counters so renaming a page cannot
silently change its content history. A `PageRevision` is immutable: it records
its predecessor, a content reference, an optional data timestamp supplied by
the author (distinct from the acceptance time), the author (client or thread),
and the acceptance time. History is never rewritten — restoring an older
revision appends a new publication pointing at the retained content.

Two content kinds exist:

- **Managed HTML** references immutable, content-addressed bytes. Inline
  JavaScript, CSS, and embedded data are allowed; managed documents are
  self-contained.
- **Hosted URL** is an explicit reference to an external site with no
  durability guarantee. ConvergeOS never fetches it server-side. Loopback and
  localhost targets are rejected: they are dev-server links, not portable
  saved pages.

## Storage and publication

Migration 055 creates `projection_pages` and `projection_page_revisions`.
Document bytes live under `<userdata>/pages/blobs/<digest[0:2]>/<digest>`
(sha-256 of the UTF-8 document), written by
[`pageContentStore.ts`][pageContentStore]. Staging is idempotent: identical
bytes resolve to the same digest, and a dispatch that fails after staging only
leaves a collectible orphan blob.

Publication is a two-phase boundary. Inline HTML submitted by a client is
staged into owned storage by `normalizeDispatchCommand` — the single funnel
for client commands from WebSocket and HTTP — which swaps the inline document
for a digest reference before the command is decided. The pure decider handles
references and concurrency; the effectful boundary handles file I/O. Persisted
events therefore never carry document bodies, and pages never depend on
worktree files or temporary servers.

Mutations use the standard orchestration guarantees: stable command IDs give
identical-retry deduplication, `page.publish` requires the observed base
revision ID so two writers against the same base cannot overwrite each other
(the loser receives a revision conflict), and metadata commands carry
`expectedMetadataRevision`. A failed publication never replaces the current
revision. Limits: 10 MiB per document, advertised to clients and agents
through the `pages` environment capability (`maxDocumentBytes`).

Project deletion archives its project's pages in the same command fan-out that
deletes threads; pages never block deletion and Unfiled pages are untouched.
Moving a page between projects clears its maintainer so a bot never keeps a
page outside its own project.

## Queries

`orchestration.listPages`, `orchestration.getPage`, and
`orchestration.getPageContent` are read-scope WebSocket RPCs. Lists return
summaries only (project filter, archive filter, bounded limit); document bytes
are fetched only when a page opens, through `getPageContent`, which resolves
the current revision's digest from the projection and reads the blob from
owned storage. The command read model hydrates pages and revisions from the
same projection tables, so decisions (including restore-revision validation)
survive restarts.

## Later work

MCP management (`pages_read`/`pages_write` and capability issuance), bot
maintenance attempts and schedules, dashboard pins, and the isolated viewer
are separate units of the same feature and are not implemented yet.
