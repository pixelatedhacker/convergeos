import { expect, it } from "@effect/vitest";
import {
  EventId,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProviderRateLimitObserver from "./ProviderRateLimitObserver.ts";

const claude = ProviderInstanceId.make("claude-personal");
const codex = ProviderInstanceId.make("codex-personal");

function rateLimitEvent(input: {
  readonly eventId: string;
  readonly provider: "claudeAgent" | "codex";
  readonly providerInstanceId: ProviderInstanceId;
  readonly createdAt: string;
  readonly rateLimits: unknown;
}): ProviderRuntimeEvent {
  return {
    eventId: EventId.make(input.eventId),
    provider: input.provider,
    providerInstanceId: input.providerInstanceId,
    threadId: ThreadId.make("thread-rate-limits"),
    createdAt: input.createdAt,
    type: "account.rate-limits.updated",
    payload: { rateLimits: input.rateLimits },
  } as ProviderRuntimeEvent;
}

it.effect("merges Claude windows across events and binds them to the emitting instance", () =>
  Effect.gen(function* () {
    const observer = yield* ProviderRateLimitObserver.make;
    yield* observer.observe(
      rateLimitEvent({
        eventId: "evt-1",
        provider: "claudeAgent",
        providerInstanceId: claude,
        createdAt: "2026-09-06T18:00:00.000Z",
        rateLimits: {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            rateLimitType: "five_hour",
            utilization: 0.09,
            resetsAt: 1788975540,
          },
        },
      }),
    );
    yield* observer.observe(
      rateLimitEvent({
        eventId: "evt-2",
        provider: "claudeAgent",
        providerInstanceId: claude,
        createdAt: "2026-09-06T18:00:01.000Z",
        rateLimits: {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed_warning",
            rateLimitType: "seven_day",
            utilization: 0.15,
            resetsAt: 1789243200,
          },
        },
      }),
    );

    const subjects = yield* observer.subjects;
    expect(subjects).toHaveLength(1);
    const subject = subjects[0]!;
    expect(subject.provider).toBe("claudeAgent");
    expect(subject.binding).toEqual({ status: "exact", providerInstanceIds: [claude] });
    expect(subject.source.transport).toBe("providerEvent");
    expect(subject.observedAt).toBe("2026-09-06T18:00:01.000Z");
    expect(subject.windows).toEqual([
      {
        id: "five_hour",
        label: "5-hour",
        usedPercent: 9,
        resetsAt: "2026-09-09T17:39:00.000Z",
        synthetic: false,
      },
      {
        id: "seven_day",
        label: "weekly (all models)",
        usedPercent: 15,
        resetsAt: "2026-09-12T20:00:00.000Z",
        synthetic: false,
      },
    ]);
    expect(subject.warning?.kind).toBe("approaching-limit");
  }),
);

it.effect("marks a rejected Claude window as reached even without utilization", () =>
  Effect.gen(function* () {
    const observer = yield* ProviderRateLimitObserver.make;
    yield* observer.observe(
      rateLimitEvent({
        eventId: "evt-3",
        provider: "claudeAgent",
        providerInstanceId: claude,
        createdAt: "2026-09-06T18:05:00.000Z",
        rateLimits: { rate_limit_info: { status: "rejected", rateLimitType: "seven_day_opus" } },
      }),
    );
    const [subject] = yield* observer.subjects;
    expect(subject?.windows).toEqual([
      {
        id: "seven_day_opus",
        label: "weekly (Opus)",
        usedPercent: 100,
        resetsAt: null,
        synthetic: true,
      },
    ]);
    expect(subject?.warning?.kind).toBe("rate-limited");
  }),
);

it.effect("normalizes Codex primary and secondary windows and keeps sparse fields", () =>
  Effect.gen(function* () {
    const observer = yield* ProviderRateLimitObserver.make;
    yield* observer.observe(
      rateLimitEvent({
        eventId: "evt-4",
        provider: "codex",
        providerInstanceId: codex,
        createdAt: "2026-09-06T18:10:00.000Z",
        rateLimits: {
          rateLimits: {
            planType: "plus",
            primary: { usedPercent: 25, resetsAt: 1788987600, windowDurationMins: 300 },
            secondary: { usedPercent: 40, resetsAt: 1789243200, windowDurationMins: 10080 },
            credits: { balance: "12.5", hasCredits: true, unlimited: false },
          },
        },
      }),
    );
    yield* observer.observe(
      rateLimitEvent({
        eventId: "evt-5",
        provider: "codex",
        providerInstanceId: codex,
        createdAt: "2026-09-06T18:11:00.000Z",
        rateLimits: { rateLimits: { primary: { usedPercent: 26 } } },
      }),
    );
    const [subject] = yield* observer.subjects;
    expect(subject?.plan).toBe("plus");
    expect(subject?.credits).toEqual({ remaining: 12.5, currency: null });
    expect(subject?.windows).toEqual([
      {
        id: "primary",
        label: "5-hour",
        usedPercent: 26,
        resetsAt: "2026-09-09T21:00:00.000Z",
        synthetic: false,
      },
      {
        id: "secondary",
        label: "weekly",
        usedPercent: 40,
        resetsAt: "2026-09-12T20:00:00.000Z",
        synthetic: false,
      },
    ]);
  }),
);

it.effect("ignores unrelated events, unknown instances, and malformed payloads", () =>
  Effect.gen(function* () {
    const observer = yield* ProviderRateLimitObserver.make;
    yield* observer.observe({
      ...rateLimitEvent({
        eventId: "evt-6",
        provider: "claudeAgent",
        providerInstanceId: claude,
        createdAt: "2026-09-06T18:12:00.000Z",
        rateLimits: {},
      }),
      providerInstanceId: undefined,
    } as ProviderRuntimeEvent);
    yield* observer.observe(
      rateLimitEvent({
        eventId: "evt-7",
        provider: "codex",
        providerInstanceId: codex,
        createdAt: "2026-09-06T18:12:00.000Z",
        rateLimits: { rateLimits: { primary: { usedPercent: "high" } } },
      }),
    );
    expect(yield* observer.subjects).toEqual([]);
  }),
);
