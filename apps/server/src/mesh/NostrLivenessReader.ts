import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { LIVENESS_KIND, LIVENESS_MAX_BYTES, LIVENESS_TAG, NostrLivenessEvent } from "./liveness.ts";

const decodeFrame = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Tuple([Schema.Literal("EVENT"), Schema.String, NostrLivenessEvent]),
      Schema.Tuple([Schema.Literal("EOSE"), Schema.String]),
    ]),
  ),
);

/** One bounded historical subscription. EOSE proves query completion, not recipient execution. */
export const readNostrLiveness = (input: {
  relayUrl: string;
  authors: ReadonlyArray<string>;
  delegationIds: ReadonlyArray<string>;
  since: number;
  timeoutMs?: number;
}) =>
  Effect.callback<{ queried: boolean; events: ReadonlyArray<typeof NostrLivenessEvent.Type> }>(
    (resume) => {
      const events: Array<typeof NostrLivenessEvent.Type> = [];
      let frames = 0;
      let bytes = 0;
      let settled = false;
      const finish = (queried: boolean) => {
        if (settled) return;
        settled = true;
        resume(Effect.succeed({ queried, events }));
      };
      let socket: WebSocket;
      try {
        socket = new globalThis.WebSocket(input.relayUrl);
      } catch {
        finish(false);
        return;
      }
      socket.addEventListener("open", () => {
        try {
          socket.send(
            JSON.stringify([
              "REQ",
              "liveness",
              {
                kinds: [LIVENESS_KIND],
                authors: input.authors,
                "#t": [LIVENESS_TAG],
                "#d": input.delegationIds,
                since: input.since,
                limit: 64,
              },
            ]),
          );
        } catch {
          finish(false);
        }
      });
      socket.addEventListener("message", (event) => {
        const raw = typeof event.data === "string" ? event.data : "";
        bytes += new TextEncoder().encode(raw).length;
        if (++frames > 128 || bytes > 256 * 1024 || raw.length > LIVENESS_MAX_BYTES + 100) {
          finish(false);
          return;
        }
        const decoded = decodeFrame(raw);
        if (Option.isNone(decoded) || decoded.value[1] !== "liveness") return;
        if (decoded.value[0] === "EOSE") {
          finish(true);
          return;
        }
        if (events.length < 64) events.push(decoded.value[2]);
        else finish(false);
      });
      socket.addEventListener("error", () => finish(false));
      socket.addEventListener("close", () => finish(false));
      return Effect.sync(() => {
        try {
          socket.close();
        } catch {
          /* Already closed. */
        }
      });
    },
  ).pipe(
    Effect.timeoutOption(input.timeoutMs ?? 2_000),
    Effect.map(Option.getOrElse(() => ({ queried: false, events: [] }))),
  );
