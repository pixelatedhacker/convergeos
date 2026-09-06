import { squashAtomCommandFailure, settlePromise } from "@t3tools/client-runtime/state/runtime";
import {
  ScheduleId,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ScheduleRecurrence,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import {
  ArrowUpRightIcon,
  CalendarClockIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { randomUUID } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useSchedules } from "../../state/schedulesView";
import { scheduleEnvironment } from "../../state/schedules";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { useSettingsProjectGroups } from "../settings/ProjectSettingsPanel";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  WEEKDAY_LABELS,
  buildScheduleRecurrence,
  defaultTimeZone,
  formatRecurrenceSummary,
  formatScheduleInstant,
  groupSchedulesByProject,
  isValidIanaTimeZone,
  listIanaTimeZones,
  projectRefKey,
  recurrenceEditorValues,
  type EnvironmentSchedule,
  type EnvironmentScheduleRun,
  type RecurrenceKind,
} from "./SchedulesPage.logic";

const IANA_TIME_ZONES = listIanaTimeZones();

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

interface ProjectChoice {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly name: string;
  readonly environmentLabel: string | null;
  readonly defaultModelSelection: ModelSelection | null;
}

export function SchedulesPage() {
  const navigate = useNavigate();
  const { environments, schedules, runs, isPending, refresh } = useSchedules();
  const projectGroups = useSettingsProjectGroups();
  const createSchedule = useAtomCommand(scheduleEnvironment.create, { reportFailure: false });
  const updateSchedule = useAtomCommand(scheduleEnvironment.update, { reportFailure: false });
  const deleteSchedule = useAtomCommand(scheduleEnvironment.remove, { reportFailure: false });
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<EnvironmentSchedule | null>(null);
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());

  const capableEnvironments = useMemo(
    () => environments.filter((environment) => environment.supportsSchedules),
    [environments],
  );
  const olderEnvironments = useMemo(
    () => environments.filter((environment) => !environment.supportsSchedules),
    [environments],
  );
  const projectNameByRef = useMemo(
    () =>
      new Map(
        projectGroups.flatMap((group) =>
          group.memberProjects.map(
            (project) => [`${project.environmentId}:${project.id}`, group.displayName] as const,
          ),
        ),
      ),
    [projectGroups],
  );
  const projects = useMemo((): ProjectChoice[] => {
    const capableIds = new Set(capableEnvironments.map((environment) => environment.environmentId));
    return projectGroups.flatMap((group) =>
      group.memberProjects.flatMap((project) => {
        if (!capableIds.has(project.environmentId)) return [];
        return [
          {
            key: projectRefKey(project.environmentId, project.id),
            environmentId: project.environmentId,
            id: project.id,
            name: group.displayName,
            environmentLabel: project.environmentLabel,
            defaultModelSelection: project.defaultModelSelection,
          },
        ];
      }),
    );
  }, [capableEnvironments, projectGroups]);
  const groups = useMemo(
    () => groupSchedulesByProject(schedules, projectNameByRef),
    [projectNameByRef, schedules],
  );
  const titleByScheduleId = useMemo(
    () => new Map(schedules.map((schedule) => [schedule.id, schedule.title] as const)),
    [schedules],
  );
  const timeZoneByScheduleId = useMemo(
    () => new Map(schedules.map((schedule) => [schedule.id, schedule.timeZone] as const)),
    [schedules],
  );
  const showOlderNotice = olderEnvironments.length > 0;
  const noCapableServers = environments.length > 0 && capableEnvironments.length === 0;
  const editorOpen = createOpen || editing !== null;

  const setBusy = (key: string, busy: boolean) => {
    setBusyKeys((current) => {
      const next = new Set(current);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const toggleEnabled = async (schedule: EnvironmentSchedule) => {
    const key = projectRefKey(schedule.environmentId, schedule.id);
    setBusy(key, true);
    try {
      const result = await updateSchedule({
        environmentId: schedule.environmentId,
        input: {
          scheduleId: schedule.id,
          expectedRevision: schedule.revision,
          enabled: !schedule.enabled,
        },
      });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Could not update schedule",
          description: errorMessage(
            squashAtomCommandFailure(result),
            "The schedule update failed.",
          ),
        });
        return;
      }
      refresh();
    } finally {
      setBusy(key, false);
    }
  };

  const removeSchedule = async (schedule: EnvironmentSchedule) => {
    const api = readLocalApi();
    if (!api) return;
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(`Delete schedule "${schedule.title}"? This cannot be undone.`, {
        variant: "destructive",
      }),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return;

    const key = projectRefKey(schedule.environmentId, schedule.id);
    setBusy(key, true);
    try {
      const result = await deleteSchedule({
        environmentId: schedule.environmentId,
        input: { scheduleId: schedule.id, expectedRevision: schedule.revision },
      });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Could not delete schedule",
          description: errorMessage(
            squashAtomCommandFailure(result),
            "The schedule delete failed.",
          ),
        });
        return;
      }
      toastManager.add({ type: "success", title: "Schedule deleted" });
      refresh();
    } finally {
      setBusy(key, false);
    }
  };

  const submitCreate = async (draft: ScheduleDraft) => {
    const result = await createSchedule({
      environmentId: draft.environmentId,
      input: {
        scheduleId: ScheduleId.make(randomUUID()),
        projectId: draft.projectId,
        title: draft.title,
        prompt: draft.prompt,
        recurrence: draft.recurrence,
        timeZone: draft.timeZone,
        modelSelection: draft.modelSelection,
        enabled: draft.enabled,
      },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not create schedule",
        description: errorMessage(squashAtomCommandFailure(result), "The schedule create failed."),
      });
      return false;
    }
    toastManager.add({ type: "success", title: "Schedule created" });
    refresh();
    return true;
  };

  const submitUpdate = async (schedule: EnvironmentSchedule, draft: ScheduleDraft) => {
    const result = await updateSchedule({
      environmentId: schedule.environmentId,
      input: {
        scheduleId: schedule.id,
        expectedRevision: schedule.revision,
        title: draft.title,
        prompt: draft.prompt,
        recurrence: draft.recurrence,
        timeZone: draft.timeZone,
        modelSelection: draft.modelSelection,
        enabled: draft.enabled,
      },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not save schedule",
        description: errorMessage(squashAtomCommandFailure(result), "The schedule update failed."),
      });
      return false;
    }
    toastManager.add({ type: "success", title: "Schedule saved" });
    refresh();
    return true;
  };

  const openThread = (run: EnvironmentScheduleRun) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: run.environmentId, threadId: run.threadId },
    });
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <WorkspaceBreadcrumb ariaLabel="Schedules breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1>Schedules</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <Button
            className="ms-auto"
            disabled={noCapableServers || projects.length === 0}
            size="sm"
            onClick={() => setCreateOpen(true)}
          >
            <PlusIcon /> New schedule
          </Button>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {environments.length === 0 ? (
              <EmptyNotice
                title="No connected environments"
                body="Connect a server to manage scheduled turns."
              />
            ) : noCapableServers ? (
              <EmptyNotice
                title="Connected servers are too old"
                body="Update ConvergeOS on those machines to manage scheduled turns."
              />
            ) : isPending && schedules.length === 0 ? (
              <p className="text-sm text-muted-foreground">Loading schedules…</p>
            ) : schedules.length === 0 ? (
              <EmptyNotice
                title="No schedules yet"
                body="Create a schedule to run a prompt once, daily, weekly, or monthly."
                action={
                  <Button disabled={projects.length === 0} onClick={() => setCreateOpen(true)}>
                    <PlusIcon /> New schedule
                  </Button>
                }
              />
            ) : (
              <div className="flex flex-col gap-8">
                {groups.map((group) => (
                  <section key={group.key} className="flex flex-col gap-3">
                    <h2 className="text-sm font-medium text-foreground">{group.name}</h2>
                    <ul className="flex flex-col gap-2">
                      {group.schedules.map((schedule) => {
                        const key = projectRefKey(schedule.environmentId, schedule.id);
                        return (
                          <ScheduleRow
                            busy={busyKeys.has(key)}
                            key={key}
                            schedule={schedule}
                            onDelete={() => void removeSchedule(schedule)}
                            onEdit={() => setEditing(schedule)}
                            onToggle={() => void toggleEnabled(schedule)}
                          />
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            )}

            {capableEnvironments
              .filter((environment) => environment.error !== null)
              .map((environment) => (
                <p key={environment.environmentId} className="text-sm text-destructive">
                  {environment.label}: {environment.error}
                </p>
              ))}

            {showOlderNotice && capableEnvironments.length > 0 ? (
              <p className="text-sm text-muted-foreground">
                {olderEnvironments.map((environment) => environment.label).join(", ")}{" "}
                {olderEnvironments.length === 1 ? "runs" : "run"} an older server version.
              </p>
            ) : null}

            {runs.length > 0 ? (
              <section className="flex flex-col gap-3">
                <h2 className="text-sm font-medium text-foreground">Recent runs</h2>
                <ul className="flex flex-col gap-1">
                  {runs.slice(0, 20).map((run) => (
                    <li
                      className="flex min-w-0 items-center gap-3 rounded-lg border border-border px-3 py-2"
                      key={`${run.environmentId}:${run.scheduleId}:${run.threadId}:${run.firedAt}`}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {titleByScheduleId.get(run.scheduleId) ?? "Schedule"}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {formatScheduleInstant(
                            run.firedAt,
                            timeZoneByScheduleId.get(run.scheduleId) ?? "UTC",
                          )}
                        </p>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => openThread(run)}>
                        Open thread <ArrowUpRightIcon />
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>

      <ScheduleEditorDialog
        key={editing ? `edit:${editing.id}` : createOpen ? "create" : "closed"}
        editing={editing}
        open={editorOpen}
        projects={projects}
        onOpenChange={(open) => {
          if (open) return;
          setCreateOpen(false);
          setEditing(null);
        }}
        onCreate={submitCreate}
        onUpdate={submitUpdate}
      />
    </SidebarInset>
  );
}

function EmptyNotice({
  title,
  body,
  action,
}: {
  readonly title: string;
  readonly body: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-4 py-6">
      <span className="grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary">
        <CalendarClockIcon className="size-6" />
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="font-heading text-xl font-semibold tracking-tight">{title}</h2>
        <p className="max-w-lg text-sm text-muted-foreground">{body}</p>
      </div>
      {action}
    </div>
  );
}

function ScheduleRow({
  busy,
  schedule,
  onDelete,
  onEdit,
  onToggle,
}: {
  readonly busy: boolean;
  readonly schedule: EnvironmentSchedule;
  readonly onDelete: () => void;
  readonly onEdit: () => void;
  readonly onToggle: () => void;
}) {
  return (
    <li className="flex min-w-0 items-start gap-3 rounded-xl border border-border px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{schedule.title}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {formatRecurrenceSummary(schedule.recurrence, schedule.timeZone)}
        </p>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          Next{" "}
          {schedule.nextRunAt ? formatScheduleInstant(schedule.nextRunAt, schedule.timeZone) : "—"}
          {" · "}
          Last{" "}
          {schedule.lastRunAt
            ? formatScheduleInstant(schedule.lastRunAt, schedule.timeZone)
            : "Never"}
        </p>
      </div>
      <Switch
        aria-label={schedule.enabled ? "Disable schedule" : "Enable schedule"}
        checked={schedule.enabled}
        disabled={busy}
        size="sm"
        onCheckedChange={() => onToggle()}
      />
      <Button
        aria-label="Edit schedule"
        disabled={busy}
        size="icon-sm"
        variant="ghost"
        onClick={onEdit}
      >
        <PencilIcon />
      </Button>
      <Button
        aria-label="Delete schedule"
        disabled={busy}
        size="icon-sm"
        variant="ghost"
        onClick={onDelete}
      >
        <Trash2Icon />
      </Button>
    </li>
  );
}

interface ScheduleDraft {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly prompt: string;
  readonly recurrence: ScheduleRecurrence;
  readonly timeZone: string;
  readonly modelSelection: ModelSelection;
  readonly enabled: boolean;
}

function ScheduleEditorDialog({
  editing,
  open,
  projects,
  onOpenChange,
  onCreate,
  onUpdate,
}: {
  readonly editing: EnvironmentSchedule | null;
  readonly open: boolean;
  readonly projects: readonly ProjectChoice[];
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreate: (draft: ScheduleDraft) => Promise<boolean>;
  readonly onUpdate: (schedule: EnvironmentSchedule, draft: ScheduleDraft) => Promise<boolean>;
}) {
  const initial = editing
    ? recurrenceEditorValues(editing.recurrence, editing.timeZone)
    : {
        kind: "daily" as const,
        onceLocal: "",
        time: "09:00",
        weekday: 1,
        monthDay: 1,
      };
  const [projectKey, setProjectKey] = useState(() =>
    editing
      ? projectRefKey(editing.environmentId, editing.projectId)
      : projects.length === 1
        ? projects[0]!.key
        : "",
  );
  const [title, setTitle] = useState(editing?.title ?? "");
  const [prompt, setPrompt] = useState(editing?.prompt ?? "");
  const [kind, setKind] = useState<RecurrenceKind>(initial.kind);
  const [onceLocal, setOnceLocal] = useState(initial.onceLocal);
  const [time, setTime] = useState(initial.time);
  const [weekday, setWeekday] = useState(String(initial.weekday));
  const [monthDay, setMonthDay] = useState(String(initial.monthDay));
  const [timeZone, setTimeZone] = useState(editing?.timeZone ?? defaultTimeZone());
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(
    editing?.modelSelection ??
      (projects.length === 1 ? (projects[0]?.defaultModelSelection ?? null) : null),
  );
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [busy, setBusy] = useState(false);

  const selectedProject = projects.find((project) => project.key === projectKey) ?? null;
  const environmentId = editing?.environmentId ?? selectedProject?.environmentId ?? null;

  const submit = async () => {
    if (!isValidIanaTimeZone(timeZone)) {
      toastManager.add({
        type: "warning",
        title: "Invalid time zone",
        description: "Enter an IANA time zone such as America/New_York.",
      });
      return;
    }
    const trimmedTitle = title.trim();
    const trimmedPrompt = prompt.trim();
    if (trimmedTitle.length === 0 || trimmedPrompt.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Title and prompt are required",
      });
      return;
    }
    if (selectedProject === null && editing === null) {
      toastManager.add({ type: "warning", title: "Pick a project" });
      return;
    }
    const built = buildScheduleRecurrence({
      kind,
      onceLocal,
      time,
      weekday: Number(weekday),
      monthDay: Number(monthDay),
      timeZone,
    });
    if (!built.ok) {
      toastManager.add({ type: "warning", title: built.error });
      return;
    }
    if (modelSelection === null) {
      toastManager.add({
        type: "warning",
        title: "Pick a model",
        description: "Scheduled turns need a model selection.",
      });
      return;
    }
    if (editing === null && selectedProject === null) return;
    const draft: ScheduleDraft = {
      environmentId: editing?.environmentId ?? selectedProject!.environmentId,
      projectId: editing?.projectId ?? selectedProject!.id,
      title: trimmedTitle,
      prompt: trimmedPrompt,
      recurrence: built.recurrence,
      timeZone: timeZone.trim(),
      modelSelection,
      enabled,
    };
    setBusy(true);
    try {
      const saved = editing === null ? await onCreate(draft) : await onUpdate(editing, draft);
      if (saved) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit schedule" : "New schedule"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Update when this prompt should run."
              : "Each run starts a new thread in the chosen project."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          {editing === null ? (
            <Field label="Project">
              <Select
                value={projectKey}
                onValueChange={(value) => {
                  if (typeof value !== "string") return;
                  setProjectKey(value);
                  const next = projects.find((project) => project.key === value);
                  if (next) setModelSelection(next.defaultModelSelection);
                }}
              >
                <SelectTrigger aria-label="Project">
                  <SelectValue>
                    {selectedProject ? projectChoiceLabel(selectedProject) : "Select a project"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((project) => (
                    <SelectItem key={project.key} value={project.key}>
                      {projectChoiceLabel(project)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
          ) : (
            <Field label="Project">
              <p className="text-sm text-muted-foreground">
                {projects.find((project) => project.key === projectKey)?.name ?? "Unknown project"}
              </p>
            </Field>
          )}

          <Field label="Title">
            <Input
              aria-label="Schedule title"
              maxLength={160}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label="Prompt">
            <Textarea
              aria-label="Schedule prompt"
              rows={5}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </Field>

          <Field label="Repeats">
            <Select
              value={kind}
              onValueChange={(value) => {
                if (
                  value === "once" ||
                  value === "daily" ||
                  value === "weekly" ||
                  value === "monthly"
                ) {
                  setKind(value);
                }
              }}
            >
              <SelectTrigger aria-label="Recurrence">
                <SelectValue>
                  {kind === "once"
                    ? "Once"
                    : kind === "daily"
                      ? "Daily"
                      : kind === "weekly"
                        ? "Weekly"
                        : "Monthly"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="once">Once</SelectItem>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
              </SelectPopup>
            </Select>
          </Field>

          {kind === "once" ? (
            <Field label="Date and time">
              <Input
                aria-label="Date and time"
                nativeInput
                type="datetime-local"
                value={onceLocal}
                onChange={(event) => setOnceLocal(event.target.value)}
              />
            </Field>
          ) : null}
          {kind === "weekly" ? (
            <Field label="Weekday">
              <Select
                value={weekday}
                onValueChange={(value) => typeof value === "string" && setWeekday(value)}
              >
                <SelectTrigger aria-label="Weekday">
                  <SelectValue>{WEEKDAY_LABELS[Number(weekday)] ?? "Weekday"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {WEEKDAY_LABELS.map((label, index) => (
                    <SelectItem key={label} value={String(index)}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
          ) : null}
          {kind === "monthly" ? (
            <Field label="Day of month">
              <Input
                aria-label="Day of month"
                max={31}
                min={1}
                nativeInput
                type="number"
                value={monthDay}
                onChange={(event) => setMonthDay(event.target.value)}
              />
            </Field>
          ) : null}
          {kind !== "once" ? (
            <Field label="Time">
              <Input
                aria-label="Time"
                nativeInput
                type="time"
                value={time}
                onChange={(event) => setTime(event.target.value)}
              />
            </Field>
          ) : null}

          <Field label="Time zone">
            <Input
              aria-label="Time zone"
              list="schedule-timezones"
              value={timeZone}
              onChange={(event) => setTimeZone(event.target.value)}
            />
            <datalist id="schedule-timezones">
              {IANA_TIME_ZONES.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </Field>

          {environmentId !== null ? (
            <Field label="Model">
              <ScheduleModelField
                environmentId={environmentId}
                projectDefault={
                  editing?.modelSelection ?? selectedProject?.defaultModelSelection ?? null
                }
                selection={modelSelection}
                onChange={setModelSelection}
              />
            </Field>
          ) : (
            <p className="text-sm text-muted-foreground">Select a project to choose a model.</p>
          )}

          <label className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">Enabled</span>
            <Switch
              aria-label="Enabled"
              checked={enabled}
              onCheckedChange={(checked) => setEnabled(Boolean(checked))}
            />
          </label>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {editing ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ScheduleModelField({
  environmentId,
  projectDefault,
  selection,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectDefault: ModelSelection | null;
  readonly selection: ModelSelection | null;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const projectSettings = useEnvironmentSettings(environmentId);
  const navigate = useNavigate();
  const serverProviders =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const resolvedSelection = resolveDefaultProviderModelSelection(
    serverProviders,
    selection ?? projectDefault,
  );
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(
          deriveProviderInstanceEntries(serverProviders),
          projectSettings,
        ),
      ),
    [projectSettings, serverProviders],
  );
  const modelOptionsByInstance = useMemo(
    () =>
      getCustomModelOptionsByInstance(
        projectSettings,
        serverProviders,
        resolvedSelection?.instanceId ?? null,
        resolvedSelection?.model ?? null,
      ),
    [projectSettings, resolvedSelection?.instanceId, resolvedSelection?.model, serverProviders],
  );

  useEffect(() => {
    if (selection === null && resolvedSelection !== null) {
      onChange(resolvedSelection);
    }
  }, [onChange, resolvedSelection, selection]);

  if (resolvedSelection === null) {
    return <span className="text-sm text-muted-foreground">No providers available</span>;
  }

  return (
    <ProviderModelPicker
      activeInstanceId={resolvedSelection.instanceId}
      instanceEntries={instanceEntries}
      lockedProvider={null}
      model={resolvedSelection.model}
      modelOptionsByInstance={modelOptionsByInstance}
      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
      triggerVariant="outline"
      onOpenProviderSetup={(instanceId) => {
        void navigate({
          to: "/settings/providers",
          search: { environmentId, instanceId },
        });
      }}
      onInstanceModelChange={(instanceId, model) => {
        onChange(createModelSelection(instanceId, model));
      }}
    />
  );
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function projectChoiceLabel(project: ProjectChoice): string {
  return project.environmentLabel ? `${project.name} · ${project.environmentLabel}` : project.name;
}
