import * as Effect from "effect/Effect";

import * as BotComputer from "../../../botComputer/BotComputerService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ComputerSnapshotToolkit, ComputerStandardToolkit } from "./tools.ts";

const withComputer = Effect.fn("ComputerToolkit.withComputer")(function* <A, E>(
  use: (
    service: BotComputer.BotComputerService["Service"],
    threadId: import("@t3tools/contracts").ThreadId,
  ) => Effect.Effect<A, E>,
) {
  const invocation = yield* McpInvocationContext.requireMcpCapability("preview");
  const computer = yield* BotComputer.BotComputerService;
  return yield* use(computer, invocation.threadId);
});

const standardHandlers = {
  computer_status: () =>
    withComputer((computer, threadId) => computer.computerStatus({ threadId })),
  computer_click: (input) =>
    withComputer((computer, threadId) => computer.click({ threadId, ...input })),
  computer_type: (input) =>
    withComputer((computer, threadId) => computer.type({ threadId, ...input })),
  computer_press: (input) =>
    withComputer((computer, threadId) => computer.press({ threadId, ...input })),
  computer_scroll: (input) =>
    withComputer((computer, threadId) => computer.scroll({ threadId, ...input })),
} satisfies Parameters<typeof ComputerStandardToolkit.toLayer>[0];

export const ComputerStandardToolkitHandlersLive =
  ComputerStandardToolkit.toLayer(standardHandlers);

export const ComputerSnapshotToolkitHandlersLive = ComputerSnapshotToolkit.toLayer({
  computer_snapshot: () => withComputer((computer, threadId) => computer.snapshot({ threadId })),
});
