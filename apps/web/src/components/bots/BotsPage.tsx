import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { vcsEnvironment } from "../../state/vcs";
import { EnvironmentModelField } from "../EnvironmentModelField";
import { Label } from "../ui/label";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  BotComputerCapability,
  EnvironmentId,
  ProjectId,
  ModelSelection,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  BotIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  PencilIcon,
  PlusIcon,
  SaveIcon,
  SendIcon,
  Trash2Icon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import { openCommandPalette } from "../../commandPaletteBus";
import { newMessageId, newThreadId } from "../../lib/utils";
import { useServerConfigs, useThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { Badge } from "../ui/badge";
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
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  botAvailabilityLabel,
  botFleetSummary,
  canDispatchToBot,
  isBotCandidate,
  reconcileSelectedBotKey,
  resolveBotAvailability,
  sortBotThreads,
  type BotAvailability,
  updateBotDispatchDraft,
  updateBusyBotKeys,
} from "./BotsPage.logic";
import { BotComputerPanel } from "./BotComputerPanel";

function threadKey(thread: Pick<EnvironmentThreadShell, "environmentId" | "id">): string {
  return `${thread.environmentId}:${thread.id}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The bot update failed.";
}

const STATUS_PRESENTATION: Record<
  BotAvailability,
  {
    readonly icon: typeof CheckCircle2Icon;
    readonly variant: "success" | "warning" | "error" | "info";
    readonly dotClass: string;
  }
> = {
  available: { icon: CheckCircle2Icon, variant: "success", dotClass: "bg-success" },
  attention: { icon: CircleAlertIcon, variant: "warning", dotClass: "bg-warning" },
  failed: { icon: CircleAlertIcon, variant: "error", dotClass: "bg-destructive" },
  working: { icon: CircleDashedIcon, variant: "info", dotClass: "bg-info" },
};

export function BotsPage() {
  const navigate = useNavigate();
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const projectGroups = useSettingsProjectGroups();
  const configureBot = useAtomCommand(threadEnvironment.configureBot, { reportFailure: false });
  const disableBot = useAtomCommand(threadEnvironment.disableBot, { reportFailure: false });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [busyThreadKeys, setBusyThreadKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [dispatchDrafts, setDispatchDrafts] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [editingBot, setEditingBot] = useState<EnvironmentThreadShell | null>(null);

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
  const bots = useMemo(
    () => sortBotThreads(threads.filter((thread) => thread.botProfile != null)),
    [threads],
  );
  const candidates = useMemo(
    () =>
      threads
        .filter((thread) =>
          isBotCandidate(
            thread,
            serverConfigs.get(thread.environmentId)?.environment.capabilities.botProfiles === true,
          ),
        )
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [serverConfigs, threads],
  );
  const botRows = useMemo(() => bots.map((thread) => ({ key: threadKey(thread), thread })), [bots]);
  const fleetSummary = useMemo(() => botFleetSummary(bots), [bots]);
  const botProjects = useMemo(
    () =>
      projectGroups.flatMap((group) =>
        group.memberProjects
          .filter(
            (project) =>
              serverConfigs.get(project.environmentId)?.environment.capabilities.botProfiles ===
              true,
          )
          .map((project) => ({
            environmentId: project.environmentId,
            id: project.id,
            name: group.displayName,
            workspaceRoot: project.workspaceRoot,
            defaultModelSelection: project.defaultModelSelection,
            environmentLabel: project.environmentLabel,
          })),
      ),
    [projectGroups, serverConfigs],
  );

  const reconciledSelectedKey = reconcileSelectedBotKey(selectedKey, botRows);
  if (selectedKey !== reconciledSelectedKey) setSelectedKey(reconciledSelectedKey);
  const selectedBot = botRows.find((bot) => bot.key === reconciledSelectedKey)?.thread ?? null;

  const setThreadBusy = (key: string, busy: boolean) => {
    setBusyThreadKeys((current) => updateBusyBotKeys(current, key, busy));
  };

  const openInbox = (thread: EnvironmentThreadShell) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: thread.environmentId, threadId: thread.id },
    });
  };

  const saveProfile = async (
    thread: EnvironmentThreadShell,
    displayName: string,
    description: string,
  ): Promise<boolean> => {
    const key = threadKey(thread);
    setThreadBusy(key, true);
    try {
      const result = await configureBot({
        environmentId: thread.environmentId,
        input: {
          threadId: thread.id,
          expectedRevision: thread.botProfile?.revision ?? null,
          displayName: displayName.trim(),
          description: description.trim() || null,
        },
      });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Could not save bot",
          description: errorMessage(squashAtomCommandFailure(result)),
        });
        return false;
      }
      setSelectedKey(key);
      toastManager.add({ type: "success", title: "Bot profile saved" });
      return true;
    } finally {
      setThreadBusy(key, false);
    }
  };

  const removeProfile = async (thread: EnvironmentThreadShell) => {
    if (thread.botProfile == null) return;
    const key = threadKey(thread);
    setThreadBusy(key, true);
    try {
      const result = await disableBot({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, expectedRevision: thread.botProfile.revision },
      });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Could not disable bot",
          description: errorMessage(squashAtomCommandFailure(result)),
        });
        return;
      }
      toastManager.add({ type: "success", title: "Bot disabled" });
    } finally {
      setThreadBusy(key, false);
    }
  };

  const dispatchTask = async (thread: EnvironmentThreadShell, message: string) => {
    const key = threadKey(thread);
    setThreadBusy(key, true);
    try {
      const result = await startTurn({
        environmentId: thread.environmentId,
        input: {
          threadId: thread.id,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: message.trim(),
            attachments: [],
          },
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: new Date().toISOString(),
        },
      });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Could not send task",
          description: errorMessage(squashAtomCommandFailure(result)),
        });
        return false;
      }
      toastManager.add({
        type: "success",
        title: `Task sent to ${thread.botProfile?.displayName ?? thread.title}`,
      });
      setDispatchDrafts((current) =>
        current.get(key) === message ? updateBotDispatchDraft(current, key, "") : current,
      );
      return true;
    } finally {
      setThreadBusy(key, false);
    }
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <WorkspaceBreadcrumb ariaLabel="Bots breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1>Bots</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <Button className="ms-auto" size="sm" onClick={() => setCreateOpen(true)}>
            <PlusIcon /> New bot
          </Button>
        </WorkspacePageHeader>

        {bots.length === 0 ? (
          <EmptyFleet candidateCount={candidates.length} onCreate={() => setCreateOpen(true)} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <aside className="flex shrink-0 flex-col border-b border-border bg-muted/15 md:w-72 md:border-r md:border-b-0">
              <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
                <span>{bots.length} bots</span>
                {fleetSummary.working > 0 && <span>· {fleetSummary.working} working</span>}
                {fleetSummary.attention > 0 && (
                  <span className="text-warning">· {fleetSummary.attention} need you</span>
                )}
              </div>
              <ScrollArea className="max-h-40 md:min-h-0 md:max-h-none md:flex-1">
                <div className="flex gap-1 px-2 pb-2 md:flex-col">
                  {bots.map((thread) => (
                    <BotFleetRow
                      key={threadKey(thread)}
                      active={reconciledSelectedKey === threadKey(thread)}
                      projectName={
                        projectNameByRef.get(`${thread.environmentId}:${thread.projectId}`) ??
                        "Unknown project"
                      }
                      thread={thread}
                      onSelect={() => setSelectedKey(threadKey(thread))}
                    />
                  ))}
                </div>
              </ScrollArea>
            </aside>

            {selectedBot && (
              <BotWorkspace
                busy={busyThreadKeys.has(threadKey(selectedBot))}
                computerCapability={
                  serverConfigs.get(selectedBot.environmentId)?.environment.capabilities.botComputer
                }
                message={dispatchDrafts.get(threadKey(selectedBot)) ?? ""}
                projectName={
                  projectNameByRef.get(`${selectedBot.environmentId}:${selectedBot.projectId}`) ??
                  "Unknown project"
                }
                thread={selectedBot}
                onDisable={() => void removeProfile(selectedBot)}
                onDispatch={(message) => dispatchTask(selectedBot, message)}
                onEdit={() => setEditingBot(selectedBot)}
                onMessageChange={(message) => {
                  const key = threadKey(selectedBot);
                  setDispatchDrafts((current) => updateBotDispatchDraft(current, key, message));
                }}
                onOpen={() => openInbox(selectedBot)}
              />
            )}
          </div>
        )}
      </div>

      {createOpen && (
        <CreateBotDialog
          busyThreadKeys={busyThreadKeys}
          candidates={candidates}
          open={createOpen}
          projectNameByRef={projectNameByRef}
          projects={botProjects}
          onOpenChange={setCreateOpen}
          onSave={saveProfile}
          onCreated={(key) => {
            setSelectedKey(key);
            setCreateOpen(false);
          }}
        />
      )}
      <EditBotDialog
        key={editingBot ? threadKey(editingBot) : "closed"}
        busy={editingBot !== null && busyThreadKeys.has(threadKey(editingBot))}
        thread={editingBot}
        onOpenChange={(open) => {
          if (!open) setEditingBot(null);
        }}
        onSave={saveProfile}
      />
    </SidebarInset>
  );
}

function EmptyFleet({
  candidateCount,
  onCreate,
}: {
  readonly candidateCount: number;
  readonly onCreate: () => void;
}) {
  return (
    <main className="grid min-h-0 flex-1 place-items-center overflow-y-auto px-6 py-12">
      <div className="w-full max-w-xl">
        <span className="mb-6 grid size-14 place-items-center rounded-2xl bg-primary/10 text-primary">
          <BotIcon className="size-7" />
        </span>
        <h2 className="text-balance font-heading text-3xl font-semibold tracking-tight">
          Create a bot
        </h2>
        <p className="mt-3 max-w-lg text-balance text-base leading-relaxed text-muted-foreground">
          Save instructions for an agent you reuse. Send it tasks here or assign work from your
          project board.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Button onClick={onCreate}>
            <PlusIcon /> Create your first bot
          </Button>
          <span className="text-sm text-muted-foreground">
            {candidateCount > 0
              ? `${candidateCount} isolated ${candidateCount === 1 ? "thread is" : "threads are"} ready`
              : "Choose a project to get started."}
          </span>
        </div>
      </div>
    </main>
  );
}

function BotFleetRow({
  active,
  projectName,
  thread,
  onSelect,
}: {
  readonly active: boolean;
  readonly projectName: string;
  readonly thread: EnvironmentThreadShell;
  readonly onSelect: () => void;
}) {
  const availability = resolveBotAvailability(thread);
  const status = STATUS_PRESENTATION[availability];
  return (
    <button
      className={`flex min-w-56 items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors md:min-w-0 ${
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
      }`}
      type="button"
      onClick={onSelect}
    >
      <span className="relative grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
        <BotIcon className="size-4.5" />
        <span
          className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-background ${status.dotClass}`}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {thread.botProfile?.displayName ?? thread.title}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {thread.planProgress?.step ?? projectName}
        </span>
      </span>
    </button>
  );
}

