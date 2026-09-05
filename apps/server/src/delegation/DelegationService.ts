import {
  AgentMeshError,
  type AgentMeshDelegationDispatchReceipt,
  type AgentMeshDelegationView,
  type AgentMeshAssistantOutput,
  type AgentMeshOperation,
  type AgentMeshSendInput,
  type AgentMeshSpawnInput,
  type AgentMeshWaitInput,
  type AgentMeshWaitResult,
  CommandId,
  type Delegation,
  DelegationId,
  MessageId,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationMessage,
  type OrchestrationThreadShell,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadLaunchService from "../orchestration/Services/ThreadLaunchService.ts";

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_MAX_CHARS = 8_000;
const stableIdPart = (value: string): string => `${value.length}:${value}`;

export interface DelegationScope {
  readonly threadId: ThreadId;
}

export interface DelegationServiceShape {
  readonly spawn: (
    scope: DelegationScope,
    input: AgentMeshSpawnInput,
  ) => Effect.Effect<AgentMeshDelegationDispatchReceipt, AgentMeshError>;
  readonly send: (
    scope: DelegationScope,
    input: AgentMeshSendInput,
  ) => Effect.Effect<AgentMeshDelegationDispatchReceipt, AgentMeshError>;
  readonly wait: (
    scope: DelegationScope,
    input: AgentMeshWaitInput,
  ) => Effect.Effect<AgentMeshWaitResult, AgentMeshError>;
}

export class DelegationService extends Context.Service<DelegationService, DelegationServiceShape>()(
  "t3/delegation/DelegationService",
) {}

const meshError = (
  operation: AgentMeshOperation,
  reason: AgentMeshError["reason"],
  targetThreadId: ThreadId | null = null,
) => new AgentMeshError({ operation, reason, targetThreadId });

export const threadDelegationIdFor = (callerId: ThreadId, requestId: string) =>
  DelegationId.make(`agent-mesh:${stableIdPart(callerId)}:${requestId}`);

export const delegationWorkerThreadIdFor = (delegationId: DelegationId) =>
  ThreadId.make(`agent-mesh-worker:${stableIdPart(delegationId)}`);

export const delegationMessageIdFor = (delegationId: DelegationId) =>
  MessageId.make(`agent-mesh-message:${stableIdPart(delegationId)}`);

export const delegationCommandIdFor = (delegationId: DelegationId, action: string) =>
  CommandId.make(`server:agent-mesh:${action}:${stableIdPart(delegationId)}`);

export const delegationWorktreeBranchFor = (delegationId: DelegationId) => {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(delegationId)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  const token = (hash >>> 0).toString(16).padStart(8, "0");
  return buildTemporaryWorktreeBranchName(() => token);
};

export function latestDelegationAssistant(
  delegation: Delegation,
  messages: ReadonlyArray<OrchestrationMessage>,
  maxChars: number,
): AgentMeshAssistantOutput | null {
  if (delegation.turnId === null) return null;
  const assistant = messages.findLast(
    (message) => message.role === "assistant" && message.turnId === delegation.turnId,
  );
  if (assistant === undefined) return null;
  const truncated = assistant.text.length > maxChars;
  return {
    messageId: assistant.id,
    turnId: assistant.turnId,
    text: truncated ? assistant.text.slice(-maxChars) : assistant.text,
    truncated,
    updatedAt: assistant.updatedAt,
  };
}

const isTerminal = (delegation: Delegation) =>
  delegation.state === "completed" ||
  delegation.state === "failed" ||
  delegation.state === "interrupted";

const isTargetBusy = (target: OrchestrationThreadShell) =>
  target.session?.status === "starting" ||
  target.session?.status === "running" ||
  target.session?.status === "error" ||
  target.latestTurn?.state === "running" ||
  target.latestTurn?.state === "error" ||
  target.hasPendingApprovals ||
  target.hasPendingUserInput ||
  target.backgroundLiveness !== null;

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const threadLauncher = yield* ThreadLaunchService.ThreadLaunchService;
  const mutationLock = yield* Semaphore.make(1);
  const domainEvents = yield* engine.subscribeDomainEvents;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const readThread = (operation: AgentMeshOperation, threadId: ThreadId) =>
    query.getThreadShellById(threadId).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("delegation thread lookup failed", { operation, threadId, cause }),
      ),
      Effect.mapError(() => meshError(operation, "callerUnavailable")),
    );

  const requireCaller = Effect.fn("DelegationService.requireCaller")(function* (
    operation: AgentMeshOperation,
    scope: DelegationScope,
  ) {
    const caller = yield* readThread(operation, scope.threadId);
    if (Option.isNone(caller)) {
      return yield* meshError(operation, "callerUnavailable");
    }
    const project = yield* query
      .getProjectShellById(caller.value.projectId)
      .pipe(Effect.mapError(() => meshError(operation, "callerUnavailable")));
    if (Option.isNone(project)) {
      return yield* meshError(operation, "callerUnavailable");
    }
    return { caller: caller.value, project: project.value };
  });

  const dispatch = (
    operation: "spawn" | "send" | "wait",
    targetThreadId: ThreadId | null,
    command: OrchestrationCommand,
  ) =>
    engine.dispatch(command).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("delegation command dispatch failed", {
          operation,
          targetThreadId,
          commandType: command.type,
          cause,
        }),
      ),
      Effect.mapError(() => meshError(operation, "dispatchFailed", targetThreadId)),
    );

  const readDelegations = Effect.fn("DelegationService.readDelegations")(function* (
    operation: "spawn" | "send" | "wait",
    ids: ReadonlyArray<DelegationId>,
  ) {
    if (query.getDelegations === undefined) {
      return yield* meshError(operation, operation === "wait" ? "waitFailed" : "dispatchFailed");
    }
    return yield* query
      .getDelegations(ids)
      .pipe(
        Effect.mapError(() =>
          meshError(operation, operation === "wait" ? "waitFailed" : "dispatchFailed"),
        ),
      );
  });

  const readDelegation = Effect.fn("DelegationService.readDelegation")(function* (
    operation: "spawn" | "send" | "wait",
    delegationId: DelegationId,
  ) {
    const delegations = yield* readDelegations(operation, [delegationId]);
    return delegations[0] ?? null;
  });

  const receiptFor = Effect.fn("DelegationService.receiptFor")(function* (delegation: Delegation) {
    const action =
      delegation.target.kind === "newThread"
        ? "worker-turn"
        : delegation.requester.kind === "thread"
          ? "peer-turn"
          : "target-turn";
    return {
      delegationId: delegation.id,
      targetThreadId: delegation.targetThreadId,
      commandId: delegationCommandIdFor(delegation.id, action),
      messageId: delegationMessageIdFor(delegation.id),
      sequence: yield* engine.latestSequence,
      state: delegation.state,
    } satisfies AgentMeshDelegationDispatchReceipt;
  });

  const matchesSendRequest = (
    delegation: Delegation,
    scope: DelegationScope,
    input: AgentMeshSendInput,
  ) =>
    delegation.requester.kind === "thread" &&
    delegation.requester.threadId === scope.threadId &&
    delegation.requester.requestId === input.requestId &&
    delegation.target.kind === "existingThread" &&
    delegation.target.threadId === input.targetThreadId &&
    delegation.task === input.message;

  const matchesSpawnRequest = (
    delegation: Delegation,
    scope: DelegationScope,
    input: AgentMeshSpawnInput,
  ) =>
    delegation.requester.kind === "thread" &&
    delegation.requester.threadId === scope.threadId &&
    delegation.requester.requestId === input.requestId &&
    delegation.target.kind === "newThread" &&
    delegation.title === input.title &&
    delegation.task === input.task &&
    (input.modelSelection === undefined ||
      Equal.equals(delegation.target.modelSelection, input.modelSelection));

  const completeDelegation = Effect.fn("DelegationService.completeDelegation")(function* (
    delegation: Delegation,
    outcome: "completed" | "failed" | "interrupted",
    detail?: string,
  ) {
    const createdAt = yield* nowIso;
    yield* dispatch("wait", delegation.targetThreadId, {
      type: "delegation.complete",
      commandId: delegationCommandIdFor(
        delegation.id,
        `complete:${outcome}:${delegation.revision}`,
      ),
      delegationId: delegation.id,
      outcome,
      failure:
        outcome === "failed"
          ? {
              code: "worker_failed",
              detail: (detail?.trim() || "The delegated worker failed.").slice(0, 2_000),
            }
          : null,
      createdAt,
    });
  });

  const bindTurn = Effect.fn("DelegationService.bindTurn")(function* (
    delegation: Delegation,
    turnId: TurnId,
  ) {
    const createdAt = yield* nowIso;
    yield* dispatch("wait", delegation.targetThreadId, {
      type: "delegation.turn.bind",
      commandId: delegationCommandIdFor(delegation.id, `bind-turn:${stableIdPart(turnId)}`),
      delegationId: delegation.id,
      turnId,
      assistantMessageId: null,
      createdAt,
    });
  });

  const dispatchDelegatedTurn = Effect.fn("DelegationService.dispatchDelegatedTurn")(function* (
    operation: "send" | "wait",
    delegation: Delegation,
    target: OrchestrationThreadShell,
  ) {
    const messageId = delegationMessageIdFor(delegation.id);
    if (delegation.target.kind === "existingThread" && delegation.requester.kind === "thread") {
      const commandId = delegationCommandIdFor(delegation.id, "peer-turn");
      const receipt = yield* dispatch(operation, target.id, {
        type: "thread.peer-turn.start",
        commandId,
        requestId: delegation.requester.requestId,
        sourceThreadId: delegation.requester.threadId,
        threadId: target.id,
        delegationId: delegation.id,
        messageId,
        message: delegation.task,
      });
      return { commandId, messageId, sequence: receipt.sequence };
    }
    const commandId = delegationCommandIdFor(
      delegation.id,
      delegation.target.kind === "newThread" ? "worker-turn" : "target-turn",
    );
    const receipt = yield* dispatch(operation, target.id, {
      type: "thread.turn.start",
      commandId,
      threadId: target.id,
      delegationId: delegation.id,
      message: { messageId, role: "user", text: delegation.task, attachments: [] },
      modelSelection: target.modelSelection,
      runtimeMode: target.runtimeMode,
      interactionMode: target.interactionMode,
      createdAt: yield* nowIso,
    });
    return { commandId, messageId, sequence: receipt.sequence };
  });

  const advanceExisting = Effect.fn("DelegationService.advanceExisting")(function* (
    operation: "send" | "wait",
    delegation: Delegation,
  ) {
    if (
      delegation.state !== "requested" ||
      delegation.target.kind !== "existingThread" ||
      delegation.targetThreadId === null
    ) {
      return null;
    }
    const targetOption = yield* query
      .getThreadShellById(delegation.targetThreadId)
      .pipe(
        Effect.mapError(() => meshError(operation, "targetUnavailable", delegation.targetThreadId)),
      );
    if (Option.isNone(targetOption) || targetOption.value.projectId !== delegation.projectId) {
      yield* completeDelegation(delegation, "failed", "The target bot is unavailable.");
      return yield* meshError(operation, "targetUnavailable", delegation.targetThreadId);
    }
    const target = targetOption.value;
    if (target.botProfile == null) {
      yield* completeDelegation(delegation, "failed", "The target thread is not an active bot.");
      return yield* meshError(operation, "targetNotBot", target.id);
    }
    const createdAt = yield* nowIso;
    yield* dispatch(operation, target.id, {
      type: "delegation.turn.request",
      commandId: delegationCommandIdFor(delegation.id, "turn-request"),
      delegationId: delegation.id,
      createdAt,
    }).pipe(
      Effect.tapError(() =>
        completeDelegation(
          delegation,
          "failed",
          "The target bot changed or became unavailable before its delegated turn could start.",
        ).pipe(Effect.ignoreCause({ log: true })),
      ),
    );
    return yield* dispatchDelegatedTurn(operation, delegation, target);
  });

  const reconcileOne = Effect.fn("DelegationService.reconcileOne")(function* (
    delegation: Delegation,
  ) {
    if (isTerminal(delegation) || delegation.targetThreadId === null) {
      return;
    }
    if (delegation.state === "requested" && delegation.target.kind === "existingThread") {
      yield* advanceExisting("wait", delegation).pipe(Effect.catch(() => Effect.void));
      return;
    }
    const target = yield* query
      .getThreadShellById(delegation.targetThreadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(target)) {
      if (delegation.state !== "requested") {
        yield* completeDelegation(delegation, "failed", "The delegated worker is unavailable.");
      }
      return;
    }

    const latestTurn = target.value.latestTurn;
    let current = delegation;
    if (current.state === "turnRequested") {
      const detail = yield* query
        .getThreadDetailSnapshot(target.value.id, { turnLimit: 1 })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const ownsTurn =
        Option.isSome(detail) &&
        detail.value.thread.messages.some(
          (message) => message.id === delegationMessageIdFor(current.id),
        );
      if (!ownsTurn) {
        if (isTargetBusy(target.value)) {
          yield* completeDelegation(
            current,
            "failed",
            "The target bot became busy before its delegated turn was accepted.",
          );
          return;
        }
        yield* dispatchDelegatedTurn("wait", current, target.value).pipe(
          Effect.tapError(() =>
            completeDelegation(
              current,
              "failed",
              "The target bot rejected the delegated turn.",
            ).pipe(Effect.ignoreCause({ log: true })),
          ),
          Effect.catch(() => Effect.void),
        );
        return;
      }
      if (latestTurn !== null) {
        yield* bindTurn(current, latestTurn.turnId);
        const refreshed = yield* readDelegation("wait", current.id);
        if (refreshed !== null) current = refreshed;
      }
    }

    if (current.state !== "running" || current.turnId === null) {
      if (target.value.session?.status === "error") {
        yield* completeDelegation(
          current,
          "failed",
          target.value.session.lastError ?? "The provider session failed to start.",
        );
      }
      return;
    }
    if (latestTurn?.turnId !== current.turnId || latestTurn.state === "running") {
      return;
    }
    if (latestTurn.state === "completed") {
      yield* completeDelegation(current, "completed");
    } else if (latestTurn.state === "interrupted") {
      yield* completeDelegation(current, "interrupted");
    } else {
      yield* completeDelegation(
        current,
        "failed",
        target.value.session?.lastError ?? "The delegated turn failed.",
      );
    }
  });

  const reconcileTarget = Effect.fn("DelegationService.reconcileTarget")(function* (
    targetThreadId: ThreadId,
  ) {
    if (query.getOpenDelegationsForTarget === undefined) return;
    const delegations = yield* query
      .getOpenDelegationsForTarget(targetThreadId)
      .pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(delegations, reconcileOne, { discard: true });
  });

  const handleDomainEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "delegation.requested":
        return event.payload.delegation.target.kind === "existingThread"
          ? advanceExisting("wait", event.payload.delegation).pipe(
              Effect.ignoreCause({ log: true }),
              Effect.asVoid,
            )
          : Effect.void;
      case "delegation.turn-requested":
        return reconcileOne(event.payload.delegation).pipe(Effect.ignoreCause({ log: true }));
      case "thread.deleted":
      case "thread.archived":
      case "thread.bot-disabled":
      case "thread.meta-updated":
      case "thread.session-set":
      case "thread.turn-diff-completed":
        return reconcileTarget(event.payload.threadId).pipe(Effect.ignoreCause({ log: true }));
      default:
        return Effect.void;
    }
  };

  yield* domainEvents.pipe(
    Stream.runForEach(handleDomainEvent),
    Effect.forkScoped({ startImmediately: true }),
  );

  const makeView = Effect.fn("DelegationService.makeView")(function* (
    delegation: Delegation,
    maxChars: number,
  ): Effect.fn.Return<AgentMeshDelegationView, AgentMeshError> {
    if (delegation.targetThreadId === null) {
      return {
        delegationId: delegation.id,
        targetThreadId: null,
        state: delegation.state,
        turnId: delegation.turnId,
        failure: delegation.failure,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        latestAssistant: null,
        updatedAt: delegation.updatedAt,
      };
    }
    const target = yield* query
      .getThreadShellById(delegation.targetThreadId)
      .pipe(Effect.mapError(() => meshError("wait", "waitFailed", delegation.targetThreadId)));
    const detail = yield* query
      .getThreadDetailSnapshot(delegation.targetThreadId, { turnLimit: 1 })
      .pipe(Effect.mapError(() => meshError("wait", "waitFailed", delegation.targetThreadId)));
    const latestAssistant = Option.isSome(detail)
      ? latestDelegationAssistant(delegation, detail.value.thread.messages, maxChars)
      : null;
    return {
      delegationId: delegation.id,
      targetThreadId: delegation.targetThreadId,
      state: delegation.state,
      turnId: delegation.turnId,
      failure: delegation.failure,
      hasPendingApprovals: Option.isSome(target) && target.value.hasPendingApprovals,
      hasPendingUserInput: Option.isSome(target) && target.value.hasPendingUserInput,
      latestAssistant,
      updatedAt: delegation.updatedAt,
    };
  });

  const readViews = Effect.fn("DelegationService.readViews")(function* (
    caller: OrchestrationThreadShell,
    input: AgentMeshWaitInput,
  ) {
    const uniqueIds = [...new Set(input.delegationIds)];
    if (uniqueIds.length !== input.delegationIds.length) {
      return yield* meshError("wait", "delegationUnavailable");
    }
    let delegations = yield* readDelegations("wait", uniqueIds);
    const byId = new Map(delegations.map((delegation) => [delegation.id, delegation] as const));
    delegations = uniqueIds.map((id) => byId.get(id)).filter((value) => value !== undefined);
    if (
      delegations.length !== uniqueIds.length ||
      delegations.some((delegation) => delegation.projectId !== caller.projectId)
    ) {
      return yield* meshError("wait", "delegationUnavailable");
    }
    yield* Effect.forEach(delegations, reconcileOne, { discard: true });
    const refreshed = yield* readDelegations("wait", uniqueIds);
    const refreshedById = new Map(
      refreshed.map((delegation) => [delegation.id, delegation] as const),
    );
    const ordered = uniqueIds
      .map((id) => refreshedById.get(id))
      .filter((value) => value !== undefined);
    return yield* Effect.forEach(ordered, (delegation) =>
      makeView(delegation, input.maxChars ?? DEFAULT_OUTPUT_MAX_CHARS),
    );
  });

  const reasonFor = (views: ReadonlyArray<AgentMeshDelegationView>) => {
    if (views.some(({ state }) => state === "failed")) return "failed" as const;
    if (views.some(({ state }) => state === "interrupted")) return "interrupted" as const;
    if (views.some(({ state }) => state === "completed")) return "completed" as const;
    if (views.some(({ hasPendingApprovals }) => hasPendingApprovals)) return "attention" as const;
    if (views.some(({ hasPendingUserInput }) => hasPendingUserInput)) return "attention" as const;
    return null;
  };

  const send: DelegationServiceShape["send"] = Effect.fn("DelegationService.send")(
    function* (scope, input) {
      return yield* mutationLock.withPermit(
        Effect.gen(function* () {
          const delegationId = threadDelegationIdFor(scope.threadId, input.requestId);
          const existing = yield* readDelegation("send", delegationId);
          if (existing !== null && !matchesSendRequest(existing, scope, input)) {
            return yield* meshError("send", "delegationUnavailable", existing.targetThreadId);
          }
          if (existing !== null && isTerminal(existing)) {
            return yield* receiptFor(existing);
          }
          const { caller, project } = yield* requireCaller("send", scope);
          const targetOption = yield* readThread("send", input.targetThreadId).pipe(
            Effect.mapError(() => meshError("send", "targetUnavailable", input.targetThreadId)),
          );
          if (Option.isNone(targetOption) || targetOption.value.projectId !== caller.projectId) {
            return yield* meshError("send", "targetUnavailable", input.targetThreadId);
          }
          const target = targetOption.value;
          if (caller.id === target.id) {
            return yield* meshError("send", "selfTarget", target.id);
          }
          if (existing === null) {
            if (target.botProfile == null) {
              return yield* meshError("send", "targetNotBot", target.id);
            }
            if (isTargetBusy(target)) {
              return yield* meshError("send", "targetBusy", target.id);
            }
            if (
              normalizeProjectPathForComparison(caller.worktreePath ?? project.workspaceRoot) ===
              normalizeProjectPathForComparison(target.worktreePath ?? project.workspaceRoot)
            ) {
              return yield* meshError("send", "workspaceShared", target.id);
            }
            const open =
              query.getOpenDelegationsForTarget === undefined
                ? []
                : yield* query
                    .getOpenDelegationsForTarget(target.id)
                    .pipe(Effect.mapError(() => meshError("send", "dispatchFailed", target.id)));
            if (open.length > 0) {
              return yield* meshError("send", "targetBusy", target.id);
            }
          } else if (existing.projectId !== caller.projectId) {
            return yield* meshError("send", "delegationUnavailable", target.id);
          }

          const createdAt = existing?.createdAt ?? (yield* nowIso);
          yield* dispatch("send", target.id, {
            type: "delegation.request",
            commandId: delegationCommandIdFor(delegationId, "request"),
            delegationId,
            projectId: caller.projectId,
            requester: { kind: "thread", threadId: caller.id, requestId: input.requestId },
            target: { kind: "existingThread", threadId: target.id },
            title: target.botProfile?.displayName ?? target.title,
            task: input.message,
            createdAt,
          });
          const commandId = delegationCommandIdFor(delegationId, "peer-turn");
          const messageId = delegationMessageIdFor(delegationId);
          const requested = yield* readDelegation("send", delegationId);
          const advanced = yield* (
            requested === null ? Effect.succeed(null) : advanceExisting("send", requested)
          ).pipe(
            Effect.tapError(() =>
              readDelegation("send", delegationId).pipe(
                Effect.flatMap((delegation) =>
                  delegation === null
                    ? Effect.void
                    : completeDelegation(delegation, "failed", "The target bot rejected the turn."),
                ),
                Effect.ignoreCause({ log: true }),
              ),
            ),
          );
          const delegation = yield* readDelegation("send", delegationId);
          return {
            delegationId,
            targetThreadId: target.id,
            commandId,
            messageId,
            sequence: advanced?.sequence ?? (yield* engine.latestSequence),
            state: delegation?.state ?? "turnRequested",
          };
        }),
      );
    },
  );

  const advanceNew = Effect.fn("DelegationService.advanceNew")(function* (
    caller: OrchestrationThreadShell,
    project: OrchestrationProjectShell,
    initial: Delegation,
  ) {
    if (initial.target.kind !== "newThread") {
      return yield* meshError("spawn", "delegationUnavailable", initial.targetThreadId);
    }
    const modelSelection = initial.target.modelSelection;
    const targetThreadId = delegationWorkerThreadIdFor(initial.id);
    const messageId = delegationMessageIdFor(initial.id);
    const commandId = delegationCommandIdFor(initial.id, "worker-turn");
    let current = initial;
    let sequence = yield* engine.latestSequence;
    let launchFailed = false;
    let launchOutcomeUncertain = false;

    const program = Effect.gen(function* () {
      if (current.state === "requested") {
        const receipt = yield* dispatch("spawn", null, {
          type: "delegation.provision.start",
          commandId: delegationCommandIdFor(current.id, "provision"),
          delegationId: current.id,
          targetThreadId,
          createdAt: yield* nowIso,
        });
        sequence = receipt.sequence;
        current = (yield* readDelegation("spawn", current.id)) ?? current;
      }
      if (isTerminal(current)) return;

      let target = yield* query
        .getThreadShellById(targetThreadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const branch = delegationWorktreeBranchFor(current.id);
      let targetHasMessage = false;
      if (current.state === "provisioning" && Option.isSome(target)) {
        const detail = yield* query
          .getThreadDetailSnapshot(targetThreadId, { turnLimit: 1 })
          .pipe(Effect.mapError(() => meshError("spawn", "provisionFailed", targetThreadId)));
        targetHasMessage =
          Option.isSome(detail) &&
          detail.value.thread.messages.some((message) => message.id === messageId);
      }
      if (current.state === "provisioning" && (Option.isNone(target) || !targetHasMessage)) {
        if (caller.branch === null) {
          return yield* meshError("spawn", "repositoryUnavailable");
        }
        const resumeExistingThread = Option.isSome(target);
        const createdAt = yield* nowIso;
        const receipt = yield* threadLauncher
          .launch({
            ...(resumeExistingThread ? { resumeExistingThread: true } : {}),
            onPrepared: () =>
              engine
                .dispatch({
                  type: "delegation.target.bind",
                  commandId: delegationCommandIdFor(current.id, "target-bind"),
                  delegationId: current.id,
                  targetThreadId,
                  createdAt,
                })
                .pipe(
                  Effect.tap((prepared) =>
                    Effect.sync(() => {
                      sequence = prepared.sequence;
                    }),
                  ),
                  Effect.asVoid,
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationDispatchCommandError({
                        message: "Failed to confirm the prepared delegation worktree.",
                        cause,
                      }),
                  ),
                ),
            command: {
              type: "thread.turn.start",
              commandId,
              threadId: targetThreadId,
              delegationId: current.id,
              message: { messageId, role: "user", text: current.task, attachments: [] },
              modelSelection,
              titleSeed: current.title,
              runtimeMode: caller.runtimeMode,
              interactionMode: caller.interactionMode,
              bootstrap: {
                ...(resumeExistingThread
                  ? {}
                  : {
                      createThread: {
                        projectId: project.id,
                        title: current.title,
                        modelSelection,
                        runtimeMode: caller.runtimeMode,
                        interactionMode: caller.interactionMode,
                        branch: null,
                        worktreePath: null,
                        createdAt,
                      },
                    }),
                prepareWorktree: {
                  projectCwd: project.workspaceRoot,
                  baseBranch: caller.branch,
                  branch,
                },
                runSetupScript: true,
              },
              createdAt,
            },
          })
          .pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                launchFailed = true;
                launchOutcomeUncertain =
                  ThreadLaunchService.isThreadLaunchSetupOutcomeUncertain(error);
              }),
            ),
          );
        sequence = receipt.sequence;
        target = yield* query
          .getThreadShellById(targetThreadId)
          .pipe(Effect.mapError(() => meshError("spawn", "provisionFailed")));
      }

      if (Option.isNone(target) || target.value.worktreePath === null) {
        return yield* meshError("spawn", "provisionFailed");
      }
      if (current.state === "provisioning") {
        const receipt = yield* dispatch("spawn", targetThreadId, {
          type: "delegation.target.bind",
          commandId: delegationCommandIdFor(current.id, "target-bind"),
          delegationId: current.id,
          targetThreadId,
          createdAt: yield* nowIso,
        });
        sequence = receipt.sequence;
        current = (yield* readDelegation("spawn", current.id)) ?? current;
      }
      if (current.state === "provisioning") {
        const receipt = yield* dispatch("spawn", targetThreadId, {
          type: "delegation.turn.request",
          commandId: delegationCommandIdFor(current.id, "turn-request"),
          delegationId: current.id,
          createdAt: yield* nowIso,
        });
        sequence = receipt.sequence;
        current = (yield* readDelegation("spawn", current.id)) ?? current;
      }
      if (current.state === "turnRequested") {
        const detail = yield* query
          .getThreadDetailSnapshot(targetThreadId, { turnLimit: 1 })
          .pipe(Effect.mapError(() => meshError("spawn", "provisionFailed", targetThreadId)));
        const turnAlreadyRequested =
          Option.isSome(detail) &&
          detail.value.thread.messages.some((message) => message.id === messageId);
        if (!turnAlreadyRequested) {
          const receipt = yield* dispatch("spawn", targetThreadId, {
            type: "thread.turn.start",
            commandId,
            threadId: targetThreadId,
            delegationId: current.id,
            message: { messageId, role: "user", text: current.task, attachments: [] },
            modelSelection,
            runtimeMode: target.value.runtimeMode,
            interactionMode: target.value.interactionMode,
            createdAt: yield* nowIso,
          });
          sequence = receipt.sequence;
        }
        yield* reconcileOne(current);
      }
    });

    yield* program.pipe(
      Effect.mapError(() => meshError("spawn", "provisionFailed", current.targetThreadId)),
      Effect.tapError(() =>
        launchFailed && !launchOutcomeUncertain
          ? Effect.void
          : readDelegation("spawn", current.id).pipe(
              Effect.flatMap((delegation) =>
                delegation === null || isTerminal(delegation)
                  ? Effect.void
                  : completeDelegation(
                      delegation,
                      "failed",
                      "The isolated worker could not be provisioned or resumed.",
                    ),
              ),
              Effect.ignoreCause({ log: true }),
            ),
      ),
    );
    const refreshed = yield* readDelegation("spawn", current.id);
    return {
      delegationId: current.id,
      targetThreadId: refreshed?.targetThreadId ?? null,
      commandId,
      messageId,
      sequence,
      state: refreshed?.state ?? current.state,
    } satisfies AgentMeshDelegationDispatchReceipt;
  });

  const reconcilePersistedDelegations = Effect.gen(function* () {
    const snapshot = yield* query.getCommandReadModel();
    for (const delegation of snapshot.delegations ?? []) {
      if (isTerminal(delegation)) continue;
      if (delegation.state === "requested" && delegation.target.kind === "existingThread") {
        yield* advanceExisting("wait", delegation).pipe(Effect.ignoreCause({ log: true }));
        continue;
      }
      if (
        delegation.target.kind === "newThread" &&
        (delegation.state === "requested" || delegation.state === "provisioning")
      ) {
        if (delegation.requester.kind !== "thread") {
          yield* completeDelegation(
            delegation,
            "failed",
            "A persisted new-worker delegation has no thread requester to resume from.",
          ).pipe(Effect.ignoreCause({ log: true }));
          continue;
        }
        const caller = yield* query.getThreadShellById(delegation.requester.threadId);
        const project = yield* query.getProjectShellById(delegation.projectId);
        if (Option.isNone(caller) || Option.isNone(project)) {
          yield* completeDelegation(
            delegation,
            "failed",
            "The requester or project required to resume this worker is unavailable.",
          ).pipe(Effect.ignoreCause({ log: true }));
          continue;
        }
        yield* advanceNew(caller.value, project.value, delegation).pipe(
          Effect.ignoreCause({ log: true }),
        );
        continue;
      }
      yield* reconcileOne(delegation).pipe(Effect.ignoreCause({ log: true }));
    }
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("persisted delegation reconciliation failed", { cause }),
    ),
  );

  yield* reconcilePersistedDelegations;

  const spawn: DelegationServiceShape["spawn"] = Effect.fn("DelegationService.spawn")(
    function* (scope, input) {
      return yield* mutationLock.withPermit(
        Effect.gen(function* () {
          const delegationId = threadDelegationIdFor(scope.threadId, input.requestId);
          const existing = yield* readDelegation("spawn", delegationId);
          if (existing !== null && !matchesSpawnRequest(existing, scope, input)) {
            return yield* meshError("spawn", "delegationUnavailable", existing.targetThreadId);
          }
          if (existing !== null && isTerminal(existing)) {
            return yield* receiptFor(existing);
          }
          const { caller, project } = yield* requireCaller("spawn", scope);
          if (existing !== null) {
            if (existing.projectId !== caller.projectId) {
              return yield* meshError("spawn", "delegationUnavailable");
            }
            return yield* advanceNew(caller, project, existing);
          }
          if (caller.branch === null) {
            return yield* meshError("spawn", "repositoryUnavailable");
          }
          const createdAt = yield* nowIso;
          const modelSelection = input.modelSelection ?? caller.modelSelection;
          yield* dispatch("spawn", null, {
            type: "delegation.request",
            commandId: delegationCommandIdFor(delegationId, "request"),
            delegationId,
            projectId: caller.projectId,
            requester: { kind: "thread", threadId: caller.id, requestId: input.requestId },
            target: { kind: "newThread", modelSelection },
            title: input.title,
            task: input.task,
            createdAt,
          });
          const delegation = yield* readDelegation("spawn", delegationId);
          if (delegation === null) {
            return yield* meshError("spawn", "dispatchFailed");
          }
          return yield* advanceNew(caller, project, delegation);
        }),
      );
    },
  );

  const wait: DelegationServiceShape["wait"] = Effect.fn("DelegationService.wait")(
    function* (scope, input) {
      const { caller } = yield* requireCaller("wait", scope);
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const liveEvents = yield* engine.subscribeDomainEvents;
          const initial = yield* readViews(caller, input);
          const initialReason = reasonFor(initial);
          if (initialReason !== null) {
            const result: AgentMeshWaitResult = {
              reason: initialReason,
              delegations: initial,
              cursor: yield* engine.latestSequence,
            };
            return result;
          }
          const timeoutMs = input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
          if (timeoutMs > 0) {
            const ids = new Set(input.delegationIds);
            const targetIds = new Set(
              initial.flatMap(({ targetThreadId }) =>
                targetThreadId === null ? [] : [targetThreadId],
              ),
            );
            yield* liveEvents.pipe(
              Stream.filter(
                (event) =>
                  (event.aggregateKind === "delegation" &&
                    ids.has(DelegationId.make(event.aggregateId))) ||
                  (event.aggregateKind === "thread" &&
                    targetIds.has(ThreadId.make(event.aggregateId))),
              ),
              Stream.mapEffect(() => readViews(caller, input)),
              Stream.filter((views) => reasonFor(views) !== null),
              Stream.runHead,
              Effect.timeoutOption(timeoutMs),
            );
          }
          const delegations = yield* readViews(caller, input);
          const result: AgentMeshWaitResult = {
            reason: reasonFor(delegations) ?? "timeout",
            delegations,
            cursor: yield* engine.latestSequence,
          };
          return result;
        }),
      );
    },
  );

  return DelegationService.of({ spawn, send, wait });
});

export const layer = Layer.effect(DelegationService, make);

export const layerTest = Layer.succeed(
  DelegationService,
  DelegationService.of({
    spawn: () => Effect.die("DelegationService.spawn is not stubbed in this test"),
    send: () => Effect.die("DelegationService.send is not stubbed in this test"),
    wait: () => Effect.die("DelegationService.wait is not stubbed in this test"),
  }),
);
