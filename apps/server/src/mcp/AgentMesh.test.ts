import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AgentMeshError,
  EnvironmentId,
  ProviderDriverKind,
  CommandId,
  DelegationId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ServerProvider,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as DelegationService from "../delegation/DelegationService.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import * as AgentMesh from "./AgentMesh.ts";
import { AgentsToolkitRegistrationLive } from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const callerId = ThreadId.make("thread-caller");
const targetId = ThreadId.make("thread-target");
const otherProjectId = ThreadId.make("thread-other-project");
const projectId = ProjectId.make("project-main");

const project: OrchestrationProjectShell = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/workspace/project",
  repositoryIdentity: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-09-03T20:00:00.000Z",
  updatedAt: "2026-09-03T20:00:00.000Z",
};

const shell = (
  id: ThreadId,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id,
  projectId,
  title: id,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  linkedPullRequest: null,
  latestTurn: null,
  createdAt: "2026-09-03T20:00:00.000Z",
  updatedAt: "2026-09-03T20:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  unsettledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  titleRegeneration: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  backgroundLiveness: null,
  planProgress: null,
  ...overrides,
});

const makeHarness = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
  messages: Readonly<Record<string, ReadonlyArray<OrchestrationMessage>>> = {},
  providers: ReadonlyArray<ServerProvider> = [],
) => {
  const commands: OrchestrationCommand[] = [];
  const acceptedSequences = new Map<string, number>();
  const byId = new Map(threads.map((thread) => [thread.id, thread] as const));
  const delegationSend: DelegationService.DelegationServiceShape["send"] = (scope, input) =>
    Effect.gen(function* () {
      const caller = byId.get(scope.threadId);
      const target = byId.get(input.targetThreadId);
      if (caller === undefined || target === undefined || caller.projectId !== target.projectId) {
        return yield* new AgentMeshError({
          operation: "send",
          reason: "targetUnavailable",
          targetThreadId: input.targetThreadId,
        });
      }
      if (caller.id === target.id) {
        return yield* new AgentMeshError({
          operation: "send",
          reason: "selfTarget",
          targetThreadId: target.id,
        });
      }
      if (
        normalizeProjectPathForComparison(caller.worktreePath ?? project.workspaceRoot) ===
        normalizeProjectPathForComparison(target.worktreePath ?? project.workspaceRoot)
      ) {
        return yield* new AgentMeshError({
          operation: "send",
          reason: "workspaceShared",
          targetThreadId: target.id,
        });
      }
      const commandId = CommandId.make(
        `test-send:${scope.threadId}:${target.id}:${input.requestId}`,
      );
      const messageId = MessageId.make(
        `test-message:${scope.threadId}:${target.id}:${input.requestId}`,
      );
      const knownSequence = acceptedSequences.get(commandId);
      const sequence = knownSequence ?? commands.length + 1;
      if (knownSequence === undefined) {
        commands.push({
          type: "thread.peer-turn.start",
          commandId,
          requestId: input.requestId,
          sourceThreadId: caller.id,
          threadId: target.id,
          messageId,
          message: input.message,
        });
        acceptedSequences.set(commandId, sequence);
      }
      return {
        delegationId: DelegationId.make(`test-delegation:${commandId}`),
        targetThreadId: target.id,
        commandId,
        messageId,
        sequence,
        state: "turnRequested",
      };
    });
  const dependencies = Layer.mergeAll(
    makeProviderRegistryLayer(providers),
    NodeServices.layer,
    Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) => Effect.succeed(Option.fromUndefinedOr(byId.get(threadId))),
      getProjectShellById: (requestedProjectId) =>
        Effect.succeed(requestedProjectId === projectId ? Option.some(project) : Option.none()),
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          projects: [project],
          threads,
          updatedAt: "2026-09-03T21:00:00.000Z",
        }),
      getThreadDetailSnapshot: (threadId) => {
        const thread = byId.get(threadId);
        return Effect.succeed(
          thread === undefined
            ? Option.none()
            : Option.some({
                snapshotSequence: 1,
                thread: {
                  ...thread,
                  deletedAt: null,
                  messages: [...(messages[threadId] ?? [])],
                  proposedPlans: [],
                  activities: [],
                  checkpoints: [],
                },
              }),
        );
      },
    }),
    Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
      dispatch: (command) =>
        Effect.sync(() => {
          if (
            command.type !== "thread.peer-turn.start" &&
            command.type !== "thread.peer-turn.interrupt"
          ) {
            throw new Error(`Unexpected agent mesh command: ${command.type}`);
          }
          const acceptedSequence = acceptedSequences.get(command.commandId);
          if (acceptedSequence !== undefined) {
            return { sequence: acceptedSequence };
          }
          commands.push(command);
          const sequence = commands.length;
          acceptedSequences.set(command.commandId, sequence);
          return { sequence };
        }),
    }),
    Layer.succeed(
      DelegationService.DelegationService,
      DelegationService.DelegationService.of({
        spawn: () => Effect.die("unused"),
        send: delegationSend,
        wait: () => Effect.die("unused"),
      }),
    ),
  );
  return {
    commands,
    setThread: (thread: OrchestrationThreadShell) => byId.set(thread.id, thread),
    make: AgentMesh.make.pipe(Effect.provide(dependencies)),
  };
};

