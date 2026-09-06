import {
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  ScheduleId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type Schedule,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { ServerActivation } from "../serverActivation.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import * as SchedulerReactor from "./SchedulerReactor.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { ThreadLaunchService } from "./Services/ThreadLaunchService.ts";

const NOW = "2026-09-06T13:00:00.000Z";
const PROJECT_ID = ProjectId.make("scheduler-project");
const SCHEDULE_ID = ScheduleId.make("schedule-daily");
const OCCURRENCE = "2026-09-06T13:00:00.000Z";

type FireCommand = Extract<OrchestrationCommand, { readonly type: "schedule.fire" }>;

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function makeProject(id: ProjectId = PROJECT_ID): OrchestrationProjectShell {
  return {
    id,
    title: `Project ${id}`,
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: NOW,
  };
}

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: SCHEDULE_ID,
    projectId: PROJECT_ID,
    title: "Morning briefing",
    prompt: "Summarize what changed overnight.",
    recurrence: { kind: "daily", time: { hour: 9, minute: 0 } },
    timeZone: "America/New_York",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    enabled: true,
    nextRunAt: OCCURRENCE,
    lastRunAt: null,
    revision: 3,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function makeSnapshot(
  projects: ReadonlyArray<OrchestrationProjectShell>,
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    projects,
    threads: [],
    updatedAt: NOW,
  };
}

interface HarnessOptions {
  readonly due: ReadonlyArray<Schedule>;
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  readonly onDispatch?: (
    command: FireCommand,
  ) => Effect.Effect<void, OrchestrationCommandInvariantError>;
  readonly onLaunch?: (threadId: ThreadId) => Effect.Effect<void, OrchestrationDispatchCommandError>;
}

const makeHarness = Effect.fn("makeSchedulerHarness")(function* (options: HarnessOptions) {
  const activation = yield* Deferred.make<void>();
  const due = yield* Ref.make(options.due);
  const dueReads = yield* Queue.unbounded<void>();
  const commands = yield* Ref.make<ReadonlyArray<FireCommand>>([]);
  const launches = yield* Ref.make<
    ReadonlyArray<{ readonly threadId: ThreadId } & Record<string, unknown>>
  >([]);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) => {
    if (command.type !== "schedule.fire") {
      return Effect.die(new Error(`Unexpected command: ${command.type}`));
    }
    return Ref.update(commands, (recorded) => [...recorded, command]).pipe(
      Effect.andThen(options.onDispatch?.(command) ?? Effect.void),
      Effect.as({ sequence: 1 }),
    );
  };

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      listDueSchedules: () => Queue.offer(dueReads, undefined).pipe(Effect.andThen(Ref.get(due))),
      getShellSnapshot: () => Effect.succeed(makeSnapshot(options.projects ?? [makeProject()])),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(ThreadLaunchService, {
      launch: (input) =>
        Ref.update(launches, (recorded) => [
          ...recorded,
          { threadId: input.command.threadId, command: input.command },
        ]).pipe(
          Effect.andThen(options.onLaunch?.(input.command.threadId) ?? Effect.void),
          Effect.as({ sequence: 1 }),
        ),
    }),
    Layer.succeed(ServerActivation, Deferred.await(activation)),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );

  return {
    activation,
    due,
    dueReads,
    commands,
    launches,
    layer: SchedulerReactor.layer.pipe(Layer.provide(dependencies)),
  };
});

const runOneSweep = Effect.fn("runOneSchedulerSweep")(function* (
  fixture: Effect.Success<ReturnType<typeof makeHarness>>,
) {
  const reactor = yield* SchedulerReactor.SchedulerReactor;
  yield* reactor.start();
  yield* Deferred.succeed(fixture.activation, undefined);
  yield* Queue.take(fixture.dueReads);
  yield* reactor.drain;
  return reactor;
});

