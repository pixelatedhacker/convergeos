import type {
  ProviderDriverKind,
  SubscriptionQuotaSubject,
  SubscriptionQuotaWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const ShortText = Schema.String.check(Schema.isMaxLength(500));
const OptionalShortText = Schema.optional(Schema.NullOr(ShortText));
const Percent = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }));

const CodexBarWindow = Schema.Struct({
  kind: ShortText,
  label: ShortText,
  usedPercent: Schema.NullOr(Percent),
  remainingPercent: Schema.optional(Schema.NullOr(Percent)),
  resetAt: Schema.optional(Schema.NullOr(ShortText)),
  idle: Schema.optional(Schema.Boolean),
});

const CodexBarIdentity = Schema.Struct({
  accountEmail: OptionalShortText,
  plan: OptionalShortText,
});

const CodexBarCredits = Schema.Struct({
  remaining: Schema.optional(Schema.Number),
  currency: OptionalShortText,
});

const CodexBarProvider = Schema.Struct({
  id: ShortText,
  name: ShortText,
  enabled: Schema.Boolean,
  source: OptionalShortText,
  status: OptionalShortText,
  identity: Schema.optional(Schema.NullOr(CodexBarIdentity)),
  windows: Schema.Array(CodexBarWindow).check(Schema.isMaxLength(64)),
  credits: Schema.optional(Schema.NullOr(CodexBarCredits)),
  error: OptionalShortText,
  updatedAt: Schema.optional(Schema.NullOr(ShortText)),
});

export const CodexBarDashboardSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  generatedAt: ShortText,
  staleAfterSeconds: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 86_400 })),
  providers: Schema.Array(CodexBarProvider).check(Schema.isMaxLength(256)),
});
export type CodexBarDashboardSnapshot = typeof CodexBarDashboardSnapshot.Type;

export const decodeCodexBarDashboardSnapshot =
  Schema.decodeUnknownEffect(CodexBarDashboardSnapshot);
export const decodeCodexBarDashboardString = Schema.decodeEffect(
  Schema.fromJsonString(CodexBarDashboardSnapshot),
);

const DRIVER_BY_CODEXBAR_ID: Readonly<Record<string, string>> = {
  claude: "claudeAgent",
  codex: "codex",
  cursor: "cursor",
  grok: "grok",
  opencode: "opencode",
  antigravity: "antigravity",
};

function providerDriver(id: string): ProviderDriverKind {
  const mapped = DRIVER_BY_CODEXBAR_ID[id] ?? id;
  const slug = mapped
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/^[^a-zA-Z]+/, "")
    .slice(0, 64);
  return (slug.length > 0 ? slug : "external") as ProviderDriverKind;
}

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  return Option.match(DateTime.make(value), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });
}

function staleAt(generatedAt: string, staleAfterSeconds: number): string | null {
  return Option.match(DateTime.make(generatedAt), {
    onNone: () => null,
    onSome: (value) => DateTime.formatIso(DateTime.add(value, { seconds: staleAfterSeconds })),
  });
}

function normalizeWindow(
  window: CodexBarDashboardSnapshot["providers"][number]["windows"][number],
  index: number,
): SubscriptionQuotaWindow {
  return {
    id: window.kind.trim() || `window-${index + 1}`,
    label: window.label.trim() || window.kind.trim() || `Window ${index + 1}`,
    usedPercent: window.usedPercent,
    resetsAt: isoOrNull(window.resetAt),
    synthetic: false,
  };
}

export interface NormalizedCodexBarSnapshot {
  readonly observedAt: string;
  readonly staleAfterSeconds: number;
  readonly subjects: ReadonlyArray<SubscriptionQuotaSubject>;
}

export function normalizeCodexBarDashboardSnapshot(
  snapshot: CodexBarDashboardSnapshot,
): NormalizedCodexBarSnapshot {
  const observedAt = isoOrNull(snapshot.generatedAt) ?? DateTime.formatIso(DateTime.makeUnsafe(0));
  const expiresAt = staleAt(observedAt, snapshot.staleAfterSeconds);
  return {
    observedAt,
    staleAfterSeconds: snapshot.staleAfterSeconds,
    subjects: snapshot.providers.map((provider, providerIndex) => {
      const windows = provider.windows.map(normalizeWindow);
      const failed = provider.error !== null && provider.error !== undefined;
      return {
        subjectId: `codexbar:${provider.id}:${providerIndex}`,
        provider: providerDriver(provider.id),
        binding: { status: "unbound", providerInstanceIds: [] },
        source: {
          collectorId: "codexbar",
          transport: "cli",
          reportedSource: provider.source?.trim() || null,
        },
        status: !provider.enabled ? "unavailable" : failed ? "failed" : "fresh",
        plan: provider.identity?.plan?.trim() || null,
        accountLabel: provider.identity?.accountEmail?.trim() || null,
        observedAt: isoOrNull(provider.updatedAt) ?? observedAt,
        staleAt: expiresAt,
        windows,
        credits:
          provider.credits?.remaining === undefined
            ? null
            : {
                remaining: provider.credits.remaining,
                currency: provider.credits.currency?.trim() || null,
              },
        warning: failed
          ? {
              kind: "provider-collection-failed",
              message: "CodexBar could not collect quota for this provider.",
            }
          : null,
      } satisfies SubscriptionQuotaSubject;
    }),
  };
}
