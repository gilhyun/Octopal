# Stage 6c — ACP process_pool Integration

**Status:** proposed (pending review)
**Owner:** Gil
**Parent plan:** `reactive-floating-feather.md` §Phase 2 (Stop/Cancel/Timeout)
**Depends on:** Stage 6a (ACP run_agent_turn), Stage 6b-i (settings flag)
**Blocks:** legacy-parity PR for Goose path; Phase 3+4 (keyring) depends on this for realistic spawn cost

---

## 1. Goal

Close the last legacy-parity gap on the Goose ACP path: reuse a persistent `goose acp` sidecar across turns instead of cold-starting per turn. Current behavior (Stage 6a) spawns a fresh sidecar for every `send_message`, pays the `initialize` + `session/new` handshake every time, and tears it down on return — ~cold-start per user message, noticeable versus legacy.

**Not in scope:** dispatcher migration to Goose (6b-ii), multi-provider keyring (Phase 3+4), per-agent model pin UI (Phase 5).

---

## 2. Pool design

### 2.1 Key

```
(folder, agent_name, provider, model, system_prompt_hash)
```

Encoded as one `String` for the existing `HashMap<String, _>` surface:

```
{folder}::{agent}::{provider}::{model}::{sp_hash_hex}
```

**Hash is over those 5 fields only.** API key is NOT in the key — per Phase 0 decision (plan §Phase 2, "config-hash에 API 키 포함 금지"). Rationale: keyring read on every `take()` would trigger macOS Keychain "allow" prompts if the user hasn't clicked "Always allow". Key rotation is handled by explicit invalidation (§2.3), not by hash drift.

### 2.2 Pool object

Existing `ProcessPool` is Claude-CLI-specific: `ProcessEntry` holds stream-json stdin/stdout and `claude_command()` spawn. We **do not overload it**. Instead:

- Add `GooseAcpPool` alongside — new struct in `src-tauri/src/commands/goose_acp_pool.rs` (new file).
- `GooseAcpEntry` wraps `AcpClient` + child PID + `config_hash` + `created_at`.
- `ManagedState` grows `goose_acp_pool: Arc<GooseAcpPool>` next to the existing `process_pool`.
- `run_agent_turn` changes from "spawn + shutdown per turn" to "`pool.take_or_spawn(key)` → run → `pool.put(key, client)` on success, `pool.kill(key)` on interrupt/error".

Session lifecycle: **new `session/new` per turn, process persists.** The `initialize` handshake is what we're caching; `session/new` is cheap (~10ms in probes). Persistent session across turns adds cancel-state complexity for no meaningful latency win.

### 2.3 Invalidation triggers

The pool entry is killed + removed when any of these happen:

| Trigger | Source | Mechanism |
|---|---|---|
| Config hash mismatch on `take()` | Agent config edited (model / system_prompt / provider) | `if entry.config_hash != expected → kill + create` |
| Process died | Sidecar crashed or was OOM-killed | `!entry.is_alive() → discard + create` |
| API key changed | Settings → save handler | `invalidate_pool_for_provider(provider)` event-driven call. **Matches plan §Phase 2 spec** — settings save handler iterates pool and kills entries whose provider matches |
| Agent deleted | Octo CRUD | `invalidate_pool_for_agent(folder, agent)` |
| Provider changed on an agent | Agent edit modal | Handled via config_hash mismatch (provider is in the key) |
| App shutdown | Tauri window close | `shutdown_all(grace_ms=200)` — see §3.2 |

Settings save handler change: when `save_settings` detects a keyring entry changed or a provider field flipped, call `state.goose_acp_pool.invalidate_pool_for_provider(&p)` before returning. Phase 3+4 wires the keyring side; 6c only adds the pool-side hook, called with a placeholder for now (invalidation is a no-op until keys live in keyring — acceptable since 6c ships while `ANTHROPIC_API_KEY` still reads from env, and env changes require app restart anyway).

