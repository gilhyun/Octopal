//! Providers manifest loader (Phase 3, scope §2.4).
//!
//! Two-layer lookup:
//!   1. Bundled default at `src-tauri/resources/providers.json`
//!      (compiled in via `include_str!`).
//!   2. Runtime overlay at `<state_dir>/providers.json` (optional; partial
//!      override — missing keys inherit bundle).
//!
//! The manifest is loaded **once** at `ManagedState::new()` and cached in
//! `ManagedState.providers_manifest`. No hot-reload in Phase 3+4; users
//! restart to pick up overlay changes (documented in scope §2.4).
//!
//! Shape matches ADR §3.4. Schema is intentionally permissive on
//! `authMethods` entries — Phase 3+4 only consumes `api_key` paths, but
//! the bundled manifest preserves the full schema so Phase 5 (oauth / cli
//! subscription) can read the same file without a migration.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

/// The embedded default manifest (compile-time). Overlay file, when
/// present, is deep-merged on top at load time.
const BUNDLED_MANIFEST: &str = include_str!("../../resources/providers.json");

/// One provider entry in the manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderEntry {
    #[serde(rename = "displayName")]
    pub display_name: String,
    /// Curated model list. `ModelList::Static` for api-key providers,
    /// `ModelList::Dynamic` sentinel for Ollama-style local providers
    /// where the list is fetched from the running daemon.
    pub models: ModelList,
    #[serde(rename = "authMethods", default)]
    pub auth_methods: Vec<AuthMethod>,
}

/// `models` field — accepts either a string sentinel (`"dynamic"`) or a
/// concrete array of model IDs. Matches ADR §3.4 schema verbatim.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ModelList {
    Dynamic(String),
    Static(Vec<String>),
}

