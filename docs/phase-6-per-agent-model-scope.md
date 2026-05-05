# Phase 6 — per-agent provider + model selection

**Status:** proposed
**Owner:** Gil
**Date:** 2026-05-02
**Branch:** `feature/phase-6-per-agent-model` (forks from 5a-finalize tip)
**Depends on:** Phase 5a + finalize merged (multi-provider keyring + CLI subscription path)
**Blocks:** Mixed-model agent workflows (e.g. one agent on Claude Opus, another on GPT-5)

---

## 1. Motivation

5a-finalize delivered the auth side of multi-provider — a user can store
both Anthropic + OpenAI credentials, flip CLI subscription on either
provider, and have the routing layer pick the right Goose backend per
provider. But the **agent → model** binding is still global:

- Every `config.json` carries no provider/model fields
- `agent.rs::run_agent_turn` derives the model from
  `settings.advanced.default_agent_model` (one of `opus`/`sonnet`/`haiku`)
  via a fallback chain that ignores the agent identity
- `goose_acp.rs::run_agent_turn` line 1147 hardcodes
  `let provider = "anthropic".to_string()`

Practical user complaint (2026-05-02): wanted to call Claude AND GPT in
the same workspace as separate agents. Today's only workaround is to
flip `default_provider` between turns — unworkable.

Phase 6 makes provider + model **first-class fields on each agent**,
default-falling-back to settings when unset (legacy `.octo` files keep
working).

## 2. Scope

In-scope:
- `config.json` schema: `provider?: string`, `model?: string`
  (both optional — absent = "use default")
- Rust deserialization in the legacy + Goose paths
- `run_agent_turn` (both `agent.rs` and `goose_acp.rs`) reads agent
  config and overrides the global default
- UI: new **Model** tab in `EditAgentModal` + `CreateAgentModal` with
  cascading provider → model dropdowns (provider switch repopulates
  the model list from `providers.json::models`)
- Anthropic alias (opus/sonnet/haiku) stays in the model list but
  exclusive to anthropic; OpenAI shows its own concrete list
- i18n (en + ko)
- Migration: legacy agents (no provider/model) continue to use
  `settings.advanced.default_agent_model` + global default provider
  unchanged. No on-disk rewrite, no version bump.

Out-of-scope (future Phase 7+ candidates):
- Per-agent `temperature` / `max_tokens` / other model params
- Cost-aware model selection (pick cheapest model that fits task)
- Provider failover (Anthropic 5xx → fall back to OpenAI)
- Agent-level usage tracking
- "Last-used model" auto-suggest in the dropdown

## 3. Schema

### 3.1 `config.json` shape (additive, optional fields)

```jsonc
{
  "name": "researcher",
  "role": "Research assistant",
  "icon": "🔬",
  // ── Phase 6 additions ──────────────
  "provider": "openai",       // optional; UI provider id matching providers.json
  "model": "gpt-5",           // optional; specific model OR alias (anthropic only)
  // ───────────────────────────────────
  "permissions": { … },
  "mcpServers": { … }
}
```

Both fields optional. Resolution rules (most → least specific):

1. `agent.config.provider` set ➞ use it
   `agent.config.model` set ➞ use it
2. Either missing ➞ fall back to `settings.providers.default_provider`
   / `settings.providers.default_model`
3. If even those missing ➞ existing 5a defaults (`anthropic` /
   `claude-sonnet-4-6`)

This keeps every existing `.octo` working without rewrite.

### 3.2 Validation (defense-in-depth)

`provider` accepted values: must exist as a key in
`providers.json` at runtime. Unknown provider ➞ ignored (fallback to
default), with a `[agent:model]` warning log:

```
[agent:model] agent=foo: provider="custom-provider" not in manifest, falling back to default
```

`model` accepted values: any non-empty string. We don't validate
against the manifest list because:
- providers.json's `models` array can lag behind reality (the bundled Goose
  catalog stale per ADR §6.8a)
- Anthropic supports aliases (`opus`/`sonnet`/`haiku`) that aren't in
  the concrete model list
- OpenAI accepts ad-hoc model IDs the user might want to override

