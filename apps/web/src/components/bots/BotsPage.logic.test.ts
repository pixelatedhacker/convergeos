import { describe, expect, it } from "vite-plus/test";

import {
  botAvailabilityLabel,
  botFleetSummary,
  canDispatchToBot,
  isBotCandidate,
  reconcileSelectedBotKey,
  resolveBotAvailability,
  sortBotThreads,
  updateBotDispatchDraft,
  updateBusyBotKeys,
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

describe("reconcileSelectedBotKey", () => {
  it("keeps a valid selection and falls back when it disappears", () => {
    const bots = [{ key: "ada" }, { key: "zed" }];
    expect(reconcileSelectedBotKey("zed", bots)).toBe("zed");
    expect(reconcileSelectedBotKey("missing", bots)).toBe("ada");
    expect(reconcileSelectedBotKey(null, [])).toBeNull();
  });
});

describe("botFleetSummary", () => {
  it("groups failed bots with work that needs attention", () => {
    expect(
      botFleetSummary([
        idle,
        { ...idle, session: { status: "running" } },
        { ...idle, latestTurn: { state: "error" } },
        { ...idle, hasPendingUserInput: true },
      ]),
    ).toEqual({ attention: 2, working: 1, available: 1 });
  });
});

describe("canDispatchToBot", () => {
  it("keeps new work away from bots that are busy or waiting on the user", () => {
    expect(canDispatchToBot("available")).toBe(true);
    expect(canDispatchToBot("failed")).toBe(true);
    expect(canDispatchToBot("working")).toBe(false);
    expect(canDispatchToBot("attention")).toBe(false);
  });
});

describe("updateBotDispatchDraft", () => {
  it("keeps each bot's in-progress task isolated", () => {
    const atlasDrafts = updateBotDispatchDraft(new Map(), "atlas", "Review the API");
    const fleetDrafts = updateBotDispatchDraft(atlasDrafts, "reviewer", "Check the diff");

    expect(fleetDrafts.get("atlas")).toBe("Review the API");
    expect(fleetDrafts.get("reviewer")).toBe("Check the diff");
    expect(updateBotDispatchDraft(fleetDrafts, "atlas", "").has("atlas")).toBe(false);
  });
});

describe("updateBusyBotKeys", () => {
  it("tracks overlapping work for different bots independently", () => {
    const atlasBusy = updateBusyBotKeys(new Set(), "atlas", true);
    const bothBusy = updateBusyBotKeys(atlasBusy, "reviewer", true);
    const reviewerBusy = updateBusyBotKeys(bothBusy, "atlas", false);

    expect([...reviewerBusy]).toEqual(["reviewer"]);
  });
});
