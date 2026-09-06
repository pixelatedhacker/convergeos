import * as DelegationUsageService from "../../../usage/DelegationUsageService.ts";
import {
  SubscriptionQuotaScopedReport,
  UsageReadError,
  type UsageMcpSummary,
  type UsageSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as SubscriptionQuotaService from "../../../subscriptionQuota/SubscriptionQuotaService.ts";
import * as ProviderInstanceRegistry from "../../../provider/Services/ProviderInstanceRegistry.ts";
import * as UsageService from "../../../usage/UsageService.ts";
import { UsageToolkit } from "./tools.ts";

export const sanitizeUsageSnapshot = (
  report: SubscriptionQuotaScopedReport,
): SubscriptionQuotaScopedReport => ({
  ...report,
  subjects: report.subjects.map((subject) => ({ ...subject, accountLabel: null })),
});

export const sanitizeUsageSummary = (summary: UsageSummary): UsageMcpSummary => ({
  ...summary,
  sources: summary.sources.map(({ fingerprint: _fingerprint, ...source }) => source),
});

export const sanitizeUsageReadError = (error: UsageReadError): UsageReadError =>
  new UsageReadError({ reason: error.reason, detail: error.detail });

const handlers = {
  usage_delegations: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.requireUsageCapability();
      const service = yield* DelegationUsageService.DelegationUsageService;
      return yield* service.read(invocation.threadId, input);
    }),
  usage_snapshot: () =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.requireUsageCapability();
      const service = yield* SubscriptionQuotaService.SubscriptionQuotaService;
      const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
      const instances = yield* registry.listInstances;
      const report = yield* service.readScoped({
        environmentId: invocation.environmentId,
        providerInstanceId: invocation.providerInstanceId,
        instances: instances.map(({ instanceId, driverKind, enabled }) => ({
          instanceId,
          driverKind,
          enabled,
        })),
      });
      return sanitizeUsageSnapshot(report);
    }),
  usage_summary: (input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireUsageCapability();
      const service = yield* UsageService.UsageService;
      return yield* service
        .readSummary(input)
        .pipe(Effect.map(sanitizeUsageSummary), Effect.mapError(sanitizeUsageReadError));
    }),
} satisfies Parameters<typeof UsageToolkit.toLayer>[0];

export const UsageToolkitHandlersLive = UsageToolkit.toLayer(handlers);
