import { describe, expect, it } from "@effect/vitest";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { AntigravityCliDriver } from "./AntigravityCliDriver.ts";

describe("AntigravityCliDriver", () => {
  it("registers native agy separately from the existing ACP integration", () => {
    expect(AntigravityCliDriver.driverKind).toBe("antigravityCli");
    expect(AntigravityCliDriver.defaultConfig()).toEqual({ enabled: false, binaryPath: "agy" });
    expect(BUILT_IN_DRIVERS).toContain(AntigravityCliDriver);
    expect(BUILT_IN_DRIVERS.find((driver) => driver.driverKind === "antigravity")).toBeDefined();
  });
});
