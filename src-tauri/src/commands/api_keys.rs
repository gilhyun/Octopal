//! API-key storage via OS keyring (Phase 4, scope §3.1–3.3).
//!
//! # Storage layout
//!
//! Single keyring service, one account per provider:
//!
//! ```
//! service = "com.octopal.api_keys"
//! account = <provider_id>   // "anthropic", "openai", ...
//! secret  = <raw API key>
//! ```
//!
//! macOS Keychain groups all accounts under one service entry so "Always
//! Allow" dismisses prompts for the whole app after the first
//! interaction. Windows Credential Manager and Linux Secret Service work
//! analogously.
//!
//! # Renderer boundary
//!
//! Keys only cross the Tauri boundary in **one direction** (save).
//! - `save_api_key_cmd` — renderer → keyring write
//! - `delete_api_key_cmd` — renderer → keyring delete (idempotent)
//! - `has_api_key_cmd` — renderer ← bool (reads settings flag, NOT keyring)
//!
//! **There is intentionally no `load_api_key_cmd`.** Key reads happen
//! Rust-internal only, in `run_agent_turn` on the MISS spawn path. This
//! is ADR §D5 made concrete (see scope §3.2 "Zero Trust for Renderer").
//!
//! # Environment fallback
//!
//! `OCTOPAL_API_KEY_FALLBACK=env` opts into reading keys from env vars
//! instead of the keyring. Intended for Linux CI / headless containers
//! where no Secret Service daemon is available. Env names are
//! `OCTOPAL_KEY_<PROVIDER_UPPERCASE>` (e.g. `OCTOPAL_KEY_ANTHROPIC`).
//!
//! In fallback mode, `save_api_key` / `delete_api_key` return an error
//! instructing the user to manage env vars externally. `has_api_key`
//! consults env presence instead of the settings flag. See scope §10.3.
//!
//! # Keyring unavailability
//!
//! On Linux, if the Secret Service daemon is absent, keyring calls fail
//! at first save with a backend error. Callers surface this to the UI
//! as a blocking card state (scope §10.3). The error path stays clean —
//! we don't silently fall back to a plaintext file.

use tauri::State;

use crate::state::ManagedState;

const SERVICE: &str = "com.octopal.api_keys";
const FALLBACK_ENV_VAR: &str = "OCTOPAL_API_KEY_FALLBACK";
const FALLBACK_ENV_VAL: &str = "env";

/// Returns true if `OCTOPAL_API_KEY_FALLBACK=env` is set. Re-read per
/// call — env vars are stable per-process, and this is a cheap syscall.
fn env_fallback_active() -> bool {
    std::env::var(FALLBACK_ENV_VAR).as_deref() == Ok(FALLBACK_ENV_VAL)
}

fn env_var_name(provider: &str) -> String {
    format!("OCTOPAL_KEY_{}", provider.to_uppercase())
}

/// Look up the API key for a provider. Returns `Ok(None)` when no key
/// is stored (not an error). Errors only on backend failure (keychain
/// locked, Secret Service absent, platform IO issue).
///
/// **Not exposed as a Tauri command by design.** Keys flow Rust-internal
/// only — scope §3.2, ADR §D5.
pub fn load_api_key(provider: &str) -> Result<Option<String>, String> {
    if env_fallback_active() {
        return Ok(std::env::var(env_var_name(provider)).ok());
    }

    let entry = keyring::Entry::new(SERVICE, provider)
        .map_err(|e| format!("keyring entry ({provider}): {e}"))?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring read ({provider}): {e}")),
    }
}

/// Create or overwrite the stored key. Caller is responsible for flipping
/// `ProvidersSettings.configured_providers[provider]` + persisting and
/// for calling pool invalidation — the Tauri command wrapper does both.
pub fn save_api_key(provider: &str, key: &str) -> Result<(), String> {
    if env_fallback_active() {
        return Err(format!(
            "Running with OCTOPAL_API_KEY_FALLBACK=env. \
             Set {} in the environment to configure this provider. \
             See docs/troubleshooting-linux-keyring.md.",
            env_var_name(provider)
        ));
    }

    let entry = keyring::Entry::new(SERVICE, provider)
        .map_err(|e| format!("keyring entry ({provider}): {e}"))?;
    entry
        .set_password(key)
        .map_err(|e| format!("keyring write ({provider}): {e}"))
}

