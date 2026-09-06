import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BOT_COMPUTER_NETWORK_LABEL,
  makeBotComputerCreateArgs,
  makeBotComputerIdentity,
} from "./BotComputerSpec.ts";

describe("BotComputerSpec", () => {
  it("derives stable Docker-safe names without embedding raw identifiers", () => {
    const first = makeBotComputerIdentity(
      EnvironmentId.make("environment with spaces"),
      ThreadId.make("thread/with:unsafe.parts"),
    );
    const repeated = makeBotComputerIdentity(
      EnvironmentId.make("environment with spaces"),
      ThreadId.make("thread/with:unsafe.parts"),
    );
    const otherEnvironment = makeBotComputerIdentity(
      EnvironmentId.make("another environment"),
      ThreadId.make("thread/with:unsafe.parts"),
    );

    expect(first).toEqual(repeated);
    expect(first).not.toEqual(otherEnvironment);
    expect(first.containerName).toMatch(/^convergeos-bot-computer-[a-f0-9]{24}$/);
    expect(first.profileVolumeName).toMatch(/^convergeos-bot-profile-[a-f0-9]{24}$/);
    expect(first.containerName).not.toContain("unsafe");
  });

  it("builds a constrained outbound container with exactly the intended mounts", () => {
    const identity = makeBotComputerIdentity(
      EnvironmentId.make("environment-1"),
      ThreadId.make("thread-1"),
    );
    const args = makeBotComputerCreateArgs({
      identity,
      worktreePath: "/tmp/Bot worktree, primary",
      networkAccess: "outbound",
    });
    const mounts = args.filter((arg) => arg.startsWith("type="));

    expect(args).toContain("127.0.0.1::6080");
    expect(args).toContain("bridge");
    expect(args).toContain(`${BOT_COMPUTER_NETWORK_LABEL}=outbound`);
    expect(args).toContain("ALL");
    expect(args).toContain("no-new-privileges:true");
    expect(args).toContain("--read-only");
    expect(args).toContain("1000:1000");
    expect(args).toContain(
      "/home/bot/.cache:rw,noexec,nosuid,size=256m,uid=1000,gid=1000,mode=0700",
    );
    expect(args).toContain("2");
    expect(args).toContain("2g");
    expect(args).toContain("256");
    expect(args).toContain("512m");
    expect(mounts).toHaveLength(2);
    expect(mounts[0]).toContain('"source=/tmp/Bot worktree, primary",target=/workspace');
    expect(mounts[1]).toContain(`source=${identity.profileVolumeName}`);
    expect(args.join(" ")).not.toMatch(/docker\.sock|\.ssh|\.aws|\.config\/gcloud|--env/);
  });
});
