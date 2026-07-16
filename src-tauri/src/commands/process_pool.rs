//! Persistent Claude CLI process pool.
//!
//! Instead of spawning a fresh `claude` process for every message (which
//! triggers macOS TCC permission dialogs each time), we keep long-running
//! processes alive and communicate via stdin/stdout using the
//! `--input-format stream-json` / `--output-format stream-json` protocol.
//!
//! Each process is keyed by `"{folder}::{agent}"` (or `"__dispatcher__"`)
//! and reused across messages. When the agent's config changes (model,
//! permissions, MCP), the old process is killed and a new one is created.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::sync::Mutex;

use super::claude_cli::claude_command;

/// A persistent Claude CLI process for bidirectional streaming.
pub struct ProcessEntry {
    child: Child,
    pub stdin: ChildStdin,
    pub reader: BufReader<ChildStdout>,
    pub pid: u32,
    pub config_hash: u64,
}

impl ProcessEntry {
    /// Write a user message to stdin in stream-json format.
    pub fn send_message(&mut self, content: &str) -> Result<(), String> {
        let msg = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": content
            }
        });
        let json_str = serde_json::to_string(&msg).map_err(|e| e.to_string())?;
        writeln!(self.stdin, "{}", json_str)
            .map_err(|e| format!("Failed to write to stdin: {}", e))?;
        self.stdin
            .flush()
            .map_err(|e| format!("Failed to flush stdin: {}", e))?;
        Ok(())
    }

    /// Check if the process is still alive.
    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Kill this process.
    pub fn kill(&mut self) {
        super::agent::kill_pid(self.pid);
        // Also try child.kill() as a fallback
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for ProcessEntry {
    fn drop(&mut self) {
        // Dropping std::process::Child does not terminate it. Make every
        // early-return and pool-removal path fail safe by reaping the child.
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

/// Manages a pool of persistent Claude CLI processes.
pub struct ProcessPool {
    /// key: "folder::agent_name" or "__dispatcher__::folder"
    processes: Mutex<HashMap<String, ProcessEntry>>,
}

impl ProcessPool {
    pub fn new() -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
        }
    }

    /// Take a process out of the pool for exclusive use.
    /// Returns `None` if no process exists for this key.
    pub fn take(&self, key: &str) -> Option<ProcessEntry> {
        self.processes.lock().unwrap().remove(key)
    }

    /// Return a process to the pool after use.
    pub fn put(&self, key: String, entry: ProcessEntry) {
        let replaced = self.processes.lock().unwrap().insert(key, entry);
        // Concurrent misses can both spawn a process for the same key. The
        // newer entry wins, but the displaced child must be explicitly reaped
        // because dropping `std::process::Child` leaves it running.
        if let Some(mut replaced) = replaced {
            replaced.kill();
        }
    }

    /// Remove and kill a process by key.
    pub fn remove(&self, key: &str) {
        let mut procs = self.processes.lock().unwrap();
        if let Some(mut entry) = procs.remove(key) {
            entry.kill();
        }
    }

    /// Remove a process by PID (used when stop_agent is called). ProcessEntry's
    /// Drop is a second-line kill/reap; the caller's PID kill remains harmless.
    pub fn remove_by_pid(&self, pid: u32) {
        let mut procs = self.processes.lock().unwrap();
        let key = procs
            .iter()
            .find(|(_, e)| e.pid == pid)
            .map(|(k, _)| k.clone());
        if let Some(k) = key {
            procs.remove(&k);
        }
    }

    /// Kill all processes (app shutdown).
    pub fn kill_all(&self) {
        let mut procs = self.processes.lock().unwrap();
        for (_, mut entry) in procs.drain() {
            entry.kill();
        }
    }

    /// Create a new persistent Claude CLI process.
    ///
    /// `args` should NOT include the user prompt — that comes via stdin.
    /// Must include: `-p --verbose --input-format stream-json --output-format stream-json`
    pub fn create_process(args: &[String], cwd: &str) -> Result<ProcessEntry, String> {
        let mut child = claude_command()
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn persistent claude process: {}", e))?;

        let pid = child.id();
        let stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Failed to capture stdin".to_string());
            }
        };
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Failed to capture stdout".to_string());
            }
        };

        // Drain stderr in a background thread to prevent blocking.
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    if !line.trim().is_empty() {
                        eprintln!("[persistent-claude-stderr] {}", line);
                    }
                }
            });
        }

        let reader = BufReader::new(stdout);

        // Don't pre-read stdout for the init event: claude v2.1.94+ doesn't
        // emit `system/init` until AFTER it reads the first stdin message.
        // Reading stdout before sending stdin deadlocks the process.
        // The main reader loops in send_message / dispatcher_route skip
        // `system` events, so the init gets handled naturally with the
        // first response.
        Ok(ProcessEntry {
            child,
            stdin,
            reader,
            pid,
            config_hash: 0,
        })
    }

    /// Compute a config hash for cache invalidation.
    pub fn hash_config(parts: &[&str]) -> u64 {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        for part in parts {
            part.hash(&mut hasher);
        }
        hasher.finish()
    }
}

