---
name: agent-orchestrator
description: Orchestrate multi-agent work in ConvergeOS using the native MCP Agent Mesh. Discover configured models, spawn isolated workers in dedicated Git worktrees, enforce inline task prompting with conventional commits, integrate completed worker branches from typed mesh metadata, launch clean-room adversarial auditors, and clean up temporary worktrees.
---

# Agent Orchestrator

Use this skill when a task spans multiple context windows, requires heavy multi-file edits, benefits from worker specialization (e.g., fast execution or AST-aware patching via Oh My Pi), or requires an unbiased clean-room adversarial audit before finalizing.

Do not use this skill for trivial edits, single-file typo fixes, or tasks that the lead can execute directly in seconds without delegation overhead.

---

## 1. Prerequisites & Access

Agent mesh tools are capability-gated:
- **Enable the feature**: Turn on **Settings → Integrations → Agents → Agent mesh access** in the web or desktop client. (Mobile clients can observe thread activity but cannot toggle the server permission yet).
- **Session boundary**: The toggle applies to provider sessions started after it changes. A running agent keeps the tools it was given, and a new turn on an existing thread reuses that thread's session. After toggling, start a new thread to get the tools.
- **Project boundary**: All mesh operations (`agents_models`, `agents_list`, `agents_read`, `agents_spawn`, `agents_send`, `agents_wait`, `agents_interrupt`) are strictly scoped to the caller's project. The server collapses cross-project and non-existent targets into the same `targetUnavailable` error.

---

## 2. Mesh Tool Reference

| Tool | Role | Key Parameters | Return Values / Behavior |
| :--- | :--- | :--- | :--- |
| `agents_models` | Dynamic capability discovery | `query`, `instanceId`, `offset`, `limit` | Returns configured provider instances, models, auth readiness, supported runtime modes, and `capabilities.optionDescriptors`. *Note*: Cached entries are not execution receipts; option keys differ per driver (`effort`, `reasoningEffort`, `thinking`, `variant`). |
| `agents_spawn` | Provision isolated worker | `requestId`, `title`, `task`, `modelSelection` | Provisions a new worker thread and temporary Git worktree on a `convergeos/<8 hex>` branch (the code still emits the legacy `t3code/` prefix until the ref rename lands; treat both as temporary), branched from `caller.branch`. The worker inherits the caller's model unless `modelSelection` is supplied, and always inherits the caller's runtime mode. Returns `delegationId`, `targetThreadId`, `state`. |
| `agents_send` | Dispatch to existing bot | `requestId`, `targetThreadId`, `message` | Dispatches one turn to an idle bot thread with an existing distinct worktree. Rejects with `targetBusy` if the bot is running or has an open delegation. |
| `agents_wait` | Bounded event-driven wait | `delegationIds` (1–8), `timeoutMs` (max 50,000), `maxChars` (256–32,000, default 8,000) | Waits on event streams without busy-polling. Resolves on `completed`, `failed`, `interrupted`, `attention`, or `timeout`. Output text is automatically capped. |
| `agents_read` | Inspect thread state | `targetThreadId`, `maxChars` | Reads thread status, checked-out `branch`, configured model selection, and bounded latest assistant output from any agent in the project. |
| `agents_interrupt`| Abort runaway turn | `requestId`, `targetThreadId`, `observedTurnId` | Interrupts the exact turn ID previously observed. Fails if the target moved to a newer turn. |

---

## 3. The Worker Contract: Inline Prompting & Commit Refs

### A. Why Workers Require Inline Prompts
Claude Code and Codex discover `.agents/skills/`, but other provider harnesses (Cursor, Grok, OpenCode, Antigravity, Oh My Pi) do not. **Never assume a spawned worker has access to repository skills.**

The lead must package the complete specification, constraints, test commands, and verification criteria directly into the `task` parameter of `agents_spawn`.

### B. Why Workers Must Commit
ConvergeOS checkpoints are hidden refs under `refs/convergeos/checkpoints/` (legacy `refs/t3/checkpoints/` until the ref rename lands), not commits on the worker's branch. Uncommitted changes in the worker's worktree are invisible to a `git merge` from the lead.

### C. The Branch Discovery Protocol
`AgentMeshWaitResult` returns `latestAssistant.text`, but does not expose the worker's branch name or worktree path. `agents_read` exposes the checked-out `branch` as typed metadata; use it instead of trusting prose from the worker.

**Every delegation task prompt must conclude with this instruction:**

```markdown
When your task is complete and tests pass:
1. Run the test suite to verify your changes.
2. Stage and commit everything, including new files, with a conventional commit:
   `git add -A && git commit -m "<type>(<scope>): <description>"`
3. Conclude your final assistant response with exactly this line:
   COMMIT: <HEAD commit hash>
```

---

## 4. End-to-End Orchestration Lifecycle

