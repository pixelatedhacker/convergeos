import { CommandId, MessageId, ThreadId, type Schedule as ScheduledTurn } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadLaunchService from "./Services/ThreadLaunchService.ts";

/**
 * Fires due scheduled turns. A minute sweep claims each due occurrence with a
 * schedule.fire command (the decider advances nextRunAt atomically, so
 * overlapping sweeps cannot double-fire), then launches a fresh thread for
 * the run through the same bootstrap path the web composer uses. All command
 * and entity ids are deterministic per occurrence, so a crash mid-fire
 * replays into engine command-receipt dedup instead of a second run.
 */
export class SchedulerReactor extends Context.Service<
  SchedulerReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/SchedulerReactor") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const threadLauncher = yield* ThreadLaunchService.ThreadLaunchService;

  const fireOne = Effect.fn("SchedulerReactor.fireOne")(function* (
    schedule: ScheduledTurn,
    activeProjectIds: ReadonlySet<string>,
  ) {
    const occurrence = schedule.nextRunAt;
    if (occurrence === null) return;
    if (!activeProjectIds.has(schedule.projectId)) {
      yield* Effect.logWarning("scheduled turn skipped: project unavailable", {
        scheduleId: schedule.id,
        projectId: schedule.projectId,
      });
      return;
    }
    const threadId = ThreadId.make(`scheduled-run:${schedule.id}:${occurrence}`);
    // A rejected fire (deleted, disabled, or already claimed) must not launch:
    // the fire is the claim on the occurrence, the launch is the follow-through.
    yield* engine.dispatch({
      type: "schedule.fire",
      commandId: CommandId.make(`server:schedule-fire:${schedule.id}:${occurrence}`),
      scheduleId: schedule.id,
      threadId,
      firedAt: DateTime.formatIso(yield* DateTime.now),
    });
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* threadLauncher.launch({
      command: {
        type: "thread.turn.start",
        commandId: CommandId.make(`server:schedule-turn:${schedule.id}:${occurrence}`),
        threadId,
        message: {
          messageId: MessageId.make(`scheduled-run-message:${schedule.id}:${occurrence}`),
          role: "user",
          text: schedule.prompt,
          attachments: [],
        },
        modelSelection: schedule.modelSelection,
        titleSeed: schedule.title,
        runtimeMode: schedule.runtimeMode,
        interactionMode: schedule.interactionMode,
        bootstrap: {
          createThread: {
            projectId: schedule.projectId,
            title: schedule.title,
            modelSelection: schedule.modelSelection,
            runtimeMode: schedule.runtimeMode,
            interactionMode: schedule.interactionMode,
            branch: null,
            worktreePath: null,
            createdAt,
          },
        },
        createdAt,
      },
    });
  });

  const sweep = Effect.fn("SchedulerReactor.sweep")(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const due = yield* snapshots.listDueSchedules(now);
    if (due.length === 0) return;
    const shell = yield* snapshots.getShellSnapshot();
    const activeProjectIds = new Set(shell.projects.map((project) => project.id));
    yield* Effect.forEach(
      due,
      (schedule) =>
        fireOne(schedule, activeProjectIds).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("scheduled turn fire failed", {
                  scheduleId: schedule.id,
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      { discard: true },
    );
  });

  const runSweep = sweep().pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("scheduled turn sweep failed", { cause: Cause.pretty(cause) }),
    ),
  );
  const worker = yield* makeDrainableWorker(() => runSweep);

  const start: SchedulerReactor["Service"]["start"] = Effect.fn("SchedulerReactor.start")(
    function* () {
      yield* forkParked(
        Effect.gen(function* () {
          yield* worker.enqueue(undefined);
          yield* worker.drain;
        }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
      );
    },
  );

  return { start, drain: worker.drain } satisfies SchedulerReactor["Service"];
});

export const layer = Layer.effect(SchedulerReactor, make);
