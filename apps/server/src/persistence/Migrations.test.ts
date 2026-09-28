import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { migrationManifest, runMigrations } from "./Migrations.ts";

// Deployed ConvergeOS databases record these IDs; they must never be renumbered.
const deployedIds = [
  [56, "TaskBudgets"],
  [57, "ProjectionThreadBranchPullRequest"],
  [62, "PullRequestFilesViewed"],
  [63, "ProjectionPages"],
] as const;

const deployedMaxId = 63;

it("migration IDs are unique and strictly ascending", () => {
  const ids = migrationManifest.map(([id]) => id);
  assert.deepEqual(
    ids,
    ids.toSorted((left, right) => left - right),
  );
  assert.strictEqual(new Set(ids).size, ids.length);
  for (const [index, id] of ids.entries()) {
    assert.strictEqual(id, index + 1);
  }
});

it("keeps the IDs already recorded by deployed databases", () => {
  const manifest = new Map<number, string>(migrationManifest);
  for (const [id, name] of deployedIds) {
    assert.strictEqual(manifest.get(id), name);
  }
});

it.effect("a database at the deployed max ID applies exactly the newer migrations", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: deployedMaxId });
    const applied = yield* runMigrations();
    assert.deepEqual(
      applied,
      migrationManifest.filter(([id]) => id > deployedMaxId),
    );
    assert.isTrue(applied.length > 0);
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
    assert.isTrue(columns.some((column) => column.name === "auto_settle_disabled_at"));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("a fresh database applies every migration", () =>
  Effect.gen(function* () {
    const applied = yield* runMigrations();
    assert.deepEqual(applied, migrationManifest);
    assert.deepEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
