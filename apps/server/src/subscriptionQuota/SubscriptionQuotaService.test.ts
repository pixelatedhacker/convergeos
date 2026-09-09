import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type SubscriptionQuotaSubject,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as CodexBarCollector from "./CodexBarCollector.ts";
import * as ProviderRateLimitObserver from "./ProviderRateLimitObserver.ts";
import * as SubscriptionQuotaService from "./SubscriptionQuotaService.ts";

const environmentId = EnvironmentId.make("environment-quota-test");
const codex = ProviderInstanceId.make("codex-personal");

const subject: SubscriptionQuotaSubject = {
  subjectId: "codexbar:codex:0",
  provider: "codex" as SubscriptionQuotaSubject["provider"],
  binding: { status: "unbound", providerInstanceIds: [] },
  source: { collectorId: "codexbar", transport: "cli", reportedSource: "oauth" },
  status: "fresh",
  plan: "Plus",
  accountLabel: "j***@example.com",
  observedAt: "2026-09-03T21:00:00.000Z",
  staleAt: "2099-09-03T21:03:00.000Z",
  windows: [
    {
      id: "session",
      label: "5-hour",
      usedPercent: 25,
      resetsAt: "2026-09-04T02:00:00.000Z",
      synthetic: false,
    },
  ],
  credits: null,
  warning: null,
};

const success = {
  _tag: "Success",
  snapshot: {
    observedAt: "2026-09-03T21:00:00.000Z",
    staleAfterSeconds: 180,
    subjects: [subject],
  },
  collector: {
    collectorId: "codexbar",
    status: "ok",
    attemptedAt: "2026-09-03T21:00:00.000Z",
    message: null,
  },
} as const;

it.effect("single-flights concurrent reads and safely binds a sole driver instance", () =>
  Effect.gen(function* () {
    let calls = 0;
    const collector = CodexBarCollector.CodexBarCollector.of({
      collect: Effect.sync(() => {
        calls += 1;
        return success;
      }),
    });
    const service = yield* SubscriptionQuotaService.make.pipe(
      Effect.provide(ProviderRateLimitObserver.layer),
      Effect.provideService(CodexBarCollector.CodexBarCollector, collector),
    );
    const context = {
      environmentId,
      instances: [{ instanceId: codex, driverKind: "codex", enabled: true }],
    } as const;

    const reports = yield* Effect.all([service.read(context), service.read(context)], {
      concurrency: "unbounded",
    });

    expect(calls).toBe(1);
    expect(reports[0].subjects[0]?.binding).toEqual({
      status: "driverOnly",
      providerInstanceIds: [codex],
    });
  }),
);

it("leaves same-driver subscriptions unbound rather than guessing an account", () => {
  const bound = SubscriptionQuotaService.bindQuotaSubjects(
    [subject],
    [
      { instanceId: codex, driverKind: "codex", enabled: true },
      {
        instanceId: ProviderInstanceId.make("codex-work"),
        driverKind: "codex",
        enabled: true,
      },
    ],
  );
  expect(bound[0]?.binding).toEqual({ status: "unbound", providerInstanceIds: [] });
});

it("leaves multiple same-provider subjects unbound even with one local instance", () => {
  const bound = SubscriptionQuotaService.bindQuotaSubjects(
    [subject, { ...subject, subjectId: "codexbar:codex:1" }],
    [{ instanceId: codex, driverKind: "codex", enabled: true }],
  );

  expect(bound.map(({ binding }) => binding)).toEqual([
    { status: "unbound", providerInstanceIds: [] },
    { status: "unbound", providerInstanceIds: [] },
  ]);
});

it.effect("removes account labels from scoped MCP reports", () =>
  Effect.gen(function* () {
    const service = yield* SubscriptionQuotaService.make.pipe(
      Effect.provide(ProviderRateLimitObserver.layer),
      Effect.provideService(
        CodexBarCollector.CodexBarCollector,
        CodexBarCollector.CodexBarCollector.of({ collect: Effect.succeed(success) }),
      ),
    );

    const report = yield* service.readScoped({
      environmentId,
      providerInstanceId: codex,
      instances: [{ instanceId: codex, driverKind: "codex", enabled: true }],
    });

    expect(report.subjects).toHaveLength(1);
    expect(report.subjects[0]?.accountLabel).toBeNull();
  }),
);

it.effect("serves stale last-good quota when a later refresh fails", () =>
  Effect.gen(function* () {
    let calls = 0;
    const service = yield* SubscriptionQuotaService.make.pipe(
      Effect.provide(ProviderRateLimitObserver.layer),
      Effect.provideService(
        CodexBarCollector.CodexBarCollector,
        CodexBarCollector.CodexBarCollector.of({
          collect: Effect.sync(() => {
            calls += 1;
            return calls === 1
              ? success
              : {
                  _tag: "Failure" as const,
                  collector: {
                    collectorId: "codexbar",
                    status: "failed" as const,
                    attemptedAt: "2026-09-03T22:00:00.000Z",
                    message: "CodexBar quota collection failed.",
                  },
                };
          }),
        }),
      ),
    );
    const context = {
      environmentId,
      instances: [{ instanceId: codex, driverKind: "codex", enabled: true }],
    } as const;

    yield* service.read(context);
    yield* TestClock.adjust("61 seconds");
    const report = yield* service.read(context);

    expect(calls).toBe(2);
    expect(report.collectors[0]?.status).toBe("failed");
    expect(report.subjects[0]?.status).toBe("stale");
    expect(report.subjects[0]?.warning?.kind).toBe("refresh-failed");
  }),
);

it.effect(
  "prefers provider-reported windows over a CodexBar subject bound to the same instance",
  () =>
    Effect.gen(function* () {
      const observer = yield* ProviderRateLimitObserver.make;
      yield* observer.observe({
        eventId: EventId.make("evt-rate-limits"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codex,
        threadId: ThreadId.make("thread-quota"),
        createdAt: "2026-09-03T21:00:30.000Z",
        type: "account.rate-limits.updated",
        payload: {
          limits: {
            windows: [
              {
                id: "primary",
                kind: "session",
                label: "5-hour",
                usedPercent: 9,
                resetsAt: "2025-09-03T21:40:00.000Z",
                windowDurationMins: 300,
              },
            ],
          },
        },
      });
      const service = yield* SubscriptionQuotaService.make.pipe(
        Effect.provideService(ProviderRateLimitObserver.ProviderRateLimitObserver, observer),
        Effect.provideService(
          CodexBarCollector.CodexBarCollector,
          CodexBarCollector.CodexBarCollector.of({ collect: Effect.succeed(success) }),
        ),
      );
      const instances = [{ instanceId: codex, driverKind: "codex", enabled: true }] as const;

      const report = yield* service.read({ environmentId, instances });
      expect(report.subjects.map((entry) => entry.subjectId)).toEqual([
        "provider-events:codex-personal",
      ]);
      expect(report.subjects[0]?.binding).toEqual({
        status: "exact",
        providerInstanceIds: [codex],
      });
      expect(report.subjects[0]?.windows[0]?.usedPercent).toBe(9);
      expect(report.collectors.map((entry) => [entry.collectorId, entry.status])).toEqual([
        ["codexbar", "ok"],
        ["provider-events", "ok"],
      ]);

      const scoped = yield* service.readScoped({
        environmentId,
        providerInstanceId: codex,
        instances,
      });
      expect(scoped.subjects.map((entry) => entry.subjectId)).toEqual([
        "provider-events:codex-personal",
      ]);
    }),
);
