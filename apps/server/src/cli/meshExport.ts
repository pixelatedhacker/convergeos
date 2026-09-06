// `t3 mesh-export` - control outbound signed agent-mesh receipt export.
//
// Export is off until this command enables it against one private Nostr relay
// (`t3 mesh-export enable wss://relay.example`). The relay URL and the opt-in
// flag are server-owned secrets, so the command writes through the same secret
// store the server reads; a running server picks the change up on its next
// export sweep without a restart.

import { Command, GlobalFlag } from "effect/unstable/cli";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument } from "effect/unstable/cli";

import {
  MESH_RECEIPT_EXPORT_ENABLED_SECRET,
  MESH_RECEIPT_RELAY_URL_SECRET,
  readMeshReceiptExportConfig,
} from "../mesh/MeshReceiptConfig.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { baseDirFlag, resolveCliAuthConfig } from "./config.ts";

const stringToBytes = (value: string) => new TextEncoder().encode(value);

class MeshExportCliError extends Schema.TaggedErrorClass<MeshExportCliError>()(
  "MeshExportCliError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const runWithSecrets = <A, E>(
  flags: { readonly baseDir: Option.Option<string> },
  run: Effect.Effect<A, E, ServerSecretStore.ServerSecretStore | ServerConfig.ServerConfig>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const runtimeLayer = Layer.mergeAll(ServerSecretStore.layer).pipe(
      Layer.provideMerge(ServerConfig.layer(config)),
    );
    return yield* run.pipe(Effect.provide(runtimeLayer));
  });

const meshExportEnableCommand = Command.make("enable", {
  baseDir: baseDirFlag,
  relayUrl: Argument.string("relay-url").pipe(
    Argument.withDescription("WebSocket URL of the private Nostr relay (wss://...)"),
  ),
}).pipe(
  Command.withDescription(
    "Publish signed agent-mesh receipts to the given private relay. Capture starts at the current watermark; no history is backfilled.",
  ),
  Command.withHandler((flags) =>
    runWithSecrets(flags, Effect.gen(function* () {
      const relayUrl = flags.relayUrl.trim();
      if (!/^wss?:\/\//.test(relayUrl)) {
        return yield* new MeshExportCliError({
          detail: "The relay URL must start with ws:// or wss://.",
        });
      }
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      yield* secrets.set(MESH_RECEIPT_RELAY_URL_SECRET, stringToBytes(relayUrl));
      yield* secrets.set(MESH_RECEIPT_EXPORT_ENABLED_SECRET, stringToBytes("true"));
      yield* Console.log(`Mesh receipt export enabled for ${relayUrl}.`);
    })),
  ),
);

const meshExportDisableCommand = Command.make("disable", {
  baseDir: baseDirFlag,
}).pipe(
  Command.withDescription(
    "Pause capture and publication at a recorded watermark. Already-signed pending receipts are kept.",
  ),
  Command.withHandler((flags) =>
    runWithSecrets(flags, Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      yield* secrets.remove(MESH_RECEIPT_EXPORT_ENABLED_SECRET);
      yield* Console.log("Mesh receipt export disabled. Pending receipts are retained.");
    })),
  ),
);

const meshExportStatusCommand = Command.make("status", {
  baseDir: baseDirFlag,
}).pipe(
  Command.withDescription("Show whether signed receipt export is enabled and where it publishes."),
  Command.withHandler((flags) =>
    runWithSecrets(flags, Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const config = yield* readMeshReceiptExportConfig(secrets);
      if (!config.enabled || config.relayUrl === null) {
        yield* Console.log(
          "Mesh receipt export is disabled. Enable it with `t3 mesh-export enable <relay-url>`.",
        );
        return;
      }
      yield* Console.log(
        `Mesh receipt export is enabled, publishing to ${config.relayUrl}.`,
      );
    })),
  ),
);

export const meshExportCommand = Command.make("mesh-export", {}).pipe(
  Command.withDescription("Control outbound signed agent-mesh receipt export."),
  Command.withSubcommands([meshExportEnableCommand, meshExportDisableCommand, meshExportStatusCommand]),
);
