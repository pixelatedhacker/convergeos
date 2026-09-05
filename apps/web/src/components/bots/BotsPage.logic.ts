export type BotAvailability = "attention" | "working" | "failed" | "available";

interface BotStatusInput {
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly session: { readonly status: string } | null;
  readonly latestTurn: { readonly state: string } | null;
  readonly backgroundLiveness?: "working" | "monitoring" | null | undefined;
}

export function resolveBotAvailability(thread: BotStatusInput): BotAvailability {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "attention";
  if (thread.session?.status === "starting" || thread.session?.status === "running")
    return "working";
  if (thread.session?.status === "error") return "failed";
  if (thread.latestTurn?.state === "running") return "working";
  if (thread.backgroundLiveness === "working" || thread.backgroundLiveness === "monitoring") {
    return "working";
  }
  if (thread.latestTurn?.state === "error") return "failed";
  return "available";
}

export function botAvailabilityLabel(
  availability: BotAvailability,
  thread: Pick<BotStatusInput, "hasPendingApprovals" | "hasPendingUserInput">,
): string {
  if (availability === "attention") {
    return thread.hasPendingApprovals ? "Needs approval" : "Needs input";
  }
  if (availability === "working") return "Working";
  if (availability === "failed") return "Failed";
  return "Available";
}

interface BotCandidateInput {
  readonly archivedAt: string | null;
  readonly botProfile?: { readonly displayName: string } | null | undefined;
  readonly worktreePath: string | null;
}

export function isBotCandidate(thread: BotCandidateInput, supportsBotProfiles: boolean): boolean {
  return (
    supportsBotProfiles &&
    thread.archivedAt === null &&
    thread.botProfile == null &&
    thread.worktreePath !== null
  );
}

interface NamedBotInput {
  readonly botProfile?: { readonly displayName: string } | null | undefined;
  readonly updatedAt: string;
}

export function sortBotThreads<T extends NamedBotInput>(threads: ReadonlyArray<T>): T[] {
  return threads.toSorted((left, right) => {
    const leftName = left.botProfile?.displayName ?? "";
    const rightName = right.botProfile?.displayName ?? "";
    return leftName.localeCompare(rightName) || right.updatedAt.localeCompare(left.updatedAt);
  });
}

export function reconcileSelectedBotKey<T extends { readonly key: string }>(
  selectedKey: string | null,
  bots: ReadonlyArray<T>,
): string | null {
  if (selectedKey !== null && bots.some((bot) => bot.key === selectedKey)) return selectedKey;
  return bots[0]?.key ?? null;
}

export function botFleetSummary(bots: ReadonlyArray<BotStatusInput>): {
  readonly attention: number;
  readonly working: number;
  readonly available: number;
} {
  let attention = 0;
  let working = 0;
  let available = 0;

  for (const bot of bots) {
    const availability = resolveBotAvailability(bot);
    if (availability === "attention" || availability === "failed") attention += 1;
    else if (availability === "working") working += 1;
    else available += 1;
  }

  return { attention, working, available };
}

export function canDispatchToBot(availability: BotAvailability): boolean {
  return availability === "available" || availability === "failed";
}

export function updateBotDispatchDraft(
  drafts: ReadonlyMap<string, string>,
  botKey: string,
  message: string,
): ReadonlyMap<string, string> {
  const next = new Map(drafts);
  if (message.length === 0) next.delete(botKey);
  else next.set(botKey, message);
  return next;
}

export function updateBusyBotKeys(
  keys: ReadonlySet<string>,
  botKey: string,
  busy: boolean,
): ReadonlySet<string> {
  const next = new Set(keys);
  if (busy) next.add(botKey);
  else next.delete(botKey);
  return next;
}
