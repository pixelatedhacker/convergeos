import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  PageContentDigest,
  PageId,
  PageRevisionId,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Saved pages: durable homes for generated websites, reports, and small
 * tools. A page belongs to one environment, optionally to one project, and
 * its content is stored independently of the agent that produced it.
 */

/** Hard byte limit for one managed HTML document. Advertised to clients and agents via the `pages` environment capability. */
export const PAGE_MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const PAGE_MAX_TITLE_LENGTH = 200;
export const PAGE_MAX_URL_LENGTH = 2048;
export const PAGE_LIST_DEFAULT_LIMIT = 50;
export const PAGE_LIST_MAX_LIMIT = 200;
/** Upper bound on the revision history returned with one page detail. */
export const PAGE_DETAIL_MAX_REVISIONS = 20;

export const PageTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(PAGE_MAX_TITLE_LENGTH));
export type PageTitle = typeof PageTitle.Type;

export const PageKind = Schema.Literals(["htmlDocument", "hostedUrl"]);
export type PageKind = typeof PageKind.Type;

/**
 * A hosted link is a reference to an external site, saved explicitly by a
 * user or agent. ConvergeOS never fetches or guarantees the content behind
 * it, so loopback and dev-server targets are rejected at the decision
 * boundary — they are not portable saved pages.
 */
export const PageHostedUrl = TrimmedNonEmptyString.check(Schema.isPattern(/^https:\/\/\S+$/)).check(
  Schema.isMaxLength(PAGE_MAX_URL_LENGTH),
);
export type PageHostedUrl = typeof PageHostedUrl.Type;

/**
 * Where a revision's content lives. Managed HTML references immutable,
 * content-addressed bytes under the owning environment's userdata; hosted
 * URLs reference an external site without a durability guarantee.
 */
export const PageContentRef = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("html"),
    digest: PageContentDigest,
    byteSize: PositiveInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("hostedUrl"),
    url: PageHostedUrl,
  }),
]);
export type PageContentRef = typeof PageContentRef.Type;

/**
 * Content as a caller submits it. Inline HTML is staged into owned storage
 * by the server before the command is decided, so persisted events only
 * ever carry the digest reference form.
 */
export const PageContentInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("html"),
    html: Schema.String.check(Schema.isMaxLength(PAGE_MAX_DOCUMENT_BYTES)),
  }),
  Schema.Struct({
    kind: Schema.Literal("hostedUrl"),
    url: PageHostedUrl,
  }),
]);
export type PageContentInput = typeof PageContentInput.Type;

/** Who produced a revision. Client saves and agent publications both land here. */
export const PageRevisionAuthor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("client") }),
  Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
]);
export type PageRevisionAuthor = typeof PageRevisionAuthor.Type;

export const PageRevision = Schema.Struct({
  id: PageRevisionId,
  pageId: PageId,
  /** Previous current revision; null for the first publication. */
  predecessorRevisionId: Schema.NullOr(PageRevisionId),
  /** Monotonic per-page content revision number, starting at 1. */
  revision: PositiveInt,
  content: PageContentRef,
  /**
   * Optional timestamp supplied with the revision describing the data it was
   * built from. Distinct from `acceptedAt`, which is when the environment
   * accepted the revision.
   */
  dataAt: Schema.NullOr(IsoDateTime),
  author: PageRevisionAuthor,
  acceptedAt: IsoDateTime,
});
export type PageRevision = typeof PageRevision.Type;

/**
 * The page aggregate as clients see it. Metadata and content revisions are
 * separate counters so a rename cannot silently change content history.
 * Document bytes are never part of this record; they are fetched only when
 * a page opens.
 */
export const Page = Schema.Struct({
  id: PageId,
  /** Null for an Unfiled page owned by the environment alone. */
  projectId: Schema.NullOr(ProjectId),
  title: PageTitle,
  kind: PageKind,
  /** Historical provenance: the conversation that produced the page. */
  sourceThreadId: Schema.NullOr(ThreadId),
  /** Bot thread assigned to maintain this page. Null until a maintainer is assigned. */
  maintainerThreadId: Schema.NullOr(ThreadId),
  currentRevisionId: PageRevisionId,
  currentRevision: PositiveInt,
  metadataRevision: PositiveInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type Page = typeof Page.Type;

export const PageListInput = Schema.Struct({
  /**
   * Absent: every page in the environment. Null: only Unfiled pages.
   * Present: only that project's pages.
   */
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  includeArchived: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PAGE_LIST_MAX_LIMIT)).pipe(
    Schema.withDecodingDefault(Effect.succeed(PAGE_LIST_DEFAULT_LIMIT)),
  ),
});
export type PageListInput = typeof PageListInput.Type;

export const PageListSnapshot = Schema.Struct({
  pages: Schema.Array(Page),
});
export type PageListSnapshot = typeof PageListSnapshot.Type;

export const PageDetailInput = Schema.Struct({
  pageId: PageId,
});
export type PageDetailInput = typeof PageDetailInput.Type;

export const PageDetailSnapshot = Schema.Struct({
  page: Page,
  /** Newest first, bounded to the most recent PAGE_DETAIL_MAX_REVISIONS. */
  revisions: Schema.Array(PageRevision),
});
export type PageDetailSnapshot = typeof PageDetailSnapshot.Type;

export const PageContentRequest = Schema.Struct({
  pageId: PageId,
});
export type PageContentRequest = typeof PageContentRequest.Type;

/**
 * The resolved document for one page's current revision, fetched only when
 * a page opens. Managed HTML returns its bytes; hosted URLs return the
 * reference for the client to open externally.
 */
export const PageResolvedContent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("html"),
    html: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("hostedUrl"),
    url: PageHostedUrl,
  }),
]);
export type PageResolvedContent = typeof PageResolvedContent.Type;

export const PageContentSnapshot = Schema.Struct({
  pageId: PageId,
  revisionId: PageRevisionId,
  content: PageResolvedContent,
});
export type PageContentSnapshot = typeof PageContentSnapshot.Type;

export const PagesQueryErrorReason = Schema.Literals([
  "notFound",
  "contentUnavailable",
  "failed",
]);
export type PagesQueryErrorReason = typeof PagesQueryErrorReason.Type;

export class PagesQueryError extends Schema.TaggedErrorClass<PagesQueryError>()(
  "PagesQueryError",
  {
    reason: PagesQueryErrorReason,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Pages query failed (${this.reason}): ${this.detail}`;
  }
}
