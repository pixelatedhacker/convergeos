import { parse as parseYaml } from "yaml";
// This module is the asynchronous filesystem/CLI boundary; the WebSocket adapter converts failures to typed Effect errors.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  ClaudeSettings,
  CodexSettings,
  type ServerProvider,
  type ServerSettings,
  type SkillStoreMutation,
  type SkillStoreSnapshot,
  type SkillStoreTarget,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const MARKER = ".convergeos-import.json";
const SkillFrontmatter = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  description: Schema.String.check(Schema.isMinLength(1)),
});
const decodeSkillFrontmatter = Schema.decodeUnknownSync(SkillFrontmatter);
const ImportMarker = Schema.Struct({ source: Schema.String, name: Schema.String });
const PluginInventory = Schema.Struct({
  installed: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      version: Schema.optional(Schema.String),
      scope: Schema.String,
      enabled: Schema.Boolean,
      installPath: Schema.optional(Schema.String),
      projectPath: Schema.optional(Schema.String),
    }),
  ),
  available: Schema.Array(
    Schema.Struct({
      pluginId: Schema.String,
      name: Schema.String,
      description: Schema.optional(Schema.String),
      marketplaceName: Schema.String,
      source: Schema.optional(Schema.Unknown),
    }),
  ),
});
const Source = Schema.Union([
  Schema.String,
  Schema.Struct({
    url: Schema.optional(Schema.String),
    source: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
  }),
]);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const decodeImportMarker = Schema.decodeUnknownSync(ImportMarker);
const decodePluginInventory = Schema.decodeUnknownSync(PluginInventory);
const isSource = Schema.is(Source);
const expand = (value: string, home: string) =>
  NodePath.resolve(
    value === "~" ? home : value.startsWith("~/") ? NodePath.join(home, value.slice(2)) : value,
  );
const slug = (value: string) =>
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) && value !== "." && value !== "..";

