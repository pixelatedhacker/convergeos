/**
 * Live subscription allowance telemetry.
 *
 * This is intentionally separate from `UsageSummary`, which describes
 * transcript-derived activity and API-equivalent cost. Quota observations are
 * volatile, may be stale, and may not be attributable to one configured
 * provider instance.
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const SUBSCRIPTION_QUOTA_CONTRACT_VERSION = 1 as const;

export const SubscriptionQuotaPercent = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: 100 }),
);
export type SubscriptionQuotaPercent = typeof SubscriptionQuotaPercent.Type;

export const SubscriptionQuotaBinding = Schema.Struct({
  status: Schema.Literals(["exact", "driverOnly", "unbound"]),
  providerInstanceIds: Schema.Array(ProviderInstanceId),
});
export type SubscriptionQuotaBinding = typeof SubscriptionQuotaBinding.Type;

export const SubscriptionQuotaWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  usedPercent: Schema.NullOr(SubscriptionQuotaPercent),
  resetsAt: Schema.NullOr(IsoDateTime),
  synthetic: Schema.Boolean,
});
export type SubscriptionQuotaWindow = typeof SubscriptionQuotaWindow.Type;

export const SubscriptionQuotaWarning = Schema.Struct({
  kind: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
});
export type SubscriptionQuotaWarning = typeof SubscriptionQuotaWarning.Type;

export const SubscriptionQuotaSubject = Schema.Struct({
  /** Opaque within this response. Collectors need not promise stable account IDs. */
  subjectId: TrimmedNonEmptyString,
  provider: ProviderDriverKind,
  binding: SubscriptionQuotaBinding,
  source: Schema.Struct({
    collectorId: TrimmedNonEmptyString,
    transport: Schema.Literals(["providerEvent", "cli", "api", "web", "local"]),
    reportedSource: Schema.NullOr(TrimmedNonEmptyString),
  }),
  status: Schema.Literals(["fresh", "stale", "unavailable", "failed"]),
  plan: Schema.NullOr(TrimmedNonEmptyString),
  /** Already redacted by the collector. MCP removes even this presentation label. */
  accountLabel: Schema.NullOr(TrimmedNonEmptyString),
  observedAt: Schema.NullOr(IsoDateTime),
  staleAt: Schema.NullOr(IsoDateTime),
  windows: Schema.Array(SubscriptionQuotaWindow),
  credits: Schema.NullOr(
    Schema.Struct({
      remaining: Schema.Number,
      currency: Schema.NullOr(TrimmedNonEmptyString),
    }),
  ),
  warning: Schema.NullOr(SubscriptionQuotaWarning),
});
export type SubscriptionQuotaSubject = typeof SubscriptionQuotaSubject.Type;

export const SubscriptionQuotaCollector = Schema.Struct({
  collectorId: TrimmedNonEmptyString,
  status: Schema.Literals(["ok", "missing", "failed"]),
  attemptedAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
});
export type SubscriptionQuotaCollector = typeof SubscriptionQuotaCollector.Type;

export const SubscriptionQuotaReadInput = Schema.Struct({});
export type SubscriptionQuotaReadInput = typeof SubscriptionQuotaReadInput.Type;

export const SubscriptionQuotaReport = Schema.Struct({
  contractVersion: Schema.Literal(SUBSCRIPTION_QUOTA_CONTRACT_VERSION),
  environmentId: EnvironmentId,
  readAt: IsoDateTime,
  subjects: Schema.Array(SubscriptionQuotaSubject),
  collectors: Schema.Array(SubscriptionQuotaCollector),
});
export type SubscriptionQuotaReport = typeof SubscriptionQuotaReport.Type;

export const SubscriptionQuotaScopedReport = Schema.Struct({
  contractVersion: Schema.Literal(SUBSCRIPTION_QUOTA_CONTRACT_VERSION),
  environmentId: EnvironmentId,
  providerInstanceId: ProviderInstanceId,
  readAt: IsoDateTime,
  subjects: Schema.Array(SubscriptionQuotaSubject),
  collectors: Schema.Array(SubscriptionQuotaCollector),
});
export type SubscriptionQuotaScopedReport = typeof SubscriptionQuotaScopedReport.Type;

export class SubscriptionQuotaMcpUnavailableError extends Schema.TaggedError<SubscriptionQuotaMcpUnavailableError>()(
  "SubscriptionQuotaMcpUnavailableError",
  {
    capability: Schema.Literal("usage.read"),
    environmentId: EnvironmentId,
    threadId: ThreadId,
    providerSessionId: TrimmedNonEmptyString,
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `MCP credential does not grant the ${this.capability} capability.`;
  }
}

export const subscriptionQuotaRemainingPercent = (
  usedPercent: SubscriptionQuotaPercent | null,
): number | null => (usedPercent === null ? null : 100 - usedPercent);
