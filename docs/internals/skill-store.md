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
