import { describe, expect, it } from "@effect/vitest";
import { makeCodexInvocationUsage } from "./codexInvocationUsage.ts";

const counts = (input: number, output: number) => ({
  inputTokens: input,
  cachedInputTokens: input / 2,
  outputTokens: output,
  reasoningOutputTokens: output / 2,
  totalTokens: input + output,
});
const snapshot = (
  turnId: string,
  input: number,
  output: number,
  lastInput = input,
  lastOutput = output,
) => ({
  threadId: "thread-1",
  turnId,
  tokenUsage: {
    total: counts(input, output),
    last: counts(lastInput, lastOutput),
    modelContextWindow: null,
  },
});

describe("Codex invocation usage", () => {
  it("records each request once across repeated snapshots and consecutive turns", () => {
    const tracker = makeCodexInvocationUsage(true);
    tracker.start("one");
    tracker.update(snapshot("one", 100, 20));
    tracker.update(snapshot("one", 100, 20));
    tracker.update(snapshot("one", 140, 30, 40, 10));
    expect(tracker.complete("one", false)).toMatchObject({
      completeness: "reported",
      models: [
        {
          model: null,
          inputTokens: 140,
          cachedInputTokens: 70,
          outputTokens: 30,
          reasoningTokens: 15,
        },
      ],
    });
    expect(tracker.complete("one", false)?.models[0]?.inputTokens).toBe(140);
    tracker.start("two");
    tracker.update(snapshot("two", 180, 40, 40, 10));
    expect(tracker.complete("two", false)?.models[0]?.inputTokens).toBe(40);
  });
  it("uses only a partial lower bound for the first resumed turn, never its historical total", () => {
    const tracker = makeCodexInvocationUsage(false);
    tracker.start("resumed");
    tracker.update(snapshot("resumed", 10000, 1000, 40, 10));
    tracker.update(snapshot("resumed", 10060, 1020, 60, 20));
    expect(tracker.complete("resumed", false)).toMatchObject({
      completeness: "partial",
      nativeSubagentUsage: "unknown",
      models: [{ inputTokens: 100, outputTokens: 30 }],
    });
  });
  it("accepts an idle baseline on resume and ignores stale events from another turn", () => {
    const tracker = makeCodexInvocationUsage(false);
    tracker.update(snapshot("old", 100, 20));
    tracker.start("new");
    tracker.update(snapshot("old", 200, 40));
    tracker.update(snapshot("new", 140, 30, 40, 10));
    expect(tracker.complete("new", false)).toMatchObject({
      completeness: "reported",
      models: [{ inputTokens: 40 }],
    });
  });
  it("invalidates an unobserved turn baseline so the next turn never inherits its charges", () => {
    const tracker = makeCodexInvocationUsage(true);
    tracker.start("one");
    tracker.update(snapshot("one", 100, 20));
    const report = tracker.complete("one", false);
    expect(tracker.complete("one", false)).toEqual(report);
    tracker.start("missing");
    expect(tracker.complete("missing", false)).toBeUndefined();
    tracker.start("three");
    tracker.update(snapshot("three", 200, 40, 40, 10));
    expect(tracker.complete("three", false)).toMatchObject({
      completeness: "partial",
      models: [{ inputTokens: 40, outputTokens: 10 }],
    });
  });

  it("reports cache writes only when the provider supplies both ends of their counter", () => {
    const tracker = makeCodexInvocationUsage(true);
    tracker.start("one");
    const value = snapshot("one", 100, 20);
    tracker.update({
      ...value,
      tokenUsage: {
        ...value.tokenUsage,
        total: { ...value.tokenUsage.total, cacheWriteInputTokens: 10 },
      },
    });
    expect(tracker.complete("one", false)?.models[0]?.cacheCreationTokens).toBe(10);
    tracker.start("two");
    tracker.update(snapshot("two", 120, 30));
    expect(tracker.complete("two", false)?.models[0]?.cacheCreationTokens).toBeNull();
  });

  it("makes resets and invalid counters unknown, and marks failed turns partial", () => {
    const tracker = makeCodexInvocationUsage(true);
    tracker.start("one");
    tracker.update(snapshot("one", 100, 20));
    tracker.update(snapshot("one", 10, 2));
    expect(tracker.complete("one", false)).toMatchObject({
      completeness: "partial",
      models: [{ inputTokens: null }],
    });
    tracker.start("two");
    tracker.update(snapshot("two", 30, 6, 20, 4));
    expect(tracker.complete("two", true)).toMatchObject({
      completeness: "partial",
      models: [{ inputTokens: 20 }],
    });
    tracker.start("three");
    expect(tracker.complete("three", false)).toBeUndefined();
  });
});
