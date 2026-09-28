import {
  EnvironmentId,
  ThreadId,
  type OrchestrationLatestTurn,
  type OrchestrationSession,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupWorkersByCoordinator } from "./threadNesting.ts";
import {
  groupThreadsByStatus,
  resolveThreadStatusGroup,
  type ThreadStatusGroupId,
} from "./threadStatusGroups.ts";

const environmentId = EnvironmentId.make("env-1");

type Fixture = Parameters<typeof groupThreadsByStatus>[0]["threads"][number];

function thread(
  id: string,
  overrides: Partial<Omit<Fixture, "session">> & {
    sessionStatus?: OrchestrationSession["status"];
    parent?: string;
    activityAt?: string;
  } = {},
): Fixture {
  const { sessionStatus, parent, activityAt, ...rest } = overrides;
  return {
    environmentId,
    id: ThreadId.make(id),
    parentThreadId: parent === undefined ? null : ThreadId.make(parent),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    interactionMode: "default",
    session:
      sessionStatus === undefined ? null : ({ status: sessionStatus } as OrchestrationSession),
    backgroundLiveness: null,
    latestTurn: null,
    latestUserMessageAt: activityAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...rest,
  };
}

const completedTurn = {
  turnId: "turn-1",
  state: "completed",
  requestedAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:01.000Z",
  completedAt: "2026-01-01T00:00:02.000Z",
  assistantMessageId: null,
} as unknown as OrchestrationLatestTurn;

const layout = (groups: ReturnType<typeof groupThreadsByStatus>) =>
  groups.map((group) => [group.id, group.threads.map((t) => t.id)] as const);

describe("resolveThreadStatusGroup", () => {
  const cases: ReadonlyArray<
    readonly [Parameters<typeof resolveThreadStatusGroup>[0], ThreadStatusGroupId]
  > = [
    [{ status: "approval", planReady: false, unseen: false, readiness: "unseen" }, "needs-you"],
    [{ status: "input", planReady: false, unseen: false, readiness: "unseen" }, "needs-you"],
    [{ status: "failed", planReady: false, unseen: true, readiness: "unseen" }, "needs-you"],
    [{ status: "ready", planReady: true, unseen: true, readiness: "unseen" }, "needs-you"],
    [{ status: "monitoring", planReady: true, unseen: false, readiness: "unseen" }, "needs-you"],
    [{ status: "working", planReady: false, unseen: false, readiness: "unseen" }, "working"],
    [{ status: "monitoring", planReady: false, unseen: false, readiness: "unseen" }, "working"],
    [{ status: "ready", planReady: false, unseen: true, readiness: "unseen" }, "review"],
    [{ status: "ready", planReady: false, unseen: false, readiness: "unseen" }, "done"],
    [{ status: "ready", planReady: false, unseen: true, readiness: "folded" }, "ready"],
    [{ status: "ready", planReady: false, unseen: false, readiness: "folded" }, "ready"],
  ];
  it.each(cases)("maps %j to %s", (input, expected) => {
    expect(resolveThreadStatusGroup(input)).toBe(expected);
  });
});

