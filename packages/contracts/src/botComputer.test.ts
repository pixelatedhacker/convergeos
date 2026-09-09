import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { BotComputerCapability, BotComputerState } from "./botComputer.ts";

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

  it("decodes both legacy host-local and authenticated remote running states", () => {
    const base = {
      threadId: "thread-1",
      status: "running",
      containerId: "container-1",
      isolation: "container",
      networkAccess: "outbound",
      warning: "This computer uses container isolation. It is not containment for hostile code.",
    } as const;
    const decode = Schema.decodeUnknownSync(BotComputerState);
    expect(
      decode({
        ...base,
        viewerAccess: "host-local",
        viewerPort: 49152,
        viewerUrl: "http://127.0.0.1:49152/vnc.html",
      }).viewerAccess,
    ).toBe("host-local");
    expect(decode({ ...base, viewerAccess: "authenticated-remote" }).viewerAccess).toBe(
      "authenticated-remote",
    );
  });
});
