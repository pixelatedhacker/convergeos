import { useNavigate } from "@tanstack/react-router";
import { summarizeEnvironmentWork } from "@t3tools/client-runtime/state/command-center";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  BellRingIcon,
  CalendarClockIcon,
  GaugeIcon,
  LoaderIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { formatRelativeTimeLabel, parseTimestampDate } from "../../timestampFormat";
import { useDashboardQuota } from "../../state/dashboard";
import { useEnvironments } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { useSchedules } from "../../state/schedulesView";
import { Badge } from "../ui/badge";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { formatWorkingDurationLabel, parseTimestampMs } from "../Sidebar.logic";
import { formatScheduleInstant } from "../schedules/SchedulesPage.logic";
import {
  partitionDashboardThreads,
  recentRunRows,
  summarizeQuotaReport,
  upcomingSchedules,
  type DashboardThreadRow,
} from "./DashboardPage.logic";

const NOW_REFRESH_MS = 30_000;

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), NOW_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const ATTENTION_BADGE: Record<
  NonNullable<DashboardThreadRow["attentionReason"]>,
  { readonly label: string; readonly variant: "error" | "warning" | "info" }
> = {
  approval: { label: "Approval", variant: "warning" },
  input: { label: "Input", variant: "warning" },
  plan: { label: "Plan ready", variant: "info" },
  failed: { label: "Failed", variant: "error" },
};

function DashboardSection(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly count?: number;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <header className="flex items-center gap-2">
        <span className="text-muted-foreground [&_svg]:size-4">{props.icon}</span>
        <h2 className="text-sm font-medium text-foreground">{props.title}</h2>
        {props.count !== undefined ? (
          <span className="text-xs tabular-nums text-muted-foreground">{props.count}</span>
        ) : null}
      </header>
      {props.children}
    </section>
  );
}

