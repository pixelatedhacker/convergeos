import { useAtomValue } from "@effect/atom-react";
import { KanbanCardId, type KanbanStatus } from "@t3tools/contracts";
import { deriveKanbanCardExecutionStatus } from "@t3tools/client-runtime/state/kanban";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { uuidv4 } from "../../lib/uuid";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects, useThreadShells } from "../../state/entities";
import { kanbanEnvironment } from "../../state/kanban";
import { useAtomCommand } from "../../state/use-atom-command";

const COLUMNS: ReadonlyArray<{ readonly status: KanbanStatus; readonly label: string }> = [
  { status: "backlog", label: "Backlog" },
  { status: "ready", label: "Ready" },
  { status: "inProgress", label: "In progress" },
  { status: "review", label: "Review" },
  { status: "done", label: "Done" },
];

export function KanbanRouteScreen() {
  const projects = useProjects();
  const insets = useSafeAreaInsets();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected =
    projects.find((project) => `${project.environmentId}:${project.id}` === selectedKey) ??
    projects[0] ??
    null;

  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Kanban" />
        </>
      ) : null}
      {projects.length === 0 ? (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-base text-foreground-muted">
            Connect an environment with a project to open its board.
          </Text>
        </View>
      ) : (
        <>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            className="max-h-14 border-b border-border-subtle"
            contentContainerClassName="items-center gap-2 px-4 py-2"
          >
            {projects.map((project) => {
              const key = `${project.environmentId}:${project.id}`;
              const active =
                selected?.environmentId === project.environmentId && selected.id === project.id;
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
                    {project.title}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
          {selected === null ? null : (
            <MobileProjectBoard
              key={`${selected.environmentId}:${selected.id}`}
              environmentId={selected.environmentId}
              projectId={selected.id}
              bottomInset={insets.bottom}
            />
          )}
        </>
      )}
    </View>
  );
}

function MobileProjectBoard({
  environmentId,
  projectId,
  bottomInset,
}: {
  environmentId: Parameters<typeof kanbanEnvironment.board>[0]["environmentId"];
  projectId: Parameters<typeof kanbanEnvironment.board>[0]["input"]["projectId"];
  bottomInset: number;
}) {
  const result = useAtomValue(kanbanEnvironment.board({ environmentId, input: { projectId } }));
  const board = Option.getOrNull(AsyncResult.value(result));
  const threads = useThreadShells();
  const botNameById = useMemo(
    () =>
      new Map(
        threads
          .filter(
            (thread) =>
              thread.environmentId === environmentId &&
              thread.projectId === projectId &&
              thread.botProfile != null,
          )
          .map((thread) => [thread.id, thread.botProfile?.displayName ?? thread.title]),
      ),
    [environmentId, projectId, threads],
  );
  const botById = useMemo(
    () =>
      new Map(
        threads
          .filter(
            (thread) => thread.environmentId === environmentId && thread.projectId === projectId,
          )
          .map((thread) => [thread.id, thread]),
      ),
    [environmentId, projectId, threads],
  );
  const createCard = useAtomCommand(kanbanEnvironment.createCard, { reportFailure: false });
  const moveCard = useAtomCommand(kanbanEnvironment.moveCard, { reportFailure: false });
  const deleteCard = useAtomCommand(kanbanEnvironment.deleteCard, { reportFailure: false });
  const retryCard = useAtomCommand(kanbanEnvironment.retryCard, { reportFailure: false });
  const [title, setTitle] = useState("");

  const report = async (
    operation: Promise<{ readonly _tag: string; readonly cause?: Cause.Cause<unknown> }>,
  ) => {
    const settled = await operation;
    if (settled._tag !== "Failure" || settled.cause === undefined) return true;
    const error = Cause.squash(settled.cause);
    Alert.alert("Kanban update failed", error instanceof Error ? error.message : "Try again.");
    return false;
  };

  const add = async () => {
    const nextTitle = title.trim();
    if (nextTitle.length === 0) return;
    const succeeded = await report(
      createCard({
        environmentId,
        input: {
          cardId: KanbanCardId.make(uuidv4()),
          projectId,
          title: nextTitle,
          description: "",
          assigneeThreadId: null,
          placement: { status: "backlog", relation: "last" },
        },
      }),
    );
    if (succeeded) setTitle("");
  };

  return (
    <View className="min-h-0 flex-1">
      <View className="flex-row items-center gap-2 border-b border-border-subtle px-4 py-3">
        <TextInput
          className="min-w-0 flex-1 rounded-xl bg-card px-3 py-2 text-base text-foreground"
          placeholder="Add a task…"
          placeholderTextColorClassName="accent-foreground-muted"
          value={title}
          onChangeText={setTitle}
          onSubmitEditing={() => void add()}
        />
        <Pressable
          accessibilityLabel="Add Kanban task"
          accessibilityRole="button"
          className="size-10 items-center justify-center rounded-full bg-accent active:opacity-70"
          disabled={title.trim().length === 0}
          onPress={() => void add()}
        >
          <SymbolView
            name="plus"
            size={18}
            tintColorClassName="accent-accent-foreground"
            type="monochrome"
            weight="semibold"
          />
        </Pressable>
      </View>
      {board === null ? (
        <View className="flex-1 items-center justify-center">
          <Text className="text-foreground-muted">Loading board…</Text>
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-3 p-4"
          contentContainerStyle={{ paddingBottom: Math.max(bottomInset, 16) }}
        >
          {COLUMNS.map((column, columnIndex) => {
            const cards = board.cards
              .filter((card) => card.status === column.status)
              .sort((left, right) => left.orderKey.localeCompare(right.orderKey));
            return (
              <View key={column.status} className="w-72 rounded-2xl bg-card-subtle p-3">
                <View className="mb-3 flex-row items-center">
                  <Text className="font-t3-bold text-foreground">{column.label}</Text>
                  <Text className="ml-auto text-sm text-foreground-muted">{cards.length}</Text>
                </View>
                <View className="gap-2">
                  {cards.map((card) => (
                    <View key={card.id} className="rounded-xl bg-card p-3">
                      <Text className="font-t3-medium text-foreground">{card.title}</Text>
                      {card.description.length === 0 ? null : (
                        <Text className="mt-1 text-sm text-foreground-muted" numberOfLines={3}>
                          {card.description}
                        </Text>
                      )}
                      {card.assigneeThreadId === null ? null : (
                        <Text className="mt-2 text-xs text-foreground-muted">
                          Bot · {botNameById.get(card.assigneeThreadId) ?? "Unavailable"}
                        </Text>
                      )}
                      {(() => {
                        const status = deriveKanbanCardExecutionStatus({
                          card,
                          delegation:
                            board.delegations.find(
                              (delegation) => delegation.id === card.delegationId,
                            ) ?? null,
                          assignee:
                            card.assigneeThreadId === null
                              ? null
                              : (botById.get(card.assigneeThreadId) ?? null),
                        });
                        if (status === null) return null;
                        return (
                          <View className="mt-2 flex-row items-center gap-2">
                            <Text className="text-xs capitalize text-foreground-muted">
                              {status}
                            </Text>
                            {status === "failed" || status === "interrupted" ? (
                              <Pressable
                                accessibilityLabel={`Retry ${card.title}`}
                                accessibilityRole="button"
                                className="rounded-full border border-border px-2 py-1"
                                onPress={() =>
                                  void report(
                                    retryCard({
                                      environmentId,
                                      input: {
                                        cardId: card.id,
                                        expectedRevision: card.revision,
                                      },
                                    }),
                                  )
                                }
                              >
                                <Text className="text-xs text-foreground">Retry</Text>
                              </Pressable>
                            ) : null}
                          </View>
                        );
                      })()}
                      <View className="mt-3 flex-row items-center border-t border-border-subtle pt-2">
                        <CardAction
                          icon="arrow.left"
                          label={`Move ${card.title} left`}
                          disabled={columnIndex === 0}
                          onPress={() => {
                            const target = COLUMNS[columnIndex - 1];
                            if (target === undefined) return;
                            void report(
                              moveCard({
                                environmentId,
                                input: {
                                  cardId: card.id,
                                  expectedRevision: card.revision,
                                  placement: { status: target.status, relation: "last" },
                                },
                              }),
                            );
                          }}
                        />
                        <CardAction
                          icon="arrow.right"
                          label={`Move ${card.title} right`}
                          disabled={columnIndex === COLUMNS.length - 1}
                          onPress={() => {
                            const target = COLUMNS[columnIndex + 1];
                            if (target === undefined) return;
                            void report(
                              moveCard({
                                environmentId,
                                input: {
                                  cardId: card.id,
                                  expectedRevision: card.revision,
                                  placement: { status: target.status, relation: "last" },
                                },
                              }),
                            );
                          }}
                        />
                        <View className="flex-1" />
                        <CardAction
                          destructive
                          icon="trash"
                          label={`Delete ${card.title}`}
                          onPress={() =>
                            Alert.alert("Delete task?", card.title, [
                              { text: "Cancel", style: "cancel" },
                              {
                                text: "Delete",
                                style: "destructive",
                                onPress: () =>
                                  void report(
                                    deleteCard({
                                      environmentId,
                                      input: {
                                        cardId: card.id,
                                        expectedRevision: card.revision,
                                      },
                                    }),
                                  ),
                              },
                            ])
                          }
                        />
                      </View>
                    </View>
                  ))}
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

function CardAction({
  icon,
  label,
  disabled = false,
  destructive = false,
  onPress,
}: {
  icon: "arrow.left" | "arrow.right" | "trash";
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      disabled={disabled}
      className="size-9 items-center justify-center rounded-full active:bg-subtle"
      onPress={onPress}
    >
      <SymbolView
        name={icon}
        size={16}
        tintColorClassName={
          destructive ? "accent-danger" : disabled ? "accent-icon-disabled" : "accent-icon"
        }
        type="monochrome"
      />
    </Pressable>
  );
}
