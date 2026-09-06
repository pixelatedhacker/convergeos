import * as Cause from "effect/Cause";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerProvider, SkillStoreAction } from "@t3tools/contracts";
import { useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

function Action({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      className="rounded-lg border border-border p-3"
    >
      <Text className={disabled ? "text-muted-foreground" : "text-foreground"}>{label}</Text>
    </Pressable>
  );
}
export function SettingsSkillsRouteScreen() {
  const { environments } = useEnvironments();
  const [selected, setSelected] = useState("");
  const environment =
    environments.find((item) => item.environmentId === selected) ??
    environments.find((item) => item.connection.phase === "connected");
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ padding: 16, gap: 16 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text className="text-foreground">
        Manage skills and plugins on the selected environment. Imports copy packages and preserve
        their original source.
      </Text>
      {environments.map((item) => (
        <Action
          key={item.environmentId}
          label={`${item.environmentId === environment?.environmentId ? "✓ " : ""}${item.label}`}
          onPress={() => setSelected(item.environmentId)}
        />
      ))}
      {environment ? (
        <EnvironmentStore
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ) : (
        <Text>Connect an environment first.</Text>
      )}
    </ScrollView>
  );
}
function EnvironmentStore({ environmentId }: { environmentId: EnvironmentId }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const [selected, setSelected] = useState("");
  const provider =
    config?.providers.find((item) => item.instanceId === selected) ?? config?.providers[0];
  const [draftCwd, setDraftCwd] = useState("");
  const [cwd, setCwd] = useState("");
  return (
    <View className="gap-3">
      <Text>Provider instance</Text>
      {config?.providers.map((item) => (
        <Action
          key={item.instanceId}
          label={`${item.instanceId === provider?.instanceId ? "✓ " : ""}${item.displayName || item.instanceId}`}
          onPress={() => setSelected(item.instanceId)}
        />
      ))}
      <TextInput
        accessibilityLabel="Project directory on environment"
        className="rounded border border-border p-3 text-foreground"
        value={draftCwd}
        onChangeText={setDraftCwd}
        placeholder="Project directory on server, optional"
        autoCapitalize="none"
      />
      <Action label="Use directory" onPress={() => setCwd(draftCwd.trim())} />
      {provider && (
        <ProviderStore
          key={`${provider.instanceId}:${cwd}`}
          environmentId={environmentId}
          provider={provider}
          cwd={cwd}
        />
      )}
    </View>
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
  const [sourcePath, setSourcePath] = useState("");
  const [scope, setScope] = useState<"user" | "project">("user");
  const [tab, setTab] = useState<"skills" | "installed" | "discover">("skills");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const run = async (action: SkillStoreAction) => {
    setPending(true);
    setMessage("");
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
  const confirm = (action: SkillStoreAction) =>
    Alert.alert(
      "Confirm package change",
      action.kind === "plugin"
        ? `${action.operation} ${action.id} in ${action.scope} scope? Plugins may include executable hooks and MCP servers. Review their source first.`
        : "Remove this imported copy and edits made to it? Its original source stays unchanged.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Confirm", onPress: () => void run(action) },
      ],
    );
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
    <View className="gap-3">
      <Text className="text-muted-foreground">{query.data?.notice}</Text>
      {query.error && <Text accessibilityRole="alert">{query.error}</Text>}
      {query.isPending && <Text>Loading catalog…</Text>}
      <Action
        label="Refresh catalog"
        disabled={pending || query.isPending}
        onPress={() => {
          void refreshProvider({ environmentId, input }).then(() => query.refresh());
        }}
      />
      <View className="gap-2">
        {(["skills", "installed", "discover"] as const).map((value) => (
          <Action
            key={value}
            label={`${tab === value ? "✓ " : ""}${value === "skills" ? "Skills" : value === "installed" ? "Installed plugins" : "Discover plugins"}`}
            onPress={() => setTab(value)}
          />
        ))}
      </View>
      <TextInput
        accessibilityLabel="Search packages"
        className="rounded border border-border p-3 text-foreground"
        value={search}
        onChangeText={setSearch}
        placeholder="Search packages"
      />
      <Action
        label={`Install scope: ${scope}. Tap to change.`}
        disabled={!cwd}
        onPress={() => setScope(scope === "user" ? "project" : "user")}
      />
      {tab === "skills" ? (
        <>
          {query.data?.skillRoots.some((root) => root.scope === scope) ? (
            <>
              <TextInput
                accessibilityLabel="Skill source directory on environment"
                className="rounded border border-border p-3 text-foreground"
                value={sourcePath}
                onChangeText={setSourcePath}
                placeholder="Source directory containing SKILL.md"
                autoCapitalize="none"
              />
              <Text className="text-muted-foreground">
                Destination: {query.data.skillRoots.find((root) => root.scope === scope)?.path}
              </Text>
              <Action
                label="Import skill"
                disabled={pending || !sourcePath.trim()}
                onPress={() => void run({ kind: "import-skill", scope, sourcePath })}
              />
            </>
          ) : (
            <Text>Directory imports are not supported for this provider.</Text>
          )}
          {skills.map((skill) => (
            <View key={skill.path} className="gap-2 rounded border border-border p-3">
              <Text className="font-semibold">{skill.displayName || skill.name}</Text>
              <Text>{skill.description}</Text>
              <Text className="text-muted-foreground">
                {skill.scope || "Provider scope"} · {skill.enabled ? "Enabled" : "Disabled"}
              </Text>
              <Text selectable>{skill.path}</Text>
              {skill.source && <Text selectable>Source: {skill.source}</Text>}
              {query.data?.skillEnablement && (
                <Action
                  label={skill.enabled ? "Disable" : "Enable"}
                  disabled={pending}
                  onPress={() =>
                    void run({
                      kind: "set-skill-enabled",
                      path: skill.path,
                      enabled: !skill.enabled,
                    })
                  }
                />
              )}
              {skill.managed && (skill.scope === "user" || skill.scope === "project") && (
                <Action
                  label="Remove imported copy"
                  disabled={pending}
                  onPress={() =>
                    confirm({
                      kind: "remove-skill",
                      name: skill.path.split(/[\\/]/).at(-2) ?? skill.name,
                      scope: skill.scope === "project" ? "project" : "user",
                    })
                  }
                />
              )}
            </View>
          ))}
          {!query.isPending && !skills.length && (
            <Text>No matching skills in the provider snapshot.</Text>
          )}
        </>
      ) : (
        <>
          {plugins.slice(0, 50).map((plugin) => (
            <View
              key={`${plugin.id}:${plugin.scope}`}
              className="gap-2 rounded border border-border p-3"
            >
              <Text className="font-semibold">{plugin.name}</Text>
              <Text>{plugin.description}</Text>
              <Text selectable>{plugin.source}</Text>
              <Text>
                {plugin.id} {plugin.version} {plugin.scope}{" "}
                {plugin.installed ? (plugin.enabled ? "Enabled" : "Disabled") : "Available"}
              </Text>
              {!plugin.installed ? (
                <Action
                  label="Install"
                  disabled={pending}
                  onPress={() =>
                    confirm({ kind: "plugin", operation: "install", id: plugin.id, scope })
                  }
                />
              ) : plugin.scope === "user" || plugin.scope === "project" ? (
                <>
                  <Action
                    label={plugin.enabled ? "Disable" : "Enable"}
                    disabled={pending}
                    onPress={() =>
                      void run({
                        kind: "plugin",
                        operation: plugin.enabled ? "disable" : "enable",
                        id: plugin.id,
                        scope: plugin.scope === "project" ? "project" : "user",
                      })
                    }
                  />
                  <Action
                    label="Uninstall"
                    disabled={pending}
                    onPress={() =>
                      confirm({
                        kind: "plugin",
                        operation: "uninstall",
                        id: plugin.id,
                        scope: plugin.scope === "project" ? "project" : "user",
                      })
                    }
                  />
                </>
              ) : (
                <Text>Manage this scope in the provider CLI.</Text>
              )}
            </View>
          ))}
          {plugins.length > 50 && (
            <Text>Showing 50 of {plugins.length}. Search to narrow the catalog.</Text>
          )}
          {!query.isPending && !plugins.length && (
            <Text>No matching plugins in the provider's configured marketplaces.</Text>
          )}
        </>
      )}
      {!!message && <Text accessibilityLiveRegion="polite">{message}</Text>}
    </View>
  );
}
