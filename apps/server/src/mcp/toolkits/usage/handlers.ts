import type { SubscriptionQuotaScopedReport } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as SubscriptionQuotaService from "../../../subscriptionQuota/SubscriptionQuotaService.ts";
import * as ProviderInstanceRegistry from "../../../provider/Services/ProviderInstanceRegistry.ts";
import { UsageToolkit } from "./tools.ts";

export const sanitizeUsageSnapshot = (
  report: SubscriptionQuotaScopedReport,
): SubscriptionQuotaScopedReport => ({
  ...report,
  subjects: report.subjects.map((subject) => ({ ...subject, accountLabel: null })),
});

const handlers = {
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
} satisfies Parameters<typeof UsageToolkit.toLayer>[0];

export const UsageToolkitHandlersLive = UsageToolkit.toLayer(handlers);