### 2.4 Pool size

Legacy `ProcessPool` has **no cap** (unbounded `HashMap`). Match that. Per-user practical ceiling is ~3–5 agents × 1–2 active folders = <10 entries. An LRU cap is future-proofing we don't need yet — note in §7 as Stage 6d candidate if pool growth becomes a memory issue in telemetry.

---

## 3. Stop button / cancel / shutdown

### 3.1 Stop mid-turn (user clicks Stop)

**Correction to scope request:** `session/cancel` is NOT a valid path. ADR §6.7 Q-C probe resolution: all cancel-family methods (`session/cancel`, `session/stop`, `session/abort`, `session/interrupt`, `session/cancelPrompt`, `session/end`, `session/terminate`) return `-32601 Method not found` on Goose v1.31.0. Process-level SIGTERM is the only cancel lever.

**Actual path:**

```
Stop button → stop_agent(run_id)
  → lookup goose_acp_pool entry by PID (mirror process_pool.remove_by_pid)
  → SIGTERM child                    (measured 4ms → stdout EOF, clean signal exit)
  → pool.remove() without kill       (process already exiting)
  → interrupted_runs.insert(run_id)  (existing legacy signaling)
  → run_agent_turn observes interrupt, returns Ok with partial collected_text
     (already implemented in Stage 6a fix — App.tsx:1255 renders partial silently)
```

No "try cancel first, fallback to SIGTERM." The measured 4ms SIGTERM→exit makes any JSON-RPC handshake layer slower than just killing.

### 3.2 App shutdown (Cmd-Q / window close)

Tauri `on_window_event::CloseRequested` handler calls `goose_acp_pool.shutdown_all(grace_ms=200)`:

1. For each entry: SIGTERM the sidecar.
2. Wait up to 200ms total (not per entry — total budget, to avoid O(n) close delay on quit).
3. Any survivor → SIGKILL.
4. Clear the `HashMap`.

200ms is ADR §6.7 prescribed grace. Per probe, 4ms SIGTERM→exit means the 200ms is pure defensive slack.

### 3.3 Pool shutdown vs process_pool.kill_all

Legacy `ProcessPool::kill_all` is immediate SIGKILL via `kill_pid` + `child.kill()`. 6c adds the grace-based variant only to `GooseAcpPool` — legacy stays unchanged (G2 gate).

---

## 4. Implementation steps

### 4.1 New file: `src-tauri/src/commands/goose_acp_pool.rs`

```rust
pub struct GooseAcpEntry {
    pub client: AcpClient,       // owns stdin/stdout to child
    pub pid: u32,
    pub config_hash: u64,
    pub provider: String,        // for invalidate_pool_for_provider
    pub key: String,             // echo of pool key (saves a reverse scan)
}

pub struct GooseAcpPool {
    entries: Mutex<HashMap<String, GooseAcpEntry>>,
}

impl GooseAcpPool {
    pub fn new() -> Self;
    pub fn take(&self, key: &str) -> Option<GooseAcpEntry>;
    #[must_use] pub fn put(&self, key: String, entry: GooseAcpEntry) -> Option<GooseAcpEntry>;
    pub fn remove(&self, key: &str) -> Option<GooseAcpEntry>;
    pub fn remove_by_pid(&self, pid: u32);                            // Stop button
    #[must_use] pub fn invalidate_pool_for_provider(&self, p: &str) -> Vec<GooseAcpEntry>;
    #[must_use] pub fn invalidate_pool_for_agent(&self, f: &str, a: &str) -> Vec<GooseAcpEntry>;
    pub async fn shutdown_all(&self, grace_ms: u64) -> usize;         // app exit → count SIGKILLed
    pub fn hash_config(folder: &str, agent: &str, provider: &str,
                       model: &str, system_prompt: &str) -> u64;
    pub fn key_for(folder: &str, agent: &str, provider: &str,
                   model: &str, sp_hash: u64) -> String;
    #[cfg(debug_assertions)] pub fn entry_counts(&self) -> HashMap<String, usize>;
    #[cfg(debug_assertions)] pub fn len(&self) -> usize;
}
```

