# Managed task admission budgets

`budgets/TaskBudgets.ts` shares the orchestration SQLite database. The engine applies budget changes within the existing event/projection/command-receipt transaction. There is no second work queue or scheduler. The command receipt is checked first, so an accepted retry neither spends again nor republishes a turn-start event.

## Durable ownership

`task_budget_policies` stores the last accepted host policy. `task_budget_threads` stores immutable root ownership. `task_budget_reservations` stores a managed turn or pending delegation's charge and execution state. These are admission records, not disposable projections: retain them when rebuilding read models.

The optional `<ServerConfig.stateDir>/task-budgets.json` uses the `TaskBudgetConfiguration` contract. Only filesystem administrators configure it; there is no policy-write MCP or client RPC. Policy changes retain consumed charges, and absent configuration retains accepted policies. Activation on an active root or a root with delegation history fails closed. The feature does not retroactively account for previous work.

`delegation.request` reserves before provisioning. A new worker receives root ownership at provisioning/target binding. Existing workers are bound during reservation. Later direct turns and grandchildren inherit that binding, even without a delegation ID. Assigning an already-bound thread to a different root fails. Kanban-write MCP is denied for budgeted callers until runnable card ownership can inherit the calling task; its read path remains available.

The root has one coordinator slot. `maxConcurrentWorkers` counts non-root reservations, including provisioning, waiting workers, and uncertain launches. This makes one coordinator plus N worker slots explicit without pretending that a waiting provider is no longer active.

## Admission and dispatch

The serialized engine checks calls, consultation allowance, concurrency, selected instance/model, a host-clock deadline, and token reservations. Consultation rules come from the explicit model allowlist. The resolved model selection is frozen into the persisted turn-start event.

A reservation moves through:

```text
reserved -> dispatched -> launching -> finished
     |           |
     +-----------+-------------------> finished (definite no-launch outcome)
```

`dispatched` means the launch event was accepted. Its exact command ID is persisted. After worktree/session preparation, `ProviderCommandReactor` calls `claimDispatch` immediately before calling `ProviderService.sendTurn`. This transaction rechecks deadline, selected model, and identity, then marks `launching`. A repeated or recovered `launching` event cannot claim again. A crash between claim and send is conservatively uncertain, even if no provider actually started.

Known no-launch failures release only an exact still-unclaimed dispatch reservation. Send failures after claim do not release capacity. A cancellation request, session reset, heartbeat, or relay timeout is not proof of terminal execution. `thread.session.set` binds a provider turn ID to the claimed reservation; PR21's exact `invocation.finished` activity releases the matching turn. A missing turn identity retains capacity for diagnosis. Completion and usage bookkeeping do not parse policy configuration, so malformed files cannot block terminal acknowledgement.

Automatic first-turn title and branch-name generation is skipped for budgeted turns. Native harness loops/subagents, shell subprocesses, explicit standalone text generation, other independently launched roots, and other environments remain outside managed-turn admission.

## Token accounting

Each allowlisted instance/model has a conservative `reserveTokens`. Admission commits that amount. `invocation.usage` updates only the matching thread/turn to `max(previousCharge, sum(inputTokens + outputTokens))`; input includes cache, output includes reasoning. Native child counters are never added separately. Replays and duplicate reports do not multiply charges. No report refunds the host reservation, including complete reports. Partial or reporting-window usage can therefore overcharge, which is preferable to manufacturing available capacity from incomplete evidence.

Actual usage above reservations can arrive after another call has started. The allowance blocks subsequent admission once the known charge no longer fits; it is not a universal output-token or subscription hard stop. Future subscription accounting should continue to use the separate quota and invocation-statistics contracts, with model identity, partial coverage and unknowns preserved.

## Read surface and trust

`budget_status({})` requires `usage.read`, binds to the MCP credential's thread, and returns `TaskBudgetStatus`. It never accepts a caller-supplied root or changes policy. Model IDs in policy describe admitted selections, not proof of provider-side routing; usage receipts remain the source for actual reported models.

The enforcement boundary is the owning host's managed dispatcher. Host administrator edits are trusted. A full-access agent with the same OS identity can tamper with host files or invoke providers directly. Policy files are not a security sandbox.

Focused tests cover parallel pending reservations, command-receipt replay, event transaction rollback, model freezing, inherited/direct descendant calls, consultation classification, known token overruns and report replay, host-clock deadline boundaries and a deadline shortened during real provider preparation, terminal acknowledgement with invalid configuration, real SQLite close/reopen, MCP scope, and the Kanban escape route.
