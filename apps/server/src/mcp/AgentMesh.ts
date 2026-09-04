import {
  AgentMeshError,
  type AgentMeshAgent,
  type AgentMeshDispatchReceipt,
  type AgentMeshInterruptInput,
  type AgentMeshListInput,
  type AgentMeshListResult,
  type AgentMeshOperation,
  type AgentMeshReadInput,
  type AgentMeshReadResult,
  type AgentMeshSendInput,
  CommandId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

const DEFAULT_LIST_LIMIT = 50;
const stableIdPart = (value: string): string => `${value.length}:${value}`;

export interface AgentMeshScope {
  readonly threadId: ThreadId;
}

export interface AgentMeshShape {
  readonly list: (
    scope: AgentMeshScope,
    input: AgentMeshListInput,
  ) => Effect.Effect<AgentMeshListResult, AgentMeshError>;
  readonly send: (
    scope: AgentMeshScope,
    input: AgentMeshSendInput,
  ) => Effect.Effect<AgentMeshDispatchReceipt, AgentMeshError>;
  readonly read: (
    scope: AgentMeshScope,
    input: AgentMeshReadInput,
  ) => Effect.Effect<AgentMeshReadResult, AgentMeshError>;
  readonly interrupt: (
    scope: AgentMeshScope,
    input: AgentMeshInterruptInput,
  ) => Effect.Effect<AgentMeshDispatchReceipt, AgentMeshError>;
}

export class AgentMesh extends Context.Service<AgentMesh, AgentMeshShape>()("t3/mcp/AgentMesh") {}

const meshError = (
  operation: AgentMeshOperation,
  reason: AgentMeshError["reason"],
  targetThreadId: ThreadId | null = null,
) => new AgentMeshError({ operation, reason, targetThreadId });

const projectAgent = (
  thread: OrchestrationThreadShell,
  caller: OrchestrationThreadShell,
  workspaceRoot: string,
): AgentMeshAgent => ({
  threadId: thread.id,
  title: thread.title,
  sessionStatus: thread.session?.status ?? null,
  latestTurnState: thread.latestTurn?.state ?? null,
  activeTurnId: thread.session?.activeTurnId ?? null,
  providerInstanceId: thread.session?.providerInstanceId ?? null,
  hasPendingApprovals: thread.hasPendingApprovals,
  hasPendingUserInput: thread.hasPendingUserInput,
  backgroundLiveness: thread.backgroundLiveness ?? null,
  workspaceIsolation:
    normalizeProjectPathForComparison(thread.worktreePath ?? workspaceRoot) ===
    normalizeProjectPathForComparison(caller.worktreePath ?? workspaceRoot)
      ? "shared"
      : "isolated",
  updatedAt: thread.updatedAt,
  current: thread.id === caller.id,
});

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const readThread = (operation: AgentMeshOperation, threadId: ThreadId) =>
    query.getThreadShellById(threadId).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("agent mesh thread lookup failed", { operation, threadId, cause }),
      ),
      Effect.mapError(() => meshError(operation, "callerUnavailable")),
    );

  const requireCaller = Effect.fn("AgentMesh.requireCaller")(function* (
    operation: AgentMeshOperation,
    scope: AgentMeshScope,
  ) {
    const caller = yield* readThread(operation, scope.threadId);
    if (Option.isNone(caller)) {
      return yield* meshError(operation, "callerUnavailable");
    }
    return caller.value;
  });

  const requireTarget = Effect.fn("AgentMesh.requireTarget")(function* (
    operation: "read" | "send" | "interrupt",
    scope: AgentMeshScope,
    targetThreadId: ThreadId,
  ) {
    const caller = yield* requireCaller(operation, scope);
    const project = yield* query.getProjectShellById(caller.projectId).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("agent mesh project lookup failed", {
          operation,
          projectId: caller.projectId,
          cause,
        }),
      ),
      Effect.mapError(() => meshError(operation, "callerUnavailable")),
    );
    if (Option.isNone(project)) {
      return yield* meshError(operation, "callerUnavailable");
    }
    const target = yield* readThread(operation, targetThreadId).pipe(
      Effect.mapError(() => meshError(operation, "targetUnavailable", targetThreadId)),
    );
    if (Option.isNone(target) || target.value.projectId !== caller.projectId) {
      return yield* meshError(operation, "targetUnavailable", targetThreadId);
    }
    return { caller, target: target.value, workspaceRoot: project.value.workspaceRoot };
  });

  const dispatch = (
    operation: "send" | "interrupt",
    targetThreadId: ThreadId,
    command: OrchestrationCommand,
  ) =>
    engine.dispatch(command).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("agent mesh command dispatch failed", {
          operation,
          targetThreadId,
          cause,
        }),
      ),
      Effect.mapError(() => meshError(operation, "dispatchFailed", targetThreadId)),
    );

  const list: AgentMeshShape["list"] = Effect.fn("AgentMesh.list")(function* (scope, input) {
    const caller = yield* requireCaller("list", scope);
    const snapshot = yield* query.getShellSnapshot().pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("agent mesh project listing failed", {
          threadId: scope.threadId,
          cause,
        }),
      ),
      Effect.mapError(() => meshError("list", "callerUnavailable")),
    );
    const limit = input.limit ?? DEFAULT_LIST_LIMIT;
    const project = snapshot.projects.find(({ id }) => id === caller.projectId);
    if (project === undefined) {
      return yield* meshError("list", "callerUnavailable");
    }
    const projectThreads = snapshot.threads
      .filter((thread) => thread.projectId === caller.projectId)
      .sort((left, right) => {
        if (left.id === scope.threadId) return -1;
        if (right.id === scope.threadId) return 1;
        return right.updatedAt.localeCompare(left.updatedAt);
      });
    const agents = projectThreads
      .slice(0, limit)
      .map((thread) => projectAgent(thread, caller, project.workspaceRoot));
    return { projectId: caller.projectId, agents, hasMore: projectThreads.length > limit };
  });

  const read: AgentMeshShape["read"] = Effect.fn("AgentMesh.read")(function* (scope, input) {
    const { caller, target, workspaceRoot } = yield* requireTarget(
      "read",
      scope,
      input.targetThreadId,
    );
    const detail = yield* query.getThreadDetailSnapshot(target.id, { turnLimit: 1 }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("agent mesh thread detail read failed", {
          threadId: target.id,
          cause,
        }),
      ),
      Effect.mapError(() => meshError("read", "targetUnavailable", target.id)),
    );
    if (Option.isNone(detail) || detail.value.thread.projectId !== caller.projectId) {
      return yield* meshError("read", "targetUnavailable", target.id);
    }
    const assistant = detail.value.thread.messages.findLast(
      (message) => message.role === "assistant",
    );
    const maxChars = input.maxChars ?? 8_000;
    const truncated = assistant !== undefined && assistant.text.length > maxChars;
    return {
      agent: projectAgent(target, caller, workspaceRoot),
      latestAssistant:
        assistant === undefined
          ? null
          : {
              messageId: assistant.id,
              turnId: assistant.turnId,
              text: truncated ? assistant.text.slice(-maxChars) : assistant.text,
              truncated,
              updatedAt: assistant.updatedAt,
            },
    };
  });

  const send: AgentMeshShape["send"] = Effect.fn("AgentMesh.send")(function* (scope, input) {
    const { caller, target, workspaceRoot } = yield* requireTarget(
      "send",
      scope,
      input.targetThreadId,
    );
    const commandId = CommandId.make(
      `provider:agent-mesh:send:${stableIdPart(caller.id)}:${stableIdPart(target.id)}:${input.requestId}`,
    );
    const messageId = MessageId.make(
      `agent-mesh:${stableIdPart(caller.id)}:${stableIdPart(target.id)}:${input.requestId}`,
    );
    if (caller.id === target.id) {
      return yield* meshError("send", "selfTarget", target.id);
    }
    if (
      normalizeProjectPathForComparison(caller.worktreePath ?? workspaceRoot) ===
      normalizeProjectPathForComparison(target.worktreePath ?? workspaceRoot)
    ) {
      return yield* meshError("send", "workspaceShared", target.id);
    }
    const command = {
      type: "thread.peer-turn.start",
      commandId,
      requestId: input.requestId,
      sourceThreadId: caller.id,
      threadId: target.id,
      messageId,
      message: input.message,
    } satisfies OrchestrationCommand;
    const receipt = yield* dispatch("send", target.id, command);
    return { targetThreadId: target.id, commandId, messageId, sequence: receipt.sequence };
  });

  const interrupt: AgentMeshShape["interrupt"] = Effect.fn("AgentMesh.interrupt")(
    function* (scope, input) {
      const { caller, target } = yield* requireTarget("interrupt", scope, input.targetThreadId);
      const commandId = CommandId.make(
        `provider:agent-mesh:interrupt:${stableIdPart(caller.id)}:${stableIdPart(target.id)}:${stableIdPart(input.observedTurnId)}:${input.requestId}`,
      );
      if (caller.id === target.id) {
        return yield* meshError("interrupt", "selfTarget", target.id);
      }
      const command = {
        type: "thread.peer-turn.interrupt",
        commandId,
        requestId: input.requestId,
        sourceThreadId: caller.id,
        threadId: target.id,
        observedTurnId: input.observedTurnId,
      } satisfies OrchestrationCommand;
      const receipt = yield* dispatch("interrupt", target.id, command);
      return { targetThreadId: target.id, commandId, sequence: receipt.sequence };
    },
  );

  return AgentMesh.of({ list, read, send, interrupt });
});

export const layer = Layer.effect(AgentMesh, make);

export const layerTest = Layer.succeed(
  AgentMesh,
  AgentMesh.of({
    list: (_scope, _input) => Effect.die("AgentMesh.list is not stubbed in this test"),
    read: (_scope, _input) => Effect.die("AgentMesh.read is not stubbed in this test"),
    send: (_scope, _input) => Effect.die("AgentMesh.send is not stubbed in this test"),
    interrupt: (_scope, _input) => Effect.die("AgentMesh.interrupt is not stubbed in this test"),
  }),
);
