use crate::commands::octo::sanitize_role;
use crate::state::{AppState, HistoryMessage, ManagedState, OctoFile};
use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Serialize)]
pub struct PagedHistory {
    pub messages: Vec<HistoryMessage>,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
}

#[tauri::command]
pub async fn pick_folder(
    workspace_id: String,
    state: State<'_, ManagedState>,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });

    let result = rx.await.map_err(|e| e.to_string())?;

    match result {
        Some(path) => {
            let folder_path = path.to_string();
            // Allow the asset protocol to serve files from this folder
            let _ = app
                .asset_protocol_scope()
                .allow_directory(std::path::Path::new(&folder_path), true);
            {
                let mut s = state.app_state.lock().map_err(|e| e.to_string())?;
                if let Some(ws) = s.workspaces.iter_mut().find(|w| w.id == workspace_id) {
                    if !ws.folders.contains(&folder_path) {
                        ws.folders.push(folder_path.clone());
                    }
                }
            }
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

/// Set up a filesystem watcher that notifies the frontend when .octo files
/// in the folder change (created, modified, deleted). Debounced to 150ms so
/// a single save that fires multiple events collapses into one emit.
fn ensure_folder_watcher(folder_path: &str, state: &State<'_, ManagedState>, app: &AppHandle) {
    let mut watchers = match state.folder_watchers.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if watchers.contains_key(folder_path) {
        return;
    }

    let folder_clone = folder_path.to_string();
    let app_clone = app.clone();
    // Leading-edge debounce: when an event arrives, schedule an emit 150ms later
    // and ignore further events until that emit fires.
    let last_scheduled: Arc<StdMutex<Option<Instant>>> = Arc::new(StdMutex::new(None));

    let mut watcher = match notify::recommended_watcher(
        move |res: Result<notify::Event, notify::Error>| {
            let event = match res {
                Ok(e) => e,
                Err(_) => return,
            };
            let has_octo = event.paths.iter().any(|p| {
                p.extension().and_then(|e| e.to_str()) == Some("octo")
            });
            let has_history = event.paths.iter().any(|p| {
                p.file_name().and_then(|n| n.to_str()) == Some("room-history.json")
            });
            if !has_octo && !has_history {
                return;
            }
            // Rate-limit: if an emit was scheduled <150ms ago, skip.
            {
                let mut ls = match last_scheduled.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                if let Some(t) = *ls {
                    if t.elapsed() < Duration::from_millis(150) {
                        return;
                    }
                }
                *ls = Some(Instant::now());
            }
            let app_spawn = app_clone.clone();
            let folder_spawn = folder_clone.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(150)).await;
                let _ = app_spawn.emit("folder:octosChanged", folder_spawn);
            });
        },
    ) {
        Ok(w) => w,
        Err(_) => return,
    };

    // Watch root for .octo files + .octopal/ subdir for room-history.json
    let root_ok = watcher
        .watch(Path::new(folder_path), RecursiveMode::NonRecursive)
        .is_ok();
    let octopal_dir = Path::new(folder_path).join(".octopal");
    if octopal_dir.is_dir() {
        let _ = watcher.watch(&octopal_dir, RecursiveMode::NonRecursive);
    }
    if root_ok {
        watchers.insert(folder_path.to_string(), watcher);
    }
}

#[tauri::command]
pub fn list_octos(
    folder_path: String,
    state: State<'_, ManagedState>,
    app: AppHandle,
) -> Result<Vec<OctoFile>, String> {
    let dir = Path::new(&folder_path);
    if !dir.is_dir() {
        return Ok(vec![]);
    }

    // Start watching this folder for .octo changes (idempotent).
    ensure_folder_watcher(&folder_path, &state, &app);
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
                    let role = sanitize_role(
                        octo.get("role")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default(),
                    );
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
                    let isolated = octo.get("isolated").and_then(|v| v.as_bool());
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
                        isolated,
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

/// Read the pending-handoff state blob for a folder. Returns an empty
/// object if the file doesn't exist or is malformed.
///
/// Pending handoffs are transient UI state — they hold the "waiting on user
/// approval" hook for a chain that was parked mid-flight. Persisting them
/// means a window reload or crash doesn't strand the approval buttons.
#[tauri::command]
pub fn read_pending_state(folder_path: String) -> Result<serde_json::Value, String> {
    let path = Path::new(&folder_path).join(".octopal").join("pending.json");
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str::<serde_json::Value>(&content).unwrap_or_else(|_| serde_json::json!({})))
}

/// Write the pending-handoff state blob for a folder. Overwrites any
/// existing file. Pass an empty object `{}` to clear.
#[tauri::command]
pub fn write_pending_state(
    folder_path: String,
    state: serde_json::Value,
) -> Result<(), String> {
    let dir = Path::new(&folder_path).join(".octopal");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("pending.json");
    let json = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
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

    maybe_rotate_room_history(&history_file);

    let mut messages: Vec<serde_json::Value> = if history_file.exists() {
        let content = fs::read_to_string(&history_file).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        vec![]
    };

    let mut msg = serde_json::json!({
        "id": id,
        "agentName": "user",
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

/// Archive `room-history.json` when it gets too large.
///
/// When the file exceeds `MAX_SIZE_BYTES`, we split it: the oldest 80% of
/// messages move to `archive/room-history-<ts>.json`, the newest 20% stay in
/// `room-history.json`. This keeps recent scrolling fast without losing
/// anything — users can still browse old archives manually.
///
/// Called opportunistically from append paths; failure is non-fatal.
pub fn maybe_rotate_room_history(history_file: &Path) {
    /// 10 MB — rotate when the file crosses this. A typical chat turn with
    /// no attachments is 1-3 KB, so this covers ~3000-10000 turns before
    /// rotation kicks in.
    const MAX_SIZE_BYTES: u64 = 10 * 1024 * 1024;

    let metadata = match fs::metadata(history_file) {
        Ok(m) => m,
        Err(_) => return,
    };
    if metadata.len() < MAX_SIZE_BYTES {
        return;
    }

    let content = match fs::read_to_string(history_file) {
        Ok(c) => c,
        Err(_) => return,
    };
    let messages: Vec<serde_json::Value> = match serde_json::from_str(&content) {
        Ok(m) => m,
        Err(_) => return,
    };
    if messages.len() < 100 {
        return; // Don't rotate tiny files even if they're heavy (big attachments)
    }

    let split = (messages.len() * 80) / 100;
    let archive: Vec<_> = messages[..split].to_vec();
    let keep: Vec<_> = messages[split..].to_vec();

    let parent = match history_file.parent() {
        Some(p) => p,
        None => return,
    };
    let archive_dir = parent.join("archive");
    if fs::create_dir_all(&archive_dir).is_err() {
        return;
    }

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let archive_path = archive_dir.join(format!("room-history-{}.json", ts));

    if let Ok(archive_json) = serde_json::to_string_pretty(&archive) {
        if fs::write(&archive_path, archive_json).is_ok() {
            if let Ok(keep_json) = serde_json::to_string_pretty(&keep) {
                let _ = fs::write(history_file, keep_json);
                eprintln!(
                    "[octopal] rotated room-history: {} msgs archived to {}",
                    archive.len(),
                    archive_path.display()
                );
            }
        }
    }
}
