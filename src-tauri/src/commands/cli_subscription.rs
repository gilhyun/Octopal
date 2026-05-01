//! CLI subscription path — both Phase 5a (Anthropic via `claude-code`)
//! and 5a-finalize (OpenAI via `chatgpt-codex`).
//!
//! This module owns these Tauri surfaces:
//!
//! 1. **`detect_binary`** (5a-finalize §3.2) — probes for any
//!    whitelisted CLI tool by name + runs `--version`. Driven by
//!    providers.json `authMethods[].detectBinary` so each provider
//!    card can probe its own tool (`claude`, `codex`, …).
//! 2. **`detect_claude`** — back-compat alias for `detect_binary("claude")`.
//!    Kept so existing renderer call sites and 5a tests keep working.
//! 3. **`set_auth_mode_cmd`** — writes the chosen `AuthMode` to
//!    `configured_providers[provider]`, persists settings, and
//!    invalidates the pool. No keyring interaction.
//! 4. **`clear_auth_mode_cmd`** — demotes to `AuthMode::None` without
//!    touching the stored API key. Symmetric with `set_auth_mode_cmd`.
//! 5. **`get_auth_mode_cmd`** — read current mode, used after card
//!    flips for in-memory state refresh.
//!
//! # Why a separate module
//!
//! Phase 4 `api_keys.rs` is keyring-only. The CLI subscription path is
//! deliberately keyring-free — auth flows through the spawned binary's
//! own token store (claude → `~/.claude/`, codex → `~/.codex/`).
//! Keeping the two split prevents accidentally coupling keyring side-
//! effects to auth-mode flips.
//!
//! # Test Connection
//!
//! The renderer reuses `detect_binary` as the "test connection" action
//! for CLI subscription mode — running `<tool> --version` is a zero-token
//! probe. A real `<tool> -p "ok"` query would burn the user's Pro quota
//! on every click (scope §5.3). Do **not** add a query-based probe here
//! without an ADR revision.

use std::time::Duration;
use tauri::State;
use tokio::process::Command;
use tokio::time::timeout;

use crate::commands::binary_discovery::{discover_binary, is_valid_binary_name};
use crate::state::{AuthMode, ManagedState};

/// Result of a `claude` binary probe.
///
/// Semantics:
/// - `found = true`: `claude` resolved on PATH **and** `--version`
///   returned a zero exit. `path` and `version` are both populated.
/// - `found = false` + `path = Some(_)`: binary exists but `--version`
///   failed (timeout, non-zero, non-UTF-8 output). `error` explains.
///   UI renders the "we found it but couldn't verify" branch.
/// - `found = false` + `path = None`: not on PATH. Card shows the
///   "install the Claude CLI" state.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ClaudeDetection {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

impl ClaudeDetection {
    fn not_found() -> Self {
        Self {
            found: false,
            path: None,
            version: None,
            error: None,
        }
    }

    fn ambiguous(path: String, err: String) -> Self {
        Self {
            found: false,
            path: Some(path),
            version: None,
            error: Some(err),
        }
    }

    fn ok(path: String, version: String) -> Self {
        Self {
            found: true,
            path: Some(path),
            version: Some(version),
            error: None,
        }
    }
}

/// Timeout for `<binary> --version`. Generous because on first run the
/// binary may be doing a self-update check; short enough that a hung
/// binary doesn't block the Settings tab indefinitely.
const VERSION_TIMEOUT_SECS: u64 = 10;

/// Run `claude --version` against the path we resolved. Splits into
/// its own function so tests can call it with a known-good binary
/// (e.g. `echo`) without touching the user's real claude install.
async fn probe_version(bin: &std::path::Path) -> ClaudeDetection {
    let path_str = bin.display().to_string();
    let mut cmd = Command::new(bin);
    cmd.arg("--version");
    // Inherit the parent PATH so `claude` can find its own helpers.
    // No XDG manipulation — we want the user's real environment.
    match timeout(Duration::from_secs(VERSION_TIMEOUT_SECS), cmd.output()).await {
        Ok(Ok(out)) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let version = if stdout.is_empty() {
                // Some builds print to stderr. Accept either.
                String::from_utf8_lossy(&out.stderr).trim().to_string()
            } else {
                stdout
            };
            if version.is_empty() {
                ClaudeDetection::ambiguous(path_str, "empty --version output".into())
            } else {
                ClaudeDetection::ok(path_str, version)
            }
        }
        Ok(Ok(out)) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let code = out.status.code().unwrap_or(-1);
            ClaudeDetection::ambiguous(path_str, format!("exit {code}: {stderr}"))
        }
        Ok(Err(e)) => ClaudeDetection::ambiguous(path_str, format!("spawn: {e}")),
        Err(_) => ClaudeDetection::ambiguous(
            path_str,
            format!("--version timed out after {VERSION_TIMEOUT_SECS}s"),
        ),
    }
}

