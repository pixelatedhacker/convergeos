import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("053_ProjectionSchedules", (it) => {
  it.effect("adds the durable schedule projection and run ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* runMigrations({ toMigrationInclusive: 53 });

      const scheduleColumns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_schedules)
      `;

      assert.deepEqual(
        scheduleColumns.map((column) => column.name),
        [
          "schedule_id",
          "project_id",
          "title",
          "prompt",
          "recurrence_json",
          "time_zone",
          "model_selection_json",
          "runtime_mode",
          "interaction_mode",
          "enabled",
          "next_run_at",
          "last_run_at",
          "revision",
          "created_at",
          "updated_at",
          "deleted_at",
        ],
      );

      const runColumns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_schedule_runs)
      `;

      assert.deepEqual(
        runColumns.map((column) => column.name),
        ["schedule_id", "thread_id", "fired_at"],
      );

      const scheduleIndexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'projection_schedules'
        ORDER BY name ASC
      `;
      assert.deepEqual(
        scheduleIndexes.map((index) => index.name),
        ["idx_projection_schedules_due", "sqlite_autoindex_projection_schedules_1"],
      );

      const runIndexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'projection_schedule_runs'
        ORDER BY name ASC
      `;
      assert.deepEqual(
        runIndexes.map((index) => index.name),
        ["idx_projection_schedule_runs_schedule", "sqlite_autoindex_projection_schedule_runs_1"],
      );
    }),
  );
});
