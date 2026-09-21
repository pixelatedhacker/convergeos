import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, SubscriptionQuotaReport } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

interface SubscriptionQuotaEnvironmentBase {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export type EnvironmentSubscriptionQuotaState =
  | (SubscriptionQuotaEnvironmentBase & { readonly kind: "pending" })
  | (SubscriptionQuotaEnvironmentBase & {
      readonly kind: "failed";
      readonly message: string;
    })
  | (SubscriptionQuotaEnvironmentBase & {
      readonly kind: "ready";
      readonly report: SubscriptionQuotaReport;
    });

const subscriptionQuotaByEnvironmentAtom = Atom.make(
  (get): readonly EnvironmentSubscriptionQuotaState[] => {
    const presentations = get(environmentPresentations.presentationsAtom);
    const states: EnvironmentSubscriptionQuotaState[] = [];

    for (const [environmentId, presentation] of presentations) {
      const result = get(serverEnvironment.subscriptionQuota({ environmentId, input: {} }));
      const report = Option.getOrNull(AsyncResult.value(result));
      const base = { environmentId, label: presentation.entry.target.label };

      if (report !== null) {
        states.push({ ...base, kind: "ready", report });
      } else if (result._tag === "Failure") {
        states.push({
          ...base,
          kind: "failed",
          message: "This environment could not report subscription limits.",
        });
      } else {
        states.push({ ...base, kind: "pending" });
      }
    }

    return states;
  },
).pipe(Atom.withLabel("web-subscription-quota:environments"));

export interface SubscriptionQuotaView {
  readonly environments: readonly EnvironmentSubscriptionQuotaState[];
  readonly refresh: () => void;
}

export function useSubscriptionQuota(): SubscriptionQuotaView {
  const environments = useAtomValue(subscriptionQuotaByEnvironmentAtom);
  const refresh = useCallback(() => {
    for (const environment of environments) {
      appAtomRegistry.refresh(
        serverEnvironment.subscriptionQuota({
          environmentId: environment.environmentId,
          input: {},
        }),
      );
    }
  }, [environments]);

  return { environments, refresh };
}
