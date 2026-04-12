//! Shared helpers for locating and spawning the `claude` CLI.
//!
//! Used to be duplicated in `agent.rs` and `dispatcher.rs` with Unix-only
//! assumptions (`which`, `/usr/local/bin`, nvm layout). This module is the
//! single source of truth and handles both Unix and Windows.
//!
//! Notes on path resolution:
//!   - GUI apps on macOS inherit a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`),
//!     so we probe common install locations by hand.
//!   - On Windows we check `%APPDATA%\npm\claude.cmd` (the standard
//!     `npm install -g @anthropic-ai/claude-code` output).
//!   - `PATH` augmentation uses `std::env::{split_paths, join_paths}` so
//!     the correct platform separator is used (`:` vs `;`).

use std::path::{Path, PathBuf};
use std::process::Command;

// ── Unix resolver ──────────────────────────────────────────────────────────

#[cfg(unix)]
pub fn resolve_claude_path() -> String {
    // 1. Try bare `claude` first (works when PATH is inherited, e.g. `cargo tauri dev`)
    if let Ok(output) = Command::new("which").arg("claude").output() {
        if output.status.success() {
            let p = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !p.is_empty() {
                return p;
            }
        }
    }

    // 2. Check common install locations. nvm paths are globbed because the
    //    node version directory is not fixed.
    let home = std::env::var("HOME").unwrap_or_default();
    let mut candidates: Vec<String> = vec![
        format!("{}/.local/bin/claude", home),
        format!("{}/.npm-global/bin/claude", home),
        format!("{}/.bun/bin/claude", home),
        "/usr/local/bin/claude".to_string(),
        "/opt/homebrew/bin/claude".to_string(),
    ];
    // Scan every installed nvm node version for a `claude` symlink.
    let nvm_versions = format!("{}/.nvm/versions/node", home);
    if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
        for entry in entries.flatten() {
            let p = entry.path().join("bin/claude");
            if let Some(s) = p.to_str() {
                candidates.push(s.to_string());
            }
        }
    }
    for candidate in &candidates {
        if Path::new(candidate).exists() {
            return candidate.clone();
        }
    }

    // 3. Try to find via a login shell (picks up user's rc files)
    if let Ok(output) = Command::new("/bin/sh")
        .args(["-l", "-c", "which claude"])
        .output()
    {
        if output.status.success() {
            let p = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !p.is_empty() {
                return p;
            }
        }
    }

    // Fallback — will fail with a clear error message if it doesn't resolve.
    "claude".to_string()
}

// ── Windows resolver ───────────────────────────────────────────────────────

#[cfg(windows)]
pub fn resolve_claude_path() -> String {
    // 1. `where.exe claude` is the Windows equivalent of `which`. It prints
    //    one path per line when multiple matches exist — we take the first.
    if let Ok(output) = Command::new("where").arg("claude").output() {
        if output.status.success() {
            let s = String::from_utf8_lossy(&output.stdout);
            if let Some(first) = s.lines().next() {
                let trimmed = first.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_string();
                }
            }
        }
    }

    // 2. Probe common install locations. The most common on Windows is
    //    `%APPDATA%\npm\claude.cmd` (standard npm global install output).
    let userprofile = std::env::var("USERPROFILE").unwrap_or_default();
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let local_appdata = std::env::var("LOCALAPPDATA").unwrap_or_default();

    let mut candidates: Vec<String> = vec![
        // npm global (default target of `npm i -g @anthropic-ai/claude-code`)
        format!("{}\\npm\\claude.cmd", appdata),
        format!("{}\\npm\\claude.ps1", appdata),
        // bun on Windows
        format!("{}\\.bun\\bin\\claude.exe", userprofile),
        format!("{}\\.bun\\bin\\claude.cmd", userprofile),
        // Scoop shims
        format!("{}\\scoop\\shims\\claude.cmd", userprofile),
        format!("{}\\scoop\\shims\\claude.exe", userprofile),
        // Explicit program files install (if claude-code ever ships an MSI)
        format!("{}\\Programs\\Anthropic\\claude.exe", local_appdata),
    ];

    // nvm-windows stores node versions under `%APPDATA%\nvm\v<version>\`.
    // Scan each version directory for a `claude.cmd` shim.
    let nvm_root = format!("{}\\nvm", appdata);
    if let Ok(entries) = std::fs::read_dir(&nvm_root) {
        for entry in entries.flatten() {
            let p = entry.path().join("claude.cmd");
            if let Some(s) = p.to_str() {
                candidates.push(s.to_string());
            }
        }
    }

    for candidate in &candidates {
        if Path::new(candidate).exists() {
            return candidate.clone();
        }
    }

    "claude".to_string()
}

// ── Command builder (cross-platform) ───────────────────────────────────────

/// Build a `Command` for the `claude` CLI with PATH prepended with the
/// binary's own directory so the Node runtime used by `claude`'s shebang
/// (`#!/usr/bin/env node`) can be found even when the process has a minimal
/// PATH (macOS GUI launch, or Windows Services).
///
/// Uses `std::env::{split_paths, join_paths}` so the platform path separator
/// (`:` on Unix, `;` on Windows) is handled automatically.
pub fn claude_command() -> Command {
    let claude_bin = resolve_claude_path();
    let mut cmd = Command::new(&claude_bin);

    if let Some(bin_dir) = Path::new(&claude_bin).parent() {
        let existing = std::env::var_os("PATH");
        let mut paths: Vec<PathBuf> = vec![bin_dir.to_path_buf()];
        if let Some(existing) = existing {
            paths.extend(std::env::split_paths(&existing));
        }
        if let Ok(joined) = std::env::join_paths(&paths) {
            cmd.env("PATH", joined);
        }
    }
    cmd
}
