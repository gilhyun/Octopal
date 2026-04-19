# ADR: Goose 2.0 Integration for Octopal v0.2.0

**Status:** Spike complete (Phase 0). Decisions locked pending API-key smoke test.
**Date:** 2026-04-18
**Supersedes:** Claude CLI as the sole AI engine (v0.1.42)
**Scope:** Single source of truth for Phase 1~10 implementation. See `reactive-floating-feather.md` for the executable plan.

---

## 1. Decision Summary

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Goose v1.31.0** pinned as bundled sidecar | Latest stable (2026-04-17). "Goose 2.0" is a product brand (Rust rewrite), not a semver |
| D2 | **Interface: ACP** (`goose acp` JSON-RPC 2.0 stdio) | `session/request_permission` official method → Permission D실현. protocolVersion + capability negotiation → drift-resilient |
| D3 | **Extension control via CLI flags/ACP params** (`--with-builtin`, `--with-extension`) | Recipe YAML file generation unnecessary. No disk I/O, no GC complexity |
| D4 | **Isolation via XDG 3-tuple** (CONFIG/DATA/STATE_HOME) | `GOOSE_CONFIG_DIR` does NOT exist in v1.31.0 (`goose info` confirmed). XDG is the only reliable path |
| D5 | **API keys in OS keyring** (`keyring` v3) | Plain `settings.json` leaks = billing bomb. Config-hash excludes keys to avoid Keychain prompts per spawn |
| D6 | **Unified onboarding** (Provider × AuthMethod 3-step) | Mirrors Goose's own provider model. Single modal for new + upgrade users. `UpgradeNoticeModal` dropped |
| D7 | **Permission = ACP session/request_permission** (D안 확정) | Octopal ACP client auto-responds based on per-agent `permissions` toggles + tool name + path matching |
| D8 | **Bundle size +220MB/platform accepted** | Figma/Postman tier. Tauri ships platform-specific installers, so users download 220MB once (not 900MB) |
| D9 | **Legacy Claude CLI path preserved** (병행 운영) | `claude_cli.rs`, `model_probe.rs`, `ClaudeLoginModal.tsx`, `modals.claudeLogin.*` i18n — 전부 v0.3.0 cleanup까지 불변. `use_legacy_claude_cli` flag로 분기 |

---

## 2. Phase 0 Spike Results (Measured)

### 2.1 Binary inspection (macOS arm64)

```
File:         Mach-O 64-bit executable arm64 (NOT universal, NOT debug)
Size raw:     220 MB
Size strip:   185 MB  (release build ships with debug symbols)
Archive .bz2: 64 MB
Links:        AppKit, CoreGraphics, Metal, MetalKit, Accelerate
              → Rust ML runtime (candle/burn) for local inference drives size
```

**User-facing installer impact:** +220MB per platform. Tauri builds one installer per triple → each user downloads 220MB once, not 4×. Comparable to Figma Desktop (280MB), Postman (250MB), VS Code (350MB).

### 2.2 CLI surface (`goose --help`)

Confirmed subcommands: `configure | info | doctor | mcp | acp | serve | session | run | recipe | schedule | gateway | update | term | local-models | completion`.

Key flags on `goose run`:
- `--output-format {text,json,stream-json}`
- `--provider <PROVIDER>` — per-run override (also env `GOOSE_PROVIDER`)
- `--model <MODEL>` — per-run override (also env `GOOSE_MODEL`)
- `--with-builtin <NAME>` — enable bundled extensions
- `--with-extension <COMMAND>` — stdio MCP extensions
- `--with-streamable-http-extension <URL>` — HTTP MCP extensions
- `--no-session`, `--no-profile`, `--max-turns <N>`, `--yolo`

Provider list (from `--help` text): `openai, anthropic, ollama, databricks, gemini-cli, claude-code, and others`.

Provider source modules observed: `anthropic.rs, azure.rs, bedrock.rs, chatgpt_codex.rs, claude_acp.rs, claude_code.rs, codex.rs, codex_acp.rs, copilot_acp.rs, cursor_agent.rs, databricks.rs, gemini_cli.rs, gemini_oauth.rs, githubcopilot.rs, google.rs, ...`

### 2.3 ACP initialize handshake

