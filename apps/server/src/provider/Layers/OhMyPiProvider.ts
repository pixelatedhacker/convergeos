import {
  type ModelCapabilities,
  type OhMyPiSettings,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { isWindowsCommandNotFound } from "../../processRunner.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  ProviderCommandNotFoundError,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";

const OH_MY_PI_PRESENTATION = {
  displayName: "Oh My Pi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const MODEL_CATALOG_TIMEOUT_MS = 15_000;
const VERSION_OUTPUT_MAX_BYTES = 16 * 1_024;
const MODEL_CATALOG_OUTPUT_MAX_BYTES = 4 * 1_024 * 1_024;
const STDERR_MAX_BYTES = 64 * 1_024;
const MAX_MODELS = 2_048;
const MAX_THINKING_EFFORTS = 32;
const MAX_MODEL_STRING_LENGTH = 512;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

interface OhMyPiCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly invalidUtf8: boolean;
}

export interface OhMyPiModelCatalog {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly ignoredEntries: number;
  readonly truncatedEntries: boolean;
}

export type OhMyPiModelCatalogParseResult =
  | { readonly _tag: "Success"; readonly catalog: OhMyPiModelCatalog }
  | { readonly _tag: "Failure"; readonly issue: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_MODEL_STRING_LENGTH ? trimmed : undefined;
}

function titleCaseToken(value: string): string {
  return value
    .split(/[-_\s]+/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function thinkingEfforts(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const efforts: string[] = [];
  for (const candidate of value) {
    const effort = boundedNonEmptyString(candidate);
    if (!effort || seen.has(effort)) continue;
    seen.add(effort);
    efforts.push(effort);
    if (efforts.length === MAX_THINKING_EFFORTS) break;
  }
  return efforts;
}

function capabilitiesForModel(entry: Record<string, unknown>): ModelCapabilities {
  const efforts = thinkingEfforts(entry.thinking);
  return efforts.length === 0
    ? EMPTY_CAPABILITIES
    : createModelCapabilities({
        optionDescriptors: [
          {
            id: "thinking",
            label: "Thinking",
            type: "select",
            options: efforts.map((effort) => ({
              id: effort,
              label: titleCaseToken(effort) || effort,
            })),
          },
        ],
      });
}

function parseModelEntry(value: unknown): ServerProviderModel | undefined {
  if (!isRecord(value)) return undefined;
  const provider = boundedNonEmptyString(value.provider);
  const id = boundedNonEmptyString(value.id);
  const advertisedSelector = boundedNonEmptyString(value.selector);
  const selector = advertisedSelector ?? (provider && id ? `${provider}/${id}` : undefined);
  if (!selector) return undefined;
  const name = boundedNonEmptyString(value.name) ?? id ?? selector;
  return {
    slug: selector,
    name,
    ...(provider ? { subProvider: provider } : {}),
    isCustom: false,
    capabilities: capabilitiesForModel(value),
  };
}

/** Parse the stable machine-readable output from `omp models --json --no-extensions`. */
export function parseOhMyPiModelCatalog(output: string): OhMyPiModelCatalogParseResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(output);
  } catch {
    return { _tag: "Failure", issue: "Oh My Pi returned malformed model catalog JSON." };
  }
  if (!isRecord(decoded) || !Array.isArray(decoded.models)) {
    return {
      _tag: "Failure",
      issue: "Oh My Pi model catalog JSON did not contain a models array.",
    };
  }

  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  let ignoredEntries = 0;
  for (const candidate of decoded.models) {
    if (models.length === MAX_MODELS) break;
    const model = parseModelEntry(candidate);
    if (!model || seen.has(model.slug)) {
      ignoredEntries += 1;
      continue;
    }
    seen.add(model.slug);
    models.push(model);
  }
  models.sort((left, right) => {
    const providerOrder = (left.subProvider ?? "").localeCompare(right.subProvider ?? "");
    return providerOrder !== 0 ? providerOrder : left.slug.localeCompare(right.slug);
  });
  return {
    _tag: "Success",
    catalog: {
      models,
      ignoredEntries,
      truncatedEntries: decoded.models.length > MAX_MODELS,
    },
  };
}

const runOhMyPiCommand = (
  settings: Pick<OhMyPiSettings, "binaryPath">,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  stdoutMaxBytes: number,
) =>
  Effect.gen(function* () {
    const binaryPath = settings.binaryPath || "omp";
    const spawnCommand = yield* resolveSpawnCommand(binaryPath, args, { env: environment });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd,
        env: environment,
        shell: spawnCommand.shell,
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
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      invalidUtf8: stdout.invalidUtf8 || stderr.invalidUtf8,
    } satisfies OhMyPiCommandResult;
  }).pipe(Effect.scoped);

function providerDraft(input: {
  readonly enabled: boolean;
  readonly checkedAt: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly installed: boolean;
  readonly version: string | null;
  readonly status: "ready" | "warning" | "error";
  readonly message?: string;
}): ServerProviderDraft {
  return {
    ...buildServerProvider({
      presentation: OH_MY_PI_PRESENTATION,
      enabled: input.enabled,
      checkedAt: input.checkedAt,
      models: input.models,
      probe: {
        installed: input.installed,
        version: input.version,
        status: input.status,
        auth: { status: "unknown" },
        ...(input.message ? { message: input.message } : {}),
      },
    }),
    supportsConversationRollback: false,
    supportsTextGeneration: false,
  };
}

