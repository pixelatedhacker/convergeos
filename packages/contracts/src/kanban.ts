import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  KanbanCardId,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

export const KanbanStatus = Schema.Literals(["backlog", "ready", "inProgress", "review", "done"]);
export type KanbanStatus = typeof KanbanStatus.Type;

export const KanbanCardTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
export const KanbanCardDescription = TrimmedString.check(Schema.isMaxLength(4_000));
export const KanbanOrderKey = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const KanbanCard = Schema.Struct({
  id: KanbanCardId,
  projectId: ProjectId,
  title: KanbanCardTitle,
  description: KanbanCardDescription,
  status: KanbanStatus,
  orderKey: KanbanOrderKey,
  assigneeThreadId: Schema.NullOr(ThreadId),
  revision: PositiveInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type KanbanCard = typeof KanbanCard.Type;

export const KanbanPlacement = Schema.Union([
  Schema.Struct({ status: KanbanStatus, relation: Schema.Literals(["first", "last"]) }),
  Schema.Struct({
    status: KanbanStatus,
    relation: Schema.Literals(["before", "after"]),
    cardId: KanbanCardId,
  }),
]);
export type KanbanPlacement = typeof KanbanPlacement.Type;

export const KanbanBoardInput = Schema.Struct({ projectId: ProjectId });
export type KanbanBoardInput = typeof KanbanBoardInput.Type;

export const KanbanBoardSnapshot = Schema.Struct({
  projectId: ProjectId,
  cards: Schema.Array(KanbanCard),
});
export type KanbanBoardSnapshot = typeof KanbanBoardSnapshot.Type;

export const KanbanBoardStreamItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("snapshot"), snapshot: KanbanBoardSnapshot }),
  Schema.Struct({ kind: Schema.Literal("card-upserted"), sequence: PositiveInt, card: KanbanCard }),
  Schema.Struct({
    kind: Schema.Literal("card-removed"),
    sequence: PositiveInt,
    projectId: ProjectId,
    cardId: KanbanCardId,
  }),
]);
export type KanbanBoardStreamItem = typeof KanbanBoardStreamItem.Type;

export const KanbanMcpOperation = Schema.Literals(["read", "create", "update", "move", "delete"]);
export type KanbanMcpOperation = typeof KanbanMcpOperation.Type;

export const KanbanMcpErrorReason = Schema.Literals([
  "capabilityDenied",
  "callerUnavailable",
  "readFailed",
  "commandFailed",
]);
export type KanbanMcpErrorReason = typeof KanbanMcpErrorReason.Type;

export class KanbanMcpError extends Schema.TaggedErrorClass<KanbanMcpError>()("KanbanMcpError", {
  operation: KanbanMcpOperation,
  reason: KanbanMcpErrorReason,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Kanban ${this.operation} failed: ${this.detail}`;
  }
}

export const KanbanMcpReadInput = Schema.Struct({});
export type KanbanMcpReadInput = typeof KanbanMcpReadInput.Type;

const KanbanMcpMutationBase = {
  requestId: CommandId,
} as const;

export const KanbanMcpWriteInput = Schema.Union([
  Schema.Struct({
    ...KanbanMcpMutationBase,
    action: Schema.Literal("create"),
    cardId: KanbanCardId,
    title: KanbanCardTitle,
    description: KanbanCardDescription,
    assigneeThreadId: Schema.NullOr(ThreadId),
    placement: KanbanPlacement,
  }),
  Schema.Struct({
    ...KanbanMcpMutationBase,
    action: Schema.Literal("update"),
    cardId: KanbanCardId,
    expectedRevision: PositiveInt,
    title: Schema.optional(KanbanCardTitle),
    description: Schema.optional(KanbanCardDescription),
    assigneeThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  }),
  Schema.Struct({
    ...KanbanMcpMutationBase,
    action: Schema.Literal("move"),
    cardId: KanbanCardId,
    expectedRevision: PositiveInt,
    placement: KanbanPlacement,
  }),
  Schema.Struct({
    ...KanbanMcpMutationBase,
    action: Schema.Literal("delete"),
    cardId: KanbanCardId,
    expectedRevision: PositiveInt,
  }),
]);
export type KanbanMcpWriteInput = typeof KanbanMcpWriteInput.Type;

export const KanbanMcpWriteResult = Schema.Struct({
  cardId: KanbanCardId,
  sequence: PositiveInt,
});
export type KanbanMcpWriteResult = typeof KanbanMcpWriteResult.Type;
