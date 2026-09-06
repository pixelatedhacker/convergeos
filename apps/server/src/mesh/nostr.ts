import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";

import { MeshReceiptFromJsonString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

/**
 * Regular stored event kind pinned for ConvergeOS mesh receipts (NIP-01
 * regular range 1000-9999; unassigned in the kind registry as of 2026-09).
 * Regular kinds are stored by relays; replacement, ephemeral, and
 * parameterized-replaceable ranges would let a relay discard history.
 */
export const MESH_NOSTR_EVENT_KIND = 9901;

/** Protocol discriminator tag carried on every mesh event. */
export const MESH_NOSTR_PROTOCOL_TAG = "convergeos.mesh";

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

export const meshTagsFor = (
  previousEventId: string | null,
): ReadonlyArray<ReadonlyArray<string>> => [
  ["t", MESH_NOSTR_PROTOCOL_TAG],
  ...(previousEventId === null ? [] : [["e", previousEventId]]),
];

/** Canonical NIP-01 serialization of the id payload. */
export const serializeNostrEventIdPayload = (params: NostrEventParams): string =>
  JSON.stringify([0, params.pubkey, params.created_at, params.kind, params.tags, params.content]);

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
  return Uint8Array.from(value.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));
};

export const nostrEventByteLength = (event: NostrEvent): number =>
  encoder.encode(JSON.stringify(event)).length;

export const encodeEventPublishMessage = (event: NostrEvent): string =>
  JSON.stringify(["EVENT", event]);

export type NostrRelayMessage =
  | {
      readonly _tag: "Ok";
      readonly eventId: string;
      readonly accepted: boolean;
      readonly message: string;
    }
  | { readonly _tag: "Notice"; readonly message: string }
  | { readonly _tag: "Other" };

const decodeRelayFrame = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Tuple([Schema.Literal("OK"), Schema.String, Schema.Boolean, Schema.String]),
      Schema.Tuple([Schema.Literal("NOTICE"), Schema.String]),
    ]),
  ),
);

/** Parses validated acknowledgements and notices; other frames are ignored. */
export const parseNostrRelayMessage = (text: string): NostrRelayMessage => {
  const decoded = decodeRelayFrame(text);
  if (Option.isNone(decoded)) return { _tag: "Other" };
  const frame = decoded.value;
  switch (frame[0]) {
    case "OK":
      return { _tag: "Ok", eventId: frame[1], accepted: frame[2], message: frame[3] };
    case "NOTICE":
      return { _tag: "Notice", message: frame[1] };
  }
};
