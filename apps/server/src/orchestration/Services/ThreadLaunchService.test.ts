import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import * as OrchestrationEngine from "./OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "./ThreadDeletionReactor.ts";

import { make, preparedWorktreeResumeFor } from "./ThreadLaunchService.ts";

it("adopts an existing local branch without treating it as a new ref", () => {
  expect(
    preparedWorktreeResumeFor(
      [
        {
          name: "convergeos/worker-a",
          current: false,
          isDefault: false,
          worktreePath: null,
        },
      ],
      "convergeos/worker-a",
    ),
  ).toEqual({ reusePreparedBranch: true, preparedWorktreePath: null });
});

it("adopts the existing worktree path when preparation completed before metadata persisted", () => {
  expect(
    preparedWorktreeResumeFor(
      [
        {
          name: "convergeos/worker-a",
          current: false,
          isDefault: false,
          worktreePath: "/worktrees/worker-a",
        },
      ],
      "convergeos/worker-a",
    ),
  ).toEqual({
    reusePreparedBranch: true,
    preparedWorktreePath: "/worktrees/worker-a",
  });
});

it.effect("fails closed when the final turn failed after setup dispatch", () => {
  const now = "2026-09-05T00:00:00.000Z";
  const projectId = ProjectId.make("project-launch-retry");
  const threadId = ThreadId.make("thread-launch-retry");
  const commandId = CommandId.make("worker-turn-retry");
  const activities: OrchestrationThreadActivity[] = [];
  const commands: OrchestrationCommand[] = [];
  const launchSteps: string[] = [];
  let setupRuns = 0;
  let worktreeCreates = 0;
  let failFinalTurn = true;
  let failMetaUpdate = false;
  let sequence = 0;
  const modelSelection = {
    instanceId: ProviderInstanceId.make("codex-launch-retry"),
    model: "gpt-test",
  };
  const thread: OrchestrationThread = {
    id: threadId,
    projectId,
    title: "Worker",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "convergeos/worker-a",
    worktreePath: "/worktrees/worker-a",
    linkedPullRequest: null,
    botProfile: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    titleRegeneration: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities,
    checkpoints: [],
    session: null,
  };
  const command = {
    type: "thread.turn.start",
    commandId,
    threadId,
    message: {
      messageId: MessageId.make("message-launch-retry"),
      role: "user",
      text: "Resume the worker.",
      attachments: [],
    },
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    bootstrap: {
      createThread: {
        projectId,
        title: "Worker",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
      },
      prepareWorktree: {
        projectCwd: "/workspace/project",
        baseBranch: "main",
        branch: "convergeos/worker-a",
      },
      runSetupScript: true,
    },
    createdAt: now,
  } satisfies Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

  const layers = Layer.mergeAll(
    Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
      dispatch: (dispatched) =>
        Effect.gen(function* () {
          commands.push(dispatched);
          launchSteps.push(dispatched.type);
          sequence += 1;
          if (dispatched.type === "thread.activity.append") {
            activities.push({ ...dispatched.activity, sequence });
          }
          if (dispatched.type === "thread.meta.update" && failMetaUpdate) {
            failMetaUpdate = false;
            return yield* new OrchestrationCommandInvariantError({
              commandType: dispatched.type,
              detail: "injected metadata failure",
            });
          }
          if (dispatched.type === "thread.turn.start" && failFinalTurn) {
            failFinalTurn = false;
            return yield* new OrchestrationCommandInvariantError({
              commandType: dispatched.type,
              detail: "injected final turn failure",
            });
          }
          return { sequence };
        }),
    }),
    Layer.mock(ThreadDeletionReactor)({
      drainThrough: () => Effect.void,
    }),
    Layer.mock(GitWorkflowService.GitWorkflowService)({
      listRefs: () =>
        Effect.succeed({
          refs: [
            {
              name: "convergeos/worker-a",
              current: false,
              isDefault: false,
              worktreePath: "/worktrees/worker-a",
            },
          ],
          isRepo: true,
          hasPrimaryRemote: true,
          nextCursor: null,
          totalCount: 1,
        }),
      createWorktree: () =>
        Effect.sync(() => {
          worktreeCreates += 1;
          return {
            worktree: {
              path: "/worktrees/worker-a",
              refName: "convergeos/worker-a",
            },
          };
        }),
      remoteExists: () => Effect.succeed(false),
    }),
    Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
      getThreadDetailById: () => Effect.succeed(Option.some({ ...thread, activities })),
    }),
    Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
      runForThread: () =>
        Effect.sync(() => {
          setupRuns += 1;
          launchSteps.push("setup-runner");
          return {
            status: "started" as const,
            scriptId: "setup",
            scriptName: "Setup",
            terminalId: "setup-setup",
            cwd: "/worktrees/worker-a",
          };
        }),
    }),
    Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
      refreshStatus: () => Effect.die("status refresh is detached"),
    }),
  );

  return Effect.gen(function* () {
    const launcher = yield* make;
    const firstError = yield* launcher
      .launch({
        command,
        onPrepared: () =>
          Effect.sync(() => {
            launchSteps.push("prepared-fence");
          }),
      })
      .pipe(Effect.flip);
    const resumeCommand = {
      ...command,
      bootstrap: {
        prepareWorktree: command.bootstrap.prepareWorktree,
        runSetupScript: true,
      },
    } satisfies Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
    const retryError = yield* launcher
      .launch({ command: resumeCommand, resumeExistingThread: true })
      .pipe(Effect.flip);

    expect(firstError.message).toContain("outcome is uncertain");
    expect(launchSteps.indexOf("prepared-fence")).toBeLessThan(launchSteps.indexOf("setup-runner"));
    expect(launchSteps.indexOf("setup-runner")).toBeLessThan(
      launchSteps.indexOf("thread.turn.start"),
    );
    expect(retryError.message).toContain("outcome is uncertain");
    expect(setupRuns).toBe(1);
    expect(commands.filter((entry) => entry.type === "thread.turn.start")).toHaveLength(1);
    expect(commands.some((entry) => entry.type === "thread.delete")).toBe(false);
    expect(
      commands.filter(
        (entry) =>
          entry.type === "thread.activity.append" &&
          entry.activity.kind === "setup-script.requested",
      ),
    ).toHaveLength(1);

    activities.splice(0, activities.length, {
      id: EventId.make("setup-intent-only"),
      tone: "info",
      kind: "setup-script.requested",
      summary: "Starting setup script",
      payload: {
        launchCommandId: command.commandId,
        worktreePath: "/worktrees/worker-a",
      },
      turnId: null,
      createdAt: now,
    });
    commands.splice(0, commands.length);
    setupRuns = 0;
    const intentOnlyError = yield* launcher
      .launch({ command: resumeCommand, resumeExistingThread: true })
      .pipe(Effect.flip);

    expect(intentOnlyError.message).toContain("outcome is uncertain");
    expect(setupRuns).toBe(0);
    expect(commands.some((entry) => entry.type === "thread.turn.start")).toBe(false);

    activities.splice(0, activities.length);
    commands.splice(0, commands.length);
    const createsBeforeMetadataFailure = worktreeCreates;
    failMetaUpdate = true;
    const metadataError = yield* launcher.launch({ command }).pipe(Effect.flip);
    expect(metadataError.message).toContain("metadata failure");
    expect(metadataError.bootstrapThreadDisposition).toBe("deleted");
    expect(commands.some((entry) => entry.type === "thread.delete")).toBe(true);
    expect(worktreeCreates).toBe(createsBeforeMetadataFailure + 1);
    expect(setupRuns).toBe(0);
  }).pipe(Effect.provide(Layer.merge(layers, NodeServices.layer)));
});

