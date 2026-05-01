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
