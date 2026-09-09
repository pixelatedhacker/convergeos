import { describe, expect, it } from "vite-plus/test";

import { resolveBotComputerViewerUrl } from "./botComputer.ts";

describe("resolveBotComputerViewerUrl", () => {
  it("targets the selected environment origin", () => {
    expect(
      resolveBotComputerViewerUrl(
        "https://environment.example.test/",
        "/api/bot-computer/view/token/vnc.html?path=websockify",
      ),
    ).toBe("https://environment.example.test/api/bot-computer/view/token/vnc.html?path=websockify");
  });

  it("rejects untrusted schemes and paths", () => {
    expect(
      resolveBotComputerViewerUrl("file:///tmp", "/api/bot-computer/view/token/vnc.html"),
    ).toBeUndefined();
    expect(
      resolveBotComputerViewerUrl("https://environment.test", "javascript:alert(1)"),
    ).toBeUndefined();
    expect(
      resolveBotComputerViewerUrl("https://environment.test", "//evil.test/viewer"),
    ).toBeUndefined();
  });
});
