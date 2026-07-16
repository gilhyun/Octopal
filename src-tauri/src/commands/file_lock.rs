//! Best-effort file lock map for the agent file safety net.
//!
//! Acquires per-file claims when an agent's `Write`/`Edit` tool fires. The
//! lock is **not** synchronously enforced against the claude subprocess —
//! claude has already issued the write by the time we see the event in the
//! stream. The lock exists to:
//!
//! 1. Detect when two concurrently-running agents touch the same file, so
//!    the UI can surface a conflict warning.
//! 2. Make it easy to plug in real PreToolUse-hook based blocking later
//!    (v2): the lock map will already be the source of truth.
//!
//! Re-entrant for the same `run_id`: an agent that writes the same file
//! twice in one run does not flag a conflict.

use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
pub struct LockHolder {
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "agentName")]
    pub agent_name: String,
    #[serde(rename = "acquiredAtMs")]
    pub acquired_at_ms: u64,
}

pub struct FileLockManager {
    state: Mutex<FileLockState>,
}

#[derive(Default)]
struct FileLockState {
    /// Path -> current holder.
    locks: HashMap<PathBuf, LockHolder>,
    /// Reverse index for fast release on run end.
    run_index: HashMap<String, Vec<PathBuf>>,
}

impl Default for FileLockManager {
    fn default() -> Self {
        Self::new()
    }
}

impl FileLockManager {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(FileLockState::default()),
        }
    }

    /// Try to claim `path` for `run_id`. Returns `Ok(())` if the claim is
    /// fresh or already held by the same run, or `Err(existing)` if a
    /// different run holds it.
    pub fn try_acquire(
        &self,
        path: PathBuf,
        run_id: &str,
        agent_name: &str,
    ) -> Result<(), LockHolder> {
        let mut state = match self.state.lock() {
            Ok(g) => g,
            // Poisoned mutex — fail open (no conflict reported) so the agent
            // run keeps moving.
            Err(_) => return Ok(()),
        };

        if let Some(existing) = state.locks.get(&path) {
            if existing.run_id == run_id {
                return Ok(());
            }
            return Err(existing.clone());
        }

        let holder = LockHolder {
            run_id: run_id.to_string(),
            agent_name: agent_name.to_string(),
            acquired_at_ms: now_ms(),
        };
        state.locks.insert(path.clone(), holder);
        state
            .run_index
            .entry(run_id.to_string())
            .or_default()
            .push(path);
        Ok(())
    }

    /// Release every lock held by `run_id`. Called when an agent run ends
    /// (success, error, or interruption).
    pub fn release_run(&self, run_id: &str) {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        let paths = state.run_index.remove(run_id).unwrap_or_default();
        if paths.is_empty() {
            return;
        }
        for path in paths {
            if let Some(holder) = state.locks.get(&path) {
                if holder.run_id == run_id {
                    state.locks.remove(&path);
                }
            }
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_removes_forward_and_reverse_entries_together() {
        let manager = FileLockManager::new();
        let path = PathBuf::from("/tmp/octopal-lock-test");
        manager
            .try_acquire(path.clone(), "run-a", "agent-a")
            .unwrap();
        assert!(manager
            .try_acquire(path.clone(), "run-b", "agent-b")
            .is_err());

        manager.release_run("run-a");
        manager
            .try_acquire(path.clone(), "run-b", "agent-b")
            .unwrap();

        let state = manager.state.lock().unwrap();
        assert_eq!(state.locks.get(&path).unwrap().run_id, "run-b");
        assert!(!state.run_index.contains_key("run-a"));
        assert_eq!(state.run_index.get("run-b"), Some(&vec![path]));
    }
}
