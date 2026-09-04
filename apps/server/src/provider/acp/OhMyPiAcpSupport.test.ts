import { describe, expect, it } from "@effect/vitest";

import {
  buildOhMyPiAcpSpawnInput,
  ohMyPiAcpSpawnArgs,
  ohMyPiApprovalMode,
} from "./OhMyPiAcpSupport.ts";

describe("ohMyPiApprovalMode", () => {
  it("maps every T3 runtime mode onto an explicit OMP approval policy", () => {
    expect(ohMyPiApprovalMode("approval-required")).toBe("always-ask");
    expect(ohMyPiApprovalMode("auto-accept-edits")).toBe("write");
    expect(ohMyPiApprovalMode("auto")).toBe("always-ask");
    expect(ohMyPiApprovalMode("full-access")).toBe("yolo");
  });
});

describe("ohMyPiAcpSpawnArgs", () => {
  it("starts ACP mode with the mapped approval policy", () => {
    expect(ohMyPiAcpSpawnArgs("approval-required")).toEqual([
      "acp",
      "--approval-mode",
      "always-ask",
    ]);
    expect(ohMyPiAcpSpawnArgs("auto-accept-edits")).toEqual(["acp", "--approval-mode", "write"]);
    expect(ohMyPiAcpSpawnArgs("full-access")).toEqual(["acp", "--approval-mode", "yolo"]);
  });
});

describe("buildOhMyPiAcpSpawnInput", () => {
  it("uses the configured binary, cwd, and instance environment", () => {
    expect(
      buildOhMyPiAcpSpawnInput(
        { binaryPath: "/opt/omp/bin/omp" },
        "/work/project",
        { OMP_CONFIG_DIR: "/work/config" },
        "auto",
      ),
    ).toEqual({
      command: "/opt/omp/bin/omp",
      args: ["acp", "--approval-mode", "always-ask"],
      cwd: "/work/project",
      env: { OMP_CONFIG_DIR: "/work/config" },
    });
  });

  it("defaults to the omp executable", () => {
    expect(buildOhMyPiAcpSpawnInput(undefined, "/work/project", undefined, "full-access")).toEqual({
      command: "omp",
      args: ["acp", "--approval-mode", "yolo"],
      cwd: "/work/project",
    });
  });
});
