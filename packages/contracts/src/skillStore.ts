import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ServerProviderSkill } from "./server.ts";

export const SkillStoreTarget = Schema.Struct({
  instanceId: ProviderInstanceId,
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type SkillStoreTarget = typeof SkillStoreTarget.Type;
export const SkillStoreScope = Schema.Literals(["user", "project"]);
export const SkillStorePlugin = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  source: Schema.String,
  scope: Schema.String,
  installed: Schema.Boolean,
  enabled: Schema.Boolean,
  version: Schema.String,
});
export const SkillStoreSnapshot = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      ...ServerProviderSkill.fields,
      managed: Schema.Boolean,
      source: Schema.optional(Schema.String),
    }),
  ),
  skillRoots: Schema.Array(Schema.Struct({ scope: SkillStoreScope, path: Schema.String })),
  plugins: Schema.Array(SkillStorePlugin),
  pluginManagement: Schema.Boolean,
  skillEnablement: Schema.Boolean,
  notice: Schema.String,
});
export type SkillStoreSnapshot = typeof SkillStoreSnapshot.Type;
export const SkillStoreAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("set-skill-enabled"),
    path: TrimmedNonEmptyString,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("import-skill"),
    scope: SkillStoreScope,
    sourcePath: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("remove-skill"),
    scope: SkillStoreScope,
    name: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("plugin"),
    operation: Schema.Literals(["install", "uninstall", "enable", "disable"]),
    scope: SkillStoreScope,
    id: TrimmedNonEmptyString,
  }),
]);
export type SkillStoreAction = typeof SkillStoreAction.Type;
export const SkillStoreMutation = Schema.Struct({
  ...SkillStoreTarget.fields,
  action: SkillStoreAction,
});
export type SkillStoreMutation = typeof SkillStoreMutation.Type;
export class SkillStoreError extends Schema.TaggedError<SkillStoreError>()("SkillStoreError", {
  message: Schema.String,
}) {}