**Deviation from the original scope (Checkpoint 2, elevated to prevent sidecar leaks):**
- `put` and both `invalidate_*` return evicted entries rather than `()`. Plus `#[must_use]`. Rationale: `AcpClient::shutdown()` is `async`, these methods are `sync` under a `Mutex` — returning the entry forces the caller to `.shutdown().await` after dropping the lock. Silent eviction would leak a sidecar per collision.
- `entry_counts()` / `len()` gated by `#[cfg(debug_assertions)]`. No prod surface yet; promote when Stage 6d LRU discussion needs it.
- Added `GooseAcpEntry.key` and a free `key_for(...)` builder for stable key construction + cheaper invalidation paths.

**Key-as-hash semantic (important for invalidation design):** `sp_hash` is **part of the key**, not a drift detector inside an entry. Editing an agent's prompt/model/provider changes the key → `pool.take(new_key)` returns `None` → MISS path. The old entry is never compared against the new key, so the `config_hash drift` log in §5(c) **never fires via agent-config edits**. That log path is reserved exclusively for `invalidate_pool_for_provider` (Phase 4 keyring rotation), where the key stays the same but an out-of-band change forces eviction. See §10 for the orphan-leak known limitation this causes.

### 4.2 `goose_acp.rs::run_agent_turn`

- Replace the top-of-function spawn path with `pool.take()` → validate `config_hash` + `is_alive()` → reuse or discard+respawn.
- Skip `initialize` + `session/new` on reused entries; `session/new` still runs per turn (see §2.2).

Wait — **we DO need `session/new` per turn, but `initialize` only once.** The cached `AcpClient` holds the post-`initialize` state. Persisting the whole client skips the handshake. Current code calls both in sequence; factor `initialize` into `AcpClient::new()` and leave `session/new` as a per-turn method.

- On turn success: `pool.put(key, entry)` before returning.
- On turn error or interrupt: `entry.client.kill()` + DO NOT return to pool.
- Config-hash drift path: kill existing, create new, proceed.

### 4.3 `agent.rs::stop_agent`

Add a Goose-pool branch parallel to the existing `process_pool.remove_by_pid`:

```rust
if let Some(pid) = state.running_agents.lock().unwrap().remove(&run_id) {
    state.interrupted_runs.lock().unwrap().insert(run_id);
    state.process_pool.remove_by_pid(pid);       // legacy (no-op if ACP)
    state.goose_acp_pool.remove_by_pid(pid);     // ACP (no-op if legacy)
    kill_pid(pid);
    // ...
}
```

Both calls are cheap (one HashMap scan each); the one that owns the PID acts, the other is a no-op.

### 4.4 `lib.rs` shutdown wiring

In `tauri::Builder::on_window_event`, on `WindowEvent::CloseRequested` for the last window, `tokio::spawn(async move { pool.shutdown_all(200).await; })` before actually closing. Existing `process_pool.kill_all()` stays (legacy path).

### 4.5 `state.rs::ManagedState`

Add `pub goose_acp_pool: Arc<GooseAcpPool>`. Initialize in `ManagedState::new()`.

### 4.6 `save_settings` handler hook

In `commands::settings::save_settings`, after persisting: if the incoming settings' providers section changed (compare with pre-save snapshot), call `state.goose_acp_pool.invalidate_pool_for_provider(provider)`. v0.2.0-beta: no-op placeholder because key values don't live in settings yet. Stage 6d / Phase 4 fills this in properly when keyring lands.

---

## 5. Success criteria (merge gates)

Each must be evidenced in the PR description with a log excerpt or screenshot:

**(a) 2nd turn skips handshake**
```
turn 1: [goose_acp_pool] MISS key=foo::bar::anthropic::… spawn
        [acp] → initialize   ← only here
        [acp] → session/new
turn 2: [goose_acp_pool] HIT  key=foo::bar::anthropic::…
        [acp] → session/new  ← no initialize
```

**(b) Latency parity with legacy on same-agent repeats**
- 3 back-to-back messages, measured client-side from `send_message` invoke to first `octo:textChunk`.
- Turn 1 (cold): ~legacy cold-start +100ms slack.
- Turns 2–3 (hot): within 50ms of legacy hot-path baseline.
- Evidence: `console.time` samples or a simple Vitest instrumentation in the smoke test.

**(c) Config-change rotation**
- Edit an agent's model in the UI → save → send message.
- Log shows:
```
[goose_acp_pool] config_hash drift for key=…  (0xabcd → 0xef01)
[goose_acp_pool] killing pid=12345
[goose_acp_pool] spawn new  pid=12567
```

**(d) Stop button on pool member**
- Start a long turn → click Stop at ~2s.
- Log shows:
```
[stop_agent] run=… pid=12567 → SIGTERM
[goose_acp_pool] remove_by_pid=12567 (exited via signal)
```
- Bubble renders partial text (Stage 6a interrupt fix path unchanged).
- The pool has NO dead entry afterward (`pool.take(key)` → `None` on next turn → fresh spawn).

---

## 6. Plan document updates

Deltas to `reactive-floating-feather.md` (single edit PR, separate commit from the code changes so reviewers can diff each clean):

### 6.1 §Phase 2 — replace paragraph "Stop 버튼 / Cancel / Timeout 처리"

Remove the "session/cancel JSON-RPC request 전송" sentence. Replace with: "Stop 버튼 → SIGTERM 직접 (Q-C probe 4ms → clean exit). `session/cancel`은 Goose v1.31.0에 존재하지 않음 (-32601) — ADR §6.7 확정." Cross-reference ADR §6.7.

Also update "**Client-side timeout**" paragraph: remove "타임아웃 도달 시 `session/cancel` 자동 전송" → "타임아웃 도달 시 SIGTERM".

### 6.2 §Phase 2 — add sub-section "ACP process pool (Stage 6c)"

Short (~10 lines) pointing at this scope doc. Document:
- pool key shape
- invalidation trigger list
- no LRU cap (matches legacy)
- app-shutdown 200ms grace

### 6.3 §Future Roadmap — add "v0.3.0: Stage 6d (optional)"

> **Stage 6d — Pool LRU cap + orphan GC**: two related follow-ups gated on telemetry:
> 1. **LRU eviction** if pool growth > 20 entries in steady state (e.g. users swapping between many project folders).
> 2. **Orphan cleanup on MISS** — when `take(new_key)` returns `None`, scan for entries with same `{folder, agent, provider, model}` prefix but different `sp_hash` and evict them. Closes the prompt-tuning leak (see §10 Known Limitations). Currently a mid-session dogfooding user tuning prompts can accumulate ~55MB/orphan until window close.
>
> Punt both until measured demand exists. Stage 6a/6c telemetry in the first 2 weeks of v0.2.0-beta decides scope.

### 6.4 §주요 리스크 — update #9 ("글로벌 Goose 설정 오염")

Add one line: "Pool 도입으로 sidecar가 장수 프로세스 됨 — XDG 격리 검증은 **각 pool 엔트리 수명 전체**에 대해 유지돼야 함. Phase 10 test #9의 해시 비교를 '메시지 1회 후' 뿐 아니라 '메시지 5회 + 에이전트 config edit 1회' 시나리오로도 실행."

### 6.5 §Critical Files — add

- `src-tauri/src/commands/goose_acp_pool.rs` (신규)

---

## 7. Open questions (pre-implementation)

