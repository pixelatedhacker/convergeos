import type { EnvironmentWorkSummary } from "@t3tools/client-runtime/state/command-center";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

interface Machine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionState: EnvironmentConnectionPhase;
}

function statusLabel(state: EnvironmentConnectionPhase): string {
  switch (state) {
    case "connected":
      return "Connected";
    case "connecting":
    case "reconnecting":
      return "Connecting";
    case "offline":
      return "Offline";
    case "error":
      return "Connection failed";
    case "available":
      return "Available";
  }
}

export function EnvironmentCommandStrip(props: {
  readonly environments: readonly Machine[];
  readonly summaries: readonly EnvironmentWorkSummary[];
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  if (props.environments.length < 2) return null;
  const workById = new Map(
    props.summaries.map((summary) => [summary.environmentId, summary] as const),
  );

  return (
    <View className="pt-3 pb-4">
      <View className="mb-2 flex-row items-center justify-between px-4">
        <Text className="text-xs font-t3-bold text-foreground-muted">Machines</Text>
        {props.selectedEnvironmentId !== null ? (
          <Pressable
            accessibilityLabel="Show all environments"
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => props.onEnvironmentChange(null)}
          >
            <Text className="text-xs font-t3-medium text-accent">Show all</Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-2.5 px-4"
      >
        {props.environments.map((environment) => {
          const summary = workById.get(environment.environmentId);
          const thread = summary?.nextThread ?? null;
          const connected = environment.connectionState === "connected";
          const selected = props.selectedEnvironmentId === environment.environmentId;
          const action =
            summary?.nextKind === "attention"
              ? "Needs you"
              : summary?.nextKind === "working"
                ? "Working now"
                : "Resume";
          return (
            <View
              className={`w-[220px] rounded-2xl border bg-screen p-3 ${selected ? "border-accent" : "border-border"}`}
              key={environment.environmentId}
            >
              <Pressable
                accessibilityLabel={`Show threads on ${environment.label}`}
                accessibilityRole="button"
                onPress={() => props.onEnvironmentChange(environment.environmentId)}
              >
                <Text className="text-sm font-t3-bold text-foreground" numberOfLines={1}>
                  {environment.label}
                </Text>
                <View className="mt-1 flex-row items-center gap-1.5">
                  <View
                    className={`size-1.5 rounded-full ${connected ? "bg-success" : "bg-foreground-muted"}`}
                  />
                  <Text className="text-[11px] text-foreground-muted">
                    {statusLabel(environment.connectionState)}
                  </Text>
                </View>
                <Text className="mt-1 text-[11px] text-foreground-muted" numberOfLines={1}>
                  {connected ? "" : "Last known · "}
                  Needs you {summary?.attentionCount ?? 0} · Working {summary?.workingCount ?? 0}
                </Text>
              </Pressable>
              {thread ? (
                <Pressable
                  accessibilityLabel={`${action}: ${thread.title} on ${environment.label}`}
                  accessibilityRole="button"
                  className="mt-3 border-t border-border pt-2"
                  onPress={() => props.onSelectThread(thread)}
                >
                  <Text className="text-[11px] font-t3-medium text-foreground-muted">
                    {connected ? action : "Last known work"}
                  </Text>
                  <Text className="mt-0.5 text-xs font-t3-medium text-foreground" numberOfLines={1}>
                    {thread.title}
                  </Text>
                </Pressable>
              ) : (
                <Text className="mt-3 border-t border-border pt-2 text-xs text-foreground-muted">
                  No open threads
                </Text>
              )}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
