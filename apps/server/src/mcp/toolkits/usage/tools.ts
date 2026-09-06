import * as DelegationUsageService from "../../../usage/DelegationUsageService.ts";
import {
  DelegationUsageInput,
  DelegationUsageResult,
  DelegationUsageError,
  SubscriptionQuotaMcpUnavailableError,
  SubscriptionQuotaScopedReport,
  UsageReadError,
  UsageMcpSummary,
  UsageSummaryInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as SubscriptionQuotaService from "../../../subscriptionQuota/SubscriptionQuotaService.ts";
import * as ProviderInstanceRegistry from "../../../provider/Services/ProviderInstanceRegistry.ts";
import * as UsageService from "../../../usage/UsageService.ts";

export const UsageSnapshotTool = Tool.make("usage_snapshot", {
  description:
    "Read live subscription quota for this agent's provider instance. Returns only quota subjects that can be safely bound to the current instance, with account labels removed.",
  parameters: Schema.Struct({}),
  success: SubscriptionQuotaScopedReport,
  failure: SubscriptionQuotaMcpUnavailableError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    SubscriptionQuotaService.SubscriptionQuotaService,
    ProviderInstanceRegistry.ProviderInstanceRegistry,
  ],
})
  .annotate(Tool.Title, "Read subscription quota")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const UsageSummaryTool = Tool.make("usage_summary", {
  description:
    "Read transcript-backed historical token usage and API-equivalent cost for this environment. This is separate from subscription quota and never returns raw transcript content.",
  parameters: UsageSummaryInput,
  success: UsageMcpSummary,
  failure: Schema.Union([UsageReadError, SubscriptionQuotaMcpUnavailableError]),
  dependencies: [McpInvocationContext.McpInvocationContext, UsageService.UsageService],
})
  .annotate(Tool.Title, "Read usage history")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const DelegationUsageTool = Tool.make("usage_delegations", {
  description:
    "Read saved provider usage for up to eight delegation IDs in this project. Use after agents_wait; retry when usage is not yet recorded. Results link requester, worker and completion turn. reportingWindow attribution can include background work from earlier turns. Null reports/counters/models mean unknown, never zero. Input includes cache and output includes reasoning. A null report can also mean usage persistence has not caught up with completion yet. These reports may include native subagents: do not add native child-task totals or transcript history to them. Cost is provider-reported API-equivalent cost, not subscription spending; live quota is separate in usage_snapshot.",
  parameters: DelegationUsageInput,
  success: DelegationUsageResult,
  failure: Schema.Union([DelegationUsageError, SubscriptionQuotaMcpUnavailableError]),
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    DelegationUsageService.DelegationUsageService,
  ],
})
  .annotate(Tool.Title, "Read delegated invocation usage")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const UsageToolkit = Toolkit.make(UsageSnapshotTool, UsageSummaryTool, DelegationUsageTool);
