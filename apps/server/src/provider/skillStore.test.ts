// @effect-diagnostics nodeBuiltinImport:off - tests exercise real temporary package directories.
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderInstanceEnvironmentVariableName,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  mutateSkillStore,
  parsePluginInventory,
  readSkillStore,
  resolveSkillStoreTarget,
  type SkillStoreCommand,
} from "./skillStore.ts";
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});
const provider = (driver: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  installed: true,
  enabled: true,
  version: "1.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-06T00:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
});
async function fixture(driver = "codex") {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "convergeos-skill-store-"));
  temporary.push(home);
  const source = NodePath.join(home, "source", "review");
  await NodeFSP.mkdir(source, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(source, "SKILL.md"),
    "---\nname: review\ndescription: Review a change.\n---\nReview the change.\n",
  );
  await NodeFSP.mkdir(NodePath.join(source, "references"));
  await NodeFSP.writeFile(NodePath.join(source, "references", "guide.md"), "Reference");
  const p = provider(driver);
  const input = { instanceId: p.instanceId };
  const env = { HOME: home };
  const settings = DEFAULT_SERVER_SETTINGS;
  return { home, source, p, input, env, settings };
}
const inventory = JSON.stringify({
  installed: [{ id: "review@example", scope: "user", enabled: true, version: "1" }],
  available: [
    {
      pluginId: "review@example",
      name: "review",
      description: "Review",
      marketplaceName: "example",
      source: "./review",
    },
  ],
});

