import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type Delegation,
  EventId,
  type KanbanCard,
  type KanbanPlacement,
  MAX_SCRIPT_ID_LENGTH,
  SCRIPT_RUN_COMMAND_PATTERN,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ThreadLinkedPullRequest,
  UserInputRequestedPayload,
  isImportedAgentSessionMessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type Schedule,
} from "@t3tools/contracts";
import { compareDateTimeStrings } from "@t3tools/shared/dateTime";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as PlatformError from "effect/PlatformError";

import {
  OrchestrationCommandInvariantError,
  OrchestrationThreadSettleBlockedError,
  type OrchestrationCommandRejection,
} from "./Errors.ts";
import { isValidScheduleTimeZone, nextRunAfter } from "./SchedulePolicy.ts";
import {
  listThreadsByProjectId,
  requireActiveProject,
  requireActiveProjectWorkspaceRootAbsent,
  requireActiveThread,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
} from "./commandInvariants.ts";
import { projectEvent } from "./projector.ts";
import { threadHasQueuedTurnStart } from "./ThreadSettlementPolicy.ts";
import type { DelegationDecisionReadModel } from "../delegation/commandReadModel.ts";

const isScriptRunCommand = Schema.is(SCRIPT_RUN_COMMAND_PATTERN);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const decodeUserInputRequestedPayload = Schema.decodeUnknownOption(UserInputRequestedPayload);
const threadPullRequestLinksEqual = Schema.toEquivalence(Schema.NullOr(ThreadLinkedPullRequest));

const KANBAN_ORDER_DIGITS = "abcdefghijklmnopqrstuvwxyz";

function isValidKanbanOrderKey(key: string): boolean {
  return (
    key.length > 0 &&
    [...key].every((character) => KANBAN_ORDER_DIGITS.includes(character)) &&
    key.at(-1) !== KANBAN_ORDER_DIGITS[0]
  );
}

function kanbanOrderMidpoint(before: string, after: string): string {
  if (after !== "" && before >= after) {
    throw new Error("kanban order bounds are invalid");
  }
  if (after !== "") {
    let shared = 0;
    while ((before.charAt(shared) || KANBAN_ORDER_DIGITS[0]) === after.charAt(shared)) {
      shared += 1;
    }
    if (shared > 0) {
      return (
        after.slice(0, shared) + kanbanOrderMidpoint(before.slice(shared), after.slice(shared))
      );
    }
  }
  const beforeDigit = before === "" ? 0 : KANBAN_ORDER_DIGITS.indexOf(before.charAt(0));
  const afterDigit =
    after === "" ? KANBAN_ORDER_DIGITS.length : KANBAN_ORDER_DIGITS.indexOf(after.charAt(0));
  if (beforeDigit < 0 || afterDigit < 0) throw new Error("kanban order key is invalid");
  if (afterDigit - beforeDigit > 1) {
    return KANBAN_ORDER_DIGITS.charAt(Math.round((beforeDigit + afterDigit) / 2));
  }
  if (after.length > 1) return after.charAt(0);
  return KANBAN_ORDER_DIGITS.charAt(beforeDigit) + kanbanOrderMidpoint(before.slice(1), "");
}

function kanbanOrderKeyBetween(before: string | null, after: string | null): string | null {
  const lower = before ?? "";
  const upper = after ?? "";
  if (lower !== "" && !isValidKanbanOrderKey(lower)) return null;
  if (upper !== "" && !isValidKanbanOrderKey(upper)) return null;
  if (upper !== "" && lower >= upper) return null;
  return kanbanOrderMidpoint(lower, upper);
}

function orderKeyForPlacement(input: {
  readonly cards: ReadonlyArray<KanbanCard>;
  readonly projectId: KanbanCard["projectId"];
  readonly movingCardId: KanbanCard["id"] | null;
  readonly placement: KanbanPlacement;
}): string | null {
  const cards = input.cards
    .filter(
      (card) =>
        card.projectId === input.projectId &&
        card.deletedAt === null &&
        card.status === input.placement.status &&
        card.id !== input.movingCardId,
    )
    .sort(
      (left, right) =>
        left.orderKey.localeCompare(right.orderKey) || left.id.localeCompare(right.id),
    );
  let before: string | null = null;
  let after: string | null = null;
  if (input.placement.relation === "first") {
    after = cards[0]?.orderKey ?? null;
  } else if (input.placement.relation === "last") {
    before = cards.at(-1)?.orderKey ?? null;
  } else if ("cardId" in input.placement) {
    const targetCardId = input.placement.cardId;
    const targetIndex = cards.findIndex((card) => card.id === targetCardId);
    if (targetIndex < 0) return null;
    if (input.placement.relation === "before") {
      before = targetIndex > 0 ? (cards[targetIndex - 1]?.orderKey ?? null) : null;
      after = cards[targetIndex]?.orderKey ?? null;
    } else {
      before = cards[targetIndex]?.orderKey ?? null;
      after = cards[targetIndex + 1]?.orderKey ?? null;
    }
  }
  return kanbanOrderKeyBetween(before, after);
}

/**
 * Blocked-on-you work derived from the thread's retained activities: an
 * approval or user-input request with no later resolution for the same
 * requestId. The server-side twin of the shell's hasPendingApprovals /
 * hasPendingUserInput flags, which the decider read model does not carry.
 * The clearing rules MUST match ProjectionPipeline's pending accounting —
 * resolved activities always clear, respond.failed clears only when the
 * failure detail marks the request stale/unknown — or settle would be
 * rejected on threads whose shell flags read as clear.
 */
function isStaleRequestFailureDetail(payload: Record<string, unknown> | null): boolean {
  const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
  if (detail === null) return false;
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request") ||
    detail.includes("stale pending user-input request") ||
    detail.includes("unknown pending user-input request") ||
    detail.includes("unknown pending user input request") ||
    detail.includes("unknown pending codex user input request")
  );
}

// Scans the read model's activities, which the projector caps at the most
// recent 500 plus pending async questions. Async questions remain actionable
// while the agent works, so they must not expire with the activity window.
function openRequests(thread: Pick<OrchestrationThread, "activities">) {
  const requests = new Map<string, OrchestrationThreadActivity>();
  for (const activity of thread.activities) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      requests.set(requestId, activity);
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      requests.delete(requestId);
    } else if (
      (activity.kind === "provider.approval.respond.failed" ||
        activity.kind === "provider.user-input.respond.failed") &&
      isStaleRequestFailureDetail(payload)
    ) {
      requests.delete(requestId);
    }
  }
  return requests;
}

function hasOpenBlockingRequest(thread: Pick<OrchestrationThread, "activities">): boolean {
  return openRequests(thread).size > 0;
}

/** Apply the shared shell-level rule to the detailed command read model. */
function hasQueuedTurnStartForThread(
  thread: Pick<OrchestrationThread, "messages" | "latestTurn" | "session">,
  now: string,
): boolean {
  let latestUserMessageAt: string | null = null;
  let latestUserMessageAtMs = Number.NEGATIVE_INFINITY;
  for (const message of thread.messages) {
    if (message.role !== "user" || isImportedAgentSessionMessageId(message.id)) continue;
    const messageAtMs = Date.parse(message.createdAt);
    latestUserMessageAtMs = Math.max(latestUserMessageAtMs, messageAtMs);
    if (messageAtMs === latestUserMessageAtMs) {
      latestUserMessageAt = message.createdAt;
    }
  }
  return threadHasQueuedTurnStart(
    {
      latestUserMessageAt: Number.isFinite(latestUserMessageAtMs) ? latestUserMessageAt : null,
      latestTurn: thread.latestTurn,
      session: thread.session,
    },
    now,
  );
}

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Effect.Effect<
  Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  PlatformError.PlatformError,
  Crypto.Crypto
> {
  return Crypto.Crypto.pipe(
    Effect.flatMap((crypto) =>
      crypto.randomUUIDv4.pipe(
        Effect.map((eventId) => ({
          eventId: EventId.make(eventId),
          aggregateKind: input.aggregateKind,
          aggregateId: input.aggregateId,
          occurredAt: input.occurredAt,
          commandId: input.commandId,
          causationEventId: null,
          correlationId: input.commandId,
          metadata: input.metadata ?? {},
        })),
      ),
    ),
  );
}

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

