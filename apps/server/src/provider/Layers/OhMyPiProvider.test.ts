import { describe, expect, it } from "@effect/vitest";

import { parseOhMyPiModelCatalog } from "./OhMyPiProvider.ts";

describe("parseOhMyPiModelCatalog", () => {
  it("maps selectors, sub-providers, and advertised thinking efforts", () => {
    const result = parseOhMyPiModelCatalog(
      JSON.stringify({
        models: [
          {
            provider: "openai",
            id: "gpt-test",
            selector: "openai/gpt-test",
            name: "GPT Test",
            contextWindow: 128_000,
            maxTokens: 16_384,
            reasoning: true,
            thinking: ["low", "medium", "high", "xhigh"],
            input: ["text", "image"],
            cost: { input: 0, output: 0 },
          },
        ],
      }),
    );

    expect(result._tag).toBe("Success");
    if (result._tag === "Failure") return;
    expect(result.catalog.models).toEqual([
      {
        slug: "openai/gpt-test",
        name: "GPT Test",
        subProvider: "openai",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "thinking",
              label: "Thinking",
              type: "select",
              options: [
                { id: "low", label: "Low" },
                { id: "medium", label: "Medium" },
                { id: "high", label: "High" },
                { id: "xhigh", label: "Xhigh" },
              ],
            },
          ],
        },
      },
    ]);
  });

  it("tolerates additive fields, derives a missing selector, and drops bad entries", () => {
    const result = parseOhMyPiModelCatalog(
      JSON.stringify({
        futureCatalogField: true,
        models: [
          { provider: "anthropic", id: "claude-test", name: "Claude Test", future: {} },
          { provider: "anthropic", id: "claude-test", name: "Duplicate" },
          { provider: "missing-id" },
          null,
        ],
      }),
    );

    expect(result._tag).toBe("Success");
    if (result._tag === "Failure") return;
    expect(result.catalog.models.map((model) => model.slug)).toEqual(["anthropic/claude-test"]);
    expect(result.catalog.ignoredEntries).toBe(3);
  });

  it("sorts the catalog deterministically and deduplicates thinking efforts", () => {
    const result = parseOhMyPiModelCatalog(
      JSON.stringify({
        models: [
          { provider: "zeta", id: "b", selector: "zeta/b", name: "B" },
          {
            provider: "alpha",
            id: "c",
            selector: "alpha/c",
            name: "C",
            thinking: ["high", "high", " low "],
          },
          { provider: "alpha", id: "a", selector: "alpha/a", name: "A" },
        ],
      }),
    );

    expect(result._tag).toBe("Success");
    if (result._tag === "Failure") return;
    expect(result.catalog.models.map((model) => model.slug)).toEqual([
      "alpha/a",
      "alpha/c",
      "zeta/b",
    ]);
    expect(result.catalog.models[1]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      options: [
        { id: "high", label: "High" },
        { id: "low", label: "Low" },
      ],
    });
  });

  it("rejects malformed JSON and a missing models array", () => {
    expect(parseOhMyPiModelCatalog("not-json")).toEqual({
      _tag: "Failure",
      issue: "Oh My Pi returned malformed model catalog JSON.",
    });
    expect(parseOhMyPiModelCatalog(JSON.stringify({ modelsByProvider: {} }))).toEqual({
      _tag: "Failure",
      issue: "Oh My Pi model catalog JSON did not contain a models array.",
    });
  });
});
