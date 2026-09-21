/**
 * SkillStoreService — per-environment skill store.
 *
 * Discovery proxies the skills.sh registry (SkillsRegistryClient); installs
 * run the vendored `skills` CLI (SkillsCli) so every harness's directory
 * layout stays upstream's problem. What ConvergeOS owns is the manifest at
 * `<stateDir>/skill-store.json`: which skills were installed, into which
 * scopes, and for which harnesses. That manifest is what lets one skill be
 * installed globally yet enabled per harness, and what survives restarts.
 *
 * Persistence follows the lightweight end of the serverSettings pattern:
 * JSON file + Ref + Semaphore + atomic write. No file watch — this service
 * is the only writer.
 *
 * @module skillStore/SkillStoreService
 */
import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  InstalledSkill,
  RegistrySkillStoreError,
  type InstalledSkillTarget,
  type ProjectId,
  type SkillStoreDetail,
  type SkillStoreDetailInput,
  type SkillStoreHarness,
  type SkillStoreInstallInput,
  type SkillStoreListResult,
  type SkillStoreSearchInput,
  type SkillStoreSearchResult,
  type SkillStoreSetHarnessEnabledInput,
  type SkillStoreUninstallInput,
} from "@t3tools/contracts";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";

import * as ServerConfig from "../config.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { fetchSkillDetail, searchRegistry } from "./SkillsRegistryClient.ts";
import { installSkill, removeSkill } from "./SkillsCli.ts";

/** Resolves a project's workspace root for project-scope CLI runs. Injected by the WS layer, which owns projections. */
export type ResolveProjectCwd = (
  projectId: ProjectId,
) => Effect.Effect<string, RegistrySkillStoreError>;

const SkillStoreManifest = Schema.Struct({
  version: Schema.Literal(1),
  skills: Schema.Array(InstalledSkill),
});
type SkillStoreManifest = typeof SkillStoreManifest.Type;

const EMPTY_MANIFEST: SkillStoreManifest = { version: 1, skills: [] };

const decodeManifest = Schema.decodeUnknownEffect(fromLenientJson(SkillStoreManifest));
const encodeManifestJson = Schema.encodeUnknownEffect(fromJsonStringPretty(SkillStoreManifest));

const sameTarget = (left: InstalledSkillTarget, right: InstalledSkillTarget): boolean =>
  left.scope === right.scope && left.projectId === right.projectId;

const unionHarnesses = (
  existing: ReadonlyArray<SkillStoreHarness>,
  added: ReadonlyArray<SkillStoreHarness>,
): ReadonlyArray<SkillStoreHarness> => [...new Set([...existing, ...added])];

export class SkillStoreService extends Context.Service<
  SkillStoreService,
  {
    readonly search: (
      input: SkillStoreSearchInput,
    ) => Effect.Effect<SkillStoreSearchResult, RegistrySkillStoreError>;
    readonly getDetail: (
      input: SkillStoreDetailInput,
    ) => Effect.Effect<SkillStoreDetail, RegistrySkillStoreError>;
    readonly listInstalled: Effect.Effect<SkillStoreListResult, RegistrySkillStoreError>;
    readonly install: (
      input: SkillStoreInstallInput,
      resolveProjectCwd: ResolveProjectCwd,
    ) => Effect.Effect<InstalledSkill, RegistrySkillStoreError>;
    readonly uninstall: (
      input: SkillStoreUninstallInput,
      resolveProjectCwd: ResolveProjectCwd,
    ) => Effect.Effect<SkillStoreListResult, RegistrySkillStoreError>;
    readonly setHarnessEnabled: (
      input: SkillStoreSetHarnessEnabledInput,
      resolveProjectCwd: ResolveProjectCwd,
    ) => Effect.Effect<InstalledSkill, RegistrySkillStoreError>;
  }
