import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, RuntimeMode, ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  getProviderRuntimeModeBlockReason,
  supportsProviderRuntimeMode,
} from "./providerRuntimeModes.ts";

const fullAccessOnly = {
  driver: ProviderDriverKind.make("fullAccessOnly"),
  displayName: "Full-access provider",
  supportedRuntimeModes: ["full-access"],
} satisfies Pick<ServerProvider, "driver" | "displayName" | "supportedRuntimeModes">;

describe("provider runtime mode availability", () => {
  it("preserves legacy behavior when the snapshot omits a capability", () => {
    for (const mode of RuntimeMode.literals) {
      expect(supportsProviderRuntimeMode({ driver: ProviderDriverKind.make("codex") }, mode)).toBe(
        true,
      );
      expect(getProviderRuntimeModeBlockReason(undefined, mode)).toBeNull();
    }
  });

  it("blocks every restricted selection without changing it or choosing Full access", () => {
    for (const mode of ["approval-required", "auto-accept-edits", "auto"] satisfies RuntimeMode[]) {
      expect(supportsProviderRuntimeMode(fullAccessOnly, mode)).toBe(false);
      expect(getProviderRuntimeModeBlockReason(fullAccessOnly, mode)).toContain(
        "Select Full access in Access",
      );
    }
    expect(getProviderRuntimeModeBlockReason(fullAccessOnly, "full-access")).toBeNull();
    expect(fullAccessOnly.supportedRuntimeModes).toEqual(["full-access"]);
  });

  it("does not treat an explicitly empty capability as unrestricted", () => {
    expect(
      supportsProviderRuntimeMode({ ...fullAccessOnly, supportedRuntimeModes: [] }, "full-access"),
    ).toBe(false);
    expect(
      getProviderRuntimeModeBlockReason(
        { ...fullAccessOnly, supportedRuntimeModes: [] },
        "full-access",
      ),
    ).toContain("Select another provider");
  });

  it("validates the wire capability instead of accepting unknown permission modes", () => {
    const decode = Schema.decodeUnknownSync(ServerProvider.fields.supportedRuntimeModes);
    expect(decode(["full-access"])).toEqual(["full-access"]);
    expect(() => decode(["always-proceed"])).toThrow();
  });
});
