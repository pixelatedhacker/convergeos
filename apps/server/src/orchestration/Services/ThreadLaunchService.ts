import {
  CommandId,
  EventId,
  OrchestrationDispatchCommandError,
  type OrchestrationClientOrigin,
  type OrchestrationCommand,
  type ThreadId,
  type VcsRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import * as OrchestrationEngine from "./OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "./ThreadDeletionReactor.ts";

type ThreadTurnStartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

export interface ThreadLaunchInput {
  readonly command: ThreadTurnStartCommand;
  readonly origin?: OrchestrationClientOrigin;
  /** Resume worktree preparation after the thread create event already committed. */
  readonly resumeExistingThread?: boolean;
  readonly onPrepared?: (prepared: {
    readonly branch: string;
    readonly worktreePath: string;
  }) => Effect.Effect<void, OrchestrationDispatchCommandError>;
}

export interface ThreadLaunchServiceShape {
  readonly launch: (
    input: ThreadLaunchInput,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
}

export const preparedWorktreeResumeFor = (refs: ReadonlyArray<VcsRef>, branch: string) => {
  const preparedRef = refs.find((ref) => ref.name === branch && ref.isRemote !== true);
  return {
    reusePreparedBranch: preparedRef !== undefined,
    preparedWorktreePath: preparedRef?.worktreePath ?? null,
  };
};

export const THREAD_LAUNCH_SETUP_OUTCOME_UNCERTAIN =
  "Setup script dispatch was recorded, but its outcome is uncertain. Start a fresh worker instead of replaying it.";

export const isThreadLaunchSetupOutcomeUncertain = (error: OrchestrationDispatchCommandError) =>
  error.message === THREAD_LAUNCH_SETUP_OUTCOME_UNCERTAIN;

export const setupResumeDispositionFor = (
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
  launchCommandId: CommandId,
): "run" | "uncertain" => {
  for (const activity of activities) {
    if (
      typeof activity.payload !== "object" ||
      activity.payload === null ||
      !("launchCommandId" in activity.payload) ||
      activity.payload.launchCommandId !== launchCommandId
    ) {
      continue;
    }
    if (activity.kind === "setup-script.started" || activity.kind === "setup-script.requested") {
      return "uncertain";
    }
  }
  return "run";
};

class ThreadLaunchSetupOutcomeUncertainError extends Schema.TaggedErrorClass<ThreadLaunchSetupOutcomeUncertainError>()(
  "ThreadLaunchSetupOutcomeUncertainError",
  { message: Schema.String },
) {}
const isThreadLaunchSetupOutcomeUncertainCause = Schema.is(ThreadLaunchSetupOutcomeUncertainError);

export class ThreadLaunchService extends Context.Service<
  ThreadLaunchService,
  ThreadLaunchServiceShape
>()("t3/orchestration/Services/ThreadLaunchService") {}

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

/** Preserve the setup runner's broader pre-refactor message normalization. */
function setupFailureDescription(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return String(cause);
}

function projectSetupScriptCompatibilityDetail(
  error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError,
): string {
  switch (error._tag) {
    case "ProjectSetupScriptOperationError":
      return setupFailureDescription(error.cause);
    case "ProjectSetupScriptProjectNotFoundError":
      return "Project was not found for setup script execution.";
    default:
      return unexpectedCompatibilityError(error);
  }
}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

  const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
    isOrchestrationDispatchCommandError(cause)
      ? cause
      : new OrchestrationDispatchCommandError({
          message: cause instanceof Error ? cause.message : fallbackMessage,
          cause,
        });

  const randomUUID = crypto.randomUUIDv4.pipe(
    Effect.mapError((cause) =>
      toDispatchCommandError(cause, "Failed to generate orchestration command identifier."),
    ),
  );
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  const dispatch = (command: OrchestrationCommand, origin: OrchestrationClientOrigin | undefined) =>
    orchestrationEngine.dispatch(command, origin === undefined ? undefined : { origin });

  const appendSetupScriptActivity = (input: {
    readonly threadId: ThreadId;
    readonly origin?: OrchestrationClientOrigin;
    readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
    readonly summary: string;
    readonly createdAt: string;
    readonly payload: Record<string, unknown>;
    readonly tone: "info" | "error";
  }) =>
    Effect.all({
      commandId: serverCommandId("setup-script-activity"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        dispatch(
          {
            type: "thread.activity.append",
            commandId,
            threadId: input.threadId,
            activity: {
              id: activityId,
              tone: input.tone,
              kind: input.kind,
              summary: input.summary,
              payload: input.payload,
              turnId: null,
              createdAt: input.createdAt,
            },
            createdAt: input.createdAt,
          },
          input.origin,
        ),
      ),
    );

  const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
    const error = Cause.squash(cause);
    if (isThreadLaunchSetupOutcomeUncertainCause(error)) {
      return new OrchestrationDispatchCommandError({
        message: THREAD_LAUNCH_SETUP_OUTCOME_UNCERTAIN,
        cause,
      });
    }
    return isOrchestrationDispatchCommandError(error)
      ? error
      : new OrchestrationDispatchCommandError({
          message:
            error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
          cause,
        });
  };

  const refreshGitStatus = (cwd: string) =>
    vcsStatusBroadcaster
      .refreshStatus(cwd)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

  const launch: ThreadLaunchServiceShape["launch"] = Effect.fn("ThreadLaunchService.launch")(
    function* (input) {
      const { command, origin } = input;
      const bootstrap = command.bootstrap;
      if (bootstrap === undefined) {
        return yield* new OrchestrationDispatchCommandError({
          message: "Thread launch requires bootstrap instructions.",
        });
      }
      const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
      let createdThread = false;
      let preparedFenceSucceeded = false;
      let setupDispatchRecorded = false;
      const targetProjectId = bootstrap.createThread?.projectId;
      const targetProjectCwd = bootstrap.prepareWorktree?.projectCwd;
      let targetWorktreePath = bootstrap.createThread?.worktreePath ?? null;

      const cleanupCreatedThread = () =>
        createdThread && !preparedFenceSucceeded
          ? serverCommandId("bootstrap-thread-delete").pipe(
              Effect.flatMap((commandId) =>
                dispatch(
                  {
                    type: "thread.delete",
                    commandId,
                    threadId: command.threadId,
                  },
                  origin,
                ),
              ),
              Effect.as(true),
            )
          : Effect.succeed(false);

      const recordSetupScriptLaunchFailure = (failure: {
        readonly error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError;
        readonly requestedAt: string;
        readonly worktreePath: string;
      }) => {
        const detail = projectSetupScriptCompatibilityDetail(failure.error);
        return appendSetupScriptActivity({
          threadId: command.threadId,
          ...(origin === undefined ? {} : { origin }),
          kind: "setup-script.failed",
          summary: "Setup script failed to start",
          createdAt: failure.requestedAt,
          payload: {
            detail,
            worktreePath: failure.worktreePath,
            launchCommandId: command.commandId,
          },
          tone: "error",
        }).pipe(
          Effect.ignoreCause({ log: false }),
          Effect.flatMap(() =>
            Effect.logWarning("bootstrap turn start failed to launch setup script", {
              threadId: command.threadId,
              worktreePath: failure.worktreePath,
              detail,
            }),
          ),
        );
      };

      const recordSetupScriptStarted = (started: {
        readonly requestedAt: string;
        readonly worktreePath: string;
        readonly scriptId: string;
        readonly scriptName: string;
        readonly terminalId: string;
      }) =>
        Effect.gen(function* () {
          const startedAt = yield* nowIso;
          const payload = {
            scriptId: started.scriptId,
            scriptName: started.scriptName,
            terminalId: started.terminalId,
            worktreePath: started.worktreePath,
            launchCommandId: command.commandId,
          };
          yield* appendSetupScriptActivity({
            threadId: command.threadId,
            ...(origin === undefined ? {} : { origin }),
            kind: "setup-script.started",
            summary: "Setup script started",
            createdAt: startedAt,
            payload,
            tone: "info",
          });
        });

      const runSetupProgram = () =>
        Effect.gen(function* () {
          if (!bootstrap.runSetupScript || !targetWorktreePath) {
            return;
          }
          const worktreePath = targetWorktreePath;
          const requestedAt = yield* nowIso;
          const detail = yield* projectionSnapshotQuery.getThreadDetailById(command.threadId, {
            activityKinds: ["setup-script.requested", "setup-script.started"],
          });
          const disposition = setupResumeDispositionFor(
            Option.isSome(detail) ? detail.value.activities : [],
            command.commandId,
          );
          if (disposition === "uncertain") {
            return yield* new ThreadLaunchSetupOutcomeUncertainError({
              message: THREAD_LAUNCH_SETUP_OUTCOME_UNCERTAIN,
            });
          }
          yield* appendSetupScriptActivity({
            threadId: command.threadId,
            ...(origin === undefined ? {} : { origin }),
            kind: "setup-script.requested",
            summary: "Starting setup script",
            createdAt: requestedAt,
            payload: {
              worktreePath,
              launchCommandId: command.commandId,
            },
            tone: "info",
          });
          setupDispatchRecorded = true;
          yield* projectSetupScriptRunner
            .runForThread({
              threadId: command.threadId,
              ...(targetProjectId ? { projectId: targetProjectId } : {}),
              ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
              worktreePath,
            })
            .pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  recordSetupScriptLaunchFailure({
                    error,
                    requestedAt,
                    worktreePath,
                  }),
                onSuccess: (setupResult) => {
                  if (setupResult.status !== "started") {
                    return appendSetupScriptActivity({
                      threadId: command.threadId,
                      ...(origin === undefined ? {} : { origin }),
                      kind: "setup-script.started",
                      summary: "No setup script configured",
                      createdAt: requestedAt,
                      payload: {
                        status: "no-script",
                        worktreePath,
                        launchCommandId: command.commandId,
                      },
                      tone: "info",
                    });
                  }
                  return recordSetupScriptStarted({
                    requestedAt,
                    worktreePath,
                    scriptId: setupResult.scriptId,
                    scriptName: setupResult.scriptName,
                    terminalId: setupResult.terminalId,
                  });
                },
              }),
            );
        });

      const launchProgram = Effect.gen(function* () {
        if (bootstrap.createThread) {
          const created = yield* dispatch(
            {
              type: "thread.create",
              commandId: yield* serverCommandId("bootstrap-thread-create"),
              threadId: command.threadId,
              projectId: bootstrap.createThread.projectId,
              title: bootstrap.createThread.title,
              modelSelection: bootstrap.createThread.modelSelection,
              runtimeMode: bootstrap.createThread.runtimeMode,
              interactionMode: bootstrap.createThread.interactionMode,
              branch: bootstrap.createThread.branch,
              worktreePath: bootstrap.createThread.worktreePath,
              createdAt: bootstrap.createThread.createdAt,
            },
            origin,
          );
          // The successful create is a fence in the engine command queue:
          // every delete for the prior incarnation committed before it. Drain
          // through that event before setup or turn start can own terminals and
          // provider sessions under the reused thread id.
          yield* threadDeletionReactor.drainThrough(created.sequence);
          createdThread = true;
        }

        if (bootstrap.prepareWorktree) {
          let worktreeBaseRef = bootstrap.prepareWorktree.baseBranch;
          let reusePreparedBranch = false;
          let preparedWorktreePath: string | null = null;
          if (input.resumeExistingThread === true && bootstrap.prepareWorktree.branch) {
            const refs = yield* gitWorkflow.listRefs({
              cwd: bootstrap.prepareWorktree.projectCwd,
              query: bootstrap.prepareWorktree.branch,
              refresh: true,
            });
            const resume = preparedWorktreeResumeFor(refs.refs, bootstrap.prepareWorktree.branch);
            reusePreparedBranch = resume.reusePreparedBranch;
            preparedWorktreePath = resume.preparedWorktreePath;
            if (reusePreparedBranch) {
              worktreeBaseRef = bootstrap.prepareWorktree.branch;
            }
          }
          // "Start from origin" is a stored default; repos without the requested
          // remote branch fall back to the local base branch.
          const startFromOrigin =
            bootstrap.prepareWorktree.startFromOrigin === true &&
            (yield* gitWorkflow.remoteExists({
              cwd: bootstrap.prepareWorktree.projectCwd,
              remoteName: "origin",
            }));
          if (startFromOrigin) {
            yield* gitWorkflow.fetchRemote({
              cwd: bootstrap.prepareWorktree.projectCwd,
              remoteName: "origin",
            });
            const remoteBaseExists = yield* gitWorkflow.remoteBranchExists({
              cwd: bootstrap.prepareWorktree.projectCwd,
              refName: bootstrap.prepareWorktree.baseBranch,
              remoteName: "origin",
            });
            if (remoteBaseExists) {
              const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
                cwd: bootstrap.prepareWorktree.projectCwd,
                refName: bootstrap.prepareWorktree.baseBranch,
                fallbackRemoteName: "origin",
              });
              worktreeBaseRef = resolvedRemoteBase.commitSha;
            }
          }
          let preparedBranch = bootstrap.prepareWorktree.branch ?? worktreeBaseRef;
          if (preparedWorktreePath === null) {
            const worktree = yield* gitWorkflow.createWorktree({
              cwd: bootstrap.prepareWorktree.projectCwd,
              refName: worktreeBaseRef,
              ...(reusePreparedBranch ? {} : { newRefName: bootstrap.prepareWorktree.branch }),
              baseRefName: bootstrap.prepareWorktree.baseBranch,
              path: null,
            });
            targetWorktreePath = worktree.worktree.path;
            preparedBranch = worktree.worktree.refName;
          } else {
            targetWorktreePath = preparedWorktreePath;
          }
          yield* dispatch(
            {
              type: "thread.meta.update",
              commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
              threadId: command.threadId,
              branch: preparedBranch,
              worktreePath: targetWorktreePath,
            },
            origin,
          );
          if (input.onPrepared !== undefined) {
            yield* input.onPrepared({
              branch: preparedBranch,
              worktreePath: targetWorktreePath,
            });
            preparedFenceSucceeded = true;
          }
          yield* refreshGitStatus(targetWorktreePath);
        }

        yield* runSetupProgram();

        return yield* dispatch(finalTurnStartCommand, origin);
      });

      return yield* launchProgram.pipe(
        Effect.catchCause((cause) => {
          const dispatchError = setupDispatchRecorded
            ? new OrchestrationDispatchCommandError({
                message: THREAD_LAUNCH_SETUP_OUTCOME_UNCERTAIN,
                cause,
              })
            : toBootstrapDispatchCommandCauseError(cause);
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.fail(dispatchError);
          }
          return Effect.uninterruptible(cleanupCreatedThread()).pipe(
            Effect.matchCauseEffect({
              onFailure: (cleanupCause) =>
                Effect.logWarning("bootstrap thread cleanup failed", {
                  threadId: command.threadId,
                  detail: Cause.pretty(cleanupCause),
                }).pipe(Effect.flatMap(() => Effect.fail(dispatchError))),
              onSuccess: (threadDeleted) =>
                Effect.fail(
                  threadDeleted
                    ? new OrchestrationDispatchCommandError({
                        message: dispatchError.message,
                        ...(dispatchError.cause !== undefined
                          ? { cause: dispatchError.cause }
                          : {}),
                        bootstrapThreadDisposition: "deleted",
                      })
                    : dispatchError,
                ),
            }),
          );
        }),
      );
    },
  );

  return ThreadLaunchService.of({ launch });
});

export const layer = Layer.effect(ThreadLaunchService, make);
