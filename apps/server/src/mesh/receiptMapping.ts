import { MESH_RECEIPT_VERSION } from "@t3tools/contracts";
import type {
  Delegation,
  EnvironmentId,
  EventId,
  MessageId,
  MeshOriginQualifiedEventRef,
  MeshArtifactReference,
  MeshKeyId,
  MeshReceipt,
  ProjectId,
  ThreadId,
  OrchestrationEvent,
} from "@t3tools/contracts";
import { sha256 } from "@noble/hashes/sha2";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { MeshReceiptExportStoreError } from "./MeshReceiptExportStore.ts";

export const ASSISTANT_TEXT_MEDIA_TYPE = "text/plain; charset=utf-8";

/**
 * The explicit export allowlist. Source event types outside this set never
 * export; excluded events simply do not appear in the stream, and per-stream
 * export sequences stay contiguous because numbers are assigned after
 * filtering.
 *
 * Only lifecycle facts ConvergeOS directly observed (runtime-observed) export
 * today. Tool evidence and verifier assessments wait for their per-provider
 * mappings; provider-reported success is never inferred from prose.
 */
export const MESH_RECEIPT_SOURCE_EVENT_TYPES: ReadonlySet<OrchestrationEvent["type"]> = new Set([
  "delegation.requested",
  "delegation.completed",
  "delegation.failed",
  "delegation.interrupted",
  "thread.turn-start-requested",
  "thread.message-sent",
]);

/** A receipt with its stream-assigned fields still open. The outbox writer
    fills exportEpoch, streamSequence, previousEventId, and recordedAt inside
    the capture transaction, immediately before signing. */
export type MeshReceiptDraft = DistributiveOmit<
  MeshReceipt,
  "exportEpoch" | "streamSequence" | "previousEventId" | "recordedAt"
>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface MappedMeshReceiptDraft {
  readonly projectId: ProjectId;
  readonly draft: MeshReceiptDraft;
  /** Output bytes retained locally and referenced by digest in the receipt.
      Retention may expire them later without erasing receipts. */
  readonly artifact: { readonly reference: MeshArtifactReference; readonly content: string } | null;
}

/** Resolution failures (e.g. persistence errors) propagate; a missing project
    resolves to None and is an intentional exclusion, not an error. */
export type ThreadProjectResolver = (
  threadId: ThreadId,
) => Effect.Effect<Option.Option<ProjectId>, MeshReceiptExportStoreError>;

export interface MeshReceiptSourceResolver {
  readonly resolveProjectIdForThread: ThreadProjectResolver;
  readonly readAssistantTextAt: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly sequenceInclusive: number;
  }) => Effect.Effect<Option.Option<string>, MeshReceiptExportStoreError>;
  readonly resolveSourceEvent: (
    eventId: EventId,
  ) => Effect.Effect<
    Option.Option<{ readonly eventId: EventId; readonly sequence: number }>,
    MeshReceiptExportStoreError
  >;
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const completeArtifactForText = (
  text: string,
): { readonly reference: MeshArtifactReference; readonly content: string } => {
  const bytes = new TextEncoder().encode(text);
  return {
    content: text,
    reference: {
      sha256: bytesToHex(sha256(bytes)) as MeshArtifactReference["sha256"],
      byteLength: bytes.length,
      mediaType: ASSISTANT_TEXT_MEDIA_TYPE,
      // The exported representation is the complete message text; a digest
      // over a truncation would say so with `truncated` instead.
      completeness: "complete",
    },
  };
};

const isDelegationTransition = (
  event: OrchestrationEvent,
): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "delegation.requested"
      | "delegation.completed"
      | "delegation.failed"
      | "delegation.interrupted";
    payload: { delegation: Delegation };
  }
> =>
  event.type === "delegation.requested" ||
  event.type === "delegation.completed" ||
  event.type === "delegation.failed" ||
  event.type === "delegation.interrupted";

/**
 * Maps one persisted orchestration event to at most one receipt draft, or null
 * when the event is outside the allowlist or cannot be attributed to a project
 * (an intentional exclusion, not a stream gap).
 */
