import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("052_ProjectionThreadSessionMcpAttachment", (it) => {
  it.effect("persists the MCP attachment outcome on projected sessions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 51 });
      yield* runMigrations({ toMigrationInclusive: 52 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
      assert.ok(columns.some((column) => column.name === "mcp_attachment"));

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          mcp_attachment,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        ) VALUES (
          'thread-leaf-only',
          'ready',
          'antigravityCli',
          'leafOnly',
          'full-access',
          NULL,
          NULL,
          '2026-09-05T00:00:00.000Z'
        )
      `;
      const rows = yield* sql<{ readonly mcpAttachment: string | null }>`
        SELECT mcp_attachment AS "mcpAttachment"
        FROM projection_thread_sessions
        WHERE thread_id = 'thread-leaf-only'
      `;
      assert.deepEqual(rows, [{ mcpAttachment: "leafOnly" }]);
    }),
  );
});