export function buildInitialOhMyPiProviderSnapshot(
  settings: OhMyPiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return providerDraft({
      enabled: settings.enabled,
      checkedAt,
      models: [],
      installed: settings.enabled,
      version: null,
      status: "warning",
      message: settings.enabled
        ? "Checking Oh My Pi availability..."
        : "Oh My Pi is disabled in ConvergeOS settings.",
    });
  });
}

export const checkOhMyPiProviderStatus = Effect.fn("checkOhMyPiProviderStatus")(function* (
  settings: OhMyPiSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return providerDraft({
      enabled: false,
      checkedAt,
      models: [],
      installed: false,
      version: null,
      status: "warning",
      message: "Oh My Pi is disabled in ConvergeOS settings.",
    });
  }

  const versionResult = yield* runOhMyPiCommand(
    settings,
    ["--version"],
    environment,
    cwd,
    VERSION_OUTPUT_MAX_BYTES,
  ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);
  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    yield* Effect.logWarning("Oh My Pi CLI health check failed.", {
      errorTag: versionResult.failure._tag,
    });
    return providerDraft({
      enabled: true,
      checkedAt,
      models: [],
      installed: !missing,
      version: null,
      status: "error",
      message: missing
        ? "Oh My Pi CLI (`omp`) is not installed or not on PATH."
        : "Failed to execute the Oh My Pi CLI health check.",
    });
  }
  if (Option.isNone(versionResult.success)) {
    return providerDraft({
      enabled: true,
      checkedAt,
      models: [],
      installed: true,
      version: null,
      status: "error",
      message: "Oh My Pi timed out while running `omp --version`.",
    });
  }

  const versionCommand = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionCommand.stdout}\n${versionCommand.stderr}`);
  if (
    versionCommand.code !== 0 ||
    versionCommand.stdoutTruncated ||
    versionCommand.stderrTruncated ||
    versionCommand.invalidUtf8
  ) {
    return providerDraft({
      enabled: true,
      checkedAt,
      models: [],
      installed: true,
      version,
      status: "error",
      message: "Oh My Pi is installed but its version probe returned invalid output.",
    });
  }

  const catalogResult = yield* runOhMyPiCommand(
    settings,
    ["models", "--json", "--no-extensions"],
    environment,
    cwd,
    MODEL_CATALOG_OUTPUT_MAX_BYTES,
  ).pipe(Effect.timeoutOption(MODEL_CATALOG_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(catalogResult)) {
    yield* Effect.logWarning("Oh My Pi model catalog probe failed.", {
      errorTag: catalogResult.failure._tag,
    });
    return providerDraft({
      enabled: true,
      checkedAt,
      models: [],
      installed: true,
      version,
      status: "warning",
      message: "Oh My Pi is installed, but its model catalog could not be loaded.",
    });
  }
  if (Option.isNone(catalogResult.success)) {
    return providerDraft({
      enabled: true,
      checkedAt,
      models: [],
      installed: true,
      version,
      status: "warning",
      message: "Oh My Pi model discovery timed out.",
    });
  }

  const catalogCommand = catalogResult.success.value;
  if (
    catalogCommand.code !== 0 ||
    catalogCommand.stdoutTruncated ||
    catalogCommand.stderrTruncated ||
    catalogCommand.invalidUtf8
  ) {
    return providerDraft({
      enabled: true,
      checkedAt,
      models: [],
      installed: true,
      version,
      status: "warning",
      message: "Oh My Pi returned an incomplete or invalid model catalog.",
    });
  }

  const parsed = parseOhMyPiModelCatalog(catalogCommand.stdout);
  if (parsed._tag === "Failure") {
    yield* Effect.logWarning(parsed.issue);
    return providerDraft({
      enabled: true,
      checkedAt,
      models: [],
      installed: true,
      version,
      status: "warning",
      message: parsed.issue,
    });
  }
  if (parsed.catalog.models.length === 0) {
    return providerDraft({
      enabled: true,
      checkedAt,
      models: [],
      installed: true,
      version,
      status: "warning",
      message: "Oh My Pi found no available models. Configure an upstream provider credential.",
    });
  }
  if (parsed.catalog.ignoredEntries > 0 || parsed.catalog.truncatedEntries) {
    yield* Effect.logWarning("Oh My Pi model catalog contained entries ConvergeOS could not use.", {
      ignoredEntries: parsed.catalog.ignoredEntries,
      truncatedEntries: parsed.catalog.truncatedEntries,
    });
  }

  return providerDraft({
    enabled: true,
    checkedAt,
    models: parsed.catalog.models,
    installed: true,
    version,
    status: "ready",
  });
});

export const enrichOhMyPiSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap(input.publishSnapshot),
    Effect.catchCause((cause) =>
      Effect.logWarning("Oh My Pi version advisory enrichment failed.", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
