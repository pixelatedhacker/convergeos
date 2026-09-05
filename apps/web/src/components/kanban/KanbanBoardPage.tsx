import { KanbanCardId, type KanbanCard, type KanbanStatus } from "@t3tools/contracts";
import {
  deriveKanbanCardExecutionStatus,
  type KanbanBoardState,
} from "@t3tools/client-runtime/state/kanban";
import { useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import {
  ArrowLeftIcon,
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  BotIcon,
  Columns3Icon,
  PencilIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { randomUUID } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { useThreadShells } from "../../state/entities";
import { kanbanEnvironment } from "../../state/kanban";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsProjectGroups } from "../settings/ProjectSettingsPanel";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

const COLUMNS: ReadonlyArray<{ readonly status: KanbanStatus; readonly label: string }> = [
  { status: "backlog", label: "Backlog" },
  { status: "ready", label: "Ready" },
  { status: "inProgress", label: "In progress" },
  { status: "review", label: "Review" },
  { status: "done", label: "Done" },
];

function failureMessage(result: { readonly _tag: string; readonly cause?: Cause.Cause<unknown> }) {
  if (result._tag !== "Failure" || result.cause === undefined) return null;
  const error = Cause.squash(result.cause);
  return error instanceof Error ? error.message : "The board update failed.";
}

export function KanbanBoardPage({ projectKey }: { readonly projectKey: string }) {
  const groups = useSettingsProjectGroups();
  const group = groups.find((candidate) => candidate.projectKey === projectKey) ?? null;
  const representative =
    group?.memberProjects.find(
      (member) => member.environmentId === group.environmentId && member.id === group.id,
    ) ??
    group?.memberProjects[0] ??
    null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron}>
          <KanbanBreadcrumb projectKey={projectKey} title={group?.displayName ?? "Project"} />
        </WorkspacePageHeader>
        {representative === null ? (
          <div className="grid min-h-0 flex-1 place-items-center text-sm text-muted-foreground">
            Project not found.
          </div>
        ) : (
          <KanbanBoard environmentId={representative.environmentId} projectId={representative.id} />
        )}
      </div>
    </SidebarInset>
  );
}

