import { Argument, Command, GlobalFlag } from "effect/unstable/cli";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  MESH_RECEIPT_EXPORT_ENABLED_SECRET,
  MESH_RECEIPT_RELAY_URL_SECRET,
  meshRelayDestinationDigest,
  readMeshReceiptExportConfig,
} from "../mesh/MeshReceiptConfig.ts";
import * as MeshReceiptExportStore from "../mesh/MeshReceiptExportStore.ts";
import * as Sqlite from "../persistence/Layers/Sqlite.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { baseDirFlag, resolveCliAuthConfig } from "./config.ts";

const decodeRelayUrl = Schema.decodeUnknownOption(Schema.URLFromString);

const stringToBytes = (value: string) => new TextEncoder().encode(value);

class MeshExportCliError extends Schema.TaggedError<MeshExportCliError>()("MeshExportCliError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const runWithStore = <A, E, R>(
  flags: { readonly baseDir: Option.Option<string> },
  run: Effect.Effect<
    A,
    E,
    R | ServerSecretStore.ServerSecretStore | MeshReceiptExportStore.MeshReceiptExportStore
  >,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const runtimeLayer = Layer.mergeAll(
      ServerSecretStore.layer,
      MeshReceiptExportStore.layer.pipe(Layer.provide(Sqlite.layerConfig)),
    ).pipe(Layer.provide(ServerConfig.layer(config)));
    return yield* run.pipe(Effect.provide(runtimeLayer));
  });

const meshExportEnableCommand = Command.make("enable", {
  baseDir: baseDirFlag,
  relayUrl: Argument.string("relay-url").pipe(
    Argument.withDescription("WebSocket URL of the private Nostr relay (wss://...)"),
  ),
}).pipe(
  Command.withDescription(
    "Start a new capture epoch at the current watermark; previous epochs stay paused.",
  ),
  Command.withHandler((flags) =>
    runWithStore(
      flags,
      Effect.gen(function* () {
        const relayUrl = flags.relayUrl.trim();
        const parsedUrl = decodeRelayUrl(relayUrl);
        if (Option.isNone(parsedUrl) || !["ws:", "wss:"].includes(parsedUrl.value.protocol)) {
          return yield* new MeshExportCliError({
            detail: "The relay URL must be a valid ws:// or wss:// URL.",
          });
        }
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const store = yield* MeshReceiptExportStore.MeshReceiptExportStore;
        const config = yield* readMeshReceiptExportConfig(secrets);
        const crypto = yield* Crypto.Crypto;
        const exportEpoch = yield* crypto.randomUUIDv4;
        yield* secrets.set(MESH_RECEIPT_RELAY_URL_SECRET, stringToBytes(relayUrl));
        yield* store.enableExport({
          exportEpoch,
          startWatermark: yield* store.latestSourceSequence,
          destinationDigest: meshRelayDestinationDigest(relayUrl),
          quotaBytes: config.quotaBytes,
          at: DateTime.formatIso(yield* DateTime.now),
        });
        yield* secrets.set(MESH_RECEIPT_EXPORT_ENABLED_SECRET, stringToBytes("true"));
        yield* Console.log(
          `Mesh receipt export enabled. New epoch: ${exportEpoch}. Previous epochs remain paused.`,
        );
      }),
    ),
  ),
);

const meshExportDisableCommand = Command.make("disable", { baseDir: baseDirFlag }).pipe(
  Command.withDescription(
    "Pause capture and every publication epoch. Pending receipts are retained.",
  ),
  Command.withHandler((flags) =>
    runWithStore(
      flags,
      Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const store = yield* MeshReceiptExportStore.MeshReceiptExportStore;
        yield* secrets.remove(MESH_RECEIPT_EXPORT_ENABLED_SECRET);
        yield* store.disableExport({
          stopWatermark: yield* store.latestSourceSequence,
          at: DateTime.formatIso(yield* DateTime.now),
        });
        yield* Console.log(
          "Mesh receipt export disabled. All publication epochs are paused; pending receipts are retained.",
        );
      }),
    ),
  ),
);

const meshExportStatusCommand = Command.make("status", { baseDir: baseDirFlag }).pipe(
  Command.withDescription("Show capture status and publication permissions for retained epochs."),
  Command.withHandler((flags) =>
    runWithStore(
      flags,
      Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const store = yield* MeshReceiptExportStore.MeshReceiptExportStore;
        const config = yield* readMeshReceiptExportConfig(secrets);
        const state = yield* store.readExportState;
        const enabled =
          config.enabled &&
          config.relayUrl !== null &&
          state?.status === "active" &&
          state.destinationDigest === meshRelayDestinationDigest(config.relayUrl);
        yield* Console.log(`Mesh receipt export is ${enabled ? "enabled" : "disabled"}.`);
        for (const epoch of yield* store.listEpochs) {
          yield* Console.log(
            `${epoch.exportEpoch}: ${epoch.publication}; ${epoch.pending} pending, ${epoch.rejected} rejected.`,
          );
        }
      }),
    ),
  ),
);

const meshExportResumeCommand = Command.make("resume", {
  baseDir: baseDirFlag,
  epoch: Argument.string("epoch"),
}).pipe(
  Command.withDescription(
    "Authorize publication of a paused epoch to its original configured relay.",
  ),
  Command.withHandler((flags) =>
    runWithStore(
      flags,
      Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const store = yield* MeshReceiptExportStore.MeshReceiptExportStore;
        const config = yield* readMeshReceiptExportConfig(secrets);
        const state = yield* store.readExportState;
        if (!config.enabled || config.relayUrl === null || state?.status !== "active") {
          return yield* new MeshExportCliError({
            detail: "Enable export to the epoch's original relay before resuming it.",
          });
        }
        const epoch = (yield* store.listEpochs).find((item) => item.exportEpoch === flags.epoch);
        if (epoch?.publication !== "paused") {
          return yield* new MeshExportCliError({
            detail: "Only a retained paused epoch can be resumed.",
          });
        }
        const destinationDigest = meshRelayDestinationDigest(config.relayUrl);
        if (
          epoch.destinationDigest !== destinationDigest ||
          state.destinationDigest !== destinationDigest
        ) {
          return yield* new MeshExportCliError({
            detail:
              "The epoch does not match the configured relay. Enable its original relay before resuming.",
          });
        }
        yield* store.setEpochPublication({
          exportEpoch: flags.epoch,
          destinationDigest,
          publication: "active",
        });
        yield* Console.log(`Publication resumed for epoch ${flags.epoch}.`);
      }),
    ),
  ),
);

const meshExportDiscardCommand = Command.make("discard", {
  baseDir: baseDirFlag,
  epoch: Argument.string("epoch"),
}).pipe(
  Command.withDescription(
    "Permanently remove publication permission from a paused epoch; retain its stored receipts.",
  ),
  Command.withHandler((flags) =>
    runWithStore(
      flags,
      Effect.gen(function* () {
        const store = yield* MeshReceiptExportStore.MeshReceiptExportStore;
        yield* store.setEpochPublication({
          exportEpoch: flags.epoch,
          destinationDigest: "",
          publication: "discarded",
        });
        yield* Console.log(
          `Publication discarded for epoch ${flags.epoch}. Stored receipts are retained.`,
        );
      }),
    ),
  ),
);

export const meshExportCommand = Command.make("mesh-export", {}).pipe(
  Command.withDescription("Control outbound signed agent-mesh receipt export."),
  Command.withSubcommands([
    meshExportEnableCommand,
    meshExportDisableCommand,
    meshExportStatusCommand,
    meshExportResumeCommand,
    meshExportDiscardCommand,
  ]),
);
