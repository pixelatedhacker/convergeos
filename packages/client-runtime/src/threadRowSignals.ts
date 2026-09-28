import type {
  OrchestrationTurnDiffStat,
  PullRequestChecksState,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";

export interface ThreadRowDiffStat {
  readonly insertions: number;
  readonly deletions: number;
  /** What the counts describe: the pull request, or the thread's last turn. */
  readonly source: "pull-request" | "turn";
  /** Tooltip and accessibility text, e.g. "Last turn: +12 −3 in 2 files". */
  readonly label: string;
}

export interface ThreadRowSignals {
  /** Line counts for the row's diff slot, or null when nothing trustworthy is known. */
  readonly diff: ThreadRowDiffStat | null;
  /** CI rollup for the glyph beside the PR badge; only reported for open pull requests. */
  readonly checks: PullRequestChecksState | null;
}

const NO_SIGNALS: ThreadRowSignals = { diff: null, checks: null };

function pullRequestDiff(insertions: number, deletions: number): ThreadRowDiffStat {
  return {
    insertions,
    deletions,
    source: "pull-request",
    label: `Pull request: +${insertions} −${deletions}`,
  };
}

function turnDiff(stat: OrchestrationTurnDiffStat | null | undefined): ThreadRowDiffStat | null {
  if (!stat || (stat.additions === 0 && stat.deletions === 0)) return null;
  const files = `${stat.files} ${stat.files === 1 ? "file" : "files"}`;
  return {
    insertions: stat.additions,
    deletions: stat.deletions,
    source: "turn",
    label: `Last turn: +${stat.additions} −${stat.deletions} in ${files}`,
  };
}

/**
 * What a sidebar thread row shows beside its PR badge, on web and mobile alike.
 *
 * The pull request is the one the badge already targets (`resolveThreadCurrentPullRequestLink`:
 * the open PR, or a stack's highest open layer), so the stats and the glyph always describe the
 * PR a click opens. Its host line counts win over `turnDiff`, the shell's `latestTurnDiffStat`
 * (the last turn's checkpoint totals). Counts must be reported and not both zero: hosts that omit
 * line counts would otherwise read as an empty change set. `diff.label` names the source, so the
 * two never read alike.
 *
 * Only data persisted on the thread shell is read, so this costs nothing on the wire.
 * Environments without multi-link support (`supportsPullRequestLinks: false`) carry no snapshots.
 */
export function resolveThreadRowSignals(input: {
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  readonly supportsPullRequestLinks: boolean;
  readonly turnDiff?: OrchestrationTurnDiffStat | null | undefined;
}): ThreadRowSignals {
  const lastTurn = turnDiff(input.turnDiff);
  const snapshot = input.supportsPullRequestLinks
    ? (resolveThreadCurrentPullRequestLink(input.pullRequests)?.snapshot ?? null)
    : null;
  if (snapshot === null) return lastTurn === null ? NO_SIGNALS : { diff: lastTurn, checks: null };

  const { additions, deletions } = snapshot;
  const prDiff =
    additions !== undefined && deletions !== undefined && (additions > 0 || deletions > 0)
      ? pullRequestDiff(additions, deletions)
      : null;
  // A merged or closed PR's last CI run is history, not a signal worth a glyph.
  const checks = snapshot.state === "open" ? (snapshot.checksState ?? null) : null;
  return { diff: prDiff ?? lastTurn, checks };
}
