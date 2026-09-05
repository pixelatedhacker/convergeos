import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_delegations (
      delegation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      requester_json TEXT NOT NULL,
      target_json TEXT NOT NULL,
      title TEXT NOT NULL,
      task TEXT NOT NULL,
      state TEXT NOT NULL,
      target_thread_id TEXT,
      turn_id TEXT,
      assistant_message_id TEXT,
      failure_json TEXT,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_delegations_target_state
    ON projection_delegations(target_thread_id, state, updated_at, delegation_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_delegations_project_state
    ON projection_delegations(project_id, state, updated_at, delegation_id)
  `;
});
