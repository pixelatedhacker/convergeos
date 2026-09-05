import { describe, expect, it } from "vite-plus/test";

import {
  applyConvergeOsEnvironmentAliases,
  withConvergeOsEnvironmentAliases,
} from "./convergeOsEnvironment.ts";

describe("ConvergeOS environment aliases", () => {
  it("accepts legacy T3CODE variables", () => {
    const environment = { T3CODE_PORT: "13773" };

    applyConvergeOsEnvironmentAliases(environment);

    expect(environment).toEqual({ T3CODE_PORT: "13773", CONVERGEOS_PORT: "13773" });
  });

  it("gives canonical variables precedence", () => {
    const environment = withConvergeOsEnvironmentAliases({
      CONVERGEOS_HOME: "/new-home",
      T3CODE_HOME: "/legacy-home",
    });

    expect(environment.CONVERGEOS_HOME).toBe("/new-home");
    expect(environment.T3CODE_HOME).toBe("/new-home");
  });

  it("does not mutate a source passed to the copy helper", () => {
    const source = { T3CODE_HOST: "127.0.0.1" };

    withConvergeOsEnvironmentAliases(source);

    expect(source).toEqual({ T3CODE_HOST: "127.0.0.1" });
  });
});