```
Request:  {"jsonrpc":"2.0","id":1,"method":"initialize",
           "params":{"protocolVersion":1,"clientCapabilities":{}}}

Response: {"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion":1,
  "agentCapabilities":{
    "loadSession":true,
    "promptCapabilities":{"image":true,"audio":false,"embeddedContext":true},
    "mcpCapabilities":{"http":true,"sse":false},
    "sessionCapabilities":{"list":{},"close":{}},
    "auth":{}},
  "authMethods":[{"id":"goose-provider","name":"Configure Provider", ...}]}}
```

### 2.4 ACP permission method (docs-confirmed)

```
Request:  {"method":"session/request_permission",
           "params":{"sessionId":"...","toolCall":{"toolCallId":"call_001"},
                     "options":[{"optionId":"allow-once","kind":"allow_once"},
                                {"optionId":"reject-once","kind":"reject_once"}]}}

Response: {"result":{"outcome":{"outcome":"selected","optionId":"allow-once"}}}
```

**Status per spec:** `MAY` (optional, capability-gated). Agent requests when operation warrants. Client (Octopal) receives and decides.

### 2.5 Default paths (`goose info`)

```
Config dir:           ~/.config/goose                         (XDG_CONFIG_HOME)
Config yaml:          ~/.config/goose/config.yaml
Sessions DB (sqlite): ~/.local/share/goose/sessions/...       (XDG_DATA_HOME)
Logs dir:             ~/.local/state/goose/logs               (XDG_STATE_HOME)
```

Isolation strategy: inject `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME` pointing to `<app_data>/octopal/goose-{config,data,state}`.

### 2.6 CLI stream-json schema (non-ACP path — NOT adopted, recorded for completeness)

```
Chunk:    {"type":"message","message":{"id":null,"role":"assistant","created":N,
                                        "content":[{"type":"text","text":"..."}],
                                        "metadata":{"userVisible":true,"agentVisible":true}}}
Terminal: {"type":"complete","total_tokens":null}
```

Usage info: only `total_tokens`. No `cost_usd`, no `cache_*`, no `modelUsage`. This is one reason ACP was preferred (structured session events + explicit tool_call lifecycle).

### 2.7 Legacy Dispatcher audit (`dispatcher.rs:93-244`)

- System prompt: ~1.5KB static, routing rules + agent list
- User prompt: `history_summary` (last 6 msgs × 80 chars) + current message
- Model: **hardcoded `--model haiku`**
- **Timeout: none.** Blocking `read_line` loop until `{"type":"result"}` or EOF
- **Max-turns: none** (uses Claude CLI default)
- Pool key: `__dispatcher__` (single shared process across all routing calls)

**Implication for ACP port:** client-side timeout (default 30s, bump to 60s when planner model is Opus/Sonnet) + `session/cancel` on timeout. `maxTurns` at ACP session/new level if ACP spec supports it; otherwise client enforcement.

---

## 3. Architectural Decisions

### 3.1 Transport: ACP JSON-RPC 2.0 over stdio

- Spawn: `goose acp` with XDG env + provider/model env
- Octopal acts as ACP **client**: sends `initialize` → `session/new` → `session/prompt`, receives `session/update` streaming chunks and `session/request_permission` requests
- No CLI stream-json, no recipe YAML

### 3.2 Stream pipeline

```
goose acp stdout (JSON-RPC 2.0)
     ↓
[1] line buffer + JSON parse (goose_acp.rs)
     ↓
[2] ACP method dispatch
     ├─ session/update  → Octopal event
     │                     ├─ assistant text chunk → message append
     │                     ├─ tool_call start      → activity panel entry
     │                     ├─ tool_call result     → activity completion
     │                     └─ thinking             → UI thinking block (if present)
     ├─ session/request_permission
     │     → goose_acp_mapper.rs: permission resolver
     │       (agent.permissions × tool name × path) → allow/reject
     │       respond with {outcome:"selected", optionId:...}
     └─ session/complete → turn end
     ↓
[3] tool name normalize map (developer__shell → Bash, miss → passthrough+warn)
     ↓
[4] emit Octopal Tauri event (identical shape to v0.1.42 internal events)
```

### 3.3 Permission resolver (D 확정)

