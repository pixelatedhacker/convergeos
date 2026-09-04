import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ANTIGRAVITY_CLI_DEFAULT_MODEL,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeAntigravityCliAdapter } from "./AntigravityCliAdapter.ts";

const isRuntimeEvent = Schema.is(ProviderRuntimeEvent);

const fixtureSource = String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const user = JSON.parse(input.trim());
  const prompt = user.message.content;
  const resumeAt = args.indexOf('--conversation');
  const id = resumeAt < 0 ? 'native-conversation' : args[resumeAt + 1];
  fs.appendFileSync(process.env.AGY_TEST_LOG, JSON.stringify({args, input: user, cwd: process.cwd(), pid: process.pid}) + '\n');
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
  if (prompt === 'early-error') {
    emit({event:'result',result:{conversation_id:'',status:'ERROR',response:'',error:'Authentication required'}});
    return;
  }
  emit({event:'init',conversation_id: prompt === 'mismatch' ? 'wrong-conversation' : id,init:{cwd:process.cwd(),permission_mode:'always-proceed'}});
  if (prompt === 'malformed') { process.stdout.write('bad json\n'); return; }
  if (prompt === 'no-result') return;
  if (prompt === 'hang') {
    process.on('SIGINT', () => {
      fs.appendFileSync(process.env.AGY_TEST_SIGNAL, String(process.pid) + '\n');
      emit({event:'result',result:{conversation_id:id,status:'INTERRUPTED',response:''}});
      process.exit(0);
    });
    setInterval(() => {}, 10000);
    return;
  }
  const step = (index, type, state, data = {}) => ({event:'step_update',step_update:{conversation_id:id,step_index:index,state,step_type:type,...data}});
  const tokens = {input_tokens:10,output_tokens:3,thinking_tokens:1,cache_read_tokens:2,total_tokens:13};
  emit(step(0,'system_message','DONE'));
  if (prompt !== 'result-only') {
    emit(step(1,'agent_response','ACTIVE',{text_delta:'hello '}));
    emit(step(1,'agent_response','DONE',{text_delta:'world',usage:tokens}));
    emit(step(1,'agent_response','DONE',{text_delta:'world',usage:tokens}));
    emit(step(2,'tool','DONE',{tool_name:'run_command',tool_info:{name:'run_command',parameters:{CommandLine:'pwd'},output:process.cwd()}}));
    emit(step(3,'checkpoint','DONE',{usage:{input_tokens:1,output_tokens:1,total_tokens:2}}));
  }
  emit({event:'result',result:{conversation_id:id,status:prompt === 'native-error' ? 'ERROR' : 'SUCCESS',response:'hello world',usage:{input_tokens:1000,output_tokens:300,total_tokens:1300},...(prompt === 'native-error' ? {error:'Model failed'} : {})}});
  if (prompt === 'nonzero') process.exitCode = 7;
  if (prompt === 'duplicate-result') emit({event:'result',result:{conversation_id:id,status:'SUCCESS',response:'duplicate'}});
});
`;

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-adapter-test-" });
  const binaryPath = path.join(cwd, "agy-test");
  const logPath = path.join(cwd, "commands.ndjson");
  const signalPath = path.join(cwd, "signals.txt");
  yield* fs.writeFileString(binaryPath, `#!${process.execPath}\n${fixtureSource}`, { mode: 0o755 });
  const instanceId = ProviderInstanceId.make("agy-test");
  const adapter = yield* makeAntigravityCliAdapter(
    { enabled: true, binaryPath },
    {
      instanceId,
      environment: { ...process.env, AGY_TEST_LOG: logPath, AGY_TEST_SIGNAL: signalPath },
    },
  );
  const observed: ProviderRuntimeEvent[] = [];
  const completions =
    yield* Queue.unbounded<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
  yield* adapter.streamEvents.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        expect(isRuntimeEvent(event)).toBe(true);
        observed.push(event);
        if (event.type === "turn.completed") yield* Queue.offer(completions, event);
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  const threadId = ThreadId.make("thread-1");
  const start = (runtimeMode: RuntimeMode = "full-access") =>
    adapter.startSession({ threadId, cwd, providerInstanceId: instanceId, runtimeMode });
  return {
    fs,
    path,
    cwd,
    logPath,
    signalPath,
    instanceId,
    adapter,
    observed,
    completions,
    threadId,
    start,
  };
});

