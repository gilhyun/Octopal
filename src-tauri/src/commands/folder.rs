use crate::commands::octo::sanitize_role;
use crate::state::{AppState, HistoryMessage, ManagedState, OctoFile};
use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

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

    // Do not display a privileged native picker for an attacker-supplied or
    // stale workspace identifier. The workspace may still be removed while
    // the dialog is open, so it is checked again before persisting below.
    {
        let s = state.app_state.lock().map_err(|e| e.to_string())?;
        if !s
            .workspaces
            .iter()
            .any(|workspace| workspace.id == workspace_id)
        {
            return Err("workspace not found".to_string());
        }
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });

    let result = rx.await.map_err(|e| e.to_string())?;

    match result {
        Some(path) => {
            let selected = std::path::PathBuf::from(path.to_string());
            let canonical = fs::canonicalize(&selected)
                .map_err(|e| format!("selected folder is unavailable: {e}"))?;
            if !canonical.is_dir() {
                return Err("selected path is not a directory".to_string());
            }
            let folder_path = canonical.to_string_lossy().into_owned();
            {
                let mut s = state.app_state.lock().map_err(|e| e.to_string())?;
                let ws = s
                    .workspaces
                    .iter_mut()
                    .find(|w| w.id == workspace_id)
                    .ok_or_else(|| "workspace was removed while choosing a folder".to_string())?;
                if !ws.folders.contains(&folder_path) {
                    ws.folders.push(folder_path.clone());
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

/// The subfolder inside each workspace folder where .octo agent files live.
const AGENTS_DIR: &str = "octopal-agents";

/// Set up a filesystem watcher that notifies the frontend when agent files
/// (config.json / prompt.md) in the folder change (created, modified, deleted).
/// Debounced to 150ms so a single save that fires multiple events collapses
/// into one emit.
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
    let last_scheduled: Arc<StdMutex<Option<Instant>>> = Arc::new(StdMutex::new(None));

    let mut watcher =
        match notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            let event = match res {
                Ok(e) => e,
                Err(_) => return,
            };
            let has_agent_file = event.paths.iter().any(|p| {
                let ext = p.extension().and_then(|e| e.to_str());
                ext == Some("json") || ext == Some("md") || ext == Some("octo")
            });
            let has_history = event
                .paths
                .iter()
                .any(|p| p.file_name().and_then(|n| n.to_str()) == Some("room-history.json"));
            if !has_agent_file && !has_history {
                return;
            }
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
        }) {
            Ok(w) => w,
            Err(_) => return,
        };

    let mut watch_ok = false;

    // Watch octopal-agents/ recursively (each agent is a subfolder now)
    let agents_dir = Path::new(folder_path).join(AGENTS_DIR);
    if agents_dir.is_dir() {
        watch_ok = watcher.watch(&agents_dir, RecursiveMode::Recursive).is_ok();
    }

    // Also watch root for legacy .octo files (migration period)
    if watcher
        .watch(Path::new(folder_path), RecursiveMode::NonRecursive)
        .is_ok()
    {
        watch_ok = true;
    }

    // Watch .octopal/ subdir for room-history.json
    let octopal_dir = Path::new(folder_path).join(".octopal");
    if octopal_dir.is_dir() {
        let _ = watcher.watch(&octopal_dir, RecursiveMode::NonRecursive);
    }
    if watch_ok {
        watchers.insert(folder_path.to_string(), watcher);
    }
}

/// Migrate legacy agent files into the v3 subfolder structure:
///   `octopal-agents/{name}/config.json` + `prompt.md`
///
/// Handles three legacy layouts:
///   Case 1: Root `.octo` files  →  subfolder
///   Case 2: Flat `octopal-agents/{name}.json` + `{name}.md`  →  subfolder
///   Case 3: Root `.octo` files already inside `octopal-agents/`
///
/// Migration uses **copy** (originals are preserved for safety).
fn migration_source(root: &Path, candidate: &Path) -> Result<std::path::PathBuf, String> {
    let relative = candidate
        .strip_prefix(root)
        .map_err(|_| "legacy agent path escaped the workspace".to_string())?;
    crate::commands::path_guard::existing_regular_file_path(root, relative)
}

fn migration_destinations(
    root: &Path,
    stem: &str,
) -> Result<(std::path::PathBuf, std::path::PathBuf, std::path::PathBuf), String> {
    crate::commands::path_guard::safe_segment(stem, "legacy agent name")?;
    let sub_relative = Path::new(AGENTS_DIR).join(stem);
    let sub_dir = crate::commands::path_guard::write_target_path(root, &sub_relative)?;
    let config_dest =
        crate::commands::path_guard::write_target_path(root, &sub_relative.join("config.json"))?;
    let prompt_dest =
        crate::commands::path_guard::write_target_path(root, &sub_relative.join("prompt.md"))?;
    Ok((sub_dir, config_dest, prompt_dest))
}

fn write_migrated_file(path: &Path, contents: &[u8]) -> Result<bool, String> {
    crate::commands::atomic_file::with_path_lock(path, || {
        if path.exists() {
            return Ok(false);
        }
        crate::commands::atomic_file::atomic_write(path, contents)?;
        Ok(true)
    })
}

fn migrate_octo_files(folder_path: &str) {
    let root = match fs::canonicalize(folder_path) {
        Ok(path) if path.is_dir() => path,
        _ => return,
    };
    let agents_dir = match crate::commands::path_guard::write_target(&root, AGENTS_DIR) {
        Ok(path) => path,
        Err(error) => {
            eprintln!("[octopal] refusing unsafe agent migration path: {error}");
            return;
        }
    };

    // Always ensure octopal-agents/ exists (even for fresh folders with no legacy files).
    if let Err(error) = fs::create_dir_all(&agents_dir) {
        eprintln!(
            "[octopal] failed to create {}: {error}",
            agents_dir.display()
        );
        return;
    }

    // ── Case 1 & 3: Collect legacy .octo files from root and octopal-agents/ ──
    let mut legacy_octos = Vec::new();
    for search_dir in [root.clone(), agents_dir.clone()] {
        if let Ok(entries) = fs::read_dir(&search_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let is_regular = entry
                    .file_type()
                    .map(|kind| kind.is_file())
                    .unwrap_or(false);
                if path.extension().and_then(|x| x.to_str()) == Some("octo") && is_regular {
                    legacy_octos.push(path);
                }
            }
        }
    }

    // ── Case 2: Collect flat .json files in octopal-agents/ ──
    let mut flat_jsons = Vec::new();
    if let Ok(entries) = fs::read_dir(&agents_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
                && path.extension().and_then(|x| x.to_str()) == Some("json")
                && path.file_name().and_then(|n| n.to_str()) != Some("config.json")
            {
                flat_jsons.push(path);
            }
        }
    }

    // ── Migrate .octo files ──
    for enumerated_src in legacy_octos {
        // Re-resolve immediately before reading; directory entries can be
        // swapped after enumeration and must never turn into symlink reads.
        let src = match migration_source(&root, &enumerated_src) {
            Ok(path) => path,
            Err(error) => {
                eprintln!("[octopal] refusing unsafe legacy file: {error}");
                continue;
            }
        };
        let stem = match src.file_stem().and_then(|s| s.to_str()) {
            Some(stem)
                if crate::commands::path_guard::safe_segment(stem, "legacy agent name").is_ok() =>
            {
                stem.to_string()
            }
            _ => continue,
        };
        let (sub_dir, _, _) = match migration_destinations(&root, &stem) {
            Ok(paths) => paths,
            Err(error) => {
                eprintln!("[octopal] refusing unsafe migration destination: {error}");
                continue;
            }
        };

        let content = match fs::read_to_string(&src) {
            Ok(content) => content,
            Err(error) => {
                eprintln!("[octopal] failed to read {}: {error}", src.display());
                continue;
            }
        };
        let mut octo: serde_json::Value = match serde_json::from_str(&content) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("[octopal] failed to parse {}: {error}", src.display());
                continue;
            }
        };
        let role = octo
            .get("role")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string();
        if let Some(object) = octo.as_object_mut() {
            object.remove("history");
        }
        let config = match serde_json::to_vec_pretty(&octo) {
            Ok(config) => config,
            Err(error) => {
                eprintln!("[octopal] failed to serialize {stem}: {error}");
                continue;
            }
        };
        if let Err(error) = fs::create_dir_all(&sub_dir) {
            eprintln!("[octopal] failed to create {}: {error}", sub_dir.display());
            continue;
        }
        let (_, config_dest, prompt_dest) = match migration_destinations(&root, &stem) {
            Ok(paths) => paths,
            Err(error) => {
                eprintln!("[octopal] migration path changed while creating it: {error}");
                continue;
            }
        };
        let wrote_config = match write_migrated_file(&config_dest, &config) {
            Ok(wrote) => wrote,
            Err(error) => {
                eprintln!(
                    "[octopal] failed to write {}: {error}",
                    config_dest.display()
                );
                continue;
            }
        };
        if !wrote_config {
            continue;
        }
        if !role.is_empty() {
            if let Err(error) = write_migrated_file(&prompt_dest, role.as_bytes()) {
                eprintln!(
                    "[octopal] failed to write {}: {error}",
                    prompt_dest.display()
                );
            }
        }

        if let Err(error) = fs::remove_file(&src) {
            eprintln!(
                "[octopal] migrated but failed to remove {}: {error}",
                src.display()
            );
        } else {
            eprintln!(
                "[octopal] migrated .octo {} → {}/config.json",
                src.display(),
                sub_dir.display()
            );
        }
    }

    // ── Migrate flat .json + .md files ──
    for enumerated_src in flat_jsons {
        let src = match migration_source(&root, &enumerated_src) {
            Ok(path) => path,
            Err(_) => continue,
        };
        let stem = match src.file_stem().and_then(|s| s.to_str()) {
            Some(stem)
                if crate::commands::path_guard::safe_segment(stem, "legacy agent name").is_ok() =>
            {
                stem.to_string()
            }
            _ => continue,
        };
        let (sub_dir, _, _) = match migration_destinations(&root, &stem) {
            Ok(paths) => paths,
            Err(_) => continue,
        };
        let content = match fs::read(&src) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let json_val: serde_json::Value = match serde_json::from_slice(&content) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if json_val
            .get("name")
            .and_then(|value| value.as_str())
            .is_none()
        {
            continue;
        }
        if fs::create_dir_all(&sub_dir).is_err() {
            continue;
        }
        let (_, config_dest, prompt_dest) = match migration_destinations(&root, &stem) {
            Ok(paths) => paths,
            Err(_) => continue,
        };
        let wrote_config = match write_migrated_file(&config_dest, &content) {
            Ok(wrote) => wrote,
            Err(error) => {
                eprintln!("[octopal] failed to copy {}: {error}", src.display());
                continue;
            }
        };
        if !wrote_config {
            continue;
        }

        let old_md_candidate = agents_dir.join(format!("{stem}.md"));
        let mut migrated_prompt = None;
        if let Ok(old_md) = migration_source(&root, &old_md_candidate) {
            if let Ok(prompt) = fs::read(&old_md) {
                if write_migrated_file(&prompt_dest, &prompt).is_ok() {
                    migrated_prompt = Some(old_md);
                }
            }
        }

        if let Err(error) = fs::remove_file(&src) {
            eprintln!(
                "[octopal] migrated but failed to remove {}: {error}",
                src.display()
            );
        }
        if let Some(old_md) = migrated_prompt {
            let _ = fs::remove_file(old_md);
        }
        eprintln!(
            "[octopal] migrated flat {} → {}/config.json",
            src.display(),
            sub_dir.display()
        );
    }
}

