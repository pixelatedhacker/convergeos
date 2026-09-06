import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_schedules (
      schedule_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      recurrence_json TEXT NOT NULL,
      time_zone TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      next_run_at TEXT,
      last_run_at TEXT,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_schedules_due
    ON projection_schedules(enabled, next_run_at)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_schedule_runs (
      schedule_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      fired_at TEXT NOT NULL,
      PRIMARY KEY (schedule_id, thread_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_schedule_runs_schedule
    ON projection_schedule_runs(schedule_id, fired_at)
  `;
});
