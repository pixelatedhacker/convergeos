import {
  SUBSCRIPTION_QUOTA_CONTRACT_VERSION,
  type EnvironmentId,
  type ProviderInstanceId,
  type SubscriptionQuotaCollector,
  type SubscriptionQuotaReport,
  type SubscriptionQuotaScopedReport,
  type SubscriptionQuotaSubject,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import * as CodexBarCollector from "./CodexBarCollector.ts";

const CACHE_TTL_MS = 60_000;

interface CachedQuota {
  readonly collectedAtMs: number;
  readonly subjects: ReadonlyArray<SubscriptionQuotaSubject>;
  readonly collector: SubscriptionQuotaCollector;
}

export interface SubscriptionQuotaReadContext {
  readonly environmentId: EnvironmentId;
  readonly instances: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly driverKind: string;
    readonly enabled: boolean;
  }>;
}

export class SubscriptionQuotaService extends Context.Service<
  SubscriptionQuotaService,
  {
    readonly read: (
      context: SubscriptionQuotaReadContext,
    ) => Effect.Effect<SubscriptionQuotaReport>;
    readonly readScoped: (context: {
      readonly environmentId: EnvironmentId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly instances: SubscriptionQuotaReadContext["instances"];
    }) => Effect.Effect<SubscriptionQuotaScopedReport>;
  }
>()("t3/subscriptionQuota/SubscriptionQuotaService") {}

function applyFreshness(
  subject: SubscriptionQuotaSubject,
  nowMs: number,
): SubscriptionQuotaSubject {
  if (subject.status !== "fresh" && subject.status !== "stale") return subject;
  const staleAtMs =
    subject.staleAt === null
      ? Number.POSITIVE_INFINITY
      : Option.match(DateTime.make(subject.staleAt), {
          onNone: () => Number.POSITIVE_INFINITY,
          onSome: DateTime.toEpochMillis,
        });
  return {
    ...subject,
    status: Number.isFinite(staleAtMs) && staleAtMs <= nowMs ? "stale" : "fresh",
  };
}

export const bindQuotaSubjects = (
  subjects: ReadonlyArray<SubscriptionQuotaSubject>,
  instances: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly driverKind: string;
    readonly enabled: boolean;
  }>,
): ReadonlyArray<SubscriptionQuotaSubject> => {
  const subjectCounts = new Map<string, number>();
  for (const subject of subjects) {
    subjectCounts.set(subject.provider, (subjectCounts.get(subject.provider) ?? 0) + 1);
  }

  return subjects.map((subject) => {
    const matches = instances.filter(
      (instance) => instance.enabled && instance.driverKind === subject.provider,
    );
    if (matches.length !== 1 || subjectCounts.get(subject.provider) !== 1) {
      return { ...subject, binding: { status: "unbound", providerInstanceIds: [] } };
    }
    return {
      ...subject,
      binding: {
        status: "driverOnly",
        providerInstanceIds: [matches[0]!.instanceId],
      },
    };
  });
};

export const make = Effect.gen(function* () {
  const collector = yield* CodexBarCollector.CodexBarCollector;
  const refreshLock = yield* Semaphore.make(1);
  let lastGood: CachedQuota | undefined;

  const read = Effect.fn("SubscriptionQuotaService.read")(function* (
    context: SubscriptionQuotaReadContext,
  ) {
    return yield* refreshLock.withPermit(
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const readAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs));

        if (lastGood && nowMs - lastGood.collectedAtMs < CACHE_TTL_MS) {
          return {
            contractVersion: SUBSCRIPTION_QUOTA_CONTRACT_VERSION,
            environmentId: context.environmentId,
            readAt,
            subjects: bindQuotaSubjects(lastGood.subjects, context.instances).map((subject) =>
              applyFreshness(subject, nowMs),
            ),
            collectors: [lastGood.collector],
          } satisfies SubscriptionQuotaReport;
        }

        const result = yield* collector.collect;
        if (result._tag === "Success") {
          lastGood = {
            collectedAtMs: nowMs,
            subjects: result.snapshot.subjects,
            collector: result.collector,
          };
          return {
            contractVersion: SUBSCRIPTION_QUOTA_CONTRACT_VERSION,
            environmentId: context.environmentId,
            readAt,
            subjects: bindQuotaSubjects(result.snapshot.subjects, context.instances).map(
              (subject) => applyFreshness(subject, nowMs),
            ),
            collectors: [result.collector],
          } satisfies SubscriptionQuotaReport;
        }

        const fallbackSubjects = (lastGood?.subjects ?? []).map(
          (subject): SubscriptionQuotaSubject => ({
            ...subject,
            status: subject.status === "fresh" ? "stale" : subject.status,
            warning: {
              kind: "refresh-failed",
              message: "The latest CodexBar refresh failed. Showing the last available quota.",
            },
          }),
        );
        return {
          contractVersion: SUBSCRIPTION_QUOTA_CONTRACT_VERSION,
          environmentId: context.environmentId,
          readAt,
          subjects: bindQuotaSubjects(fallbackSubjects, context.instances),
          collectors: [result.collector],
        } satisfies SubscriptionQuotaReport;
      }),
    );
  });

  const readScoped = Effect.fn("SubscriptionQuotaService.readScoped")(function* (context: {
    readonly environmentId: EnvironmentId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly instances: SubscriptionQuotaReadContext["instances"];
  }) {
    const report = yield* read({
      environmentId: context.environmentId,
      instances: context.instances,
    });
    return {
      contractVersion: report.contractVersion,
      environmentId: report.environmentId,
      providerInstanceId: context.providerInstanceId,
      readAt: report.readAt,
      collectors: report.collectors,
      subjects: report.subjects
        .filter((subject) =>
          subject.binding.providerInstanceIds.includes(context.providerInstanceId),
        )
        .map((subject) => ({ ...subject, accountLabel: null })),
    } satisfies SubscriptionQuotaScopedReport;
  });

  return SubscriptionQuotaService.of({ read, readScoped });
});

export const layer = Layer.effect(SubscriptionQuotaService, make);

export const layerTest = Layer.succeed(
  SubscriptionQuotaService,
  SubscriptionQuotaService.of({
    read: (context) =>
      Effect.succeed({
        contractVersion: SUBSCRIPTION_QUOTA_CONTRACT_VERSION,
        environmentId: context.environmentId,
        readAt: "1970-01-01T00:00:00.000Z",
        subjects: [],
        collectors: [],
      }),
    readScoped: (context) =>
      Effect.succeed({
        contractVersion: SUBSCRIPTION_QUOTA_CONTRACT_VERSION,
        environmentId: context.environmentId,
        providerInstanceId: context.providerInstanceId,
        readAt: "1970-01-01T00:00:00.000Z",
        subjects: [],
        collectors: [],
      }),
  }),
);
