import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DelegationId,
  KanbanCardId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type Delegation,
  type KanbanCard,
  type OrchestrationCommand,
  type OrchestrationProject,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { isAvailableKanbanBot, make } from "./KanbanDelegationReactor.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

const NOW = "2026-09-05T12:00:00.000Z";
const projectId = ProjectId.make("project-kanban-scheduler");
const botId = ThreadId.make("thread-kanban-bot");

const project: OrchestrationProject = {
  id: projectId,
  title: "Scheduler",
  workspaceRoot: "/workspace/repo",
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

const bot: OrchestrationThread = {
  id: botId,
  projectId,
  title: "Builder",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "codex/builder",
  worktreePath: "/worktrees/builder",
  linkedPullRequest: null,
  botProfile: {
    displayName: "Builder",
    description: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  },
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
};
const secondBotId = ThreadId.make("thread-kanban-bot-two");
const secondBot: OrchestrationThread = {
  ...bot,
  id: secondBotId,
  title: "Reviewer",
  branch: "codex/reviewer",
  worktreePath: "/worktrees/reviewer",
};
const toShell = (thread: OrchestrationThread): OrchestrationThreadShell => ({
  ...thread,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  backgroundLiveness: null,
});

const card = (
  id: string,
  delegationId: DelegationId | null = null,
  assigneeThreadId: ThreadId = botId,
): KanbanCard => ({
  id: KanbanCardId.make(id),
  projectId,
  title: `Task ${id}`,
  description: "Implement it",
  status: "ready",
  orderKey: id,
  assigneeThreadId,
  delegationId,
  revision: delegationId === null ? 1 : 2,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
});

const runReconcile = (input: {
  readonly cards: ReadonlyArray<KanbanCard>;
  readonly delegations?: ReadonlyArray<Delegation>;
  readonly rejectRequestForCardId?: string;
  readonly rejectFirstRequest?: boolean;
  readonly reconcileCount?: number;
  readonly requestCommandIds?: string[];
}) => {
  const commands: OrchestrationCommand[] = [];
  const receiptOutcomes = new Map<string, boolean>();
  let rejectedFirstRequest = false;
  return Effect.gen(function* () {
    const reactor = yield* make;
    for (let index = 0; index < (input.reconcileCount ?? 1); index += 1) {
      yield* reactor.reconcile();
    }
    return commands;
  }).pipe(
    Effect.provideService(ProjectionSnapshotQuery, {
      getCommandReadModel: () =>
        Effect.succeed({
          snapshotSequence: 0,
          projects: [project],
          threads: [bot, secondBot],
          kanbanCards: input.cards,
          delegations: input.delegations ?? [],
          updatedAt: NOW,
        }),
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 0,
          projects: [project],
          threads: [toShell(bot), toShell(secondBot)],
          updatedAt: NOW,
        }),
    } as unknown as ProjectionSnapshotQuery["Service"]),
    Effect.provideService(OrchestrationEngineService, {
      readEvents: () => Stream.empty,
      dispatch: (command) => {
        if (command.type === "delegation.request") {
          input.requestCommandIds?.push(command.commandId);
          const priorOutcome = receiptOutcomes.get(command.commandId);
          const rejectForCard =
            command.requester.kind === "kanban" &&
            command.requester.cardId === input.rejectRequestForCardId;
          const rejectFirst = input.rejectFirstRequest === true && !rejectedFirstRequest;
          if (priorOutcome === false || rejectForCard || rejectFirst) {
            rejectedFirstRequest = true;
            receiptOutcomes.set(command.commandId, false);
            return Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "target already reserved",
              }),
            );
          }
          receiptOutcomes.set(command.commandId, true);
        }
        return Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        });
      },
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
      latestSequence: Effect.succeed(0),
    }),
    Effect.provide(NodeServices.layer),
  );
};

it.effect("reserves an idle bot after the first of two ready cards", () =>
  Effect.gen(function* () {
    const commands = yield* runReconcile({ cards: [card("a"), card("b")] });
    const requests = commands.filter((command) => command.type === "delegation.request");

    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0]?.requester.kind, "kanban");
    if (requests[0]?.requester.kind === "kanban") {
      assert.strictEqual(requests[0].requester.cardId, KanbanCardId.make("a"));
    }
  }),
);

