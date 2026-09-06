import {
  AgentMeshModelsInput,
  AgentMeshModelsResult,
  AgentMeshDelegationDispatchReceipt,
  AgentMeshDispatchReceipt,
  AgentMeshError,
  AgentMeshInterruptInput,
  AgentMeshListInput,
  AgentMeshListResult,
  AgentMeshReadInput,
  AgentMeshReadResult,
  AgentMeshSendInput,
  AgentMeshSpawnInput,
  AgentMeshWaitInput,
  AgentMeshWaitResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as AgentMesh from "../../AgentMesh.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, AgentMesh.AgentMesh];

export const AgentsModelsTool = Tool.make("agents_models", {
  description:
    "Discover configured provider model IDs, option descriptors, runtime modes, and cached readiness for delegation. Filter by instanceId or query and follow nextOffset for more results. Catalog entries are not proof of successful model execution. Use returned instanceId and model.slug in modelSelection; options are an array of {id,value} using model.capabilities.optionDescriptors.",
  parameters: AgentMeshModelsInput,
  success: AgentMeshModelsResult,
  failure: AgentMeshError,
  dependencies,
})
  .annotate(Tool.Title, "Discover delegation models")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const AgentsListTool = Tool.make("agents_list", {
  description:
    "List durable agent threads in this agent's project. Returns configured model selection and bounded status metadata, with the current thread first.",
  parameters: AgentMeshListInput,
  success: AgentMeshListResult,
  failure: AgentMeshError,
  dependencies,
})
  .annotate(Tool.Title, "List project agents")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const AgentsSendTool = Tool.make("agents_send", {
  description:
    "Send a delegated request to an idle agent in this project with an isolated workspace. Reuse requestId when retrying the same request.",
  parameters: AgentMeshSendInput,
  success: AgentMeshDelegationDispatchReceipt,
  failure: AgentMeshError,
  dependencies,
})
  .annotate(Tool.Title, "Send task to project agent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const AgentsSpawnTool = Tool.make("agents_spawn", {
  description:
    "Create an isolated worker thread in this Git project and assign one durable delegation. The worker inherits the caller's model unless modelSelection is supplied. Reuse requestId when retrying the same request.",
  parameters: AgentMeshSpawnInput,
  success: AgentMeshDelegationDispatchReceipt,
  failure: AgentMeshError,
  dependencies,
})
  .annotate(Tool.Title, "Spawn isolated project agent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const AgentsWaitTool = Tool.make("agents_wait", {
  description:
    "Wait for one to eight delegations to complete, fail, be interrupted, or need user attention. Returns bounded latest assistant output and a state cursor; timeoutMs is capped at 50000.",
  parameters: AgentMeshWaitInput,
  success: AgentMeshWaitResult,
  failure: AgentMeshError,
  dependencies,
})
  .annotate(Tool.Title, "Wait for delegated work")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const AgentsInterruptTool = Tool.make("agents_interrupt", {
  description:
    "Interrupt the exact observed turn of another project agent. Reuse requestId when retrying the same interrupt.",
  parameters: AgentMeshInterruptInput,
  success: AgentMeshDispatchReceipt,
  failure: AgentMeshError,
  dependencies,
})
  .annotate(Tool.Title, "Interrupt project agent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const AgentsReadTool = Tool.make("agents_read", {
  description:
    "Read bounded status and the latest assistant output from an agent in this project. Long output is truncated from the beginning.",
  parameters: AgentMeshReadInput,
  success: AgentMeshReadResult,
  failure: AgentMeshError,
  dependencies,
})
  .annotate(Tool.Title, "Read project agent output")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const AgentsToolkit = Toolkit.make(
  AgentsModelsTool,
  AgentsListTool,
  AgentsReadTool,
  AgentsSpawnTool,
  AgentsSendTool,
  AgentsWaitTool,
  AgentsInterruptTool,
);
