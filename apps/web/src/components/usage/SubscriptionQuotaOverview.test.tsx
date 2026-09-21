import {
  EnvironmentId,
  ProviderDriverKind,
  type SubscriptionQuotaCollector,
  type SubscriptionQuotaReport,
  type SubscriptionQuotaSubject,
  type SubscriptionQuotaWindow,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentSubscriptionQuotaState } from "../../state/subscriptionQuota";
import { SubscriptionQuotaOverview } from "./SubscriptionQuotaOverview";

const now = "2026-09-05T18:00:00.000Z";

const window = (input: {
  readonly id: string;
  readonly label: string;
  readonly usedPercent: number | null;
  readonly synthetic?: boolean;
}): SubscriptionQuotaWindow => ({
  id: input.id,
  label: input.label,
  usedPercent: input.usedPercent,
  resetsAt: "2026-09-05T22:00:00.000Z",
  synthetic: input.synthetic ?? false,
});

const subject = (input: {
  readonly provider?: ProviderDriverKind;
  readonly status?: SubscriptionQuotaSubject["status"];
  readonly windows: readonly SubscriptionQuotaWindow[];
  readonly unbound?: boolean;
  readonly credits?: SubscriptionQuotaSubject["credits"];
}): SubscriptionQuotaSubject => ({
  subjectId: `subject-${input.provider ?? "codex"}-${input.status ?? "fresh"}`,
  provider: input.provider ?? ProviderDriverKind.make("codex"),
  binding: input.unbound
    ? { status: "unbound", providerInstanceIds: [] }
    : { status: "driverOnly", providerInstanceIds: [] },
  source: { collectorId: "codexbar", transport: "cli", reportedSource: "oauth" },
  status: input.status ?? "fresh",
  plan: "Plus",
  accountLabel: null,
  observedAt: now,
  staleAt: "2026-09-05T18:03:00.000Z",
  windows: [...input.windows],
  credits: input.credits ?? null,
  warning: null,
});

const okCollector: SubscriptionQuotaCollector = {
  collectorId: "codexbar",
  status: "ok",
  attemptedAt: now,
  message: null,
};

const ready = (input: {
  readonly id: string;
  readonly label: string;
  readonly subjects: readonly SubscriptionQuotaSubject[];
  readonly collectors?: readonly SubscriptionQuotaCollector[];
}): EnvironmentSubscriptionQuotaState => {
  const environmentId = EnvironmentId.make(input.id);
  const report: SubscriptionQuotaReport = {
    contractVersion: 1,
    environmentId,
    readAt: now,
    subjects: [...input.subjects],
    collectors: [...(input.collectors ?? [okCollector])],
  };
  return { kind: "ready", environmentId, label: input.label, report };
};

