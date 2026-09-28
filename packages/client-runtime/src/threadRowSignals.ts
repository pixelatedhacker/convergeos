import type { PullRequestChecksState, ThreadPullRequestLink } from "@t3tools/contracts";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";

export interface ThreadRowDiffStat {
  readonly insertions: number;
  readonly deletions: number;
}

export interface ThreadRowSignals {
  /** Line counts for the row's diff slot, or null when nothing trustworthy is known. */
  readonly diff: ThreadRowDiffStat | null;
  /** CI rollup for the glyph beside the PR badge; only reported for open pull requests. */
  readonly checks: PullRequestChecksState | null;
}

const NO_SIGNALS: ThreadRowSignals = { diff: null, checks: null };

/**
 * What a sidebar thread row shows beside its PR badge, on web and mobile alike.
 *
 * The pull request is the one the badge already targets (`resolveThreadCurrentPullRequestLink`:
 * the open PR, or a stack's highest open layer), so the stats and the glyph always describe the
 * PR a click opens. Its host line counts win over `turnDiff`, the seam for per-turn checkpoint
 * stats on threads without a PR. Both counts must be reported and not both zero: hosts that omit
 * line counts would otherwise read as an empty change set.
 *
 * Only snapshots persisted on the thread shell are read, so this costs nothing on the wire.
 * Environments without multi-link support (`supportsPullRequestLinks: false`) carry no snapshots.
 */
export function resolveThreadRowSignals(input: {
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  readonly supportsPullRequestLinks: boolean;
  readonly turnDiff?: ThreadRowDiffStat | null;
}): ThreadRowSignals {
  const turnDiff = input.turnDiff ?? null;
  const snapshot = input.supportsPullRequestLinks
    ? (resolveThreadCurrentPullRequestLink(input.pullRequests)?.snapshot ?? null)
    : null;
  if (snapshot === null) return turnDiff === null ? NO_SIGNALS : { diff: turnDiff, checks: null };

  const { additions, deletions } = snapshot;
  const pullRequestDiff =
    additions !== undefined && deletions !== undefined && (additions > 0 || deletions > 0)
      ? { insertions: additions, deletions }
      : null;
  // A merged or closed PR's last CI run is history, not a signal worth a glyph.
  const checks = snapshot.state === "open" ? (snapshot.checksState ?? null) : null;
  return { diff: pullRequestDiff ?? turnDiff, checks };
}
