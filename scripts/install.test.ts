// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell installer through a PTY and a gated HTTP fixture.
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

describe.skipIf(HostProcessPlatform.defaultValue() === "win32")("installer coexistence", () => {
  it("installs and reinstalls beside T3 Code without replacing its launcher or data", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "convergeos-install-"));
    const version = "1.2.3";
    const stem = `t3-${version}-${HostProcessPlatform.defaultValue()}-${HostProcessArchitecture.defaultValue()}`;
    const archiveName = `${stem}.tar.gz`;
    const binDir = NodePath.join(root, "bin");
    const t3Home = NodePath.join(root, ".t3");
    const convergeOsHome = NodePath.join(root, ".convergeos");
    await NodeFSP.mkdir(NodePath.join(root, stem));
    await NodeFSP.mkdir(binDir);
    await NodeFSP.mkdir(t3Home);
    const t3Launcher = NodePath.join(binDir, "t3");
    const t3Data = NodePath.join(t3Home, "state.sqlite");
    await NodeFSP.writeFile(t3Launcher, "existing T3 launcher");
    await NodeFSP.writeFile(t3Data, "existing T3 data");
    await NodeFSP.writeFile(
      NodePath.join(root, stem, "t3"),
      "#!/bin/sh\necho 'ConvergeOS v1.2.3'\n",
      { mode: 0o755 },
    );
    NodeChildProcess.execFileSync("tar", [
      "-czf",
      NodePath.join(root, archiveName),
      "-C",
      root,
      stem,
    ]);
    const archive = await NodeFSP.readFile(NodePath.join(root, archiveName));
    const checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
    const server = NodeHttp.createServer((request, response) => {
      response.end(
        request.url?.endsWith("/SHA256SUMS") ? `${checksum}  ${archiveName}\n` : archive,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      for (let install = 0; install < 2; install += 1) {
        const child = NodeChildProcess.spawn(
          "sh",
          [NodePath.join(import.meta.dirname, "install.sh")],
          {
            env: {
              ...process.env,
              HOME: root,
              T3CODE_HOME: t3Home,
              T3CODE_RELEASE_BASE_URL: "http://127.0.0.1:1/upstream",
              CONVERGEOS_VERSION: version,
              CONVERGEOS_INSTALL_BIN_DIR: binDir,
              CONVERGEOS_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
              CONVERGEOS_HOME: undefined,
            },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        const code = await new Promise<number | null>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", resolve);
        });
        expect(code, stderr).toBe(0);
        expect(await NodeFSP.readFile(t3Launcher, "utf8")).toBe("existing T3 launcher");
        expect(await NodeFSP.readFile(t3Data, "utf8")).toBe("existing T3 data");
        expect(await NodeFSP.readdir(t3Home)).toEqual(["state.sqlite"]);
        expect(await NodeFSP.readlink(NodePath.join(binDir, "convergeos"))).toBe(
          NodePath.join(convergeOsHome, "runtime/versions", version, "t3"),
        );
      }
      expect(
        NodeChildProcess.execFileSync(NodePath.join(binDir, "convergeos"), ["--version"], {
          encoding: "utf8",
        }).trim(),
      ).toBe("ConvergeOS v1.2.3");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

// util-linux's script gives the real installer a terminal without a browser or extra packages.
describe.skipIf(HostProcessPlatform.defaultValue() !== "linux")("installer terminal", () => {
  it.each([false, true])(
    "preserves download and install behavior (HTTP failure: %s)",
    async (fail) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-progress-"));
      const version = "1.2.3";
      const stem = `t3-${version}-linux-${HostProcessArchitecture.defaultValue()}`;
      const archiveName = `${stem}.tar.gz`;
      let resumeDownload: (() => void) | undefined;
      let sawPartialProgress = false;
      let output = "";
      await NodeFSP.mkdir(NodePath.join(root, stem));
      await NodeFSP.writeFile(NodePath.join(root, stem, "t3"), "#!/bin/sh\necho 't3 v1.2.3'\n", {
        mode: 0o755,
      });
      await NodeFSP.writeFile(
        NodePath.join(root, stem, "payload"),
        NodeCrypto.randomBytes(64 * 1024),
      );
      NodeChildProcess.execFileSync("tar", [
        "-czf",
        NodePath.join(root, archiveName),
        "-C",
        root,
        stem,
      ]);
      const archive = await NodeFSP.readFile(NodePath.join(root, archiveName));
      const checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
      const server = NodeHttp.createServer((request, response) => {
        if (request.url?.endsWith("/SHA256SUMS")) {
          response.end(`${checksum}  ${archiveName}\n`);
        } else if (fail) {
          response.writeHead(500).end();
        } else {
          response.writeHead(200, { "Content-Length": archive.length });
          resumeDownload = () => response.end(archive.subarray(Math.floor(archive.length / 2)));
          response.write(archive.subarray(0, Math.floor(archive.length / 2)));
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const installer = NodePath.resolve(import.meta.dirname, "install.sh").replaceAll(
        "'",
        "'\\''",
      );
      const child = NodeChildProcess.spawn("script", ["-qec", `sh '${installer}'`, "/dev/null"], {
        env: {
          ...process.env,
          TERM: "xterm",
          NO_COLOR: "1",
          CONVERGEOS_VERSION: version,
          CONVERGEOS_HOME: NodePath.join(root, "home"),
          CONVERGEOS_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
          CONVERGEOS_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        if (!sawPartialProgress && /\b[1-9]\d?%/.test(output)) {
          sawPartialProgress = true;
          resumeDownload?.();
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", resolve);
        });
        const versions = NodePath.join(root, "home/runtime/versions");
        if (fail) {
          expect(code).not.toBe(0);
          expect(output).toContain("500");
          expect(output).not.toContain("100%");
          expect(output).not.toContain("Installed ConvergeOS");
          expect(await NodeFSP.readdir(versions)).toEqual([]);
        } else {
          expect(code).toBe(0);
          expect(sawPartialProgress).toBe(true);
          expect(output).toContain("100%");
          expect(output).toContain("0.1 / 0.1 MB");
          expect(output).toContain("Installed ConvergeOS 1.2.3");
          expect(
            await NodeFSP.readFile(NodePath.join(versions, version, ".install-complete"), "utf8"),
          ).toBe("1.2.3\n");
          expect(
            NodeChildProcess.execFileSync(NodePath.join(root, "bin/convergeos"), ["--version"], {
              encoding: "utf8",
            }).trim(),
          ).toBe("t3 v1.2.3");
          expect(await NodeFSP.readdir(versions)).toEqual([version]);
        }
      } finally {
        if (child.exitCode === null) child.kill();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
});
