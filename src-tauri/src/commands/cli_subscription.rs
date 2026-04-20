//! Claude CLI subscription path (Phase 5a, scope §5/§7).
//!
//! This module owns three Tauri surfaces:
//!
//! 1. **`detect_claude`** — probes the user's `PATH` for the `claude`
//!    binary and runs `claude --version` with a short timeout. Called
//!    on Anthropic card mount to pick between the four card states.
//! 2. **`set_auth_mode_cmd`** — writes the chosen `AuthMode` to
//!    `configured_providers[provider]`, persists settings, and
//!    invalidates the pool. No keyring interaction.
//! 3. **`clear_auth_mode_cmd`** — demotes to `AuthMode::None` without
//!    touching the stored API key. Symmetric with `set_auth_mode_cmd`.
//!
//! # Why a separate module
//!
//! Phase 4 `api_keys.rs` is keyring-only. The CLI subscription path is
//! deliberately keyring-free — auth flows through the `claude` binary's
//! own token store under `~/.claude/`. Keeping the two split prevents
//! accidentally coupling keyring side-effects to auth-mode flips.
//!
//! # Test Connection
//!
//! The renderer reuses `detect_claude` as the "test connection" action
//! for CLI subscription mode — running `claude --version` is a zero-token
//! probe. A real `claude -p "ok"` query would burn the user's Pro quota
//! on every click (scope §5.3). Do **not** add a query-based probe here
//! without an ADR revision.

use std::time::Duration;
use tauri::State;
use tokio::process::Command;
use tokio::time::timeout;

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

/// PATH lookup without pulling in the `which` crate. The `PATH` is the
/// standard OS env var (Windows `Path`/`PATH` both resolve), split by
/// `:` on POSIX and `;` on Windows. We stop at the first hit that's a
/// file (not necessarily executable — the `--version` probe that
/// follows would fail for a non-exec hit, producing the "ambiguous"
/// path so the UI can surface it).
fn resolve_on_path(name: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        // Windows executable extensions. On POSIX this is a cheap no-op.
        #[cfg(windows)]
        {
            for ext in ["exe", "cmd", "bat"] {
                let with_ext = candidate.with_extension(ext);
                if with_ext.is_file() {
                    return Some(with_ext);
                }
            }
        }
    }
    None
}

/// Timeout for `claude --version`. Generous because on first run the
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

/// Tauri command: detect the Claude CLI.
///
/// Safe to call on every Settings open — no side effects, no keyring.
/// The renderer also reuses this as the "Test Connection" action for
/// CLI subscription mode (same probe, different copy).
#[tauri::command]
pub async fn detect_claude() -> ClaudeDetection {
    let Some(bin) = resolve_on_path("claude") else {
        return ClaudeDetection::not_found();
    };
    probe_version(&bin).await
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
    async fn detect_claude_missing_binary_returns_not_found() {
        // Point PATH at a directory that can't contain claude.
        let guard = EnvGuard::new("PATH", Some("/var/empty"));
        let result = detect_claude().await;
        assert!(!result.found);
        assert!(result.path.is_none());
        assert!(result.error.is_none(), "absent ≠ ambiguous: {result:?}");
        drop(guard);
    }

    #[tokio::test]
    async fn resolve_on_path_skips_nonexistent_entries() {
        let guard = EnvGuard::new("PATH", Some("/nonexistent-a:/nonexistent-b"));
        assert!(resolve_on_path("sh").is_none());
        drop(guard);
    }

    // ── env mutation helper ───────────────────────────────────────────
    //
    // set_var / remove_var aren't thread-safe under Rust's aliasing
    // rules but this test module serializes via #[tokio::test] on a
    // single-threaded runtime by default. Using the same mutex-guarded
    // approach as api_keys.rs would force all detection tests onto one
    // lock, which isn't needed here — the PATH tests only mutate during
    // the `detect_claude_missing_binary_returns_not_found` and
    // `resolve_on_path_skips_nonexistent_entries` cases and restore on
    // drop. The `probe_version_*` tests don't touch env.

    static ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct EnvGuard {
        key: String,
        prev: Option<String>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl EnvGuard {
        fn new(key: &str, value: Option<&str>) -> Self {
            let lock = ENV_MUTEX.lock().unwrap();
            let prev = std::env::var(key).ok();
            match value {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
            Self {
                key: key.to_string(),
                prev,
                _lock: lock,
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match self.prev.take() {
                Some(v) => std::env::set_var(&self.key, v),
                None => std::env::remove_var(&self.key),
            }
        }
    }
}
