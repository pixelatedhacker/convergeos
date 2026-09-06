import type {
  BotComputerCapability,
  BotComputerState,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  ExternalLinkIcon,
  MonitorIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ServerOffIcon,
  ShieldAlertIcon,
  Trash2Icon,
  WifiIcon,
} from "lucide-react";
import { useState } from "react";

import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { botComputerEnvironment } from "../../state/botComputer";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { toastManager } from "../ui/toast";
import {
  botComputerDisplayState,
  botComputerPrimaryAction,
  botComputerStatusLabel,
  canOpenHostLocalViewer,
  type BotComputerPrimaryAction,
} from "./BotComputerPanel.logic";

type BotComputerMutation = "start" | "suspend" | "resume" | "reset" | "destroy";
type DestructiveMutation = Extract<BotComputerMutation, "reset" | "destroy">;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The Bot computer operation failed.";
}

export function BotComputerPanel({
  capability,
  environmentId,
  threadId,
}: {
  readonly capability: BotComputerCapability | undefined;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const target = { environmentId, input: { threadId } } as const;
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const query = useEnvironmentQuery(capability ? botComputerEnvironment.inspect(target) : null);
  const start = useAtomCommand(botComputerEnvironment.start, { reportFailure: false });
  const suspend = useAtomCommand(botComputerEnvironment.suspend, { reportFailure: false });
  const resume = useAtomCommand(botComputerEnvironment.resume, { reportFailure: false });
  const reset = useAtomCommand(botComputerEnvironment.reset, { reportFailure: false });
  const destroy = useAtomCommand(botComputerEnvironment.destroy, { reportFailure: false });
  const [pending, setPending] = useState<BotComputerMutation | null>(null);
  const [confirming, setConfirming] = useState<DestructiveMutation | null>(null);
  const [mutationState, setMutationState] = useState<BotComputerState | null>(null);
  const state = botComputerDisplayState(query.data, mutationState);
  const canOpenViewer = canOpenHostLocalViewer({
    environmentHttpBaseUrl,
    viewerUrl: state?.status === "running" ? state.viewerUrl : undefined,
    viewerPort: state?.status === "running" ? state.viewerPort : undefined,
    clientOrigin: window.location.origin,
  });

  const run = async (operation: BotComputerMutation) => {
    if (pending !== null) return;
    setMutationState(null);
    setPending(operation);
    try {
      const result = await (operation === "start"
        ? start({ ...target, input: { threadId, networkAccess: "outbound" } })
        : operation === "resume"
          ? resume({ ...target, input: { threadId, networkAccess: "outbound" } })
          : operation === "reset"
            ? reset({ ...target, input: { threadId, networkAccess: "outbound" } })
            : operation === "suspend"
              ? suspend(target)
              : destroy(target));
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Bot computer unavailable",
          description: errorMessage(squashAtomCommandFailure(result)),
        });
        return;
      }
      setMutationState(result.value.status === "failed" ? result.value : null);
    } finally {
      setPending(null);
    }
  };

  const runPrimary = (action: BotComputerPrimaryAction) => {
    if (action === "start" || action === "retry") void run("start");
    if (action === "resume") void run("resume");
  };

  const primaryAction = botComputerPrimaryAction(state);
  const statusLabel = capability ? botComputerStatusLabel(state) : "Not supported";

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-xs">
      <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-border px-3 py-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <MonitorIcon className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Computer</h3>
          <Badge
            variant={
              state?.status === "running"
                ? "success"
                : state?.status === "failed"
                  ? "error"
                  : state?.status === "unavailable"
                    ? "warning"
                    : "secondary"
            }
          >
            {statusLabel}
          </Badge>
          {state?.status === "running" && (
            <Badge variant="secondary">
              <WifiIcon /> Outbound network
            </Badge>
          )}
        </div>

        <div className="ms-auto flex items-center gap-1.5">
          <Button
            aria-label="Refresh computer status"
            disabled={capability === undefined || pending !== null || query.isPending}
            size="icon-sm"
            variant="ghost"
            onClick={() => {
              setMutationState(null);
              query.refresh();
            }}
          >
            <RefreshCwIcon className={query.isPending ? "animate-spin" : undefined} />
          </Button>
          {state?.status === "running" && canOpenViewer && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => window.open(state.viewerUrl, "_blank", "noopener,noreferrer")}
            >
              <ExternalLinkIcon /> Open
            </Button>
          )}
          {state?.status === "running" && (
            <Button
              disabled={pending !== null}
              size="sm"
              variant="outline"
              onClick={() => void run("suspend")}
            >
              <PauseIcon /> {pending === "suspend" ? "Suspending…" : "Suspend"}
            </Button>
          )}
          {primaryAction !== null && state?.status !== "unavailable" && (
            <Button disabled={pending !== null} size="sm" onClick={() => runPrimary(primaryAction)}>
              <PlayIcon />
              {pending === "start" || pending === "resume"
                ? "Starting…"
                : primaryAction === "resume"
                  ? "Resume"
                  : "Start with network"}
            </Button>
          )}
        </div>
      </div>

      <div className="relative flex aspect-[16/10] min-h-72 items-center justify-center bg-[#111318]">
        {capability === undefined ? (
          <ComputerEmptyState
            icon={<ServerOffIcon />}
            title="Computer is not available"
            detail="Update this environment to a version that supports Bot computers."
          />
        ) : query.error ? (
          <ComputerEmptyState
            icon={<ShieldAlertIcon />}
            title="Could not inspect this computer"
            detail={query.error}
          />
        ) : query.isPending && state === null ? (
          <ComputerEmptyState
            icon={<RefreshCwIcon className="animate-spin" />}
            title="Checking the host"
            detail="Reading this Bot's container state."
          />
        ) : state?.status === "running" && canOpenViewer ? (
          <iframe
            allow="clipboard-read; clipboard-write"
            className="absolute inset-0 size-full border-0 bg-black"
            // noVNC needs a non-opaque origin for its ES modules. The viewer gate rejects same-origin URLs.
            // oxlint-disable-next-line react/iframe-missing-sandbox
            sandbox="allow-forms allow-modals allow-pointer-lock allow-same-origin allow-scripts"
            src={state.viewerUrl}
            title="Bot computer desktop"
          />
        ) : state?.status === "running" ? (
          <ComputerEmptyState
            icon={<MonitorIcon />}
            title="Desktop is running on its host"
            detail="The first Bot Computer viewer is host-local. Open this environment on the host to take control."
          />
        ) : state?.status === "unavailable" ? (
          <ComputerEmptyState
            icon={<ServerOffIcon />}
            title="Docker is not ready"
            detail={state.detail}
          />
        ) : state?.status === "failed" ? (
          <ComputerEmptyState
            icon={<ShieldAlertIcon />}
            title="Computer needs attention"
            detail={state.detail}
          />
        ) : state?.status === "suspended" ? (
          <ComputerEmptyState
            icon={<PauseIcon />}
            title="Computer is suspended"
            detail="Its browser profile and workspace are preserved with no container compute running."
          />
        ) : (
          <ComputerEmptyState
            icon={<MonitorIcon />}
            title="Give this Bot a desktop"
            detail="Starts Chromium, a terminal, and file access in the Bot's isolated worktree. Outbound network access is enabled explicitly."
          />
        )}

        {pending !== null && (
          <div className="absolute inset-0 grid place-items-center bg-background/75 backdrop-blur-sm">
            <div className="flex items-center gap-2 text-sm font-medium">
              <RefreshCwIcon className="size-4 animate-spin" />
              {pending === "destroy"
                ? "Destroying computer…"
                : pending === "reset"
                  ? "Resetting computer…"
                  : pending === "suspend"
                    ? "Suspending computer…"
                    : "Starting computer…"}
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-border bg-muted/20 px-3 py-2.5 sm:px-4">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
          Container isolation is not safe containment for hostile code. Host credentials are not
          injected, but files and secrets in this Bot&apos;s worktree are visible here.
        </p>
        {(state?.status === "running" ||
          state?.status === "suspended" ||
          (state?.status === "failed" && state.containerId !== undefined)) && (
          <div className="flex items-center gap-1">
            <Button
              disabled={pending !== null}
              size="sm"
              variant="ghost"
              onClick={() => setConfirming("reset")}
            >
              <RotateCcwIcon /> Reset
            </Button>
            <Button
              disabled={pending !== null}
              size="sm"
              variant="ghost"
              onClick={() => setConfirming("destroy")}
            >
              <Trash2Icon /> Destroy
            </Button>
          </div>
        )}
      </div>

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {confirming === "reset" ? "Reset this computer?" : "Destroy this computer?"}
            </DialogTitle>
            <DialogDescription>
              This deletes the persistent Chromium profile, including cookies and signed-in
              sessions. Files in the Bot worktree are not deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="text-sm text-muted-foreground">
            {confirming === "reset"
              ? "A clean computer will start immediately with outbound network access."
              : "You can create a clean computer again later."}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const operation = confirming;
                setConfirming(null);
                if (operation !== null) void run(operation);
              }}
            >
              {confirming === "reset" ? "Reset computer" : "Destroy computer"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </section>
  );
}

function ComputerEmptyState({
  icon,
  title,
  detail,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly detail: string;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 text-center text-white">
      <span className="mb-4 grid size-12 place-items-center rounded-2xl bg-white/10 [&_svg]:size-5">
        {icon}
      </span>
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-white/60">{detail}</p>
    </div>
  );
}
