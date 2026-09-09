import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const BOT_COMPUTER_ISOLATION_WARNING =
  "This computer uses container isolation. It is not containment for hostile code." as const;

export const BotComputerCapability = Schema.Struct({
  viewerAccess: Schema.Literals(["host-local", "authenticated-remote"]),
  isolation: Schema.Literal("container"),
  networkAccessModes: Schema.Tuple([Schema.Literal("outbound")]),
  warning: Schema.Literal(BOT_COMPUTER_ISOLATION_WARNING),
});
export type BotComputerCapability = typeof BotComputerCapability.Type;

const BotComputerStateBase = {
  threadId: ThreadId,
  isolation: Schema.Literal("container"),
  warning: Schema.Literal(BOT_COMPUTER_ISOLATION_WARNING),
};

export const BotComputerNetworkAccess = Schema.Literal("outbound");
export type BotComputerNetworkAccess = typeof BotComputerNetworkAccess.Type;

export const BotComputerRunningState = Schema.Struct({
  ...BotComputerStateBase,
  viewerAccess: Schema.Literal("authenticated-remote"),
  status: Schema.Literal("running"),
  containerId: TrimmedNonEmptyString,
  networkAccess: BotComputerNetworkAccess,
});
export type BotComputerRunningState = typeof BotComputerRunningState.Type;

const LegacyBotComputerRunningState = Schema.Struct({
  ...BotComputerStateBase,
  viewerAccess: Schema.Literal("host-local"),
  status: Schema.Literal("running"),
  containerId: TrimmedNonEmptyString,
  viewerPort: NonNegativeInt.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThan(65_536)),
  viewerUrl: TrimmedNonEmptyString,
  networkAccess: BotComputerNetworkAccess,
});

export const BotComputerState = Schema.Union([
  Schema.Struct({
    ...BotComputerStateBase,
    viewerAccess: Schema.Literals(["host-local", "authenticated-remote"]),
    status: Schema.Literal("unavailable"),
    reason: Schema.Literals(["unsupported-platform", "docker-unavailable"]),
    detail: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...BotComputerStateBase,
    viewerAccess: Schema.Literals(["host-local", "authenticated-remote"]),
    status: Schema.Literal("absent"),
  }),
  Schema.Struct({
    ...BotComputerStateBase,
    viewerAccess: Schema.Literals(["host-local", "authenticated-remote"]),
    status: Schema.Literal("suspended"),
    containerId: TrimmedNonEmptyString,
    networkAccess: BotComputerNetworkAccess,
  }),
  BotComputerRunningState,
  LegacyBotComputerRunningState,
  Schema.Struct({
    ...BotComputerStateBase,
    viewerAccess: Schema.Literals(["host-local", "authenticated-remote"]),
    status: Schema.Literal("failed"),
    operation: Schema.Literals(["inspect", "start", "suspend", "resume", "reset", "destroy"]),
    detail: TrimmedNonEmptyString,
    containerId: Schema.optional(TrimmedNonEmptyString),
  }),
]);
export type BotComputerState = typeof BotComputerState.Type;

export const BotComputerInput = Schema.Struct({ threadId: ThreadId });
export type BotComputerInput = typeof BotComputerInput.Type;

export const BotComputerStartInput = Schema.Struct({
  threadId: ThreadId,
  networkAccess: BotComputerNetworkAccess,
});
export type BotComputerStartInput = typeof BotComputerStartInput.Type;

export const BotComputerViewerAccess = Schema.Struct({
  viewerPath: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtcFromString,
});
export type BotComputerViewerAccess = typeof BotComputerViewerAccess.Type;

const ComputerCoordinate = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(16_384),
);

export const BotComputerClickInput = Schema.Struct({
  x: ComputerCoordinate,
  y: ComputerCoordinate,
  button: Schema.Literals(["left", "middle", "right"]),
});
export type BotComputerClickInput = typeof BotComputerClickInput.Type;

export const BotComputerTypeInput = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000)),
});
export type BotComputerTypeInput = typeof BotComputerTypeInput.Type;

export const BotComputerPressInput = Schema.Struct({
  key: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
    Schema.isPattern(/^[A-Za-z0-9_+]+$/),
  ),
});
export type BotComputerPressInput = typeof BotComputerPressInput.Type;

export const BotComputerScrollInput = Schema.Struct({
  direction: Schema.Literals(["up", "down", "left", "right"]),
  amount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(20)),
});
export type BotComputerScrollInput = typeof BotComputerScrollInput.Type;

export const BotComputerActionResult = Schema.Record(Schema.String, Schema.Never);
export type BotComputerActionResult = typeof BotComputerActionResult.Type;

export const BotComputerSnapshot = Schema.Struct({
  mimeType: Schema.Literal("image/png"),
  data: Schema.String,
  width: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  height: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type BotComputerSnapshot = typeof BotComputerSnapshot.Type;

export class BotComputerAuthorizationError extends Schema.TaggedError<BotComputerAuthorizationError>()(
  "BotComputerAuthorizationError",
  {
    threadId: ThreadId,
    reason: Schema.Literals([
      "thread-unavailable",
      "not-bot",
      "project-unavailable",
      "worktree-unavailable",
      "worktree-not-isolated",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "thread-unavailable":
        return "The Bot thread is unavailable on this environment.";
      case "not-bot":
        return "The requested thread is not an active Bot.";
      case "project-unavailable":
        return "The Bot project is unavailable on this environment.";
      case "worktree-unavailable":
        return "The Bot does not have an isolated worktree.";
      case "worktree-not-isolated":
        return "The Bot worktree is the project's shared checkout.";
    }
  }
}

export class BotComputerOperationError extends Schema.TaggedError<BotComputerOperationError>()(
  "BotComputerOperationError",
  {
    threadId: ThreadId,
    operation: Schema.Literals(["inspect", "start", "suspend", "resume", "reset", "destroy"]),
    message: TrimmedNonEmptyString,
  },
) {}

export class BotComputerControlError extends Schema.TaggedError<BotComputerControlError>()(
  "BotComputerControlError",
  {
    threadId: ThreadId,
    operation: Schema.Literals(["status", "snapshot", "click", "type", "press", "scroll"]),
    reason: Schema.Literals(["not-running", "execution-failed", "invalid-screenshot"]),
    detail: TrimmedNonEmptyString,
  },
) {}

export const BotComputerError = Schema.Union([
  BotComputerAuthorizationError,
  BotComputerOperationError,
  BotComputerControlError,
]);
export type BotComputerError = typeof BotComputerError.Type;
