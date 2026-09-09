import { expect, it } from "@effect/vitest";
import { EventId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProviderRateLimitObserver from "./ProviderRateLimitObserver.ts";

const claude = ProviderInstanceId.make("claude-personal");
const codex = ProviderInstanceId.make("codex-personal");

function rateLimitEvent(input: {
  readonly eventId: string;
  readonly provider: "claudeAgent" | "codex";
  readonly providerInstanceId: ProviderInstanceId;
  readonly createdAt: string;
  readonly windows: ProviderRateLimitObserver.RateLimitRuntimeEvent["payload"]["limits"]["windows"];
}): ProviderRateLimitObserver.RateLimitRuntimeEvent {
  return {
    eventId: EventId.make(input.eventId),
    provider: ProviderDriverKind.make(input.provider),
    providerInstanceId: input.providerInstanceId,
    threadId: ThreadId.make("thread-rate-limits"),
    createdAt: input.createdAt,
    type: "account.rate-limits.updated",
    payload: { limits: { windows: input.windows } },
  };
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
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "5-hour",
            usedPercent: 9,
            resetsAt: "2026-09-09T17:39:00.000Z",
          },
        ],
      }),
    );
    yield* observer.observe(
      rateLimitEvent({
        eventId: "evt-2",
        provider: "claudeAgent",
        providerInstanceId: claude,
        createdAt: "2026-09-06T18:00:01.000Z",
        windows: [
          {
            id: "seven_day",
            kind: "weekly",
            label: "weekly (all models)",
            usedPercent: 15,
            resetsAt: "2026-09-12T20:00:00.000Z",
          },
        ],
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
    expect(subject.warning).toBeNull();
  }),
);

it.effect("records a provider-normalized 100% window", () =>
  Effect.gen(function* () {
    const observer = yield* ProviderRateLimitObserver.make;
    yield* observer.observe(
      rateLimitEvent({
        eventId: "evt-3",
        provider: "claudeAgent",
        providerInstanceId: claude,
        createdAt: "2026-09-06T18:05:00.000Z",
        windows: [
          {
            id: "seven_day_opus",
            kind: "weekly",
            label: "weekly (Opus)",
            usedPercent: 100,
          },
        ],
      }),
    );
    const [subject] = yield* observer.subjects;
    expect(subject?.windows).toEqual([
      {
        id: "seven_day_opus",
        label: "weekly (Opus)",
        usedPercent: 100,
        resetsAt: null,
        synthetic: false,
      },
    ]);
    expect(subject?.warning).toBeNull();
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
        windows: [
          {
            id: "primary",
            kind: "session",
            label: "5-hour",
            usedPercent: 25,
            resetsAt: "2026-09-09T21:00:00.000Z",
            windowDurationMins: 300,
          },
          {
            id: "secondary",
            kind: "weekly",
            label: "weekly",
            usedPercent: 40,
            resetsAt: "2026-09-12T20:00:00.000Z",
            windowDurationMins: 10080,
          },
        ],
      }),
    );
    yield* observer.observe(
      rateLimitEvent({
        eventId: "evt-5",
        provider: "codex",
        providerInstanceId: codex,
        createdAt: "2026-09-06T18:11:00.000Z",
        windows: [{ id: "primary", kind: "session", label: "5-hour", usedPercent: 26 }],
      }),
    );
    const [subject] = yield* observer.subjects;
    expect(subject?.plan).toBeNull();
    expect(subject?.credits).toBeNull();
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

it.effect("ignores events without an instance or normalized windows", () =>
  Effect.gen(function* () {
    const observer = yield* ProviderRateLimitObserver.make;
    const { providerInstanceId: _instanceId, ...withoutInstance } = rateLimitEvent({
      eventId: "evt-6",
      provider: "claudeAgent",
      providerInstanceId: claude,
      createdAt: "2026-09-06T18:12:00.000Z",
      windows: [{ id: "five_hour", kind: "session", label: "5-hour", usedPercent: 10 }],
    });
    yield* observer.observe(withoutInstance);
    yield* observer.observe(
      rateLimitEvent({
        eventId: "evt-7",
        provider: "codex",
        providerInstanceId: codex,
        createdAt: "2026-09-06T18:12:00.000Z",
        windows: [],
      }),
    );
    expect(yield* observer.subjects).toEqual([]);
  }),
);
