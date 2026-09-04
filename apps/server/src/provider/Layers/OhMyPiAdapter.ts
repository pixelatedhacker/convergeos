import {
  ApprovalRequestId,
  EventId,
  OH_MY_PI_DEFAULT_MODEL,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  TurnId,
  isProviderSendTurnSupportedImageMimeType,
  type OhMyPiSettings,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type ThreadId,
  type TurnCompletedPayload,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { mapAcpToAdapterError, selectAcpPermissionOptionId } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeOhMyPiAcpRuntime, type OhMyPiAcpRuntimeInput } from "../acp/OhMyPiAcpSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("ohMyPi");
const ResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.NonEmptyString,
});
const decodeResumeCursor = Schema.decodeUnknownOption(ResumeCursor);
const isAcpError = Schema.is(EffectAcpErrors.AcpError);
const QUESTION_TEXT_LIMIT = 4_000;
const ELICITATION_FIELD_LIMIT = 32;
const ELICITATION_OPTION_LIMIT = 100;

type Adapter = ProviderAdapterShape<ProviderAdapterError>;
type Runtime = Pick<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  | "handleRequestPermission"
  | "handleElicitation"
  | "start"
  | "setMode"
  | "setModel"
  | "setConfigOption"
  | "getEvents"
  | "drainEvents"
  | "prompt"
  | "cancel"
>;
type NativePermission = EffectAcpSchema.RequestPermissionRequest;
type NativePermissionResponse = EffectAcpSchema.RequestPermissionResponse;
type NativeElicitation = EffectAcpSchema.ElicitationRequest;
type NativeElicitationResponse = EffectAcpSchema.ElicitationResponse;

export interface OhMyPiAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly onSessionStarted?: (
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    cwd: string,
  ) => Effect.Effect<void>;
  readonly onAvailableCommands?: (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
    cwd: string,
  ) => Effect.Effect<void>;
}

interface PendingApproval {
  readonly request: NativePermission;
  readonly response: Deferred.Deferred<{
    readonly decision: ProviderApprovalDecision;
    readonly result: NativePermissionResponse;
  }>;
}

interface ElicitationBinding {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly encode: (answers: ProviderUserInputAnswers) => NativeElicitationResponse | undefined;
}

interface PendingElicitation {
  readonly binding: ElicitationBinding;
  readonly response: Deferred.Deferred<{
    readonly answers: ProviderUserInputAnswers;
    readonly result: NativeElicitationResponse;
  }>;
}

interface TurnIntent {
  readonly turnId: TurnId;
  readonly generation: number;
  settled: boolean;
}

interface SessionContext {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly nativeSessionId: string;
  readonly scope: Scope.Closeable;
  readonly runtime: Runtime;
  readonly promptLock: Semaphore.Semaphore;
  readonly stopLock: Semaphore.Semaphore;
  readonly approvals: Map<ApprovalRequestId, PendingApproval>;
  readonly elicitations: Map<ApprovalRequestId, PendingElicitation>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  promptFiber: Fiber.Fiber<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError> | undefined;
  generation: number;
  stopped: boolean;
  closed: boolean;
  disconnected: boolean;
}

function boundedText(text: string, fallback: string): string {
  const trimmed = text.trim();
  if (!trimmed) return fallback;
  return trimmed.length <= QUESTION_TEXT_LIMIT
    ? trimmed
    : `${trimmed.slice(0, QUESTION_TEXT_LIMIT - 3)}...`;
}

function fieldChoices(
  field: EffectAcpSchema.ElicitationPropertySchema,
): ReadonlyArray<{ readonly value: string; readonly label: string; readonly description: string }> {
  if (field.type === "string") {
    if (field.oneOf) {
      return field.oneOf.map((option) => ({
        value: option.const,
        label: boundedText(option.title ?? option.const, option.const),
        description: boundedText(option.title ?? option.const, option.const),
      }));
    }
    return (field.enum ?? []).map((value) => ({
      value,
      label: boundedText(value, "Option"),
      description: boundedText(value, "Option"),
    }));
  }
  if (field.type === "array") {
    const choices =
      "anyOf" in field.items
        ? field.items.anyOf.map((option) => ({
            value: option.const,
            label: boundedText(option.title ?? option.const, option.const),
            description: boundedText(option.title ?? option.const, option.const),
          }))
        : field.items.enum.map((value) => ({
            value,
            label: boundedText(value, "Option"),
            description: boundedText(value, "Option"),
          }));
    return choices;
  }
  if (field.type === "boolean") {
    return [
      { value: "true", label: "Yes", description: "Yes" },
      { value: "false", label: "No", description: "No" },
    ];
  }
  return [];
}

