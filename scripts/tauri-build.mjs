#!/usr/bin/env node

/**
 * Conditional Tauri build script.
 *
 * `tauri.conf.json` ships with `createUpdaterArtifacts: false` as the safe
 * default — that way ANY build path (this wrapper, raw `pnpm tauri build`,
 * `cargo tauri build`, an IDE integration, …) succeeds without a signing
 * key. The wrapper only ENABLES updater artifacts when a signing key is
 * actually present:
 *
 * - If `TAURI_SIGNING_PRIVATE_KEY` is set  → wrapper passes
 *   `--config '{"bundle":{"createUpdaterArtifacts":true}}'` to override the
 *   conf-file false. Result: signed updater artifacts produced (CI / release).
 *
 * - If unset                               → wrapper does nothing extra. The
 *   conf-file false applies, no updater artifact generated, no signing
 *   step, no error. Contributors can `pnpm build` locally with zero setup.
 *
 * Uses the locally-installed `@tauri-apps/cli` (node_modules/.bin/tauri) so no
 * separate `cargo install tauri-cli` step is required. `cargo` itself still
 * needs to be reachable because Tauri shells out to it to compile the Rust app.
 *
 * Extra CLI args are forwarded to `tauri build`.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureGooseSidecar } from "./ensure-goose-sidecar.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const isWindows = platform() === "win32";
const isMac = platform() === "darwin";

/**
 * macOS-only preflight: verify Xcode "first launch" status (license
 * accepted + required components installed). After a macOS update the
 * license sometimes resets and the resulting cargo build error is a
 * wall of linker arguments with the actual cause buried near the
 * bottom:
 *
 *   You have not agreed to the Xcode license agreements.
 *   Please run 'sudo xcodebuild -license' from within a Terminal window
 *   to review and agree to the Xcode and Apple SDKs license.
 *
 * Catch this up front and surface a clear remediation instead of
 * letting a contributor scroll through cargo's linker dump trying to
 * figure out what went wrong.
 *
 * Detection: `xcodebuild -checkFirstLaunchStatus` exits 0 when the
 * license is accepted AND first-launch components are installed.
 * Non-zero (commonly 69, "service unavailable" in BSD sysexits, used
 * by xcodebuild for "first launch incomplete") signals that
 * `sudo xcodebuild -runFirstLaunch` is needed. This catches both the
 * license-not-accepted case and the missing-components case in one
 * gate — same remediation either way.
 *
 * Lighter calls like `xcrun --show-sdk-path` and `clang --version`
 * succeed even when the license isn't accepted (verified empirically
 * 2026-05-02), so they can't be used as the gate.
 */
function checkXcodeFirstLaunch() {
  if (!isMac) return;
  // Step 1: Xcode CLT itself must be installed. xcode-select -p
  // returns the developer dir if CLT or full Xcode is set up, errors
  // otherwise — this exits before xcodebuild even exists.
  try {
    execSync("xcode-select -p", { stdio: "pipe" });
  } catch (_e) {
    console.error("");
    console.error("❌ Xcode Command Line Tools are not installed.");
    console.error("");
    console.error("   Install them once, then retry the build:");
    console.error("");
    console.error("       xcode-select --install");
    console.error("");
    console.error(
      "   See https://tauri.app/start/prerequisites/ for the full macOS list."
    );
    console.error("");
    process.exit(1);
  }

  // Step 2: license + first-launch components.
  try {
    execSync("xcodebuild -checkFirstLaunchStatus", { stdio: "pipe" });
    return; // 0 = all good
  } catch (_e) {
    // xcodebuild not on PATH (CLT-only install without full Xcode).app)
    // returns ENOENT here — that's a separate failure mode and CLT-only
    // builds shouldn't need xcodebuild for Tauri's link step. Skip
    // the gate in that case rather than blocking.
    if (_e.code === "ENOENT") return;
    console.error("");
    console.error(
      "❌ Xcode setup is incomplete (license not accepted, or required components missing)."
    );
    console.error(
      "   This often happens after a macOS update — the Xcode license needs"
    );
    console.error("   to be re-accepted.");
    console.error("");
    console.error("   Run this once in a terminal, then retry the build:");
    console.error("");
    console.error("       sudo xcodebuild -runFirstLaunch");
    console.error("");
    console.error("   Or, to review the license interactively:");
    console.error("");
    console.error("       sudo xcodebuild -license");
    console.error("");
    process.exit(1);
  }
}