/// Tauri command: detect any whitelisted CLI tool.
///
/// Phase 5a-finalize §3.2 generalization of `detect_claude`. The
/// renderer dispatches based on `providers.json::authMethods[].detectBinary`
/// — Anthropic's card calls `detect_binary("claude")`, OpenAI's calls
/// `detect_binary("codex")`, future providers extend the manifest
/// without code changes here.
///
/// Safety contract:
/// - `name` is validated by [`is_valid_binary_name`] (alphanumeric +
///   `_`/`-`, length ≤ 64). Invalid names short-circuit to `not_found`
///   rather than erroring; the UI just shows "binary missing" copy.
/// - Discovery uses [`discover_binary`] which scans parent PATH plus
///   known install dirs (nvm, asdf, homebrew, ~/.local/bin, ~/.cargo/bin).
///   Solves the macOS LaunchServices PATH gap that 5a Commit C-3
///   manual verification surfaced (scope §1.1).
/// - Then runs `<bin> --version` with [`VERSION_TIMEOUT_SECS`] timeout.
///   Zero tokens consumed; never invokes `<bin>` with model-query args.
#[tauri::command]
pub async fn detect_binary(name: String) -> ClaudeDetection {
    // Validation barrier first (defense in depth — discover_binary
    // also validates, but rejecting at the command boundary lets us
    // log "renderer asked for invalid name" if we ever add audit
    // logging without burying it inside the helper).
    if !is_valid_binary_name(&name) {
        return ClaudeDetection::not_found();
    }
    let Some(bin) = discover_binary(&name) else {
        return ClaudeDetection::not_found();
    };
    probe_version(&bin).await
}

/// Back-compat shim for `detect_binary("claude")`. Kept so:
/// - 5a renderer code (`window.api.detectClaude()`) keeps working
///   without churn during the 5a-finalize transition
/// - 5a tests in this module continue to exercise the same surface
///
/// New renderer code should call `detect_binary` directly with the
/// `detectBinary` value from providers.json.
#[tauri::command]
pub async fn detect_claude() -> ClaudeDetection {
    detect_binary("claude".to_string()).await
}

/// Write the auth mode for a provider, persist settings, and invalidate
/// the pool. Mirrors the pool-invalidation discipline of
/// `save_api_key_cmd` / `delete_api_key_cmd` (scope §4.4) — any change
/// to how a provider authenticates must evict live sidecars so the next
/// send spawns fresh under the new mode.
///
/// Does NOT touch the keyring. Callers wanting to also clear a stored
/// key should call `delete_api_key_cmd` separately. Rationale: a user
/// who flips Anthropic to CLI subscription may still want to flip back
/// later without re-entering their API key.
#[tauri::command]
pub async fn set_auth_mode_cmd(
    provider: String,
    mode: AuthMode,
    state: State<'_, ManagedState>,
) -> Result<(), String> {
    {
        let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
        settings
            .providers
            .configured_providers
            .insert(provider.clone(), mode);
    }
    state.save_settings()?;

    let evicted = state.goose_acp_pool.invalidate_pool_for_provider(&provider);
    let evicted_count = evicted.len();
    for entry in evicted {
        entry.client.shutdown().await;
    }
    if evicted_count > 0 {
        eprintln!(
            "[cli_subscription] set_auth_mode({provider}, {mode:?}) → {evicted_count} sidecars evicted"
        );
    }

    Ok(())
}

/// Convenience for the UI's "back out" button — equivalent to
/// `set_auth_mode_cmd(provider, AuthMode::None)`. Kept as a separate
/// command so renderer call sites read intentionally
/// (`clearAuthMode('anthropic')` vs `setAuthMode('anthropic', 'none')`).
#[tauri::command]
pub async fn clear_auth_mode_cmd(
    provider: String,
    state: State<'_, ManagedState>,
) -> Result<(), String> {
    set_auth_mode_cmd(provider, AuthMode::None, state).await
}

/// Read the current auth mode for a provider. Used by the Anthropic
/// card after a save/flip to refresh its UI without an out-of-band
/// settings reload round-trip. Returns `AuthMode::None` if the
/// provider has no entry in `configured_providers` — matches the
/// default Phase 3+4 pre-configured shape.
#[tauri::command]
pub fn get_auth_mode_cmd(
    provider: String,
    state: State<'_, ManagedState>,
) -> Result<AuthMode, String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    Ok(settings
        .providers
        .configured_providers
        .get(&provider)
        .copied()
        .unwrap_or(AuthMode::None))
}

