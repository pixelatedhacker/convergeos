import { assert, expect, it } from "@effect/vitest";
import {
  CommandId,
  DelegationId,
  EventId,
  KanbanCardId,
  MessageId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type Delegation,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadLaunchService from "../orchestration/Services/ThreadLaunchService.ts";
import {
  delegationCommandIdFor,
  delegationMessageIdFor,
  delegationWorkerThreadIdFor,
  make,
  threadDelegationIdFor,
} from "./DelegationService.ts";

const now = "2026-09-05T00:00:00.000Z";
const projectId = ProjectId.make("project-runtime");
const callerId = ThreadId.make("thread-caller-runtime");
const botId = ThreadId.make("thread-bot-runtime");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex-runtime"),
  model: "gpt-test",
};

const project: OrchestrationProjectShell = {
  id: projectId,
  title: "Runtime project",
  workspaceRoot: "/workspace/runtime-project",
  repositoryIdentity: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
};

const thread = (input: {
  readonly id: ThreadId;
  readonly worktreePath: string | null;
  readonly bot?: boolean;
}): OrchestrationThreadShell => ({
  id: input.id,
  projectId,
  title: input.bot === true ? "Bot" : "Caller",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: input.worktreePath,
  linkedPullRequest: null,
  botProfile:
    input.bot === true
      ? {
          displayName: "Bot",
          description: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        }
      : null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  unsettledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  titleRegeneration: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  backgroundLiveness: null,
  planProgress: null,
});

const fullThread = (
  shell: OrchestrationThreadShell,
  messages: ReadonlyArray<OrchestrationMessage>,
): OrchestrationThread => ({
  ...shell,
  deletedAt: null,
  messages: [...messages],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
});

const delegation = (input: {
  readonly id: string;
  readonly state: Delegation["state"];
  readonly requester: Delegation["requester"];
  readonly target: Delegation["target"];
  readonly targetThreadId: ThreadId | null;
}): Delegation => ({
  id: DelegationId.make(input.id),
  projectId,
  requester: input.requester,
  target: input.target,
  title: "Delegated task",
  task: "Implement the delegated task.",
  state: input.state,
  targetThreadId: input.targetThreadId,
  turnId: null,
  assistantMessageId: null,
  failure: null,
  revision: input.state === "requested" ? 1 : input.state === "provisioning" ? 2 : 3,
  createdAt: now,
  updatedAt: now,
});

const transitionEvent = (
  type: "delegation.requested" | "delegation.turn-requested",
  value: Delegation,
  sequence: number,
): OrchestrationEvent => ({
  type,
  sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind: "delegation",
  aggregateId: value.id,
  occurredAt: now,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  payload: { delegation: value },
});

interface HarnessInput {
  readonly initialDelegation: Delegation | null;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly publishTurnRequested?: boolean;
  readonly failedTurnStarts?: number;
  readonly launchFails?: boolean;
  readonly uncertainLaunch?: boolean;
  readonly rejectTurnRequest?: boolean;
}

