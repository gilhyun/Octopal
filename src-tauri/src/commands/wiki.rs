use crate::state::ManagedState;
use serde::Serialize;
use std::fs;
use tauri::State;

#[derive(Serialize)]
pub struct WikiPage {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub mtime: f64,
}

#[tauri::command]
pub fn wiki_list(workspace_id: String, state: State<'_, ManagedState>) -> Result<Vec<WikiPage>, String> {
    let wiki_dir = state.wiki_dir(&workspace_id);
    if !wiki_dir.exists() {
        return Ok(vec![]);
    }
    let mut pages = vec![];
    let entries = fs::read_dir(&wiki_dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("md") {
            if let Ok(meta) = entry.metadata() {
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as f64)
                    .unwrap_or(0.0);
                pages.push(WikiPage {
                    name: path.file_name().unwrap().to_string_lossy().to_string(),
                    path: path.to_string_lossy().to_string(),
                    size: meta.len(),
                    mtime,
                });
            }
        }
    }
    pages.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(pages)
}

#[tauri::command]
pub fn wiki_read(
    workspace_id: String,
    name: String,
    state: State<'_, ManagedState>,
) -> Result<serde_json::Value, String> {
    let wiki_dir = state.wiki_dir(&workspace_id);
    let file_path = wiki_dir.join(&name);
    if !file_path.exists() {
        return Ok(serde_json::json!({ "ok": false, "error": "Page not found" }));
    }
    let content = fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "ok": true, "content": content }))
}

#[tauri::command]
pub fn wiki_write(
    workspace_id: String,
    name: String,
    content: String,
    state: State<'_, ManagedState>,
) -> Result<serde_json::Value, String> {
    let wiki_dir = state.wiki_dir(&workspace_id);
    fs::create_dir_all(&wiki_dir).map_err(|e| e.to_string())?;

    // Sanitize name
    let safe_name = if name.ends_with(".md") {
        name.clone()
    } else {
        format!("{}.md", name)
    };
    let file_path = wiki_dir.join(&safe_name);
    fs::write(&file_path, &content).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "ok": true, "name": safe_name }))
}

#[tauri::command]
pub fn wiki_delete(
    workspace_id: String,
    name: String,
    state: State<'_, ManagedState>,
) -> Result<serde_json::Value, String> {
    let wiki_dir = state.wiki_dir(&workspace_id);
    let file_path = wiki_dir.join(&name);
    if file_path.exists() {
        // Trash so users can recover an accidental wiki page deletion.
        if let Err(e) = trash::delete(&file_path) {
            // Fallback for headless / unsupported platforms.
            fs::remove_file(&file_path)
                .map_err(|fs_err| format!("trash: {}, fs: {}", e, fs_err))?;
        }
    }
    Ok(serde_json::json!({ "ok": true }))
}
