# Phase 5a-finalize — robust CLI subscription on macOS app bundles + OpenAI Codex

**Status:** in-progress
**Owner:** Gil
**Date:** 2026-05-02 (resumed from 5a Commit C-3 manual verification)
**Branch:** `feature/phase-5a-cli-subscription` (continues — A/B/B-fix/C-1/C-2/C-3 docs already landed)
**Parent plan:** docs/phase-5a-scope.md (5a base)

---

## 1. Why this exists

Phase 5a Commit C-3 manual verification on Gil's actual machine surfaced
two problems that 5a's `§10.3` had explicitly punted to 5b:

### 1.1 Discovery: `claude` not detected on Finder-launched Octopal

Symptom (per user screenshot): Settings → Providers → Anthropic shows
`neither` state ("설정된 Anthropic 인증이 없습니다" + "Claude CLI 설치하기"
link). User has `claude` installed and authenticated.

Root cause analysis:

| Probe | Result |
|---|---|
| `which claude` (shell) | `~/.nvm/versions/node/v22.15.1/bin/claude` |
| `launchctl getenv PATH` | empty (no LaunchServices PATH set) |
| Octopal app launch | `/Applications/Octopal.app/Contents/MacOS/octopal` (Finder) |
| Octopal inherited PATH | `/usr/bin:/bin:/usr/sbin:/sbin` (macOS bundle default) |
| `detect_claude` | scans inherited PATH only — never sees nvm dir → `not_found` |

This is the **canonical** macOS app-bundle gotcha: Finder/Dock launches
inherit a minimal LaunchServices environment, not the user's shell PATH.
nvm/asdf/homebrew/local-bin all live outside the inherited PATH.

5a §10.3 had documented this: *"Phase 5a falls back to clear error from
Goose itself; Phase 5b can add explicit PATH configuration."* In
practice the failure surfaces **earlier** — at the detect_claude stage,
before Goose even spawns — and turns the carefully-designed 4-state
Anthropic card into a one-state dead-end.

### 1.2 Discovery: `claude` is self-contained, `codex` is a node shebang

Probing the actual binaries:

```bash
$ file ~/.nvm/versions/node/v22.15.1/bin/claude.exe
# Mach-O arm64 executable (Bun-compiled, self-contained)

$ env -i PATH=/usr/bin:/bin /Users/.../claude --version
2.1.123 (Claude Code)   # ← works, binary needs no node

$ head -1 ~/.nvm/versions/node/v22.15.1/lib/node_modules/@openai/codex/bin/codex.js
#!/usr/bin/env node     # ← shebang script

$ env -i PATH=/usr/bin:/bin /Users/.../codex --version
env: node: No such file or directory   # ← needs node on PATH
```

Implication: **`claude` is recoverable with absolute-path probes alone.
`codex` is not** — even if we discover its absolute path, the kernel's
shebang dispatcher needs to find `node` on the child's PATH. Two fixes
in one: discover the binary, AND ensure its runtime dependencies (node)
are reachable.

### 1.3 Discovery: Goose has a built-in command-override mechanism

Goose v1.31.0 strings dump revealed environment variables we missed in
5a's research:

| Env var | Effect on Goose subprocess spawn |
|---|---|
| `CLAUDE_CODE_COMMAND` | Override which binary the `claude-code` provider spawns |
| `CODEX_COMMAND` | Override which binary the `chatgpt-codex` provider spawns |
| `GEMINI_CLI_COMMAND` | Override the `gemini-cli` provider's binary |
| `CURSOR_AGENT_COMMAND` | Override the cursor-agent provider's binary |
| `CODEX_SKIP_GIT_CHECK` | (related — controls codex behavior) |

This means we don't have to rely on PATH lookup at all on the Goose
side. We pin the absolute path of the discovered binary into the child
env. PATH augmentation is still needed for codex's shebang `node`
resolution, but the *primary* binary discovery is contract-typed via
`*_COMMAND`.

This is materially better than 5a §10.3's imagined fix ("user types a
path into a Settings field"). Auto-discovery + env injection = zero
configuration UX.

### 1.4 Discovery: Goose v1.31.0 supports `chatgpt-codex` (Phase 5b earlier than expected)

5a scope §3.1 Anthropic-only authMethods table is incomplete for
OpenAI:

> [strings dump excerpt]
> "OpenAI Codex CLI[Deprecated: use chatgpt_codex or codex-acp instead]
>  Execute OpenAI models via Codex CLI tool. Requires codex CLI installed."

So Goose v1.31.0 ships **two** OpenAI subscription paths:
- `codex` (deprecated, will be removed)
- `chatgpt-codex` (current)
- `codex-acp` (next, requires npm adapter — same caveat as `claude-acp`)

For Phase 5a-finalize we route to `chatgpt-codex` (zero-install, like
how 5a chose `claude-code` over `claude-acp`). User on this machine
already has `~/.nvm/.../codex` installed → ready to go.

This means OpenAI gets cli_subscription support **as part of finalize**,
not Phase 5b-OAuth. The two are independent: Codex CLI is subscription-
based but uses `codex login` (browser flow inside the CLI itself, not
Octopal). 5b-OAuth is about Google's `gemini_oauth` flow, which is a
separate animal.

---

## 2. Scope

In-scope (this branch):
- Augmented binary discovery — generic `discover_binary(name)` that
  scans parent PATH + known install dirs (nvm, asdf, homebrew, local).
- `detect_codex` Tauri command (alongside existing `detect_claude`)
- `*_COMMAND` env injection in `build_goose_env` so Goose subprocess
  uses our discovered absolute paths
- Augmented PATH in child env — codex shebang needs node
- `providers.json`: OpenAI gains `cli_subscription` authMethod
- `resolve_goose_provider`: `(openai, CliSubscription) → chatgpt-codex`
- UI: extract `AnthropicProviderCard`'s 4-state logic into a generic
  component that works for any provider whose authMethods include
  `cli_subscription`
- Tests (unit) + manual verification checklist update

Out-of-scope (deferred to Phase 5b proper):
- Google OAuth (`gemini_oauth`)
- First-run onboarding modal that replaces `ClaudeLoginModal`
- `claude-acp` / `codex-acp` adapter paths (deferred to 5c)
- Manual binary path field in Settings (auto-discovery makes this
  unnecessary for 5a-finalize; if heuristics fail in the wild we can
  add it later)
