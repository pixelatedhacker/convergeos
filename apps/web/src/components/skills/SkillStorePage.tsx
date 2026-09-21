import { useCallback, useEffect, useMemo, useState } from "react";
import { PackageIcon, PackageOpenIcon, SearchIcon, ServerIcon, Trash2Icon } from "lucide-react";
import {
  SKILL_STORE_SEARCH_DEFAULT_LIMIT,
  type EnvironmentId,
  type InstalledSkill,
  type ProjectId,
  SkillStoreHarness,
  type SkillStoreDetail,
  type SkillStoreEntry,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { isElectron } from "~/env";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { readLocalApi } from "../../localApi";
import { useSettingsProjectGroups } from "../settings/ProjectSettingsPanel";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  SKILL_STORE_HARNESSES,
  buildInstallPlan,
  formatInstallCount,
  installedTargetKey,
  installedTargetLabel,
  skillStoreHarnessLabel,
} from "./SkillStorePage.logic";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function SkillStorePage() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  const connectedEnvironments = useMemo(
    () => environments.filter((environment) => environment.connection.phase === "connected"),
    [environments],
  );
  const [viewEnvironmentId, setViewEnvironmentId] = useState<EnvironmentId | null>(null);
  const activeEnvironmentId =
    viewEnvironmentId !== null &&
    connectedEnvironments.some((environment) => environment.environmentId === viewEnvironmentId)
      ? viewEnvironmentId
      : (primaryEnvironmentId ?? connectedEnvironments[0]?.environmentId ?? null);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReadonlyArray<SkillStoreEntry> | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<SkillStoreEntry | null>(null);

  const search = useAtomCommand(serverEnvironment.skillStoreSearch, {
    label: "skill-store:search",
    reportFailure: false,
  });

  const installedQuery = useEnvironmentQuery(
    activeEnvironmentId === null
      ? null
      : serverEnvironment.skillStoreInstalled({ environmentId: activeEnvironmentId, input: {} }),
  );
  const installedSkills = installedQuery.data?.skills ?? [];

  const runSearch = async () => {
    const trimmed = query.trim();
    if (activeEnvironmentId === null || trimmed.length < 2) return;
    setSearching(true);
    setSearchError(null);
    try {
      const result = await search({
        environmentId: activeEnvironmentId,
        input: { query: trimmed, limit: SKILL_STORE_SEARCH_DEFAULT_LIMIT },
      });
      if (result._tag === "Failure") {
        setResults(null);
        setSearchError(errorMessage(squashAtomCommandFailure(result), "The skill search failed."));
        return;
      }
      setResults(result.value.skills);
    } finally {
      setSearching(false);
    }
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <WorkspaceBreadcrumb ariaLabel="Skill store breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1>Skill store</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {connectedEnvironments.length === 0 ? (
              <EmptyNotice
                title="No connected environments"
                body="Connect a server to browse and install skills."
              />
            ) : (
              <>
                <section className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <ServerIcon className="size-4 text-muted-foreground" />
                    <h2 className="text-sm font-medium">Environment</h2>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {connectedEnvironments.map((environment) => (
                      <Button
                        key={environment.environmentId}
                        size="sm"
                        variant={
                          environment.environmentId === activeEnvironmentId ? "default" : "outline"
                        }
                        onClick={() => setViewEnvironmentId(environment.environmentId)}
                      >
                        {environment.label}
                      </Button>
                    ))}
                  </div>
                </section>

                <section className="flex flex-col gap-3">
                  <h2 className="text-sm font-medium">Discover skills</h2>
                  <form
                    className="flex gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void runSearch();
                    }}
                  >
                    <Input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search the skills.sh registry…"
                      aria-label="Search skills"
                    />
                    <Button
                      type="submit"
                      disabled={searching || query.trim().length < 2}
                      size="sm"
                      className="shrink-0"
                    >
                      <SearchIcon /> {searching ? "Searching…" : "Search"}
                    </Button>
                  </form>
                  {searchError ? <p className="text-sm text-destructive">{searchError}</p> : null}
                  {results !== null ? (
                    results.length === 0 ? (
                      <EmptyNotice title="No skills found" body="Try a different search query." />
                    ) : (
                      <ul className="grid gap-2 sm:grid-cols-2">
                        {results.map((entry) => (
                          <li key={entry.id}>
                            <button
                              type="button"
                              className="flex w-full flex-col gap-1.5 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-accent/50"
                              onClick={() => setSelectedEntry(entry)}
                            >
                              <div className="flex items-center gap-2">
                                <PackageIcon className="size-4 shrink-0 text-muted-foreground" />
                                <span className="truncate text-sm font-medium">{entry.name}</span>
                                <Badge variant="secondary" className="ms-auto shrink-0">
                                  {formatInstallCount(entry.installs)} installs
                                </Badge>
                              </div>
                              <span className="truncate text-xs text-muted-foreground">
                                {entry.source}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )
                  ) : null}
                </section>

                <InstalledSkillsSection
                  environmentId={activeEnvironmentId}
                  skills={installedSkills}
                  isPending={installedQuery.isPending}
                  error={installedQuery.error}
                  refresh={installedQuery.refresh}
                />
              </>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>

      <SkillDetailDialog
        key={selectedEntry?.id ?? "closed"}
        entry={selectedEntry}
        environmentId={activeEnvironmentId}
        connectedEnvironments={connectedEnvironments.map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
        }))}
        onClose={() => setSelectedEntry(null)}
        onInstalled={() => installedQuery.refresh()}
      />
    </SidebarInset>
  );
}