/// Parse agent config files from a directory.
///
/// **v3 (primary)**: Each agent is a subfolder with `config.json` inside.
///   `octopal-agents/developer/config.json`
///
/// **Legacy fallback**: Flat `.json` / `.octo` files in the directory itself
/// are still picked up during the migration period.
fn collect_octos_from_dir(dir: &Path, octos: &mut Vec<OctoFile>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        // v3 subfolder: {dir}/{agent_name}/config.json
        if file_type.is_dir() {
            let config_path = path.join("config.json");
            if fs::symlink_metadata(&config_path)
                .map(|meta| meta.is_file() && !meta.file_type().is_symlink())
                .unwrap_or(false)
            {
                if let Some(octo) = parse_agent_config(&config_path) {
                    octos.push(octo);
                }
            }
            continue;
        }

        // Legacy flat files: {dir}/{name}.json or {dir}/{name}.octo
        if file_type.is_file() {
            let ext = path.extension().and_then(|e| e.to_str());
            if ext == Some("json") || ext == Some("octo") {
                if let Some(octo) = parse_agent_config(&path) {
                    octos.push(octo);
                }
            }
        }
    }
}

/// Read a single agent config file and return an `OctoFile` if valid.
fn parse_agent_config(path: &Path) -> Option<OctoFile> {
    let content = fs::read_to_string(path).ok()?;
    let octo: serde_json::Value = serde_json::from_str(&content).ok()?;

    let name = octo
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|n| !n.is_empty())?;
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
    // Phase 3: optional per-agent overrides. Legacy .octo files without
    // these keys produce None; agents with them read through.
    let provider = octo
        .get("provider")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let model = octo
        .get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Some(OctoFile {
        path: path.to_string_lossy().to_string(),
        name: name.to_string(),
        role,
        icon,
        color,
        hidden,
        isolated,
        permissions,
        mcp_servers,
        provider,
        model,
    })
}

