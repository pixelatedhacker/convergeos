import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const TaskBudgetModel = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  consultation: Schema.Boolean,
  reserveTokens: PositiveInt,
});

export const TaskBudgetPolicy = Schema.Struct({
  rootThreadId: ThreadId,
  maxCalls: NonNegativeInt,
  maxConsultations: NonNegativeInt,
  maxConcurrentWorkers: NonNegativeInt,
  deadline: IsoDateTime,
  maxTokens: NonNegativeInt,
  models: Schema.Array(TaskBudgetModel).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export type TaskBudgetPolicy = typeof TaskBudgetPolicy.Type;

export const TaskBudgetConfiguration = Schema.Struct({
  version: Schema.Literal(1),
  policies: Schema.Array(TaskBudgetPolicy).check(Schema.isMaxLength(1000)),
});

export const TaskBudgetStatus = Schema.Struct({
  threadId: ThreadId,
  rootThreadId: Schema.NullOr(ThreadId),
  policy: Schema.NullOr(TaskBudgetPolicy),
  calls: NonNegativeInt,
  consultations: NonNegativeInt,
  activeWorkers: NonNegativeInt,
  activeCoordinator: NonNegativeInt,
  committedTokens: NonNegativeInt,
  observedAt: IsoDateTime,
  deadlineExceeded: Schema.Boolean,
  enforcement: Schema.Literal("managed-host-admission"),
});
export type TaskBudgetStatus = typeof TaskBudgetStatus.Type;

export class TaskBudgetError extends Schema.TaggedError<TaskBudgetError>()("TaskBudgetError", {
  detail: Schema.String,
}) {}