/**
 * Resolve a usable `cargo` binary path.
 * Falls back to the rustup toolchain dir when `~/.cargo/bin` shims are missing
 * (e.g. rustup toolchain installed but env not sourced).
 * Returns the directory that should be prepended to PATH, or null if cargo
 * is already discoverable.
 */
function resolveCargoDir() {
  // 1) Already on PATH?
  try {
    execSync(isWindows ? "where cargo" : "command -v cargo", { stdio: "ignore" });
    return null;
  } catch {
    // not on PATH, continue
  }

  // 2) Standard cargo home shim
  const cargoHome = process.env.CARGO_HOME || join(homedir(), ".cargo");
  const shimDir = join(cargoHome, "bin");
  if (existsSync(join(shimDir, isWindows ? "cargo.exe" : "cargo"))) return shimDir;

  // 3) Rustup toolchain fallback (~/.rustup/toolchains/*/bin/cargo)
  const rustupHome = process.env.RUSTUP_HOME || join(homedir(), ".rustup");
  const toolchainsDir = join(rustupHome, "toolchains");
  if (existsSync(toolchainsDir)) {
    for (const name of readdirSync(toolchainsDir)) {
      const binDir = join(toolchainsDir, name, "bin");
      if (existsSync(join(binDir, isWindows ? "cargo.exe" : "cargo"))) return binDir;
    }
  }

  console.error(
    "❌ `cargo` not found. Install Rust via https://rustup.rs, then ensure\n" +
      "   `$HOME/.cargo/bin` is on your PATH (add `. \"$HOME/.cargo/env\"` to\n" +
      "   your shell profile, or run `rustup default stable`)."
  );
  process.exit(1);
}

const tauriBin = join(
  projectRoot,
  "node_modules",
  ".bin",
  isWindows ? "tauri.cmd" : "tauri"
);

if (!existsSync(tauriBin)) {
  console.error(
    `❌ Tauri CLI not found at ${tauriBin}. Did you run \`pnpm install\` (or \`npm install\`)?`
  );
  process.exit(1);
}

// Preflight checks before any heavy work. Fail fast with a friendly
// remediation pointer rather than letting cargo wall-of-text the user.
checkXcodeFirstLaunch();

const cargoDir = resolveCargoDir();
const childEnv = { ...process.env };
if (cargoDir) {
  // Prepend cargo dir so `tauri build`'s internal `cargo` invocations succeed.
  childEnv.PATH = `${cargoDir}${delimiter}${childEnv.PATH ?? ""}`;
}

const hasSigningKey = !!process.env.TAURI_SIGNING_PRIVATE_KEY;
const extraArgs = process.argv.slice(2);

// `tauri.conf.json` ships with createUpdaterArtifacts=false (safe default).
// When the signing key IS present we override to true here so CI/release
// builds emit the signed `.tar.gz` updater artifact.
const baseArgs = ["build"];
if (hasSigningKey) {
  baseArgs.push(
    "--config",
    JSON.stringify({ bundle: { createUpdaterArtifacts: true } })
  );
}

if (hasSigningKey) {
  console.log(
    "🔑 TAURI_SIGNING_PRIVATE_KEY detected — building WITH updater artifacts (signed)"
  );
} else {
  console.log(
    "ℹ️  No TAURI_SIGNING_PRIVATE_KEY — building without updater artifacts."
  );
  console.log(
    "   The .app and .dmg are produced normally. Set the env var only when"
  );
  console.log("   producing release artifacts for the GitHub updater channel.\n");
}

// Ensure bundled Goose sidecar is present before tauri build runs.
// Host triple only — CI cross-compile jobs pass GOOSE_TARGET_TRIPLE env.
try {
  await ensureGooseSidecar();
} catch (err) {
  console.error(`❌ Failed to prepare Goose sidecar: ${err.message}`);
  process.exit(1);
}

try {
  execFileSync(tauriBin, [...baseArgs, ...extraArgs], {
    stdio: "inherit",
    env: childEnv,
    cwd: projectRoot,
  });
} catch (err) {
  process.exit(err.status ?? 1);
}
