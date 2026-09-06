import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ScheduleCreatedPayload,
  ScheduleDeletedPayload,
  ScheduleFiredPayload,
  ScheduleId,
  ScheduleUpdatedPayload,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type Schedule,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-09-05T15:00:00.000Z";
const projectId = ProjectId.make("project-schedules");
const scheduleId = ScheduleId.make("schedule-one");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test-model" };

const readModel = (schedules: ReadonlyArray<Schedule> = []): OrchestrationReadModel => ({
  snapshotSequence: 0,
  projects: [
    {
      id: projectId,
      title: "Schedules",
      workspaceRoot: "/workspace/project",
      repositoryIdentity: null,
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      autoPull: false,
      faviconPath: null,
      projectIcon: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    },
  ],
  threads: [],
  kanbanCards: [],
  schedules,
  updatedAt: NOW,
});

const dailySchedule = (overrides: Partial<Schedule> = {}): Schedule => ({
  id: scheduleId,
  projectId,
  title: "Morning briefing",
  prompt: "Summarize what changed overnight.",
  recurrence: { kind: "daily", time: { hour: 9, minute: 0 } },
  timeZone: "America/New_York",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  enabled: true,
  // 15:00Z is 11:00 EDT, so the next 09:00 is tomorrow, 13:00Z.
  nextRunAt: "2026-09-06T13:00:00.000Z",
  lastRunAt: null,
  revision: 1,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...overrides,
});

const createCommand = (
  overrides: Partial<Extract<OrchestrationCommand, { type: "schedule.create" }>> = {},
): Extract<OrchestrationCommand, { type: "schedule.create" }> => ({
  type: "schedule.create",
  commandId: CommandId.make("create-schedule"),
  scheduleId,
  projectId,
  title: "Morning briefing",
  prompt: "Summarize what changed overnight.",
  recurrence: { kind: "daily", time: { hour: 9, minute: 0 } },
  timeZone: "America/New_York",
  modelSelection,
  enabled: true,
  createdAt: NOW,
  ...overrides,
});

