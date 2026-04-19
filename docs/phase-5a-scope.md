# Phase 5a — Claude CLI subscription auth path

**Status:** proposed (pending Phase 3+4 PR merge)
**Owner:** Gil
**Date:** 2026-04-19
**Parent plan:** `reactive-floating-feather.md` §Phase 5 (split)
**Depends on:** Phase 3+4 (`feature/phase-3-4-config-keyring`)
**Blocks:** v0.2.0-beta *wide* rollout (Phase 3+4 alone supports limited rollout for API-credit users)

---

## 1. Motivation

Phase 3+4 ships with a known limitation (phase-3-4-scope.md §10.5): **Claude Pro/Max subscription users who have no Anthropic API credits can't use the Goose path.** Flipping `use_legacy_claude_cli=false` routes them to `run_agent_turn` which expects an `ANTHROPIC_API_KEY`. No key = fast-fail. Their workaround is "stay on legacy forever" — acceptable for a limited beta but a dead end for v0.2.0-beta wide rollout.

Phase 5a adds the `cli_subscription` authMethod to the Anthropic card so Pro users can flip to Goose and keep using their existing `claude` CLI authentication — no API billing needed.

## 2. Scope split rationale (why 5a, not monolithic 5)

The original ADR §3.5 had Phase 5 as a single "unified onboarding" drop: all three authMethods (`api_key`, `cli_subscription`, `oauth`) + a first-run modal that replaces `ClaudeLoginModal`. At ~1,000 LOC that's too much for one reviewable PR, and it couples two independent needs:

- **5a — cli_subscription** unblocks Pro subscribers *today*. Data-model change (bool → enum) + card state expansion + Goose routing. ~400 LOC, 2–3 days.
- **5b — oauth + onboarding** handles Google OAuth + the first-run modal replacement. New UI, external browser flow, no data-model change. ~600 LOC, 3–5 days.
- **5c — claude-acp adapter transition** tracks Goose upstream deprecation of `claude-code` in favor of `claude-acp`. Deferred until Goose actually removes `claude-code` — probably 2–3 Goose releases out.

5a is the priority because it's the beta-rollout blocker. 5b and 5c can slip without harming existing users.

## 3. Research findings (2026-04-19)

Actual binary interrogation, not docs-reading.

### 3.1 Goose v1.31.0 Anthropic authMethods

Via `$GOOSE run --help` + `strings $GOOSE`:

| provider ID | How it authenticates | Key required | Goose status |
|---|---|---|---|
| `anthropic` | `POST https://api.anthropic.com/v1/messages` with `x-api-key` | `ANTHROPIC_API_KEY` required | 정식 (Phase 4 사용) |
| `claude-code` | Spawns local `claude` binary as subprocess | None (uses `claude`'s auth) | **Deprecated** per Goose strings: *"use claude-acp instead. No MCP support."* |
| `claude-acp` | Spawns `claude-agent-acp` npm adapter which then fronts `claude` | None | Recommended replacement — **but requires `npm install -g @zed-industries/claude-agent-acp`** |

No Anthropic OAuth provider in Goose v1.31.0 (Google has `gemini_oauth`, Anthropic does not).

### 3.2 claude-code provider end-to-end probe

```bash
env -u ANTHROPIC_API_KEY \
  GOOSE_PROVIDER=claude-code GOOSE_MODEL=claude-sonnet-4-5 \
  XDG_CONFIG_HOME=/tmp/goose-probe XDG_DATA_HOME=/tmp/goose-probe \
  $GOOSE run --no-session -t "say READY" --quiet
# → READY
# → exit 0
```

Then with `HOME=/tmp/nohome` (blocking ~/.claude access) + PATH stripped:

```
error: could not resolve command 'claude': file does not exist.
```

**Confirms:** `claude-code` spawns the actual `claude` binary. Auth flows through claude's own token store (~/.claude/ + OS keychain). No Goose-level key storage involved.

### 3.3 Phase 5a picks `claude-code`, not `claude-acp`

Deprecated ≠ broken. `claude-code` works today with zero additional install. `claude-acp` requires the user to `npm install -g @zed-industries/claude-agent-acp` — extra step, extra failure mode, external npm dependency with its own update cycle.

**Tradeoff accepted:** no MCP support on `claude-code`. Phase 5a users who pick cli_subscription lose agent-level MCP on the Goose path. Documented in the card UI (see §5.3). MCP users stay on api_key path or on legacy until Phase 5c.

## 4. Data model

### 4.1 AuthMode enum

Replace `configured_providers: BTreeMap<String, bool>` with `BTreeMap<String, AuthMode>`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    None,
    ApiKey,
    CliSubscription,
}
```

### 4.2 Migration (Phase 3+4 → Phase 5a)

Settings on disk from Phase 3+4 have `configuredProviders: {"anthropic": true, "openai": false}`. Accept both shapes:

- serde `#[serde(untagged)]` helper struct that reads either bool-or-enum and normalizes
- Mapping: `true` → `ApiKey`, `false` → `None` (absent key same as `None`)
- Tests cover both directions and the mixed case (some keys bool, some enum)

