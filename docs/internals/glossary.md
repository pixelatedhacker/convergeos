# Glossary

Terms whose meaning matters across ConvergeOS. Architecture and lifecycle constraints belong in the
[overview](./overview.md), not in these definitions.

## Workspace and conversation

| Term           | Meaning                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Environment    | One running server and the machine, credentials, workspace access, and state it owns.                                                                                                 |
| Client         | A web, desktop, or mobile UI connected to an environment. The desktop app can also host a server.                                                                                     |
| Project        | An environment-local workspace record rooted at a directory.                                                                                                                          |
| Workspace root | The project's base filesystem directory on the environment.                                                                                                                           |
| Worktree       | A separate Git checkout a thread can use instead of the project's main checkout. The environment can also inventory checkouts that no thread claims. See [worktrees](./worktrees.md). |
| Thread         | The durable conversation and work history for a project. It survives provider process exits.                                                                                          |
| Turn           | One user-to-agent work cycle. Provider work can finish before checkpoint and diff work settles.                                                                                       |
| Activity       | A non-message timeline item, such as a tool action, approval, or failure.                                                                                                             |
| T3 home        | The base data directory. Runtime state normally lives under its `userdata` directory.                                                                                                 |

## Orchestration

| Term                    | Meaning                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Command                 | A request to change domain state. Accepting it does not mean its side effects have finished. |
| Event                   | A persisted fact produced by a command.                                                      |
| Decider                 | The pure logic that turns a command and current state into events.                           |
| Projection / read model | A view of current state derived from persisted events.                                       |
| Projector               | The logic that applies events to a read model.                                               |
| Reactor                 | A worker that performs follow-up work in response to recorded intent or runtime signals.     |
| Command receipt         | A durable record of a command's result, used to make retries idempotent.                     |
| Runtime receipt         | A test-only signal that an asynchronous milestone completed.                                 |
| Quiesced                | The relevant follow-up workers have finished, beyond the provider turn merely ending.        |

## Providers and checkpoints

| Term                | Meaning                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Provider            | The agent runtime ConvergeOS controls, such as Codex or Claude Code.                                         |
| Driver              | The integration for a provider kind.                                                                         |
| Provider instance   | One configured provider, with its own settings and lifecycle. Multiple instances can use the same driver.    |
| Adapter             | The boundary translating a provider's native protocol into ConvergeOS operations and events.                 |
| Session             | The provider runtime attached to a thread. A session can be stopped and resumed without deleting the thread. |
| Runtime mode        | The thread's permission policy. See [permission modes](../user/permission-modes.md).                         |
| Interaction mode    | How the agent approaches the task, such as planning. Separate from permission policy.                        |
| Checkpoint          | A saved workspace state used for diffs and restore, stored as a hidden Git ref.                              |
| Checkpoint baseline | The workspace state captured before the work being compared.                                                 |
| Turn diff           | The workspace changes attributed to one turn.                                                                |

## Pull requests

| Term                 | Meaning                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull request link    | A persisted thread association identified by host, repository, and number. Links can cross projects within an environment and carry a server-maintained snapshot.                        |
| Pull request sync    | The reactor that refreshes each distinct linked review once per cadence and discovers native stack layers. Explicit refreshes and failed stack reads trigger another read.               |
| Current pull request | The link used by single-review controls and older clients. Open work takes precedence; a completed single chain points at its top layer. Unrelated terminal links use the latest update. |

## Composer context

| Term                 | Meaning                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Context record       | The typed payload behind a composer chip, keyed by `contextId` in `message.context.records`. It never holds bytes.                  |
| Context reference    | One occurrence of a record in message text: `[label](t3-context://v1/<kind>/<contextId>)`. Several references can share one record. |
| Attachment binding   | The link from an image or file record to its server-owned attachment. Its attachment ID can change without changing `contextId`.    |
| Attachment inventory | The ordered image records shown as thumbnails above the prose, including images with no inline references.                          |

See [composer context references](./composer-context-references.md) for the contract and lifecycle.

## Pages

Pages are durable homes for generated websites, reports, and small tools. See [pages.md](pages.md).

#### Page

A saved result owned by one environment and optionally one project. A page holds a title, a kind (`htmlDocument` or `hostedUrl`), source-thread provenance, and a current content revision. Unfiled pages have no project yet. Archive is reversible and preserves content and history. See the Page contract and the decider.

#### Page revision

An immutable publication of a page's content. Managed HTML references content-addressed bytes stored under the environment's userdata; hosted URLs reference an external site without a durability guarantee. Restoring an older revision appends a new publication instead of rewriting history.

#### Maintainer

The bot thread assigned to keep a page up to date. The maintainer reference is stored on the page; maintenance dispatch and schedules are part of page maintenance and reuse the existing orchestration lifecycle.


## Skill store

The skill store surfaces the skills.sh registry inside ConvergeOS. See [skill-store.md](skill-store.md).

#### Skill

