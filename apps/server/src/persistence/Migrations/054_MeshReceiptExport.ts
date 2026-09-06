import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS mesh_export_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL,
      export_epoch TEXT NOT NULL,
      cursor_sequence INTEGER NOT NULL,
      quota_bytes INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      stop_watermark INTEGER,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS mesh_export_streams (
      export_epoch TEXT NOT NULL,
      project_id TEXT NOT NULL,
      stream_sequence INTEGER NOT NULL,
      last_event_id TEXT,
      PRIMARY KEY (export_epoch, project_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS mesh_receipt_outbox (
      export_epoch TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      stream_sequence INTEGER NOT NULL,
      receipt_type TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      source_sequence INTEGER NOT NULL,
      nostr_event_id TEXT NOT NULL,
      event_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      next_attempt_at TEXT,
      rejection_reason TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (export_epoch, stream_id, stream_sequence),
      UNIQUE (export_epoch, receipt_type, source_event_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_mesh_receipt_outbox_pending
    ON mesh_receipt_outbox(status, next_attempt_at)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS mesh_signer_keys (
      key_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      public_key_hex TEXT NOT NULL,
      enrolled_at TEXT NOT NULL,
      revoked_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS mesh_artifacts (
      sha256 TEXT PRIMARY KEY,
      byte_length INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      completeness TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});
