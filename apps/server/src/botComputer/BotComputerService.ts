import {
  BOT_COMPUTER_ISOLATION_WARNING,
  BotComputerAuthorizationError,
  BotComputerControlError,
  BotComputerOperationError,
  type BotComputerActionResult,
  type BotComputerClickInput,
  type BotComputerInput,
  type BotComputerNetworkAccess,
  type BotComputerPressInput,
  type BotComputerRunningState,
  type BotComputerScrollInput,
  type BotComputerSnapshot,
  type BotComputerStartInput,
  type BotComputerState,
  type BotComputerTypeInput,
  type ThreadId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { BOT_COMPUTER_DOCKERFILE } from "./BotComputerImage.ts";
import {
  BOT_COMPUTER_MAX_SCREENSHOT_BASE64_BYTES,
  decodeScreenshotBase64,
  makeClickCommand,
  makePressCommand,
  makeScrollCommand,
  makeSnapshotCaptureCommand,
  makeSnapshotCleanupCommand,
  makeSnapshotEncodeCommand,
  makeTypeCommand,
} from "./BotComputerControl.ts";
import {
  BOT_COMPUTER_IMAGE,
  BOT_COMPUTER_LABEL,
  BOT_COMPUTER_NETWORK_LABEL,
  BOT_COMPUTER_OWNER_LABEL,
  BOT_COMPUTER_SPEC_LABEL,
  BOT_COMPUTER_SPEC_VERSION,
  makeBotComputerCreateArgs,
  makeBotComputerIdentity,
  type BotComputerIdentity,
} from "./BotComputerSpec.ts";
import * as DockerCli from "./DockerCli.ts";

type BotComputerOperation = Extract<BotComputerState, { status: "failed" }>["operation"];
type BotComputerControlOperation = BotComputerControlError["operation"];
type BotComputerServiceError =
  | BotComputerAuthorizationError
  | BotComputerOperationError
  | BotComputerControlError;

interface AuthorizedBotComputer {
  readonly threadId: ThreadId;
  readonly worktreePath: string;
  readonly identity: BotComputerIdentity;
}

const baseState = (threadId: ThreadId) => ({
  threadId,
  viewerAccess: "authenticated-remote" as const,
  isolation: "container" as const,
  warning: BOT_COMPUTER_ISOLATION_WARNING,
});

function failedState(
  target: Pick<AuthorizedBotComputer, "threadId">,
  operation: BotComputerOperation,
  detail: string,
  containerId?: string,
): BotComputerState {
  return {
    ...baseState(target.threadId),
    status: "failed",
    operation,
    detail,
    ...(containerId === undefined ? {} : { containerId }),
  };
}

function ownsContainer(
  observation: DockerCli.DockerContainerObservation,
  identity: BotComputerIdentity,
): boolean {
  return (
    observation.labels[BOT_COMPUTER_LABEL] === "1" &&
    observation.labels[BOT_COMPUTER_OWNER_LABEL] === identity.ownerHash
  );
}

function currentSpecMatches(observation: DockerCli.DockerContainerObservation): boolean {
  return (
    observation.image === BOT_COMPUTER_IMAGE &&
    observation.labels[BOT_COMPUTER_SPEC_LABEL] === BOT_COMPUTER_SPEC_VERSION
  );
}

function networkAccessFromObservation(
  observation: DockerCli.DockerContainerObservation,
): BotComputerNetworkAccess | null {
  const value = observation.labels[BOT_COMPUTER_NETWORK_LABEL];
  return value === "outbound" ? value : null;
}

export function stateFromDockerObservation(
  target: Pick<AuthorizedBotComputer, "threadId" | "identity">,
  observation: DockerCli.DockerContainerObservation | null,
  operation: BotComputerOperation = "inspect",
): BotComputerState {
  if (observation === null) {
    return { ...baseState(target.threadId), status: "absent" };
  }
  if (!ownsContainer(observation, target.identity)) {
    return failedState(
      target,
      operation,
      "The deterministic container name is owned by another Docker resource.",
      observation.id,
    );
  }
  const networkAccess = networkAccessFromObservation(observation);
  if (networkAccess === null) {
    return failedState(
      target,
      operation,
      "The container has no valid Bot computer network policy label.",
      observation.id,
    );
  }
  if (observation.running && observation.status === "running") {
    const binding = observation.viewerBindings.find(
      ({ hostIp, hostPort }) =>
        (hostIp === "127.0.0.1" || hostIp === "::1") && /^\d+$/.test(hostPort),
    );
    const port = binding === undefined ? 0 : Number(binding.hostPort);
    if (port < 1 || port > 65_535) {
      return failedState(
        target,
        operation,
        "The running container has no valid loopback-only viewer binding.",
        observation.id,
      );
    }
    return {
      ...baseState(target.threadId),
      status: "running",
      containerId: observation.id,
      networkAccess,
    };
  }
  if (
    !observation.running &&
    (observation.status === "created" || observation.status === "exited")
  ) {
    return {
      ...baseState(target.threadId),
      status: "suspended",
      containerId: observation.id,
      networkAccess,
    };
  }
  return failedState(
    target,
    operation,
    observation.error.trim() || `Docker reported container state '${observation.status}'.`,
    observation.id,
  );
}

export class BotComputerService extends Context.Service<
  BotComputerService,
  {
    readonly inspect: (
      input: BotComputerInput,
    ) => Effect.Effect<BotComputerState, BotComputerAuthorizationError | BotComputerOperationError>;
    readonly start: (
      input: BotComputerStartInput,
    ) => Effect.Effect<BotComputerState, BotComputerAuthorizationError | BotComputerOperationError>;
    readonly suspend: (
      input: BotComputerInput,
    ) => Effect.Effect<BotComputerState, BotComputerAuthorizationError | BotComputerOperationError>;
    readonly resume: (
      input: BotComputerStartInput,
    ) => Effect.Effect<BotComputerState, BotComputerAuthorizationError | BotComputerOperationError>;
    readonly reset: (
      input: BotComputerStartInput,
    ) => Effect.Effect<BotComputerState, BotComputerAuthorizationError | BotComputerOperationError>;
    readonly destroy: (
      input: BotComputerInput,
    ) => Effect.Effect<BotComputerState, BotComputerAuthorizationError | BotComputerOperationError>;
    readonly viewerTarget: (
      input: BotComputerInput,
    ) => Effect.Effect<
      { readonly containerId: string; readonly viewerPort: number },
      BotComputerServiceError
    >;
    readonly computerStatus: (
      input: BotComputerInput,
    ) => Effect.Effect<BotComputerRunningState, BotComputerServiceError>;
    readonly snapshot: (
      input: BotComputerInput,
    ) => Effect.Effect<BotComputerSnapshot, BotComputerServiceError>;
    readonly click: (
      input: BotComputerInput & BotComputerClickInput,
    ) => Effect.Effect<BotComputerActionResult, BotComputerServiceError>;
    readonly type: (
      input: BotComputerInput & BotComputerTypeInput,
    ) => Effect.Effect<BotComputerActionResult, BotComputerServiceError>;
    readonly press: (
      input: BotComputerInput & BotComputerPressInput,
    ) => Effect.Effect<BotComputerActionResult, BotComputerServiceError>;
    readonly scroll: (
      input: BotComputerInput & BotComputerScrollInput,
    ) => Effect.Effect<BotComputerActionResult, BotComputerServiceError>;
  }
>()("t3/botComputer/BotComputerService") {}

export const make = Effect.gen(function* () {
  const docker = yield* DockerCli.DockerCli;
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const platform = yield* HostProcessPlatform;
  const mutationLock = yield* Semaphore.make(1);
  const viewerInspections = yield* SynchronizedRef.make(
    new Map<string, ReturnType<typeof docker.inspectContainer>>(),
  );

  const inspectViewerTarget = (containerName: string) =>
    SynchronizedRef.modifyEffect(viewerInspections, (inspections) => {
      const pending = inspections.get(containerName);
      if (pending !== undefined) return Effect.succeed([pending, inspections] as const);
      return Effect.cached(docker.inspectContainer(containerName)).pipe(
        Effect.map((cached) => {
          let shared = cached;
          shared = cached.pipe(
            Effect.ensuring(
              SynchronizedRef.update(viewerInspections, (current) => {
                if (current.get(containerName) !== shared) return current;
                const next = new Map(current);
                next.delete(containerName);
                return next;
              }),
            ),
          );
          const next = new Map(inspections);
          next.set(containerName, shared);
          return [shared, next] as const;
        }),
      );
    }).pipe(Effect.flatten);

  const authorize = Effect.fn("BotComputerService.authorize")(function* (
    input: BotComputerInput,
    operation: BotComputerOperation,
  ) {
    const thread = yield* query.getThreadShellById(input.threadId).pipe(
      Effect.mapError(
        () =>
          new BotComputerOperationError({
            threadId: input.threadId,
            operation,
            message: "The Bot thread could not be read.",
          }),
      ),
    );
    if (Option.isNone(thread)) {
      return yield* new BotComputerAuthorizationError({
        threadId: input.threadId,
        reason: "thread-unavailable",
      });
    }
    if (thread.value.botProfile == null) {
      return yield* new BotComputerAuthorizationError({
        threadId: input.threadId,
        reason: "not-bot",
      });
    }
    if (thread.value.worktreePath === null) {
      return yield* new BotComputerAuthorizationError({
        threadId: input.threadId,
        reason: "worktree-unavailable",
      });
    }
    const project = yield* query.getProjectShellById(thread.value.projectId).pipe(
      Effect.mapError(
        () =>
          new BotComputerOperationError({
            threadId: input.threadId,
            operation,
            message: "The Bot project could not be read.",
          }),
      ),
    );
    if (Option.isNone(project)) {
      return yield* new BotComputerAuthorizationError({
        threadId: input.threadId,
        reason: "project-unavailable",
      });
    }
    if (
      normalizeProjectPathForComparison(thread.value.worktreePath) ===
      normalizeProjectPathForComparison(project.value.workspaceRoot)
    ) {
      return yield* new BotComputerAuthorizationError({
        threadId: input.threadId,
        reason: "worktree-not-isolated",
      });
    }
    return {
      threadId: input.threadId,
      worktreePath: thread.value.worktreePath,
      identity: makeBotComputerIdentity(yield* environment.getEnvironmentId, input.threadId),
    } satisfies AuthorizedBotComputer;
  });

  const unavailable = (
    target: AuthorizedBotComputer,
    reason: "unsupported-platform" | "docker-unavailable",
    detail: string,
  ): BotComputerState => ({ ...baseState(target.threadId), status: "unavailable", reason, detail });

  const inspectAuthorized = Effect.fn("BotComputerService.inspectAuthorized")(function* (
    target: AuthorizedBotComputer,
    operation: BotComputerOperation,
  ) {
    if (platform !== "linux" && platform !== "darwin") {
      return unavailable(
        target,
        "unsupported-platform",
        "Bot computers require a Linux-compatible Docker host.",
      );
    }
    const availability = yield* docker.probe;
    if (!availability.available) {
      return unavailable(target, "docker-unavailable", availability.detail);
    }
    return yield* docker.inspectContainer(target.identity.containerName).pipe(
      Effect.match({
        onFailure: (error) => failedState(target, operation, error.message),
        onSuccess: (observation) => stateFromDockerObservation(target, observation, operation),
      }),
    );
  });

  const observeAfter = Effect.fn("BotComputerService.observeAfter")(function* (
    target: AuthorizedBotComputer,
    operation: BotComputerOperation,
  ) {
    return yield* docker.inspectContainer(target.identity.containerName).pipe(
      Effect.match({
        onFailure: (error) => failedState(target, operation, error.message),
        onSuccess: (observation) => stateFromDockerObservation(target, observation, operation),
      }),
    );
  });

  const ensureImage = Effect.fn("BotComputerService.ensureImage")(function* () {
    const exists = yield* docker.imageExists(BOT_COMPUTER_IMAGE);
    if (!exists) yield* docker.buildImage(BOT_COMPUTER_IMAGE, BOT_COMPUTER_DOCKERFILE);
  });

  const convergeToRunning = Effect.fn("BotComputerService.convergeToRunning")(function* (
    target: AuthorizedBotComputer,
    operation: "start" | "resume" | "reset",
    networkAccess: BotComputerNetworkAccess,
  ) {
    const initial = yield* docker.inspectContainer(target.identity.containerName);
    if (initial !== null && !ownsContainer(initial, target.identity)) {
      return stateFromDockerObservation(target, initial, operation);
    }
    if (
      initial?.running === true &&
      initial.status === "running" &&
      currentSpecMatches(initial) &&
      networkAccessFromObservation(initial) === networkAccess
    ) {
      const running = stateFromDockerObservation(target, initial, operation);
      if (running.status === "running") return running;
    }

    yield* ensureImage();
    if (
      initial !== null &&
      (!currentSpecMatches(initial) || networkAccessFromObservation(initial) !== networkAccess)
    ) {
      yield* docker.removeContainer(target.identity.containerName);
    } else if (initial !== null && initial.status !== "created" && initial.status !== "exited") {
      yield* docker.removeContainer(target.identity.containerName);
    }

    const afterReconcile = yield* docker.inspectContainer(target.identity.containerName);
    if (afterReconcile === null) {
      yield* docker.createContainer(
        makeBotComputerCreateArgs({
          identity: target.identity,
          worktreePath: target.worktreePath,
          networkAccess,
        }),
      );
    }
    const beforeStart = yield* docker.inspectContainer(target.identity.containerName);
    if (beforeStart === null) {
      return failedState(
        target,
        operation,
        "Docker did not retain the created Bot computer container.",
      );
    }
    if (!ownsContainer(beforeStart, target.identity)) {
      return stateFromDockerObservation(target, beforeStart, operation);
    }
    if (!beforeStart.running) yield* docker.startContainer(target.identity.containerName);
    return yield* observeAfter(target, operation);
  });

  const runMutation = (
    input: BotComputerInput,
    operation: BotComputerOperation,
    effect: (
      target: AuthorizedBotComputer,
    ) => Effect.Effect<BotComputerState, DockerCli.DockerCliError>,
  ) =>
    mutationLock.withPermits(1)(
      Effect.gen(function* () {
        const target = yield* authorize(input, operation);
        const readiness = yield* inspectAuthorized(target, operation);
        if (readiness.status === "unavailable") return readiness;
        return yield* effect(target).pipe(
          Effect.catch((error) => Effect.succeed(failedState(target, operation, error.message))),
        );
      }),
    );

  const inspect: BotComputerService["Service"]["inspect"] = Effect.fn("BotComputerService.inspect")(
    function* (input) {
      const target = yield* authorize(input, "inspect");
      return yield* inspectAuthorized(target, "inspect");
    },
  );

  const start: BotComputerService["Service"]["start"] = (input) =>
    runMutation(input, "start", (target) =>
      convergeToRunning(target, "start", input.networkAccess),
    );

  const resume: BotComputerService["Service"]["resume"] = (input) =>
    runMutation(input, "resume", (target) =>
      convergeToRunning(target, "resume", input.networkAccess),
    );

  const suspend: BotComputerService["Service"]["suspend"] = (input) =>
    runMutation(input, "suspend", (target) =>
      Effect.gen(function* () {
        const observation = yield* docker.inspectContainer(target.identity.containerName);
        if (observation === null) return stateFromDockerObservation(target, null, "suspend");
        if (!ownsContainer(observation, target.identity)) {
          return stateFromDockerObservation(target, observation, "suspend");
        }
        if (observation.running) yield* docker.stopContainer(target.identity.containerName);
        return yield* observeAfter(target, "suspend");
      }),
    );

  const destroyAuthorized = Effect.fn("BotComputerService.destroyAuthorized")(function* (
    target: AuthorizedBotComputer,
    operation: "destroy" | "reset",
  ) {
    const observation = yield* docker.inspectContainer(target.identity.containerName);
    if (observation !== null) {
      if (!ownsContainer(observation, target.identity)) {
        return stateFromDockerObservation(target, observation, operation);
      }
      yield* docker.removeContainer(target.identity.containerName);
    }
    yield* docker.removeVolume(target.identity.profileVolumeName);
    return yield* observeAfter(target, operation);
  });

  const destroy: BotComputerService["Service"]["destroy"] = (input) =>
    runMutation(input, "destroy", (target) => destroyAuthorized(target, "destroy"));

  const reset: BotComputerService["Service"]["reset"] = (input) =>
    runMutation(input, "reset", (target) =>
      Effect.gen(function* () {
        const destroyed = yield* destroyAuthorized(target, "reset");
        if (destroyed.status !== "absent") return destroyed;
        return yield* convergeToRunning(target, "reset", input.networkAccess);
      }),
    );

  const requireRunning = Effect.fn("BotComputerService.requireRunning")(function* (
    input: BotComputerInput,
    operation: BotComputerControlOperation,
  ) {
    const target = yield* authorize(input, "inspect");
    const state = yield* inspectAuthorized(target, "inspect");
    if (state.status !== "running" || state.viewerAccess !== "authenticated-remote") {
      return yield* new BotComputerControlError({
        threadId: input.threadId,
        operation,
        reason: "not-running",
        detail: `The Bot computer is ${state.status}; start or resume it before using computer tools.`,
      });
    }
    return { target, state };
  });

  const executeControl = Effect.fn("BotComputerService.executeControl")(function* (
    input: BotComputerInput,
    operation: Exclude<BotComputerControlOperation, "status" | "snapshot">,
    command: ReadonlyArray<string>,
  ) {
    return yield* mutationLock.withPermits(1)(
      Effect.gen(function* () {
        const { state } = yield* requireRunning(input, operation);
        yield* docker.execContainer(state.containerId, command).pipe(
          Effect.mapError(
            (error) =>
              new BotComputerControlError({
                threadId: input.threadId,
                operation,
                reason: "execution-failed",
                detail: error.message,
              }),
          ),
        );
        return {};
      }),
    );
  });

  const computerStatus: BotComputerService["Service"]["computerStatus"] = (input) =>
    requireRunning(input, "status").pipe(Effect.map(({ state }) => state));

  const viewerTarget: BotComputerService["Service"]["viewerTarget"] = Effect.fn(
    "BotComputerService.viewerTarget",
  )(function* (input) {
    const target = yield* authorize(input, "inspect");
    if (platform !== "linux" && platform !== "darwin") {
      return yield* new BotComputerControlError({
        threadId: input.threadId,
        operation: "status",
        reason: "not-running",
        detail: "Bot computers require a Linux-compatible Docker host.",
      });
    }
    const observation = yield* inspectViewerTarget(target.identity.containerName).pipe(
      Effect.mapError(
        (error) =>
          new BotComputerOperationError({
            threadId: input.threadId,
            operation: "inspect",
            message: error.message,
          }),
      ),
    );
    const state = stateFromDockerObservation(target, observation, "inspect");
    if (state.status !== "running" || state.viewerAccess !== "authenticated-remote") {
      return yield* new BotComputerControlError({
        threadId: input.threadId,
        operation: "status",
        reason: "not-running",
        detail: `The Bot computer is ${state.status}; start or resume it before viewing it.`,
      });
    }
    const binding = observation?.viewerBindings.find(
      ({ hostIp, hostPort }) =>
        (hostIp === "127.0.0.1" || hostIp === "::1") && /^\d+$/.test(hostPort),
    );
    const viewerPort = binding === undefined ? 0 : Number(binding.hostPort);
    if (observation?.id !== state.containerId || viewerPort < 1 || viewerPort > 65_535) {
      return yield* new BotComputerControlError({
        threadId: input.threadId,
        operation: "status",
        reason: "not-running",
        detail: "The running Bot computer has no valid viewer endpoint.",
      });
    }
    return { containerId: state.containerId, viewerPort };
  });

  const snapshot: BotComputerService["Service"]["snapshot"] = (input) =>
    mutationLock.withPermits(1)(
      Effect.gen(function* () {
        const { state } = yield* requireRunning(input, "snapshot");
        const encoded = yield* Effect.acquireUseRelease(
          docker.execContainer(state.containerId, makeSnapshotCaptureCommand()),
          () =>
            docker.execContainer(
              state.containerId,
              makeSnapshotEncodeCommand(),
              BOT_COMPUTER_MAX_SCREENSHOT_BASE64_BYTES,
            ),
          () =>
            docker
              .execContainer(state.containerId, makeSnapshotCleanupCommand())
              .pipe(Effect.ignore),
        ).pipe(
          Effect.mapError(
            (error) =>
              new BotComputerControlError({
                threadId: input.threadId,
                operation: "snapshot",
                reason: "execution-failed",
                detail: error.message,
              }),
          ),
        );
        const decoded = decodeScreenshotBase64(encoded);
        if (decoded === null) {
          return yield* new BotComputerControlError({
            threadId: input.threadId,
            operation: "snapshot",
            reason: "invalid-screenshot",
            detail: "The Bot computer returned an invalid or oversized PNG screenshot.",
          });
        }
        return { mimeType: "image/png", ...decoded };
      }),
    );

  const click: BotComputerService["Service"]["click"] = (input) =>
    executeControl(input, "click", makeClickCommand(input));
  const type: BotComputerService["Service"]["type"] = (input) =>
    executeControl(input, "type", makeTypeCommand(input));
  const press: BotComputerService["Service"]["press"] = (input) =>
    executeControl(input, "press", makePressCommand(input));
  const scroll: BotComputerService["Service"]["scroll"] = (input) =>
    executeControl(input, "scroll", makeScrollCommand(input));

  return BotComputerService.of({
    inspect,
    start,
    suspend,
    resume,
    reset,
    destroy,
    viewerTarget,
    computerStatus,
    snapshot,
    click,
    type,
    press,
    scroll,
  });
});

export const layer = Layer.effect(BotComputerService, make).pipe(Layer.provide(DockerCli.layer));
