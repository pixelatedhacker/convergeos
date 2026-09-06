import {
  DelegationUsageError,
  InvocationUsageActivity,
  IsoDateTime,
  ThreadId,
  TurnId,
  type DelegationUsageEntry,
  type DelegationUsageInput,
  type DelegationUsageResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  invocationFinishedActivityId,
  invocationStartedActivityId,
  invocationUsageActivityId,
} from "./invocationUsageActivity.ts";

export class DelegationUsageService extends Context.Service<
  DelegationUsageService,
  {
    readonly read: (
      callerThreadId: ThreadId,
      input: DelegationUsageInput,
    ) => Effect.Effect<DelegationUsageResult, DelegationUsageError>;
  }
>()("t3/usage/DelegationUsageService") {}

const TurnLookup = Schema.Struct({ threadId: ThreadId, turnId: TurnId });
const terminalStates = new Set(["completed", "failed", "interrupted"]);

export const make = Effect.gen(function* () {
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const sql = yield* SqlClient.SqlClient;
  const readStarted = SqlSchema.findOneOption({
    Request: TurnLookup,
    Result: Schema.Struct({ createdAt: IsoDateTime }),
    execute: ({ threadId, turnId }) => sql`
      SELECT created_at AS "createdAt" FROM projection_thread_activities
      WHERE activity_id = ${invocationStartedActivityId(ThreadId.make(threadId), TurnId.make(turnId))}
        AND thread_id = ${threadId} AND turn_id = ${turnId} AND kind = 'invocation.started'
    `,
  });
  const readUsage = SqlSchema.findOneOption({
    Request: TurnLookup,
    Result: Schema.Struct({
      createdAt: IsoDateTime,
      payload: Schema.fromJsonString(InvocationUsageActivity),
    }),
    execute: ({ threadId, turnId }) => sql`
      SELECT created_at AS "createdAt", payload_json AS "payload" FROM projection_thread_activities
      WHERE activity_id = ${invocationUsageActivityId(ThreadId.make(threadId), TurnId.make(turnId))}
        AND thread_id = ${threadId} AND turn_id = ${turnId} AND kind = 'invocation.usage'
    `,
  });
  const readFinished = SqlSchema.findOneOption({
    Request: TurnLookup,
    Result: Schema.Struct({
      createdAt: IsoDateTime,
      payload: Schema.fromJsonString(InvocationUsageActivity),
    }),
    execute: ({ threadId, turnId }) => sql`
      SELECT created_at AS "createdAt", payload_json AS "payload" FROM projection_thread_activities
      WHERE activity_id = ${invocationFinishedActivityId(ThreadId.make(threadId), TurnId.make(turnId))}
        AND thread_id = ${threadId} AND turn_id = ${turnId} AND kind = 'invocation.finished'
    `,
  });

  const read = Effect.fn("DelegationUsageService.read")(function* (
    callerThreadId: ThreadId,
    input: DelegationUsageInput,
  ) {
    const caller = yield* query
      .getThreadShellById(callerThreadId)
      .pipe(Effect.mapError(() => new DelegationUsageError({ reason: "readFailed" })));
    const ids = [...new Set(input.delegationIds)];
    if (
      Option.isNone(caller) ||
      ids.length !== input.delegationIds.length ||
      !query.getDelegations
    ) {
      return yield* new DelegationUsageError({ reason: "unavailable" });
    }
    const delegations = yield* query
      .getDelegations(ids)
      .pipe(Effect.mapError(() => new DelegationUsageError({ reason: "readFailed" })));
    const byId = new Map(delegations.map((delegation) => [delegation.id, delegation]));
    const ordered = ids.map((id) => byId.get(id)).filter((value) => value !== undefined);
    if (
      ordered.length !== ids.length ||
      ordered.some(({ projectId }) => projectId !== caller.value.projectId)
    ) {
      return yield* new DelegationUsageError({ reason: "unavailable" });
    }

    const entries = yield* Effect.forEach(
      ordered,
      Effect.fn(function* (delegation) {
        const lookup =
          delegation.targetThreadId !== null && delegation.turnId !== null
            ? { threadId: delegation.targetThreadId, turnId: delegation.turnId }
            : null;
        const started = lookup === null ? Option.none() : yield* readStarted(lookup);
        const finished = lookup === null ? Option.none() : yield* readFinished(lookup);
        const measured = lookup === null ? Option.none() : yield* readUsage(lookup);
        const recordedReport =
          Option.isSome(measured) &&
          Option.isSome(finished) &&
          measured.value.payload.provider === finished.value.payload.provider &&
          measured.value.payload.providerInstanceId === finished.value.payload.providerInstanceId
            ? measured.value.payload.report
            : null;
        const startedAt = Option.isSome(started) ? started.value.createdAt : null;
        const finishedAt = Option.isSome(finished) ? finished.value.createdAt : null;
        const startTime = startedAt === null ? Option.none() : DateTime.make(startedAt);
        const finishTime = finishedAt === null ? Option.none() : DateTime.make(finishedAt);
        const elapsed =
          Option.isSome(startTime) && Option.isSome(finishTime)
            ? DateTime.toEpochMillis(finishTime.value) - DateTime.toEpochMillis(startTime.value)
            : null;
        return {
          delegationId: delegation.id,
          requester: delegation.requester,
          targetThreadId: delegation.targetThreadId,
          turnId: delegation.turnId,
          state: delegation.state,
          startedAt,
          finishedAt,
          durationMs: elapsed !== null && elapsed >= 0 ? elapsed : null,
          usage: Option.isSome(finished)
            ? { status: "recorded", ...finished.value.payload, report: recordedReport }
            : {
                status: "unavailable",
                reason:
                  lookup === null
                    ? "notStarted"
                    : terminalStates.has(delegation.state)
                      ? "notRecorded"
                      : "awaitingCompletion",
              },
        } satisfies DelegationUsageEntry;
      }),
    ).pipe(Effect.mapError(() => new DelegationUsageError({ reason: "readFailed" })));
    return { contractVersion: 1, delegations: entries } satisfies DelegationUsageResult;
  });

  return DelegationUsageService.of({ read });
});

export const layer = Layer.effect(DelegationUsageService, make);
