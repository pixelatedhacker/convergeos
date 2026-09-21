/**
 * Content-addressed storage for managed page documents.
 *
 * Publication first stages bytes here, then an accepted event references the
 * digest. Files are immutable once renamed into place, so a page never
 * depends on a worktree file or a temporary server surviving. Staging is
 * idempotent: the same bytes always land on the same digest key, and a
 * dispatch that fails after staging only leaves a collectible orphan.
 *
 * @module pageContentStore
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import { PageContentDigest } from "@t3tools/contracts";

export class PageContentStoreError extends Schema.TaggedError<PageContentStoreError>()(
  "PageContentStoreError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Page content store failed (${this.operation}): ${this.detail}`;
  }
}

export interface PageContentStoreShape {
  /** Digest and byte size of the UTF-8 encoding of `html`. */
  readonly inspect: (html: string) => {
    readonly digest: PageContentDigest;
    readonly byteSize: number;
  };
  /** Stage bytes into owned storage; resolves to the same digest for identical input. */
  readonly stage: (
    html: string,
  ) => Effect.Effect<
    { readonly digest: PageContentDigest; readonly byteSize: number },
    PageContentStoreError
  >;
  /** Read the stored bytes for a digest, or null when the blob is absent. */
  readonly read: (
    digest: PageContentDigest,
  ) => Effect.Effect<string | null, PageContentStoreError>;
}

export const pageBlobsDir = (pagesDir: string): string => NodePath.join(pagesDir, "blobs");

export const makePageContentStore = (
  fileSystem: FileSystem.FileSystem,
  pagesDir: string,
): PageContentStoreShape => {
  const blobsDir = pageBlobsDir(pagesDir);
  const blobPath = (digest: PageContentDigest) =>
    NodePath.join(blobsDir, digest.slice(0, 2), digest);
  const decoder = new TextDecoder();

  const inspect = (html: string) => {
    const bytes = Buffer.from(html, "utf8");
    return {
      digest: PageContentDigest.make(NodeCrypto.createHash("sha256").update(bytes).digest("hex")),
      byteSize: bytes.byteLength,
    };
  };

  return {
    inspect,
    stage: (html) =>
      Effect.gen(function* () {
        const { digest, byteSize } = inspect(html);
        const finalPath = blobPath(digest);
        const staged = yield* fileSystem.exists(finalPath).pipe(
          Effect.mapError(
            (cause) =>
              new PageContentStoreError({
                operation: "stage:exists",
                detail: "could not inspect stored page content",
                cause,
              }),
          ),
        );
        if (!staged) {
          const partPath = `${finalPath}.${NodeCrypto.randomUUID()}.part`;
          yield* fileSystem.makeDirectory(NodePath.dirname(finalPath), { recursive: true }).pipe(
            Effect.mapError(
              (cause) =>
                new PageContentStoreError({
                  operation: "stage:mkdir",
                  detail: "could not prepare page content storage",
                  cause,
                }),
            ),
          );
          yield* fileSystem.writeFile(partPath, Buffer.from(html, "utf8")).pipe(
            Effect.mapError(
              (cause) =>
                new PageContentStoreError({
                  operation: "stage:write",
                  detail: "could not write page content",
                  cause,
                }),
            ),
          );
          yield* fileSystem.rename(partPath, finalPath).pipe(
            Effect.mapError(
              (cause) =>
                new PageContentStoreError({
                  operation: "stage:rename",
                  detail: "could not finalize page content",
                  cause,
                }),
            ),
          );
        }
        return { digest, byteSize };
      }),
    read: (digest) =>
      Effect.gen(function* () {
        const finalPath = blobPath(digest);
        const staged = yield* fileSystem.exists(finalPath).pipe(
          Effect.mapError(
            (cause) =>
              new PageContentStoreError({
                operation: "read:exists",
                detail: "could not inspect stored page content",
                cause,
              }),
          ),
        );
        if (!staged) {
          return null;
        }
        return yield* fileSystem.readFile(finalPath).pipe(
          Effect.map((bytes) => decoder.decode(bytes)),
          Effect.mapError(
            (cause) =>
              new PageContentStoreError({
                operation: "read",
                detail: "could not read page content",
                cause,
              }),
          ),
        );
      }),
  };
};
