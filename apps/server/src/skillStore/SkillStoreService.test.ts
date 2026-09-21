import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { StandardCommand } from "effect/unstable/process/ChildProcess";
import { ProjectId, SkillStoreError } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as SkillStoreService from "./SkillStoreService.ts";

interface FakeInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
}

interface FakeExit {
  readonly code: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

const encode = (value: string) => new TextEncoder().encode(value);

const makeFakeSpawner = (
  invocations: Array<FakeInvocation>,
  behavior?: (command: StandardCommand) => FakeExit,
) =>
  ChildProcessSpawner.make((command) => {
    if (command._tag !== "StandardCommand") {
      return Effect.die("piped commands are not supported in this test");
    }
    invocations.push({
      command: command.command,
      args: command.args,
      cwd: command.options.cwd,
    });
    const exit = behavior?.(command) ?? { code: 0, stdout: "{}" };
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exit.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(encode(exit.stdout ?? "")),
        stderr: Stream.make(encode(exit.stderr ?? "")),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    );
  });

const makeServiceLayer = (
  config: ServerConfig.ServerConfig["Service"],
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) =>
  SkillStoreService.layer.pipe(
    Layer.provideMerge(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(Layer.succeed(ServerConfig.ServerConfig, config)),
  );

const resolveProjectCwd: SkillStoreService.ResolveProjectCwd = () =>
  Effect.succeed("/tmp/fake-project");

const INSTALL_INPUT = {
  source: "vercel-labs/skills",
  skillId: "find-skills",
  name: "Find Skills",
  description: null,
} as const;

it.layer(NodeServices.layer)("SkillStoreService", (it) => {
  const withConfig = <A, E, R>(
    use: (config: ServerConfig.ServerConfig["Service"]) => Effect.Effect<A, E, R>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const configContext = yield* Layer.build(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-skill-store-test-" }),
        );
        const config = Context.get(configContext, ServerConfig.ServerConfig);
        return yield* use(config);
      }),
    );

  it.effect("install runs the CLI per target and records the manifest", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const invocations: Array<FakeInvocation> = [];
        const serviceLayer = makeServiceLayer(config, makeFakeSpawner(invocations));
        const record = yield* Effect.gen(function* () {
          const service = yield* SkillStoreService.SkillStoreService;
          return yield* service.install(
            {
              ...INSTALL_INPUT,
              targets: [{ scope: "global", harnesses: ["codex", "cursor"] }],
            },
            resolveProjectCwd,
          );
        }).pipe(Effect.provide(serviceLayer));

        assert.strictEqual(record.id, "vercel-labs/skills/find-skills");
        assert.deepStrictEqual(record.targets, [
          { scope: "global", harnesses: ["codex", "cursor"] },
        ]);
        assert.strictEqual(invocations.length, 1);
        const args = invocations[0]?.args ?? [];
        assert.deepStrictEqual(args.slice(1), [
          "add",
          "vercel-labs/skills",
          "--skill",
          "find-skills",
          "--agent",
          "codex",
          "cursor",
          "--global",
          "--yes",
          "--json",
        ]);
      }),
    ),
  );

  it.effect("repeat installs union harnesses on the existing target", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const invocations: Array<FakeInvocation> = [];
        const serviceLayer = makeServiceLayer(config, makeFakeSpawner(invocations));
        const record = yield* Effect.gen(function* () {
          const service = yield* SkillStoreService.SkillStoreService;
          yield* service.install(
            { ...INSTALL_INPUT, targets: [{ scope: "global", harnesses: ["codex"] }] },
            resolveProjectCwd,
          );
          return yield* service.install(
            { ...INSTALL_INPUT, targets: [{ scope: "global", harnesses: ["cursor"] }] },
            resolveProjectCwd,
          );
        }).pipe(Effect.provide(serviceLayer));

        assert.deepStrictEqual(record.targets, [
          { scope: "global", harnesses: ["codex", "cursor"] },
        ]);
        assert.strictEqual(invocations.length, 2);
      }),
    ),
  );

  it.effect("project scope resolves the project cwd and omits --global", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const invocations: Array<FakeInvocation> = [];
        const serviceLayer = makeServiceLayer(config, makeFakeSpawner(invocations));
        yield* Effect.gen(function* () {
          const service = yield* SkillStoreService.SkillStoreService;
          return yield* service.install(
            {
              ...INSTALL_INPUT,
              targets: [
                {
                  scope: "project",
                  projectId: ProjectId.make("project-1"),
                  harnesses: ["claude-code"],
                },
              ],
            },
            resolveProjectCwd,
          );
        }).pipe(Effect.provide(serviceLayer));

        assert.strictEqual(invocations.length, 1);
        assert.strictEqual(invocations[0]?.cwd, "/tmp/fake-project");
        assert.isFalse((invocations[0]?.args ?? []).includes("--global"));
      }),
    ),
  );

  it.effect("a failed target still persists the targets that already landed", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const invocations: Array<FakeInvocation> = [];
        // Fail only the project-scope invocation (the second target).
        const spawner = makeFakeSpawner(invocations, (command) =>
          command.args.includes("--global")
            ? { code: 0, stdout: "{}" }
            : { code: 1, stderr: "boom" },
        );
        const serviceLayer = makeServiceLayer(config, spawner);
        const result = yield* Effect.gen(function* () {
          const service = yield* SkillStoreService.SkillStoreService;
          const installExit = yield* service
            .install(
              {
                ...INSTALL_INPUT,
                targets: [
                  { scope: "global", harnesses: ["codex"] },
                  {
                    scope: "project",
                    projectId: ProjectId.make("project-1"),
                    harnesses: ["codex"],
                  },
                ],
              },
              resolveProjectCwd,
            )
            .pipe(Effect.flip);
          const listed = yield* service.listInstalled;
          return { installExit, listed };
        }).pipe(Effect.provide(serviceLayer));

        assert.instanceOf(result.installExit, SkillStoreError);
        assert.strictEqual(result.installExit.reason, "installFailed");
        assert.strictEqual(result.listed.skills.length, 1);
        assert.deepStrictEqual(result.listed.skills[0]?.targets, [
          { scope: "global", harnesses: ["codex"] },
        ]);
      }),
    ),
  );

  it.effect("setHarnessEnabled removes only the toggled harness", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const invocations: Array<FakeInvocation> = [];
        const serviceLayer = makeServiceLayer(config, makeFakeSpawner(invocations));
        const record = yield* Effect.gen(function* () {
          const service = yield* SkillStoreService.SkillStoreService;
          yield* service.install(
            { ...INSTALL_INPUT, targets: [{ scope: "global", harnesses: ["codex", "cursor"] }] },
            resolveProjectCwd,
          );
          return yield* service.setHarnessEnabled(
            {
              id: "vercel-labs/skills/find-skills",
              scope: "global",
              harness: "codex",
              enabled: false,
            },
            resolveProjectCwd,
          );
        }).pipe(Effect.provide(serviceLayer));

        assert.deepStrictEqual(record.targets, [{ scope: "global", harnesses: ["cursor"] }]);
        const removeInvocation = invocations.find((invocation) =>
          invocation.args.includes("remove"),
        );
        assert.deepStrictEqual(removeInvocation?.args.slice(1), [
          "remove",
          "find-skills",
          "--agent",
          "codex",
          "--global",
          "--yes",
          "--json",
        ]);
      }),
    ),
  );

  it.effect("setHarnessEnabled on an unknown skill fails notFound", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const serviceLayer = makeServiceLayer(config, makeFakeSpawner([]));
        const error = yield* Effect.gen(function* () {
          const service = yield* SkillStoreService.SkillStoreService;
          return yield* service
            .setHarnessEnabled(
              {
                id: "vercel-labs/skills/find-skills",
                scope: "global",
                harness: "codex",
                enabled: false,
              },
              resolveProjectCwd,
            )
            .pipe(Effect.flip);
        }).pipe(Effect.provide(serviceLayer));

        assert.instanceOf(error, SkillStoreError);
        assert.strictEqual(error.reason, "notFound");
      }),
    ),
  );

  it.effect("uninstall removes every target and drops the record", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const invocations: Array<FakeInvocation> = [];
        const serviceLayer = makeServiceLayer(config, makeFakeSpawner(invocations));
        const listed = yield* Effect.gen(function* () {
          const service = yield* SkillStoreService.SkillStoreService;
          yield* service.install(
            {
              ...INSTALL_INPUT,
              targets: [
                { scope: "global", harnesses: ["codex"] },
                {
                  scope: "project",
                  projectId: ProjectId.make("project-1"),
                  harnesses: ["cursor"],
                },
              ],
            },
            resolveProjectCwd,
          );
          yield* service.uninstall({ id: "vercel-labs/skills/find-skills" }, resolveProjectCwd);
          return yield* service.listInstalled;
        }).pipe(Effect.provide(serviceLayer));

        assert.deepStrictEqual(listed.skills, []);
        const removals = invocations.filter((invocation) => invocation.args.includes("remove"));
        assert.strictEqual(removals.length, 2);
        assert.isTrue(removals.some((invocation) => invocation.args.includes("--global")));
        assert.isTrue(removals.some((invocation) => invocation.cwd === "/tmp/fake-project"));
      }),
    ),
  );

  it.effect("the manifest survives a fresh service instance", () =>
    withConfig((config) =>
      Effect.gen(function* () {
        const firstLayer = makeServiceLayer(config, makeFakeSpawner([]));
        yield* Effect.gen(function* () {
          const service = yield* SkillStoreService.SkillStoreService;
          return yield* service.install(
            { ...INSTALL_INPUT, targets: [{ scope: "global", harnesses: ["codex"] }] },
            resolveProjectCwd,
          );
        }).pipe(Effect.provide(firstLayer));

        // A fresh layer build gets an empty in-memory Ref, so this list can
        // only come from the manifest on disk.
        const secondLayer = makeServiceLayer(config, makeFakeSpawner([]));
        const listed = yield* Effect.gen(function* () {
          const service = yield* SkillStoreService.SkillStoreService;
          return yield* service.listInstalled;
        }).pipe(Effect.provide(secondLayer));

        assert.strictEqual(listed.skills.length, 1);
        assert.strictEqual(listed.skills[0]?.id, "vercel-labs/skills/find-skills");
      }),
    ),
  );
});
