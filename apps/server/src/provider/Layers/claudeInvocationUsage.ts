import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { InvocationModelUsage, InvocationUsageReport } from "@t3tools/contracts";

function counter(value: number | undefined): number | null {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Streaming modelUsage is cumulative within query(), including native children. */
export function makeClaudeInvocationUsage() {
  let sessionId: string | undefined;
  let previous = new Map<string, InvocationModelUsage>();
  let baselineMissing = false;

  return {
    missing() {
      baselineMissing = true;
    },
    result(
      result: Pick<SDKResultMessage, "session_id" | "modelUsage"> & {
        usage?: Pick<
          SDKResultMessage["usage"],
          | "input_tokens"
          | "output_tokens"
          | "cache_read_input_tokens"
          | "cache_creation_input_tokens"
        >;
      },
      partial: boolean,
    ): InvocationUsageReport | undefined {
      if (sessionId !== result.session_id) {
        previous = new Map();
        if (sessionId !== undefined) baselineMissing = false;
        sessionId = result.session_id;
      }
      const entries = Object.entries(result.modelUsage ?? {});
      if (entries.length === 0) {
        // A missing result must not be charged to the next turn.
        baselineMissing = true;
        if (!result.usage) return undefined;
        const input = counter(result.usage.input_tokens);
        const read = counter(result.usage.cache_read_input_tokens);
        const write = counter(result.usage.cache_creation_input_tokens);
        const output = counter(result.usage.output_tokens);
        return {
          source: "claude/result.usage",
          attribution: "turn",
          completeness:
            partial || input === null || read === null || write === null || output === null
              ? "partial"
              : "reported",
          nativeSubagentUsage: "excluded",
          models: [
            {
              model: null,
              inputTokens:
                input !== null && read !== null && write !== null
                  ? counter(input + read + write)
                  : null,
              cachedInputTokens: read,
              cacheCreationTokens: write,
              outputTokens: output,
              reasoningTokens: null,
              costUsd: null,
            },
          ],
        };
      }
      const models: InvocationModelUsage[] = [];
      let incomplete = partial || baselineMissing;
      let regressed = false;
      for (const [model, usage] of entries) {
        const observedModel = model.trim();
        const modelIdentity =
          observedModel.length > 0 && observedModel.length <= 256 ? observedModel : null;
        const input = counter(usage.inputTokens);
        const read = counter(usage.cacheReadInputTokens);
        const write = counter(usage.cacheCreationInputTokens);
        const current: InvocationModelUsage = {
          model: modelIdentity,
          inputTokens:
            input !== null && read !== null && write !== null
              ? counter(input + read + write)
              : null,
          outputTokens: counter(usage.outputTokens),
          cachedInputTokens: read,
          cacheCreationTokens: write,
          reasoningTokens: null,
          costUsd: Number.isFinite(usage.costUSD) && usage.costUSD >= 0 ? usage.costUSD : null,
        };
        const before = previous.get(model);
        const delta = (key: Exclude<keyof InvocationModelUsage, "model">): number | null => {
          const value = current[key];
          const prior = before ? before[key] : 0;
          if (value !== null && prior !== null && value < prior) regressed = true;
          if (baselineMissing || value === null || prior === null || value < prior) {
            if (key !== "reasoningTokens") incomplete = true;
            return null;
          }
          return value - prior;
        };
        const row: InvocationModelUsage = {
          model: modelIdentity,
          inputTokens: delta("inputTokens"),
          outputTokens: delta("outputTokens"),
          cachedInputTokens: delta("cachedInputTokens"),
          cacheCreationTokens: delta("cacheCreationTokens"),
          reasoningTokens: null,
          costUsd: delta("costUsd"),
        };
        previous.set(model, current);
        // Historical models with an unchanged cumulative snapshot did no work this turn.
        if (
          !before ||
          row.inputTokens === null ||
          row.outputTokens === null ||
          Object.entries(row).some(
            ([key, value]) => key !== "model" && value !== null && value !== 0,
          )
        ) {
          models.push(row);
        }
      }
      baselineMissing = regressed;
      if (models.length === 0) return undefined;
      return {
        source: "claude/result.modelUsage.delta",
        attribution: "reportingWindow",
        completeness: incomplete || models.length > 100 ? "partial" : "reported",
        nativeSubagentUsage: "included",
        models: models.slice(0, 100),
      };
    },
  };
}
