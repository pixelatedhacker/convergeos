// @effect-diagnostics nodeBuiltinImport:off - Temporary protocol peers exercise real process and filesystem boundaries.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { afterEach, expect, it } from "@effect/vitest";

import { setCodexSkillEnabled } from "./codexSkillEnablement.ts";
import { probeCodexSkillsForCwd } from "./Layers/CodexProvider.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => NodeFSP.rm(directory, { recursive: true })),
  );
});

async function fixture() {
  const cwd = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codex-skill-config-")),
  );
  directories.push(cwd);
  const homePath = NodePath.join(cwd, "codex-home");
  const skillPath = NodePath.join(homePath, "skills", "review", "SKILL.md");
  await NodeFSP.mkdir(NodePath.dirname(skillPath), { recursive: true });
  await NodeFSP.writeFile(
    skillPath,
    "---\nname: review\ndescription: Review a change.\n---\nReview it.\n",
  );
  await NodeFSP.writeFile(
    NodePath.join(cwd, "app-server"),
    `
const NodeFSP = require("node:fs");
const NodePath = require("node:path");
const readline = require("node:readline");
const home = process.env.CODEX_HOME;
const state = NodePath.join(home, "enabled.json");
const skill = NodePath.join(home, "skills", "review", "SKILL.md");
const enabled = () => NodeFSP.existsSync(state) ? JSON.parse(NodeFSP.readFileSync(state, "utf8")) : true;
readline.createInterface({input: process.stdin}).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  switch (request.method) {
    case "initialize":
      result = {userAgent: "test-codex", codexHome: home, platformFamily: "unix", platformOs: "macos"};
      break;
    case "skills/list":
      result = {data: [{cwd: request.params.cwds[0], errors: [], skills: [
        {name: "review", path: skill, scope: "user", description: "Review", enabled: enabled()}
      ]}]};
      break;
    case "skills/config/write":
      if (process.env.REJECT_SKILL_WRITE !== "1") NodeFSP.writeFileSync(state, JSON.stringify(request.params.enabled));
      result = {effectiveEnabled: enabled()};
      break;
    default:
      process.stdout.write(JSON.stringify({id: request.id, error: {code: -32601, message: request.method}}) + "\\n");
      return;
  }
  process.stdout.write(JSON.stringify({id: request.id, result}) + "\\n");
});
`,
  );
  return { binaryPath: process.execPath, cwd, homePath, skillPath };
}

it.layer(NodeServices.layer)("Codex skill configuration", (it) => {
  it.effect("disables and re-enables the selected skill across fresh provider sessions", () =>
    Effect.gen(function* () {
      const input = yield* Effect.promise(fixture);
      yield* setCodexSkillEnabled({ ...input, enabled: false }).pipe(Effect.scoped);
      expect(yield* probeCodexSkillsForCwd(input).pipe(Effect.scoped)).toMatchObject([
        { path: input.skillPath, enabled: false },
      ]);
      yield* setCodexSkillEnabled({ ...input, enabled: true }).pipe(Effect.scoped);
      expect(yield* probeCodexSkillsForCwd(input).pipe(Effect.scoped)).toMatchObject([
        { path: input.skillPath, enabled: true },
      ]);
    }),
  );

  it.effect("refuses an undiscovered path without writing config", () =>
    Effect.gen(function* () {
      const input = yield* Effect.promise(fixture);
      const error = yield* setCodexSkillEnabled({
        ...input,
        skillPath: NodePath.join(input.cwd, "other", "SKILL.md"),
        enabled: false,
      }).pipe(Effect.scoped, Effect.flip);
      expect(error.message).toContain("no longer in");
      const entries = yield* Effect.promise(() => NodeFSP.readdir(input.homePath));
      expect(entries).not.toContain("enabled.json");
    }),
  );

  it.effect(
    "does not report success when provider policy leaves the effective state unchanged",
    () =>
      Effect.gen(function* () {
        const input = yield* Effect.promise(fixture);
        const error = yield* setCodexSkillEnabled({
          ...input,
          enabled: false,
          environment: { REJECT_SKILL_WRITE: "1" },
        }).pipe(Effect.scoped, Effect.flip);
        expect(error.message).toContain("did not apply");
      }),
  );
});
