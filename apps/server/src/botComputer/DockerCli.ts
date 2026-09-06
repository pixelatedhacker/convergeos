import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

const DockerPortBinding = Schema.Struct({
  HostIp: Schema.String,
  HostPort: Schema.String,
});

const DockerContainerInspect = Schema.Struct({
  Id: Schema.String,
  State: Schema.Struct({
    Status: Schema.String,
    Running: Schema.Boolean,
    Error: Schema.String,
  }),
  Config: Schema.Struct({
    Image: Schema.String,
    Labels: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
  }),
  NetworkSettings: Schema.Struct({
    Ports: Schema.Record(Schema.String, Schema.NullOr(Schema.Array(DockerPortBinding))),
  }),
});
const decodeDockerContainerInspect = Schema.decodeEffect(
  Schema.fromJsonString(DockerContainerInspect),
);

export interface DockerContainerObservation {
  readonly id: string;
  readonly status: string;
  readonly running: boolean;
  readonly error: string;
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly viewerBindings: ReadonlyArray<{ readonly hostIp: string; readonly hostPort: string }>;
}

export type DockerAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly detail: string };

export class DockerCliError extends Schema.TaggedErrorClass<DockerCliError>()("DockerCliError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export function parseDockerContainerInspect(
  raw: string,
): Effect.Effect<DockerContainerObservation, DockerCliError> {
  return Effect.gen(function* () {
    const decoded = yield* decodeDockerContainerInspect(raw).pipe(
      Effect.mapError(
        (cause) =>
          new DockerCliError({
            operation: "container inspect",
            detail: "Docker returned invalid container inspection output.",
            cause,
          }),
      ),
    );
    return {
      id: decoded.Id,
      status: decoded.State.Status,
      running: decoded.State.Running,
      error: decoded.State.Error,
      image: decoded.Config.Image,
      labels: decoded.Config.Labels ?? {},
      viewerBindings: (decoded.NetworkSettings.Ports["6080/tcp"] ?? []).map((binding) => ({
        hostIp: binding.HostIp,
        hostPort: binding.HostPort,
      })),
    };
  });
}

export class DockerCli extends Context.Service<
  DockerCli,
  {
    readonly probe: Effect.Effect<DockerAvailability>;
    readonly inspectContainer: (
      name: string,
    ) => Effect.Effect<DockerContainerObservation | null, DockerCliError>;
    readonly imageExists: (image: string) => Effect.Effect<boolean, DockerCliError>;
    readonly buildImage: (image: string, dockerfile: string) => Effect.Effect<void, DockerCliError>;
    readonly createContainer: (args: ReadonlyArray<string>) => Effect.Effect<void, DockerCliError>;
    readonly startContainer: (name: string) => Effect.Effect<void, DockerCliError>;
    readonly stopContainer: (name: string) => Effect.Effect<void, DockerCliError>;
    readonly removeContainer: (name: string) => Effect.Effect<void, DockerCliError>;
    readonly removeVolume: (name: string) => Effect.Effect<void, DockerCliError>;
    readonly execContainer: (
      name: string,
      args: ReadonlyArray<string>,
      maxOutputBytes?: number,
    ) => Effect.Effect<string, DockerCliError>;
  }
>()("t3/botComputer/DockerCli") {}

const missingContainer = (stderr: string): boolean => /no such (object|container)/i.test(stderr);
const missingImage = (stderr: string): boolean => /no such image/i.test(stderr);
const missingVolume = (stderr: string): boolean => /no such volume/i.test(stderr);

export const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;

  const run = Effect.fn("DockerCli.run")(function* (
    operation: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly stdin?: string;
      readonly timeout?: number;
      readonly maxOutputBytes?: number;
    },
  ) {
    const result = yield* runner
      .run({
        command: "docker",
        args,
        ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
        timeout: options?.timeout ?? 30_000,
        maxOutputBytes: options?.maxOutputBytes ?? 1_000_000,
        outputMode: "error",
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new DockerCliError({
              operation,
              detail: `Docker could not complete ${operation}.`,
              cause,
            }),
        ),
      );
    if (result.stdoutInvalidUtf8 || result.stderrInvalidUtf8) {
      return yield* new DockerCliError({
        operation,
        detail: `Docker returned invalid UTF-8 during ${operation}.`,
      });
    }
    return result;
  });

  const probe = run("availability probe", ["version", "--format", "{{json .Server.Version}}"]).pipe(
    Effect.map((result): DockerAvailability =>
      result.code === 0
        ? { available: true }
        : { available: false, detail: "Docker is installed but its daemon is unavailable." },
    ),
    Effect.orElseSucceed(
      () =>
        ({
          available: false,
          detail: "Docker is unavailable on this environment.",
        }) satisfies DockerAvailability,
    ),
  );

  const inspectContainer = Effect.fn("DockerCli.inspectContainer")(function* (name: string) {
    const result = yield* run("container inspect", [
      "container",
      "inspect",
      name,
      "--format",
      "{{json .}}",
    ]);
    if (result.code !== 0) {
      if (missingContainer(result.stderr)) return null;
      return yield* new DockerCliError({
        operation: "container inspect",
        detail: "Docker could not inspect the Bot computer container.",
      });
    }
    return yield* parseDockerContainerInspect(result.stdout.trim());
  });

  const imageExists = Effect.fn("DockerCli.imageExists")(function* (image: string) {
    const result = yield* run("image inspect", ["image", "inspect", image]);
    if (result.code === 0) return true;
    if (missingImage(result.stderr)) return false;
    return yield* new DockerCliError({
      operation: "image inspect",
      detail: "Docker could not inspect the Bot computer image.",
    });
  });

  const expectSuccess = Effect.fn("DockerCli.expectSuccess")(function* (
    operation: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly stdin?: string;
      readonly timeout?: number;
      readonly maxOutputBytes?: number;
    },
  ) {
    const result = yield* run(operation, args, options);
    if (result.code !== 0) {
      return yield* new DockerCliError({
        operation,
        detail: `Docker could not complete ${operation}.`,
      });
    }
  });

  return DockerCli.of({
    probe,
    inspectContainer,
    imageExists,
    buildImage: (image, dockerfile) =>
      expectSuccess("image build", ["build", "--tag", image, "-"], {
        stdin: dockerfile,
        timeout: 15 * 60_000,
      }),
    createContainer: (args) => expectSuccess("container create", args),
    startContainer: (name) => expectSuccess("container start", ["container", "start", name]),
    stopContainer: (name) =>
      expectSuccess("container stop", ["container", "stop", "--time", "10", name]),
    removeContainer: (name) =>
      expectSuccess("container remove", ["container", "rm", "--force", name]),
    removeVolume: (name) =>
      run("profile volume remove", ["volume", "rm", "--force", name]).pipe(
        Effect.flatMap((result) =>
          result.code === 0 || missingVolume(result.stderr)
            ? Effect.void
            : Effect.fail(
                new DockerCliError({
                  operation: "profile volume remove",
                  detail: "Docker could not remove the Bot browser profile volume.",
                }),
              ),
        ),
      ),
    execContainer: (name, args, maxOutputBytes = 1_000_000) =>
      run("container exec", ["container", "exec", name, ...args], {
        timeout: 30_000,
        maxOutputBytes,
      }).pipe(
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed(result.stdout)
            : Effect.fail(
                new DockerCliError({
                  operation: "container exec",
                  detail: "Docker could not execute the Bot computer control command.",
                }),
              ),
        ),
      ),
  });
});

export const layer = Layer.effect(DockerCli, make).pipe(Layer.provide(ProcessRunner.layer));
