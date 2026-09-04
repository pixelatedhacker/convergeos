import { describe, expect, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/schema";

import { describeOhMyPiElicitation, ohMyPiApprovalOptions } from "./OhMyPiAdapter.ts";

describe("describeOhMyPiElicitation", () => {
  it("maps free-text and numeric fields without inventing choices", () => {
    const binding = describeOhMyPiElicitation({
      mode: "form",
      sessionId: "session-1",
      message: "Configure the run",
      requestedSchema: {
        type: "object",
        title: "Run options",
        required: ["label", "retries"],
        properties: {
          label: { type: "string", title: "Label" },
          retries: { type: "integer", title: "Retries", minimum: 0, maximum: 5 },
          note: { type: "string", title: "Optional note" },
        },
      },
    } satisfies EffectAcpSchema.ElicitationRequest);

    expect(binding?.questions).toEqual([
      expect.objectContaining({ id: "label", options: [], allowCustomAnswer: true }),
      expect.objectContaining({ id: "retries", options: [], allowCustomAnswer: true }),
      expect.objectContaining({ id: "note", options: [], allowCustomAnswer: true }),
    ]);
    expect(binding?.encode({ label: "nightly", retries: "3" })).toEqual({
      action: {
        action: "accept",
        content: { label: "nightly", retries: 3 },
      },
    });
    expect(binding?.encode({ label: "nightly", retries: "6" })).toBeUndefined();
  });

  it("encodes OMP's paired custom-answer field", () => {
    const binding = describeOhMyPiElicitation({
      mode: "form",
      sessionId: "session-1",
      message: "Choose a target",
      requestedSchema: {
        required: ["target"],
        properties: {
          target: {
            type: "string",
            title: "Target",
            oneOf: [
              { const: "web", title: "Web" },
              { const: "mobile", title: "Mobile" },
            ],
          },
          target__other: { type: "string", title: "Custom target" },
        },
      },
    } satisfies EffectAcpSchema.ElicitationRequest);

    expect(binding?.questions).toHaveLength(1);
    expect(binding?.questions[0]).toEqual(
      expect.objectContaining({
        id: "target",
        allowCustomAnswer: true,
        options: [
          { value: "web", label: "Web", description: "Web" },
          { value: "mobile", label: "Mobile", description: "Mobile" },
        ],
      }),
    );
    expect(binding?.encode({ target: "desktop" })).toEqual({
      action: { action: "accept", content: { target__other: "desktop" } },
    });
  });

  it("declines URL and oversized form requests", () => {
    expect(
      describeOhMyPiElicitation({
        mode: "url",
        sessionId: "session-1",
        message: "Sign in",
        elicitationId: "login-1",
        url: "https://example.com/login",
      }),
    ).toBeUndefined();

    expect(
      describeOhMyPiElicitation({
        mode: "form",
        sessionId: "session-1",
        message: "Choose",
        requestedSchema: {
          properties: {
            choice: {
              type: "string",
              enum: Array.from({ length: 101 }, (_, index) => `option-${index}`),
            },
          },
        },
      }),
    ).toBeUndefined();
  });
});

describe("ohMyPiApprovalOptions", () => {
  it("exposes decisions from option kinds, independent of native option IDs", () => {
    expect(
      ohMyPiApprovalOptions({
        sessionId: "session-1",
        toolCall: { toolCallId: "tool-1", title: "Write file" },
        options: [
          { optionId: "yes-this-time", name: "Yes", kind: "allow_once" },
          { optionId: "yes-thread", name: "Always", kind: "allow_always" },
          { optionId: "no-this-time", name: "No", kind: "reject_once" },
        ],
      }),
    ).toEqual([
      { decision: "accept", label: "Allow once" },
      { decision: "acceptForSession", label: "Allow for this thread" },
      { decision: "decline", label: "Deny" },
      { decision: "cancel", label: "Cancel" },
    ]);
  });
});
