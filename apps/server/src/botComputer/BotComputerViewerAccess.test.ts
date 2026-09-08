import { AuthSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { make } from "./BotComputerViewerAccess.ts";

const target = {
  sessionId: AuthSessionId.make("session-1"),
  threadId: ThreadId.make("thread-1"),
  containerId: "container-1",
  viewerPort: 49152,
} as const;

describe("BotComputerViewerAccess", () => {
  it("issues path-scoped access and revokes every link for a thread", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const access = make();
        const first = yield* access.issue(target);
        const second = yield* access.issue(target);
        expect(first.viewerPath).not.toBe(second.viewerPath);
        expect(new URL(first.viewerPath, "http://viewer.invalid").searchParams.get("resize")).toBe(
          "scale",
        );
        const firstToken = first.viewerPath.split("/")[4];
        expect(firstToken).toBeDefined();
        expect((yield* access.resolve(firstToken ?? ""))?.viewerPort).toBe(49152);
        yield* access.revokeThread(target.threadId);
        expect(yield* access.resolve(firstToken ?? "")).toBeUndefined();
      }),
    );
  });

  it("expires viewer links", async () => {
    let nowMs = 1_000;
    await Effect.runPromise(
      Effect.gen(function* () {
        const access = make({ nowMs: () => nowMs });
        const issued = yield* access.issue(target);
        const token = issued.viewerPath.split("/")[4] ?? "";
        nowMs += 5 * 60 * 1_000;
        expect(yield* access.resolve(token)).toBeUndefined();
      }),
    );
  });
});
