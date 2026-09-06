import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { publishSignedEvent } from "./NostrRelay.ts";
import { MESH_NOSTR_EVENT_KIND, signNostrEvent } from "./nostr.ts";

const event = signNostrEvent(
  {
    pubkey: "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f",
    created_at: 1_757_040_000,
    kind: MESH_NOSTR_EVENT_KIND,
    tags: [],
    content: "receipt",
  },
  Uint8Array.from({ length: 32 }, () => 1),
);
const eventJson = JSON.stringify(event, null, 2);

const makeRelay = Effect.fn("test.makeRelay")(function* (
  respond: (socket: NodeSocket.NodeWS.WebSocket) => void,
) {
  const received = Promise.withResolvers<string>();
  const messages: string[] = [];
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSocket.NodeWS.WebSocketServer({ port: 0, host: "127.0.0.1" })),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            for (const client of server.clients) client.terminate();
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
  );
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = data.toString();
      messages.push(message);
      received.resolve(message);
      respond(socket);
    });
  });
  yield* Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected a TCP relay address");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    received: Effect.promise(() => received.promise),
    messages,
  };
});

it.effect("accepts matching acknowledgements and resends the exact stored signed bytes", () =>
  Effect.gen(function* () {
    const relay = yield* makeRelay((socket) => {
      socket.send(JSON.stringify(["OK", event.id, true, ""]));
    });
    assert.deepEqual(yield* publishSignedEvent(relay.url, eventJson), { _tag: "Accepted" });
    assert.deepEqual(yield* publishSignedEvent(relay.url, eventJson), { _tag: "Accepted" });
    assert.deepEqual(relay.messages, [`["EVENT",${eventJson}]`, `["EVENT",${eventJson}]`]);
  }).pipe(Effect.scoped),
);

it.effect("retains an explicit relay rejection reason", () =>
  Effect.gen(function* () {
    const relay = yield* makeRelay((socket) => {
      socket.send(JSON.stringify(["OK", event.id, false, "blocked: disabled key"]));
    });
    assert.deepEqual(yield* publishSignedEvent(relay.url, eventJson), {
      _tag: "Rejected",
      reason: "blocked: disabled key",
    });
  }).pipe(Effect.scoped),
);

it.effect(
  "ignores malformed frames and unrelated acknowledgements before a valid acknowledgement",
  () =>
    Effect.gen(function* () {
      const relay = yield* makeRelay((socket) => {
        for (const frame of [
          ["OK", event.id],
          ["OK", event.id, false],
          ["OK", event.id, "false", "bad boolean"],
          ["OK", event.id, false, null],
          ["OK", "0".repeat(64), false, "unrelated rejection"],
          ["NOTICE", "relay status"],
          ["OK", event.id, true, ""],
        ])
          socket.send(JSON.stringify(frame));
      });
      assert.deepEqual(yield* publishSignedEvent(relay.url, eventJson), { _tag: "Accepted" });
    }).pipe(Effect.scoped),
);

it.effect("treats connection closure before acknowledgement as retryable", () =>
  Effect.gen(function* () {
    const relay = yield* makeRelay((socket) => socket.close());
    assert.deepEqual(yield* publishSignedEvent(relay.url, eventJson), {
      _tag: "Transient",
      reason: "relay closed before acknowledgement",
    });
  }).pipe(Effect.scoped),
);

it.effect("times out after receiving only malformed and mismatched acknowledgements", () =>
  Effect.gen(function* () {
    const relay = yield* makeRelay((socket) => {
      socket.send(JSON.stringify(["OK", event.id, false]));
      socket.send(JSON.stringify(["OK", "0".repeat(64), true, ""]));
    });
    const publication = yield* Effect.forkChild(publishSignedEvent(relay.url, eventJson, 1_000));
    yield* relay.received;
    yield* TestClock.adjust(1_000);
    assert.deepEqual(yield* Fiber.join(publication), {
      _tag: "Transient",
      reason: "relay timed out after 1000ms",
    });
  }).pipe(Effect.scoped),
);
