import type { EnvironmentId } from "@t3tools/contracts";

import { effectiveSnoozed } from "./threadSettled.ts";
import type { EnvironmentThreadShell } from "./models.ts";

export type CommandCenterNextKind = "attention" | "working" | "recent";

export interface EnvironmentWorkSummary {
  readonly environmentId: EnvironmentId;
  readonly attentionCount: number;
  readonly workingCount: number;
  readonly nextThread: EnvironmentThreadShell | null;
  readonly nextKind: CommandCenterNextKind | null;
}

interface MutableSummary {
  attentionCount: number;
  workingCount: number;
  nextThread: EnvironmentThreadShell | null;
  nextKind: CommandCenterNextKind | null;
  nextActivityAt: number;
}

const KIND_PRIORITY: Record<CommandCenterNextKind, number> = {
  attention: 3,
  working: 2,
  recent: 1,
};

function activityAt(thread: EnvironmentThreadShell): number {
  const timestamps = [thread.updatedAt, thread.session?.updatedAt, thread.latestTurn?.completedAt];
  let latest = Number.NEGATIVE_INFINITY;
  for (const timestamp of timestamps) {
    if (timestamp == null) continue;
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) latest = Math.max(latest, parsed);
  }
  return latest;
}

/** A single pass over live or cached shells. No extra RPCs or detail subscriptions. */
export function summarizeEnvironmentWork(
  environmentIds: readonly EnvironmentId[],
  threads: readonly EnvironmentThreadShell[],
  now: Date,
): readonly EnvironmentWorkSummary[] {
  const summaries = new Map<EnvironmentId, MutableSummary>();
  for (const environmentId of environmentIds) {
    summaries.set(environmentId, {
      attentionCount: 0,
      workingCount: 0,
      nextThread: null,
      nextKind: null,
      nextActivityAt: Number.NEGATIVE_INFINITY,
    });
  }

  const nowIso = now.toISOString();
  for (const thread of threads) {
    const summary = summaries.get(thread.environmentId);
    if (summary === undefined || thread.archivedAt !== null) continue;

    const needsInput = thread.hasPendingApprovals || thread.hasPendingUserInput;
    const failed = thread.session?.status === "error";
    const working =
      !needsInput &&
      !failed &&
      (thread.session?.status === "running" ||
        thread.session?.status === "starting" ||
        thread.backgroundLiveness === "working" ||
        thread.backgroundLiveness === "monitoring");
    const snoozed = effectiveSnoozed(thread, { now: nowIso });
    const attention =
      !snoozed && (needsInput || failed || (!working && thread.hasActionableProposedPlan));
    if (working) summary.workingCount += 1;
    if (attention) summary.attentionCount += 1;

    if (snoozed) continue;
    const kind: CommandCenterNextKind = attention ? "attention" : working ? "working" : "recent";
    if (kind === "recent" && thread.settledOverride === "settled") continue;
    const timestamp = activityAt(thread);
    if (
      summary.nextKind === null ||
      KIND_PRIORITY[kind] > KIND_PRIORITY[summary.nextKind] ||
      (kind === summary.nextKind && timestamp > summary.nextActivityAt)
    ) {
      summary.nextThread = thread;
      summary.nextKind = kind;
      summary.nextActivityAt = timestamp;
    }
  }

  return environmentIds.map((environmentId) => {
    const summary = summaries.get(environmentId)!;
    return {
      environmentId,
      attentionCount: summary.attentionCount,
      workingCount: summary.workingCount,
      nextThread: summary.nextThread,
      nextKind: summary.nextKind,
    };
  });
}