A third-party agent capability bundle (a `SKILL.md` plus supporting files) installed from the skills.sh registry. Identified by `<owner>/<repo>/<skillId>`. Discovery is HTTP against the registry; installation runs the vendored `skills` CLI on the target environment.

#### Harness

An install target for skills, named by its `skills` CLI agent slug (`claude-code`, `codex`, `cursor`, `grok`, `opencode`, `antigravity`). Provider driver kinds map onto harnesses via `SKILL_STORE_HARNESS_BY_DRIVER_KIND` in [the skill store contracts][27]; drivers without a mapping are not valid install targets.

#### Skill store manifest

The per-environment record of installed skills, `skill-store.json` in the environment's state directory, owned by [SkillStoreService.ts][28]. It maps each skill to its targets (global or one project, times a set of harnesses) and is plain local state, not orchestration events.

### Checkpointing

Checkpointing captures workspace state over time so the app can diff turns and restore earlier points. The main pieces are [CheckpointStore.ts][19], [CheckpointDiffQuery.ts][20], and [CheckpointReactor.ts][6].

#### Checkpoint

A saved snapshot of a thread workspace at a particular turn. In practice it is a hidden Git ref in [CheckpointStore.ts][19] plus a projected summary from [ProjectionCheckpoints.ts][21]. Capture and lifecycle work happen in [CheckpointReactor.ts][6].

#### Checkpoint ref

The durable identifier for a filesystem checkpoint, stored as a Git ref. It is typed in [the contracts][1], constructed in [Utils.ts][22], and used by [CheckpointStore.ts][19].

#### Checkpoint baseline

The starting checkpoint for diffing a thread timeline. This flow is surfaced through [RuntimeReceiptBus.ts][13], coordinated in [CheckpointReactor.ts][6], and supported by [Utils.ts][22].

#### Checkpoint diff

The patch difference between two checkpoints. Query logic lives in [CheckpointDiffQuery.ts][20], diff parsing lives in [Diffs.ts][23], and finalization is coordinated by [CheckpointReactor.ts][6].

#### Turn diff

The file patch and changed-file summary for one turn. It is usually computed in [CheckpointDiffQuery.ts][20], represented in [the contracts][1], and recorded into thread state by [projector.ts][4].

### Appearance

#### Environment theme

A theme an environment's machine publishes for clients to follow, one file per theme under `themes/` in that environment's state directory; the filename is the theme id. [environmentTheme.ts][25] watches the directory and streams the set over `subscribeServerConfig`; clients render each as a library card, generating a full palette when the file carries seed colors and using the palette directly when it is a standard exported theme file. A desktop that retints its apps when the system theme changes rewrites its file, so ConvergeOS follows along without a restart. See [environment-theme.md][26].

#### Default theme

The environment's theme, held in its `settings.json` as `defaultTheme` (with `defaultThemeSetAt`
as the set-generation) and set with `t3 theme set <id>`. Web and desktop clients apply each set
once — live when connected, on the next connect otherwise — so setting it switches them, while a
theme a user picks in Settings afterwards sticks until the next set; mobile keeps its own
appearance settings. Naming a published [environment theme](#environment-theme) is how a desktop
ships ConvergeOS already matching it.

## Practical Shortcuts

- If you see `requested`, think "intent recorded".
- If you see `completed`, think "result applied".
- If you see `receipt`, think "async milestone signal, for tests".
- If you see `checkpoint`, think "workspace snapshot for diff/restore".
- If you see `quiesced`, think "all relevant follow-up work has gone idle".

## Related Docs

- [Architecture overview][24]
- [Provider architecture][16]
- [Permission modes][18]
- [Workspace layout][2]

[1]: ../../packages/contracts/src/orchestration.ts
[2]: ./workspace-layout.md
[3]: ../../apps/server/src/vcs/GitVcsDriverCore.ts
[4]: ../../apps/server/src/orchestration/projector.ts
[5]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[6]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
[7]: ../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts
[8]: ../../apps/server/src/orchestration/decider.ts
[9]: ../../apps/server/src/orchestration/commandInvariants.ts
[10]: ../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts
[11]: ../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts
[12]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[13]: ../../apps/server/src/orchestration/Services/RuntimeReceiptBus.ts
[14]: ../../apps/server/src/provider/Layers/ProviderService.ts
[15]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[16]: ./providers.md
[17]: ../../apps/server/src/provider/Layers/CodexAdapter.ts
[18]: ../user/permission-modes.md
[19]: ../../apps/server/src/checkpointing/CheckpointStore.ts
[20]: ../../apps/server/src/checkpointing/CheckpointDiffQuery.ts
[21]: ../../apps/server/src/persistence/Services/ProjectionCheckpoints.ts
[22]: ../../apps/server/src/checkpointing/Utils.ts
[23]: ../../apps/server/src/checkpointing/Diffs.ts
[24]: ./overview.md
[25]: ../../apps/server/src/environmentTheme.ts
[26]: ../user/environment-theme.md
[27]: ../../packages/contracts/src/skillStore.ts
[28]: ../../apps/server/src/skillStore/SkillStoreService.ts
