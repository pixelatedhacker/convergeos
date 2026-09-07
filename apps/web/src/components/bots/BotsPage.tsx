import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { BotComputerCapability, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  BotIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  GitBranchIcon,
  InboxIcon,
  PencilIcon,
  PlusIcon,
  SaveIcon,
  SendIcon,
  Trash2Icon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import { openCommandPalette } from "../../commandPaletteBus";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { newMessageId } from "../../lib/utils";
import { useServerConfigs, useThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsProjectGroups } from "../settings/ProjectSettingsPanel";
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
  const createThread = useNewThreadHandler();
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
        group.memberProjects.map((project) => ({
          environmentId: project.environmentId,
          id: project.id,
          name: group.displayName,
        })),
      ),
    [projectGroups],
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
          title: "Could not dispatch task",
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

  const startBotThread = async (project: BotProjectChoice) => {
    const created = await createThread(scopeProjectRef(project.environmentId, project.id), {
      envMode: "worktree",
    });
    if (created !== null) setCreateOpen(false);
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
                <span>{bots.length} in fleet</span>
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

      <CreateBotDialog
        busyThreadKeys={busyThreadKeys}
        candidates={candidates}
        open={createOpen}
        projectNameByRef={projectNameByRef}
        projects={botProjects}
        onOpenChange={setCreateOpen}
        onSave={saveProfile}
        onStartThread={startBotThread}
      />
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
          Build a fleet that keeps working.
        </h2>
        <p className="mt-3 max-w-lg text-balance text-base leading-relaxed text-muted-foreground">
          Bots are persistent, named agent threads. Dispatch work here, assign Kanban tasks, or let
          another harness reach them through the ConvergeOS agent mesh.
        </p>
        <div className="mt-8 grid gap-4 border-y border-border py-6 sm:grid-cols-3">
          <FleetCapability icon={<InboxIcon />} label="Dedicated inbox" />
          <FleetCapability icon={<GitBranchIcon />} label="Isolated worktree" />
          <FleetCapability icon={<ArrowUpRightIcon />} label="Mesh addressable" />
        </div>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Button onClick={onCreate}>
            <PlusIcon /> {candidateCount > 0 ? "Promote a thread" : "Create your first bot"}
          </Button>
          <span className="text-sm text-muted-foreground">
            {candidateCount > 0
              ? `${candidateCount} isolated ${candidateCount === 1 ? "thread is" : "threads are"} ready`
              : "Start an isolated thread first, then return here."}
          </span>
        </div>
      </div>
    </main>
  );
}

function FleetCapability({
  icon,
  label,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
}) {
  return (
    <div className="flex items-center gap-2.5 text-sm font-medium [&_svg]:size-4 [&_svg]:text-muted-foreground">
      {icon}
      {label}
    </div>
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
                "A persistent agent ready to own work in this project."}
            </p>
          </div>
          <Button aria-label="Edit bot" size="icon-sm" variant="ghost" onClick={onEdit}>
            <PencilIcon />
          </Button>
        </div>

        <div className="pt-7">
          <BotComputerPanel
            key={`${thread.environmentId}:${thread.id}`}
            capability={computerCapability}
            environmentId={thread.environmentId}
            threadId={thread.id}
          />
        </div>

        <section className="py-7">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Dispatch work</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Send a task without leaving the fleet.
              </p>
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
            Kanban and MCP harnesses can address this bot by its thread identity.
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
}

function CreateBotDialog({
  busyThreadKeys,
  candidates,
  open,
  projectNameByRef,
  projects,
  onOpenChange,
  onSave,
  onStartThread,
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
  readonly onStartThread: (project: BotProjectChoice) => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New bot</DialogTitle>
          <DialogDescription>
            Promote an isolated thread into a persistent fleet member.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-2">
          {candidates.length === 0 ? (
            projects.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border px-5 py-8 text-center">
                <p className="text-sm font-medium">Add a project to create a bot</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Bots need a project and an isolated worktree.
                </p>
                <Button
                  className="mt-4"
                  size="sm"
                  onClick={() => {
                    onOpenChange(false);
                    openCommandPalette({ open: "add-project" });
                  }}
                >
                  <PlusIcon /> Add project
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="pb-1 text-sm text-muted-foreground">
                  Choose a project. ConvergeOS will open a new thread in an isolated worktree.
                </p>
                {projects.map((project) => (
                  <button
                    className="flex items-center gap-3 rounded-xl border border-border px-3 py-3 text-left transition-colors hover:bg-accent"
                    key={`${project.environmentId}:${project.id}`}
                    type="button"
                    onClick={() => void onStartThread(project)}
                  >
                    <span className="grid size-9 place-items-center rounded-xl bg-primary/10 text-primary">
                      <GitBranchIcon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{project.name}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        Start isolated bot thread
                      </span>
                    </span>
                    <ArrowUpRightIcon className="size-4 text-muted-foreground" />
                  </button>
                ))}
              </div>
            )
          ) : (
            candidates.map((thread) => (
              <div
                key={threadKey(thread)}
                className="flex min-w-0 items-center gap-3 rounded-xl border border-border px-3 py-3"
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                  <BotIcon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{thread.title}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {projectNameByRef.get(`${thread.environmentId}:${thread.projectId}`) ??
                      "Unknown project"}
                    {thread.branch ? ` · ${thread.branch}` : ""}
                  </p>
                </div>
                <Button
                  disabled={busyThreadKeys.has(threadKey(thread))}
                  size="sm"
                  onClick={() =>
                    void onSave(thread, thread.title, "").then(
                      (saved) => saved && onOpenChange(false),
                    )
                  }
                >
                  Add
                </Button>
              </div>
            ))
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
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
            Give this fleet member a clear name and responsibility.
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
            aria-label="Bot description"
            maxLength={500}
            placeholder="What should this bot handle?"
            rows={4}
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