export const mapSourceEventToDraft = (
  event: OrchestrationEvent,
  issuerEnvironmentId: EnvironmentId,
  keyId: MeshKeyId,
  sources: MeshReceiptSourceResolver,
): Effect.Effect<MappedMeshReceiptDraft | null, MeshReceiptExportStoreError> =>
  Effect.gen(function* () {
    if (!MESH_RECEIPT_SOURCE_EVENT_TYPES.has(event.type)) {
      return null;
    }

    const cause: MeshOriginQualifiedEventRef | null =
      event.causationEventId === null
        ? null
        : {
            environmentId: issuerEnvironmentId,
            sourceEventId: event.causationEventId,
            ...Option.match(yield* sources.resolveSourceEvent(event.causationEventId), {
              onNone: () => ({}),
              onSome: (source) => ({ sourceSequence: source.sequence }),
            }),
          };

    if (isDelegationTransition(event)) {
      const delegation = event.payload.delegation;
      // Kanban-originated delegations have no agent thread to attribute;
      // thread-delegated work is the mesh's subject. Intentional exclusion.
      if (delegation.requester.kind !== "thread") {
        return null;
      }
      const requesterThreadId = delegation.requester.threadId;
      const common = draftBase(
        event,
        issuerEnvironmentId,
        keyId,
        delegation.projectId,
        event.type === "delegation.requested"
          ? requesterThreadId
          : (delegation.targetThreadId ?? requesterThreadId),
        cause,
      );
      if (event.type === "delegation.requested") {
        return {
          projectId: delegation.projectId,
          artifact: null,
          draft: {
            ...common,
            delegationId: delegation.id,
            type: "delegation.accepted",
            payload: {
              requesterThreadId,
              targetThreadId: delegation.targetThreadId,
              title: delegation.title,
            },
          },
        };
      }
      return {
        projectId: delegation.projectId,
        artifact: null,
        draft: {
          ...common,
          delegationId: delegation.id,
          ...(delegation.targetThreadId === null || delegation.turnId === null
            ? {}
            : { turnId: delegation.turnId }),
          type: "delegation.terminal",
          payload: {
            requesterThreadId,
            targetThreadId: delegation.targetThreadId,
            state:
              event.type === "delegation.completed"
                ? "completed"
                : event.type === "delegation.failed"
                  ? "failed"
                  : "interrupted",
            failure: delegation.failure,
          },
        },
      };
    }

    if (event.type === "thread.turn-start-requested") {
      const threadId = threadAggregateId(event);
      if (threadId === null) return null;
      const projectId = yield* resolveProjectId(threadId, sources.resolveProjectIdForThread);
      if (projectId === null) return null;
      return {
        projectId,
        artifact: null,
        draft: {
          ...draftBase(event, issuerEnvironmentId, keyId, projectId, threadId, cause),
          type: "turn.started",
          payload: { messageId: event.payload.messageId, turnId: null },
        },
      };
    }

    if (event.type === "thread.message-sent") {
      // Only final (non-streaming) assistant text exports, and only its digest
      // travels — bytes stay in local artifact storage.
      if (event.payload.role !== "assistant" || event.payload.streaming) {
        return null;
      }
      const threadId = threadAggregateId(event);
      if (threadId === null) return null;
      const projectId = yield* resolveProjectId(threadId, sources.resolveProjectIdForThread);
      if (projectId === null) return null;
      const text = yield* sources.readAssistantTextAt({
        threadId,
        messageId: event.payload.messageId,
        sequenceInclusive: event.sequence,
      });
      if (Option.isNone(text)) {
        return yield* new MeshReceiptExportStoreError({
          operation: "readAssistantTextAt",
          cause: new Error(`Assistant output is unavailable for source event ${event.eventId}`),
        });
      }
      const artifact = completeArtifactForText(text.value);
      return {
        projectId,
        artifact,
        draft: {
          ...draftBase(event, issuerEnvironmentId, keyId, projectId, threadId, cause),
          ...(event.payload.turnId === null ? {} : { turnId: event.payload.turnId }),
          type: "artifact.available",
          outputs: [artifact.reference],
          payload: {},
        },
      };
    }

    return null;
  });

const threadAggregateId = (event: OrchestrationEvent): ThreadId | null =>
  event.aggregateKind === "thread" ? (event.aggregateId as ThreadId) : null;

const resolveProjectId = (
  threadId: ThreadId,
  resolve: ThreadProjectResolver,
): Effect.Effect<ProjectId | null, MeshReceiptExportStoreError> =>
  Effect.map(resolve(threadId), Option.getOrNull);

const draftBase = (
  event: OrchestrationEvent,
  issuerEnvironmentId: EnvironmentId,
  keyId: MeshKeyId,
  projectId: ProjectId,
  threadId: ThreadId,
  cause: MeshOriginQualifiedEventRef | null,
) =>
  ({
    protocol: "convergeos.mesh",
    version: MESH_RECEIPT_VERSION,
    issuerEnvironmentId,
    keyId,
    projectId,
    streamId: projectId,
    threadId,
    sourceEventId: event.eventId,
    sourceSequence: event.sequence,
    cause,
    ...(event.commandId === null ? {} : { commandId: event.commandId }),
    occurredAt: event.occurredAt,
    evidence: "runtime-observed",
  }) as const;