function runHarness<A, E, R>(
  input: HarnessInput,
  use: (state: {
    readonly service: import("./DelegationService.ts").DelegationServiceShape;
    readonly commands: OrchestrationCommand[];
    readonly launchInputs: ThreadLaunchService.ThreadLaunchInput[];
    readonly events: Queue.Queue<OrchestrationEvent>;
    readonly turnStarted: Deferred.Deferred<void>;
    readonly delegationCompleted: Deferred.Deferred<void>;
    readonly setDelegation: (value: Delegation) => void;
    readonly deleteThread: (threadId: ThreadId) => void;
    readonly getDelegation: () => Delegation | null;
  }) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    let currentDelegation = input.initialDelegation;
    let sequence = 0;
    let failedTurnStarts = input.failedTurnStarts ?? 0;
    const commands: OrchestrationCommand[] = [];
    const launchInputs: ThreadLaunchService.ThreadLaunchInput[] = [];
    const threads = new Map(input.threads.map((entry) => [entry.id, entry]));
    const messages = new Map<ThreadId, OrchestrationMessage[]>();
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    const turnStarted = yield* Deferred.make<void>();
    const delegationCompleted = yield* Deferred.make<void>();

    const dispatch = (command: OrchestrationCommand) =>
      Effect.gen(function* () {
        commands.push(command);
        sequence += 1;
        if (command.type === "delegation.turn.request" && input.rejectTurnRequest === true) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "target worktree changed after reservation",
          });
        }
        if (command.type === "delegation.provision.start" && currentDelegation !== null) {
          currentDelegation = {
            ...currentDelegation,
            state: "provisioning",
            targetThreadId: command.targetThreadId,
            revision: currentDelegation.revision + 1,
          };
        } else if (command.type === "delegation.target.bind" && currentDelegation !== null) {
          currentDelegation = {
            ...currentDelegation,
            targetThreadId: command.targetThreadId,
            revision: currentDelegation.revision + 1,
          };
        } else if (command.type === "delegation.turn.request" && currentDelegation !== null) {
          currentDelegation = {
            ...currentDelegation,
            state: "turnRequested",
            revision: currentDelegation.revision + 1,
          };
          if (input.publishTurnRequested === true) {
            yield* Queue.offer(
              events,
              transitionEvent("delegation.turn-requested", currentDelegation, sequence),
            );
          }
        } else if (command.type === "delegation.complete" && currentDelegation !== null) {
          currentDelegation = {
            ...currentDelegation,
            state: command.outcome,
            failure: command.failure,
            revision: currentDelegation.revision + 1,
          };
          yield* Deferred.succeed(delegationCompleted, undefined);
        } else if (command.type === "thread.meta.update") {
          const existing = threads.get(command.threadId);
          if (existing !== undefined) {
            threads.set(command.threadId, {
              ...existing,
              branch: command.branch ?? existing.branch,
              worktreePath: command.worktreePath ?? existing.worktreePath,
            });
          }
        }

        if (command.type === "thread.turn.start" || command.type === "thread.peer-turn.start") {
          if (failedTurnStarts > 0) {
            failedTurnStarts -= 1;
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "injected turn-start failure",
            });
          }
          const messageId =
            command.type === "thread.turn.start" ? command.message.messageId : command.messageId;
          const text =
            command.type === "thread.turn.start" ? command.message.text : command.message;
          messages.set(command.threadId, [
            {
              id: messageId,
              role: "user",
              text,
              attachments: [],
              turnId: null,
              streaming: false,
              createdAt: now,
              updatedAt: now,
            },
          ]);
          yield* Deferred.succeed(turnStarted, undefined);
        }
        return { sequence };
      });

    const layers = Layer.mergeAll(
      Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
        readEvents: () => Stream.empty,
        dispatch,
        streamDomainEvents: Stream.fromQueue(events),
        subscribeDomainEvents: Effect.succeed(Stream.fromQueue(events)),
        latestSequence: Effect.sync(() => sequence),
      }),
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getCommandReadModel: () =>
          Effect.sync(() => ({
            snapshotSequence: sequence,
            projects: [{ ...project, deletedAt: null }],
            threads: [...threads.values()].map((entry) =>
              fullThread(entry, messages.get(entry.id) ?? []),
            ),
            kanbanCards: [],
            delegations: currentDelegation === null ? [] : [currentDelegation],
            updatedAt: now,
          })),
        getDelegations: (ids) =>
          Effect.sync(() =>
            currentDelegation !== null && ids.includes(currentDelegation.id)
              ? [currentDelegation]
              : [],
          ),
        getOpenDelegationsForTarget: (threadId) =>
          Effect.sync(() =>
            currentDelegation !== null &&
            currentDelegation.targetThreadId === threadId &&
            currentDelegation.state !== "completed" &&
            currentDelegation.state !== "failed" &&
            currentDelegation.state !== "interrupted"
              ? [currentDelegation]
              : [],
          ),
        getProjectShellById: (id) =>
          Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
        getThreadShellById: (id) =>
          Effect.sync(() => {
            const value = threads.get(id);
            return value === undefined ? Option.none() : Option.some(value);
          }),
        getThreadDetailSnapshot: (id) =>
          Effect.sync(() => {
            const shell = threads.get(id);
            return shell === undefined
              ? Option.none()
              : Option.some({
                  snapshotSequence: sequence,
                  thread: fullThread(shell, messages.get(id) ?? []),
                });
          }),
      }),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: (launchInput) => {
          launchInputs.push(launchInput);
          if (input.launchFails === true) {
            return Effect.fail(
              new OrchestrationDispatchCommandError({
                message:
                  input.uncertainLaunch === true
                    ? ThreadLaunchService.THREAD_LAUNCH_SETUP_OUTCOME_UNCERTAIN
                    : "injected launch failure",
              }),
            );
          }
          return Effect.sync(() => {
            sequence += 1;
            const existing = threads.get(launchInput.command.threadId);
            if (existing !== undefined) {
              threads.set(existing.id, { ...existing, worktreePath: "/worktrees/recovered" });
            }
            messages.set(launchInput.command.threadId, [
              {
                id: launchInput.command.message.messageId,
                role: launchInput.command.message.role,
                text: launchInput.command.message.text,
                attachments: launchInput.command.message.attachments,
                turnId: null,
                streaming: false,
                createdAt: now,
                updatedAt: now,
              },
            ]);
            return { sequence };
          });
        },
      }),
    );

    const service = yield* make.pipe(Effect.provide(layers));
    return yield* use({
      service,
      commands,
      launchInputs,
      events,
      turnStarted,
      delegationCompleted,
      setDelegation: (value) => {
        currentDelegation = value;
      },
      deleteThread: (threadId) => {
        threads.delete(threadId);
      },
      getDelegation: () => currentDelegation,
    });
  });
}

