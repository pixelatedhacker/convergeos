import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { SubscriptionQuotaReport, subscriptionQuotaRemainingPercent } from "./subscriptionQuota.ts";

const decode = Schema.decodeUnknownSync(SubscriptionQuotaReport);

const report = {
  contractVersion: 1,
  environmentId: "environment-1",
  readAt: "2026-09-03T22:00:00.000Z",
  collectors: [{ collectorId: "codexbar", status: "ok", attemptedAt: null, message: null }],
  subjects: [
    {
      subjectId: "codexbar:codex:0",
      provider: "codex",
      binding: { status: "driverOnly", providerInstanceIds: ["codex"] },
      source: { collectorId: "codexbar", transport: "cli", reportedSource: "oauth" },
      status: "fresh",
      plan: "Plus",
      accountLabel: "j…@example.com",
      observedAt: "2026-09-03T21:59:00Z",
      staleAt: "2026-09-03T22:02:00Z",
      windows: [
        {
          id: "five-hour",
          label: "5-hour",
          usedPercent: 42,
          resetsAt: "2026-09-04T01:00:00Z",
          synthetic: false,
        },
      ],
      credits: null,
      warning: null,
    },
  ],
} as const;

describe("SubscriptionQuotaReport", () => {
  it("decodes subject-level quota with explicit provider-instance binding", () => {
    expect(decode(report).subjects[0]?.binding.status).toBe("driverOnly");
  });

  it("rejects percentages outside 0 through 100", () => {
    expect(() =>
      decode({
        ...report,
        subjects: [
          {
            ...report.subjects[0],
            windows: [{ ...report.subjects[0]!.windows[0], usedPercent: 101 }],
          },
        ],
      }),
    ).toThrow();
  });

  it("derives remaining quota without storing a competing value", () => {
    expect(subscriptionQuotaRemainingPercent(42)).toBe(58);
    expect(subscriptionQuotaRemainingPercent(null)).toBeNull();
  });
});
