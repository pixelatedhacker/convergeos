import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const migrationLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

migrationLayer("051_ProjectionKanbanDelegationLink", (it) => {
  it.effect("adds the durable delegation link and lookup index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 50 });
      yield* runMigrations({ toMigrationInclusive: 51 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_kanban_cards)
      `;
      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_kanban_cards)
      `;
      assert.isTrue(columns.some((column) => column.name === "delegation_id"));
      assert.isTrue(
        indexes.some((index) => index.name === "idx_projection_kanban_cards_delegation"),
      );
    }),
  );
});