it.effect("advances a persisted Kanban request with the shared deterministic turn identity", () => {
  const value = delegation({
    id: "delegation-kanban-requested",
    state: "requested",
    requester: {
      kind: "kanban",
      cardId: KanbanCardId.make("card-runtime"),
      cardRevision: 1,
    },
    target: { kind: "existingThread", threadId: botId },
    targetThreadId: botId,
  });
  return Effect.scoped(
    runHarness(
      {
        initialDelegation: value,
        threads: [thread({ id: botId, worktreePath: "/worktrees/bot", bot: true })],
      },
      ({ commands }) =>
        Effect.sync(() => {
          expect(commands.map((command) => command.type)).toEqual([
            "delegation.turn.request",
            "thread.turn.start",
          ]);
          const turn = commands[1];
          assert(turn?.type === "thread.turn.start");
          expect(turn.commandId).toBe(delegationCommandIdFor(value.id, "target-turn"));
          expect(turn.message.messageId).toBe(delegationMessageIdFor(value.id));
        }),
    ),
  );
});

it.effect("restarts a persisted new-worker turn without requiring its requester", () => {
  const workerId = delegationWorkerThreadIdFor(DelegationId.make("delegation-worker-turn"));
  const value = delegation({
    id: "delegation-worker-turn",
    state: "turnRequested",
    requester: { kind: "thread", threadId: callerId, requestId: "worker-turn" },
    target: { kind: "newThread", modelSelection },
    targetThreadId: workerId,
  });
  return Effect.scoped(
    runHarness(
      {
        initialDelegation: value,
        threads: [thread({ id: workerId, worktreePath: "/worktrees/worker" })],
      },
      ({ commands }) =>
        Effect.sync(() => {
          const turn = commands.find((command) => command.type === "thread.turn.start");
          assert(turn?.type === "thread.turn.start");
          expect(turn.commandId).toBe(delegationCommandIdFor(value.id, "worker-turn"));
          expect(turn.message.messageId).toBe(delegationMessageIdFor(value.id));
          expect(commands.some((command) => command.type === "thread.peer-turn.start")).toBe(false);
        }),
    ),
  );
});