it.layer(NodeServices.layer)("schedule decider", (it) => {
  it.effect("creates a schedule with the computed next run", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: createCommand(),
        readModel: readModel(),
      });

      expect("type" in event && event.type).toBe("schedule.created");
      if (!("type" in event) || event.type !== "schedule.created") return;
      expect(event.aggregateKind).toBe("schedule");
      const payload = yield* Schema.decodeUnknownEffect(ScheduleCreatedPayload)(event.payload);
      expect(payload.schedule).toMatchObject({
        id: scheduleId,
        projectId,
        enabled: true,
        nextRunAt: "2026-09-06T13:00:00.000Z",
        lastRunAt: null,
        revision: 1,
        deletedAt: null,
      });
    }),
  );

  it.effect("rejects a duplicate schedule id", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: createCommand(),
        readModel: readModel([dailySchedule({ deletedAt: NOW })]),
      }).pipe(Effect.flip);
      expect(String(error)).toContain("already exists");
    }),
  );

  it.effect("rejects an invalid time zone", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: createCommand({ timeZone: "Mars/Olympus" }),
        readModel: readModel(),
      }).pipe(Effect.flip);
      expect(String(error)).toContain("not a valid IANA time zone");
    }),
  );

  it.effect("rejects an enabled once schedule in the past", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: createCommand({ recurrence: { kind: "once", at: "2026-09-05T09:00:00.000Z" } }),
        readModel: readModel(),
      }).pipe(Effect.flip);
      expect(String(error)).toContain("no future run time");
    }),
  );

  it.effect("allows a disabled schedule with no future run time", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: createCommand({
          recurrence: { kind: "once", at: "2026-09-05T09:00:00.000Z" },
          enabled: false,
        }),
        readModel: readModel(),
      });
      expect("type" in event && event.type).toBe("schedule.created");
      if (!("type" in event) || event.type !== "schedule.created") return;
      const payload = yield* Schema.decodeUnknownEffect(ScheduleCreatedPayload)(event.payload);
      expect(payload.schedule.nextRunAt).toBeNull();
      expect(payload.schedule.enabled).toBe(false);
    }),
  );

  it.effect("recomputes the next run when timing changes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "schedule.update",
          commandId: CommandId.make("update-schedule"),
          scheduleId,
          expectedRevision: 1,
          recurrence: { kind: "weekly", weekday: 1, time: { hour: 8, minute: 30 } },
          createdAt: NOW,
        },
        readModel: readModel([dailySchedule()]),
      });
      expect("type" in event && event.type).toBe("schedule.updated");
      if (!("type" in event) || event.type !== "schedule.updated") return;
      const payload = yield* Schema.decodeUnknownEffect(ScheduleUpdatedPayload)(event.payload);
      // From Friday 2026-09-05 the next Monday is 2026-09-07, 08:30 EDT.
      expect(payload.schedule.nextRunAt).toBe("2026-09-07T12:30:00.000Z");
      expect(payload.schedule.revision).toBe(2);
    }),
  );

  it.effect("keeps an exhausted once schedule editable for unrelated changes", () =>
    Effect.gen(function* () {
      const exhausted = dailySchedule({
        recurrence: { kind: "once", at: "2026-09-01T09:00:00.000Z" },
        nextRunAt: null,
        lastRunAt: "2026-09-01T13:00:00.000Z",
      });
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "schedule.update",
          commandId: CommandId.make("retitle-schedule"),
          scheduleId,
          expectedRevision: 1,
          title: "Renamed",
          createdAt: NOW,
        },
        readModel: readModel([exhausted]),
      });
      expect("type" in event && event.type).toBe("schedule.updated");
      if (!("type" in event) || event.type !== "schedule.updated") return;
      const payload = yield* Schema.decodeUnknownEffect(ScheduleUpdatedPayload)(event.payload);
      expect(payload.schedule.title).toBe("Renamed");
      expect(payload.schedule.nextRunAt).toBeNull();
    }),
  );

  it.effect("clears nextRunAt on disable and recomputes on re-enable", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const disabled = yield* decideOrchestrationCommand({
        command: {
          type: "schedule.update",
          commandId: CommandId.make("disable-schedule"),
          scheduleId,
          expectedRevision: 1,
          enabled: false,
          createdAt: NOW,
        },
        readModel: readModel([dailySchedule()]),
      });
      if (!("type" in disabled) || disabled.type !== "schedule.updated") {
        throw new Error("expected schedule.updated");
      }
      const disabledPayload = yield* Schema.decodeUnknownEffect(ScheduleUpdatedPayload)(
        disabled.payload,
      );
      expect(disabledPayload.schedule.enabled).toBe(false);
      expect(disabledPayload.schedule.nextRunAt).toBeNull();

      const reenabled = yield* decideOrchestrationCommand({
        command: {
          type: "schedule.update",
          commandId: CommandId.make("enable-schedule"),
          scheduleId,
          expectedRevision: 2,
          enabled: true,
          createdAt: NOW,
        },
        readModel: readModel([disabledPayload.schedule]),
      });
      if (!("type" in reenabled) || reenabled.type !== "schedule.updated") {
        throw new Error("expected schedule.updated");
      }
      const reenabledPayload = yield* Schema.decodeUnknownEffect(ScheduleUpdatedPayload)(
        reenabled.payload,
      );
      expect(reenabledPayload.schedule.nextRunAt).toBe("2026-09-06T13:00:00.000Z");
    }),
  );

  it.effect("rejects an update with a stale revision", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "schedule.update",
          commandId: CommandId.make("stale-update"),
          scheduleId,
          expectedRevision: 99,
          title: "Nope",
          createdAt: NOW,
        },
        readModel: readModel([dailySchedule()]),
      }).pipe(Effect.flip);
      expect(String(error)).toContain("revision changed");
    }),
  );

  it.effect("deletes a schedule", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "schedule.delete",
          commandId: CommandId.make("delete-schedule"),
          scheduleId,
          expectedRevision: 1,
          createdAt: NOW,
        },
        readModel: readModel([dailySchedule()]),
      });
      expect("type" in event && event.type).toBe("schedule.deleted");
      if (!("type" in event) || event.type !== "schedule.deleted") return;
      const payload = yield* Schema.decodeUnknownEffect(ScheduleDeletedPayload)(event.payload);
      expect(payload).toMatchObject({ projectId, scheduleId, previousRevision: 1 });
    }),
  );

  it.effect("fires a due schedule and advances the next run", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("scheduled-run:schedule-one:2026-09-06T13:00:00.000Z");
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "schedule.fire",
          commandId: CommandId.make("fire-schedule"),
          scheduleId,
          threadId,
          firedAt: "2026-09-06T13:00:05.000Z",
        },
        readModel: readModel([dailySchedule()]),
      });
      expect("type" in event && event.type).toBe("schedule.fired");
      if (!("type" in event) || event.type !== "schedule.fired") return;
      const payload = yield* Schema.decodeUnknownEffect(ScheduleFiredPayload)(event.payload);
      expect(payload.threadId).toBe(threadId);
      expect(payload.firedAt).toBe("2026-09-06T13:00:05.000Z");
      expect(payload.schedule.lastRunAt).toBe("2026-09-06T13:00:05.000Z");
      expect(payload.schedule.nextRunAt).toBe("2026-09-07T13:00:00.000Z");
      expect(payload.schedule.revision).toBe(2);
    }),
  );

  it.effect("exhausts a once schedule when it fires", () =>
    Effect.gen(function* () {
      const once = dailySchedule({
        recurrence: { kind: "once", at: "2026-09-06T13:00:00.000Z" },
        nextRunAt: "2026-09-06T13:00:00.000Z",
      });
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "schedule.fire",
          commandId: CommandId.make("fire-once"),
          scheduleId,
          threadId: ThreadId.make("scheduled-run:schedule-one:once"),
          firedAt: "2026-09-06T13:00:00.000Z",
        },
        readModel: readModel([once]),
      });
      if (!("type" in event) || event.type !== "schedule.fired") {
        throw new Error("expected schedule.fired");
      }
      const payload = yield* Schema.decodeUnknownEffect(ScheduleFiredPayload)(event.payload);
      expect(payload.schedule.nextRunAt).toBeNull();
      expect(payload.schedule.enabled).toBe(true);
    }),
  );

  it.effect("rejects a fire before the schedule is due", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "schedule.fire",
          commandId: CommandId.make("fire-early"),
          scheduleId,
          threadId: ThreadId.make("scheduled-run:schedule-one:early"),
          firedAt: "2026-09-06T12:59:59.000Z",
        },
        readModel: readModel([dailySchedule()]),
      }).pipe(Effect.flip);
      expect(String(error)).toContain("not due");
    }),
  );

  it.effect("rejects a fire for a disabled schedule", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "schedule.fire",
          commandId: CommandId.make("fire-disabled"),
          scheduleId,
          threadId: ThreadId.make("scheduled-run:schedule-one:disabled"),
          firedAt: "2026-09-07T00:00:00.000Z",
        },
        readModel: readModel([dailySchedule({ enabled: false, nextRunAt: null })]),
      }).pipe(Effect.flip);
      expect(String(error)).toContain("not runnable");
    }),
  );

  it.effect("projects schedule events into the read model", () =>
    Effect.gen(function* () {
      const created = yield* decideOrchestrationCommand({
        command: createCommand(),
        readModel: readModel(),
      });
      if (!("type" in created) || created.type !== "schedule.created") {
        throw new Error("expected schedule.created");
      }
      const createdPayload = yield* Schema.decodeUnknownEffect(ScheduleCreatedPayload)(
        created.payload,
      );
      const withCreated = yield* projectEvent(readModel(), {
        ...created,
        type: "schedule.created",
        payload: createdPayload,
        sequence: 1,
      });
      const projected = (withCreated.schedules ?? []).find(
        (schedule) => schedule.id === scheduleId,
      );
      expect(projected?.title).toBe("Morning briefing");
      expect(projected?.nextRunAt).toBe("2026-09-06T13:00:00.000Z");

      const deleted = yield* decideOrchestrationCommand({
        command: {
          type: "schedule.delete",
          commandId: CommandId.make("delete-projected"),
          scheduleId,
          expectedRevision: 1,
          createdAt: NOW,
        },
        readModel: withCreated,
      });
      if (!("type" in deleted) || deleted.type !== "schedule.deleted") {
        throw new Error("expected schedule.deleted");
      }
      const deletedPayload = yield* Schema.decodeUnknownEffect(ScheduleDeletedPayload)(
        deleted.payload,
      );
      const withDeleted = yield* projectEvent(withCreated, {
        ...deleted,
        type: "schedule.deleted",
        payload: deletedPayload,
        sequence: 2,
      });
      expect(
        (withDeleted.schedules ?? []).find((schedule) => schedule.id === scheduleId)?.deletedAt,
      ).not.toBeNull();
    }),
  );
});