function KanbanBreadcrumb({ projectKey, title }: { projectKey: string; title: string }) {
  const navigate = useNavigate();
  return (
    <WorkspaceBreadcrumb ariaLabel="Kanban navigation">
      <WorkspaceBreadcrumbItem>
        <button
          type="button"
          className="truncate hover:text-foreground"
          onClick={() => void navigate({ to: "/projects/$projectKey", params: { projectKey } })}
        >
          {title}
        </button>
      </WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator />
      <WorkspaceBreadcrumbItem>
        <span className="inline-flex items-center gap-1.5">
          <Columns3Icon className="size-3.5" /> Kanban
        </span>
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}

function KanbanBoard({
  environmentId,
  projectId,
}: {
  environmentId: Parameters<typeof kanbanEnvironment.board>[0]["environmentId"];
  projectId: Parameters<typeof kanbanEnvironment.board>[0]["input"]["projectId"];
}) {
  const query = useEnvironmentQuery(
    kanbanEnvironment.board({ environmentId, input: { projectId } }),
  );
  const threads = useThreadShells();
  const bots = useMemo(
    () =>
      threads.filter(
        (thread) =>
          thread.environmentId === environmentId &&
          thread.projectId === projectId &&
          thread.botProfile != null &&
          thread.archivedAt === null,
      ),
    [environmentId, projectId, threads],
  );
  const createCard = useAtomCommand(kanbanEnvironment.createCard, { reportFailure: false });
  const updateCard = useAtomCommand(kanbanEnvironment.updateCard, { reportFailure: false });
  const moveCard = useAtomCommand(kanbanEnvironment.moveCard, { reportFailure: false });
  const deleteCard = useAtomCommand(kanbanEnvironment.deleteCard, { reportFailure: false });
  const retryCard = useAtomCommand(kanbanEnvironment.retryCard, { reportFailure: false });
  const [newTitle, setNewTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const cards = query.data?.cards ?? [];

  const run = useCallback(
    async (
      operation: Promise<{ readonly _tag: string; readonly cause?: Cause.Cause<unknown> }>,
    ) => {
      const result = await operation;
      const message = failureMessage(result);
      if (message !== null)
        toastManager.add({ type: "error", title: "Kanban update failed", description: message });
      return message === null;
    },
    [],
  );

  const addCard = useCallback(async () => {
    const title = newTitle.trim();
    if (title.length === 0 || submitting) return;
    setSubmitting(true);
    const succeeded = await run(
      createCard({
        environmentId,
        input: {
          cardId: KanbanCardId.make(randomUUID()),
          projectId,
          title,
          description: "",
          assigneeThreadId: null,
          placement: { status: "backlog", relation: "last" },
        },
      }),
    );
    setSubmitting(false);
    if (succeeded) setNewTitle("");
  }, [createCard, environmentId, newTitle, projectId, run, submitting]);

  if (query.error !== null) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center gap-3 text-sm">
        <div className="text-destructive">{query.error}</div>
        <Button size="sm" variant="outline" onClick={query.refresh}>
          Retry
        </Button>
      </div>
    );
  }

  if (query.isPending && query.data === null) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center text-sm text-muted-foreground">
        Loading board…
      </div>
    );
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <Input
          aria-label="New Kanban card title"
          className="max-w-md"
          placeholder="Add a task to the backlog…"
          value={newTitle}
          onChange={(event) => setNewTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void addCard();
          }}
        />
        <Button
          size="sm"
          disabled={newTitle.trim().length === 0 || submitting}
          onClick={() => void addCard()}
        >
          <PlusIcon /> Add task
        </Button>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {cards.length} {cards.length === 1 ? "task" : "tasks"}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-4">
        <div className="grid h-full min-w-[1100px] grid-cols-5 gap-3">
          {COLUMNS.map((column, columnIndex) => {
            const columnCards = cards
              .filter((card) => card.status === column.status)
              .sort((left, right) => left.orderKey.localeCompare(right.orderKey));
            return (
              <section
                key={column.status}
                className="flex min-h-0 flex-col rounded-lg border bg-muted/25"
              >
                <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
                  <h2 className="text-xs font-semibold uppercase tracking-wide">{column.label}</h2>
                  <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                    {columnCards.length}
                  </span>
                </header>
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
                  {columnCards.map((card, cardIndex) => (
                    <KanbanCardView
                      key={card.id}
                      card={card}
                      bots={bots}
                      delegation={
                        query.data?.delegations.find(
                          (delegation) => delegation.id === card.delegationId,
                        ) ?? null
                      }
                      canMoveLeft={columnIndex > 0}
                      canMoveRight={columnIndex < COLUMNS.length - 1}
                      canMoveUp={cardIndex > 0}
                      canMoveDown={cardIndex < columnCards.length - 1}
                      onMoveColumn={(direction) => {
                        const target = COLUMNS[columnIndex + direction];
                        if (target === undefined) return Promise.resolve();
                        return run(
                          moveCard({
                            environmentId,
                            input: {
                              cardId: card.id,
                              expectedRevision: card.revision,
                              placement: { status: target.status, relation: "last" },
                            },
                          }),
                        ).then(() => undefined);
                      }}
                      onReorder={(direction) => {
                        const target = columnCards[cardIndex + direction];
                        if (target === undefined) return Promise.resolve();
                        return run(
                          moveCard({
                            environmentId,
                            input: {
                              cardId: card.id,
                              expectedRevision: card.revision,
                              placement: {
                                status: column.status,
                                relation: direction < 0 ? "before" : "after",
                                cardId: target.id,
                              },
                            },
                          }),
                        ).then(() => undefined);
                      }}
                      onSave={(input) =>
                        run(
                          updateCard({
                            environmentId,
                            input: { cardId: card.id, expectedRevision: card.revision, ...input },
                          }),
                        )
                      }
                      onDelete={() =>
                        run(
                          deleteCard({
                            environmentId,
                            input: { cardId: card.id, expectedRevision: card.revision },
                          }),
                        ).then(() => undefined)
                      }
                      onRetry={() =>
                        run(
                          retryCard({
                            environmentId,
                            input: { cardId: card.id, expectedRevision: card.revision },
                          }),
                        ).then(() => undefined)
                      }
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </main>
  );
}

function KanbanCardView({
  card,
  bots,
  delegation,
  canMoveLeft,
  canMoveRight,
  canMoveUp,
  canMoveDown,
  onMoveColumn,
  onReorder,
  onSave,
  onDelete,
  onRetry,
}: {
  card: KanbanCard;
  bots: ReturnType<typeof useThreadShells>;
  delegation: NonNullable<KanbanBoardState["delegations"]>[number] | null;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveColumn: (direction: -1 | 1) => Promise<void>;
  onReorder: (direction: -1 | 1) => Promise<void>;
  onSave: (input: {
    title: string;
    description: string;
    assigneeThreadId: KanbanCard["assigneeThreadId"];
  }) => Promise<boolean>;
  onDelete: () => Promise<void>;
  onRetry: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);
  const [assignee, setAssignee] = useState<string>(card.assigneeThreadId ?? "");
  const assigneeBot = bots.find((bot) => bot.id === card.assigneeThreadId) ?? null;
  const executionStatus = deriveKanbanCardExecutionStatus({
    card,
    delegation,
    assignee: assigneeBot,
  });

  useEffect(() => {
    if (editing) return;
    setTitle(card.title);
    setDescription(card.description);
    setAssignee(card.assigneeThreadId ?? "");
  }, [card.assigneeThreadId, card.description, card.title, editing]);

  if (editing) {
    return (
      <article className="space-y-2 rounded-md border bg-card p-2.5 shadow-sm">
        <Input
          aria-label="Task title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Textarea
          aria-label="Task description"
          className="min-h-20 resize-y"
          placeholder="Description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <label className="block text-[11px] text-muted-foreground">
          Assign bot
          <select
            className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs text-foreground"
            value={assignee}
            onChange={(event) => setAssignee(event.target.value)}
          >
            <option value="">Unassigned</option>
            {bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.botProfile?.displayName ?? bot.title}
              </option>
            ))}
          </select>
        </label>
        <div className="flex justify-end gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Cancel editing"
            onClick={() => setEditing(false)}
          >
            <XIcon />
          </Button>
          <Button
            size="icon-xs"
            aria-label="Save task"
            disabled={title.trim().length === 0}
            onClick={() =>
              void onSave({
                title: title.trim(),
                description: description.trim(),
                assigneeThreadId:
                  assignee === "" ? null : (bots.find((bot) => bot.id === assignee)?.id ?? null),
              }).then((succeeded) => {
                if (succeeded) setEditing(false);
              })
            }
          >
            <SaveIcon />
          </Button>
        </div>
      </article>
    );
  }

  return (
    <article className="group rounded-md border bg-card p-2.5 shadow-sm">
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-medium leading-5">{card.title}</h3>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Edit ${card.title}`}
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => setEditing(true)}
        >
          <PencilIcon />
        </Button>
      </div>
      {card.description.length > 0 ? (
        <p className="mt-1 line-clamp-3 text-xs leading-4 text-muted-foreground">
          {card.description}
        </p>
      ) : null}
      {assigneeBot !== null ? (
        <div className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
          <BotIcon className="size-3" />
          {assigneeBot.botProfile?.displayName ?? assigneeBot.title}
        </div>
      ) : null}
      {executionStatus === null ? null : (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="capitalize">{executionStatus}</span>
          {executionStatus === "failed" || executionStatus === "interrupted" ? (
            <Button size="xs" variant="outline" onClick={() => void onRetry()}>
              Retry
            </Button>
          ) : null}
        </div>
      )}
      <div className="mt-2 flex items-center gap-1 border-t pt-2">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Move ${card.title} left`}
          disabled={!canMoveLeft}
          onClick={() => void onMoveColumn(-1)}
        >
          <ArrowLeftIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Move ${card.title} right`}
          disabled={!canMoveRight}
          onClick={() => void onMoveColumn(1)}
        >
          <ArrowRightIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Move ${card.title} up`}
          disabled={!canMoveUp}
          onClick={() => void onReorder(-1)}
        >
          <ArrowUpIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Move ${card.title} down`}
          disabled={!canMoveDown}
          onClick={() => void onReorder(1)}
        >
          <ArrowDownIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Delete ${card.title}`}
          className="ml-auto text-destructive"
          onClick={() => {
            if (window.confirm(`Delete “${card.title}”?`)) void onDelete();
          }}
        >
          <Trash2Icon />
        </Button>
      </div>
    </article>
  );
}