#[tauri::command]
pub fn list_octos(
    folder_path: String,
    state: State<'_, ManagedState>,
    app: AppHandle,
) -> Result<Vec<OctoFile>, String> {
    let dir = crate::commands::path_guard::registered_folder(&state, Path::new(&folder_path))?;
    let canonical_folder = dir.to_string_lossy().into_owned();
    let agents_candidate = dir.join(AGENTS_DIR);
    if fs::symlink_metadata(&agents_candidate)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("octopal-agents may not be a symlink".to_string());
    }

    // Auto-migrate legacy .octo files → .json + .md
    migrate_octo_files(&canonical_folder);

    // Start watching this folder for agent file changes (idempotent).
    ensure_folder_watcher(&canonical_folder, &state, &app);

    let mut octos = vec![];

    // Only scan octopal-agents/ subfolder — NOT the project root.
    // Previously we also scanned the root for legacy .json files, but that
    // caused package.json ({"name":"octopal",...}) to be mistakenly parsed
    // as an agent, creating a phantom "octopal" agent with full permissions.
    let agents_dir = dir.join(AGENTS_DIR);
    collect_octos_from_dir(&agents_dir, &mut octos);

    // If no agents found at all, create a default "assistant" agent
    if octos.is_empty() {
        let result = crate::commands::octo::create_octo_in_registered_folder(
            dir.clone(),
            "assistant".to_string(),
            "General assistant. Scans the project, answers questions, and helps with tasks."
                .to_string(),
            None,
            Some("🐙".to_string()),
            None,
            None,
            None,
            // Phase 6: default assistant inherits workspace provider/model
            // (None ⇒ omitted from config.json ⇒ resolve_for_turn falls
            // back to settings).
            None,
            None,
        );
        if result.ok {
            if let Some(ref path) = result.path {
                let config_path = Path::new(path);
                if let Some(octo) = parse_agent_config(config_path) {
                    octos.push(octo);
                }
            }
        }
    }

    octos.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(octos)
}