it.effect("lists only same-project agents with bounded status metadata", () =>
  Effect.gen(function* () {
    const harness = makeHarness([
      shell(targetId, {
        updatedAt: "2026-09-03T22:00:00.000Z",
        hasPendingApprovals: true,
        session: {
          threadId: targetId,
          status: "ready",
          providerName: "antigravityCli",
          mcpAttachment: "leafOnly",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-09-03T22:00:00.000Z",
        },
      }),
      shell(callerId),
      shell(otherProjectId, { projectId: ProjectId.make("project-other") }),
    ]);
    const mesh = yield* harness.make;

    const result = yield* mesh.list({ threadId: callerId }, { limit: 10 });

    expect(result.projectId).toBe(projectId);
    expect(result.agents.map(({ threadId }) => threadId)).toEqual([callerId, targetId]);
    expect(result.agents[0]?.current).toBe(true);
    expect(result.agents[1]?.hasPendingApprovals).toBe(true);
    expect(result.agents[1]?.workspaceIsolation).toBe("shared");
    expect(result.agents[1]?.branch).toBeNull();
    expect(result.agents[1]?.mcpAttachment).toBe("leafOnly");
    expect(result.hasMore).toBe(false);
  }),
);

it.effect("filters the mesh to bots and returns their profile metadata", () =>
  Effect.gen(function* () {
    const harness = makeHarness([
      shell(callerId),
      shell(targetId, {
        branch: "bots/reviewer",
        worktreePath: "/worktrees/reviewer",
        botProfile: {
          displayName: "Reviewer",
          description: "Reviews changes before handoff.",
          revision: 1,
          createdAt: "2026-09-03T20:00:00.000Z",
          updatedAt: "2026-09-03T20:00:00.000Z",
        },
      }),
    ]);
    const mesh = yield* harness.make;

    const result = yield* mesh.list({ threadId: callerId }, { onlyBots: true });

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({
      threadId: targetId,
      workspaceIsolation: "isolated",
      branch: "bots/reviewer",
      botProfile: { displayName: "Reviewer", revision: 1 },
    });
  }),
);

it.effect("dispatches a message through the existing target thread", () =>
  Effect.gen(function* () {
    const harness = makeHarness([
      shell(callerId),
      shell(targetId, { worktreePath: "/worktrees/target" }),
    ]);
    const mesh = yield* harness.make;

    const receipt = yield* mesh.send(
      { threadId: callerId },
      {
        requestId: "quota-check",
        targetThreadId: targetId,
        message: "Check the quota adapter.",
      },
    );

    expect(receipt).toMatchObject({ targetThreadId: targetId, sequence: 1 });
    expect(harness.commands).toHaveLength(1);
    expect(harness.commands[0]).toMatchObject({
      type: "thread.peer-turn.start",
      sourceThreadId: callerId,
      threadId: targetId,
      message: "Check the quota adapter.",
    });
  }),
);