function coerceFieldAnswer(
  field: EffectAcpSchema.ElicitationPropertySchema,
  answer: unknown,
): EffectAcpSchema.ElicitationContentValue | undefined {
  if (field.type === "string") {
    if (typeof answer !== "string") return undefined;
    if (
      field.minLength !== undefined &&
      field.minLength !== null &&
      answer.length < field.minLength
    )
      return undefined;
    if (
      field.maxLength !== undefined &&
      field.maxLength !== null &&
      answer.length > field.maxLength
    )
      return undefined;
    const allowed = field.oneOf?.map((option) => option.const) ?? field.enum ?? undefined;
    return allowed && !allowed.includes(answer) ? undefined : answer;
  }
  if (field.type === "boolean") {
    if (typeof answer === "boolean") return answer;
    if (answer === "true") return true;
    if (answer === "false") return false;
    return undefined;
  }
  if (field.type === "number" || field.type === "integer") {
    const value =
      typeof answer === "number" ? answer : typeof answer === "string" ? Number(answer) : NaN;
    if (!Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value)))
      return undefined;
    if (field.minimum !== undefined && field.minimum !== null && value < field.minimum)
      return undefined;
    if (field.maximum !== undefined && field.maximum !== null && value > field.maximum)
      return undefined;
    return value;
  }
  if (!Array.isArray(answer) || !answer.every((value) => typeof value === "string"))
    return undefined;
  const allowed =
    "anyOf" in field.items ? field.items.anyOf.map((option) => option.const) : field.items.enum;
  if (answer.some((value) => !allowed.includes(value))) return undefined;
  if (field.minItems !== undefined && field.minItems !== null && answer.length < field.minItems)
    return undefined;
  if (field.maxItems !== undefined && field.maxItems !== null && answer.length > field.maxItems)
    return undefined;
  return answer;
}

/** Converts the bounded ACP form subset used by OMP into T3's existing question model. */
export function describeOhMyPiElicitation(
  request: NativeElicitation,
): ElicitationBinding | undefined {
  if (request.mode !== "form") return undefined;
  const properties = request.requestedSchema.properties ?? {};
  const entries = Object.entries(properties);
  const required = new Set(request.requestedSchema.required ?? []);
  if (entries.length === 0 || entries.length > ELICITATION_FIELD_LIMIT) return undefined;
  const questions: UserInputQuestion[] = [];
  const visibleEntries: Array<readonly [string, EffectAcpSchema.ElicitationPropertySchema]> = [];

  for (const [key, field] of entries) {
    if (key.endsWith("__other") && properties[key.slice(0, -"__other".length)]) continue;
    const choices = fieldChoices(field);
    if (choices.length > ELICITATION_OPTION_LIMIT) return undefined;
    const otherKey = `${key}__other`;
    const hasOther = properties[otherKey]?.type === "string";
    const title = boundedText(field.title ?? key, "Question");
    questions.push({
      id: key,
      header: boundedText(request.requestedSchema.title ?? "Question", "Question"),
      question: boundedText(field.description ?? title ?? request.message, request.message),
      options: choices,
      multiSelect: field.type === "array",
      allowCustomAnswer:
        hasOther || field.type === "number" || field.type === "integer" || choices.length === 0,
    });
    visibleEntries.push([key, field]);
  }
  if (questions.length === 0) return undefined;

  return {
    questions,
    encode: (answers) => {
      const content: Record<string, EffectAcpSchema.ElicitationContentValue> = {};
      for (const [key, field] of visibleEntries) {
        const answer = answers[key];
        if (answer === undefined && !required.has(key)) continue;
        const value = coerceFieldAnswer(field, answer);
        if (value !== undefined) {
          content[key] = value;
          continue;
        }
        const otherKey = `${key}__other`;
        const otherField = properties[otherKey];
        const otherValue =
          otherField?.type === "string" ? coerceFieldAnswer(otherField, answer) : undefined;
        if (otherValue === undefined) return undefined;
        content[otherKey] = otherValue;
      }
      return { action: { action: "accept", content } };
    },
  };
}

