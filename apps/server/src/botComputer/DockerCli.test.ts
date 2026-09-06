import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vite-plus/test";

import { parseDockerContainerInspect } from "./DockerCli.ts";

describe("DockerCli inspection boundary", () => {
  it.effect("normalizes Docker inspection JSON once", () =>
    Effect.gen(function* () {
      const observation = yield* parseDockerContainerInspect(
        '{"Id":"container-id","State":{"Status":"running","Running":true,"Error":""},"Config":{"Image":"convergeos/bot-computer:1","Labels":{"com.convergeos.bot-computer":"1"}},"NetworkSettings":{"Ports":{"6080/tcp":[{"HostIp":"127.0.0.1","HostPort":"49152"}]}}}',
      );

      expect(observation).toEqual({
        id: "container-id",
        status: "running",
        running: true,
        error: "",
        image: "convergeos/bot-computer:1",
        labels: { "com.convergeos.bot-computer": "1" },
        viewerBindings: [{ hostIp: "127.0.0.1", hostPort: "49152" }],
      });
    }),
  );

  it.effect("rejects invalid JSON and unsupported shapes at the adapter boundary", () =>
    Effect.gen(function* () {
      const invalidJson = yield* Effect.flip(parseDockerContainerInspect("not json"));
      expect(invalidJson).toMatchObject({
        _tag: "DockerCliError",
        detail: "Docker returned invalid container inspection output.",
      });
      const invalidShape = yield* Effect.flip(
        parseDockerContainerInspect('{"Id":"partial"}'),
      );
      expect(invalidShape).toMatchObject({
        _tag: "DockerCliError",
        detail: "Docker returned invalid container inspection output.",
      });
    }),
  );
});