export type SkillStoreCommand = (input: {
  binary: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => Promise<string>;
export const runSkillStoreCommand: SkillStoreCommand = async ({ binary, args, cwd, env }) => {
  const result = await exec(binary, [...args], {
    cwd,
    env,
    timeout: 120_000,
    maxBuffer: 4_000_000,
  });
  return result.stdout;
};

export function resolveSkillStoreTarget(
  input: SkillStoreTarget,
  settings: ServerSettings,
  provider: ServerProvider,
  environment = process.env,
) {
  const envelope = settings.providerInstances[input.instanceId];
  const env = { ...mergeProviderInstanceEnvironment(envelope?.environment, environment) };
  const home = env.HOME || NodeOS.homedir();
  const cwd = input.cwd ? expand(input.cwd, home) : home;
  const driver = provider.driver;
  const roots: SkillStoreSnapshot["skillRoots"][number][] = [];
  let binary = "";
  if (driver === "claudeAgent") {
    const config = decodeClaudeSettings(envelope?.config ?? settings.providers.claudeAgent);
    binary = config.binaryPath.startsWith("~")
      ? expand(config.binaryPath, home)
      : config.binaryPath || "claude";
    if (config.homePath) env.CLAUDE_CONFIG_DIR = expand(config.homePath, home);
    roots.push({
      scope: "user",
      path: NodePath.join(
        env.CLAUDE_CONFIG_DIR
          ? NodePath.resolve(cwd, env.CLAUDE_CONFIG_DIR)
          : NodePath.join(home, ".claude"),
        "skills",
      ),
    });
    if (input.cwd) roots.push({ scope: "project", path: NodePath.join(cwd, ".claude", "skills") });
  } else if (driver === "codex") {
    const config = decodeCodexSettings(envelope?.config ?? settings.providers.codex);
    roots.push({
      scope: "user",
      path: NodePath.join(
        config.homePath
          ? expand(config.homePath, home)
          : config.shadowHomePath
            ? NodePath.join(NodeOS.homedir(), ".codex")
            : env.CODEX_HOME || NodePath.join(home, ".codex"),
        "skills",
      ),
    });
    if (input.cwd) roots.push({ scope: "project", path: NodePath.join(cwd, ".agents", "skills") });
  } else if (driver === "cursor") {
    roots.push({ scope: "user", path: NodePath.join(home, ".cursor", "skills") });
    if (input.cwd) roots.push({ scope: "project", path: NodePath.join(cwd, ".cursor", "skills") });
  }
  return {
    roots,
    binary,
    cwd,
    env,
    pluginManagement: driver === "claudeAgent" && provider.installed,
  };
}

async function readMarker(directory: string) {
  try {
    return decodeImportMarker(
      JSON.parse(await NodeFSP.readFile(NodePath.join(directory, MARKER), "utf8")),
    );
  } catch {
    return null;
  }
}

export function parsePluginInventory(text: string, cwd?: string): SkillStoreSnapshot["plugins"] {
  const inventory = decodePluginInventory(JSON.parse(text));
  const installed = inventory.installed.map((plugin) => {
    const available = inventory.available.find((item) => item.pluginId === plugin.id);
    return {
      id: plugin.id,
      name: available?.name ?? plugin.id.split("@")[0] ?? plugin.id,
      description: available?.description ?? "",
      source: available?.marketplaceName ?? plugin.installPath ?? "Provider installation",
      scope: plugin.scope,
      installed: true,
      enabled: plugin.enabled,
      version: plugin.version ?? "",
    };
  });
  return [
    ...installed.filter((plugin, index) => {
      const native = inventory.installed[index];
      return plugin.scope === "user" || (cwd !== undefined && native?.projectPath === cwd);
    }),
    ...Array.from(new Map(installed.map((plugin) => [plugin.id, plugin])).values())
      .filter((plugin) => !inventory.available.some((item) => item.pluginId === plugin.id))
      .map((plugin) => ({ ...plugin, installed: false, enabled: false, scope: "" })),
    ...inventory.available.map((plugin) => {
      const source = isSource(plugin.source) ? plugin.source : undefined;
      return {
        id: plugin.pluginId,
        name: plugin.name,
        description: plugin.description ?? "",
        source: `${plugin.marketplaceName}${source ? ` · ${typeof source === "string" ? source : (source.url ?? source.path ?? source.source ?? "")}` : ""}`,
        scope: "",
        installed: false,
        enabled: false,
        version: "",
      };
    }),
  ];
}

export async function readSkillStore(
  input: SkillStoreTarget,
  settings: ServerSettings,
  provider: ServerProvider,
  run: SkillStoreCommand = runSkillStoreCommand,
  environment = process.env,
): Promise<SkillStoreSnapshot> {
  const target = resolveSkillStoreTarget(input, settings, provider, environment);
  const snapshot = input.cwd
    ? provider.workspaceSnapshots?.find((item) => item.cwd === input.cwd)
    : undefined;
  const skills = await Promise.all(
    (snapshot?.skills ?? provider.skills).map(async (skill) => {
      const root = target.roots.find(
        (item) => NodePath.dirname(NodePath.dirname(skill.path)) === item.path,
      );
      const marker = root ? await readMarker(NodePath.dirname(skill.path)) : null;
      return { ...skill, managed: marker !== null, ...(marker ? { source: marker.source } : {}) };
    }),
  );
  // Managed imports are visible immediately, before the provider next refreshes its catalog.
  for (const root of target.roots) {
    let entries: string[];
    try {
      entries = await NodeFSP.readdir(root.path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    for (const name of entries) {
      if (!slug(name)) continue;
      const directory = NodePath.join(root.path, name);
      const marker = await readMarker(directory);
      const skillPath = NodePath.join(directory, "SKILL.md");
      if (!marker || skills.some((skill) => skill.path === skillPath)) continue;
      skills.push({
        name,
        path: skillPath,
        scope: root.scope,
        enabled: true,
        managed: true,
        source: marker.source,
      });
    }
  }
  let plugins: SkillStoreSnapshot["plugins"] = [];
  let notice = target.pluginManagement
    ? "Plugin changes apply to new provider sessions. Existing conversations may need a new session."
    : "Plugin management is not supported for this provider. Skills use its reported catalog.";
  if (input.cwd && !snapshot)
    notice = `Project-specific discovery is unavailable; showing the latest general skill snapshot. ${notice}`;
  if (target.pluginManagement) {
    try {
      plugins = parsePluginInventory(
        await run({ ...target, args: ["plugin", "list", "--json", "--available"] }),
        input.cwd ? await NodeFSP.realpath(target.cwd) : undefined,
      );
    } catch (error) {
      notice = `Plugin catalog unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return {
    skills,
    skillRoots: target.roots,
    plugins,
    pluginManagement: target.pluginManagement,
    skillEnablement: provider.driver === "codex" && provider.installed,
    notice,
  };
}

async function copySkill(source: string, destination: string) {
  let files = 0;
  let bytes = 0;
  const walk = async (from: string, to: string) => {
    await NodeFSP.mkdir(to);
    for (const entry of await NodeFSP.readdir(from, { withFileTypes: true })) {
      if ([".git", "node_modules", MARKER].includes(entry.name)) continue;
      if (++files > 1000) throw new Error("Skill package exceeds 1,000 files.");
      const file = NodePath.join(from, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Import a package containing regular files, not symbolic links.");
      if (entry.isDirectory()) await walk(file, NodePath.join(to, entry.name));
      else if (entry.isFile()) {
        bytes += (await NodeFSP.stat(file)).size;
        if (bytes > 20_000_000) throw new Error("Skill package exceeds 20 MB.");
        await NodeFSP.copyFile(file, NodePath.join(to, entry.name));
      } else throw new Error("Skill package contains an unsupported file type.");
    }
  };
  await walk(source, destination);
}

export async function mutateSkillStore(
  input: SkillStoreMutation,
  settings: ServerSettings,
  provider: ServerProvider,
  run: SkillStoreCommand = runSkillStoreCommand,
  environment = process.env,
) {
  const target = resolveSkillStoreTarget(input, settings, provider, environment);
  const action = input.action;
  if (action.kind === "set-skill-enabled")
    throw new Error("Skill enablement requires the provider RPC adapter.");
  if (action.scope === "project" && !input.cwd)
    throw new Error("Choose a project directory first.");
  if (action.kind === "plugin") {
    if (!target.pluginManagement)
      throw new Error("This provider does not support plugin management.");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._@/-]*$/.test(action.id))
      throw new Error("Invalid plugin identifier.");
    const inventory = parsePluginInventory(
      await run({ ...target, args: ["plugin", "list", "--json", "--available"] }),
      input.cwd ? await NodeFSP.realpath(target.cwd) : undefined,
    );
    if (
      action.operation === "install" &&
      inventory.some(
        (plugin) => plugin.id === action.id && plugin.installed && plugin.scope === action.scope,
      )
    )
      throw new Error("Plugin already installed in this scope.");
    const match = inventory.find(
      (plugin) =>
        plugin.id === action.id &&
        (action.operation === "install"
          ? !plugin.installed
          : plugin.installed && plugin.scope === action.scope),
    );
    if (!match)
      throw new Error("Refresh the catalog: the plugin is unavailable in the selected scope.");
    await run({
      ...target,
      args: ["plugin", action.operation, action.id, "--scope", action.scope],
    });
    return {
      message: "Plugin command completed. Start a new provider session to load the change.",
    };
  }
  const root = target.roots.find((item) => item.scope === action.scope);
  if (!root) throw new Error("Skill import is not supported for this provider and scope.");
  await NodeFSP.mkdir(root.path, { recursive: true });
  const canonicalRoot = await NodeFSP.realpath(root.path);
  if (action.kind === "remove-skill") {
    if (!slug(action.name)) throw new Error("Invalid skill name.");
    const directory = NodePath.join(canonicalRoot, action.name);
    if ((await NodeFSP.lstat(directory)).isSymbolicLink())
      throw new Error("Cannot remove a linked skill.");
    if (!(await readMarker(directory)))
      throw new Error("Only copies imported by ConvergeOS can be removed here.");
    await NodeFSP.rm(directory, { recursive: true });
    return {
      message: "Imported copy removed. Its original source is unchanged and can be imported again.",
    };
  }
  const source = await NodeFSP.realpath(
    expand(action.sourcePath, target.env.HOME || NodeOS.homedir()),
  );
  const name = NodePath.basename(source);
  if (!slug(name)) throw new Error("The package directory needs a simple skill name.");
  const entryStat = await NodeFSP.stat(NodePath.join(source, "SKILL.md"));
  if (entryStat.size > 1_000_000) throw new Error("SKILL.md exceeds 1 MB.");
  if (!entryStat.isFile()) throw new Error("Choose a package directory containing SKILL.md.");
  const contents = await NodeFSP.readFile(NodePath.join(source, "SKILL.md"), "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
  if (!frontmatter) throw new Error("SKILL.md needs YAML frontmatter with a name and description.");
  try {
    decodeSkillFrontmatter(parseYaml(frontmatter[1] ?? ""));
  } catch {
    throw new Error("SKILL.md needs a nonempty name and description in its YAML frontmatter.");
  }
  if (source === canonicalRoot || canonicalRoot.startsWith(`${source}${NodePath.sep}`))
    throw new Error("The destination cannot be inside the source package.");
  const destination = NodePath.join(canonicalRoot, name);
  const lock = NodePath.join(canonicalRoot, `.${name}.convergeos-lock`);
  await NodeFSP.mkdir(lock);
  const temporary = NodePath.join(
    NodePath.dirname(canonicalRoot),
    `.${name}.${NodeCrypto.randomUUID()}.importing`,
  );
  try {
    try {
      await NodeFSP.lstat(destination);
      throw new Error("A skill already exists with this name. No files were replaced.");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await copySkill(source, temporary);
    await NodeFSP.writeFile(NodePath.join(temporary, MARKER), JSON.stringify({ source, name }));
    await NodeFSP.rename(temporary, destination);
  } finally {
    await NodeFSP.rm(temporary, { recursive: true, force: true });
    await NodeFSP.rmdir(lock);
  }
  return { message: "Skill imported. Start a new provider session to load it." };
}
