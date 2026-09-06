import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";

/**
 * Configuration for outbound agent-mesh receipt export.
 *
 * Export is disabled until both secrets exist. Credentials stay server-owned:
 * the relay URL and key material never reach provider prompts, MCP arguments,
 * or clients, which only see the derived descriptor capability.
 */
export const MESH_RECEIPT_EXPORT_ENABLED_SECRET = "mesh-receipt-export-enabled";
export const MESH_RECEIPT_RELAY_URL_SECRET = "mesh-receipt-relay-url";
export const MESH_RECEIPT_QUOTA_BYTES_SECRET = "mesh-receipt-quota-bytes";

export const MESH_RECEIPT_SIGNING_KEY_SECRET = "mesh-receipt-signing-key";

/** Backlog ceiling for unpublished signed events. At capacity, capture pauses
    with its source cursor intact and local execution continues unblocked. */
export const DEFAULT_MESH_RECEIPT_OUTBOX_QUOTA_BYTES = 8 * 1024 * 1024;

export interface MeshReceiptExportConfig {
  readonly enabled: boolean;
  readonly relayUrl: string | null;
  readonly quotaBytes: number;
}

export const isMeshReceiptExportEnabledValue = (value: string | null): boolean =>
  value === "true";

const readSecretString = (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  name: string,
): Effect.Effect<string | null> =>
  secrets.get(name).pipe(
    Effect.map((bytes) => (Option.isSome(bytes) ? new TextDecoder().decode(bytes.value) : null)),
    Effect.catch(() => Effect.succeed(null)),
  );

export const readMeshReceiptExportConfig = (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
): Effect.Effect<MeshReceiptExportConfig> =>
  Effect.gen(function* () {
    const [enabledRaw, relayUrl, quotaRaw] = yield* Effect.all([
      readSecretString(secrets, MESH_RECEIPT_EXPORT_ENABLED_SECRET),
      readSecretString(secrets, MESH_RECEIPT_RELAY_URL_SECRET),
      readSecretString(secrets, MESH_RECEIPT_QUOTA_BYTES_SECRET),
    ]);
    const parsedQuota = quotaRaw === null ? Number.NaN : Number.parseInt(quotaRaw, 10);
    const quotaBytes =
      Number.isFinite(parsedQuota) && parsedQuota > 0
        ? parsedQuota
        : DEFAULT_MESH_RECEIPT_OUTBOX_QUOTA_BYTES;
    const normalizedRelayUrl = relayUrl?.trim() || null;
    return {
      enabled: isMeshReceiptExportEnabledValue(enabledRaw) && normalizedRelayUrl !== null,
      relayUrl: normalizedRelayUrl,
      quotaBytes,
    };
  });
