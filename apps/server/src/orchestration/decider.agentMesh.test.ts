import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-09-03T20:00:00.000Z";
const projectId = ProjectId.make("project-mesh");
const sourceId = ThreadId.make("thread-source");
const targetId = ThreadId.make("thread-target");

const thread = (
  id: ThreadId,
  overrides: Partial<OrchestrationThread> = {},
): OrchestrationThread => ({
  id,
  projectId,
  title: id === sourceId ? "Quota research" : "Implementation",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: id === sourceId ? "/worktrees/source" : "/worktrees/target",
  linkedPullRequest: null,
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

const readModel = (
  source: OrchestrationThread = thread(sourceId),
  target: OrchestrationThread = thread(targetId),
): OrchestrationReadModel => ({
  snapshotSequence: 0,
  projects: [
    {
      id: projectId,
      title: "Project",
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
  threads: [source, target],
  updatedAt: NOW,
});

const startCommand = {
  type: "thread.peer-turn.start" as const,
  commandId: CommandId.make("provider:agent-mesh:send:source:target:request-1"),
  requestId: "request-1",
  sourceThreadId: sourceId,
  threadId: targetId,
  messageId: MessageId.make("message-peer-request"),
  message: "Review the quota adapter.",
};

it.layer(NodeServices.layer)("agent mesh decider", (it) => {
  it.effect("turns an isolated peer request into the existing turn events with provenance", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: startCommand,
        readModel: readModel(),
      });
      const events = Array.isArray(decided) ? decided : [decided];

      expect(events.map(({ type }) => type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      const message = events[0];
      expect(message?.commandId).toBe(startCommand.commandId);
      if (message?.type === "thread.message-sent") {
        expect(message.payload.text).toContain(
          'Peer agent request from "Quota research" (thread-source):',
        );
        expect(message.payload.text).toContain("Review the quota adapter.");
      }
    }),
  );

  it.effect("rejects a peer message when provenance would exceed the provider limit", () =>
    Effect.gen(function* () {
      const source = thread(sourceId, { title: "S" });
      const prefix = `Peer agent request from "S" (${sourceId}):\n\n`;
      const exactMessage = "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - prefix.length);
      const exact = yield* decideOrchestrationCommand({
        command: { ...startCommand, message: exactMessage },
        readModel: readModel(source, thread(targetId)),
      });
      const exactEvents = Array.isArray(exact) ? exact : [exact];
      expect(exactEvents[0]?.type).toBe("thread.message-sent");

      const error = yield* decideOrchestrationCommand({
        command: { ...startCommand, message: `${exactMessage}x` },
        readModel: readModel(source, thread(targetId)),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("provider limit");
    }),
  );

  it.effect("rejects peer work in a shared mutable workspace", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: startCommand,
        readModel: readModel(
          thread(sourceId),
          thread(targetId, { worktreePath: "/worktrees/source" }),
        ),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("shares the source workspace");
    }),
  );

  it.effect("normalizes Windows paths before enforcing workspace isolation", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: startCommand,
        readModel: readModel(
          thread(sourceId, { worktreePath: "C:\\Repo" }),
          thread(targetId, { worktreePath: "c:/repo/" }),
        ),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("shares the source workspace");
    }),
  );

  it.effect("rejects a peer request targeting its source thread", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: { ...startCommand, threadId: sourceId },
        readModel: readModel(),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("source and target");
    }),
  );

  it.effect("rejects deleted source, target, and project rows atomically", () =>
    Effect.gen(function* () {
      for (const model of [
        readModel(thread(sourceId, { deletedAt: NOW }), thread(targetId)),
        readModel(thread(sourceId), thread(targetId, { deletedAt: NOW })),
        {
          ...readModel(),
          projects: readModel().projects.map((project) => ({ ...project, deletedAt: NOW })),
        },
      ]) {
        const error = yield* decideOrchestrationCommand({
          command: startCommand,
          readModel: model,
        }).pipe(Effect.flip);

        expect(error._tag).toBe("OrchestrationCommandInvariantError");
        expect(error.message).toMatch(/deleted/);
      }
    }),
  );

  it.effect("rejects cross-project and busy targets atomically", () =>
    Effect.gen(function* () {
      const crossProject = yield* decideOrchestrationCommand({
        command: startCommand,
        readModel: readModel(
          thread(sourceId),
          thread(targetId, { projectId: ProjectId.make("project-other") }),
        ),
      }).pipe(Effect.flip);
      expect(crossProject.message).toContain("another project");

      const busy = yield* decideOrchestrationCommand({
        command: startCommand,
        readModel: readModel(
          thread(sourceId),
          thread(targetId, {
            activities: [
              {
                id: EventId.make("approval-request"),
                tone: "approval",
                kind: "approval.requested",
                summary: "Approval requested",
                payload: { requestId: "approval-1" },
                turnId: null,
                createdAt: NOW,
              },
            ],
          }),
        ),
      }).pipe(Effect.flip);
      expect(busy.message).toContain("busy or waiting for input");
    }),
  );

  it.effect("interrupts only the exact observed running turn", () =>
    Effect.gen(function* () {
      const turnId = TurnId.make("turn-running");
      const target = thread(targetId, {
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: null,
          assistantMessageId: null,
        },
      });
      const command = {
        type: "thread.peer-turn.interrupt" as const,
        commandId: CommandId.make("provider:agent-mesh:interrupt:request-2"),
        requestId: "request-2",
        sourceThreadId: sourceId,
        threadId: targetId,
        observedTurnId: turnId,
      };

      const decided = yield* decideOrchestrationCommand({
        command,
        readModel: readModel(thread(sourceId), target),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.turn-interrupt-requested");

      const stale = yield* decideOrchestrationCommand({
        command: { ...command, observedTurnId: TurnId.make("turn-stale") },
        readModel: readModel(thread(sourceId), target),
      }).pipe(Effect.flip);
      expect(stale.message).toContain("not running observed turn");
    }),
  );
});