impl Drop for ProcessPool {
    fn drop(&mut self) {
        if let Ok(processes) = self.processes.get_mut() {
            for (_, mut entry) in processes.drain() {
                entry.kill();
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    /// Helper: create a dummy ProcessEntry that uses its real PID
    fn dummy_process_real_pid() -> ProcessEntry {
        let mut child = Command::new("sleep")
            .arg("600")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("failed to spawn sleep");

        let pid = child.id();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let reader = BufReader::new(stdout);

        ProcessEntry {
            child,
            stdin,
            reader,
            pid,
            config_hash: 0,
        }
    }

    // ────────────────────────────────────────────────────────
    // ProcessPool: take / put basics
    // ────────────────────────────────────────────────────────

    #[test]
    fn pool_take_returns_none_when_empty() {
        let pool = ProcessPool::new();
        assert!(pool.take("nonexistent").is_none());
    }

    #[test]
    fn pool_put_then_take_returns_entry() {
        let pool = ProcessPool::new();
        let mut entry = dummy_process_real_pid();
        entry.config_hash = 42;
        let pid = entry.pid;
        pool.put("folder::agent".to_string(), entry);

        let taken = pool.take("folder::agent");
        assert!(taken.is_some());
        let mut taken = taken.unwrap();
        assert_eq!(taken.pid, pid);
        assert_eq!(taken.config_hash, 42);
        taken.kill(); // cleanup

        // After take, the pool should be empty for that key
        assert!(pool.take("folder::agent").is_none());
    }

    #[test]
    fn pool_put_overwrites_existing() {
        let pool = ProcessPool::new();
        let mut e1 = dummy_process_real_pid();
        e1.config_hash = 1;
        let pid1 = e1.pid;

        let mut e2 = dummy_process_real_pid();
        e2.config_hash = 2;
        let pid2 = e2.pid;

        pool.put("key".to_string(), e1);
        pool.put("key".to_string(), e2);

        let mut taken = pool.take("key").unwrap();
        assert_eq!(taken.config_hash, 2);
        assert_eq!(taken.pid, pid2);
        taken.kill();

        let status = unsafe { libc::kill(pid1 as i32, 0) };
        assert_ne!(status, 0, "replaced process must be killed and reaped");
    }

    // ────────────────────────────────────────────────────────
    // ProcessPool: remove
    // ────────────────────────────────────────────────────────

    #[test]
    fn pool_remove_kills_and_removes() {
        let pool = ProcessPool::new();
        let entry = dummy_process_real_pid();
        let pid = entry.pid;
        pool.put("key".to_string(), entry);

        pool.remove("key");

        // Key should no longer exist
        assert!(pool.take("key").is_none());

        // Process should be dead (give it a moment)
        std::thread::sleep(std::time::Duration::from_millis(50));
        let status = unsafe { libc::kill(pid as i32, 0) };
        assert_ne!(status, 0, "process should be dead after remove");
    }

    #[test]
    fn pool_remove_nonexistent_key_is_noop() {
        let pool = ProcessPool::new();
        pool.remove("nonexistent"); // should not panic
    }

    // ────────────────────────────────────────────────────────
    // ProcessPool: remove_by_pid (used by stop_agent)
    // ────────────────────────────────────────────────────────

    #[test]
    fn pool_remove_by_pid_removes_correct_entry() {
        let pool = ProcessPool::new();
        let e1 = dummy_process_real_pid();
        let pid1 = e1.pid;
        let e2 = dummy_process_real_pid();
        let pid2 = e2.pid;

        pool.put("agent1".to_string(), e1);
        pool.put("agent2".to_string(), e2);

        // Remove agent1 by PID
        pool.remove_by_pid(pid1);

        // agent1 should be gone
        assert!(pool.take("agent1").is_none());

        // agent2 should still be there
        let mut remaining = pool.take("agent2").unwrap();
        assert_eq!(remaining.pid, pid2);
        remaining.kill();

        // Clean up pid1's process
        unsafe {
            libc::kill(pid1 as i32, libc::SIGTERM);
        }
    }

    #[test]
    fn pool_remove_by_pid_nonexistent_is_noop() {
        let pool = ProcessPool::new();
        let entry = dummy_process_real_pid();
        let pid = entry.pid;
        pool.put("key".to_string(), entry);

        pool.remove_by_pid(99999); // non-existent PID

        // Original entry should still be there
        let mut taken = pool.take("key").unwrap();
        assert_eq!(taken.pid, pid);
        taken.kill();
    }

    // ────────────────────────────────────────────────────────
    // ProcessPool: kill_all (app shutdown)
    // ────────────────────────────────────────────────────────

    #[test]
    fn pool_kill_all_clears_everything() {
        let pool = ProcessPool::new();
        let e1 = dummy_process_real_pid();
        let pid1 = e1.pid;
        let e2 = dummy_process_real_pid();
        let pid2 = e2.pid;

        pool.put("a".to_string(), e1);
        pool.put("b".to_string(), e2);

        pool.kill_all();

        // Both should be gone from pool
        assert!(pool.take("a").is_none());
        assert!(pool.take("b").is_none());

        // Both processes should be dead
        std::thread::sleep(std::time::Duration::from_millis(50));
        let s1 = unsafe { libc::kill(pid1 as i32, 0) };
        let s2 = unsafe { libc::kill(pid2 as i32, 0) };
        assert_ne!(s1, 0, "process 1 should be dead after kill_all");
        assert_ne!(s2, 0, "process 2 should be dead after kill_all");
    }

    #[test]
    fn pool_kill_all_on_empty_pool_is_noop() {
        let pool = ProcessPool::new();
        pool.kill_all(); // should not panic
    }

    // ────────────────────────────────────────────────────────
    // ProcessEntry: is_alive
    // ────────────────────────────────────────────────────────

    #[test]
    fn process_entry_is_alive_for_running_process() {
        let mut entry = dummy_process_real_pid();
        assert!(entry.is_alive());
        entry.kill();
    }

    #[test]
    fn process_entry_is_not_alive_after_kill() {
        let mut entry = dummy_process_real_pid();
        entry.kill();
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(!entry.is_alive());
    }

    // ────────────────────────────────────────────────────────
    // Config hash for cache invalidation
    // ────────────────────────────────────────────────────────

    #[test]
    fn hash_config_same_input_same_output() {
        let h1 = ProcessPool::hash_config(&["agent", "opus", "perms"]);
        let h2 = ProcessPool::hash_config(&["agent", "opus", "perms"]);
        assert_eq!(h1, h2);
    }

    #[test]
    fn hash_config_different_input_different_output() {
        let h1 = ProcessPool::hash_config(&["agent", "opus", "perms"]);
        let h2 = ProcessPool::hash_config(&["agent", "haiku", "perms"]);
        assert_ne!(h1, h2, "different model should produce different hash");
    }

    #[test]
    fn hash_config_order_matters() {
        let h1 = ProcessPool::hash_config(&["a", "b"]);
        let h2 = ProcessPool::hash_config(&["b", "a"]);
        assert_ne!(h1, h2, "order should matter for config hash");
    }

    #[test]
    fn hash_config_empty_parts() {
        let h1 = ProcessPool::hash_config(&[]);
        let h2 = ProcessPool::hash_config(&[]);
        assert_eq!(h1, h2);
    }

    // ────────────────────────────────────────────────────────
    // Config change detection (simulates cache invalidation)
    // ────────────────────────────────────────────────────────

    #[test]
    fn config_change_triggers_process_replacement() {
        let pool = ProcessPool::new();
        let mut entry = dummy_process_real_pid();
        let _old_pid = entry.pid;

        // Simulate: old process has hash for "opus" config
        entry.config_hash = ProcessPool::hash_config(&["agent", "opus"]);
        pool.put("key".to_string(), entry);

        // New request comes with "haiku" config
        let new_hash = ProcessPool::hash_config(&["agent", "haiku"]);
        let mut taken = pool.take("key").unwrap();

        // Config changed → should create new process
        assert_ne!(
            taken.config_hash, new_hash,
            "config hash mismatch should trigger replacement"
        );
        taken.kill();
    }

    #[test]
    fn same_config_reuses_process() {
        let pool = ProcessPool::new();
        let mut entry = dummy_process_real_pid();
        let original_pid = entry.pid;

        let hash = ProcessPool::hash_config(&["agent", "opus"]);
        entry.config_hash = hash;
        pool.put("key".to_string(), entry);

        let new_hash = ProcessPool::hash_config(&["agent", "opus"]);
        let mut taken = pool.take("key").unwrap();

        // Same config → should reuse
        assert_eq!(
            taken.config_hash, new_hash,
            "same config should reuse process"
        );
        assert_eq!(taken.pid, original_pid, "PID should be the same (reused)");
        taken.kill();
    }

    // ────────────────────────────────────────────────────────
    // Concurrent access safety (basic check)
    // ────────────────────────────────────────────────────────

    #[test]
    fn pool_concurrent_take_put() {
        use std::sync::Arc;
        use std::thread;

        let pool = Arc::new(ProcessPool::new());
        let mut handles = vec![];

        // Spawn 10 threads that each put and take
        for i in 0..10 {
            let pool_clone = pool.clone();
            handles.push(thread::spawn(move || {
                let key = format!("agent_{}", i);
                let entry = dummy_process_real_pid();
                let pid = entry.pid;
                pool_clone.put(key.clone(), entry);

                // Small delay
                std::thread::sleep(std::time::Duration::from_millis(5));

                if let Some(mut taken) = pool_clone.take(&key) {
                    taken.kill();
                } else {
                    // Another thread may have taken it — that's fine for this test
                    unsafe {
                        libc::kill(pid as i32, libc::SIGTERM);
                    }
                }
            }));
        }

        for h in handles {
            h.join().unwrap();
        }

        // Pool should be empty after all threads
        pool.kill_all();
    }

    // ────────────────────────────────────────────────────────
    // Dispatcher pool key isolation
    // ────────────────────────────────────────────────────────

    #[test]
    fn dispatcher_and_agent_use_separate_keys() {
        let pool = ProcessPool::new();

        let mut dispatcher_entry = dummy_process_real_pid();
        dispatcher_entry.config_hash = 100;
        let dispatcher_pid = dispatcher_entry.pid;

        let mut agent_entry = dummy_process_real_pid();
        agent_entry.config_hash = 200;
        let agent_pid = agent_entry.pid;

        pool.put("__dispatcher__".to_string(), dispatcher_entry);
        pool.put("/path/to/folder::developer".to_string(), agent_entry);

        // Taking dispatcher should not affect agent
        let mut d = pool.take("__dispatcher__").unwrap();
        assert_eq!(d.config_hash, 100);
        assert_eq!(d.pid, dispatcher_pid);

        let mut a = pool.take("/path/to/folder::developer").unwrap();
        assert_eq!(a.config_hash, 200);
        assert_eq!(a.pid, agent_pid);

        d.kill();
        a.kill();
    }

    // ────────────────────────────────────────────────────────
    // stop_agent flow simulation (removal also reaps through Drop)
    // ────────────────────────────────────────────────────────

    #[test]
    fn stop_agent_flow_removes_from_pool_without_double_kill() {
        let pool = ProcessPool::new();
        let entry = dummy_process_real_pid();
        let pid = entry.pid;

        pool.put("folder::agent".to_string(), entry);

        // Simulate stop_agent: remove_by_pid just removes from map
        pool.remove_by_pid(pid);

        // Entry should be gone
        assert!(pool.take("folder::agent").is_none());

        // RAII removal must not orphan the child even if the caller's
        // follow-up PID signal is delayed or fails.
        let status = unsafe { libc::kill(pid as i32, 0) };
        assert_ne!(status, 0, "removed process must be killed and reaped");
    }
}
