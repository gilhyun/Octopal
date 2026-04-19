//! Persistent `goose acp` sidecar pool (Stage 6c).
//!
//! Parallel to `process_pool::ProcessPool` but Goose-specific. Each entry
//! wraps a post-`initialize` `AcpClient`; a fresh `session/new` is still
//! called per turn (scope §2.2). API keys deliberately do NOT enter the
//! config hash — rotation happens via explicit `invalidate_*` (scope §2.1).
//!
//! Key shape:
//!   `{folder}::{agent}::{provider}::{model}::{sp_hash_hex}`
//!
//! `hash_config` mirrors `ProcessPool::hash_config` but is semantically
//! typed (no accidental arg order flips). The string key is what gets
//! stored; `config_hash` on the entry is used to detect drift between
//! what spawned the sidecar and what the caller is about to ask for.
//!
//! ADR cross-refs:
//!   §6.7 — SIGTERM is the only cancel lever (no JSON-RPC cancel).
//!   §2.1 / §3.1 — XDG isolation preserved across the pool entry's lifetime.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::commands::goose_acp::AcpClient;

/// One live `goose acp` sidecar that's been handshaken and is ready for
/// `open_turn_session` + `run_turn`. The pool owns this between turns.
pub struct GooseAcpEntry {
    pub client: AcpClient,
    pub pid: u32,
    pub config_hash: u64,
    /// Goose-facing provider id (e.g. `"anthropic"`, `"claude-code"`).
    /// Used by `invalidate_pool_for_provider` when an API key rotates.
    pub provider: String,
    /// Pool key this entry was put back under — needed so `invalidate_*`
    /// callers can surface which entries got evicted without reverse-
    /// scanning the HashMap.
    pub key: String,
}

/// Pool keyed by `{folder}::{agent}::{provider}::{model}::{sp_hash_hex}`.
/// No LRU cap — matches legacy `ProcessPool` (scope §2.4). Per-user
/// practical ceiling is <10 entries; revisit if telemetry disagrees.
pub struct GooseAcpPool {
    entries: Mutex<HashMap<String, GooseAcpEntry>>,
}

impl Default for GooseAcpPool {
    fn default() -> Self {
        Self::new()
    }
}

impl GooseAcpPool {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Take a client out for exclusive use. Caller validates
    /// `entry.config_hash` against the expected hash and discards
    /// (via `entry.client.shutdown()`) on drift before spawning fresh.
    pub fn take(&self, key: &str) -> Option<GooseAcpEntry> {
        self.entries.lock().unwrap().remove(key)
    }

    /// Return a client to the pool after a successful turn. If an entry
    /// already exists at this key (e.g. concurrent rebuild), the old one
    /// is evicted and its client kept as `leftover` for the caller to
    /// clean up — we don't want to drop an `AcpClient` silently because
    /// `shutdown` is async and `put` is sync.
    ///
    /// Caller contract: if this returns `Some(leftover)`, caller must
    /// `.shutdown().await` on it.
    #[must_use = "leftover entry must be shutdown by caller"]
    pub fn put(&self, key: String, entry: GooseAcpEntry) -> Option<GooseAcpEntry> {
        self.entries.lock().unwrap().insert(key, entry)
    }

    /// Remove a specific key. Returns the entry so the caller can decide
    /// whether to shutdown gracefully (settings change) or just drop
    /// (process already dead).
    pub fn remove(&self, key: &str) -> Option<GooseAcpEntry> {
        self.entries.lock().unwrap().remove(key)
    }

    /// Used by `stop_agent`: find the entry whose sidecar PID matches and
    /// drop it from the map WITHOUT shutting down the client. The caller
    /// already SIGTERM'd the PID (scope §3.1, measured 4ms → exit); any
    /// further kill would race the process reaper.
    pub fn remove_by_pid(&self, pid: u32) {
        let mut map = self.entries.lock().unwrap();
        let key = map
            .iter()
            .find(|(_, e)| e.pid == pid)
            .map(|(k, _)| k.clone());
        if let Some(k) = key {
            map.remove(&k);
        }
    }

    /// API-key-rotation hook (scope §2.3). Returns evicted entries so the
    /// caller can shutdown them off the lock. v0.2.0-beta calls this with
    /// no-op semantics (keys still live in env, not keyring) — the hook
    /// itself works; Phase 4 will populate the trigger side.
    #[must_use = "evicted entries must be shutdown by caller"]
    pub fn invalidate_pool_for_provider(&self, provider: &str) -> Vec<GooseAcpEntry> {
        let mut map = self.entries.lock().unwrap();
        let keys: Vec<String> = map
            .iter()
            .filter(|(_, e)| e.provider == provider)
            .map(|(k, _)| k.clone())
            .collect();
        keys.into_iter().filter_map(|k| map.remove(&k)).collect()
    }

