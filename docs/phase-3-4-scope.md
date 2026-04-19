# Phase 3+4 — Multi-provider Config + Keyring + Settings UI

**Status:** proposed (pending review)
**Owner:** Gil
**Date:** 2026-04-19
**Parent plan:** `reactive-floating-feather.md` §Phase 3 + §Phase 4
**ADR anchors:** §3.4 (providers.json schema), §3.5 (onboarding), §6.8 (model ID dash form), §6.8a (catalog staleness + merge), §D5 (keyring), §7 (keyring cargo check, security review)
**Depends on:** Stage 6a/6b/6c (landed 6ca9afe)
**Blocks:** v0.2.0-beta practical rollout (env-var dependency is the last blocker); Stage 6b-ii dispatcher migration (needs `planner_model` settings field)

---

## 0. Why bundle Phase 3 + Phase 4

Three forces:

1. **Env-dependency is the beta-practicality blocker.** `ANTHROPIC_API_KEY` + `OCTOPAL_USE_GOOSE` at launch time means beta users can't just install the app and sign in — they need shell knowledge. We can't ship v0.2.0-beta wide without closing this.
2. **Natural extension of 6c TODO.** [goose_acp.rs:1138](src-tauri/src/commands/goose_acp.rs:1138) literally reads *"Stage 6b will read from OS keyring."* The placeholder invalidation hook in [settings.rs:41](src-tauri/src/commands/settings.rs:41) is waiting for Phase 4 to wire the real trigger.
3. **6b-ii (dispatcher) and 6d (pool telemetry) have prerequisites.** 6b-ii needs `planner_model` in settings (designed here); 6d needs telemetry that only flows once real users can set keys (enabled by this).

Splitting Phase 3 config from Phase 4 UI/keyring would land a config schema no user can actually populate. One PR, two clean commits inside (schema, then wiring).

---

## 1. Scope boundaries

### In scope

- `OctoFile` gets optional `provider` / `model` override fields (agent-level; `None` = inherit from AppSettings default).
- `AppSettings.ProvidersSettings` expanded to full multi-provider schema.
- `model_alias.rs`: new module — provider-agnostic alias (`opus`/`sonnet`/`haiku`) → concrete model ID resolver.
- `providers.json` bundled manifest at `src-tauri/resources/providers.json` + runtime overlay at `~/.octopal/providers.json`.
- `keyring` crate v3 wired for macOS Keychain + Windows Credential Manager + Linux Secret Service.
- New `api_keys` module: `load_api_key(provider)` / `save_api_key(provider, key)` / `delete_api_key(provider)`.
- `run_agent_turn` + `acp_turn_test` call sites read from keyring, not env.
- Settings → new **Providers tab** with per-provider card (key input, Test Connection, default selection, model dropdown + custom ID).
- Env vars `ANTHROPIC_API_KEY` + `OCTOPAL_USE_GOOSE` demoted from load-bearing to dev-only override (behind `#[cfg(debug_assertions)]`).

### Out of scope (named here so reviewers can see the line)

- **Per-auth-method dispatch** (OAuth, CLI subscription detection). ADR §3.5 describes unified 3-step onboarding (Provider → AuthMethod → Configure); Phase 3+4 ships **api_key path only**. `cli_subscription` / `oauth` / `host_only` are Phase 5+ — fields exist in the schema (forward-compat), UI shows "Coming soon" for non-api_key methods.
- **Onboarding modal**. Phase 3+4 ships the Settings tab; the first-run modal replacement for `ClaudeLoginModal` is Phase 5.
- **Per-agent model picker in agent-edit modal UI**. The schema field exists (`OctoFile.model`), but Phase 3+4 only exposes the field to the settings-level default + an advanced JSON edit in the agent modal. Dedicated dropdown is Phase 5.
- **Adaptive Opus detection rewrite**. `model_probe.rs` remains legacy-only (G2). Goose-path "Latest Opus" resolution uses `providers.json` curated list + alias map; adaptive-against-Goose probe is Phase 5.
- **Keyring rotation telemetry / audit log.** Security-relevant events logged to stderr only; structured audit is Phase 6+.
- **Dispatcher (Haiku) migration**. Stage 6b-ii lands after this with `planner_model` already in settings — so we design the field here but don't flip the dispatcher branch.

---

## 2. Phase 3 — Config schema

### 2.1 `OctoFile` extensions

In [state.rs](src-tauri/src/state.rs) `OctoFile` struct, add:

```rust
/// Agent-level provider override. None → inherit AppSettings.providers.default_provider.
/// Serialized to .octo JSON as `"provider"`. Values must match a key in providers.json.
#[serde(default, skip_serializing_if = "Option::is_none")]
pub provider: Option<String>,

/// Agent-level model override. None → inherit AppSettings.providers.default_model.
/// Accepts concrete ID (`"claude-opus-4-7"`), alias (`"opus"`), or custom string.
/// Alias resolution happens at spawn time (model_alias.rs).
#[serde(default, skip_serializing_if = "Option::is_none")]
pub model: Option<String>,
```

