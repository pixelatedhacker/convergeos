import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  MESH_RECEIPT_PUBLISH_TIMEOUT_MS,
  encodeEventPublishMessage,
  parseNostrRelayMessage,
} from "./nostr.ts";

/**
 * Outbound publish against one private Nostr relay.
 *
 * Relay acceptance (NIP-01 `OK` with `true`) is only a transport milestone —
 * distinct from recipient delivery, action acceptance, and action completion.
 * Connect failures, malformed frames, and timeouts are `Transient` so the
 * outbox retries with backoff; an explicit relay rejection is final and stays
 * retained with its reason.
 */
export type NostrPublishOutcome =
  | { readonly _tag: "Accepted" }
  | { readonly _tag: "Rejected"; readonly reason: string }
  | { readonly _tag: "Transient"; readonly reason: string };

interface MinimalWebSocket {
  send: (data: string) => unknown;
  close: () => unknown;
  addEventListener: (
    type: "open" | "message" | "error" | "close",
    listener: (event: { data?: unknown }) => void,
  ) => void;
}

const connectWebSocket = (url: string): MinimalWebSocket | null => {
  const Ctor = (globalThis as Record<string, unknown>).WebSocket;
  if (typeof Ctor !== "function") return null;
  try {
    return new (Ctor as new (url: string) => MinimalWebSocket)(url);
  } catch {
    return null;
  }
};

const publishOnce = (relayUrl: string, eventJson: string, eventId: string) =>
  Effect.callback<NostrPublishOutcome>((resume) => {
    let settled = false;
    const settle = (outcome: NostrPublishOutcome) => {
      if (settled) return;
      settled = true;
      resume(Effect.succeed(outcome));
    };
    const socket = connectWebSocket(relayUrl);
    if (socket === null) {
      settle({ _tag: "Transient", reason: "no WebSocket client available in this runtime" });
      return;
    }
    socket.addEventListener("open", () => {
      try {
        socket.send(encodeEventPublishMessage(JSON.parse(eventJson)));
      } catch (cause) {
        settle({ _tag: "Transient", reason: `send failed: ${String(cause)}` });
        socket.close();
      }
    });
    socket.addEventListener("message", (event) => {
      const frame = parseNostrRelayMessage(typeof event.data === "string" ? event.data : "");
      if (frame._tag === "Ok" && frame.eventId === eventId) {
        settle(
          frame.accepted
            ? { _tag: "Accepted" }
            : { _tag: "Rejected", reason: frame.message || "relay rejected the event" },
        );
        socket.close();
      }
    });
    socket.addEventListener("error", () => {
      settle({ _tag: "Transient", reason: "relay connection error" });
      socket.close();
    });
    socket.addEventListener("close", () => {
      settle({ _tag: "Transient", reason: "relay closed before acknowledgement" });
    });
    return Effect.sync(() => {
      try {
        socket.close();
      } catch {
        // Already closed; nothing to release.
      }
    });
  });

/**
 * Publishes the exact stored event JSON and resolves with the relay's
 * acknowledgement. The original signed bytes are resent on every retry —
 * same id, timestamp, and signature.
 */
export const publishSignedEvent = (
  relayUrl: string,
  eventJson: string,
  timeoutMs: number = MESH_RECEIPT_PUBLISH_TIMEOUT_MS,
): Effect.Effect<NostrPublishOutcome> => {
  let eventId: string;
  try {
    const parsed = JSON.parse(eventJson) as { id?: unknown };
    if (typeof parsed.id !== "string") throw new Error("missing event id");
    eventId = parsed.id;
  } catch (cause) {
    return Effect.succeed({ _tag: "Transient", reason: `stored event is not valid JSON: ${String(cause)}` });
  }
  return publishOnce(relayUrl, eventJson, eventId).pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.map(
      Option.match({
        onNone: () => ({ _tag: "Transient" as const, reason: `relay timed out after ${timeoutMs}ms` }),
        onSome: (outcome) => outcome,
      }),
    ),
  );
};


/**
 * The relay boundary as a service so the export worker stays deterministic
 * under test: tests substitute an in-memory relay speaking the same protocol
 * (EVENT frame in, NIP-01 OK frame out).
 */
export class NostrRelay extends Context.Service<
  NostrRelay,
  {
    readonly publish: (
      relayUrl: string,
      eventJson: string,
    ) => Effect.Effect<NostrPublishOutcome>;
  }
>()("t3/mesh/NostrRelay") {}

export const make = Effect.succeed(
  NostrRelay.of({
    publish: (relayUrl, eventJson) => publishSignedEvent(relayUrl, eventJson),
  }),
);

export const layer = Layer.succeed(NostrRelay, NostrRelay.of({
  publish: (relayUrl, eventJson) => publishSignedEvent(relayUrl, eventJson),
}));
