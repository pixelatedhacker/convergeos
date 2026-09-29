import { describe, expect, it } from "vite-plus/test";

import {
  applyConvergeOsEnvironmentAliases,
  withConvergeOsEnvironmentAliases,
} from "./convergeOsEnvironment.ts";

describe("ConvergeOS environment aliases", () => {
  it("accepts legacy T3CODE variables", () => {
    const environment = { T3CODE_HOST: "127.0.0.1" };

    applyConvergeOsEnvironmentAliases(environment);

    expect(environment).toEqual({ T3CODE_HOST: "127.0.0.1", CONVERGEOS_HOST: "127.0.0.1" });
  });

  it("gives canonical variables precedence", () => {
    const environment = withConvergeOsEnvironmentAliases({
      CONVERGEOS_HOME: "/new-home",
      T3CODE_HOME: "/legacy-home",
    });

    expect(environment.CONVERGEOS_HOME).toBe("/new-home");
    expect(environment.T3CODE_HOME).toBe("/new-home");
  });

  it("ignores another product's home and port", () => {
    const environment = withConvergeOsEnvironmentAliases({
      T3CODE_HOME: "/t3-data",
      T3CODE_PORT: "3773",
    });
    expect(environment).toEqual({});
  });

  it("keeps canonical home and port aliases stable across repeated bootstrap", () => {
    const environment = withConvergeOsEnvironmentAliases({
      CONVERGEOS_HOME: "/convergeos-data",
      CONVERGEOS_PORT: "4773",
      T3CODE_HOME: "/t3-data",
      T3CODE_PORT: "3773",
    });
    expect(withConvergeOsEnvironmentAliases(environment)).toEqual(environment);
    expect(environment.T3CODE_HOME).toBe("/convergeos-data");
    expect(environment.T3CODE_PORT).toBe("4773");
  });

  it("does not mutate a source passed to the copy helper", () => {
    const source = { T3CODE_HOST: "127.0.0.1" };

    withConvergeOsEnvironmentAliases(source);

    expect(source).toEqual({ T3CODE_HOST: "127.0.0.1" });
  });
});
