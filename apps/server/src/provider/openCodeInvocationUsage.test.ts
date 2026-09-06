import type { AssistantMessage, StepFinishPart } from "@opencode-ai/sdk/v2";
import { describe, expect, it } from "vite-plus/test";

import { OpenCodeInvocationUsage } from "./openCodeInvocationUsage.ts";

const message = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id: "assistant-1",
  sessionID: "session-1",
  role: "assistant",
  parentID: "prompt-1",
  modelID: "observed-model",
  providerID: "provider",
  time: { created: 1, completed: 2 },
  mode: "build",
  agent: "build",
  path: { cwd: "/workspace", root: "/workspace" },
  cost: 999,
  tokens: { input: 999, output: 999, reasoning: 999, cache: { read: 999, write: 999 } },
  ...overrides,
});
const step = (overrides: Partial<StepFinishPart> = {}): StepFinishPart => ({
  id: "step-1",
  sessionID: "session-1",
  messageID: "assistant-1",
  type: "step-finish",
  reason: "stop",
  cost: 0.1,
  tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 30, write: 40 } },
  ...overrides,
});

describe("OpenCode invocation usage", () => {
  it("sums distinct steps once and never adds the assistant message snapshot", () => {
    const usage = new OpenCodeInvocationUsage("session-1");
    usage.startPrompt("prompt-1", false);
    usage.observeStep(step());
    usage.observeMessage(message());
    usage.observeStep(step());
    usage.observeMessage(message());
    usage.observeStep(step({ id: "step-2" }));
    expect(usage.report(false)).toEqual({
      source: "opencode.step-finish",
      attribution: "turn",
      completeness: "reported",
      nativeSubagentUsage: "excluded",
      models: [
        {
          model: "provider/observed-model",
          inputTokens: 160,
          outputTokens: 50,
          cachedInputTokens: 60,
          cacheCreationTokens: 80,
          reasoningTokens: 10,
          costUsd: 0.2,
        },
      ],
    });
  });

  it("excludes old-turn and native child-session counters, preserving steering prompts", () => {
    const usage = new OpenCodeInvocationUsage("session-1");
    usage.startPrompt("prompt-1", false);
    usage.observeMessage(message());
    usage.observeStep(step());
    usage.startPrompt("prompt-2", true);
    usage.observeMessage(message({ id: "assistant-2", parentID: "prompt-2", modelID: "second" }));
    usage.observeStep(step({ id: "step-2", messageID: "assistant-2" }));
    usage.observeMessage(message({ id: "child", sessionID: "child-session" }));
    usage.observeStep(step({ id: "child-step", messageID: "child", sessionID: "child-session" }));
    expect(usage.report(false)?.models.map((model) => model.model)).toEqual([
      "provider/observed-model",
      "provider/second",
    ]);
    usage.startPrompt("prompt-3", false);
    usage.observeMessage(message());
    usage.observeStep(step());
    expect(usage.report(false)).toBeUndefined();
  });

  it("keeps observed consumption on errors and rejects invalid counters", () => {
    const usage = new OpenCodeInvocationUsage("session-1");
    usage.startPrompt("prompt-1", false);
    usage.observeMessage(message());
    usage.observeStep(step());
    usage.observeStep(step({ id: "invalid", cost: Number.NaN }));
    expect(usage.report(false)?.completeness).toBe("partial");
    expect(usage.report(true)?.models[0]?.inputTokens).toBe(80);
  });

  it("marks an assistant error as partial even when the session becomes idle", () => {
    const usage = new OpenCodeInvocationUsage("session-1");
    usage.startPrompt("prompt-1", false);
    usage.observeMessage(message({ error: { name: "UnknownError", data: { message: "failed" } } }));
    usage.observeStep(step());
    expect(usage.report(false)?.completeness).toBe("partial");
  });

  it("keeps missing model identity unknown", () => {
    const usage = new OpenCodeInvocationUsage("session-1");
    usage.startPrompt("prompt-1", false);
    usage.observeMessage(message({ modelID: " " }));
    usage.observeStep(step());
    expect(usage.report(false)?.models[0]?.model).toBeNull();
  });

  it("marks missing step-to-message attribution partial until the header arrives", () => {
    const usage = new OpenCodeInvocationUsage("session-1");
    usage.startPrompt("prompt-1", false);
    usage.observeMessage(message());
    usage.observeStep(step());
    usage.observeStep(step({ id: "second", messageID: "missing-header" }));
    expect(usage.report(false)?.completeness).toBe("partial");
    expect(usage.report(false)?.models[0]?.inputTokens).toBe(80);
    usage.observeMessage(message({ id: "missing-header" }));
    expect(usage.report(false)?.completeness).toBe("reported");
    expect(usage.report(false)?.models[0]?.inputTokens).toBe(160);
  });

  it("bounds model identities and marks a truncated model report partial", () => {
    const usage = new OpenCodeInvocationUsage("session-1");
    usage.startPrompt("prompt-1", false);
    usage.observeMessage(message({ modelID: "m".repeat(257) }));
    usage.observeStep(step());
    expect(usage.report(false)?.models[0]?.model).toBeNull();
    for (let index = 0; index < 100; index += 1) {
      const id = `assistant-${index + 2}`;
      usage.observeMessage(message({ id, modelID: `model-${index}` }));
      usage.observeStep(step({ id: `step-${index + 2}`, messageID: id }));
    }
    const report = usage.report(false);
    expect(report?.models).toHaveLength(100);
    expect(report?.completeness).toBe("partial");
  });

  it("does not turn absent step usage into a zero-consumption success", () => {
    const usage = new OpenCodeInvocationUsage("session-1");
    usage.startPrompt("prompt-1", false);
    usage.observeMessage(message());
    expect(usage.report(false)).toBeUndefined();
  });
});
