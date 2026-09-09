import type { InvocationUsageReport } from "@t3tools/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";

type Counters = CodexSchema.V2ThreadTokenUsageUpdatedNotification["tokenUsage"]["total"];
const zero: Counters = {
  cacheWriteInputTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};
const keys = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
] as const;

/** Thread totals are snapshots. On resume, the first last-request snapshot is only a lower bound. */
export function makeCodexInvocationUsage(freshThread: boolean) {
  let latest: Counters | undefined = freshThread ? zero : undefined;
  let completed: { turnId: string; report: InvocationUsageReport | undefined } | undefined;
  let active:
    | {
        turnId: string;
        baseline: Counters | undefined;
        seen: boolean;
        partial: boolean;
        invalid: boolean;
      }
    | undefined;
  return {
    start(turnId: string) {
      if (active?.turnId === turnId || completed?.turnId === turnId) return;
      completed = undefined;
      active = {
        turnId,
        baseline: latest,
        seen: false,
        partial: latest === undefined,
        invalid: false,
      };
    },
    update(payload: CodexSchema.V2ThreadTokenUsageUpdatedNotification) {
      if (active && active.turnId !== payload.turnId) return;
      const total = payload.tokenUsage.total;
      const valid =
        keys.every((key) => Number.isSafeInteger(total[key]) && total[key] >= 0) &&
        total.cachedInputTokens <= total.inputTokens &&
        total.reasoningOutputTokens <= total.outputTokens;
      if (!valid) {
        if (active) active.invalid = true;
        return;
      }
      if (active) {
        active.seen = true;
        const previous = latest;
        if (previous && keys.some((key) => total[key] < previous[key])) active.invalid = true;
        if (!active.baseline) {
          const last = payload.tokenUsage.last;
          if (
            keys.some(
              (key) => !Number.isSafeInteger(last[key]) || last[key] < 0 || last[key] > total[key],
            )
          ) {
            active.invalid = true;
          } else {
            active.baseline = {
              ...(total.cacheWriteInputTokens !== undefined &&
              last.cacheWriteInputTokens !== undefined &&
              Number.isSafeInteger(total.cacheWriteInputTokens) &&
              Number.isSafeInteger(last.cacheWriteInputTokens) &&
              last.cacheWriteInputTokens >= 0 &&
              total.cacheWriteInputTokens >= last.cacheWriteInputTokens
                ? {
                    cacheWriteInputTokens: total.cacheWriteInputTokens - last.cacheWriteInputTokens,
                  }
                : {}),
              inputTokens: total.inputTokens - last.inputTokens,
              cachedInputTokens: total.cachedInputTokens - last.cachedInputTokens,
              outputTokens: total.outputTokens - last.outputTokens,
              reasoningOutputTokens: total.reasoningOutputTokens - last.reasoningOutputTokens,
              totalTokens: total.totalTokens - last.totalTokens,
            };
          }
        }
      }
      latest = total;
    },
    complete(turnId: string, failed: boolean): InvocationUsageReport | undefined {
      if (!active || active.turnId !== turnId)
        return completed?.turnId === turnId ? completed.report : undefined;
      const turn = active;
      active = undefined;
      if (!turn.seen || !latest) {
        latest = undefined;
        completed = { turnId, report: undefined };
        return undefined;
      }
      const current = latest;
      const baseline = turn.baseline;
      const delta = (key: (typeof keys)[number]): number | null =>
        turn.invalid || !baseline ? null : current[key] - baseline[key];
      const report: InvocationUsageReport = {
        source: "codex/thread.tokenUsage.delta",
        attribution: "reportingWindow",
        completeness: failed || turn.partial || turn.invalid ? "partial" : "reported",
        nativeSubagentUsage: "unknown",
        models: [
          {
            // Notifications carry no executed model. Configured/requested models cannot identify these tokens.
            model: null,
            inputTokens: delta("inputTokens"),
            cachedInputTokens: delta("cachedInputTokens"),
            outputTokens: delta("outputTokens"),
            reasoningTokens: delta("reasoningOutputTokens"),
            cacheCreationTokens:
              !turn.invalid &&
              baseline?.cacheWriteInputTokens !== undefined &&
              current.cacheWriteInputTokens !== undefined &&
              Number.isSafeInteger(current.cacheWriteInputTokens) &&
              current.cacheWriteInputTokens >= baseline.cacheWriteInputTokens
                ? current.cacheWriteInputTokens - baseline.cacheWriteInputTokens
                : null,
            costUsd: null,
          },
        ],
      };
      if (turn.invalid || failed) latest = undefined;
      completed = { turnId, report };
      return report;
    },
  };
}