/// Idempotent: deleting a missing key is `Ok(())`, not `Err`.
pub fn delete_api_key(provider: &str) -> Result<(), String> {
    if env_fallback_active() {
        return Err(format!(
            "Running with OCTOPAL_API_KEY_FALLBACK=env. \
             Unset {} in the environment to remove this provider. \
             See docs/troubleshooting-linux-keyring.md.",
            env_var_name(provider)
        ));
    }

    let entry = keyring::Entry::new(SERVICE, provider)
        .map_err(|e| format!("keyring entry ({provider}): {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete ({provider}): {e}")),
    }
}

// ── Tauri commands (renderer-facing) ─────────────────────────────────
//
// Write-only + bool-query surface. No read command — see module doc.

/// Renderer → keyring save. Also flips `configured_providers[provider] = true`,
/// persists settings, and invalidates the pool so the next spawn reads the
/// new key (scope §4.4).
#[tauri::command]
pub async fn save_api_key_cmd(
    provider: String,
    key: String,
    state: State<'_, ManagedState>,
) -> Result<(), String> {
    // 1. Keyring write first. If this fails, settings untouched → UI state
    //    stays truthful (scope §3.2 atomicity).
    save_api_key(&provider, &key)?;

    // 2. Flip the presence flag + persist settings.
    {
        let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
        settings
            .providers
            .configured_providers
            .insert(provider.clone(), true);
    }
    state.save_settings()?;

    // 3. Pool invalidation: existing pooled sidecars still hold the old
    //    env key (or none at all). Kill them so next turn spawns with the
    //    fresh key. #[must_use] from Stage 6c forces us to shutdown the
    //    evicted entries; do it off the settings lock.
    let evicted = state.goose_acp_pool.invalidate_pool_for_provider(&provider);
    let evicted_count = evicted.len();
    for entry in evicted {
        entry.client.shutdown().await;
    }
    if evicted_count > 0 {
        eprintln!(
            "[api_keys] invalidate_pool_for_provider({provider}) → {evicted_count} sidecars shut down"
        );
    }

    Ok(())
}

/// Renderer → keyring delete + flag flip. Idempotent wrt missing key.
#[tauri::command]
pub async fn delete_api_key_cmd(
    provider: String,
    state: State<'_, ManagedState>,
) -> Result<(), String> {
    delete_api_key(&provider)?;

    {
        let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
        settings
            .providers
            .configured_providers
            .insert(provider.clone(), false);
    }
    state.save_settings()?;

    let evicted = state.goose_acp_pool.invalidate_pool_for_provider(&provider);
    let evicted_count = evicted.len();
    for entry in evicted {
        entry.client.shutdown().await;
    }
    if evicted_count > 0 {
        eprintln!(
            "[api_keys] invalidate_pool_for_provider({provider}) → {evicted_count} sidecars shut down"
        );
    }

    Ok(())
}

/// Renderer → bool "is this provider configured?". Reads the settings
/// flag (not the keyring) so opening the Settings tab doesn't trigger
/// Keychain prompts for every provider card. In env-fallback mode,
/// consults env presence instead.
#[tauri::command]
pub fn has_api_key_cmd(
    provider: String,
    state: State<'_, ManagedState>,
) -> Result<bool, String> {
    if env_fallback_active() {
        return Ok(std::env::var(env_var_name(&provider)).is_ok());
    }

    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    Ok(settings
        .providers
        .configured_providers
        .get(&provider)
        .copied()
        .unwrap_or(false))
}

/// Renderer → bool "is keyring available at all?". True unless
/// env-fallback is active or the backend won't give us an Entry handle
/// for a probe account. Settings UI uses this to decide whether to show
/// "OS keyring unavailable" blocking card.
#[tauri::command]
pub fn keyring_available_cmd() -> bool {
    if env_fallback_active() {
        // Fallback IS our "keyring equivalent" in this mode — report
        // available so UI lets the user proceed (with warning banner).
        return true;
    }
    keyring::Entry::new(SERVICE, "__octopal_probe__").is_ok()
}

