import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { KanbanCardId, type KanbanCard, type KanbanStatus } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  deriveKanbanCardExecutionStatus,
  type KanbanBoardState,
} from "@t3tools/client-runtime/state/kanban";
import { useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import {
  ActivityIcon,
  ArrowUpRightIcon,
  BellRingIcon,
  BotIcon,
  CalendarClockIcon,
  CheckIcon,
  Columns3Icon,
  HistoryIcon,
  LoaderIcon,
  PlusIcon,
  SettingsIcon,
  SquarePenIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { cn, randomUUID } from "../../lib/utils";
import { formatRelativeTimeLabel, parseTimestampDate } from "../../timestampFormat";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useThreadShells } from "../../state/entities";
import { kanbanEnvironment } from "../../state/kanban";
import { useEnvironmentQuery } from "../../state/query";
import { useSchedules } from "../../state/schedulesView";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProjectFavicon } from "../ProjectFavicon";
import { useSettingsProjectGroups } from "../settings/ProjectSettingsPanel";
import { formatScheduleInstant } from "../schedules/SchedulesPage.logic";
import { formatWorkingDurationLabel, parseTimestampMs } from "../Sidebar.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  BOARD_STATUSES,
  activityByDay,
  boardColumns,
  botRoster,
  partitionProjectActivity,
  projectMemberKeys,
  recentProjectThreads,
  statusLine,
  upcomingProjectSchedules,
  type BoardView,
  type BotRosterEntry,
} from "./ProjectHomePage.logic";

const NOW_REFRESH_MS = 30_000;

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), NOW_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const BOARD_STATUS_LABEL: Record<KanbanStatus, string> = {
  backlog: "Backlog",
  ready: "Ready",
  inProgress: "In progress",
  review: "Review",
  done: "Done",
};

const BOARD_STATUS_DOT: Record<KanbanStatus, string> = {
  backlog: "bg-muted-foreground/40",
  ready: "bg-info",
  inProgress: "bg-success",
  review: "bg-warning",
  done: "bg-muted-foreground/40",
};

const ATTENTION_BADGE = {
  approval: { label: "Approve", variant: "warning" },
  input: { label: "Answer", variant: "warning" },
  plan: { label: "Review plan", variant: "info" },
  failed: { label: "Retry", variant: "error" },
} as const;

const BOT_STATE_BADGE: Record<
  BotRosterEntry["state"],
  { readonly label: string; readonly variant: "success" | "info" | "warning" | "error" | "secondary" }
> = {
  waiting: { label: "Needs you", variant: "warning" },
  working: { label: "Working", variant: "success" },
  monitoring: { label: "Monitoring", variant: "info" },
  failed: { label: "Failed", variant: "error" },
  idle: { label: "Idle", variant: "secondary" },
};

function relativeLabel(iso: string): string {
  return parseTimestampDate(iso) === null ? "" : formatRelativeTimeLabel(iso);
}

function HomeSection(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly count?: number;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-3", props.className)}>
      <header className="flex items-center gap-2">
        <span className="text-muted-foreground [&_svg]:size-4">{props.icon}</span>
        <h2 className="text-sm font-medium text-foreground">{props.title}</h2>
        {props.count !== undefined ? (
          <span className="ms-auto text-xs tabular-nums text-muted-foreground">{props.count}</span>
        ) : null}
      </header>
      {props.children}
    </section>
  );
}

function HomeRow(props: {
  readonly title: string;
  readonly meta: string;
  readonly onClick?: () => void;
  readonly trailing?: ReactNode;
}) {
  return (
    <li>
      <button
        className="flex w-full min-w-0 items-center gap-3 rounded-lg px-2 py-1.5 text-start hover:bg-muted/60 disabled:hover:bg-transparent"
        disabled={props.onClick === undefined}
        onClick={props.onClick}
        type="button"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{props.title}</span>
          <span className="block truncate text-xs text-muted-foreground">{props.meta}</span>
        </span>
        {props.trailing}
      </button>
    </li>
  );
}

function failureMessage(result: { readonly _tag: string; readonly cause?: Cause.Cause<unknown> }) {
  if (result._tag !== "Failure" || result.cause === undefined) return null;
  const error = Cause.squash(result.cause);
  return error instanceof Error ? error.message : "The board update failed.";
}

