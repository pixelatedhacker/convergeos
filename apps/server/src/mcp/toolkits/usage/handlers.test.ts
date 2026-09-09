import * as DelegationUsageService from "../../../usage/DelegationUsageService.ts";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  UsageDay,
  UsageMcpSummary,
  UsageReadError,
  type UsageSummary,
  type SubscriptionQuotaScopedReport,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { vi } from "vite-plus/test";

import type { ProviderInstance } from "../../../provider/ProviderDriver.ts";
import * as SubscriptionQuotaService from "../../../subscriptionQuota/SubscriptionQuotaService.ts";
import * as ProviderInstanceRegistry from "../../../provider/Services/ProviderInstanceRegistry.ts";
import * as UsageService from "../../../usage/UsageService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const environmentId = EnvironmentId.make("environment-usage-mcp");
const providerInstanceId = ProviderInstanceId.make("codex-personal");
const readScoped =
  vi.fn<SubscriptionQuotaService.SubscriptionQuotaService["Service"]["readScoped"]>();
const readSummary = vi.fn<UsageService.UsageService["Service"]["readSummary"]>();

const providerInstance = {
  instanceId: providerInstanceId,
  driverKind: ProviderDriverKind.make("codex"),
  enabled: true,
} as ProviderInstance;

let registryInstances: ReadonlyArray<ProviderInstance> = [providerInstance];

const report: SubscriptionQuotaScopedReport = {
  contractVersion: 1,
  environmentId,
  providerInstanceId,
  readAt: "2026-09-03T22:00:00.000Z",
  collectors: [{ collectorId: "codexbar", status: "ok", attemptedAt: null, message: null }],
  subjects: [
    {
      subjectId: "codexbar:codex:0",
      provider: ProviderDriverKind.make("codex"),
      binding: { status: "driverOnly", providerInstanceIds: [providerInstanceId] },
      source: { collectorId: "codexbar", transport: "cli", reportedSource: "oauth" },
      status: "fresh",
      plan: "Plus",
      accountLabel: "j***@example.com",
      observedAt: "2026-09-03T21:59:00.000Z",
      staleAt: "2026-09-03T22:02:00.000Z",
      windows: [],
      credits: null,
      warning: null,
    },
  ],
};

const usageSummary: UsageSummary = {
  contractVersion: 5,
  readAt: "2026-09-03T22:00:00.000Z",
  timeZone: "America/Chicago",
  sinceDay: UsageDay.make("2026-09-01"),
  untilDay: UsageDay.make("2026-09-03"),
  buckets: [],
  sources: [
    {
      fingerprint: {
        hostId: "private-host",
        provider: "codex",
        resolvedHomePath: "/Users/private/.codex",
        volumeId: "1:2",
      },
      status: "ok",
      scannedFiles: 2,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 1,
      message: null,
    },
  ],
  pricing: { status: "cached", source: "test-rates", fetchedAt: null, knownModels: 0 },
  scanDurationMs: 2,
};

const readDelegationUsage =
  vi.fn<DelegationUsageService.DelegationUsageService["Service"]["read"]>();
const TestLayer = McpHttpServer.UsageToolkitRegistrationLive.pipe(
  Layer.provide(
    Layer.succeed(DelegationUsageService.DelegationUsageService, {
      read: (caller, input) => readDelegationUsage(caller, input),
    }),
  ),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(
    Layer.succeed(
      SubscriptionQuotaService.SubscriptionQuotaService,
      SubscriptionQuotaService.SubscriptionQuotaService.of({
        read: () => Effect.die("unused"),
        readScoped: (input) => readScoped(input),
      }),
    ),
  ),
  Layer.provide(
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      listInstances: Effect.sync(() => registryInstances),
      streamChanges: Stream.empty,
    }),
  ),
  Layer.provide(
    Layer.succeed(
      UsageService.UsageService,
      UsageService.UsageService.of({
        readSummary: (input) => readSummary(input),
        refreshRates: Effect.succeed(usageSummary.pricing),
      }),
    ),
  ),
);

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "usage-mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "usage-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

