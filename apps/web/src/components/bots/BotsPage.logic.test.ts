import { describe, expect, it } from "vite-plus/test";

import {
  botAvailabilityLabel,
  isBotCandidate,
  resolveBotAvailability,
  sortBotThreads,
} from "./BotsPage.logic";

const idle = {
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  session: null,
  latestTurn: null,
  backgroundLiveness: null,
} as const;

describe("resolveBotAvailability", () => {
  it("prioritizes user attention over work and failure states", () => {
    const input = {
      ...idle,
      hasPendingApprovals: true,
      session: { status: "error" },
      latestTurn: { state: "running" },
    };

    expect(resolveBotAvailability(input)).toBe("attention");
    expect(botAvailabilityLabel("attention", input)).toBe("Needs approval");
  });

  it("recognizes failed, working, and available inboxes", () => {
    expect(resolveBotAvailability({ ...idle, latestTurn: { state: "error" } })).toBe("failed");
    expect(resolveBotAvailability({ ...idle, backgroundLiveness: "monitoring" })).toBe("working");
    expect(
      resolveBotAvailability({
        ...idle,
        session: { status: "running" },
        latestTurn: { state: "error" },
      }),
    ).toBe("working");
    expect(resolveBotAvailability(idle)).toBe("available");
  });
});

describe("isBotCandidate", () => {
  it("only offers active isolated threads on capable environments", () => {
    const candidate = { archivedAt: null, botProfile: null, worktreePath: "/tmp/bot" } as const;
    expect(isBotCandidate(candidate, true)).toBe(true);
    expect(isBotCandidate(candidate, false)).toBe(false);
    expect(isBotCandidate({ ...candidate, worktreePath: null }, true)).toBe(false);
    expect(isBotCandidate({ ...candidate, archivedAt: "2026-01-01" }, true)).toBe(false);
  });
});

describe("sortBotThreads", () => {
  it("sorts bot inboxes by their profile name", () => {
    const bots = [
      { botProfile: { displayName: "Zed" }, updatedAt: "2026-01-02" },
      { botProfile: { displayName: "Ada" }, updatedAt: "2026-01-01" },
    ];
    expect(sortBotThreads(bots).map((bot) => bot.botProfile.displayName)).toEqual(["Ada", "Zed"]);
  });
});
