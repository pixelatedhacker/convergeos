import * as Schema from "effect/Schema";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NativeId = Schema.NonEmptyString.check(Schema.isMaxLength(512));

export const AntigravityCliUsage = Schema.Struct({
  input_tokens: Count,
  output_tokens: Count,
  thinking_tokens: Schema.optional(Count),
  cache_read_tokens: Schema.optional(Count),
  total_tokens: Count,
});
export type AntigravityCliUsage = typeof AntigravityCliUsage.Type;

export const AntigravityCliResumeCursor = Schema.Struct({
  driver: Schema.Literal("antigravityCli"),
  schemaVersion: Schema.Literal(1),
  conversationId: NativeId,
  cwd: Schema.NonEmptyString,
  instanceId: Schema.NonEmptyString,
});
export type AntigravityCliResumeCursor = typeof AntigravityCliResumeCursor.Type;

const Init = Schema.Struct({
  event: Schema.Literal("init"),
  conversation_id: NativeId,
  init: Schema.Struct({
    cwd: Schema.NonEmptyString,
    permission_mode: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
  }),
});
const Step = Schema.Struct({
  event: Schema.Literal("step_update"),
  step_update: Schema.Struct({
    conversation_id: NativeId,
    step_index: Count,
    state: Schema.Literals(["ACTIVE", "DONE"]),
    step_type: Schema.NonEmptyString,
    text_delta: Schema.optional(Schema.String),
    tool_name: Schema.optional(Schema.String),
    tool_info: Schema.optional(
      Schema.Struct({
        name: Schema.optional(Schema.String),
        parameters: Schema.optional(Schema.Unknown),
        output: Schema.optional(Schema.Unknown),
        error: Schema.optional(Schema.Unknown),
      }),
    ),
    subagent_info: Schema.optional(Schema.Unknown),
    usage: Schema.optional(AntigravityCliUsage),
  }),
});
const Result = Schema.Struct({
  event: Schema.Literal("result"),
  result: Schema.Struct({
    // Early authentication/model failures can have no native conversation.
    conversation_id: Schema.String.check(Schema.isMaxLength(512)),
    status: Schema.Literals([
      "SUCCESS",
      "ERROR",
      "CANCELED",
      "INTERRUPTED",
      "INVALID",
      "WAITING",
      "RUNNING",
    ]),
    response: Schema.String,
    error: Schema.optional(Schema.String),
    usage: Schema.optional(AntigravityCliUsage),
  }),
});

export const AntigravityCliEvent = Schema.Union([Init, Step, Result]);
export type AntigravityCliEvent = typeof AntigravityCliEvent.Type;
export const decodeAntigravityCliEvent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AntigravityCliEvent),
);

/** Sum only completed steps from this turn; result counters include previous turns. */
export function antigravityCliTurnUsage(steps: ReadonlyArray<AntigravityCliUsage>) {
  return {
    inputTokens: steps.reduce((sum, step) => sum + step.input_tokens, 0),
    outputTokens: steps.reduce((sum, step) => sum + step.output_tokens, 0),
    totalTokens: steps.reduce((sum, step) => sum + step.total_tokens, 0),
    reasoningOutputTokens: steps.reduce((sum, step) => sum + (step.thinking_tokens ?? 0), 0),
    cachedInputTokens: steps.reduce((sum, step) => sum + (step.cache_read_tokens ?? 0), 0),
  };
}
