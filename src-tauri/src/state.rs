use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::commands::backup::BackupTracker;
use crate::commands::file_lock::FileLockManager;
use crate::commands::goose_acp_pool::GooseAcpPool;
use crate::commands::process_pool::ProcessPool;
use crate::commands::providers_manifest::{self, ProvidersManifest};

/// Persistent app state (workspaces, folders)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppState {
    pub workspaces: Vec<Workspace>,
    #[serde(rename = "activeWorkspaceId")]
    pub active_workspace_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub folders: Vec<String>,
}

/// OctoFile — represents an agent config file (.json or legacy .octo)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OctoFile {
    pub path: String,
    pub name: String,
    pub role: String,
    #[serde(default = "default_icon")]
    pub icon: String,
    pub color: Option<String>,
    pub hidden: Option<bool>,
    /// When true, this agent runs in "isolated mode": it never sees peers or
    /// the shared room history, and other agents can't hand off to it. Used
    /// for heavy single-shot research/analysis agents that would pollute the
    /// group chat. Claude Code's subagent pattern.
    #[serde(default)]
    pub isolated: Option<bool>,
    pub permissions: Option<OctoPermissions>,
    #[serde(rename = "mcpServers")]
    pub mcp_servers: Option<serde_json::Value>,
    /// Phase 3: agent-level provider override. None → inherit
    /// `AppSettings.providers.default_provider`. Values must match a key in
    /// `providers.json` (e.g. `"anthropic"`, `"openai"`). Legacy .octo files
    /// without this field round-trip as None (skip_serializing_if).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Phase 3: agent-level model override. None → inherit
    /// `AppSettings.providers.default_model`. Accepts concrete ID
    /// (`"claude-opus-4-7"`), alias (`"opus"`), or a custom string.
    /// Alias resolution happens at spawn time via `commands::model_alias`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

