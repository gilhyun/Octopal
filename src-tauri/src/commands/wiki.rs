use crate::state::ManagedState;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

use super::path_guard;

#[derive(Serialize)]
pub struct WikiPage {
    /// Path relative to wiki_dir with forward-slash separators, e.g. "docs/intro.md".
    /// Pages at the top level have no prefix.
    pub name: String,
    pub path: String,
    pub size: u64,
    pub mtime: f64,
}

/// Walk the wiki dir recursively, collecting .md files with relative paths.
/// Caps depth to avoid runaway traversal on symlink loops or pathological trees.
pub(crate) fn collect_pages(root: &Path, current: &Path, depth: u8, out: &mut Vec<WikiPage>) {
    if depth > 8 {
        return;
    }
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            // Skip hidden dirs (e.g. .git, .DS_Store shouldn't be dirs but defensive)
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            collect_pages(root, &path, depth + 1, out);
        } else if ft.is_file() && path.extension().and_then(|e| e.to_str()) == Some("md") {
            let Ok(meta) = entry.metadata() else { continue };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as f64)
                .unwrap_or(0.0);
            // Build a forward-slash-separated relative path so the frontend
            // can split on "/" to derive folder grouping.
            let rel = path.strip_prefix(root).unwrap_or(&path);
            let name = rel
                .components()
                .filter_map(|c| c.as_os_str().to_str())
                .collect::<Vec<_>>()
                .join("/");
            out.push(WikiPage {
                name,
                path: path.to_string_lossy().to_string(),
                size: meta.len(),
                mtime,
            });
        }
    }
}

#[tauri::command]
pub fn wiki_list(
    workspace_id: String,
    state: State<'_, ManagedState>,
) -> Result<Vec<WikiPage>, String> {
    let wiki_dir = workspace_wiki_dir(&state, &workspace_id, false)?;
    if !wiki_dir.exists() {
        return Ok(vec![]);
    }
    let mut pages: Vec<WikiPage> = vec![];
    collect_pages(&wiki_dir, &wiki_dir, 0, &mut pages);
    pages.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(pages)
}

#[tauri::command]
pub fn wiki_read(
    workspace_id: String,
    name: String,
    state: State<'_, ManagedState>,
) -> Result<serde_json::Value, String> {
    let wiki_dir = workspace_wiki_dir(&state, &workspace_id, false)?;
    let rel = match sanitize_rel_name(&name) {
        Some(p) => p,
        None => return Err(format!("invalid wiki page name: {}", name)),
    };
    if !wiki_dir.is_dir() {
        return Ok(serde_json::json!({ "ok": false, "error": "Page not found" }));
    }
    let file_path = match path_guard::existing_regular_file_path(&wiki_dir, &rel) {
        Ok(path) => path,
        Err(_) => return Ok(serde_json::json!({ "ok": false, "error": "Page not found" })),
    };
    let content = fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "ok": true, "content": content }))
}

/// Reject names that would escape the wiki_dir (e.g. "../../etc/passwd").
/// Allows forward-slash subpaths ("folder/page.md") but strips any path
/// components that are "." or "..".
fn sanitize_rel_name(name: &str) -> Option<PathBuf> {
    path_guard::safe_relative(name).ok()
}

