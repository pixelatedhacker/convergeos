import {
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type SubscriptionQuotaSubject,
  type SubscriptionQuotaWarning,
  type SubscriptionQuotaWindow,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Keeps the latest subscription rate-limit windows that provider runtimes
 * report during normal turns. Claude Code and the Codex app server both push
 * these updates, so quota can be shown without an external collector.
 * Observations are in-memory and bound exactly to the emitting instance.
 */
export const PROVIDER_EVENTS_COLLECTOR_ID = "provider-events";
const STALE_AFTER_SECONDS = 30 * 60;

const ClaudeRateLimitEvent = Schema.Struct({
  rate_limit_info: Schema.Struct({
    status: Schema.Literals(["allowed", "allowed_warning", "rejected"]),
    resetsAt: Schema.optional(Schema.NullOr(Schema.Number)),
    rateLimitType: Schema.optional(Schema.NullOr(Schema.String)),
    utilization: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
});

const CodexWindow = Schema.Struct({
  usedPercent: Schema.Number,
  resetsAt: Schema.optional(Schema.NullOr(Schema.Number)),
  windowDurationMins: Schema.optional(Schema.NullOr(Schema.Number)),
});

const CodexRateLimitsEvent = Schema.Struct({
  rateLimits: Schema.Struct({
    primary: Schema.optional(Schema.NullOr(CodexWindow)),
    secondary: Schema.optional(Schema.NullOr(CodexWindow)),
    planType: Schema.optional(Schema.NullOr(Schema.String)),
    rateLimitReachedType: Schema.optional(Schema.NullOr(Schema.String)),
    credits: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          balance: Schema.optional(Schema.NullOr(Schema.String)),
          hasCredits: Schema.Boolean,
          unlimited: Schema.Boolean,
        }),
      ),
    ),
  }),
});

const decodeClaudeRateLimit = Schema.decodeUnknownEffect(ClaudeRateLimitEvent);
const decodeCodexRateLimits = Schema.decodeUnknownEffect(CodexRateLimitsEvent);

interface ObservedInstance {
  readonly provider: SubscriptionQuotaSubject["provider"];
  readonly plan: string | null;
  readonly windows: ReadonlyMap<string, SubscriptionQuotaWindow>;
  readonly credits: SubscriptionQuotaSubject["credits"];
  readonly warning: SubscriptionQuotaWarning | null;
  readonly observedAt: string;
}

/** Providers report epoch seconds; tolerate milliseconds defensively. */
function epochToIso(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null;
  const millis = value < 1e11 ? value * 1000 : value;
  return Option.match(DateTime.make(millis), { onNone: () => null, onSome: DateTime.formatIso });
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value * 100) / 100));
}

/** Claude reports utilization as a 0..1 fraction; a value above 1 is already a percentage. */
function claudeUsedPercent(utilization: number | null | undefined): number | null {
  if (utilization === null || utilization === undefined || !Number.isFinite(utilization))
    return null;
  return clampPercent(utilization <= 1 ? utilization * 100 : utilization);
}

const CLAUDE_WINDOW_LABELS: Readonly<Record<string, string>> = {
  five_hour: "5-hour",
  seven_day: "weekly (all models)",
  seven_day_opus: "weekly (Opus)",
  seven_day_sonnet: "weekly (Sonnet)",
  overage: "overage",
};

function claudeWindowLabel(rateLimitType: string): string {
  return CLAUDE_WINDOW_LABELS[rateLimitType] ?? rateLimitType.replace(/_/g, " ");
}

function codexWindowLabel(id: string, durationMins: number | null | undefined): string {
  if (durationMins === null || durationMins === undefined || durationMins <= 0) return id;
  if (durationMins % 1440 === 0) {
    const days = durationMins / 1440;
    return days === 7 ? "weekly" : `${days}-day`;
  }
  if (durationMins % 60 === 0) return `${durationMins / 60}-hour`;
  return `${durationMins}-minute`;
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
    plan: observed.plan,
    accountLabel: null,
    observedAt: observed.observedAt,
    staleAt: staleAt(observed.observedAt),
    windows: [...observed.windows.values()],
    credits: observed.credits,
    warning: observed.warning,
  };
}