Pseudocode for `session/request_permission` handler:

```
fn resolve_permission(req: PermissionRequest, agent: &OctoFile) -> PermissionResponse {
    let tool = normalize_tool(&req.tool_call.tool_name);
    let needs_write = matches!(tool.as_str(), "Write" | "Edit" | "developer__text_editor");
    let needs_shell = matches!(tool.as_str(), "Bash" | "developer__shell");
    let needs_net   = matches!(tool.as_str(), "WebFetch" | "developer__fetch");

    if needs_write && !agent.permissions.file_write { return reject("file_write disabled"); }
    if needs_shell && !agent.permissions.bash       { return reject("bash disabled"); }
    if needs_net   && !agent.permissions.network    { return reject("network disabled"); }

    if let Some(path) = extract_path(&req.tool_call.input) {
        if matches_any(&agent.permissions.deny_paths, &path)  { return reject("deny_paths"); }
        if !agent.permissions.allow_paths.is_empty()
            && !matches_any(&agent.permissions.allow_paths, &path) { return reject("not in allow_paths"); }
    }
    allow_once()
}
```

Fine-grained fileWrite/bash/network combinations remain fully supported.

### 3.4 providers.json schema (external resource)

```json
{
  "anthropic": {
    "displayName": "Anthropic",
    "models": ["claude-opus-4-7","claude-sonnet-4-5","claude-haiku-4-5"],
    "authMethods": [
      {"id":"api_key","label":"API Key","goose_provider":"anthropic"},
      {"id":"cli_subscription","label":"Claude CLI Subscription","goose_provider":"claude-code","detectBinary":"claude"}
    ]
  },
  "google": {
    "displayName":"Google",
    "models":["gemini-2.5-pro","gemini-2.5-flash"],
    "authMethods": [
      {"id":"api_key","label":"API Key","goose_provider":"google"},
      {"id":"cli_subscription","label":"Gemini CLI","goose_provider":"gemini-cli","detectBinary":"gemini"},
      {"id":"oauth","label":"Google OAuth","goose_provider":"gemini-oauth"}
    ]
  },
  "openai": {
    "displayName":"OpenAI",
    "models":["gpt-5","gpt-5-mini","o3"],
    "authMethods": [
      {"id":"api_key","label":"API Key","goose_provider":"openai"},
      {"id":"cli_subscription","label":"ChatGPT Codex","goose_provider":"chatgpt-codex","detectBinary":"codex"}
    ]
  },
  "ollama": {
    "displayName":"Ollama (Local)",
    "models":"dynamic",
    "authMethods": [{"id":"host_only","label":"Local host","goose_provider":"ollama"}]
  }
}
```

- Bundle default at `src-tauri/resources/providers.json`
- Runtime overlay at `~/.octopal/providers.json` (partial override: missing keys inherit bundle)
- `goose_provider` is the value injected as `GOOSE_PROVIDER` env — may differ from UI `displayName`
- `detectBinary` runs `which <bin>` at onboarding for CLI auth pre-selection

### 3.5 Onboarding flow (unified)

