import * as NodeCrypto from "node:crypto";

import type { BotComputerNetworkAccess, EnvironmentId, ThreadId } from "@t3tools/contracts";

export const BOT_COMPUTER_IMAGE = "convergeos/bot-computer:1";
export const BOT_COMPUTER_SPEC_VERSION = "1";

export const BOT_COMPUTER_LABEL = "com.convergeos.bot-computer";
export const BOT_COMPUTER_OWNER_LABEL = "com.convergeos.bot-computer.owner";
export const BOT_COMPUTER_SPEC_LABEL = "com.convergeos.bot-computer.spec";
export const BOT_COMPUTER_NETWORK_LABEL = "com.convergeos.bot-computer.network";

export interface BotComputerIdentity {
  readonly ownerHash: string;
  readonly containerName: string;
  readonly profileVolumeName: string;
}

function stableHash(...parts: ReadonlyArray<string>): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part)), "utf8");
    hash.update(":", "utf8");
    hash.update(part, "utf8");
  }
  return hash.digest("hex").slice(0, 24);
}

export function makeBotComputerIdentity(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): BotComputerIdentity {
  const ownerHash = stableHash(environmentId, threadId);
  return {
    ownerHash,
    containerName: `convergeos-bot-computer-${ownerHash}`,
    profileVolumeName: `convergeos-bot-profile-${ownerHash}`,
  };
}

function mountField(name: string, value: string): string {
  const field = `${name}=${value}`;
  return /[",\n\r]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

export function makeBotComputerCreateArgs(input: {
  readonly identity: BotComputerIdentity;
  readonly worktreePath: string;
  readonly networkAccess: BotComputerNetworkAccess;
}): ReadonlyArray<string> {
  return [
    "container",
    "create",
    "--name",
    input.identity.containerName,
    "--label",
    `${BOT_COMPUTER_LABEL}=1`,
    "--label",
    `${BOT_COMPUTER_OWNER_LABEL}=${input.identity.ownerHash}`,
    "--label",
    `${BOT_COMPUTER_SPEC_LABEL}=${BOT_COMPUTER_SPEC_VERSION}`,
    "--label",
    `${BOT_COMPUTER_NETWORK_LABEL}=${input.networkAccess}`,
    "--network",
    "bridge",
    "--publish",
    "127.0.0.1::6080",
    "--mount",
    `type=bind,${mountField("source", input.worktreePath)},target=/workspace`,
    "--mount",
    `type=volume,source=${input.identity.profileVolumeName},target=/home/bot/.config/chromium`,
    "--workdir",
    "/workspace",
    "--user",
    "1000:1000",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=256m,uid=1000,gid=1000,mode=1770",
    "--tmpfs",
    "/run:rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=0750",
    "--tmpfs",
    "/home/bot/.cache:rw,noexec,nosuid,size=256m,uid=1000,gid=1000,mode=0700",
    "--cpus",
    "2",
    "--memory",
    "2g",
    "--pids-limit",
    "256",
    "--shm-size",
    "512m",
    BOT_COMPUTER_IMAGE,
  ];
}

export function makeBotComputerViewerUrl(port: number): string {
  return `http://127.0.0.1:${port}/vnc.html?autoconnect=1&resize=remote`;
}