Both are `#[serde(skip_serializing_if = "Option::is_none")]` — agents that don't override keep their `.octo` JSON byte-identical to today. No migration needed; legacy files read back as `None` on both fields.

Pool-key impact: `provider` and `model` are already in `GooseAcpPool::key_for(..)` args (Stage 6c §2.1). Resolution (§2.5 below) happens *before* pool-key construction, so an agent flipping from inherit → explicit opus produces a different pool key → MISS → fresh spawn. That's correct behavior (different model = different sidecar).

### 2.2 `AppSettings.ProvidersSettings` expansion

Currently [state.rs:184](src-tauri/src/state.rs:184) only holds `use_legacy_claude_cli`. Expand to:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProvidersSettings {
    #[serde(rename = "useLegacyClaudeCli", default = "default_use_legacy_claude_cli")]
    pub use_legacy_claude_cli: bool,

    /// Provider ID matching a key in providers.json. Default "anthropic" for
    /// migration continuity — existing users had implicit anthropic routing.
    #[serde(rename = "defaultProvider", default = "default_provider")]
    pub default_provider: String,

    /// Model ID or alias. Default "claude-sonnet-4-6" per ADR §6.8 "daily driver".
    #[serde(rename = "defaultModel", default = "default_model")]
    pub default_model: String,

    /// Planner model for dispatcher (Stage 6b-ii). Default "claude-haiku-4-5-20251001"
    /// — preserves today's hardcoded haiku routing until 6b-ii flips the flag.
    ///
    /// **Phase 3+4 scope: schema-only. Wire-up deferred to Stage 6b-ii.**
    /// That is: this PR adds the field, surfaces it in Settings UI (§3.4), and
    /// persists user choice — but `dispatcher.rs` still reads its hardcoded
    /// model name until 6b-ii swaps in `settings.providers.planner_model`.
    /// Designed here so 6b-ii lands as a pure logic change without a schema
    /// migration (and users who pre-set the field during beta get their choice
    /// honored the moment 6b-ii ships).
    #[serde(rename = "plannerModel", default = "default_planner_model")]
    pub planner_model: String,

    /// Per-provider presence flag. NOT the key itself — the actual key is in
    /// OS keyring under service="com.octopal.api_keys", account=<provider>.
    /// This flag is true iff save_api_key(provider, ...) has been called and
    /// not later deleted. UI checks this to decide card empty/filled state
    /// without touching keyring (avoiding Keychain prompts on every settings open).
    #[serde(rename = "configuredProviders", default)]
    pub configured_providers: std::collections::BTreeMap<String, bool>,
}
```

**Why not store keys here at all?** ADR §D5. Plain `settings.json` = billing-bomb leak vector. The `configured_providers` map is a *presence bit only* — "is there a key in keyring for provider X?" — so the UI can render card state without a keyring round-trip (which would prompt the OS on unlocked sessions).

### 2.3 `model_alias.rs` — new module

```rust
// src-tauri/src/commands/model_alias.rs
//
// Provider-agnostic alias → concrete model ID resolver.
// Resolution table per ADR §6.8 (dated 2026-04-19 catalog).

