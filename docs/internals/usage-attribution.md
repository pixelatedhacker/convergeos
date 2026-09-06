# Usage attribution

The transcript-backed `UsageService` owns historical environment totals. `DelegationUsageService`
answers a different question: what usage did the provider report alongside this delegated turn?
The two datasets overlap. They are never merged or summed by the new service.

## Capture and persistence

Adapters attach `InvocationUsageReport` to `turn.completed`, or to an interrupted OpenCode turn's
`turn.aborted` event when completed step counters survive. Ingestion saves the measurement as
`invocation.usage`, with a stable thread-and-turn activity ID. Start and terminal metadata are
separate activities. A repeated terminal event without counters cannot erase a known measurement.
A repeated measurement replaces its snapshot instead of incrementing a counter.
Start and terminal markers retain the earliest observed timestamps, so replays do not inflate or
shrink the recorded duration.

Normal orchestration persistence and projection replay retain these records. The MCP query reads
only the indexed start, terminal and measurement rows for the exact delegated turn, then returns
schema-validated metadata. Missing records remain unavailable; malformed records fail the read.
A completion receipt can precede usage projection, so a missing report is retryable.

`providerInstanceId` is captured from the runtime event, not the worker's current settings.
Models come from provider observations. The schema does not promote a requested model into an
observed model. Native provider session IDs are not currently retained in this report; the durable
ConvergeOS thread, turn, and provider instance identify the invocation.

## Provider semantics

| Provider                       | Measurement                                                   | Attribution and limits                                                                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude                         | Differences between cumulative streaming `modelUsage` reports | `reportingWindow`; includes native child usage. Query/session resets, missing results, and regressed counters break the baseline. Background child work can cross prompt boundaries.                                                                 |
| Claude fallback                | Per-turn main-loop result `usage`                             | `turn`; excludes native children, model unknown.                                                                                                                                                                                                     |
| Codex                          | Differences in cumulative thread token snapshots              | `reportingWindow`; executed model and native child inclusion unknown. First resumed turn without a baseline uses a partial last-request lower bound. Missing/invalid/failed turns invalidate the next baseline.                                      |
| OpenCode                       | Completed `step-finish` parts, keyed by part ID               | `turn`; observed assistant provider/model, filters accepted prompt IDs and session ID, excludes native child sessions. Replayed parts replace prior values. Failures, cancellation, stream gaps and unresolved message headers mark results partial. |
| Cursor, Grok, OMP, Antigravity | No normalized invocation report                               | ACP context occupancy is not consumed tokens. Generated ACP response documentation conflicts about turn/session scope. Antigravity CLI cache/thinking subset semantics remain unverified. Existing history and quota collectors are unchanged.       |

Claude semantics follow the [SDK cost tracking documentation](https://code.claude.com/docs/en/agent-sdk/cost-tracking).
OpenCode uses step records because assistant message counters can describe only the latest step.
See upstream [processor](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/processor.ts)
and [session](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.ts) code.
Codex's [app-server protocol](https://developers.openai.com/codex/app-server/) separates token
notifications from rate-limit windows.

Input totals include cache reads and cache creation; output totals include reasoning. These are
subsets, not additional counters to sum. Unavailable subset counts are null. Provider cost is an
API-equivalent estimate, never actual subscription spending. Identities longer than 256 characters
become unknown; reports cap model rows at 100 and flag truncated reports partial.

## Budget consumers

Use `usage_snapshot` for the current instance's bound quota and `usage_delegations` after waiting
for a dispatched task. Keep the exact delegation ID, observed provider instance, turn, model,
completeness and attribution alongside any local budget estimate. Retry a missing terminal report
before concluding the provider did not supply one. Do not interpret an unknown counter as zero.

No aggregate total is returned because native child reports can overlap parent reports. A
`reportingWindow` report cannot prove causal cost for that delegation. Cross-provider estimates
must retain those limits and must not be added to transcript-history buckets. This change supplies
measurements; it does not reserve quota, enforce a hard budget, or establish an exchange rate from
tokens to subscription percentage.

## Verification scope

Focused tests cover cumulative snapshots, model changes, missing baselines, resets, stream gaps,
step replay, failure/cancellation, duplicate terminal events, native child exclusion, exact-turn
SQL reads, project isolation, and MCP capability/parameter validation. The persistence test uses
SQLite and the real activity projector repository. No test contacts a live account or writes to
provider credentials or the user's ConvergeOS database.

## Subscription-backed reporting coverage

Subscription-backed usage remains a product requirement beyond the normalized test coverage above.
Acceptance requires an actual subscribed invocation through each supported ConvergeOS adapter,
with the native observation matched to its persisted turn and MCP report. Synthetic SDK fixtures
prove parsing and accounting rules; they do not prove that an installed subscription-backed
provider emits the same data.

The required statistics are observed provider/model identity where available, input/output/cache
and reasoning counters, elapsed time, outcome and coverage for the parent and delegated work.
The environment should expose unavailable fields and unsupported adapters explicitly. Historical
charts must retain source identity when they gain additional harness coverage, so importing an
invocation report cannot double-count the provider transcript that already contains it.

Subscription allowance stays a separate read of fresh provider windows and reset times. Prefer
native account-bound observations where a provider exposes them; keep the current optional
CodexBar collector and label ambiguous account bindings. Stable account identity and shared-account
coordination are prerequisites for an account-wide reservation system. A response-scoped quota
subject ID, requested model, token-price estimate, or before/after percentage difference cannot
stand in for that evidence.

The remaining gaps are real subscription-path verification, verified actual-model attribution
when usage notifications omit it, native child accounting, and normalized invocation reporting for
Cursor, Grok, OMP and Antigravity. The task budget gate must remain useful with those gaps present.
