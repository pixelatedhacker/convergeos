import { describe, expect, it } from "vitest";

import { composeBotTurnInput } from "./botInstructions.ts";

describe("composeBotTurnInput", () => {
  it("returns the task unchanged when the thread is not a bot", () => {
    expect(composeBotTurnInput(null, "Fix the flaky test")).toBe("Fix the flaky test");
    expect(composeBotTurnInput(undefined, "Fix the flaky test")).toBe("Fix the flaky test");
  });

  it("returns the task unchanged when the bot has no instructions", () => {
    expect(composeBotTurnInput({ description: null }, "Fix it")).toBe("Fix it");
    expect(composeBotTurnInput({ description: "   " }, "Fix it")).toBe("Fix it");
  });

  it("prepends the instructions ahead of the task", () => {
    expect(
      composeBotTurnInput({ description: "Review diffs. Commit before finishing." }, "Audit #12"),
    ).toBe(
      "<bot_instructions>\nReview diffs. Commit before finishing.\n</bot_instructions>\n\nAudit #12",
    );
  });

  it("sends the instructions alone when the task text is empty", () => {
    expect(composeBotTurnInput({ description: "Describe attached images." }, "  ")).toBe(
      "<bot_instructions>\nDescribe attached images.\n</bot_instructions>",
    );
  });
});
