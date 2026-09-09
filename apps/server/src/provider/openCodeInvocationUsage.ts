import type { AssistantMessage, StepFinishPart } from "@opencode-ai/sdk/v2";
import type { InvocationModelUsage, InvocationUsageReport } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const StepUsage = Schema.Struct({
  id: Schema.NonEmptyString,
  messageID: Schema.NonEmptyString,
  sessionID: Schema.NonEmptyString,
  cost: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  tokens: Schema.Struct({
    input: Count,
    output: Count,
    reasoning: Count,
    cache: Schema.Struct({ read: Count, write: Count }),
  }),
});
const decodeStepUsage = Schema.decodeUnknownOption(StepUsage);

/** Tracks only steps belonging to this turn's prompts, including steering prompts. */
export class OpenCodeInvocationUsage {
  private readonly prompts = new Set<string>();
  private readonly messages = new Map<string, { model: string | null; failed: boolean }>();
  private readonly steps = new Map<string, typeof StepUsage.Type>();
  private invalidReport = false;

  private readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  startPrompt(messageId: string, steering: boolean) {
    if (!steering) {
      this.prompts.clear();
      this.messages.clear();
      this.steps.clear();
      this.invalidReport = false;
    }
    this.prompts.add(messageId);
  }

  markPartial() {
    this.invalidReport = true;
  }

  observeMessage(message: AssistantMessage) {
    if (message.sessionID !== this.sessionId || !this.prompts.has(message.parentID)) return;
    const provider = message.providerID?.trim();
    const model = message.modelID?.trim();
    const identity = model ? (provider ? `${provider}/${model}` : model) : null;
    this.messages.set(message.id, {
      model: identity !== null && identity.length <= 256 ? identity : null,
      failed: message.error !== undefined,
    });
  }

  observeStep(step: StepFinishPart) {
    if (step.sessionID !== this.sessionId) return;
    const decoded = decodeStepUsage(step);
    if (Option.isNone(decoded)) {
      this.invalidReport = true;
      return;
    }
    this.steps.set(step.id, decoded.value);
  }

  report(failed: boolean): InvocationUsageReport | undefined {
    const models = new Map<string | null, InvocationModelUsage>();
    let partial = failed || this.invalidReport;
    for (const step of this.steps.values()) {
      const message = this.messages.get(step.messageID);
      if (!message) {
        partial = true;
        continue;
      }
      partial ||= message.failed;
      const previous = models.get(message.model);
      // OpenCode stores non-cached input and visible output separately from these subsets.
      const usage = {
        model: message.model,
        inputTokens:
          (previous?.inputTokens ?? 0) +
          step.tokens.input +
          step.tokens.cache.read +
          step.tokens.cache.write,
        outputTokens: (previous?.outputTokens ?? 0) + step.tokens.output + step.tokens.reasoning,
        cachedInputTokens: (previous?.cachedInputTokens ?? 0) + step.tokens.cache.read,
        cacheCreationTokens: (previous?.cacheCreationTokens ?? 0) + step.tokens.cache.write,
        reasoningTokens: (previous?.reasoningTokens ?? 0) + step.tokens.reasoning,
        costUsd: (previous?.costUsd ?? 0) + step.cost,
      } satisfies InvocationModelUsage;
      models.set(message.model, usage);
    }
    if (models.size === 0) return undefined;
    return {
      source: "opencode.step-finish",
      attribution: "turn",
      completeness: partial || models.size > 100 ? "partial" : "reported",
      nativeSubagentUsage: "excluded",
      models: [...models.values()].slice(0, 100),
    };
  }
}