### 4.3 Pool key impact (scope §2.1 6c reminder)

**Phase 5a adds `auth_mode` to the pool key.** Rationale: api_key and cli_subscription spawn entirely different sidecars (different `GOOSE_PROVIDER` env → different child binary behavior + potentially different `claude` subprocess). A user who flips from api_key to cli_subscription must get a fresh sidecar; silently reusing the old one would mask the switch.

**Impact on existing Stage 6c tests:**
- [goose_acp_pool.rs](src-tauri/src/commands/goose_acp_pool.rs) `hash_config()` signature gains `auth_mode: &str` (or &AuthMode) — breaking change for all callers
- Tests needing update: `hash_config_same_input_same_output`, `hash_config_model_change_drifts`, `hash_config_system_prompt_change_drifts`, `pool_deduplicates_same_key`, `key_for_has_stable_shape`, `invalidate_for_agent_prefix_filter`, `pool_put_collision_returns_leftover_not_silent_drop`
- New tests: `hash_config_auth_mode_change_drifts`, `migration_pool_key_with_auth_mode`

Estimate: ~30 LOC test churn across ~7 existing tests, plus 2 new tests. Factor into total LOC.

## 5. UI design — Anthropic card

### 5.1 Four states (auto-detected on card mount)

On mount, run **two parallel probes**:
- `hasApiKey('anthropic')` — reads settings flag (existing Phase 4 path, no keyring touch)
- `detectClaude()` — new Rust command: `which claude` + `claude --version` with 5s timeout

Then render one of four states:

| State | Condition | UI |
|---|---|---|
| `neither` | no keyring + no claude binary | empty input + **both** install guides (link to Anthropic API docs + link to Claude CLI install guide) |
| `api_key_only` | keyring set, no claude | current Phase 4 UI (no change) |
| `cli_only` | claude binary detected, no keyring | "Use your Claude CLI subscription" panel + `Activate` button + small "Or add an API key instead" link to reveal the key input |
| `detected_both` | both present | **radio** — "API key" / "Claude CLI subscription" with `currentMode` pre-selected. Shows Test Connection per mode |

### 5.2 cli_only UI content (**CORRECTION 1 from user**)

Do NOT hardcode an npm command. The Claude CLI install path is **not** `npm install -g @anthropic-ai/claude-code` (that's Claude Code CLI for dev work — a Node package that may or may not be the user's installed binary). The `claude` binary Goose's `claude-code` provider expects is whatever the user already uses to log into Claude.ai — typically installed via `claude.ai/install.sh` or the platform installer.

**Correct UI copy:**
> **Use your Claude Pro/Max subscription**
>
> Your Claude CLI is installed and authenticated. Octopal can route through it instead of an API key.
>
> [ Activate ]   [ Or use an API key instead ]

When `cli_only` but detection is ambiguous (e.g. binary found but `claude --version` failed):
> We found `claude` at `{path}` but couldn't verify it's authenticated. Run `claude` in a terminal to sign in, then retry.

When `neither`:
> **No Anthropic credentials configured**
>
> Choose one:
>
> - Paste an API key (above) — works out of the box, usage is billed
> - [ Install Claude CLI ] — use your Pro/Max subscription instead

The `Install Claude CLI` button opens `https://docs.claude.com/en/docs/claude-code/quickstart` (or whatever the current canonical Anthropic install URL is at Phase 5a ship time — **verify live before ship, do not hardcode command strings**).

### 5.3 Test Connection behavior per mode (**CORRECTION 2 from user**)

