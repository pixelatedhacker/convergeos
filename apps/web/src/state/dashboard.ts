/**
 * Multi-environment subscription quota state for the dashboard card.
 *
 * Same merge shape as usage and schedules: every connected environment
 * answers the same typed query and failures surface as per-environment rows
 * instead of sinking the card. There is no quota capability flag, so older
 * servers simply error and are reported as unavailable.
 *
 * @module state/dashboard
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, SubscriptionQuotaReport } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

const EMPTY_QUOTA_INPUT = {} as const;

export interface EnvironmentQuotaStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly report: SubscriptionQuotaReport | null;
}

const quotaByEnvironmentAtom = Atom.make((get): readonly EnvironmentQuotaStatus[] => {
  const presentations = get(environmentPresentations.presentationsAtom);
  const statuses: EnvironmentQuotaStatus[] = [];
  for (const [environmentId, presentation] of presentations) {
    const result = get(
      serverEnvironment.subscriptionQuota({ environmentId, input: EMPTY_QUOTA_INPUT }),
    );
    statuses.push({
      environmentId,
      label: presentation.entry.target.label,
      isPending: result.waiting,
      error: result._tag === "Failure" ? "This environment could not report quota." : null,
      report: Option.getOrNull(AsyncResult.value(result)),
    });
  }
  return statuses;
}).pipe(Atom.withLabel("web-dashboard:quota"));

export interface DashboardQuotaView {
  readonly environments: readonly EnvironmentQuotaStatus[];
  /** True until at least one environment has answered. */
  readonly isPending: boolean;
  readonly refresh: () => void;
}

export function useDashboardQuota(): DashboardQuotaView {
  const environments = useAtomValue(quotaByEnvironmentAtom);

  const refresh = useCallback(() => {
    for (const environment of environments) {
      appAtomRegistry.refresh(
        serverEnvironment.subscriptionQuota({
          environmentId: environment.environmentId,
          input: EMPTY_QUOTA_INPUT,
        }),
      );
    }
  }, [environments]);

  const answered = environments.filter((environment) => environment.report !== null).length;
  const stillReporting = environments.filter(
    (environment) => environment.report === null && environment.error === null,
  ).length;

  return {
    environments,
    isPending: answered === 0 && stillReporting > 0,
    refresh,
  };
}