const verifyOrdinaryBootstrapCleanup = (runSetupScript: boolean) => {
  const now = "2026-09-05T00:00:00.000Z";
  const projectId = ProjectId.make(
    runSetupScript ? "project-ordinary-setup" : "project-ordinary-meta",
  );
  const threadId = ThreadId.make(runSetupScript ? "thread-ordinary-setup" : "thread-ordinary-meta");
  const activities: OrchestrationThreadActivity[] = [];
  const commands: OrchestrationCommand[] = [];
  let sequence = 0;
  let setupRuns = 0;
  const modelSelection = {
    instanceId: ProviderInstanceId.make("codex-ordinary-bootstrap"),
    model: "gpt-test",
  };
  const thread: OrchestrationThread = {
    id: threadId,
    projectId,
    title: "Ordinary bootstrap",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "convergeos/ordinary-bootstrap",
    worktreePath: "/worktrees/ordinary-bootstrap",
    linkedPullRequest: null,
    botProfile: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    titleRegeneration: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities,
    checkpoints: [],
    session: null,
  };
  const command = {
    type: "thread.turn.start",
    commandId: CommandId.make(`ordinary-bootstrap-${runSetupScript ? "setup" : "meta"}`),
    threadId,
    message: {
      messageId: MessageId.make(`ordinary-bootstrap-message-${runSetupScript ? "setup" : "meta"}`),
      role: "user",
      text: "Start an ordinary thread.",
      attachments: [],
    },
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    bootstrap: {
      createThread: {
        projectId,
        title: "Ordinary bootstrap",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
      },
      prepareWorktree: {
        projectCwd: "/workspace/project",
        baseBranch: "main",
        branch: "convergeos/ordinary-bootstrap",
      },
      runSetupScript,
    },
    createdAt: now,
  } satisfies Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

  const layers = Layer.mergeAll(
    Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
      dispatch: (dispatched) =>
        Effect.gen(function* () {
          commands.push(dispatched);
          sequence += 1;
          if (dispatched.type === "thread.activity.append") {
            activities.push({ ...dispatched.activity, sequence });
          }
          if (dispatched.type === "thread.turn.start") {
            return yield* new OrchestrationCommandInvariantError({
              commandType: dispatched.type,
              detail: "injected ordinary final turn failure",
            });
          }
          return { sequence };
        }),
    }),
    Layer.mock(ThreadDeletionReactor)({ drainThrough: () => Effect.void }),
    Layer.mock(GitWorkflowService.GitWorkflowService)({
      createWorktree: () =>
        Effect.succeed({
          worktree: {
            path: "/worktrees/ordinary-bootstrap",
            refName: "convergeos/ordinary-bootstrap",
          },
        }),
      remoteExists: () => Effect.succeed(false),
    }),
    Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
      getThreadDetailById: () => Effect.succeed(Option.some({ ...thread, activities })),
    }),
    Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
      runForThread: () =>
        Effect.sync(() => {
          setupRuns += 1;
          return {
            status: "started" as const,
            scriptId: "setup",
            scriptName: "Setup",
            terminalId: "setup-ordinary",
            cwd: "/worktrees/ordinary-bootstrap",
          };
        }),
    }),
    Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
      refreshStatus: () => Effect.die("status refresh is detached"),
    }),
  );

  return Effect.gen(function* () {
    const launcher = yield* make;
    const error = yield* launcher.launch({ command }).pipe(Effect.flip);

    expect(error.bootstrapThreadDisposition).toBe("deleted");
    expect(commands.at(-1)?.type).toBe("thread.delete");
    expect(commands.some((entry) => entry.type === "thread.meta.update")).toBe(true);
    expect(setupRuns).toBe(runSetupScript ? 1 : 0);
  }).pipe(Effect.provide(Layer.merge(layers, NodeServices.layer)));
};

it.effect("deletes an ordinary bootstrap when the final turn fails after worktree metadata", () =>
  verifyOrdinaryBootstrapCleanup(false),
);

it.effect("deletes an ordinary bootstrap when the final turn fails after setup", () =>
  verifyOrdinaryBootstrapCleanup(true),
);
