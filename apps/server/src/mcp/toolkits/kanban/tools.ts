import {
  KanbanBoardSnapshot,
  KanbanMcpError,
  KanbanMcpReadInput,
  KanbanMcpWriteInput,
  KanbanMcpWriteResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngineService,
  ProjectionSnapshotQuery,
];

export const KanbanReadTool = Tool.make("kanban_read", {
  description:
    "Read the active Kanban cards for this agent's project, including status, order, revision, and bot assignment.",
  parameters: KanbanMcpReadInput,
  success: KanbanBoardSnapshot,
  failure: KanbanMcpError,
  dependencies,
})
  .annotate(Tool.Title, "Read project Kanban")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const KanbanWriteTool = Tool.make("kanban_write", {
  description:
    "Create, update, move, or delete one card in this agent's project. Reuse requestId when retrying and pass the last observed revision for mutations.",
  parameters: KanbanMcpWriteInput,
  success: KanbanMcpWriteResult,
  failure: KanbanMcpError,
  dependencies,
})
  .annotate(Tool.Title, "Update project Kanban")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const KanbanToolkit = Toolkit.make(KanbanReadTool, KanbanWriteTool);