pub fn resolve(alias_or_id: &str, provider: &str) -> String {
    match (alias_or_id, provider) {
        ("opus",   "anthropic") => "claude-opus-4-7".into(),
        ("sonnet", "anthropic") => "claude-sonnet-4-6".into(),
        ("haiku",  "anthropic") => "claude-haiku-4-5-20251001".into(),
        ("opus" | "sonnet" | "haiku", _) => {
            // Other providers don't have opus/sonnet/haiku semantics — passthrough
            // so the 404 surfaces in activity stream (ADR §6.8a "no up-front validation").
            alias_or_id.into()
        }
        _ => alias_or_id.into(),
    }
}
```

**Why a module, not a function in `goose_acp.rs`?** Tested in isolation; Stage 6b-ii dispatcher also consumes it.

**Why hardcoded, not providers.json-driven?** Aliases are semantic ("latest Opus"), values are anchored to the Octopal release cycle. Loading from JSON would let a bad overlay at `~/.octopal/providers.json` silently misroute "opus" to a weaker model — a footgun that outweighs the flexibility. ADR §6.8 pins these in code; this module is the canonical impl.

Resolution happens in `run_agent_turn` **once**, before pool key construction. Log line:

```
[alias] resolved "opus" (anthropic) → claude-opus-4-7
```

### 2.4 `providers.json` manifest

Bundle default at `src-tauri/resources/providers.json`. Schema matches ADR §3.4 verbatim. Anthropic `models` list ordered per ADR §6.8 (newest-first):

```json
{
  "anthropic": {
    "displayName": "Anthropic",
    "models": [
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-6",
      "claude-sonnet-4-5-20250929"
    ],
    "authMethods": [
      {"id":"api_key","label":"API Key","goose_provider":"anthropic"}
    ]
  },
  "openai": {
    "displayName": "OpenAI",
    "models": ["gpt-5","gpt-5-mini","o3"],
    "authMethods": [{"id":"api_key","label":"API Key","goose_provider":"openai"}]
  },
  "google": {
    "displayName": "Google",
    "models": ["gemini-2.5-pro","gemini-2.5-flash"],
    "authMethods": [{"id":"api_key","label":"API Key","goose_provider":"google"}]
  },
  "ollama": {
    "displayName": "Ollama (Local)",
    "models": "dynamic",
    "authMethods": [{"id":"host_only","label":"Local host","goose_provider":"ollama"}]
  }
}
```

**Scope note:** `cli_subscription` / `oauth` authMethods from ADR §3.4 are **dropped from the bundled manifest for Phase 3+4** — forward-compat lives in the schema but not the bundle, so Settings UI shows only `api_key` cards (+ `host_only` for Ollama). Phase 5 re-adds them when the dispatch code exists.

Runtime overlay logic:
- On boot, read bundle from `include_str!("resources/providers.json")`.
- If `~/.octopal/providers.json` exists, deserialize and deep-merge (per-provider partial override; missing keys inherit bundle).
- Result cached in `ManagedState.providers_manifest: Arc<ProvidersManifest>`.
- Invalidate cache on `save_settings` if providers manifest file mtime changed (not required for MVP — user restart suffices).

### 2.5 Model / provider resolution order

On every `run_agent_turn` entry, before building `GooseSpawnConfig`:

```
provider_raw = agent.provider.unwrap_or(settings.default_provider)          // 1
model_raw    = agent.model.unwrap_or(settings.default_model)                // 2
model_final  = model_alias::resolve(&model_raw, &provider_raw)              // 3
```

No validation against `providers_manifest.models` (ADR §6.8a — custom IDs must work). `availableModels(provider)` merge from ADR §6.8a is a **UI-only** concern (Settings dropdown); the spawn path is pure passthrough.

Logging:

```
[resolve] agent=foo provider=anthropic (default) model=opus → claude-opus-4-7
[resolve] agent=bar provider=openai (agent override) model=gpt-5 → gpt-5
```

---

## 3. Phase 4 — Keyring + Settings UI

### 3.1 `keyring` crate v3

Add to `src-tauri/Cargo.toml`:

```toml
keyring = { version = "3", default-features = false, features = ["apple-native","windows-native","linux-native-sync-persistent"] }
```

**Why all three platform backends:** CI matrix runs on all three (ADR §7 carried TODO: "Keyring v3 cross-platform `cargo check` on macOS/Windows/Linux"). Turning off default features drops `secret-service` async to avoid pulling tokio-dbus on mac/windows builds.

Service name constant: `"com.octopal.api_keys"` — single service, accounts = provider IDs (`"anthropic"`, `"openai"`, …). Matches ADR §3.5 `save_api_key(provider_id, key)` signature.

### 3.2 `api_keys` module

New file `src-tauri/src/commands/api_keys.rs`:

```rust
const SERVICE: &str = "com.octopal.api_keys";

/// Returns None if no key is stored for this provider (not an error).
/// Errors only on keyring backend failures (OS permissions denied, locked keychain, etc.).
pub fn load_api_key(provider: &str) -> Result<Option<String>, String>;

/// Creates or overwrites. Caller is responsible for also flipping the
/// ProvidersSettings.configured_providers[provider] flag via save_settings.
pub fn save_api_key(provider: &str, key: &str) -> Result<(), String>;

/// Idempotent: deleting a missing key is Ok(()), not Err.
pub fn delete_api_key(provider: &str) -> Result<(), String>;

// Tauri command wrappers — expose to renderer with redaction on error paths.
#[tauri::command] pub fn save_api_key_cmd(provider: String, key: String, state: ...) -> Result<(), String>;
#[tauri::command] pub fn delete_api_key_cmd(provider: String, state: ...) -> Result<(), String>;
#[tauri::command] pub fn has_api_key_cmd(provider: String, state: ...) -> Result<bool, String>;
```

**Critically:** no `load_api_key_cmd` exposed to renderer. The key only crosses the Tauri boundary in one direction (save). Read happens Rust-internal, inside `run_agent_turn`. This is ADR §D5 "API keys don't traverse IPC" made concrete.

`has_api_key_cmd` is used by the Settings UI to render "configured / not configured" without actually reading the value. Backed by `configured_providers` flag (not keyring) — avoids per-open Keychain prompts.

`save_api_key_cmd` also updates `configured_providers[provider] = true` and persists settings. `delete_api_key_cmd` flips to `false`. Atomic wrt the settings file; keyring write first, then settings (so a failed keyring write doesn't lie about state).

### 3.3 Call site migration

Replace the three env reads:

**[goose_acp.rs:927](src-tauri/src/commands/goose_acp.rs:927)** (`acp_turn_test` — debug command):

**Audit finding (2026-04-19):** this command is currently **NOT** `#[cfg(debug_assertions)]`-gated. The function at [goose_acp.rs:923](src-tauri/src/commands/goose_acp.rs:923) and its registration at [lib.rs:251](src-tauri/src/lib.rs:251) both compile into release. Phase 3+4 must fix this as part of the keyring migration:

