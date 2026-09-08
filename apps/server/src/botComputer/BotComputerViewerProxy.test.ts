// @effect-diagnostics nodeBuiltinImport:off
import * as NodeVm from "node:vm";

import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { describe, expect } from "vite-plus/test";

import {
  executeViewerHttpRequest,
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

  it.effect("waits for the initial noVNC document to become reachable", () =>
    Effect.gen(function* () {
      const firstAttempt = yield* Deferred.make<void>();
      let attempts = 0;
      const client = HttpClient.make((request) => {
        attempts += 1;
        if (attempts === 1) {
          return Deferred.succeed(firstAttempt, undefined).pipe(
            Effect.andThen(
              Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({
                    request,
                    cause: new Error("viewer is still starting"),
                  }),
                }),
              ),
            ),
          );
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("<html><head></head></html>")),
        );
      });
      const request = HttpClientRequest.get("http://127.0.0.1:49152/vnc.html");
      const responseFiber = yield* executeViewerHttpRequest(
        Effect.succeed(true),
        client,
        request,
        true,
      ).pipe(Effect.forkChild);

      yield* Deferred.await(firstAttempt);
      expect(attempts).toBe(1);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("100 millis");

      const response = yield* Fiber.join(responseFiber);
      expect(Option.getOrThrow(response).status).toBe(200);
      expect(attempts).toBe(2);
    }),
  );

  it.effect("stops retrying when viewer access changes between attempts", () =>
    Effect.gen(function* () {
      const firstAttempt = yield* Deferred.make<void>();
      let accessIsCurrent = true;
      let requests = 0;
      const client = HttpClient.make((request) => {
        requests += 1;
        return Deferred.succeed(firstAttempt, undefined).pipe(
          Effect.andThen(
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  cause: new Error("viewer is still starting"),
                }),
              }),
            ),
          ),
        );
      });
      const responseFiber = yield* executeViewerHttpRequest(
        Effect.sync(() => accessIsCurrent),
        client,
        HttpClientRequest.get("http://127.0.0.1:49152/vnc.html"),
        true,
      ).pipe(Effect.forkChild);

      yield* Deferred.await(firstAttempt);
      accessIsCurrent = false;
      yield* Effect.yieldNow;
      yield* TestClock.adjust("100 millis");

      expect(yield* Fiber.join(responseFiber)).toEqual(Option.none());
      expect(requests).toBe(1);
    }),
  );
});
