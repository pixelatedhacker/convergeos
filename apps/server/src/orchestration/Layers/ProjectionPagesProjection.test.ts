import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  PageContentDigest,
  PageId,
  PageRevisionId,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ServerConfig } from "../../config.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";

const makePagesTestLayer = (prefix: string) =>
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(ThreadPlanProgress.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";
const pageId = PageId.make("page-dash");
const firstRevisionId = PageRevisionId.make("revision-1");
const secondRevisionId = PageRevisionId.make("revision-2");
const htmlContent = (digestHex: string) => ({
  kind: "html" as const,
  digest: PageContentDigest.make(digestHex),
  byteSize: 32,
});

const eventBase = (eventId: string, commandId: string, occurredAt: string) => ({
  eventId: EventId.make(eventId),
  aggregateKind: "page" as const,
  aggregateId: pageId,
  occurredAt,
  commandId: CommandId.make(commandId),
  causationEventId: null,
  correlationId: CommandId.make(commandId),
  metadata: {},
});

const revisionRecord = (
  id: PageRevisionId,
  number: number,
  predecessorRevisionId: PageRevisionId | null,
  digestHex: string,
  acceptedAt: string,
) => ({
  id,
  pageId,
  predecessorRevisionId,
  revision: number,
  content: htmlContent(digestHex),
  dataAt: null,
  author: { kind: "client" as const },
  acceptedAt,
});

const pageRecord = (overrides: Record<string, unknown> = {}) => ({
  id: pageId,
  projectId: null,
  title: "Release readiness",
  kind: "htmlDocument" as const,
  sourceThreadId: null,
  maintainerThreadId: null,
  currentRevisionId: firstRevisionId,
  currentRevision: 1,
  metadataRevision: 1,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  ...overrides,
});

it.layer(makePagesTestLayer("t3-pages-projection-test-"))("pages projections", (it) => {
  it.effect("replays publications into rows and serves restart-safe reads", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      yield* eventStore.append({
        ...eventBase("evt-page-1", "cmd-page-1", NOW),
        type: "page.created",
        payload: {
          page: pageRecord(),
          revision: revisionRecord(firstRevisionId, 1, null, "a".repeat(64), NOW),
        },
      });
      yield* eventStore.append({
        ...eventBase("evt-page-2", "cmd-page-2", LATER),
        type: "page.published",
        payload: {
          page: pageRecord({
            currentRevisionId: secondRevisionId,
            currentRevision: 2,
            updatedAt: LATER,
          }),
          revision: revisionRecord(secondRevisionId, 2, firstRevisionId, "b".repeat(64), LATER),
        },
      });
      yield* eventStore.append({
        ...eventBase("evt-page-3", "cmd-page-3", LATER),
        type: "page.renamed",
        payload: {
          page: pageRecord({
            currentRevisionId: secondRevisionId,
            currentRevision: 2,
            title: "Release readiness (Q4)",
            metadataRevision: 2,
            updatedAt: LATER,
          }),
        },
      });

      // Bootstrap replays the full event range into the projection tables,
      // the same path a server restart takes.
      yield* projectionPipeline.bootstrap;

      const listResult = yield* snapshotQuery.listPages({
        includeArchived: false,
        limit: 50,
      });
      assert.equal(listResult.length, 1);
      const listedPage = listResult[0];
      assert.equal(listedPage?.id, pageId);
      assert.equal(listedPage?.title, "Release readiness (Q4)");
      assert.equal(listedPage?.currentRevision, 2);
      assert.equal(listedPage?.metadataRevision, 2);

      const detail = yield* snapshotQuery.getPageDetail(pageId);
      if (Option.isNone(detail)) {
        throw new Error("page detail should resolve");
      }
      assert.equal(detail.value.page.id, pageId);
      assert.deepEqual(
        detail.value.revisions.map((revision) => revision.revision),
        [2, 1],
      );
      assert.deepEqual(detail.value.revisions[1]?.content, htmlContent("a".repeat(64)));

      const contentRef = yield* snapshotQuery.getPageContentRef(pageId);
      if (Option.isNone(contentRef)) {
        throw new Error("page content ref should resolve");
      }
      assert.equal(contentRef.value.revisionId, secondRevisionId);
      assert.deepEqual(contentRef.value.content, htmlContent("b".repeat(64)));

      const missingRef = yield* snapshotQuery.getPageContentRef(PageId.make("page-missing"));
      assert.isTrue(Option.isNone(missingRef));

      // The engine's command read model hydrates pages from the same
      // projection tables after a restart.
      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      assert.equal(commandReadModel.pages?.length, 1);
      assert.deepEqual(
        commandReadModel.pageRevisions?.map((revision) => revision.id),
        [firstRevisionId, secondRevisionId],
      );
    }),
  );

  it.effect("archived pages leave the default list but stay queryable", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      yield* eventStore.append({
        ...eventBase("evt-arch-1", "cmd-arch-1", NOW),
        type: "page.created",
        payload: {
          page: pageRecord(),
          revision: revisionRecord(firstRevisionId, 1, null, "c".repeat(64), NOW),
        },
      });
      yield* eventStore.append({
        ...eventBase("evt-arch-2", "cmd-arch-2", LATER),
        type: "page.archived",
        payload: {
          page: pageRecord({ archivedAt: LATER, metadataRevision: 2, updatedAt: LATER }),
        },
      });

      yield* projectionPipeline.bootstrap;

      const active = yield* snapshotQuery.listPages({
        includeArchived: false,
        limit: 50,
      });
      assert.equal(active.length, 0);

      const includingArchived = yield* snapshotQuery.listPages({
        includeArchived: true,
        limit: 50,
      });
      assert.equal(includingArchived.length, 1);
      assert.equal(includingArchived[0]?.archivedAt, LATER);

      const unfiledFilter = yield* snapshotQuery.listPages({
        projectId: null,
        includeArchived: true,
        limit: 50,
      });
      assert.equal(unfiledFilter.length, 1);

      const projectFilter = yield* snapshotQuery.listPages({
        projectId: ProjectId.make("project-somewhere"),
        includeArchived: true,
        limit: 50,
      });
      assert.equal(projectFilter.length, 0);
    }),
  );
});