/// Renderer → structured status for the Providers tab banner.
#[derive(serde::Serialize)]
pub struct KeyringStatus {
    pub backend: &'static str, // "keyring" | "env_fallback"
    pub available: bool,
    pub fallback_env_var: &'static str,
}

/// Renderer → Test Connection. Hits the provider's listing endpoint
/// (free, no tokens billed) to verify the configured key is live.
/// Uses the currently stored key — caller should have called
/// `save_api_key_cmd` first if they just changed it.
///
/// Endpoints (scope §3.4):
/// - anthropic: GET https://api.anthropic.com/v1/models
/// - openai:    GET https://api.openai.com/v1/models
/// - google:    GET https://generativelanguage.googleapis.com/v1beta/models?key=…
/// - ollama:    GET http://localhost:11434/api/tags
///
/// Returns structured result so the UI can render latency + status.
/// Error strings are sanitized — only the HTTP status code, never the
/// raw response body (scope §4.2 log redaction).
#[derive(serde::Serialize)]
pub struct TestConnectionResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub status: Option<u16>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn test_provider_connection(
    provider: String,
) -> Result<TestConnectionResult, String> {
    let start = std::time::Instant::now();
    let key = match load_api_key(&provider)? {
        Some(k) => k,
        None => {
            return Ok(TestConnectionResult {
                ok: false,
                latency_ms: start.elapsed().as_millis() as u64,
                status: None,
                error: Some("no key configured".into()),
            });
        }
    };

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => return Err(format!("http client init: {e}")),
    };

    let (url, headers): (String, Vec<(&'static str, String)>) = match provider.as_str() {
        "anthropic" => (
            "https://api.anthropic.com/v1/models".into(),
            vec![
                ("x-api-key", key.clone()),
                ("anthropic-version", "2023-06-01".into()),
            ],
        ),
        "openai" => (
            "https://api.openai.com/v1/models".into(),
            vec![("authorization", format!("Bearer {key}"))],
        ),
        "google" => (
            format!(
                "https://generativelanguage.googleapis.com/v1beta/models?key={}",
                urlencoding::encode(&key)
            ),
            vec![],
        ),
        "ollama" => {
            // "key" here is reused as host URL for ollama. UI stores
            // OLLAMA_HOST-style value in the same keyring slot.
            let host = if key.is_empty() {
                "http://localhost:11434".into()
            } else {
                key.trim_end_matches('/').to_string()
            };
            (format!("{host}/api/tags"), vec![])
        }
        _ => {
            return Ok(TestConnectionResult {
                ok: false,
                latency_ms: start.elapsed().as_millis() as u64,
                status: None,
                error: Some(format!("unsupported provider: {provider}")),
            });
        }
    };

    let mut req = client.get(&url);
    for (k, v) in headers {
        req = req.header(k, v);
    }

    match req.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let ok = resp.status().is_success();
            Ok(TestConnectionResult {
                ok,
                latency_ms: start.elapsed().as_millis() as u64,
                status: Some(status),
                error: if ok {
                    None
                } else {
                    // Only the status code, never the body — ADR §D5.
                    Some(format!("HTTP {status}"))
                },
            })
        }
        Err(e) => Ok(TestConnectionResult {
            ok: false,
            latency_ms: start.elapsed().as_millis() as u64,
            status: None,
            // Format `e` with `{}` (not `{:#?}`) — the reqwest Display
            // impl gives a one-line summary without inner body bytes.
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub fn keyring_status_cmd() -> KeyringStatus {
    if env_fallback_active() {
        KeyringStatus {
            backend: "env_fallback",
            available: true,
            fallback_env_var: FALLBACK_ENV_VAR,
        }
    } else {
        KeyringStatus {
            backend: "keyring",
            available: keyring::Entry::new(SERVICE, "__octopal_probe__").is_ok(),
            fallback_env_var: FALLBACK_ENV_VAR,
        }
    }
}

#[cfg(test)]
mod tests {
    //! Unit tests for the env-fallback path. Keyring backends are tested
    //! via the smoke test (manual, scope §6 G1) since `keyring v3`'s
    //! `mock` feature isn't enabled in our dependency surface (we build
    //! platform-native only — one binary, one real backend per target).
    //! Adding `mock` would double CI matrix cost for a code path whose
    //! bugs surface on the first real save. Accepted tradeoff, documented
    //! in scope §7 Q2.

    use super::*;

    /// Single shared mutex — env-var tests mutate process-global state
    /// so they must serialize. Once one test holds the lock it mutates
    /// env, runs, then resets before releasing.
    static ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct EnvGuard {
        restore: Vec<(String, Option<String>)>,
    }
    impl EnvGuard {
        fn set(&mut self, k: &str, v: Option<&str>) {
            self.restore
                .push((k.to_string(), std::env::var(k).ok()));
            match v {
                Some(val) => std::env::set_var(k, val),
                None => std::env::remove_var(k),
            }
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (k, v) in self.restore.drain(..) {
                match v {
                    Some(val) => std::env::set_var(&k, val),
                    None => std::env::remove_var(&k),
                }
            }
        }
    }
    fn guard() -> EnvGuard {
        EnvGuard { restore: vec![] }
    }

    #[test]
    fn env_fallback_inactive_by_default() {
        let _lock = ENV_MUTEX.lock().unwrap();
        let mut g = guard();
        g.set(FALLBACK_ENV_VAR, None);
        assert!(!env_fallback_active());
    }

    #[test]
    fn env_fallback_active_when_set_to_env() {
        let _lock = ENV_MUTEX.lock().unwrap();
        let mut g = guard();
        g.set(FALLBACK_ENV_VAR, Some("env"));
        assert!(env_fallback_active());
    }

    #[test]
    fn env_fallback_inactive_for_other_values() {
        let _lock = ENV_MUTEX.lock().unwrap();
        let mut g = guard();
        g.set(FALLBACK_ENV_VAR, Some("file"));
        assert!(!env_fallback_active());
        g.set(FALLBACK_ENV_VAR, Some("1"));
        assert!(!env_fallback_active());
    }

    #[test]
    fn env_var_name_uppercases_provider() {
        assert_eq!(env_var_name("anthropic"), "OCTOPAL_KEY_ANTHROPIC");
        assert_eq!(env_var_name("openai"), "OCTOPAL_KEY_OPENAI");
    }

    #[test]
    fn load_in_fallback_reads_env_var() {
        let _lock = ENV_MUTEX.lock().unwrap();
        let mut g = guard();
        g.set(FALLBACK_ENV_VAR, Some("env"));
        g.set("OCTOPAL_KEY_ANTHROPIC", Some("sk-ant-test-xyz"));
        let v = load_api_key("anthropic").unwrap();
        assert_eq!(v.as_deref(), Some("sk-ant-test-xyz"));
    }

    #[test]
    fn load_in_fallback_missing_env_returns_none() {
        let _lock = ENV_MUTEX.lock().unwrap();
        let mut g = guard();
        g.set(FALLBACK_ENV_VAR, Some("env"));
        g.set("OCTOPAL_KEY_ANTHROPIC", None);
        let v = load_api_key("anthropic").unwrap();
        assert_eq!(v, None);
    }

    #[test]
    fn save_in_fallback_errors_with_envvar_name() {
        let _lock = ENV_MUTEX.lock().unwrap();
        let mut g = guard();
        g.set(FALLBACK_ENV_VAR, Some("env"));
        let err = save_api_key("anthropic", "sk-ant-foo").unwrap_err();
        assert!(err.contains("OCTOPAL_API_KEY_FALLBACK"));
        assert!(err.contains("OCTOPAL_KEY_ANTHROPIC"));
    }

    #[test]
    fn delete_in_fallback_errors_with_envvar_name() {
        let _lock = ENV_MUTEX.lock().unwrap();
        let mut g = guard();
        g.set(FALLBACK_ENV_VAR, Some("env"));
        let err = delete_api_key("openai").unwrap_err();
        assert!(err.contains("OCTOPAL_KEY_OPENAI"));
    }

    #[test]
    fn keyring_status_reports_env_fallback_when_active() {
        let _lock = ENV_MUTEX.lock().unwrap();
        let mut g = guard();
        g.set(FALLBACK_ENV_VAR, Some("env"));
        let s = keyring_status_cmd();
        assert_eq!(s.backend, "env_fallback");
        assert!(s.available);
    }
}
