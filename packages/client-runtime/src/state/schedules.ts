import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createSchedule,
  deleteSchedule,
  updateSchedule,
  type CreateScheduleInput,
  type DeleteScheduleInput,
  type UpdateScheduleInput,
} from "../operations/commands.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export function createScheduleEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:schedules:list",
      tag: ORCHESTRATION_WS_METHODS.listSchedules,
      staleTimeMs: 5_000,
      refreshIntervalMs: 30_000,
    }),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:schedules:create",
      execute: (input: CreateScheduleInput) => createSchedule(input),
      scheduler,
      concurrency,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:schedules:update",
      execute: (input: UpdateScheduleInput) => updateSchedule(input),
      scheduler,
      concurrency,
    }),
    remove: createEnvironmentCommand(runtime, {
      label: "environment-data:schedules:delete",
      execute: (input: DeleteScheduleInput) => deleteSchedule(input),
      scheduler,
      concurrency,
    }),
  };
}