fn default_icon() -> String {
    "🤖".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OctoPermissions {
    #[serde(rename = "fileWrite")]
    pub file_write: Option<bool>,
    pub bash: Option<bool>,
    pub network: Option<bool>,
    #[serde(rename = "allowPaths")]
    pub allow_paths: Option<Vec<String>>,
    #[serde(rename = "denyPaths")]
    pub deny_paths: Option<Vec<String>>,
}

/// History message stored in .octo files
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryMessage {
    pub id: Option<String>,
    #[serde(rename = "agentName", default)]
    pub agent_name: String,
    pub text: String,
    pub ts: f64,
    pub role: Option<String>,
    #[serde(rename = "roomTs")]
    pub room_ts: Option<f64>,
    /// Attachments (images, text files) sent with the message
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<serde_json::Value>,
    /// Token usage data (input/output tokens, cost, duration, model)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<serde_json::Value>,
}

/// App settings
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub general: GeneralSettings,
    pub agents: AgentSettings,
    pub appearance: AppearanceSettings,
    pub shortcuts: ShortcutSettings,
    pub advanced: AdvancedSettings,
    #[serde(rename = "versionControl")]
    pub version_control: VersionControlSettings,
    #[serde(default)]
    pub backup: BackupSettings,
    #[serde(default)]
    pub providers: ProvidersSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneralSettings {
    #[serde(rename = "restoreLastWorkspace")]
    pub restore_last_workspace: bool,
    #[serde(rename = "launchAtLogin")]
    pub launch_at_login: bool,
    pub language: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSettings {
    #[serde(rename = "defaultPermissions")]
    pub default_permissions: DefaultPermissions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DefaultPermissions {
    #[serde(rename = "fileWrite")]
    pub file_write: bool,
    pub bash: bool,
    pub network: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppearanceSettings {
    #[serde(rename = "chatFontSize")]
    pub chat_font_size: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShortcutSettings {
    #[serde(rename = "textExpansions")]
    pub text_expansions: Vec<TextShortcut>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextShortcut {
    pub trigger: String,
    pub expansion: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdvancedSettings {
    #[serde(rename = "defaultAgentModel")]
    pub default_agent_model: String,
    #[serde(rename = "autoModelSelection")]
    pub auto_model_selection: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionControlSettings {
    #[serde(rename = "autoCommit")]
    pub auto_commit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupSettings {
    /// Maximum number of backup directories to keep per workspace.
    /// Older ones are pruned to OS trash.
    #[serde(rename = "maxBackupsPerWorkspace", default = "default_max_backups")]
    pub max_backups_per_workspace: u32,
    /// Backups older than this many days are pruned, regardless of count.
    #[serde(rename = "maxAgeDays", default = "default_max_age_days")]
    pub max_age_days: u32,
}

fn default_max_backups() -> u32 {
    50
}

fn default_max_age_days() -> u32 {
    7
}

impl Default for BackupSettings {
    fn default() -> Self {
        Self {
            max_backups_per_workspace: default_max_backups(),
            max_age_days: default_max_age_days(),
        }
    }
}

/// Auth mechanism configured for a provider.
///
/// Phase 5a replaces the Phase 3+4 `bool` flag with this enum so the
/// Anthropic card can represent the Pro/Max subscription path. Prior
/// shape (`"anthropic": true|false`) still deserializes — `true` →
/// `ApiKey`, `false` → `None`. See scope §4.1 + §4.2.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    None,
    ApiKey,
    CliSubscription,
}

impl AuthMode {
    /// Any auth mode except `None` counts as configured. Phase 3+4
    /// callers that branched on `bool` now branch on this — semantics
    /// stay identical for legacy data (true → ApiKey → true).
    pub fn is_configured(self) -> bool {
        !matches!(self, AuthMode::None)
    }

    /// snake_case string form used in pool keys, log lines, and any
    /// other place we want a stable textual representation. Must match
    /// the `#[serde(rename_all = "snake_case")]` output so keys stay
    /// greppable across logs and on-disk serde output.
    ///
    /// Added in Phase 5a Commit C-2 (scope §4.3): the pool key gains an
    /// `auth_mode` segment so an `ApiKey` ↔ `CliSubscription` flip
    /// produces a different key, guaranteeing a fresh sidecar spawn. A
    /// single helper here keeps the segment value defined once rather
    /// than duplicated at every call site.
    pub fn as_pool_key_segment(self) -> &'static str {
        match self {
            AuthMode::None => "none",
            AuthMode::ApiKey => "api_key",
            AuthMode::CliSubscription => "cli_subscription",
        }
    }
}

impl Default for AuthMode {
    fn default() -> Self {
        AuthMode::None
    }
}

/// Custom deserializer so existing on-disk `settings.json` files from
/// Phase 3+4 (bool shape) still load. No migration pass, no settings
/// version bump — the normalization happens on every load. Users who
/// re-save settings get the enum shape written back; users who never
/// touch settings keep the bool shape in-file with identical behavior.
impl<'de> Deserialize<'de> for AuthMode {
    fn deserialize<D>(d: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = AuthMode;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("bool or one of \"none\" | \"api_key\" | \"cli_subscription\"")
            }
            fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<AuthMode, E> {
                Ok(if v { AuthMode::ApiKey } else { AuthMode::None })
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<AuthMode, E> {
                match v {
                    "none" => Ok(AuthMode::None),
                    "api_key" => Ok(AuthMode::ApiKey),
                    "cli_subscription" => Ok(AuthMode::CliSubscription),
                    other => Err(E::custom(format!("unknown AuthMode: {other}"))),
                }
            }
            fn visit_string<E: serde::de::Error>(self, v: String) -> Result<AuthMode, E> {
                self.visit_str(&v)
            }
        }
        d.deserialize_any(V)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProvidersSettings {
    /// v0.2.0-beta opt-in rollout: true = legacy Claude CLI path (v0.1.42
    /// behavior), false = Goose ACP sidecar. Flips to default-false in
    /// v0.2.0 stable; removed entirely in v0.3.0 cleanup PR.
    #[serde(rename = "useLegacyClaudeCli", default = "default_use_legacy_claude_cli")]
    pub use_legacy_claude_cli: bool,

    /// Phase 3: Provider ID matching a key in `providers.json`. Default
    /// `"anthropic"` for migration continuity — existing users had implicit
    /// anthropic routing via `ANTHROPIC_API_KEY`.
    #[serde(rename = "defaultProvider", default = "default_default_provider")]
    pub default_provider: String,

    /// Phase 3: Model ID or alias (resolved via `commands::model_alias`).
    /// Default `"claude-sonnet-4-6"` per ADR §6.8 "daily driver".
    #[serde(rename = "defaultModel", default = "default_default_model")]
    pub default_model: String,

    /// Phase 3: Planner model for dispatcher (Stage 6b-ii).
    ///
    /// **Schema-only in Phase 3+4. Wire-up deferred to Stage 6b-ii.**
    /// This PR adds the field, surfaces it in Settings UI, and persists user
    /// choice — but `dispatcher.rs` still reads its hardcoded haiku model
    /// name until 6b-ii swaps in `settings.providers.planner_model`.
    /// Designed here so 6b-ii lands as a pure logic change without a schema
    /// migration; beta users who pre-set this get their choice honored the
    /// moment 6b-ii ships.
    #[serde(rename = "plannerModel", default = "default_planner_model")]
    pub planner_model: String,

    /// Per-provider active auth mode. Separate from `api_key_stored`
    /// below: a user can have a stored API key AND active
    /// `CliSubscription` mode simultaneously. Flipping the mode never
    /// touches the keyring, so the stored key is always recoverable by
    /// flipping back.
    ///
    /// Accepts legacy bool shape (Phase 3+4 `true|false`) via
    /// `AuthMode`'s custom Deserialize — true → `ApiKey`, false → `None`.
    #[serde(rename = "configuredProviders", default)]
    pub configured_providers: std::collections::BTreeMap<String, AuthMode>,

    /// Per-provider "key is present in OS keyring" mirror. Maintained
    /// by `save_api_key_cmd` / `delete_api_key_cmd` only; intentionally
    /// *not* touched by `set_auth_mode_cmd`. This is what drives the
    /// UI's "show the API-key radio even when CLI subscription is the
    /// active mode" behavior — without this separation, flipping to
    /// `CliSubscription` would hide the saved key from the Settings
    /// tab and trap users in cli-only mode (scope §5a bugfix 2026-04-21).
    ///
    /// Absence of an entry means "no key stored" — same semantics as
    /// `false`. Migration from Phase 3+4 settings.json is handled by
    /// `ProvidersSettings::normalize_after_load()` at startup: any
    /// legacy `configured_providers[p] == ApiKey` backfills
    /// `api_key_stored[p] = true`. Direct CliSubscription-only setups
    /// (no keyring entry ever written) stay absent as expected.
    #[serde(rename = "apiKeyStored", default)]
    pub api_key_stored: std::collections::BTreeMap<String, bool>,
}

impl ProvidersSettings {
    /// Backfill `api_key_stored` from `configured_providers` for
    /// entries loaded from a pre-Phase-5a settings.json. Idempotent:
    /// safe to call every load. Only *adds* missing entries — never
    /// clears or overwrites, so a user who saved a key in ApiKey mode
    /// then flipped to CliSubscription keeps their `api_key_stored`
    /// bit after restart.
    pub fn normalize_after_load(&mut self) {
        for (provider, mode) in &self.configured_providers {
            if *mode == AuthMode::ApiKey && !self.api_key_stored.contains_key(provider) {
                self.api_key_stored.insert(provider.clone(), true);
            }
        }
    }
}

fn default_use_legacy_claude_cli() -> bool {
    true
}

fn default_default_provider() -> String {
    "anthropic".to_string()
}

fn default_default_model() -> String {
    "claude-sonnet-4-6".to_string()
}

fn default_planner_model() -> String {
    "claude-haiku-4-5-20251001".to_string()
}

impl Default for ProvidersSettings {
    fn default() -> Self {
        Self {
            use_legacy_claude_cli: default_use_legacy_claude_cli(),
            default_provider: default_default_provider(),
            default_model: default_default_model(),
            planner_model: default_planner_model(),
            configured_providers: std::collections::BTreeMap::new(),
            api_key_stored: std::collections::BTreeMap::new(),
        }
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            general: GeneralSettings {
                restore_last_workspace: true,
                launch_at_login: false,
                language: "en".to_string(),
            },
            agents: AgentSettings {
                default_permissions: DefaultPermissions {
                    file_write: false,
                    bash: false,
                    network: false,
                },
            },
            appearance: AppearanceSettings { chat_font_size: 14 },
            shortcuts: ShortcutSettings {
                text_expansions: vec![],
            },
            advanced: AdvancedSettings {
                default_agent_model: "opus".to_string(),
                auto_model_selection: false,
            },
            version_control: VersionControlSettings { auto_commit: true },
            backup: BackupSettings::default(),
            providers: ProvidersSettings::default(),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            workspaces: vec![],
            active_workspace_id: None,
        }
    }
}

/// Runtime state managed by Tauri
pub struct ManagedState {
    pub app_state: Mutex<AppState>,
    pub settings: Mutex<AppSettings>,
    pub running_agents: Arc<Mutex<HashMap<String, u32>>>, // runId -> child PID
    pub interrupted_runs: Arc<Mutex<HashSet<String>>>,
    #[allow(dead_code)]
    pub permanent_grants: Mutex<HashSet<String>>,
    pub folder_watchers: Arc<Mutex<HashMap<String, notify::RecommendedWatcher>>>,
    pub state_dir: PathBuf,
    #[allow(dead_code)]
    pub is_dev: bool,
    /// Tracks per-run pre-write file snapshots so the activity panel can
    /// offer "revert" on every Write/Edit an agent performs.
    pub backup_tracker: Arc<BackupTracker>,
    /// Best-effort file claim map used to flag concurrent-agent conflicts.
    pub file_lock_manager: Arc<FileLockManager>,
    /// Persistent Claude CLI process pool — reuses long-running processes
    /// to avoid macOS TCC permission popups on every spawn.
    pub process_pool: Arc<ProcessPool>,
    /// Persistent `goose acp` sidecar pool (Stage 6c). Parallel lane to
    /// `process_pool` — whichever runtime spawned the child owns its
    /// pool entry; `stop_agent` asks both pools to drop by PID, with the
    /// non-owning side being a cheap no-op.
    pub goose_acp_pool: Arc<GooseAcpPool>,
    /// Phase 3: providers.json manifest, loaded once at startup from the
    /// bundled default + optional runtime overlay at `<state_dir>/providers.json`.
    /// Consumed by Settings UI (Phase 4 — model dropdown, Test Connection
    /// dispatch) and by the spawn path (provider → `GOOSE_PROVIDER`).
    /// Arc + immutable: swap-on-restart is sufficient for Phase 3+4;
    /// hot-reload is an explicit non-goal (scope §2.4).
    pub providers_manifest: Arc<ProvidersManifest>,
    /// Cached result of probing the Claude CLI for the newest Opus model
    /// available on this machine (e.g. `claude-opus-4-7`). Nested Option:
    ///   outer `None`      → probe hasn't finished yet
    ///   outer `Some(None)` → probe ran, no premium opus available
    ///   outer `Some(Some)` → probe ran, this is the best explicit name
    /// See `commands::model_probe` for details.
    pub best_opus_model: Arc<Mutex<Option<Option<String>>>>,
}

impl ManagedState {
    pub fn new(is_dev: bool) -> Self {
        let home = dirs::home_dir().expect("Cannot find home directory");
        let state_dir = if is_dev {
            home.join(".octopal-dev")
        } else {
            home.join(".octopal")
        };
        fs::create_dir_all(&state_dir).ok();

        let state_file = state_dir.join("state.json");
        let app_state = if state_file.exists() {
            fs::read_to_string(&state_file)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            AppState::default()
        };

        let settings_file = state_dir.join("settings.json");
        let mut settings: AppSettings = if settings_file.exists() {
            fs::read_to_string(&settings_file)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            AppSettings::default()
        };
        // Phase 5a migration: ensure `api_key_stored` tracks keyring
        // presence independently of the active auth mode. Loaded
        // Phase 3+4 settings have no such field; derive it from the
        // legacy configured_providers so `has_api_key_cmd` keeps
        // reporting correctly after a flip to CliSubscription.
        settings.providers.normalize_after_load();

        // Phase 3: load bundled providers.json + optional overlay. Parse
        // failure on the bundle is a programmer error (compile-time
        // included + covered by unit test), so `.expect` is correct here —
        // no graceful degradation since there's no meaningful "empty
        // manifest" fallback that wouldn't brick provider selection.
        let providers_manifest = Arc::new(
            providers_manifest::load(&state_dir)
                .expect("load bundled providers.json (compile-time invariant)"),
        );

        Self {
            app_state: Mutex::new(app_state),
            settings: Mutex::new(settings),
            running_agents: Arc::new(Mutex::new(HashMap::new())),
            interrupted_runs: Arc::new(Mutex::new(HashSet::new())),
            permanent_grants: Mutex::new(HashSet::new()),
            folder_watchers: Arc::new(Mutex::new(HashMap::new())),
            state_dir,
            is_dev,
            backup_tracker: Arc::new(BackupTracker::new()),
            file_lock_manager: Arc::new(FileLockManager::new()),
            process_pool: Arc::new(ProcessPool::new()),
            goose_acp_pool: Arc::new(GooseAcpPool::new()),
            providers_manifest,
            best_opus_model: Arc::new(Mutex::new(None)),
        }
    }

    pub fn save_state(&self) -> Result<(), String> {
        let state = self.app_state.lock().map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(&*state).map_err(|e| e.to_string())?;
        let file = self.state_dir.join("state.json");
        fs::write(file, json).map_err(|e| e.to_string())
    }

    pub fn save_settings(&self) -> Result<(), String> {
        let settings = self.settings.lock().map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(&*settings).map_err(|e| e.to_string())?;
        let file = self.state_dir.join("settings.json");
        fs::write(file, json).map_err(|e| e.to_string())
    }

    pub fn wiki_dir(&self, workspace_id: &str) -> PathBuf {
        self.state_dir.join("wiki").join(workspace_id)
    }
}

#[cfg(test)]
mod migration_tests {
    //! Phase 3 schema migration — ensure legacy on-disk files keep
    //! deserializing after we add fields. Both `.octo` agent files and
    //! `settings.json` are user-owned state; a breaking deserialization
    //! would wipe their config on upgrade.

    use super::*;

    #[test]
    fn legacy_octo_file_without_provider_or_model_deserializes() {
        // Pre-Phase-3 .octo file shape (no provider/model keys).
        let json = r#"{
            "path": "/tmp/foo/assistant.octo",
            "name": "assistant",
            "role": "Helps with stuff",
            "icon": "🤖",
            "color": null,
            "hidden": null,
            "permissions": null,
            "mcpServers": null
        }"#;
        let f: OctoFile = serde_json::from_str(json).unwrap();
        assert_eq!(f.provider, None);
        assert_eq!(f.model, None);
        assert_eq!(f.name, "assistant");
    }

    #[test]
    fn octo_file_with_provider_and_model_roundtrips() {
        let original = OctoFile {
            path: "/tmp/foo/opus-researcher.octo".into(),
            name: "opus-researcher".into(),
            role: "Deep research".into(),
            icon: "🔬".into(),
            color: None,
            hidden: None,
            isolated: Some(true),
            permissions: None,
            mcp_servers: None,
            provider: Some("anthropic".into()),
            model: Some("opus".into()),
        };
        let s = serde_json::to_string(&original).unwrap();
        let back: OctoFile = serde_json::from_str(&s).unwrap();
        assert_eq!(back.provider.as_deref(), Some("anthropic"));
        assert_eq!(back.model.as_deref(), Some("opus"));
    }

    #[test]
    fn octo_file_serialized_without_provider_field_when_none() {
        // `skip_serializing_if = "Option::is_none"` keeps legacy files
        // byte-compatible — an agent that doesn't override produces
        // bytewise-identical JSON to pre-Phase-3.
        let f = OctoFile {
            path: "/tmp/foo/bar.octo".into(),
            name: "bar".into(),
            role: "x".into(),
            icon: "🤖".into(),
            color: None,
            hidden: None,
            isolated: None,
            permissions: None,
            mcp_servers: None,
            provider: None,
            model: None,
        };
        let s = serde_json::to_string(&f).unwrap();
        assert!(!s.contains("\"provider\""), "provider should be skipped: {s}");
        assert!(!s.contains("\"model\""), "model should be skipped: {s}");
    }

    #[test]
    fn legacy_settings_without_phase_3_fields_deserializes_with_defaults() {
        // Pre-Phase-3 settings.json shape — only useLegacyClaudeCli in
        // providers block. Users upgrading from 6c must not lose settings.
        let json = r#"{
            "general": {"restoreLastWorkspace": true, "launchAtLogin": false, "language": "en"},
            "agents": {"defaultPermissions": {"fileWrite": false, "bash": false, "network": false}},
            "appearance": {"chatFontSize": 14},
            "shortcuts": {"textExpansions": []},
            "advanced": {"defaultAgentModel": "opus", "autoModelSelection": false},
            "versionControl": {"autoCommit": true},
            "backup": {"maxBackupsPerWorkspace": 50, "maxAgeDays": 7},
            "providers": {"useLegacyClaudeCli": true}
        }"#;
        let s: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(s.providers.use_legacy_claude_cli, true);
        assert_eq!(s.providers.default_provider, "anthropic");
        assert_eq!(s.providers.default_model, "claude-sonnet-4-6");
        assert_eq!(s.providers.planner_model, "claude-haiku-4-5-20251001");
        assert!(s.providers.configured_providers.is_empty());
    }

    #[test]
    fn legacy_settings_with_missing_providers_block_deserializes() {
        // Even older shape: providers key absent entirely (pre-6b).
        // `AppSettings.providers` has `#[serde(default)]` — should fill in.
        let json = r#"{
            "general": {"restoreLastWorkspace": true, "launchAtLogin": false, "language": "en"},
            "agents": {"defaultPermissions": {"fileWrite": false, "bash": false, "network": false}},
            "appearance": {"chatFontSize": 14},
            "shortcuts": {"textExpansions": []},
            "advanced": {"defaultAgentModel": "opus", "autoModelSelection": false},
            "versionControl": {"autoCommit": true}
        }"#;
        let s: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(s.providers.use_legacy_claude_cli, true);
        assert_eq!(s.providers.default_provider, "anthropic");
    }

    #[test]
    fn providers_settings_roundtrips_with_configured_map() {
        let mut cfg = std::collections::BTreeMap::new();
        cfg.insert("anthropic".to_string(), AuthMode::ApiKey);
        cfg.insert("openai".to_string(), AuthMode::None);
        let mut stored = std::collections::BTreeMap::new();
        stored.insert("anthropic".to_string(), true);
        let original = ProvidersSettings {
            use_legacy_claude_cli: false,
            default_provider: "anthropic".into(),
            default_model: "claude-opus-4-7".into(),
            planner_model: "claude-haiku-4-5-20251001".into(),
            configured_providers: cfg,
            api_key_stored: stored,
        };
        let s = serde_json::to_string(&original).unwrap();
        let back: ProvidersSettings = serde_json::from_str(&s).unwrap();
        assert_eq!(back.default_model, "claude-opus-4-7");
        assert_eq!(
            back.configured_providers.get("anthropic"),
            Some(&AuthMode::ApiKey)
        );
        assert_eq!(
            back.configured_providers.get("openai"),
            Some(&AuthMode::None)
        );
    }

    // ── Phase 5a AuthMode migration (scope §4.2) ──────────────────────
    //
    // On-disk settings.json from Phase 3+4 has the bool shape. Phase 5a
    // must read both shapes and normalize to `AuthMode`. Users who never
    // re-save settings after upgrading will keep the bool shape in-file
    // with identical behavior (true → ApiKey, false → None).

    #[test]
    fn auth_mode_reads_legacy_bool_true_as_api_key() {
        let json = r#"{"anthropic": true}"#;
        let m: std::collections::BTreeMap<String, AuthMode> =
            serde_json::from_str(json).unwrap();
        assert_eq!(m.get("anthropic"), Some(&AuthMode::ApiKey));
    }

    #[test]
    fn auth_mode_reads_legacy_bool_false_as_none() {
        let json = r#"{"openai": false}"#;
        let m: std::collections::BTreeMap<String, AuthMode> =
            serde_json::from_str(json).unwrap();
        assert_eq!(m.get("openai"), Some(&AuthMode::None));
    }

    #[test]
    fn auth_mode_reads_snake_case_variants() {
        let json = r#"{
            "a": "none",
            "b": "api_key",
            "c": "cli_subscription"
        }"#;
        let m: std::collections::BTreeMap<String, AuthMode> =
            serde_json::from_str(json).unwrap();
        assert_eq!(m.get("a"), Some(&AuthMode::None));
        assert_eq!(m.get("b"), Some(&AuthMode::ApiKey));
        assert_eq!(m.get("c"), Some(&AuthMode::CliSubscription));
    }

    #[test]
    fn auth_mode_roundtrip_writes_snake_case() {
        // Post-migration on-disk shape: snake_case strings. If a user
        // upgrades to 5a and re-saves settings, the bool flips to the
        // enum string form. Must roundtrip losslessly.
        let mut cfg = std::collections::BTreeMap::new();
        cfg.insert("anthropic".to_string(), AuthMode::CliSubscription);
        cfg.insert("openai".to_string(), AuthMode::ApiKey);
        cfg.insert("google".to_string(), AuthMode::None);

        let s = serde_json::to_string(&cfg).unwrap();
        assert!(s.contains("\"cli_subscription\""), "got: {s}");
        assert!(s.contains("\"api_key\""));
        assert!(s.contains("\"none\""));

        let back: std::collections::BTreeMap<String, AuthMode> =
            serde_json::from_str(&s).unwrap();
        assert_eq!(back, cfg);
    }

    #[test]
    fn auth_mode_missing_key_defaults_to_empty_map() {
        // providers block present but configuredProviders absent — should
        // round-trip as empty map via #[serde(default)] on the field.
        let json = r#"{
            "general": {"restoreLastWorkspace": true, "launchAtLogin": false, "language": "en"},
            "agents": {"defaultPermissions": {"fileWrite": false, "bash": false, "network": false}},
            "appearance": {"chatFontSize": 14},
            "shortcuts": {"textExpansions": []},
            "advanced": {"defaultAgentModel": "opus", "autoModelSelection": false},
            "versionControl": {"autoCommit": true},
            "providers": {"useLegacyClaudeCli": false}
        }"#;
        let s: AppSettings = serde_json::from_str(json).unwrap();
        assert!(s.providers.configured_providers.is_empty());
    }

    #[test]
    fn auth_mode_mixed_bool_and_enum_normalizes() {
        // Real migration edge case: user hand-edited settings.json or
        // hit a partial write where some keys are bool and some are
        // already enum strings. All entries should land as AuthMode.
        let json = r#"{
            "anthropic": true,
            "openai": "api_key",
            "google": false,
            "ollama": "cli_subscription"
        }"#;
        let m: std::collections::BTreeMap<String, AuthMode> =
            serde_json::from_str(json).unwrap();
        assert_eq!(m.get("anthropic"), Some(&AuthMode::ApiKey));
        assert_eq!(m.get("openai"), Some(&AuthMode::ApiKey));
        assert_eq!(m.get("google"), Some(&AuthMode::None));
        assert_eq!(m.get("ollama"), Some(&AuthMode::CliSubscription));
    }

    #[test]
    fn auth_mode_unknown_string_errors() {
        let json = r#"{"anthropic": "oauth"}"#;
        let err = serde_json::from_str::<std::collections::BTreeMap<String, AuthMode>>(json)
            .unwrap_err()
            .to_string();
        assert!(err.contains("unknown AuthMode"), "got: {err}");
    }

    #[test]
    fn auth_mode_is_configured_matches_legacy_bool_semantics() {
        // Behavior parity check: the Phase 3+4 bool semantics were
        // "configured iff true". After migration, is_configured() must
        // match for all legacy inputs.
        assert!(!AuthMode::None.is_configured());
        assert!(AuthMode::ApiKey.is_configured());
        assert!(AuthMode::CliSubscription.is_configured());
    }

    // ── Phase 5a bugfix (2026-04-21): api_key_stored independence ────
    //
    // Regression guard: before this fix, `has_api_key_cmd` conflated
    // "key stored in keyring" with "ApiKey is the active mode", which
    // hid stored keys from the Settings UI after a flip to
    // `CliSubscription` and trapped users in cli-only mode.

    #[test]
    fn normalize_backfills_api_key_stored_from_legacy_configured() {
        // Phase 3+4 shape: only configured_providers present, no
        // api_key_stored. After normalize the stored flag is derived.
        let json = r#"{
            "useLegacyClaudeCli": false,
            "defaultProvider": "anthropic",
            "defaultModel": "claude-sonnet-4-6",
            "plannerModel": "claude-haiku-4-5-20251001",
            "configuredProviders": {"anthropic": true, "openai": false}
        }"#;
        let mut p: ProvidersSettings = serde_json::from_str(json).unwrap();
        assert!(p.api_key_stored.is_empty(), "loaded without normalize");
        p.normalize_after_load();
        assert_eq!(p.api_key_stored.get("anthropic"), Some(&true));
        // openai was false (= None) — no backfill.
        assert!(!p.api_key_stored.contains_key("openai"));
    }

    #[test]
    fn normalize_backfills_from_phase5a_enum_shape() {
        // A user who re-saved settings after upgrading has enum form.
        // Normalize still fills api_key_stored for ApiKey entries.
        let json = r#"{
            "useLegacyClaudeCli": false,
            "defaultProvider": "anthropic",
            "defaultModel": "claude-sonnet-4-6",
            "plannerModel": "claude-haiku-4-5-20251001",
            "configuredProviders": {"anthropic": "api_key"}
        }"#;
        let mut p: ProvidersSettings = serde_json::from_str(json).unwrap();
        p.normalize_after_load();
        assert_eq!(p.api_key_stored.get("anthropic"), Some(&true));
    }

    #[test]
    fn normalize_does_not_backfill_cli_subscription_entries() {
        // Directly-activated CLI subscription (user never saved a key)
        // should NOT cause api_key_stored to be set. Otherwise
        // has_api_key_cmd would lie.
        let json = r#"{
            "useLegacyClaudeCli": false,
            "defaultProvider": "anthropic",
            "defaultModel": "claude-sonnet-4-6",
            "plannerModel": "claude-haiku-4-5-20251001",
            "configuredProviders": {"anthropic": "cli_subscription"}
        }"#;
        let mut p: ProvidersSettings = serde_json::from_str(json).unwrap();
        p.normalize_after_load();
        assert!(!p.api_key_stored.contains_key("anthropic"));
    }

    #[test]
    fn normalize_preserves_explicit_api_key_stored_under_cli_mode() {
        // The critical invariant: a user saved an API key, then flipped
        // to CliSubscription. On restart, configured_providers is
        // CliSubscription but api_key_stored[anthropic] is still true
        // (persisted by save_api_key_cmd, never cleared). Normalize
        // must leave that flag alone.
        let json = r#"{
            "useLegacyClaudeCli": false,
            "defaultProvider": "anthropic",
            "defaultModel": "claude-sonnet-4-6",
            "plannerModel": "claude-haiku-4-5-20251001",
            "configuredProviders": {"anthropic": "cli_subscription"},
            "apiKeyStored": {"anthropic": true}
        }"#;
        let mut p: ProvidersSettings = serde_json::from_str(json).unwrap();
        p.normalize_after_load();
        assert_eq!(p.api_key_stored.get("anthropic"), Some(&true));
        assert_eq!(
            p.configured_providers.get("anthropic"),
            Some(&AuthMode::CliSubscription)
        );
    }

    #[test]
    fn normalize_is_idempotent() {
        // Calling normalize twice must be a no-op after the first call.
        let json = r#"{
            "useLegacyClaudeCli": false,
            "defaultProvider": "anthropic",
            "defaultModel": "claude-sonnet-4-6",
            "plannerModel": "claude-haiku-4-5-20251001",
            "configuredProviders": {"anthropic": true}
        }"#;
        let mut p: ProvidersSettings = serde_json::from_str(json).unwrap();
        p.normalize_after_load();
        let after_once = p.api_key_stored.clone();
        p.normalize_after_load();
        assert_eq!(p.api_key_stored, after_once);
    }

    #[test]
    fn api_key_stored_roundtrips_through_serde() {
        let mut p = ProvidersSettings::default();
        p.configured_providers
            .insert("anthropic".to_string(), AuthMode::CliSubscription);
        p.api_key_stored.insert("anthropic".to_string(), true);

        let s = serde_json::to_string(&p).unwrap();
        assert!(s.contains("\"apiKeyStored\""));
        let back: ProvidersSettings = serde_json::from_str(&s).unwrap();
        assert_eq!(back.api_key_stored.get("anthropic"), Some(&true));
        assert_eq!(
            back.configured_providers.get("anthropic"),
            Some(&AuthMode::CliSubscription)
        );
    }

    // ── Scenario tests covering the user-facing bug repro ─────────────
    //
    // These simulate the Tauri command effects on ProvidersSettings
    // directly — the commands are thin wrappers around these mutations,
    // and testing state transitions here is faster than plumbing a full
    // `ManagedState` fixture.

    fn simulate_save_api_key(p: &mut ProvidersSettings, provider: &str) {
        p.configured_providers
            .insert(provider.to_string(), AuthMode::ApiKey);
        p.api_key_stored.insert(provider.to_string(), true);
    }

    fn simulate_set_auth_mode(p: &mut ProvidersSettings, provider: &str, mode: AuthMode) {
        p.configured_providers.insert(provider.to_string(), mode);
        // Intentional: api_key_stored untouched.
    }

    fn simulate_delete_api_key(p: &mut ProvidersSettings, provider: &str) {
        p.configured_providers
            .insert(provider.to_string(), AuthMode::None);
        p.api_key_stored.insert(provider.to_string(), false);
    }

    #[test]
    fn scenario_save_then_flip_to_cli_preserves_api_key_stored() {
        // User saves key → Anthropic card shows radios (api_only).
        // User clicks "CLI subscription" radio → set_auth_mode flips
        // configured_providers but NOT api_key_stored. has_api_key_cmd
        // must still return true so the card keeps showing both radios.
        let mut p = ProvidersSettings::default();
        simulate_save_api_key(&mut p, "anthropic");
        assert_eq!(p.api_key_stored.get("anthropic"), Some(&true));
        assert_eq!(
            p.configured_providers.get("anthropic"),
            Some(&AuthMode::ApiKey)
        );

        simulate_set_auth_mode(&mut p, "anthropic", AuthMode::CliSubscription);
        // ← the fix: api_key_stored unchanged.
        assert_eq!(p.api_key_stored.get("anthropic"), Some(&true));
        assert_eq!(
            p.configured_providers.get("anthropic"),
            Some(&AuthMode::CliSubscription)
        );
    }

    #[test]
    fn scenario_flip_back_to_api_key_still_has_stored_key() {
        // Continuation: user flips back to API key via radio. The
        // stored keyring entry survived (never deleted), so sending
        // a message would load the key successfully.
        let mut p = ProvidersSettings::default();
        simulate_save_api_key(&mut p, "anthropic");
        simulate_set_auth_mode(&mut p, "anthropic", AuthMode::CliSubscription);
        simulate_set_auth_mode(&mut p, "anthropic", AuthMode::ApiKey);
        assert_eq!(p.api_key_stored.get("anthropic"), Some(&true));
        assert_eq!(
            p.configured_providers.get("anthropic"),
            Some(&AuthMode::ApiKey)
        );
    }

    #[test]
    fn scenario_delete_clears_both_flags() {
        // Delete is the only path that clears api_key_stored. Even if
        // the active mode was CliSubscription, deleting the key must
        // clear both so a later ApiKey selection doesn't try to load
        // a nonexistent keyring entry.
        let mut p = ProvidersSettings::default();
        simulate_save_api_key(&mut p, "anthropic");
        simulate_set_auth_mode(&mut p, "anthropic", AuthMode::CliSubscription);
        simulate_delete_api_key(&mut p, "anthropic");
        assert_eq!(p.api_key_stored.get("anthropic"), Some(&false));
        assert_eq!(
            p.configured_providers.get("anthropic"),
            Some(&AuthMode::None)
        );
    }

    #[test]
    fn scenario_cli_only_user_never_gets_false_has_api_key() {
        // A user who came in fresh, saw cli_only state, clicked
        // Activate — never saved a key. api_key_stored stays absent
        // (interpreted as false by has_api_key_cmd).
        let mut p = ProvidersSettings::default();
        simulate_set_auth_mode(&mut p, "anthropic", AuthMode::CliSubscription);
        assert!(!p.api_key_stored.contains_key("anthropic"));
    }

    #[test]
    fn full_settings_with_legacy_bool_configured_providers_loads() {
        // End-to-end: a real Phase 3+4 settings.json (bool shape) loaded
        // through AppSettings deserialization yields AuthMode-normalized
        // state. This is the migration-gate test §4.2 calls out.
        let json = r#"{
            "general": {"restoreLastWorkspace": true, "launchAtLogin": false, "language": "en"},
            "agents": {"defaultPermissions": {"fileWrite": false, "bash": false, "network": false}},
            "appearance": {"chatFontSize": 14},
            "shortcuts": {"textExpansions": []},
            "advanced": {"defaultAgentModel": "opus", "autoModelSelection": false},
            "versionControl": {"autoCommit": true},
            "providers": {
                "useLegacyClaudeCli": false,
                "defaultProvider": "anthropic",
                "defaultModel": "claude-sonnet-4-6",
                "plannerModel": "claude-haiku-4-5-20251001",
                "configuredProviders": {"anthropic": true, "openai": false}
            }
        }"#;
        let s: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(
            s.providers.configured_providers.get("anthropic"),
            Some(&AuthMode::ApiKey)
        );
        assert_eq!(
            s.providers.configured_providers.get("openai"),
            Some(&AuthMode::None)
        );
    }
}
