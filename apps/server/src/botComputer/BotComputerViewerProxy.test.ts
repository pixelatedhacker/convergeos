// @effect-diagnostics nodeBuiltinImport:off
import * as NodeVm from "node:vm";

import { describe, expect, it } from "vite-plus/test";

import {
  injectBotComputerViewerStorageShim,
  parseBotComputerViewerPath,
} from "./BotComputerViewerProxy.ts";

describe("BotComputerViewerProxy", () => {
  it("parses only token-scoped non-traversing viewer paths", () => {
    const token = "a".repeat(43);
    expect(parseBotComputerViewerPath(`/api/bot-computer/view/${token}/core/rfb.js`)).toEqual({
      token,
      upstreamPath: "core/rfb.js",
    });
    expect(parseBotComputerViewerPath(`/api/bot-computer/view/${token}/../secret`)).toBeUndefined();
    expect(parseBotComputerViewerPath("/api/bot-computer/view/short/vnc.html")).toBeUndefined();
  });

  it("injects the opaque-origin storage shim before noVNC modules run", () => {
    const html =
      "<!doctype html><html><head><script type=module src=app/ui.js></script></head></html>";
    const injected = injectBotComputerViewerStorageShim(html);
    expect(injected).toContain('Object.defineProperty(window, "localStorage"');
    expect(injected?.indexOf("Object.defineProperty")).toBeLessThan(
      injected?.indexOf("app/ui.js") ?? 0,
    );
    const script = injected?.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    const context = NodeVm.createContext({ Map });
    Object.defineProperty(context, "window", { value: context });
    Object.defineProperty(context, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("opaque origin");
      },
    });
    NodeVm.runInContext(script ?? "", context);
    const storage = context.localStorage as Storage;
    storage.setItem("resize", "remote");
    expect(storage.getItem("resize")).toBe("remote");
    expect(storage.length).toBe(1);
    storage.removeItem("resize");
    expect(storage.getItem("resize")).toBeNull();
    expect(injectBotComputerViewerStorageShim("<html></html>")).toBeUndefined();
  });
});
