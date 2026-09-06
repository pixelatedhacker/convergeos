# Review usage

The Usage page combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart. Refreshing rescans every connected environment and refetches model pricing on
each of them, so a newly released model that showed $0.00 gets a price without waiting for the daily
pricing update.

## Subscription quota

Subscription quota is a separate live signal. It reports provider allowance windows, utilization,
and reset times instead of estimating spend from session transcripts. Claude Code and Codex report
their session and weekly windows while they run, and ConvergeOS keeps the latest report for each
provider instance until the server restarts; these are the same figures the provider shows in its
own usage screen. ConvergeOS can also collect quota through CodexBar when it is installed on the
environment host, which covers providers and accounts that do not report windows themselves.
CodexBar remains optional, and a missing or failed collector is reported as unavailable rather than
as zero usage.

Connected clients can read the environment-wide quota snapshot. Agents with an active ConvergeOS MCP
session can use `usage_snapshot` to read only quota that can be safely associated with their own
provider instance. Windows the provider reported itself are always associated with that instance. Account labels are omitted from the agent-facing result. If several configured
instances use the same provider subscription and the account cannot be proven, the quota remains
visible at environment scope but is withheld from the instance-scoped MCP tool.

Agents can use `usage_summary` for the same transcript-backed, pre-aggregated history shown on the
Usage page. It returns token and API-equivalent cost buckets plus source and pricing health; it does
not return transcript text, host identity, or transcript filesystem paths. Agent access to these
tools is controlled independently under
**Settings > Integrations > Agents > Agent usage access** and is off until you enable it.

## Usage for delegated work

After delegating through ConvergeOS, agents can call `usage_delegations` with the delegation IDs
returned by `agents_spawn` or `agents_send`. It returns the requester, worker, completion turn,
provider instance, outcome, elapsed time when known, and the provider's saved usage report.
The same Agent usage access setting controls this tool. It reads only delegations in the caller's
project and returns no prompts or transcript text.

Claude reports model-level input, output, cache usage, and estimated API cost. OpenCode reports
observed model usage from completed steps. Codex reports token counters; its usage notifications
do not identify the executed model, so that field remains unknown. Subscription-backed calls can
report these statistics too. Availability depends on what the provider sends.

A report marked `reportingWindow` describes changes in provider counters between observations.
Background native agents can contribute work started in an earlier turn. It is not an exact bill
for the prompt attached to that completion. A `partial` report may omit work after a stream gap,
missing baseline, failure, or cancellation. Missing values mean unknown, never zero.

Cursor, Grok, OMP, and Antigravity currently return no normalized invocation report. Their
existing usage history and quota support are unchanged. This tool does not add OpenCode to the
Usage page's historical charts.

Read `usage_snapshot` separately for subscription allowance and reset times. Do not convert
reported tokens or API-equivalent cost into a precise fraction of a subscription. Native child
usage and transcript history can overlap these reports and must not be added to them.
Usage may arrive just after completion; retry a missing report before treating it as unavailable.