| Mode | Test Connection action | Rationale |
|---|---|---|
| `api_key` | GET `/v1/models` (unchanged from Phase 4) | Free endpoint |
| `cli_subscription` | `claude --version` (primary) + optionally `claude config list` (secondary) | **Zero tokens consumed.** A `claude -p "ok"` query would burn user's Pro quota on every click — unacceptable UX |

**Do NOT** dispatch a real model query during Test Connection. The user pays (in tokens or rate-limit budget) for every such probe.

Success message: **"Claude CLI responds. You should be able to send messages now."** — deliberately conservative. We're verifying the binary is runnable, not that the token is valid for a specific model. The first real message the user sends exercises auth end-to-end; if it fails there, the error surfaces in the activity stream with the real API response (same as any other auth failure).

### 5.4 cli_subscription write path

No keyring entry is written. Instead:
- `ProvidersSettings.configured_providers["anthropic"] = AuthMode::CliSubscription`
- Same pool invalidation flow as api_key save (flag delta in settings.rs)
- Save button on the CLI panel: `set_auth_mode_cmd(provider, AuthMode::CliSubscription)` — new Tauri command

`save_api_key_cmd` stays, but now also sets the auth_mode flag to `ApiKey` atomically.

`delete_api_key_cmd` demotes to `None` (unchanged from Phase 4).

New `clear_auth_mode_cmd` for explicitly backing out of cli_subscription mode (goes to `None`).

## 6. Rust routing

### 6.1 `goose_acp.rs::run_agent_turn` — provider resolution

Currently hardcodes `let provider = "anthropic".to_string();` (phase-3-4 path). Phase 5a:

```rust
let provider_id = "anthropic"; // TODO post-5a: use settings.default_provider once multi-provider dispatches
let auth_mode = {
    let s = state.settings.lock().map_err(|e| e.to_string())?;
    s.providers.configured_providers
        .get(provider_id).cloned()
        .unwrap_or(AuthMode::None)
};
let goose_provider = match auth_mode {
    AuthMode::None => {
        return Ok(SendResult {
            ok: false, error: Some(format!(
                "No authentication configured for provider \"{provider_id}\". \
                 Add one in Settings → Providers."
            )), ..Default::default()
        });
    }
    AuthMode::ApiKey => "anthropic".to_string(),         // existing Phase 4 path
    AuthMode::CliSubscription => "claude-code".to_string(), // new Phase 5a path
};
```

The `fill_api_key` closure only runs for `AuthMode::ApiKey`. For `CliSubscription` it's skipped — cfg.api_key stays None. `env_var_for_provider(&goose_provider)` returns None for `claude-code`, so no `ANTHROPIC_API_KEY` in child env.

### 6.2 `env_var_for_provider` change

```rust
pub fn env_var_for_provider(provider: &str) -> Option<&'static str> {
    match provider {
        "anthropic" => Some("ANTHROPIC_API_KEY"),
        "claude-code" | "claude-acp" => None,  // auth flows through `claude` binary subprocess
        "openai" => Some("OPENAI_API_KEY"),
        // ...
    }
}
```

### 6.3 Child PATH propagation

The `claude-code` provider spawns `claude` — which must be on the child's `PATH`. Currently `build_env()` in goose_acp.rs builds the child env from scratch with only XDG + provider key. Phase 5a: preserve PATH from the parent process so Goose's subprocess spawn can find `claude`.

Verified necessary by probe §3.2: PATH stripped → "could not resolve command 'claude'".

Tests:
- `build_env_cli_subscription_preserves_path` — assert the child env inherits PATH
- `build_env_cli_subscription_omits_api_key` — assert ANTHROPIC_API_KEY not set

## 7. Detection command

New `commands::cli_subscription::detect_claude` Tauri command (not a rust-internal only; renderer calls it on card mount):

```rust
#[derive(serde::Serialize)]
pub struct ClaudeDetection {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn detect_claude() -> ClaudeDetection;
```

Impl:
1. `which claude` → get path (or None if absent)
2. Run `claude --version` with 5s timeout → parse stdout for version string
3. Errors (timeout, non-zero exit) → `found: false, error: Some(...)` — UI renders the "we found it but couldn't verify" branch

**Do not** run a real query or auth check. Version probe is enough for the detection UX.

## 8. Merge gates