const decodeLog = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      args: Schema.Array(Schema.String),
      input: Schema.Struct({
        event: Schema.Literal("user"),
        message: Schema.Struct({ content: Schema.String }),
      }),
      cwd: Schema.String,
      pid: Schema.Number,
    }),
  ),
);

describe.skipIf(HostProcessPlatform.defaultValue() === "win32")(
  "Antigravity CLI spawned adapter",
  () => {
    it.effect("publishes the old ready state before a completion-triggered follow-up starts", () =>
      Effect.gen(function* () {
        const { start, adapter, observed, threadId } = yield* fixture;
        yield* start();
        const followup = yield* Deferred.make<TurnId>();
        let launched = false;
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.type !== "turn.completed" || launched) return;
              launched = true;
              const next = yield* adapter.sendTurn({ threadId, input: "hang" });
              yield* Deferred.succeed(followup, next.turnId);
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* adapter.sendTurn({ threadId, input: "first" });
        const nextId = yield* Deferred.await(followup);
        const readyIndex = observed.findIndex(
          (event) => event.type === "session.state.changed" && event.payload.state === "ready",
        );
        const nextIndex = observed.findIndex(
          (event) => event.type === "turn.started" && event.turnId === nextId,
        );
        expect(readyIndex).toBeGreaterThanOrEqual(0);
        expect(nextIndex).toBeGreaterThan(readyIndex);
        expect(
          observed
            .slice(nextIndex)
            .some(
              (event) => event.type === "session.state.changed" && event.payload.state === "ready",
            ),
        ).toBe(false);
        expect((yield* adapter.listSessions())[0]?.status).toBe("running");
        yield* adapter.interruptTurn(threadId, nextId);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.effect("concurrent stops share one drain and preserve a replacement started on exit", () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const killEntered = yield* Deferred.make<void>();
        const releaseKill = yield* Deferred.make<void>();
        let killCount = 0;
        const { start, adapter, observed, threadId } = yield* fixture.pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
            ...spawner,
            spawn: (command) =>
              spawner.spawn(command).pipe(
                Effect.map((child) => ({
                  ...child,
                  kill: (options) =>
                    Effect.gen(function* () {
                      killCount++;
                      yield* Deferred.succeed(killEntered, undefined);
                      yield* Deferred.await(releaseKill);
                      yield* child.kill(options);
                    }),
                })),
              ),
          }),
        );
        yield* start();
        yield* adapter.sendTurn({ threadId, input: "hang" });
        const replacementStarted = yield* Deferred.make<void>();
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.type !== "session.exited" || (yield* Deferred.isDone(replacementStarted)))
                return;
              yield* start();
              yield* Deferred.succeed(replacementStarted, undefined);
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        const firstStop = yield* adapter
          .stopSession(threadId)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(killEntered);
        const secondStop = yield* adapter
          .stopSession(threadId)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        expect(killCount).toBe(1);
        yield* Deferred.succeed(releaseKill, undefined);
        yield* Fiber.join(firstStop);
        yield* Fiber.join(secondStop);
        yield* Deferred.await(replacementStarted);
        expect(yield* adapter.hasSession(threadId)).toBe(true);
        expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
        expect(observed.filter((event) => event.type === "session.exited")).toHaveLength(1);
        expect(killCount).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.effect(
      "streams text and tools, resumes explicitly, and reports only current step usage",
      () =>
        Effect.gen(function* () {
          const { start, adapter, observed, completions, threadId, instanceId, fs, logPath, cwd } =
            yield* fixture;
          yield* start();
          const first = yield* adapter.sendTurn({
            threadId,
            input: "first",
            modelSelection: { instanceId, model: ANTIGRAVITY_CLI_DEFAULT_MODEL },
          });
          const firstCompleted = yield* Queue.take(completions);
          expect(firstCompleted.payload.state).toBe("completed");
          expect(firstCompleted.payload.usage).toEqual({
            inputTokens: 11,
            outputTokens: 4,
            totalTokens: 15,
            reasoningOutputTokens: 1,
            cachedInputTokens: 2,
          });
          expect(
            observed
              .filter((event) => event.type === "content.delta")
              .map((event) => event.payload.delta)
              .join(""),
          ).toBe("hello world");
          expect(
            observed.filter(
              (event) =>
                event.type === "item.completed" && event.payload.itemType === "command_execution",
            ),
          ).toHaveLength(1);
          expect(observed.filter((event) => event.type === "item.started")).toHaveLength(2);
          expect(observed.some((event) => event.type === "thread.token-usage.updated")).toBe(false);
          yield* adapter.stopSession(threadId);
          const cursor = first.resumeCursor;
          yield* adapter.startSession({
            threadId,
            cwd,
            providerInstanceId: instanceId,
            runtimeMode: "full-access",
            resumeCursor: cursor,
          });
          yield* adapter.sendTurn({
            threadId,
            input: "second",
            modelSelection: { instanceId, model: "model-b" },
          });
          const secondCompleted = yield* Queue.take(completions);
          expect(secondCompleted.payload.usage).toEqual(firstCompleted.payload.usage);
          const commands = (yield* fs.readFileString(logPath))
            .trim()
            .split("\n")
            .map((line) => decodeLog(line));
          expect(commands[0]?.args).not.toContain("--model");
          expect(commands[0]?.args).toContain("--dangerously-skip-permissions");
          expect(commands[1]?.args).toEqual(
            expect.arrayContaining(["--conversation", "native-conversation", "--model", "model-b"]),
          );
          expect(commands[1]?.args).not.toContain("--effort");
          expect(commands[1]?.args).not.toContain("--continue");
          expect(commands[1]?.input.message.content).toBe("second");
          expect(commands[0]?.pid).not.toBe(commands[1]?.pid);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.effect("cancels only its tracked child, drains completion, and resumes afterward", () =>
      Effect.gen(function* () {
        const {
          start,
          adapter,
          observed,
          completions,
          threadId,
          fs,
          signalPath,
          logPath,
          cwd,
          instanceId,
        } = yield* fixture;
        yield* start();
        const turn = yield* adapter.sendTurn({ threadId, input: "hang" });
        const steer = yield* adapter
          .sendTurn({ threadId, input: "cannot steer" })
          .pipe(Effect.exit);
        expect(Exit.isFailure(steer)).toBe(true);
        yield* adapter.interruptTurn(threadId, TurnId.make("other-turn"));
        expect(observed.filter((event) => event.type === "turn.completed")).toHaveLength(0);
        const otherThread = ThreadId.make("thread-2");
        yield* adapter.startSession({
          threadId: otherThread,
          cwd,
          providerInstanceId: instanceId,
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: otherThread, input: "hang" });
        yield* adapter.interruptTurn(threadId, turn.turnId);
        const completed = yield* Queue.take(completions);
        expect(completed.turnId).toBe(turn.turnId);
        expect(completed.payload.state).toBe("interrupted");
        expect(
          (yield* adapter.listSessions()).find((session) => session.threadId === otherThread)
            ?.status,
        ).toBe("running");
        const commands = (yield* fs.readFileString(logPath))
          .trim()
          .split("\n")
          .map((line) => decodeLog(line));
        expect((yield* fs.readFileString(signalPath)).trim()).toBe(String(commands[0]?.pid));
        yield* adapter.sendTurn({ threadId, input: "after cancel" });
        expect((yield* Queue.take(completions)).payload.state).toBe("completed");
        yield* adapter.stopSession(otherThread);
        expect(
          observed.filter(
            (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
          ),
        ).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    for (const prompt of [
      "nonzero",
      "no-result",
      "malformed",
      "native-error",
      "duplicate-result",
    ]) {
      it.effect(`settles ${prompt} as one failure without stranding the turn`, () =>
        Effect.gen(function* () {
          const { start, adapter, observed, completions, threadId } = yield* fixture;
          yield* start();
          yield* adapter.sendTurn({ threadId, input: prompt }).pipe(Effect.ignore);
          expect((yield* Queue.take(completions)).payload.state).toBe("failed");
          expect(observed.filter((event) => event.type === "turn.completed")).toHaveLength(1);
          expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
    }

    it.effect("reports pre-init errors and result-only answers", () =>
      Effect.gen(function* () {
        const { start, adapter, observed, completions, threadId } = yield* fixture;
        yield* start();
        expect(
          Exit.isFailure(
            yield* adapter
              .sendTurn({
                threadId,
                input: "image",
                attachments: [
                  {
                    type: "image",
                    id: "image-1",
                    name: "image.png",
                    mimeType: "image/png",
                    sizeBytes: 1,
                  },
                ],
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* adapter.sendTurn({ threadId, input: "early-error" }).pipe(Effect.exit),
          ),
        ).toBe(true);
        expect((yield* Queue.take(completions)).payload.errorMessage).toContain(
          "Authentication required",
        );
        yield* adapter.sendTurn({ threadId, input: "result-only" });
        expect((yield* Queue.take(completions)).payload.usage).toBeUndefined();
        expect(
          observed
            .filter((event) => event.type === "content.delta")
            .map((event) => event.payload.delta)
            .join(""),
        ).toBe("hello world");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.effect(
      "rejects incompatible modes, cwd, cursors, images, plans, and model options before spawn",
      () =>
        Effect.gen(function* () {
          const { start, adapter, threadId, instanceId, cwd, fs, logPath } = yield* fixture;
          for (const mode of ["approval-required", "auto-accept-edits", "auto"] as const)
            expect(Exit.isFailure(yield* start(mode).pipe(Effect.exit))).toBe(true);
          expect(
            Exit.isFailure(
              yield* adapter
                .startSession({ threadId, cwd: "relative", runtimeMode: "full-access" })
                .pipe(Effect.exit),
            ),
          ).toBe(true);
          expect(
            Exit.isFailure(
              yield* adapter
                .startSession({
                  threadId,
                  cwd,
                  runtimeMode: "full-access",
                  resumeCursor: { driver: "other", conversationId: "native-conversation" },
                })
                .pipe(Effect.exit),
            ),
          ).toBe(true);
          expect(
            Exit.isFailure(
              yield* adapter
                .startSession({
                  threadId,
                  cwd,
                  runtimeMode: "full-access",
                  resumeCursor: {
                    driver: "antigravityCli",
                    schemaVersion: 1,
                    conversationId: "native-conversation",
                    cwd,
                    instanceId: "someone-else",
                  },
                })
                .pipe(Effect.exit),
            ),
          ).toBe(true);
          yield* start();
          expect(
            Exit.isFailure(
              yield* adapter
                .sendTurn({ threadId, input: "plan", interactionMode: "plan" })
                .pipe(Effect.exit),
            ),
          ).toBe(true);
          expect(
            Exit.isFailure(
              yield* adapter
                .sendTurn({
                  threadId,
                  input: "bad effort",
                  modelSelection: {
                    instanceId,
                    model: "model",
                    options: [{ id: "effort", value: "max" }],
                  },
                })
                .pipe(Effect.exit),
            ),
          ).toBe(true);
          expect(
            Exit.isFailure(
              yield* adapter
                .sendTurn({
                  threadId,
                  input: "wrong model instance",
                  modelSelection: { instanceId: ProviderInstanceId.make("other"), model: "model" },
                })
                .pipe(Effect.exit),
            ),
          ).toBe(true);
          expect(yield* fs.exists(logPath)).toBe(false);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  },
);
