import { useNavigate } from "@tanstack/react-router";
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
import { useProjects, useThreadShells } from "../../state/entities";
import { useSchedules } from "../../state/schedulesView";
import { Badge } from "../ui/badge";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
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

function DashboardCard(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly count?: number;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3">
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
          <WorkspaceBreadcrumb ariaLabel="Dashboard breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1>Dashboard</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded">
            <div className="grid gap-4 md:grid-cols-2">
              <DashboardCard
                count={attention.length}
                icon={<BellRingIcon />}
                title="Needs attention"
              >
                {attention.length === 0 ? (
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">
                    Nothing is waiting on you.
                  </p>
                ) : (
                  <ul className="flex flex-col">
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
              </DashboardCard>

              <DashboardCard count={running.length} icon={<LoaderIcon />} title="Running now">
                {running.length === 0 ? (
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">
                    No agents are working right now.
                  </p>
                ) : (
                  <ul className="flex flex-col">
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
              </DashboardCard>

              <DashboardCard count={upcoming.length} icon={<CalendarClockIcon />} title="Schedules">
                {schedulesPending && upcoming.length === 0 ? (
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">Loading schedules…</p>
                ) : upcoming.length === 0 && recentRuns.length === 0 ? (
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">
                    No schedules yet. Create one from the Schedules page.
                  </p>
                ) : (
                  <>
                    {upcoming.length > 0 ? (
                      <ul className="flex flex-col">
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
                      <ul className="flex flex-col border-t border-border pt-2">
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
                  className="mt-auto px-2 text-start text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => void navigate({ to: "/schedules" })}
                  type="button"
                >
                  Manage schedules
                </button>
              </DashboardCard>

              <DashboardCard
                count={quotaRows.length}
                icon={<GaugeIcon />}
                title="Subscription quota"
              >
                {quota.isPending ? (
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">Reading quota…</p>
                ) : quotaRows.length === 0 &&
                  quota.environments.every((environment) => environment.error === null) ? (
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">
                    No quota collectors reported.
                  </p>
                ) : (
                  <ul className="flex flex-col">
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
                          className="px-2 py-1.5 text-xs text-muted-foreground"
                          key={environment.environmentId}
                        >
                          {environment.label}: quota unavailable
                        </li>
                      ))}
                  </ul>
                )}
                <button
                  className="mt-auto px-2 text-start text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => void navigate({ to: "/usage" })}
                  type="button"
                >
                  Open usage
                </button>
              </DashboardCard>
            </div>
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
