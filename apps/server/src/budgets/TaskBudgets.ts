import {
  InvocationUsageReport,
  TaskBudgetConfiguration,
  TaskBudgetError,
  TaskBudgetPolicy,
  type TaskBudgetStatus,
  type ModelSelection,
  type OrchestrationCommand,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import type { DelegationCommandReadModel } from "../delegation/commandReadModel.ts";

const decodeConfiguration = Schema.decodeUnknownEffect(
  Schema.fromJsonString(TaskBudgetConfiguration),
);
const encodePolicy = Schema.encodeEffect(Schema.fromJsonString(TaskBudgetPolicy));
const decodePolicy = Schema.decodeUnknownEffect(Schema.fromJsonString(TaskBudgetPolicy));
const decodeUsage = Schema.decodeUnknownOption(Schema.Struct({ report: InvocationUsageReport }));
const denied = (detail: string) => new TaskBudgetError({ detail });

interface Reservation {
  reservation_id: string;
  root_thread_id: string;
  delegation_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  dispatch_command_id: string | null;
  instance_id: string;
  model: string;
  consultation: number;
  committed_tokens: number;
  phase: "reserved" | "dispatched" | "launching" | "finished";
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  const policyPath = `${config.stateDir}/task-budgets.json`;

  const configuration = Effect.fn("TaskBudgets.configuration")(function* () {
    if (!(yield* fs.exists(policyPath))) return [];
    const text = yield* fs.readFileString(policyPath);
    const decoded = yield* decodeConfiguration(text);
    const ids = new Set(decoded.policies.map((policy) => policy.rootThreadId));
    if (ids.size !== decoded.policies.length) return yield* denied("Duplicate budget root policy.");
    for (const policy of decoded.policies) {
      const models = new Set(
        policy.models.map(
          (entry) => `${entry.instanceId.length}:${entry.instanceId}${entry.model}`,
        ),
      );
      if (models.size !== policy.models.length)
        return yield* denied("Duplicate budget model rule.");
    }
    return decoded.policies;
  });

  const savedPolicy = Effect.fn("TaskBudgets.savedPolicy")(function* (rootId: string) {
    const rows = yield* sql<{
      policy_json: string;
    }>`SELECT policy_json FROM task_budget_policies WHERE root_thread_id = ${rootId}`;
    return rows[0] === undefined ? null : yield* decodePolicy(rows[0].policy_json);
  });

  const binding = Effect.fn("TaskBudgets.binding")(function* (threadId: string) {
    const rows = yield* sql<{
      root_thread_id: string;
    }>`SELECT root_thread_id FROM task_budget_threads WHERE thread_id = ${threadId}`;
    return rows[0]?.root_thread_id ?? null;
  });

  const bind = Effect.fn("TaskBudgets.bind")(function* (threadId: string, rootId: string) {
    const previous = yield* binding(threadId);
    if (previous !== null && previous !== rootId)
      return yield* denied("Worker already belongs to another task budget.");
    yield* sql`INSERT INTO task_budget_threads(thread_id, root_thread_id) VALUES (${threadId}, ${rootId}) ON CONFLICT(thread_id) DO NOTHING`;
  });

  const policyFor = Effect.fn("TaskBudgets.policyFor")(function* (
    threadId: string,
    policies: ReadonlyArray<TaskBudgetPolicy>,
  ) {
    const rootId = (yield* binding(threadId)) ?? threadId;
    const supplied = policies.find((policy) => policy.rootThreadId === rootId);
    const policy = supplied ?? (yield* savedPolicy(rootId));
    if (policy === null) return null;
    const encoded = yield* encodePolicy(policy);
    yield* sql`INSERT INTO task_budget_policies(root_thread_id, policy_json)
      VALUES (${rootId}, ${encoded})
      ON CONFLICT(root_thread_id) DO UPDATE SET policy_json = excluded.policy_json`;
    yield* bind(threadId, rootId);
    return policy;
  });

  const policyForAdmission = Effect.fn("TaskBudgets.policyForAdmission")(function* (
    threadId: string,
    policies: ReadonlyArray<TaskBudgetPolicy>,
    readModel: DelegationCommandReadModel,
  ) {
    const rootId = (yield* binding(threadId)) ?? threadId;
    if (
      policies.some((policy) => policy.rootThreadId === rootId) &&
      (yield* savedPolicy(rootId)) === null
    ) {
      const thread = readModel.threads.find((entry) => entry.id === rootId);
      const active =
        thread?.session?.status === "starting" ||
        thread?.session?.status === "running" ||
        thread?.session?.activeTurnId != null ||
        thread?.latestTurn?.state === "running";
      const hasDelegationHistory =
        readModel.delegations?.some(
          (delegation) =>
            (delegation.requester.kind === "thread" && delegation.requester.threadId === rootId) ||
            delegation.targetThreadId === rootId,
        ) ?? false;
      if (active || hasDelegationHistory)
        return yield* denied(
          "Activate task budgets on an idle root before its first delegation; existing work cannot be retroactively accounted.",
        );
    }
    return yield* policyFor(threadId, policies);
  });

  const totals = Effect.fn("TaskBudgets.totals")(function* (rootId: string) {
    const rows = yield* sql<{
      calls: number;
      consultations: number;
      active_workers: number;
      active_coordinator: number;
      tokens: number;
    }>`
      SELECT COUNT(*) AS calls, COALESCE(SUM(consultation),0) AS consultations,
      COALESCE(SUM(CASE WHEN phase <> 'finished' AND (thread_id IS NULL OR thread_id <> root_thread_id) THEN 1 ELSE 0 END),0) AS active_workers,
      COALESCE(SUM(CASE WHEN phase <> 'finished' AND thread_id = root_thread_id THEN 1 ELSE 0 END),0) AS active_coordinator,
      COALESCE(SUM(committed_tokens),0) AS tokens
      FROM task_budget_reservations WHERE root_thread_id = ${rootId}`;
    return (
      rows[0] ?? { calls: 0, consultations: 0, active_workers: 0, active_coordinator: 0, tokens: 0 }
    );
  });

  const admit = Effect.fn("TaskBudgets.admit")(function* (input: {
    id: string;
    delegationId: string | null;
    threadId: string | null;
    policy: TaskBudgetPolicy;
    selection: ModelSelection | undefined;
  }) {
    const now = yield* Clock.currentTimeMillis;
    if (now >= Date.parse(input.policy.deadline))
      return yield* denied("Task budget deadline has passed; new calls are blocked.");
    const model = input.policy.models.find(
      (entry) =>
        entry.instanceId === input.selection?.instanceId && entry.model === input.selection.model,
    );
    if (model === undefined)
      return yield* denied("Provider instance/model is not allowed by this task budget.");
    const existing =
      yield* sql<Reservation>`SELECT * FROM task_budget_reservations WHERE reservation_id = ${input.id}`;
    const previous = existing[0];
    if (previous !== undefined) {
      if (
        previous.root_thread_id !== input.policy.rootThreadId ||
        previous.instance_id !== model.instanceId ||
        previous.model !== model.model ||
        previous.phase === "finished"
      ) {
        return yield* denied("Reservation identity or selected model changed.");
      }
      return;
    }
    const used = yield* totals(input.policy.rootThreadId);
    if (used.calls >= input.policy.maxCalls)
      return yield* denied("Task call allowance is exhausted.");
    if (model.consultation && used.consultations >= input.policy.maxConsultations)
      return yield* denied("Task consultation allowance is exhausted.");
    if (used.tokens + model.reserveTokens > input.policy.maxTokens)
      return yield* denied("Task token allowance cannot cover the conservative reservation.");
    const coordinator = input.threadId === input.policy.rootThreadId;
    if (
      coordinator
        ? used.active_coordinator >= 1
        : used.active_workers >= input.policy.maxConcurrentWorkers
    ) {
      return yield* denied(
        "Task concurrency allowance is occupied (including pending or uncertain launches).",
      );
    }
    if (input.threadId !== null) {
      const active =
        yield* sql`SELECT reservation_id FROM task_budget_reservations WHERE thread_id = ${input.threadId} AND phase <> 'finished' LIMIT 1`;
      if (active.length > 0)
        return yield* denied("This thread already has a budgeted invocation in flight.");
      yield* bind(input.threadId, input.policy.rootThreadId);
    }
    yield* sql`INSERT INTO task_budget_reservations
      (reservation_id,root_thread_id,delegation_id,thread_id,turn_id,instance_id,model,consultation,committed_tokens,phase,admitted_at)
      VALUES (${input.id},${input.policy.rootThreadId},${input.delegationId},${input.threadId},NULL,${model.instanceId},${model.model},${model.consultation ? 1 : 0},${model.reserveTokens},'reserved',${DateTime.formatIso(DateTime.makeUnsafe(now))})`;
  });

  // The engine calls this inside its event/receipt transaction, before any launch event is published.
  const applyCommand = Effect.fn("TaskBudgets.applyCommand")(function* (
    command: OrchestrationCommand,
    readModel: DelegationCommandReadModel,
  ) {
    if (command.type === "delegation.request") {
      if (command.requester.kind !== "thread") return;
      const policies = yield* configuration();
      const policy = yield* policyForAdmission(command.requester.threadId, policies, readModel);
      if (policy === null) return;
      const target = command.target;
      const threadId = target.kind === "existingThread" ? target.threadId : null;
      const selection =
        target.kind === "newThread"
          ? target.modelSelection
          : readModel.threads.find((thread) => thread.id === target.threadId)?.modelSelection;
      yield* admit({
        id: `delegation:${command.delegationId}`,
        delegationId: command.delegationId,
        threadId,
        policy,
        selection,
      });
      return;
    }
    if (
      command.type === "delegation.provision.start" ||
      command.type === "delegation.target.bind"
    ) {
      const rows =
        yield* sql<Reservation>`SELECT * FROM task_budget_reservations WHERE delegation_id = ${command.delegationId}`;
      if (rows[0] === undefined) return;
      yield* bind(command.targetThreadId, rows[0].root_thread_id);
      yield* sql`UPDATE task_budget_reservations SET thread_id = ${command.targetThreadId} WHERE delegation_id = ${command.delegationId}`;
      return;
    }
    if (command.type === "thread.turn.start" || command.type === "thread.peer-turn.start") {
      const policies = yield* configuration();
      const delegation =
        command.delegationId === undefined
          ? undefined
          : readModel.delegations?.find((entry) => entry.id === command.delegationId);
      const requester =
        delegation?.requester.kind === "thread"
          ? delegation.requester.threadId
          : command.type === "thread.peer-turn.start"
            ? command.sourceThreadId
            : undefined;
      const parentPolicy =
        requester === undefined ? null : yield* policyForAdmission(requester, policies, readModel);
      if (parentPolicy !== null) yield* bind(command.threadId, parentPolicy.rootThreadId);
      const policy = yield* policyForAdmission(command.threadId, policies, readModel);
      if (policy === null) return;
      const thread = readModel.threads.find((entry) => entry.id === command.threadId);
      const selection =
        command.type === "thread.turn.start"
          ? (command.modelSelection ??
            thread?.modelSelection ??
            command.bootstrap?.createThread?.modelSelection)
          : thread?.modelSelection;
      const id =
        command.delegationId === undefined
          ? `command:${command.commandId}`
          : `delegation:${command.delegationId}`;
      yield* admit({
        id,
        delegationId: command.delegationId ?? null,
        threadId: command.threadId,
        policy,
        selection,
      });
      const current =
        yield* sql<Reservation>`SELECT * FROM task_budget_reservations WHERE reservation_id = ${id}`;
      if (current[0]?.phase !== "reserved")
        return yield* denied(
          "Reservation was already dispatched; use the original command ID to retry.",
        );
      yield* sql`UPDATE task_budget_reservations SET phase = 'dispatched', thread_id = ${command.threadId}, dispatch_command_id = ${command.commandId} WHERE reservation_id = ${id}`;
      return selection;
    }
    if (command.type === "thread.session.set" && command.session.activeTurnId !== null) {
      yield* sql`UPDATE task_budget_reservations SET turn_id = ${command.session.activeTurnId}
        WHERE thread_id = ${command.threadId} AND phase = 'launching' AND turn_id IS NULL`;
      return;
    }
    if (command.type === "thread.activity.append" && command.activity.turnId !== undefined) {
      const activity = command.activity;
      if (activity.kind === "invocation.usage") {
        const decoded = decodeUsage(activity.payload);
        if (decoded._tag === "Some") {
          // Never refund reservations. Partial/windows are lower bounds, not additive child totals.
          const tokens = decoded.value.report.models.reduce(
            (sum, model) => sum + (model.inputTokens ?? 0) + (model.outputTokens ?? 0),
            0,
          );
          yield* sql`UPDATE task_budget_reservations SET committed_tokens = MAX(committed_tokens, ${tokens})
            WHERE thread_id = ${command.threadId} AND turn_id = ${activity.turnId ?? null}`;
        }
      } else if (activity.kind === "invocation.finished") {
        yield* sql`UPDATE task_budget_reservations SET phase = 'finished'
          WHERE thread_id = ${command.threadId} AND turn_id = ${activity.turnId ?? null}`;
      }
      return;
    }
    // Failure before dispatch proves no invocation was launched. After dispatch, only provider acknowledgement releases the slot.
    if (command.type === "delegation.complete") {
      yield* sql`UPDATE task_budget_reservations SET phase = 'finished' WHERE delegation_id = ${command.delegationId} AND phase = 'reserved'`;
    }
  });

  const read = Effect.fn("TaskBudgets.read")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<TaskBudgetStatus, TaskBudgetError> {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const policies = yield* configuration();
          const rootId = (yield* binding(threadId)) ?? threadId;
          const policy =
            policies.find((entry) => entry.rootThreadId === rootId) ?? (yield* savedPolicy(rootId));
          const used = policy === null ? null : yield* totals(policy.rootThreadId);
          const now = yield* Clock.currentTimeMillis;
          return {
            threadId,
            rootThreadId: policy?.rootThreadId ?? null,
            policy,
            calls: used?.calls ?? 0,
            consultations: used?.consultations ?? 0,
            activeWorkers: used?.active_workers ?? 0,
            activeCoordinator: used?.active_coordinator ?? 0,
            committedTokens: used?.tokens ?? 0,
            observedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
            deadlineExceeded: policy === null ? false : now >= Date.parse(policy.deadline),
            enforcement: "managed-host-admission" as const,
          };
        }),
      )
      .pipe(Effect.mapError(() => denied("Unable to read the task budget policy or ledger.")));
  });
  const claimDispatch = Effect.fn("TaskBudgets.claimDispatch")(function* (input: {
    threadId: ThreadId;
    commandId: string | null;
    modelSelection: ModelSelection | undefined;
  }) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const policies = yield* configuration();
          const policy = yield* policyFor(input.threadId, policies);
          if (policy === null) return;
          const rows = yield* sql<Reservation>`SELECT * FROM task_budget_reservations
        WHERE dispatch_command_id = ${input.commandId} AND thread_id = ${input.threadId}`;
          const reservation = rows[0];
          if (
            reservation === undefined ||
            reservation.phase !== "dispatched" ||
            reservation.turn_id !== null
          ) {
            return yield* denied(
              "This turn has no unclaimed budget reservation; an earlier launch may still be running.",
            );
          }
          if ((yield* Clock.currentTimeMillis) >= Date.parse(policy.deadline))
            return yield* denied("Task deadline passed before provider dispatch.");
          if (
            !policy.models.some(
              (entry) =>
                entry.instanceId === reservation.instance_id && entry.model === reservation.model,
            )
          )
            return yield* denied("Admitted model was removed from the task budget allowlist.");
          if (
            reservation.instance_id !== input.modelSelection?.instanceId ||
            reservation.model !== input.modelSelection.model
          ) {
            return yield* denied("Provider dispatch differs from the admitted budget model.");
          }
          yield* sql`UPDATE task_budget_reservations SET phase = 'launching' WHERE reservation_id = ${reservation.reservation_id}`;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "TaskBudgetError"
            ? cause
            : denied("Task budget could not be verified before provider dispatch."),
        ),
      );
  });

  const releaseUnlaunched = Effect.fn("TaskBudgets.releaseUnlaunched")(function* (
    threadId: ThreadId,
    commandId: string | null,
  ) {
    // Only a reactor path known not to have called sendTurn may use this. Claimed/uncertain launches stay occupied.
    yield* sql`UPDATE task_budget_reservations SET phase = 'finished'
      WHERE thread_id = ${threadId} AND dispatch_command_id = ${commandId} AND phase = 'dispatched' AND turn_id IS NULL`;
  });
  return { applyCommand, read, claimDispatch, releaseUnlaunched };
});
