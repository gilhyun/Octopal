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
    /// Path -> current holder.
    locks: Mutex<HashMap<PathBuf, LockHolder>>,
    /// Reverse index for fast release on run end.
    run_index: Mutex<HashMap<String, Vec<PathBuf>>>,
}

impl Default for FileLockManager {
    fn default() -> Self {
        Self::new()
    }
}

impl FileLockManager {
    pub fn new() -> Self {
        Self {
            locks: Mutex::new(HashMap::new()),
            run_index: Mutex::new(HashMap::new()),
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
        let mut locks = match self.locks.lock() {
            Ok(g) => g,
            // Poisoned mutex — fail open (no conflict reported) so the agent
            // run keeps moving.
            Err(_) => return Ok(()),
        };

        if let Some(existing) = locks.get(&path) {
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
        locks.insert(path.clone(), holder);
        drop(locks);

        if let Ok(mut idx) = self.run_index.lock() {
            idx.entry(run_id.to_string()).or_default().push(path);
        }
        Ok(())
    }

    /// Release every lock held by `run_id`. Called when an agent run ends
    /// (success, error, or interruption).
    pub fn release_run(&self, run_id: &str) {
        let paths = match self.run_index.lock() {
            Ok(mut idx) => idx.remove(run_id).unwrap_or_default(),
            Err(_) => return,
        };
        if paths.is_empty() {
            return;
        }
        if let Ok(mut locks) = self.locks.lock() {
            for p in paths {
                if let Some(h) = locks.get(&p) {
                    if h.run_id == run_id {
                        locks.remove(&p);
                    }
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
