import * as Cause from "effect/Cause";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerProvider, SkillStoreAction } from "@t3tools/contracts";
import { useState } from "react";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

export function SkillStoreSettingsPanel() {
  const { environments } = useEnvironments();
  const [selected, setSelected] = useState<string>("");
  const environment =
    environments.find((item) => item.environmentId === selected) ??
    environments.find((item) => item.connection.phase === "connected");
  return (
    <SettingsPageContainer>
      <SettingsSection title="Skills & plugins">
        <p className="px-3 text-sm text-muted-foreground">
          Manage packages on the selected environment. Imported skills are independent copies;
          original sources stay unchanged.
        </p>
        <label className="flex flex-col gap-2 text-sm">
          Environment
          <select
            className="rounded border bg-background p-2"
            value={environment?.environmentId ?? ""}
            onChange={(event) => setSelected(event.target.value)}
          >
            {environments.map((item) => (
              <option key={item.environmentId} value={item.environmentId}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {environment ? (
          <EnvironmentStore
            key={environment.environmentId}
            environmentId={environment.environmentId}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Connect an environment to manage its skills.
          </p>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function EnvironmentStore({ environmentId }: { environmentId: EnvironmentId }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const [selected, setSelected] = useState("");
  const provider =
    config?.providers.find((item) => item.instanceId === selected) ?? config?.providers[0];
  const [cwd, setCwd] = useState("");
  const [draftCwd, setDraftCwd] = useState("");
  return (
    <div className="space-y-4 pt-4">
      <label className="flex flex-col gap-2 text-sm">
        Provider instance
        <select
          className="rounded border bg-background p-2"
          value={provider?.instanceId ?? ""}
          onChange={(event) => setSelected(event.target.value)}
        >
          {config?.providers.map((item) => (
            <option key={item.instanceId} value={item.instanceId}>
              {item.displayName || item.instanceId} · {item.driver}
            </option>
          ))}
        </select>
      </label>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setCwd(draftCwd.trim());
        }}
      >
        <label className="flex flex-1 flex-col gap-2 text-sm">
          Project directory on this environment, optional
          <Input
            value={draftCwd}
            onChange={(event) => setDraftCwd(event.target.value)}
            placeholder="/path/to/project"
          />
        </label>
        <Button type="submit" variant="outline">
          Use directory
        </Button>
      </form>
      {provider ? (
        <ProviderStore
          key={`${provider.instanceId}:${cwd}`}
          environmentId={environmentId}
          provider={provider}
          cwd={cwd}
        />
      ) : (
        <p>No providers configured.</p>
      )}
    </div>
  );
}

function ProviderStore({
  environmentId,
  provider,
  cwd,
}: {
  environmentId: EnvironmentId;
  provider: ServerProvider;
  cwd: string;
}) {
  const input = { instanceId: provider.instanceId, ...(cwd ? { cwd } : {}) };
  const query = useEnvironmentQuery(serverEnvironment.skillStore({ environmentId, input }));
  const mutate = useAtomCommand(serverEnvironment.mutateSkillStore);
  const refreshProvider = useAtomCommand(serverEnvironment.refreshProviders);
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"user" | "project">("user");
  const [sourcePath, setSourcePath] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [confirmation, setConfirmation] = useState<SkillStoreAction | null>(null);
  const [tab, setTab] = useState<"skills" | "installed" | "discover">("skills");
  const run = async (action: SkillStoreAction) => {
    setPending(true);
    setMessage("");
    setConfirmation(null);
    try {
      const result = await mutate({ environmentId, input: { ...input, action } });
      setMessage(
        result._tag === "Success"
          ? result.value.message
          : String(Cause.squash(result.cause)).slice(0, 2000),
      );
      if (result._tag === "Success") await refreshProvider({ environmentId, input });
      query.refresh();
    } finally {
      setPending(false);
    }
  };
  const needle = search.toLowerCase();
  const skills =
    query.data?.skills.filter((item) =>
      `${item.name} ${item.description ?? ""} ${item.path}`.toLowerCase().includes(needle),
    ) ?? [];
  const plugins =
    query.data?.plugins.filter(
      (item) =>
        item.installed === (tab === "installed") &&
        `${item.name} ${item.description} ${item.source}`.toLowerCase().includes(needle),
    ) ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {(["skills", "installed", "discover"] as const).map((value) => (
          <Button
            key={value}
            variant={tab === value ? "default" : "outline"}
            onClick={() => setTab(value)}
          >
            {value === "skills"
              ? "Skills"
              : value === "installed"
                ? "Installed plugins"
                : "Discover plugins"}
          </Button>
        ))}
        <Button
          variant="ghost"
          disabled={pending || query.isPending}
          onClick={() => {
            void refreshProvider({ environmentId, input }).then(() => query.refresh());
          }}
        >
          Refresh
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{query.data?.notice}</p>
      {query.error && (
        <p role="alert" className="text-sm text-destructive">
          {query.error}
        </p>
      )}
      {query.isPending && (
        <p role="status" className="text-sm">
          Loading catalog…
        </p>
      )}
      <Input
        aria-label="Search skills and plugins"
        placeholder="Search name, description or source"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <label className="flex items-center gap-2 text-sm">
        Install scope
        <select
          className="rounded border bg-background p-2"
          value={scope}
          onChange={(event) => setScope(event.target.value === "project" ? "project" : "user")}
        >
          <option value="user">User on this environment</option>
          <option value="project" disabled={!cwd}>
            Selected project
          </option>
        </select>
      </label>
      {tab === "skills" && (
        <>
          {query.data?.skillRoots.some((root) => root.scope === scope) ? (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                void run({ kind: "import-skill", scope, sourcePath });
              }}
            >
              <label className="flex flex-col gap-2 text-sm">
                Import package directory on this environment
                <Input
                  required
                  value={sourcePath}
                  onChange={(event) => setSourcePath(event.target.value)}
                  placeholder="/path/to/my-skill"
                />
              </label>
              <p className="break-all text-xs text-muted-foreground">
                Destination: {query.data.skillRoots.find((root) => root.scope === scope)?.path}. The
                directory must contain SKILL.md.
              </p>
              <Button disabled={pending || !sourcePath.trim()} type="submit">
                Import skill
              </Button>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">
              Directory imports are not supported for this provider. Its discovered skills are
              listed below.
            </p>
          )}
          {skills.map((skill) => (
            <article key={skill.path} className="space-y-2 rounded border p-3">
              <h3 className="font-medium">{skill.displayName || skill.name}</h3>
              <p className="text-sm">{skill.description}</p>
              <p className="text-xs text-muted-foreground">
                {skill.scope || "Provider scope"} · {skill.enabled ? "Enabled" : "Disabled"} ·{" "}
                {skill.managed ? "Imported copy" : "Provider managed"}
              </p>
              <p className="break-all text-xs text-muted-foreground">{skill.path}</p>
              {skill.source && <p className="break-all text-xs">Source: {skill.source}</p>}
              {query.data?.skillEnablement && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void run({
                      kind: "set-skill-enabled",
                      path: skill.path,
                      enabled: !skill.enabled,
                    })
                  }
                >
                  {skill.enabled ? "Disable" : "Enable"}
                </Button>
              )}
              {skill.managed && (skill.scope === "user" || skill.scope === "project") && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    setConfirmation({
                      kind: "remove-skill",
                      scope: skill.scope === "project" ? "project" : "user",
                      name: skill.path.split(/[\\/]/).at(-2) ?? skill.name,
                    })
                  }
                >
                  Remove imported copy
                </Button>
              )}
            </article>
          ))}
          {!query.isPending && !skills.length && (
            <p className="text-sm text-muted-foreground">
              No matching skills in the current provider snapshot. Refresh to discover recent
              changes.
            </p>
          )}
        </>
      )}
      {tab !== "skills" && (
        <>
          {plugins.slice(0, 100).map((plugin) => (
            <article key={`${plugin.id}:${plugin.scope}`} className="space-y-2 rounded border p-3">
              <h3 className="font-medium">{plugin.name}</h3>
              <p className="text-sm">{plugin.description}</p>
              <p className="break-all text-xs text-muted-foreground">{plugin.source}</p>
              <p className="text-xs">
                {plugin.id} {plugin.version} {plugin.scope}{" "}
                {plugin.installed ? (plugin.enabled ? "Enabled" : "Disabled") : "Available"}
              </p>
              <div className="flex gap-2">
                {!plugin.installed ? (
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      setConfirmation({
                        kind: "plugin",
                        operation: "install",
                        scope,
                        id: plugin.id,
                      })
                    }
                  >
                    Install
                  </Button>
                ) : plugin.scope === "user" || plugin.scope === "project" ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        void run({
                          kind: "plugin",
                          operation: plugin.enabled ? "disable" : "enable",
                          scope: plugin.scope === "project" ? "project" : "user",
                          id: plugin.id,
                        })
                      }
                    >
                      {plugin.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        setConfirmation({
                          kind: "plugin",
                          operation: "uninstall",
                          scope: plugin.scope === "project" ? "project" : "user",
                          id: plugin.id,
                        })
                      }
                    >
                      Uninstall
                    </Button>
                  </>
                ) : (
                  <p className="text-xs">Manage this scope in the provider CLI.</p>
                )}
              </div>
            </article>
          ))}
          {plugins.length > 100 && (
            <p className="text-sm">
              Showing 100 of {plugins.length}. Search to narrow the catalog.
            </p>
          )}
          {!query.isPending && !plugins.length && (
            <p className="text-sm text-muted-foreground">
              No matching plugins. Discovery uses this provider's configured marketplaces.
            </p>
          )}
        </>
      )}
      {confirmation && (
        <div
          role="alertdialog"
          aria-label="Confirm package change"
          className="space-y-3 rounded border p-4"
        >
          <p className="text-sm">
            {confirmation.kind === "plugin"
              ? `${confirmation.operation} ${confirmation.id} in ${confirmation.scope} scope? Plugins can include executable hooks and MCP servers. Review the source above.`
              : `Remove the imported copy of ${confirmation.kind === "remove-skill" ? confirmation.name : "this skill"}? Local changes to that copy will be removed. The original source stays unchanged.`}
          </p>
          <div className="flex gap-2">
            <Button onClick={() => void run(confirmation)}>Confirm</Button>
            <Button variant="outline" onClick={() => setConfirmation(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </div>
  );
}