>()("t3/skillStore/SkillStoreService") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Captured at layer build so the service interface stays free of
  // infrastructure requirements; the runtime composition provides both.
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const manifestPath = path.join(config.stateDir, "skill-store.json");
  const manifestRef = yield* Ref.make(Option.none<SkillStoreManifest>());
  const mutationLock = yield* Semaphore.make(1);

  const withHttpClient = Effect.provideService(HttpClient.HttpClient, httpClient);
  const withSpawner = Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner);

  const loadManifest = Effect.gen(function* () {
    const cached = yield* Ref.get(manifestRef);
    if (Option.isSome(cached)) {
      return cached.value;
    }
    const contents = yield* fs.readFileString(manifestPath).pipe(Effect.option);
    const manifest = yield* Option.match(contents, {
      onNone: () => Effect.succeed(EMPTY_MANIFEST),
      onSome: (raw) =>
        decodeManifest(raw).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Ignoring undecodable skill-store manifest", {
              manifestPath,
              cause,
            }).pipe(Effect.as(EMPTY_MANIFEST)),
          ),
        ),
    });
    yield* Ref.set(manifestRef, Option.some(manifest));
    return manifest;
  });

  const persistManifest = (manifest: SkillStoreManifest) =>
    Effect.gen(function* () {
      const contents = yield* encodeManifestJson(manifest).pipe(
        Effect.mapError(
          (cause) =>
            new RegistrySkillStoreError({
              reason: "installFailed",
              detail: "Failed to encode skill-store manifest",
              cause,
            }),
        ),
      );
      yield* writeFileStringAtomically({
        filePath: manifestPath,
        contents,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) =>
            new RegistrySkillStoreError({
              reason: "installFailed",
              detail: "Failed to write skill-store manifest",
              cause,
            }),
        ),
      );
      yield* Ref.set(manifestRef, Option.some(manifest));
    });

  const resolveTargetCwd = (
    target: InstalledSkillTarget,
    resolveProjectCwd: ResolveProjectCwd,
  ): Effect.Effect<string, RegistrySkillStoreError> => {
    if (target.scope === "global") {
      return Effect.succeed(NodeOS.homedir());
    }
    if (target.projectId === undefined) {
      return Effect.fail(
        new RegistrySkillStoreError({
          reason: "invalidInput",
          detail: "Project-scope skill targets require a projectId",
        }),
      );
    }
    return resolveProjectCwd(target.projectId);
  };

  /** Merge a target list into the manifest record for `id`, creating it when missing. */
  const upsertRecord = (
    manifest: SkillStoreManifest,
    record: Omit<InstalledSkill, "targets" | "installedAt"> & {
      readonly targets: ReadonlyArray<InstalledSkillTarget>;
    },
    installedAt: string,
  ): SkillStoreManifest => {
    const existing = manifest.skills.find((skill) => skill.id === record.id);
    if (!existing) {
      return {
        ...manifest,
        skills: [...manifest.skills, { ...record, targets: record.targets, installedAt }],
      };
    }
    const mergedTargets = existing.targets.map((target) => {
      const incoming = record.targets.find((candidate) => sameTarget(candidate, target));
      return incoming
        ? { ...target, harnesses: unionHarnesses(target.harnesses, incoming.harnesses) }
        : target;
    });
    for (const incoming of record.targets) {
      if (!existing.targets.some((target) => sameTarget(target, incoming))) {
        mergedTargets.push(incoming);
      }
    }
    return {
      ...manifest,
      skills: manifest.skills.map((skill) =>
        skill.id === record.id
          ? { ...skill, name: record.name, description: record.description, targets: mergedTargets }
          : skill,
      ),
    };
  };

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const search = Effect.fn("SkillStoreService.search")(function* (input: SkillStoreSearchInput) {
    const skills = yield* searchRegistry(input.query, input.limit).pipe(withHttpClient);
    return { skills } satisfies SkillStoreSearchResult;
  });

  const getDetail = Effect.fn("SkillStoreService.getDetail")(function* (
    input: SkillStoreDetailInput,
  ) {
    return yield* fetchSkillDetail(input).pipe(withHttpClient);
  });

  const listInstalled = Effect.gen(function* () {
    const manifest = yield* loadManifest;
    return { skills: manifest.skills } satisfies SkillStoreListResult;
  });

  const install = Effect.fn("SkillStoreService.install")(function* (
    input: SkillStoreInstallInput,
    resolveProjectCwd: ResolveProjectCwd,
  ) {
    return yield* mutationLock.withPermits(1)(
      Effect.gen(function* () {
        const id = `${input.source}/${input.skillId}`;
        const completedTargets: Array<InstalledSkillTarget> = [];
        for (const target of input.targets) {
          const cwd = yield* resolveTargetCwd(target, resolveProjectCwd);
          yield* installSkill({
            source: input.source,
            skillId: input.skillId,
            harnesses: target.harnesses,
            scope: target.scope,
            cwd,
          }).pipe(
            withSpawner,
            // A failed target still persists the ones that already landed, so
            // multi-environment installs never leave invisible state behind.
            Effect.catch((error) =>
              completedTargets.length > 0
                ? Effect.gen(function* () {
                    const manifest = yield* loadManifest;
                    yield* persistManifest(
                      upsertRecord(
                        manifest,
                        {
                          id,
                          source: input.source,
                          skillId: input.skillId,
                          name: input.name,
                          description: input.description ?? null,
                          targets: completedTargets,
                        },
                        yield* nowIso,
                      ),
                    );
                    return yield* error;
                  })
                : Effect.fail(error),
            ),
          );
          completedTargets.push({ ...target, harnesses: [...target.harnesses] });
        }

        const manifest = yield* loadManifest;
        const next = upsertRecord(
          manifest,
          {
            id,
            source: input.source,
            skillId: input.skillId,
            name: input.name,
            description: input.description ?? null,
            targets: completedTargets,
          },
          yield* nowIso,
        );
        yield* persistManifest(next);
        const record = next.skills.find((skill) => skill.id === id);
        if (!record) {
          return yield* new RegistrySkillStoreError({
            reason: "installFailed",
            detail: `Installed skill '${id}' is missing from the manifest after persist`,
          });
        }
        return record;
      }),
    );
  });

  const uninstall = Effect.fn("SkillStoreService.uninstall")(function* (
    input: SkillStoreUninstallInput,
    resolveProjectCwd: ResolveProjectCwd,
  ) {
    return yield* mutationLock.withPermits(1)(
      Effect.gen(function* () {
        const manifest = yield* loadManifest;
        const record = manifest.skills.find((skill) => skill.id === input.id);
        if (!record) {
          return yield* new RegistrySkillStoreError({
            reason: "notFound",
            detail: `Skill '${input.id}' is not installed`,
          });
        }
        const failedTargets: Array<InstalledSkillTarget> = [];
        let firstFailure: RegistrySkillStoreError | undefined;
        for (const target of record.targets) {
          if (target.harnesses.length === 0) {
            continue;
          }
          const cwd = yield* resolveTargetCwd(target, resolveProjectCwd);
          const failure = yield* removeSkill({
            skillId: record.skillId,
            harnesses: target.harnesses,
            scope: target.scope,
            cwd,
          }).pipe(withSpawner, Effect.asVoid, Effect.flip, Effect.option);
          if (Option.isSome(failure)) {
            failedTargets.push(target);
            firstFailure ??= failure.value;
          }
        }

        const next: SkillStoreManifest = {
          ...manifest,
          skills:
            failedTargets.length === 0
              ? manifest.skills.filter((skill) => skill.id !== record.id)
              : manifest.skills.map((skill) =>
                  skill.id === record.id ? { ...skill, targets: failedTargets } : skill,
                ),
        };
        yield* persistManifest(next);
        if (firstFailure) {
          return yield* firstFailure;
        }
        return { skills: next.skills } satisfies SkillStoreListResult;
      }),
    );
  });

  const setHarnessEnabled = Effect.fn("SkillStoreService.setHarnessEnabled")(function* (
    input: SkillStoreSetHarnessEnabledInput,
    resolveProjectCwd: ResolveProjectCwd,
  ) {
    return yield* mutationLock.withPermits(1)(
      Effect.gen(function* () {
        const manifest = yield* loadManifest;
        const record = manifest.skills.find((skill) => skill.id === input.id);
        if (!record) {
          return yield* new RegistrySkillStoreError({
            reason: "notFound",
            detail: `Skill '${input.id}' is not installed`,
          });
        }
        const target = record.targets.find(
          (candidate) => candidate.scope === input.scope && candidate.projectId === input.projectId,
        );
        if (!target) {
          return yield* new RegistrySkillStoreError({
            reason: "notFound",
            detail: `Skill '${input.id}' has no ${input.scope} target to toggle`,
          });
        }

        const cwd = yield* resolveTargetCwd(target, resolveProjectCwd);
        if (input.enabled) {
          yield* installSkill({
            source: record.source,
            skillId: record.skillId,
            harnesses: [input.harness],
            scope: target.scope,
            cwd,
          }).pipe(withSpawner);
        } else {
          yield* removeSkill({
            skillId: record.skillId,
            harnesses: [input.harness],
            scope: target.scope,
            cwd,
          }).pipe(withSpawner);
        }

        const nextTargets = record.targets.map((candidate) =>
          sameTarget(candidate, target)
            ? {
                ...candidate,
                harnesses: input.enabled
                  ? unionHarnesses(candidate.harnesses, [input.harness])
                  : candidate.harnesses.filter((harness) => harness !== input.harness),
              }
            : candidate,
        );
        const nextRecord: InstalledSkill = { ...record, targets: nextTargets };
        yield* persistManifest({
          ...manifest,
          skills: manifest.skills.map((skill) => (skill.id === record.id ? nextRecord : skill)),
        });
        return nextRecord;
      }),
    );
  });

  return SkillStoreService.of({
    search,
    getDetail,
    listInstalled,
    install,
    uninstall,
    setHarnessEnabled,
  });
});

export const layer = Layer.effect(SkillStoreService, make);

/** Test double: in-memory manifest, no CLI or network. */
export const layerTest = (overrides?: Partial<SkillStoreService["Service"]>) =>
  Layer.succeed(
    SkillStoreService,
    SkillStoreService.of({
      search: () => Effect.succeed({ skills: [] }),
      getDetail: () =>
        Effect.fail(
          new RegistrySkillStoreError({ reason: "notFound", detail: "not implemented in test" }),
        ),
      listInstalled: Effect.succeed({ skills: [] }),
      install: () =>
        Effect.fail(
          new RegistrySkillStoreError({
            reason: "installFailed",
            detail: "not implemented in test",
          }),
        ),
      uninstall: () => Effect.succeed({ skills: [] }),
      setHarnessEnabled: () =>
        Effect.fail(
          new RegistrySkillStoreError({ reason: "notFound", detail: "not implemented in test" }),
        ),
      ...overrides,
    }),
  );
