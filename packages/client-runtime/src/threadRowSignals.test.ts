import type { ThreadPullRequestLink, ThreadPullRequestSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { resolveThreadRowSignals } from "./threadRowSignals.ts";

function snapshot(input: Partial<ThreadPullRequestSnapshot> = {}): ThreadPullRequestSnapshot {
  return {
    state: "open",
    title: "Change",
    headBranch: "feature",
    baseBranch: "main",
    isDraft: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    syncedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  };
}

function link(
  number: number,
  snapshotInput: Partial<ThreadPullRequestSnapshot> | null = {},
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "pingdotgg/t3code",
    number,
    url: `https://github.com/pingdotgg/t3code/pull/${number}`,
    source: "manual",
    linkedAt: `2026-01-01T00:00:${String(number).padStart(2, "0")}.000Z`,
    snapshot: snapshotInput === null ? null : snapshot(snapshotInput),
    stack: null,
  };
}

const turnDiff = { additions: 12, deletions: 3, files: 2 };
const lastTurn = {
  insertions: 12,
  deletions: 3,
  source: "turn",
  label: "Last turn: +12 −3 in 2 files",
} as const;
const prDiff = (insertions: number, deletions: number) => ({
  insertions,
  deletions,
  source: "pull-request" as const,
  label: `Pull request: +${insertions} −${deletions}`,
});

describe("resolveThreadRowSignals", () => {
  it("shows nothing for a thread without a pull request or turn stats", () => {
    expect(resolveThreadRowSignals({ pullRequests: [], supportsPullRequestLinks: true })).toEqual({
      diff: null,
      checks: null,
    });
  });

  it("falls back to turn stats when there is no pull request", () => {
    expect(
      resolveThreadRowSignals({ pullRequests: [], supportsPullRequestLinks: true, turnDiff }),
    ).toEqual({ diff: lastTurn, checks: null });
  });

  it("labels a single-file turn and hides a turn without line changes", () => {
    expect(
      resolveThreadRowSignals({
        pullRequests: [],
        supportsPullRequestLinks: true,
        turnDiff: { additions: 5, deletions: 0, files: 1 },
      }).diff?.label,
    ).toBe("Last turn: +5 −0 in 1 file");
    expect(
      resolveThreadRowSignals({
        pullRequests: [],
        supportsPullRequestLinks: true,
        turnDiff: { additions: 0, deletions: 0, files: 1 },
      }).diff,
    ).toBeNull();
  });

  it("falls back to turn stats in environments without link snapshots", () => {
    expect(
      resolveThreadRowSignals({
        pullRequests: [link(7, { additions: 120, deletions: 45 })],
        supportsPullRequestLinks: false,
        turnDiff,
      }).diff,
    ).toEqual(lastTurn);
  });

  it("prefers the pull request's line counts over turn stats", () => {
    const signals = resolveThreadRowSignals({
      pullRequests: [link(7, { additions: 120, deletions: 45, checksState: "passing" })],
      supportsPullRequestLinks: true,
      turnDiff,
    });
    expect(signals).toEqual({ diff: prDiff(120, 45), checks: "passing" });
  });

  it("uses the open pull request the badge shows over a merged one", () => {
    const signals = resolveThreadRowSignals({
      pullRequests: [
        link(1, {
          state: "merged",
          headBranch: "old",
          additions: 900,
          deletions: 900,
          checksState: "failing",
        }),
        link(2, { headBranch: "new", additions: 10, deletions: 2, checksState: "pending" }),
      ],
      supportsPullRequestLinks: true,
    });
    expect(signals).toEqual({ diff: prDiff(10, 2), checks: "pending" });
  });

  it("uses the top open layer of a stack", () => {
    const signals = resolveThreadRowSignals({
      pullRequests: [
        link(1, { headBranch: "base-layer", additions: 50, deletions: 5, checksState: "passing" }),
        link(2, {
          headBranch: "top-layer",
          baseBranch: "base-layer",
          additions: 8,
          deletions: 0,
          checksState: "failing",
        }),
      ],
      supportsPullRequestLinks: true,
    });
    expect(signals).toEqual({ diff: prDiff(8, 0), checks: "failing" });
  });

  it.each([
    ["missing", {}],
    ["partial", { additions: 4 }],
    ["zero", { additions: 0, deletions: 0 }],
  ] as const)("treats %s host line counts as unknown and keeps turn stats", (_, counts) => {
    expect(
      resolveThreadRowSignals({
        pullRequests: [link(7, counts)],
        supportsPullRequestLinks: true,
        turnDiff,
      }).diff,
    ).toEqual(lastTurn);
  });

  it.each(["passing", "failing", "pending"] as const)(
    "reports %s checks on an open pull request",
    (checksState) => {
      expect(
        resolveThreadRowSignals({
          pullRequests: [link(7, { checksState })],
          supportsPullRequestLinks: true,
        }).checks,
      ).toBe(checksState);
    },
  );

  it.each([
    ["no reported checks", { checksState: null }],
    ["an unreported rollup", {}],
    ["a merged pull request", { state: "merged", checksState: "failing" }],
    ["a closed pull request", { state: "closed", checksState: "pending" }],
  ] as const)("shows no checks glyph for %s", (_, input) => {
    expect(
      resolveThreadRowSignals({ pullRequests: [link(7, input)], supportsPullRequestLinks: true })
        .checks,
    ).toBeNull();
  });

  it("ignores links awaiting their first sync and environments without link snapshots", () => {
    expect(
      resolveThreadRowSignals({ pullRequests: [link(7, null)], supportsPullRequestLinks: true }),
    ).toEqual({ diff: null, checks: null });
    expect(
      resolveThreadRowSignals({
        pullRequests: [link(7, { additions: 1, deletions: 1, checksState: "failing" })],
        supportsPullRequestLinks: false,
      }),
    ).toEqual({ diff: null, checks: null });
  });
});
