use crate::state::{AppSettings, ManagedState};
use tauri::State;

#[tauri::command]
pub fn load_settings(state: State<'_, ManagedState>) -> Result<AppSettings, String> {
    let s = state.settings.lock().map_err(|e| e.to_string())?;
    Ok(s.clone())
}

#[tauri::command]
pub fn save_settings(
    settings: AppSettings,
    state: State<'_, ManagedState>,
) -> Result<serde_json::Value, String> {
    // Snapshot the providers section so we can detect changes after the
    // write. Stage 6c wires the invalidation hook; Phase 4 will populate
    // the trigger side (keyring save/delete). For v0.2.0-beta the only
    // observable change here is the `useLegacyClaudeCli` flag — flipping
    // it mid-session doesn't need to touch in-flight pool entries (next
    // send_message reads the flag fresh), so the hook runs as a no-op
    // placeholder right now. Leaving it wired so the Phase 4 PR only has
    // to fill in `if provider_X_key_changed`.
    let prev_providers = state
        .settings
        .lock()
        .map_err(|e| e.to_string())?
        .providers
        .clone();

    let mut s = state.settings.lock().map_err(|e| e.to_string())?;
    *s = settings;
    drop(s);
    state.save_settings()?;

    // Invalidation hook — placeholder. When Phase 4 adds keyring-backed
    // API keys to `ProvidersSettings`, compare `prev_providers.<key>` vs
    // the new value and call `invalidate_pool_for_provider(<provider>)`
    // for each rotation. The evicted entries come back so we can shutdown
    // off the sync settings lock (#[must_use] enforces this).
    let _ = prev_providers; // suppress unused-warning until Phase 4
    let evicted = state.goose_acp_pool.invalidate_pool_for_provider("__noop__");
    debug_assert!(evicted.is_empty(), "placeholder invalidation should never hit");

    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn get_version() -> serde_json::Value {
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "tauri": "2.x",
        "rust": "1.84+"
    })
}