describe("SubscriptionQuotaOverview", () => {
  it("shows every allowance window as remaining percentage with its reset", () => {
    const markup = renderToStaticMarkup(
      <SubscriptionQuotaOverview
        environments={[
          ready({
            id: "environment-local",
            label: "Local Mac",
            subjects: [
              subject({
                windows: [
                  window({ id: "session", label: "5-hour", usedPercent: 25 }),
                  window({ id: "weekly", label: "Weekly", usedPercent: 80 }),
                ],
              }),
            ],
          }),
        ]}
      />,
    );

    expect(markup).toContain("75% left");
    expect(markup).toContain("20% left");
    expect(markup).toContain("5-hour");
    expect(markup).toContain("Weekly");
    expect(markup).toContain("Resets");
    expect(markup).not.toContain("Local Mac");
  });

  it("labels a window whose utilization is unavailable", () => {
    const markup = renderToStaticMarkup(
      <SubscriptionQuotaOverview
        environments={[
          ready({
            id: "environment-null",
            label: "Local",
            subjects: [
              subject({ windows: [window({ id: "session", label: "5-hour", usedPercent: null })] }),
            ],
          }),
        ]}
      />,
    );

    expect(markup).toContain("Usage unavailable");
  });

  it("rounds fractional remaining allowance without changing the meter value", () => {
    const markup = renderToStaticMarkup(
      <SubscriptionQuotaOverview
        environments={[
          ready({
            id: "environment-fractional",
            label: "Local",
            subjects: [
              subject({
                windows: [
                  window({
                    id: "session",
                    label: "5-hour",
                    usedPercent: 22.7537142857,
                  }),
                ],
              }),
            ],
          }),
        ]}
      />,
    );

    expect(markup).toContain("77.2% left");
    expect(markup).not.toContain("77.2462857143% left");
  });

  it("keeps stale and failed subject values visible with explicit labels", () => {
    const markup = renderToStaticMarkup(
      <SubscriptionQuotaOverview
        environments={[
          ready({
            id: "environment-stale",
            label: "Local",
            subjects: [
              subject({
                status: "stale",
                windows: [window({ id: "stale", label: "Stale window", usedPercent: 10 })],
              }),
              subject({
                provider: ProviderDriverKind.make("claudeAgent"),
                status: "failed",
                windows: [window({ id: "failed", label: "Failed window", usedPercent: 60 })],
              }),
            ],
          }),
        ]}
      />,
    );

    expect(markup).toContain("Stale");
    expect(markup).toContain("90% left");
    expect(markup).toContain("Collection failed");
    expect(markup).toContain("40% left");
  });

  it("reports a missing CodexBar collector without presenting zero usage", () => {
    const markup = renderToStaticMarkup(
      <SubscriptionQuotaOverview
        environments={[
          ready({
            id: "environment-missing",
            label: "Local",
            subjects: [],
            collectors: [
              {
                collectorId: "codexbar",
                status: "missing",
                attemptedAt: now,
                message: "CodexBar is not installed.",
              },
            ],
          }),
        ]}
      />,
    );

    expect(markup).toContain("CodexBar is unavailable on this environment.");
    expect(markup).not.toContain("No subscription limits reported.");
    expect(markup).not.toContain("0% left");
  });

  it.each(["opencode", "ohMyPi", "antigravity", "antigravityCli"])(
    "uses the built-in mark for %s",
    (provider) => {
      const markup = renderToStaticMarkup(
        <SubscriptionQuotaOverview
          environments={[
            ready({
              id: `environment-${provider}`,
              label: "Local",
              subjects: [
                subject({
                  provider: ProviderDriverKind.make(provider),
                  windows: [window({ id: "session", label: "Session", usedPercent: 25 })],
                }),
              ],
            }),
          ]}
        />,
      );

      expect(markup).not.toContain("lucide-circle");
    },
  );

  it("formats an unknown provider safely and shows supplemental quota metadata", () => {
    const markup = renderToStaticMarkup(
      <SubscriptionQuotaOverview
        environments={[
          ready({
            id: "environment-unknown",
            label: "Local",
            subjects: [
              subject({
                provider: ProviderDriverKind.make("future_provider"),
                windows: [
                  window({ id: "estimated", label: "Monthly", usedPercent: 35, synthetic: true }),
                ],
                unbound: true,
                credits: { remaining: 12.5, currency: "USD" },
              }),
            ],
          }),
        ]}
      />,
    );

    expect(markup).toContain("Future Provider");
    expect(markup).toContain("Estimated window");
    expect(markup).toContain("Not linked to a configured provider instance.");
    expect(markup).toContain("12.5 USD remaining");
  });

  it("keeps reports grouped under distinct environment labels", () => {
    const markup = renderToStaticMarkup(
      <SubscriptionQuotaOverview
        environments={[
          ready({
            id: "environment-local",
            label: "Local Mac",
            subjects: [
              subject({ windows: [window({ id: "local", label: "Daily", usedPercent: 20 })] }),
            ],
          }),
          ready({
            id: "environment-remote",
            label: "Build Host",
            subjects: [
              subject({ windows: [window({ id: "remote", label: "Weekly", usedPercent: 70 })] }),
            ],
          }),
        ]}
      />,
    );

    expect(markup).toContain("Local Mac");
    expect(markup).toContain("Build Host");
    expect(markup).toContain("80% left");
    expect(markup).toContain("30% left");
  });
});
