import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import * as BotComputer from "./BotComputerService.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import {
  BOT_COMPUTER_VIEWER_ROUTE_PREFIX,
  BotComputerViewerAccessService,
} from "./BotComputerViewerAccess.ts";

const VIEWER_RESPONSE_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "private, no-store",
  "Content-Security-Policy": "sandbox allow-scripts allow-pointer-lock",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

const STORAGE_SHIM = `<script>
try { localStorage.length; } catch (_) {
  const values = new Map();
  Object.defineProperty(window, "localStorage", { value: {
    getItem: (key) => values.has(String(key)) ? values.get(String(key)) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
    clear: () => values.clear(),
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() { return values.size; }
  }});
}
</script>`;

export function injectBotComputerViewerStorageShim(html: string): string | undefined {
  const head = html.indexOf("<head>");
  if (head < 0) return undefined;
  return `${html.slice(0, head + 6)}${STORAGE_SHIM}${html.slice(head + 6)}`;
}

export const executeViewerHttpRequest = (
  validate: Effect.Effect<boolean>,
  httpClient: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  initialDocument: boolean,
) =>
  validate.pipe(
    Effect.flatMap((valid) =>
      valid
        ? httpClient.execute(request).pipe(Effect.map(Option.some))
        : Effect.succeed(Option.none()),
    ),
    initialDocument
      ? Effect.retry({ times: 49, schedule: Schedule.spaced("100 millis") })
      : (effect) => effect,
  );

export function parseBotComputerViewerPath(pathname: string) {
  const suffix = pathname.slice(`${BOT_COMPUTER_VIEWER_ROUTE_PREFIX}/`.length);
  const separator = suffix.indexOf("/");
  if (separator < 1) return undefined;
  const token = suffix.slice(0, separator);
  const upstreamPath = suffix.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return undefined;
  if (
    upstreamPath.length === 0 ||
    upstreamPath.startsWith("/") ||
    upstreamPath.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    return undefined;
  }
  return { token, upstreamPath };
}

const route = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const requestUrl = HttpServerRequest.toURL(request);
  if (Option.isNone(requestUrl)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const parsed = parseBotComputerViewerPath(requestUrl.value.pathname);
  if (parsed === undefined) return HttpServerResponse.text("Not Found", { status: 404 });

  const access = yield* BotComputerViewerAccessService;
  const target = yield* access.resolve(parsed.token);
  if (target === undefined) return HttpServerResponse.text("Not Found", { status: 404 });
  const sessions = yield* SessionStore.SessionStore;
  const botComputer = yield* BotComputer.BotComputerService;
  const targetIsCurrent = botComputer.viewerTarget({ threadId: target.threadId }).pipe(
    Effect.option,
    Effect.map(
      (current) =>
        Option.isSome(current) &&
        current.value.containerId === target.containerId &&
        current.value.viewerPort === target.viewerPort,
    ),
  );
  const accessIsCurrent = Effect.gen(function* () {
    const latestTarget = yield* access.resolve(parsed.token);
    if (
      latestTarget === undefined ||
      latestTarget.sessionId !== target.sessionId ||
      latestTarget.threadId !== target.threadId ||
      latestTarget.containerId !== target.containerId ||
      latestTarget.viewerPort !== target.viewerPort
    ) {
      return false;
    }
    const latestSessions = yield* sessions.listActive().pipe(Effect.option);
    if (
      Option.isNone(latestSessions) ||
      !latestSessions.value.some((session) => session.sessionId === target.sessionId)
    ) {
      return false;
    }
    return yield* targetIsCurrent;
  });

  const isWebSocket = request.headers.upgrade?.toLowerCase() === "websocket";
  if (isWebSocket) {
    if (!(yield* accessIsCurrent)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    if (parsed.upstreamPath !== "websockify") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const downstream = yield* request.upgrade;
    const upstream = yield* Socket.makeWebSocket(
      `ws://127.0.0.1:${target.viewerPort}/websockify`,
    ).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal));
    const [writeDownstream, writeUpstream] = yield* Effect.all([
      downstream.writer,
      upstream.writer,
    ]);
    const bridge = Effect.raceFirst(
      downstream.runRaw((chunk) => writeUpstream(chunk)),
      upstream.runRaw((chunk) => writeDownstream(chunk)),
    );
    const sessionRevoked = sessions.streamChanges.pipe(
      Stream.filter(
        (change) => change.type === "clientRemoved" && change.sessionId === target.sessionId,
      ),
      Stream.runHead,
      Effect.asVoid,
    );
    yield* Effect.raceFirst(bridge, sessionRevoked).pipe(Effect.ignore);
    return HttpServerResponse.empty();
  }

  const httpClient = yield* HttpClient.HttpClient;
  const upstreamUrl = new URL(`http://127.0.0.1:${target.viewerPort}/`);
  upstreamUrl.pathname = `/${parsed.upstreamPath}`;
  upstreamUrl.search = requestUrl.value.search;
  const responseResult = yield* executeViewerHttpRequest(
    accessIsCurrent,
    httpClient,
    HttpClientRequest.get(upstreamUrl),
    parsed.upstreamPath === "vnc.html",
  ).pipe(Effect.option);
  if (Option.isNone(responseResult)) {
    return HttpServerResponse.text("Bad Gateway", {
      status: 502,
      headers: VIEWER_RESPONSE_HEADERS,
    });
  }
  if (Option.isNone(responseResult.value)) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  const response = responseResult.value.value;
  if (parsed.upstreamPath === "vnc.html") {
    const html = yield* response.text.pipe(Effect.option);
    const injected = Option.isSome(html)
      ? injectBotComputerViewerStorageShim(html.value)
      : undefined;
    if (injected === undefined) {
      return HttpServerResponse.text("Bad Gateway", {
        status: 502,
        headers: VIEWER_RESPONSE_HEADERS,
      });
    }
    return HttpServerResponse.text(injected, {
      status: response.status,
      contentType: "text/html; charset=utf-8",
      headers: VIEWER_RESPONSE_HEADERS,
    });
  }
  const contentType = response.headers["content-type"];
  const contentLength = response.headers["content-length"];
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers: {
      ...VIEWER_RESPONSE_HEADERS,
      ...(contentType === undefined ? {} : { "Content-Type": contentType }),
      ...(contentLength === undefined ? {} : { "Content-Length": contentLength }),
    },
  });
}).pipe(
  Effect.catch(() => Effect.succeed(HttpServerResponse.text("Bad Gateway", { status: 502 }))),
);

export const botComputerViewerProxyRouteLayer = HttpRouter.add(
  "GET",
  `${BOT_COMPUTER_VIEWER_ROUTE_PREFIX}/*`,
  route,
);
