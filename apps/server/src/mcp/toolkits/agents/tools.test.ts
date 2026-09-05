import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import {
  AgentsInterruptTool,
  AgentsListTool,
  AgentsReadTool,
  AgentsSendTool,
  AgentsSpawnTool,
  AgentsWaitTool,
} from "./tools.ts";

it("annotates reads and mutations to match their behavior", () => {
  for (const tool of [AgentsListTool, AgentsReadTool, AgentsWaitTool]) {
    expect(Context.get(tool.annotations, Tool.Readonly)).toBe(true);
    expect(Context.get(tool.annotations, Tool.Destructive)).toBe(false);
    expect(Context.get(tool.annotations, Tool.Idempotent)).toBe(true);
    expect(Context.get(tool.annotations, Tool.OpenWorld)).toBe(false);
  }

  expect(Context.get(AgentsSendTool.annotations, Tool.Readonly)).toBe(false);
  expect(Context.get(AgentsSendTool.annotations, Tool.Destructive)).toBe(true);
  expect(Context.get(AgentsSendTool.annotations, Tool.Idempotent)).toBe(true);
  expect(Context.get(AgentsSendTool.annotations, Tool.OpenWorld)).toBe(true);

  expect(Context.get(AgentsSpawnTool.annotations, Tool.Readonly)).toBe(false);
  expect(Context.get(AgentsSpawnTool.annotations, Tool.Destructive)).toBe(true);
  expect(Context.get(AgentsSpawnTool.annotations, Tool.Idempotent)).toBe(true);
  expect(Context.get(AgentsSpawnTool.annotations, Tool.OpenWorld)).toBe(true);

  expect(Context.get(AgentsInterruptTool.annotations, Tool.Readonly)).toBe(false);
  expect(Context.get(AgentsInterruptTool.annotations, Tool.Destructive)).toBe(true);
  expect(Context.get(AgentsInterruptTool.annotations, Tool.Idempotent)).toBe(true);
  expect(Context.get(AgentsInterruptTool.annotations, Tool.OpenWorld)).toBe(false);
});
