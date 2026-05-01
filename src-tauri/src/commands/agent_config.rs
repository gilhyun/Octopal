//! Per-agent provider + model binding (Phase 6 §3.3).
//!
//! Each agent's `config.json` may carry optional `provider` and `model`
//! fields; this module owns the deserialization + resolution logic that
//! turns those (possibly absent) fields into the concrete (provider,
//! model) pair `run_agent_turn` uses to spawn a sidecar.
//!
//! # Fallback chain (most → least specific)
//!
//! 1. `agent.config.provider` set ➞ use it
//!    `agent.config.model` set ➞ use it
//! 2. Either missing ➞ use `settings.providers.default_provider`
//!    / `settings.providers.default_model`
//! 3. Even those missing (corrupted settings) ➞ built-in defaults
//!    (`anthropic` / `claude-sonnet-4-6`)
//!
//! Provider and model resolve **independently** — an agent can pin only
//! the model (inheriting the workspace provider) or only the provider
//! (inheriting the model alias). Today's UI (Phase 6 §5.1) exposes
//! cascading dropdowns that make this rare in practice but the API
//! supports it cleanly.
//!
//! # No on-disk migration
//!
//! Both fields are `Option<String>` with `#[serde(default)]`. Legacy
//! `config.json` files (no provider/model fields) deserialize to
//! `AgentBinding::default()` (both `None`) and resolve to the settings
//! defaults — identical to v0.1.42 behavior. Saving an agent without
//! touching the Model tab leaves the on-disk JSON unchanged.

use std::path::Path;

use serde::Deserialize;

/// Built-in fallback when neither agent nor settings specify. Matches
/// the historical hardcode in `goose_acp.rs::run_agent_turn` so the
/// "everything missing" path produces v0.1.42 behavior verbatim.
const BUILTIN_PROVIDER: &str = "anthropic";
const BUILTIN_MODEL: &str = "claude-sonnet-4-6";

/// Subset of an agent's `config.json` relevant to provider/model
/// resolution. Other fields (name, role, permissions, mcp) are owned
/// by separate parsing paths in `octo.rs` / `agent.rs`; this struct is
/// strictly **additive** and ignores everything else.
///
/// Empty string is treated as `None` after deserialization — that
/// way a user clearing the Model tab field doesn't accidentally
/// override the default with `""`. The renderer should never write an
/// empty string but defense-in-depth costs nothing.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
pub struct AgentBinding {
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

impl AgentBinding {
    /// Coerce empty strings to None. Called after deserialization on the
    /// boundary so internal logic never has to think about the
    /// `Some("")` case.
    pub fn normalize(mut self) -> Self {
        if self.provider.as_deref().map(str::is_empty).unwrap_or(false) {
            self.provider = None;
        }
        if self.model.as_deref().map(str::is_empty).unwrap_or(false) {
            self.model = None;
        }
        self
    }

    /// Read an agent's `config.json` from disk, return its binding (or
    /// default if the file is missing / malformed / has neither field).
    ///
    /// Errors are logged but never bubbled — a corrupt config.json
    /// shouldn't prevent the turn from running with defaults. The
    /// existing `agent.rs` / `goose_acp.rs` parsing already validates
    /// the structural fields (name, role, etc.); this read is for the
    /// **additive** Phase 6 fields only.
    pub fn read_or_default(octo_path: &Path) -> Self {
        let raw = match std::fs::read_to_string(octo_path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!(
                    "[agent_config] {} unreadable: {e} — falling back to defaults",
                    octo_path.display()
                );
                return Self::default();
            }
        };
        match serde_json::from_str::<AgentBinding>(&raw) {
            Ok(b) => b.normalize(),
            Err(e) => {
                eprintln!(
                    "[agent_config] {} parse failed: {e} — falling back to defaults",
                    octo_path.display()
                );
                Self::default()
            }
        }
    }
}