#[tauri::command]
pub fn load_history(
    folder_path: String,
    state: State<'_, ManagedState>,
) -> Result<Vec<HistoryMessage>, String> {
    let folder = crate::commands::path_guard::registered_folder(&state, Path::new(&folder_path))?;
    let history_file =
        crate::commands::path_guard::write_target(&folder, ".octopal/room-history.json")?;
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
    state: State<'_, ManagedState>,
) -> Result<PagedHistory, String> {
    let folder = crate::commands::path_guard::registered_folder(&state, Path::new(&folder_path))?;
    let history_file =
        crate::commands::path_guard::write_target(&folder, ".octopal/room-history.json")?;
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
    let start = total.saturating_sub(limit);
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
pub fn read_pending_state(
    folder_path: String,
    state: State<'_, ManagedState>,
) -> Result<serde_json::Value, String> {
    let folder = crate::commands::path_guard::registered_folder(&state, Path::new(&folder_path))?;
    let path = crate::commands::path_guard::write_target(&folder, ".octopal/pending.json")?;
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str::<serde_json::Value>(&content)
        .unwrap_or_else(|_| serde_json::json!({})))
}

/// Write the pending-handoff state blob for a folder. Overwrites any
/// existing file. Pass an empty object `{}` to clear.
#[tauri::command]
pub fn write_pending_state(
    folder_path: String,
    state: serde_json::Value,
    managed_state: State<'_, ManagedState>,
) -> Result<(), String> {
    let folder =
        crate::commands::path_guard::registered_folder(&managed_state, Path::new(&folder_path))?;
    let dir = crate::commands::path_guard::write_target(&folder, ".octopal")?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = crate::commands::path_guard::write_target(&folder, ".octopal/pending.json")?;
    crate::commands::atomic_file::with_path_lock(&path, || {
        crate::commands::atomic_file::atomic_write_json(&path, &state)
    })
}