impl ModelList {
    /// Returns the static list if known, else `None`. Callers needing
    /// dynamic resolution (Ollama) must probe the daemon separately.
    pub fn as_slice(&self) -> Option<&[String]> {
        match self {
            ModelList::Static(v) => Some(v.as_slice()),
            ModelList::Dynamic(_) => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthMethod {
    pub id: String,
    pub label: String,
    /// Value injected as `GOOSE_PROVIDER` env at spawn time. May differ
    /// from the top-level provider key (e.g. `"cli_subscription"` routes
    /// to `goose_provider: "claude-code"`).
    #[serde(rename = "goose_provider")]
    pub goose_provider: String,
    /// Phase 5 fields, accepted and stored but not yet consumed.
    #[serde(rename = "detectBinary", default, skip_serializing_if = "Option::is_none")]
    pub detect_binary: Option<String>,
}

/// Root manifest — a map of provider ID → entry.
pub type ProvidersManifest = BTreeMap<String, ProviderEntry>;

/// Loads the bundled manifest and, if present, deep-merges the overlay at
/// `state_dir/providers.json`. Errors only on bundle parse failure (which
/// is a programmer error — the bundle is compile-time validated via
/// `include_str!` + tests). Overlay parse failures are logged and the
/// bundle is returned as-is, so a corrupted user overlay doesn't brick
/// the app.
pub fn load(state_dir: &Path) -> Result<ProvidersManifest, String> {
    let bundled: ProvidersManifest = serde_json::from_str(BUNDLED_MANIFEST)
        .map_err(|e| format!("bundled providers.json parse: {e}"))?;

    let overlay_path = state_dir.join("providers.json");
    if !overlay_path.exists() {
        return Ok(bundled);
    }

    let overlay_raw = match std::fs::read_to_string(&overlay_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "[providers_manifest] overlay read failed ({}): {}. Using bundled default.",
                overlay_path.display(),
                e
            );
            return Ok(bundled);
        }
    };

    let overlay: ProvidersManifest = match serde_json::from_str(&overlay_raw) {
        Ok(m) => m,
        Err(e) => {
            eprintln!(
                "[providers_manifest] overlay parse failed ({}): {}. Using bundled default.",
                overlay_path.display(),
                e
            );
            return Ok(bundled);
        }
    };

    Ok(merge(bundled, overlay))
}

/// Deep-merge: overlay entries replace bundled ones at the provider level
/// (not field-level). Missing providers in the overlay inherit the bundle
/// untouched. This matches ADR §3.4 "partial override: missing keys
/// inherit bundle".
///
/// Field-level deep merge would let a user set just `displayName` in
/// their overlay and keep the bundled model list — desirable but adds
/// surface area without a clear use case yet. Phase 5 revisits if
/// demanded.
fn merge(mut bundled: ProvidersManifest, overlay: ProvidersManifest) -> ProvidersManifest {
    for (k, v) in overlay {
        bundled.insert(k, v);
    }
    bundled
}

/// Renderer-facing: return the current providers manifest for the
/// Settings → Providers tab. Reads from the cached `ManagedState` field
/// populated at startup (scope §2.4 "hot-reload explicit non-goal").
#[tauri::command]
pub fn get_providers_manifest(
    state: tauri::State<'_, crate::state::ManagedState>,
) -> ProvidersManifest {
    (*state.providers_manifest).clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn bundled_manifest_parses() {
        let m: ProvidersManifest = serde_json::from_str(BUNDLED_MANIFEST).unwrap();
        assert!(m.contains_key("anthropic"));
        assert!(m.contains_key("openai"));
        assert!(m.contains_key("google"));
        assert!(m.contains_key("ollama"));
    }

    #[test]
    fn bundled_anthropic_has_opus_4_7_first() {
        // ADR §6.8 newest-first ordering — also asserts our alias target
        // (claude-opus-4-7) is actually present in the curated list.
        let m: ProvidersManifest = serde_json::from_str(BUNDLED_MANIFEST).unwrap();
        let anthropic = m.get("anthropic").unwrap();
        let models = anthropic.models.as_slice().expect("static list");
        assert_eq!(models[0], "claude-opus-4-7");
        assert!(models.contains(&"claude-sonnet-4-6".to_string()));
        assert!(models.contains(&"claude-haiku-4-5-20251001".to_string()));
    }

    #[test]
    fn ollama_uses_dynamic_sentinel() {
        let m: ProvidersManifest = serde_json::from_str(BUNDLED_MANIFEST).unwrap();
        let ollama = m.get("ollama").unwrap();
        assert!(
            ollama.models.as_slice().is_none(),
            "ollama must be ModelList::Dynamic"
        );
    }

    #[test]
    fn load_without_overlay_returns_bundled() {
        let tmp = tempdir();
        let m = load(tmp.path()).unwrap();
        assert_eq!(m.len(), 4);
    }

    #[test]
    fn overlay_adds_new_provider() {
        let tmp = tempdir();
        let overlay = r#"{
            "custom": {
                "displayName": "Custom",
                "models": ["custom-model-1"],
                "authMethods": [
                    {"id":"api_key","label":"API Key","goose_provider":"custom"}
                ]
            }
        }"#;
        fs::write(tmp.path().join("providers.json"), overlay).unwrap();
        let m = load(tmp.path()).unwrap();
        assert_eq!(m.len(), 5);
        assert!(m.contains_key("custom"));
        assert!(m.contains_key("anthropic"), "bundle still present");
    }

    #[test]
    fn overlay_replaces_existing_provider() {
        let tmp = tempdir();
        let overlay = r#"{
            "anthropic": {
                "displayName": "Anthropic (overridden)",
                "models": ["claude-custom-999"],
                "authMethods": [
                    {"id":"api_key","label":"API Key","goose_provider":"anthropic"}
                ]
            }
        }"#;
        fs::write(tmp.path().join("providers.json"), overlay).unwrap();
        let m = load(tmp.path()).unwrap();
        let a = m.get("anthropic").unwrap();
        assert_eq!(a.display_name, "Anthropic (overridden)");
        let models = a.models.as_slice().unwrap();
        assert_eq!(models, &["claude-custom-999"]);
    }

    #[test]
    fn corrupted_overlay_falls_back_to_bundle() {
        let tmp = tempdir();
        fs::write(tmp.path().join("providers.json"), "{ not json").unwrap();
        let m = load(tmp.path()).unwrap();
        // Bundle intact; corrupted overlay logged and skipped.
        assert_eq!(m.len(), 4);
        assert!(m.contains_key("anthropic"));
    }

    /// Minimal tempdir helper — we intentionally don't pull `tempfile`
    /// for this. Uses a unique path under `std::env::temp_dir()` and
    /// cleans up on Drop.
    struct TempDir(std::path::PathBuf);
    impl TempDir {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn tempdir() -> TempDir {
        let p = std::env::temp_dir().join(format!(
            "octopal-providers-manifest-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}