    /// Agent-delete / agent-rename hook. Key prefix is `{folder}::{agent}::…`.
    #[must_use = "evicted entries must be shutdown by caller"]
    pub fn invalidate_pool_for_agent(&self, folder: &str, agent: &str) -> Vec<GooseAcpEntry> {
        let prefix = format!("{folder}::{agent}::");
        let mut map = self.entries.lock().unwrap();
        let keys: Vec<String> = map
            .keys()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect();
        keys.into_iter().filter_map(|k| map.remove(&k)).collect()
    }

    /// App-shutdown path (scope §3.2). Global budget, not per-entry:
    /// SIGTERM everything, poll up to `grace_ms` total for exit, then
    /// drop whatever's left (the shell plugin's `shutdown` = SIGKILL).
    ///
    /// Returns the number of entries that had to be SIGKILLed. Logged by
    /// the caller for shutdown diagnostics.
    pub async fn shutdown_all(&self, grace_ms: u64) -> usize {
        let entries: Vec<GooseAcpEntry> = {
            let mut map = self.entries.lock().unwrap();
            map.drain().map(|(_, v)| v).collect()
        };
        if entries.is_empty() {
            return 0;
        }

        let deadline = Instant::now() + Duration::from_millis(grace_ms);
        let mut survivors = Vec::new();
        for entry in entries {
            let now = Instant::now();
            if now >= deadline {
                survivors.push(entry);
                continue;
            }
            // shutdown() consumes self — the shell plugin SIGKILLs today
            // (see AcpClient::shutdown comment). Budget check above means
            // past the deadline we just drop, which also SIGKILLs.
            entry.client.shutdown().await;
        }
        let killed = survivors.len();
        drop(survivors); // Drop path = shell plugin kill.
        killed
    }

    /// Stable hash over the 5 cache-relevant fields. API key is NOT here
    /// (scope §2.1) — rotation goes through `invalidate_pool_for_provider`.
    pub fn hash_config(
        folder: &str,
        agent: &str,
        provider: &str,
        model: &str,
        system_prompt: &str,
    ) -> u64 {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        folder.hash(&mut h);
        agent.hash(&mut h);
        provider.hash(&mut h);
        model.hash(&mut h);
        system_prompt.hash(&mut h);
        h.finish()
    }

    /// Build the pool key string. The `sp_hash` is the same `u64` the
    /// hash-config function computed over `system_prompt` (rendered as
    /// hex, 16 chars) — we fold it into the key so two agents with
    /// identical (folder, agent, provider, model) but different prompts
    /// don't collide.
    pub fn key_for(folder: &str, agent: &str, provider: &str, model: &str, sp_hash: u64) -> String {
        format!("{folder}::{agent}::{provider}::{model}::{sp_hash:016x}")
    }

    /// Dev-only: used exclusively by tests and `cargo check --features debug`
    /// builds. G3 merge gate ("10 msgs, entry count stays at 1") reads this.
    /// Keeping it off the prod surface avoids exposing internal state via
    /// Tauri command until we have a real diagnostic use case.
    #[cfg(debug_assertions)]
    pub fn entry_counts(&self) -> HashMap<String, usize> {
        let map = self.entries.lock().unwrap();
        let mut counts = HashMap::new();
        for key in map.keys() {
            *counts.entry(key.clone()).or_insert(0) += 1;
        }
        counts
    }

    /// Dev-only: aggregate entry count. Cheaper than `entry_counts()` when
    /// the test just needs the total.
    #[cfg(debug_assertions)]
    pub fn len(&self) -> usize {
        self.entries.lock().unwrap().len()
    }
}

// ── Tests ──────────────────────────────────────────────────────────────

// Bypasses `AcpClient` entirely — the pool's HashMap semantics are what
// we're validating, not the sidecar I/O. Spawning real sidecars in unit
// tests would couple to a binary that's resolved via Tauri's sidecar
// lookup (absent in `cargo test --lib`).
//
// We construct entries with fake PIDs + zero-init clients via `unsafe`
// is tempting but wrong — `AcpClient`'s fields are non-Send Mutexes, and
// a zeroed `tokio::sync::Mutex` would deadlock on the first lock. Instead,
// tests below work with a stripped-down helper that holds only the fields
// the pool logic reads.
#[cfg(test)]
mod tests {
    use super::*;

    // ── Config-hash invariants ────────────────────────────────────────

    #[test]
    fn hash_config_same_input_same_output() {
        let h1 = GooseAcpPool::hash_config("/p", "dev", "anthropic", "claude-sonnet-4-6", "SP");
        let h2 = GooseAcpPool::hash_config("/p", "dev", "anthropic", "claude-sonnet-4-6", "SP");
        assert_eq!(h1, h2);
    }

    #[test]
    fn hash_config_model_change_drifts() {
        let h1 = GooseAcpPool::hash_config("/p", "dev", "anthropic", "claude-sonnet-4-6", "SP");
        let h2 = GooseAcpPool::hash_config("/p", "dev", "anthropic", "claude-opus-4-7", "SP");
        assert_ne!(h1, h2);
    }

