import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE task_budget_policies (
    root_thread_id TEXT PRIMARY KEY,
    policy_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE task_budget_threads (
    thread_id TEXT PRIMARY KEY,
    root_thread_id TEXT NOT NULL REFERENCES task_budget_policies(root_thread_id)
  )`;
  yield* sql`CREATE TABLE task_budget_reservations (
    reservation_id TEXT PRIMARY KEY,
    root_thread_id TEXT NOT NULL REFERENCES task_budget_policies(root_thread_id),
    delegation_id TEXT UNIQUE,
    thread_id TEXT,
    turn_id TEXT,
    dispatch_command_id TEXT UNIQUE,
    instance_id TEXT NOT NULL,
    model TEXT NOT NULL,
    consultation INTEGER NOT NULL,
    committed_tokens INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('reserved', 'dispatched', 'launching', 'finished')),
    admitted_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX idx_task_budget_root ON task_budget_reservations(root_thread_id, phase)`;
  yield* sql`CREATE INDEX idx_task_budget_turn ON task_budget_reservations(thread_id, turn_id)`;
});
