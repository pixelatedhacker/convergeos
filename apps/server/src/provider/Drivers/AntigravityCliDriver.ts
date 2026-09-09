import { AntigravityCliSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeUnavailableTextGeneration } from "../../textGeneration/UnavailableTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeAntigravityCliAdapter } from "../Layers/AntigravityCliAdapter.ts";
import {
  buildInitialAntigravityCliProviderSnapshot,
  checkAntigravityCliProviderStatus,
} from "../Layers/AntigravityCliProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER_KIND = ProviderDriverKind.make("antigravityCli");
const decodeSettings = Schema.decodeSync(AntigravityCliSettings);
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type AntigravityCliDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig
  | ServerSettingsService;

export const AntigravityCliDriver: ProviderDriver<AntigravityCliSettings, AntigravityCliDriverEnv> =
  {
    driverKind: DRIVER_KIND,
    metadata: { displayName: "Antigravity CLI", supportsMultipleInstances: true },
    configSchema: AntigravityCliSettings,
    defaultConfig: () => decodeSettings({}),
    create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const serverSettings = yield* ServerSettingsService;
        const { cwd } = yield* ServerConfig;
        const processEnvironment = mergeProviderInstanceEnvironment(environment);
        const continuationIdentity = defaultProviderContinuationIdentity({
          driverKind: DRIVER_KIND,
          instanceId,
        });
        const stampIdentity = withInstanceIdentity({
          instanceId,
          driverKind: DRIVER_KIND,
          displayName,
          accentColor,
          continuationGroupKey: continuationIdentity.continuationKey,
        });
        const effectiveConfig = { ...config, enabled } satisfies AntigravityCliSettings;
        const adapter = yield* makeAntigravityCliAdapter(effectiveConfig, {
          instanceId,
          environment: processEnvironment,
        });
        const checkProviderForCwd = (targetCwd: string) =>
          checkAntigravityCliProviderStatus(effectiveConfig, processEnvironment, targetCwd).pipe(
            Effect.map(stampIdentity),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
        const snapshotSettings = makeProviderSnapshotSettingsSource(
          effectiveConfig,
          serverSettings,
        );
        const snapshot = yield* makeManagedServerProvider<
          ProviderSnapshotSettings<AntigravityCliSettings>
        >({
          resolveMaintenance: () => Effect.succeed(MAINTENANCE),
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: (settings) =>
            buildInitialAntigravityCliProviderSnapshot(settings.provider).pipe(
              Effect.map(stampIdentity),
            ),
          checkProvider: checkProviderForCwd(cwd),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: `Failed to build Antigravity CLI snapshot: ${cause.message}`,
                cause,
              }),
          ),
        );
        return {
          instanceId,
          driverKind: DRIVER_KIND,
          continuationIdentity,
          displayName,
          accentColor,
          enabled,
          snapshot,
          snapshotForCwd: (targetCwd) =>
            effectiveConfig.enabled ? checkProviderForCwd(targetCwd) : snapshot.getSnapshot,
          adapter,
          textGeneration: makeUnavailableTextGeneration("Antigravity CLI"),
        } satisfies ProviderInstance;
      }),
  };