it.effect("returns the stored receipt when the same request is retried", () =>
  Effect.gen(function* () {
    const harness = makeHarness([
      shell(callerId),
      shell(targetId, { worktreePath: "/worktrees/target" }),
    ]);
    const mesh = yield* harness.make;
    const input = {
      requestId: "stable-request",
      targetThreadId: targetId,
      message: "Run the focused tests.",
    } as const;

    const first = yield* mesh.send({ threadId: callerId }, input);
    harness.setThread(
      shell(targetId, {
        worktreePath: "/worktrees/target",
        latestTurn: {
          turnId: TurnId.make("turn-started-after-first-response"),
          state: "running",
          requestedAt: "2026-09-03T20:00:00.000Z",
          startedAt: "2026-09-03T20:00:01.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );
    const second = yield* mesh.send({ threadId: callerId }, input);

    expect(harness.commands).toHaveLength(1);
    expect(second).toEqual(first);
  }),
);

it.effect("scopes stable message identifiers to the target thread", () =>
  Effect.gen(function* () {
    const secondTargetId = ThreadId.make("thread-second-target");
    const harness = makeHarness([
      shell(callerId),
      shell(targetId, { worktreePath: "/worktrees/target" }),
      shell(secondTargetId, { worktreePath: "/worktrees/second-target" }),
    ]);
    const mesh = yield* harness.make;

    const first = yield* mesh.send(
      { threadId: callerId },
      { requestId: "same-request", targetThreadId: targetId, message: "First target." },
    );
    const second = yield* mesh.send(
      { threadId: callerId },
      { requestId: "same-request", targetThreadId: secondTargetId, message: "Second target." },
    );

    expect(second.commandId).not.toBe(first.commandId);
    expect(second.messageId).not.toBe(first.messageId);
  }),
);

it.effect("rejects sending to the caller thread", () =>
  Effect.gen(function* () {
    const harness = makeHarness([shell(callerId)]);
    const mesh = yield* harness.make;

    const error = yield* mesh
      .send(
        { threadId: callerId },
        { requestId: "self-send", targetThreadId: callerId, message: "Loop back." },
      )
      .pipe(Effect.flip);

    expect(error.reason).toBe("selfTarget");
    expect(harness.commands).toHaveLength(0);
  }),
);

it.effect("rejects sending to a thread that shares the mutable workspace", () =>
  Effect.gen(function* () {
    const harness = makeHarness([shell(callerId), shell(targetId)]);
    const mesh = yield* harness.make;

    const error = yield* mesh
      .send(
        { threadId: callerId },
        {
          requestId: "shared-workspace",
          targetThreadId: targetId,
          message: "Edit the shared checkout.",
        },
      )
      .pipe(Effect.flip);

    expect(error.reason).toBe("workspaceShared");
    expect(harness.commands).toHaveLength(0);
  }),
);

it.effect("normalizes Windows paths before checking workspace isolation", () =>
  Effect.gen(function* () {
    const harness = makeHarness([
      shell(callerId, { worktreePath: "C:\\Repo" }),
      shell(targetId, { worktreePath: "c:/repo/" }),
    ]);
    const mesh = yield* harness.make;

    const error = yield* mesh
      .send(
        { threadId: callerId },
        {
          requestId: "windows-shared-workspace",
          targetThreadId: targetId,
          message: "Edit the aliased checkout.",
        },
      )
      .pipe(Effect.flip);

    expect(error.reason).toBe("workspaceShared");
    expect(harness.commands).toHaveLength(0);
  }),
);

it.effect("does not reveal or dispatch to a thread in another project", () =>
  Effect.gen(function* () {
    const harness = makeHarness([
      shell(callerId),
      shell(otherProjectId, { projectId: ProjectId.make("project-other") }),
    ]);
    const mesh = yield* harness.make;

    const error = yield* mesh
      .send(
        { threadId: callerId },
        {
          requestId: "cross-boundary",
          targetThreadId: otherProjectId,
          message: "Cross the boundary.",
        },
      )
      .pipe(Effect.flip);

    expect(error).toBeInstanceOf(AgentMeshError);
    expect(error.reason).toBe("targetUnavailable");
    expect(harness.commands).toHaveLength(0);
  }),
);

it.effect("interrupts only a running target turn", () =>
  Effect.gen(function* () {
    const runningTurnId = TurnId.make("turn-running");
    const harness = makeHarness([
      shell(callerId),
      shell(targetId, {
        worktreePath: "/worktrees/target",
        latestTurn: {
          turnId: runningTurnId,
          state: "running",
          requestedAt: "2026-09-03T20:00:00.000Z",
          startedAt: "2026-09-03T20:00:01.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    ]);
    const mesh = yield* harness.make;

    yield* mesh.interrupt(
      { threadId: callerId },
      { requestId: "stop-target", targetThreadId: targetId, observedTurnId: runningTurnId },
    );

    expect(harness.commands[0]).toMatchObject({
      type: "thread.peer-turn.interrupt",
      sourceThreadId: callerId,
      threadId: targetId,
      observedTurnId: runningTurnId,
    });
  }),
);

it.effect("returns bounded latest assistant output without user messages", () =>
  Effect.gen(function* () {
    const assistantText = `opening-${"x".repeat(300)}-ending`;
    const latestTurnId = TurnId.make("turn-latest");
    const assistantMessageId = MessageId.make("message-assistant");
    const harness = makeHarness(
      [
        shell(callerId),
        shell(targetId, {
          latestTurn: {
            turnId: latestTurnId,
            state: "completed",
            requestedAt: "2026-09-03T20:00:00.000Z",
            startedAt: "2026-09-03T20:00:01.000Z",
            completedAt: "2026-09-03T20:01:00.000Z",
            assistantMessageId,
          },
        }),
      ],
      {
        [targetId]: [
          {
            id: MessageId.make("message-user"),
            role: "user",
            text: "private prompt",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: "2026-09-03T20:00:00.000Z",
            updatedAt: "2026-09-03T20:00:00.000Z",
          },
          {
            id: assistantMessageId,
            role: "assistant",
            text: assistantText,
            attachments: [],
            turnId: latestTurnId,
            streaming: false,
            createdAt: "2026-09-03T20:01:00.000Z",
            updatedAt: "2026-09-03T20:01:00.000Z",
          },
        ],
      },
    );
    const mesh = yield* harness.make;

    const result = yield* mesh.read(
      { threadId: callerId },
      { targetThreadId: targetId, maxChars: 256 },
    );

    expect(result.latestAssistant?.text).toHaveLength(256);
    expect(result.latestAssistant?.text.endsWith("-ending")).toBe(true);
    expect(result.latestAssistant?.text).not.toContain("private prompt");
    expect(result.latestAssistant?.truncated).toBe(true);
  }),
);

const catalogProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("judgment-instance"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", email: "private@example.invalid" },
  message: "private provider diagnostic",
  checkedAt: "2026-09-05T00:00:00.000Z",
  supportedRuntimeModes: ["approval-required", "full-access"],
  models: [
    { slug: "execution", name: "Execution", isCustom: false, capabilities: null },
    {
      slug: "judgment",
      name: "Judgment",
      aliases: ["reviewer"],
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoning",
            label: "Reasoning",
            type: "select",
            options: [{ id: "high", label: "High" }],
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
};

it.effect(
  "discovers paginated model selections and native effort options without account details",
  () =>
    Effect.gen(function* () {
      const mesh = yield* makeHarness([shell(callerId)], {}, [catalogProvider]).make;
      const first = yield* mesh.models({ threadId: callerId }, { limit: 1 });
      expect(first.models.map(({ model }) => model.slug)).toEqual(["execution"]);
      expect(first.nextOffset).toBe(1);
      const next = yield* mesh.models({ threadId: callerId }, { offset: 1, limit: 1 });
      expect(next.nextOffset).toBeNull();
      expect(next.models[0]).toMatchObject({
        instanceId: "judgment-instance",
        authStatus: "authenticated",
        supportedRuntimeModes: ["approval-required", "full-access"],
        model: {
          slug: "judgment",
          capabilities: { optionDescriptors: [{ id: "reasoning", options: [{ id: "high" }] }] },
        },
      });
      expect(next.models[0]).not.toHaveProperty("auth");
      expect(next.models[0]).not.toHaveProperty("message");
      const filtered = yield* mesh.models(
        { threadId: callerId },
        { query: "REVIEWER", instanceId: catalogProvider.instanceId },
      );
      expect(filtered.models.map(({ model }) => model.slug)).toEqual(["judgment"]);
      const absent = yield* mesh.models(
        { threadId: callerId },
        { instanceId: ProviderInstanceId.make("absent") },
      );
      expect(absent.models).toEqual([]);
    }),
);

it.effect("does not expose the catalog to an unavailable caller", () =>
  Effect.gen(function* () {
    const mesh = yield* makeHarness([], {}, [catalogProvider]).make;
    const error = yield* mesh.models({ threadId: callerId }, {}).pipe(Effect.flip);
    expect(error.reason).toBe("callerUnavailable");
  }),
);

it.effect("reports the bot's configured selection without inferring identity from its title", () =>
  Effect.gen(function* () {
    const selection = {
      instanceId: catalogProvider.instanceId,
      model: "judgment",
      options: [{ id: "reasoning", value: "high" }],
    };
    const mesh = yield* makeHarness([
      shell(callerId),
      shell(targetId, { modelSelection: selection }),
    ]).make;
    const result = yield* mesh.list({ threadId: callerId }, {});
    expect(result.agents.find(({ threadId }) => threadId === targetId)?.modelSelection).toEqual(
      selection,
    );
  }),
);

it.effect("registers model discovery as an MCP tool and requires agents.read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mesh = yield* makeHarness([shell(callerId)], {}, [catalogProvider]).make;
      const registered = AgentsToolkitRegistrationLive.pipe(
        Layer.provide(Layer.succeed(AgentMesh.AgentMesh, mesh)),
        Layer.provideMerge(McpServer.McpServer.layer),
      );
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const client = McpSchema.McpServerClient.of({
          clientId: 1,
          clientCapabilities: {},
          clientInfo: { name: "mesh-test", version: "1" },
          protocolVersion: "2025-06-18",
          initializePayload: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "mesh-test", version: "1" },
          },
          getClient: Effect.die("unused"),
        });
        const invoke = (capabilities: ReadonlySet<McpInvocationContext.McpCapability>) =>
          server.callTool({ name: "agents_models", arguments: { query: "judgment" } }).pipe(
            Effect.provideService(McpSchema.McpServerClient, client),
            Effect.provideService(McpInvocationContext.McpInvocationContext, {
              environmentId: EnvironmentId.make("test-environment"),
              threadId: callerId,
              providerSessionId: "test-session",
              providerInstanceId: ProviderInstanceId.make("codex"),
              issuedAt: 1,
              capabilities,
            }),
          );
        const denied = yield* invoke(new Set());
        expect(denied.isError).toBe(true);
        const allowed = yield* invoke(new Set(["agents.read"]));
        expect(allowed.isError).not.toBe(true);
        expect(allowed.structuredContent).toMatchObject({
          models: [{ instanceId: "judgment-instance" }],
        });
        expect(allowed.structuredContent).not.toHaveProperty("models.0.auth");
      }).pipe(Effect.provide(registered));
    }),
  ),
);
