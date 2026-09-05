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
and reset times instead of estimating spend from session transcripts. ConvergeOS can collect this data
when CodexBar is installed on the environment host. CodexBar remains optional, and a missing or
failed collector is reported as unavailable rather than as zero usage.

Connected clients can read the environment-wide quota snapshot. Agents with an active ConvergeOS MCP
session can use `usage_snapshot` to read only quota that can be safely associated with their own
provider instance. Account labels are omitted from the agent-facing result. If several configured
instances use the same provider subscription and the account cannot be proven, the quota remains
visible at environment scope but is withheld from the instance-scoped MCP tool.
