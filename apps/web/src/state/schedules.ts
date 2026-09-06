import { createScheduleEnvironmentAtoms } from "@t3tools/client-runtime/state/schedules";

import { connectionAtomRuntime } from "../connection/runtime";

export const scheduleEnvironment: ReturnType<typeof createScheduleEnvironmentAtoms> =
  createScheduleEnvironmentAtoms(connectionAtomRuntime);
