import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("049_ProjectionKanbanCards", (it) => {
  it.effect("adds the durable Kanban card projection", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 48 });
      yield* runMigrations({ toMigrationInclusive: 49 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_kanban_cards)
      `;

      assert.deepEqual(
        columns.map((column) => column.name),
        [
          "card_id",
          "project_id",
          "title",
          "description",
          "status",
          "order_key",
          "assignee_thread_id",
          "revision",
          "created_at",
          "updated_at",
          "deleted_at",
        ],
      );
    }),
  );
});
