//! File backup engine for the agent file safety net.
//!
//! Each agent run gets a backup directory under
//! `<workspace>/.octopal/backups/<ts>-<agent>-<runId8>/`. We snapshot a file
//! the FIRST time an agent's `Write`/`Edit` tool touches it during a run, so
//! the backup always holds the original pre-run state.
//!
//! Files outside the workspace folder are skipped (security + scope).
//!
//! Reverts use the `trash` crate so any current-state files we delete during
//! revert end up in the OS trash, not gone forever.

use chrono::{TimeZone, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

use super::path_guard;
use crate::state::ManagedState;

/// Fallback cap on backup directories kept per workspace, used when no
/// settings are available (e.g. tests, background pruner without state).
const DEFAULT_MAX_BACKUPS_PER_WORKSPACE: usize = 50;
/// Fallback maximum age of a backup before pruning.
const DEFAULT_MAX_BACKUP_AGE_DAYS: u64 = 7;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupFileEntry {
    /// Path relative to the workspace folder.
    pub path: String,
    /// Whether the file existed at snapshot time. `false` means the agent
    /// created this file — reverting deletes it (sent to OS trash).
    pub existed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupMeta {
    pub id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "agentName")]
    pub agent_name: String,
    pub ts: u64,
    #[serde(rename = "folderPath")]
    pub folder_path: String,
    pub files: Vec<BackupFileEntry>,
}

/// Per-run state held only while the run is in flight. Tracks which files
/// have already been snapshotted so we don't overwrite the original capture.
struct RunBackupState {
    backup_id: String,
    run_id: String,
    folder_path: PathBuf,
    agent_name: String,
    started_ts: u64,
    /// Canonical absolute path -> entry (for dedup) plus the relative form.
    files: HashMap<PathBuf, BackupFileEntry>,
}

/// In-memory tracker shared across `send_message` runs.
pub struct BackupTracker {
    runs: Mutex<HashMap<String, RunBackupState>>,
}

impl Default for BackupTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl BackupTracker {
    pub fn new() -> Self {
        Self {
            runs: Mutex::new(HashMap::new()),
        }
    }

    /// Snapshot a file before the agent modifies it. Returns the backup id
    /// (one per run) on success, or `None` if the file is outside the
    /// workspace, the path is unresolvable, or filesystem I/O failed.
    ///
    /// Idempotent within a run: subsequent calls for the same file return
    /// the existing backup id without re-copying.
    pub fn snapshot(
        &self,
        folder_path: &Path,
        run_id: &str,
        agent_name: &str,
        file_path: &str,
    ) -> Option<String> {
        let folder_canonical = canonicalize_or_self(folder_path);
        let abs = resolve_target_path(&folder_canonical, file_path)?;
        let rel = abs.strip_prefix(&folder_canonical).ok()?.to_path_buf();

        let mut runs = self.runs.lock().ok()?;
        let state = runs.entry(run_id.to_string()).or_insert_with(|| {
            let ts = now_ms();
            let backup_id = format!(
                "{}-{}-{}",
                format_ts_compact(ts),
                sanitize_segment(agent_name),
                sanitize_segment(&run_id.chars().take(8).collect::<String>()),
            );
            RunBackupState {
                backup_id,
                run_id: run_id.to_string(),
                folder_path: folder_canonical.clone(),
                agent_name: agent_name.to_string(),
                started_ts: ts,
                files: HashMap::new(),
            }
        });

        // Already snapshotted in this run — re-entrant is fine.
        if state.files.contains_key(&abs) {
            return Some(state.backup_id.clone());
        }

        let backups = secure_backups_root(&state.folder_path, true).ok()?;
        validate_backup_id(&state.backup_id).ok()?;
        let backup_root = path_guard::write_target(&backups, &state.backup_id).ok()?;
        fs::create_dir_all(&backup_root).ok()?;
        let backup_root = fs::canonicalize(&backup_root).ok()?;
        if !backup_root.starts_with(&backups) {
            return None;
        }
        // Best-effort: keep `.octopal/backups/` out of git so users on a git
        // repo don't accidentally commit megabytes of snapshots.
        ensure_octopal_gitignore(&state.folder_path);

        let existed = abs.exists() && abs.is_file();
        if existed {
            // Revalidate both source and destination at the point of use so a
            // workspace symlink cannot turn snapshotting into an arbitrary
            // read or write after the initial tool event was parsed.
            let source = path_guard::existing_regular_file_path(&folder_canonical, &rel).ok()?;
            let dest = path_guard::write_target_path(&backup_root, &rel).ok()?;
            if let Some(parent) = dest.parent() {
                if fs::create_dir_all(parent).is_err() {
                    return None;
                }
            }
            if path_guard::write_target_path(&backup_root, &rel).is_err()
                || crate::commands::atomic_file::atomic_copy(&source, &dest).is_err()
            {
                return None;
            }
        }

        state.files.insert(
            abs,
            BackupFileEntry {
                path: portable_relative(&rel),
                existed,
            },
        );

        let _ = write_meta(&backup_root, state);
        Some(state.backup_id.clone())
    }

