#!/usr/bin/env node

/**
 * Ensure the bundled Goose sidecar binary exists for the host (or specified)
 * Rust target triple. Called by scripts/tauri-build.mjs before `tauri build`,
 * and usable standalone via `node scripts/ensure-goose-sidecar.mjs`.
 *
 * Reads the pinned version from scripts/goose-version.json, downloads the
 * matching release asset from GitHub (block/goose), extracts the `goose`
 * binary into src-tauri/binaries/goose-<triple>[.exe], ad-hoc codesigns on
 * macOS, and caches archives under scripts/.cache/goose/<version>/.
 *
 * See docs/goose-integration-notes.md for rationale.
 */

import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const versionFile = join(__dirname, "goose-version.json");
const cacheDir = join(__dirname, ".cache", "goose");
const binariesDir = join(projectRoot, "src-tauri", "binaries");

function detectHostTriple() {
  if (process.env.GOOSE_TARGET_TRIPLE) return process.env.GOOSE_TARGET_TRIPLE;
  try {
    const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
    const match = out.match(/^host:\s*(.+)$/m);
    if (match) return match[1].trim();
  } catch {}
  const p = platform();
  const a = arch();
  if (p === "darwin" && a === "arm64") return "aarch64-apple-darwin";
  if (p === "darwin" && a === "x64") return "x86_64-apple-darwin";
  if (p === "win32" && a === "x64") return "x86_64-pc-windows-msvc";
  if (p === "linux" && a === "x64") return "x86_64-unknown-linux-gnu";
  if (p === "linux" && a === "arm64") return "aarch64-unknown-linux-gnu";
  throw new Error(`Unsupported host: ${p}/${a}`);
}

function loadVersion() {
  const raw = readFileSync(versionFile, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed.version || !parsed.assets) {
    throw new Error("goose-version.json missing required fields");
  }
  return parsed;
}

function sha256OfFile(path) {
  const h = createHash("sha256");
  h.update(readFileSync(path));
  return h.digest("hex");
}

async function downloadRelease(version, assetName, destPath) {
  mkdirSync(dirname(destPath), { recursive: true });
  const url = `https://github.com/block/goose/releases/download/${version}/${assetName}`;
  console.log(`  ↓ ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const reader = res.body.getReader();
  const stream = createWriteStream(destPath);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!stream.write(value)) {
        await new Promise((r) => stream.once("drain", r));
      }
    }
  } finally {
    stream.end();
    await new Promise((r) => stream.once("close", r));
  }
}

function extractArchive(archivePath, workDir) {
  mkdirSync(workDir, { recursive: true });
  if (archivePath.endsWith(".tar.bz2")) {
    execFileSync("tar", ["-xjf", archivePath, "-C", workDir], { stdio: "inherit" });
  } else if (archivePath.endsWith(".tar.gz")) {
    execFileSync("tar", ["-xzf", archivePath, "-C", workDir], { stdio: "inherit" });
  } else if (archivePath.endsWith(".zip")) {
    if (platform() === "win32") {
      execFileSync(
        "powershell",
        ["-NoProfile", "-Command", `Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${workDir}'`],
        { stdio: "inherit" },
      );
    } else {
      execFileSync("unzip", ["-o", archivePath, "-d", workDir], { stdio: "inherit" });
    }
  } else {
    throw new Error(`Unsupported archive format: ${archivePath}`);
  }
}

function findBinary(workDir, triple) {
  const binaryName = triple.endsWith("windows-msvc") ? "goose.exe" : "goose";

  // Direct path (flat archive)
  const direct = join(workDir, binaryName);
  if (existsSync(direct)) return direct;

  // Walk up to 2 levels deep for nested archives (e.g. goose-<triple>/goose)
  const walk = (dir, depth) => {
    if (depth < 0) return null;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isFile() && entry.name === binaryName) {
        return full;
      }
      if (entry.isDirectory()) {
        const nested = walk(full, depth - 1);
        if (nested) return nested;
      }
    }
    return null;
  };
  const found = walk(workDir, 2);
  if (found) return found;

  throw new Error(`goose binary not found after extraction in ${workDir}`);
}

