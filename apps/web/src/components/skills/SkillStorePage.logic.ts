import {
  SkillStoreHarness,
  type EnvironmentId,
  type InstalledSkillTarget,
  type ProjectId,
  type SkillStoreEntry,
  type SkillStoreInstallInput,
} from "@t3tools/contracts";

/** Harnesses the store can install to, in display order. */
export const SKILL_STORE_HARNESSES = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "grok", label: "Grok" },
  { id: "opencode", label: "OpenCode" },
  { id: "antigravity", label: "Antigravity" },
] as const satisfies ReadonlyArray<{ id: SkillStoreHarness; label: string }>;

export const skillStoreHarnessLabel = (harness: SkillStoreHarness): string =>
  SKILL_STORE_HARNESSES.find((entry) => entry.id === harness)?.label ?? harness;

export const formatInstallCount = (installs: SkillStoreEntry["installs"]): string =>
  installs >= 1000 ? `${(installs / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(installs);

/** Stable identity for one installed target row (scope + project). */
export const installedTargetKey = (target: InstalledSkillTarget): string =>
  target.scope === "project" ? `project:${target.projectId ?? ""}` : "global";

export const installedTargetLabel = (
  target: InstalledSkillTarget,
  projectNameById: ReadonlyMap<string, string>,
): string =>
  target.scope === "project"
    ? (projectNameById.get(target.projectId ?? "") ?? "Unknown project")
    : "Environment-wide";

export interface SkillInstallPlanTarget {
  readonly environmentId: EnvironmentId;
  readonly targets: SkillStoreInstallInput["targets"];
}

/**
 * Builds the per-environment install fan-out. Project scope pins the install
 * to the environment that owns the project; global scope repeats one global
 * target per selected environment.
 */
export function buildInstallPlan(input: {
  readonly scope: "global" | "project";
  readonly projectEnvironmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly globalEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly harnesses: ReadonlyArray<SkillStoreHarness>;
}): SkillInstallPlanTarget[] {
  if (input.harnesses.length === 0) return [];
  const harnesses = [...input.harnesses] as [SkillStoreHarness, ...SkillStoreHarness[]];
  if (input.scope === "project") {
    if (input.projectEnvironmentId === null || input.projectId === null) return [];
    return [
      {
        environmentId: input.projectEnvironmentId,
        targets: [{ scope: "project", projectId: input.projectId, harnesses }],
      },
    ];
  }
  return input.globalEnvironmentIds.map((environmentId) => ({
    environmentId,
    targets: [{ scope: "global", harnesses }],
  }));
}
