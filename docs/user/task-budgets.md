# Task budgets

A task budget limits provider turns launched through ConvergeOS on one environment. Its workers inherit the same allowance. Budgets are optional and disabled unless the environment administrator configures one.

A **call** is one managed provider turn, which may contain many model requests and tool calls inside the provider. The limits do not count each internal request separately.

## Configure an idle task

Create an idle thread and copy its thread ID. Configure the budget before starting work or creating any delegations from that thread. ConvergeOS rejects first activation on an active thread or one with delegation history because it cannot safely account for the earlier work.

On the environment running the providers, save `task-budgets.json` beside that environment's `settings.json` and `state.sqlite`, normally under `userdata` in the ConvergeOS home directory. For a development environment, use its isolated state directory. No policy file is created automatically.

```json
{
  "version": 1,
  "policies": [
    {
      "rootThreadId": "YOUR_THREAD_ID",
      "maxCalls": 20,
      "maxConsultations": 2,
      "maxConcurrentWorkers": 3,
      "deadline": "2030-01-01T18:00:00.000Z",
      "maxTokens": 600000,
      "models": [
        {
          "instanceId": "codex",
          "model": "YOUR_WORKER_MODEL_ID",
          "consultation": false,
          "reserveTokens": 20000
        },
        {
          "instanceId": "claude",
          "model": "YOUR_REVIEW_MODEL_ID",
          "consultation": true,
          "reserveTokens": 60000
        }
      ]
    }
  ]
}
```

Replace the thread, configured provider-instance, model, and deadline values. Only the listed instance/model combinations are allowed. A consultation is a call to a model marked `consultation: true`; the agent cannot avoid that charge by calling its task a review or implementation.

The root coordinator has one execution slot separate from the worker limit. Pending provisioning and uncertain launches occupy worker slots. Nested workers also occupy slots while waiting for their children, so allow enough slots for the intended depth.

Limits are checked when work is admitted and the deadline is checked again immediately before the provider turn is sent. Crossing the deadline blocks new dispatches; it does not cancel an already running turn.

## Read or adjust a budget

Agents with usage access can call `budget_status` with no arguments. It reports the inherited policy, managed calls, consultations, occupied coordinator and worker slots, committed tokens, and whether the host deadline has passed. The tool cannot edit limits or choose another task's budget.

The administrator can edit the policy file to change limits. Use an atomic file replacement to avoid a reader observing half-written JSON. Invalid configuration blocks new work. Removing a policy or its file preserves the last accepted policy and its durable charges. Re-adding the same root does not reset its counters. To start a new allowance, create a new idle root thread.

A failed provisioning attempt or a provider dispatch rejected before launch releases concurrency capacity but retains its call and token charge. An uncertain launch or requested cancellation retains capacity until the provider acknowledges a terminal turn. A restart does not erase pending work or automatically relaunch an uncertain invocation.

## Tokens and subscription usage

Each admitted call commits its configured token reservation. If the provider later reports more input plus output tokens, the charge increases to that observed amount. Cache and reasoning subsets are not added again. Duplicate reports do not increase the charge, and smaller, missing, partial, or reporting-window reports never refund it.

This is a conservative allowance for admitting future work, not an exact token cutoff. A running call can exceed its reservation before usage arrives. Reporting windows can include background work and may conservatively charge it again across separate invocations. These figures are not a conversion into subscription percentages or billed dollars. Use `usage_delegations` for the saved model statistics and `usage_snapshot` for separate live subscription quota.

## Boundaries

These controls cover ConvergeOS-managed turns on the owning environment, including direct follow-up turns on bound workers. They do not restrict shell-launched CLIs, native provider subagents, internal model/tool loops, separately launched tasks, or other environments. Automatic title and branch-name model generation is skipped for budgeted turns; other explicitly requested text-generation features are outside this allowance.

Budgeted agents cannot mutate Kanban cards through MCP because that could create work outside their inherited task. They can still read the board and use the managed agent tools for delegation.

Only the host administrator should modify the policy file. A local agent with unrestricted filesystem or administrator access can modify server-owned files or use another launch route. This feature is not an isolation boundary against such a process.