- Wrap the `acp_turn_test` function body + the `#[tauri::command]` attribute with `#[cfg(debug_assertions)]`.
- Matching `#[cfg(debug_assertions)]` gate on the `invoke_handler` registration line in `lib.rs`.
- Inside the (now debug-only) function, try `api_keys::load_api_key("anthropic")` first, fall back to `std::env::var("ANTHROPIC_API_KEY")` only if keyring returned None. Release builds don't have this fn at all.
- Doc comment above the fn:
  ```
  /// DEBUG-ONLY test command. Gated behind #[cfg(debug_assertions)] —
  /// never reaches release builds. Production code path for keyring
  /// reads is api_keys::load_api_key() called from run_agent_turn.
  /// Removal tracked under Phase 7 cleanup (see reactive-floating-feather.md
  /// §Phase 7 "Dead-code sweep").
  ```

**[goose_acp.rs:1132](src-tauri/src/commands/goose_acp.rs:1132)** (`run_agent_turn` — the real one):
- Replace with `api_keys::load_api_key(&provider)?`.
- If `None`, return `SendResult { ok: false, error: Some("No API key configured for provider \"<p>\". Add one in Settings → Providers.") }` — user-facing, points at the tab.
- **No env fallback here.** Release or debug, Settings is the only path. Forces the correct flow to be exercised in dev.

**[agent.rs:733](src-tauri/src/commands/agent.rs:733)** + **[dispatcher.rs:85](src-tauri/src/commands/dispatcher.rs:85)** (`OCTOPAL_USE_GOOSE` gate):
- Currently: `cfg!(debug_assertions) && env == "1"`. Replace with: `!settings.providers.use_legacy_claude_cli`.
- Env keeps working in debug as an **additional** force-on lever (for when you want to test Goose path without flipping settings): `cfg!(debug_assertions) && env_says_yes || settings_says_goose`. Documented in comment.

**[goose_acp.rs:58](src-tauri/src/commands/goose_acp.rs:58)** (`OCTOPAL_GOOSE_DEV_FALLBACK`): untouched — developer-only sidecar-path override, not user-facing state.

### 3.4 Settings → Providers tab

New tab in existing Settings modal, between "Agents" and "Advanced". Layout:

```
┌──────────────────────────────────────────────┐
│  Default provider:  [Anthropic ▼]            │
│  Default model:     [claude-sonnet-4-6 ▼] ⓘ  │
│  Planner model:     [claude-haiku-4-5  ▼] ⓘ  │
├──────────────────────────────────────────────┤
│  Anthropic                        [●] Active │
│  ┌──────────────────────────────────────────┐│
│  │ API Key  [••••••••••••••••]  [Save]      ││
│  │                              [Test Conn] ││
│  │ Status: ✓ Connected (last tested 2m ago) ││
│  │ [ Remove key ]                           ││
│  └──────────────────────────────────────────┘│
│  OpenAI                        [○] Not set   │
│  ┌ ... similar card ... ┐                    │
│  Google                        [○] Not set   │
│  Ollama                        [○] Not set   │
│    Host URL: [http://localhost:11434]        │
└──────────────────────────────────────────────┘
```

**Interactions:**
- API Key field is masked (`<input type="password">`), never rendered back after save (the field shows `••••` as a placeholder if `has_api_key` returns true; editing replaces).
- Save button disabled until the field has non-whitespace content.
- Test Connection button calls a new Rust command `test_provider_connection(provider)` — hits the provider's free list endpoint (`GET https://api.anthropic.com/v1/models` for Anthropic; `/v1/models` for OpenAI; `/v1beta/models` for Google; `/api/tags` for Ollama). No completion calls, no billed tokens. Returns `{ok, latency_ms, error?}`.
- Status row shows test results; persisted in-memory for the session only (not in settings).
- "Remove key" confirms then calls `delete_api_key_cmd`.

**Model dropdown source** (ADR §6.8a merge):

```
options = providers_manifest.anthropic.models
        ∪ goose_catalog.anthropic.models  (loaded lazily once, cached)
        ∪ user's custom entries from past sessions (persisted per-provider list in settings)
        + literal "Custom…" entry that opens a text input
```

Aliases (`opus` / `sonnet` / `haiku`) shown at the top of the Anthropic dropdown with "→ claude-opus-4-7" resolution hint.

