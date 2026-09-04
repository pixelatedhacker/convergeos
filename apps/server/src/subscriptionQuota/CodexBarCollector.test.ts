import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { vi } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as CodexBarCollector from "./CodexBarCollector.ts";

const run = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>();
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const collect = Effect.gen(function* () {
  const service = yield* CodexBarCollector.make.pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, ProcessRunner.ProcessRunner.of({ run })),
  );
  return yield* service.collect;
});

it.effect("runs the redacted dashboard command and normalizes partial provider results", () =>
  Effect.gen(function* () {
    run.mockReturnValueOnce(
      Effect.succeed({
        stdout: encodeJson({
          schemaVersion: 1,
          generatedAt: "2026-09-03T21:33:16Z",
          staleAfterSeconds: 180,
          providers: [
            {
              id: "codex",
              name: "Codex",
              enabled: true,
              source: "oauth",
              status: null,
              identity: { accountEmail: "j***@example.com", plan: "Plus" },
              windows: [
                {
                  kind: "session",
                  label: "5-hour",
                  usedPercent: 25,
                  remainingPercent: 75,
                  resetAt: "2026-09-04T02:00:00Z",
                },
              ],
              credits: { remaining: 12.5, currency: "USD" },
              error: null,
              updatedAt: "2026-09-03T21:33:00Z",
            },
            {
              id: "claude",
              name: "Claude",
              enabled: true,
              source: "auto",
              status: null,
              identity: null,
              windows: [],
              credits: null,
              error: "credential for secret@example.com failed",
              updatedAt: "2026-09-03T21:33:00Z",
            },
          ],
        }),
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }),
    );

    const result = yield* collect;

    expect(run).toHaveBeenCalledWith({
      command: "codexbar",
      args: ["dashboard", "--identity", "redacted"],
      timeout: "30 seconds",
      maxOutputBytes: 2 * 1024 * 1024,
    });
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(
        result.snapshot.subjects.map(({ provider, status }) => ({ provider, status })),
      ).toEqual([
        { provider: "codex", status: "fresh" },
        { provider: "claudeAgent", status: "failed" },
      ]);
      expect(result.snapshot.subjects[1]?.warning?.message).not.toContain("secret@example.com");
      expect(result.snapshot.subjects[0]?.credits).toEqual({ remaining: 12.5, currency: "USD" });
    }
  }),
);

it.effect("reports invalid or unsupported JSON without returning raw output", () =>
  Effect.gen(function* () {
    run.mockReturnValueOnce(
      Effect.succeed({
        stdout: '{"schemaVersion":2,"credential":"secret"}',
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }),
    );

    const result = yield* collect;
    expect(result._tag).toBe("Failure");
    expect(result.collector.message).not.toContain("secret");
  }),
);

it.effect("treats an unspawnable optional collector as missing", () =>
  Effect.gen(function* () {
    run.mockImplementationOnce((input) =>
      Effect.fail(
        new ProcessRunner.ProcessSpawnError({
          command: input.command,
          argumentCount: input.args.length,
          cause: { code: "ENOENT" },
        }),
      ),
    );

    const result = yield* collect;
    expect(result._tag).toBe("Failure");
    expect(result.collector.status).toBe("missing");
  }),
);
