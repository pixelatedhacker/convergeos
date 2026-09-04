import { type OhMyPiSettings, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type OhMyPiAcpRuntimeSettings = Pick<OhMyPiSettings, "binaryPath">;

export type OhMyPiApprovalMode = "always-ask" | "write" | "yolo";

export interface OhMyPiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "resumeMethod" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly settings: OhMyPiAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode: RuntimeMode;
}

export function ohMyPiApprovalMode(runtimeMode: RuntimeMode): OhMyPiApprovalMode {
  switch (runtimeMode) {
    case "approval-required":
    case "auto":
      return "always-ask";
    case "auto-accept-edits":
      return "write";
    case "full-access":
      return "yolo";
  }
}

export function ohMyPiAcpSpawnArgs(runtimeMode: RuntimeMode): ReadonlyArray<string> {
  return ["acp", "--approval-mode", ohMyPiApprovalMode(runtimeMode)];
}

export function buildOhMyPiAcpSpawnInput(
  settings: OhMyPiAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment: NodeJS.ProcessEnv | undefined,
  runtimeMode: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings?.binaryPath || "omp",
    args: ohMyPiAcpSpawnArgs(runtimeMode),
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeOhMyPiAcpRuntime = (
  input: OhMyPiAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildOhMyPiAcpSpawnInput(
          input.settings,
          input.cwd,
          input.environment,
          input.runtimeMode,
        ),
        authMethodId: "agent",
        resumeMethod: "resume",
        clientCapabilities: input.clientCapabilities ?? { elicitation: { form: {} } },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  });
