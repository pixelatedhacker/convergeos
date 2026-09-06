import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Input includes cache reads/writes; output includes reasoning. Subsets are not added again. */
export const InvocationModelUsage = Schema.Struct({
  model: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  inputTokens: Schema.NullOr(NonNegativeInt),
  outputTokens: Schema.NullOr(NonNegativeInt),
  cachedInputTokens: Schema.NullOr(NonNegativeInt),
  cacheCreationTokens: Schema.NullOr(NonNegativeInt),
  reasoningTokens: Schema.NullOr(NonNegativeInt),
  costUsd: Schema.NullOr(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
});
export type InvocationModelUsage = typeof InvocationModelUsage.Type;

/** One turn's provider report. Never combine this with native child-task or transcript totals. */
export const InvocationUsageReport = Schema.Struct({
  source: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  /** A provider reporting window can contain background child work from an earlier turn. */
  attribution: Schema.Literals(["turn", "reportingWindow"]),
  completeness: Schema.Literals(["reported", "partial"]),
  nativeSubagentUsage: Schema.Literals(["included", "excluded", "unknown"]),
  models: Schema.Array(InvocationModelUsage).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export type InvocationUsageReport = typeof InvocationUsageReport.Type;
