# Skill and plugin management

The settings page sends environment-scoped RPC requests through the existing connection runtime. Web and desktop share the page; mobile has a native settings screen using the same contracts and client atoms. No marketplace index or client-local installer is introduced.

`server.getSkillStore` requires orchestration read access. `server.mutateSkillStore` requires orchestration operate access. Each request names a provider instance, plus an optional directory on the owning environment. The server resolves its current provider snapshot and settings. Account-specific environment variables, binary paths, and provider homes stay on the server.

## Provider capabilities

| Provider        | Skill inventory                                                | Import/remove copied packages                      | Existing skill enablement    | Plugins                                                           |
| --------------- | -------------------------------------------------------------- | -------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------- |
| Codex           | Existing provider discovery                                    | User shared home and project `.agents/skills`      | Native `skills/config/write` | Unsupported                                                       |
| Claude Code     | Existing provider discovery                                    | User config directory and project `.claude/skills` | Unsupported                  | Native CLI catalog and scoped install, enable, disable, uninstall |
| Cursor          | Existing provider discovery, including shared `.agents/skills` | User/project `.cursor/skills`                      | Unsupported                  | Unsupported                                                       |
| Other providers | Existing provider discovery where available                    | Unsupported                                        | Unsupported                  | Unsupported                                                       |

Codex overlays share the configured shared home's skills. Their import root is not the authentication overlay directory. Ambient `CODEX_HOME` applies only when direct mode has no configured home. Multiple instances using the same directory share package changes.

Imports validate the entry file's frontmatter, copy regular package contents into a temporary sibling directory, and rename the complete package into the provider root. A per-name directory lock serializes imports from this server; existing destinations are rejected. `.git`, `node_modules`, and old import metadata are excluded. Package limits are 1,000 entries and 20 MB. Symbolic links and special files are refused. An import marker records its original source, which remains untouched. Removal is confined to a direct child of a supported root and requires that marker; linked skill directories and unmanaged installations are refused.

The marker identifies ownership of a copied directory, not a security signature or an update ledger. There is no automatic source synchronization. The user confirms removal because edits inside an imported copy will be deleted.

Claude commands run against the selected instance's binary, environment, and directory. They have a two-minute timeout and bounded output. The manager does not pass `--yes` to bypass CLI approvals for command-based installs. The catalog parser keeps provider-reported errors visible, filters project installations by canonical directory, and preserves install candidates across scopes. Catalog listing is on demand with a 30-second client cache, not a subscription or background scan. Provider refresh completes before the client rereads the store after a mutation.

Native plugin changes are only claimed after successful command completion. Existing provider sessions may retain old packages. Codex skill changes are validated against a fresh native skill catalog and require enabled-state readback. The manager does not edit unsupported providers' enablement formats.

## Registry discovery and installation

# Skill store architecture

The skill store surfaces the [skills.sh](https://skills.sh) registry — the open agent-skills
ecosystem behind the `skills` CLI — inside ConvergeOS. Clients get discovery, detail, install,
uninstall, and per-harness enable/disable over RPC; each environment owns the record of what it
installed where.

## Discovery is HTTP, installation is the CLI

The two halves of the store use different mechanisms on purpose:

- **Discovery** (`skillStore.search`, `skillStore.getDetail`) is plain HTTP from the server to
  `skills.sh/api/search` and `skills.sh/api/download`, implemented in
  [SkillsRegistryClient.ts](../../apps/server/src/skillStore/SkillsRegistryClient.ts). Detail
  responses download the skill bundle and parse `SKILL.md` frontmatter for the description;
  individual file contents are capped (`SKILL_STORE_DETAIL_MAX_FILE_BYTES`) so a bundle cannot
  flood the wire.
- **Installation** runs the vendored `skills` npm package's CLI (`bin/cli.mjs`) under
  `process.execPath`, wrapped by
  [SkillsCli.ts](../../apps/server/src/skillStore/SkillsCli.ts). Per-harness directory layouts
  (`~/.claude/skills`, `.agents/skills`, and so on) change as harnesses evolve; delegating them
  to the upstream CLI keeps that maintenance burden out of this repo. The CLI is invoked with
  `--global` for environment scope or in the project's `workspaceRoot` for project scope, and
  `--agent <harness>` once per selected harness.

## State lives in a per-environment manifest, not the event store

Installed skills are local file layout, not orchestration domain state, so they do not go
through the decider/projector pipeline.
[SkillStoreService.ts](../../apps/server/src/skillStore/SkillStoreService.ts) keeps a
`skill-store.json` manifest in the environment's state directory, holds it in a `Ref`,
serializes mutations through a `Semaphore`, and writes atomically. The manifest maps each skill
(`<source>/<skillId>`) to its install targets: a scope (`global` or one `projectId`) times the
harnesses enabled there.

`skillStore.setHarnessEnabled` toggles one harness inside one target: enabling re-runs the CLI
add for that harness, disabling removes it from that harness only. `skillStore.uninstall`
removes the skill from every target and drops the manifest record. Both refresh the provider
registry afterwards so newly installed skills show up in running sessions' tool surfaces.

## Multi-environment fan-out is a client concern

Every RPC is scoped to the environment the client is connected to. The web UI
([SkillStorePage.tsx](../../apps/web/src/components/skills/SkillStorePage.tsx)) implements
"install to these three machines" by issuing one `skillStore.install` per selected environment
and reporting per-environment outcomes; project scope pins the install to the environment that
owns the project. Read-side, the installed list is a per-environment query atom
(`skillStoreInstalled` in
[server.ts](../../packages/client-runtime/src/state/server.ts)) so each environment's manifest
caches and refreshes independently.

## Contracts and authorization

Schemas and the harness mapping live in
[skillStore.ts](../../packages/contracts/src/skillStore.ts). `SkillStoreHarness` is the set of
`skills` CLI agent slugs the store offers; `SKILL_STORE_HARNESS_BY_DRIVER_KIND` maps provider
driver kinds onto them, and drivers without a mapping stay hidden in the UI. Search, detail,
and list require the read scope; install, uninstall, and harness toggles require the operate
scope (see [RpcAuthorization.ts](../../apps/server/src/auth/RpcAuthorization.ts)).