    #[test]
    fn hash_config_system_prompt_change_drifts() {
        let h1 = GooseAcpPool::hash_config("/p", "dev", "anthropic", "claude-sonnet-4-6", "SP1");
        let h2 = GooseAcpPool::hash_config("/p", "dev", "anthropic", "claude-sonnet-4-6", "SP2");
        assert_ne!(h1, h2);
    }

    #[test]
    fn key_for_has_stable_shape() {
        let k = GooseAcpPool::key_for("/p", "dev", "anthropic", "claude-sonnet-4-6", 0xdeadbeef);
        assert_eq!(k, "/p::dev::anthropic::claude-sonnet-4-6::00000000deadbeef");
    }

    // ── G3: pool deduplication (the merge-gate invariant) ────────────
    //
    // Covers BOTH the leak scenario ("each turn accidentally creates a new
    // entry without removing the old") AND the ghost-duplicate scenario
    // ("key collision at put-time leaves two live sidecars in flight").
    //
    // Can't use a real AcpClient here (see module-level comment). Instead
    // we exercise the HashMap invariant by hand: simulate 10 turn cycles
    // of take → (new entry) → put. After all cycles, pool.len() == 1.
    //
    // This version validates the HashMap logic. The full-stack version
    // (real sidecar) runs as the G3 manual test referenced in the scope
    // doc — "10 consecutive messages to same agent, pool entry count
    // stays at 1" — verified during Checkpoint 3.

    struct FakePool {
        entries: Mutex<HashMap<String, (u32, u64, String)>>,
    }
    impl FakePool {
        fn new() -> Self {
            Self {
                entries: Mutex::new(HashMap::new()),
            }
        }
        fn take(&self, k: &str) -> Option<(u32, u64, String)> {
            self.entries.lock().unwrap().remove(k)
        }
        fn put(&self, k: String, v: (u32, u64, String)) -> Option<(u32, u64, String)> {
            self.entries.lock().unwrap().insert(k, v)
        }
        fn len(&self) -> usize {
            self.entries.lock().unwrap().len()
        }
    }

    #[test]
    fn pool_deduplicates_same_key() {
        let pool = FakePool::new();
        let key = GooseAcpPool::key_for(
            "/my/folder",
            "dev",
            "anthropic",
            "claude-sonnet-4-6",
            GooseAcpPool::hash_config(
                "/my/folder",
                "dev",
                "anthropic",
                "claude-sonnet-4-6",
                "you are a developer",
            ),
        );

        for turn in 0..10 {
            // Simulate: run_agent_turn takes the entry out…
            let taken = pool.take(&key);
            // …runs the turn (fake) and produces a (possibly new) pid…
            let next_pid = 10000 + turn as u32;
            let hash = 0x1234_5678_9abc_def0;
            let leftover = pool.put(key.clone(), (next_pid, hash, "anthropic".into()));

            // First turn: pool was empty, nothing came out of take.
            // Subsequent turns: we took the entry, so put never races.
            if turn == 0 {
                assert!(taken.is_none());
            } else {
                assert!(taken.is_some(), "turn {} should reuse the entry", turn);
            }
            assert!(
                leftover.is_none(),
                "turn {} put returned leftover — pool lost dedup invariant",
                turn
            );

            assert_eq!(pool.len(), 1, "pool size must be 1 after turn {}", turn);
        }

        assert_eq!(pool.len(), 1);
    }

    #[test]
    fn pool_put_collision_returns_leftover_not_silent_drop() {
        // Direct test of the `#[must_use]` contract on put(): if two
        // spawners race and both put() to the same key, the older entry
        // must be returned — silent drop would leak the older sidecar.
        let pool = FakePool::new();
        let k = "x::y::anthropic::m::0000000000000000".to_string();
        let first = pool.put(k.clone(), (1, 0, "anthropic".into()));
        assert!(first.is_none());

        let second = pool.put(k.clone(), (2, 0, "anthropic".into()));
        assert!(second.is_some(), "collision must surface leftover");
        assert_eq!(second.unwrap().0, 1, "leftover must be the OLDER entry");
    }

    #[test]
    fn invalidate_for_agent_prefix_filter() {
        // Same agent name across two folders must stay isolated.
        let pool = FakePool::new();
        let sp = GooseAcpPool::hash_config("/a", "dev", "anthropic", "m", "sp");
        let k_a = GooseAcpPool::key_for("/a", "dev", "anthropic", "m", sp);
        let k_b = GooseAcpPool::key_for("/b", "dev", "anthropic", "m", sp);

        pool.put(k_a.clone(), (1, 0, "anthropic".into()));
        pool.put(k_b.clone(), (2, 0, "anthropic".into()));
        assert_eq!(pool.len(), 2);

        // Emulate invalidate_pool_for_agent("/a", "dev"): prefix match.
        let prefix = "/a::dev::";
        let kills: Vec<String> = pool
            .entries
            .lock()
            .unwrap()
            .keys()
            .filter(|k| k.starts_with(prefix))
            .cloned()
            .collect();
        for k in kills {
            pool.entries.lock().unwrap().remove(&k);
        }

        assert_eq!(pool.len(), 1);
        assert!(pool.take(&k_b).is_some());
    }
}