for (const partial of [
  { label: "worktree metadata is missing", worktreePath: null },
  { label: "metadata exists but setup did not finish", worktreePath: "/worktrees/partial" },
] as const) {
  it.effect(`resumes a created worker when ${partial.label}`, () => {
    const id = DelegationId.make(
      partial.worktreePath === null
        ? "delegation-partial-no-metadata"
        : "delegation-partial-no-setup",
    );
    const workerId = delegationWorkerThreadIdFor(id);
    const value = delegation({
      id,
      state: "provisioning",
      requester: { kind: "thread", threadId: callerId, requestId: id },
      target: { kind: "newThread", modelSelection },
      targetThreadId: null,
    });
    return Effect.scoped(
      runHarness(
        {
          initialDelegation: value,
          threads: [
            thread({ id: callerId, worktreePath: project.workspaceRoot }),
            thread({ id: workerId, worktreePath: partial.worktreePath }),
          ],
        },
        ({ launchInputs, getDelegation }) =>
          Effect.sync(() => {
            expect(launchInputs).toHaveLength(1);
            expect(launchInputs[0]?.resumeExistingThread).toBe(true);
            expect(launchInputs[0]?.command.bootstrap?.createThread).toBeUndefined();
            expect(getDelegation()?.targetThreadId).toBe(workerId);
            expect(getDelegation()?.state).toBe("turnRequested");
          }),
      ),
    );
  });
}

it.effect("retries a live Kanban turn after the requested event wins the first dispatch race", () =>
  Effect.scoped(
    runHarness(
      {
        initialDelegation: null,
        threads: [thread({ id: botId, worktreePath: "/worktrees/bot", bot: true })],
        publishTurnRequested: true,
        failedTurnStarts: 1,
      },
      ({ commands, events, setDelegation, turnStarted }) =>
        Effect.gen(function* () {
          const value = delegation({
            id: "delegation-kanban-live",
            state: "requested",
            requester: {
              kind: "kanban",
              cardId: KanbanCardId.make("card-live"),
              cardRevision: 1,
            },
            target: { kind: "existingThread", threadId: botId },
            targetThreadId: botId,
          });
          setDelegation(value);
          yield* Queue.offer(events, transitionEvent("delegation.requested", value, 1));
          yield* Deferred.await(turnStarted);
          const starts = commands.filter((command) => command.type === "thread.turn.start");
          expect(starts).toHaveLength(2);
          expect(starts[0]?.commandId).toBe(delegationCommandIdFor(value.id, "target-turn"));
          expect(starts[1]?.commandId).toBe(delegationCommandIdFor(value.id, "target-turn"));
        }),
    ),
  ),
);

it.effect("fails a reserved Kanban delegation when its bot is deleted before turn request", () =>
  Effect.scoped(
    runHarness(
      {
        initialDelegation: null,
        threads: [thread({ id: botId, worktreePath: "/worktrees/bot", bot: true })],
      },
      ({ delegationCompleted, deleteThread, events, getDelegation, setDelegation }) =>
        Effect.gen(function* () {
          const value = delegation({
            id: "delegation-kanban-deleted-bot",
            state: "requested",
            requester: {
              kind: "kanban",
              cardId: KanbanCardId.make("card-deleted-bot"),
              cardRevision: 1,
            },
            target: { kind: "existingThread", threadId: botId },
            targetThreadId: botId,
          });
          setDelegation(value);
          deleteThread(botId);
          yield* Queue.offer(events, {
            type: "thread.deleted",
            sequence: 1,
            eventId: EventId.make("event-thread-deleted"),
            aggregateKind: "thread",
            aggregateId: botId,
            occurredAt: now,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            payload: { threadId: botId, deletedAt: now },
          });
          yield* Deferred.await(delegationCompleted);
          expect(getDelegation()?.state).toBe("failed");
        }),
    ),
  ),
);

it.effect("fails a reserved delegation when the target worktree changes before turn request", () =>
  Effect.scoped(
    runHarness(
      {
        initialDelegation: delegation({
          id: "delegation-worktree-race",
          state: "requested",
          requester: {
            kind: "kanban",
            cardId: KanbanCardId.make("card-worktree-race"),
            cardRevision: 1,
          },
          target: { kind: "existingThread", threadId: botId },
          targetThreadId: botId,
        }),
        threads: [thread({ id: botId, worktreePath: project.workspaceRoot, bot: true })],
        rejectTurnRequest: true,
      },
      ({ delegationCompleted, getDelegation }) =>
        Effect.gen(function* () {
          yield* Deferred.await(delegationCompleted);
          expect(getDelegation()?.state).toBe("failed");
          expect(getDelegation()?.failure?.detail).toContain("target bot changed");
        }),
    ),
  ),
);

