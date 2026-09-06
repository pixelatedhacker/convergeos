/**
 * Multi-environment schedule state.
 *
 * Every connected environment answers the same typed query; the client merges
 * the results. Environments whose servers predate scheduled turns are listed
 * but excluded from the merged schedule and run lists.
 *
 * @module state/schedulesView
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScheduleListSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import {
  mergeCapableSnapshots,
  type EnvironmentSchedule,
  type EnvironmentScheduleRun,
} from "../components/schedules/SchedulesPage.logic";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useServerConfigs } from "./entities";
import { environmentPresentations } from "./presentation";
import { scheduleEnvironment } from "./schedules";

const EMPTY_LIST_INPUT = {} as const;

export interface EnvironmentSchedulesQueryStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly snapshot: ScheduleListSnapshot | null;
}

export interface EnvironmentSchedulesStatus extends EnvironmentSchedulesQueryStatus {
  readonly supportsSchedules: boolean;
}

const schedulesByEnvironmentAtom = Atom.make((get): readonly EnvironmentSchedulesQueryStatus[] => {
  const presentations = get(environmentPresentations.presentationsAtom);
  const statuses: EnvironmentSchedulesQueryStatus[] = [];
  for (const [environmentId, presentation] of presentations) {
    const result = get(scheduleEnvironment.list({ environmentId, input: EMPTY_LIST_INPUT }));
    statuses.push({
      environmentId,
      label: presentation.entry.target.label,
      isPending: result.waiting,
      error: result._tag === "Failure" ? "This environment could not list schedules." : null,
      snapshot: Option.getOrNull(AsyncResult.value(result)),
    });
  }
  return statuses;
}).pipe(Atom.withLabel("web-schedules:environments"));

export interface SchedulesView {
  readonly environments: readonly EnvironmentSchedulesStatus[];
  readonly schedules: readonly EnvironmentSchedule[];
  readonly runs: readonly EnvironmentScheduleRun[];
  /** True until at least one capable environment has answered. */
  readonly isPending: boolean;
  /**
   * True while capable environments that have not failed are still answering.
   * Older or failed environments are reported on their own rows.
   */
  readonly isPartial: boolean;
  readonly refresh: () => void;
}

export function useSchedules(): SchedulesView {
  const queryStatuses = useAtomValue(schedulesByEnvironmentAtom);
  const serverConfigs = useServerConfigs();

  const environments = useMemo(
    () =>
      queryStatuses.map((status): EnvironmentSchedulesStatus => {
        const supportsSchedules =
          serverConfigs.get(status.environmentId)?.environment.capabilities.scheduledTurns === true;
        if (!supportsSchedules) {
          return {
            ...status,
            supportsSchedules: false,
            isPending: false,
            error: null,
            snapshot: null,
          };
        }
        return { ...status, supportsSchedules: true };
      }),
    [queryStatuses, serverConfigs],
  );

  const refresh = useCallback(() => {
    for (const environment of environments) {
      appAtomRegistry.refresh(
        scheduleEnvironment.list({
          environmentId: environment.environmentId,
          input: EMPTY_LIST_INPUT,
        }),
      );
    }
  }, [environments]);

  const { schedules, runs } = useMemo(() => mergeCapableSnapshots(environments), [environments]);

  const capable = environments.filter((environment) => environment.supportsSchedules);
  const answeredCount = capable.filter((environment) => environment.snapshot !== null).length;
  const stillReporting = capable.filter(
    (environment) => environment.snapshot === null && environment.error === null,
  ).length;

  return {
    environments,
    schedules,
    runs,
    isPending: capable.length > 0 && answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
    refresh,
  };
}