/// Resolve the wiki root only for an ID that is currently present in app
/// state. The ID is also required to be a single segment so a corrupt state
/// file cannot turn `state_dir/wiki/<id>` into an arbitrary path.
fn workspace_wiki_dir(
    state: &ManagedState,
    workspace_id: &str,
    create: bool,
) -> Result<PathBuf, String> {
    path_guard::safe_segment(workspace_id, "workspace id")?;
    let exists = state
        .app_state
        .lock()
        .map_err(|e| e.to_string())?
        .workspaces
        .iter()
        .any(|workspace| workspace.id == workspace_id);
    if !exists {
        return Err("workspace is not registered".to_string());
    }

    let state_root = fs::canonicalize(&state.state_dir).map_err(|e| e.to_string())?;
    let wiki_parent = state_root.join("wiki");
    if create {
        if let Ok(meta) = fs::symlink_metadata(&wiki_parent) {
            if meta.file_type().is_symlink() {
                return Err("wiki root may not be a symlink".to_string());
            }
        }
        fs::create_dir_all(&wiki_parent).map_err(|e| e.to_string())?;
    } else if !wiki_parent.exists() {
        return Ok(wiki_parent.join(workspace_id));
    }

    let wiki_parent = fs::canonicalize(&wiki_parent).map_err(|e| e.to_string())?;
    if !wiki_parent.starts_with(&state_root) {
        return Err("wiki root escapes application state".to_string());
    }
    let wiki_dir = wiki_parent.join(workspace_id);
    if let Ok(meta) = fs::symlink_metadata(&wiki_dir) {
        if meta.file_type().is_symlink() {
            return Err("workspace wiki may not be a symlink".to_string());
        }
    }
    if create {
        fs::create_dir_all(&wiki_dir).map_err(|e| e.to_string())?;
    } else if !wiki_dir.exists() {
        return Ok(wiki_dir);
    }
    let resolved = fs::canonicalize(&wiki_dir).map_err(|e| e.to_string())?;
    if !resolved.starts_with(&wiki_parent) {
        return Err("workspace wiki escapes its allowed root".to_string());
    }
    Ok(resolved)
}

#[tauri::command]
pub fn wiki_write(
    workspace_id: String,
    name: String,
    content: String,
    state: State<'_, ManagedState>,
) -> Result<serde_json::Value, String> {
    // Ensure .md extension
    let safe_name = if name.ends_with(".md") {
        name.clone()
    } else {
        format!("{}.md", name)
    };

    // Reject path-traversal attempts
    let rel = match sanitize_rel_name(&safe_name) {
        Some(p) => p,
        None => return Err(format!("invalid wiki page name: {}", name)),
    };

    let wiki_dir = workspace_wiki_dir(&state, &workspace_id, true)?;
    let mut file_path = path_guard::write_target_path(&wiki_dir, &rel)?;
    // Create any missing parent directories so nested names like "folder/page.md" work
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Recheck after parent creation so an existing symlink component cannot be
    // introduced through a pre-populated malicious wiki tree.
    file_path = path_guard::write_target_path(&wiki_dir, &rel)?;
    crate::commands::atomic_file::with_path_lock(&file_path, || {
        crate::commands::atomic_file::atomic_write(&file_path, content.as_bytes())
    })?;
    Ok(serde_json::json!({ "ok": true, "name": safe_name }))
}

#[tauri::command]
pub fn wiki_delete(
    workspace_id: String,
    name: String,
    state: State<'_, ManagedState>,
) -> Result<serde_json::Value, String> {
    let wiki_dir = workspace_wiki_dir(&state, &workspace_id, false)?;
    let rel = match sanitize_rel_name(&name) {
        Some(p) => p,
        None => return Err(format!("invalid wiki page name: {}", name)),
    };
    if wiki_dir.is_dir() {
        let file_path = match path_guard::existing_regular_file_path(&wiki_dir, &rel) {
            Ok(path) => path,
            Err(_) => return Ok(serde_json::json!({ "ok": true })),
        };
        crate::commands::atomic_file::with_path_lock(&file_path, || {
            // Trash so users can recover an accidental wiki page deletion.
            if let Err(e) = trash::delete(&file_path) {
                // Fallback for headless / unsupported platforms.
                fs::remove_file(&file_path)
                    .map_err(|fs_err| format!("trash: {}, fs: {}", e, fs_err))?;
            }
            Ok(())
        })?;
    }
    Ok(serde_json::json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wiki_names_reject_unix_and_windows_traversal() {
        for bad in ["../secret.md", "docs/../../secret.md", "..\\secret.md"] {
            assert!(sanitize_rel_name(bad).is_none(), "accepted {bad:?}");
        }
        assert_eq!(
            sanitize_rel_name("docs/intro.md").unwrap(),
            PathBuf::from("docs/intro.md")
        );
    }

    #[test]
    fn workspace_id_must_be_one_segment() {
        for bad in ["../outside", "/tmp/outside", "..\\outside", ""] {
            assert!(path_guard::safe_segment(bad, "workspace id").is_err());
        }
    }
}
