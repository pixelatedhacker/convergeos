import { EventId, type ThreadId, type TurnId } from "@t3tools/contracts";

export const invocationUsageActivityId = (threadId: ThreadId, turnId: TurnId) =>
  EventId.make(`invocation-usage:${threadId.length}:${threadId}:${turnId}`);

export const invocationStartedActivityId = (threadId: ThreadId, turnId: TurnId) =>
  EventId.make(`invocation-started:${threadId.length}:${threadId}:${turnId}`);

export const invocationFinishedActivityId = (threadId: ThreadId, turnId: TurnId) =>
  EventId.make(`invocation-finished:${threadId.length}:${threadId}:${turnId}`);
