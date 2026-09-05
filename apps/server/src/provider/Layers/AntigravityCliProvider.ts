import {
  type AntigravityCliSettings,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { isWindowsCommandNotFound } from "../../processRunner.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  ProviderCommandNotFoundError,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const HELP_TIMEOUT_MS = 10_000;
const MODEL_CATALOG_TIMEOUT_MS = 45_000;
const HELP_MAX_BYTES = 64 * 1_024;
const CATALOG_MAX_BYTES = 1_024 * 1_024;
const STDERR_MAX_BYTES = 64 * 1_024;
const MAX_MODELS = 2_048;
const MAX_MODEL_STRING_LENGTH = 512;
const PRESENTATION = {
  displayName: "Antigravity CLI",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
};
const MODEL_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [],
});

/** Decode the CLI's tab-separated stdout catalog; stderr contains progress, not models. */
export function parseAntigravityCliModelCatalog(output: string) {
  const models: ServerProviderModel[] = [];
  const seen = new Set<string>();
  let ignoredEntries = 0;
  let truncatedEntries = false;
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    if (models.length === MAX_MODELS) {
      truncatedEntries = true;
      break;
    }
    const columns = line.split("\t");
    const slug = columns[0]?.trim();
    const name = columns[1]?.trim();
    if (
      columns.length !== 2 ||
      !slug ||
      !name ||
      slug.length > MAX_MODEL_STRING_LENGTH ||
      name.length > MAX_MODEL_STRING_LENGTH ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u.test(slug) ||
      Array.from(name).some(
        (character) => character.charCodeAt(0) < 32 || character === "\u007f",
      ) ||
      seen.has(slug)
    ) {
      ignoredEntries += 1;
      continue;
    }
    seen.add(slug);
    models.push({ slug, name, isCustom: false, capabilities: MODEL_CAPABILITIES });
  }
  models.sort((left, right) => left.slug.localeCompare(right.slug));
  return { models, ignoredEntries, truncatedEntries };
}

const runAntigravityCliCommand = Effect.fn("runAntigravityCliCommand")(function* (
  settings: AntigravityCliSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  stdoutMaxBytes: number,
) {
  const binaryPath = settings.binaryPath || "agy";
  const command = yield* resolveSpawnCommand(binaryPath, args, { env: environment });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command.command, command.args, {
      cwd,
      env: environment,
      shell: command.shell,
    }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectUint8StreamText({ stream: child.stdout, maxBytes: stdoutMaxBytes }),
      collectUint8StreamText({ stream: child.stderr, maxBytes: STDERR_MAX_BYTES }),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );
  if (yield* isWindowsCommandNotFound(exitCode, stderr.text)) {
    return yield* new ProviderCommandNotFoundError({
      binaryPath,
      exitCode,
      stdoutLength: stdout.bytes,
      stderrLength: stderr.bytes,
    });
  }
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    code: exitCode,
    invalidOutput: stdout.truncated || stderr.truncated || stdout.invalidUtf8 || stderr.invalidUtf8,
  };
}, Effect.scoped);

function providerDraft(input: {
  readonly enabled: boolean;
  readonly checkedAt: string;
  readonly installed: boolean;
  readonly status: "ready" | "warning" | "error";
  readonly models?: ReadonlyArray<ServerProviderModel>;
  readonly auth?: ServerProviderAuth;
  readonly message: string;
}): ServerProviderDraft {
  return {
    ...buildServerProvider({
      presentation: PRESENTATION,
      enabled: input.enabled,
      checkedAt: input.checkedAt,
      models: input.models ?? [],
      probe: {
        installed: input.installed,
        version: null,
        status: input.status,
        auth: input.auth ?? { status: "unknown" },
        message: input.message,
      },
    }),
    supportedRuntimeModes: ["full-access"],
    supportsConversationRollback: false,
    supportsTextGeneration: false,
  };
}

export const buildInitialAntigravityCliProviderSnapshot = Effect.fn(
  "buildInitialAntigravityCliProviderSnapshot",
)(function* (settings: AntigravityCliSettings) {
  return providerDraft({
    enabled: settings.enabled,
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    installed: settings.enabled,
    status: "warning",
    message: settings.enabled
      ? "Checking Antigravity CLI availability..."
      : "Antigravity CLI is disabled in ConvergeOS settings.",
  });
});

