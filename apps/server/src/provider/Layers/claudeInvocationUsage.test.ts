import { describe, expect, it } from "@effect/vitest";
import type { ModelUsage } from "@anthropic-ai/claude-agent-sdk";
import { makeClaudeInvocationUsage } from "./claudeInvocationUsage.ts";

const usage = (input: number, output: number): ModelUsage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: input * 2,
  cacheCreationInputTokens: input,
  costUSD: input / 100,
  contextWindow: 200000,
  maxOutputTokens: 64000,
  webSearchRequests: 0,
});
const result = (models: Record<string, ModelUsage>, session = "session-1") => ({
  session_id: session,
  modelUsage: models,
});

describe("Claude invocation usage", () => {
  it("differences cumulative streaming totals and does not add repeated snapshots", () => {
    const tracker = makeClaudeInvocationUsage();
    expect(tracker.result(result({ opus: usage(10, 3) }), false)?.models[0]).toMatchObject({
      model: "opus",
      inputTokens: 40,
      outputTokens: 3,
      cachedInputTokens: 20,
      cacheCreationTokens: 10,
    });
    expect(
      tracker.result(result({ opus: usage(15, 8), sonnet: usage(2, 1) }), false),
    ).toMatchObject({
      nativeSubagentUsage: "included",
      completeness: "reported",
      models: [
        { model: "opus", inputTokens: 20, outputTokens: 5 },
        { model: "sonnet", inputTokens: 8, outputTokens: 1 },
      ],
    });
    expect(
      tracker.result(result({ opus: usage(15, 8), sonnet: usage(2, 1) }), false),
    ).toBeUndefined();
  });
  it("starts query counters fresh on resume and resets when the SDK changes session identity", () => {
    const resumedQuery = makeClaudeInvocationUsage();
    expect(
      resumedQuery.result(result({ opus: usage(3, 1) }, "existing-session"), false)?.models[0]
        ?.inputTokens,
    ).toBe(12);
    expect(
      resumedQuery.result(result({ opus: usage(2, 1) }, "clear-new-session"), false)?.models[0]
        ?.inputTokens,
    ).toBe(8);
  });
  it("marks failure and unavailable or regressed baselines partial without charging the next turn for missing work", () => {
    const tracker = makeClaudeInvocationUsage();
    tracker.result(result({ opus: usage(10, 3) }), false);
    expect(tracker.result(result({ opus: usage(0, 0) }), true)).toMatchObject({
      completeness: "partial",
      models: [{ inputTokens: null, outputTokens: null }],
    });
    expect(tracker.result(result({ opus: usage(15, 5) }), false)).toMatchObject({
      completeness: "partial",
      models: [{ inputTokens: null }],
    });
    expect(tracker.result(result({ opus: usage(17, 7) }), false)?.models[0]?.inputTokens).toBe(8);
    tracker.missing();
    expect(
      tracker.result(result({ opus: usage(20, 9) }), false)?.models[0]?.inputTokens,
    ).toBeNull();
    expect(tracker.result(result({ opus: usage(21, 10) }), false)?.models[0]?.inputTokens).toBe(4);
  });
  it("falls back to per-turn main-loop usage without inventing a model or attributing cumulative cost", () => {
    const tracker = makeClaudeInvocationUsage();
    tracker.result(result({ opus: usage(10, 3) }), false);
    expect(
      tracker.result(
        {
          ...result({}),
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 5,
          },
        },
        false,
      ),
    ).toMatchObject({
      source: "claude/result.usage",
      nativeSubagentUsage: "excluded",
      models: [{ model: null, inputTokens: 35, outputTokens: 4, costUsd: null }],
    });
    expect(tracker.result(result({ opus: usage(20, 10) }), false)).toMatchObject({
      completeness: "partial",
      models: [{ inputTokens: null }],
    });
  });

  it("does not charge a missing first result to the following turn", () => {
    const tracker = makeClaudeInvocationUsage();
    tracker.missing();
    expect(tracker.result(result({ opus: usage(20, 10) }), false)).toMatchObject({
      completeness: "partial",
      models: [{ inputTokens: null, outputTokens: null }],
    });
    expect(tracker.result(result({ opus: usage(25, 12) }), false)?.models[0]?.inputTokens).toBe(20);
  });

  it("keeps counters when an observed model identifier exceeds the wire limit", () => {
    const tracker = makeClaudeInvocationUsage();
    expect(
      tracker.result(result({ ["m".repeat(257)]: usage(10, 5) }), false)?.models[0],
    ).toMatchObject({ model: null, inputTokens: 40 });
  });

  it("retains unknown token fields rather than turning invalid telemetry into zero", () => {
    const tracker = makeClaudeInvocationUsage();
    expect(
      tracker.result(result({ opus: { ...usage(1, 1), inputTokens: Number.NaN } }), false),
    ).toMatchObject({
      completeness: "partial",
      models: [{ inputTokens: null, reasoningTokens: null }],
    });
  });
});