it("keeps errored, blocked, background, and queued bot shells unavailable", () => {
  const available = toShell(bot);
  const sessionError = {
    ...available,
    session: {
      threadId: botId,
      status: "error" as const,
      providerName: "codex",
      runtimeMode: "full-access" as const,
      activeTurnId: null,
      lastError: "Failed",
      updatedAt: NOW,
    },
  };
  const turnError = {
    ...available,
    latestTurn: {
      turnId: TurnId.make("turn-error"),
      state: "error" as const,
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      assistantMessageId: null,
    },
  };
  const blocked = [
    sessionError,
    turnError,
    { ...available, hasPendingApprovals: true },
    { ...available, hasPendingUserInput: true },
    { ...available, backgroundLiveness: "working" as const },
    { ...available, latestUserMessageAt: NOW },
  ];
  const input = {
    card: card("blocked"),
    projectWorkspaceRoot: project.workspaceRoot,
    delegations: [],
    now: NOW,
  };

  assert.isTrue(isAvailableKanbanBot({ ...input, thread: available }));
  for (const thread of blocked) {
    assert.isFalse(isAvailableKanbanBot({ ...input, thread }));
  }
});

it("rejects a bot whose normalized worktree is the project root", () => {
  assert.isFalse(
    isAvailableKanbanBot({
      card: card("equivalent-root"),
      thread: { ...toShell(bot), worktreePath: `${project.workspaceRoot}/` },
      projectWorkspaceRoot: project.workspaceRoot,
      delegations: [],
      now: NOW,
    }),
  );
});

it.effect("continues after another dispatcher wins the first bot reservation", () =>
  Effect.gen(function* () {
    const commands = yield* runReconcile({
      cards: [card("a"), card("b", null, secondBotId)],
      rejectRequestForCardId: "a",
    });
    const request = commands.find((command) => command.type === "delegation.request");
    assert.strictEqual(request?.requester.kind, "kanban");
    if (request?.requester.kind === "kanban") {
      assert.strictEqual(request.requester.cardId, KanbanCardId.make("b"));
    }
    assert.deepEqual(request?.target, { kind: "existingThread", threadId: secondBotId });
  }),
);

it.effect("uses a fresh command receipt identity when a transient reservation clears", () =>
  Effect.gen(function* () {
    const requestCommandIds: string[] = [];
    const commands = yield* runReconcile({
      cards: [card("recovery")],
      rejectFirstRequest: true,
      reconcileCount: 2,
      requestCommandIds,
    });

    assert.strictEqual(requestCommandIds.length, 2);
    assert.notStrictEqual(requestCommandIds[0], requestCommandIds[1]);
    assert.strictEqual(
      commands.filter((command) => command.type === "delegation.request").length,
      1,
    );
  }),
);

it.effect("links the persisted delegation found after a restart", () =>
  Effect.gen(function* () {
    const delegationId = DelegationId.make("kanban:linked:1");
    const linkedCard = card("linked");
    const delegation: Delegation = {
      id: delegationId,
      projectId,
      requester: { kind: "kanban", cardId: linkedCard.id, cardRevision: linkedCard.revision },
      target: { kind: "existingThread", threadId: botId },
      title: linkedCard.title,
      task: "Do the linked work",
      state: "requested",
      targetThreadId: botId,
      turnId: null,
      assistantMessageId: null,
      failure: null,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };

    const commands = yield* runReconcile({ cards: [linkedCard], delegations: [delegation] });
    assert.deepEqual(
      commands.map((command) => command.type),
      ["kanban.card.delegation.link"],
    );
    const link = commands.find((command) => command.type === "kanban.card.delegation.link");
    assert.strictEqual(link?.delegationId, delegationId);
  }),
);

it.effect("moves linked cards through running and completed lifecycle commands", () =>
  Effect.gen(function* () {
    const delegationId = DelegationId.make("kanban:lifecycle:1");
    const readyCard = card("lifecycle", delegationId);
    const running: Delegation = {
      id: delegationId,
      projectId,
      requester: { kind: "kanban", cardId: readyCard.id, cardRevision: 1 },
      target: { kind: "existingThread", threadId: botId },
      title: readyCard.title,
      task: "Do the work",
      state: "running",
      targetThreadId: botId,
      turnId: null,
      assistantMessageId: null,
      failure: null,
      revision: 3,
      createdAt: NOW,
      updatedAt: NOW,
    };

    const startCommands = yield* runReconcile({ cards: [readyCard], delegations: [running] });
    assert.deepEqual(
      startCommands.map((command) => command.type),
      ["kanban.card.delegation.start"],
    );

    const completed = { ...running, state: "completed" as const, revision: 4 };
    const completeCommands = yield* runReconcile({
      cards: [{ ...readyCard, status: "inProgress" }],
      delegations: [completed],
    });
    assert.deepEqual(
      completeCommands.map((command) => command.type),
      ["kanban.card.delegation.complete"],
    );
  }),
);