export const checkAntigravityCliProviderStatus = Effect.fn("checkAntigravityCliProviderStatus")(
  function* (
    settings: AntigravityCliSettings,
    environment: NodeJS.ProcessEnv,
    cwd: string,
  ): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const base = { enabled: settings.enabled, checkedAt, installed: true };
    if (!settings.enabled) {
      return providerDraft({
        ...base,
        installed: false,
        status: "warning",
        message: "Antigravity CLI is disabled in ConvergeOS settings.",
      });
    }

    const help = yield* runAntigravityCliCommand(
      settings,
      ["--help"],
      environment,
      cwd,
      HELP_MAX_BYTES,
    ).pipe(Effect.timeoutOption(HELP_TIMEOUT_MS), Effect.result);
    if (Result.isFailure(help)) {
      const missing = isCommandMissingCause(help.failure);
      return providerDraft({
        ...base,
        installed: !missing,
        status: "error",
        message: missing
          ? "Antigravity CLI (`agy`) is not installed or not on PATH. Install it on the server host or configure its executable path."
          : "Failed to execute Antigravity CLI. Check the executable path and retry.",
      });
    }
    if (Option.isNone(help.success)) {
      return providerDraft({
        ...base,
        status: "error",
        message:
          "Antigravity CLI timed out running `agy --help`. Check the installation and retry.",
      });
    }
    const helpCommand = help.success.value;
    const helpText = `${helpCommand.stdout}\n${helpCommand.stderr}`;
    if (
      helpCommand.code !== 0 ||
      helpCommand.invalidOutput ||
      ![
        "--input-format",
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
        "--conversation",
      ].every((flag) => helpText.includes(flag))
    ) {
      return providerDraft({
        ...base,
        status: "error",
        message:
          "The configured executable does not advertise Antigravity CLI headless streaming. Check the path or update the CLI manually, then retry.",
      });
    }

    const catalog = yield* runAntigravityCliCommand(
      settings,
      ["models"],
      environment,
      cwd,
      CATALOG_MAX_BYTES,
    ).pipe(Effect.timeoutOption(MODEL_CATALOG_TIMEOUT_MS), Effect.result);
    if (Result.isFailure(catalog)) {
      return providerDraft({
        ...base,
        status: "warning",
        message:
          "Antigravity CLI model discovery failed. Run `agy models` on the server host and retry.",
      });
    }
    if (Option.isNone(catalog.success)) {
      return providerDraft({
        ...base,
        status: "warning",
        message:
          "Antigravity CLI model discovery timed out. Finish CLI setup with `agy` on the server host, then retry.",
      });
    }
    const catalogCommand = catalog.success.value;
    if (
      /\b(?:unauthenticated|not authenticated|not logged in|authentication (?:required|failed)|login required|sign[ -]in required)\b/iu.test(
        `${catalogCommand.stdout}\n${catalogCommand.stderr}`,
      )
    ) {
      return providerDraft({
        ...base,
        status: "warning",
        auth: { status: "unauthenticated" },
        message:
          "Antigravity CLI requires authentication. Open `agy` on the server host, sign in, then retry.",
      });
    }
    if (catalogCommand.code !== 0 || catalogCommand.invalidOutput) {
      return providerDraft({
        ...base,
        status: "warning",
        message:
          "Antigravity CLI returned an incomplete or invalid model catalog. Run `agy models` on the server host and retry.",
      });
    }
    const parsed = parseAntigravityCliModelCatalog(catalogCommand.stdout);
    if (parsed.models.length === 0) {
      return providerDraft({
        ...base,
        status: "warning",
        message:
          "Antigravity CLI returned no usable models. Run `agy models` on the server host and check account access, then retry.",
      });
    }
    return providerDraft({
      ...base,
      models: parsed.models,
      status: parsed.ignoredEntries > 0 || parsed.truncatedEntries ? "warning" : "ready",
      message:
        parsed.ignoredEntries > 0 || parsed.truncatedEntries
          ? "Some Antigravity CLI model entries could not be used. Authentication is checked when a turn starts."
          : "Antigravity CLI is available. Authentication is checked when a turn starts.",
    });
  },
);