If the model is invalid, the provider's API surfaces the error in the
turn stream — same UX as today.

### 3.3 Rust struct

New file: `src-tauri/src/commands/agent_config.rs` (small, ~80 LOC).

```rust
/// Subset of config.json relevant to provider/model resolution.
/// Other fields (name, role, permissions, mcp) are unchanged from
/// existing parsing; this struct is *additive*.
#[derive(Deserialize, Default)]
pub struct AgentBinding {
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

/// Resolve (provider, model) for a turn:
/// agent_config → provider_default + model_default → "anthropic" + "claude-sonnet-4-6"
pub fn resolve_for_turn(
    binding: &AgentBinding,
    settings_default_provider: Option<&str>,
    settings_default_model: Option<&str>,
) -> (String, String) { … }
```

Tested in isolation — pure resolution logic, no I/O.

## 4. Rust changes

### 4.1 `goose_acp::run_agent_turn`

Replaces the hardcoded `let provider = "anthropic".to_string()` with:

```rust
let agent_binding = read_agent_binding(&params.octo_path)?;
let provider = agent_binding.provider.clone()
    .or_else(|| settings.providers.default_provider.clone())
    .unwrap_or_else(|| "anthropic".to_string());
```

Pool key already includes `provider` (Phase 5a C-2 §4.3) — no additional
pool-key changes. Different agents on different providers get distinct
pool keys naturally.

### 4.2 `agent.rs` (legacy claude CLI path)

Same resolution but only `model` matters here (legacy path is
Anthropic-only). If `agent.provider` is something other than
`"anthropic"`, log a warning + fall back to `claude-sonnet-4-6`. The
real fix is to route those agents through Goose, which the Goose path
already does.

### 4.3 `model` resolution per provider

Anthropic alias substitution (existing `model_probe::resolve_model_for_cli`)
stays — but only fires when `provider == "anthropic"`. Other providers
pass the model string verbatim to Goose's `GOOSE_MODEL` env.

```rust
let goose_model = match provider.as_str() {
    "anthropic" => model_probe::resolve_model_for_cli(&raw_model, &state),
    _ => raw_model,  // openai/google/etc. — verbatim
};
```

### 4.4 Pool drift on agent edit

When the user edits an agent's provider or model and saves, the
existing pool key changes (because both fields are in the hash). Next
turn's MISS triggers a fresh spawn. No additional invalidation needed.

## 5. UI design

### 5.1 New Model tab in EditAgentModal / CreateAgentModal

Tab order: **Basic / Prompt / Permissions / Model / MCP**