#[cfg(test)]
mod tests {
    //! Detection is I/O-heavy. Tests exercise the tokenization /
    //! timeout logic against controllable binaries (`echo`, `sleep`)
    //! instead of the real `claude` install, so CI doesn't depend on
    //! the host having the CLI.

    use super::*;

    /// Hardcoded POSIX path — avoids resolve_on_path, which would race
    /// with the PATH-mutating tests in this module under parallel
    /// execution. Skips on Windows where `/bin/echo` doesn't exist.
    fn posix_bin(name: &str) -> Option<std::path::PathBuf> {
        if cfg!(windows) {
            return None;
        }
        let p = std::path::PathBuf::from(format!("/bin/{name}"));
        if p.is_file() {
            return Some(p);
        }
        let p = std::path::PathBuf::from(format!("/usr/bin/{name}"));
        if p.is_file() {
            return Some(p);
        }
        None
    }

    #[tokio::test]
    async fn probe_version_parses_stdout_from_echo() {
        // `echo --version` prints "--version" to stdout and exits 0.
        // Good enough to exercise the success branch.
        let Some(echo) = posix_bin("echo") else {
            return;
        };
        let result = probe_version(&echo).await;
        assert!(result.found, "got: {result:?}");
        assert!(result.version.unwrap().contains("--version"));
    }

    #[tokio::test]
    async fn probe_version_reports_missing_binary_path() {
        // Non-existent path triggers the spawn-failure branch.
        let fake = std::path::PathBuf::from("/definitely/not/a/real/path/claude-xyz");
        let result = probe_version(&fake).await;
        assert!(!result.found);
        assert!(result.error.is_some(), "should carry a spawn error");
    }

    #[tokio::test]
    async fn probe_version_reports_nonzero_exit() {
        // `false` on POSIX always exits non-zero. Treat that as ambiguous.
        let Some(false_bin) = posix_bin("false") else {
            return;
        };
        let result = probe_version(&false_bin).await;
        assert!(!result.found);
        let err = result.error.unwrap();
        assert!(err.starts_with("exit "), "got: {err}");
    }

    #[tokio::test]
    async fn detect_binary_missing_returns_not_found() {
        // Use a synthetic name no nvm/asdf/homebrew dir could possibly
        // contain. We can't just point PATH at /var/empty anymore — D-2
        // discovery augments with known install dirs (nvm etc.) so a
        // CI box with claude installed via nvm would find it even
        // under a stripped PATH. Synthetic name removes that race.
        let result = detect_binary("octopal-definitely-absent-zzz".to_string()).await;
        assert!(!result.found);
        assert!(result.path.is_none());
        assert!(result.error.is_none(), "absent ≠ ambiguous: {result:?}");
    }

    #[tokio::test]
    async fn detect_binary_rejects_invalid_name_as_not_found() {
        // Validation barrier: path traversal / shell metacharacters all
        // short-circuit to not_found rather than reaching discover_binary.
        // This is defense-in-depth; discover_binary also validates, but
        // catching at the command boundary keeps audit traces clean.
        for bad in ["../claude", "/usr/bin/sh", "claude;rm -rf /", ""] {
            let result = detect_binary(bad.to_string()).await;
            assert!(
                !result.found,
                "bad name {bad:?} must short-circuit to not_found",
            );
            assert!(result.path.is_none());
        }
    }

    #[tokio::test]
    async fn detect_claude_alias_resolves_to_detect_binary_claude() {
        // Back-compat: detect_claude() must produce equivalent output
        // to detect_binary("claude"). Both call sites in 5a renderer
        // code rely on this — D-2 swapped the implementation but kept
        // the contract.
        let from_alias = detect_claude().await;
        let from_generic = detect_binary("claude".to_string()).await;
        assert_eq!(from_alias.found, from_generic.found);
        assert_eq!(from_alias.path, from_generic.path);
        // version + error may legitimately differ across two
        // back-to-back invocations if the binary is doing self-update
        // probes — but `found` and `path` are deterministic.
    }

    // Env-mutation harness removed in D-2: the only tests that used
    // it (`detect_claude_missing_binary_returns_not_found`,
    // `resolve_on_path_skips_nonexistent_entries`) were replaced with
    // synthetic-name-based variants that don't need PATH manipulation.
    // `binary_discovery::tests::EnvGuard` covers the PATH-mutating
    // path tests for the underlying lookup module.
}
