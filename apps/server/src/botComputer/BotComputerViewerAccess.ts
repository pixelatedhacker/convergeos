import { randomBytes } from "node:crypto";

import {
  type AuthSessionId,
  type BotComputerViewerAccess,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const BOT_COMPUTER_VIEWER_ROUTE_PREFIX = "/api/bot-computer/view";
const VIEWER_ACCESS_TTL_MS = 5 * 60 * 1_000;
const MAX_VIEWER_ACCESS_TOKENS = 256;

export interface BotComputerViewerTarget {
  readonly sessionId: AuthSessionId;
  readonly threadId: ThreadId;
  readonly containerId: string;
  readonly viewerPort: number;
  readonly expiresAtMs: number;
}

export class BotComputerViewerAccessService extends Context.Service<
  BotComputerViewerAccessService,
  {
    readonly issue: (
      input: Omit<BotComputerViewerTarget, "expiresAtMs">,
    ) => Effect.Effect<BotComputerViewerAccess>;
    readonly resolve: (token: string) => Effect.Effect<BotComputerViewerTarget | undefined>;
    readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/botComputer/BotComputerViewerAccess/BotComputerViewerAccessService") {}

export const make = (options?: { readonly nowMs?: () => number }) => {
  const targets = new Map<string, BotComputerViewerTarget>();
  const nowMs = options?.nowMs ?? Date.now;

  const issue: BotComputerViewerAccessService["Service"]["issue"] = Effect.fn(
    "BotComputerViewerAccess.issue",
  )(function* (input) {
    const now = nowMs();
    for (const [token, target] of targets) {
      if (target.expiresAtMs <= now) targets.delete(token);
    }
    while (targets.size >= MAX_VIEWER_ACCESS_TOKENS) {
      const oldest = targets.keys().next().value;
      if (oldest === undefined) break;
      targets.delete(oldest);
    }
    const expiresAt = DateTime.makeUnsafe(now + VIEWER_ACCESS_TTL_MS);
    const token = randomBytes(32).toString("base64url");
    targets.set(token, { ...input, expiresAtMs: expiresAt.epochMilliseconds });
    const websocketPath = `${BOT_COMPUTER_VIEWER_ROUTE_PREFIX}/${token}/websockify`;
    const query = new URLSearchParams({
      autoconnect: "1",
      resize: "remote",
      path: websocketPath.replace(/^\//, ""),
    });
    return {
      viewerPath: `${BOT_COMPUTER_VIEWER_ROUTE_PREFIX}/${token}/vnc.html?${query.toString()}`,
      expiresAt,
    };
  });

  const resolve: BotComputerViewerAccessService["Service"]["resolve"] = Effect.fn(
    "BotComputerViewerAccess.resolve",
  )(function* (token) {
    const target = targets.get(token);
    if (target === undefined) return undefined;
    if (target.expiresAtMs <= nowMs()) {
      targets.delete(token);
      return undefined;
    }
    return target;
  });

  const revokeThread: BotComputerViewerAccessService["Service"]["revokeThread"] = (threadId) =>
    Effect.sync(() => {
      for (const [token, target] of targets) {
        if (target.threadId === threadId) targets.delete(token);
      }
    });

  return BotComputerViewerAccessService.of({ issue, resolve, revokeThread });
};

export const layer = Layer.sync(BotComputerViewerAccessService, make);
