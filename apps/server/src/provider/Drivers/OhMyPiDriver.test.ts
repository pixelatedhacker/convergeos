import { describe, expect, it } from "@effect/vitest";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { OhMyPiDriver } from "./OhMyPiDriver.ts";

describe("OhMyPiDriver", () => {
  it("ships as a disabled first-party driver with the omp executable", () => {
    expect(OhMyPiDriver.driverKind).toBe("ohMyPi");
    expect(OhMyPiDriver.defaultConfig()).toEqual({
      enabled: false,
      binaryPath: "omp",
    });
    expect(BUILT_IN_DRIVERS).toContain(OhMyPiDriver);
  });
});
