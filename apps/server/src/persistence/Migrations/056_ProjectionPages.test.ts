import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("056_ProjectionPages", (it) => {
  it.effect("adds the page and page revision projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* runMigrations({ toMigrationInclusive: 63 });

      const pageColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_pages)
      `;
      assert.deepEqual(
        pageColumns.map((column) => column.name),
        [
          "page_id",
          "project_id",
          "title",
          "kind",
          "source_thread_id",
          "maintainer_thread_id",
          "current_revision_id",
          "current_revision",
          "metadata_revision",
          "created_at",
          "updated_at",
          "archived_at",
        ],
      );

      const revisionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_page_revisions)
      `;
      assert.deepEqual(
        revisionColumns.map((column) => column.name),
        [
          "revision_id",
          "page_id",
          "predecessor_revision_id",
          "revision",
          "content_json",
          "data_at",
          "author_json",
          "accepted_at",
        ],
      );
    }),
  );
});
