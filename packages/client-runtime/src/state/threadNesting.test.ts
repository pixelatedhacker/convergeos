import { EnvironmentId, ThreadId, type OrchestrationSession } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupWorkersByCoordinator,
  resolveCoordinatorStatus,
  workerSummary,
  type SidebarThreadStatusInput,
} from "./threadNesting.ts";

const environmentId = EnvironmentId.make("env-1");

function thread(id: string, parent?: string) {
  return {
    environmentId,
    id: ThreadId.make(id),
    parentThreadId: parent === undefined ? null : ThreadId.make(parent),
  };
}

const key = (id: string) => `${environmentId}:${id}`;

function statusInput(
  overrides: Partial<SidebarThreadStatusInput> & { sessionStatus?: OrchestrationSession["status"] },
): SidebarThreadStatusInput {
  const { sessionStatus, ...rest } = overrides;
  return {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session:
      sessionStatus === undefined ? null : ({ status: sessionStatus } as OrchestrationSession),
    backgroundLiveness: null,
    ...rest,
  };
}

describe("groupWorkersByCoordinator", () => {
  it("nests active workers under a visible coordinator in partition order", () => {
    const nesting = groupWorkersByCoordinator({
      pinned: [thread("coordinator")],
      active: [
        thread("worker-b", "coordinator"),
        thread("other"),
        thread("worker-a", "coordinator"),
      ],
    });
    expect(nesting.childrenByCoordinator.get(key("coordinator"))?.map((t) => t.id)).toEqual([
      "worker-b",
      "worker-a",
    ]);
    expect([...nesting.nestedKeys]).toEqual([key("worker-b"), key("worker-a")]);
    expect(nesting.orphans).toEqual([]);
  });

  it("keeps workers top-level when the coordinator is not in the pinned or active blocks", () => {
    // A settled, snoozed, archived, or deleted coordinator is absent from both blocks.
    const nesting = groupWorkersByCoordinator({
      pinned: [],
      active: [thread("worker", "coordinator")],
    });
    expect(nesting.nestedKeys.size).toBe(0);
    expect(nesting.orphans.map((t) => t.id)).toEqual(["worker"]);
  });

  it("lets pin win over nesting", () => {
    const nesting = groupWorkersByCoordinator({
      pinned: [thread("worker", "coordinator")],
      active: [thread("coordinator")],
    });
    expect(nesting.childrenByCoordinator.size).toBe(0);
    expect(nesting.orphans.map((t) => t.id)).toEqual(["worker"]);
  });

  it("nests only one level deep", () => {
    const nesting = groupWorkersByCoordinator({
      pinned: [],
      active: [
        thread("coordinator"),
        thread("worker", "coordinator"),
        thread("sub-worker", "worker"),
      ],
    });
    expect(nesting.childrenByCoordinator.get(key("coordinator"))?.map((t) => t.id)).toEqual([
      "worker",
    ]);
    expect(nesting.childrenByCoordinator.has(key("worker"))).toBe(false);
    expect(nesting.orphans.map((t) => t.id)).toEqual(["sub-worker"]);
  });

  it("does not nest across environments", () => {
    const nesting = groupWorkersByCoordinator({
      pinned: [],
      active: [
        thread("coordinator"),
        { ...thread("worker", "coordinator"), environmentId: EnvironmentId.make("env-2") },
      ],
    });
    expect(nesting.nestedKeys.size).toBe(0);
  });

  it("re-flattens workers once the coordinator leaves the active block", () => {
    const worker = thread("worker", "coordinator");
    const before = groupWorkersByCoordinator({
      pinned: [],
      active: [thread("coordinator"), worker],
    });
    expect(before.nestedKeys.has(key("worker"))).toBe(true);
    const afterSettle = groupWorkersByCoordinator({ pinned: [], active: [worker] });
    expect(afterSettle.nestedKeys.has(key("worker"))).toBe(false);
    expect(afterSettle.orphans).toEqual([worker]);
  });

  it("survives a malformed parent cycle", () => {
    const nesting = groupWorkersByCoordinator({
      pinned: [],
      active: [thread("a", "b"), thread("b", "a")],
    });
    expect(nesting.nestedKeys.size).toBe(1);
  });
});

describe("workerSummary", () => {
  it("counts running, needs-you, and failed workers", () => {
    const summary = workerSummary([
      statusInput({ sessionStatus: "running" }),
      statusInput({ hasPendingApprovals: true }),
      statusInput({ sessionStatus: "ready" }),
    ]);
    expect(summary.text).toBe("3 workers · 1 running · 1 needs you");
    expect(summary.rollupStatus).toBe("approval");
  });

  it("describes a single idle worker", () => {
    const summary = workerSummary([statusInput({})]);
    expect(summary.text).toBe("1 worker");
    expect(summary.rollupStatus).toBe("ready");
  });

  it("reports failures and plural attention", () => {
    const summary = workerSummary([
      statusInput({ sessionStatus: "error" }),
      statusInput({ hasPendingUserInput: true }),
      statusInput({ hasPendingApprovals: true }),
    ]);
    expect(summary.text).toBe("3 workers · 2 need you · 1 failed");
    expect(summary.rollupStatus).toBe("approval");
  });
});

describe("resolveCoordinatorStatus", () => {
  it("surfaces an outranking child status while collapsed", () => {
    expect(resolveCoordinatorStatus({ own: "working", rollup: "approval", expanded: false })).toBe(
      "approval",
    );
  });

  it("keeps the coordinator's own status when it outranks its children", () => {
    expect(resolveCoordinatorStatus({ own: "input", rollup: "working", expanded: false })).toBe(
      "input",
    );
  });

  it("shows the coordinator's own status while expanded", () => {
    expect(resolveCoordinatorStatus({ own: "ready", rollup: "approval", expanded: true })).toBe(
      "ready",
    );
  });
});