describe("groupThreadsByStatus", () => {
  it("maps shell states to groups, including connecting and plan ready", () => {
    const groups = groupThreadsByStatus({
      threads: [
        thread("approval", { hasPendingApprovals: true }),
        thread("input", { hasPendingUserInput: true }),
        thread("failed", { sessionStatus: "error" }),
        thread("plan", {
          interactionMode: "plan",
          hasActionableProposedPlan: true,
          latestTurn: completedTurn,
          sessionStatus: "ready",
        }),
        thread("running", { sessionStatus: "running" }),
        thread("connecting", { sessionStatus: "starting" }),
        thread("monitoring", { backgroundLiveness: "monitoring" }),
        thread("unseen", { latestTurn: completedTurn }),
        thread("seen", { latestTurn: completedTurn }),
      ],
      readiness: "unseen",
      isUnseen: (t) => t.id === "unseen",
    });
    expect(
      Object.fromEntries(groups.map((group) => [group.id, group.threads.map((t) => t.id).sort()])),
    ).toEqual({
      "needs-you": ["approval", "failed", "input", "plan"],
      working: ["connecting", "monitoring", "running"],
      review: ["unseen"],
      done: ["seen"],
    });
    expect(groups.map((group) => group.label)).toEqual([
      "Needs you",
      "Working",
      "Ready to review",
      "Done",
    ]);
  });

  it("does not treat a plan as ready while a new turn is connecting", () => {
    const groups = groupThreadsByStatus({
      threads: [
        thread("plan", {
          interactionMode: "plan",
          hasActionableProposedPlan: true,
          latestTurn: completedTurn,
          sessionStatus: "starting",
        }),
      ],
      readiness: "unseen",
    });
    expect(layout(groups)).toEqual([["working", ["plan"]]]);
  });

  it("orders each group by most recent activity, newest first, and hides empty groups", () => {
    const groups = groupThreadsByStatus({
      threads: [
        thread("old", { activityAt: "2026-01-01T00:00:00.000Z" }),
        thread("new", { activityAt: "2026-01-03T00:00:00.000Z" }),
        thread("mid", {
          activityAt: "2026-01-01T00:00:00.000Z",
          latestTurn: { ...completedTurn, completedAt: "2026-01-02T00:00:00.000Z" },
        }),
      ],
      readiness: "unseen",
    });
    expect(layout(groups)).toEqual([["done", ["new", "mid", "old"]]]);
  });

  it("folds unseen and seen completions into one Ready group", () => {
    const groups = groupThreadsByStatus({
      threads: [
        thread("seen", { activityAt: "2026-01-02T00:00:00.000Z" }),
        thread("unseen", { activityAt: "2026-01-01T00:00:00.000Z" }),
        thread("running", { sessionStatus: "running" }),
      ],
      readiness: "folded",
      isUnseen: (t) => t.id === "unseen",
    });
    expect(layout(groups)).toEqual([
      ["working", ["running"]],
      ["ready", ["seen", "unseen"]],
    ]);
    expect(groups[1]?.label).toBe("Ready");
  });

  it("groups a coordinator by its rolled-up status and leaves its workers out", () => {
    const coordinator = thread("coordinator");
    const approvalWorker = thread("worker-a", { parent: "coordinator", hasPendingApprovals: true });
    const quietWorker = thread("worker-b", { parent: "coordinator" });
    const other = thread("other", { sessionStatus: "running" });
    const nesting = groupWorkersByCoordinator({
      pinned: [],
      active: [coordinator, approvalWorker, quietWorker, other],
    });
    const topLevel = [coordinator, approvalWorker, quietWorker, other].filter(
      (t) => !nesting.nestedKeys.has(`${t.environmentId}:${t.id}`),
    );
    const groups = groupThreadsByStatus({
      threads: topLevel,
      childrenByCoordinator: nesting.childrenByCoordinator,
      readiness: "unseen",
    });
    expect(layout(groups)).toEqual([
      ["needs-you", ["coordinator"]],
      ["working", ["other"]],
    ]);
  });

  it("keeps a coordinator in its own group when its workers are quieter", () => {
    const coordinator = thread("coordinator", { hasPendingUserInput: true });
    const worker = thread("worker", { parent: "coordinator", sessionStatus: "running" });
    const nesting = groupWorkersByCoordinator({ pinned: [], active: [coordinator, worker] });
    const groups = groupThreadsByStatus({
      threads: [coordinator],
      childrenByCoordinator: nesting.childrenByCoordinator,
      readiness: "folded",
    });
    expect(layout(groups)).toEqual([["needs-you", ["coordinator"]]]);
  });

  it("returns no groups for an empty active list", () => {
    expect(groupThreadsByStatus({ threads: [], readiness: "unseen" })).toEqual([]);
  });
});
