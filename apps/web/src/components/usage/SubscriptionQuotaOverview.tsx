import {
  subscriptionQuotaRemainingPercent,
  type ProviderDriverKind,
  type SubscriptionQuotaCollector,
  type SubscriptionQuotaSubject,
  type SubscriptionQuotaWindow,
} from "@t3tools/contracts";
import { CircleIcon } from "lucide-react";

import type { EnvironmentSubscriptionQuotaState } from "../../state/subscriptionQuota";
import { formatProviderDriverKindLabel } from "../../providerModels";
import {
  AntigravityIcon,
  ClaudeAI,
  CursorIcon,
  GrokIcon,
  OhMyPiIcon,
  OpenAI,
  OpenCodeIcon,
} from "../Icons";

export interface SubscriptionQuotaOverviewProps {
  readonly environments: readonly EnvironmentSubscriptionQuotaState[];
}

export function SubscriptionQuotaOverview({ environments }: SubscriptionQuotaOverviewProps) {
  return (
    <section aria-labelledby="subscription-limits-heading" className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 id="subscription-limits-heading" className="text-sm font-medium text-foreground">
          Subscription limits
        </h2>
        <p className="text-xs text-muted-foreground">
          Live allowance reported by each environment.
        </p>
      </div>

      {environments.length === 0 ? (
        <div className="border border-border px-3 py-3 text-sm text-muted-foreground">
          Connect an environment to review subscription limits.
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {environments.map((environment) => (
            <EnvironmentQuota
              key={environment.environmentId}
              environment={environment}
              showEnvironmentLabel={environments.length > 1}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function EnvironmentQuota({
  environment,
  showEnvironmentLabel,
}: {
  readonly environment: EnvironmentSubscriptionQuotaState;
  readonly showEnvironmentLabel: boolean;
}) {
  switch (environment.kind) {
    case "pending":
      return (
        <div className="flex flex-col gap-1 border border-border px-3 py-2">
          {showEnvironmentLabel ? (
            <h3 className="text-sm font-medium text-foreground">{environment.label}</h3>
          ) : null}
          <p className="text-xs text-muted-foreground">Checking subscription limits…</p>
        </div>
      );
    case "failed":
      return (
        <div className="flex flex-col gap-1 border border-border px-3 py-2">
          {showEnvironmentLabel ? (
            <h3 className="text-sm font-medium text-foreground">{environment.label}</h3>
          ) : null}
          <p className="text-xs text-destructive">{environment.message}</p>
        </div>
      );
    case "ready": {
      const collectorUnavailable = environment.report.collectors.some(
        (collector) => collector.status !== "ok",
      );
      return (
        <div className="flex min-w-0 flex-col gap-2">
          {showEnvironmentLabel ? (
            <h3 className="text-xs font-medium text-muted-foreground">{environment.label}</h3>
          ) : null}
          <CollectorNotices collectors={environment.report.collectors} />
          {environment.report.subjects.length === 0 && !collectorUnavailable ? (
            <p className="border border-border px-3 py-2 text-xs text-muted-foreground">
              No subscription limits reported.
            </p>
          ) : environment.report.subjects.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {environment.report.subjects.map((subject) => (
                <QuotaSubject key={subject.subjectId} subject={subject} />
              ))}
            </div>
          ) : null}
        </div>
      );
    }
  }
}

function CollectorNotices({
  collectors,
}: {
  readonly collectors: readonly SubscriptionQuotaCollector[];
}) {
  const unavailable = collectors.filter((collector) => collector.status !== "ok");
  if (unavailable.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      {unavailable.map((collector) => (
        <p key={collector.collectorId}>
          {collector.collectorId === "codexbar"
            ? collector.status === "missing"
              ? "CodexBar is unavailable on this environment."
              : "CodexBar could not refresh subscription limits."
            : `${collector.collectorId} could not refresh subscription limits.`}
        </p>
      ))}
    </div>
  );
}

function QuotaSubject({ subject }: { readonly subject: SubscriptionQuotaSubject }) {
  const status = subjectStatusLabel(subject.status);
  const providerLabel = formatProviderDriverKindLabel(subject.provider);
  const detail = [subject.plan, subject.accountLabel].filter(
    (value): value is string => value !== null,
  );

  return (
    <article className="flex min-w-0 flex-col gap-2.5 border border-border p-3">
      <div className="flex min-w-0 items-center gap-2">
        <SubscriptionProviderMark provider={subject.provider} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-foreground">{providerLabel}</span>
          {detail.length > 0 ? (
            <span className="truncate text-xs text-muted-foreground">{detail.join(" · ")}</span>
          ) : null}
        </div>
        {status === null ? null : (
          <span className="shrink-0 text-xs font-medium text-muted-foreground">{status}</span>
        )}
      </div>

      {subject.windows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No allowance windows reported.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {subject.windows.map((window) => (
            <QuotaWindow key={window.id} window={window} />
          ))}
        </div>
      )}

      {subject.warning === null ? null : (
        <p className="text-xs text-muted-foreground">{subject.warning.message}</p>
      )}
      {subject.binding.status === "unbound" ? (
        <p className="text-xs text-muted-foreground">
          Not linked to a configured provider instance.
        </p>
      ) : null}
      {subject.credits === null ? null : (
        <p className="text-xs text-muted-foreground tabular-nums">
          {subject.credits.remaining} {subject.credits.currency ?? "credits"} remaining
        </p>
      )}
    </article>
  );
}

function QuotaWindow({ window }: { readonly window: SubscriptionQuotaWindow }) {
  const remaining = subscriptionQuotaRemainingPercent(window.usedPercent);
  const remainingLabel = remaining === null ? null : formatRemainingPercent(remaining);
  const reset =
    window.resetsAt === null ? "Reset unavailable" : `Resets ${formatReset(window.resetsAt)}`;

  return (
    <div className="flex min-w-0 flex-col gap-1.5 bg-muted/35 px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-xs text-muted-foreground">{window.label}</span>
        <span className="shrink-0 text-sm font-medium text-foreground tabular-nums">
          {remainingLabel === null ? "Usage unavailable" : `${remainingLabel}% left`}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={`${window.label} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining ?? undefined}
        aria-valuetext={remainingLabel === null ? "Usage unavailable" : `${remainingLabel}% left`}
      >
        {remaining === null ? null : (
          <div className="h-full rounded-full bg-foreground" style={{ width: `${remaining}%` }} />
        )}
      </div>
      <span className="text-xs text-muted-foreground">{reset}</span>
      {window.synthetic ? (
        <span className="text-xs text-muted-foreground">Estimated window</span>
      ) : null}
    </div>
  );
}

function SubscriptionProviderMark({ provider }: { readonly provider: ProviderDriverKind }) {
  const className = "size-4 shrink-0 text-foreground";
  switch (provider) {
    case "codex":
      return <OpenAI className={className} aria-hidden />;
    case "claudeAgent":
      return <ClaudeAI className={className} aria-hidden />;
    case "cursor":
      return <CursorIcon className={className} aria-hidden />;
    case "grok":
      return <GrokIcon className={className} aria-hidden />;
    case "opencode":
      return <OpenCodeIcon className={className} aria-hidden />;
    case "ohMyPi":
      return <OhMyPiIcon className={className} aria-hidden />;
    case "antigravity":
    case "antigravityCli":
      return <AntigravityIcon className={className} aria-hidden />;
    default:
      return <CircleIcon className={className} aria-hidden />;
  }
}

function subjectStatusLabel(status: SubscriptionQuotaSubject["status"]): string | null {
  switch (status) {
    case "fresh":
      return null;
    case "stale":
      return "Stale";
    case "unavailable":
      return "Unavailable";
    case "failed":
      return "Collection failed";
  }
}

function formatReset(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatRemainingPercent(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}