### Step 1: Discover Capabilities
Do not hardcode static model names. Call `agents_models` to inspect available options:
- Match high-reasoning tasks (scoping, architectural review) to models supporting high `effort` (e.g. `ultrathink`, `xhigh`).
- Match deterministic syntax edits to fast models or specialized engines (e.g. Oh My Pi via ACP).

### Step 2: Spawn the Worker
Call `agents_spawn`:
- Pass a deterministic `requestId` (reusing it safely resumes on retry).
- Select the worker model in `modelSelection`.
- Embed full task requirements, test commands, and the commit conclusion contract into `task`.

### Step 3: Wait for Completion & Handle Outcomes
Call `agents_wait([delegationId])`:
- **`reason === "completed"`**:
  Call `agents_read` with the returned `targetThreadId` and read its typed `branch` field.
  Parse `COMMIT: <hash>` from `latestAssistant.text`, then confirm both the commit and its
  membership on that branch with `git log -1 <hash>` and
  `git merge-base --is-ancestor <hash> <branch>`.
- **`reason === "attention"`**:
  The worker is paused waiting for user approval or input (workers inherit `caller.runtimeMode`). Because no MCP tool can approve on its behalf, **alert the user immediately in the UI**:
  > *"Worker thread `<targetThreadId>` is waiting for approval. Please approve the prompt in the UI to allow delegation to proceed."*
  Once approved by the user, re-enter `agents_wait`.
- **`reason === "timeout"`**:
  Call `agents_read` to check if the worker is still actively generating. If still working, re-enter `agents_wait`.
- **`reason === "failed"`**:
  Inspect `failure` in the returned delegation view. Do not merge broken code. Diagnose the failure and spawn a replacement or abort.

### Step 4: Integrate the Worker Branch
Record the pre-merge base first; the auditor needs it. Then merge in the lead's working directory:
```sh
BASE=$(git rev-parse HEAD)
git merge <worker-branch>
```
*Note*: `agents_spawn` only branches from `caller.branch` (`apps/server/src/delegation/DelegationService.ts:765`). Merging the worker branch into `caller.branch` is **mandatory** before spawning an auditor; otherwise, the auditor will land on the lead's original commit and miss the worker's changes.

### Step 5: Clean-Room Adversarial Audit
To eliminate self-confirmation bias, spawn a fresh auditor with zero prior conversational history:
- Call `agents_spawn` with a reviewer model, preferably from a different provider than the author (e.g. Codex or Antigravity if Claude authored).
- Because `caller.branch` now contains the merged worker changes, the auditor's worktree automatically branches from the new HEAD.
- The auditor's worktree is a fresh checkout with no diff context. Pass the base and the worker commits inline:
  ```markdown
  Audit the changes between <BASE> and HEAD on this branch. Worker commits: <COMMIT hashes>.
  1. Run `git diff <BASE>..HEAD --stat` to scope the review, then read the full diff.
  2. Run focused unit and integration tests for the touched files.
  3. Check for dead weight, unnecessary abstractions, or missing error handling.
  4. Output a pass/fail report with concrete verification evidence.
  ```
- Wait for the audit pass via `agents_wait([auditDelegationId])`.
- If the audit fails, revert or dispatch a fix ticket.

### Step 6: Post-Audit Cleanup
ConvergeOS does not delete temporary worktrees when a turn completes. The worker thread still references its worktree, and the provider command reactor recreates a missing worktree from the thread's branch the next time that thread receives a command (`apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:472`). Removing the worktree or branch while the thread is live therefore breaks the thread. Order matters:
1. Archive or delete the worker and auditor threads in ConvergeOS so nothing references the worktrees.
2. List active worktrees: `git worktree list`
3. Remove the temporary worktrees: `git worktree remove <worktree-path>`
4. Delete the temporary branches: `git branch -d <worker-branch>`

---

## 5. Error & Rejection Matrix

| Error Reason | Cause | Corrective Action |
| :--- | :--- | :--- |
| `targetBusy` | Target bot is running a turn or already has an open delegation. | Only occurs on `agents_send`. Wait for the bot to finish, or use `agents_spawn` to create an ephemeral worker instead. |
| `workspaceShared` | Source and target share the same working directory. | Peer delegations require distinct worktrees. Spawn an isolated thread with `agents_spawn`. |
| `targetNotBot` | Target thread exists but has no active bot profile. | Call `agents_list(onlyBots: true)` to discover valid bot inboxes, or spawn an ephemeral thread. |
| `capabilityDenied` | `enableAgentMeshAccess` is disabled on the server. | Inform the user to enable Agent Mesh access in Settings. |
| `repositoryUnavailable` | Caller thread has no Git branch, typically a detached HEAD. | Check out a branch in the lead's worktree before delegating. |
| `provisionFailed` | Server could not create the worker's worktree or branch. | Inspect server logs; a stale worktree admin entry is the usual cause. `git worktree prune` in the workspace root clears it. |
