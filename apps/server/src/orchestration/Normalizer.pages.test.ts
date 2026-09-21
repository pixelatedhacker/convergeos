// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { CommandId, PageId, type ClientOrchestrationCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { pageBlobsDir } from "../pages/pageContentStore.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";

const testLayer = Layer.mergeAll(
  WorkspacePaths.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-pages-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const NOW = "2026-08-01T00:00:00.000Z";

const createPageCommand = (
  overrides: Partial<Extract<ClientOrchestrationCommand, { type: "page.create" }>> = {},
): ClientOrchestrationCommand => ({
  type: "page.create",
  commandId: CommandId.make("create-page"),
  pageId: PageId.make("page-doc"),
  projectId: null,
  title: "Release readiness",
  sourceThreadId: null,
  content: { kind: "html", html: "<html><body>ok</body></html>" },
  dataAt: null,
  createdAt: NOW,
  ...overrides,
});

describe("normalizeDispatchCommand pages", () => {
  it.effect("stages inline HTML into owned storage and swaps in a digest reference", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const normalized = yield* normalizeDispatchCommand(createPageCommand());
      if (normalized.type !== "page.create") {
        throw new Error("Expected a page.create command.");
      }

      expect(normalized.content.kind).toBe("html");
      if (normalized.content.kind !== "html") return;
      expect(normalized.content.byteSize).toBe(
        Buffer.byteLength("<html><body>ok</body></html>", "utf8"),
      );
      // The staged document exists under the environment's own storage and
      // the command carries no inline document anymore.
      expect(
        NodeFS.existsSync(
          NodePath.join(pageBlobsDir(config.pagesDir), normalized.content.digest.slice(0, 2), normalized.content.digest),
        ),
      ).toBe(true);
      expect("html" in normalized.content).toBe(false);
      if ("author" in normalized) {
        expect(normalized.author).toEqual({ kind: "client" });
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects oversized and empty documents before any event exists", () =>
    Effect.gen(function* () {
      const tooLarge = yield* Effect.flip(
        normalizeDispatchCommand(
          createPageCommand({
            pageId: PageId.make("page-large"),
            content: { kind: "html", html: "x".repeat(10 * 1024 * 1024 + 1) },
          }),
        ),
      );
      expect(tooLarge.message).toContain("too large");

      const empty = yield* Effect.flip(
        normalizeDispatchCommand(
          createPageCommand({
            pageId: PageId.make("page-empty"),
            content: { kind: "html", html: "" },
          }),
        ),
      );
      expect(empty.message).toContain("cannot be empty");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("passes hosted URL publications through without staging a blob", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const normalized = yield* normalizeDispatchCommand(
        createPageCommand({
          pageId: PageId.make("page-link"),
          content: { kind: "hostedUrl", url: "https://example.com/report" },
        }),
      );
      if (normalized.type !== "page.create") {
        throw new Error("Expected a page.create command.");
      }
      expect(normalized.content).toEqual({
        kind: "hostedUrl",
        url: "https://example.com/report",
      });
      expect(NodeFS.existsSync(pageBlobsDir(config.pagesDir))).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );
});
