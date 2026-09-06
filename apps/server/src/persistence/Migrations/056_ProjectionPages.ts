import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_pages (
      page_id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_thread_id TEXT,
      maintainer_thread_id TEXT,
      current_revision_id TEXT NOT NULL,
      current_revision INTEGER NOT NULL,
      metadata_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_pages_project
    ON projection_pages(project_id, archived_at, updated_at, page_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_page_revisions (
      revision_id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      predecessor_revision_id TEXT,
      revision INTEGER NOT NULL,
      content_json TEXT NOT NULL,
      data_at TEXT,
      author_json TEXT NOT NULL,
      accepted_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_page_revisions_page
    ON projection_page_revisions(page_id, revision)
  `;
});
