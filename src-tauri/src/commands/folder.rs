use crate::state::{AppState, HistoryMessage, ManagedState, OctoFile};
use serde::Serialize;
use std::fs;
use std::path::Path;
use tauri::State;

#[derive(Serialize)]
pub struct PagedHistory {
    pub messages: Vec<HistoryMessage>,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
}

#[tauri::command]
pub fn pick_folder(
    workspace_id: String,
    state: State<'_, ManagedState>,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let result = app
        .dialog()
        .file()
        .blocking_pick_folder();

    match result {
        Some(path) => {
            let folder_path = path.to_string();
            let mut s = state.app_state.lock().map_err(|e| e.to_string())?;
            if let Some(ws) = s.workspaces.iter_mut().find(|w| w.id == workspace_id) {
                if !ws.folders.contains(&folder_path) {
                    ws.folders.push(folder_path.clone());
                }
            }
            drop(s);
            state.save_state()?;
            Ok(Some(folder_path))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub fn remove_folder(
    workspace_id: String,
    folder_path: String,
    state: State<'_, ManagedState>,
) -> Result<AppState, String> {
    let mut s = state.app_state.lock().map_err(|e| e.to_string())?;
    if let Some(ws) = s.workspaces.iter_mut().find(|w| w.id == workspace_id) {
        ws.folders.retain(|f| f != &folder_path);
    }
    let result = s.clone();
    drop(s);
    state.save_state()?;
    Ok(result)
}

#[tauri::command]
pub fn list_octos(folder_path: String) -> Result<Vec<OctoFile>, String> {
    let dir = Path::new(&folder_path);
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut octos = vec![];
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("octo") {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(octo) = serde_json::from_str::<serde_json::Value>(&content) {
                    let name = octo
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    let role = octo
                        .get("role")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    let icon = octo
                        .get("icon")
                        .and_then(|v| v.as_str())
                        .unwrap_or("🤖")
                        .to_string();
                    let color = octo
                        .get("color")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let hidden = octo.get("hidden").and_then(|v| v.as_bool());
                    let permissions = octo
                        .get("permissions")
                        .and_then(|v| serde_json::from_value(v.clone()).ok());
                    let mcp_servers = octo.get("mcpServers").cloned();

                    octos.push(OctoFile {
                        path: path.to_string_lossy().to_string(),
                        name,
                        role,
                        icon,
                        color,
                        hidden,
                        permissions,
                        mcp_servers,
                    });
                }
            }
        }
    }
    octos.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(octos)
}

#[tauri::command]
pub fn load_history(folder_path: String) -> Result<Vec<HistoryMessage>, String> {
    let history_file = Path::new(&folder_path)
        .join(".octopal")
        .join("room-history.json");
    if !history_file.exists() {
        return Ok(vec![]);
    }
    let content = fs::read_to_string(&history_file).map_err(|e| e.to_string())?;
    let messages: Vec<HistoryMessage> = serde_json::from_str(&content).unwrap_or_default();
    Ok(messages)
}

#[tauri::command]
pub fn load_history_paged(
    folder_path: String,
    limit: usize,
    before_ts: Option<f64>,
) -> Result<PagedHistory, String> {
    let history_file = Path::new(&folder_path)
        .join(".octopal")
        .join("room-history.json");
    if !history_file.exists() {
        return Ok(PagedHistory {
            messages: vec![],
            has_more: false,
        });
    }
    let content = fs::read_to_string(&history_file).map_err(|e| e.to_string())?;
    let all: Vec<HistoryMessage> = serde_json::from_str(&content).unwrap_or_default();

    let filtered: Vec<_> = if let Some(ts) = before_ts {
        all.into_iter().filter(|m| m.ts < ts).collect()
    } else {
        all
    };

    let total = filtered.len();
    let start = if total > limit { total - limit } else { 0 };
    let messages = filtered[start..].to_vec();
    let has_more = start > 0;

    Ok(PagedHistory { messages, has_more })
}

#[tauri::command]
pub fn append_user_message(
    folder_path: String,
    id: String,
    ts: f64,
    text: String,
    attachments: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let octopal_dir = Path::new(&folder_path).join(".octopal");
    fs::create_dir_all(&octopal_dir).map_err(|e| e.to_string())?;
    let history_file = octopal_dir.join("room-history.json");

    let mut messages: Vec<serde_json::Value> = if history_file.exists() {
        let content = fs::read_to_string(&history_file).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        vec![]
    };

    let mut msg = serde_json::json!({
        "id": id,
        "agentName": "You",
        "text": text,
        "ts": ts,
    });
    if let Some(att) = attachments {
        msg["attachments"] = att;
    }
    messages.push(msg);

    let json = serde_json::to_string_pretty(&messages).map_err(|e| e.to_string())?;
    fs::write(&history_file, json).map_err(|e| e.to_string())?;

    Ok(serde_json::json!({ "ok": true }))
}