function adhocCodesignMacOS(path) {
  if (platform() !== "darwin") return;
  try {
    execFileSync("codesign", ["--force", "--sign", "-", "--options", "runtime", path], {
      stdio: "inherit",
    });
  } catch (err) {
    console.warn(`⚠️  codesign failed on ${path}: ${err.message}`);
    console.warn("   Continuing — production signing happens at the outer .app level.");
  }
}

export async function ensureGooseSidecar({ triple } = {}) {
  const { version, assets } = loadVersion();
  const target = triple ?? detectHostTriple();
  if (target === "universal-apple-darwin") {
    return ensureGooseUniversalSidecar();
  }
  const assetName = assets[target];
  if (!assetName) {
    throw new Error(`No release asset mapped for target triple ${target} in goose-version.json`);
  }

  const isWindows = target.endsWith("windows-msvc");
  const outName = isWindows ? `goose-${target}.exe` : `goose-${target}`;
  const outPath = join(binariesDir, outName);

  if (existsSync(outPath)) {
    const size = statSync(outPath).size;
    console.log(`✓ Goose sidecar already present: ${outName} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    return outPath;
  }

  console.log(`\n📦 Preparing Goose sidecar ${version} for ${target}`);

  const cacheVersionDir = join(cacheDir, version);
  mkdirSync(cacheVersionDir, { recursive: true });
  const archivePath = join(cacheVersionDir, assetName);

  if (!existsSync(archivePath)) {
    await downloadRelease(version, assetName, archivePath);
  } else {
    console.log(`  ✓ cached archive: ${assetName}`);
  }

  const workDir = join(cacheVersionDir, `extract-${target}`);
  rmSync(workDir, { recursive: true, force: true });
  extractArchive(archivePath, workDir);
  const binaryInArchive = findBinary(workDir, target);

  mkdirSync(binariesDir, { recursive: true });
  copyFileSync(binaryInArchive, outPath);
  if (!isWindows) chmodSync(outPath, 0o755);

  adhocCodesignMacOS(outPath);

  const sha = sha256OfFile(outPath);
  const size = statSync(outPath).size;
  console.log(`✓ Installed ${outName} (${(size / 1024 / 1024).toFixed(1)} MB, sha256 ${sha.slice(0, 12)}…)`);
  return outPath;
}

export async function ensureGooseUniversalSidecar() {
  const target = "universal-apple-darwin";
  const outName = `goose-${target}`;
  const outPath = join(binariesDir, outName);

  if (existsSync(outPath)) {
    const size = statSync(outPath).size;
    console.log(`✓ Goose sidecar already present: ${outName} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    return outPath;
  }

  if (platform() !== "darwin") {
    throw new Error("universal-apple-darwin sidecar can only be created on macOS with lipo");
  }

  const armPath = await ensureGooseSidecar({ triple: "aarch64-apple-darwin" });
  const intelPath = await ensureGooseSidecar({ triple: "x86_64-apple-darwin" });

  console.log(`\n📦 Preparing Goose universal sidecar for ${target}`);
  mkdirSync(binariesDir, { recursive: true });
  execFileSync("lipo", ["-create", armPath, intelPath, "-output", outPath], {
    stdio: "inherit",
  });
  chmodSync(outPath, 0o755);
  adhocCodesignMacOS(outPath);

  const sha = sha256OfFile(outPath);
  const size = statSync(outPath).size;
  console.log(`✓ Installed ${outName} (${(size / 1024 / 1024).toFixed(1)} MB, sha256 ${sha.slice(0, 12)}…)`);
  return outPath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const tripleArg = process.argv[2];
  ensureGooseSidecar({ triple: tripleArg }).catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