it.effect("keeps a resumed worker provisioning when the reusable launch fails", () => {
  const id = DelegationId.make("delegation-resume-failure");
  const workerId = delegationWorkerThreadIdFor(id);
  const value = delegation({
    id,
    state: "provisioning",
    requester: { kind: "thread", threadId: callerId, requestId: "resume-failure" },
    target: { kind: "newThread", modelSelection },
    targetThreadId: null,
  });
  return Effect.scoped(
    runHarness(
      {
        initialDelegation: value,
        threads: [
          thread({ id: callerId, worktreePath: project.workspaceRoot }),
          thread({ id: workerId, worktreePath: null }),
        ],
        launchFails: true,
      },
      ({ service, getDelegation }) =>
        service
          .spawn(
            { threadId: callerId },
            {
              requestId: "resume-failure",
              title: value.title,
              task: value.task,
              modelSelection,
            },
          )
          .pipe(
            Effect.flip,
            Effect.tap(() =>
              Effect.sync(() => expect(getDelegation()?.state).toBe("provisioning")),
            ),
          ),
    ),
  );
});

it.effect("terminalizes a worker whose setup dispatch outcome is uncertain", () => {
  const id = DelegationId.make("delegation-uncertain-setup");
  const workerId = delegationWorkerThreadIdFor(id);
  const value = delegation({
    id,
    state: "provisioning",
    requester: { kind: "thread", threadId: callerId, requestId: "uncertain-setup" },
    target: { kind: "newThread", modelSelection },
    targetThreadId: null,
  });
  return Effect.scoped(
    runHarness(
      {
        initialDelegation: value,
        threads: [
          thread({ id: callerId, worktreePath: project.workspaceRoot }),
          thread({ id: workerId, worktreePath: "/worktrees/uncertain" }),
        ],
        launchFails: true,
        uncertainLaunch: true,
      },
      ({ service, commands, getDelegation }) =>
        service
          .spawn(
            { threadId: callerId },
            {
              requestId: "uncertain-setup",
              title: value.title,
              task: value.task,
              modelSelection,
            },
          )
          .pipe(
            Effect.flip,
            Effect.tap(() =>
              Effect.sync(() => {
                expect(getDelegation()?.state).toBe("failed");
                expect(commands.some((command) => command.type === "thread.turn.start")).toBe(
                  false,
                );
              }),
            ),
          ),
    ),
  );
});

it.effect("returns a terminal send receipt after both requester and target disappear", () => {
  const value = {
    ...delegation({
      id: threadDelegationIdFor(callerId, "terminal-send"),
      state: "completed",
      requester: { kind: "thread", threadId: callerId, requestId: "terminal-send" },
      target: { kind: "existingThread", threadId: botId },
      targetThreadId: botId,
    }),
    task: "Already completed.",
  } satisfies Delegation;
  return Effect.scoped(
    runHarness({ initialDelegation: value, threads: [] }, ({ service }) =>
      service
        .send(
          { threadId: callerId },
          {
            requestId: "terminal-send",
            targetThreadId: botId,
            message: value.task,
          },
        )
        .pipe(
          Effect.tap((receipt) =>
            Effect.sync(() => {
              expect(receipt.delegationId).toBe(value.id);
              expect(receipt.targetThreadId).toBe(botId);
              expect(receipt.state).toBe("completed");
            }),
          ),
        ),
    ),
  );
});

it.effect("returns a terminal spawn receipt after its requester disappears", () => {
  const id = threadDelegationIdFor(callerId, "terminal-spawn");
  const value = delegation({
    id,
    state: "failed",
    requester: { kind: "thread", threadId: callerId, requestId: "terminal-spawn" },
    target: { kind: "newThread", modelSelection },
    targetThreadId: delegationWorkerThreadIdFor(id),
  });
  return Effect.scoped(
    runHarness({ initialDelegation: value, threads: [] }, ({ service }) =>
      service
        .spawn(
          { threadId: callerId },
          {
            requestId: "terminal-spawn",
            title: value.title,
            task: value.task,
            modelSelection,
          },
        )
        .pipe(
          Effect.tap((receipt) =>
            Effect.sync(() => {
              expect(receipt.delegationId).toBe(value.id);
              expect(receipt.targetThreadId).toBe(value.targetThreadId);
              expect(receipt.state).toBe("failed");
            }),
          ),
        ),
    ),
  );
});
