import { AgentLivenessInput, AgentLivenessResult, AgentMeshError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { AgentLiveness } from "../../../mesh/AgentLiveness.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const AgentsLivenessTool = Tool.make("agents_liveness", {
  description:
    "Read verified, expiring host observations for one to eight delegations owned by this caller. Uses the configured private relay and enrolled local environment signer. Running means the host observed the matching provider runtime turn; separate providerActivityAt may be unknown. Stale or missing observations mean unknown liveness, never failure. Relay acknowledgement is not delivery. This does not dispatch remote work or wake agents.",
  parameters: AgentLivenessInput,
  success: AgentLivenessResult,
  failure: AgentMeshError,
  dependencies: [McpInvocationContext.McpInvocationContext, AgentLiveness],
})
  .annotate(Tool.Title, "Read delegated agent liveness")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
export const LivenessToolkit = Toolkit.make(AgentsLivenessTool);
export const LivenessToolkitHandlersLive = LivenessToolkit.toLayer({
  agents_liveness: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.requireAgentCapability("agents.read", "read");
      return yield* (yield* AgentLiveness).read(invocation.threadId, input);
    }),
});
