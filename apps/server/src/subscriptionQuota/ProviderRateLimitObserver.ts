import {
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type SubscriptionQuotaSubject,
  type SubscriptionQuotaWindow,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/**
 * Keeps the latest subscription rate-limit windows that provider runtimes
 * report during normal turns. Claude Code and the Codex app server both push
 * these updates, so quota can be shown without an external collector.
 * Observations are in-memory and bound exactly to the emitting instance.
 */
export const PROVIDER_EVENTS_COLLECTOR_ID = "provider-events";
const STALE_AFTER_SECONDS = 30 * 60;

interface ObservedInstance {
  readonly provider: SubscriptionQuotaSubject["provider"];
  readonly windows: ReadonlyMap<string, SubscriptionQuotaWindow>;
  readonly observedAt: string;
}

function staleAt(observedAt: string): string | null {
  return Option.match(DateTime.make(observedAt), {
    onNone: () => null,
    onSome: (value) => DateTime.formatIso(DateTime.add(value, { seconds: STALE_AFTER_SECONDS })),
  });
}

function toSubject(
  instanceId: ProviderInstanceId,
  observed: ObservedInstance,
): SubscriptionQuotaSubject {
  return {
    subjectId: `${PROVIDER_EVENTS_COLLECTOR_ID}:${instanceId}`,
    provider: observed.provider,
    binding: { status: "exact", providerInstanceIds: [instanceId] },
    source: {
      collectorId: PROVIDER_EVENTS_COLLECTOR_ID,
      transport: "providerEvent",
      reportedSource: null,
    },
    status: "fresh",
    plan: null,
    accountLabel: null,
    observedAt: observed.observedAt,
    staleAt: staleAt(observed.observedAt),
    windows: [...observed.windows.values()],
    credits: null,
    warning: null,
  };
}

export type RateLimitRuntimeEvent = Extract<
  ProviderRuntimeEvent,
  { type: "account.rate-limits.updated" }
>;

/** Merge the adapter-normalized sparse update into one instance record. */
export function applyRateLimitsUpdate(
  previous: ObservedInstance | undefined,
  event: RateLimitRuntimeEvent,
): ObservedInstance {
  const windows = new Map(previous?.windows ?? []);
  for (const update of event.payload.limits.windows) {
    const known = windows.get(update.id);
    windows.set(update.id, {
      id: update.id,
      label: update.label,
      usedPercent: update.usedPercent,
      resetsAt: update.resetsAt ?? known?.resetsAt ?? null,
      synthetic: false,
    });
  }
  return {
    provider: event.provider,
    windows,
    observedAt: event.createdAt,
  };
}

export class ProviderRateLimitObserver extends Context.Service<
  ProviderRateLimitObserver,
  {
    readonly observe: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
    readonly subjects: Effect.Effect<ReadonlyArray<SubscriptionQuotaSubject>>;
  }
>()("t3/subscriptionQuota/ProviderRateLimitObserver") {}

export const make = Effect.sync(() => {
  const observed = new Map<ProviderInstanceId, ObservedInstance>();

  const observe = (event: ProviderRuntimeEvent): Effect.Effect<void> => {
    if (event.type !== "account.rate-limits.updated" || event.providerInstanceId === undefined) {
      return Effect.void;
    }
    const instanceId = event.providerInstanceId;
    if (event.payload.limits.windows.length === 0) {
      return Effect.void;
    }
    return Effect.sync(() => {
      observed.set(instanceId, applyRateLimitsUpdate(observed.get(instanceId), event));
    });
  };

  const subjects = Effect.sync(() =>
    [...observed.entries()].map(([instanceId, record]) => toSubject(instanceId, record)),
  );

  return ProviderRateLimitObserver.of({ observe, subjects });
});

export const layer = Layer.effect(ProviderRateLimitObserver, make);
