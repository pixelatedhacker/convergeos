// @effect-diagnostics globalDate:off -- Fixed wall-clock fixtures for snooze behavior.
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { summarizeEnvironmentWork } from "./commandCenter.ts";
import type { EnvironmentThreadShell } from "./models.ts";

const laptop = EnvironmentId.make("laptop");
const workstation = EnvironmentId.make("workstation");
const server = EnvironmentId.make("server");
const now = new Date("2026-09-17T12:00:00.000Z");

function thread(
  environmentId: EnvironmentId,
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    environmentId,
    id: ThreadId.make(id),
    projectId: ProjectId.make("project"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-09-16T10:00:00.000Z",
    updatedAt: "2026-09-17T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } as EnvironmentThreadShell;
}

describe("summarizeEnvironmentWork", () => {
  it("keeps three machines separate and selects attention before running and recent work", () => {
    const oldApproval = thread(laptop, "approval", {
      hasPendingApprovals: true,
      updatedAt: "2026-09-17T08:00:00.000Z",
    });
    const working = thread(laptop, "working", {
      session: { status: "running", updatedAt: "2026-09-17T11:00:00.000Z" } as NonNullable<
        EnvironmentThreadShell["session"]
      >,
    });
    const remoteWork = thread(workstation, "working", {
      backgroundLiveness: "monitoring",
    });
    const recent = thread(server, "recent");

    const summaries = summarizeEnvironmentWork(
      [laptop, workstation, server],
      [working, remoteWork, recent, oldApproval],
      now,
    );

    expect(summaries.map((summary) => [summary.attentionCount, summary.workingCount])).toEqual([
      [1, 1],
      [0, 1],
      [0, 0],
    ]);
    expect(summaries.map((summary) => summary.nextThread?.id)).toEqual([
      oldApproval.id,
      remoteWork.id,
      recent.id,
    ]);
    expect(summaries.map((summary) => summary.nextKind)).toEqual([
      "attention",
      "working",
      "recent",
    ]);
  });

  it("removes archived and snoozed requests from the jump target as shells change", () => {
    const snoozed = thread(laptop, "snoozed-plan", {
      hasActionableProposedPlan: true,
      snoozedAt: "2026-09-17T10:00:00.000Z",
      snoozedUntil: "2026-09-17T13:00:00.000Z",
      updatedAt: "2026-09-17T11:00:00.000Z",
    });
    const archived = thread(laptop, "archived", {
      hasPendingUserInput: true,
      archivedAt: "2026-09-17T10:00:00.000Z",
    });
    const resume = thread(laptop, "resume", {
      updatedAt: "2026-09-17T09:00:00.000Z",
    });

    const [beforeWake] = summarizeEnvironmentWork([laptop], [snoozed, archived, resume], now);
    const [afterWake] = summarizeEnvironmentWork(
      [laptop],
      [snoozed, archived, resume],
      new Date("2026-09-17T13:01:00.000Z"),
    );

    expect(beforeWake).toMatchObject({ attentionCount: 0, nextThread: resume });
    expect(afterWake).toMatchObject({ attentionCount: 1, nextThread: snoozed });
  });
});