- AppImage / Linux flatpak / Windows Store specific PATH quirks
  (different LaunchServices analogue per platform — current scope is
  macOS app bundle since that's where the bug manifested)

---

## 3. Design

### 3.1 Augmented binary discovery

New module: `src-tauri/src/commands/binary_discovery.rs`

```rust
/// Search-path candidate set, ordered by priority. Includes the parent
/// PATH plus dirs Octopal knows about even when LaunchServices stripped
/// them (nvm, asdf, homebrew arch-aware, ~/.local/bin, ~/.cargo/bin).
pub fn candidate_search_paths() -> Vec<PathBuf> { ... }

/// Build a PATH env value from candidate dirs, preserving order +
/// deduping. Used both for binary lookup and for child env injection
/// (so codex's shebang `#!/usr/bin/env node` finds node).
pub fn augmented_path_value() -> String { ... }

/// Find a named binary in the candidate search paths. Returns the first
/// hit that's both a regular file and executable. None means absent.
pub fn discover_binary(name: &str) -> Option<PathBuf> { ... }
```

Candidate dirs (in order):
1. Parent PATH (split via `std::env::split_paths`)
2. nvm: glob `~/.nvm/versions/node/*/bin/`, latest version first
   (sorted by mtime — matches `which claude` from a recent shell)
3. asdf: `~/.asdf/shims/`
4. Homebrew arch-aware:
   - arm64: `/opt/homebrew/bin/`, `/opt/homebrew/sbin/`
   - x86_64: `/usr/local/bin/`, `/usr/local/sbin/`
5. `~/.local/bin/`
6. `~/.cargo/bin/`

`name` is whitelisted (lowercase letters, digits, dash, underscore;
length ≤ 64). This rules out path traversal (`../../etc/passwd`) and
keeps the API surface tight.

Tests:
- `discover_binary_finds_in_parent_path` — synthetic dir + PATH guard
- `discover_binary_finds_in_nvm_glob` — synthetic ~/.nvm tree
- `discover_binary_returns_none_when_absent`
- `discover_binary_rejects_invalid_names` — `..`, slashes, oversized
- `augmented_path_value_includes_known_dirs` — string assertion
- `candidate_search_paths_dedups` — same dir in PATH + heuristic

### 3.2 Generic detect_binary

Refactor `detect_claude` →
- Internal: `probe_version(bin)` stays
- Public: `detect_binary(name)` Tauri command — generic, handles claude/codex/etc.
- `detect_claude` becomes a one-line wrapper for back-compat (the
  renderer initially called it directly; we keep the alias to avoid
  churning the older code paths in C-3 verification)

```rust
#[tauri::command]
pub async fn detect_binary(name: String) -> ClaudeDetection {
    // name validation reused from binary_discovery::discover_binary
    let Some(bin) = discover_binary(&name) else {
        return ClaudeDetection::not_found();
    };
    probe_version(&bin).await
}
```

The renderer dispatches based on `providers.json::authMethods[].detectBinary`:

```jsonc
"anthropic": {
  "authMethods": [
    { "id": "api_key", ... },
    { "id": "cli_subscription", "goose_provider": "claude-code", "detectBinary": "claude" }
  ]
}
"openai": {
  "authMethods": [
    { "id": "api_key", ... },
    { "id": "cli_subscription", "goose_provider": "chatgpt-codex", "detectBinary": "codex" }
  ]
}
```

### 3.3 `*_COMMAND` env injection in build_goose_env

`GooseSpawnConfig` gains:

```rust
pub struct GooseSpawnConfig {
    // ... existing fields ...
    /// Absolute path of the CLI-subscription binary, when applicable.
    /// `None` for ApiKey mode. `Some(path)` for CliSubscription —
    /// build_goose_env emits the matching `*_COMMAND` env var so Goose's
    /// subprocess spawn uses the absolute path instead of PATH lookup.
    pub cli_command: Option<PathBuf>,
}
```

`build_goose_env` extension:

```rust
// Phase 5a-finalize: pin discovered binary path into Goose's env.
// Without this, Goose calls into PATH to spawn `claude` / `codex` and
// LaunchServices PATH on macOS won't have nvm/asdf entries.
if let Some(abs_path) = &cfg.cli_command {
    let env_var = match cfg.provider.as_str() {
        "claude-code" => Some("CLAUDE_CODE_COMMAND"),
        "claude-acp" => Some("CLAUDE_CODE_COMMAND"), // claude-acp also spawns claude
        "chatgpt-codex" => Some("CODEX_COMMAND"),
        "gemini-cli" | "gemini-oauth" => Some("GEMINI_CLI_COMMAND"),
        _ => None,
    };
    if let Some(v) = env_var {
        env.insert(v.into(), abs_path.to_string_lossy().into_owned());
    }
}

// Replace the existing `if let Ok(path) = std::env::var("PATH")` block:
env.insert("PATH".into(), augmented_path_value());
```

`run_agent_turn` discovers the binary on the MISS/drift path (alongside
`fill_api_key` for the key path):

```rust
let fill_cli_command = |cfg: &mut GooseSpawnConfig, binary: &str| -> Result<(), String> {
    let abs = discover_binary(binary).ok_or_else(|| format!(
        "Could not find `{binary}` on PATH or known install locations \
         (nvm, asdf, homebrew, ~/.local/bin). Install it or use API key mode."
    ))?;
    cfg.cli_command = Some(abs);
    Ok(())
};

// In MISS / drift branches:
match auth_mode {
    AuthMode::ApiKey => fill_api_key(&mut cfg, &provider)?,
    AuthMode::CliSubscription => {
        let binary = match provider.as_str() {
            "anthropic" => "claude",
            "openai" => "codex",
            other => return Ok(SendResult { ok: false, error: Some(
                format!("CLI subscription not configured for provider \"{other}\"")
            ), ..Default::default() }),
        };
        fill_cli_command(&mut cfg, binary)?;
    }
    AuthMode::None => unreachable!(), // already handled by resolve_goose_provider
}
```

### 3.4 OpenAI Codex routing

`providers.json` (`src-tauri/resources/providers.json`):

```jsonc
"openai": {
  "displayName": "OpenAI",
  "models": ["gpt-5", "gpt-5-mini", "o3", "gpt-5-codex"],
  "authMethods": [
    { "id": "api_key", "label": "API Key", "goose_provider": "openai" },
    { "id": "cli_subscription", "label": "ChatGPT subscription (Codex CLI)",
      "goose_provider": "chatgpt-codex", "detectBinary": "codex" }
  ]
}
```

`resolve_goose_provider` extension (in goose_acp.rs):

```rust
("openai", AuthMode::CliSubscription) => Some("chatgpt-codex"),
```

Test matrix gains:
- `("openai", CliSubscription) → Some("chatgpt-codex")`

`provider_api_key_env` already returns None for `chatgpt-codex` — no
change needed.

### 3.5 UI generalization

`AnthropicProviderCard` (479 LOC) gets renamed and refactored to
`ProviderCardWithCli` — a generic 4-state card for any provider whose
authMethods include `cli_subscription`.

State derivation (unchanged from 5a B-fix):

| Card state | hasKey | cliBinaryFound |
|---|---|---|
| `neither` | false | false |
| `api_key_only` | true | false |
| `cli_only` | false | true |
| `detected_both` | true | true |

New props:
- `providerId: string` (was hardcoded "anthropic")
- `cliBinaryName: string` (was hardcoded "claude" — comes from
  authMethods[1].detectBinary)
- `cliMethodLabel: string` (was hardcoded "Claude CLI subscription" —
  comes from authMethods[1].label)
- i18n key namespace shifts to `settings.providers.cliSubscription.*`
  (provider-agnostic copy; provider name interpolates via {{name}})

`ProvidersTab` selection logic:

```tsx
const cliMethod = entry.authMethods.find(m => m.id === 'cli_subscription')
if (cliMethod && cliMethod.detectBinary) {
  return <ProviderCardWithCli
    providerId={pid}
    displayName={entry.displayName}
    cliBinaryName={cliMethod.detectBinary}
    cliMethodLabel={cliMethod.label}
    ...
  />
}
return <ProviderCard ... /> // simple Phase 4 card for api_key-only providers
```

So Anthropic and OpenAI both get the 4-state UI. Google/Ollama/etc.
stay on the simple `ProviderCard` (their authMethods array doesn't
include `cli_subscription`).

### 3.6 i18n

en.json + ko.json get a new namespace `settings.providers.cliSubscription`:

```jsonc
"cliSubscription": {
  "panelTitle": "Use your {{providerName}} subscription",
  "panelDesc": "{{cliName}} CLI is installed and authenticated. Octopal can route through it instead of an API key.",
  "activate": "Activate",
  "useApiKeyInstead": "Or use an API key instead",
  "ambiguousFound": "We found `{{cliName}}` at `{{path}}` but couldn't verify it's authenticated. Run `{{cliName}}` in a terminal to sign in, then retry.",
  "notFound": "{{cliName}} CLI not detected. Install it or paste an API key.",
  "installLink": "Install {{cliName}} CLI",
  // ... etc
}
```

Provider-specific copy (install URLs, etc.) lives in
`providers.json` itself (`installUrl: "https://..."`) so the i18n
string just renders `{{installLink}}` and the URL comes from manifest.

---

## 4. Commit order

| # | Title | LOC | Sleep-safe |
|---|---|---|---|
| D-1 | binary_discovery module + tests | ~250 | ✓ |
| D-2 | detect_binary generic command + detect_claude alias | ~80 | ✓ |
| D-3 | build_goose_env: cli_command field + *_COMMAND injection + augmented PATH | ~180 (incl. test churn) | ✓ |
| D-4 | providers.json + resolver: OpenAI cli_subscription | ~40 | ✓ |
| D-5 | UI: AnthropicProviderCard → ProviderCardWithCli generic | ~150 | depends — UI changes need visual verification |
| D-6 | docs: phase-5a-c3-manual-verification.md update for nvm scenario + OpenAI flow | ~80 | ✓ |

D-1 through D-4 are pure-logic / Rust-only and unit-testable. D-5 is
TSX/CSS — the test layer is React Testing Library if we add it, or Gil
verifies in dev mode. D-6 is documentation.

If sleep-mode cycle: D-1 → D-2 → D-3 → D-4 → D-6 (skip D-5) overnight,
Gil reviews + does D-5 in person next morning. UI-only changes are the
right place to draw the awake/asleep line.

---

## 5. Merge gates

- **G1-finalize** — Settings → Providers → Anthropic card on a
  Finder-launched (not dev-mode) Octopal: detect_claude finds
  `~/.nvm/.../claude.exe` → renders `cli_only` or `detected_both` →
  Activate → message → response streams. stderr shows
  `[binary_discovery] discovered claude at /Users/.../claude.exe`.

- **G2-finalize** — Same flow for OpenAI card. detect_codex finds
  `~/.nvm/.../codex` → activate → message via Goose's `chatgpt-codex`
  provider → response streams.

- **G3-finalize** — `cargo test --lib` ≥ 117 + new (target ~135). All
  new binary_discovery tests pass under `env -i PATH=/usr/bin:/bin`
  (simulating LaunchServices) — can't unset PATH globally without
  trashing other tests, so use synthetic temp dirs.

- **G4-finalize** — Negative path: rename `~/.nvm/.../claude.exe`
  temporarily → reload Settings tab → Anthropic card flips to
  `neither`. Restore → flips back. Tests detection re-runs on every
  card mount as expected.

- **G5-finalize** — Test Connection still zero-token (G5-5a invariant
  preserved). Network monitor shows no traffic to api.anthropic.com or
  api.openai.com during Test Connection clicks for both providers.

---

## 6. Risks

### 6.1 nvm version selection

`~/.nvm/versions/node/*/bin/` may have multiple Node versions. Picking
the wrong one means an outdated `claude` install. Strategy: sort by
mtime descending (latest installed wins). Pinned install would surface
in the absolute path used; if Gil ran `nvm install lts/iron` recently
the latest mtime should match the active version.

If this turns out to be wrong in practice, fallback options:
- Read `~/.nvmrc` if present
- Use `~/.nvm/alias/default`
- Defer to a configurable Settings field (Phase 5b)

### 6.2 codex.js needs node — what if user's only node is via nvm?

Augmented PATH must include nvm node bin. The candidate dirs cover
this. Verified with `env -i PATH=/usr/bin:/bin:<nvm_bin> /Users/.../codex`
(empirically pending in D-3 test).

### 6.3 augmented_path_value() length

Concatenating ~10 dirs may exceed some env-size limits (notably Windows
`SetEnvironmentVariable` 32K cap). On macOS no practical limit. Cap at
4096 bytes with truncation warning if approached. Not expected to
trigger in real-world setups.

### 6.4 Conflict with existing 5a tests

C-1's `env_builder_preserves_parent_path` asserts `env["PATH"] ==
parent_path`. After D-3 the assertion changes to "PATH includes
known-install dirs". Update the test; don't delete the invariant.

### 6.5 OpenAI Codex CLI auth state

Like claude, codex stores its auth in its own state dir (probably
`~/.codex/`). `detect_codex` only verifies the binary runs; the first
real message exercises auth end-to-end. If `codex` isn't logged in,
Goose's stream will surface the error — same behavior as the claude
path. 5a §10.2 caveat extends to codex.

---

## 7. Resume-tomorrow checklist

If this gets interrupted between commits:

1. Read git log on `feature/phase-5a-cli-subscription` — top commit
   tells you where to resume (D-1 / D-2 / etc.).
2. `cargo test --lib` — must be passing before continuing.
3. The commit message of the *last completed* commit lists what's
   already done; the next D-X heading in this file lists what's next.

If a commit gets stuck (e.g. nvm glob fails for some reason):
- Write `docs/phase-5a-finalize-blocker.md` with the situation
- Park the branch; do NOT rebase or amend
- Resume in person

---

## 8. Open questions

(populate as we hit them during implementation; resolve before merge)

- [ ] Should `discover_binary` follow symlinks before checking
      executability? (`claude.exe` is a symlink → ../lib/.../claude.exe;
      `is_file()` follows symlinks by default — verify on macOS)
- [ ] Does Goose `chatgpt-codex` provider need any other env beyond
      `CODEX_COMMAND`? (codex's own `CODEX_REASONING_EFFORT` etc. are
      user-tunable, not auth)
- [ ] `gpt-5-codex` — does the user's Codex CLI subscription give
      access to this model, or is it part of the API tier? Verify
      empirically before adding to `providers.json` defaults.
