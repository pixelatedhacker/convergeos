import {
  type MeshKeyId,
  type AgentLivenessObservation,
  type MeshReceipt,
  MeshKeyId as MeshKeyIdSchema,
} from "@t3tools/contracts";
import { schnorr } from "@noble/curves/secp256k1";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { LIVENESS_KIND, LIVENESS_TAG, LIVENESS_MAX_BYTES, NostrLivenessEvent } from "./liveness.ts";
import { MESH_RECEIPT_SIGNING_KEY_SECRET } from "./MeshReceiptConfig.ts";
import {
  MAX_NOSTR_EVENT_BYTES,
  MESH_NOSTR_EVENT_KIND,
  encodeMeshReceiptContent,
  meshTagsFor,
  nostrEventByteLength,
  signNostrEvent,
  type NostrEvent,
} from "./nostr.ts";

const decodeLivenessEvent = Schema.decodeUnknownSync(NostrLivenessEvent);

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export interface MeshSignedReceipt {
  readonly receipt: MeshReceipt;
  readonly event: NostrEvent;
  /** The exact JSON text to persist and resend byte-for-byte on retries. */
  readonly eventJson: string;
}

export type MeshSignedReceiptResult =
  | { readonly _tag: "Signed"; readonly signed: MeshSignedReceipt }
  | { readonly _tag: "Oversize"; readonly byteLength: number };

/**
 * Signs mesh receipts with the environment-owned key. The signature means
 * "this environment recorded this event for this agent" — it does not claim
 * the agent holds an independent key or that any external action succeeded.
 *
 * The private key lives only in server secret storage, never in provider
 * prompts, MCP arguments, or clients. The event's Nostr `created_at` is
 * derived from the receipt's signed `recordedAt`, so retries resend the same
 * timestamp and signature.
 */
export class MeshReceiptSigner extends Context.Service<
  MeshReceiptSigner,
  {
    readonly signLivenessSync: (
      observation: AgentLivenessObservation,
    ) => typeof NostrLivenessEvent.Type | null;
    readonly publicKeyHex: string;
    readonly keyId: MeshKeyId;
    readonly signReceiptSync: (receipt: MeshReceipt) => MeshSignedReceiptResult;
  }
>()("t3/mesh/MeshReceiptSigner") {}

const acquireValidSigningKey = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const isValidKey = (bytes: Uint8Array): boolean => {
    try {
      schnorr.getPublicKey(bytes);
      return true;
    } catch {
      return false;
    }
  };

  const existing = yield* secrets.get(MESH_RECEIPT_SIGNING_KEY_SECRET);
  if (existing._tag === "Some" && isValidKey(existing.value)) {
    return existing.value;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const generated = yield* crypto.randomBytes(32);
    if (!isValidKey(generated)) continue;
    yield* secrets.set(MESH_RECEIPT_SIGNING_KEY_SECRET, generated);
    return generated;
  }
  return yield* Effect.die("Failed to generate a valid secp256k1 signing key");
});

export const make = Effect.gen(function* () {
  const secretKey = yield* acquireValidSigningKey;
  const publicKeyHex = bytesToHex(schnorr.getPublicKey(secretKey));
  const keyId = MeshKeyIdSchema.make(`mk_${publicKeyHex.slice(0, 16)}`);

  const signReceiptSync: MeshReceiptSigner["Service"]["signReceiptSync"] = (receipt) => {
    const content = encodeMeshReceiptContent(receipt);
    const params = {
      pubkey: publicKeyHex,
      // NIP-01 created_at is whole seconds; deriving it from the signed
      // recordedAt keeps resends byte-identical.
      created_at: Math.floor(Date.parse(receipt.recordedAt) / 1_000),
      kind: MESH_NOSTR_EVENT_KIND,
      tags: meshTagsFor(receipt.previousEventId),
      content,
    };
    const event = signNostrEvent(params, secretKey);
    const byteLength = nostrEventByteLength(event);
    if (byteLength > MAX_NOSTR_EVENT_BYTES) {
      // Receipt payloads are bounded upstream, so this is a loud bug rather
      // than a truncation trigger. Identity fields are never cut to fit.
      return { _tag: "Oversize", byteLength };
    }
    return {
      _tag: "Signed",
      signed: { receipt, event, eventJson: JSON.stringify(event) },
    };
  };

  const signLivenessSync = (observation: AgentLivenessObservation) => {
    const event = signNostrEvent(
      {
        pubkey: publicKeyHex,
        created_at: Math.floor(Date.parse(observation.observedAt) / 1_000),
        kind: LIVENESS_KIND,
        tags: [
          ["t", LIVENESS_TAG],
          ["d", observation.delegationId],
          ["expiration", String(Math.floor(Date.parse(observation.expiresAt) / 1_000))],
        ],
        content: JSON.stringify(observation),
      },
      secretKey,
    );
    return nostrEventByteLength(event) <= LIVENESS_MAX_BYTES ? decodeLivenessEvent(event) : null;
  };
  return MeshReceiptSigner.of({ publicKeyHex, keyId, signReceiptSync, signLivenessSync });
});

export const layer = Layer.effect(MeshReceiptSigner, make);