describe("SchedulerReactor", () => {
  it.effect("claims a due occurrence and launches a fresh thread for it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({ due: [makeSchedule()] });

        yield* Effect.gen(function* () {
          yield* runOneSweep(fixture);

          const commands = yield* Ref.get(fixture.commands);
          assert.deepStrictEqual(
            commands.map(({ commandId, scheduleId, threadId }) => ({
              commandId,
              scheduleId,
              threadId,
            })),
            [
              {
                commandId: `server:schedule-fire:${SCHEDULE_ID}:${OCCURRENCE}`,
                scheduleId: SCHEDULE_ID,
                threadId: `scheduled-run:${SCHEDULE_ID}:${OCCURRENCE}`,
              },
            ],
          );

          const launches = yield* Ref.get(fixture.launches);
          assert.strictEqual(launches.length, 1);
          const command = launches[0]?.command as Extract<
            OrchestrationCommand,
            { readonly type: "thread.turn.start" }
          >;
          assert.strictEqual(command.type, "thread.turn.start");
          assert.strictEqual(
            command.commandId,
            `server:schedule-turn:${SCHEDULE_ID}:${OCCURRENCE}`,
          );
          assert.strictEqual(command.message.text, "Summarize what changed overnight.");
          assert.strictEqual(command.titleSeed, "Morning briefing");
          assert.deepStrictEqual(command.bootstrap, {
            createThread: {
              projectId: PROJECT_ID,
              title: "Morning briefing",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: NOW,
            },
          });
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("skips schedules whose project is unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          due: [makeSchedule()],
          projects: [makeProject(ProjectId.make("other-project"))],
        });

        yield* Effect.gen(function* () {
          yield* runOneSweep(fixture);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
          assert.deepStrictEqual(yield* Ref.get(fixture.launches), []);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("keeps sweeping when the fire is rejected after the launch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const stale = makeSchedule();
        const next = makeSchedule({
          id: ScheduleId.make("schedule-hourly"),
          title: "Hourly sync",
        });
        const fixture = yield* makeHarness({
          due: [stale, next],
          onDispatch: (command) =>
            command.scheduleId === SCHEDULE_ID
              ? Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: "schedule changed after the sweep read it",
                  }),
                )
              : Effect.void,
        });

        yield* Effect.gen(function* () {
          yield* runOneSweep(fixture);

          // Launch-first ordering means a rejected fire (deleted or disabled in
          // the race window) leaves an orphan thread rather than dropping the
          // occurrence; the sweep still fires the remaining due schedules.
          assert.strictEqual((yield* Ref.get(fixture.commands)).length, 2);
          const launches = yield* Ref.get(fixture.launches);
          assert.deepStrictEqual(
            launches.map(({ threadId }) => threadId),
            [
              ThreadId.make(`scheduled-run:schedule-daily:${OCCURRENCE}`),
              ThreadId.make(`scheduled-run:schedule-hourly:${OCCURRENCE}`),
            ],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("does not claim the occurrence when the launch fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const failing = makeSchedule();
        const next = makeSchedule({
          id: ScheduleId.make("schedule-hourly"),
          title: "Hourly sync",
        });
        const fixture = yield* makeHarness({
          due: [failing, next],
          onLaunch: (threadId) =>
            threadId === ThreadId.make(`scheduled-run:${SCHEDULE_ID}:${OCCURRENCE}`)
              ? Effect.fail(
                  new OrchestrationDispatchCommandError({
                    message: "transient launch failure",
                  }),
                )
              : Effect.void,
        });

        yield* Effect.gen(function* () {
          yield* runOneSweep(fixture);

          // The failed launch must not fire: nextRunAt stays put and the next
          // sweep retries the occurrence. The healthy schedule still fires.
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map(({ scheduleId }) => scheduleId),
            [ScheduleId.make("schedule-hourly")],
          );
          assert.strictEqual((yield* Ref.get(fixture.launches)).length, 2);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("sweeps again every minute", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({ due: [makeSchedule()] });

        yield* Effect.gen(function* () {
          const reactor = yield* runOneSweep(fixture);
          assert.strictEqual((yield* Ref.get(fixture.commands)).length, 1);

          yield* TestClock.adjust("1 minute");
          yield* Queue.take(fixture.dueReads);
          yield* reactor.drain;
          assert.strictEqual((yield* Ref.get(fixture.commands)).length, 2);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});
