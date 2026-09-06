import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { migrationManifest, runMigrations } from "../Migrations.ts";

it.effect("055 pauses pre-existing export epochs without rewriting signed outbox records", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 54 });
    const at = "2026-09-06T00:00:00.000Z";
    yield* sql`
      INSERT INTO mesh_export_state (
        id, status, export_epoch, cursor_sequence, quota_bytes, started_at, stop_watermark, updated_at
      ) VALUES (1, 'active', 'epoch-active', 42, 8388608, ${at}, NULL, ${at})
    `;
    const retainedEvents = [
      {
        epoch: "epoch-active",
        sequence: 1,
        status: "pending",
        json: '{ "id": "event-pending", "content": "retained pending receipt" }\n',
      },
      {
        epoch: "epoch-active",
        sequence: 2,
        status: "accepted",
        json: '{"id":"event-accepted","content":"retained accepted receipt"}',
      },
      {
        epoch: "epoch-old",
        sequence: 1,
        status: "rejected",
        json: '{"id":"event-rejected", "content":"retained rejected receipt"}',
      },
    ];
    for (const event of retainedEvents) {
      const sourceId = `${event.epoch}:${event.sequence}`;
      yield* sql`
        INSERT INTO mesh_receipt_outbox (
          export_epoch, stream_id, stream_sequence, receipt_type, source_event_id,
          source_sequence, nostr_event_id, event_json, status, attempts, next_attempt_at,
          rejection_reason, created_at
        ) VALUES (
          ${event.epoch}, 'project-1', ${event.sequence}, 'artifact.available', ${sourceId},
          ${event.sequence}, ${sourceId}, ${event.json}, ${event.status}, 2, ${at},
          ${event.status === "rejected" ? "blocked: retained rejection" : null}, ${at}
        )
      `;
    }
    const before =
      yield* sql`SELECT * FROM mesh_receipt_outbox ORDER BY export_epoch, stream_sequence`;

    const applied = yield* runMigrations({ toMigrationInclusive: 55 });
    assert.deepEqual(applied, [[55, "MeshExportPublication"]]);
    const epochs = yield* sql<{
      readonly export_epoch: string;
      readonly destination_digest: string | null;
      readonly publication: string;
    }>`SELECT * FROM mesh_export_epochs ORDER BY export_epoch`;
    assert.deepEqual(epochs, [
      { export_epoch: "epoch-active", destination_digest: null, publication: "paused" },
      { export_epoch: "epoch-old", destination_digest: null, publication: "paused" },
    ]);
    const states = yield* sql<{
      readonly status: string;
      readonly export_epoch: string;
      readonly cursor_sequence: number;
    }>`SELECT status, export_epoch, cursor_sequence FROM mesh_export_state`;
    assert.deepEqual(states, [
      { status: "disabled", export_epoch: "epoch-active", cursor_sequence: 42 },
    ]);
    const after =
      yield* sql`SELECT * FROM mesh_receipt_outbox ORDER BY export_epoch, stream_sequence`;
    assert.deepEqual(after, before);
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 55 }), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("a fresh database applies all migrations with no implicit export authorization", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const applied = yield* runMigrations();
    assert.deepEqual(applied, migrationManifest);
    const epochs = yield* sql`SELECT * FROM mesh_export_epochs`;
    const states = yield* sql`SELECT * FROM mesh_export_state`;
    const outbox = yield* sql`SELECT * FROM mesh_receipt_outbox`;
    assert.deepEqual(epochs, []);
    assert.deepEqual(states, []);
    assert.deepEqual(outbox, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
