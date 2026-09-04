import {
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export function mapAcpToAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (isAcpProcessExitedError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }
  if (isAcpRequestError(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: error.message,
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  });
}

export function acpPermissionOutcome(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    default:
      return "reject-once";
  }
}

/**
 * Resolve a T3 approval decision to the opaque option id offered by an ACP
 * agent. ACP standardizes option kinds, not ids; returning a synthesized id
 * would make the UI appear to approve a choice the provider never offered.
 */
export function selectAcpPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): string | undefined {
  if (decision === "cancel") return undefined;
  const preferredKind: EffectAcpSchema.PermissionOption["kind"] =
    decision === "accept" ? "allow_once" : decision === "decline" ? "reject_once" : "allow_always";
  const preferred = request.options.find((option) => option.kind === preferredKind);
  const preferredId = preferred?.optionId.trim();
  if (preferredId) return preferredId;

  // A thread-scoped approval may safely degrade to a one-shot approval, but
  // never in the other direction. This keeps providers without allow_always
  // usable without granting more authority than the user selected.
  if (decision === "acceptForSession") {
    const once = request.options.find((option) => option.kind === "allow_once");
    const onceId = once?.optionId.trim();
    if (onceId) return onceId;
  }
  return undefined;
}
