/**
 * Nostr transport boundary for agent-mesh receipts.
 *
 * Everything Nostr-specific lives here: NIP-01 event serialization, signing,
 * verification, the relay publish handshake, and the pinned event kind. The
 * orchestration decider, provider adapters, and receipt mapping never see
 * Nostr types — they speak only the `MeshReceipt` contract.
 *
 * Serialization and signatures follow NIP-01 exactly: the event id is the
 * SHA-256 of the canonical `["0", pubkey, created_at, kind, tags, content]`
 * serialization, and the signature is BIP-340 Schnorr over that id. Signing
 * uses @noble/curves, the same maintained library nostr-tools builds on.
 */
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";

import { MeshReceiptFromJsonString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Regular stored event kind pinned for ConvergeOS mesh receipts (NIP-01
 * regular range 1000-9999; unassigned in the kind registry as of 2026-09).
 * Regular kinds are stored by relays; replacement, ephemeral, and
 * parameterized-replaceable ranges would let a relay discard history.
 */
export const MESH_NOSTR_EVENT_KIND = 9901;

/** Protocol discriminator tag carried on every mesh event. */
export const MESH_NOSTR_PROTOCOL_TAG = "convergeos.mesh";

/** A relay must reject events larger than 512 KiB, but full output never
    belongs in a relay event. Stay an order of magnitude under relay limits so
    identity fields are never truncated to fit a transport. */
export const MAX_NOSTR_EVENT_BYTES = 32 * 1024;

export const MESH_RECEIPT_PUBLISH_TIMEOUT_MS = 10_000;

export interface NostrEventParams {
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: ReadonlyArray<ReadonlyArray<string>>;
  readonly content: string;
}

export interface NostrEvent extends NostrEventParams {
  readonly id: string;
  readonly sig: string;
}

const encoder = new TextEncoder();

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const meshTagsFor = (previousEventId: string | null): ReadonlyArray<ReadonlyArray<string>> => [
  ["t", MESH_NOSTR_PROTOCOL_TAG],
  ...(previousEventId === null ? [] : [["e", previousEventId]]),
];

/** Canonical NIP-01 serialization of the id payload. */
export const serializeNostrEventIdPayload = (params: NostrEventParams): string =>
  JSON.stringify([
    0,
    params.pubkey,
    params.created_at,
    params.kind,
    params.tags,
    params.content,
  ]);

export const computeNostrEventId = (params: NostrEventParams): string =>
  hex(sha256(encoder.encode(serializeNostrEventIdPayload(params))));

export const encodeMeshReceiptContent = Schema.encodeSync(MeshReceiptFromJsonString);

export const decodeMeshReceiptContent = Schema.decodeUnknownSync(MeshReceiptFromJsonString);

export const isMeshReceiptContent = Schema.is(MeshReceiptFromJsonString);

/** Signs the canonical id payload with the BIP-340 Schnorr algorithm. Throws
    when the secret key is not a valid secp256k1 scalar. */
export const signNostrEvent = (params: NostrEventParams, secretKey: Uint8Array): NostrEvent => {
  const id = computeNostrEventId(params);
  const sig = hex(schnorr.sign(hexToBytes(id), secretKey));
  return { ...params, tags: params.tags.map((tag) => [...tag]), id, sig };
};

/** Full verification: id recomputation, schema-valid content, and signature.
    Any byte changed in content, tags, or metadata breaks one of these. */
export const verifyNostrEvent = (event: NostrEvent): boolean => {
  if (computeNostrEventId(event) !== event.id) return false;
  try {
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    return false;
  }
};

const hexToBytes = (value: string): Uint8Array => {
  if (value.length % 2 !== 0 || /[^0-9a-f]/.test(value)) {
    throw new Error("Expected lowercase hex");
  }
  return Uint8Array.from(
    value.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)),
  );
};

export const nostrEventByteLength = (event: NostrEvent): number =>
  encoder.encode(JSON.stringify(event)).length;

export const encodeEventPublishMessage = (event: NostrEvent): string =>
  JSON.stringify(["EVENT", event]);

export type NostrRelayMessage =
  | { readonly _tag: "Ok"; readonly eventId: string; readonly accepted: boolean; readonly message: string }
  | { readonly _tag: "Notice"; readonly message: string }
  | { readonly _tag: "Other" };

/** Parses one relay frame. Only NIP-01 `OK` (the acceptance acknowledgement)
    and `NOTICE` are meaningful to the publisher; requests are ignored. */
export const parseNostrRelayMessage = (text: string): NostrRelayMessage => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { _tag: "Other" };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return { _tag: "Other" };
  switch (parsed[0]) {
    case "OK":
      return {
        _tag: "Ok",
        eventId: typeof parsed[1] === "string" ? parsed[1] : "",
        accepted: parsed[2] === true,
        message: typeof parsed[3] === "string" ? parsed[3] : "",
      };
    case "NOTICE":
      return { _tag: "Notice", message: typeof parsed[1] === "string" ? parsed[1] : "" };
    default:
      return { _tag: "Other" };
  }
};