function BotWorkspace({
  busy,
  computerCapability,
  message,
  projectName,
  thread,
  onDisable,
  onDispatch,
  onEdit,
  onMessageChange,
  onOpen,
}: {
  readonly busy: boolean;
  readonly computerCapability: BotComputerCapability | undefined;
  readonly message: string;
  readonly projectName: string;
  readonly thread: EnvironmentThreadShell;
  readonly onDisable: () => void;
  readonly onDispatch: (message: string) => Promise<boolean>;
  readonly onEdit: () => void;
  readonly onMessageChange: (message: string) => void;
  readonly onOpen: () => void;
}) {
  const [computerOpen, setComputerOpen] = useState(false);
  const availability = resolveBotAvailability(thread);
  const status = STATUS_PRESENTATION[availability];
  const StatusIcon = status.icon;
  const canDispatch = canDispatchToBot(availability);
  const dispatchDisabled = busy || !canDispatch || message.trim().length === 0;

  const dispatch = () => {
    if (dispatchDisabled) return;
    void onDispatch(message);
  };

  return (
    <ScrollArea className="min-h-0 flex-1">
      <main className="mx-auto flex w-full max-w-5xl flex-col px-5 py-7 sm:px-8 sm:py-10">
        <div className="flex min-w-0 items-start gap-4 border-b border-border pb-7">
          <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary">
            <BotIcon className="size-6" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate font-heading text-2xl font-semibold tracking-tight">
                {thread.botProfile?.displayName ?? thread.title}
              </h2>
              <Badge variant={status.variant}>
                <StatusIcon /> {botAvailabilityLabel(availability, thread)}
              </Badge>
            </div>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {thread.botProfile?.description ||
                "No standing instructions yet. Edit the bot to add the role it follows on every task."}
            </p>
          </div>
          <Button aria-label="Edit bot" size="icon-sm" variant="ghost" onClick={onEdit}>
            <PencilIcon />
          </Button>
        </div>

        <section className="py-7">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Send a task</h3>
            </div>
            <Button size="sm" variant="ghost" onClick={onOpen}>
              Open conversation <ArrowUpRightIcon />
            </Button>
          </div>
          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-xs focus-within:ring-2 focus-within:ring-ring/25">
            <Textarea
              aria-label={`Message ${thread.botProfile?.displayName ?? thread.title}`}
              className="min-h-28 resize-none border-0 bg-transparent px-4 py-3 shadow-none focus-visible:ring-0"
              disabled={busy || !canDispatch}
              placeholder={
                busy
                  ? "Sending task…"
                  : availability === "working"
                    ? "This bot is working…"
                    : availability === "attention"
                      ? "Open the conversation to respond…"
                      : "Give this bot a task…"
              }
              value={message}
              onChange={(event) => onMessageChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) dispatch();
              }}
            />
            <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/25 px-3 py-2">
              <span className="text-xs text-muted-foreground">
                {thread.modelSelection.model} · {thread.runtimeMode}
              </span>
              <Button className="ms-auto" disabled={dispatchDisabled} size="sm" onClick={dispatch}>
                <SendIcon /> Send task
              </Button>
            </div>
          </div>
        </section>

        <details
          className="mb-7 rounded-lg border border-border p-3"
          onToggle={(event) => setComputerOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer text-sm font-medium">Computer</summary>
          <p className="my-2 text-xs text-muted-foreground">
            Open a browser desktop for tasks that need one.
          </p>
          {computerOpen ? (
            <BotComputerPanel
              key={`${thread.environmentId}:${thread.id}`}
              capability={computerCapability}
              environmentId={thread.environmentId}
              threadId={thread.id}
            />
          ) : null}
        </details>

        <section className="grid border-y border-border sm:grid-cols-3 sm:divide-x sm:divide-border">
          <BotFact
            label="Current work"
            value={thread.planProgress?.step ?? botAvailabilityLabel(availability, thread)}
          />
          <BotFact label="Project" value={projectName} detail={thread.branch ?? undefined} />
          <BotFact
            label="Connection"
            value={thread.session?.mcpAttachment === "attached" ? "MCP attached" : "Thread ready"}
            detail={thread.worktreePath ? "Isolated worktree" : undefined}
          />
        </section>

        <div className="mt-7 flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Disabling the bot keeps its conversation and files.
          </p>
          <Button disabled={busy} size="sm" variant="ghost" onClick={onDisable}>
            <Trash2Icon /> Disable bot
          </Button>
        </div>
      </main>
    </ScrollArea>
  );
}