function InstalledSkillsSection({
  environmentId,
  skills,
  isPending,
  error,
  refresh,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly skills: ReadonlyArray<InstalledSkill>;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}) {
  const projects = useSettingsProjectGroups();
  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.displayName] as const)),
    [projects],
  );
  const uninstall = useAtomCommand(serverEnvironment.skillStoreUninstall, {
    label: "skill-store:uninstall",
    reportFailure: false,
  });
  const setHarnessEnabled = useAtomCommand(serverEnvironment.skillStoreSetHarnessEnabled, {
    label: "skill-store:set-harness-enabled",
    reportFailure: false,
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    label: "skill-store:refresh-providers",
    reportFailure: false,
  });
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const refreshAfterMutation = useCallback(() => {
    refresh();
    if (environmentId !== null) {
      void refreshProviders({ environmentId, input: {} });
    }
  }, [environmentId, refresh, refreshProviders]);

  const toggleHarness = async (
    skill: InstalledSkill,
    target: InstalledSkill["targets"][number],
    harness: SkillStoreHarness,
    enabled: boolean,
  ) => {
    if (environmentId === null) return;
    const key = `${skill.id}:${installedTargetKey(target)}:${harness}`;
    setBusyKey(key);
    try {
      const result = await setHarnessEnabled({
        environmentId,
        input: {
          id: skill.id,
          scope: target.scope,
          ...(target.projectId !== undefined ? { projectId: target.projectId } : {}),
          harness,
          enabled,
        },
      });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Could not update skill",
          description: errorMessage(squashAtomCommandFailure(result), "The skill update failed."),
        });
        return;
      }
      refreshAfterMutation();
    } finally {
      setBusyKey(null);
    }
  };

  const removeSkill = async (skill: InstalledSkill) => {
    if (environmentId === null) return;
    const api = readLocalApi();
    if (!api) return;
    const confirmed = await api.dialogs.confirm(
      `Remove "${skill.name}" from this environment? This deletes it from every harness and scope it was installed to.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setBusyKey(skill.id);
    try {
      const result = await uninstall({ environmentId, input: { id: skill.id } });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Could not remove skill",
          description: errorMessage(squashAtomCommandFailure(result), "The skill removal failed."),
        });
        return;
      }
      toastManager.add({ type: "success", title: "Skill removed" });
      refreshAfterMutation();
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <PackageOpenIcon className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Installed on this environment</h2>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {skills.length === 0 ? (
        <EmptyNotice
          title={isPending ? "Loading installed skills…" : "No skills installed"}
          body={
            isPending
              ? "Reading the environment manifest."
              : "Search above and install a skill to see it here."
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {skills.map((skill) => (
            <li
              key={skill.id}
              className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3"
            >
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{skill.name}</span>
                <span className="truncate text-xs text-muted-foreground">{skill.id}</span>
                <Button
                  className="ms-auto"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${skill.name}`}
                  disabled={busyKey !== null}
                  onClick={() => void removeSkill(skill)}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </div>
              {skill.description ? (
                <p className="text-xs text-muted-foreground">{skill.description}</p>
              ) : null}
              <div className="flex flex-col gap-2">
                {skill.targets.map((target) => (
                  <div
                    key={installedTargetKey(target)}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border/60 px-3 py-2"
                  >
                    <span className="text-xs font-medium text-muted-foreground">
                      {installedTargetLabel(target, projectNameById)}
                    </span>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      {SKILL_STORE_HARNESSES.map((harness) => {
                        const enabled = target.harnesses.includes(harness.id);
                        return (
                          <Label
                            key={harness.id}
                            className="flex items-center gap-1.5 text-xs font-normal"
                          >
                            <Switch
                              size="sm"
                              checked={enabled}
                              disabled={busyKey !== null}
                              aria-label={`${skillStoreHarnessLabel(harness.id)} for ${skill.name}`}
                              onCheckedChange={(checked) =>
                                void toggleHarness(skill, target, harness.id, checked === true)
                              }
                            />
                            {skillStoreHarnessLabel(harness.id)}
                          </Label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SkillDetailDialog({
  entry,
  environmentId,
  connectedEnvironments,
  onClose,
  onInstalled,
}: {
  readonly entry: SkillStoreEntry | null;
  readonly environmentId: EnvironmentId | null;
  readonly connectedEnvironments: ReadonlyArray<{
    environmentId: EnvironmentId;
    label: string;
  }>;
  readonly onClose: () => void;
  readonly onInstalled: () => void;
}) {
  const projects = useSettingsProjectGroups();
  const [detail, setDetail] = useState<SkillStoreDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [scope, setScope] = useState<"global" | "project">("global");
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] = useState<ReadonlySet<EnvironmentId>>(
    () => new Set(environmentId === null ? [] : [environmentId]),
  );
  const [selectedHarnesses, setSelectedHarnesses] = useState<ReadonlySet<SkillStoreHarness>>(
    () => new Set(["claude-code"]),
  );
  const [installing, setInstalling] = useState(false);

  const getDetail = useAtomCommand(serverEnvironment.skillStoreGetDetail, {
    label: "skill-store:get-detail",
    reportFailure: false,
  });
  const install = useAtomCommand(serverEnvironment.skillStoreInstall, {
    label: "skill-store:install",
    reportFailure: false,
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    label: "skill-store:refresh-providers",
    reportFailure: false,
  });

  useEffect(() => {
    if (entry === null || environmentId === null) return;
    let cancelled = false;
    void (async () => {
      const result = await getDetail({
        environmentId,
        input: { source: entry.source, skillId: entry.skillId },
      });
      if (cancelled) return;
      if (result._tag === "Failure") {
        setDetailError(
          errorMessage(squashAtomCommandFailure(result), "Could not load skill details."),
        );
        return;
      }
      setDetail(result.value);
    })();
    return () => {
      cancelled = true;
    };
  }, [entry, environmentId, getDetail]);

  const installableProjects = useMemo(
    () =>
      projects.filter((project) =>
        connectedEnvironments.some(
          (environment) => environment.environmentId === project.environmentId,
        ),
      ),
    [projects, connectedEnvironments],
  );

  const toggleHarness = (harness: SkillStoreHarness) => {
    setSelectedHarnesses((current) => {
      const next = new Set(current);
      if (next.has(harness)) {
        next.delete(harness);
      } else {
        next.add(harness);
      }
      return next;
    });
  };

  const toggleEnvironment = (environmentIdToToggle: EnvironmentId) => {
    setSelectedEnvironmentIds((current) => {
      const next = new Set(current);
      if (next.has(environmentIdToToggle)) {
        next.delete(environmentIdToToggle);
      } else {
        next.add(environmentIdToToggle);
      }
      return next;
    });
  };

  const selectedProject =
    selectedProjectKey === null
      ? null
      : (installableProjects.find(
          (project) => `${project.environmentId}:${project.id}` === selectedProjectKey,
        ) ?? null);

  const plan = buildInstallPlan({
    scope,
    projectEnvironmentId: selectedProject?.environmentId ?? null,
    projectId: (selectedProject?.id ?? null) as ProjectId | null,
    globalEnvironmentIds: [...selectedEnvironmentIds],
    harnesses: [...selectedHarnesses],
  });

  const runInstall = async () => {
    if (entry === null || plan.length === 0) return;
    setInstalling(true);
    const touchedEnvironmentIds: EnvironmentId[] = [];
    try {
      for (const planTarget of plan) {
        const result = await install({
          environmentId: planTarget.environmentId,
          input: {
            source: entry.source,
            skillId: entry.skillId,
            name: entry.name,
            description: detail?.description ?? null,
            targets: planTarget.targets,
          },
        });
        const environmentLabel =
          connectedEnvironments.find(
            (environment) => environment.environmentId === planTarget.environmentId,
          )?.label ?? planTarget.environmentId;
        if (result._tag === "Failure") {
          toastManager.add({
            type: "error",
            title: `Could not install on ${environmentLabel}`,
            description: errorMessage(
              squashAtomCommandFailure(result),
              "The skill install failed.",
            ),
          });
          continue;
        }
        touchedEnvironmentIds.push(planTarget.environmentId);
      }
      if (touchedEnvironmentIds.length > 0) {
        toastManager.add({
          type: "success",
          title:
            touchedEnvironmentIds.length === 1
              ? "Skill installed"
              : `Skill installed on ${touchedEnvironmentIds.length} environments`,
        });
        for (const touchedEnvironmentId of touchedEnvironmentIds) {
          void refreshProviders({ environmentId: touchedEnvironmentId, input: {} });
        }
        onInstalled();
        onClose();
      }
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Dialog open={entry !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-2xl">
        <DialogTitle>{entry?.name ?? "Skill"}</DialogTitle>
        <DialogDescription>
          {entry === null ? "" : `${entry.source} · ${formatInstallCount(entry.installs)} installs`}
        </DialogDescription>
        {entry === null ? null : (
          <div className="flex flex-col gap-5">
            {detailError ? <p className="text-sm text-destructive">{detailError}</p> : null}
            {detail?.description ? (
              <p className="text-sm text-muted-foreground">{detail.description}</p>
            ) : null}
            {detail !== null && detail.files.length > 0 ? (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer select-none">
                  {detail.files.length} file{detail.files.length === 1 ? "" : "s"} in this skill
                </summary>
                <ul className="mt-2 flex flex-col gap-1">
                  {detail.files.map((file) => (
                    <li key={file.path} className="font-mono">
                      {file.path}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Harnesses</h3>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {SKILL_STORE_HARNESSES.map((harness) => (
                  <Label key={harness.id} className="flex items-center gap-1.5 text-sm font-normal">
                    <Checkbox
                      checked={selectedHarnesses.has(harness.id)}
                      onCheckedChange={() => toggleHarness(harness.id)}
                      aria-label={harness.label}
                    />
                    {harness.label}
                  </Label>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Where to install</h3>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={scope === "global" ? "default" : "outline"}
                  onClick={() => setScope("global")}
                >
                  Environments
                </Button>
                <Button
                  size="sm"
                  variant={scope === "project" ? "default" : "outline"}
                  onClick={() => setScope("project")}
                  disabled={installableProjects.length === 0}
                >
                  A project
                </Button>
              </div>
              {scope === "global" ? (
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {connectedEnvironments.map((environment) => (
                    <Label
                      key={environment.environmentId}
                      className="flex items-center gap-1.5 text-sm font-normal"
                    >
                      <Checkbox
                        checked={selectedEnvironmentIds.has(environment.environmentId)}
                        onCheckedChange={() => toggleEnvironment(environment.environmentId)}
                        aria-label={environment.label}
                      />
                      {environment.label}
                    </Label>
                  ))}
                </div>
              ) : (
                <Select
                  value={selectedProjectKey ?? ""}
                  onValueChange={(value) => setSelectedProjectKey(value === "" ? null : value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a project" />
                  </SelectTrigger>
                  <SelectPopup>
                    {installableProjects.map((project) => {
                      const environmentLabel =
                        connectedEnvironments.find(
                          (environment) => environment.environmentId === project.environmentId,
                        )?.label ?? null;
                      return (
                        <SelectItem
                          key={`${project.environmentId}:${project.id}`}
                          value={`${project.environmentId}:${project.id}`}
                        >
                          {project.displayName}
                          {environmentLabel !== null ? ` · ${environmentLabel}` : ""}
                        </SelectItem>
                      );
                    })}
                  </SelectPopup>
                </Select>
              )}
            </div>

            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={onClose} disabled={installing}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={installing || plan.length === 0}
                onClick={() => void runInstall()}
              >
                {installing ? "Installing…" : "Install"}
              </Button>
            </div>
          </div>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function EmptyNotice({ title, body }: { readonly title: string; readonly body: string }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-border px-4 py-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">{body}</p>
    </div>
  );
}
