import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { BotComputerCapability } from "./botComputer.ts";

const decodeCapability = Schema.decodeUnknownSync(BotComputerCapability);

describe("BotComputerCapability", () => {
  it("accepts the truthful outbound-only V1 capability", () => {
    expect(
      decodeCapability({
        viewerAccess: "host-local",
        isolation: "container",
        networkAccessModes: ["outbound"],
        warning: "This computer uses container isolation. It is not containment for hostile code.",
      }).networkAccessModes,
    ).toEqual(["outbound"]);
  });
});
