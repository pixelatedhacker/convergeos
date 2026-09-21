import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  PageContentDigest,
  PageCreatedPayload,
  PagePublishedPayload,
  PageId,
  PageRevisionId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type Page,
  type PageRevision,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const decodePageCreatedPayload = Schema.decodeUnknownEffect(PageCreatedPayload);
const decodePagePublishedPayload = Schema.decodeUnknownEffect(PagePublishedPayload);

const NOW = "2026-09-03T20:00:00.000Z";
const projectId = ProjectId.make("project-pages");
const sourceThreadId = ThreadId.make("thread-generator");
const digestOne = PageContentDigest.make("a".repeat(64));
const digestTwo = PageContentDigest.make("b".repeat(64));
const firstRevisionId = PageRevisionId.make("revision-1");

const project = {
  id: projectId,
  title: "Pages",
  workspaceRoot: "/workspace/pages",
  repositoryIdentity: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};

const htmlContent = (digest: PageContentDigest, byteSize = 11) =>
  ({ kind: "html", digest, byteSize }) as const;

const page = (overrides: Partial<Page> = {}): Page => ({
  id: PageId.make("page-release"),
  projectId: null,
  title: "Release readiness",
  kind: "htmlDocument",
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

const revision = (overrides: Partial<PageRevision> = {}): PageRevision => ({
  id: firstRevisionId,
  pageId: PageId.make("page-release"),
  predecessorRevisionId: null,
  revision: 1,
  content: htmlContent(digestOne),
  dataAt: null,
  author: { kind: "client" },
  acceptedAt: NOW,
  ...overrides,
});

const readModel = (
  pages: ReadonlyArray<Page> = [],
  pageRevisions: ReadonlyArray<PageRevision> = [],
): OrchestrationReadModel => ({
  snapshotSequence: 0,
  projects: [project],
  threads: [],
  pages,
  pageRevisions,
  updatedAt: NOW,
});

const createCommand = (
  overrides: Partial<Extract<OrchestrationCommand, { type: "page.create" }>> = {},
): Extract<OrchestrationCommand, { type: "page.create" }> => ({
  type: "page.create",
  commandId: CommandId.make("create-page"),
  pageId: PageId.make("page-release"),
  projectId: null,
  title: "Release readiness",
  sourceThreadId: null,
  content: htmlContent(digestOne),
  dataAt: null,
  author: { kind: "client" },
  createdAt: NOW,
  ...overrides,
});

const publishCommand = (
  overrides: Partial<Extract<OrchestrationCommand, { type: "page.publish" }>> = {},
): Extract<OrchestrationCommand, { type: "page.publish" }> => ({
  type: "page.publish",
  commandId: CommandId.make("publish-page"),
  pageId: PageId.make("page-release"),
  baseRevisionId: firstRevisionId,
  content: htmlContent(digestTwo),
  dataAt: null,
  author: { kind: "client" },
  createdAt: NOW,
  ...overrides,
});

/** Fold one planned event into the read model exactly like the engine would. */
const applyEvent = (
  model: OrchestrationReadModel,
  event: Omit<OrchestrationEvent, "sequence">,
): Effect.Effect<OrchestrationReadModel> =>
  projectEvent(model, {
    ...event,
    sequence: model.snapshotSequence + 1,
  } as OrchestrationEvent).pipe(Effect.orDie);

it.layer(NodeServices.layer)("pages decider", (it) => {
  it.effect("creates an unfiled HTML page with provenance and a first revision", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: createCommand({ sourceThreadId }),
        readModel: readModel(),
      });

      expect("type" in event && event.type).toBe("page.created");
      if (!("type" in event) || event.type !== "page.created") return;
      const payload = yield* decodePageCreatedPayload(event.payload);
      expect(event.aggregateKind).toBe("page");
      expect(payload.page).toMatchObject({
        id: PageId.make("page-release"),
        projectId: null,
        kind: "htmlDocument",
        sourceThreadId,
        currentRevision: 1,
        metadataRevision: 1,
        archivedAt: null,
        maintainerThreadId: null,
      });
      expect(payload.revision).toMatchObject({
        predecessorRevisionId: null,
        revision: 1,
        content: { kind: "html", digest: digestOne },
        author: { kind: "client" },
      });
    }),
  );

  it.effect("rejects duplicate ids and unknown projects", () =>
    Effect.gen(function* () {
      const duplicate = yield* decideOrchestrationCommand({
        command: createCommand(),
        readModel: readModel([page()]),
      }).pipe(Effect.flip);
      expect(duplicate.message).toContain("already exists");

      const unknownProject = yield* decideOrchestrationCommand({
        command: createCommand({ projectId: ProjectId.make("project-missing") }),
        readModel: readModel(),
      }).pipe(Effect.flip);
      expect(unknownProject.message).toContain("does not exist");
    }),
  );

  it.effect("rejects hosted URLs that are not public https links", () =>
    Effect.gen(function* () {
      const loopback = yield* decideOrchestrationCommand({
        command: createCommand({
          content: { kind: "hostedUrl", url: "http://localhost:3773/thread/1" },
        }),
        readModel: readModel(),
      }).pipe(Effect.flip);
      expect(loopback.message).toContain("unportable hosted URL");

      const loopbackIp = yield* decideOrchestrationCommand({
        command: createCommand({
          pageId: PageId.make("page-two"),
          content: { kind: "hostedUrl", url: "https://127.0.0.1:3773/thread/1" },
        }),
        readModel: readModel(),
      }).pipe(Effect.flip);
      expect(loopbackIp.message).toContain("unportable hosted URL");
    }),
  );

  it.effect("publishes against the observed revision and rejects stale bases", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: publishCommand(),
        readModel: readModel([page()], [revision()]),
      });
      expect("type" in event && event.type).toBe("page.published");
      if (!("type" in event) || event.type !== "page.published") return;
      const payload = yield* decodePagePublishedPayload(event.payload);
      expect(payload.revision).toMatchObject({
        predecessorRevisionId: firstRevisionId,
        revision: 2,
        content: { kind: "html", digest: digestTwo },
      });
      expect(payload.page.currentRevision).toBe(2);

      const conflict = yield* decideOrchestrationCommand({
        command: publishCommand({ baseRevisionId: PageRevisionId.make("revision-stale") }),
        readModel: readModel([page()], [revision()]),
      }).pipe(Effect.flip);
      expect(conflict.message).toContain("revision changed");
    }),
  );

  it.effect("renames metadata without touching content history", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "page.rename",
          commandId: CommandId.make("rename-page"),
          pageId: page().id,
          expectedMetadataRevision: 1,
          title: "Release readiness (Q4)",
          createdAt: NOW,
        },
        readModel: readModel([page()], [revision()]),
      });
      expect("type" in event && event.type).toBe("page.renamed");
      if (!("type" in event) || event.type !== "page.renamed") return;
      const nextModel = yield* projectEvent(readModel([page()], [revision()]), {
        ...event,
        sequence: 1,
      } as OrchestrationEvent).pipe(Effect.orDie);
      const renamedPage = nextModel.pages?.[0];
      expect(renamedPage).toMatchObject({
        title: "Release readiness (Q4)",
        metadataRevision: 2,
        currentRevision: 1,
        currentRevisionId: firstRevisionId,
      });

      const stale = yield* decideOrchestrationCommand({
        command: {
          type: "page.rename",
          commandId: CommandId.make("rename-page-stale"),
          pageId: page().id,
          expectedMetadataRevision: 3,
          title: "Stale rename",
          createdAt: NOW,
        },
        readModel: readModel([page()], [revision()]),
      }).pipe(Effect.flip);
      expect(stale.message).toContain("metadata revision changed");
    }),
  );

  it.effect("archives and restores pages, blocking publication while archived", () =>
    Effect.gen(function* () {
      const archive = yield* decideOrchestrationCommand({
        command: {
          type: "page.archive",
          commandId: CommandId.make("archive-page"),
          pageId: page().id,
          expectedMetadataRevision: 1,
          createdAt: NOW,
        },
        readModel: readModel([page()], [revision()]),
      });
      expect("type" in archive && archive.type).toBe("page.archived");
      if (!("type" in archive) || archive.type !== "page.archived") return;
      const archivedModel = yield* projectEvent(readModel([page()], [revision()]), {
        ...archive,
        sequence: 1,
      } as OrchestrationEvent).pipe(Effect.orDie);

      const publishWhileArchived = yield* decideOrchestrationCommand({
        command: publishCommand(),
        readModel: archivedModel,
      }).pipe(Effect.flip);
      expect(publishWhileArchived.message).toContain("archived");

      const restore = yield* decideOrchestrationCommand({
        command: {
          type: "page.restore",
          commandId: CommandId.make("restore-page"),
          pageId: page().id,
          expectedMetadataRevision: 2,
          createdAt: NOW,
        },
        readModel: archivedModel,
      });
      expect("type" in restore && restore.type).toBe("page.restored");

      const archiveTwice = yield* decideOrchestrationCommand({
        command: {
          type: "page.archive",
          commandId: CommandId.make("archive-page-again"),
          pageId: page().id,
          expectedMetadataRevision: 1,
          createdAt: NOW,
        },
        readModel: archivedModel,
      }).pipe(Effect.flip);
      expect(archiveTwice.message).toContain("archived");
    }),
  );

  it.effect("moves pages between projects and clears the maintainer", () =>
    Effect.gen(function* () {
      const otherProjectId = ProjectId.make("project-other");
      const otherProject = {
        ...project,
        id: otherProjectId,
        workspaceRoot: "/workspace/other",
      };
      const withMaintainer = page({
        projectId,
        maintainerThreadId: ThreadId.make("thread-page-bot"),
      });
      const model = {
        ...readModel([withMaintainer], [revision()]),
        projects: [project, otherProject],
      };
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "page.assign-project",
          commandId: CommandId.make("assign-project"),
          pageId: withMaintainer.id,
          expectedMetadataRevision: 1,
          projectId: otherProjectId,
          createdAt: NOW,
        },
        readModel: model,
      });
      expect("type" in event && event.type).toBe("page.project-assigned");
      if (!("type" in event) || event.type !== "page.project-assigned") return;
      const payload = event.payload as { page: Page };
      expect(payload.page.maintainerThreadId).toBeNull();
      expect(payload.page.projectId).toBe(otherProjectId);

      const unfile = yield* decideOrchestrationCommand({
        command: {
          type: "page.assign-project",
          commandId: CommandId.make("unfile-page"),
          pageId: withMaintainer.id,
          expectedMetadataRevision: 1,
          projectId: null,
          createdAt: NOW,
        },
        readModel: model,
      });
      expect("type" in unfile && unfile.type).toBe("page.project-assigned");

      const missing = yield* decideOrchestrationCommand({
        command: {
          type: "page.assign-project",
          commandId: CommandId.make("assign-missing"),
          pageId: withMaintainer.id,
          expectedMetadataRevision: 1,
          projectId: ProjectId.make("project-missing"),
          createdAt: NOW,
        },
        readModel: model,
      }).pipe(Effect.flip);
      expect(missing.message).toContain("does not exist");
    }),
  );

  it.effect("restore-revision re-publishes retained content without rewriting history", () =>
    Effect.gen(function* () {
      const secondRevisionId = PageRevisionId.make("revision-2");
      const current = page({
        currentRevisionId: secondRevisionId,
        currentRevision: 2,
        metadataRevision: 1,
      });
      const history = [
        revision(),
        revision({
          id: secondRevisionId,
          predecessorRevisionId: firstRevisionId,
          revision: 2,
          content: htmlContent(digestTwo),
        }),
      ];

      const event = yield* decideOrchestrationCommand({
        command: {
          type: "page.restore-revision",
          commandId: CommandId.make("restore-revision"),
          pageId: current.id,
          baseRevisionId: secondRevisionId,
          sourceRevisionId: firstRevisionId,
          author: { kind: "client" },
          createdAt: NOW,
        },
        readModel: readModel([current], history),
      });
      expect("type" in event && event.type).toBe("page.published");
      if (!("type" in event) || event.type !== "page.published") return;
      const payload = yield* decodePagePublishedPayload(event.payload);
      expect(payload.revision).toMatchObject({
        predecessorRevisionId: secondRevisionId,
        revision: 3,
        content: { kind: "html", digest: digestOne },
      });

      const unknownSource = yield* decideOrchestrationCommand({
        command: {
          type: "page.restore-revision",
          commandId: CommandId.make("restore-unknown"),
          pageId: current.id,
          baseRevisionId: secondRevisionId,
          sourceRevisionId: PageRevisionId.make("revision-missing"),
          author: { kind: "client" },
          createdAt: NOW,
        },
        readModel: readModel([current], history),
      }).pipe(Effect.flip);
      expect(unknownSource.message).toContain("no revision");
    }),
  );

  it.effect("project deletion archives project pages but leaves Unfiled pages", () =>
    Effect.gen(function* () {
      const filedPage = page({ projectId });
      const unfiledPage = page({ id: PageId.make("page-unfiled") });
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "project.delete",
          commandId: CommandId.make("delete-project"),
          projectId,
        },
        readModel: readModel([filedPage, unfiledPage], []),
      });

      const events = Array.isArray(decided) ? decided : [decided];
      const types = events.map((event) => event.type);
      expect(types).toEqual(["page.archived", "project.deleted"]);
      const archivedEvent = events[0];
      if (archivedEvent === undefined || archivedEvent.type !== "page.archived") return;
      const payload = archivedEvent.payload as { page: Page };
      expect(payload.page.id).toBe(filedPage.id);
      expect(payload.page.archivedAt).not.toBeNull();
    }),
  );

  it.effect("project deletion with threads and pages fans out in order under force", () =>
    Effect.gen(function* () {
      const filedPage = page({ projectId });
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "project.delete",
          commandId: CommandId.make("delete-project-forced"),
          projectId,
          force: true,
        },
        readModel: {
          ...readModel([filedPage], []),
          threads: [
            {
              id: ThreadId.make("thread-1"),
              projectId,
              title: "Thread",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "m" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              botProfile: null,
              latestTurn: null,
              createdAt: NOW,
              updatedAt: NOW,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              unsettledAt: null,
              snoozedUntil: null,
              snoozedAt: null,
              pinnedAt: null,
              pinOrderKey: null,
              titleRegeneration: null,
              deletedAt: null,
              messages: [],
              proposedPlans: [],
              activities: [],
              checkpoints: [],
              session: null,
            },
          ],
        },
      });

      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual([
        "thread.deleted",
        "page.archived",
        "project.deleted",
      ]);
    }),
  );

  it.effect("sequential publications keep the full revision history", () =>
    Effect.gen(function* () {
      const created = yield* decideOrchestrationCommand({
        command: createCommand(),
        readModel: readModel(),
      });
      if (!("type" in created) || created.type !== "page.created") return;
      const createdPayload = yield* decodePageCreatedPayload(created.payload);
      let model = yield* applyEvent(readModel(), created);

      const published = yield* decideOrchestrationCommand({
        command: publishCommand({ baseRevisionId: createdPayload.revision.id }),
        readModel: model,
      });
      if (!("type" in published) || published.type !== "page.published") return;
      model = yield* applyEvent(model, published);

      expect(model.pageRevisions?.length).toBe(2);
      expect(model.pageRevisions?.map((entry) => entry.revision)).toEqual([1, 2]);
      expect(model.pages?.[0]?.currentRevision).toBe(2);
      expect(model.pages?.[0]?.currentRevisionId).toBe(
        model.pageRevisions?.at(-1)?.id ?? null,
      );
    }),
  );
});
