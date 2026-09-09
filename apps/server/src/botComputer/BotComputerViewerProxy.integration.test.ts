// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { AuthSessionId, ThreadId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpServer, HttpRouter } from "effect/unstable/http";
import { describe, expect } from "vite-plus/test";

import * as BotComputer from "./BotComputerService.ts";
import {
  BOT_COMPUTER_VIEWER_ROUTE_PREFIX,
  BotComputerViewerAccessService,
  make as makeViewerAccess,
} from "./BotComputerViewerAccess.ts";
import { botComputerViewerProxyRouteLayer } from "./BotComputerViewerProxy.ts";
import * as SessionStore from "../auth/SessionStore.ts";

const sessionId = AuthSessionId.make("session-viewer-test");
const threadId = ThreadId.make("thread-viewer-test");
const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

interface Upstream {
  readonly httpUrl: string;
  readonly close: () => Promise<void>;
  readonly closed: Promise<void>;
  readonly received: Promise<Uint8Array>;
}

const makeUpstream = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<Upstream>((resolve, reject) => {
        const server = NodeHttp.createServer((request, response) => {
          if (request.url === "/vnc.html") {
            response.setHeader("content-type", "text/html");
            response.end("<!doctype html><html><head></head><body>viewer</body></html>");
            return;
          }
          response.setHeader("content-type", "application/octet-stream");
          response.end(Buffer.from([1, 2, 3, 4]));
        });
        const webSockets = new NodeSocket.NodeWS.WebSocketServer({ server });
        let resolveClosed!: () => void;
        let resolveReceived!: (value: Uint8Array) => void;
        const closed = new Promise<void>((resolveClosedPromise) => {
          resolveClosed = resolveClosedPromise;
        });
        const received = new Promise<Uint8Array>((resolveReceivedPromise) => {
          resolveReceived = resolveReceivedPromise;
        });
        webSockets.on("connection", (socket) => {
          socket.on("message", (message, isBinary) => {
            const bytes = isBinary
              ? new Uint8Array(message as Buffer)
              : new TextEncoder().encode(String(message));
            resolveReceived(bytes);
            socket.send(bytes);
          });
          socket.on("close", () => resolveClosed());
        });
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Expected an ephemeral TCP address"));
            return;
          }
          resolve({
            httpUrl: `http://127.0.0.1:${address.port}`,
            closed,
            received,
            close: () =>
              new Promise<void>((resolveClose, rejectClose) => {
                webSockets.close(() =>
                  server.close((error) => (error ? rejectClose(error) : resolveClose())),
                );
              }),
          });
        });
      }),
  ),
  (upstream) => Effect.promise(upstream.close),
);

const makeActiveSessionStore = () =>
  Layer.mock(SessionStore.SessionStore)({
    cookieName: "test-session",
    legacyCookieName: undefined,
    listActive: () =>
      Effect.succeed([
        {
          sessionId,
          subject: "viewer-test",
          scopes: ["orchestration:operate"],
          method: "browser-session-cookie",
          client: { deviceType: "desktop" },
          issuedAt: now,
          expiresAt: DateTime.add(now, { hours: 1 }),
          lastConnectedAt: null,
          connected: true,
          current: true,
        },
      ]),
    // Keep the revocation watcher alive for the lifetime of the proxy socket.
    streamChanges: Stream.never,
  });

const makeProxyLayer = (
  access: BotComputerViewerAccessService["Service"],
  target: { readonly containerId: string; readonly viewerPort: number },
) =>
  HttpRouter.serve(botComputerViewerProxyRouteLayer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(Layer.succeed(BotComputerViewerAccessService, access)),
    Layer.provide(
      Layer.mock(BotComputer.BotComputerService)({
        viewerTarget: () => Effect.succeed(target),
      }),
    ),
    Layer.provide(makeActiveSessionStore()),
    Layer.provide(FetchHttpClient.layer),
  );

const issueAccess = (access: BotComputerViewerAccessService["Service"], viewerPort: number) =>
  Effect.gen(function* () {
    const issued = yield* access.issue({
      sessionId,
      threadId,
      containerId: "container-viewer-test",
      viewerPort,
    });
    const match = issued.viewerPath.match(
      new RegExp(`${BOT_COMPUTER_VIEWER_ROUTE_PREFIX}/([^/]+)/`),
    );
    if (match?.[1] === undefined) {
      return yield* Effect.die("Viewer token was not included in path");
    }
    return { issued, token: match[1] };
  });

