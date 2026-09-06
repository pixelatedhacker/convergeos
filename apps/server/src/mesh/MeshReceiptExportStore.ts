import {
  EventId,
  type IsoDateTime,
  type MeshArtifactReference,
  type MeshKeyId,
  type MeshReceipt,
  NonNegativeInt,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import type { MeshReceiptDraft } from "./receiptMapping.ts";
import type { MeshReceiptSigner } from "./MeshReceiptSigner.ts";

/**
 * Durable storage for outbound mesh receipt export: the export state machine,
 * per-project stream chains, the signed-event outbox, signer enrollment, and
 * content-addressed artifact retention.
 *
 * Capture is transactional: one `captureBatch` allocates per-stream sequence
 * numbers, signs through the provided signer, inserts outbox rows, and
 * advances the source cursor together. A crash before the commit replays the
 * source events; a crash after publication but before acknowledgement resends
 * the same event id — neither skips history nor forks the stream.
 */
export class MeshReceiptExportStoreError extends Schema.TaggedErrorClass<
  MeshReceiptExportStoreError
>()("MeshReceiptExportStoreError", {
  operation: Schema.Literals([
    "readExportState",
    "enableExport",
    "disableExport",
    "resolveProjectIdForThread",
    "captureBatch",
    "listDuePending",
    "markAccepted",
    "markRejected",
    "markRetry",
    "pendingBytes",
    "recordArtifact",
    "listArtifacts",
    "enrollKey",
    "listActiveKeys",
  ]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Mesh receipt export store operation '${this.operation}' failed.`;
  }
}

export type MeshReceiptExportStoreShape = {
  readonly readExportState: Effect.Effect<
    {
      readonly status: "active" | "disabled";
      readonly exportEpoch: string;
      readonly cursorSequence: number;
      readonly quotaBytes: number;
      readonly stopWatermark: number | null;
    } | null,
    MeshReceiptExportStoreError
  >;

  readonly enableExport: (input: {
    readonly exportEpoch: string;
    readonly startWatermark: number;
    readonly quotaBytes: number;
    readonly at: IsoDateTime;
  }) => Effect.Effect<void, MeshReceiptExportStoreError>;

  readonly disableExport: (input: {
    readonly stopWatermark: number;
    readonly at: IsoDateTime;
  }) => Effect.Effect<void, MeshReceiptExportStoreError>;

  readonly resolveProjectIdForThread: (
    threadId: string,
  ) => Effect.Effect<Option.Option<ProjectId>, MeshReceiptExportStoreError>;

  readonly captureBatch: (input: {
    readonly exportEpoch: string;
    readonly cursorFrom: number;
    readonly cursorTo: number;
    readonly at: IsoDateTime;
    readonly drafts: ReadonlyArray<MeshReceiptDraft>;
    readonly artifacts: ReadonlyArray<{
      readonly reference: MeshArtifactReference;
      readonly content: string;
    }>;
    readonly signer: MeshReceiptSigner["Service"];
  }) => Effect.Effect<
    {
      readonly captured: number;
      readonly cursorTo: number;
      readonly streams: ReadonlyArray<{
        readonly projectId: ProjectId;
        readonly streamSequence: number;
        readonly lastEventId: string | null;
        readonly lastSource: { readonly sourceEventId: EventId; readonly sourceSequence: number };
      }>;
    },
    MeshReceiptExportStoreError
  >;

  readonly listDuePending: (input: {
    readonly now: IsoDateTime;
    readonly limit: number;
  }) => Effect.Effect<
    ReadonlyArray<{
      readonly nostrEventId: string;
      readonly eventJson: string;
      readonly attempts: number;
    }>,
    MeshReceiptExportStoreError
  >;

  readonly markAccepted: (input: {
    readonly nostrEventId: string;
  }) => Effect.Effect<void, MeshReceiptExportStoreError>;

  readonly markRejected: (input: {
    readonly nostrEventId: string;
    readonly reason: string;
  }) => Effect.Effect<void, MeshReceiptExportStoreError>;

  readonly markRetry: (input: {
    readonly nostrEventId: string;
    readonly nextAttemptAt: IsoDateTime;
  }) => Effect.Effect<void, MeshReceiptExportStoreError>;

  readonly pendingBytes: Effect.Effect<number, MeshReceiptExportStoreError>;

  readonly recordArtifact: (input: {
    readonly reference: MeshArtifactReference;
    readonly content: string;
    readonly at: IsoDateTime;
  }) => Effect.Effect<void, MeshReceiptExportStoreError>;

  readonly listArtifacts: Effect.Effect<
    ReadonlyArray<{
      readonly sha256: string;
      readonly byteLength: number;
      readonly mediaType: string;
      readonly completeness: string;
      readonly content: string;
    }>,
    MeshReceiptExportStoreError
  >;

  readonly enrollKey: (input: {
    readonly keyId: MeshKeyId;
    readonly environmentId: string;
    readonly publicKeyHex: string;
    readonly at: IsoDateTime;
  }) => Effect.Effect<void, MeshReceiptExportStoreError>;

  readonly listActiveKeys: Effect.Effect<
    ReadonlyArray<{
      readonly keyId: string;
      readonly environmentId: string;
      readonly publicKeyHex: string;
    }>,
    MeshReceiptExportStoreError
  >;
}

export const isMeshReceiptExportStoreError = Schema.is(MeshReceiptExportStoreError);

export class MeshReceiptExportStore extends Context.Service<
  MeshReceiptExportStore,
  MeshReceiptExportStoreShape
>()("t3/mesh/MeshReceiptExportStore") {}

const ExportStateRow = Schema.Struct({
  status: Schema.Literals(["active", "disabled"]),
  exportEpoch: Schema.String,
  cursorSequence: NonNegativeInt,
  quotaBytes: NonNegativeInt,
  stopWatermark: Schema.NullOr(Schema.Number),
});

const DuePendingRow = Schema.Struct({
  nostrEventId: Schema.String,
  eventJson: Schema.String,
  attempts: NonNegativeInt,
});

const meshSqlError = (operation: MeshReceiptExportStoreError["operation"]) => (cause: unknown) =>
  new MeshReceiptExportStoreError({ operation, cause });

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readExportState: MeshReceiptExportStoreShape["readExportState"] = SqlSchema.findOneOption({
    Request: Schema.Struct({}),
    Result: ExportStateRow,
    execute: () => sql`
      SELECT status, export_epoch AS "exportEpoch", cursor_sequence AS "cursorSequence",
             quota_bytes AS "quotaBytes", stop_watermark AS "stopWatermark"
      FROM mesh_export_state WHERE id = 1
    `,
  })({}).pipe(
    Effect.map(Option.getOrNull),
    Effect.mapError(meshSqlError("readExportState")),
  );

  const enableExport: MeshReceiptExportStoreShape["enableExport"] = (input) =>
    sql`
      INSERT INTO mesh_export_state (
        id, status, export_epoch, cursor_sequence, quota_bytes, started_at, stop_watermark, updated_at
      ) VALUES (1, 'active', ${input.exportEpoch}, ${input.startWatermark}, ${input.quotaBytes}, ${input.at}, NULL, ${input.at})
      ON CONFLICT (id) DO UPDATE SET
        status = 'active',
        export_epoch = excluded.export_epoch,
        cursor_sequence = excluded.cursor_sequence,
        quota_bytes = excluded.quota_bytes,
        started_at = excluded.started_at,
        stop_watermark = NULL,
        updated_at = excluded.updated_at
    `.pipe(Effect.asVoid, Effect.mapError(meshSqlError("enableExport")));

  const disableExport: MeshReceiptExportStoreShape["disableExport"] = (input) =>
    sql`
      UPDATE mesh_export_state
      SET status = 'disabled', stop_watermark = ${input.stopWatermark}, updated_at = ${input.at}
      WHERE id = 1
    `.pipe(Effect.asVoid, Effect.mapError(meshSqlError("disableExport")));

  const resolveProjectIdForThread: MeshReceiptExportStoreShape["resolveProjectIdForThread"] = (
    threadId,
  ) =>
    SqlSchema.findOneOption({
      Request: Schema.Struct({ threadId: Schema.String }),
      Result: Schema.Struct({ projectId: Schema.String }),
      execute: (request) => sql`
        SELECT project_id AS "projectId" FROM projection_threads WHERE thread_id = ${request.threadId}
      `,
    })({ threadId }).pipe(
      Effect.map(Option.map((row) => row.projectId as ProjectId)),
      Effect.mapError(meshSqlError("resolveProjectIdForThread")),
    );

  const readStreamRows = (epoch: string, projectIds: ReadonlyArray<string>) =>
    projectIds.length === 0
      ? Effect.succeed([])
      : sql<{ readonly projectId: string; readonly streamSequence: number; readonly lastEventId: string | null }>`
          SELECT project_id AS "projectId", stream_sequence AS "streamSequence", last_event_id AS "lastEventId"
          FROM mesh_export_streams
          WHERE export_epoch = ${epoch} AND ${sql.in("project_id", projectIds)}
        `.pipe(Effect.mapError(meshSqlError("captureBatch")));

  const captureBatch: MeshReceiptExportStoreShape["captureBatch"] = (input) =>
    input.drafts.length === 0
      ? Effect.succeed({
          captured: 0,
          cursorTo: input.cursorTo,
          streams: [],
        })
      : sql.withTransaction(
      Effect.gen(function* () {
        // Re-captures (a crash replayed the same source events) dedupe on
        // (epoch, receipt type, source event): one stable logical receipt.
        const existing = yield* sql<{ readonly sourceEventId: string; readonly receiptType: string }>`
          SELECT source_event_id AS "sourceEventId", receipt_type AS "receiptType"
          FROM mesh_receipt_outbox
          WHERE export_epoch = ${input.exportEpoch}
            AND ${sql.in("source_event_id", input.drafts.map((draft) => draft.sourceEventId))}
        `.pipe(Effect.mapError(meshSqlError("captureBatch")));
        const existingKeys = new Set(existing.map((row) => `${row.receiptType}:${row.sourceEventId}`));

        const streamRows = yield* readStreamRows(
          input.exportEpoch,
          [...new Set(input.drafts.map((draft) => draft.projectId))],
        );
        const streams = new Map(
          streamRows.map((row) => [row.projectId, { sequence: row.streamSequence, lastEventId: row.lastEventId }]),
        );
        const lastSourceByStream = new Map<string, { sourceEventId: EventId; sourceSequence: number }>();
        let captured = 0;

        for (const artifact of input.artifacts) {
          yield* sql`
            INSERT INTO mesh_artifacts (sha256, byte_length, media_type, completeness, content, created_at)
            VALUES (${artifact.reference.sha256}, ${artifact.reference.byteLength}, ${artifact.reference.mediaType}, ${artifact.reference.completeness}, ${artifact.content}, ${input.at})
            ON CONFLICT (sha256) DO NOTHING
          `.pipe(Effect.mapError(meshSqlError("captureBatch")));
        }

        for (const draft of input.drafts) {
          if (existingKeys.has(`${draft.type}:${draft.sourceEventId}`)) {
            continue;
          }
          const stream = streams.get(draft.projectId) ?? { sequence: 0, lastEventId: null };
          const receipt = {
            ...draft,
            exportEpoch: input.exportEpoch,
            streamId: draft.projectId,
            streamSequence: stream.sequence + 1,
            previousEventId: stream.lastEventId,
            recordedAt: input.at,
          } as MeshReceipt;
          const signed = input.signer.signReceiptSync(receipt);
          if (signed._tag === "Oversize") {
            // Payloads are bounded upstream; an oversize receipt is a loud
            // bug. Failing the batch keeps the cursor intact for replay
            // instead of publishing a stream that skips history.
            return yield* Effect.fail(
              new MeshReceiptExportStoreError({
                operation: "captureBatch",
                cause: new Error(`Signed event exceeds the ${signed.byteLength}-byte limit`),
              }),
            );
          }
          yield* sql`
            INSERT INTO mesh_receipt_outbox (
              export_epoch, stream_id, stream_sequence, receipt_type, source_event_id,
              source_sequence, nostr_event_id, event_json, status, attempts, next_attempt_at,
              rejection_reason, created_at
            ) VALUES (
              ${input.exportEpoch}, ${draft.projectId}, ${stream.sequence + 1}, ${draft.type},
              ${draft.sourceEventId}, ${draft.sourceSequence}, ${signed.signed.event.id},
              ${signed.signed.eventJson}, 'pending', 0, NULL, NULL, ${input.at}
            )
          `.pipe(Effect.mapError(meshSqlError("captureBatch")));
          streams.set(draft.projectId, {
            sequence: stream.sequence + 1,
            lastEventId: signed.signed.event.id,
          });
          lastSourceByStream.set(draft.projectId, {
            sourceEventId: draft.sourceEventId,
            sourceSequence: draft.sourceSequence,
          });
          captured += 1;
        }

        for (const [projectId, stream] of streams) {
          yield* sql`
            INSERT INTO mesh_export_streams (export_epoch, project_id, stream_sequence, last_event_id)
            VALUES (${input.exportEpoch}, ${projectId}, ${stream.sequence}, ${stream.lastEventId})
            ON CONFLICT (export_epoch, project_id) DO UPDATE SET
              stream_sequence = excluded.stream_sequence,
              last_event_id = excluded.last_event_id
          `.pipe(Effect.mapError(meshSqlError("captureBatch")));
        }

        if (input.cursorTo > input.cursorFrom) {
          const claimed = yield* sql<{ readonly cursorSequence: number }>`
            SELECT cursor_sequence AS "cursorSequence" FROM mesh_export_state
            WHERE id = 1 AND status = 'active' AND cursor_sequence = ${input.cursorFrom}
          `.pipe(Effect.mapError(meshSqlError("captureBatch")));
          if (claimed.length === 0) {
            return yield* Effect.fail(
              new MeshReceiptExportStoreError({
                operation: "captureBatch",
                cause: new Error("Export cursor moved concurrently; capture batch aborted"),
              }),
            );
          }
          yield* sql`
            UPDATE mesh_export_state
            SET cursor_sequence = ${input.cursorTo}, updated_at = ${input.at}
            WHERE id = 1
          `.pipe(Effect.mapError(meshSqlError("captureBatch")));
        }

        return {
          captured,
          cursorTo: input.cursorTo,
          streams: [...streams.entries()].map(([projectId, stream]) => ({
            projectId: projectId as ProjectId,
            streamSequence: stream.sequence,
            lastEventId: stream.lastEventId,
            lastSource: lastSourceByStream.get(projectId) ?? {
              sourceEventId: draftBaseSourceEventId(input.exportEpoch, projectId, stream.sequence),
              sourceSequence: input.cursorTo,
            },
          })),
        };
      }),
    ).pipe(
      // withTransaction surfaces client-acquisition SqlError; fold it into the
      // store's typed error so callers handle one error type.
      Effect.catch((cause) =>
        isMeshReceiptExportStoreError(cause)
          ? Effect.fail(cause)
          : Effect.fail(meshSqlError("captureBatch")(cause)),
      ),
    );

  const listDuePending: MeshReceiptExportStoreShape["listDuePending"] = (input) =>
    SqlSchema.findAll({
      Request: Schema.Struct({ now: Schema.String, limit: NonNegativeInt }),
      Result: DuePendingRow,
      execute: (request) => sql`
        SELECT nostr_event_id AS "nostrEventId", event_json AS "eventJson", attempts
        FROM mesh_receipt_outbox
        WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ${request.now})
        ORDER BY export_epoch, stream_id, stream_sequence
        LIMIT ${request.limit}
      `,
    })({ now: input.now, limit: input.limit }).pipe(Effect.mapError(meshSqlError("listDuePending")));

  const markAccepted: MeshReceiptExportStoreShape["markAccepted"] = (input) =>
    sql`
      UPDATE mesh_receipt_outbox
      SET status = 'accepted', rejection_reason = NULL
      WHERE nostr_event_id = ${input.nostrEventId} AND status = 'pending'
    `.pipe(Effect.asVoid, Effect.mapError(meshSqlError("markAccepted")));

  const markRejected: MeshReceiptExportStoreShape["markRejected"] = (input) =>
    sql`
      UPDATE mesh_receipt_outbox
      SET status = 'rejected', rejection_reason = ${input.reason}
      WHERE nostr_event_id = ${input.nostrEventId} AND status = 'pending'
    `.pipe(Effect.asVoid, Effect.mapError(meshSqlError("markRejected")));

  const markRetry: MeshReceiptExportStoreShape["markRetry"] = (input) =>
    sql`
      UPDATE mesh_receipt_outbox
      SET attempts = attempts + 1, next_attempt_at = ${input.nextAttemptAt}
      WHERE nostr_event_id = ${input.nostrEventId} AND status = 'pending'
    `.pipe(Effect.asVoid, Effect.mapError(meshSqlError("markRetry")));

  const pendingBytes: MeshReceiptExportStoreShape["pendingBytes"] = sql<{ readonly total: number }>`
    SELECT COALESCE(SUM(LENGTH(event_json)), 0) AS total
    FROM mesh_receipt_outbox WHERE status = 'pending'
  `.pipe(
    Effect.map((rows) => rows[0]?.total ?? 0),
    Effect.mapError(meshSqlError("pendingBytes")),
  );

  const recordArtifact: MeshReceiptExportStoreShape["recordArtifact"] = (input) =>
    sql`
      INSERT INTO mesh_artifacts (sha256, byte_length, media_type, completeness, content, created_at)
      VALUES (${input.reference.sha256}, ${input.reference.byteLength}, ${input.reference.mediaType}, ${input.reference.completeness}, ${input.content}, ${input.at})
      ON CONFLICT (sha256) DO NOTHING
    `.pipe(Effect.asVoid, Effect.mapError(meshSqlError("recordArtifact")));

  const listArtifacts: MeshReceiptExportStoreShape["listArtifacts"] = sql<{
    readonly sha256: string;
    readonly byteLength: number;
    readonly mediaType: string;
    readonly completeness: string;
    readonly content: string;
  }>`
    SELECT sha256, byte_length AS "byteLength", media_type AS "mediaType",
           completeness, content
    FROM mesh_artifacts ORDER BY created_at
  `.pipe(Effect.mapError(meshSqlError("listArtifacts")));

  const enrollKey: MeshReceiptExportStoreShape["enrollKey"] = (input) =>
    sql`
      INSERT INTO mesh_signer_keys (key_id, environment_id, public_key_hex, enrolled_at, revoked_at)
      VALUES (${input.keyId}, ${input.environmentId}, ${input.publicKeyHex}, ${input.at}, NULL)
      ON CONFLICT (key_id) DO UPDATE SET
        revoked_at = CASE WHEN mesh_signer_keys.revoked_at IS NULL THEN NULL ELSE mesh_signer_keys.revoked_at END
    `.pipe(Effect.asVoid, Effect.mapError(meshSqlError("enrollKey")));

  const listActiveKeys: MeshReceiptExportStoreShape["listActiveKeys"] = sql<{
    readonly keyId: string;
    readonly environmentId: string;
    readonly publicKeyHex: string;
  }>`
    SELECT key_id AS "keyId", environment_id AS "environmentId", public_key_hex AS "publicKeyHex"
    FROM mesh_signer_keys WHERE revoked_at IS NULL ORDER BY enrolled_at
  `.pipe(Effect.mapError(meshSqlError("listActiveKeys")));

  return {
    readExportState,
    enableExport,
    disableExport,
    resolveProjectIdForThread,
    captureBatch,
    listDuePending,
    markAccepted,
    markRejected,
    markRetry,
    pendingBytes,
    recordArtifact,
    listArtifacts,
    enrollKey,
    listActiveKeys,
  } satisfies MeshReceiptExportStoreShape;
});

export const layer = Layer.effect(MeshReceiptExportStore, make);

const draftBaseSourceEventId = (epoch: string, projectId: string, sequence: number): EventId =>
  EventId.make(`mesh-export:${epoch}:${projectId}:${sequence}`);
