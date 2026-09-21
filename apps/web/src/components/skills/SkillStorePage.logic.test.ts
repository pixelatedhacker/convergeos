import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  buildInstallPlan,
  formatInstallCount,
  installedTargetKey,
  installedTargetLabel,
  skillStoreHarnessLabel,
} from "./SkillStorePage.logic";

describe("formatInstallCount", () => {
  it("keeps small counts exact", () => {
    expect(formatInstallCount(0)).toBe("0");
    expect(formatInstallCount(999)).toBe("999");
  });

  it("abbreviates thousands", () => {
    expect(formatInstallCount(1500)).toBe("1.5k");
    expect(formatInstallCount(2000)).toBe("2k");
  });
});

describe("skillStoreHarnessLabel", () => {
  it("labels known harnesses", () => {
    expect(skillStoreHarnessLabel("claude-code")).toBe("Claude Code");
    expect(skillStoreHarnessLabel("opencode")).toBe("OpenCode");
  });
});

describe("installedTargetKey", () => {
  it("distinguishes global from project scopes", () => {
    expect(installedTargetKey({ scope: "global", harnesses: [] })).toBe("global");
    expect(
      installedTargetKey({
        scope: "project",
        projectId: ProjectId.make("p1"),
        harnesses: [],
      }),
    ).toBe("project:p1");
  });
});

describe("installedTargetLabel", () => {
  it("labels global targets as environment-wide", () => {
    expect(installedTargetLabel({ scope: "global", harnesses: [] }, new Map())).toBe(
      "Environment-wide",
    );
  });

  it("resolves project names and falls back for unknown projects", () => {
    const names = new Map([[ProjectId.make("p1") as string, "convergeos"]]);
    expect(
      installedTargetLabel(
        { scope: "project", projectId: ProjectId.make("p1"), harnesses: [] },
        names,
      ),
    ).toBe("convergeos");
    expect(
      installedTargetLabel(
        { scope: "project", projectId: ProjectId.make("gone"), harnesses: [] },
        names,
      ),
    ).toBe("Unknown project");
  });
});

describe("buildInstallPlan", () => {
  const envA = EnvironmentId.make("env-a");
  const envB = EnvironmentId.make("env-b");

  it("returns no plan without harnesses", () => {
    expect(
      buildInstallPlan({
        scope: "global",
        projectEnvironmentId: null,
        projectId: null,
        globalEnvironmentIds: [envA],
        harnesses: [],
      }),
    ).toEqual([]);
  });

  it("fans a global install out to every selected environment", () => {
    expect(
      buildInstallPlan({
        scope: "global",
        projectEnvironmentId: null,
        projectId: null,
        globalEnvironmentIds: [envA, envB],
        harnesses: ["codex", "cursor"],
      }),
    ).toEqual([
      { environmentId: envA, targets: [{ scope: "global", harnesses: ["codex", "cursor"] }] },
      { environmentId: envB, targets: [{ scope: "global", harnesses: ["codex", "cursor"] }] },
    ]);
  });

  it("pins a project install to the project's own environment", () => {
    expect(
      buildInstallPlan({
        scope: "project",
        projectEnvironmentId: envB,
        projectId: ProjectId.make("p1"),
        globalEnvironmentIds: [envA],
        harnesses: ["claude-code"],
      }),
    ).toEqual([
      {
        environmentId: envB,
        targets: [
          { scope: "project", projectId: ProjectId.make("p1"), harnesses: ["claude-code"] },
        ],
      },
    ]);
  });

  it("returns no plan for project scope without a project", () => {
    expect(
      buildInstallPlan({
        scope: "project",
        projectEnvironmentId: null,
        projectId: null,
        globalEnvironmentIds: [envA],
        harnesses: ["codex"],
      }),
    ).toEqual([]);
  });
});