describe("BotComputerViewerProxy integration", () => {
  it.effect("scopes access to a thread and expires old entries", () =>
    Effect.gen(function* () {
      let observedAt = 0;
      const access = makeViewerAccess({ nowMs: () => observedAt });
      const first = yield* issueAccess(access, 49152);
      const second = yield* issueAccess(access, 49152);
      expect(yield* access.resolve(first.token)).toBeDefined();
      expect(yield* access.resolve(second.token)).toBeDefined();

      observedAt = 300_001;
      expect(yield* access.resolve(first.token)).toBeUndefined();
      expect(yield* access.resolve(second.token)).toBeUndefined();

      observedAt = 600_000;
      const current = yield* issueAccess(access, 49152);
      const currentSecond = yield* issueAccess(access, 49152);
      yield* access.revokeThread(threadId);
      expect(yield* access.resolve(current.token)).toBeUndefined();
      expect(yield* access.resolve(currentSecond.token)).toBeUndefined();
    }),
  );

  it.effect("proxies valid noVNC HTTP content and rejects invalid or revoked access", () =>
    Effect.gen(function* () {
      const upstream = yield* makeUpstream;
      const port = Number(new URL(upstream.httpUrl).port);
      const access = makeViewerAccess();
      yield* Effect.gen(function* () {
        yield* Layer.build(
          makeProxyLayer(access, { containerId: "container-viewer-test", viewerPort: port }),
        );
        const { token } = yield* issueAccess(access, port);
        const client = yield* HttpClient.HttpClient;

        const viewer = yield* client.get(`${BOT_COMPUTER_VIEWER_ROUTE_PREFIX}/${token}/vnc.html`);
        expect(viewer.status).toBe(200);
        expect(yield* viewer.text).toContain('Object.defineProperty(window, "localStorage"');

        const binary = yield* client.get(
          `${BOT_COMPUTER_VIEWER_ROUTE_PREFIX}/${token}/core/rfb.js`,
        );
        expect(binary.status).toBe(200);
        expect(yield* binary.text).toBe(String.fromCharCode(1, 2, 3, 4));

        const invalid = yield* client.get(
          `${BOT_COMPUTER_VIEWER_ROUTE_PREFIX}/${"x".repeat(43)}/vnc.html`,
        );
        expect(invalid.status).toBe(404);
        yield* access.revokeThread(threadId);
        const revoked = yield* client.get(`${BOT_COMPUTER_VIEWER_ROUTE_PREFIX}/${token}/vnc.html`);
        expect(revoked.status).toBe(404);
      }).pipe(Effect.provide(NodeHttpServer.layerTest));
    }),
  );

  it.effect("forwards binary WebSocket frames and closes upstream when the viewer closes", () =>
    Effect.gen(function* () {
      const upstream = yield* makeUpstream;
      const port = Number(new URL(upstream.httpUrl).port);
      const access = makeViewerAccess();
      yield* Effect.gen(function* () {
        yield* Layer.build(
          makeProxyLayer(access, { containerId: "container-viewer-test", viewerPort: port }),
        );
        const { token } = yield* issueAccess(access, port);
        const server = yield* HttpServer.HttpServer;
        const address = server.address;
        if (address._tag !== "TcpAddress") {
          return yield* Effect.die("Expected a TCP test server");
        }
        const websocket = new NodeSocket.NodeWS.WebSocket(
          `ws://127.0.0.1:${address.port}${BOT_COMPUTER_VIEWER_ROUTE_PREFIX}/${token}/websockify`,
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => websocket.close()));
        const opened = new Promise<void>((resolve, reject) => {
          websocket.once("open", resolve);
          websocket.once("error", reject);
          websocket.once("unexpected-response", (_request, response) => {
            reject(
              new Error(`Proxy rejected WebSocket with HTTP ${response.statusCode ?? "unknown"}`),
            );
          });
        });
        const received = new Promise<Uint8Array>((resolve, reject) => {
          websocket.once("message", (message, isBinary) => {
            resolve(
              isBinary
                ? new Uint8Array(message as Buffer)
                : new TextEncoder().encode(String(message)),
            );
          });
          websocket.once("error", reject);
          websocket.once("close", () => reject(new Error("Proxy viewer closed before echo")));
        });
        yield* Effect.promise(() => opened);
        websocket.send(Buffer.from([9, 8, 7]));
        expect([...((yield* Effect.promise(() => upstream.received)) as Uint8Array)]).toEqual([
          9, 8, 7,
        ]);
        expect([...((yield* Effect.promise(() => received)) as Uint8Array)]).toEqual([9, 8, 7]);
        websocket.close();
        yield* Effect.promise(() => upstream.closed);
      }).pipe(Effect.provide(NodeHttpServer.layerTest));
    }),
  );
});
