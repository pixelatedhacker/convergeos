import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import { KanbanReadTool, KanbanWriteTool } from "./tools.ts";

it("annotates Kanban reads and mutations to match their behavior", () => {
  expect(Context.get(KanbanReadTool.annotations, Tool.Readonly)).toBe(true);
  expect(Context.get(KanbanReadTool.annotations, Tool.Destructive)).toBe(false);
  expect(Context.get(KanbanReadTool.annotations, Tool.Idempotent)).toBe(true);
  expect(Context.get(KanbanReadTool.annotations, Tool.OpenWorld)).toBe(false);

  expect(Context.get(KanbanWriteTool.annotations, Tool.Readonly)).toBe(false);
  expect(Context.get(KanbanWriteTool.annotations, Tool.Destructive)).toBe(true);
  expect(Context.get(KanbanWriteTool.annotations, Tool.Idempotent)).toBe(true);
  expect(Context.get(KanbanWriteTool.annotations, Tool.OpenWorld)).toBe(false);
});