**Goose catalog fetch:** add `get_goose_model_catalog()` command that spawns `goose info --json` (one-shot, not the ACP sidecar) and parses. Cached in `ManagedState.goose_catalog: OnceCell<...>`. Scope note: if `goose info --json` doesn't exist (we haven't probed), fall back to empty → UI shows only providers.json + custom. **Low-priority** — if the fallback is what we ship, still meets the ADR §6.8a intent (curated list is source of truth).

### 3.5 i18n

All new strings keyed under `settings.providers.*` in `en.json` / `ko.json`. No changes to `modals.claudeLogin.*` (G2).

---

## 4. Security considerations

Drawn from ADR §D5 + §7 security-review items.

### 4.1 Key lifetime in memory

- Keyring read happens **once per cold spawn** (MISS path in `run_agent_turn`). `String` lives in `GooseSpawnConfig.api_key: Option<String>`, passed to the child's env, and dropped after spawn.
- Pool HIT path does NOT re-read the key — the child already has it in its env. Matches Stage 6c §2.3 rationale ("keyring read on every `take()` would trigger macOS Keychain prompts").
- Zeroization: `String` has no zeroize by default. Acceptable tradeoff (ADR §D5 doesn't mandate) — Rust process memory isn't dumpable without elevated privileges, and the key is in the child's env anyway. `zeroize` crate is Phase 6+ if audit demands.

### 4.2 Log redaction

- `tracing::debug!` / `tracing::info!` in `goose_acp.rs` currently log `cfg` fields. Add a `Debug` impl override on `GooseSpawnConfig` that prints `api_key: Some("<redacted>")` / `None`.
- Activity stream (renderer-visible) never receives `api_key`. Verified by: grep `api_key` in `goose_acp_mapper.rs` should find nothing.
- Error strings returned to UI from `run_agent_turn` / `test_provider_connection` must not echo the key. `test_provider_connection` wraps any error as `"Connection test failed (status <code>)"` — never the raw response body (which could echo query params on some providers).

### 4.3 OS-prompt minimization

- Service name `com.octopal.api_keys` is per-app, not per-provider — so macOS Keychain treats the whole app as one "allow" scope. First spawn after install triggers one dialog, "Always Allow" dismisses for the rest of the install.
- `has_api_key_cmd` backed by settings flag (not keyring) means opening Settings doesn't trigger a prompt. Confirmed rationale in §3.2.
- Stage 6c's pool `config_hash` **stays keyless** — invalidation is event-driven (§3.6 below), not rehash-based. Reaffirming Stage 6c scope §2.1.

### 4.4 Pool invalidation on key rotation

Replace the no-op in [settings.rs:41](src-tauri/src/commands/settings.rs:41):

```rust
// Compare prev vs new configured_providers flags. For each provider whose
// flag flipped (true→false, false→true, or stayed true but test-connection
// was called), invalidate pool so the next spawn reads the new key.
for (provider, was) in &prev_providers.configured_providers {
    if settings.providers.configured_providers.get(provider).copied() != Some(*was) {
        let evicted = state.goose_acp_pool.invalidate_pool_for_provider(provider);
        // drop settings lock before awaiting shutdowns
        drop(s);
        for entry in evicted { entry.client.shutdown().await.ok(); }
    }
}
```

**Subtlety:** `save_api_key_cmd` also needs to call this (since the flag-flip happens inside *its* transaction, not `save_settings`). Factor the invalidation logic into a helper used by both.

### 4.5 Threat model notes

- **Attacker with file read on settings.json:** gets provider names and `configured_providers` flags, no keys. ✅
- **Attacker with memory dump of running Octopal:** gets any currently-spawned sidecar's env (via /proc on Linux, limited on mac/windows). Pool design already trades this for reduced Keychain friction; ADR §D5 accepts.
- **Attacker with keyring unlock:** gets keys. Out of scope — OS-level compromise.
- **Renderer XSS / malicious extension:** no renderer-side path to read keys. `save_api_key_cmd` is write-only from renderer POV; `has_api_key_cmd` is boolean. ✅
- **Log shipping / crash report upload:** redacted config via custom `Debug`; spot-check the crash handler (if any) for env forwarding.

---

## 5. Env var removal (G4)

Current load-bearing env vars:

| Env var | Site | After Phase 3+4 |
|---|---|---|
| `ANTHROPIC_API_KEY` | [goose_acp.rs:927](src-tauri/src/commands/goose_acp.rs:927), [:1132](src-tauri/src/commands/goose_acp.rs:1132) | `:1132` → keyring only. `:927` → keyring + debug-only env fallback. |
| `OCTOPAL_USE_GOOSE` | [agent.rs:733](src-tauri/src/commands/agent.rs:733), [dispatcher.rs:85](src-tauri/src/commands/dispatcher.rs:85) | `!settings.use_legacy_claude_cli` is primary; env = debug-only force-on. |
| `OCTOPAL_GOOSE_DEV_FALLBACK` | [goose_acp.rs:58](src-tauri/src/commands/goose_acp.rs:58) | unchanged (dev-only sidecar path override). |

After this phase, a fresh install with no env vars set must reach a working state via Settings alone. That's G4.

---

## 6. Merge gates

**G1 — End-to-end via Settings**
1. Fresh install (clean `~/.octopal/`, no env vars in shell).
2. Open app → Settings → Providers tab.
3. Enter Anthropic API key, Save.
4. Click Test Connection → green ✓.
5. Create an agent, send a message → streams text, no error about missing key.
6. Evidence: screen recording or log excerpt showing keyring write, pool MISS spawn with key resolved from keyring (not env).

**G2 — Legacy files unchanged**
`git diff main..HEAD -- src-tauri/src/commands/claude_cli.rs src-tauri/src/commands/model_probe.rs renderer/src/components/ClaudeLoginModal.tsx renderer/src/i18n/locales/en.json` (the `modals.claudeLogin.*` keys specifically) → no modifications. New keys under `settings.providers.*` are fine.

**G3 — Unit tests + security review checklist**
- `api_keys::{load,save,delete,has}` unit tests with a mocked keyring backend (keyring v3 has `mock` feature).
- `model_alias::resolve` table tests for all 3×N combos.
- Providers manifest overlay merge test (bundle + partial overlay → expected shape).
- Settings save handler invalidation test (flip `configured_providers[anthropic]` → mock pool asserts `invalidate_pool_for_provider("anthropic")` called).
- Security review checklist (§8 below) signed off in PR description.

**G4 — Env removal proof**
- `env -i <octopal binary>` launches and works through Settings. (Or: launch with `unset ANTHROPIC_API_KEY OCTOPAL_USE_GOOSE`.)
- Release-build `strings src-tauri/target/release/octopal | grep ANTHROPIC_API_KEY` → finds only the source-code literal string for the env-var name in `acp_turn_test` (debug command), nothing load-bearing.

**G5 — Stage 6c pool correctness preserved**
- 55/55 existing unit tests still pass.
- Repeat the 5-case regression from the 6c PR; plus a 6th case: key rotation via Settings mid-session → old pool entries evicted → next message spawns fresh sidecar with new key.

---

## 7. Open questions (pre-implementation)

| # | Question | Resolution path |
|---|---|---|
| Q1 | Does `goose info --json` exist / emit the model catalog? | `goose info --help` check at impl time. If not, §3.4 falls back to providers.json-only — **non-blocking**, scope says this is the acceptable fallback. |
| Q2 | Keyring v3 `mock` feature API shape — enough for unit tests or do we need a trait wrapper? | 10-min crate-doc read. If mock is awkward, wrap `load/save/delete` behind a `trait KeyStore` + inject at module level. Low risk. |
| Q3 | Ollama `host_only` — does it need a per-install URL, or is env `OLLAMA_HOST` enough? | Ship with settings-field + `GOOSE_OLLAMA_HOST` env inject. Phase 5 refactors when oauth/cli_subscription cards land. Non-blocking. |
| Q4 | Is there a first-run UX gap if a user opens the app post-upgrade and nothing is configured? | **Yes — but Phase 5 onboarding handles it.** For Phase 3+4, the existing `ClaudeLoginModal` path still works in `use_legacy_claude_cli=true` default. New users flipping to Goose hit an empty Providers tab with a "Add your first API key" empty state. Acceptable for beta. |
| Q5 | Should `planner_model` have its own API key (if future dispatcher is a different provider than main)? | Phase 3+4 says no — planner uses whatever the default-provider key is. Phase 6b-ii revisits if demand. |

None block starting.

---

## 8. Security review checklist (draft)

Attach to PR description as a checked list. Reviewer signs off item-by-item before G3 passes.

### 8.1 Key handling
- [ ] Keys never appear in `tracing::{info,debug}` output. Grep `src-tauri/src/commands/goose_acp.rs goose_acp_pool.rs api_keys.rs` for `api_key` adjacent to `info!`/`debug!`/`println!` — zero hits or explicitly redacted.
- [ ] Custom `Debug` impl on `GooseSpawnConfig` redacts `api_key` field. Test: `format!("{:?}", cfg)` snapshot.
- [ ] No `load_api_key_cmd` Tauri command exists — keys only flow Rust-internal after save.
- [ ] Keyring write atomicity: `save_api_key` + settings `configured_providers` flag flip are sequential; failure of second is logged but doesn't leave orphaned keyring entry (documented in §3.2).
- [ ] Error strings returned to UI never include the key value or raw provider response body.

### 8.2 Storage boundaries
- [ ] `settings.json` post-save contains only provider IDs and boolean flags for `configured_providers`. Test: save a key, diff settings.json, assert no long-string fields added.
- [ ] No plaintext key in `~/.octopal/` anywhere. `grep -r sk-ant ~/.octopal/` after a test save → zero hits.
- [ ] `providers.json` overlay file is read-only from Octopal's perspective — we never write user keys there.

### 8.3 IPC boundaries
- [ ] `has_api_key_cmd` reads flag, not keyring — no Keychain prompts from renderer-initiated Settings open.
- [ ] `save_api_key_cmd` / `delete_api_key_cmd` permission-check via Tauri `capabilities` (match existing settings-save capability).
- [ ] Test Connection responses sanitized — `{ok, latency_ms, error_message}` where `error_message` is a whitelist of known patterns, not the raw HTTP body.

### 8.4 OS integration
- [ ] Service name `com.octopal.api_keys` matches bundle identifier convention so macOS Keychain groups correctly.
- [ ] macOS Keychain "Always Allow" works end-to-end (manual test on a clean user account).
- [ ] Windows Credential Manager stores under a namespaced target (manual test).
- [ ] Linux Secret Service graceful failure if daemon absent — UI shows "OS keyring unavailable; configure a session env var as fallback" rather than crashing.

### 8.5 Pool / lifecycle
- [ ] Stage 6c `#[must_use]` eviction contract still holds — `invalidate_pool_for_provider` callers `.shutdown().await` every evicted entry.
- [ ] Key rotation via Settings → next message → old sidecar killed, new sidecar spawned with new key. Evidence: log excerpt + RSS drop.
- [ ] App shutdown (`CloseRequested`) still walks the pool (Stage 6c §3.2). No new code path bypasses.

### 8.6 Env var posture
- [ ] G4 evidence: `env -i` launch works through Settings alone.
- [ ] Debug-only env fallbacks gated by `cfg!(debug_assertions)` — grep confirms no release code reads `ANTHROPIC_API_KEY` load-bearingly.
- [ ] Docs / README updated to say "Settings → Providers" is the supported path; env vars are dev-only.

---

## 9. Size estimate

| File | LOC (new / changed) |
|---|---|
| `src-tauri/src/commands/api_keys.rs` (new) | ~120 |
| `src-tauri/src/commands/model_alias.rs` (new) | ~40 + tests |
| `src-tauri/src/commands/providers_manifest.rs` (new) | ~80 (parse + overlay merge) |
| `src-tauri/resources/providers.json` (new) | ~40 |
| `src-tauri/src/state.rs` | +30 (OctoFile fields, ProvidersSettings expansion, ManagedState.providers_manifest) |
| `src-tauri/src/commands/goose_acp.rs` | ~40 lines diff (env→keyring, alias resolve, provider arg) |
| `src-tauri/src/commands/settings.rs` | +40 (real invalidation logic) |
| `src-tauri/src/commands/agent.rs` + `dispatcher.rs` | ~10 each (OCTOPAL_USE_GOOSE → settings flag) |
| `src-tauri/src/lib.rs` | +15 (register new commands) |
| `renderer/src/components/settings/ProvidersTab.tsx` (new) | ~400 (card-per-provider, masked input, Test Connection) |
| `renderer/src/components/settings/ProviderCard.tsx` (new) | ~150 |
| `renderer/src/tauri-api.ts` | +30 (typed wrappers for new commands) |
| `renderer/src/i18n/locales/en.json`, `ko.json` | ~60 new keys each |

**Total:** ~1,100 LOC, 3–4 day PR. Two clean commits: (A) Rust schema + keyring, (B) Settings UI.

---

## 10. Known limitations (ships with v0.2.0-beta)

### 10.1 No first-run onboarding
Upgrade users on the Goose path hit an empty Providers tab. Documented in Q4; Phase 5 (onboarding modal replacement) closes this. Beta release notes should call it out.

### 10.2 Test Connection consumes no tokens but takes ~500ms
Anthropic `/v1/models` is free but rate-limited globally. Rapid-clicking Test Connection 20× could 429. Acceptable; surfaces as status-row error. No client-side throttle in MVP.

### 10.3 Keyring unavailable on Linux without Secret Service daemon
Some minimal window managers / docker-dev setups lack gnome-keyring/kwallet. UI degrades to a **blocking card state** that doesn't silently drop to something insecure.

**User-facing message (i18n key `settings.providers.error.keyringUnavailable`):**

> **OS keyring unavailable**
>
> Octopal couldn't reach your system's secure credential store. API keys can't be saved safely without it.
>
> - **GNOME / most desktops:** install `gnome-keyring` (`sudo apt install gnome-keyring` on Debian/Ubuntu).
> - **KDE:** install `kwallet` and ensure the KWallet daemon is running.
> - **Headless / docker:** see the Linux troubleshooting guide (link below).
>
> [ Retry ]  [ Open troubleshooting guide ]

The Save button in every provider card is disabled; the card shows this error in place of the normal form. No silent fallback to plain files.

**Documented dev-only escape hatch: `OCTOPAL_API_KEY_FALLBACK=env`**

For Linux dev / CI / containerized setups where installing a keyring daemon isn't practical, an explicit opt-in reads from env vars *instead of* the keyring. Rules:

- **Off by default.** Unset or any value other than `env` → strict keyring path.
- **Must be set at process startup.** Mid-session changes have no effect (settings load happens once).
- **Not wrapped in `cfg!(debug_assertions)` — works in release too**, since some users deploy Octopal via CI/docker and that's a legitimate (if unsafe) workflow. The safety burden shifts to the user.
- When enabled:
  - `api_keys::load_api_key(p)` consults env var naming scheme: `OCTOPAL_KEY_ANTHROPIC`, `OCTOPAL_KEY_OPENAI`, etc. Uppercase provider ID, `OCTOPAL_KEY_` prefix.
  - `save_api_key` / `delete_api_key` / Settings UI all return an error instructing the user to manage env vars externally.
  - Settings Providers tab shows a persistent yellow banner: *"Running in environment-variable fallback mode. Keys are read from `OCTOPAL_KEY_<PROVIDER>` env vars, bypassing OS keyring. This is unsafe on shared machines."*
- Documented in `docs/troubleshooting-linux-keyring.md` (new file, one-page, three sections: *Installing a Secret Service daemon*, *When to use env fallback*, *Security implications*).

README gets a one-paragraph "Linux without keyring" subsection under Installation, pointing at the troubleshooting doc.

**Rationale for not-`#[cfg(debug_assertions)]`-gated:** unlike `acp_turn_test` (which is a developer artifact), this escape hatch serves a real deployment scenario (headless Linux CI). Gating it out of release would push users to patch the binary — worse outcome. Explicit opt-in + loud UI warning is the cleanest tradeoff.

### 10.4 Model alias map hardcoded
New Anthropic model (Opus 4.8 when it ships) requires an Octopal release to update the `opus` alias. Users can still pick it via "Custom model ID" (ADR §6.8a escape hatch). Accepted tradeoff.

### 10.5 Claude Pro subscription users stranded on legacy path

**Symptom:** a user with a paid Claude.ai Pro/Max subscription (local `claude` CLI installed + authenticated) but **no Anthropic API credits** can't use the Goose path in v0.2.0-beta. Flipping `use_legacy_claude_cli=false` pushes them to `run_agent_turn`, which hits the `anthropic` provider and needs an `ANTHROPIC_API_KEY`. No key → fast-fail with "Add one in Settings → Providers" — and they literally can't, because their subscription doesn't include API billing.

**Workaround:** keep `use_legacy_claude_cli=true` (the default). Everything stays on the v0.1.42 claude CLI path, which uses their local subscription.

**Why it surfaced only at PR time:** Phase 3+4 scope §1 deliberately dropped `cli_subscription` / `oauth` authMethods from the bundled manifest ("api_key path only"). We designed the schema as forward-compat but the UI has only api_key cards. The assumption was "users who flip the legacy toggle are API-credit users by definition" — turns out that's not safe. Plenty of Octopal early-adopters are Pro subscribers who'd happily try the Goose beta if it worked with their existing auth.

**Research (2026-04-19) for the fix path:**
- Goose v1.31.0 ships a **`claude-code` provider** (and a recommended-replacement `claude-acp` provider) that spawns the local `claude` CLI binary as subprocess. Verified end-to-end: `env -u ANTHROPIC_API_KEY GOOSE_PROVIDER=claude-code $GOOSE run -t "say READY"` returns `READY`, exit 0.
- No API key required. No keyring entry required. Only `claude` on `PATH` + authenticated (~/.claude/ tokens).
- `claude-code` is marked **deprecated** in Goose strings: *"use claude-acp instead. No MCP support."* Real fix should target `claude-acp` eventually (Phase 5c); Phase 5a uses `claude-code` for the fastest-to-ship path (works today with no extra npm install).

**Fix: Stage Phase 5a (separate branch/PR, tracked at [docs/phase-5a-scope.md](./phase-5a-scope.md)).** Blocker-level priority for v0.2.0-beta wide rollout; v0.2.0-beta limited rollout (API-credit users only) can ship with Phase 3+4 alone.

**PR policy:** Phase 3+4 PR description calls this out as a "known limitation" and steers Pro subscribers to keep the legacy toggle on. No auto-detection in Phase 3+4 — a Pro user who toggles legacy=off gets the clear error message pointing them at Settings → Providers, which would be a dead end, BUT the scoped beta users (API credit holders) don't hit this path.

---

## Decision point

Sign off to proceed → I open the `feature/phase-3-4-config-keyring` branch and start with §2.1 (OctoFile fields) + §2.2 (ProvidersSettings expansion) + `model_alias.rs` as commit A. Commit B (keyring) after A passes the schema-migration test. Commit C (Settings UI) last.
