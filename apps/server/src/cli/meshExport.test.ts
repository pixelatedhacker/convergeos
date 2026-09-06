import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import { meshExportCommand } from "./meshExport.ts";
import * as MeshReceiptExportStore from "../mesh/MeshReceiptExportStore.ts";
import * as Sqlite from "../persistence/Layers/Sqlite.ts";

const runCli = Command.runWith(meshExportCommand, { version: "0.0.0" });
const readEpochs = Effect.fn("test.readEpochs")(function* (baseDir: string) {
  const path = yield* Path.Path;
  return yield* MeshReceiptExportStore.MeshReceiptExportStore.pipe(
    Effect.flatMap((store) => store.listEpochs),
    Effect.provide(
      MeshReceiptExportStore.layer.pipe(
        Layer.provide(
          Sqlite.makeSqlitePersistenceLive(path.join(baseDir, "userdata", "state.sqlite")),
        ),
      ),
    ),
  );
});
const testLayer = Layer.mergeAll(
  NodeServices.layer,
  NetService.layer,
  TestConsole.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "3773" } })),
);

it.effect("records rapid disable and enable transitions without a running exporter", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "mesh-export-cli-" });
    yield* runCli(["enable", "wss://relay.example", "--base-dir", baseDir]);
    const [first] = yield* readEpochs(baseDir);
    if (!first) throw new Error("Expected the first epoch");
    yield* runCli(["disable", "--base-dir", baseDir]);
    yield* runCli(["enable", "wss://relay.example", "--base-dir", baseDir]);
    const epochs = yield* readEpochs(baseDir);
    assert.equal(epochs.length, 2);
    assert.equal(
      epochs.find((epoch) => epoch.exportEpoch === first.exportEpoch)?.publication,
      "paused",
    );
    assert.equal(epochs.filter((epoch) => epoch.publication === "active").length, 1);
    yield* runCli(["resume", first.exportEpoch, "--base-dir", baseDir]);
    assert.equal(
      (yield* readEpochs(baseDir)).filter((epoch) => epoch.publication === "active").length,
      2,
    );
    yield* runCli(["disable", "--base-dir", baseDir]);
    assert.isTrue((yield* readEpochs(baseDir)).every((epoch) => epoch.publication === "paused"));
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("refuses old-epoch resume when disabled or configured for another relay", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "mesh-export-cli-" });
    yield* runCli(["enable", "wss://original.example", "--base-dir", baseDir]);
    const [original] = yield* readEpochs(baseDir);
    if (!original) throw new Error("Expected the original epoch");
    yield* runCli(["disable", "--base-dir", baseDir]);
    const disabled = yield* runCli(["resume", original.exportEpoch, "--base-dir", baseDir]).pipe(
      Effect.flip,
    );
    assert.include(String(disabled), "Enable export");
    yield* runCli(["enable", "wss://different.example", "--base-dir", baseDir]);
    const mismatched = yield* runCli(["resume", original.exportEpoch, "--base-dir", baseDir]).pipe(
      Effect.flip,
    );
    assert.include(String(mismatched), "configured relay");
    assert.equal(
      (yield* readEpochs(baseDir)).find((epoch) => epoch.exportEpoch === original.exportEpoch)
        ?.publication,
      "paused",
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("shows retained epoch status while disabled and makes discard permanent", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "mesh-export-cli-" });
    yield* runCli(["enable", "wss://relay.example", "--base-dir", baseDir]);
    const [epoch] = yield* readEpochs(baseDir);
    if (!epoch) throw new Error("Expected the retained epoch");
    yield* runCli(["disable", "--base-dir", baseDir]);
    yield* runCli(["status", "--base-dir", baseDir]);
    const output = (yield* TestConsole.logLines).join("\n");
    assert.include(output, "Mesh receipt export is disabled.");
    assert.include(output, `${epoch.exportEpoch}: paused; 0 pending, 0 rejected.`);
    yield* runCli(["discard", epoch.exportEpoch, "--base-dir", baseDir]);
    assert.equal((yield* readEpochs(baseDir))[0]?.publication, "discarded");
    yield* runCli(["enable", "wss://relay.example", "--base-dir", baseDir]);
    yield* runCli(["resume", epoch.exportEpoch, "--base-dir", baseDir]).pipe(Effect.flip);
    assert.equal(
      (yield* readEpochs(baseDir)).find((item) => item.exportEpoch === epoch.exportEpoch)
        ?.publication,
      "discarded",
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