function CardRow(props: {
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

function relativeLabel(iso: string): string {
  return parseTimestampDate(iso) === null ? "" : formatRelativeTimeLabel(iso);
}

export function DashboardPage() {
  const navigate = useNavigate();
  const now = useNow();
  const threads = useThreadShells();
  const projects = useProjects();
  const { environments, isReady: environmentsReady, networkStatus } = useEnvironments();
  const { schedules, runs, isPending: schedulesPending } = useSchedules();
  const quota = useDashboardQuota();

  const projectNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const project of projects) {
      names.set(`${project.environmentId}:${project.id}`, project.title);
    }
    return names;
  }, [projects]);

  const { running, attention } = useMemo(
    () => partitionDashboardThreads(threads, now),
    [threads, now],
  );
  const environmentWork = useMemo(
    () =>
      summarizeEnvironmentWork(
        environments.map((environment) => environment.environmentId),
        threads,
        now,
      ),
    [environments, threads, now],
  );
  const workByEnvironmentId = useMemo(
    () => new Map(environmentWork.map((summary) => [summary.environmentId, summary] as const)),
    [environmentWork],
  );
  const upcoming = useMemo(() => upcomingSchedules(schedules), [schedules]);
  const recentRuns = useMemo(() => recentRunRows(runs, schedules), [runs, schedules]);
  const quotaRows = useMemo(
    () =>
      quota.environments.flatMap((environment) =>
        environment.report === null
          ? []
          : summarizeQuotaReport(environment.report, environment.label),
      ),
    [quota.environments],
  );

  const openThread = (row: {
    readonly environmentId: DashboardThreadRow["environmentId"];
    readonly threadId: DashboardThreadRow["threadId"];
  }) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: row.environmentId, threadId: row.threadId },
    });
  };

  const projectName = (row: DashboardThreadRow) =>
    projectNames.get(`${row.environmentId}:${row.projectId}`) ?? "Project";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <WorkspaceBreadcrumb ariaLabel="Command center breadcrumb">
            <WorkspaceBreadcrumbItem current>Command center</WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded" title="Command center">
            <div className="flex flex-col gap-10">
              <section className="flex min-w-0 flex-col gap-3" aria-label="Machines">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-sm font-medium text-foreground">Machines</h2>
                  <button
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => void navigate({ to: "/settings/connections" })}
                    type="button"
                  >
                    Manage connections
                  </button>
                </div>
                {!environmentsReady ? (
                  <p className="text-sm text-muted-foreground">Loading machines…</p>
                ) : environments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Connect a machine to see its work here.
                  </p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {environments.map((environment) => {
                      const summary = workByEnvironmentId.get(environment.environmentId);
                      const nextThread = summary?.nextThread ?? null;
                      const connected =
                        environment.entry.enabled &&
                        networkStatus !== "offline" &&
                        environment.connection.phase === "connected";
                      const status = !environment.entry.enabled
                        ? "Paused"
                        : networkStatus === "offline" || environment.connection.phase === "offline"
                          ? "Offline"
                          : environment.connection.phase === "connected"
                            ? "Connected"
                            : environment.connection.phase === "connecting" ||
                                environment.connection.phase === "reconnecting"
                              ? "Connecting"
                              : environment.connection.phase === "error"
                                ? "Connection failed"
                                : "Available";
                      const nextLabel =
                        summary?.nextKind === "attention"
                          ? "Needs you"
                          : summary?.nextKind === "working"
                            ? "Working now"
                            : "Resume";
                      return (
                        <button
                          aria-label={
                            nextThread
                              ? `${nextLabel}: ${nextThread.title} on ${environment.label}`
                              : `${environment.label}: ${status}; manage connection`
                          }
                          className="group flex min-h-36 min-w-0 flex-col rounded-xl border border-border/70 bg-card p-4 text-left shadow-xs transition-colors hover:border-border hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          key={environment.environmentId}
                          onClick={() =>
                            nextThread
                              ? openThread({
                                  environmentId: nextThread.environmentId,
                                  threadId: nextThread.id,
                                })
                              : void navigate({ to: "/settings/connections" })
                          }
                          type="button"
                        >
                          <span className="flex w-full min-w-0 items-center gap-2.5">
                            <EnvironmentMachineIcon
                              aria-hidden
                              className="size-4 shrink-0 text-muted-foreground"
                              kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                            />
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">
                              {environment.label}
                            </span>
                            <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                              <span
                                className={`size-1.5 rounded-full ${connected ? "bg-success" : "bg-muted-foreground/50"}`}
                              />
                              {status}
                            </span>
                          </span>
                          <span className="mt-4 flex gap-2 text-xs text-muted-foreground">
                            {connected ? null : <span>Last known ·</span>}
                            <span>Needs you {summary?.attentionCount ?? 0}</span>
                            <span aria-hidden>·</span>
                            <span>Working {summary?.workingCount ?? 0}</span>
                          </span>
                          <span className="mt-auto block min-w-0 pt-3">
                            <span className="block text-[11px] font-medium text-muted-foreground">
                              {connected ? nextLabel : "Last known work"}
                            </span>
                            <span className="mt-0.5 block truncate text-sm text-foreground">
                              {nextThread?.title ?? "No open threads"}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
              <DashboardSection
                count={attention.length}
                icon={<BellRingIcon />}
                title="Needs attention"
              >
                {attention.length === 0 ? (
                  <p className="py-1.5 text-sm text-muted-foreground">Nothing is waiting on you.</p>
                ) : (
                  <ul className="-mx-2 flex flex-col">
                    {attention.map((row) => {
                      const badge = ATTENTION_BADGE[row.attentionReason ?? "input"];
                      return (
                        <CardRow
                          key={`${row.environmentId}:${row.threadId}`}
                          meta={`${projectName(row)} · ${relativeLabel(row.sortAt)}`}
                          title={row.title}
                          trailing={<Badge variant={badge.variant}>{badge.label}</Badge>}
                          onClick={() => openThread(row)}
                        />
                      );
                    })}
                  </ul>
                )}
              </DashboardSection>

              <div className="grid gap-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <DashboardSection count={running.length} icon={<LoaderIcon />} title="Running now">
                  {running.length === 0 ? (
                    <p className="py-1.5 text-sm text-muted-foreground">
                      No agents are working right now.
                    </p>
                  ) : (
                    <ul className="-mx-2 flex flex-col">
                      {running.map((row) => (
                        <CardRow
                          key={`${row.environmentId}:${row.threadId}`}
                          meta={`${projectName(row)} · ${formatWorkingDurationLabel(
                            now.getTime() - parseTimestampMs(row.sortAt),
                          )}`}
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
                </DashboardSection>

                <div className="flex min-w-0 flex-col gap-10">
                  <DashboardSection
                    count={upcoming.length}
                    icon={<CalendarClockIcon />}
                    title="Schedules"
                  >
                    {schedulesPending && upcoming.length === 0 ? (
                      <p className="py-1.5 text-sm text-muted-foreground">Loading schedules…</p>
                    ) : upcoming.length === 0 && recentRuns.length === 0 ? (
                      <p className="py-1.5 text-sm text-muted-foreground">
                        No schedules yet. Create one from the Schedules page.
                      </p>
                    ) : (
                      <>
                        {upcoming.length > 0 ? (
                          <ul className="-mx-2 flex flex-col">
                            {upcoming.map((row) => (
                              <CardRow
                                key={`${row.environmentId}:${row.scheduleId}`}
                                meta={formatScheduleInstant(row.nextRunAt, row.timeZone)}
                                title={row.title}
                              />
                            ))}
                          </ul>
                        ) : null}
                        {recentRuns.length > 0 ? (
                          <ul className="-mx-2 flex flex-col border-t border-border/60 pt-2">
                            {recentRuns.map((row) => (
                              <CardRow
                                key={`${row.environmentId}:${row.scheduleId}:${row.threadId}:${row.firedAt}`}
                                meta={`Ran ${relativeLabel(row.firedAt)}`}
                                title={row.scheduleTitle ?? "Deleted schedule"}
                                trailing={
                                  <ArrowUpRightIcon className="size-3.5 text-muted-foreground" />
                                }
                                onClick={() => openThread(row)}
                              />
                            ))}
                          </ul>
                        ) : null}
                      </>
                    )}
                    <button
                      className="mt-2 self-start text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => void navigate({ to: "/schedules" })}
                      type="button"
                    >
                      Manage schedules
                    </button>
                  </DashboardSection>

                  <DashboardSection
                    count={quotaRows.length}
                    icon={<GaugeIcon />}
                    title="Subscription quota"
                  >
                    {quota.isPending ? (
                      <p className="py-1.5 text-sm text-muted-foreground">Reading quota…</p>
                    ) : quotaRows.length === 0 &&
                      quota.environments.every((environment) => environment.error === null) ? (
                      <p className="py-1.5 text-sm text-muted-foreground">
                        No quota collectors reported.
                      </p>
                    ) : (
                      <ul className="-mx-2 flex flex-col">
                        {quotaRows.map((row) => (
                          <CardRow
                            key={`${row.environmentId}:${row.subjectId}`}
                            meta={
                              row.worstWindowLabel === null
                                ? `${row.environmentLabel} · ${row.status}`
                                : `${row.environmentLabel} · ${row.worstWindowLabel}${
                                    row.worstWindowResetsAt
                                      ? ` · resets ${relativeLabel(row.worstWindowResetsAt)}`
                                      : ""
                                  }`
                            }
                            title={`${row.provider}${row.plan ? ` (${row.plan})` : ""}`}
                            trailing={
                              row.worstWindowRemainingPercent === null ? null : (
                                <Badge
                                  variant={
                                    row.worstWindowRemainingPercent <= 10
                                      ? "error"
                                      : row.worstWindowRemainingPercent <= 25
                                        ? "warning"
                                        : "default"
                                  }
                                >
                                  {row.worstWindowRemainingPercent}% left
                                </Badge>
                              )
                            }
                            onClick={() => void navigate({ to: "/usage" })}
                          />
                        ))}
                        {quota.environments
                          .filter((environment) => environment.error !== null)
                          .map((environment) => (
                            <li
                              className="py-1.5 text-xs text-muted-foreground"
                              key={environment.environmentId}
                            >
                              {environment.label}: quota unavailable
                            </li>
                          ))}
                      </ul>
                    )}
                    <button
                      className="mt-2 self-start text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => void navigate({ to: "/usage" })}
                      type="button"
                    >
                      Open usage
                    </button>
                  </DashboardSection>
                </div>
              </div>
            </div>
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
