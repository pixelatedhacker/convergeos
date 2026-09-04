import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { AntigravityCliSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  buildInitialAntigravityCliProviderSnapshot,
  checkAntigravityCliProviderStatus,
  parseAntigravityCliModelCatalog,
} from "./AntigravityCliProvider.ts";

const decodeSettings = Schema.decodeSync(AntigravityCliSettings);
const VALID_HELP =
  "Usage: agy --input-format stream-json --output-format stream-json --dangerously-skip-permissions --conversation";
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const writeFakeCli = Effect.fn("writeFakeCli")(function* (input: {
  readonly help?: string;
  readonly helpCode?: number;
  readonly models?: string;
  readonly modelCode?: number;
  readonly stderr?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporaryDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-discovery-" });
  const cwd = yield* fs.realPath(temporaryDirectory);
  const binaryPath = path.join(cwd, "agy");
  yield* fs.writeFileString(
    binaryPath,
    [
      "#!/bin/sh",
      // Every probe must propagate the requested cwd and environment.
      `test "$PWD" = ${shellQuote(cwd)} || exit 90`,
      'test "$T3_AGY_PROBE" = "fixture" || exit 91',
      'case "$1" in',
      `--help) printf '%s\\n' ${shellQuote(input.help ?? VALID_HELP)}; exit ${input.helpCode ?? 0};;`,
      `models) printf '%s\\n' ${shellQuote(input.models ?? "model-b\tModel B\nmodel-a\tModel A")}; printf '%s\\n' ${shellQuote(input.stderr ?? "Loading account...")} >&2; exit ${input.modelCode ?? 0};;`,
      "*) exit 92;;",
      "esac",
      "",
    ].join("\n"),
  );
  yield* fs.chmod(binaryPath, 0o755);
  return { cwd, binaryPath };
});
const probeFixture = Effect.fn("probeFixture")(function* (
  input: Parameters<typeof writeFakeCli>[0],
) {
  const { cwd, binaryPath } = yield* writeFakeCli(input);
  return yield* checkAntigravityCliProviderStatus(
    decodeSettings({ enabled: true, binaryPath }),
    { ...process.env, T3_AGY_PROBE: "fixture" },
    cwd,
  );
}, Effect.scoped);

describe("parseAntigravityCliModelCatalog", () => {
  it("preserves real model IDs and labels, sorts and deduplicates", () => {
    const result = parseAntigravityCliModelCatalog(
      "model-z\tModel Z\r\nmodel-a\tModel A\nmodel-z\tDuplicate\n",
    );
    expect(result.models.map(({ slug, name }) => [slug, name])).toEqual([
      ["model-a", "Model A"],
      ["model-z", "Model Z"],
    ]);
    expect(result.ignoredEntries).toBe(1);
    expect(result.truncatedEntries).toBe(false);
    expect(result.models[0]?.capabilities?.optionDescriptors).toEqual([]);
  });

  it("rejects progress, malformed rows, control characters, and oversized strings", () => {
    const result = parseAntigravityCliModelCatalog(
      [
        "Loading models...",
        "no-label\t",
        "\tNo ID",
        "bad slug\tName",
        "too-many\tName\tColumn",
        "ansi\t\u001b[1mBad label",
        `${"x".repeat(513)}\tLong ID`,
        `long-label\t${"x".repeat(513)}`,
        "real-model\tReal Model",
      ].join("\n"),
    );
    expect(result.models.map((model) => model.slug)).toEqual(["real-model"]);
    expect(result.ignoredEntries).toBe(8);
  });

  it("caps the retained catalog", () => {
    const result = parseAntigravityCliModelCatalog(
      Array.from({ length: 2_050 }, (_, index) => `model-${index}\tModel ${index}`).join("\n"),
    );
    expect(result.models).toHaveLength(2_048);
    expect(result.truncatedEntries).toBe(true);
  });
});

it.layer(NodeServices.layer)("Antigravity CLI status", (it) => {
  it.effect("stays disabled without probing and reports only supported access", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({});
      const initial = yield* buildInitialAntigravityCliProviderSnapshot(settings);
      const checked = yield* checkAntigravityCliProviderStatus(settings, {}, "/nonexistent");
      for (const snapshot of [initial, checked]) {
        expect(snapshot.status).toBe("disabled");
        expect(snapshot.installed).toBe(false);
        expect(snapshot.supportedRuntimeModes).toEqual(["full-access"]);
        expect(snapshot.showInteractionModeToggle).toBe(false);
        expect(snapshot.supportsConversationRollback).toBe(false);
        expect(snapshot.supportsTextGeneration).toBe(false);
      }
    }),
  );

  it.effect("reports a missing executable with installation guidance", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAntigravityCliProviderStatus(
        decodeSettings({ enabled: true, binaryPath: "/definitely/not/installed/agy" }),
        process.env,
        process.cwd(),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("Install it on the server host");
    }),
  );

  it.effect("requires actual headless protocol support from the configured binary", () =>
    Effect.gen(function* () {
      for (const input of [
        { help: "Antigravity IDE launcher 1.2.3" },
        { help: "stream-json --output-format --input-format" },
        { helpCode: 1 },
      ]) {
        const snapshot = yield* probeFixture(input);
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("error");
        expect(snapshot.models).toEqual([]);
        expect(snapshot.version).toBeNull();
        expect(snapshot.message).toContain("headless streaming");
      }
    }),
  );

  it.effect(
    "loads stdout models with cwd/environment but does not claim authenticated or versioned",
    () =>
      Effect.gen(function* () {
        const snapshot = yield* probeFixture({
          stderr: "Loading CLI 1.1.26...\nnoise\tNot a model",
        });
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("ready");
        expect(snapshot.models.map((model) => model.slug)).toEqual(["model-a", "model-b"]);
        expect(snapshot.auth.status).toBe("unknown");
        expect(snapshot.version).toBeNull();
      }),
  );

  it.effect("recognizes auth errors even when a catalog is returned with exit zero", () =>
    Effect.gen(function* () {
      const snapshot = yield* probeFixture({ stderr: "Not authenticated. secret-token" });
      expect(snapshot.status).toBe("warning");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("sign in");
      expect(snapshot.message).not.toContain("secret-token");
      expect(snapshot.models).toEqual([]);
    }),
  );

  it.effect("gives retry diagnostics for model failure and malformed catalogs", () =>
    Effect.gen(function* () {
      for (const input of [{ modelCode: 3 }, { models: "unexpected output" }, { models: "" }]) {
        const snapshot = yield* probeFixture(input);
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("warning");
        expect(snapshot.models).toEqual([]);
        expect(snapshot.auth.status).toBe("unknown");
        expect(snapshot.message).toContain("retry");
      }
    }),
  );

  it.effect("bounds subprocess catalog output without accepting its truncated prefix", () =>
    Effect.gen(function* () {
      const snapshot = yield* probeFixture({ models: `model-a\t${"a".repeat(1_025 * 1_024)}` });
      expect(snapshot.status).toBe("warning");
      expect(snapshot.models).toEqual([]);
      expect(snapshot.message).toContain("incomplete or invalid");
    }),
  );
});