type DecideOrchestrationCommandResult =
  | PlannedOrchestrationEvent
  | ReadonlyArray<PlannedOrchestrationEvent>;

function sameDelegationRequester(
  left: Delegation["requester"],
  right: Delegation["requester"],
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "thread" && right.kind === "thread") {
    return left.threadId === right.threadId && left.requestId === right.requestId;
  }
  if (left.kind === "kanban" && right.kind === "kanban") {
    return left.cardId === right.cardId && left.cardRevision === right.cardRevision;
  }
  return false;
}

function findDelegation(
  readModel: DelegationDecisionReadModel,
  delegationId: Delegation["id"],
): Delegation | undefined {
  return readModel.delegations?.find((delegation) => delegation.id === delegationId);
}

function isTerminalDelegation(delegation: Delegation): boolean {
  return (
    delegation.state === "completed" ||
    delegation.state === "failed" ||
    delegation.state === "interrupted"
  );
}

const decideCommandSequence = Effect.fn("decideCommandSequence")(function* ({
  commands,
  readModel,
}: {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly readModel: DelegationDecisionReadModel;
}): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  OrchestrationCommandRejection | PlatformError.PlatformError,
  Crypto.Crypto
> {
  let nextReadModel = readModel;
  let nextSequence = readModel.snapshotSequence;
  const plannedEvents: PlannedOrchestrationEvent[] = [];

  for (const nextCommand of commands) {
    const decided = yield* decideOrchestrationCommand({
      command: nextCommand,
      readModel: nextReadModel,
    });
    const nextEvents = Array.isArray(decided) ? decided : [decided];
    for (const nextEvent of nextEvents) {
      plannedEvents.push(nextEvent);
      nextSequence += 1;
      const projected = yield* projectEvent(nextReadModel, {
        ...nextEvent,
        sequence: nextSequence,
      }).pipe(Effect.orDie);
      nextReadModel = {
        ...projected,
        ...(nextReadModel.delegations === undefined
          ? {}
          : { delegations: nextReadModel.delegations }),
      };
    }
  }

  return plannedEvents;
});

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
  userInputActivity,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: DelegationDecisionReadModel;
  readonly userInputActivity?: OrchestrationThreadActivity;
}): Effect.fn.Return<
  DecideOrchestrationCommandResult,
  OrchestrationCommandRejection | PlatformError.PlatformError,
  Crypto.Crypto
> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireActiveProjectWorkspaceRootAbsent({
        readModel,
        command,
        workspaceRoot: command.workspaceRoot,
        exceptProjectId: command.projectId,
      });

      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          // Project creation has no user model choice. Older clients sent an
          // automatic seed here, but only a metadata update records an
          // explicit project default.
          defaultModelSelection: null,
          faviconPath: null,
          projectIcon: null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      const project = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (command.scripts !== undefined) {
        // Persisted IDs predate shortcut validation. Let users edit or remove them
        // without allowing another invalid ID to enter the project.
        const existingIds = new Set(project.scripts.map((script) => script.id));
        for (const script of command.scripts) {
          if (!existingIds.has(script.id) && !isScriptRunCommand(`script.${script.id}.run`)) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Script ID '${script.id}' must be 1-${MAX_SCRIPT_ID_LENGTH} lowercase letters, digits or hyphens, starting with a letter or digit.`,
            });
          }
        }
      }
      if (command.workspaceRoot !== undefined) {
        yield* requireActiveProjectWorkspaceRootAbsent({
          readModel,
          command,
          workspaceRoot: command.workspaceRoot,
          exceptProjectId: command.projectId,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.defaultThreadEnvMode !== undefined
            ? { defaultThreadEnvMode: command.defaultThreadEnvMode }
            : {}),
          ...(command.autoPull !== undefined ? { autoPull: command.autoPull } : {}),
          ...(command.faviconPath !== undefined ? { faviconPath: command.faviconPath } : {}),
          ...(command.projectIcon !== undefined ? { projectIcon: command.projectIcon } : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const activeThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      );
      if (activeThreads.length > 0 && command.force !== true) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is not empty and cannot be deleted without force=true.`,
        });
      }
      if (activeThreads.length > 0) {
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...activeThreads.map(
              (thread): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
                type: "thread.delete",
                commandId: command.commandId,
                threadId: thread.id,
              }),
            ),
            {
              type: "project.delete",
              commandId: command.commandId,
              projectId: command.projectId,
            },
          ],
        });
      }

      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.deleted" as const,
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(command.historyImport === true ? { metadata: { historyImport: true } } : {}),
        })),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.delete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.botProfile != null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} is a bot inbox; disable the bot before deleting it`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.archive": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.botProfile != null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} is a bot inbox; disable the bot before archiving it`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.settle":
    case "thread.auto-settle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.type === "thread.auto-settle" && thread.settledOverride !== null) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} changed before automatic settlement`,
          }),
        );
      }
      // The server owns settle eligibility. A stale command must not settle
      // a thread whose session is coming alive or working.
      if (thread.session?.status === "starting" || thread.session?.status === "running") {
        return yield* new OrchestrationThreadSettleBlockedError({ threadId: command.threadId });
      }
      const pendingRequests = openRequests(thread);
      // Manual settlement dismisses async questions without answering them.
      // Native callbacks and approvals still need a response or interruption.
      if (
        Array.from(pendingRequests.values()).some(
          (activity) =>
            command.type === "thread.auto-settle" ||
            activity.kind !== "user-input.requested" ||
            !Predicate.isObject(activity.payload) ||
            activity.payload.responseMode !== "message",
        )
      ) {
        return yield* new OrchestrationThreadSettleBlockedError({ threadId: command.threadId });
      }
      const occurredAt = yield* nowIso;
      // Settling inside the adoption window would hide just-requested work.
      if (hasQueuedTurnStartForThread(thread, occurredAt)) {
        return yield* new OrchestrationThreadSettleBlockedError({ threadId: command.threadId });
      }
      // Settling an already-settled thread re-emits with the original
      // settledAt: the engine rejects zero-event commands, and bulk-settle /
      // double-click must stay silent no-ops rather than surface errors.
      const alreadySettled = thread.settledOverride === "settled" && thread.settledAt !== null;
      const settledEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.settled" as const,
        payload: {
          threadId: command.threadId,
          settledAt: alreadySettled
            ? thread.settledAt
            : command.type === "thread.auto-settle"
              ? command.settledAt
              : occurredAt,
          // A re-emission is a projected no-op: keep the existing updatedAt
          // so duplicate settles neither rewind nor churn ordering. A fresh
          // settle stamps the command time.
          updatedAt: alreadySettled ? thread.updatedAt : occurredAt,
        },
      };
      // Settling is "I'm done with this": clear states that would keep the
      // row pinned or snoozed instead of showing the new settled state.
      const companionEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      for (const [requestId, request] of pendingRequests) {
        companionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.activity-appended",
          payload: {
            threadId: command.threadId,
            activity: {
              id: EventId.make(`settle:${command.commandId}:${requestId}`),
              kind: "user-input.resolved",
              summary: "User input dismissed",
              tone: "info",
              turnId: request.turnId,
              createdAt: occurredAt,
              payload: { requestId, responseMode: "message" },
            },
          },
        });
      }
      if (thread.pinnedAt != null) {
        companionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unpinned" as const,
          payload: {
            threadId: command.threadId,
            updatedAt: occurredAt,
          },
        });
      }
      if (thread.snoozedUntil != null) {
        companionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      return companionEvents.length > 0 ? [settledEvent, ...companionEvents] : settledEvent;
    }

    case "thread.unsettle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): reducing the event a
      // second time lands on the same override state. A re-emission keeps
      // the existing updatedAt so duplicates do not churn ordering.
      const alreadyPinnedActive = thread.settledOverride === "active";
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyPinnedActive ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.snooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // A wake time in the past would create a thread that is snoozed and
      // woken at once — the row would never leave the inbox but still carry
      // snooze state. Reject instead of silently normalizing. The negated
      // comparison also catches unparseable wake times (IsoDateTime is
      // structurally just a string): NaN fails every comparison, and an
      // unparseable snoozedUntil must never persist.
      if (!(Date.parse(command.snoozedUntil) > Date.parse(occurredAt))) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} snooze wake time ${command.snoozedUntil} is not in the future`,
          }),
        );
      }
      // Blocked-on-you work must not be snoozed away: a pending approval or
      // user-input request is the agent waiting on the user, and hiding it
      // defeats the request. (A running session IS snoozable — snooze only
      // affects visibility, never the agent.)
      if (openRequests(thread).size > 0) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a pending approval or user-input request and cannot be snoozed`,
          }),
        );
      }
      // A queued turn start — a user message no turn has adopted yet — is
      // invisible pending work: no session, no pending flags. Snoozing in
      // that window would hide a just-requested turn exactly the way settle
      // would.
      if (hasQueuedTurnStartForThread(thread, occurredAt)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a queued turn start and cannot be snoozed`,
          }),
        );
      }
      // Re-snoozing an already-snoozed thread to the SAME wake time is a
      // duplicate (double-click, raced clients): re-emit with the original
      // timestamps so the projection is a no-op. A different wake time is a
      // real change and stamps fresh.
      const existingSnoozedAt =
        thread.snoozedUntil === command.snoozedUntil && thread.snoozedAt != null
          ? thread.snoozedAt
          : null;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.snoozed",
        payload: {
          threadId: command.threadId,
          snoozedUntil: command.snoozedUntil,
          snoozedAt: existingSnoozedAt ?? occurredAt,
          updatedAt: existingSnoozedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.unsnooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): waking a thread that
      // is not snoozed lands on the same null state without churning
      // updatedAt.
      const alreadyAwake = thread.snoozedUntil == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unsnoozed",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyAwake ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // Re-pinning an already-pinned thread is a duplicate (double-click,
      // raced clients): re-emit with the original timestamps so the
      // projection is a no-op. Pinning has no lifecycle invariants — a pin
      // only ever promotes visibility, so it can never hide pending work.
      const existingPinnedAt = thread.pinnedAt ?? null;
      const pinnedEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pinned" as const,
        payload: {
          threadId: command.threadId,
          pinnedAt: existingPinnedAt ?? occurredAt,
          // A fresh pin takes the client's slot in the arranged order; on a
          // re-pin the existing key wins so raced duplicates cannot move a
          // thread the user already placed.
          ...(existingPinnedAt === null && command.orderKey !== undefined
            ? { pinOrderKey: command.orderKey }
            : {}),
          updatedAt: existingPinnedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
      // Pinning is a promotion: it clears the parked states rather than
      // silently outranking them. An explicit settle un-settles (reason
      // "user", same override the un-settle button stamps), and a snooze's
      // return ticket is spent — the thread is on top NOW, not on Tuesday.
      const promotionEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (thread.settledOverride === "settled") {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      if (thread.snoozedUntil != null) {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      return promotionEvents.length > 0 ? [pinnedEvent, ...promotionEvents] : pinnedEvent;
    }

    case "thread.unpin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): unpinning a thread
      // that is not pinned lands on the same null state without churning
      // updatedAt.
      const alreadyUnpinned = thread.pinnedAt == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unpinned",
        payload: {
          threadId: command.threadId,
          updatedAt: alreadyUnpinned ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin.reorder": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Only pinned threads have a slot in the arranged order. Rejecting
      // (rather than silently pinning) keeps a raced reorder-after-unpin
      // from resurrecting a pin the user just cleared.
      if (thread.pinnedAt == null) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} is not pinned and cannot be reordered`,
          }),
        );
      }
      // Idempotent by re-emission (see thread.settle): a duplicate drop on
      // the same slot keeps the existing updatedAt so it projects as a no-op.
      const keyUnchanged = thread.pinOrderKey === command.orderKey;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pin-reordered",
        payload: {
          threadId: command.threadId,
          orderKey: command.orderKey,
          updatedAt: keyUnchanged ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.active.reorder": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // Snooze retains this slot. Changing it cannot wake the thread, and
      // accepting it handles races with snooze and retained wake timestamps.
      if (
        thread.deletedAt !== null ||
        thread.pinnedAt != null ||
        thread.settledOverride === "settled"
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} is not active and cannot be reordered`,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          activeOrderKey: command.orderKey,
          // Arranging the list is not thread activity or a lifecycle transition.
          updatedAt: thread.updatedAt,
        },
      };
    }

    case "thread.meta.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const branch =
        command.branch !== undefined &&
        command.expectedBranch !== undefined &&
        thread.branch !== command.expectedBranch
          ? thread.branch
          : command.branch;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.regenerateTitle === true
            ? {
                regenerateTitle: true as const,
                previousTitle: thread.title,
                titleRegeneration: {
                  requestId: command.commandId,
                  startedAt: occurredAt,
                },
              }
            : {}),
          ...(command.title !== undefined && thread.titleRegeneration != null
            ? { titleRegeneration: null }
            : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(branch !== undefined ? { branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          ...(command.linkedPullRequest !== undefined
            ? { linkedPullRequest: command.linkedPullRequest }
            : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pull-request.sync": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} was deleted before pull request discovery`,
        });
      }
      if (
        thread.projectId !== command.projectId ||
        thread.branch !== command.expected.branch ||
        thread.worktreePath !== command.expected.worktreePath ||
        !threadPullRequestLinksEqual(
          thread.linkedPullRequest ?? null,
          command.expected.linkedPullRequest,
        ) ||
        !threadPullRequestLinksEqual(
          thread.branchPullRequest ?? null,
          command.expected.branchPullRequest,
        )
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} changed before pull request discovery`,
        });
      }
      const project = yield* requireProject({ readModel, command, projectId: command.projectId });
      if (project.deletedAt !== null || project.workspaceRoot !== command.expected.workspaceRoot) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `project ${command.projectId} changed before pull request discovery`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          branchPullRequest: command.branchPullRequest,
          ...(command.linkedPullRequest !== undefined
            ? { linkedPullRequest: command.linkedPullRequest }
            : {}),
          updatedAt: thread.updatedAt,
        },
      };
    }

    case "thread.bot.configure": {
      const thread = yield* requireActiveThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const project = yield* requireActiveProject({
        readModel,
        command,
        projectId: thread.projectId,
      });
      const workspacePath = thread.worktreePath;
      if (
        workspacePath === null ||
        normalizeProjectPathForComparison(workspacePath) ===
          normalizeProjectPathForComparison(project.workspaceRoot)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} needs an isolated worktree before it can become a bot`,
        });
      }
      const conflictingBot = readModel.threads.find(
        (candidate) =>
          candidate.id !== thread.id &&
          candidate.deletedAt === null &&
          candidate.botProfile != null &&
          normalizeProjectPathForComparison(candidate.worktreePath ?? project.workspaceRoot) ===
            normalizeProjectPathForComparison(workspacePath),
      );
      if (conflictingBot !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} shares the bot worktree owned by ${conflictingBot.id}`,
        });
      }
      const currentProfile = thread.botProfile ?? null;
      const currentRevision = currentProfile?.revision ?? null;
      if (currentRevision !== command.expectedRevision) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} bot profile revision changed`,
        });
      }
      const updatedAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: updatedAt,
          commandId: command.commandId,
        })),
        type: "thread.bot-configured",
        payload: {
          threadId: command.threadId,
          profile: {
            displayName: command.displayName,
            description: command.description,
            revision: (currentRevision ?? 0) + 1,
            createdAt: currentProfile?.createdAt ?? command.createdAt,
            updatedAt,
          },
        },
      };
    }

    case "thread.bot.disable": {
      const thread = yield* requireActiveThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.botProfile == null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} is not a bot inbox`,
        });
      }
      if (thread.botProfile.revision !== command.expectedRevision) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} bot profile revision changed`,
        });
      }
      const disabledAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: disabledAt,
          commandId: command.commandId,
        })),
        type: "thread.bot-disabled",
        payload: {
          threadId: command.threadId,
          previousRevision: thread.botProfile.revision,
          disabledAt,
        },
      };
    }

    case "schedule.create": {
      yield* requireActiveProject({ readModel, command, projectId: command.projectId });
      if ((readModel.schedules ?? []).some((schedule) => schedule.id === command.scheduleId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `schedule ${command.scheduleId} already exists`,
        });
      }
      if (!isValidScheduleTimeZone(command.timeZone)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `schedule time zone '${command.timeZone}' is not a valid IANA time zone`,
        });
      }
      const nextRunAt = nextRunAfter(command.recurrence, command.timeZone, command.createdAt);
      if (command.enabled && nextRunAt === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `schedule ${command.scheduleId} has no future run time`,
        });
      }
      const updatedAt = yield* nowIso;
      const schedule: Schedule = {
        id: command.scheduleId,
        projectId: command.projectId,
        title: command.title,
        prompt: command.prompt,
        recurrence: command.recurrence,
        timeZone: command.timeZone,
        modelSelection: command.modelSelection,
        runtimeMode: command.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        interactionMode: command.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        enabled: command.enabled,
        nextRunAt: command.enabled ? nextRunAt : null,
        lastRunAt: null,
        revision: 1,
        createdAt: command.createdAt,
        updatedAt,
        deletedAt: null,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "schedule",
          aggregateId: command.scheduleId,
          occurredAt: updatedAt,
          commandId: command.commandId,
        })),
        type: "schedule.created",
        payload: { schedule },
      };
    }

    case "schedule.update": {
      const current = (readModel.schedules ?? []).find(
        (schedule) => schedule.id === command.scheduleId && schedule.deletedAt === null,
      );
      if (current === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `schedule ${command.scheduleId} is unavailable`,
        });
      }
      yield* requireActiveProject({ readModel, command, projectId: current.projectId });
      if (current.revision !== command.expectedRevision) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `schedule ${command.scheduleId} revision changed`,
        });
      }
      const timeZone = command.timeZone ?? current.timeZone;
      if (!isValidScheduleTimeZone(timeZone)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `schedule time zone '${timeZone}' is not a valid IANA time zone`,
        });
      }
      const recurrence = command.recurrence ?? current.recurrence;
      const enabled = command.enabled ?? current.enabled;
      const timingChanged =
        command.recurrence !== undefined ||
        command.timeZone !== undefined ||
        enabled !== current.enabled;
      const updatedAt = yield* nowIso;
      const nextRunAt = enabled
        ? timingChanged
          ? nextRunAfter(recurrence, timeZone, updatedAt)
          : current.nextRunAt
        : null;
      // Only a timing edit can make a schedule unfireable; unrelated edits
      // (e.g. a title change on an exhausted "once") must stay legal.
      if (timingChanged && enabled && nextRunAt === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `schedule ${command.scheduleId} has no future run time`,
        });
      }
      const schedule: Schedule = {
        ...current,
        ...(command.title === undefined ? {} : { title: command.title }),
        ...(command.prompt === undefined ? {} : { prompt: command.prompt }),
        ...(command.modelSelection === undefined ? {} : { modelSelection: command.modelSelection }),
        ...(command.runtimeMode === undefined ? {} : { runtimeMode: command.runtimeMode }),
        ...(command.interactionMode === undefined
          ? {}
          : { interactionMode: command.interactionMode }),
        recurrence,
        timeZone,
        enabled,
        nextRunAt,
        revision: current.revision + 1,
        updatedAt,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "schedule",
          aggregateId: command.scheduleId,
          occurredAt: updatedAt,
          commandId: command.commandId,
        })),
        type: "schedule.updated",
        payload: { schedule },
      };
    }

    case "schedule.delete": {
      const current = (readModel.schedules ?? []).find(
        (schedule) => schedule.id === command.scheduleId && schedule.deletedAt === null,
      );
      if (current === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `schedule ${command.scheduleId} is unavailable`,
        });
      }
      yield* requireActiveProject({ readModel, command, projectId: current.projectId });
      if (current.revision !== command.expectedRevision) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `schedule ${command.scheduleId} revision changed`,
        });
      }
      const deletedAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "schedule",
          aggregateId: command.scheduleId,
          occurredAt: deletedAt,
          commandId: command.commandId,
        })),
        type: "schedule.deleted",
        payload: {
          projectId: current.projectId,
          scheduleId: command.scheduleId,
          previousRevision: current.revision,
          deletedAt,
        },
      };
    }

    case "schedule.fire": {
      const current = (readModel.schedules ?? []).find(
        (schedule) => schedule.id === command.scheduleId && schedule.deletedAt === null,
      );
      if (current === undefined || !current.enabled || current.nextRunAt === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `schedule ${command.scheduleId} is not runnable`,
        });
      }
      const firedAt = DateTime.make(command.firedAt);
      const dueAt = DateTime.make(current.nextRunAt);
      if (
        Option.isNone(firedAt) ||
        Option.isNone(dueAt) ||
        DateTime.toEpochMillis(dueAt.value) > DateTime.toEpochMillis(firedAt.value)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `schedule ${command.scheduleId} is not due until ${current.nextRunAt}`,
        });
      }
      const schedule: Schedule = {
        ...current,
        lastRunAt: command.firedAt,
        nextRunAt: nextRunAfter(current.recurrence, current.timeZone, command.firedAt),
        revision: current.revision + 1,
        updatedAt: command.firedAt,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "schedule",
          aggregateId: command.scheduleId,
          occurredAt: command.firedAt,
          commandId: command.commandId,
        })),
        type: "schedule.fired",
        payload: { schedule, threadId: command.threadId, firedAt: command.firedAt },
      };
    }

    case "kanban.card.create": {
      yield* requireActiveProject({ readModel, command, projectId: command.projectId });
      const cards = readModel.kanbanCards ?? [];
      if (cards.some((card) => card.id === command.cardId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `kanban card ${command.cardId} already exists`,
        });
      }
      if (command.assigneeThreadId !== null) {
        const assignee = readModel.threads.find(
          (thread) =>
            thread.id === command.assigneeThreadId &&
            thread.projectId === command.projectId &&
            thread.deletedAt === null &&
            thread.archivedAt === null &&
            thread.botProfile != null,
        );
        if (assignee === undefined) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `kanban assignee ${command.assigneeThreadId} is not an active bot in project ${command.projectId}`,
          });
        }
      }
      const orderKey = orderKeyForPlacement({
        cards,
        projectId: command.projectId,
        movingCardId: null,
        placement: command.placement,
      });
      if (orderKey === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "kanban placement target is unavailable in the requested column",
        });
      }
      const updatedAt = yield* nowIso;
      const card: KanbanCard = {
        id: command.cardId,
        projectId: command.projectId,
        title: command.title,
        description: command.description,
        status: command.placement.status,
        orderKey,
        assigneeThreadId: command.assigneeThreadId,
        delegationId: null,
        revision: 1,
        createdAt: command.createdAt,
        updatedAt,
        deletedAt: null,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "kanban-card",
          aggregateId: command.cardId,
          occurredAt: updatedAt,
          commandId: command.commandId,
        })),
        type: "kanban.card-created",
        payload: { card },
      };
    }

    case "kanban.card.update": {
      const cards = readModel.kanbanCards ?? [];
      const current = cards.find((card) => card.id === command.cardId && card.deletedAt === null);
      if (current === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `kanban card ${command.cardId} is unavailable`,
        });
      }
      yield* requireActiveProject({ readModel, command, projectId: current.projectId });
      if (current.revision !== command.expectedRevision) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `kanban card ${command.cardId} revision changed`,
        });
      }
      if (command.assigneeThreadId !== undefined && command.assigneeThreadId !== null) {
        const assignee = readModel.threads.find(
          (thread) =>
            thread.id === command.assigneeThreadId &&
            thread.projectId === current.projectId &&
            thread.deletedAt === null &&
            thread.archivedAt === null &&
            thread.botProfile != null,
        );
        if (assignee === undefined) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `kanban assignee ${command.assigneeThreadId} is not an active bot in project ${current.projectId}`,
          });
        }
      }
      const linkedDelegation =
        current.delegationId === null ? undefined : findDelegation(readModel, current.delegationId);
      const changesCard =
        (command.title !== undefined && command.title !== current.title) ||
        (command.description !== undefined && command.description !== current.description) ||
        (command.assigneeThreadId !== undefined &&
          command.assigneeThreadId !== current.assigneeThreadId);
      if (
        linkedDelegation !== undefined &&
        !isTerminalDelegation(linkedDelegation) &&
        changesCard
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `kanban card ${command.cardId} has active delegated work`,
        });
      }
      if (
        current.delegationId !== null &&
        command.assigneeThreadId !== undefined &&
        command.assigneeThreadId !== current.assigneeThreadId
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `kanban card ${command.cardId} has linked delegation ${current.delegationId}; retry it before changing assignee`,
        });
      }
      const updatedAt = yield* nowIso;
      const card: KanbanCard = {
        ...current,
        ...(command.title === undefined ? {} : { title: command.title }),
        ...(command.description === undefined ? {} : { description: command.description }),
        ...(command.assigneeThreadId === undefined
          ? {}
          : { assigneeThreadId: command.assigneeThreadId }),
        revision: current.revision + 1,
        updatedAt,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "kanban-card",
          aggregateId: command.cardId,
          occurredAt: updatedAt,
          commandId: command.commandId,
        })),
        type: "kanban.card-updated",
        payload: { card },
      };
    }

    case "kanban.card.move": {
      const cards = readModel.kanbanCards ?? [];
      const current = cards.find((card) => card.id === command.cardId && card.deletedAt === null);
      if (current === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `kanban card ${command.cardId} is unavailable`,
        });
      }
      yield* requireActiveProject({ readModel, command, projectId: current.projectId });
      if (current.revision !== command.expectedRevision) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `kanban card ${command.cardId} revision changed`,
        });
      }
      if (
        (command.placement.relation === "before" || command.placement.relation === "after") &&
        command.placement.cardId === command.cardId
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "a kanban card cannot be placed relative to itself",
        });
      }
      const orderKey = orderKeyForPlacement({
        cards,
        projectId: current.projectId,
        movingCardId: current.id,
        placement: command.placement,
      });
      if (orderKey === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "kanban placement target is unavailable in the requested column",
        });
      }
      const updatedAt = yield* nowIso;
      const linkedDelegation =
        current.delegationId === null ? undefined : findDelegation(readModel, current.delegationId);
      const changesColumn = command.placement.status !== current.status;
      if (
        changesColumn &&
        (linkedDelegation?.state === "failed" || linkedDelegation?.state === "interrupted")
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `kanban card ${command.cardId} must be retried explicitly`,
        });
      }
      if (
        changesColumn &&
        linkedDelegation !== undefined &&
        linkedDelegation.state !== "completed" &&
        linkedDelegation.state !== "failed" &&
        linkedDelegation.state !== "interrupted"
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `kanban card ${command.cardId} has active delegated work`,
        });
      }
      const card: KanbanCard = {
        ...current,
        status: command.placement.status,
        orderKey,
        ...(changesColumn && linkedDelegation?.state === "completed" ? { delegationId: null } : {}),
        revision: current.revision + 1,
        updatedAt,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "kanban-card",
          aggregateId: command.cardId,
          occurredAt: updatedAt,
          commandId: command.commandId,
        })),
        type: "kanban.card-moved",
        payload: { card },
      };
    }

    case "kanban.card.delete": {
      const current = (readModel.kanbanCards ?? []).find(
        (card) => card.id === command.cardId && card.deletedAt === null,
      );
      if (current === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `kanban card ${command.cardId} is unavailable`,
        });
      }
      yield* requireActiveProject({ readModel, command, projectId: current.projectId });
      if (current.revision !== command.expectedRevision) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `kanban card ${command.cardId} revision changed`,
        });
      }
      const linkedDelegation =
        current.delegationId === null ? undefined : findDelegation(readModel, current.delegationId);
      if (linkedDelegation !== undefined && !isTerminalDelegation(linkedDelegation)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `kanban card ${command.cardId} has active delegated work`,
        });
      }
      const deletedAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "kanban-card",
          aggregateId: command.cardId,
          occurredAt: deletedAt,
          commandId: command.commandId,
        })),
        type: "kanban.card-deleted",
        payload: {
          projectId: current.projectId,
          cardId: current.id,
          previousRevision: current.revision,
          deletedAt,
        },
      };
    }

    case "kanban.card.retry": {
      const current = (readModel.kanbanCards ?? []).find(
        (card) => card.id === command.cardId && card.deletedAt === null,
      );
      if (current === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `kanban card ${command.cardId} is unavailable`,
        });
      }
      yield* requireActiveProject({ readModel, command, projectId: current.projectId });
      if (current.revision !== command.expectedRevision) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `kanban card ${command.cardId} revision changed`,
        });
      }
      if (current.delegationId === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `kanban card ${command.cardId} has no delegation to retry`,
        });
      }
      const delegation = findDelegation(readModel, current.delegationId);
      if (
        delegation === undefined ||
        (delegation.state !== "failed" && delegation.state !== "interrupted")
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `kanban card ${command.cardId} delegation is not retryable`,
        });
      }
      const updatedAt = yield* nowIso;
      const card: KanbanCard = {
        ...current,
        status: "ready",
        delegationId: null,
        revision: current.revision + 1,
        updatedAt,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "kanban-card",
          aggregateId: command.cardId,
          occurredAt: updatedAt,
          commandId: command.commandId,
        })),
        type: "kanban.card-retried",
        payload: { card },
      };
    }

    case "kanban.card.delegation.link": {
      const current = (readModel.kanbanCards ?? []).find(
        (card) => card.id === command.cardId && card.deletedAt === null,
      );
      const delegation = findDelegation(readModel, command.delegationId);
      if (current === undefined || delegation === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "kanban card or delegation is unavailable",
        });
      }
      if (current.revision !== command.expectedRevision || current.delegationId !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `kanban card ${command.cardId} is no longer available for delegation`,
        });
      }
      if (
        current.status !== "ready" ||
        current.assigneeThreadId === null ||
        delegation.projectId !== current.projectId ||
        delegation.requester.kind !== "kanban" ||
        delegation.requester.cardId !== current.id ||
        delegation.requester.cardRevision !== current.revision ||
        delegation.target.kind !== "existingThread" ||
        delegation.target.threadId !== current.assigneeThreadId
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `delegation ${command.delegationId} does not match ready card ${command.cardId}`,
        });
      }
      const updatedAt = yield* nowIso;
      const card: KanbanCard = {
        ...current,
        delegationId: delegation.id,
        revision: current.revision + 1,
        updatedAt,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "kanban-card",
          aggregateId: command.cardId,
          occurredAt: updatedAt,
          commandId: command.commandId,
        })),
        type: "kanban.card-delegation-linked",
        payload: { card },
      };
    }

    case "kanban.card.delegation.complete": {
      const current = (readModel.kanbanCards ?? []).find(
        (card) => card.id === command.cardId && card.deletedAt === null,
      );
      const delegation = findDelegation(readModel, command.delegationId);
      if (
        current === undefined ||
        current.delegationId !== command.delegationId ||
        delegation === undefined ||
        (delegation.state !== "completed" &&
          delegation.state !== "failed" &&
          delegation.state !== "interrupted")
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `completed delegation ${command.delegationId} is not linked to card ${command.cardId}`,
        });
      }
      const updatedAt = yield* nowIso;
      const card: KanbanCard = {
        ...current,
        status: delegation.state === "completed" ? "review" : "ready",
        revision: current.revision + 1,
        updatedAt,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "kanban-card",
          aggregateId: command.cardId,
          occurredAt: updatedAt,
          commandId: command.commandId,
        })),
        type: "kanban.card-delegation-completed",
        payload: { card },
      };
    }

    case "kanban.card.delegation.start": {
      const current = (readModel.kanbanCards ?? []).find(
        (card) => card.id === command.cardId && card.deletedAt === null,
      );
      const delegation = findDelegation(readModel, command.delegationId);
      if (
        current === undefined ||
        current.delegationId !== command.delegationId ||
        current.status !== "ready" ||
        delegation?.state !== "running"
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `running delegation ${command.delegationId} is not ready on card ${command.cardId}`,
        });
      }
      const updatedAt = yield* nowIso;
      const card: KanbanCard = {
        ...current,
        status: "inProgress",
        revision: current.revision + 1,
        updatedAt,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "kanban-card",
          aggregateId: command.cardId,
          occurredAt: updatedAt,
          commandId: command.commandId,
        })),
        type: "kanban.card-delegation-started",
        payload: { card },
      };
    }

    case "thread.title.regeneration.complete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestIsCurrent = thread.titleRegeneration?.requestId === command.requestId;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(requestIsCurrent && command.title !== undefined ? { title: command.title } : {}),
          ...(requestIsCurrent ? { titleRegeneration: null } : {}),
          updatedAt: requestIsCurrent ? occurredAt : thread.updatedAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "delegation.request": {
      const project = yield* requireActiveProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const delegations = readModel.delegations ?? [];
      if (delegations.some((delegation) => delegation.id === command.delegationId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `delegation ${command.delegationId} already exists`,
        });
      }
      const duplicateRequester = delegations.find((delegation) =>
        sameDelegationRequester(delegation.requester, command.requester),
      );
      if (duplicateRequester !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `request already belongs to delegation ${duplicateRequester.id}`,
        });
      }

      let kanbanRequesterCard: KanbanCard | null = null;
      if (command.requester.kind === "thread") {
        const requesterThread = yield* requireActiveThread({
          readModel,
          command,
          threadId: command.requester.threadId,
        });
        if (requesterThread.projectId !== command.projectId) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "requester thread belongs to another project",
          });
        }
      } else {
        const requester = command.requester;
        const card = (readModel.kanbanCards ?? []).find(
          (candidate) => candidate.id === requester.cardId && candidate.deletedAt === null,
        );
        if (card === undefined || card.projectId !== command.projectId) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "requester Kanban card is not active in this project",
          });
        }
        if (card.revision !== requester.cardRevision) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `requester Kanban card revision is ${card.revision}, expected ${requester.cardRevision}`,
          });
        }
        if (
          card.status !== "ready" ||
          card.assigneeThreadId === null ||
          card.delegationId !== null ||
          command.target.kind !== "existingThread" ||
          command.target.threadId !== card.assigneeThreadId
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "requester Kanban card is no longer ready for its assigned bot",
          });
        }
        kanbanRequesterCard = card;
      }

      let targetThreadId = null;
      if (command.target.kind === "existingThread") {
        const targetThread = yield* requireActiveThread({
          readModel,
          command,
          threadId: command.target.threadId,
        });
        if (targetThread.projectId !== command.projectId) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "target thread belongs to another project",
          });
        }
        if (
          command.requester.kind === "thread" &&
          command.requester.threadId === command.target.threadId
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "a thread cannot delegate work to itself",
          });
        }
        if (targetThread.botProfile == null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "target thread is not an active bot",
          });
        }
        if (
          targetThread.worktreePath === null ||
          normalizeProjectPathForComparison(targetThread.worktreePath) ===
            normalizeProjectPathForComparison(project.workspaceRoot)
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "target bot does not own an isolated worktree",
          });
        }
        const targetSessionBusy =
          targetThread.session?.status === "starting" ||
          targetThread.session?.status === "running" ||
          targetThread.session?.status === "error";
        if (
          targetSessionBusy ||
          targetThread.latestTurn?.state === "running" ||
          targetThread.latestTurn?.state === "error" ||
          hasOpenBlockingRequest(targetThread) ||
          hasQueuedTurnStartForThread(targetThread, command.createdAt)
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "target bot is busy or waiting for input",
          });
        }
        const openTargetDelegation = delegations.find(
          (candidate) =>
            candidate.targetThreadId === targetThread.id && !isTerminalDelegation(candidate),
        );
        if (openTargetDelegation !== undefined) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `target bot already owns delegation ${openTargetDelegation.id}`,
          });
        }
        if (command.requester.kind === "thread") {
          const requesterThread = yield* requireActiveThread({
            readModel,
            command,
            threadId: command.requester.threadId,
          });
          const requesterWorkspace = normalizeProjectPathForComparison(
            requesterThread.worktreePath ?? project.workspaceRoot,
          );
          const targetWorkspace = normalizeProjectPathForComparison(
            targetThread.worktreePath ?? project.workspaceRoot,
          );
          if (requesterWorkspace === targetWorkspace) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "target bot shares the requester's mutable workspace",
            });
          }
        }
        targetThreadId = command.target.threadId;
      }

      const delegation: Delegation = {
        id: command.delegationId,
        projectId: command.projectId,
        requester: command.requester,
        target: command.target,
        title: command.title,
        task: command.task,
        state: "requested",
        targetThreadId,
        turnId: null,
        assistantMessageId: null,
        failure: null,
        revision: 1,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      };
      const requestedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "delegation",
          aggregateId: command.delegationId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "delegation.requested",
        payload: { delegation },
      };
      if (kanbanRequesterCard === null) return requestedEvent;

      const linkedCard: KanbanCard = {
        ...kanbanRequesterCard,
        delegationId: delegation.id,
        revision: kanbanRequesterCard.revision + 1,
        updatedAt: command.createdAt,
      };
      const linkedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "kanban-card",
          aggregateId: kanbanRequesterCard.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "kanban.card-delegation-linked",
        payload: { card: linkedCard },
      };
      return [requestedEvent, linkedEvent];
    }

    case "delegation.provision.start": {
      const delegation = findDelegation(readModel, command.delegationId);
      if (delegation === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `delegation ${command.delegationId} does not exist`,
        });
      }
      if (delegation.state !== "requested" || delegation.target.kind !== "newThread") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `delegation ${command.delegationId} cannot start provisioning from ${delegation.state}`,
        });
      }
      const next: Delegation = {
        ...delegation,
        state: "provisioning",
        targetThreadId: command.targetThreadId,
        revision: delegation.revision + 1,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "delegation",
          aggregateId: command.delegationId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "delegation.provision-started",
        payload: { delegation: next },
      };
    }

    case "delegation.target.bind": {
      const delegation = findDelegation(readModel, command.delegationId);
      if (delegation === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `delegation ${command.delegationId} does not exist`,
        });
      }
      if (
        delegation.state !== "provisioning" ||
        delegation.target.kind !== "newThread" ||
        (delegation.targetThreadId !== null && delegation.targetThreadId !== command.targetThreadId)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `delegation ${command.delegationId} cannot bind a target from ${delegation.state}`,
        });
      }
      const targetThread = yield* requireActiveThread({
        readModel,
        command,
        threadId: command.targetThreadId,
      });
      if (targetThread.projectId !== delegation.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "target thread belongs to another project",
        });
      }
      const project = yield* requireActiveProject({
        readModel,
        command,
        projectId: delegation.projectId,
      });
      if (
        targetThread.worktreePath === null ||
        normalizeProjectPathForComparison(targetThread.worktreePath) ===
          normalizeProjectPathForComparison(project.workspaceRoot)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "spawned target does not own an isolated worktree",
        });
      }
      const next: Delegation = {
        ...delegation,
        targetThreadId: command.targetThreadId,
        revision: delegation.revision + 1,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "delegation",
          aggregateId: command.delegationId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "delegation.target-bound",
        payload: { delegation: next },
      };
    }

    case "delegation.turn.request": {
      const delegation = findDelegation(readModel, command.delegationId);
      if (delegation === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `delegation ${command.delegationId} does not exist`,
        });
      }
      const isReadyExisting =
        delegation.state === "requested" && delegation.target.kind === "existingThread";
      const isReadyNew =
        delegation.state === "provisioning" &&
        delegation.target.kind === "newThread" &&
        delegation.targetThreadId !== null;
      if ((!isReadyExisting && !isReadyNew) || delegation.targetThreadId === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `delegation ${command.delegationId} cannot request a turn from ${delegation.state}`,
        });
      }
      const targetThread = yield* requireActiveThread({
        readModel,
        command,
        threadId: delegation.targetThreadId,
      });
      if (delegation.target.kind === "existingThread") {
        const project = yield* requireActiveProject({
          readModel,
          command,
          projectId: delegation.projectId,
        });
        if (
          targetThread.botProfile == null ||
          targetThread.worktreePath === null ||
          normalizeProjectPathForComparison(targetThread.worktreePath) ===
            normalizeProjectPathForComparison(project.workspaceRoot)
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `delegation ${command.delegationId} target is no longer an active isolated bot`,
          });
        }
      } else {
        const project = yield* requireActiveProject({
          readModel,
          command,
          projectId: delegation.projectId,
        });
        if (
          targetThread.worktreePath === null ||
          normalizeProjectPathForComparison(targetThread.worktreePath) ===
            normalizeProjectPathForComparison(project.workspaceRoot)
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `delegation ${command.delegationId} worker is not ready in an isolated worktree`,
          });
        }
      }
      const next: Delegation = {
        ...delegation,
        state: "turnRequested",
        revision: delegation.revision + 1,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "delegation",
          aggregateId: command.delegationId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "delegation.turn-requested",
        payload: { delegation: next },
      };
    }

    case "delegation.turn.bind": {
      const delegation = findDelegation(readModel, command.delegationId);
      if (delegation === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `delegation ${command.delegationId} does not exist`,
        });
      }
      if (delegation.state !== "turnRequested" || delegation.targetThreadId === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `delegation ${command.delegationId} cannot bind a turn from ${delegation.state}`,
        });
      }
      const targetThread = yield* requireActiveThread({
        readModel,
        command,
        threadId: delegation.targetThreadId,
      });
      if (targetThread.latestTurn?.turnId !== command.turnId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `turn ${command.turnId} is not the latest turn for delegation target ${delegation.targetThreadId}`,
        });
      }
      if (
        command.assistantMessageId !== null &&
        targetThread.latestTurn.assistantMessageId !== command.assistantMessageId
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `assistant message ${command.assistantMessageId} does not belong to turn ${command.turnId}`,
        });
      }
      const next: Delegation = {
        ...delegation,
        state: "running",
        turnId: command.turnId,
        assistantMessageId: command.assistantMessageId,
        revision: delegation.revision + 1,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "delegation",
          aggregateId: command.delegationId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "delegation.turn-bound",
        payload: { delegation: next },
      };
    }

    case "delegation.complete": {
      const delegation = findDelegation(readModel, command.delegationId);
      if (delegation === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `delegation ${command.delegationId} does not exist`,
        });
      }
      const terminal = ["completed", "failed", "interrupted"].includes(delegation.state);
      const validCompleted = command.outcome === "completed" && delegation.state === "running";
      const validInterrupted =
        command.outcome === "interrupted" &&
        (delegation.state === "turnRequested" || delegation.state === "running");
      const validFailed = command.outcome === "failed" && !terminal;
      if (!validCompleted && !validInterrupted && !validFailed) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `delegation ${command.delegationId} cannot become ${command.outcome} from ${delegation.state}`,
        });
      }
      const next: Delegation = {
        ...delegation,
        state: command.outcome,
        failure: command.failure,
        revision: delegation.revision + 1,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "delegation",
          aggregateId: command.delegationId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type:
          command.outcome === "completed"
            ? "delegation.completed"
            : command.outcome === "failed"
              ? "delegation.failed"
              : "delegation.interrupted",
        payload: { delegation: next },
      };
    }

    case "thread.peer-turn.start": {
      const sourceThread = yield* requireActiveThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      const targetThread = yield* requireActiveThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (sourceThread.id === targetThread.id) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `peer turn source and target are both '${targetThread.id}'`,
        });
      }
      if (sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `peer turn target '${targetThread.id}' belongs to another project`,
        });
      }
      const project = yield* requireActiveProject({
        readModel,
        command,
        projectId: sourceThread.projectId,
      });
      const sourceWorkspace = normalizeProjectPathForComparison(
        sourceThread.worktreePath ?? project.workspaceRoot,
      );
      const targetWorkspace = normalizeProjectPathForComparison(
        targetThread.worktreePath ?? project.workspaceRoot,
      );
      if (sourceWorkspace === targetWorkspace) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `peer turn target '${targetThread.id}' shares the source workspace`,
        });
      }
      const targetSessionBusy =
        targetThread.session?.status === "starting" || targetThread.session?.status === "running";
      const createdAt = yield* nowIso;
      if (
        targetSessionBusy ||
        targetThread.session?.status === "error" ||
        targetThread.latestTurn?.state === "running" ||
        targetThread.latestTurn?.state === "error" ||
        hasOpenBlockingRequest(targetThread) ||
        hasQueuedTurnStartForThread(targetThread, createdAt)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `peer turn target '${targetThread.id}' is busy or waiting for input`,
        });
      }
      const sourceTitle = sourceThread.title.replace(/\s+/g, " ").trim();
      const sourceLabel = `"${sourceTitle}" (${sourceThread.id})`;
      const peerMessage = `Peer agent request from ${sourceLabel}:\n\n${command.message}`;
      if (peerMessage.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `peer turn message exceeds the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS}-character provider limit after provenance is added`,
        });
      }
      return yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.turn.start",
          commandId: command.commandId,
          threadId: targetThread.id,
          message: {
            messageId: command.messageId,
            role: "user",
            text: peerMessage,
            attachments: [],
          },
          ...(command.delegationId === undefined ? {} : { delegationId: command.delegationId }),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          createdAt,
        },
      });
    }

    case "thread.peer-turn.interrupt": {
      const sourceThread = yield* requireActiveThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      const targetThread = yield* requireActiveThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (sourceThread.id === targetThread.id) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `peer interrupt source and target are both '${targetThread.id}'`,
        });
      }
      if (sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `peer interrupt target '${targetThread.id}' belongs to another project`,
        });
      }
      yield* requireActiveProject({
        readModel,
        command,
        projectId: sourceThread.projectId,
      });
      if (
        targetThread.latestTurn?.state !== "running" ||
        targetThread.latestTurn.turnId !== command.observedTurnId
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `peer interrupt target '${targetThread.id}' is not running observed turn '${command.observedTurnId}'`,
        });
      }
      const createdAt = yield* nowIso;
      return yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.turn.interrupt",
          commandId: command.commandId,
          threadId: targetThread.id,
          turnId: command.observedTurnId,
          createdAt,
        },
      });
    }

    case "thread.turn.start": {
      if (isImportedAgentSessionMessageId(command.message.messageId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message id '${command.message.messageId}' uses the reserved imported-session namespace.`,
        });
      }
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.delegationId !== undefined) {
        const owner = findDelegation(readModel, command.delegationId);
        const phaseAllowsTurnStart =
          owner?.state === "turnRequested" ||
          (owner?.state === "provisioning" && owner.target.kind === "newThread");
        if (
          owner === undefined ||
          owner.targetThreadId !== targetThread.id ||
          !phaseAllowsTurnStart
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `delegation ${command.delegationId} does not own an active turn reservation for thread ${targetThread.id}`,
          });
        }
      }
      const openTargetDelegation = (readModel.delegations ?? []).find(
        (delegation) =>
          delegation.targetThreadId === targetThread.id &&
          delegation.state !== "completed" &&
          delegation.state !== "failed" &&
          delegation.state !== "interrupted",
      );
      if (openTargetDelegation !== undefined && command.delegationId !== openTargetDelegation.id) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${targetThread.id} is reserved by delegation ${openTargetDelegation.id}`,
        });
      }
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          createdAt: command.createdAt,
        },
      };
      // Real activity resets ANY override: it wakes an explicitly settled
      // thread, and it clears a keep-active pin back to neutral so the
      // thread can auto-settle again after this burst of work goes stale.
      // A snooze clears the same way — sending a message to a snoozed
      // thread is the user re-engaging, so the return ticket is spent.
      const lifecycleResetEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (targetThread.settledOverride !== null) {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      if (targetThread.snoozedUntil != null) {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      return [...lifecycleResetEvents, userMessageEvent, turnStartRequestedEvent];
    }

    case "thread.turn.interrupt": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const request = userInputActivity;
      const attachments = Object.values(command.attachmentsByQuestionId ?? {}).flat();
      let questionTextById: Record<string, string> = {};
      if (attachments.length > 0) {
        const payload =
          request?.kind === "user-input.requested"
            ? decodeUserInputRequestedPayload(request.payload)
            : Option.none();
        if (Option.isNone(payload)) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail:
              request?.kind === "user-input.resolved"
                ? "This question has already been answered."
                : "This question is no longer pending.",
          });
        }
        questionTextById = Object.fromEntries(
          payload.value.questions.map((question) => [question.id, question.question]),
        );
        for (const questionId of Object.keys(command.attachmentsByQuestionId ?? {})) {
          const question = payload.value.questions.find((question) => question.id === questionId);
          if (!question || question.allowCustomAnswer === false) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "This question does not accept file references.",
            });
          }
        }
      }
      if (
        request &&
        Predicate.isObject(request.payload) &&
        request.payload.responseMode === "message"
      ) {
        const payload = decodeUserInputRequestedPayload(request.payload);
        if (request.kind !== "user-input.requested" || Option.isNone(payload)) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "This question has already been answered.",
          });
        }
        const replies: string[] = [];
        for (const question of payload.value.questions) {
          const answer = command.answers[question.id];
          if (
            typeof answer !== "string" ||
            (answer.trim().length === 0 && !command.attachmentsByQuestionId?.[question.id]?.length)
          ) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "Answer each question before sending.",
            });
          }
          const questionAttachments = command.attachmentsByQuestionId?.[question.id] ?? [];
          const attachmentLabels = questionAttachments
            .map((attachment) => `Attached file: ${attachment.name} (${attachment.id})`)
            .join("\n");
          replies.push(
            [`${question.question}\n${answer.trim()}`, attachmentLabels].filter(Boolean).join("\n"),
          );
        }
        // Commit the answer and its message together. The normal turn path
        // steers a running agent or resumes an idle session.
        return yield* decideCommandSequence({
          readModel,
          commands: [
            {
              type: "thread.activity.append",
              commandId: command.commandId,
              threadId: command.threadId,
              createdAt: command.createdAt,
              activity: {
                id: EventId.make(`async-answer:${command.requestId}`),
                kind: "user-input.resolved",
                summary: "User input submitted",
                tone: "info",
                turnId: request.turnId,
                createdAt: command.createdAt,
                payload: {
                  requestId: command.requestId,
                  responseMode: "message",
                  answers: command.answers,
                  ...(command.attachmentsByQuestionId
                    ? { attachmentsByQuestionId: command.attachmentsByQuestionId }
                    : {}),
                },
              },
            },
            {
              type: "thread.turn.start",
              commandId: command.commandId,
              threadId: command.threadId,
              createdAt: command.createdAt,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              message: {
                messageId: MessageId.make(`async-answer:${command.requestId}`),
                role: "user",
                text: replies.join("\n\n"),
                attachments,
              },
            },
          ],
        });
      }
      const responseEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: { requestId: command.requestId },
        })),
        type: "thread.user-input-response-requested" as const,
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          ...(command.attachmentsByQuestionId
            ? { attachmentsByQuestionId: command.attachmentsByQuestionId }
            : {}),
          createdAt: command.createdAt,
        },
      };
      if (attachments.length === 0) return responseEvent;
      const historyEvent = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.activity.append",
          commandId: command.commandId,
          threadId: command.threadId,
          createdAt: command.createdAt,
          activity: {
            id: EventId.make(`question-answer:${command.commandId}`),
            kind: "user-input.answer-submitted",
            summary: "Question answer submitted",
            tone: "info",
            turnId: request?.turnId ?? null,
            createdAt: command.createdAt,
            payload: {
              requestId: command.requestId,
              answers: command.answers,
              questionTextById,
              attachmentsByQuestionId: command.attachmentsByQuestionId,
              detail: attachments.map((attachment) => attachment.name).join("\n"),
            },
          },
        },
      });
      return [...(Array.isArray(historyEvent) ? historyEvent : [historyEvent]), responseEvent];
    }

    case "thread.user-input.dismiss": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const request = userInputActivity;
      if (request === undefined || request.kind !== "user-input.requested") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This question has already been answered.",
        });
      }
      // Only async questions can be dropped silently. A native callback
      // question leaves the provider blocked until it gets a reply, so it
      // still needs an answer or an interrupted turn.
      if (!Predicate.isObject(request.payload) || request.payload.responseMode !== "message") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This question needs an answer. Answer it or stop the turn.",
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: {
            id: EventId.make(`async-dismiss:${command.requestId}`),
            kind: "user-input.resolved",
            summary: "User input dismissed",
            tone: "info",
            turnId: request.turnId,
            createdAt: command.createdAt,
            payload: { requestId: command.requestId, responseMode: "message" },
          },
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Settle-cleanup stops are conditional: between the settle landing and
      // this command, another client may have re-engaged the thread (a turn
      // start unsettles it and brings the session alive). Commands are
      // decided serially against this read model, so checking here — not in
      // the dispatcher's pre-settle snapshot — closes that race.
      if (command.onlyIfSettled === true) {
        const sessionComingAlive =
          thread.session?.status === "starting" || thread.session?.status === "running";
        if (
          thread.settledOverride !== "settled" ||
          sessionComingAlive ||
          hasQueuedTurnStartForThread(thread, command.createdAt)
        ) {
          return yield* Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `thread ${command.threadId} was re-engaged after settle; skipping session stop`,
            }),
          );
        }
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sessionSetEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        })),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
      // Only a session coming alive is activity worth waking a settled thread
      // for — status writes like ready/stopped/error arrive after the fact and
      // must not fight a user's explicit settle. Snooze is deliberately NOT
      // cleared here: snooze never pauses the agent, so its session starting
      // or erroring is not the user re-engaging. Blocked/failed work still
      // surfaces immediately — effectiveSnoozed refuses to classify a thread
      // with a raised hand (approval / input / failure / fresh completion)
      // as snoozed, without spending the return ticket.
      const isSessionActivity =
        command.session.status === "starting" || command.session.status === "running";
      // Real activity resets ANY override (settled wakes, active unpins).
      if (thread.settledOverride === null || !isSessionActivity) {
        return sessionSetEvent;
      }
      const unsettledEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: "activity",
          updatedAt: command.createdAt,
        },
      };
      return [unsettledEvent, sessionSetEvent];
    }

    case "thread.message.assistant.delta": {
      if (isImportedAgentSessionMessageId(command.messageId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message id '${command.messageId}' uses the reserved imported-session namespace.`,
        });
      }
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      if (isImportedAgentSessionMessageId(command.messageId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message id '${command.messageId}' uses the reserved imported-session namespace.`,
        });
      }
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.history.import": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (
        thread.deletedAt !== null ||
        thread.archivedAt !== null ||
        thread.messages.length > 0 ||
        thread.latestTurn !== null ||
        thread.session !== null ||
        openRequests(thread).size > 0
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' must be active and empty before history can be imported.`,
        });
      }
      const firstMessage = command.messages[0];
      if (firstMessage === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Thread history imports require at least one message.",
        });
      }

      const events: Array<PlannedOrchestrationEvent> = [];
      for (const message of command.messages) {
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: message.createdAt,
            commandId: command.commandId,
            metadata: { historyImport: true },
          })),
          type: "thread.message-sent",
          payload: {
            threadId: command.threadId,
            messageId: message.messageId,
            role: message.role,
            text: message.text,
            turnId: null,
            streaming: false,
            createdAt: message.createdAt,
            updatedAt: message.createdAt,
          },
        });
      }
      const settledAt = command.messages.reduce(
        (latest, message) =>
          compareDateTimeStrings(message.createdAt, latest) > 0 ? message.createdAt : latest,
        firstMessage.createdAt,
      );
      events.push({
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: settledAt,
          commandId: command.commandId,
          metadata: { historyImport: true },
        })),
        type: "thread.settled",
        payload: {
          threadId: command.threadId,
          settledAt,
          updatedAt: settledAt,
        },
      });
      return events;
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      const activityAppendedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        })),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
      // An approval or user-input request is blocked-on-you work — it must
      // never stay hidden inside a settled slim row.
      const wakesSettledThread =
        command.activity.kind === "approval.requested" ||
        command.activity.kind === "user-input.requested";
      // Real activity resets ANY override (settled wakes, active unpins).
      if (thread.settledOverride === null || !wakesSettledThread) {
        return activityAppendedEvent;
      }
      const unsettledEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: "activity",
          updatedAt: command.createdAt,
        },
      };
      return [unsettledEvent, activityAppendedEvent];
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