it.effect("scopes usage_snapshot to the credential and strips account labels", () =>
  Effect.gen(function* () {
    registryInstances = [providerInstance];
    readScoped.mockReturnValueOnce(Effect.succeed(report));
    const server = yield* McpServer.McpServer;
    const result = yield* server.callTool({ name: "usage_snapshot", arguments: {} }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId,
        threadId: ThreadId.make("thread-usage-mcp"),
        providerSessionId: "session-usage-mcp",
        providerInstanceId,
        capabilities: new Set(["usage.read"] as const),
        issuedAt: 1,
      }),
      Effect.provideService(McpSchema.McpServerClient, client),
    );

    expect(readScoped).toHaveBeenCalledWith({
      environmentId,
      providerInstanceId,
      instances: [expect.objectContaining({ instanceId: providerInstanceId })],
    });
    expect(result.isError).toBe(false);
    expect(
      (result.structuredContent as SubscriptionQuotaScopedReport).subjects[0]?.accountLabel,
    ).toBeNull();
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("resolves the live provider registry for every invocation", () =>
  Effect.gen(function* () {
    readScoped.mockClear();
    registryInstances = [providerInstance];
    readScoped.mockReturnValue(Effect.succeed(report));
    const server = yield* McpServer.McpServer;
    const call = server.callTool({ name: "usage_snapshot", arguments: {} }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId,
        threadId: ThreadId.make("thread-usage-mcp"),
        providerSessionId: "session-usage-mcp",
        providerInstanceId,
        capabilities: new Set(["usage.read"] as const),
        issuedAt: 1,
      }),
      Effect.provideService(McpSchema.McpServerClient, client),
    );

    yield* call;
    registryInstances = [];
    yield* call;

    expect(readScoped).toHaveBeenNthCalledWith(1, {
      environmentId,
      providerInstanceId,
      instances: [{ instanceId: providerInstanceId, driverKind: "codex", enabled: true }],
    });
    expect(readScoped).toHaveBeenNthCalledWith(2, {
      environmentId,
      providerInstanceId,
      instances: [],
    });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("returns transcript-backed usage history for the requested window", () =>
  Effect.gen(function* () {
    readSummary.mockReturnValueOnce(Effect.succeed(usageSummary));
    const server = yield* McpServer.McpServer;
    const input = {
      sinceDay: UsageDay.make("2026-09-01"),
      untilDay: UsageDay.make("2026-09-03"),
      timeZone: "America/Chicago",
      resolution: "day" as const,
    };
    const result = yield* server.callTool({ name: "usage_summary", arguments: input }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId,
        threadId: ThreadId.make("thread-usage-history-mcp"),
        providerSessionId: "session-usage-history-mcp",
        providerInstanceId,
        capabilities: new Set(["usage.read"] as const),
        issuedAt: 1,
      }),
      Effect.provideService(McpSchema.McpServerClient, client),
    );

    expect(readSummary).toHaveBeenCalledWith(input);
    expect(result.isError).toBe(false);
    const summary = yield* Schema.decodeUnknownEffect(UsageMcpSummary)(result.structuredContent);
    expect(summary).toEqual({
      ...usageSummary,
      sources: usageSummary.sources.map(({ fingerprint: _fingerprint, ...source }) => source),
    });
    expect(summary.sources.every((source) => !("fingerprint" in source))).toBe(true);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("removes host paths from usage_summary failures", () =>
  Effect.gen(function* () {
    readSummary.mockReturnValueOnce(
      Effect.fail(
        new UsageReadError({
          reason: "scanFailed",
          detail: "Server settings could not be read.",
          cause: new Error("Could not read /Users/private/.convergeos/settings.json"),
        }),
      ),
    );
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "usage_summary",
        arguments: {
          sinceDay: "2026-09-01",
          untilDay: "2026-09-03",
          timeZone: "America/Chicago",
          resolution: "day",
        },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          environmentId,
          threadId: ThreadId.make("thread-usage-failure-mcp"),
          providerSessionId: "session-usage-failure-mcp",
          providerInstanceId,
          capabilities: new Set(["usage.read"] as const),
          issuedAt: 1,
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(result.isError).toBe(true);
    const text = result.content
      .filter(
        (item): item is Extract<(typeof result.content)[number], { type: "text" }> =>
          item.type === "text",
      )
      .map((item) => item.text)
      .join("\n");
    expect(text).toContain("Server settings could not be read.");
    expect(text).not.toContain("/Users/private");
    expect(text).not.toContain("settings.json");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("usage_delegations binds reads to the authenticated caller and validates limits", () =>
  Effect.gen(function* () {
    readDelegationUsage.mockReset();
    readDelegationUsage.mockReturnValue(Effect.succeed({ contractVersion: 1, delegations: [] }));
    const server = yield* McpServer.McpServer;
    const scope = {
      environmentId,
      threadId: ThreadId.make("delegation-usage-caller"),
      providerSessionId: "session-usage-mcp",
      providerInstanceId,
      capabilities: new Set(["usage.read"] as const),
      issuedAt: 1,
    };
    const result = yield* server
      .callTool({ name: "usage_delegations", arguments: { delegationIds: ["delegation-one"] } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(false);
    expect(readDelegationUsage).toHaveBeenCalledExactlyOnceWith(scope.threadId, {
      delegationIds: ["delegation-one"],
    });

    const denied = yield* server
      .callTool({ name: "usage_delegations", arguments: { delegationIds: ["delegation-one"] } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...scope,
          capabilities: new Set<McpInvocationContext.McpCapability>(),
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(denied.isError).toBe(true);
    expect(readDelegationUsage).toHaveBeenCalledTimes(1);

    const oversized = yield* server
      .callTool({
        name: "usage_delegations",
        arguments: {
          delegationIds: Array.from({ length: 9 }, (_, index) => `delegation-${index}`),
        },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.flip,
      );
    expect(oversized._tag).toBe("InvalidParams");
    expect(readDelegationUsage).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(TestLayer)),
);
