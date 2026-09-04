import type { SubscriptionQuotaCollector } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import {
  decodeCodexBarDashboardString,
  normalizeCodexBarDashboardSnapshot,
  type NormalizedCodexBarSnapshot,
} from "./CodexBarSnapshot.ts";

const CODEXBAR_TIMEOUT = "30 seconds";
const CODEXBAR_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export type CodexBarCollectionResult =
  | {
      readonly _tag: "Success";
      readonly snapshot: NormalizedCodexBarSnapshot;
      readonly collector: SubscriptionQuotaCollector;
    }
  | {
      readonly _tag: "Failure";
      readonly collector: SubscriptionQuotaCollector;
    };

export class CodexBarCollector extends Context.Service<
  CodexBarCollector,
  { readonly collect: Effect.Effect<CodexBarCollectionResult> }
>()("t3/subscriptionQuota/CodexBarCollector") {}

const failure = (
  status: "missing" | "failed",
  attemptedAt: string,
  message: string,
): CodexBarCollectionResult => ({
  _tag: "Failure",
  collector: { collectorId: "codexbar", status, attemptedAt, message },
});

export const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const collect = Effect.gen(function* () {
    const attemptedAt = DateTime.formatIso(yield* DateTime.now);
    const output = yield* processRunner
      .run({
        command: "codexbar",
        args: ["dashboard", "--identity", "redacted"],
        timeout: CODEXBAR_TIMEOUT,
        maxOutputBytes: CODEXBAR_MAX_OUTPUT_BYTES,
      })
      .pipe(
        Effect.match({
          onFailure: (error) =>
            failure(
              error._tag === "ProcessSpawnError" ? "missing" : "failed",
              attemptedAt,
              error._tag === "ProcessSpawnError"
                ? "CodexBar is not installed or could not be started."
                : "CodexBar quota collection failed.",
            ),
          onSuccess: (value) => value,
        }),
      );

    if ("_tag" in output) return output;
    if (output.code !== 0 || output.stdoutInvalidUtf8 || output.stdoutTruncated) {
      return failure("failed", attemptedAt, "CodexBar returned an unusable quota snapshot.");
    }

    const decoded = yield* decodeCodexBarDashboardString(output.stdout).pipe(Effect.option);
    if (decoded._tag === "None") {
      return failure(
        "failed",
        attemptedAt,
        "CodexBar returned invalid JSON or an unsupported dashboard schema.",
      );
    }

    const snapshot = normalizeCodexBarDashboardSnapshot(decoded.value);
    return {
      _tag: "Success",
      snapshot,
      collector: { collectorId: "codexbar", status: "ok", attemptedAt, message: null },
    } satisfies CodexBarCollectionResult;
  });

  return CodexBarCollector.of({ collect });
});

export const layer = Layer.effect(CodexBarCollector, make);
