use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

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

/// OctoFile — represents a .octo agent file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OctoFile {
    pub path: String,
    pub name: String,
    pub role: String,
    #[serde(default = "default_icon")]
    pub icon: String,
    pub color: Option<String>,
    pub hidden: Option<bool>,
    pub permissions: Option<OctoPermissions>,
    #[serde(rename = "mcpServers")]
    pub mcp_servers: Option<serde_json::Value>,
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
    #[serde(rename = "observerModel")]
    pub observer_model: String,
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
                observer_model: "haiku".to_string(),
                default_agent_model: "opus".to_string(),
                auto_model_selection: false,
            },
            version_control: VersionControlSettings { auto_commit: true },
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
        let settings = if settings_file.exists() {
            fs::read_to_string(&settings_file)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            AppSettings::default()
        };

        Self {
            app_state: Mutex::new(app_state),
            settings: Mutex::new(settings),
            running_agents: Arc::new(Mutex::new(HashMap::new())),
            interrupted_runs: Arc::new(Mutex::new(HashSet::new())),
            permanent_grants: Mutex::new(HashSet::new()),
            folder_watchers: Arc::new(Mutex::new(HashMap::new())),
            state_dir,
            is_dev,
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
