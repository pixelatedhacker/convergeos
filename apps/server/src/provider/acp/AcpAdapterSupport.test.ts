import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  acpPermissionOutcome,
  mapAcpToAdapterError,
  selectAcpPermissionOptionId,
} from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("maps ACP approval decisions to permission outcomes", () => {
    expect(acpPermissionOutcome("accept")).toBe("allow-once");
    expect(acpPermissionOutcome("acceptForSession")).toBe("allow-always");
    expect(acpPermissionOutcome("decline")).toBe("reject-once");
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });

  it("uses the provider's opaque permission option ids", () => {
    const request = {
      sessionId: "session-1",
      toolCall: { toolCallId: "tool-1", title: "Run command" },
      options: [
        { optionId: "yes:this-time", name: "Allow", kind: "allow_once" as const },
        { optionId: "yes:this-thread", name: "Always", kind: "allow_always" as const },
        { optionId: "nope", name: "Deny", kind: "reject_once" as const },
      ],
    };

    expect(selectAcpPermissionOptionId(request, "accept")).toBe("yes:this-time");
    expect(selectAcpPermissionOptionId(request, "acceptForSession")).toBe("yes:this-thread");
    expect(selectAcpPermissionOptionId(request, "decline")).toBe("nope");
    expect(selectAcpPermissionOptionId(request, "cancel")).toBeUndefined();
  });

  it("only downgrades thread approval to a one-shot option", () => {
    const request = {
      sessionId: "session-1",
      toolCall: { toolCallId: "tool-1", title: "Run command" },
      options: [
        { optionId: "once", name: "Allow", kind: "allow_once" as const },
        { optionId: "forever", name: "Always", kind: "allow_always" as const },
      ],
    };

    expect(selectAcpPermissionOptionId(request, "acceptForSession")).toBe("forever");
    expect(
      selectAcpPermissionOptionId(
        { ...request, options: request.options.slice(0, 1) },
        "acceptForSession",
      ),
    ).toBe("once");
    expect(selectAcpPermissionOptionId(request, "decline")).toBeUndefined();
    expect(selectAcpPermissionOptionId(request, "acceptAlways")).toBe("forever");
  });
});