#[tauri::command]
pub fn append_user_message(
    folder_path: String,
    id: String,
    ts: f64,
    text: String,
    attachments: Option<serde_json::Value>,
    state: State<'_, ManagedState>,
) -> Result<serde_json::Value, String> {
    let folder = crate::commands::path_guard::registered_folder(&state, Path::new(&folder_path))?;
    let octopal_dir = crate::commands::path_guard::write_target(&folder, ".octopal")?;
    fs::create_dir_all(&octopal_dir).map_err(|e| e.to_string())?;
    let history_file =
        crate::commands::path_guard::write_target(&folder, ".octopal/room-history.json")?;

    crate::commands::atomic_file::with_path_lock(&history_file, || {
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
        crate::commands::atomic_file::atomic_write_json(&history_file, &messages)
    })?;

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
fn history_archive_dir(history_file: &Path) -> Result<std::path::PathBuf, String> {
    let octopal_dir = history_file
        .parent()
        .ok_or_else(|| "history file has no parent".to_string())?;
    if octopal_dir.file_name().and_then(|name| name.to_str()) != Some(".octopal") {
        return Err("history file is not inside .octopal".to_string());
    }
    let workspace_root = octopal_dir
        .parent()
        .ok_or_else(|| "history file has no workspace root".to_string())?;
    crate::commands::path_guard::write_target(workspace_root, ".octopal/archive")
}

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

    let archive_dir = match history_archive_dir(history_file) {
        Ok(path) => path,
        Err(_) => return,
    };
    let workspace_root = match archive_dir
        .parent()
        .and_then(|octopal_dir| octopal_dir.parent())
    {
        Some(root) => root,
        None => return,
    };
    if fs::create_dir_all(&archive_dir).is_err() {
        return;
    }

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let archive_path = match crate::commands::path_guard::write_target(
        workspace_root,
        &format!(".octopal/archive/room-history-{ts}.json"),
    ) {
        Ok(path) => path,
        Err(_) => return,
    };

    if crate::commands::atomic_file::atomic_write_json(&archive_path, &archive).is_ok()
        && crate::commands::atomic_file::atomic_write_json(history_file, &keep).is_ok()
    {
        eprintln!(
            "[octopal] rotated room-history: {} msgs archived to {}",
            archive.len(),
            archive_path.display()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(label: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "octopal-folder-test-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn legacy_migration_uses_safe_destinations_and_removes_history() {
        let root = temp_workspace("migration");
        let legacy = root.join("assistant.octo");
        fs::write(
            &legacy,
            r#"{"name":"assistant","role":"Helpful","history":[{"text":"private"}]}"#,
        )
        .unwrap();

        migrate_octo_files(root.to_str().unwrap());

        let config = root.join("octopal-agents/assistant/config.json");
        let prompt = root.join("octopal-agents/assistant/prompt.md");
        assert!(!legacy.exists());
        assert!(config.is_file());
        assert_eq!(fs::read_to_string(prompt).unwrap(), "Helpful");
        let migrated: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(config).unwrap()).unwrap();
        assert!(migrated.get("history").is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn legacy_migration_rejects_windows_reserved_stems() {
        let root = temp_workspace("reserved");
        let legacy = root.join("CON.octo");
        fs::write(&legacy, r#"{"name":"CON","role":"Unsafe"}"#).unwrap();

        migrate_octo_files(root.to_str().unwrap());

        assert!(legacy.exists());
        assert!(!root.join("octopal-agents/CON/config.json").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn legacy_migration_never_reads_symlink_sources() {
        use std::os::unix::fs::symlink;

        let root = temp_workspace("migration-symlink");
        let outside = temp_workspace("migration-outside").join("outside.octo");
        fs::write(&outside, r#"{"name":"escape","role":"Unsafe"}"#).unwrap();
        let alias = root.join("escape.octo");
        symlink(&outside, &alias).unwrap();

        migrate_octo_files(root.to_str().unwrap());

        assert!(alias.symlink_metadata().unwrap().file_type().is_symlink());
        assert!(!root.join("octopal-agents/escape/config.json").exists());
        let outside_root = outside.parent().unwrap().to_path_buf();
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside_root);
    }

    #[cfg(unix)]
    #[test]
    fn history_archive_rejects_symlink_directory() {
        use std::os::unix::fs::symlink;

        let root = temp_workspace("archive-symlink");
        let outside = temp_workspace("archive-outside");
        fs::create_dir_all(root.join(".octopal")).unwrap();
        let history = root.join(".octopal/room-history.json");
        fs::write(&history, "[]").unwrap();
        symlink(&outside, root.join(".octopal/archive")).unwrap();

        assert!(history_archive_dir(&history).is_err());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }
}
