import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { queuedProviderInputBlockReason } from "./thread-outbox-model";

const cli = {
  driver: ProviderDriverKind.make("antigravityCli"),
  displayName: "Antigravity CLI",
  supportedRuntimeModes: ["full-access"],
} satisfies Pick<ServerProvider, "driver" | "displayName" | "supportedRuntimeModes">;

describe("queued provider input validation", () => {
  it("rejects offline images when the delivery provider becomes Antigravity CLI", () => {
    const input = {
      runtimeMode: "full-access",
      attachments: [{ type: "image" }],
      threadBusy: false,
    } as const;
    expect(queuedProviderInputBlockReason({ ...input, provider: undefined })).toBeNull();
    expect(queuedProviderInputBlockReason({ ...input, provider: cli })).toContain(
      "Remove image attachments",
    );
    expect(input.attachments).toEqual([{ type: "image" }]);
  });

  it("rechecks the current provider after an upload that began under another driver", () => {
    const input = {
      runtimeMode: "full-access",
      attachments: [{ type: "file" }, { type: "image" }],
      threadBusy: false,
    } as const;
    expect(
      queuedProviderInputBlockReason({
        ...input,
        provider: { driver: ProviderDriverKind.make("antigravity") },
      }),
    ).toBeNull();
    expect(queuedProviderInputBlockReason({ ...input, provider: cli })).toContain(
      "Remove image attachments",
    );
  });

  it("preserves support for text and file references", () => {
    for (const attachments of [[], [{ type: "file" }]] as const) {
      expect(
        queuedProviderInputBlockReason({
          provider: cli,
          runtimeMode: "full-access",
          attachments,
          threadBusy: false,
        }),
      ).toBeNull();
    }
  });

  it("restores busy CLI input instead of submitting unsupported steering", () => {
    expect(
      queuedProviderInputBlockReason({
        provider: cli,
        runtimeMode: "full-access",
        attachments: [],
        threadBusy: true,
      }),
    ).toContain("then send your draft");
    expect(
      queuedProviderInputBlockReason({
        provider: { driver: ProviderDriverKind.make("codex") },
        runtimeMode: "full-access",
        attachments: [],
        threadBusy: true,
      }),
    ).toBeNull();
  });

  it("still rejects a saved unsupported access mode before delivering", () => {
    expect(
      queuedProviderInputBlockReason({
        provider: cli,
        runtimeMode: "approval-required",
        attachments: [],
        threadBusy: false,
      }),
    ).toContain("Select Full access");
  });

  it("reports image removal for mixed input on a busy CLI thread", () => {
    expect(
      queuedProviderInputBlockReason({
        provider: cli,
        runtimeMode: "full-access",
        attachments: [{ type: "file" }, { type: "image" }],
        threadBusy: true,
      }),
    ).toContain("Remove image attachments");
  });

  it("keeps the explicit access selection when both images and busy state are invalid", () => {
    expect(
      queuedProviderInputBlockReason({
        provider: cli,
        runtimeMode: "approval-required",
        attachments: [{ type: "image" }],
        threadBusy: true,
      }),
    ).toContain("Select Full access");
  });
});
