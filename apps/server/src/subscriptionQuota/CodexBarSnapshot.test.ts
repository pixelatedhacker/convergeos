import { describe, expect, it } from "@effect/vitest";
import {
  normalizeCodexBarDashboardSnapshot,
  type CodexBarDashboardSnapshot,
} from "./CodexBarSnapshot.ts";

function normalize(provider: Partial<CodexBarDashboardSnapshot["providers"][number]>) {
  return normalizeCodexBarDashboardSnapshot({
    schemaVersion: 1,
    generatedAt: "2026-09-21T12:00:00Z",
    staleAfterSeconds: 180,
    providers: [
      {
        id: "claude",
        name: "Claude",
        enabled: true,
        windows: [{ kind: "session", label: "Session", usedPercent: 0 }],
        ...provider,
      },
    ],
  }).subjects[0];
}

describe("CodexBar quota normalization", () => {
  it("does not turn offline conversation counts into subscription allowance", () => {
    expect(
      normalize({ id: "antigravity", source: "offline", identity: { plan: "Offline" } }),
    ).toMatchObject({ status: "unavailable", plan: null, windows: [] });
  });
  it("preserves unavailable and stale collector states", () => {
    expect(normalize({ status: "unavailable" })?.status).toBe("unavailable");
    expect(normalize({ status: "stale" })?.status).toBe("stale");
    expect(normalize({ status: "unavailable", error: "collection failed" })?.status).toBe("failed");
  });
  it("rejects a CLI status line misidentified as a plan without dropping quota", () => {
    expect(normalize({ identity: { plan: "Completes tasksorneedsinp" } })).toMatchObject({
      plan: null,
      windows: [{ usedPercent: 0 }],
    });
    expect(normalize({ identity: { plan: "Max 20x" } })?.plan).toBe("Max 20x");
  });
});
