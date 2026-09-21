import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

/**
 * Skill store: discovery and installation of third-party agent skills backed
 * by the skills.sh registry (the open agent-skills ecosystem behind the
 * `skills` CLI). Discovery is plain HTTP against skills.sh; installation runs
 * the vendored `skills` CLI on the target environment so per-harness
 * directory layouts stay upstream's problem.
 *
 * State is per environment: each ConvergeOS server keeps its own manifest of
 * what it installed where, and clients fan out to multiple environments by
 * repeating the RPC per `environmentId`.
 */

export const SKILL_STORE_SEARCH_DEFAULT_LIMIT = 20;
export const SKILL_STORE_SEARCH_MAX_LIMIT = 50;
/** Detail responses cap individual file contents so a skill bundle cannot flood the wire. */
export const SKILL_STORE_DETAIL_MAX_FILE_BYTES = 256 * 1024;

/**
 * Harness slugs as the `skills` CLI names them (`--agent`). These are the
 * install targets the store UI offers; ConvergeOS provider driver kinds map
 * onto them via {@link SKILL_STORE_HARNESS_BY_DRIVER_KIND}.
 */
export const SkillStoreHarness = Schema.Literals([
  "claude-code",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
]);
export type SkillStoreHarness = typeof SkillStoreHarness.Type;

/**
 * Provider driver kind -> skills CLI agent slug. Drivers without a mapping
 * (ohMyPi, antigravityCli) are not valid install targets and stay hidden in
 * the store UI.
 */
export const SKILL_STORE_HARNESS_BY_DRIVER_KIND: Readonly<
  Record<string, SkillStoreHarness | undefined>
> = {
  claudeAgent: "claude-code",
  codex: "codex",
  cursor: "cursor",
  grok: "grok",
  opencode: "opencode",
  antigravity: "antigravity",
};

export const skillStoreHarnessForDriverKind = (
  driverKind: ProviderDriverKind,
): SkillStoreHarness | undefined => SKILL_STORE_HARNESS_BY_DRIVER_KIND[driverKind];

/** Project scope installs into the repo (committed or gitignored); global scope into the environment user's home. */
export const RegistrySkillStoreScope = Schema.Literals(["global", "project"]);
export type RegistrySkillStoreScope = typeof RegistrySkillStoreScope.Type;

/** One registry search hit. `id` is the full slug `<owner>/<repo>/<skillId>`. */
export const SkillStoreEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  skillId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  /** `<owner>/<repo>` source repository. */
  source: TrimmedNonEmptyString,
  installs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  url: TrimmedNonEmptyString,
});
export type SkillStoreEntry = typeof SkillStoreEntry.Type;

export const SkillStoreSearchInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(Schema.isMinLength(2)),
  limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
    .check(Schema.isLessThanOrEqualTo(SKILL_STORE_SEARCH_MAX_LIMIT))
    .pipe(Schema.withDecodingDefault(Effect.succeed(SKILL_STORE_SEARCH_DEFAULT_LIMIT))),
});
export type SkillStoreSearchInput = typeof SkillStoreSearchInput.Type;

export const SkillStoreSearchResult = Schema.Struct({
  skills: Schema.Array(SkillStoreEntry),
});
export type SkillStoreSearchResult = typeof SkillStoreSearchResult.Type;

export const SkillStoreDetailInput = Schema.Struct({
  source: TrimmedNonEmptyString,
  skillId: TrimmedNonEmptyString,
});
export type SkillStoreDetailInput = typeof SkillStoreDetailInput.Type;

export const SkillStoreFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  contents: Schema.String,
});
export type SkillStoreFile = typeof SkillStoreFile.Type;

/** Full skill bundle for the detail view, fetched on demand from the registry. */
export const SkillStoreDetail = Schema.Struct({
  id: TrimmedNonEmptyString,
  skillId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  /** Parsed from SKILL.md frontmatter when present. */
  description: Schema.NullOr(Schema.String),
  source: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  files: Schema.Array(SkillStoreFile),
});
export type SkillStoreDetail = typeof SkillStoreDetail.Type;

/** Where one install lands: a scope (env-global or one project) times a set of harnesses. */
export const SkillStoreInstallTarget = Schema.Struct({
  scope: RegistrySkillStoreScope,
  /** Required when scope is "project"; identifies the project whose root the CLI runs in. */
  projectId: Schema.optional(ProjectId),
  harnesses: Schema.NonEmptyArray(SkillStoreHarness),
});
export type SkillStoreInstallTarget = typeof SkillStoreInstallTarget.Type;

export const SkillStoreInstallInput = Schema.Struct({
  source: TrimmedNonEmptyString,
  skillId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  targets: Schema.NonEmptyArray(SkillStoreInstallTarget),
});
export type SkillStoreInstallInput = typeof SkillStoreInstallInput.Type;

export const InstalledSkillTarget = Schema.Struct({
  scope: RegistrySkillStoreScope,
  projectId: Schema.optional(ProjectId),
  harnesses: Schema.Array(SkillStoreHarness),
});
export type InstalledSkillTarget = typeof InstalledSkillTarget.Type;

/** Persisted manifest record for one installed skill on this environment. */
export const InstalledSkill = Schema.Struct({
  /** `<source>/<skillId>`. */
  id: TrimmedNonEmptyString,
  source: TrimmedNonEmptyString,
  skillId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  targets: Schema.Array(InstalledSkillTarget),
  installedAt: IsoDateTime,
});
export type InstalledSkill = typeof InstalledSkill.Type;

export const SkillStoreListResult = Schema.Struct({
  skills: Schema.Array(InstalledSkill),
});
export type SkillStoreListResult = typeof SkillStoreListResult.Type;

export const SkillStoreUninstallInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type SkillStoreUninstallInput = typeof SkillStoreUninstallInput.Type;

/**
 * Toggles one harness within one installed target. Enabling re-runs the CLI
 * add for that harness; disabling removes the skill from that harness only,
 * keeping the manifest record and every other target.
 */
export const SkillStoreSetHarnessEnabledInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  scope: RegistrySkillStoreScope,
  projectId: Schema.optional(ProjectId),
  harness: SkillStoreHarness,
  enabled: Schema.Boolean,
});
export type SkillStoreSetHarnessEnabledInput = typeof SkillStoreSetHarnessEnabledInput.Type;

export const RegistrySkillStoreErrorReason = Schema.Literals([
  "registryUnavailable",
  "cliUnavailable",
  "installFailed",
  "removeFailed",
  "notFound",
  "invalidInput",
]);
export type RegistrySkillStoreErrorReason = typeof RegistrySkillStoreErrorReason.Type;

export class RegistrySkillStoreError extends Schema.TaggedError<RegistrySkillStoreError>()(
  "RegistrySkillStoreError",
  {
    reason: RegistrySkillStoreErrorReason,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Skill store operation failed (${this.reason}): ${this.detail}`;
  }
}
