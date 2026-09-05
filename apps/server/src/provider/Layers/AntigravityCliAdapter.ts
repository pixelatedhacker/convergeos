import {
  ANTIGRAVITY_CLI_DEFAULT_MODEL,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  TurnId,
  type AntigravityCliSettings,
  type ItemLifecyclePayload,
  type ModelSelection,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
  type TurnCompletedPayload,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner";
import * as NodeCrypto from "node:crypto";

import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import {
  AntigravityCliResumeCursor,
  antigravityCliTurnUsage,
  decodeAntigravityCliEvent,
  type AntigravityCliEvent,
  type AntigravityCliUsage,
} from "../antigravityCliProtocol.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("antigravityCli");
const MAX_LINE_CHARS = 4 * 1024 * 1024;
const decodeCursor = Schema.decodeUnknownOption(AntigravityCliResumeCursor);
const encodePrompt = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      event: Schema.Literal("user"),
      message: Schema.Struct({ content: Schema.String }),
    }),
  ),
);
type Adapter = ProviderAdapterShape<ProviderAdapterError>;
type NativeResult = Extract<AntigravityCliEvent, { event: "result" }>["result"];

export interface AntigravityCliAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
}

interface ActiveTurn {
  readonly id: TurnId;
  readonly initialized: Deferred.Deferred<void, ProviderAdapterError>;
  readonly done: Deferred.Deferred<void>;
  readonly items: Map<RuntimeItemId, ItemLifecyclePayload>;
  readonly completedItems: Set<RuntimeItemId>;
  readonly stepUsage: Map<number, AntigravityCliUsage>;
  fiber: Fiber.Fiber<void> | undefined;
  child: ChildProcessHandle | undefined;
  interrupted: boolean;
  streamedText: boolean;
  result: NativeResult | undefined;
}

interface SessionContext {
  session: ProviderSession;
  readonly cwd: string;
  cursor: AntigravityCliResumeCursor | undefined;
  selection: ModelSelection | undefined;
  active: ActiveTurn | undefined;
  stopping: boolean;
  readonly stopped: Deferred.Deferred<void>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
}

