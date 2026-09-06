import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BotProfile,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { describe, expect } from "vite-plus/test";

import {
  BOT_COMPUTER_IMAGE,
  BOT_COMPUTER_LABEL,
  BOT_COMPUTER_NETWORK_LABEL,
  BOT_COMPUTER_OWNER_LABEL,
  BOT_COMPUTER_SPEC_LABEL,
  BOT_COMPUTER_SPEC_VERSION,
  makeBotComputerIdentity,
} from "./BotComputerSpec.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  make as makeBotComputerService,
  stateFromDockerObservation,
} from "./BotComputerService.ts";
import * as DockerCli from "./DockerCli.ts";

const threadId = ThreadId.make("thread-1");
const identity = makeBotComputerIdentity(EnvironmentId.make("environment-1"), threadId);
const labels = {
  [BOT_COMPUTER_LABEL]: "1",
  [BOT_COMPUTER_OWNER_LABEL]: identity.ownerHash,
  [BOT_COMPUTER_SPEC_LABEL]: BOT_COMPUTER_SPEC_VERSION,
  [BOT_COMPUTER_NETWORK_LABEL]: "outbound",
};
const now = "2026-09-05T00:00:00.000Z";
const botProfile: BotProfile = {
  displayName: "Test Bot",
  description: null,
  revision: 1,
  createdAt: now,
  updatedAt: now,
};

describe("BotComputerService Docker state projection", () => {
  it("derives absent, suspended, and running without independent booleans", () => {
    expect(stateFromDockerObservation({ threadId, identity }, null).status).toBe("absent");
    expect(
      stateFromDockerObservation(
        { threadId, identity },
        {
          id: "container-id",
          status: "exited",
          running: false,
          error: "",
          image: BOT_COMPUTER_IMAGE,
          labels,
          viewerBindings: [],
        },
      ),
    ).toMatchObject({ status: "suspended", networkAccess: "outbound" });
    expect(
      stateFromDockerObservation(
        { threadId, identity },
        {
          id: "container-id",
          status: "running",
          running: true,
          error: "",
          image: BOT_COMPUTER_IMAGE,
          labels,
          viewerBindings: [{ hostIp: "127.0.0.1", hostPort: "49152" }],
        },
      ),
    ).toMatchObject({
      status: "running",
      viewerPort: 49152,
      viewerUrl: "http://127.0.0.1:49152/vnc.html?autoconnect=1&resize=remote",
      networkAccess: "outbound",
    });
  });

  it("fails closed for foreign ownership, missing policy, and non-loopback viewers", () => {
    const observation = {
      id: "container-id",
      status: "running",
      running: true,
      error: "",
      image: BOT_COMPUTER_IMAGE,
      labels,
      viewerBindings: [{ hostIp: "0.0.0.0", hostPort: "49152" }],
    } as const;

    expect(stateFromDockerObservation({ threadId, identity }, observation)).toMatchObject({
      status: "failed",
      detail: "The running container has no valid loopback-only viewer binding.",
    });
    expect(
      stateFromDockerObservation(
        { threadId, identity },
        { ...observation, labels: { ...labels, [BOT_COMPUTER_NETWORK_LABEL]: "" } },
      ),
    ).toMatchObject({ status: "failed", detail: expect.stringContaining("network policy") });
    expect(
      stateFromDockerObservation(
        { threadId, identity },
        { ...observation, labels: { ...labels, [BOT_COMPUTER_OWNER_LABEL]: "other" } },
      ),
    ).toMatchObject({ status: "failed", detail: expect.stringContaining("owned by another") });
  });

  it.effect("authorizes only active Bot threads before touching Docker", () =>
    Effect.gen(function* () {
      let probes = 0;
      const service = yield* makeService(
        { botProfile: null },
        {
          ...makeDockerFake(),
          probe: Effect.sync(() => {
            probes += 1;
            return { available: true } as const;
          }),
        },
      );

      const error = yield* service.inspect({ threadId }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "BotComputerAuthorizationError",
        reason: "not-bot",
      });
      expect(probes).toBe(0);
    }),
  );

  it.effect("converges repeated starts without recreating a running computer", () =>
    Effect.gen(function* () {
      let observation: DockerCli.DockerContainerObservation | null = null;
      let creates = 0;
      let starts = 0;
      const createdObservation: DockerCli.DockerContainerObservation = {
        id: "container-id",
        status: "created",
        running: false,
        error: "",
        image: BOT_COMPUTER_IMAGE,
        labels,
        viewerBindings: [],
      };
      const docker = makeDockerFake({
        inspectContainer: () => Effect.succeed(observation),
        createContainer: () =>
          Effect.sync(() => {
            creates += 1;
            observation = createdObservation;
          }),
        startContainer: () =>
          Effect.sync(() => {
            starts += 1;
            observation = {
              ...createdObservation,
              status: "running",
              running: true,
              viewerBindings: [{ hostIp: "127.0.0.1", hostPort: "49152" }],
            };
          }),
      });
      const service = yield* makeService({ botProfile }, docker);

      const first = yield* service.start({ threadId, networkAccess: "outbound" });
      const second = yield* service.start({ threadId, networkAccess: "outbound" });

      expect(first.status).toBe("running");
      expect(second.status).toBe("running");
      expect(creates).toBe(1);
      expect(starts).toBe(1);
    }),
  );

  it.effect("denies computer controls unless the owned container is running", () =>
    Effect.gen(function* () {
      const service = yield* makeService(
        { botProfile },
        makeDockerFake({
          inspectContainer: () =>
            Effect.succeed({
              id: "container-id",
              status: "exited",
              running: false,
              error: "",
              image: BOT_COMPUTER_IMAGE,
              labels,
              viewerBindings: [],
            }),
        }),
      );

      const error = yield* service.computerStatus({ threadId }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "BotComputerControlError",
        operation: "status",
        reason: "not-running",
      });
    }),
  );
});

function makeDockerFake(
  overrides: Partial<DockerCli.DockerCli["Service"]> = {},
): DockerCli.DockerCli["Service"] {
  return DockerCli.DockerCli.of({
    probe: Effect.succeed({ available: true }),
    inspectContainer: () => Effect.succeed(null),
    imageExists: () => Effect.succeed(true),
    buildImage: () => Effect.void,
    createContainer: () => Effect.void,
    startContainer: () => Effect.void,
    stopContainer: () => Effect.void,
    removeContainer: () => Effect.void,
    removeVolume: () => Effect.void,
    execContainer: () => Effect.succeed(""),
    ...overrides,
  });
}

function makeService(
  threadFields: { readonly botProfile: BotProfile | null },
  docker: DockerCli.DockerCli["Service"],
) {
  const projectId = ProjectId.make("project-1");
  const thread: OrchestrationThreadShell = {
    id: threadId,
    projectId,
    title: "Test Bot",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "codex/test-bot",
    botProfile: threadFields.botProfile,
    worktreePath: "/tmp/project-worktree",
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
  const project: OrchestrationProjectShell = {
    id: projectId,
    title: "Test Project",
    workspaceRoot: "/tmp/project",
    repositoryIdentity: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    faviconPath: null,
    projectIcon: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  };

  return makeBotComputerService.pipe(
    Effect.provideService(DockerCli.DockerCli, docker),
    Effect.provide(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getThreadShellById: () => Effect.succeed(Option.some(thread)),
        getProjectShellById: () => Effect.succeed(Option.some(project)),
      }),
    ),
    Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-1")),
    }),
    Effect.provideService(HostProcessPlatform, "linux"),
  );
}
