import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE mesh_export_epochs (
      export_epoch TEXT PRIMARY KEY,
      destination_digest TEXT,
      publication TEXT NOT NULL CHECK (publication IN ('active', 'paused', 'discarded'))
    )
  `;
  yield* sql`
    INSERT INTO mesh_export_epochs (export_epoch, destination_digest, publication)
    SELECT export_epoch, NULL, 'paused' FROM mesh_receipt_outbox
    UNION SELECT export_epoch, NULL, 'paused' FROM mesh_export_state
  `;
  yield* sql`UPDATE mesh_export_state SET status = 'disabled'`;
  yield* sql`
    CREATE INDEX idx_mesh_source_message
    ON orchestration_events (stream_id, json_extract(payload_json, '$.messageId'), sequence)
    WHERE aggregate_kind = 'thread' AND event_type = 'thread.message-sent'
  `;
});
