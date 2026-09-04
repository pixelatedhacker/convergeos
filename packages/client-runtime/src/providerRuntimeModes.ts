import type { RuntimeMode, ServerProvider } from "@t3tools/contracts";

export const RUNTIME_MODE_LABELS: Readonly<Record<RuntimeMode, string>> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

type RuntimeModeProvider = Pick<ServerProvider, "supportedRuntimeModes" | "displayName" | "driver">;

export function supportsProviderRuntimeMode(
  provider: RuntimeModeProvider | null | undefined,
  mode: RuntimeMode,
): boolean {
  return provider?.supportedRuntimeModes?.includes(mode) ?? true;
}

/** Preserve the selected mode until the user explicitly chooses a supported one. */
export function getProviderRuntimeModeBlockReason(
  provider: RuntimeModeProvider | null | undefined,
  mode: RuntimeMode,
): string | null {
  if (supportsProviderRuntimeMode(provider, mode)) return null;
  const name = provider?.displayName ?? provider?.driver ?? "This provider";
  const choices = provider?.supportedRuntimeModes?.map((value) => RUNTIME_MODE_LABELS[value]);
  return choices?.length
    ? `${name} does not support ${RUNTIME_MODE_LABELS[mode]}. Select ${choices.join(" or ")} in Access to continue.`
    : `${name} has no supported access mode. Select another provider.`;
}
