import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { CommandId, type EnvironmentId, type Page, type ProjectId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { Linking, Platform, Pressable, ScrollView, View } from "react-native";
import { WebView } from "react-native-webview";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects, useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";

function Action({
  label,
  disabled,
  onPress,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      className="rounded-lg border border-border px-3 py-2"
      onPress={onPress}
    >
      <Text className={disabled ? "text-foreground-muted" : "text-foreground"}>{label}</Text>
    </Pressable>
  );
}

export function PagesRouteScreen({
  route,
}: StaticScreenProps<{ projectKeys?: string[] } | undefined>) {
  const configs = useServerConfigs();
  const projects = useProjects().filter(
    (project) =>
      configs.get(project.environmentId)?.environment.capabilities.pages &&
      (!route.params?.projectKeys ||
        route.params.projectKeys.includes(`${project.environmentId}:${project.id}`)),
  );
  const [key, setKey] = useState<string | null>(null);
  const selected =
    projects.find((project) => `${project.environmentId}:${project.id}` === key) ?? projects[0];
  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Pages" />
        </>
      ) : null}
      <ScrollView horizontal className="max-h-16" contentContainerClassName="gap-2 p-3">
        {projects.map((project) => (
          <Action
            key={`${project.environmentId}:${project.id}`}
            label={project.title}
            disabled={project === selected}
            onPress={() => setKey(`${project.environmentId}:${project.id}`)}
          />
        ))}
      </ScrollView>
      {selected ? (
        <ProjectPages
          key={`${selected.environmentId}:${selected.id}`}
          environmentId={selected.environmentId}
          projectId={selected.id}
        />
      ) : (
        <Text className="p-4 text-foreground-muted">
          Connect to an environment that supports saved pages.
        </Text>
      )}
    </View>
  );
}

function ProjectPages({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const [includeArchived, setIncludeArchived] = useState(false);
  const pages = useEnvironmentQuery(
    orchestrationEnvironment.pages({
      environmentId,
      input: { projectId, includeArchived, limit: 200 },
    }),
  );
  const [selected, setSelected] = useState<Page | null>(null);
  if (selected)
    return (
      <SavedPage
        environmentId={environmentId}
        page={selected}
        onBack={() => {
          setSelected(null);
          pages.refresh();
        }}
      />
    );
  return (
    <ScrollView contentContainerClassName="gap-3 p-4 pb-12">
      <View className="flex-row flex-wrap gap-2">
        <Action label="Refresh" onPress={pages.refresh} />
        <Action
          label={includeArchived ? "Hide archived" : "Show archived"}
          onPress={() => setIncludeArchived(!includeArchived)}
        />
      </View>
      <Text className="text-sm text-foreground-muted">
        Save pages from the web or desktop app, then open them here.
      </Text>
      {pages.error ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {pages.error}
        </Text>
      ) : null}
      {pages.isPending && !pages.data ? (
        <Text className="text-foreground-muted">Loading pages…</Text>
      ) : null}
      {pages.data?.pages.length === 0 ? (
        <Text className="text-foreground-muted">No saved pages.</Text>
      ) : null}
      {pages.data?.pages.map((page) => (
        <Pressable
          key={page.id}
          accessibilityRole="button"
          className="gap-1 rounded-lg bg-card p-4"
          onPress={() => setSelected(page)}
        >
          <Text className="font-t3-medium text-foreground">{page.title}</Text>
          <Text className="text-xs text-foreground-muted">
            {page.archivedAt ? "Archived" : `Version ${page.currentRevision}`} ·{" "}
            {new Date(page.updatedAt).toLocaleString()}
          </Text>
        </Pressable>
      ))}
      {pages.data?.pages.length === 200 ? (
        <Text className="text-xs text-foreground-muted">
          Showing the 200 most recently updated pages.
        </Text>
      ) : null}
    </ScrollView>
  );
}

function SavedPage({
  environmentId,
  page,
  onBack,
}: {
  readonly environmentId: EnvironmentId;
  readonly page: Page;
  readonly onBack: () => void;
}) {
  const content = useEnvironmentQuery(
    orchestrationEnvironment.pageContent({ environmentId, input: { pageId: page.id } }),
  );
  const update = useAtomCommand(orchestrationEnvironment.updatePage, { reportFailure: false });
  const navigation = useNavigation();
  const [title, setTitle] = useState(page.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = async (type: "page.rename" | "page.archive" | "page.restore") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const metadata = {
        commandId: CommandId.make(uuidv4()),
        pageId: page.id,
        expectedMetadataRevision: page.metadataRevision,
        createdAt: new Date().toISOString(),
      };
      const result = await update({
        environmentId,
        input:
          type === "page.rename"
            ? { ...metadata, type, title: title.trim() }
            : { ...metadata, type },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      onBack();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the page.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="flex-1 gap-3 p-3">
      <View className="flex-row flex-wrap gap-2">
        <Action label="Back to pages" disabled={busy} onPress={onBack} />
        <Action label="Refresh content" onPress={content.refresh} />
        <Action
          label={page.archivedAt ? "Restore page" : "Archive page"}
          disabled={busy}
          onPress={() => void change(page.archivedAt ? "page.restore" : "page.archive")}
        />
      </View>
      <View className="flex-row items-center gap-2">
        <TextInput
          accessibilityLabel="Page title"
          className="min-w-0 flex-1 rounded-lg bg-card p-3 text-foreground"
          value={title}
          maxLength={200}
          onChangeText={setTitle}
        />
        <Action
          label="Rename"
          disabled={
            busy || page.archivedAt !== null || !title.trim() || title.trim() === page.title
          }
          onPress={() => void change("page.rename")}
        />
      </View>
      {page.sourceThreadId ? (
        <Action
          label="Open conversation"
          onPress={() => {
            if (page.sourceThreadId)
              navigation.navigate("Thread", { environmentId, threadId: page.sourceThreadId });
          }}
        />
      ) : null}
      {error || content.error ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {error ?? content.error}
        </Text>
      ) : null}
      {content.isPending && !content.data ? (
        <Text className="text-foreground-muted">Loading page…</Text>
      ) : null}
      {content.data?.content.kind === "html" ? (
        <WebView
          source={{ html: content.data.content.html, baseUrl: "https://saved-page.invalid" }}
          originWhitelist={["*"]}
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          incognito
          setSupportMultipleWindows={false}
          onShouldStartLoadWithRequest={(request) =>
            request.url === "about:blank" ||
            request.url === "https://saved-page.invalid/" ||
            request.url.startsWith("https://saved-page.invalid/#")
          }
          style={{ flex: 1 }}
        />
      ) : content.data?.content.kind === "hostedUrl" ? (
        <Action
          label="Open website"
          onPress={() => {
            const data = content.data?.content;
            if (data?.kind === "hostedUrl")
              void Linking.openURL(data.url).catch(() => setError("Could not open the website."));
          }}
        />
      ) : null}
    </View>
  );
}
