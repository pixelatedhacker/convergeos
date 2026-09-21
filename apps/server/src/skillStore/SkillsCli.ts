/**
 * SkillsCli — spawn adapter for the vendored `skills` CLI (vercel-labs/skills).
 *
 * The CLI owns per-harness directory layouts, its own lockfile, and the
 * global-store-plus-symlink install model, so ConvergeOS shells out instead
 * of reimplementing them. The package is a runtime dependency of the server;
 * its bin is resolved through the module graph (`skills/package.json` ->
 * `bin/cli.mjs`) and executed with the current Node binary. When the package
 * cannot be resolved (e.g. a bundled desktop build that tree-shook it away)
 * every operation fails with a typed `cliUnavailable` error.
 *
 * @module skillStore/SkillsCli
 */
import * as NodeModule from "node:module";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcess } from "effect/unstable/process";
import { RegistrySkillStoreError, type SkillStoreHarness, type RegistrySkillStoreScope } from "@t3tools/contracts";

import { spawnAndCollect } from "../provider/providerSnapshot.ts";

/** Installs download the skill bundle; allow real network time but never hang a turn. */
const SKILLS_CLI_TIMEOUT_MS = 120_000;

let resolvedCliPath: string | undefined;

const resolveSkillsCliPath = (): string => {
  if (resolvedCliPath !== undefined) {
    return resolvedCliPath;
  }
  const require = NodeModule.createRequire(import.meta.url);
  const packageJsonPath = require.resolve("skills/package.json");
  // String surgery instead of node:path so this stays lint-clean; mixed
  // separators on Windows are still valid for Node execution.
  resolvedCliPath = `${packageJsonPath.slice(0, -"package.json".length)}bin/cli.mjs`;
  return resolvedCliPath;
};

export interface SkillsCliInvocation {
  readonly args: ReadonlyArray<string>;
  /** Project scope runs in the repo root; global scope runs in the user's home. */
  readonly cwd: string;
}

/**
 * Run the CLI and return stdout. Non-zero exits and timeouts are typed
 * `RegistrySkillStoreError`s; stderr is included in the detail because the CLI puts
 * its real failure message there.
 */
export const runSkillsCli = Effect.fn("SkillsCli.run")(function* (
  invocation: SkillsCliInvocation,
  failureReason: "installFailed" | "removeFailed",
) {
  let cliPath: string;
  try {
    cliPath = resolveSkillsCliPath();
  } catch (cause) {
    return yield* new RegistrySkillStoreError({
      reason: "cliUnavailable",
      detail:
        "The bundled `skills` CLI could not be resolved. Reinstall or update ConvergeOS to restore skill installs.",
      cause,
    });
  }

  const result = yield* spawnAndCollect(
    process.execPath,
    ChildProcess.make(process.execPath, [cliPath, ...invocation.args], {
      cwd: invocation.cwd,
      env: { ...process.env },
    }),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new RegistrySkillStoreError({
          reason: failureReason,
          detail: `\`skills ${invocation.args.join(" ")}\` failed to spawn`,
          cause,
        }),
    ),
    Effect.timeoutOption(SKILLS_CLI_TIMEOUT_MS),
  );

  if (Option.isNone(result)) {
    return yield* new RegistrySkillStoreError({
      reason: failureReason,
      detail: `\`skills ${invocation.args.join(" ")}\` timed out`,
    });
  }
  if (result.value.code !== 0) {
    return yield* new RegistrySkillStoreError({
      reason: failureReason,
      detail:
        result.value.stderr.trim() ||
        result.value.stdout.trim() ||
        `\`skills ${invocation.args.join(" ")}\` exited with code ${result.value.code}`,
    });
  }
  return result.value.stdout;
});

const scopeArgs = (scope: RegistrySkillStoreScope): ReadonlyArray<string> =>
  scope === "global" ? ["--global"] : [];

/**
 * Install one skill into a set of harnesses for one scope. `cwd` must be the
 * project root for project scope and the environment user's home for global
 * scope (the CLI resolves `~/` targets from `HOME`, but a stable cwd keeps
 * project detection from misfiring on the server's own working directory).
 */
export const installSkill = (input: {
  readonly source: string;
  readonly skillId: string;
  readonly harnesses: ReadonlyArray<SkillStoreHarness>;
  readonly scope: RegistrySkillStoreScope;
  readonly cwd: string;
}) =>
  runSkillsCli(
    {
      args: [
        "add",
        input.source,
        "--skill",
        input.skillId,
        "--agent",
        ...input.harnesses,
        ...scopeArgs(input.scope),
        "--yes",
        "--json",
      ],
      cwd: input.cwd,
    },
    "installFailed",
  );

/** Remove one skill from a set of harnesses for one scope. */
export const removeSkill = (input: {
  readonly skillId: string;
  readonly harnesses: ReadonlyArray<SkillStoreHarness>;
  readonly scope: RegistrySkillStoreScope;
  readonly cwd: string;
}) =>
  runSkillsCli(
    {
      args: [
        "remove",
        input.skillId,
        "--agent",
        ...input.harnesses,
        ...scopeArgs(input.scope),
        "--yes",
        "--json",
      ],
      cwd: input.cwd,
    },
    "removeFailed",
  );
