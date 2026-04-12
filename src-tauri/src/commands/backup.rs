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
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

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
                run_id.chars().take(8).collect::<String>(),
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

        let backup_root = backups_root(&state.folder_path).join(&state.backup_id);
        if fs::create_dir_all(&backup_root).is_err() {
            return None;
        }
        // Best-effort: keep `.octopal/backups/` out of git so users on a git
        // repo don't accidentally commit megabytes of snapshots.
        ensure_octopal_gitignore(&state.folder_path);

        let existed = abs.exists() && abs.is_file();
        if existed {
            let dest = backup_root.join(&rel);
            if let Some(parent) = dest.parent() {
                if fs::create_dir_all(parent).is_err() {
                    return None;
                }
            }
            if fs::copy(&abs, &dest).is_err() {
                return None;
            }
        }

        state.files.insert(
            abs,
            BackupFileEntry {
                path: rel.to_string_lossy().to_string(),
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
pub fn list_backups(folder_path: String) -> Result<Vec<BackupMeta>, String> {
    let folder = Path::new(&folder_path);
    let root = backups_root(folder);
    if !root.is_dir() {
        return Ok(vec![]);
    }

    let mut metas: Vec<BackupMeta> = vec![];
    let entries = fs::read_dir(&root).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let meta_path = path.join("meta.json");
        if let Ok(content) = fs::read_to_string(&meta_path) {
            if let Ok(meta) = serde_json::from_str::<BackupMeta>(&content) {
                metas.push(meta);
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
) -> Result<String, String> {
    let folder = Path::new(&folder_path);
    let backup = backups_root(folder).join(&backup_id);
    if !backup.is_dir() {
        return Err("Backup not found".to_string());
    }
    let safe_rel = sanitize_relative(&file_path)?;
    let target = backup.join(&safe_rel);
    if !target.starts_with(&backup) {
        return Err("Path traversal denied".to_string());
    }
    if !target.exists() {
        // The file may have been newly created by the agent — there's nothing
        // to read from the backup; the original "previous content" is empty.
        return Ok(String::new());
    }
    fs::read_to_string(&target).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_current_file(folder_path: String, file_path: String) -> Result<String, String> {
    let folder = Path::new(&folder_path);
    let safe_rel = sanitize_relative(&file_path)?;
    let target = folder.join(&safe_rel);
    let folder_canonical = canonicalize_or_self(folder);
    // Use canonicalized parent for the containment check so that newly-created
    // files (which can't be canonicalized themselves) still pass.
    let candidate_canonical = if target.exists() {
        canonicalize_or_self(&target)
    } else if let Some(parent) = target.parent() {
        let cp = canonicalize_or_self(parent);
        match target.file_name() {
            Some(name) => cp.join(name),
            None => return Err("Invalid path".to_string()),
        }
    } else {
        return Err("Invalid path".to_string());
    };
    if !candidate_canonical.starts_with(&folder_canonical) {
        return Err("Path traversal denied".to_string());
    }
    if !target.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&target).map_err(|e| e.to_string())
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
) -> Result<RevertResult, String> {
    let folder = Path::new(&folder_path);
    let backup_dir = backups_root(folder).join(&backup_id);
    let meta_path = backup_dir.join("meta.json");
    let meta_content = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let meta: BackupMeta = serde_json::from_str(&meta_content).map_err(|e| e.to_string())?;

    let target_files: Vec<&BackupFileEntry> = match &file_path {
        Some(p) => meta.files.iter().filter(|f| &f.path == p).collect(),
        None => meta.files.iter().collect(),
    };

    let mut reverted: Vec<String> = vec![];
    let mut failed: Vec<String> = vec![];

    for entry in target_files {
        let current_abs = folder.join(&entry.path);
        if entry.existed {
            // Restore from snapshot
            let snapshot_abs = backup_dir.join(&entry.path);
            if !snapshot_abs.exists() {
                failed.push(entry.path.clone());
                continue;
            }
            if let Some(parent) = current_abs.parent() {
                let _ = fs::create_dir_all(parent);
            }
            match fs::copy(&snapshot_abs, &current_abs) {
                Ok(_) => reverted.push(entry.path.clone()),
                Err(_) => failed.push(entry.path.clone()),
            }
        } else {
            // File was created by the agent — trash it (best-effort).
            if current_abs.exists() {
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
    let root = backups_root(folder);
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
        if too_old || over_count {
            if trash::delete(path).is_ok() || fs::remove_dir_all(path).is_ok() {
                pruned += 1;
            }
        }
    }
    Ok(pruned)
}

/// Tauri command — reads retention limits from app settings, then prunes.
#[tauri::command]
pub fn prune_backups(
    folder_path: String,
    state: State<'_, ManagedState>,
) -> Result<usize, String> {
    let (max_count, max_age) = match state.settings.lock() {
        Ok(s) => (
            s.backup.max_backups_per_workspace as usize,
            s.backup.max_age_days as u64,
        ),
        Err(_) => (DEFAULT_MAX_BACKUPS_PER_WORKSPACE, DEFAULT_MAX_BACKUP_AGE_DAYS),
    };
    prune_with_limits(&folder_path, max_count, max_age)
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn backups_root(folder: &Path) -> PathBuf {
    folder.join(".octopal").join("backups")
}

/// Drop a `.gitignore` inside `.octopal/` that excludes runtime artifacts
/// (backups, room history, uploads). Idempotent: only writes when missing,
/// never overwrites a user-customized file.
fn ensure_octopal_gitignore(folder: &Path) {
    let gitignore = folder.join(".octopal").join(".gitignore");
    if gitignore.exists() {
        return;
    }
    let body = "# Auto-generated by Octopal — runtime artifacts, safe to ignore.\nbackups/\nuploads/\nroom-history.json\nroom-log.json\n";
    let _ = fs::write(&gitignore, body);
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
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        folder_canonical.join(p)
    };
    if abs.exists() {
        Some(canonicalize_or_self(&abs))
    } else {
        let parent = abs.parent()?;
        let cp = canonicalize_or_self(parent);
        Some(cp.join(abs.file_name()?))
    }
}

fn write_meta(backup_root: &Path, state: &RunBackupState) -> std::io::Result<()> {
    let meta = BackupMeta {
        id: state.backup_id.clone(),
        run_id: state.run_id.clone(),
        agent_name: state.agent_name.clone(),
        ts: state.started_ts,
        folder_path: state.folder_path.to_string_lossy().to_string(),
        files: state.files.values().cloned().collect(),
    };
    let json = serde_json::to_string_pretty(&meta).unwrap_or_default();
    fs::write(backup_root.join("meta.json"), json)
}

/// Reject absolute paths and `..` segments. Returns a normalized relative
/// PathBuf safe to join under a backup or workspace root.
fn sanitize_relative(input: &str) -> Result<PathBuf, String> {
    let p = Path::new(input);
    if p.is_absolute() {
        return Err("Absolute path not allowed".to_string());
    }
    for component in p.components() {
        match component {
            std::path::Component::ParentDir => return Err("Parent traversal not allowed".to_string()),
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                return Err("Absolute path not allowed".to_string())
            }
            _ => {}
        }
    }
    Ok(p.to_path_buf())
}
