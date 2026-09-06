import {
  BotComputerActionResult,
  BotComputerClickInput,
  BotComputerError,
  BotComputerPressInput,
  BotComputerRunningState,
  BotComputerScrollInput,
  BotComputerSnapshot,
  BotComputerTypeInput,
  PreviewAutomationUnavailableError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as BotComputer from "../../../botComputer/BotComputerService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, BotComputer.BotComputerService];
const EmptyInput = Schema.Struct({});
const ComputerToolError = Schema.Union([BotComputerError, PreviewAutomationUnavailableError]);

export const ComputerStatusTool = Tool.make("computer_status", {
  description: "Get the running state and host-local viewer metadata for this Bot's own computer.",
  parameters: EmptyInput,
  success: BotComputerRunningState,
  failure: ComputerToolError,
  dependencies,
})
  .annotate(Tool.Title, "Get Bot computer status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ComputerSnapshotTool = Tool.make("computer_snapshot", {
  description: "Capture a PNG screenshot of this Bot's own running computer.",
  parameters: EmptyInput,
  success: BotComputerSnapshot,
  failure: ComputerToolError,
  dependencies,
})
  .annotate(Tool.Title, "Capture Bot computer")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ComputerClickTool = Tool.make("computer_click", {
  description: "Move the pointer and click coordinates on this Bot's own running computer.",
  parameters: BotComputerClickInput,
  success: BotComputerActionResult,
  failure: ComputerToolError,
  dependencies,
})
  .annotate(Tool.Title, "Click Bot computer")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerTypeTool = Tool.make("computer_type", {
  description: "Type literal text into the focused control on this Bot's own running computer.",
  parameters: BotComputerTypeInput,
  success: BotComputerActionResult,
  failure: ComputerToolError,
  dependencies,
})
  .annotate(Tool.Title, "Type on Bot computer")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerPressTool = Tool.make("computer_press", {
  description:
    "Press one validated X11 key or key chord on this Bot's own running computer, such as Enter or ctrl+l.",
  parameters: BotComputerPressInput,
  success: BotComputerActionResult,
  failure: ComputerToolError,
  dependencies,
})
  .annotate(Tool.Title, "Press key on Bot computer")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerScrollTool = Tool.make("computer_scroll", {
  description: "Scroll in one direction on this Bot's own running computer.",
  parameters: BotComputerScrollInput,
  success: BotComputerActionResult,
  failure: ComputerToolError,
  dependencies,
})
  .annotate(Tool.Title, "Scroll Bot computer")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerStandardToolkit = Toolkit.make(
  ComputerStatusTool,
  ComputerClickTool,
  ComputerTypeTool,
  ComputerPressTool,
  ComputerScrollTool,
);

export const ComputerSnapshotToolkit = Toolkit.make(ComputerSnapshotTool);