describe("skill imports", () => {
  it.each(["codex", "claudeAgent", "cursor"])(
    "copies a %s package, lists its source, and removes only the copy",
    async (driver) => {
      const f = await fixture(driver);
      const command: SkillStoreCommand = async () => '{"installed":[],"available":[]}';
      await mutateSkillStore(
        { ...f.input, action: { kind: "import-skill", scope: "user", sourcePath: f.source } },
        f.settings,
        f.p,
        command,
        f.env,
      );
      const catalog = await readSkillStore(f.input, f.settings, f.p, command, f.env);
      expect(catalog.skills).toHaveLength(1);
      expect(catalog.skills[0]).toMatchObject({
        managed: true,
        source: await NodeFSP.realpath(f.source),
        scope: "user",
      });
      const skill = catalog.skills[0]!;
      expect(
        await NodeFSP.readFile(
          NodePath.join(NodePath.dirname(skill.path), "references", "guide.md"),
          "utf8",
        ),
      ).toBe("Reference");
      await mutateSkillStore(
        { ...f.input, action: { kind: "remove-skill", scope: "user", name: "review" } },
        f.settings,
        f.p,
        command,
        f.env,
      );
      await expect(NodeFSP.stat(skill.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await NodeFSP.readFile(NodePath.join(f.source, "SKILL.md"), "utf8")).toContain(
        "Review the change.",
      );
    },
  );
  it("never overwrites an existing skill", async () => {
    const f = await fixture();
    const root = resolveSkillStoreTarget(f.input, f.settings, f.p, f.env).roots[0]!;
    await NodeFSP.mkdir(NodePath.join(root.path, "review"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root.path, "review", "SKILL.md"), "Original");
    await expect(
      mutateSkillStore(
        { ...f.input, action: { kind: "import-skill", scope: "user", sourcePath: f.source } },
        f.settings,
        f.p,
        undefined,
        f.env,
      ),
    ).rejects.toThrow("already exists");
    expect(await NodeFSP.readFile(NodePath.join(root.path, "review", "SKILL.md"), "utf8")).toBe(
      "Original",
    );
    await expect(
      mutateSkillStore(
        { ...f.input, action: { kind: "remove-skill", scope: "user", name: "review" } },
        f.settings,
        f.p,
        undefined,
        f.env,
      ),
    ).rejects.toThrow("Only copies");
  });
  it("rejects linked contents without leaving an import behind", async () => {
    const f = await fixture();
    await NodeFSP.symlink(
      NodePath.join(f.source, "SKILL.md"),
      NodePath.join(f.source, "linked.md"),
    );
    await expect(
      mutateSkillStore(
        { ...f.input, action: { kind: "import-skill", scope: "user", sourcePath: f.source } },
        f.settings,
        f.p,
        undefined,
        f.env,
      ),
    ).rejects.toThrow("symbolic links");
    const catalog = await readSkillStore(f.input, f.settings, f.p, undefined, f.env);
    expect(catalog.skills).toEqual([]);
  });
  it("requires project scope to have a directory and isolates its root", async () => {
    const f = await fixture();
    await expect(
      mutateSkillStore(
        { ...f.input, action: { kind: "import-skill", scope: "project", sourcePath: f.source } },
        f.settings,
        f.p,
        undefined,
        f.env,
      ),
    ).rejects.toThrow("project directory");
    const cwd = NodePath.join(f.home, "project");
    await NodeFSP.mkdir(cwd);
    await mutateSkillStore(
      { ...f.input, cwd, action: { kind: "import-skill", scope: "project", sourcePath: f.source } },
      f.settings,
      f.p,
      undefined,
      f.env,
    );
    expect(
      await NodeFSP.readFile(NodePath.join(cwd, ".agents", "skills", "review", "SKILL.md"), "utf8"),
    ).toContain("Review");
    expect((await readSkillStore(f.input, f.settings, f.p, undefined, f.env)).skills).toEqual([]);
  });
  it("rejects traversal and imports on unsupported providers", async () => {
    const f = await fixture();
    await expect(
      mutateSkillStore(
        { ...f.input, action: { kind: "remove-skill", scope: "user", name: "../source" } },
        f.settings,
        f.p,
        undefined,
        f.env,
      ),
    ).rejects.toThrow("Invalid skill");
    const p = provider("opencode");
    await expect(
      mutateSkillStore(
        {
          instanceId: p.instanceId,
          action: { kind: "import-skill", scope: "user", sourcePath: f.source },
        },
        f.settings,
        p,
        undefined,
        f.env,
      ),
    ).rejects.toThrow("not supported");
  });
  it("uses the shared Codex home for overlays, and ambient CODEX_HOME only in direct mode", async () => {
    const f = await fixture();
    const environment = { ...f.env, CODEX_HOME: NodePath.join(f.home, "ambient") };
    const settings: ServerSettings = {
      ...f.settings,
      providerInstances: {
        [f.p.instanceId]: {
          driver: f.p.driver,
          config: { shadowHomePath: NodePath.join(f.home, "shadow") },
        },
      },
    };
    expect(resolveSkillStoreTarget(f.input, settings, f.p, environment).roots[0]?.path).toBe(
      NodePath.join(NodeOS.homedir(), ".codex", "skills"),
    );
    expect(resolveSkillStoreTarget(f.input, f.settings, f.p, environment).roots[0]?.path).toBe(
      NodePath.join(f.home, "ambient", "skills"),
    );
  });
  it("rejects a malformed skill before installing it", async () => {
    const f = await fixture();
    await NodeFSP.writeFile(NodePath.join(f.source, "SKILL.md"), "No frontmatter");
    await expect(
      mutateSkillStore(
        { ...f.input, action: { kind: "import-skill", scope: "user", sourcePath: f.source } },
        f.settings,
        f.p,
        undefined,
        f.env,
      ),
    ).rejects.toThrow("YAML frontmatter");
  });
  it("resolves configured provider home without mutating the host environment", async () => {
    const f = await fixture("claudeAgent");
    const settings: ServerSettings = {
      ...f.settings,
      providerInstances: {
        [f.p.instanceId]: {
          driver: f.p.driver,
          config: { homePath: NodePath.join(f.home, "account-two"), binaryPath: "/tool/claude" },
          environment: [
            {
              name: ProviderInstanceEnvironmentVariableName.make("CLAUDE_CONFIG_DIR"),
              value: "/old",
              sensitive: false,
            },
          ],
        },
      },
    };
    const target = resolveSkillStoreTarget(f.input, settings, f.p, f.env);
    expect(target.binary).toBe("/tool/claude");
    expect(target.env.CLAUDE_CONFIG_DIR).toBe(NodePath.join(f.home, "account-two"));
    expect(target.roots[0]?.path).toBe(NodePath.join(f.home, "account-two", "skills"));
    expect(f.env).toEqual({ HOME: f.home });
  });
});
describe("provider-native plugins", () => {
  it("keeps available provenance for plugins installed in another scope", () => {
    expect(parsePluginInventory(inventory)).toHaveLength(2);
    expect(parsePluginInventory(inventory)[1]).toMatchObject({
      installed: false,
      source: "example · ./review",
    });
  });
  it("hides other projects' installations and deduplicates available entries across scopes", () => {
    const text = JSON.stringify({
      installed: [
        { id: "review@example", scope: "project", projectPath: "/project/a", enabled: false },
        { id: "review@example", scope: "project", projectPath: "/project/b", enabled: true },
        { id: "review@example", scope: "user", enabled: true },
      ],
      available: [],
    });
    const catalog = parsePluginInventory(text, "/project/a");
    expect(catalog.filter((plugin) => plugin.installed)).toHaveLength(2);
    expect(catalog.find((plugin) => plugin.scope === "project")?.enabled).toBe(false);
    expect(catalog.filter((plugin) => !plugin.installed)).toHaveLength(1);
    expect(parsePluginInventory(text).filter((plugin) => plugin.installed)).toHaveLength(1);
  });
  it("passes exact scoped arguments to the selected instance binary", async () => {
    const f = await fixture("claudeAgent");
    const commands: Parameters<SkillStoreCommand>[0][] = [];
    const run: SkillStoreCommand = async (command) => {
      commands.push(command);
      return inventory;
    };
    const cwd = NodePath.join(f.home, "project");
    await NodeFSP.mkdir(cwd);
    await mutateSkillStore(
      {
        ...f.input,
        cwd,
        action: { kind: "plugin", operation: "install", scope: "project", id: "review@example" },
      },
      f.settings,
      f.p,
      run,
      f.env,
    );
    expect(commands[1]?.args).toEqual([
      "plugin",
      "install",
      "review@example",
      "--scope",
      "project",
    ]);
    expect(commands[1]?.cwd).toBe(cwd);
    await expect(
      mutateSkillStore(
        {
          ...f.input,
          action: { kind: "plugin", operation: "install", scope: "user", id: "review@example" },
        },
        f.settings,
        f.p,
        run,
        f.env,
      ),
    ).rejects.toThrow("already installed");
  });
  it("rejects missing installed scope and preserves a failed catalog as an error notice", async () => {
    const f = await fixture("claudeAgent");
    const run: SkillStoreCommand = async () => inventory;
    await expect(
      mutateSkillStore(
        {
          ...f.input,
          cwd: f.home,
          action: { kind: "plugin", operation: "disable", scope: "project", id: "review@example" },
        },
        f.settings,
        f.p,
        run,
        f.env,
      ),
    ).rejects.toThrow("selected scope");
    const catalog = await readSkillStore(
      f.input,
      f.settings,
      f.p,
      async () => {
        throw new Error("CLI unavailable");
      },
      f.env,
    );
    expect(catalog.notice).toContain("CLI unavailable");
    expect(catalog.plugins).toEqual([]);
  });
});