export function ohMyPiApprovalOptions(
  request: NativePermission,
): ReadonlyArray<ProviderApprovalOption> {
  const has = (kind: EffectAcpSchema.PermissionOption["kind"]) =>
    request.options.some((option) => option.kind === kind && option.optionId.trim());
  return [
    ...(has("allow_once") ? [{ decision: "accept" as const, label: "Allow once" }] : []),
    ...(has("allow_always")
      ? [{ decision: "acceptForSession" as const, label: "Allow for this thread" }]
      : []),
    ...(has("reject_once") ? [{ decision: "decline" as const, label: "Deny" }] : []),
    { decision: "cancel", label: "Cancel" },
  ];
}

const buildOhMyPiPrompt = Effect.fn("OhMyPiAdapter.buildPrompt")(function* (input: {
  readonly text: string | undefined;
  readonly attachments: Parameters<Adapter["sendTurn"]>[0]["attachments"];
  readonly attachmentsDir: string;
}): Effect.fn.Return<
  ReadonlyArray<EffectAcpSchema.ContentBlock>,
  ProviderAdapterError,
  FileSystem.FileSystem
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const blocks: EffectAcpSchema.ContentBlock[] = [];
  const text = input.text?.trim();
  if (text) blocks.push({ type: "text", text });

  for (const attachment of input.attachments ?? []) {
    if (attachment.type !== "image") continue;
    if (!isProviderSendTurnSupportedImageMimeType(attachment.mimeType)) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: `Oh My Pi does not support image type '${attachment.mimeType}'.`,
      });
    }
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: `Invalid attachment '${attachment.name}'.`,
      });
    }
    const info = yield* fileSystem.stat(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/prompt",
            detail: `Could not read attachment '${attachment.name}'.`,
            cause,
          }),
      ),
    );
    if (info.type !== "File" || Number(info.size) > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: `Attachment '${attachment.name}' is too large. Images are limited to 10 MiB.`,
      });
    }
    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/prompt",
            detail: `Could not read attachment '${attachment.name}'.`,
            cause,
          }),
      ),
    );
    if (bytes.length > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: `Attachment '${attachment.name}' changed while being read and is too large.`,
      });
    }
    blocks.push({
      type: "image",
      data: Buffer.from(bytes).toString("base64"),
      mimeType: attachment.mimeType,
    });
  }
  if (blocks.length === 0) {
    return yield* new ProviderAdapterValidationError({
      provider: PROVIDER,
      operation: "sendTurn",
      issue: "Turn requires non-empty text or an image attachment.",
    });
  }
  return blocks;
});

