import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { resolveBotComputerViewerUrl } from "@t3tools/client-runtime/state/bot-computer";
import type {
  BotComputerCapability,
  BotComputerState,
  BotComputerViewerAccess,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { WebView } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { botComputerEnvironment } from "../../state/botComputer";
import { useServerConfigs, useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

type BotComputerMutation = "start" | "suspend" | "resume" | "reset" | "destroy";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The Bot computer operation failed.";
}

function statusLabel(state: BotComputerState | null): string {
  if (state === null) return "Checking";
  switch (state.status) {
    case "absent":
      return "Not created";
    case "failed":
      return "Needs attention";
    case "running":
      return "Running";
    case "suspended":
      return "Suspended";
    case "unavailable":
      return "Unavailable";
  }
}

function Action(props: {
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      className={
        props.destructive
          ? "rounded-xl bg-destructive px-4 py-3"
          : "rounded-xl bg-primary px-4 py-3"
      }
      disabled={props.disabled}
      onPress={props.onPress}
      style={props.disabled ? { opacity: 0.45 } : undefined}
    >
      <Text
        className={
          props.destructive
            ? "text-center font-t3-bold text-destructive-foreground"
            : "text-center font-t3-bold text-primary-foreground"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

export function BotsRouteScreen() {
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const bots = useMemo(
    () =>
      threads
        .filter((thread) => thread.botProfile != null)
        .sort((left, right) =>
          (left.botProfile?.displayName ?? left.title).localeCompare(
            right.botProfile?.displayName ?? right.title,
          ),
        ),
    [threads],
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected =
    bots.find((bot) => `${bot.environmentId}:${bot.id}` === selectedKey) ?? bots[0] ?? null;

  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Bots" />
        </>
      ) : null}
      {bots.length === 0 ? (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-base text-foreground-muted">
            Create a Bot with an isolated worktree before giving it a computer.
          </Text>
        </View>
      ) : (
        <>
          <ScrollView
            horizontal
            className="max-h-14 border-b border-border-subtle"
            contentContainerClassName="items-center gap-2 px-4 py-2"
            showsHorizontalScrollIndicator={false}
          >
            {bots.map((bot) => {
              const key = `${bot.environmentId}:${bot.id}`;
              const active =
                selected?.environmentId === bot.environmentId && selected.id === bot.id;
              return (
                <Pressable
                  key={key}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  className={
                    active
                      ? "rounded-full bg-accent px-3 py-1.5"
                      : "rounded-full bg-card px-3 py-1.5"
                  }
                  onPress={() => setSelectedKey(key)}
                >
                  <Text
                    className={active ? "font-t3-medium text-accent-foreground" : "text-foreground"}
                  >
                    {bot.botProfile?.displayName ?? bot.title}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
          {selected === null ? null : (
            <BotComputer
              key={`${selected.environmentId}:${selected.id}`}
              capability={
                serverConfigs.get(selected.environmentId)?.environment.capabilities.botComputer
              }
              environmentId={selected.environmentId}
              threadId={selected.id}
            />
          )}
        </>
      )}
    </View>
  );
}

function BotComputer(props: {
  readonly capability: BotComputerCapability | undefined;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const insets = useSafeAreaInsets();
  const target = useMemo(
    () => ({ environmentId: props.environmentId, input: { threadId: props.threadId } }) as const,
    [props.environmentId, props.threadId],
  );
  const preparedConnection = usePreparedConnection(props.environmentId);
  const httpBaseUrl =
    preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null;
  const query = useEnvironmentQuery(
    props.capability ? botComputerEnvironment.inspect(target) : null,
  );
  const start = useAtomCommand(botComputerEnvironment.start, { reportFailure: false });
  const suspend = useAtomCommand(botComputerEnvironment.suspend, { reportFailure: false });
  const resume = useAtomCommand(botComputerEnvironment.resume, { reportFailure: false });
  const reset = useAtomCommand(botComputerEnvironment.reset, { reportFailure: false });
  const destroy = useAtomCommand(botComputerEnvironment.destroy, { reportFailure: false });
  const [pending, setPending] = useState<BotComputerMutation | null>(null);
  const [mutationState, setMutationState] = useState<BotComputerState | null>(null);
  const [viewerAccess, setViewerAccess] = useState<BotComputerViewerAccess | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [viewerPending, setViewerPending] = useState(false);
  const viewerRequestGeneration = useRef(0);
  const state = mutationState?.status === "failed" ? mutationState : query.data;
  const requestViewerAccess = useAtomCommand(botComputerEnvironment.viewerAccess, {
    reportFailure: false,
  });
  const refreshViewerAccess = useCallback(async () => {
    const generation = ++viewerRequestGeneration.current;
    setViewerAccess(null);
    setViewerError(null);
    setViewerPending(true);
    const result = await requestViewerAccess(target);
    if (generation !== viewerRequestGeneration.current) return;
    setViewerPending(false);
    if (result._tag === "Failure") {
      setViewerError(errorMessage(squashAtomCommandFailure(result)));
      return;
    }
    setViewerAccess(result.value);
  }, [requestViewerAccess, target]);
  const usesAuthenticatedViewer =
    state?.status === "running" && state.viewerAccess === "authenticated-remote";
  useEffect(() => {
    if (!usesAuthenticatedViewer) {
      viewerRequestGeneration.current += 1;
      // Invalidation ends any viewer request whose result is now ignored.
      // oxlint-disable-next-line react/set-state-in-effect
      setViewerPending(false);
      return;
    }
    void refreshViewerAccess();
    return () => {
      viewerRequestGeneration.current += 1;
    };
  }, [refreshViewerAccess, usesAuthenticatedViewer]);
  const viewerUrl =
    usesAuthenticatedViewer && httpBaseUrl !== null && viewerAccess !== null && pending === null
      ? (resolveBotComputerViewerUrl(httpBaseUrl, viewerAccess.viewerPath) ?? null)
      : null;

  const run = async (operation: BotComputerMutation) => {
    if (pending !== null) return;
    viewerRequestGeneration.current += 1;
    setMutationState(null);
    setViewerAccess(null);
    setViewerPending(false);
    setPending(operation);
    try {
      const result = await (operation === "start"
        ? start({ ...target, input: { threadId: props.threadId, networkAccess: "outbound" } })
        : operation === "resume"
          ? resume({ ...target, input: { threadId: props.threadId, networkAccess: "outbound" } })
          : operation === "reset"
            ? reset({ ...target, input: { threadId: props.threadId, networkAccess: "outbound" } })
            : operation === "suspend"
              ? suspend(target)
              : destroy(target));
      if (result._tag === "Failure") {
        Alert.alert("Bot computer unavailable", errorMessage(squashAtomCommandFailure(result)));
        return;
      }
      setMutationState(result.value.status === "failed" ? result.value : null);
      if (
        result.value.status === "running" &&
        result.value.viewerAccess === "authenticated-remote"
      ) {
        await refreshViewerAccess();
      }
    } finally {
      setPending(null);
    }
  };

  const confirm = (operation: "reset" | "destroy") => {
    Alert.alert(
      operation === "reset" ? "Reset this computer?" : "Destroy this computer?",
      "This removes its Chromium profile, including cookies and signed-in sessions. Files in the Bot worktree are preserved.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: operation === "reset" ? "Reset computer" : "Destroy computer",
          style: "destructive",
          onPress: () => void run(operation),
        },
      ],
    );
  };

  return (
    <View className="min-h-0 flex-1">
      <View className="flex-row items-center gap-3 border-b border-border-subtle px-4 py-3">
        <View className="min-w-0 flex-1">
          <Text className="font-t3-bold text-foreground">Computer</Text>
          <Text className="text-sm text-foreground-muted">{statusLabel(state)}</Text>
        </View>
        <Pressable
          accessibilityLabel={
            usesAuthenticatedViewer ? "Reconnect desktop" : "Refresh computer status"
          }
          accessibilityRole="button"
          disabled={pending !== null}
          onPress={() => {
            setMutationState(null);
            query.refresh();
            if (usesAuthenticatedViewer) void refreshViewerAccess();
          }}
        >
          <Text className="font-t3-medium text-primary">
            {usesAuthenticatedViewer ? "Reconnect desktop" : "Refresh"}
          </Text>
        </Pressable>
      </View>

      <View className="min-h-0 flex-1 bg-black">
        {viewerUrl !== null ? (
          <WebView
            key={viewerUrl}
            source={{ uri: viewerUrl }}
            originWhitelist={["http://*", "https://*"]}
            setSupportMultipleWindows={false}
            startInLoadingState
            renderLoading={() => (
              <View className="absolute inset-0 items-center justify-center bg-black">
                <ActivityIndicator color="white" />
              </View>
            )}
            onError={(event) => {
              viewerRequestGeneration.current += 1;
              setViewerAccess(null);
              setViewerPending(false);
              setViewerError(event.nativeEvent.description || "The desktop connection failed.");
            }}
            onHttpError={(event) => {
              viewerRequestGeneration.current += 1;
              setViewerAccess(null);
              setViewerPending(false);
              setViewerError(
                `The desktop viewer returned HTTP ${event.nativeEvent.statusCode}. Reconnect to request fresh access.`,
              );
            }}
            style={{ flex: 1, backgroundColor: "black" }}
          />
        ) : (
          <View className="flex-1 items-center justify-center gap-2 px-8">
            {query.isPending || viewerPending || pending !== null ? (
              <ActivityIndicator color="white" />
            ) : null}
            <Text className="text-center font-t3-bold text-white">
              {props.capability === undefined
                ? "Computer is not available"
                : state?.status === "running" && state.viewerAccess === "host-local"
                  ? "Remote viewing needs an update"
                  : query.error
                    ? "Could not inspect this computer"
                    : state?.status === "suspended"
                      ? "Computer is suspended"
                      : state?.status === "unavailable"
                        ? "Docker is not ready"
                        : state?.status === "failed"
                          ? "Computer needs attention"
                          : "Give this Bot a desktop"}
            </Text>
            <Text className="text-center text-sm text-white/60">
              {query.error ??
                viewerError ??
                (state?.status === "running" && state.viewerAccess === "host-local"
                  ? "Update this environment to view its Bot computers on mobile."
                  : null) ??
                (state?.status === "unavailable" || state?.status === "failed"
                  ? state.detail
                  : state?.status === "running"
                    ? "Requesting secure viewer access from the environment."
                    : "The desktop runs in the Bot's isolated worktree.")}
            </Text>
          </View>
        )}
      </View>

      <View
        className="gap-3 border-t border-border-subtle bg-sheet px-4 pt-4"
        style={{ paddingBottom: Math.max(insets.bottom, 16) }}
      >
        {state?.status === "running" ? (
          <Action
            disabled={pending !== null}
            label={pending === "suspend" ? "Suspending…" : "Suspend"}
            onPress={() => void run("suspend")}
          />
        ) : state?.status === "suspended" ? (
          <Action
            disabled={pending !== null}
            label={pending === "resume" ? "Resuming…" : "Resume with network"}
            onPress={() => void run("resume")}
          />
        ) : state?.status === "absent" || state?.status === "failed" ? (
          <Action
            disabled={pending !== null}
            label={pending === "start" ? "Starting…" : "Start with network"}
            onPress={() => void run("start")}
          />
        ) : null}
        {state?.status === "running" ||
        state?.status === "suspended" ||
        (state?.status === "failed" && state.containerId !== undefined) ? (
          <View className="flex-row gap-3">
            <View className="flex-1">
              <Action
                disabled={pending !== null}
                label={pending === "reset" ? "Resetting…" : "Reset"}
                onPress={() => confirm("reset")}
              />
            </View>
            <View className="flex-1">
              <Action
                destructive
                disabled={pending !== null}
                label={pending === "destroy" ? "Destroying…" : "Destroy"}
                onPress={() => confirm("destroy")}
              />
            </View>
          </View>
        ) : null}
        <Text className="text-xs leading-relaxed text-foreground-muted">
          Container isolation is not safe containment for hostile code. Worktree files and secrets
          are visible to the computer.
        </Text>
      </View>
    </View>
  );
}
