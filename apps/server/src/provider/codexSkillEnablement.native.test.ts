// @effect-diagnostics nodeBuiltinImport:off - Opt-in native CLI verification uses a disposable provider home.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";
import { setCodexSkillEnabled } from "./codexSkillEnablement.ts";
import { probeCodexSkillsForCwd } from "./Layers/CodexProvider.ts";

const binaryPath = process.env.CONVERGEOS_TEST_CODEX_BINARY;
it.layer(NodeServices.layer)("Native Codex skill configuration", (it) => {
  it.effect.skipIf(!binaryPath)("persists enablement in a disposable provider home", () =>
    Effect.gen(function* () {
      if (!binaryPath)
        throw new Error("Set CONVERGEOS_TEST_CODEX_BINARY to run the native CLI check.");
      const cwd = yield* Effect.acquireRelease(
        Effect.promise(async () =>
          NodeFSP.realpath(
            await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codex-skill-native-")),
          ),
        ),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      );
      const homePath = NodePath.join(cwd, "codex");
      const skillPath = NodePath.join(homePath, "skills", "native-review", "SKILL.md");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(skillPath), { recursive: true });
        await NodeFSP.writeFile(
          skillPath,
          "---\nname: native-review\ndescription: Review a local change.\n---\nReview it.\n",
        );
      });
      const input = { binaryPath, cwd, homePath, skillPath, environment: { HOME: cwd } };
      const before = yield* probeCodexSkillsForCwd(input).pipe(Effect.scoped);
      expect(before.find((skill) => skill.path === skillPath)?.enabled).toBe(true);
      yield* setCodexSkillEnabled({ ...input, enabled: false }).pipe(Effect.scoped);
      const disabled = yield* probeCodexSkillsForCwd(input).pipe(Effect.scoped);
      expect(disabled.find((skill) => skill.path === skillPath)?.enabled).toBe(false);
      yield* setCodexSkillEnabled({ ...input, enabled: true }).pipe(Effect.scoped);
      const enabled = yield* probeCodexSkillsForCwd(input).pipe(Effect.scoped);
      expect(enabled.find((skill) => skill.path === skillPath)?.enabled).toBe(true);
    }),
  );
});
