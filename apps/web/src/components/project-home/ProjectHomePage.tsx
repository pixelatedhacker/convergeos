import { KanbanCardId, type KanbanCard } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  deriveKanbanCardExecutionStatus,
  type KanbanBoardState,
} from "@t3tools/client-runtime/state/kanban";
import { useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import {
  ArrowUpRightIcon,
  BellRingIcon,
  BotIcon,
  CalendarClockIcon,
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
import { useSettingsProjectGroups } from "../settings/ProjectSettingsPanel";
import { formatScheduleInstant } from "../schedules/SchedulesPage.logic";
import { formatWorkingDurationLabel, parseTimestampMs } from "../Sidebar.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  BOARD_STATUSES,
  partitionProjectActivity,
  projectMemberKeys,
  recentProjectThreads,
  summarizeProjectBoard,
  upcomingProjectSchedules,
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

const BOARD_STATUS_LABEL: Record<(typeof BOARD_STATUSES)[number], string> = {
  backlog: "Backlog",
  ready: "Ready",
  inProgress: "In progress",
  review: "Review",
  done: "Done",
};

const ATTENTION_BADGE = {
  approval: { label: "Approval", variant: "warning" },
  input: { label: "Input", variant: "warning" },
  plan: { label: "Plan ready", variant: "info" },
  failed: { label: "Failed", variant: "error" },
} as const;

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

  const keys = useMemo(
    () => projectMemberKeys(group?.memberProjects ?? []),
    [group?.memberProjects],
  );
  const threads = useThreadShells();
  const { schedules, isPending: schedulesPending } = useSchedules();
  const { handleNewThread } = useHandleNewThread();

  const { running, attention } = useMemo(
    () => partitionProjectActivity(threads, keys, now),
    [threads, keys, now],
  );
  const recent = useMemo(() => recentProjectThreads(threads, keys), [threads, keys]);
  const upcoming = useMemo(() => upcomingProjectSchedules(schedules, keys), [schedules, keys]);

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
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">
                    {group.displayName}
                  </h1>
                  <p className="truncate text-xs text-muted-foreground">
                    {representative.workspaceRoot}
                  </p>
                </div>
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

              <HomeSection
                count={attention.length}
                icon={<BellRingIcon />}
                title="Needs attention"
              >
                {attention.length === 0 ? (
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">
                    Nothing is waiting on you in this project.
                  </p>
                ) : (
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
                )}
              </HomeSection>

              <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
                <BoardSection
                  environmentId={representative.environmentId}
                  projectId={representative.id}
                  onOpenBoard={openBoard}
                />
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
                </div>
              </div>

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
                        meta={[
                          thread.branch,
                          relativeLabel(thread.updatedAt),
                        ]
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
            </WorkspacePageContainer>
          )}
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function BoardSection(props: {
  readonly environmentId: Parameters<typeof kanbanEnvironment.board>[0]["environmentId"];
  readonly projectId: Parameters<typeof kanbanEnvironment.board>[0]["input"]["projectId"];
  readonly onOpenBoard: () => void;
}) {
  const query = useEnvironmentQuery(
    kanbanEnvironment.board({ environmentId: props.environmentId, input: { projectId: props.projectId } }),
  );
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
  const [newTitle, setNewTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const cards = query.data?.cards ?? [];
  const glance = useMemo(() => summarizeProjectBoard(cards), [cards]);

  const addCard = useCallback(async () => {
    const title = newTitle.trim();
    if (title.length === 0 || submitting) return;
    setSubmitting(true);
    const result = await createCard({
      environmentId: props.environmentId,
      input: {
        cardId: KanbanCardId.make(randomUUID()),
        projectId: props.projectId,
        title,
        description: "",
        assigneeThreadId: null,
        placement: { status: "backlog", relation: "last" },
      },
    });
    setSubmitting(false);
    const message = failureMessage(result);
    if (message !== null) {
      toastManager.add({ type: "error", title: "Kanban update failed", description: message });
      return;
    }
    setNewTitle("");
  }, [createCard, newTitle, props.environmentId, props.projectId, submitting]);

  const cardMeta = useCallback(
    (
      card: KanbanCard,
      delegation: NonNullable<KanbanBoardState["delegations"]>[number] | null,
    ): string => {
      const assignee = bots.find((bot) => bot.id === card.assigneeThreadId) ?? null;
      const status = deriveKanbanCardExecutionStatus({ card, delegation, assignee });
      const parts: string[] = [BOARD_STATUS_LABEL[card.status]];
      if (assignee !== null) parts.push(assignee.botProfile?.displayName ?? assignee.title);
      if (status !== null) parts.push(status);
      return parts.join(" · ");
    },
    [bots],
  );

  return (
    <HomeSection count={glance.total} icon={<Columns3Icon />} title="Board">
      {query.error !== null ? (
        <div className="flex items-center gap-3 px-2 py-1.5 text-sm">
          <span className="min-w-0 flex-1 truncate text-destructive">{query.error}</span>
          <Button size="sm" variant="outline" onClick={query.refresh}>
            Retry
          </Button>
        </div>
      ) : query.isPending && query.data === null ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">Loading board…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-2">
            {BOARD_STATUSES.map((status) => (
              <span key={status} className="flex items-baseline gap-1.5 text-xs">
                <span className="text-muted-foreground">{BOARD_STATUS_LABEL[status]}</span>
                <span className="tabular-nums text-foreground">{glance.counts[status]}</span>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Input
              aria-label="New task title"
              placeholder="Add a task to the backlog…"
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
          {glance.spotlight.length > 0 ? (
            <ul className="-mx-2 flex flex-col">
              {glance.spotlight.map((card) => (
                <HomeRow
                  key={card.id}
                  meta={cardMeta(
                    card,
                    query.data?.delegations.find(
                      (delegation) => delegation.id === card.delegationId,
                    ) ?? null,
                  )}
                  title={card.title}
                  trailing={
                    card.assigneeThreadId !== null ? (
                      <BotIcon className="size-3.5 text-muted-foreground" />
                    ) : undefined
                  }
                  onClick={props.onOpenBoard}
                />
              ))}
            </ul>
          ) : null}
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
