use crate::state::{AppSettings, ManagedState};
use tauri::State;

#[tauri::command]
pub fn load_settings(state: State<'_, ManagedState>) -> Result<AppSettings, String> {
    let s = state.settings.lock().map_err(|e| e.to_string())?;
    Ok(s.clone())
}

/// Persist settings and invalidate pool entries for any provider whose
/// `configured_providers` flag changed.
///
/// Pool invalidation is driven by *flag deltas*, not by out-of-band key
/// rotation: the rotation path is `save_api_key_cmd` / `delete_api_key_cmd`
/// in `commands::api_keys`, which flip the flag as part of their own
/// transaction. That lands here via the settings persist → delta detection
/// below → `invalidate_pool_for_provider`. The helper closure is shared
/// logic (scope §4.4).
///
/// Other `ProvidersSettings` changes (e.g. `default_provider` edits in UI,
/// `useLegacyClaudeCli` toggle) do not invalidate the pool — they take
/// effect on the next `send_message` via a fresh settings read. Only key
/// presence changes warrant killing live sidecars.
#[tauri::command]
pub async fn save_settings(
    settings: AppSettings,
    state: State<'_, ManagedState>,
) -> Result<serde_json::Value, String> {
    // Snapshot BEFORE the write so we can diff configured_providers flags.
    // Scope §4.4: keyring rotation (save_api_key_cmd / delete_api_key_cmd)
    // lands here via `settings.providers.configured_providers[provider]`
    // flip; this diff is what catches it.
    let (prev_configured, prev_api_key_stored) = {
        let s = state.settings.lock().map_err(|e| e.to_string())?;
        (
            s.providers.configured_providers.clone(),
            s.providers.api_key_stored.clone(),
        )
    };

    let next_configured = settings.providers.configured_providers.clone();

    {
        let mut s = state.settings.lock().map_err(|e| e.to_string())?;
        *s = settings;
        // Phase 5a: `api_key_stored` is Rust-internal state maintained
        // by `save_api_key_cmd` / `delete_api_key_cmd`. The renderer's
        // AppSettings type doesn't know about it; a naive `*s = settings`
        // would drop the field to empty every time the user saves any
        // other setting. Preserve it explicitly.
        s.providers.api_key_stored = prev_api_key_stored;
    }
    state.save_settings()?;

    // Collect providers whose flag crossed true↔false (or from absent → any).
    // Flag staying the same → no-op. We do NOT invalidate on flag-stays-true
    // because that would churn the pool on every unrelated settings save
    // (theme change, shortcut edit, etc).
    let changed: Vec<String> = next_configured
        .iter()
        .filter_map(|(provider, &new_val)| {
            let prev_val = prev_configured.get(provider).copied();
            if prev_val != Some(new_val) {
                Some(provider.clone())
            } else {
                None
            }
        })
        .chain(prev_configured.keys().filter_map(|p| {
            if !next_configured.contains_key(p) {
                // Provider row removed entirely (shouldn't happen through
                // Tauri commands, but guard against hand-edited settings).
                Some(p.clone())
            } else {
                None
            }
        }))
        .collect();

    // #[must_use] on invalidate_* forces us to shutdown returned entries.
    // The lock is already released (block above); await shutdowns here.
    for provider in &changed {
        let evicted = state.goose_acp_pool.invalidate_pool_for_provider(provider);
        let n = evicted.len();
        for entry in evicted {
            entry.client.shutdown().await;
        }
        if n > 0 {
            eprintln!(
                "[settings] configured_providers[{provider}] changed → {n} sidecars evicted"
            );
        }
    }

    Ok(serde_json::json!({ "ok": true, "invalidated": changed }))
}

#[tauri::command]
pub fn get_version() -> serde_json::Value {
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "tauri": "2.x",
        "rust": "1.84+"
    })
}