- **G1-5a** — a Pro user with no API key set, `use_legacy_claude_cli=false`, opens Settings → Providers, sees `cli_only` state, clicks Activate → sends a message → Goose spawns with `GOOSE_PROVIDER=claude-code`, claude subprocess auth succeeds, response streams. Log shows:
  ```
  [resolve] agent=foo provider=anthropic auth=cli_subscription → goose_provider=claude-code
  [goose_acp_pool] MISS key=…::cli_subscription::… → spawn
  ```

- **G2-5a** — migration: open the app with a Phase 3+4 settings.json (bool flags) → flags auto-upgrade to enum on first load → re-save → on-disk JSON now has `"anthropic": "api_key"`. No loss of prior configured state.

- **G3-5a** — all Phase 3+4 tests still pass (82+) + new tests:
  - AuthMode enum serde roundtrip
  - Migration from bool shape
  - Pool key includes auth_mode (drift test)
  - env_var_for_provider returns None for claude-code
  - detect_claude integration test (with + without claude binary)

- **G4-5a** — UI states manually verified: all four card states render correctly, radio toggle persists across Settings close/open, Activate button correctly writes AuthMode::CliSubscription.

- **G5-5a** — Test Connection for cli_subscription **never** triggers a real API request. Verified by network monitor during button click.

## 9. Size estimate

| Component | LOC |
|---|---|
| AuthMode enum + migration | ~60 |
| commands/cli_subscription.rs (detect_claude) | ~80 |
| goose_acp.rs routing + build_env change | ~40 |
| goose_acp_pool.rs auth_mode in key | ~30 + 30 test churn |
| New set_auth_mode_cmd / clear_auth_mode_cmd | ~50 |
| ProviderCard anthropic-specific 4-state logic | ~200 |
| global.d.ts + tauri-api.ts | ~30 |
| i18n keys (en/ko) | ~40 |
| Tests (new) | ~80 |
| providers.json cli_subscription restoration | ~5 |
| **Total** | **~645 LOC**, 2–3 day PR |

## 10. Known limitations (v0.2.0-beta ship state with 5a)

### 10.1 `claude-code` no-MCP caveat

Users on cli_subscription lose agent-level MCP on the Goose path. If they configure an MCP server on an agent, the server config is ignored when the sidecar uses `claude-code`. Card UI documents this:

> ⚠️ MCP extensions (like GitHub, Slack, Notion integrations) aren't supported in Claude CLI subscription mode. Switch to API key to use MCP.

Mitigation tracked under Phase 5c (claude-acp transition).

### 10.2 Detection staleness

`detect_claude` runs once per card mount. If the user installs/uninstalls `claude` while Settings is open, the card doesn't refresh. Acceptable — users rarely do this mid-session.

### 10.3 Path assumption for `claude` subprocess

`claude-code` spawns `claude` via PATH lookup. Works when Octopal is launched from a shell or from Applications (inherits LaunchServices env). **Fails if `claude` is installed in a shell-specific path** (e.g. user installed via nvm and Octopal can't see nvm's PATH). Phase 5a falls back to clear error from Goose itself ("could not resolve command 'claude'"); Phase 5b can add explicit PATH configuration.

### 10.4 No OAuth for Anthropic

Anthropic doesn't expose OAuth via Goose v1.31.0. Not a limitation we can fix at Phase 5a layer.

---

## 11. Resume-tomorrow checklist

When picking this up:

1. Read §3.1 research table — confirm Goose version hasn't bumped (probe `$GOOSE --version`; if != 1.31.0, re-verify `claude-code` still exists and isn't `removed`)
2. Confirm no changes to `src-tauri/src/commands/goose_acp_pool.rs::hash_config` signature since Phase 3+4 landed
3. Start with commit order:
   - **A**: AuthMode enum + migration + tests (no behavior change)
   - **B**: detect_claude command + ProviderCard 4-state UI (reads enum, doesn't route yet)
   - **C**: goose_acp routing + pool key auth_mode + build_env PATH preservation

4. G1-5a manual verification requires a real Pro subscription session. Gil has claude CLI authenticated on this machine (verified at [docs/phase-3-4-scope.md §10.5] probe 2026-04-19) — good to go.

---

## Decision point

Phase 3+4 PR merges first → 5a branch opens off main post-merge. Do **not** rebase 5a onto 3+4 in-flight — the enum migration test needs 3+4 state shape as the baseline to migrate *from*.