export function ProjectHomePage({ projectKey }: { readonly projectKey: string }) {
  const navigate = useNavigate();
  const now = useNow();
  const groups = useSettingsProjectGroups();
  const group = groups.find((candidate) => candidate.projectKey === projectKey) ?? null;
  const representative =
    group?.memberProjects.find(
      (member) => member.environmentId === group.environmentId && member.id === group.id,
    ) ??
    group?.memberProjects[0] ??
    null;

  const memberProjects = group?.memberProjects;
  const keys = useMemo(() => projectMemberKeys(memberProjects ?? []), [memberProjects]);
  const threads = useThreadShells();
  const { schedules, isPending: schedulesPending } = useSchedules();
  const { handleNewThread } = useHandleNewThread();

  const boardQuery = useEnvironmentQuery(
    representative === null
      ? null
      : kanbanEnvironment.board({
          environmentId: representative.environmentId,
          input: { projectId: representative.id },
        }),
  );
  const board = useMemo(() => boardColumns(boardQuery.data?.cards ?? []), [boardQuery.data]);

  const { running, attention } = useMemo(
    () => partitionProjectActivity(threads, keys, now),
    [threads, keys, now],
  );
  const recent = useMemo(() => recentProjectThreads(threads, keys), [threads, keys]);
  const upcoming = useMemo(() => upcomingProjectSchedules(schedules, keys), [schedules, keys]);
  const activity = useMemo(() => activityByDay(threads, keys, now), [threads, keys, now]);
  const boardCards = boardQuery.data?.cards;
  const roster = useMemo(
    () => botRoster(threads, boardCards ?? [], keys),
    [threads, boardCards, keys],
  );

  const status = useMemo(
    () =>
      statusLine({
        attention: attention.length,
        running: running.length,
        ready: board.counts.ready,
        inProgress: board.counts.inProgress,
      }),
    [attention.length, running.length, board.counts.ready, board.counts.inProgress],
  );

  const openThread = useCallback(
    (row: { readonly environmentId: string; readonly threadId: string }) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: row.environmentId, threadId: row.threadId },
      });
    },
    [navigate],
  );

  const openBoard = useCallback(() => {
    void navigate({ to: "/kanban/$projectKey", params: { projectKey } });
  }, [navigate, projectKey]);

  const openSettings = useCallback(() => {
    void navigate({ to: "/projects/$projectKey", params: { projectKey } });
  }, [navigate, projectKey]);

  const startThread = useCallback(() => {
    if (representative === null) return;
    void handleNewThread(scopeProjectRef(representative.environmentId, representative.id));
  }, [handleNewThread, representative]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <WorkspaceBreadcrumb ariaLabel="Project home breadcrumb">
            <WorkspaceBreadcrumbItem current>
              {group?.displayName ?? "Project"}
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          {group === null || representative === null ? (
            <div className="grid min-h-0 flex-1 place-items-center p-12 text-sm text-muted-foreground">
              Project not found.
            </div>
          ) : (
            <WorkspacePageContainer width="expanded">
              <div className="flex flex-wrap items-center gap-3">
                <ProjectFavicon
                  environmentId={representative.environmentId}
                  cwd={representative.workspaceRoot}
                  projectName={group.displayName}
                  faviconPath={representative.faviconPath}
                  projectIcon={representative.projectIcon}
                  className="size-10 shrink-0 rounded-lg"
                />
                <div className="min-w-0 flex-1">
                  <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">
                    {group.displayName}
                  </h1>
                  <p className="truncate text-xs text-muted-foreground">
                    {representative.workspaceRoot}
                  </p>
                  <p className="mt-0.5 text-sm text-foreground/80">
                    {status ?? "Nothing in flight. Start something."}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={startThread}>
                    <SquarePenIcon /> New thread
                  </Button>
                  <Button size="sm" variant="outline" onClick={openBoard}>
                    <Columns3Icon /> Board
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Project settings for ${group.displayName}`}
                    onClick={openSettings}
                  >
                    <SettingsIcon />
                  </Button>
                </div>
              </div>

              {roster.length > 0 ? (
                <HomeSection count={roster.length} icon={<BotIcon />} title="The team">
                  <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {roster.map((bot) => (
                      <BotCard
                        key={`${bot.environmentId}:${bot.threadId}`}
                        bot={bot}
                        onClick={() =>
                          openThread({ environmentId: bot.environmentId, threadId: bot.threadId })
                        }
                      />
                    ))}
                  </div>
                </HomeSection>
              ) : null}

              {attention.length > 0 ? (
                <HomeSection
                  count={attention.length}
                  icon={<BellRingIcon />}
                  title="Waiting on you"
                >
                  <ul className="-mx-2 flex flex-col">
                    {attention.map((row) => {
                      const badge = ATTENTION_BADGE[row.attentionReason ?? "input"];
                      return (
                        <HomeRow
                          key={`${row.environmentId}:${row.threadId}`}
                          meta={relativeLabel(row.sortAt)}
                          title={row.title}
                          trailing={<Badge variant={badge.variant}>{badge.label}</Badge>}
                          onClick={() => openThread(row)}
                        />
                      );
                    })}
                  </ul>
                </HomeSection>
              ) : null}

              <BoardHero
                board={board}
                cards={boardQuery.data?.cards ?? []}
                delegations={boardQuery.data?.delegations ?? []}
                error={boardQuery.error}
                isPending={boardQuery.isPending && boardQuery.data === null}
                environmentId={representative.environmentId}
                projectId={representative.id}
                onOpenBoard={openBoard}
                onRefresh={boardQuery.refresh}
              />

              <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
                <HomeSection count={recent.length} icon={<HistoryIcon />} title="Jump back in">
                  {recent.length === 0 ? (
                    <p className="px-2 py-1.5 text-sm text-muted-foreground">
                      No threads yet. Start one and it will show up here.
                    </p>
                  ) : (
                    <ul className="-mx-2 flex flex-col">
                      {recent.map((thread) => (
                        <HomeRow
                          key={`${thread.environmentId}:${thread.id}`}
                          meta={[thread.branch, relativeLabel(thread.updatedAt)]
                            .filter((part) => part != null && part !== "")
                            .join(" · ")}
                          title={thread.title}
                          trailing={
                            <ArrowUpRightIcon className="size-3.5 text-muted-foreground" />
                          }
                          onClick={() =>
                            openThread({ environmentId: thread.environmentId, threadId: thread.id })
                          }
                        />
                      ))}
                    </ul>
                  )}
                </HomeSection>

                <div className="flex min-w-0 flex-col gap-6">
                  <HomeSection count={running.length} icon={<LoaderIcon />} title="Running now">
                    {running.length === 0 ? (
                      <p className="px-2 py-1.5 text-sm text-muted-foreground">
                        No agents are working here right now.
                      </p>
                    ) : (
                      <ul className="-mx-2 flex flex-col">
                        {running.map((row) => (
                          <HomeRow
                            key={`${row.environmentId}:${row.threadId}`}
                            meta={formatWorkingDurationLabel(
                              now.getTime() - parseTimestampMs(row.sortAt),
                            )}
                            title={row.title}
                            trailing={
                              <Badge variant={row.status === "monitoring" ? "info" : "success"}>
                                {row.status === "monitoring" ? "Monitoring" : "Working"}
                              </Badge>
                            }
                            onClick={() => openThread(row)}
                          />
                        ))}
                      </ul>
                    )}
                  </HomeSection>

                  <HomeSection
                    count={upcoming.length}
                    icon={<CalendarClockIcon />}
                    title="Upcoming"
                  >
                    {schedulesPending && upcoming.length === 0 ? (
                      <p className="px-2 py-1.5 text-sm text-muted-foreground">
                        Loading schedules…
                      </p>
                    ) : upcoming.length === 0 ? (
                      <p className="px-2 py-1.5 text-sm text-muted-foreground">
                        No schedules for this project.
                      </p>
                    ) : (
                      <ul className="-mx-2 flex flex-col">
                        {upcoming.map((row) => (
                          <HomeRow
                            key={`${row.environmentId}:${row.scheduleId}`}
                            meta={formatScheduleInstant(row.nextRunAt, row.timeZone)}
                            title={row.title}
                          />
                        ))}
                      </ul>
                    )}
                    <button
                      className="mt-auto px-2 text-start text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => void navigate({ to: "/schedules" })}
                      type="button"
                    >
                      All schedules
                    </button>
                  </HomeSection>

                  <HomeSection icon={<ActivityIcon />} title="Activity">
                    <ActivityStrip activity={activity} />
                  </HomeSection>
                </div>
              </div>
            </WorkspacePageContainer>
          )}
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function BotCard(props: { readonly bot: BotRosterEntry; readonly onClick: () => void }) {
  const badge = BOT_STATE_BADGE[props.bot.state];
  return (
    <button
      className="flex min-w-0 items-center gap-3 rounded-lg border border-border/70 bg-card p-3 text-start transition-colors hover:bg-muted/50"
      onClick={props.onClick}
      type="button"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
        <BotIcon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{props.bot.displayName}</span>
          <Badge size="sm" variant={badge.variant}>
            {badge.label}
          </Badge>
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {props.bot.description ??
            (props.bot.openTasks > 0
              ? `${props.bot.openTasks} open ${props.bot.openTasks === 1 ? "task" : "tasks"} on the board`
              : "No open tasks")}
        </span>
      </span>
    </button>
  );
}

function ActivityStrip({
  activity,
}: {
  readonly activity: ReturnType<typeof activityByDay>;
}) {
  const max = Math.max(1, ...activity.map((day) => day.count));
  const total = activity.reduce((sum, day) => sum + day.count, 0);
  return (
    <div className="px-2">
      <div
        className="flex h-10 items-end gap-[3px]"
        role="img"
        aria-label={`${total} threads touched over the last ${activity.length} days`}
      >
        {activity.map((day, index) => (
          <Tooltip key={day.day}>
            <TooltipTrigger
              render={
                <div
                  className={cn(
                    "min-w-0 flex-1 rounded-[2px]",
                    index === activity.length - 1
                      ? "bg-foreground/55"
                      : day.count > 0
                        ? "bg-muted-foreground/35"
                        : "bg-muted-foreground/12",
                  )}
                  style={{ height: `${Math.max(8, (day.count / max) * 100)}%` }}
                />
              }
            />
            <TooltipPopup>
              {day.count} {day.count === 1 ? "thread" : "threads"} · {day.day}
            </TooltipPopup>
          </Tooltip>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Threads touched per day, last {activity.length} days
      </p>
    </div>
  );
}

function BoardHero(props: {
  readonly board: BoardView;
  readonly cards: readonly KanbanCard[];
  readonly delegations: KanbanBoardState["delegations"];
  readonly error: string | null;
  readonly isPending: boolean;
  readonly environmentId: Parameters<typeof kanbanEnvironment.board>[0]["environmentId"];
  readonly projectId: Parameters<typeof kanbanEnvironment.board>[0]["input"]["projectId"];
  readonly onOpenBoard: () => void;
  readonly onRefresh: () => void;
}) {
  const threads = useThreadShells();
  const bots = useMemo(
    () =>
      threads.filter(
        (thread) =>
          thread.environmentId === props.environmentId &&
          thread.projectId === props.projectId &&
          thread.botProfile != null &&
          thread.archivedAt === null,
      ),
    [props.environmentId, props.projectId, threads],
  );
  const createCard = useAtomCommand(kanbanEnvironment.createCard, { reportFailure: false });
  const moveCard = useAtomCommand(kanbanEnvironment.moveCard, { reportFailure: false });
  const [newTitle, setNewTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [activeCardId, setActiveCardId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor),
  );

  const run = useCallback(
    async (operation: Promise<{ readonly _tag: string; readonly cause?: Cause.Cause<unknown> }>) => {
      const result = await operation;
      const message = failureMessage(result);
      if (message !== null) {
        toastManager.add({ type: "error", title: "Kanban update failed", description: message });
        props.onRefresh();
      }
      return message === null;
    },
    [props],
  );

  const addCard = useCallback(async () => {
    const title = newTitle.trim();
    if (title.length === 0 || submitting) return;
    setSubmitting(true);
    const succeeded = await run(
      createCard({
        environmentId: props.environmentId,
        input: {
          cardId: KanbanCardId.make(randomUUID()),
          projectId: props.projectId,
          title,
          description: "",
          assigneeThreadId: null,
          placement: { status: "backlog", relation: "last" },
        },
      }),
    );
    setSubmitting(false);
    if (succeeded) setNewTitle("");
  }, [createCard, newTitle, props.environmentId, props.projectId, run, submitting]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveCardId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveCardId(null);
      const card = props.cards.find((candidate) => candidate.id === event.active.id);
      const target = event.over?.id;
      if (
        card === undefined ||
        typeof target !== "string" ||
        target === card.status ||
        !BOARD_STATUSES.includes(target as KanbanStatus)
      ) {
        return;
      }
      void run(
        moveCard({
          environmentId: props.environmentId,
          input: {
            cardId: card.id,
            expectedRevision: card.revision,
            placement: { status: target as KanbanStatus, relation: "last" },
          },
        }),
      );
    },
    [moveCard, props.cards, props.environmentId, run],
  );

  const activeCard =
    activeCardId === null
      ? null
      : (props.cards.find((candidate) => candidate.id === activeCardId) ?? null);

  return (
    <HomeSection count={props.board.total} icon={<Columns3Icon />} title="Board">
      {props.error !== null ? (
        <div className="flex items-center gap-3 px-2 py-1.5 text-sm">
          <span className="min-w-0 flex-1 truncate text-destructive">{props.error}</span>
          <Button size="sm" variant="outline" onClick={props.onRefresh}>
            Retry
          </Button>
        </div>
      ) : props.isPending ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">Loading board…</p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Input
              aria-label="New task title"
              placeholder="Dump a task here — it lands in the backlog…"
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void addCard();
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={newTitle.trim().length === 0 || submitting}
              onClick={() => void addCard()}
            >
              <PlusIcon /> Add
            </Button>
          </div>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setActiveCardId(null)}
          >
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {props.board.columns.map((column) => (
                <BoardColumn
                  key={column.status}
                  column={column}
                  bots={bots}
                  delegations={props.delegations}
                  onOpenBoard={props.onOpenBoard}
                />
              ))}
            </div>
            <DragOverlay>
              {activeCard === null ? null : (
                <div className="rounded-md border border-border bg-card p-2 text-xs font-medium shadow-lg">
                  {activeCard.title}
                </div>
              )}
            </DragOverlay>
          </DndContext>
        </>
      )}
      <button
        className="mt-auto px-2 text-start text-xs text-muted-foreground hover:text-foreground"
        onClick={props.onOpenBoard}
        type="button"
      >
        Open board
      </button>
    </HomeSection>
  );
}

function BoardColumn(props: {
  readonly column: BoardView["columns"][number];
  readonly bots: ReturnType<typeof useThreadShells>;
  readonly delegations: KanbanBoardState["delegations"];
  readonly onOpenBoard: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: props.column.status });
  return (
    <section
      ref={setNodeRef}
      className={cn(
        "flex min-h-24 min-w-0 flex-col gap-1.5 rounded-lg border border-border/70 bg-muted/25 p-1.5 transition-colors",
        isOver && "border-ring bg-muted/50",
      )}
    >
      <header className="flex items-center gap-1.5 px-1 pt-0.5">
        {props.column.status === "done" ? (
          <CheckIcon className="size-2.5 text-muted-foreground" />
        ) : (
          <span
            className={cn("size-1.5 rounded-full", BOARD_STATUS_DOT[props.column.status])}
            aria-hidden="true"
          />
        )}
        <h3 className="text-[11px] font-medium text-muted-foreground">
          {BOARD_STATUS_LABEL[props.column.status]}
        </h3>
        <span className="ms-auto text-[10px] tabular-nums text-muted-foreground/70">
          {props.column.cards.length + props.column.overflow}
        </span>
      </header>
      {props.column.cards.map((card) => (
        <BoardCard
          key={card.id}
          card={card}
          bots={props.bots}
          delegation={
            props.delegations.find((delegation) => delegation.id === card.delegationId) ?? null
          }
          onOpenBoard={props.onOpenBoard}
        />
      ))}
      {props.column.overflow > 0 ? (
        <button
          className="rounded px-1 py-0.5 text-start text-[11px] text-muted-foreground hover:text-foreground"
          onClick={props.onOpenBoard}
          type="button"
        >
          +{props.column.overflow} more
        </button>
      ) : null}
    </section>
  );
}

function BoardCard(props: {
  readonly card: KanbanCard;
  readonly bots: ReturnType<typeof useThreadShells>;
  readonly delegation: NonNullable<KanbanBoardState["delegations"]>[number] | null;
  readonly onOpenBoard: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: props.card.id,
  });
  const assignee = props.bots.find((bot) => bot.id === props.card.assigneeThreadId) ?? null;
  const executionStatus = deriveKanbanCardExecutionStatus({
    card: props.card,
    delegation: props.delegation,
    assignee,
  });
  return (
    <article
      ref={setNodeRef}
      style={
        transform === null
          ? undefined
          : { transform: `translate(${transform.x}px, ${transform.y}px)` }
      }
      className={cn(
        "min-w-0 cursor-grab rounded-md border border-border/70 bg-card p-2 active:cursor-grabbing",
        isDragging && "opacity-40",
      )}
      onClick={props.onOpenBoard}
      {...attributes}
      {...listeners}
    >
      <h4 className="line-clamp-2 text-xs font-medium leading-4">{props.card.title}</h4>
      {assignee !== null || executionStatus !== null ? (
        <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
          {assignee !== null ? (
            <span className="flex min-w-0 items-center gap-0.5">
              <BotIcon className="size-2.5 shrink-0" />
              <span className="truncate">
                {assignee.botProfile?.displayName ?? assignee.title}
              </span>
            </span>
          ) : null}
          {executionStatus !== null ? (
            <span className="ms-auto shrink-0 capitalize">{executionStatus}</span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
