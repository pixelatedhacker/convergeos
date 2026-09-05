import {
  CommandId,
  KanbanMcpError,
  type KanbanMcpOperation,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { KanbanToolkit } from "./tools.ts";

const fail = (
  operation: KanbanMcpOperation,
  reason: "callerUnavailable" | "readFailed" | "commandFailed",
  detail: string,
) => new KanbanMcpError({ operation, reason, detail });

const callerProject = Effect.fn("kanbanMcp.callerProject")(function* (
  threadId: McpInvocationContext.McpInvocationScope["threadId"],
  operation: KanbanMcpOperation,
) {
  const query = yield* ProjectionSnapshotQuery;
  const readModel = yield* query
    .getCommandReadModel()
    .pipe(Effect.mapError((error) => fail(operation, "readFailed", error.message)));
  const thread = readModel.threads.find(
    (candidate) => candidate.id === threadId && candidate.deletedAt === null,
  );
  if (thread === undefined) {
    return yield* fail(operation, "callerUnavailable", "Calling agent thread is unavailable.");
  }
  return { projectId: thread.projectId, readModel };
});

const handlers = {
  kanban_read: () =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.requireKanbanCapability("kanban.read", "read");
      const { projectId, readModel } = yield* callerProject(invocation.threadId, "read");
      return {
        projectId,
        cards: (readModel.kanbanCards ?? []).filter(
          (card) => card.projectId === projectId && card.deletedAt === null,
        ),
        delegations: (readModel.delegations ?? [])
          .filter(
            (delegation) =>
              delegation.projectId === projectId && delegation.requester.kind === "kanban",
          )
          .map((delegation) => ({
            id: delegation.id,
            state: delegation.state,
            targetThreadId: delegation.targetThreadId,
          })),
      };
    }),
  kanban_write: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.requireKanbanCapability(
        "kanban.write",
        input.action,
      );
      const { projectId } = yield* callerProject(invocation.threadId, input.action);
      const commandId = CommandId.make(`mcp-kanban:${invocation.threadId}:${input.requestId}`);
      const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const command: OrchestrationCommand =
        input.action === "create"
          ? {
              type: "kanban.card.create",
              commandId,
              cardId: input.cardId,
              projectId,
              title: input.title,
              description: input.description,
              assigneeThreadId: input.assigneeThreadId,
              placement: input.placement,
              createdAt,
            }
          : input.action === "update"
            ? {
                type: "kanban.card.update",
                commandId,
                cardId: input.cardId,
                expectedRevision: input.expectedRevision,
                createdAt,
                ...(input.title === undefined ? {} : { title: input.title }),
                ...(input.description === undefined ? {} : { description: input.description }),
                ...(input.assigneeThreadId === undefined
                  ? {}
                  : { assigneeThreadId: input.assigneeThreadId }),
              }
            : input.action === "move"
              ? {
                  type: "kanban.card.move",
                  commandId,
                  cardId: input.cardId,
                  expectedRevision: input.expectedRevision,
                  placement: input.placement,
                  createdAt,
                }
              : input.action === "retry"
                ? {
                    type: "kanban.card.retry",
                    commandId,
                    cardId: input.cardId,
                    expectedRevision: input.expectedRevision,
                    createdAt,
                  }
                : {
                    type: "kanban.card.delete",
                    commandId,
                    cardId: input.cardId,
                    expectedRevision: input.expectedRevision,
                    createdAt,
                  };
      const engine = yield* OrchestrationEngineService;
      const receipt = yield* engine
        .dispatch(command)
        .pipe(Effect.mapError((error) => fail(input.action, "commandFailed", error.message)));
      return { cardId: input.cardId, sequence: receipt.sequence };
    }),
} satisfies Parameters<typeof KanbanToolkit.toLayer>[0];

export const KanbanToolkitHandlersLive = KanbanToolkit.toLayer(handlers);
