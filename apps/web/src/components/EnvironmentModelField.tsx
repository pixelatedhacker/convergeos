import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../state/server";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "./settings/settingsLayout";

export function EnvironmentModelField({
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
