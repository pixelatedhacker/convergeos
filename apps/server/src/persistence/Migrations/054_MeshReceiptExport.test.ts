import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("054_MeshReceiptExport", (it) => {
  it.effect("adds the receipt outbox, export streams, enrollment, and artifact tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* runMigrations({ toMigrationInclusive: 54 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'mesh_%'
        ORDER BY name
      `;
      assert.deepEqual(
        tables.map((table) => table.name),
        [
          "mesh_artifacts",
          "mesh_export_state",
          "mesh_export_streams",
          "mesh_receipt_outbox",
          "mesh_signer_keys",
        ],
      );

      // The export stream + receipt-type uniqueness contract the outbox writer
      // relies on: one record per (epoch, stream) position, and one receipt per
      // (epoch, type, source event).
      yield* sql`INSERT INTO mesh_export_streams (export_epoch, project_id, stream_sequence) VALUES ('epoch-1', 'project-1', 0)`;
      yield* sql`
        INSERT INTO mesh_receipt_outbox (
          export_epoch, stream_id, stream_sequence, receipt_type, source_event_id,
          source_sequence, nostr_event_id, event_json, status, attempts, next_attempt_at,
          rejection_reason, created_at
        ) VALUES ('epoch-1', 'project-1', 1, 'delegation.accepted', 'evt-1', 41, ${"a".repeat(64)}, '{}', 'pending', 0, NULL, NULL, '2026-09-05T00:00:00.000Z')
      `;
      const duplicateSourceReceipt = yield* Effect.result(
        sql`
          INSERT INTO mesh_receipt_outbox (
            export_epoch, stream_id, stream_sequence, receipt_type, source_event_id,
            source_sequence, nostr_event_id, event_json, status, attempts, next_attempt_at,
            rejection_reason, created_at
          ) VALUES ('epoch-1', 'project-1', 2, 'delegation.accepted', 'evt-1', 41, ${"b".repeat(64)}, '{}', 'pending', 0, NULL, NULL, '2026-09-05T00:00:00.000Z')
        `,
      );
      assert.equal(duplicateSourceReceipt._tag, "Failure");
    }),
  );
});