export const makeAntigravityCliAdapter = Effect.fn("makeAntigravityCliAdapter")(function* (
  settings: AntigravityCliSettings,
  options: AntigravityCliAdapterOptions = {},
) {
  const instanceId = options.instanceId ?? ProviderInstanceId.make("antigravityCli");
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const ownerScope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const sessions = new Map<ThreadId, SessionContext>();
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(events));
  const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const base = (context: SessionContext, turn?: ActiveTurn) =>
    nowIso.pipe(
      Effect.map((createdAt) => ({
        eventId: EventId.make(NodeCrypto.randomUUID()),
        provider: PROVIDER,
        providerInstanceId: instanceId,
        threadId: context.session.threadId,
        createdAt,
        ...(turn ? { turnId: turn.id } : {}),
      })),
    );
  const invalid = (operation: string, issue: string) =>
    new ProviderAdapterValidationError({ provider: PROVIDER, operation, issue });
  const failed = (detail: string) =>
    new ProviderAdapterRequestError({ provider: PROVIDER, method: "headless", detail });
  const requireSession = (threadId: ThreadId) =>
    Effect.suspend(() => {
      const context = sessions.get(threadId);
      return context && !context.stopping
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    });

  const acceptEvent = Effect.fn("AntigravityCliAdapter.acceptEvent")(function* (
    context: SessionContext,
    turn: ActiveTurn,
    event: AntigravityCliEvent,
  ) {
    if (turn.result)
      return yield* failed("Antigravity CLI emitted data after its terminal result.");
    const raw = { source: "antigravity.cli", payload: event } as const;
    if (event.event === "init") {
      if (yield* Deferred.isDone(turn.initialized))
        return yield* failed("Antigravity CLI emitted duplicate initialization.");
      const nativeCwd = yield* fs
        .realPath(event.init.cwd)
        .pipe(
          Effect.mapError(() => failed("Antigravity CLI initialized in an unavailable workspace.")),
        );
      if (nativeCwd !== context.cwd)
        return yield* failed("Antigravity CLI initialized in a different workspace.");
      if (context.cursor && context.cursor.conversationId !== event.conversation_id)
        return yield* failed("Antigravity CLI resumed a different conversation.");
      context.cursor = {
        driver: "antigravityCli",
        schemaVersion: 1,
        instanceId,
        cwd: context.cwd,
        conversationId: event.conversation_id,
      };
      context.session = {
        ...context.session,
        resumeCursor: context.cursor,
        updatedAt: yield* nowIso,
      };
      yield* emit({
        ...(yield* base(context, turn)),
        type: "session.configured",
        payload: { config: { resumeCursor: context.cursor } },
        raw,
      });
      yield* Deferred.succeed(turn.initialized, undefined);
      return;
    }
    const conversationId =
      event.event === "step_update"
        ? event.step_update.conversation_id
        : event.result.conversation_id;
    if (!context.cursor || !(yield* Deferred.isDone(turn.initialized))) {
      return yield* failed(
        event.event === "result"
          ? event.result.error || "Antigravity CLI ended before initialization."
          : "Antigravity CLI sent a step before initialization.",
      );
    }
    if (conversationId !== context.cursor.conversationId)
      return yield* failed("Antigravity CLI changed conversation identity during a turn.");
    if (event.event === "result") {
      turn.result = event.result;
      if (!turn.streamedText && event.result.response) {
        const itemId = RuntimeItemId.make(`${turn.id}:response`);
        const payload = { itemType: "assistant_message" } satisfies ItemLifecyclePayload;
        turn.items.set(itemId, payload);
        yield* emit({
          ...(yield* base(context, turn)),
          itemId,
          type: "item.started",
          payload,
          raw,
        });
        yield* emit({
          ...(yield* base(context, turn)),
          itemId,
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta: event.result.response },
          raw,
        });
      }
      return;
    }
    const step = event.step_update;
    if (step.state === "DONE" && step.usage) turn.stepUsage.set(step.step_index, step.usage);
    if (["user_input", "checkpoint", "system_message"].includes(step.step_type)) return;
    const itemId = RuntimeItemId.make(`${turn.id}:${step.step_index}`);
    if (turn.completedItems.has(itemId)) return;
    const isAssistant = step.step_type === "agent_response";
    const toolName = step.tool_name || step.tool_info?.name || "Tool";
    const itemType = isAssistant
      ? "assistant_message"
      : toolName === "run_command"
        ? "command_execution"
        : ["write_to_file", "replace_file_content", "multi_replace_file_content"].includes(toolName)
          ? "file_change"
          : step.step_type === "tool"
            ? "dynamic_tool_call"
            : "unknown";
    const payload: ItemLifecyclePayload = {
      itemType,
      ...(isAssistant
        ? {}
        : { title: toolName, data: step.tool_info ?? step.subagent_info ?? step }),
      status:
        step.state === "ACTIVE"
          ? "inProgress"
          : step.tool_info?.error !== undefined
            ? "failed"
            : "completed",
    };
    if (!turn.items.has(itemId))
      yield* emit({
        ...(yield* base(context, turn)),
        itemId,
        type: "item.started",
        payload: { ...payload, status: "inProgress" },
        raw,
      });
    turn.items.set(itemId, payload);
    if (isAssistant && step.text_delta) {
      turn.streamedText = true;
      yield* emit({
        ...(yield* base(context, turn)),
        itemId,
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: step.text_delta },
        raw,
      });
    }
    yield* emit({
      ...(yield* base(context, turn)),
      itemId,
      type: step.state === "DONE" ? "item.completed" : "item.updated",
      payload,
      raw,
    });
    if (step.state === "DONE") turn.completedItems.add(itemId);
  });

  const runProcess = Effect.fn("AntigravityCliAdapter.runProcess")(function* (
    context: SessionContext,
    turn: ActiveTurn,
    prompt: string,
    selection: ModelSelection | undefined,
  ) {
    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
    ];
    if (context.cursor) args.push("--conversation", context.cursor.conversationId);
    if (selection && selection.model !== ANTIGRAVITY_CLI_DEFAULT_MODEL)
      args.push("--model", selection.model);
    const spawn = yield* resolveSpawnCommand(
      settings.binaryPath || "agy",
      args,
      options.environment ? { env: options.environment } : {},
    );
    const child = yield* spawner.spawn(
      ChildProcess.make(spawn.command, spawn.args, {
        cwd: context.cwd,
        env: options.environment,
        shell: spawn.shell,
        stdin: {
          stream: Stream.make(
            new TextEncoder().encode(
              `${encodePrompt({ event: "user", message: { content: prompt } })}\n`,
            ),
          ),
          endOnDone: true,
        },
      }),
    );
    turn.child = child;
    let buffer = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const consume = Effect.fn("AntigravityCliAdapter.consume")(function* (
      text: string,
      final = false,
    ) {
      buffer += text;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        if (newline > MAX_LINE_CHARS)
          return yield* failed("Antigravity CLI output line exceeded the size limit.");
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const event = yield* decodeAntigravityCliEvent(line).pipe(
            Effect.mapError(() => failed("Antigravity CLI emitted invalid stream JSON.")),
          );
          yield* acceptEvent(context, turn, event);
        }
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_LINE_CHARS)
        return yield* failed("Antigravity CLI output line exceeded the size limit.");
      if (final && buffer.trim()) {
        const event = yield* decodeAntigravityCliEvent(buffer).pipe(
          Effect.mapError(() => failed("Antigravity CLI emitted an incomplete JSON line.")),
        );
        buffer = "";
        yield* acceptEvent(context, turn, event);
      }
    });
    const stdout = child.stdout.pipe(
      Stream.runForEach((chunk) =>
        Effect.try({
          try: () => decoder.decode(chunk, { stream: true }),
          catch: () => failed("Antigravity CLI emitted invalid UTF-8."),
        }).pipe(Effect.flatMap((text) => consume(text))),
      ),
      Effect.andThen(
        Effect.try({
          try: () => decoder.decode(),
          catch: () => failed("Antigravity CLI emitted incomplete UTF-8."),
        }).pipe(Effect.flatMap((text) => consume(text, true))),
      ),
    );
    const [, stderr, exitCode] = yield* Effect.all(
      [stdout, collectUint8StreamText({ stream: child.stderr, maxBytes: 16_384 }), child.exitCode],
      { concurrency: "unbounded" },
    );
    if (Number(exitCode) !== 0 && !turn.interrupted)
      return yield* failed(
        `Antigravity CLI exited with code ${exitCode}.${stderr.text.trim() ? ` ${stderr.text.trim()}` : ""}`,
      );
    if (!turn.result && !turn.interrupted)
      return yield* failed(
        `Antigravity CLI exited without a result.${stderr.text.trim() ? ` ${stderr.text.trim()}` : ""}`,
      );
  });

  const finish = Effect.fn("AntigravityCliAdapter.finish")(function* (
    context: SessionContext,
    turn: ActiveTurn,
    error?: string,
  ) {
    const result = turn.result;
    const state: TurnCompletedPayload["state"] = turn.interrupted
      ? "interrupted"
      : error
        ? "failed"
        : result?.status === "SUCCESS"
          ? "completed"
          : result?.status === "INTERRUPTED"
            ? "interrupted"
            : result?.status === "CANCELED"
              ? "cancelled"
              : "failed";
    const errorMessage = error ?? result?.error;
    const usage =
      turn.stepUsage.size > 0 ? antigravityCliTurnUsage([...turn.stepUsage.values()]) : undefined;
    for (const [itemId, payload] of turn.items) {
      if (!turn.completedItems.has(itemId))
        yield* emit({
          ...(yield* base(context, turn)),
          itemId,
          type: "item.completed",
          payload: { ...payload, status: state === "completed" ? "completed" : "failed" },
        });
    }
    context.turns.push({ id: turn.id, items: result ? [result] : [] });
    if (context.active === turn) {
      context.active = undefined;
      const { activeTurnId: _activeTurnId, ...session } = context.session;
      context.session = {
        ...session,
        status: context.stopping ? "closed" : "ready",
        updatedAt: yield* nowIso,
      };
    }
    yield* Deferred.fail(
      turn.initialized,
      failed(errorMessage || "Antigravity CLI stopped before initialization."),
    );
    yield* emit({
      ...(yield* base(context, turn)),
      type: "turn.completed",
      payload: {
        state,
        ...(usage ? { usage } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        ...(result ? { stopReason: result.status } : {}),
      },
      ...(result
        ? { raw: { source: "antigravity.cli", payload: { result, usageScope: "conversation" } } }
        : {}),
    });
    yield* emit({
      ...(yield* base(context)),
      type: "session.state.changed",
      payload: { state: context.stopping ? "stopped" : "ready" },
    });
    yield* Deferred.succeed(turn.done, undefined);
  }, lock.withPermit);

  const cancel = Effect.fn("AntigravityCliAdapter.cancel")(function* (
    context: SessionContext,
    turn: ActiveTurn,
  ) {
    turn.interrupted = true;
    if (turn.child)
      yield* turn.child
        .kill({ killSignal: "SIGINT", forceKillAfter: "1 second" })
        .pipe(Effect.ignore);
    if (turn.fiber) yield* Fiber.interrupt(turn.fiber);
    yield* Deferred.await(turn.done);
  });
  const stopSession: Adapter["stopSession"] = Effect.fn("AntigravityCliAdapter.stopSession")(
    function* (threadId) {
      const target = yield* lock.withPermit(
        Effect.sync(() => {
          const context = sessions.get(threadId);
          if (!context) return undefined;
          const owner = !context.stopping;
          context.stopping = true;
          return { context, owner };
        }),
      );
      if (!target) return;
      const { context, owner } = target;
      if (!owner) return yield* Deferred.await(context.stopped);
      if (context.active) yield* cancel(context, context.active);
      yield* lock.withPermit(
        Effect.gen(function* () {
          if (sessions.get(threadId) === context) {
            sessions.delete(threadId);
            yield* emit({
              ...(yield* base(context)),
              type: "session.exited",
              payload: { reason: "Session stopped.", exitKind: "graceful" },
            });
          }
          yield* Deferred.succeed(context.stopped, undefined);
        }),
      );
    },
    Effect.uninterruptible,
  );
  const stopAll = () => Effect.forEach([...sessions.keys()], stopSession, { discard: true });
  yield* Effect.addFinalizer(() => stopAll().pipe(Effect.ignore));

  const startSession: Adapter["startSession"] = (input) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (!settings.enabled)
          return yield* invalid(
            "startSession",
            "Enable Antigravity CLI in provider settings first.",
          );
        if (input.runtimeMode !== "full-access")
          return yield* invalid(
            "startSession",
            "Antigravity CLI requires Full access. Headless mode cannot ask for approvals.",
          );
        if (
          (input.provider !== undefined && input.provider !== PROVIDER) ||
          (input.providerInstanceId !== undefined && input.providerInstanceId !== instanceId) ||
          (input.modelSelection && input.modelSelection.instanceId !== instanceId)
        )
          return yield* invalid(
            "startSession",
            "Antigravity CLI provider instance does not match.",
          );
        if (!input.cwd || !path.isAbsolute(input.cwd))
          return yield* invalid("startSession", "An absolute workspace directory is required.");
        const cwd = yield* fs
          .realPath(input.cwd)
          .pipe(
            Effect.mapError(() =>
              invalid("startSession", "The workspace directory is unavailable."),
            ),
          );
        const stat = yield* fs
          .stat(cwd)
          .pipe(
            Effect.mapError(() =>
              invalid("startSession", "The workspace directory is unavailable."),
            ),
          );
        if (stat.type !== "Directory")
          return yield* invalid("startSession", "The workspace must be a directory.");
        const decoded =
          input.resumeCursor === undefined
            ? Option.none<AntigravityCliResumeCursor>()
            : decodeCursor(input.resumeCursor);
        if (input.resumeCursor !== undefined && Option.isNone(decoded))
          return yield* invalid(
            "startSession",
            "The saved Antigravity CLI conversation is invalid.",
          );
        const cursor = Option.getOrUndefined(decoded);
        if (cursor && (cursor.cwd !== cwd || cursor.instanceId !== instanceId))
          return yield* invalid(
            "startSession",
            "The saved Antigravity CLI conversation belongs to another workspace or instance.",
          );
        if (sessions.has(input.threadId))
          return yield* invalid(
            "startSession",
            "Stop the existing Antigravity CLI session before replacing it.",
          );
        const now = yield* nowIso;
        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: input.threadId,
          cwd,
          runtimeMode: input.runtimeMode,
          status: "ready",
          mcpAttachment: mcpSession ? "leafOnly" : "notRequested",
          createdAt: now,
          updatedAt: now,
          ...(cursor ? { resumeCursor: cursor } : {}),
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
        };
        const context: SessionContext = {
          session,
          cwd,
          cursor,
          selection: input.modelSelection,
          active: undefined,
          stopping: false,
          stopped: yield* Deferred.make<void>(),
          turns: [],
        };
        sessions.set(input.threadId, context);
        yield* emit({
          ...(yield* base(context)),
          type: "session.started",
          payload: cursor ? { resume: cursor } : {},
        });
        return session;
      }),
    );

  const sendTurn: Adapter["sendTurn"] = Effect.fn("AntigravityCliAdapter.sendTurn")(
    function* (input) {
      const { context, turn } = yield* lock.withPermit(
        Effect.gen(function* () {
          const context = yield* requireSession(input.threadId);
          if (context.active)
            return yield* invalid(
              "sendTurn",
              "Antigravity CLI cannot steer an active turn. Wait or stop it first.",
            );
          if (!input.input?.trim())
            return yield* invalid("sendTurn", "Antigravity CLI requires a text prompt.");
          const prompt = input.input;
          if (input.attachments?.some((attachment) => attachment.type === "image"))
            return yield* invalid(
              "sendTurn",
              "Antigravity CLI supports text input only; remove image attachments.",
            );
          if (input.interactionMode === "plan")
            return yield* invalid("sendTurn", "Antigravity CLI does not support T3 plan mode.");
          const selection = input.modelSelection ?? context.selection;
          if (selection && selection.instanceId !== instanceId)
            return yield* invalid(
              "sendTurn",
              "The selected model belongs to another provider instance.",
            );
          if (selection?.options?.length)
            return yield* invalid(
              "sendTurn",
              "Choose a model variant from the Antigravity CLI catalog; separate effort overrides are not supported.",
            );
          const turn: ActiveTurn = {
            id: TurnId.make(NodeCrypto.randomUUID()),
            initialized: yield* Deferred.make<void, ProviderAdapterError>(),
            done: yield* Deferred.make<void>(),
            items: new Map(),
            completedItems: new Set(),
            stepUsage: new Map(),
            fiber: undefined,
            child: undefined,
            interrupted: false,
            streamedText: false,
            result: undefined,
          };
          context.active = turn;
          context.selection = selection;
          context.session = {
            ...context.session,
            status: "running",
            activeTurnId: turn.id,
            ...(selection ? { model: selection.model } : {}),
          };
          yield* emit({
            ...(yield* base(context, turn)),
            type: "turn.started",
            payload: selection ? { model: selection.model } : {},
          });
          turn.fiber = yield* Effect.uninterruptibleMask((restore) =>
            restore(
              Effect.all(
                [
                  runProcess(context, turn, prompt, selection).pipe(
                    Effect.scoped,
                    Effect.timeoutOrElse({
                      duration: "30 minutes",
                      orElse: () =>
                        Effect.fail(failed("Antigravity CLI exceeded its turn timeout.")),
                    }),
                  ),
                  Deferred.await(turn.initialized).pipe(
                    Effect.timeoutOrElse({
                      duration: "30 seconds",
                      orElse: () =>
                        Effect.fail(
                          failed("Antigravity CLI did not initialize within 30 seconds."),
                        ),
                    }),
                  ),
                ],
                { concurrency: "unbounded", discard: true },
              ),
            ).pipe(
              Effect.exit,
              Effect.flatMap((exit) => {
                if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
                  turn.interrupted = true;
                const failure = Exit.isFailure(exit)
                  ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
                  : undefined;
                return finish(
                  context,
                  turn,
                  Exit.isFailure(exit) && !turn.interrupted
                    ? failure instanceof Error
                      ? failure.message.slice(0, 4_000)
                      : "Antigravity CLI process failed."
                    : undefined,
                );
              }),
            ),
          ).pipe(Effect.forkIn(ownerScope, { startImmediately: true }));
          return { context, turn };
        }),
      );
      yield* Deferred.await(turn.initialized);
      return { threadId: input.threadId, turnId: turn.id, resumeCursor: context.cursor };
    },
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      supportsConversationRollback: false,
      promptlessTurnContinuation: false,
    },
    startSession,
    sendTurn,
    interruptTurn: (threadId, turnId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const turn = context.active;
        if (turn && (turnId === undefined || turnId === turn.id)) yield* cancel(context, turn);
      }),
    respondToRequest: () =>
      Effect.fail(
        invalid("respondToRequest", "Antigravity CLI has no interactive approval channel."),
      ),
    respondToUserInput: () =>
      Effect.fail(
        invalid("respondToUserInput", "Antigravity CLI has no structured input channel."),
      ),
    stopSession,
    stopAll,
    listSessions: () => Effect.sync(() => [...sessions.values()].map((context) => context.session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread: (threadId) =>
      requireSession(threadId).pipe(Effect.map((context) => ({ threadId, turns: context.turns }))),
    rollbackThread: () =>
      Effect.fail(
        invalid("rollbackThread", "Antigravity CLI cannot rewind native conversation history."),
      ),
    streamEvents: Stream.fromPubSub(events),
  } satisfies Adapter;
});
