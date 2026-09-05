import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  ExternalLinkIcon,
  PencilIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import { useServerConfigs, useThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsProjectGroups } from "../settings/ProjectSettingsPanel";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  botAvailabilityLabel,
  isBotCandidate,
  resolveBotAvailability,
  sortBotThreads,
  type BotAvailability,
} from "./BotsPage.logic";

function threadKey(thread: Pick<EnvironmentThreadShell, "environmentId" | "id">): string {
  return `${thread.environmentId}:${thread.id}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The bot profile update failed.";
}

const STATUS_PRESENTATION: Record<
  BotAvailability,
  {
    readonly icon: typeof CheckCircle2Icon;
    readonly variant: "success" | "warning" | "error" | "info";
  }
> = {
  available: { icon: CheckCircle2Icon, variant: "success" },
  attention: { icon: CircleAlertIcon, variant: "warning" },
  failed: { icon: CircleAlertIcon, variant: "error" },
  working: { icon: CircleDashedIcon, variant: "info" },
};

export function BotsPage() {
  const navigate = useNavigate();
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const projectGroups = useSettingsProjectGroups();
  const configureBot = useAtomCommand(threadEnvironment.configureBot, { reportFailure: false });
  const disableBot = useAtomCommand(threadEnvironment.disableBot, { reportFailure: false });
  const [busyThreadKey, setBusyThreadKey] = useState<string | null>(null);

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
    setBusyThreadKey(key);
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
      toastManager.add({ type: "success", title: "Bot profile saved" });
      return true;
    } finally {
      setBusyThreadKey(null);
    }
  };

  const removeProfile = async (thread: EnvironmentThreadShell) => {
    if (thread.botProfile == null) return;
    const key = threadKey(thread);
    setBusyThreadKey(key);
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
      setBusyThreadKey(null);
    }
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Bots breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1>Bots</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <Badge className="ms-auto" variant="secondary">
            {bots.length} {bots.length === 1 ? "bot" : "bots"}
          </Badge>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            <section className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <h2 className="text-lg font-semibold">Bot inboxes</h2>
                <p className="max-w-2xl text-sm text-muted-foreground">
                  Persistent agent threads that can receive work from Kanban or another harness
                  through the ConvergeOS agent mesh.
                </p>
              </div>

              {bots.length === 0 ? (
                <div className="flex min-h-44 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-6 text-center">
                  <span className="grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
                    <BotIcon className="size-5" />
                  </span>
                  <div>
                    <p className="text-sm font-medium">No bots yet</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Create an isolated thread, then promote it below.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="grid gap-3 lg:grid-cols-2">
                  {bots.map((thread) => (
                    <BotCard
                      key={threadKey(thread)}
                      busy={busyThreadKey === threadKey(thread)}
                      projectName={
                        projectNameByRef.get(`${thread.environmentId}:${thread.projectId}`) ??
                        "Unknown project"
                      }
                      thread={thread}
                      onDisable={() => void removeProfile(thread)}
                      onOpen={() => openInbox(thread)}
                      onSave={(displayName, description) =>
                        saveProfile(thread, displayName, description)
                      }
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="flex flex-col gap-4 border-t border-border pt-6">
              <div className="flex flex-col gap-1">
                <h2 className="text-base font-semibold">Create a bot</h2>
                <p className="max-w-2xl text-sm text-muted-foreground">
                  Bots use isolated worktrees so their inbox can keep working without modifying a
                  shared checkout.
                </p>
              </div>

              {candidates.length === 0 ? (
                <p className="rounded-lg bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
                  No eligible isolated threads. Start a thread in a worktree to make it a bot.
                </p>
              ) : (
                <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
                  {candidates.map((thread) => (
                    <div
                      key={threadKey(thread)}
                      className="flex min-w-0 items-center gap-3 px-4 py-3"
                    >
                      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                        <BotIcon className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{thread.title}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {projectNameByRef.get(`${thread.environmentId}:${thread.projectId}`) ??
                            "Unknown project"}
                          {thread.branch ? ` · ${thread.branch}` : ""}
                        </p>
                      </div>
                      <Button
                        disabled={busyThreadKey === threadKey(thread)}
                        size="sm"
                        variant="outline"
                        onClick={() => void saveProfile(thread, thread.title, "")}
                      >
                        <PlusIcon />
                        Make bot
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function BotCard({
  busy,
  projectName,
  thread,
  onDisable,
  onOpen,
  onSave,
}: {
  readonly busy: boolean;
  readonly projectName: string;
  readonly thread: EnvironmentThreadShell;
  readonly onDisable: () => void;
  readonly onOpen: () => void;
  readonly onSave: (displayName: string, description: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(thread.botProfile?.displayName ?? thread.title);
  const [description, setDescription] = useState(thread.botProfile?.description ?? "");
  const availability = resolveBotAvailability(thread);
  const status = STATUS_PRESENTATION[availability];
  const StatusIcon = status.icon;

  const cancelEditing = () => {
    setDisplayName(thread.botProfile?.displayName ?? thread.title);
    setDescription(thread.botProfile?.description ?? "");
    setEditing(false);
  };

  return (
    <article className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-card p-4 shadow-xs">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <BotIcon className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-sm font-semibold">
              {thread.botProfile?.displayName ?? thread.title}
            </h3>
            <Badge variant={status.variant}>
              <StatusIcon />
              {botAvailabilityLabel(availability, thread)}
            </Badge>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {projectName}
            {thread.branch ? ` · ${thread.branch}` : ""}
          </p>
        </div>
      </div>

      {editing ? (
        <div className="flex flex-col gap-3">
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
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button disabled={busy} size="sm" variant="ghost" onClick={cancelEditing}>
              <XIcon />
              Cancel
            </Button>
            <Button
              disabled={busy || displayName.trim().length === 0}
              size="sm"
              onClick={() =>
                void onSave(displayName, description).then((saved) => {
                  if (saved) setEditing(false);
                })
              }
            >
              <SaveIcon />
              Save
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="min-h-10 text-sm text-muted-foreground">
            {thread.botProfile?.description || "No description yet."}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{thread.modelSelection.model}</Badge>
            <Badge variant="outline">MCP {thread.session?.mcpAttachment ?? "not started"}</Badge>
            <div className="ms-auto flex items-center gap-1">
              <Button
                aria-label="Edit bot"
                size="icon-xs"
                variant="ghost"
                onClick={() => {
                  setDisplayName(thread.botProfile?.displayName ?? thread.title);
                  setDescription(thread.botProfile?.description ?? "");
                  setEditing(true);
                }}
              >
                <PencilIcon />
              </Button>
              <Button
                aria-label="Disable bot"
                disabled={busy}
                size="icon-xs"
                variant="ghost"
                onClick={onDisable}
              >
                <Trash2Icon />
              </Button>
              <Button size="sm" variant="outline" onClick={onOpen}>
                Open inbox
                <ExternalLinkIcon />
              </Button>
            </div>
          </div>
        </>
      )}
    </article>
  );
}
