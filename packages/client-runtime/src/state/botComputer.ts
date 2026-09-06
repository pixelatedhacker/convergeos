import { type EnvironmentId, type ThreadId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export function createBotComputerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const inspect = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:bot-computer:inspect",
    tag: WS_METHODS.botComputerInspect,
    staleTimeMs: 2_000,
    idleTtlMs: 0,
  });
  const lifecycleConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };
  const refreshAfterMutation = (
    target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly threadId: ThreadId };
    },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() =>
      registry.refresh(
        inspect({
          environmentId: target.environmentId,
          input: { threadId: target.input.threadId },
        }),
      ),
    );

  const lifecycleCommand = <
    TTag extends
      | typeof WS_METHODS.botComputerStart
      | typeof WS_METHODS.botComputerSuspend
      | typeof WS_METHODS.botComputerResume
      | typeof WS_METHODS.botComputerReset
      | typeof WS_METHODS.botComputerDestroy,
  >(
    tag: TTag,
    label: string,
  ) =>
    createEnvironmentRpcCommand(runtime, {
      label,
      tag,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
      onSuccess: refreshAfterMutation,
    });

  return {
    inspect,
    start: lifecycleCommand(WS_METHODS.botComputerStart, "environment-data:bot-computer:start"),
    suspend: lifecycleCommand(
      WS_METHODS.botComputerSuspend,
      "environment-data:bot-computer:suspend",
    ),
    resume: lifecycleCommand(WS_METHODS.botComputerResume, "environment-data:bot-computer:resume"),
    reset: lifecycleCommand(WS_METHODS.botComputerReset, "environment-data:bot-computer:reset"),
    destroy: lifecycleCommand(
      WS_METHODS.botComputerDestroy,
      "environment-data:bot-computer:destroy",
    ),
  };
}
