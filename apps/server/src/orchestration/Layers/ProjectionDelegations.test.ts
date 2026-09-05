import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DelegationId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const layer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("delegation projection queries", (it) => {
  it.effect("reads exact delegations and only open work for a target", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      if (query.getDelegations === undefined || query.getOpenDelegationsForTarget === undefined) {
        throw new Error("delegation projection queries are unavailable");
      }

      yield* sql`
        INSERT INTO projection_delegations (
          delegation_id, project_id, requester_json, target_json, title, task, state,
          target_thread_id, turn_id, assistant_message_id, failure_json, revision,
          created_at, updated_at
        ) VALUES
          (
            'delegation-open', 'project-1',
            '{"kind":"thread","threadId":"parent","requestId":"audit-1"}',
            '{"kind":"existingThread","threadId":"worker"}',
            'Open audit', 'Audit it.', 'running', 'worker', 'turn-1', NULL, NULL, 3,
            '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:02.000Z'
          ),
          (
            'delegation-done', 'project-1',
            '{"kind":"thread","threadId":"parent","requestId":"audit-2"}',
            '{"kind":"existingThread","threadId":"worker"}',
            'Done audit', 'Audit it.', 'completed', 'worker', 'turn-2', 'answer-2', NULL, 4,
            '2026-09-05T00:00:03.000Z', '2026-09-05T00:00:06.000Z'
          )
      `;

      const selected = yield* query.getDelegations([
        DelegationId.make("delegation-done"),
        DelegationId.make("delegation-open"),
      ]);
      assert.deepEqual(
        selected.map((delegation) => delegation.id),
        ["delegation-open", "delegation-done"],
      );

      const open = yield* query.getOpenDelegationsForTarget(ThreadId.make("worker"));
      assert.deepEqual(
        open.map((delegation) => delegation.id),
        ["delegation-open"],
      );

      const commandModel = yield* query.getCommandReadModel();
      assert.equal(commandModel.delegations?.length, 2);
    }),
  );
});
