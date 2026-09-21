#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { BRAND_ASSET_PATHS, DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./lib/brand-assets.ts";
import { encodePngIco, readPngDimensions, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const source = NodePath.join(root, "assets/convergeos/app-icon.png");
const check = process.argv.includes("--check");
const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "convergeos-icons-"));
const renditions = new Map<number, Buffer>();
const stale: string[] = [];

function render(size: number) {
  const cached = renditions.get(size);
  if (cached) return cached;
  const output = NodePath.join(temporary, `${size}.png`);
  NodeChildProcess.execFileSync("sips", ["-z", String(size), String(size), source, "--out", output], {
    stdio: "pipe",
  });
  const contents = NodeFS.readFileSync(output);
  const dimensions = readPngDimensions(contents);
  if (dimensions.width !== size || dimensions.height !== size) {
    throw new Error(`Invalid icon dimensions for ${size}px rendition`);
  }
  renditions.set(size, contents);
  return contents;
}

function save(path: string, contents: Buffer) {
  const target = NodePath.join(root, path);
  if (check) {
    if (!NodeFS.readFileSync(target).equals(contents)) stale.push(path);
  } else {
    NodeFS.writeFileSync(target, contents);
  }
}

try {
  const ico = encodePngIco(WINDOWS_ICON_SIZES.map((size) => ({ size, contents: render(size) })));
  for (const [key, path] of Object.entries(BRAND_ASSET_PATHS)) {
    if (path.endsWith(".ico")) save(path, ico);
    if (path.endsWith(".png")) {
      const size = key.includes("Favicon16")
        ? 16
        : key.includes("Favicon32")
          ? 32
          : key.includes("AppleTouch")
            ? 180
            : 1024;
      save(path, render(size));
    }
  }
  for (const override of DEVELOPMENT_PUBLIC_ICON_OVERRIDES) {
    save(override.targetRelativePath, NodeFS.readFileSync(NodePath.join(root, override.sourceRelativePath)));
  }
  if (stale.length > 0) throw new Error(`Stale ConvergeOS icons:\n${stale.join("\n")}`);
  process.stdout.write(check ? "ConvergeOS icons are current.\n" : "ConvergeOS icons exported.\n");
} finally {
  NodeFS.rmSync(temporary, { recursive: true, force: true });
}