/** Keeps one official OMP ACP process per thread. */
export function makeOhMyPiAdapter(settings: OhMyPiSettings, options?: OhMyPiAdapterOptions) {
  return Effect.gen(function* () {
    const instanceId = options?.instanceId ?? ProviderInstanceId.make("ohMyPi");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* ServerConfig;
    const crypto = yield* Crypto.Crypto;
    const ownerScope = yield* Effect.scope;
    const makeNativeLoggers = yield* makeAcpNativeLoggerFactory();
    const sessions = new Map<ThreadId, SessionContext>();
    const locks = yield* SynchronizedRef.make(new Map<ThreadId, Semaphore.Semaphore>());
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomId = crypto.randomUUIDv4.pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Could not create an Oh My Pi runtime identifier.",
            cause,
          }),
      ),
    );
    const stamp = Effect.all({ eventId: Effect.map(randomId, EventId.make), createdAt: nowIso });
    const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);

    const withThreadLock = <A, E, R>(threadId: ThreadId, task: Effect.Effect<A, E, R>) =>
      SynchronizedRef.modifyEffect(locks, (current) => {
        const existing = current.get(threadId);
        if (existing) return Effect.succeed([existing, current] as const);
        return Semaphore.make(1).pipe(
          Effect.map((lock) => [lock, new Map(current).set(threadId, lock)] as const),
        );
      }).pipe(Effect.flatMap((lock) => lock.withPermit(task)));

    const requireSession = (threadId: ThreadId) => {
      const context = sessions.get(threadId);
      return context && !context.stopped
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const cancelInteractions = Effect.fn("OhMyPiAdapter.cancelInteractions")(function* (
      context: SessionContext,
    ) {
      for (const pending of context.approvals.values()) {
        yield* Deferred.succeed(pending.response, {
          decision: "cancel",
          result: { outcome: { outcome: "cancelled" } },
        });
      }
      for (const pending of context.elicitations.values()) {
        yield* Deferred.succeed(pending.response, {
          answers: {},
          result: { action: { action: "cancel" } },
        });
      }
    });

    const stopContext = (context: SessionContext) =>
      context.stopLock
        .withPermit(
          Effect.gen(function* () {
            if (context.closed) return;
            context.stopped = true;
            yield* Effect.gen(function* () {
              yield* cancelInteractions(context);
              if (context.promptFiber && !context.disconnected)
                yield* Effect.ignore(context.runtime.cancel);
            }).pipe(Effect.ensuring(Scope.close(context.scope, Exit.void)));
            context.closed = true;
            if (sessions.get(context.threadId) === context) sessions.delete(context.threadId);
            yield* emit({
              type: "session.exited",
              ...(yield* stamp),
              provider: PROVIDER,
              threadId: context.threadId,
              payload: {
                exitKind: context.disconnected ? "error" : "graceful",
                ...(context.disconnected ? { reason: "Oh My Pi process stopped." } : {}),
              },
            });
          }),
        )
        .pipe(Effect.uninterruptible);

    const handlePermission = Effect.fn("OhMyPiAdapter.handlePermission")(function* (
      context: SessionContext,
      request: NativePermission,
    ): Effect.fn.Return<NativePermissionResponse, ProviderAdapterError> {
      if (context.stopped || request.sessionId !== context.nativeSessionId)
        return { outcome: { outcome: "cancelled" } };
      const requestId = ApprovalRequestId.make(yield* randomId);
      const runtimeRequestId = RuntimeRequestId.make(requestId);
      const response = yield* Deferred.make<{
        decision: ProviderApprovalDecision;
        result: NativePermissionResponse;
      }>();
      context.approvals.set(requestId, { request, response });
      const permissionRequest = parsePermissionRequest(request);
      return yield* Effect.gen(function* () {
        yield* emit(
          makeAcpRequestOpenedEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            requestId: runtimeRequestId,
            permissionRequest,
            approvalOptions: ohMyPiApprovalOptions(request),
            detail: permissionRequest.detail ?? "Oh My Pi requests permission.",
            args: permissionRequest.toolCall?.data ?? {},
            source: "acp.jsonrpc",
            method: "session/request_permission",
            rawPayload: permissionRequest,
          }),
        );
        const answer = yield* Deferred.await(response);
        yield* emit(
          makeAcpRequestResolvedEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            requestId: runtimeRequestId,
            permissionRequest,
            decision: answer.decision,
          }),
        );
        return answer.result;
      }).pipe(Effect.ensuring(Effect.sync(() => context.approvals.delete(requestId))));
    });

    const handleElicitation = Effect.fn("OhMyPiAdapter.handleElicitation")(function* (
      context: SessionContext,
      request: NativeElicitation,
    ): Effect.fn.Return<NativeElicitationResponse, ProviderAdapterError> {
      if (context.stopped || request.sessionId !== context.nativeSessionId)
        return { action: { action: "cancel" } };
      const binding = describeOhMyPiElicitation(request);
      if (!binding) {
        yield* Effect.logWarning("Declining unsupported Oh My Pi ACP elicitation.", {
          mode: request.mode,
          threadId: context.threadId,
        });
        return { action: { action: "decline" } };
      }
      const requestId = ApprovalRequestId.make(yield* randomId);
      const runtimeRequestId = RuntimeRequestId.make(requestId);
      const response = yield* Deferred.make<{
        answers: ProviderUserInputAnswers;
        result: NativeElicitationResponse;
      }>();
      context.elicitations.set(requestId, { binding, response });
      return yield* Effect.gen(function* () {
        yield* emit({
          type: "user-input.requested",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: context.threadId,
          turnId: context.activeTurnId,
          requestId: runtimeRequestId,
          payload: { questions: binding.questions },
          raw: {
            source: "acp.jsonrpc",
            method: "session/elicitation",
            payload: {
              mode: request.mode,
              message: boundedText(request.message, "Oh My Pi requests input."),
              fields: binding.questions.map((question) => question.id),
            },
          },
        });
        const answer = yield* Deferred.await(response);
        yield* emit({
          type: "user-input.resolved",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: context.threadId,
          turnId: context.activeTurnId,
          requestId: runtimeRequestId,
          payload: { answers: answer.answers },
        });
        return answer.result;
      }).pipe(Effect.ensuring(Effect.sync(() => context.elicitations.delete(requestId))));
    });

    const handleEvent = Effect.fn("OhMyPiAdapter.handleEvent")(function* (
      context: SessionContext,
      event: AcpSessionRuntime.AcpSessionRuntimeEvent,
    ) {
      if (event._tag === "EventStreamBarrier") {
        yield* Deferred.succeed(event.acknowledge, undefined);
        return;
      }
      if (context.stopped) return;
      switch (event._tag) {
        case "ModeChanged":
          return;
        case "AvailableCommandsUpdated":
          yield* (
            options?.onAvailableCommands?.(event.availableCommands, context.cwd) ?? Effect.void
          );
          return;
        case "ConnectionTerminated":
          context.disconnected = true;
          yield* stopContext(context).pipe(Effect.forkIn(ownerScope));
          return;
        case "AssistantItemStarted":
        case "AssistantItemCompleted":
          yield* emit(
            makeAcpAssistantItemEvent({
              stamp: yield* stamp,
              provider: PROVIDER,
              threadId: context.threadId,
              turnId: context.activeTurnId,
              itemId: event.itemId,
              lifecycle: event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
            }),
          );
          return;
        case "ThoughtDelta":
        case "ContentDelta":
          yield* emit(
            makeAcpContentDeltaEvent({
              stamp: yield* stamp,
              provider: PROVIDER,
              threadId: context.threadId,
              turnId: context.activeTurnId,
              ...(event._tag === "ContentDelta" && event.itemId ? { itemId: event.itemId } : {}),
              ...(event._tag === "ThoughtDelta" ? { streamKind: "reasoning_text" } : {}),
              text: event.text,
              rawPayload: event.rawPayload,
            }),
          );
          return;
        case "PlanUpdated":
          yield* emit(
            makeAcpPlanUpdatedEvent({
              stamp: yield* stamp,
              provider: PROVIDER,
              threadId: context.threadId,
              turnId: context.activeTurnId,
              payload: event.payload,
              source: "acp.jsonrpc",
              method: "session/update",
              rawPayload: event.rawPayload,
            }),
          );
          return;
        case "ToolCallUpdated":
          yield* emit(
            makeAcpToolCallEvent({
              stamp: yield* stamp,
              provider: PROVIDER,
              threadId: context.threadId,
              turnId: context.activeTurnId,
              toolCall: event.toolCall,
              rawPayload: event.rawPayload,
            }),
          );
          return;
      }
    });

    const applyConfiguration = Effect.fn("OhMyPiAdapter.applyConfiguration")(function* (input: {
      readonly context: SessionContext;
      readonly modelSelection: Parameters<Adapter["sendTurn"]>[0]["modelSelection"];
      readonly interactionMode: Parameters<Adapter["sendTurn"]>[0]["interactionMode"];
    }) {
      if (input.modelSelection && input.modelSelection.model !== OH_MY_PI_DEFAULT_MODEL) {
        yield* input.context.runtime.setModel(input.modelSelection.model);
      }
      if (input.modelSelection) {
        const thinking = getModelSelectionStringOptionValue(input.modelSelection, "thinking");
        if (thinking) yield* input.context.runtime.setConfigOption("thinking", thinking);
      }
      yield* input.context.runtime.setMode(input.interactionMode === "plan" ? "plan" : "default");
    });

    const startSession: Adapter["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (!settings.enabled) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "Enable Oh My Pi in provider settings before starting a thread.",
            });
          }
          if (
            (input.provider !== undefined && input.provider !== PROVIDER) ||
            (input.providerInstanceId !== undefined && input.providerInstanceId !== instanceId) ||
            (input.modelSelection !== undefined && input.modelSelection.instanceId !== instanceId)
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "The Oh My Pi provider instance does not match the requested session.",
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "The session requires a workspace directory.",
            });
          }
          const cursor = decodeResumeCursor(input.resumeCursor);
          if (input.resumeCursor !== undefined && Option.isNone(cursor)) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "The saved Oh My Pi session is invalid. Start a new thread.",
            });
          }
          const previous = sessions.get(input.threadId);
          if (previous) yield* stopContext(previous);
          const cwd = path.resolve(input.cwd);
          const sessionScope = yield* Scope.make("sequential");
          let transferred = false;
          let context: SessionContext | undefined;
          yield* Effect.addFinalizer(() => {
            if (transferred) return Effect.void;
            sessions.delete(input.threadId);
            return Scope.close(sessionScope, Exit.void);
          });

          return yield* Effect.gen(function* () {
            const mcp = McpProviderSession.readMcpProviderSession(input.threadId);
            const runtime = yield* makeOhMyPiAcpRuntime({
              childProcessSpawner,
              settings,
              ...(options?.environment ? { environment: options.environment } : {}),
              runtimeMode: input.runtimeMode,
              cwd,
              clientInfo: { name: "t3-code", version: "0.0.0" },
              additionalDirectories: [serverConfig.attachmentsDir],
              ...(Option.isSome(cursor) ? { resumeSessionId: cursor.value.sessionId } : {}),
              mcpServers: mcp
                ? [
                    {
                      type: "http",
                      name: "t3-code",
                      url: mcp.endpoint,
                      headers: [{ name: "Authorization", value: mcp.authorizationHeader }],
                    },
                  ]
                : [],
              ...makeNativeLoggers({
                nativeEventLogger: options?.nativeEventLogger,
                provider: PROVIDER,
                threadId: input.threadId,
              }),
            } satisfies OhMyPiAcpRuntimeInput).pipe(Effect.provideService(Crypto.Crypto, crypto));
            yield* runtime.handleRequestPermission((request) =>
              context
                ? handlePermission(context, request).pipe(
                    Effect.mapError((cause) =>
                      EffectAcpErrors.AcpRequestError.internalError(
                        "Could not process an Oh My Pi permission request.",
                        undefined,
                        { cause },
                      ),
                    ),
                  )
                : Effect.succeed({ outcome: { outcome: "cancelled" } }),
            );
            yield* runtime.handleElicitation((request) =>
              context
                ? handleElicitation(context, request).pipe(
                    Effect.mapError((cause) =>
                      EffectAcpErrors.AcpRequestError.internalError(
                        "Could not process an Oh My Pi elicitation.",
                        undefined,
                        { cause },
                      ),
                    ),
                  )
                : Effect.succeed({ action: { action: "cancel" } }),
            );
            const started = yield* runtime.start();
            const createdAt = yield* nowIso;
            const session: ProviderSession = {
              provider: PROVIDER,
              providerInstanceId: instanceId,
              threadId: input.threadId,
              cwd,
              status: "ready",
              runtimeMode: input.runtimeMode,
              ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
              resumeCursor: { schemaVersion: 1, sessionId: started.sessionId },
              createdAt,
              updatedAt: createdAt,
            };
            context = {
              threadId: input.threadId,
              cwd,
              nativeSessionId: started.sessionId,
              scope: sessionScope,
              runtime,
              promptLock: yield* Semaphore.make(1),
              stopLock: yield* Semaphore.make(1),
              approvals: new Map(),
              elicitations: new Map(),
              turns: [],
              session,
              activeTurnId: undefined,
              promptFiber: undefined,
              generation: 0,
              stopped: false,
              closed: false,
              disconnected: false,
            };
            const running = context;
            if (input.modelSelection) {
              yield* applyConfiguration({
                context: running,
                modelSelection: input.modelSelection,
                interactionMode: "default",
              });
            }
            yield* options?.onSessionStarted?.(started, cwd) ?? Effect.void;
            sessions.set(input.threadId, running);
            yield* Stream.runForEach(runtime.getEvents(), (event) =>
              handleEvent(running, event),
            ).pipe(
              Effect.catchCause(() =>
                Effect.logError("Could not process an Oh My Pi runtime event."),
              ),
              Effect.forkIn(sessionScope),
            );
            yield* emit({
              type: "session.started",
              ...(yield* stamp),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { resume: started.initializeResult },
            });
            yield* emit({
              type: "session.state.changed",
              ...(yield* stamp),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { state: "ready", reason: "Oh My Pi ACP session ready" },
            });
            yield* emit({
              type: "thread.started",
              ...(yield* stamp),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { providerThreadId: started.sessionId },
            });
            yield* runtime.drainEvents;
            if (running.stopped) {
              return yield* new ProviderAdapterSessionClosedError({
                provider: PROVIDER,
                threadId: input.threadId,
              });
            }
            transferred = true;
            return session;
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError((cause) =>
              isAcpError(cause)
                ? mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause)
                : cause,
            ),
          );
        }).pipe(Effect.scoped),
      );

    const sendTurn: Adapter["sendTurn"] = Effect.fn("OhMyPiAdapter.sendTurn")(function* (input) {
      const context = yield* requireSession(input.threadId);
      if (input.modelSelection && input.modelSelection.instanceId !== instanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "The selected model belongs to another provider instance.",
        });
      }
      const prompt = yield* buildOhMyPiPrompt({
        text: input.input,
        attachments: input.attachments,
        attachmentsDir: serverConfig.attachmentsDir,
      }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
      let intent: TurnIntent | undefined;
      const finishTurn = (turn: TurnIntent, payload: TurnCompletedPayload) =>
        Effect.gen(function* () {
          if (turn.settled || context.stopped || context.generation !== turn.generation) return;
          turn.settled = true;
          context.activeTurnId = undefined;
          context.promptFiber = undefined;
          context.session = {
            ...context.session,
            status: payload.state === "failed" ? "error" : "ready",
            activeTurnId: undefined,
            updatedAt: yield* nowIso,
            ...(payload.errorMessage
              ? { lastError: payload.errorMessage }
              : { lastError: undefined }),
          };
          yield* emit({
            type: "turn.completed",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId: turn.turnId,
            payload,
          });
        }).pipe(Effect.uninterruptible);

      return yield* Effect.gen(function* () {
        const launch = yield* context.promptLock.withPermit(
          Effect.gen(function* () {
            yield* requireSession(input.threadId);
            const turnId = context.activeTurnId ?? TurnId.make(yield* randomId);
            const steering = context.activeTurnId !== undefined;
            const turn: TurnIntent = { turnId, generation: ++context.generation, settled: false };
            intent = turn;
            context.activeTurnId = turnId;
            if (!steering) {
              yield* emit({
                type: "turn.started",
                ...(yield* stamp),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: input.modelSelection ? { model: input.modelSelection.model } : {},
              });
            }
            if (context.promptFiber) {
              yield* cancelInteractions(context);
              yield* context.runtime.cancel;
              yield* Fiber.await(context.promptFiber);
            }
            yield* applyConfiguration({
              context,
              modelSelection: input.modelSelection,
              interactionMode: input.interactionMode,
            });
            const model = input.modelSelection?.model ?? context.session.model;
            context.session = {
              ...context.session,
              status: "running",
              activeTurnId: turnId,
              ...(model ? { model } : {}),
              updatedAt: yield* nowIso,
            };
            const dispatched = yield* Deferred.make<void>();
            const fiber = yield* context.runtime
              .prompt({ prompt }, { dispatched })
              .pipe(Effect.forkIn(context.scope));
            context.promptFiber = fiber;
            yield* Effect.raceFirst(
              Deferred.await(dispatched),
              Fiber.await(fiber).pipe(
                Effect.flatMap((exit) => exit),
                Effect.asVoid,
              ),
            );
            return { turn, fiber };
          }),
        );
        const result = yield* Fiber.await(launch.fiber).pipe(Effect.flatMap((exit) => exit));
        yield* context.runtime.drainEvents;
        if (context.stopped) {
          return yield* new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        const record = context.turns.find((turn) => turn.id === launch.turn.turnId);
        if (record) record.items.push(result);
        else context.turns.push({ id: launch.turn.turnId, items: [result] });
        yield* context.promptLock.withPermit(
          finishTurn(launch.turn, {
            state: result.stopReason === "cancelled" ? "cancelled" : "completed",
            stopReason: result.stopReason,
          }),
        );
        return {
          threadId: input.threadId,
          turnId: launch.turn.turnId,
          resumeCursor: context.session.resumeCursor,
        };
      }).pipe(
        Effect.mapError((cause) =>
          isAcpError(cause)
            ? mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", cause)
            : cause,
        ),
        Effect.tapError((cause) =>
          Effect.suspend(() =>
            intent
              ? context.promptLock.withPermit(
                  finishTurn(intent, { state: "failed", errorMessage: cause.message }),
                )
              : Effect.void,
          ),
        ),
        Effect.onInterrupt(() =>
          context.promptLock.withPermit(
            Effect.gen(function* () {
              const turn = intent;
              if (
                !turn ||
                turn.settled ||
                context.stopped ||
                context.generation !== turn.generation
              )
                return;
              const promptFiber = context.promptFiber;
              yield* cancelInteractions(context);
              yield* Effect.ignore(context.runtime.cancel);
              if (promptFiber) yield* Fiber.interrupt(promptFiber);
              yield* finishTurn(turn, { state: "cancelled", stopReason: "cancelled" });
            }),
          ),
        ),
      );
    });

    const interruptTurn: Adapter["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* context.promptLock.withPermit(
          Effect.gen(function* () {
            yield* cancelInteractions(context);
            yield* context.runtime.cancel;
          }),
        );
      }).pipe(
        Effect.mapError((cause) =>
          isAcpError(cause)
            ? mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", cause)
            : cause,
        ),
      );

    const respondToRequest: Adapter["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.approvals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: "This approval request is no longer pending.",
          });
        }
        const optionId = selectAcpPermissionOptionId(pending.request, decision);
        if (decision !== "cancel" && optionId === undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToRequest",
            issue: "Oh My Pi did not offer this permission choice.",
          });
        }
        yield* Deferred.succeed(pending.response, {
          decision,
          result: {
            outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" },
          },
        });
      });

    const respondToUserInput: Adapter["respondToUserInput"] = (threadId, requestId, answers) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.elicitations.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/elicitation",
            detail: "This question is no longer pending.",
          });
        }
        const result = pending.binding.encode(answers);
        if (!result) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToUserInput",
            issue: "The response does not match Oh My Pi's requested form.",
          });
        }
        yield* Deferred.succeed(pending.response, { answers, result });
      });

    const stopSession: Adapter["stopSession"] = (threadId) =>
      withThreadLock(threadId, Effect.flatMap(requireSession(threadId), stopContext));
    const stopAll: Adapter["stopAll"] = () =>
      Effect.forEach([...sessions.values()], stopContext, { discard: true });
    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.void
            : Effect.logError("Could not stop Oh My Pi sessions."),
        ),
        Effect.ensuring(PubSub.shutdown(events)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      stopAll,
      listSessions: () =>
        Effect.sync(() =>
          [...sessions.values()]
            .filter((context) => !context.stopped)
            .map((context) => ({ ...context.session })),
        ),
      hasSession: (threadId) =>
        Effect.sync(() => sessions.has(threadId) && !sessions.get(threadId)?.stopped),
      readThread: (threadId) =>
        Effect.map(requireSession(threadId), (context) => ({ threadId, turns: context.turns })),
      rollbackThread: (_threadId: ThreadId, _numTurns: number) =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "Oh My Pi does not support conversation rewind. Start a new thread instead.",
          }),
        ),
      streamEvents: Stream.fromPubSub(events),
    } satisfies Adapter;
  });
}
