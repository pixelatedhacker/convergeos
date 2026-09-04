import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadBotConfiguredPayload,
  ThreadBotDisabledPayload,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-09-03T20:00:00.000Z";
const projectId = ProjectId.make("project-bots");
const threadId = ThreadId.make("thread-bot");

const thread = (overrides: Partial<OrchestrationThread> = {}): OrchestrationThread => ({
  id: threadId,
  projectId,
  title: "Release work",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "codex/release",
  worktreePath: "/worktrees/release",
  linkedPullRequest: null,
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
  ...overrides,
});

const readModel = (...threads: ReadonlyArray<OrchestrationThread>): OrchestrationReadModel => ({
  snapshotSequence: 0,
  projects: [
    {
      id: projectId,
      title: "Bots",
      workspaceRoot: "/workspace/project",
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
    },
  ],
  threads: threads.length === 0 ? [thread()] : [...threads],
  updatedAt: NOW,
});

const configure = {
  type: "thread.bot.configure" as const,
  commandId: CommandId.make("configure-bot"),
  threadId,
  expectedRevision: null,
  displayName: "Release captain",
  description: "Owns release checks.",
  createdAt: NOW,
};

it.layer(NodeServices.layer)("bot profile decider", (it) => {
  it.effect("configures and updates one canonical isolated inbox", () =>
    Effect.gen(function* () {
      const created = yield* decideOrchestrationCommand({
        command: configure,
        readModel: readModel(),
      });
      expect("type" in created).toBe(true);
      if (!("type" in created) || created.type !== "thread.bot-configured") return;
      const createdPayload = yield* Schema.decodeUnknownEffect(ThreadBotConfiguredPayload)(
        created.payload,
      );
      expect(createdPayload.profile).toMatchObject({
        displayName: "Release captain",
        description: "Owns release checks.",
        revision: 1,
        createdAt: NOW,
      });

      const projected = yield* projectEvent(readModel(), {
        ...created,
        type: "thread.bot-configured",
        payload: createdPayload,
        sequence: 1,
      });
      const updated = yield* decideOrchestrationCommand({
        command: {
          ...configure,
          commandId: CommandId.make("update-bot"),
          expectedRevision: 1,
          displayName: "Release lead",
        },
        readModel: projected,
      });
      if (!("type" in updated) || updated.type !== "thread.bot-configured") return;
      const updatedPayload = yield* Schema.decodeUnknownEffect(ThreadBotConfiguredPayload)(
        updated.payload,
      );
      expect(updatedPayload.profile.displayName).toBe("Release lead");
      expect(updatedPayload.profile.revision).toBe(2);
      expect(updatedPayload.profile.createdAt).toBe(NOW);
    }),
  );

  it.effect("rejects shared workspaces, duplicate worktrees, and stale revisions", () =>
    Effect.gen(function* () {
      const shared = yield* decideOrchestrationCommand({
        command: configure,
        readModel: readModel(thread({ worktreePath: "/workspace/project/" })),
      }).pipe(Effect.flip);
      expect(shared.message).toContain("isolated worktree");

      const existingProfile = {
        displayName: "Existing bot",
        description: null,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      } as const;
      const duplicate = yield* decideOrchestrationCommand({
        command: configure,
        readModel: readModel(
          thread(),
          thread({
            id: ThreadId.make("thread-existing-bot"),
            botProfile: existingProfile,
            worktreePath: "/worktrees/release/",
          }),
        ),
      }).pipe(Effect.flip);
      expect(duplicate.message).toContain("shares the bot worktree");

      const stale = yield* decideOrchestrationCommand({
        command: { ...configure, expectedRevision: 2 },
        readModel: readModel(thread({ botProfile: existingProfile })),
      }).pipe(Effect.flip);
      expect(stale.message).toContain("revision changed");
    }),
  );

  it.effect("requires disable before archive or delete and keeps the thread", () =>
    Effect.gen(function* () {
      const botThread = thread({
        botProfile: {
          displayName: "Release captain",
          description: null,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      });
      for (const command of [
        { type: "thread.archive" as const, commandId: CommandId.make("archive-bot"), threadId },
        { type: "thread.delete" as const, commandId: CommandId.make("delete-bot"), threadId },
      ]) {
        const error = yield* decideOrchestrationCommand({
          command,
          readModel: readModel(botThread),
        }).pipe(Effect.flip);
        expect(error.message).toContain("disable the bot");
      }

      const disabled = yield* decideOrchestrationCommand({
        command: {
          type: "thread.bot.disable",
          commandId: CommandId.make("disable-bot"),
          threadId,
          expectedRevision: 1,
          createdAt: NOW,
        },
        readModel: readModel(botThread),
      });
      if (!("type" in disabled) || disabled.type !== "thread.bot-disabled") return;
      const disabledPayload = yield* Schema.decodeUnknownEffect(ThreadBotDisabledPayload)(
        disabled.payload,
      );
      const projected = yield* projectEvent(readModel(botThread), {
        ...disabled,
        type: "thread.bot-disabled",
        payload: disabledPayload,
        sequence: 1,
      });
      expect(projected.threads[0]?.botProfile).toBeNull();
      expect(projected.threads[0]?.deletedAt).toBeNull();
    }),
  );
});
