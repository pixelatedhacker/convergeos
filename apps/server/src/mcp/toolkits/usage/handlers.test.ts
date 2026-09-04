import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type SubscriptionQuotaScopedReport,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { vi } from "vite-plus/test";

import type { ProviderInstance } from "../../../provider/ProviderDriver.ts";
import * as SubscriptionQuotaService from "../../../subscriptionQuota/SubscriptionQuotaService.ts";
import * as ProviderInstanceRegistry from "../../../provider/Services/ProviderInstanceRegistry.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const environmentId = EnvironmentId.make("environment-usage-mcp");
const providerInstanceId = ProviderInstanceId.make("codex-personal");
const readScoped =
  vi.fn<SubscriptionQuotaService.SubscriptionQuotaService["Service"]["readScoped"]>();

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

const TestLayer = McpHttpServer.UsageToolkitRegistrationLive.pipe(
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
);

const client = McpSchema.McpServerClient.of({
  clientId: 1,
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
