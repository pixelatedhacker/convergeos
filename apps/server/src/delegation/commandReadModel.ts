import type { Delegation, OrchestrationEvent, OrchestrationReadModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { OrchestrationProjectorDecodeError } from "../orchestration/Errors.ts";
import { projectEvent } from "../orchestration/projector.ts";

export interface DelegationCommandReadModel extends OrchestrationReadModel {
  readonly delegations?: ReadonlyArray<Delegation>;
}

export type DelegationDecisionReadModel = OrchestrationReadModel & {
  readonly delegations?: ReadonlyArray<Delegation>;
};

export function projectCommandEvent(
  model: DelegationCommandReadModel,
  event: OrchestrationEvent,
): Effect.Effect<DelegationCommandReadModel, OrchestrationProjectorDecodeError> {
  switch (event.type) {
    case "delegation.requested":
    case "delegation.provision-started":
    case "delegation.target-bound":
    case "delegation.turn-requested":
    case "delegation.turn-bound":
    case "delegation.completed":
    case "delegation.failed":
    case "delegation.interrupted": {
      const delegation = event.payload.delegation;
      return Effect.succeed({
        ...model,
        snapshotSequence: event.sequence,
        updatedAt: event.occurredAt,
        delegations: [
          ...(model.delegations ?? []).filter((entry) => entry.id !== delegation.id),
          delegation,
        ],
      });
    }
    default:
      return projectEvent(model, event).pipe(
        Effect.map((next) =>
          model.delegations === undefined ? next : { ...next, delegations: model.delegations },
        ),
      );
  }
}