| # | Question | Resolution path |
|---|---|---|
| Q1 | AcpClient initialize path — is it already separable from session/new, or does `new()` do both? | Read `goose_acp.rs::AcpClient::new` at impl time. If coupled, factor into `new` + `open_session`. Low risk — 10-min refactor |
| Q2 | Does `session/new` reuse of a capability-negotiated client work, or does Goose require a fresh `initialize` per ~N minutes? | Smoke test: spawn 1 sidecar, run 10 back-to-back session/new over 5 min, check for errors. If Goose kicks the client after N minutes, add idle timeout → kill entry. Don't over-engineer until we see it |
| Q3 | Stop button path: is the in-flight `session/prompt` request handling safe when SIGTERM fires mid-read? ADR §6.7 says "in-flight pending forever" — but in the pool era the pool might still hand out the (dead) entry | `is_alive()` check on `take()` catches dead process. If SIGTERM-mid-read leaves stdout reader in a bad state, `is_alive()` returns false → discard. Validated in success criterion (d) |
| Q4 | Shutdown grace — do we need per-entry timeout or global? | Global 200ms budget total (§3.2). Per-entry would be O(n)×200ms = pathological on 20+ entries |

None block starting; all resolvable during 1–2 day implementation.

---

## 8. Merge gates

- **G1**: success criteria (a)–(d) evidenced in PR description.
- **G2**: `git diff main HEAD -- claude_cli.rs model_probe.rs ClaudeLoginModal.tsx process_pool.rs` → empty. `process_pool.rs` additions are NOT allowed in 6c — Goose pool is a new file.
- **G3** (new for 6c): smoke test — 10 consecutive messages to same agent without crash; pool entry count stays at 1.

---

## 9. Size estimate

- New file: ~150 LOC (`goose_acp_pool.rs`)
- `goose_acp.rs::run_agent_turn`: ~30 LOC diff (take/put wrapping + AcpClient refactor for initialize separation)
- `agent.rs::stop_agent`: +2 lines
- `lib.rs`: +5 lines (shutdown hook)
- `state.rs`: +3 lines
- `settings.rs` save handler: +5 lines (no-op invalidation hook)

Total: ~200 LOC. 1–2 day PR.

---

## 10. Known limitations (v0.2.0-beta)

### 10.1 Orphan pool entries on prompt/config edit

**Symptom:** editing an agent's `prompt.md` (or any field folded into `sp_hash`) produces a new pool key. The old entry is no longer reachable via `take()`, but remains in the `HashMap` with its sidecar alive until `shutdown_all` fires on last-window close.

**Why:** §4.1 "Key-as-hash semantic" — `sp_hash` is part of the key by design (so stale-prompt HIT is structurally impossible). The consequence is that the OLD key's entry becomes an orphan; nothing currently scans the pool for sibling-key entries to evict.

**Measured impact:** RSS per live orphan is ~**55MB** (debug build, Opus-4.7 default, measured 2026-04-19 on 3 coexisting sidecars — 59/54/54MB). A dogfooding user rapidly tuning prompts on 3–5 agents could reach ~10 orphans ≈ 550MB mid-session before the next app restart. Release build likely smaller but same order.

**Mitigations in place:**
- `shutdown_all(200ms)` on `CloseRequested` walks **every** entry (§3.2), so app exit guarantees cleanup.
- Orphans never serve requests (unreachable via `take()`), so there's no correctness risk — just memory.
- `pgrep -f "goose acp"` remains a diagnostic fallback for power users.

**Not fixing in v0.2.0-beta because:** prompt edits are rare outside active tuning, and the window-close safety net bounds worst-case memory to a session. Tracked as **Stage 6d** (§6.3) — orphan cleanup on MISS + optional LRU cap. Telemetry during the v0.2.0-beta window decides priority.

**What would trigger a hotfix instead of Stage 6d:** user reports of >1GB resident after a single-day session without a restart, or system-wide memory pressure attributable to stacked sidecars.

---

## Decision point

Sign off to proceed → I open the 6c branch and start with the `AcpClient` `new()` / `open_session()` refactor (Q1).