/// Resolve the (provider, model) pair for a turn given the agent's
/// binding plus the workspace defaults. Pure function — testable in
/// isolation, no I/O.
///
/// `settings_default_provider` / `settings_default_model` come from
/// `state::ProvidersSettings::{default_provider, default_model}`.
/// They're `&str` (not `&Option<&str>`) because the settings struct
/// always has values — `default_default_provider()` /
/// `default_default_model()` ensure non-empty defaults at deserialize
/// time. Empty-string here would mean "user manually cleared
/// settings"; we treat that as "fall back to built-in" rather than
/// silently passing `""` to Goose.
pub fn resolve_for_turn(
    binding: &AgentBinding,
    settings_default_provider: &str,
    settings_default_model: &str,
) -> (String, String) {
    let provider = binding
        .provider
        .as_deref()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            if !settings_default_provider.is_empty() {
                Some(settings_default_provider)
            } else {
                None
            }
        })
        .unwrap_or(BUILTIN_PROVIDER)
        .to_string();
    let model = binding
        .model
        .as_deref()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            if !settings_default_model.is_empty() {
                Some(settings_default_model)
            } else {
                None
            }
        })
        .unwrap_or(BUILTIN_MODEL)
        .to_string();
    (provider, model)
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Deserialization ─────────────────────────────────────────

    #[test]
    fn legacy_config_without_provider_or_model_yields_default_binding() {
        // Pre-Phase 6 config.json — no provider/model fields. Must
        // deserialize cleanly into AgentBinding::default(). This is the
        // backwards-compatibility invariant: if it breaks, every
        // existing agent breaks at load time.
        let raw = r#"{
            "name": "researcher",
            "role": "Research assistant",
            "icon": "🔬"
        }"#;
        let binding: AgentBinding = serde_json::from_str(raw).unwrap();
        assert_eq!(binding, AgentBinding::default());
        assert!(binding.provider.is_none());
        assert!(binding.model.is_none());
    }

    #[test]
    fn config_with_only_provider_keeps_model_none() {
        let raw = r#"{ "provider": "openai" }"#;
        let binding: AgentBinding = serde_json::from_str(raw).unwrap();
        assert_eq!(binding.provider.as_deref(), Some("openai"));
        assert!(binding.model.is_none());
    }

    #[test]
    fn config_with_only_model_keeps_provider_none() {
        let raw = r#"{ "model": "gpt-5" }"#;
        let binding: AgentBinding = serde_json::from_str(raw).unwrap();
        assert!(binding.provider.is_none());
        assert_eq!(binding.model.as_deref(), Some("gpt-5"));
    }

    #[test]
    fn config_with_both_fields_keeps_both() {
        let raw = r#"{ "provider": "openai", "model": "gpt-5" }"#;
        let binding: AgentBinding = serde_json::from_str(raw).unwrap();
        assert_eq!(binding.provider.as_deref(), Some("openai"));
        assert_eq!(binding.model.as_deref(), Some("gpt-5"));
    }

    #[test]
    fn empty_string_fields_normalize_to_none() {
        // The renderer should never write `""` — but if it does (race,
        // user manually editing JSON), normalize() coerces to None so
        // resolve_for_turn doesn't pass `""` to Goose.
        let raw = r#"{ "provider": "", "model": "" }"#;
        let binding: AgentBinding =
            serde_json::from_str::<AgentBinding>(raw).unwrap().normalize();
        assert!(binding.provider.is_none());
        assert!(binding.model.is_none());
    }

    // ── Resolution ──────────────────────────────────────────────

    #[test]
    fn resolve_uses_binding_when_both_set() {
        let binding = AgentBinding {
            provider: Some("openai".into()),
            model: Some("gpt-5".into()),
        };
        let (p, m) = resolve_for_turn(&binding, "anthropic", "claude-sonnet-4-6");
        assert_eq!(p, "openai");
        assert_eq!(m, "gpt-5");
    }

    #[test]
    fn resolve_falls_back_to_settings_when_binding_empty() {
        let binding = AgentBinding::default();
        let (p, m) = resolve_for_turn(&binding, "anthropic", "claude-opus-4-7");
        assert_eq!(p, "anthropic");
        assert_eq!(m, "claude-opus-4-7");
    }

    #[test]
    fn resolve_mixes_binding_provider_with_settings_model() {
        // User pinned provider on the agent but left model on default.
        // Resolution should respect the partial override.
        let binding = AgentBinding {
            provider: Some("openai".into()),
            model: None,
        };
        let (p, m) = resolve_for_turn(&binding, "anthropic", "claude-sonnet-4-6");
        assert_eq!(p, "openai");
        // Note: this is a "weird" combination (openai + sonnet), but the
        // resolver is intentionally agnostic — UI prevents this in the
        // dropdown cascade, but if it ever happens at the resolver layer
        // we don't crash, we just pass to Goose which surfaces an error.
        assert_eq!(m, "claude-sonnet-4-6");
    }

    #[test]
    fn resolve_mixes_binding_model_with_settings_provider() {
        let binding = AgentBinding {
            provider: None,
            model: Some("claude-haiku-4-5-20251001".into()),
        };
        let (p, m) = resolve_for_turn(&binding, "anthropic", "claude-sonnet-4-6");
        assert_eq!(p, "anthropic");
        assert_eq!(m, "claude-haiku-4-5-20251001");
    }

    #[test]
    fn resolve_uses_builtin_when_binding_and_settings_both_empty() {
        // Defensive: settings struct guarantees non-empty defaults at
        // deserialize, but if a future bug ever writes empty strings,
        // we fall through to `anthropic` / `claude-sonnet-4-6` rather
        // than passing `""` to Goose.
        let binding = AgentBinding::default();
        let (p, m) = resolve_for_turn(&binding, "", "");
        assert_eq!(p, BUILTIN_PROVIDER);
        assert_eq!(m, BUILTIN_MODEL);
    }

    #[test]
    fn resolve_treats_binding_empty_string_same_as_none() {
        // Without normalize(), a Some("") binding would have skipped
        // the fallback. The filter inside resolve_for_turn handles it
        // even if normalize() was somehow bypassed.
        let binding = AgentBinding {
            provider: Some("".into()),
            model: Some("".into()),
        };
        let (p, m) = resolve_for_turn(&binding, "openai", "gpt-5");
        assert_eq!(p, "openai");
        assert_eq!(m, "gpt-5");
    }

    // ── File I/O (read_or_default graceful degradation) ─────────

    #[test]
    fn read_or_default_returns_default_for_missing_file() {
        let path = std::env::temp_dir().join("octopal-agent-config-missing-xyz.json");
        let _ = std::fs::remove_file(&path); // ensure absent
        let binding = AgentBinding::read_or_default(&path);
        assert_eq!(binding, AgentBinding::default());
    }

    #[test]
    fn read_or_default_returns_default_for_malformed_file() {
        let path = std::env::temp_dir().join("octopal-agent-config-malformed.json");
        std::fs::write(&path, b"{ this isn't json").unwrap();
        let binding = AgentBinding::read_or_default(&path);
        assert_eq!(binding, AgentBinding::default());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_or_default_extracts_binding_from_full_config() {
        let path = std::env::temp_dir().join("octopal-agent-config-full.json");
        // Note: fs::write takes &[u8]; emoji in icon would break a `b"…"`
        // raw byte literal but is fine through `.as_bytes()`. Use a
        // non-emoji icon here to keep the test non-distracting.
        let body = r#"{
            "name": "gpt-agent",
            "role": "GPT-powered agent",
            "icon": "G",
            "provider": "openai",
            "model": "gpt-5"
        }"#;
        std::fs::write(&path, body).unwrap();
        let binding = AgentBinding::read_or_default(&path);
        assert_eq!(binding.provider.as_deref(), Some("openai"));
        assert_eq!(binding.model.as_deref(), Some("gpt-5"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_or_default_handles_extra_unknown_fields() {
        // Phase 7 might add `temperature` or similar — Phase 6 must not
        // break when those fields appear (forward compat).
        let path = std::env::temp_dir().join("octopal-agent-config-future.json");
        std::fs::write(
            &path,
            br#"{
                "provider": "anthropic",
                "model": "opus",
                "temperature": 0.7,
                "maxTokens": 4096,
                "futureField": "ignore me"
            }"#,
        )
        .unwrap();
        let binding = AgentBinding::read_or_default(&path);
        assert_eq!(binding.provider.as_deref(), Some("anthropic"));
        assert_eq!(binding.model.as_deref(), Some("opus"));
        let _ = std::fs::remove_file(&path);
    }
}