    /// Drop the in-memory state for a finished run. Backup files on disk are
    /// untouched — they remain available for revert until pruned.
    pub fn finalize_run(&self, run_id: &str) {
        if let Ok(mut runs) = self.runs.lock() {
            runs.remove(run_id);
        }
    }
}

// ── Tauri commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_backups(
    folder_path: String,
    state: State<'_, ManagedState>,
) -> Result<Vec<BackupMeta>, String> {
    let folder = path_guard::registered_folder(&state, Path::new(&folder_path))?;
    let root = secure_backups_root(&folder, false)?;
    if !root.is_dir() {
        return Ok(vec![]);
    }

    let mut metas: Vec<BackupMeta> = vec![];
    let entries = fs::read_dir(&root).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        let Ok(path) = secure_backup_dir(&folder, &id) else {
            continue;
        };
        let Ok(meta_path) = path_guard::existing_regular_file(&path, "meta.json") else {
            continue;
        };
        if let Ok(content) = fs::read_to_string(&meta_path) {
            if let Ok(meta) = serde_json::from_str::<BackupMeta>(&content) {
                if meta.id == id
                    && fs::canonicalize(&meta.folder_path).is_ok_and(|path| path == folder)
                {
                    metas.push(meta);
                }
            }
        }
    }
    // Newest first
    metas.sort_by(|a, b| b.ts.cmp(&a.ts));
    Ok(metas)
}

