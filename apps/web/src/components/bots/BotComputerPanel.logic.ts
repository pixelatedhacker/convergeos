import type { BotComputerState } from "@t3tools/contracts";

export type BotComputerPrimaryAction = "start" | "resume" | "retry" | null;

export function botComputerDisplayState(
  queryState: BotComputerState | null,
  mutationState: BotComputerState | null,
): BotComputerState | null {
  return mutationState?.status === "failed" ? mutationState : queryState;
}

export function botComputerPrimaryAction(state: BotComputerState | null): BotComputerPrimaryAction {
  if (state === null) return null;
  if (state.status === "absent") return "start";
  if (state.status === "suspended") return "resume";
  if (state.status === "failed") return "retry";
  return null;
}

export function botComputerStatusLabel(state: BotComputerState | null): string {
  if (state === null) return "Checking";
  switch (state.status) {
    case "absent":
      return "Not created";
    case "failed":
      return "Needs attention";
    case "running":
      return "Running";
    case "suspended":
      return "Suspended";
    case "unavailable":
      return "Unavailable";
  }
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

export function legacyBotComputerViewerUrl(input: {
  readonly environmentHttpBaseUrl: string | null;
  readonly viewerUrl: string;
  readonly viewerPort: number;
}): string | null {
  if (input.environmentHttpBaseUrl === null) return null;
  try {
    const environment = new URL(input.environmentHttpBaseUrl);
    const viewer = new URL(input.viewerUrl);
    const environmentIsLoopback = isLoopbackHostname(environment.hostname.toLowerCase());
    const viewerIsLoopback = isLoopbackHostname(viewer.hostname.toLowerCase());
    return environmentIsLoopback &&
      viewerIsLoopback &&
      viewer.protocol === "http:" &&
      Number(viewer.port) === input.viewerPort &&
      viewer.pathname === "/vnc.html" &&
      viewer.origin !== environment.origin
      ? viewer.toString()
      : null;
  } catch {
    return null;
  }
}
