import type { BotComputerState, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botComputerDisplayState,
  botComputerPrimaryAction,
  botComputerStatusLabel,
  canOpenHostLocalViewer,
} from "./BotComputerPanel.logic";

const threadId = "thread-1" as ThreadId;
const base = {
  threadId,
  viewerAccess: "host-local" as const,
  isolation: "container" as const,
  warning:
    "This computer uses container isolation. It is not containment for hostile code." as const,
};

describe("BotComputerPanel logic", () => {
  it("maps lifecycle states to the one primary recovery action", () => {
    const absent = { ...base, status: "absent" } satisfies BotComputerState;
    const suspended = {
      ...base,
      status: "suspended",
      containerId: "container-1",
      networkAccess: "outbound",
    } satisfies BotComputerState;
    const failed = {
      ...base,
      status: "failed",
      operation: "inspect",
      detail: "Docker inspection failed.",
    } satisfies BotComputerState;
    const running = {
      ...base,
      status: "running",
      containerId: "container-1",
      viewerPort: 49152,
      viewerUrl: "http://127.0.0.1:49152/vnc.html",
      networkAccess: "outbound",
    } satisfies BotComputerState;

    expect(botComputerPrimaryAction(absent)).toBe("start");
    expect(botComputerPrimaryAction(suspended)).toBe("resume");
    expect(botComputerPrimaryAction(failed)).toBe("retry");
    expect(botComputerPrimaryAction(running)).toBeNull();
    expect(botComputerStatusLabel(suspended)).toBe("Suspended");
  });

  it("keeps the last failed mutation visible until the user retries or refreshes", () => {
    const absent = { ...base, status: "absent" } satisfies BotComputerState;
    const failed = {
      ...base,
      status: "failed",
      operation: "start",
      detail: "Docker could not create the container.",
    } satisfies BotComputerState;

    expect(botComputerDisplayState(absent, failed)).toEqual(failed);
    expect(botComputerDisplayState(absent, absent)).toEqual(absent);
  });

  it("only embeds the expected cross-origin loopback viewer", () => {
    const input = {
      environmentHttpBaseUrl: "http://localhost:13773",
      viewerUrl: "http://127.0.0.1:49152/vnc.html?autoconnect=1",
      viewerPort: 49152,
      clientOrigin: "http://localhost:5733",
    } as const;

    expect(canOpenHostLocalViewer(input)).toBe(true);
    expect(
      canOpenHostLocalViewer({ ...input, environmentHttpBaseUrl: "https://devbox.tailnet.ts.net" }),
    ).toBe(false);
    expect(canOpenHostLocalViewer({ ...input, viewerUrl: "https://example.com/vnc.html" })).toBe(
      false,
    );
    expect(canOpenHostLocalViewer({ ...input, viewerUrl: "http://127.0.0.1:49153/vnc.html" })).toBe(
      false,
    );
    expect(
      canOpenHostLocalViewer({
        ...input,
        viewerUrl: "http://localhost:5733/vnc.html",
        viewerPort: 5733,
      }),
    ).toBe(false);
    expect(canOpenHostLocalViewer({ ...input, viewerUrl: "not a url" })).toBe(false);
  });
});