#[tauri::command]
pub fn read_backup_file(
    folder_path: String,
    backup_id: String,
    file_path: String,
    state: State<'_, ManagedState>,
) -> Result<String, String> {
    let folder = path_guard::registered_folder(&state, Path::new(&folder_path))?;
    let (backup, meta) = load_backup_meta(&folder, &backup_id)?;
    let (safe_rel, entry) = listed_backup_file(&meta, &file_path)?;
    if !entry.existed {
        // The agent created this file, so its prior content is intentionally empty.
        return Ok(String::new());
    }
    let target = path_guard::existing_regular_file_path(&backup, &safe_rel)?;
    fs::read_to_string(target).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_current_file(
    folder_path: String,
    backup_id: String,
    file_path: String,
    state: State<'_, ManagedState>,
) -> Result<String, String> {
    let folder = path_guard::registered_folder(&state, Path::new(&folder_path))?;
    let (_, meta) = load_backup_meta(&folder, &backup_id)?;
    let (safe_rel, _) = listed_backup_file(&meta, &file_path)?;
    let target = path_guard::write_target_path(&folder, &safe_rel)?;
    if !target.exists() {
        return Ok(String::new());
    }
    let target = path_guard::existing_regular_file_path(&folder, &safe_rel)?;
    fs::read_to_string(target).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct RevertResult {
    pub ok: bool,
    pub reverted: Vec<String>,
    pub failed: Vec<String>,
}

/// Revert one file (or all files when `file_path` is `None`) from a backup.
///
/// - existed=true → restore from snapshot (overwrite current).
/// - existed=false (file was created by the agent) → send current to OS trash.
#[tauri::command]
pub fn revert_backup(
    folder_path: String,
    backup_id: String,
    file_path: Option<String>,
    state: State<'_, ManagedState>,
) -> Result<RevertResult, String> {
    let folder = path_guard::registered_folder(&state, Path::new(&folder_path))?;
    let (backup_dir, meta) = load_backup_meta(&folder, &backup_id)?;

    let selected = file_path
        .as_deref()
        .map(sanitize_backup_relative)
        .transpose()?;
    let target_files: Vec<&BackupFileEntry> = match &selected {
        Some(selected) => meta
            .files
            .iter()
            .filter(|entry| sanitize_backup_relative(&entry.path).as_ref() == Ok(selected))
            .collect(),
        None => meta.files.iter().collect(),
    };

    let mut reverted: Vec<String> = vec![];
    let mut failed: Vec<String> = vec![];

    for entry in target_files {
        let safe_rel = match sanitize_backup_relative(&entry.path) {
            Ok(path) => path,
            Err(_) => {
                failed.push(entry.path.clone());
                continue;
            }
        };
        let current_abs = match path_guard::write_target_path(&folder, &safe_rel) {
            Ok(path) => path,
            Err(_) => {
                failed.push(entry.path.clone());
                continue;
            }
        };
        if entry.existed {
            // Restore from snapshot
            let snapshot_abs = match path_guard::existing_regular_file_path(&backup_dir, &safe_rel)
            {
                Ok(path) => path,
                Err(_) => {
                    failed.push(entry.path.clone());
                    continue;
                }
            };
            if let Some(parent) = current_abs.parent() {
                if fs::create_dir_all(parent).is_err()
                    || path_guard::write_target_path(&folder, &safe_rel).is_err()
                {
                    failed.push(entry.path.clone());
                    continue;
                }
            }
            match crate::commands::atomic_file::atomic_copy(&snapshot_abs, &current_abs) {
                Ok(_) => reverted.push(entry.path.clone()),
                Err(_) => failed.push(entry.path.clone()),
            }
        } else {
            // File was created by the agent — trash it (best-effort).
            if current_abs.exists() {
                let current_abs = match path_guard::existing_regular_file_path(&folder, &safe_rel) {
                    Ok(path) => path,
                    Err(_) => {
                        failed.push(entry.path.clone());
                        continue;
                    }
                };
                match trash::delete(&current_abs) {
                    Ok(_) => reverted.push(entry.path.clone()),
                    Err(_) => {
                        // Fallback: remove_file (still better than nothing)
                        if fs::remove_file(&current_abs).is_ok() {
                            reverted.push(entry.path.clone());
                        } else {
                            failed.push(entry.path.clone());
                        }
                    }
                }
            } else {
                // Already gone — count as success.
                reverted.push(entry.path.clone());
            }
        }
    }

    Ok(RevertResult {
        ok: failed.is_empty(),
        reverted,
        failed,
    })
}

/// Trim old backups: keep at most `max_count` AND drop anything older than
/// `max_age_days`. Pruned dirs go to OS trash. Pure helper that the Tauri
/// command and the agent.rs background sweeper both call.
pub fn prune_with_limits(
    folder_path: &str,
    max_count: usize,
    max_age_days: u64,
) -> Result<usize, String> {
    let folder = Path::new(folder_path);
    if !folder.is_dir() {
        return Ok(0);
    }
    let root = secure_backups_root(folder, false)?;
    if !root.is_dir() {
        return Ok(0);
    }

    let mut entries: Vec<(PathBuf, u64)> = vec![];
    let read = fs::read_dir(&root).map_err(|e| e.to_string())?;
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let ts = fs::read_to_string(path.join("meta.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<BackupMeta>(&s).ok())
            .map(|m| m.ts)
            .unwrap_or(0);
        entries.push((path, ts));
    }
    // Newest first
    entries.sort_by(|a, b| b.1.cmp(&a.1));

    let cutoff_ms = now_ms().saturating_sub(max_age_days * 24 * 60 * 60 * 1000);
    let mut pruned = 0usize;
    for (i, (path, ts)) in entries.iter().enumerate() {
        let too_old = *ts > 0 && *ts < cutoff_ms;
        let over_count = i >= max_count;
        if (too_old || over_count)
            && (trash::delete(path).is_ok() || fs::remove_dir_all(path).is_ok())
        {
            pruned += 1;
        }
    }
    Ok(pruned)
}

/// Tauri command — reads retention limits from app settings, then prunes.
#[tauri::command]
pub fn prune_backups(folder_path: String, state: State<'_, ManagedState>) -> Result<usize, String> {
    path_guard::registered_folder(&state, Path::new(&folder_path))?;
    let (max_count, max_age) = match state.settings.lock() {
        Ok(s) => (
            s.backup.max_backups_per_workspace as usize,
            s.backup.max_age_days as u64,
        ),
        Err(_) => (
            DEFAULT_MAX_BACKUPS_PER_WORKSPACE,
            DEFAULT_MAX_BACKUP_AGE_DAYS,
        ),
    };
    prune_with_limits(&folder_path, max_count, max_age)
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn validate_backup_id(backup_id: &str) -> Result<(), String> {
    path_guard::safe_segment(backup_id, "backup id")?;
    if !backup_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid backup id".to_string());
    }
    Ok(())
}

fn secure_backups_root(folder: &Path, create: bool) -> Result<PathBuf, String> {
    let folder = fs::canonicalize(folder).map_err(|e| e.to_string())?;
    let relative = Path::new(".octopal").join("backups");
    let target = path_guard::write_target_path(&folder, &relative)?;
    if create {
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    } else if !target.exists() {
        return Ok(target);
    }
    let target = fs::canonicalize(&target).map_err(|e| e.to_string())?;
    if !target.starts_with(&folder) {
        return Err("backup root escapes its workspace".to_string());
    }
    Ok(target)
}

fn secure_backup_dir(folder: &Path, backup_id: &str) -> Result<PathBuf, String> {
    validate_backup_id(backup_id)?;
    let root = secure_backups_root(folder, false)?;
    if !root.is_dir() {
        return Err("Backup not found".to_string());
    }
    let relative = PathBuf::from(backup_id);
    let backup = path_guard::write_target_path(&root, &relative)?;
    if !backup.exists() {
        return Err("Backup not found".to_string());
    }
    let backup = fs::canonicalize(&backup).map_err(|e| e.to_string())?;
    if !backup.starts_with(&root) || !backup.is_dir() {
        return Err("Backup not found".to_string());
    }
    Ok(backup)
}

fn load_backup_meta(folder: &Path, backup_id: &str) -> Result<(PathBuf, BackupMeta), String> {
    let backup_dir = secure_backup_dir(folder, backup_id)?;
    let meta_path = path_guard::existing_regular_file(&backup_dir, "meta.json")?;
    let meta_content = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let meta: BackupMeta = serde_json::from_str(&meta_content).map_err(|e| e.to_string())?;
    if meta.id != backup_id {
        return Err("backup metadata id does not match its directory".to_string());
    }
    let meta_folder = fs::canonicalize(&meta.folder_path)
        .map_err(|_| "backup metadata references an unavailable workspace".to_string())?;
    if meta_folder != folder {
        return Err("backup metadata belongs to a different workspace".to_string());
    }
    Ok((backup_dir, meta))
}

fn listed_backup_file<'a>(
    meta: &'a BackupMeta,
    requested: &str,
) -> Result<(PathBuf, &'a BackupFileEntry), String> {
    let safe_rel = sanitize_backup_relative(requested)?;
    let entry = meta
        .files
        .iter()
        .find(|entry| sanitize_backup_relative(&entry.path).is_ok_and(|listed| listed == safe_rel))
        .ok_or_else(|| "file is not listed in this backup".to_string())?;
    Ok((safe_rel, entry))
}

fn portable_relative(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Drop a `.gitignore` inside `.octopal/` that excludes runtime artifacts
/// (backups, room history, uploads). Idempotent: only writes when missing,
/// never overwrites a user-customized file.
fn ensure_octopal_gitignore(folder: &Path) {
    let Ok(gitignore) = path_guard::write_target(folder, ".octopal/.gitignore") else {
        return;
    };
    let body = "# Auto-generated by Octopal — runtime artifacts, safe to ignore.\nbackups/\nuploads/\nroom-history.json\nroom-log.json\n";
    let _ = crate::commands::atomic_file::with_path_lock(&gitignore, || {
        if gitignore.exists() {
            // Existing user-owned files (including non-regular targets) are
            // never replaced by this best-effort helper.
            path_guard::existing_regular_file(folder, ".octopal/.gitignore")?;
            return Ok(());
        }
        crate::commands::atomic_file::atomic_write(&gitignore, body.as_bytes())
    });
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn format_ts_compact(ms: u64) -> String {
    // YYYYMMDD-HHMMSS in UTC. Avoids local-tz ambiguity in dir names.
    let secs = (ms / 1000) as i64;
    match Utc.timestamp_opt(secs, 0).single() {
        Some(dt) => dt.format("%Y%m%d-%H%M%S").to_string(),
        None => format!("{}", ms),
    }
}

fn sanitize_segment(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "agent".to_string()
    } else {
        cleaned
    }
}

fn canonicalize_or_self(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Resolve a possibly-relative tool input path to an absolute path inside
/// the workspace. Does NOT require the file to exist (it may be created by
/// the agent), but does canonicalize the parent so symlinked workspaces
/// still strip cleanly.
fn resolve_target_path(folder_canonical: &Path, file_path: &str) -> Option<PathBuf> {
    let p = Path::new(file_path);
    let relative = if p.is_absolute() {
        if p.exists() {
            let resolved = fs::canonicalize(p).ok()?;
            return resolved.starts_with(folder_canonical).then_some(resolved);
        }
        p.strip_prefix(folder_canonical).ok()?.to_path_buf()
    } else {
        sanitize_backup_relative(file_path).ok()?
    };
    path_guard::write_target_path(folder_canonical, &relative).ok()
}

fn write_meta(backup_root: &Path, state: &RunBackupState) -> Result<(), String> {
    let meta = BackupMeta {
        id: state.backup_id.clone(),
        run_id: state.run_id.clone(),
        agent_name: state.agent_name.clone(),
        ts: state.started_ts,
        folder_path: state.folder_path.to_string_lossy().to_string(),
        files: state.files.values().cloned().collect(),
    };
    let path = path_guard::write_target(backup_root, "meta.json")?;
    crate::commands::atomic_file::with_path_lock(&path, || {
        crate::commands::atomic_file::atomic_write_json(&path, &meta)
    })
}

/// Reject absolute paths and `..` segments. Returns a normalized relative
/// PathBuf safe to join under a backup or workspace root.
fn sanitize_backup_relative(input: &str) -> Result<PathBuf, String> {
    // Older Windows builds persisted backslashes in meta.json. Normalize them
    // before component validation so legacy backups remain usable while
    // `..\\outside` is still rejected as traversal.
    path_guard::safe_relative(&input.replace('\\', "/"))
}

#[cfg(test)]
mod security_tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "octopal-backup-security-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn backup_id_is_one_ascii_segment() {
        for bad in ["../etc", "/etc", "..\\etc", "a/b", ".", "id.json"] {
            assert!(validate_backup_id(bad).is_err(), "accepted {bad:?}");
        }
        assert!(validate_backup_id("20260711-agent-deadbeef").is_ok());
    }

    #[test]
    fn tampered_metadata_paths_cannot_leave_workspace() {
        for bad in ["../../.ssh/config", "..\\..\\.ssh\\config", "/etc/passwd"] {
            assert!(sanitize_backup_relative(bad).is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn backup_reads_require_a_metadata_listed_path() {
        let meta = BackupMeta {
            id: "good-id".into(),
            run_id: "run".into(),
            agent_name: "agent".into(),
            ts: 1,
            folder_path: "/workspace".into(),
            files: vec![BackupFileEntry {
                path: "src/main.rs".into(),
                existed: true,
            }],
        };
        assert_eq!(
            listed_backup_file(&meta, "src/main.rs").unwrap().0,
            Path::new("src/main.rs")
        );
        assert!(listed_backup_file(&meta, "Cargo.toml").is_err());
        assert!(listed_backup_file(&meta, "../secret").is_err());
    }

    #[test]
    fn renderer_run_id_cannot_inject_backup_path_segments() {
        let segment = sanitize_segment("../../x");
        let id = format!("20260711-010101-agent-{segment}");
        assert!(validate_backup_id(&id).is_ok());
        assert!(!id.contains('/'));
        assert!(!id.contains('\\'));
    }

    #[cfg(unix)]
    #[test]
    fn backup_file_symlink_cannot_escape_backup_root() {
        use std::os::unix::fs::symlink;

        let folder = temp_dir("folder");
        let outside = temp_dir("outside");
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        let backup_root = folder.join(".octopal/backups/good-id");
        fs::create_dir_all(&backup_root).unwrap();
        symlink(&outside, backup_root.join("escape")).unwrap();

        assert!(path_guard::existing_regular_file(&backup_root, "escape/secret.txt").is_err());
        let _ = fs::remove_dir_all(folder);
        let _ = fs::remove_dir_all(outside);
    }

    #[cfg(unix)]
    #[test]
    fn gitignore_helper_rejects_symlinked_octopal_directory() {
        use std::os::unix::fs::symlink;

        let folder = temp_dir("gitignore-folder");
        let outside = temp_dir("gitignore-outside");
        symlink(&outside, folder.join(".octopal")).unwrap();
        ensure_octopal_gitignore(&folder);
        assert!(!outside.join(".gitignore").exists());
        let _ = fs::remove_dir_all(folder);
        let _ = fs::remove_dir_all(outside);
    }
}