export type RateLimitRuntimeEvent = Extract<
  ProviderRuntimeEvent,
  { type: "account.rate-limits.updated" }
>;

/** Merge one Claude update into the instance record. Each event carries one window. */
export function applyClaudeRateLimit(
  previous: ObservedInstance | undefined,
  event: RateLimitRuntimeEvent,
  decoded: typeof ClaudeRateLimitEvent.Type,
): ObservedInstance {
  const info = decoded.rate_limit_info;
  const windows = new Map(previous?.windows ?? []);
  const id = info.rateLimitType ?? "unknown";
  const usedPercent = claudeUsedPercent(info.utilization);
  const label = claudeWindowLabel(id);
  windows.set(id, {
    id,
    label,
    usedPercent: usedPercent ?? (info.status === "rejected" ? 100 : null),
    resetsAt: epochToIso(info.resetsAt),
    synthetic: usedPercent === null && info.status === "rejected",
  });
  const warning: SubscriptionQuotaWarning | null =
    info.status === "rejected"
      ? { kind: "rate-limited", message: `Claude reported the ${label} limit as reached.` }
      : info.status === "allowed_warning"
        ? {
            kind: "approaching-limit",
            message: `Claude reported the ${label} limit as nearly reached.`,
          }
        : null;
  return {
    provider: event.provider,
    plan: previous?.plan ?? null,
    windows,
    credits: null,
    warning,
    observedAt: event.createdAt,
  };
}

/** Codex sends the whole snapshot; sparse fields keep their previous value. */
export function applyCodexRateLimits(
  previous: ObservedInstance | undefined,
  event: RateLimitRuntimeEvent,
  decoded: typeof CodexRateLimitsEvent.Type,
): ObservedInstance {
  const snapshot = decoded.rateLimits;
  const windows = new Map(previous?.windows ?? []);
  for (const id of ["primary", "secondary"] as const) {
    const window = snapshot[id];
    if (!window) continue;
    // A rolling update may omit the window duration and reset; keep the last known values.
    const known = windows.get(id);
    windows.set(id, {
      id,
      label:
        window.windowDurationMins === null || window.windowDurationMins === undefined
          ? (known?.label ?? id)
          : codexWindowLabel(id, window.windowDurationMins),
      usedPercent: clampPercent(window.usedPercent),
      resetsAt: epochToIso(window.resetsAt) ?? known?.resetsAt ?? null,
      synthetic: false,
    });
  }
  const balance = snapshot.credits?.balance ? Number(snapshot.credits.balance) : Number.NaN;
  return {
    provider: event.provider,
    plan: snapshot.planType ?? previous?.plan ?? null,
    windows,
    credits:
      snapshot.credits === null || snapshot.credits === undefined
        ? (previous?.credits ?? null)
        : Number.isFinite(balance)
          ? { remaining: balance, currency: null }
          : null,
    warning: snapshot.rateLimitReachedType
      ? {
          kind: "rate-limited",
          message: `Codex reported the ${snapshot.rateLimitReachedType} limit as reached.`,
        }
      : null,
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
    const previous = observed.get(instanceId);
    if (event.provider === "claudeAgent") {
      return Effect.map(
        Effect.option(decodeClaudeRateLimit(event.payload.rateLimits)),
        (decoded) => {
          if (Option.isSome(decoded)) {
            observed.set(instanceId, applyClaudeRateLimit(previous, event, decoded.value));
          }
        },
      );
    }
    if (event.provider === "codex") {
      return Effect.map(
        Effect.option(decodeCodexRateLimits(event.payload.rateLimits)),
        (decoded) => {
          if (Option.isSome(decoded)) {
            observed.set(instanceId, applyCodexRateLimits(previous, event, decoded.value));
          }
        },
      );
    }
    return Effect.void;
  };

  const subjects = Effect.sync(() =>
    [...observed.entries()].map(([instanceId, record]) => toSubject(instanceId, record)),
  );

  return ProviderRateLimitObserver.of({ observe, subjects });
});

export const layer = Layer.effect(ProviderRateLimitObserver, make);
