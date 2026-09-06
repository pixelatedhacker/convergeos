// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { PageContentDigest } from "@t3tools/contracts";

import { makePageContentStore, pageBlobsDir } from "./pageContentStore.ts";
import { ServerConfig } from "../config.ts";

const layer = it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-page-content-store-test-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
);

const digestOf = (html: string): string =>
  NodeCrypto.createHash("sha256").update(Buffer.from(html, "utf8")).digest("hex");

layer("pageContentStore", (it) => {
  it.effect("stages, reads, and deduplicates content by digest", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const serverConfig = yield* ServerConfig;
      const store = makePageContentStore(fileSystem, serverConfig.pagesDir);

      const html = "<html><body><h1>Release 1.4</h1></body></html>";
      const staged = yield* store.stage(html);
      assert.equal(staged.digest, PageContentDigest.make(digestOf(html)));
      assert.equal(staged.byteSize, Buffer.byteLength(html, "utf8"));

      // Staging again is a no-op that resolves to the same digest.
      const restaged = yield* store.stage(html);
      assert.equal(restaged.digest, staged.digest);

      const readBack = yield* store.read(staged.digest);
      assert.equal(readBack, html);

      const blobFiles = yield* fileSystem.readDirectory(pageBlobsDir(serverConfig.pagesDir), {
        recursive: true,
      });
      const storedBlobs = blobFiles.filter(
        (file) => NodePath.basename(file) === staged.digest && !file.endsWith(".part"),
      );
      assert.equal(storedBlobs.length, 1);
    }),
  );

  it.effect("distinguishes content by byte encoding and reports missing blobs", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const serverConfig = yield* ServerConfig;
      const store = makePageContentStore(fileSystem, serverConfig.pagesDir);

      const plain = yield* store.stage("plain");
      const multiByte = yield* store.stage("plain 🚀");
      assert.notEqual(plain.digest, multiByte.digest);
      assert.equal(
        multiByte.byteSize,
        Buffer.byteLength("plain 🚀", "utf8"),
      );

      const missing = yield* store.read(PageContentDigest.make("c".repeat(64)));
      assert.equal(missing, null);
    }),
  );
});