Step 1 — Provider (list from providers.json)
Step 2 — AuthMethod (from selected provider's `authMethods[]`; skipped if only 1 option, e.g. Ollama)
Step 3 — Configure:
- `api_key`: password input + Test (list endpoint only, no completion calls)
- `cli_subscription`: show `which <detectBinary>` result + login status (via `{binary} --version` or similar)
- `oauth`: spawn external browser + callback
- `host_only`: host URL + `/api/tags` probe

Save: `save_api_key(provider_id, key)` to keyring (api_key path only) + AppSettings `default_provider`/`default_auth_method`/`default_model` + `onboarding_complete=true`.

**Upgrade users:** at boot, `detectBinary` runs — if `claude` is on PATH and logged in, onboarding opens pre-selected to Anthropic + `cli_subscription`. User can override, but the "Just keep working" path is 2 clicks.

---

## 4. Feature Compatibility Matrix (Final)

| # | Feature | v0.1.42 source | Goose/ACP equivalent | Status |
|---|---------|---------------|----------------------|--------|
| 1 | Assistant text streaming | `assistant` + `content[text]` blocks | ACP `session/update` with `agentMessageChunk` | ✅ Maintained |
| 2 | Tool-use activity labels (Bash/Write/Edit/Read/Grep/Glob/WebFetch) | Claude `block.name` | ACP `tool_call.tool_name` → `developer__shell` etc. | 🟡 Normalize map; miss = passthrough + `warn!` |
| 3 | File diff rendering | tool_use result text | Same pattern in ACP tool_call result | ✅ Maintained |
| 4 | Thinking blocks | `content[type=thinking]` | **Unconfirmed** — spec mentions but Goose emission depends on provider | 🟡 Preserve UI, render when present, hidden otherwise |
| 5 | `total_cost_usd` | Claude `result.usage.total_cost_usd` | Goose stream gives `total_tokens` only (spike confirmed) | 🔴 Degraded → show "N/A" + tooltip |
| 6 | Cache hit tokens (`cache_read/creation_input_tokens`) | Claude-specific | Missing from Goose output | 🔴 Hidden UI fields when not provided |
| 7 | `modelUsage` multi-model breakdown | Claude `result.modelUsage` | Unconfirmed | 🟡 `Option<T>` — render if present |
| 8 | @mention routing | Renderer-only | n/a | ✅ Unchanged |
| 9 | Dispatcher orchestration | Hardcoded Haiku | `GOOSE_PLANNER_*` env | 🟡 Add client-side timeout (none today) + max-turns enforcement |
| 10 | Fine-grained permissions (fileWrite/bash/network独立) | `--disallowed-tools` | **ACP `session/request_permission`** | ✅ Maintained (Permission D) |
| 11 | MCP servers (stdio/sse/http) | Claude `--mcp-config` | ACP `mcpCapabilities` = `http:true, sse:false`; stdio via `--with-extension` | 🟡 SSE transport missing → badge unsupported servers in UI |
| 12 | Adaptive Opus detection (`model_probe.rs`) | Claude latest auto-probe | Not needed (Goose handles provider-internal) | 🟢 Deprecated safely; Settings retains "Latest Anthropic Opus" placeholder |

Legend: ✅ no loss · 🟡 maintained via adapter/workaround · 🔴 degraded, UX policy required

---

## 5. Open Questions (require API-key smoke test before Phase 2 freeze)

1. **Thinking block emission** — does `provider=anthropic` + reasoning model emit thinking events over ACP? Need one real Opus run.
2. **modelUsage availability** — does ACP expose per-model token breakdown when multiple models are used in a session?
3. **SSE MCP fallback** — `mcpCapabilities.sse:false` is confirmed; is there a spec-level fallback or do SSE servers just fail?
4. **ACP `maxTurns` on session/new** — confirm whether spec supports it or we enforce client-side.
5. **`session/cancel` timing** — how quickly does Goose honor it mid tool_call?

Answers go into this file as `## 6. Smoke Test Findings` after a 30-minute API-key run. Blocking for Phase 2 PR merge (Merge Gate G1).

---

## 6. Smoke Test Findings — 2026-04-18 (Phase 2 stage 2 PoC)

Shell-level probe against bundled `goose-aarch64-apple-darwin` v1.31.0 (no API keys, proves wire protocol only). Ran three JSON-RPC requests sequentially: `initialize` → `session/new` → `session/prompt` (with a deliberately bad `sessionId` to probe error shape).

### 6.1 Verified `agentCapabilities` (ADR-bound)

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": { "image": true, "audio": false, "embeddedContext": true },
    "mcpCapabilities":    { "http": true, "sse": false },
    "sessionCapabilities": { "list": {}, "close": {} },
    "auth": {}
  },
  "authMethods": [
    { "id": "goose-provider",
      "name": "Configure Provider",
      "description": "Run `goose configure` to set up your AI provider and API key" }
  ]
}
```

Stable across both Phase 0 spike and Phase 2 stage 2 probe. Safe to pin as the handshake contract.

### 6.2 NEW: `session/new` exposes permission modes → 2-layer defense

This was NOT in the earlier spike capture. The `session/new` response now reveals:

```json
{
  "sessionId": "<uuid>",
  "modes": {
    "currentModeId": "auto",
    "availableModes": [
      { "id": "auto",          "description": "Automatically approve tool calls" },
      { "id": "approve",       "description": "Ask before every tool call" },
      { "id": "smart_approve", "description": "Ask only for sensitive tool calls" },
      { "id": "chat",          "description": "Chat only, no tool calls" }
    ]
  }
}
```

**Permission D becomes a 2-layer defense:**

| Layer | Mechanism | Scope | Bypass protection |
|-------|-----------|-------|-------------------|
| 1 (outer) | ACP session mode set at `session/new` | Protocol-level — `chat` mode blocks tool calls from being formulated at all | Cannot be bypassed by a bug in the Octopal resolver |
| 2 (inner) | `session/request_permission` auto-response | Per-tool-call, per-path, fine-grained | Governed by `goose_acp_mapper.rs:resolve_permission` |

**Octopal permission toggles → ACP session mode mapping (binding rule):**

```
if  !file_write && !bash && !network            → "chat"         (hard lock, L1 only)
elif file_write && bash && network              → "auto"         (L1 trust, L2 path filter only)
else                                             → "auto"         (L1 trust, L2 fine-grained filter)
```

`approve`/`smart_approve` modes are not used — they prompt the human, but in Octopal the agent IS the human's delegate, so we must auto-decide. The decision engine is our resolver; the session mode is just the blast-radius cap.

Why `chat` matters: if the resolver has a bug and wrongly allow-lists a tool, a fully-locked agent still cannot invoke it because Goose never emits the tool call in the first place. Belt and braces.

### 6.2b Other observations worth ADR-binding

- **`mcpCapabilities.sse: false`** — confirms Risk #11: SSE MCP transport is officially unsupported. Migration step must badge existing v0.1.42 agents using SSE MCP servers as "incompatible" in the agent edit modal. HTTP + stdio migrate cleanly.
- **`promptCapabilities.image: true, audio: false`** — image input supported at the protocol level. Octopal has no image attach UI today, but this is a v0.4.0+ feature candidate with zero plumbing cost.
- **`loadSession: true`** — Goose can resume existing sessions by id. Potential future feature: persist `sessionId` in room-log.json and re-attach on agent restart for true context continuity across app restarts. Out of scope for v0.2.0 but a strong hook for v0.3.x.
- **`error.code: -32002` (Resource not found)** — standard JSON-RPC 2.0 error codes. Goose is spec-compliant. Our `oneshot` correlation table handles this cleanly via the `id` field.

### 6.3 Error response shape (JSON-RPC 2.0 standard)

Bad `sessionId` on `session/prompt`:
```json
{ "jsonrpc":"2.0", "id":3, "error":{ "code":-32002, "message":"Resource not found", "data":"Session not found: PLACEHOLDER"} }
```

Standard JSON-RPC 2.0 error envelope. Our client correlates via `id` — already handled correctly by the `oneshot::Sender` table in `goose_acp.rs`.

### 6.4 Rust-side implementation status

`src-tauri/src/commands/goose_acp.rs` now exposes `acp_smoke_test` (Tauri command) that performs the same 3-request lifecycle over the real sidecar spawn path. `cargo check` passes. The command is **registered but not yet wired into the renderer** — it's a debugging entry point for Phase 2 stage 2. Full e2e Rust-path verification will come with `cargo tauri dev` + a dev-tools button in stage 3.

### 6.5 Still-open questions (status after live probe 2026-04-19)

| # | Question | Status |
|---|----------|--------|
| A | Does `anthropic` + reasoning model emit a `thinking` sessionUpdate variant? | **RESOLVED (partial)** — No `agent_thought_chunk` appeared for a standard Sonnet 4.6 prompt. Extended thinking isn't enabled by Goose's default config. If we want thinking UI to work, we'll need Goose to expose a thinking-enable flag (not in v1.31.0 `session/new` params). Degrade gracefully: thinking UI just never renders on Goose path, no crash |
| B | Does `modelUsage` / `usage` / `cost` appear in `session/prompt` response? | **RESOLVED ❌** — Response carries only `{stopReason}`. No tokens, no cost, no modelUsage. Confirms Plan §Risks #3 decision: `UsageEvent` fields are optional, UI shows "N/A" on Goose path |
| C | Does `session/cancel` succeed? | **RESOLVED ❌** — all cancel-family methods return -32601. Cancellation is process-level SIGTERM/SIGKILL. See §6.6 |
| D | Does ACP accept `maxTurns` on `session/new`? | **RESOLVED ❌** — `maxTurns:1` silently ignored, not echoed in response, session runs unlimited turns. Client must implement turn-counting itself by observing `tool_call` updates and forcing shutdown on overrun |
| E | SSE MCP fallback | **RESOLVED ❌** — `mcpCapabilities.sse: false`. HTTP + stdio only |

### 6.5a Live stream shape (2026-04-19, Sonnet 4.6 one-shot prompt)

Observed for "Pick cats or dogs, one sentence":

```
t+1492ms session/update agent_message_chunk  text="I"
t+1900ms session/update agent_message_chunk  text=" pick **dogs** — their unwavering loyalty and bound"
t+2214ms session/update agent_message_chunk  text="less enthusiasm make every homecoming feel like the best moment of your day"
t+2221ms session/update agent_message_chunk  text="."
prompt response                               result={stopReason:"end_turn"}   at t+2221ms
```

**Shape invariants (bind to code):**
- Every chunk: `{sessionUpdate:"agent_message_chunk", content:{type:"text", text:"..."}}`
- Chunk size varies 1–70 chars. Caller must accumulate — one chunk ≠ one sentence.
- **Turn-complete signal = `session/prompt` response, not a session/update variant.** Stage 5's prompt await loop ends when the response lands; it does NOT need to watch for a "complete" update.
- `stopReason` values observed: `"end_turn"`. Other possible per ACP spec: `"max_tokens"`, `"refusal"`, `"error"` (not yet observed).
- **When Goose errors mid-turn** (e.g. bad model ID → 404 from Anthropic), the error text arrives as a regular `agent_message_chunk` ("Ran into this error: ..."). stopReason is still `end_turn`. Mapper doesn't need special handling — error flows through as assistant text like any other chunk.

### 6.6 Method probe — what Goose v1.31.0 actually implements

Ran against sandboxed sidecar, 13 candidate methods + 1 control (`session/__nope__` → confirmed -32601 baseline).

**EXISTS (4 methods):**

| Method | Purpose | Use in Phase 2 |
|--------|---------|----------------|
| `session/list` | List open sessions | Diagnostics, state recovery |
| `session/set_mode` ⚠️ **snake_case** | Change permission mode at runtime | Permission 2-layer (optional runtime downgrade) |
| `session/load` | Resume existing session by id | v0.3.x continuity feature (out-of-scope for v0.2.0) |
| `session/close` | Clean session teardown | Agent removal only — **NOT cancellation** |

Note: `session/setMode` (camelCase) returns -32601. `session/set_mode` (snake_case) returns `{}`. Codebase must use snake_case.

**MISSING (-32601):** `session/cancel`, `session/stop`, `session/abort`, `session/interrupt`, `session/cancelPrompt`, `session/end`, `session/terminate`, `session/setMode`.

### 6.7 Cancellation strategy (final) — Q-C resolved via SIGTERM probe

Since no JSON-RPC cancel method exists, Stop-button and dispatcher-timeout paths must kill the child process. **Live SIGTERM timing probe** (`scripts/acp-cancel-probe.mjs`, Anthropic-backed, 3 scenarios):

| Scenario | SIGTERM → stdout EOF | SIGTERM → exit | Post-SIGTERM bytes | Post-SIGTERM updates |
|----------|----------------------|----------------|--------------------|-----------------------|
| S1 text streaming (mid-gen) | **4ms** | 5ms | 0 | 0 |
| S2 tool_use (shell running)  | **4ms** | 4ms | 0 | 0 |
| S3 race (before first chunk) | **1ms** | 1ms | 0 | 0 |

**All three** exit with `signal=SIGTERM` (clean), flush zero bytes post-signal, and leave the in-flight `session/prompt` request pending forever (no zombie stream). Goose handles SIGTERM via tokio runtime shutdown — no half-baked tool output or orphaned subprocess rot.

**Revised path:**

```
Stop button / timeout →  SIGTERM sidecar PID
                         ↓ (200ms grace — was 3s, overspec'd)
                         SIGKILL if still alive (never observed in probe)
                         ↓
                         process_pool.rs config-hash miss on next message
                         → respawns fresh `goose acp` process
                         → new sessionId (prior turn's context is lost)
```

**Note on tauri-plugin-shell:** `CommandChild::kill()` only exposes SIGKILL. Given SIGTERM→exit = 4ms and SIGKILL→exit ≈ 0ms on macOS, the distinction is immaterial for UX. Stage 6 uses `kill()` directly; a future SIGTERM-graceful API can swap in without behavioral change.

**UX implication:** Stop forfeits the in-flight turn's context. User's next message starts a fresh session for that agent. This matches v0.1.42's claude-cli behavior — no UX regression.

**Dispatcher:** same kill path, but dispatcher pool key is `__dispatcher__` (single shared process), so a timeout nukes only the router, not the agents.

**Child-of-child processes.** Goose-spawned subprocesses (e.g. a long-running `bash` tool invocation that itself spawned `find`) may leave partial stdout/stderr or temp files when the Goose parent receives SIGTERM. This is consistent with v0.1.42's Claude CLI behavior — Octopal does not walk the process tree to clean up grandchildren. Users on Stop during a 2-minute `grep -r` see the partial output already captured by Goose before SIGTERM; the underlying `grep` becomes an orphan reaped by the init process. If a future user report surfaces this, the fix is process-group kill (`killpg(-pid, SIGTERM)`) — not in scope for v0.2.0.

### 6.8 Model ID resolution — ⚠️ dot-notation is a display alias only

**Stage-3 live probe overturned the earlier §6.8 assumption.** Goose's
`session/new` (and `session/load`) response advertises a catalog using
**dot notation** (`claude-sonnet-4.6`, `claude-opus-4.6`, …), but when
that string is passed as `GOOSE_MODEL` it is **forwarded verbatim to
Anthropic's API**, which returns 404:

```
Resource not found (404): model: claude-sonnet-4.5.
Available models for this provider:
  claude-sonnet-4-6, claude-opus-4-6, claude-opus-4-5-20251101,
  claude-haiku-4-5-20251001, claude-sonnet-4-5-20250929,
  claude-opus-4-1-20250805, claude-opus-4-20250514,
  claude-sonnet-4-20250514
```

**The correct form is dash + digits** (optionally with a date suffix).
Goose v1.31.0 advertises dot aliases in its ACP catalog but does NOT
resolve them to real IDs before API call — that's a Goose behavior we
have to work around, not a naming convention we can adopt.

**Binding consequences for Octopal:**

- **`GOOSE_MODEL` must receive the Anthropic-native ID** (dash form). Current (2026-04-19) Anthropic catalog:
  - ✅ `claude-opus-4-7` (latest Opus, released 2026-04-16 — **not** yet in Goose v1.31.0's ACP catalog; see §6.8a staleness risk)
  - ✅ `claude-sonnet-4-6` (Feb 2026, current daily-driver default)
  - ✅ `claude-sonnet-4-5-20250929` (dated form of prior Sonnet, still valid)
  - ✅ `claude-opus-4-6` (prior Opus, still valid)
  - ✅ `claude-haiku-4-5-20251001` (latest Haiku — also accepted as bare `claude-haiku-4-5`)
  - ❌ `claude-sonnet-4.6` (dot form — 404s)
- Phase 3 defaults (split by tier):
  - `default_model = "claude-sonnet-4-6"` — practical daily driver
  - `default_opus  = "claude-opus-4-7"`  — top-tier fallback when user picks "Latest Opus" or `opus` alias
- Phase 4 `providers.json` anthropic `models: ["claude-opus-4-7","claude-sonnet-4-6","claude-haiku-4-5-20251001", "claude-opus-4-6","claude-sonnet-4-5-20250929", ...]` — ordered newest-first.
- Phase 3 `model_alias.rs` resolution map (updated):
  - `(opus, anthropic) → "claude-opus-4-7"` (was `4-6`; bump)
  - `(sonnet, anthropic) → "claude-sonnet-4-6"`
  - `(haiku, anthropic) → "claude-haiku-4-5-20251001"`
- Phase 10 regression suite: assert `claude-opus-4-7` spawns cleanly (proves Goose accepts IDs not in its own catalog); assert `claude-sonnet-4.6` (dot) fails with a 404 message we surface in activity stream.
- Adaptive `model_probe` analog: **keep it.** `model_probe.rs` already probes `claude-opus-4-7` against the Claude CLI — the mechanism is reusable against Goose on the Anthropic provider (empty prompt + `GOOSE_MODEL=<candidate>` → spawn dies quickly with 404 if unavailable, streams tokens if available). Phase 4 adaptive detection runs against Goose at startup to pick the best Opus the user's key actually has access to.

**Why keep the dot-alias catalog around?** It's useful UX-facing *display* data:
`session/load` reveals provider modules + human-readable display names. Phase 4 providers.json UI can use the catalog for display strings but must **never** write dot-form to `GOOSE_MODEL`.

### 6.8a Model catalog staleness — `availableModels` is a hint, not truth

**New risk surfaced by the Opus 4.7 catalog gap.** Goose v1.31.0's `session/load` response advertises a fixed list (`claude-sonnet-4.6`, `claude-opus-4.6`, `claude-haiku-4.5`, …) compiled into the binary at Goose release time. When Anthropic ships a new model (Opus 4.7, 2026-04-16), **Goose's catalog does not update** — users would be stuck on 4.6 until the Goose team cuts a new release and Octopal re-bundles it.

**But:** the catalog is display-only. Goose happily forwards any `GOOSE_MODEL` env string to the Anthropic API, which resolves it server-side. Opus 4.7 works through Goose v1.31.0 today despite not appearing in the ACP catalog.

**Octopal's strategy: merge Goose catalog + Octopal curated list.**

```
availableModels(provider) =
    Octopal curated list (providers.json, newest-first)
  ⋃ Goose catalog models (for this provider, display-only)
  ⋃ user's persisted model picks from past sessions (never drop)
```

- **Octopal curated list** lives in `src-tauri/resources/providers.json` and is updated with each Octopal release. Source of truth for "current newest" — never waits on Goose.
- **Goose catalog** is kept for discoverability of provider-specific models Octopal doesn't explicitly curate (e.g. fine-tunes, preview models).
- **Custom model ID escape hatch** — Settings → Providers tab gets a "Custom model ID" text field per provider. Any string goes to `GOOSE_MODEL` verbatim. Lets users try a new Anthropic model (Opus 4.8 hypothetically) the day it ships, without waiting on an Octopal release.
- **Validation:** custom IDs are NOT validated up-front. If invalid, the 404 surfaces in activity stream — same path as a typo. No blocking modal.

**Why this matters for Phase 2 Stage 6:** `agent.rs` must accept model strings Octopal-curated **or** user-custom without enumeration. The spawn path already passes through to `GOOSE_MODEL` env; no allow-list. Just don't add one.

### 6.9 `session/new` mode parameter — RESOLVED ❌

Tried four parameter shapes (`mode: "chat"`, `modeId: "chat"`, `modes: {currentModeId: "chat"}`, baseline). All four created sessions with `currentModeId: "auto"`. Goose silently ignores unknown params on `session/new`. Mode lock requires two round-trips:

```
session/new { cwd, mcpServers } → sessionId, modes.currentModeId:"auto"
session/set_mode { sessionId, modeId:"chat" } → {}
```

Combined latency measured ~90ms locally — acceptable. Octopal spawn path: always do the two-call sequence; pick the modeId per the 2-layer rule in §6.2.

---

## 7. Outstanding Phase 0 Work (carried)

- [x] ~~API-key smoke test (Anthropic) to resolve §6.5 question C~~ — **resolved** Apr 2026 via `scripts/acp-live-probe.mjs` (Q-A/B/D) + `scripts/acp-cancel-probe.mjs` (Q-C). See §6.5, §6.5a, §6.7.
- [ ] Keyring v3 cross-platform `cargo check` on macOS/Windows/Linux (Cargo.toml patch + CI matrix) — needed for Phase 4.
- [ ] room-log.json compatibility: confirm Octopal's MessageRow shape is preserved (renderer writes it, not Goose — should be trivially compatible, but write test).
- [ ] Security review kickoff: D0 ticket for keyring (D+1 2h slot), D+2 ticket for log redaction.

Phase 2 stage 6 (agent.rs integration, pool hookup) is now unblocked.