(Model goes after Permissions because conceptually it's "what runs the
agent" — adjacent to permissions which is "what the agent can do".)

```
┌─ Model tab ─────────────────────────────────────┐
│  Provider   [Anthropic           ▾]            │
│             ☐ Use workspace default             │
│                                                 │
│  Model      [opus (alias)        ▾]            │
│             Available: opus, sonnet, haiku,     │
│                        claude-opus-4-6, …       │
│                                                 │
│  ⓘ Leave both fields default to inherit the     │
│    workspace's defaults from Settings → Providers │
└─────────────────────────────────────────────────┘
```

Provider dropdown is populated from `providers.json` keys.
Model dropdown is populated from the selected provider's `models`
array. Switching provider clears the model field (with confirmation
toast if model was set).

"Use workspace default" checkbox above each dropdown — when checked,
the field renders disabled and saves as `null`/absent in `config.json`
(triggers fallback to settings).

### 5.2 CreateAgentModal default

New agent: defaults to "Use workspace default" for both. User who
wants a non-default agent unchecks the box and picks. This makes
"create agent" identical to today's behavior unless user explicitly
opts in.

### 5.3 Visual indicator on agent card

Each agent in the sidebar already shows its name + icon. Phase 6
adds a small badge under the name when the agent has a non-default
provider/model:

```
🔬 researcher
   (gpt-5)              ← only shown if model overridden
```

Anthropic with default model: no badge (avoids cluttering the most
common case).

## 6. Commit order

| # | Title | LOC | Sleep-safe |
|---|---|---|---|
| E-1 | `agent_config.rs` + Rust schema + create_octo/update_octo accept new fields + tests | ~250 | ✓ |
| E-2 | `agent.rs` (legacy) reads binding; warning log for non-anthropic | ~80 | ✓ |
| E-3 | `goose_acp.rs::run_agent_turn` reads binding; provider parameterization | ~150 | ✓ |
| E-4 | UI: Model tab in EditAgentModal + CreateAgentModal + provider→model cascade | ~250 | UI |
| E-5 | UI: agent-card badge for non-default model + i18n | ~80 | UI |
| E-6 | docs/phase-6-verification.md + manifest sanity tests | ~120 | ✓ |

Pure-Rust E-1/E-2/E-3 + docs E-6 run overnight. UI E-4/E-5 need visual
review.

## 7. Merge gates

- **G1-6** — Edit existing agent: open Model tab, switch provider to
  OpenAI, pick `gpt-5`, save. Send a message to that agent. stderr:
  `[resolve] agent=foo provider=openai auth=cli_subscription →
  goose_provider=chatgpt-codex`. Response streams from GPT.

- **G2-6** — Same workspace, second agent left at "Use workspace
  default". Send a message: routes through Anthropic (current default).
  Verifies that agent A's binding doesn't bleed into agent B.

- **G3-6** — Legacy agent (no provider/model in config.json): loads
  fine, sends fine, hits global defaults. No on-disk rewrite happens
  unless the user actively edits.

- **G4-6** — Switch back to "Use workspace default" on agent A: save,
  next turn uses defaults again. Pool entry for the previous binding
  evicted (drift detection).

- **G5-6** — Provider in config.json that doesn't exist in
  providers.json (e.g. user-edited file with `"provider": "custom"`):
  warning logged, falls back to default. No crash, no opaque errors.

## 8. Risks

### 8.1 Pool key proliferation

Different (agent, provider, model) triples spawn distinct sidecars.
A workspace with 5 agents using 3 different providers/models = up to
15 pooled sidecars. Each is ~50-100MB resident. Mitigation: existing
pool already handles this (Phase 5a C-2 §4.3); CMU's eviction policy
(idle timeout) is Phase 7 territory.

### 8.2 Anthropic alias behavior

`opus`/`sonnet`/`haiku` resolve via `model_probe::resolve_model_for_cli`
to specific versions. If a user picks "opus" while OpenAI is selected
as provider, the alias has no meaning. UI prevents this (model dropdown
filtered by provider) but on-disk validity is the renderer's
responsibility — Rust trusts the value and lets it fail downstream
(provider returns "unknown model" error in the stream).

### 8.3 Backward compat for the model probe

`resolve_model_for_cli` is hardcoded for anthropic aliases. We gate it
on `provider == "anthropic"` (Phase 6 §4.3) so OpenAI/Google models
pass through verbatim. Existing 5a tests of `resolve_model_for_cli`
unaffected.

### 8.4 First-time UX

User opens the Model tab on an existing agent: defaults to "Use
workspace default" (since the field is absent). No surprise. They can
override or close without saving.

## 9. What's NOT changing

- API key resolution stays in `api_keys.rs`, keyed by UI provider.
  Phase 6 just uses whatever key the per-agent provider needs.
- Settings → Providers UI stays identical. The "기본 프로바이더" /
  "기본 모델" dropdowns still exist — they're now the *fallback* for
  agents that don't specify their own.
- Pool key shape stays the same (folder::agent::provider::auth_mode::
  model::sp_hash). C-2 already factored provider/model into the key,
  so per-agent overrides naturally produce per-agent pool entries.

## 10. Resume-tomorrow checklist

If interrupted between commits:

1. Read git log on `feature/phase-6-per-agent-model` to see where
   we are (top commit message lists what's done).
2. Run `cargo test --lib` — must be green.
3. Continue at the next E-X heading in this file.

---

## Decision point

Phase 5a + finalize merge first → 6 branch rebases onto main if
needed. The schema additions are forward-compatible (deserialize
ignores unknown fields), so a 5a-still-on-branch state doesn't block
6 development — but the PR opens cleanest after 5a merge.
