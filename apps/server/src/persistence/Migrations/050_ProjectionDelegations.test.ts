import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("050_ProjectionDelegations", (it) => {
  it.effect("adds the durable delegation projection and query indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* runMigrations({ toMigrationInclusive: 50 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_delegations)
      `;
      assert.deepEqual(
        columns.map((column) => column.name),
        [
          "delegation_id",
          "project_id",
          "requester_json",
          "target_json",
          "title",
          "task",
          "state",
          "target_thread_id",
          "turn_id",
          "assistant_message_id",
          "failure_json",
          "revision",
          "created_at",
          "updated_at",
        ],
      );

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'projection_delegations'
        ORDER BY name ASC
      `;
      assert.deepEqual(
        indexes.map((index) => index.name),
        [
          "idx_projection_delegations_project_state",
          "idx_projection_delegations_target_state",
          "sqlite_autoindex_projection_delegations_1",
        ],
      );
    }),
  );
});