function BotFact({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string | undefined;
}) {
  return (
    <div className="min-w-0 py-5 sm:px-5 sm:first:ps-0 sm:last:pe-0">
      <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 truncate text-sm font-medium">{value}</p>
      {detail && <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

interface BotProjectChoice {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly name: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection: ModelSelection | null;
  readonly environmentLabel: string | null;
}

function CreateBotDialog({
  busyThreadKeys,
  candidates,
  open,
  projectNameByRef,
  projects,
  onOpenChange,
  onSave,
  onCreated,
}: {
  readonly busyThreadKeys: ReadonlySet<string>;
  readonly candidates: ReadonlyArray<EnvironmentThreadShell>;
  readonly open: boolean;
  readonly projectNameByRef: ReadonlyMap<string, string>;
  readonly projects: ReadonlyArray<BotProjectChoice>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (
    thread: EnvironmentThreadShell,
    displayName: string,
    description: string,
  ) => Promise<boolean>;
  readonly onCreated: (key: string) => void;
}) {
  const [projectKey, setProjectKey] = useState("");
  const project =
    projects.find((entry) => `${entry.environmentId}:${entry.id}` === projectKey) ?? projects[0];
  const [creating, setCreating] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!creating) onOpenChange(next);
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New bot</DialogTitle>
          <DialogDescription>
            Save instructions and choose a provider. Tasks run in the bot's own worktree.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          {project ? (
            <>
              <label className="flex flex-col gap-1.5 text-sm">
                Project
                <select
                  disabled={creating}
                  className="h-9 rounded-md border bg-background px-2"
                  value={`${project.environmentId}:${project.id}`}
                  onChange={(event) => setProjectKey(event.target.value)}
                >
                  {projects.map((entry) => (
                    <option
                      key={`${entry.environmentId}:${entry.id}`}
                      value={`${entry.environmentId}:${entry.id}`}
                    >
                      {entry.name}
                      {entry.environmentLabel ? ` · ${entry.environmentLabel}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <NewBotForm
                key={`${project.environmentId}:${project.id}`}
                project={project}
                onBusyChange={setCreating}
                onCreated={onCreated}
              />
            </>
          ) : (
            <div className="text-sm text-muted-foreground">
              <p>Add a project on a connected environment that supports bots.</p>
              <Button
                className="mt-3"
                onClick={() => {
                  onOpenChange(false);
                  openCommandPalette({ open: "add-project" });
                }}
              >
                Add project
              </Button>
            </div>
          )}
          {candidates.length > 0 && !creating ? (
            <details className="border-t pt-3">
              <summary className="cursor-pointer text-sm">Use an existing thread</summary>
              <div className="mt-3 flex flex-col gap-2">
                {candidates.map((thread) => (
                  <div
                    key={threadKey(thread)}
                    className="flex items-center gap-3 rounded-md border p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{thread.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {projectNameByRef.get(`${thread.environmentId}:${thread.projectId}`) ??
                          "Unknown project"}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      disabled={busyThreadKeys.has(threadKey(thread))}
                      onClick={() =>
                        void onSave(thread, thread.title, "").then((saved) => {
                          if (saved) onOpenChange(false);
                        })
                      }
                    >
                      Use thread
                    </Button>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function NewBotForm({
  project,
  onBusyChange,
  onCreated,
}: {
  readonly project: BotProjectChoice;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onCreated: (key: string) => void;
}) {
  const settings = useEnvironmentSettings(project.environmentId);
  const resolvedSettings = resolveProjectSettings(settings, project.id, project).settings;
  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree, { reportFailure: false });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const configureBot = useAtomCommand(threadEnvironment.configureBot, { reportFailure: false });
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [model, setModel] = useState<ModelSelection | null>(null);
  const [threadId] = useState(newThreadId);
  const [worktree, setWorktree] = useState<{ path: string; refName: string } | null>(null);
  const [threadCreated, setThreadCreated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (busy || model === null || !name.trim()) return;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      let targetWorktree = worktree;
      if (targetWorktree === null) {
        const result = await createWorktree({
          environmentId: project.environmentId,
          input: {
            cwd: project.workspaceRoot,
            refName: "HEAD",
            newRefName: `bot/${threadId}`,
            path: null,
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        targetWorktree = result.value.worktree;
        setWorktree(targetWorktree);
      }
      if (!threadCreated) {
        const result = await createThread({
          environmentId: project.environmentId,
          input: {
            threadId,
            projectId: project.id,
            title: name.trim(),
            modelSelection: model,
            runtimeMode: resolvedSettings.defaultRuntimeMode,
            interactionMode: "default",
            branch: targetWorktree.refName,
            worktreePath: targetWorktree.path,
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        setThreadCreated(true);
      }
      const result = await configureBot({
        environmentId: project.environmentId,
        input: {
          threadId,
          expectedRevision: null,
          displayName: name.trim(),
          description: instructions.trim() || null,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      onCreated(`${project.environmentId}:${threadId}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <label className="flex flex-col gap-1.5 text-sm">
        Bot name
        <Input
          required
          maxLength={80}
          disabled={busy || threadCreated}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        Instructions
        <Textarea
          rows={4}
          maxLength={2000}
          disabled={busy}
          placeholder="What should this bot do on every task?"
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </label>
      <div className="flex flex-col gap-1.5">
        <Label>Provider and model</Label>
        <fieldset disabled={busy || threadCreated}>
          <EnvironmentModelField
            environmentId={project.environmentId}
            projectDefault={resolvedSettings.defaultModelSelection}
            selection={model}
            onChange={setModel}
          />
        </fieldset>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
          {threadCreated
            ? " The thread was created. Retry to finish saving the bot."
            : worktree
              ? " The worktree was created. Retry to finish setup."
              : ""}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Creating a bot does not send a task. You can edit its instructions or disable it later.
      </p>
      <Button type="submit" disabled={busy || model === null || !name.trim()}>
        {busy ? "Creating bot…" : error ? "Retry creation" : "Create bot"}
      </Button>
    </form>
  );
}

function EditBotDialog({
  busy,
  thread,
  onOpenChange,
  onSave,
}: {
  readonly busy: boolean;
  readonly thread: EnvironmentThreadShell | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (
    thread: EnvironmentThreadShell,
    displayName: string,
    description: string,
  ) => Promise<boolean>;
}) {
  const [displayName, setDisplayName] = useState(
    thread?.botProfile?.displayName ?? thread?.title ?? "",
  );
  const [description, setDescription] = useState(thread?.botProfile?.description ?? "");

  return (
    <Dialog open={thread !== null} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Edit bot</DialogTitle>
          <DialogDescription>
            Name this bot and write the instructions it follows on every task.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <Input
            aria-label="Bot name"
            maxLength={80}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
          <Textarea
            aria-label="Bot instructions"
            maxLength={2000}
            placeholder="Standing instructions sent ahead of every task, such as the role, the test command, and the commit rule."
            rows={6}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={busy || thread === null || displayName.trim().length === 0}
            onClick={() => {
              if (thread === null) return;
              void onSave(thread, displayName, description).then(
                (saved) => saved && onOpenChange(false),
              );
            }}
          >
            <SaveIcon /> Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
