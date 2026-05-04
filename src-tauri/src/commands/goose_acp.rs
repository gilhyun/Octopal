//! Goose ACP sidecar client — path resolution + JSON-RPC 2.0 + spawn orchestration.
//!
//! Phase 2 stages:
//!   stage 1 ✅ `check_goose_sidecar` (version probe, path resolution rules)
//!   stage 2 ✅ `acp_smoke_test`      (spawn → initialize → session/new → prompt)
//!   stage 3 ✅ AcpClient struct, env injection, permission→mode mapping,
//!              2-call spawn sequence (`session/new` + `session/set_mode`)
//!   stage 4+   streaming adapter, permission resolver, pool hookup
//!
//! Path resolution rules:
//!   - Production & default dev: use `app.shell().sidecar("goose")` ONLY.
//!     The bundled binary at `src-tauri/binaries/goose-<triple>[.exe]` is
//!     the single source of truth. Never call `Command::new("goose")`
//!     because PATH lookup could pick up a user's globally-installed Goose
//!     and cause config/data directory collisions (ADR §2.1, §3.1).
//!   - Dev-mode PATH fallback: opt-in via `OCTOPAL_GOOSE_DEV_FALLBACK=1`
//!     AND only compiles into debug builds (`#[cfg(debug_assertions)]`).
//!
//! Why this module looks the way it does:
//!   - `session/cancel` does NOT exist in Goose v1.31.0 (ADR §6.7). Cancellation
//!     is a process-level SIGTERM → 3s grace → SIGKILL, not a JSON-RPC call.
//!   - `session/new` does NOT accept a `mode` param (ADR §6.9), so lock-mode
//!     agents need a second `session/set_mode` call after `session/new`.
//!   - Method names are snake_case (`session/set_mode`, not `setMode`).

use crate::commands::goose_acp_mapper::{
    translate_notification, translate_permission_request, MappedEvent, PermissionRequest,
};
use crate::state::OctoPermissions;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::{mpsc, oneshot, Mutex};

// ── check_goose_sidecar ────────────────────────────────────────────────

#[derive(Serialize)]
pub struct GooseSidecarCheck {
    pub found: bool,
    pub version: String,
    pub path: String,
}

#[tauri::command]
pub async fn check_goose_sidecar(app: AppHandle) -> Result<Value, String> {
    let sidecar = match app.shell().sidecar("goose") {
        Ok(cmd) => cmd,
        Err(err) => {
            #[cfg(debug_assertions)]
            {
                if std::env::var("OCTOPAL_GOOSE_DEV_FALLBACK").ok().as_deref() == Some("1") {
                    return dev_fallback_check().await;
                }
            }
            return Ok(serde_json::to_value(GooseSidecarCheck {
                found: false,
                version: String::new(),
                path: format!("sidecar resolve failed: {err}"),
            })
            .unwrap());
        }
    };

    let output = sidecar
        .args(["--version"])
        .output()
        .await
        .map_err(|e| format!("goose --version spawn failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Ok(serde_json::to_value(GooseSidecarCheck {
            found: false,
            version: String::new(),
            path: format!("exit status non-zero: {stderr}"),
        })
        .unwrap());
    }

    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(serde_json::to_value(GooseSidecarCheck {
        found: true,
        version,
        path: "bundled".to_string(),
    })
    .unwrap())
}

#[cfg(debug_assertions)]
async fn dev_fallback_check() -> Result<Value, String> {
    use std::process::Command;
    let which = if cfg!(windows) { "where" } else { "which" };
    let resolved = Command::new(which)
        .arg("goose")
        .output()
        .map_err(|e| format!("PATH probe failed: {e}"))?;
    if !resolved.status.success() {
        return Ok(serde_json::to_value(GooseSidecarCheck {
            found: false,
            version: String::new(),
            path: "dev-fallback: goose not on PATH".to_string(),
        })
        .unwrap());
    }
    let path = String::from_utf8_lossy(&resolved.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    let version_out = Command::new(&path)
        .arg("--version")
        .output()
        .map_err(|e| format!("dev goose --version failed: {e}"))?;
    let version = String::from_utf8_lossy(&version_out.stdout).trim().to_string();
    Ok(serde_json::to_value(GooseSidecarCheck {
        found: version_out.status.success(),
        version,
        path: format!("dev-fallback:{path}"),
    })
    .unwrap())
}

// ── Env injection (stage 3) ────────────────────────────────────────────

/// The env var name Goose reads for a given provider's API key.
///
/// Values based on Goose's own provider modules (see `goose --help` provider
/// list + source). Returns `None` for providers that don't take a key
/// (Ollama = host URL only, `claude-code` / `claude-acp` / `gemini-cli` /
/// `codex` = piggyback on the user's CLI subscription, no key
/// plumbed through env).
///
/// Phase 5a (scope §6.2): `claude-code` is the routing target for
/// `AuthMode::CliSubscription` on Anthropic. `claude-acp` is listed here
/// for Phase 5c forward-compat — also subprocess-piggybacks, so no env var.
fn provider_api_key_env(goose_provider: &str) -> Option<&'static str> {
    match goose_provider {
        "anthropic" => Some("ANTHROPIC_API_KEY"),
        "openai" => Some("OPENAI_API_KEY"),
        "google" => Some("GOOGLE_API_KEY"),
        "databricks" => Some("DATABRICKS_TOKEN"),
        // CLI-subscription providers + Ollama: no API key env
        "claude-code" | "claude-acp" | "gemini-cli" | "gemini-oauth" | "codex"
        | "ollama" => None,
        // Unknown provider: don't guess. Caller falls back to no key injection
        // and the agent will surface the provider's own "missing credentials"
        // error in the stream.
        _ => None,
    }
}

/// Map an Octopal (UI provider, auth mode) pair to the Goose-facing provider
/// id. Pure function — the entire point is to keep routing decisions
/// testable without spawning a sidecar.
///
/// Phase 5a scope:
/// - `(anthropic, ApiKey)` → `anthropic` (unchanged Phase 4 path)
/// - `(anthropic, CliSubscription)` → `claude-acp` (npm adapter, OAuth-aware;
///   replaces deprecated `claude-code` post-2026-05-02 fix)
/// - Other `(p, ApiKey)` pass through (openai/google/databricks/ollama)
/// - `(_, None)` → None — caller surfaces the "not configured" error
/// - `(non-anthropic, CliSubscription)` → None — Phase 5b+ territory
/// - Unknown `(p, ApiKey)` → None — caller surfaces "unsupported provider"
///
/// Distinct from `provider_api_key_env` (which maps goose-id → env-var-name):
/// this one maps UI-id → goose-id. Both are needed because the UI provider
/// is the *identity* the user picks in Settings, while the goose provider is
/// the *implementation* we hand to the sidecar.
pub(crate) fn resolve_goose_provider(
    ui_provider: &str,
    auth_mode: crate::state::AuthMode,
) -> Option<&'static str> {
    use crate::state::AuthMode;
    match (ui_provider, auth_mode) {
        (_, AuthMode::None) => None,
        ("anthropic", AuthMode::ApiKey) => Some("anthropic"),
        // 2026-05-02 third fix (this session): pivot to `claude-acp` for
        // the same reason we pivoted OpenAI to `chatgpt_codex` earlier
        // — Goose's deprecated `claude-code` provider hangs at
        // session/prompt under modern claude CLI 2.x. Goose strings
        // dump literally says: "[Deprecated: use claude-acp instead]
        // Requires claude CLI installed, no MCPs. Use claude-acp for
        // ACP support with extensions."
        //
        // Trade-off: claude-acp requires `npm install -g
        // @zed-industries/claude-agent-acp` (the ACP adapter). README
        // calls this out alongside the codex prerequisite. The
        // `claude` binary itself is still required (the adapter
        // shells out to it) so detectBinary stays as "claude".
        ("anthropic", AuthMode::CliSubscription) => Some("claude-acp"),
        // 2026-05-02 second fix: OpenAI's CliSubscription routes to
        // `chatgpt_codex` (underscore) — Goose's CURRENT OpenAI
        // subscription provider that does OAuth directly against
        // chatgpt.com.
        //
        // Earlier-this-session attempt was the deprecated `codex`
        // provider, which spawns the user's installed codex CLI as a
        // subprocess. That looked attractive (piggyback on the user's
        // existing `codex login` state) but failed at runtime:
        //
        //   gpt agent → codex CLI 0.128.0 spawned with --skip-git-repo-check
        //   → "error: unexpected argument '--skip-git-repo-check' found"
        //   → exit 1
        //
        // Goose v1.31.0's deprecated `codex` provider was written
        // against an older codex CLI version whose flags have since
        // changed. Hence "deprecated" in the strings dump — Goose
        // upstream knew the subprocess approach was brittle and
        // pivoted to `chatgpt_codex` for first-party OAuth.
        //
        // Trade-off accepted: `chatgpt_codex` runs its own OAuth flow
        // against chatgpt.com (separate token store at
        // `<XDG_DATA>/chatgpt_codex/tokens.json`, NOT the user's
        // `~/.codex/auth.json`). First message after activation
        // triggers the OAuth — Goose opens the browser, user
        // authorizes, Goose's localhost callback receives the code,
        // tokens get persisted under our XDG isolation root, then the
        // turn proceeds. Phase 5b's onboarding work will eventually
        // pre-flight this from the OpenAI card's Activate button so
        // it doesn't surprise the user mid-message.
        //
        // What this means for Octopal's plumbing:
        //   - CODEX_COMMAND env (D-3) is no longer relevant for OpenAI
        //     — chatgpt_codex doesn't shell out. The mapping in
        //     build_goose_env stays for now (it's a no-op when
        //     cli_command is None) but could be removed entirely in
        //     a follow-up cleanup.
        //   - detect_binary("codex") on the OpenAI card still surfaces
        //     a "have you got codex installed?" hint, even though the
        //     binary isn't strictly needed at runtime. Kept for the
        //     UX continuity — users who installed codex CLI for
        //     `codex login` typically expect Octopal to route through
        //     it conceptually.
        ("openai", AuthMode::ApiKey) => Some("openai"),
        ("openai", AuthMode::CliSubscription) => Some("chatgpt_codex"),
        ("google", AuthMode::ApiKey) => Some("google"),
        ("databricks", AuthMode::ApiKey) => Some("databricks"),
        ("ollama", AuthMode::ApiKey) => Some("ollama"),
        _ => None,
    }
}

/// Goose data isolation root: `<app_data>/octopal/goose-{config,data,state}`.
///
/// Takes a pre-resolved app_data root rather than calling Tauri APIs so it's
/// easy to test in isolation. Caller is responsible for passing the correct
/// directory (usually `app.path().app_data_dir()?` joined with "octopal").
pub struct GooseXdgRoots {
    pub config: PathBuf,
    pub data: PathBuf,
    pub state: PathBuf,
}

impl GooseXdgRoots {
    pub fn under(app_data: &Path) -> Self {
        Self {
            config: app_data.join("goose-config"),
            data: app_data.join("goose-data"),
            state: app_data.join("goose-state"),
        }
    }

    /// Create the 3 directories if missing. Idempotent.
    pub fn ensure(&self) -> Result<(), String> {
        for p in [&self.config, &self.data, &self.state] {
            std::fs::create_dir_all(p)
                .map_err(|e| format!("mkdir {}: {e}", p.display()))?;
        }
        Ok(())
    }
}

/// Per-spawn config. Owned by `spawn_agent`; does not persist.
pub struct GooseSpawnConfig {
    /// The goose-facing provider id (e.g. "anthropic", "claude-code", "ollama").
    /// This is the `goose_provider` from providers.json, not the UI-facing
    /// provider name.
    pub provider: String,
    /// Model ID in Anthropic-native form (dash, e.g. "claude-opus-4-7",
    /// "claude-sonnet-4-6", "claude-haiku-4-5-20251001"). **Do not** use
    /// Goose's dot-alias display form ("claude-sonnet-4.6") here — Goose
    /// v1.31.0 forwards verbatim to the provider API and gets a 404
    /// (ADR §6.8). **Goose's ACP catalog may be stale** (e.g. v1.31.0
    /// doesn't advertise Opus 4.7 but still accepts it) — do not validate
    /// against the catalog (ADR §6.8a).
    pub model: String,
    /// API key for providers that take one. None for CLI-subscription and
    /// Ollama. Keyring lookup happens before spawn; this struct just carries
    /// the resolved value.
    pub api_key: Option<String>,
    /// Ollama host URL, only meaningful when provider == "ollama".
    pub ollama_host: Option<String>,
    /// XDG isolation roots (ADR §D4).
    pub xdg: GooseXdgRoots,
    /// Per-agent permission toggles — drive the 2-layer mode mapping.
    pub permissions: Option<OctoPermissions>,
    /// The cwd the agent sees via ACP. Usually the workspace folder.
    pub cwd: PathBuf,
    /// Phase 5a-finalize §3.3: absolute path of the CLI-subscription
    /// binary, when applicable. Pinned into the child env via the
    /// matching `*_COMMAND` variable so Goose's subprocess spawn uses
    /// the discovered path instead of falling back to PATH lookup.
    ///
    /// - `None` for `AuthMode::ApiKey` and Ollama (those don't spawn
    ///   a subprocess CLI).
    /// - `Some(path)` for `AuthMode::CliSubscription` — populated by
    ///   `run_agent_turn` via [`crate::commands::binary_discovery::discover_binary`]
    ///   on the spawn (MISS / drift) path. HIT path doesn't need it
    ///   because the existing sidecar already has it baked into its env.
    pub cli_command: Option<PathBuf>,
}

/// Build the env map passed to `goose acp`. Pure function — no I/O.
///
/// Caller is responsible for `xdg.ensure()` before spawn (otherwise Goose
/// will fail to write its sqlite session store).
pub fn build_goose_env(cfg: &GooseSpawnConfig) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = HashMap::new();

    // XDG isolation — the entire reason Octopal can coexist with a globally
    // installed `goose` without touching the user's own config.
    env.insert(
        "XDG_CONFIG_HOME".into(),
        cfg.xdg.config.to_string_lossy().into_owned(),
    );
    env.insert(
        "XDG_DATA_HOME".into(),
        cfg.xdg.data.to_string_lossy().into_owned(),
    );
    env.insert(
        "XDG_STATE_HOME".into(),
        cfg.xdg.state.to_string_lossy().into_owned(),
    );

    // Provider + model selection. Goose reads these at ACP startup to pick
    // the provider module and default model.
    env.insert("GOOSE_PROVIDER".into(), cfg.provider.clone());
    env.insert("GOOSE_MODEL".into(), cfg.model.clone());

    // Provider-specific credentials.
    if let (Some(name), Some(key)) =
        (provider_api_key_env(&cfg.provider), cfg.api_key.as_deref())
    {
        env.insert(name.into(), key.to_string());
    }

    // Ollama-only host override.
    if cfg.provider == "ollama" {
        if let Some(host) = cfg.ollama_host.as_deref() {
            env.insert("OLLAMA_HOST".into(), host.to_string());
        }
    }

    // Phase 5a-finalize §3.3: pin the CLI-subscription binary's absolute
    // path into Goose's env via the matching `*_COMMAND` override.
    // Goose reads these and skips PATH lookup, which is what we want on
    // macOS app-bundle launches where LaunchServices stripped nvm dirs
    // (5a §10.3 / 5a-finalize §1.1).
    //
    // Provider → env var mapping (verified empirically against Goose
    // v1.31.0 strings dump 2026-05-02):
    //
    //   claude-code  → CLAUDE_CODE_COMMAND  (deprecated, kept for forward-compat)
    //   codex        → CODEX_COMMAND        (deprecated, similar story)
    //   gemini-cli   → GEMINI_CLI_COMMAND
    //   gemini-oauth → GEMINI_CLI_COMMAND
    //
    // **NOT included on purpose:**
    //   claude-acp     — spawns `claude-agent-acp` (npm adapter); strings
    //                    dump shows no CLAUDE_AGENT_ACP_COMMAND override.
    //                    Adapter resolves via PATH only — augmented PATH
    //                    below covers it.
    //   chatgpt_codex  — does its own OAuth, doesn't shell out.
    //
    // For the not-included providers, `cli_command` either stays None
    // (no detect) or carries the discovered path that simply isn't
    // honored; either way this block is a no-op for them.
    if let Some(abs_path) = &cfg.cli_command {
        let env_var = match cfg.provider.as_str() {
            "claude-code" => Some("CLAUDE_CODE_COMMAND"),
            "codex" => Some("CODEX_COMMAND"),
            "gemini-cli" | "gemini-oauth" => Some("GEMINI_CLI_COMMAND"),
            _ => None,
        };
        if let Some(v) = env_var {
            env.insert(v.into(), abs_path.to_string_lossy().into_owned());
        }
    }

    // Phase 5a-finalize §3.1: child PATH is the *augmented* candidate-dir
    // value, not just the parent inherited PATH. Two reasons it must
    // include the augmentation:
    //
    // 1. macOS app-bundle launches inherit a minimal LaunchServices PATH
    //    (`/usr/bin:/bin:/usr/sbin:/sbin`). Goose providers that fall
    //    back to PATH lookup despite our `*_COMMAND` override (or future
    //    providers we don't have an override for yet) would fail to find
    //    nvm/asdf/homebrew binaries.
    //
    // 2. Even when our `*_COMMAND` pin works, shebang scripts re-resolve
    //    their interpreter via PATH at exec time. Codex CLI's
    //    `#!/usr/bin/env node` will fail with "env: node: No such file
    //    or directory" if PATH doesn't have a node binary — which under
    //    LaunchServices it won't, since user's node is typically in
    //    nvm or homebrew.
    //
    // Replaces the C-1 `std::env::var("PATH")` block which only forwarded
    // parent PATH (insufficient under LaunchServices). The augmented value
    // includes the parent PATH at the front (preserving its order) plus
    // the heuristic fallbacks.
    env.insert(
        "PATH".into(),
        crate::commands::binary_discovery::augmented_path_value(),
    );

    env
}

// ── Permission → mode mapping (ADR §6.2 2-layer defense) ──────────────

/// Map Octopal's per-agent permission toggles to an ACP session mode id.
///
/// The rule is deliberately coarse: only full-lockdown agents get `chat`
/// mode. Everything else goes through `auto` + the fine-grained permission
/// resolver (stage 7). `approve`/`smart_approve` modes are not used —
/// they're for interactive human-in-the-loop, which doesn't match Octopal's
/// agent-as-delegate model.
pub fn permissions_to_mode_id(perms: Option<&OctoPermissions>) -> &'static str {
    let Some(p) = perms else { return "auto" };
    let file_write = p.file_write.unwrap_or(true);
    let bash = p.bash.unwrap_or(true);
    let network = p.network.unwrap_or(true);
    if !file_write && !bash && !network {
        "chat"
    } else {
        "auto"
    }
}

// ── AcpClient (JSON-RPC 2.0 over stdio) ───────────────────────────────

type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

/// Reusable ACP client. Wraps a spawned `goose acp` sidecar and exposes
/// request/response + session lifecycle helpers. Notifications (no `id`)
/// land on the event log, which future streaming code (stage 4) will
/// consume to emit per-session Tauri events.
///
/// Lifecycle:
///   1. `AcpClient::spawn(app, env)` — start the sidecar + reader task.
///   2. `.initialize()` — capability handshake (fills `capabilities`).
///   3. `.new_session(cwd, mcp_servers)` — session/new, returns sessionId.
///   4. `.set_mode(session_id, mode_id)` — session/set_mode if locking down.
///   5. (later) `.prompt(session_id, text)` — will be added in stage 4.
///   6. `.shutdown()` — SIGTERM → 3s grace → SIGKILL.
///
/// Kept as one struct per agent process (matches process_pool.rs's
/// per-agent config-hash keying; stage 6 will wire it in).
/// Emitted by the reader task when a permission request arrives. Includes
/// the raw JSON-RPC `id` so the caller can respond via `respond_raw`.
#[derive(Debug, Clone)]
pub struct IncomingPermissionRequest {
    pub request_id: u64,
    pub payload: PermissionRequest,
}

/// What the reader pushes onto the per-client stream channel.
/// `MappedEvent` covers the bulk (tool calls, text chunks, activity
/// labels); `Permission` is separate because it needs a JSON-RPC response,
/// not a fire-and-forget emit.
#[derive(Debug, Clone)]
pub enum StreamItem {
    Mapped(MappedEvent),
    Permission(IncomingPermissionRequest),
    /// Reader lost the goose process. After this the channel closes.
    Terminated { code: Option<i32> },
}

pub struct AcpClient {
    child: Mutex<CommandChild>,
    pending: PendingMap,
    next_id: AtomicU64,
    /// Raw session/update + session/request_permission JSON values. Kept
    /// for the smoke test and ad-hoc debugging. The primary streaming
    /// path for callers is `take_stream()` below.
    events: Arc<Mutex<Vec<Value>>>,
    /// Translated stream. Populated only if `take_stream()` was called
    /// *before* spawn returned — once taken, the sender lives inside the
    /// reader task and drops when the process exits. `None` means nobody
    /// claimed the stream, so translations are silently discarded (only
    /// the raw `events` vec fills up).
    stream_rx: Mutex<Option<mpsc::UnboundedReceiver<StreamItem>>>,
    /// stderr is tee'd here for post-mortem logs. Stage 9 will also mirror
    /// to `~/.octopal/logs/goose-*.log`.
    stderr_tail: Arc<Mutex<Vec<String>>>,
    /// Filled by `initialize()`. None until then.
    pub capabilities: Option<Value>,
}

impl AcpClient {
    /// Spawn `goose acp` with the given env. Starts a background reader
    /// task that demultiplexes stdout into responses vs notifications.
    pub async fn spawn(
        app: &AppHandle,
        env: HashMap<String, String>,
    ) -> Result<Self, String> {
        let cmd = app
            .shell()
            .sidecar("goose")
            .map_err(|e| format!("sidecar resolve: {e}"))?
            .args(["acp"])
            .envs(env);

        let (mut rx, child) = cmd
            .spawn()
            .map_err(|e| format!("goose acp spawn failed: {e}"))?;

        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let events: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let stderr_tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let (stream_tx, stream_rx) = mpsc::unbounded_channel::<StreamItem>();

        let pending_r = pending.clone();
        let events_r = events.clone();
        let stderr_r = stderr_tail.clone();

        // Reader task — runs for the life of the process. It terminates
        // naturally when the sidecar closes stdout (on SIGTERM or
        // graceful exit).
        tokio::spawn(async move {
            let mut buf = String::new();
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => {
                        buf.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(nl) = buf.find('\n') {
                            let line: String = buf.drain(..=nl).collect();
                            let trimmed = line.trim();
                            if trimmed.is_empty() {
                                continue;
                            }
                            let parsed: Value = match serde_json::from_str(trimmed) {
                                Ok(v) => v,
                                Err(_) => {
                                    events_r.lock().await.push(json!({ "__raw": trimmed }));
                                    continue;
                                }
                            };

                            // Classify: response (has id, no method) vs
                            // server-originated request (has id + method,
                            // e.g. session/request_permission) vs plain
                            // notification (has method, no id).
                            let has_id = parsed.get("id").is_some();
                            let method = parsed
                                .get("method")
                                .and_then(|v| v.as_str())
                                .map(str::to_string);

                            if has_id && method.is_none() {
                                // Response to one of our requests.
                                if let Some(id) = parsed.get("id").and_then(|v| v.as_u64()) {
                                    if let Some(tx) = pending_r.lock().await.remove(&id) {
                                        let _ = tx.send(parsed.clone());
                                    }
                                }
                            } else if method.as_deref() == Some("session/request_permission") {
                                // Server request — needs a response. Route
                                // to the stream so the caller can answer.
                                if let (Some(id), Some(payload)) = (
                                    parsed.get("id").and_then(|v| v.as_u64()),
                                    translate_permission_request(&parsed),
                                ) {
                                    let _ = stream_tx.send(StreamItem::Permission(
                                        IncomingPermissionRequest {
                                            request_id: id,
                                            payload,
                                        },
                                    ));
                                }
                            } else if method.as_deref() == Some("session/update") {
                                // Stream update. Translate + forward each
                                // mapped event individually so downstream
                                // select! loops see fine-grained events.
                                for ev in translate_notification(&parsed) {
                                    let _ = stream_tx.send(StreamItem::Mapped(ev));
                                }
                            }

                            events_r.lock().await.push(parsed);
                        }
                    }
                    CommandEvent::Stderr(bytes) => {
                        stderr_r
                            .lock()
                            .await
                            .push(String::from_utf8_lossy(&bytes).into_owned());
                    }
                    CommandEvent::Error(err) => {
                        stderr_r.lock().await.push(format!("<error> {err}"));
                    }
                    CommandEvent::Terminated(p) => {
                        stderr_r
                            .lock()
                            .await
                            .push(format!("<terminated> code={:?}", p.code));
                        let _ = stream_tx.send(StreamItem::Terminated { code: p.code });
                        break;
                    }
                    _ => {}
                }
            }
            // Reader exits → stream_tx drops → receiver sees `None`.
        });

        Ok(Self {
            child: Mutex::new(child),
            pending,
            next_id: AtomicU64::new(1),
            events,
            stream_rx: Mutex::new(Some(stream_rx)),
            stderr_tail,
            capabilities: None,
        })
    }

    /// Take the translated-stream receiver. Returns `None` on second call.
    /// Only one consumer is supported per client.
    pub async fn take_stream(&self) -> Option<mpsc::UnboundedReceiver<StreamItem>> {
        self.stream_rx.lock().await.take()
    }

    /// Return the translated-stream receiver to the client so a future
    /// turn can `take_stream()` again. Used by `run_agent_turn` (Stage
    /// 6c) when a pooled client crosses turn boundaries. Legacy one-shot
    /// callers (`acp_smoke_test`, `acp_turn_test`, `spawn_agent` consumers
    /// that immediately shutdown) don't need this.
    pub async fn put_stream(&self, rx: mpsc::UnboundedReceiver<StreamItem>) {
        *self.stream_rx.lock().await = Some(rx);
    }

    /// Send a JSON-RPC 2.0 response for a request received **from** the
    /// agent (as opposed to our own outgoing requests, which use
    /// `request()`). Used primarily for `session/request_permission`
    /// replies where the agent is waiting on us.
    pub async fn respond_raw(&self, id: u64, result: Value) -> Result<(), String> {
        let msg = json!({ "jsonrpc": "2.0", "id": id, "result": result });
        let mut wire = serde_json::to_vec(&msg).map_err(|e| format!("serialize: {e}"))?;
        wire.push(b'\n');
        self.child
            .lock()
            .await
            .write(&wire)
            .map_err(|e| format!("respond_raw write: {e}"))
    }

    /// Send a JSON-RPC 2.0 request and await its response by id.
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let mut wire = serde_json::to_vec(&msg).map_err(|e| format!("serialize: {e}"))?;
        wire.push(b'\n');
        self.child
            .lock()
            .await
            .write(&wire)
            .map_err(|e| format!("stdin write ({method}): {e}"))?;

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(_)) => Err(format!("{method}: response channel closed")),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("{method}: timeout after {:?}", timeout))
            }
        }
    }

    /// Capability handshake. Must be called first. Populates `capabilities`.
    pub async fn initialize(&mut self) -> Result<Value, String> {
        let resp = self
            .request(
                "initialize",
                json!({ "protocolVersion": 1, "clientCapabilities": {} }),
                Duration::from_secs(5),
            )
            .await?;
        self.capabilities = resp
            .get("result")
            .and_then(|r| r.get("agentCapabilities"))
            .cloned();
        Ok(resp)
    }

    /// Create a new session. Returns the sessionId string.
    ///
    /// `mcp_servers` is a JSON array; pass `json!([])` for none. Per Phase 0
    /// spike, SSE transport is not supported (`mcpCapabilities.sse: false`),
    /// so callers should filter out SSE entries upstream.
    pub async fn new_session(
        &self,
        cwd: &Path,
        mcp_servers: Value,
    ) -> Result<String, String> {
        let resp = self
            .request(
                "session/new",
                json!({
                    "cwd": cwd.to_string_lossy(),
                    "mcpServers": mcp_servers,
                }),
                Duration::from_secs(5),
            )
            .await?;
        resp.get("result")
            .and_then(|r| r.get("sessionId"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| format!("session/new returned no sessionId: {resp}"))
    }

    /// Change the session mode. `mode_id` must be one of
    /// `auto` | `approve` | `smart_approve` | `chat` (ADR §6.2).
    /// Octopal only uses `auto` and `chat`.
    pub async fn set_mode(&self, session_id: &str, mode_id: &str) -> Result<(), String> {
        let resp = self
            .request(
                "session/set_mode",
                json!({ "sessionId": session_id, "modeId": mode_id }),
                Duration::from_secs(3),
            )
            .await?;
        if resp.get("error").is_some() {
            return Err(format!("session/set_mode error: {resp}"));
        }
        Ok(())
    }

    /// Close a session cleanly. Does NOT cancel in-flight prompts (no
    /// such method exists; see ADR §6.7). For cancellation, use
    /// `shutdown()` which kills the whole process.
    pub async fn close_session(&self, session_id: &str) -> Result<(), String> {
        let _ = self
            .request(
                "session/close",
                json!({ "sessionId": session_id }),
                Duration::from_secs(3),
            )
            .await?;
        Ok(())
    }

    /// Snapshot all events received so far. Stage 4 will replace this
    /// with a streaming channel.
    pub async fn drain_events(&self) -> Vec<Value> {
        let mut g = self.events.lock().await;
        std::mem::take(&mut *g)
    }

    pub async fn stderr_snapshot(&self) -> Vec<String> {
        self.stderr_tail.lock().await.clone()
    }

    /// The underlying sidecar PID. Needed so `stop_agent` (agent.rs) can
    /// route SIGTERM to the goose process via the shared `running_agents`
    /// map (keyed by run_id → pid). Live probe showed SIGTERM→exit = 4ms
    /// across all scenarios (ADR §6.7), so caller's stop-button UX is
    /// effectively instant.
    pub async fn sidecar_pid(&self) -> u32 {
        self.child.lock().await.pid()
    }

    /// SIGTERM → 3s grace → SIGKILL. This is the only cancellation path
    /// (ADR §6.7). Caller is responsible for any caller-side cleanup like
    /// pool entry removal.
    pub async fn shutdown(self) {
        // tauri_plugin_shell's `kill()` sends SIGKILL directly — there is
        // no separate SIGTERM API on CommandChild today. Grace period is
        // effectively 0 in the process-crate sense, but Goose will still
        // flush stdout buffers before the kernel reaps it.
        //
        // If future tauri-plugin-shell adds a graceful shutdown API, this
        // is the single place to swap it in.
        let child = self.child.into_inner();
        let _ = child.kill();
    }
}

// ── Turn dispatch (stage 5) ────────────────────────────────────────────

/// What a turn yields while in flight. Caller's callback receives these
/// in order as Goose streams — one `AssistantTextChunk` per chunk, one
/// `Activity` hint per chunk (dedup is caller's job via run_id), one
/// `Permission` per agent-initiated tool request.
#[derive(Debug, Clone)]
pub enum TurnEvent {
    Mapped(MappedEvent),
    Permission(IncomingPermissionRequest),
}

/// Outcome of one `session/prompt` call. `stop_reason` mirrors the ACP
/// response field (`end_turn`, `max_tokens`, `refusal`, …). Goose v1.31.0
/// does NOT include `usage` or `modelUsage` in the response (ADR §6.5) —
/// if tokens/cost matter, the caller has to estimate them elsewhere.
#[derive(Debug, Clone)]
pub struct TurnResult {
    pub stop_reason: String,
}

/// Fire `session/prompt` and drain the stream until the prompt resolves.
///
/// The select loop is **biased toward the stream** so callers see UI
/// updates before the final response — matters for "Writing response…"
/// label + last char sequencing.
///
/// # Cancellation
/// There is no JSON-RPC cancel (ADR §6.7). If the caller wants to abort
/// a turn, they must drop this future AND call `AcpClient::shutdown()`
/// to SIGKILL the sidecar. Dropping the future alone leaves Goose still
/// generating tokens the sidecar will happily try to stream back.
pub async fn run_turn<F>(
    client: &AcpClient,
    stream: &mut mpsc::UnboundedReceiver<StreamItem>,
    session_id: &str,
    prompt_text: &str,
    timeout: Duration,
    mut on_event: F,
) -> Result<TurnResult, String>
where
    F: FnMut(TurnEvent),
{
    let prompt_fut = client.request(
        "session/prompt",
        json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": prompt_text }],
        }),
        timeout,
    );
    tokio::pin!(prompt_fut);
    loop {
        tokio::select! {
            biased;
            item = stream.recv() => {
                match item {
                    Some(StreamItem::Mapped(ev)) => on_event(TurnEvent::Mapped(ev)),
                    Some(StreamItem::Permission(req)) => {
                        on_event(TurnEvent::Permission(req));
                    }
                    Some(StreamItem::Terminated { code }) => {
                        return Err(format!(
                            "sidecar terminated mid-prompt (code={:?})",
                            code
                        ));
                    }
                    None => {
                        return Err("stream channel closed unexpectedly".into());
                    }
                }
            }
            resp = &mut prompt_fut => {
                let resp = resp?;
                if let Some(err) = resp.get("error") {
                    return Err(format!("session/prompt error: {err}"));
                }
                let stop_reason = resp
                    .get("result")
                    .and_then(|r| r.get("stopReason"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                return Ok(TurnResult { stop_reason });
            }
        }
    }
}

// ── Full spawn orchestrator ────────────────────────────────────────────

/// Cold-miss half of `spawn_agent`: spawn the sidecar and finish the
/// capability handshake, but DO NOT open a session. Used by `GooseAcpPool`
/// so the post-initialize client can live across turns while each turn
/// still gets a fresh `session/new` (ADR §6.7 / scope §2.2 — per-turn
/// session, cached client).
pub async fn spawn_initialized(
    app: &AppHandle,
    cfg: &GooseSpawnConfig,
) -> Result<AcpClient, String> {
    cfg.xdg.ensure()?;
    let env = build_goose_env(cfg);
    let mut client = AcpClient::spawn(app, env).await?;
    client.initialize().await?;
    Ok(client)
}

/// Per-turn half: open a session on an already-initialized client and
/// apply the permission → mode lock. Returns just the session id — the
/// caller owns the client.
pub async fn open_turn_session(
    client: &AcpClient,
    cfg: &GooseSpawnConfig,
) -> Result<String, String> {
    let session_id = client.new_session(&cfg.cwd, json!([])).await?;
    let mode_id = permissions_to_mode_id(cfg.permissions.as_ref());
    if mode_id != "auto" {
        client.set_mode(&session_id, mode_id).await?;
    }
    Ok(session_id)
}

/// Spawn `goose acp`, handshake, open a session, and lock its mode to
/// match the agent's permission toggles. On success, the returned client
/// has `capabilities` populated and a live session ready for prompts
/// (stage 4).
///
/// This does NOT call `session/prompt` — prompt dispatch is the next
/// stage's responsibility.
///
/// Preserved for legacy callers (`acp_smoke_test`, `acp_turn_test`) that
/// do a single spawn-then-throw-away flow. The pool path uses
/// `spawn_initialized` + `open_turn_session` instead so the client can be
/// reused across turns.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub async fn spawn_agent(
    app: &AppHandle,
    cfg: GooseSpawnConfig,
) -> Result<(AcpClient, String), String> {
    let client = spawn_initialized(app, &cfg).await?;
    let session_id = open_turn_session(&client, &cfg).await?;
    Ok((client, session_id))
}

// ── acp_smoke_test (refactored to use AcpClient) ──────────────────────

#[derive(Serialize, Default)]
pub struct AcpSmokeResult {
    pub initialize_response: Option<Value>,
    pub capabilities: Option<Value>,
    pub session_new_response: Option<Value>,
    pub session_id: Option<String>,
    pub set_mode_mode: Option<String>,
    pub set_mode_response: Option<Value>,
    pub events: Vec<Value>,
    pub stderr_tail: Vec<String>,
    pub errors: Vec<String>,
    pub elapsed_ms: u64,
}

/// Smoke test via the real AcpClient pipeline. No API key injected
/// (protocol probe only). Used as the debug entry point for stage 3
/// until stage 4's Tauri event streaming lands.
#[tauri::command]
pub async fn acp_smoke_test(app: AppHandle) -> Result<Value, String> {
    let start = Instant::now();
    let mut result = AcpSmokeResult::default();

    // XDG sandbox in the OS temp dir so dev runs don't clobber the real
    // Octopal app-data location.
    let sandbox = std::env::temp_dir().join(format!(
        "octopal-acp-smoke-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let xdg = GooseXdgRoots::under(&sandbox);
    if let Err(e) = xdg.ensure() {
        result.errors.push(e);
        result.elapsed_ms = start.elapsed().as_millis() as u64;
        return Ok(serde_json::to_value(result).unwrap());
    }

    // Use `anthropic` + dummy model so the initialize/session flow is
    // exercised without hitting any provider. Prompt is intentionally not
    // sent here — a prompt would need a real API key.
    let cfg = GooseSpawnConfig {
        provider: "anthropic".into(),
        model: "claude-sonnet-4-6".into(),
        api_key: None,
        ollama_host: None,
        xdg,
        permissions: None,
        cwd: sandbox.clone(),
        cli_command: None,
    };

    let env = build_goose_env(&cfg);
    let mut client = match AcpClient::spawn(&app, env).await {
        Ok(c) => c,
        Err(e) => {
            result.errors.push(format!("spawn: {e}"));
            result.elapsed_ms = start.elapsed().as_millis() as u64;
            return Ok(serde_json::to_value(result).unwrap());
        }
    };

    match client.initialize().await {
        Ok(resp) => {
            result.initialize_response = Some(resp);
            result.capabilities = client.capabilities.clone();
        }
        Err(e) => {
            result.errors.push(format!("initialize: {e}"));
            finalize(&mut result, client, start).await;
            return Ok(serde_json::to_value(result).unwrap());
        }
    }

    match client.new_session(&cfg.cwd, json!([])).await {
        Ok(sid) => {
            result.session_new_response = Some(json!({ "sessionId": sid }));
            result.session_id = Some(sid);
        }
        Err(e) => {
            result.errors.push(format!("session/new: {e}"));
            finalize(&mut result, client, start).await;
            return Ok(serde_json::to_value(result).unwrap());
        }
    }

    // Exercise the 2-call sequence — demonstrates set_mode wiring end-to-end.
    let mode = permissions_to_mode_id(cfg.permissions.as_ref());
    result.set_mode_mode = Some(mode.to_string());
    if mode != "auto" {
        if let Some(sid) = result.session_id.clone() {
            match client.set_mode(&sid, mode).await {
                Ok(()) => result.set_mode_response = Some(json!({ "ok": true })),
                Err(e) => result.errors.push(format!("session/set_mode: {e}")),
            }
        }
    }

    finalize(&mut result, client, start).await;
    Ok(serde_json::to_value(result).unwrap())
}

async fn finalize(result: &mut AcpSmokeResult, client: AcpClient, start: Instant) {
    result.events = client.drain_events().await;
    result.stderr_tail = client.stderr_snapshot().await;
    client.shutdown().await;
    result.elapsed_ms = start.elapsed().as_millis() as u64;
}

// ── acp_turn_test (stage 5 live pipeline proof, DEBUG-ONLY) ────────────

#[cfg(debug_assertions)]
#[derive(Serialize, Default)]
pub struct AcpTurnTestResult {
    pub session_id: Option<String>,
    /// Concatenated `AssistantTextChunk` text — what the user would see.
    pub text: String,
    pub activity_labels: Vec<String>,
    pub activity_log: Vec<Value>,
    pub thought_chunks: Vec<String>,
    pub tool_calls: u64,
    pub permission_requests: u64,
    pub stop_reason: Option<String>,
    pub elapsed_ms: u64,
    pub errors: Vec<String>,
}

/// **DEBUG-ONLY** test command. Gated behind `#[cfg(debug_assertions)]` —
/// never reaches release builds. Production code path for key reads is
/// `api_keys::load_api_key()` called from `run_agent_turn` (MISS branch).
/// Removal tracked under Phase 7 cleanup (reactive-floating-feather.md
/// §Phase 7 "Dead-code sweep").
///
/// Key resolution order in this command:
///   1. `api_keys::load_api_key("anthropic")` — try keyring first
///   2. fall back to `ANTHROPIC_API_KEY` env var
///
/// Live end-to-end pipeline: spawn → initialize → new_session →
/// session/prompt → stream consume → shutdown. This is the stage-5
/// manual verification entry point — it exercises sidecar resolution
/// (stage 1), JSON-RPC client (stage 2), env isolation + mode lock
/// (stage 3), event mapper + mpsc channel (stage 4), run_turn state
/// machine (stage 5).
///
/// Not intended for production — `run_agent_turn` (Stage 6a+) is the
/// real consumer, via the `use_legacy_claude_cli` flag branch.
#[cfg(debug_assertions)]
#[tauri::command]
pub async fn acp_turn_test(app: AppHandle, prompt: String) -> Result<Value, String> {
    let start = Instant::now();
    let mut result = AcpTurnTestResult::default();

    // Try keyring first (preferred). In debug, fall back to env so local
    // dev without Settings setup still works. Release builds don't have
    // this command compiled in at all — see #[cfg(debug_assertions)].
    let api_key = match crate::commands::api_keys::load_api_key("anthropic") {
        Ok(Some(k)) => Some(k),
        Ok(None) => std::env::var("ANTHROPIC_API_KEY").ok(),
        Err(e) => {
            eprintln!("[acp_turn_test] keyring read failed: {e}. Falling back to env.");
            std::env::var("ANTHROPIC_API_KEY").ok()
        }
    };
    if api_key.is_none() {
        result
            .errors
            .push("No Anthropic key found (keyring empty, ANTHROPIC_API_KEY env unset)".into());
        result.elapsed_ms = start.elapsed().as_millis() as u64;
        return Ok(serde_json::to_value(result).unwrap());
    }

    let sandbox = std::env::temp_dir().join(format!(
        "octopal-acp-turn-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let xdg = GooseXdgRoots::under(&sandbox);

    let cfg = GooseSpawnConfig {
        provider: "anthropic".into(),
        model: "claude-sonnet-4-6".into(),
        api_key,
        ollama_host: None,
        xdg,
        permissions: None,
        cwd: sandbox.clone(),
        cli_command: None,
    };

    let (client, session_id) = match spawn_agent(&app, cfg).await {
        Ok(pair) => pair,
        Err(e) => {
            result.errors.push(format!("spawn_agent: {e}"));
            result.elapsed_ms = start.elapsed().as_millis() as u64;
            return Ok(serde_json::to_value(result).unwrap());
        }
    };
    result.session_id = Some(session_id.clone());

    let mut stream = match client.take_stream().await {
        Some(s) => s,
        None => {
            result.errors.push("stream already taken".into());
            client.shutdown().await;
            result.elapsed_ms = start.elapsed().as_millis() as u64;
            return Ok(serde_json::to_value(result).unwrap());
        }
    };

    let mut collected_text = String::new();
    let mut activity = Vec::new();
    let mut activity_log = Vec::new();
    let mut thoughts = Vec::new();
    let mut tool_calls: u64 = 0;
    let mut perms: u64 = 0;

    let turn_result = run_turn(
        &client,
        &mut stream,
        &session_id,
        &prompt,
        Duration::from_secs(120),
        |ev| match ev {
            TurnEvent::Mapped(MappedEvent::AssistantTextChunk { text }) => {
                collected_text.push_str(&text);
            }
            TurnEvent::Mapped(MappedEvent::AssistantThoughtChunk { text }) => {
                thoughts.push(text);
            }
            TurnEvent::Mapped(MappedEvent::Activity { text }) => {
                activity.push(text);
            }
            TurnEvent::Mapped(MappedEvent::ActivityLog { tool, target }) => {
                tool_calls += 1;
                activity_log.push(json!({ "tool": tool, "target": target }));
            }
            TurnEvent::Permission(req) => {
                perms += 1;
                activity.push(format!(
                    "permission requested: {} (call={})",
                    req.payload.tool_name, req.payload.tool_call_id
                ));
            }
        },
    )
    .await;

    match turn_result {
        Ok(tr) => result.stop_reason = Some(tr.stop_reason),
        Err(e) => result.errors.push(format!("run_turn: {e}")),
    }

    result.text = collected_text;
    result.activity_labels = activity;
    result.activity_log = activity_log;
    result.thought_chunks = thoughts;
    result.tool_calls = tool_calls;
    result.permission_requests = perms;

    client.shutdown().await;
    result.elapsed_ms = start.elapsed().as_millis() as u64;
    Ok(serde_json::to_value(result).unwrap())
}

// ── run_agent_turn (stage 6a): end-to-end agent turn via ACP ─────────

use crate::commands::agent::SendResult;
use crate::state::ManagedState;
use tauri::{Emitter, State};

/// Parameters `agent.rs::send_message` passes to the goose path.
///
/// `system_prompt` and `contextual_prompt` are pre-built by the caller so
/// all the v0.1.42 prompt-assembly logic (peers, wiki, memory, handoff
/// instructions) is preserved byte-for-byte without duplication here.
///
/// Stage 6a does NOT read anything from `AppSettings` — `model` and
/// `api_key` come from env (OCTOPAL_USE_GOOSE=1 + ANTHROPIC_API_KEY).
/// Stage 6b replaces these with settings + keyring lookup.
pub struct RunAgentTurnParams {
    pub folder_path: String,
    pub octo_path: String,
    pub agent_name: String,
    pub run_id: String,
    pub pending_id: Option<String>,
    /// Full system prompt text (peers + memory + wiki + capabilities).
    pub system_prompt: String,
    /// Raw user prompt — persisted to room-history as the user turn.
    pub user_prompt: String,
    /// User prompt with history_prefix + attachment refs already prepended.
    /// This is what Goose sees on `session/prompt`.
    pub contextual_prompt: String,
    pub user_ts: f64,
    /// Anthropic-native model ID (dash form). Caller resolved aliases
    /// already via `model_probe::resolve_model_for_cli` or equivalent.
    /// Empty string → use GOOSE_MODEL env default.
    pub model: String,
    pub permissions: Option<OctoPermissions>,
}

fn default_model_for_provider(
    provider: &str,
    manifest: &crate::commands::providers_manifest::ProvidersManifest,
) -> Option<String> {
    match provider {
        // Canonical Anthropic API namespace. Claude subscription mode is
        // translated later by model_alias::resolve_for_goose_provider.
        "anthropic" => Some("claude-sonnet-4-6".to_string()),
        "openai" => Some("gpt-5".to_string()),
        "google" => Some("gemini-2.5-pro".to_string()),
        _ => manifest
            .get(provider)
            .and_then(|entry| entry.models.as_slice())
            .and_then(|models| models.first())
            .cloned(),
    }
}

fn choose_raw_model(
    binding: &crate::commands::agent_config::AgentBinding,
    settings_default_provider: &str,
    settings_default_model: &str,
    caller_model: &str,
    manifest: &crate::commands::providers_manifest::ProvidersManifest,
) -> (String, String) {
    let (provider, _) = crate::commands::agent_config::resolve_for_turn(
        binding,
        settings_default_provider,
        settings_default_model,
    );

    if let Some(model) = binding.model.as_deref().filter(|s| !s.is_empty()) {
        return (provider, model.to_string());
    }

    let provider_is_overridden = binding
        .provider
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|p| p != settings_default_provider)
        .unwrap_or(false);

    if provider_is_overridden {
        if let Some(model) = default_model_for_provider(&provider, manifest) {
            return (provider, model);
        }
    }

    if !caller_model.is_empty() {
        return (provider, caller_model.to_string());
    }

    let model = if settings_default_model.is_empty() {
        default_model_for_provider(&provider, manifest)
            .unwrap_or_else(|| "claude-sonnet-4-6".to_string())
    } else {
        settings_default_model.to_string()
    };
    (provider, model)
}

fn render_permission_response(
    req: &PermissionRequest,
    perms: Option<&OctoPermissions>,
) -> Value {
    // Options in ACP look like `[{optionId:"allow-once", kind:"allow_once"}, {optionId:"reject-once", kind:"reject_once"}, ...]`.
    // We pick by `kind`. Order: whether the agent's per-tool toggle allows
    // this tool → pick allow_once, else reject_once.
    let options = req.options.as_array().cloned().unwrap_or_default();
    let find_kind = |kind: &str| -> Option<String> {
        options.iter().find_map(|o| {
            let k = o.get("kind")?.as_str()?;
            if k == kind {
                o.get("optionId")?.as_str().map(str::to_string)
            } else {
                None
            }
        })
    };
    let allow_id = find_kind("allow_once");
    let reject_id = find_kind("reject_once");
    let name = req.tool_name.to_lowercase();
    let allow = match perms {
        None => true, // no explicit config = full trust (matches legacy)
        Some(p) => {
            let is_shell = name.contains("shell") || name.contains("bash");
            let is_write = name.contains("write")
                || name.contains("edit")
                || name.contains("text_editor");
            let is_fetch = name.contains("fetch") || name.contains("http");
            if is_shell {
                p.bash.unwrap_or(true)
            } else if is_write {
                p.file_write.unwrap_or(true)
            } else if is_fetch {
                p.network.unwrap_or(true)
            } else {
                true // read-only/unknown: allow (mode=chat locks these anyway)
            }
        }
    };
    let chosen = if allow { allow_id } else { reject_id };
    match chosen {
        Some(option_id) => {
            json!({ "outcome": { "outcome": "selected", "optionId": option_id } })
        }
        None => json!({ "outcome": { "outcome": "cancelled" } }),
    }
}

/// Stage 6c: pool-backed agent turn via ACP. First turn per agent pays
/// the full spawn + `initialize` + `session/new`; subsequent turns reuse
/// the pooled `AcpClient` and only pay `session/new` (~10ms). On turn
/// success the client goes back to the pool; on interrupt or error it's
/// torn down (ADR §6.7, scope §3.1).
///
/// Goose doesn't emit token counts in `session/prompt` responses
/// (ADR §6.5/Q-B), so successful turns return and persist a lightweight
/// usage object with only the configured model name.
///
/// Log prefix convention (scope §5 success criteria):
///   `[goose_acp_pool] MISS|HIT|drift|spawn|reuse|put|kill|evict key=…`
/// Every pool-relevant state transition emits one line — reviewers and
/// verification traces follow this prefix.
pub async fn run_agent_turn(
    app: &AppHandle,
    state: &State<'_, ManagedState>,
    params: RunAgentTurnParams,
) -> Result<SendResult, String> {
    // `provider` is the **UI-facing** provider id (what the user picks in
    // Settings → Providers, what the keyring is keyed on). Distinct from
    // `goose_provider` below, which is the **implementation** we hand to
    // the sidecar. For Anthropic with ApiKey mode they happen to be equal
    // (both "anthropic"); for CliSubscription mode they diverge:
    // ui=anthropic, goose=claude-code (scope §6.1).
    //
    // Phase 6 §4.1: provider is no longer hardcoded — read the per-agent
    // `AgentBinding` from config.json and fall back to
    // `settings.providers.default_provider`. An agent without the field
    // (legacy or unconfigured) inherits the workspace default; an agent
    // with `"provider": "openai"` routes via OpenAI even when the
    // workspace default is Anthropic.
    let binding = crate::commands::agent_config::AgentBinding::read_or_default(
        std::path::Path::new(&params.octo_path),
    );
    let (provider, raw_model) = {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        choose_raw_model(
            &binding,
            settings.providers.default_provider.as_str(),
            settings.providers.default_model.as_str(),
            params.model.as_str(),
            &state.providers_manifest,
        )
    };

    // ── Configured-provider check (Phase 4, scope §4.1) ──────────────
    // Reads the settings flag, NOT the keyring. This means opening the
    // Settings tab or checking "is the user set up" never triggers a
    // Keychain prompt. First actual spawn (MISS below) is where the
    // keyring (and prompt, if "Always Allow" isn't set yet) happens.
    let auth_mode = {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        settings
            .providers
            .configured_providers
            .get(&provider)
            .copied()
            .unwrap_or(crate::state::AuthMode::None)
    };

    // Phase 5a Commit C-1 (scope §6.1): resolve the UI provider + auth mode
    // to the goose-facing provider id that gets `GOOSE_PROVIDER`. None means
    // we can't route this turn — surface the specific reason (not
    // configured vs unsupported) so the UI shows a helpful error instead of
    // a mysterious "sidecar timed out" later.
    let goose_provider = match resolve_goose_provider(&provider, auth_mode) {
        Some(gp) => gp.to_string(),
        None => {
            let error_msg = match auth_mode {
                crate::state::AuthMode::None => format!(
                    "No authentication configured for provider \"{provider}\". \
                     Add one in Settings → Providers."
                ),
                crate::state::AuthMode::CliSubscription => format!(
                    "Claude CLI subscription mode is only supported for the \
                     Anthropic provider in this build. Switch to API key mode \
                     in Settings → Providers, or select Anthropic."
                ),
                crate::state::AuthMode::ApiKey => format!(
                    "Provider \"{provider}\" is not supported in this build."
                ),
            };
            return Ok(SendResult {
                ok: false,
                output: None,
                error: Some(error_msg),
                usage: None,
            });
        }
    };
    let auth_mode_segment = auth_mode.as_pool_key_segment();
    eprintln!(
        "[resolve] agent={} provider={} auth={} → goose_provider={}",
        params.agent_name, provider, auth_mode_segment, goose_provider
    );

    // XDG roots under ~/.octopal/ — matches plan §9 "Goose data" paths.
    let app_data_root = dirs::home_dir()
        .ok_or_else(|| "home_dir not available".to_string())?
        .join(".octopal");
    std::fs::create_dir_all(&app_data_root)
        .map_err(|e| format!("mkdir .octopal: {e}"))?;
    let xdg = GooseXdgRoots::under(&app_data_root);

    let model = crate::commands::model_alias::resolve_for_goose_provider(
        &raw_model,
        &goose_provider,
    );

    // Phase 4 invariant (scope §4.1): keyring is read **only on MISS
    // path**. HIT path reuses a pooled sidecar that already has the key
    // in its env from when it was spawned. Building cfg with api_key =
    // None here is intentional — the MISS branch below fills it before
    // calling spawn_initialized (only for ApiKey mode; CliSubscription
    // never touches the keyring and spawns with api_key=None, which
    // build_goose_env correctly omits from env).
    let mut cfg = GooseSpawnConfig {
        provider: goose_provider.clone(),
        model: model.clone(),
        api_key: None,
        ollama_host: None,
        xdg,
        permissions: params.permissions.clone(),
        cwd: std::path::PathBuf::from(&params.folder_path),
        cli_command: None,
    };

    // ── Pool key + config hash (scope §2.1 + §4.3) ───────────────────
    // Hash excludes api_key by design (rotation goes through
    // invalidate_pool_for_provider; see scope §2.3). Phase 5a C-2 adds
    // `auth_mode` to both hash and key — flipping ApiKey ↔ CliSubscription
    // must never hit a pooled sidecar spawned under the other auth
    // (different GOOSE_PROVIDER, different child binary behavior).
    let expected_hash = crate::commands::goose_acp_pool::GooseAcpPool::hash_config(
        &params.folder_path,
        &params.agent_name,
        &provider,
        auth_mode_segment,
        &model,
        &params.system_prompt,
    );
    let pool_key = crate::commands::goose_acp_pool::GooseAcpPool::key_for(
        &params.folder_path,
        &params.agent_name,
        &provider,
        auth_mode_segment,
        &model,
        expected_hash,
    );

    // Emit the "Thinking…" breadcrumb up front — matches legacy's line 655.
    // Payload shape mirrors agent.rs::ActivityEvent serde rename (runId/folderPath/agentName).
    let _ = app.emit(
        "octo:activity",
        json!({
            "runId": params.run_id,
            "text": "Thinking…",
            "folderPath": params.folder_path,
            "agentName": params.agent_name,
        }),
    );

    // ── Pool take-or-spawn ──────────────────────────────────────────
    // Two paths: HIT (reused client, skip initialize), MISS (cold spawn).
    // Drift (hash mismatch) is treated as a MISS plus explicit shutdown of
    // the stale entry. Dead entries (process already exited) are silently
    // discarded — the old PID is meaningless without its handle.
    //
    // Keyring read is deferred into the spawn branches (scope §4.1) so
    // HIT path never touches the keyring. `fill_api_key` is the single
    // function doing that read — search for it when auditing prompts.
    //
    // Phase 5a (scope §6.1): takes `ui_provider` explicitly, not
    // `cfg.provider`, because `cfg.provider` is now the *goose-facing* id
    // ("claude-code" under CliSubscription) and the keyring is keyed by
    // UI provider ("anthropic"). Passing `cfg.provider` would miss the
    // stored key. The closure is also only called for `AuthMode::ApiKey`
    // below — `CliSubscription` skips it and spawns with `api_key=None`,
    // which `build_goose_env` correctly omits from env.
    let pool = state.goose_acp_pool.clone();
    let fill_api_key = |cfg: &mut GooseSpawnConfig, ui_provider: &str| -> Result<(), String> {
        let key = crate::commands::api_keys::load_api_key(ui_provider)?
            .ok_or_else(|| {
                format!(
                    "No API key configured for provider \"{ui_provider}\". \
                     Add one in Settings → Providers."
                )
            })?;
        cfg.api_key = Some(key);
        Ok(())
    };
    // Phase 5a-finalize §3.3: counterpart to fill_api_key for the
    // CliSubscription path. Resolves the provider's UI-facing CLI name
    // (claude / codex / …) into an absolute binary path via the
    // augmented discovery (binary_discovery::discover_binary). The
    // resolved path goes into cfg.cli_command and ends up in the child
    // env as CLAUDE_CODE_COMMAND / CODEX_COMMAND / GEMINI_CLI_COMMAND
    // via build_goose_env.
    let fill_cli_command = |cfg: &mut GooseSpawnConfig, binary: &str| -> Result<(), String> {
        let abs = crate::commands::binary_discovery::discover_binary(binary).ok_or_else(
            || {
                format!(
                    "Could not find `{binary}` on PATH or known install dirs \
                     (nvm, asdf, homebrew, ~/.local/bin, ~/.cargo/bin). \
                     Install it (or use API key mode in Settings → Providers)."
                )
            },
        )?;
        eprintln!(
            "[binary_discovery] discovered {binary} at {}",
            abs.display()
        );
        cfg.cli_command = Some(abs);
        Ok(())
    };
    let needs_api_key = auth_mode == crate::state::AuthMode::ApiKey;
    let needs_cli_command = auth_mode == crate::state::AuthMode::CliSubscription;
    // Map UI provider → CLI binary name to discover. Phase 5a-finalize
    // §3.4 expands this with OpenAI; for now (D-3) only Anthropic has a
    // CliSubscription route, so any other provider here is a programmer
    // error reflected in the resolver step above (it would have already
    // returned None).
    let cli_binary_for = |ui_provider: &str| -> Option<&'static str> {
        match ui_provider {
            "anthropic" => Some("claude"),
            "openai" => Some("codex"),
            _ => None,
        }
    };
    let client = match pool.take(&pool_key) {
        Some(entry) if entry.config_hash == expected_hash => {
            eprintln!("[goose_acp_pool] HIT key={}", pool_key);
            entry.client
        }
        Some(stale) => {
            eprintln!(
                "[goose_acp_pool] drift key={} old_hash={:016x} new_hash={:016x} → evict+spawn",
                pool_key, stale.config_hash, expected_hash
            );
            // Consume entry to get `client`, then move shutdown off the
            // sync path. `drift` log above and `evict` log here sandwich
            // the lifecycle so verification can grep either.
            let old_pid = stale.pid;
            stale.client.shutdown().await;
            eprintln!("[goose_acp_pool] evict pid={} key={}", old_pid, pool_key);
            eprintln!("[goose_acp_pool] spawn key={} (after drift)", pool_key);
            if needs_api_key {
                fill_api_key(&mut cfg, &provider)?;
            }
            if needs_cli_command {
                let binary = cli_binary_for(&provider).ok_or_else(|| {
                    format!(
                        "CliSubscription routing reached spawn for unsupported \
                         provider \"{provider}\" — resolver should have rejected earlier."
                    )
                })?;
                fill_cli_command(&mut cfg, binary)?;
            }
            spawn_initialized(app, &cfg).await?
        }
        None => {
            eprintln!("[goose_acp_pool] MISS key={} → spawn", pool_key);
            if needs_api_key {
                fill_api_key(&mut cfg, &provider)?;
            }
            if needs_cli_command {
                let binary = cli_binary_for(&provider).ok_or_else(|| {
                    format!(
                        "CliSubscription routing reached spawn for unsupported \
                         provider \"{provider}\" — resolver should have rejected earlier."
                    )
                })?;
                fill_cli_command(&mut cfg, binary)?;
            }
            spawn_initialized(app, &cfg).await?
        }
    };

    // ── Per-turn session/new (scope §2.2) ───────────────────────────
    // Always fresh — persistent sessions across turns would add cancel-state
    // complexity for no meaningful latency win.
    let session_id = match open_turn_session(&client, &cfg).await {
        Ok(sid) => sid,
        Err(e) => {
            // Failed session/new on a reused client → discard; the sidecar
            // might be wedged (ADR §6.7). Don't return it to the pool.
            eprintln!(
                "[goose_acp_pool] session/new failed on reused client → evict key={} err={}",
                pool_key, e
            );
            client.shutdown().await;
            return Err(e);
        }
    };

    // Register sidecar PID under run_id so stop_agent can SIGTERM it.
    let pid = client.sidecar_pid().await;
    state
        .running_agents
        .lock()
        .unwrap()
        .insert(params.run_id.clone(), pid);

    let mut stream = match client.take_stream().await {
        Some(s) => s,
        None => {
            // Reused client's stream was already taken on a prior turn and
            // wasn't returned — should never happen if put/take are balanced,
            // but if it does, we can't drive this turn: evict and rebuild on
            // the next call rather than wedge here.
            eprintln!(
                "[goose_acp_pool] stream already taken on reused client → evict key={}",
                pool_key
            );
            state.running_agents.lock().unwrap().remove(&params.run_id);
            client.shutdown().await;
            return Err("goose stream already taken".into());
        }
    };

    // ── Build the turn prompt ───────────────────────────────────────
    // TEMPORARY: Goose ACP v1.31.0 has no dedicated system-prompt channel
    // (session/new doesn't accept one). Stage 6a prepends the Octopal
    // system prompt as a framed preface. 6b will investigate Goose's
    // recipe API or extension hooks for proper injection.
    // Tracking: Stage 6b
    let turn_text = format!(
        "--- OCTOPAL AGENT CONTEXT (treat as system instructions) ---\n\
         {}\n\
         --- END CONTEXT ---\n\n\
         {}",
        params.system_prompt, params.contextual_prompt
    );

    // ── Drive the turn ──────────────────────────────────────────────
    let app_for_cb = app.clone();
    let folder_cb = params.folder_path.clone();
    let agent_cb = params.agent_name.clone();
    let run_id_cb = params.run_id.clone();
    let backup_tracker = state.backup_tracker.clone();
    let file_lock_manager = state.file_lock_manager.clone();

    let mut collected_text = String::new();
    let mut permission_replies: Vec<(u64, Value)> = Vec::new();
    let perms_for_cb = params.permissions.clone();

    let turn_outcome = run_turn(
        &client,
        &mut stream,
        &session_id,
        &turn_text,
        Duration::from_secs(120),
        |ev| match ev {
            TurnEvent::Mapped(MappedEvent::AssistantTextChunk { text }) => {
                // Progressive text delivery — Goose emits agent_message_chunk
                // notifications as the model streams. We push each delta to
                // the UI so the bubble grows in real time instead of snapping
                // to the final value only on turn end. Legacy's UI had no
                // per-chunk event, so this is a strict UX upgrade.
                let _ = app_for_cb.emit(
                    "octo:textChunk",
                    json!({
                        "runId": run_id_cb,
                        "delta": text,
                        "folderPath": folder_cb,
                        "agentName": agent_cb,
                    }),
                );
                collected_text.push_str(&text);
            }
            TurnEvent::Mapped(MappedEvent::AssistantThoughtChunk { .. }) => {
                // Not rendered in v0.1.42 UI; dropping is intentional per
                // ADR §6.5 Q-A (no thinking events observed anyway).
            }
            TurnEvent::Mapped(MappedEvent::Activity { text }) => {
                let _ = app_for_cb.emit(
                    "octo:activity",
                    json!({
                        "runId": run_id_cb,
                        "text": text,
                        "folderPath": folder_cb,
                        "agentName": agent_cb,
                    }),
                );
            }
            TurnEvent::Mapped(MappedEvent::ActivityLog { tool, target }) => {
                // Mirror legacy's Write/Edit backup + lock plumbing.
                let mut backup_id = None;
                let mut conflict_with = None;
                if matches!(tool.as_str(), "Write" | "Edit") && !target.is_empty() {
                    let abs_path = if Path::new(&target).is_absolute() {
                        std::path::PathBuf::from(&target)
                    } else {
                        Path::new(&folder_cb).join(&target)
                    };
                    if let Err(existing) = file_lock_manager.try_acquire(
                        abs_path.clone(),
                        &run_id_cb,
                        &agent_cb,
                    ) {
                        conflict_with = Some(existing);
                    }
                    backup_id = backup_tracker.snapshot(
                        Path::new(&folder_cb),
                        &run_id_cb,
                        &agent_cb,
                        &target,
                    );
                }
                let ts_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64;
                // `backupId`/`conflictWith` intentionally omitted from the
                // JSON when None, mirroring the serde `skip_serializing_if`
                // on agent.rs::ActivityLogEvent.
                let mut payload = serde_json::Map::new();
                payload.insert("folderPath".into(), json!(folder_cb));
                payload.insert("agentName".into(), json!(agent_cb));
                payload.insert("tool".into(), json!(tool));
                payload.insert("target".into(), json!(target));
                payload.insert("ts".into(), json!(ts_ms));
                if let Some(b) = backup_id {
                    payload.insert("backupId".into(), json!(b));
                }
                if let Some(c) = conflict_with {
                    payload.insert("conflictWith".into(), json!(c));
                }
                let _ = app_for_cb.emit("activity:log", Value::Object(payload));
            }
            TurnEvent::Permission(req) => {
                let response = render_permission_response(&req.payload, perms_for_cb.as_ref());
                permission_replies.push((req.request_id, response));
            }
        },
    )
    .await;

    // Flush any permission replies we buffered (callback can't be async).
    for (id, resp) in permission_replies.drain(..) {
        let _ = client.respond_raw(id, resp).await;
    }

    // ── Cleanup: unregister + pool decision (Stage 6c) ──────────────
    let was_interrupted = state
        .interrupted_runs
        .lock()
        .unwrap()
        .remove(&params.run_id);
    state.running_agents.lock().unwrap().remove(&params.run_id);
    file_lock_manager.release_run(&params.run_id);
    backup_tracker.finalize_run(&params.run_id);

    // Close the per-turn session so Goose can reclaim its sqlite row.
    // **Not gated** on reuse — `session/close` exists (ADR §6.7) but its
    // exact v1.31.0 semantics are documented as "agent removal, not
    // cancellation"; if a future Goose version returns unexpected errors
    // we'd rather keep pooling (degraded = accumulating sessions in
    // sqlite, bounded by process lifetime) than silently disable reuse
    // (catastrophic = full Stage 6a cold-spawn regression). On shutdown
    // the whole sqlite file tears down with the XDG sandbox.
    if let Err(e) = client.close_session(&session_id).await {
        eprintln!("[goose_acp_pool] close_session soft-fail sid={} err={}", session_id, e);
    }

    // Decide: return to pool (reuse next turn) vs shutdown (kill now).
    //   - Interrupted → Stop already SIGTERM'd the PID via stop_agent;
    //     client is effectively dead. Shutdown is a no-op for the zombie.
    //   - turn_outcome Err → stream broke; not safe to reuse.
    //   - Otherwise → put back for the next turn.
    if let Ok(result) = &turn_outcome {
        eprintln!(
            "[goose_acp_pool] turn_done key={} stop_reason={}",
            pool_key, result.stop_reason
        );
    }
    let turn_ok = turn_outcome.is_ok();
    let reuse = !was_interrupted && turn_ok;

    if reuse {
        // Re-seat the stream receiver so the next turn can take_stream()
        // again — a pool HIT that hits None would fatally evict an
        // otherwise-healthy sidecar.
        client.put_stream(stream).await;
        let entry = crate::commands::goose_acp_pool::GooseAcpEntry {
            client,
            pid,
            config_hash: expected_hash,
            provider: provider.clone(),
            key: pool_key.clone(),
        };
        // put() returns collision leftover — shouldn't happen in the
        // single-take-per-turn path, but the #[must_use] forces us to
        // handle it. If it ever fires, shutdown the old one so the newer
        // client wins.
        if let Some(leftover) = pool.put(pool_key.clone(), entry) {
            eprintln!(
                "[goose_acp_pool] put collision key={} evicting older pid={}",
                pool_key, leftover.pid
            );
            leftover.client.shutdown().await;
        }
        eprintln!("[goose_acp_pool] put key={} pid={}", pool_key, pid);
    } else {
        eprintln!(
            "[goose_acp_pool] kill key={} pid={} interrupted={} turn_ok={}",
            pool_key, pid, was_interrupted, turn_ok
        );
        client.shutdown().await;
    }

    // Interrupt = user clicked Stop. Legacy (agent.rs:1113) returns whatever
    // text was accumulated before SIGTERM as a normal `Ok`, and writes it to
    // history. We mirror that: skip the turn_outcome error check and fall
    // through to the persistence path with the partial `collected_text`.
    // The stream/IO error from the killed child is expected, not a failure.
    if !was_interrupted {
        if let Err(e) = turn_outcome {
            return Ok(SendResult {
                ok: false,
                output: None,
                error: Some(format!("goose turn failed: {e}")),
                usage: None,
            });
        }
    }

    let output = collected_text.trim().to_string();
    let usage = crate::commands::agent::UsageData::model_only(model);

    // ── Persist: .octo history[] + room-history.json ────────────────
    // Byte-identical to legacy's write path (agent.rs:1078-1146).
    let mut octo: Value = {
        let content = std::fs::read_to_string(&params.octo_path)
            .map_err(|e| format!("read octo: {e}"))?;
        serde_json::from_str(&content).map_err(|e| format!("parse octo: {e}"))?
    };
    if let Some(hist) = octo.get_mut("history").and_then(|h| h.as_array_mut()) {
        let now_ms = chrono::Utc::now().timestamp_millis() as f64;
        hist.push(json!({
            "role": "user",
            "text": params.user_prompt,
            "ts": params.user_ts,
            "roomTs": params.user_ts,
        }));
        hist.push(json!({
            "role": "assistant",
            "text": output,
            "ts": now_ms,
            "roomTs": now_ms,
        }));
    }
    std::fs::write(
        &params.octo_path,
        serde_json::to_string_pretty(&octo).unwrap(),
    )
    .map_err(|e| format!("write octo: {e}"))?;

    let room_history_path = Path::new(&params.folder_path)
        .join(".octopal")
        .join("room-history.json");
    std::fs::create_dir_all(room_history_path.parent().unwrap()).ok();
    crate::commands::folder::maybe_rotate_room_history(&room_history_path);
    let mut room_history: Vec<Value> = if room_history_path.exists() {
        std::fs::read_to_string(&room_history_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        vec![]
    };
    let entry_id = params
        .pending_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    room_history.push(json!({
        "id": entry_id,
        "agentName": params.agent_name,
        "text": output,
        "ts": chrono::Utc::now().timestamp_millis() as f64,
        "usage": serde_json::to_value(&usage).unwrap_or_default(),
    }));
    std::fs::write(
        &room_history_path,
        serde_json::to_string_pretty(&room_history).unwrap(),
    )
    .ok();

    Ok(SendResult {
        ok: true,
        output: Some(output),
        error: None,
        usage: Some(usage),
    })
}

// ── unit tests (env builder + mode mapper — pure logic) ───────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn xdg(tmp: &Path) -> GooseXdgRoots {
        GooseXdgRoots::under(tmp)
    }

    fn manifest() -> crate::commands::providers_manifest::ProvidersManifest {
        serde_json::from_value(serde_json::json!({
            "anthropic": {
                "displayName": "Anthropic",
                "models": ["claude-opus-4-7", "claude-sonnet-4-6"],
                "authMethods": []
            },
            "openai": {
                "displayName": "OpenAI",
                "models": ["gpt-5.4", "gpt-5"],
                "authMethods": []
            },
            "google": {
                "displayName": "Google",
                "models": ["gemini-2.5-pro"],
                "authMethods": []
            }
        }))
        .unwrap()
    }

    #[test]
    fn choose_raw_model_provider_override_uses_provider_default() {
        let binding = crate::commands::agent_config::AgentBinding {
            provider: Some("openai".to_string()),
            model: None,
        };
        let (provider, model) = choose_raw_model(
            &binding,
            "anthropic",
            "claude-sonnet-4-6",
            "",
            &manifest(),
        );
        assert_eq!(provider, "openai");
        assert_eq!(model, "gpt-5");
    }

    #[test]
    fn choose_raw_model_agent_model_override_wins() {
        let binding = crate::commands::agent_config::AgentBinding {
            provider: Some("openai".to_string()),
            model: Some("gpt-5.4".to_string()),
        };
        let (provider, model) = choose_raw_model(
            &binding,
            "anthropic",
            "claude-sonnet-4-6",
            "opus",
            &manifest(),
        );
        assert_eq!(provider, "openai");
        assert_eq!(model, "gpt-5.4");
    }

    #[test]
    fn choose_raw_model_model_only_override_keeps_workspace_provider() {
        let binding = crate::commands::agent_config::AgentBinding {
            provider: None,
            model: Some("claude-haiku-4-5-20251001".to_string()),
        };
        let (provider, model) = choose_raw_model(
            &binding,
            "anthropic",
            "claude-sonnet-4-6",
            "",
            &manifest(),
        );
        assert_eq!(provider, "anthropic");
        assert_eq!(model, "claude-haiku-4-5-20251001");
    }

    #[test]
    fn env_builder_injects_xdg_and_provider() {
        let tmp = std::env::temp_dir().join("octopal-env-test");
        let cfg = GooseSpawnConfig {
            provider: "anthropic".into(),
            model: "claude-sonnet-4-6".into(),
            api_key: Some("sk-ant-test".into()),
            ollama_host: None,
            xdg: xdg(&tmp),
            permissions: None,
            cwd: tmp.clone(),
            cli_command: None,
        };
        let env = build_goose_env(&cfg);
        assert_eq!(env.get("GOOSE_PROVIDER").map(|s| s.as_str()), Some("anthropic"));
        assert_eq!(env.get("GOOSE_MODEL").map(|s| s.as_str()), Some("claude-sonnet-4-6"));
        assert_eq!(env.get("ANTHROPIC_API_KEY").map(|s| s.as_str()), Some("sk-ant-test"));
        assert!(env.get("XDG_CONFIG_HOME").is_some());
        assert!(env.get("XDG_DATA_HOME").is_some());
        assert!(env.get("XDG_STATE_HOME").is_some());
        assert!(env.get("OLLAMA_HOST").is_none());
    }

    #[test]
    fn env_builder_ollama_sets_host_not_key() {
        let tmp = std::env::temp_dir().join("octopal-env-test2");
        let cfg = GooseSpawnConfig {
            provider: "ollama".into(),
            model: "llama3".into(),
            api_key: Some("unused".into()),
            ollama_host: Some("http://localhost:11434".into()),
            xdg: xdg(&tmp),
            permissions: None,
            cwd: tmp.clone(),
            cli_command: None,
        };
        let env = build_goose_env(&cfg);
        assert_eq!(
            env.get("OLLAMA_HOST").map(|s| s.as_str()),
            Some("http://localhost:11434")
        );
        // Ollama shouldn't receive an API key under any standard env name.
        assert!(env.get("ANTHROPIC_API_KEY").is_none());
        assert!(env.get("OPENAI_API_KEY").is_none());
    }

    #[test]
    fn env_builder_claude_code_omits_key() {
        let tmp = std::env::temp_dir().join("octopal-env-test3");
        let cfg = GooseSpawnConfig {
            provider: "claude-code".into(),
            model: "claude-sonnet-4-6".into(),
            // Even if a key is accidentally passed for a CLI-subscription
            // provider, we must NOT inject it — claude-code uses the user's
            // already-logged-in CLI state, and an extra key could interfere.
            api_key: Some("sk-ant-should-be-ignored".into()),
            ollama_host: None,
            xdg: xdg(&tmp),
            permissions: None,
            cwd: tmp.clone(),
            cli_command: None,
        };
        let env = build_goose_env(&cfg);
        assert!(env.get("ANTHROPIC_API_KEY").is_none());
    }

    #[test]
    fn mode_mapping_full_lockdown() {
        let perms = OctoPermissions {
            file_write: Some(false),
            bash: Some(false),
            network: Some(false),
            allow_paths: None,
            deny_paths: None,
        };
        assert_eq!(permissions_to_mode_id(Some(&perms)), "chat");
    }

    #[test]
    fn mode_mapping_any_permission_on_stays_auto() {
        // Even a single enabled toggle keeps the agent in "auto" — the
        // fine-grained resolver (stage 7) handles the rest.
        for (fw, bash, net) in [
            (true, false, false),
            (false, true, false),
            (false, false, true),
            (true, true, true),
        ] {
            let perms = OctoPermissions {
                file_write: Some(fw),
                bash: Some(bash),
                network: Some(net),
                allow_paths: None,
                deny_paths: None,
            };
            assert_eq!(
                permissions_to_mode_id(Some(&perms)),
                "auto",
                "fw={fw} bash={bash} net={net}"
            );
        }
    }

    #[test]
    fn mode_mapping_none_defaults_to_auto() {
        // Missing OctoPermissions = "no explicit config" = full trust,
        // mirroring v0.1.42 behavior.
        assert_eq!(permissions_to_mode_id(None), "auto");
    }

    #[test]
    fn mode_mapping_partial_defaults_each_field_to_true() {
        // `file_write: None` means "not set" → default true. So `bash=false,
        // network=false, file_write=None` → file_write=true effectively →
        // "auto", NOT "chat".
        let perms = OctoPermissions {
            file_write: None,
            bash: Some(false),
            network: Some(false),
            allow_paths: None,
            deny_paths: None,
        };
        assert_eq!(permissions_to_mode_id(Some(&perms)), "auto");
    }

    // ── Phase 5a Commit C-1: provider_api_key_env arm table ───────────
    //
    // The fn has two semantic groups:
    // 1. API-key providers → return the env var name Goose reads
    // 2. CLI-subscription / Ollama providers + unknown → return None
    //
    // Group membership is the routing contract — if someone ever adds a
    // provider to the wrong group the child process gets the wrong env
    // (or misses one), which manifests as an obscure auth failure. These
    // tests pin the membership so refactors surface a compile-time
    // match-exhaustiveness issue OR a failing assertion, not a runtime
    // regression found months later.

    #[test]
    fn provider_api_key_env_api_key_providers_return_env_name() {
        assert_eq!(
            provider_api_key_env("anthropic"),
            Some("ANTHROPIC_API_KEY")
        );
        assert_eq!(provider_api_key_env("openai"), Some("OPENAI_API_KEY"));
        assert_eq!(provider_api_key_env("google"), Some("GOOGLE_API_KEY"));
        assert_eq!(
            provider_api_key_env("databricks"),
            Some("DATABRICKS_TOKEN")
        );
    }

    #[test]
    fn provider_api_key_env_cli_subscription_providers_return_none() {
        // All CLI-subscription-style providers (auth via spawned binary)
        // + Ollama (auth via host URL) must NOT get an api key env.
        //
        // `claude-acp` is included here pre-emptively: Phase 5a routes to
        // `claude-code`, but §6.2 pins `claude-acp` behavior for Phase 5c
        // (see also scope §3.3). Listing it now means the Phase 5c flip
        // is a UI change, not an auth bug.
        for cli_prov in [
            "claude-code",
            "claude-acp",
            "gemini-cli",
            "gemini-oauth",
            "codex",
            "ollama",
        ] {
            assert!(
                provider_api_key_env(cli_prov).is_none(),
                "provider={cli_prov} must return None — CLI-sub / Ollama providers \
                 don't take a key via env",
            );
        }
    }

    #[test]
    fn provider_api_key_env_unknown_provider_returns_none() {
        // Unknown providers fall through to None rather than guessing at
        // an env var name. The downstream effect is "sidecar spawns, Goose
        // itself emits missing-credentials error" — correct surface.
        assert!(provider_api_key_env("mystery-provider-2026").is_none());
        assert!(provider_api_key_env("").is_none());
    }

    // ── Phase 5a Commit C-1: resolve_goose_provider matrix ────────────
    //
    // This is the single pure function that decides which goose provider a
    // turn spawns under. Matrix test covers every (ui, auth_mode) combo
    // the Phase 5a UI can produce + two rejection edges (non-anthropic
    // CliSubscription, unknown provider ApiKey).

    #[test]
    fn resolve_goose_provider_authmode_matrix() {
        use crate::state::AuthMode;
        // (ui, mode) → expected goose id
        let cases: &[(&str, AuthMode, Option<&'static str>)] = &[
            // None always resolves to None regardless of ui provider.
            ("anthropic", AuthMode::None, None),
            ("openai", AuthMode::None, None),
            ("unknown", AuthMode::None, None),
            // ApiKey mode for supported providers passes through.
            ("anthropic", AuthMode::ApiKey, Some("anthropic")),
            ("openai", AuthMode::ApiKey, Some("openai")),
            ("google", AuthMode::ApiKey, Some("google")),
            ("databricks", AuthMode::ApiKey, Some("databricks")),
            ("ollama", AuthMode::ApiKey, Some("ollama")),
            // CliSubscription:
            //   anthropic → claude-code (Phase 5a)
            //   openai    → chatgpt_codex (2026-05-02 second fix; was
            //               originally chatgpt-codex which doesn't exist,
            //               then `codex` deprecated which broke against
            //               codex CLI 0.128.0's flag changes)
            //   others    → None (5b+ territory)
            ("anthropic", AuthMode::CliSubscription, Some("claude-acp")),
            ("openai", AuthMode::CliSubscription, Some("chatgpt_codex")),
            ("google", AuthMode::CliSubscription, None),
            // Unknown providers resolve to None so the caller surfaces a
            // specific error ("not supported in this build") rather than
            // spawning a sidecar that then fails with a cryptic goose error.
            ("mystery", AuthMode::ApiKey, None),
        ];

        for &(ui, mode, expected) in cases {
            assert_eq!(
                resolve_goose_provider(ui, mode),
                expected,
                "ui={ui} mode={mode:?} expected={expected:?}",
            );
        }
    }

    #[test]
    fn resolve_goose_provider_openai_cli_subscription_uses_chatgpt_codex() {
        // 2026-05-02 second fix: OpenAI's CliSubscription routes to
        // `chatgpt_codex` (underscore, current). Two earlier attempts
        // failed:
        //   - `chatgpt-codex` (dash) → "Unknown provider" at Goose
        //   - `codex` (deprecated) → spawns codex CLI 0.128.0 with
        //     legacy flags (--skip-git-repo-check) → exit 1
        // chatgpt_codex does its own OAuth against chatgpt.com — Goose
        // opens a browser, user authorizes, tokens persist under the
        // sidecar's XDG_DATA root.
        use crate::state::AuthMode;
        assert_eq!(
            resolve_goose_provider("openai", AuthMode::CliSubscription),
            Some("chatgpt_codex"),
        );
    }

    #[test]
    fn resolve_goose_provider_anthropic_cli_subscription_uses_claude_acp() {
        // 2026-05-02 third-this-session pivot: Anthropic + CliSubscription
        // → `claude-acp` (NOT the originally-chosen `claude-code` from
        // 5a §3.3). Same pattern as the OpenAI pivot earlier this
        // session: Goose's `claude-code` provider is deprecated
        // ("[Deprecated: use claude-acp instead]") and hangs at
        // session/prompt under modern claude CLI 2.x. claude-acp
        // requires an npm adapter (`npm install -g
        // @zed-industries/claude-agent-acp`) — README documents this.
        use crate::state::AuthMode;
        assert_eq!(
            resolve_goose_provider("anthropic", AuthMode::CliSubscription),
            Some("claude-acp"),
        );
    }

    // ── Phase 5a Commit C-1: build_goose_env PATH propagation ─────────

    #[test]
    fn env_builder_path_includes_parent_dirs() {
        // 5a-finalize §3.1 update: child PATH is now the *augmented*
        // candidate-dir value, not the verbatim parent PATH (D-3
        // change). The C-1 invariant — "parent PATH dirs reach the
        // child" — is preserved as a substring relation: every dir
        // from parent PATH must appear inside the augmented PATH at
        // its original position. Heuristic dirs append after.
        let tmp = std::env::temp_dir().join("octopal-env-path-test");
        let cfg = GooseSpawnConfig {
            provider: "claude-code".into(),
            model: "claude-sonnet-4-6".into(),
            api_key: None,
            ollama_host: None,
            xdg: xdg(&tmp),
            permissions: None,
            cwd: tmp.clone(),
            cli_command: None,
        };
        let env = build_goose_env(&cfg);
        let aug_path = env
            .get("PATH")
            .expect("PATH must be set on child env")
            .as_str();
        let parent_path =
            std::env::var("PATH").expect("test harness must have PATH set");
        for dir in parent_path.split(':').filter(|s| !s.is_empty()) {
            assert!(
                aug_path.contains(dir),
                "augmented PATH should preserve parent dir {dir:?}",
            );
        }
    }

    // ── Phase 5a-finalize Commit D-3: cli_command → *_COMMAND env ─────

    #[test]
    fn env_builder_claude_code_with_cli_command_injects_command_env() {
        // CliSubscription path: cfg.cli_command carries the absolute
        // path of the discovered claude binary. build_goose_env must
        // emit CLAUDE_CODE_COMMAND with that exact value so Goose
        // skips PATH lookup. This is the workaround for macOS
        // LaunchServices PATH stripping (§1.1).
        let tmp = std::env::temp_dir().join("octopal-env-claude-cmd-test");
        let claude_path =
            std::path::PathBuf::from("/Users/test/.nvm/versions/node/v22/bin/claude");
        let cfg = GooseSpawnConfig {
            provider: "claude-code".into(),
            model: "claude-sonnet-4-6".into(),
            api_key: None,
            ollama_host: None,
            xdg: xdg(&tmp),
            permissions: None,
            cwd: tmp.clone(),
            cli_command: Some(claude_path.clone()),
        };
        let env = build_goose_env(&cfg);
        assert_eq!(
            env.get("CLAUDE_CODE_COMMAND").map(|s| s.as_str()),
            Some(claude_path.to_string_lossy().as_ref()),
            "CLAUDE_CODE_COMMAND should pin the discovered absolute path",
        );
        assert!(env.get("CODEX_COMMAND").is_none());
        assert!(env.get("GEMINI_CLI_COMMAND").is_none());
        // Still no API key — CliSubscription invariant.
        assert!(env.get("ANTHROPIC_API_KEY").is_none());
    }

    #[test]
    fn env_builder_codex_with_cli_command_injects_codex_env() {
        // 2026-05-02 fix: provider id is `codex` (deprecated provider
        // spawning the codex CLI subprocess), NOT `chatgpt-codex`
        // (which doesn't exist) or `chatgpt_codex` (current OAuth-only
        // provider). build_goose_env routes `codex` → CODEX_COMMAND.
        let tmp = std::env::temp_dir().join("octopal-env-codex-cmd-test");
        let codex_path =
            std::path::PathBuf::from("/Users/test/.nvm/versions/node/v22/bin/codex");
        let cfg = GooseSpawnConfig {
            provider: "codex".into(),
            model: "gpt-5".into(),
            api_key: None,
            ollama_host: None,
            xdg: xdg(&tmp),
            permissions: None,
            cwd: tmp.clone(),
            cli_command: Some(codex_path.clone()),
        };
        let env = build_goose_env(&cfg);
        assert_eq!(
            env.get("CODEX_COMMAND").map(|s| s.as_str()),
            Some(codex_path.to_string_lossy().as_ref()),
        );
        assert!(env.get("CLAUDE_CODE_COMMAND").is_none());
        assert!(env.get("OPENAI_API_KEY").is_none());
    }

    #[test]
    fn env_builder_no_cli_command_means_no_command_env_emitted() {
        // ApiKey mode (or any non-CliSubscription provider): cfg.cli_command
        // = None must emit zero `*_COMMAND` env vars. Otherwise stray
        // env from a prior turn could leak into a fresh ApiKey spawn.
        let tmp = std::env::temp_dir().join("octopal-env-no-cmd-test");
        let cfg = GooseSpawnConfig {
            provider: "anthropic".into(),
            model: "claude-sonnet-4-6".into(),
            api_key: Some("sk-ant-fake".into()),
            ollama_host: None,
            xdg: xdg(&tmp),
            permissions: None,
            cwd: tmp.clone(),
            cli_command: None, // explicit
        };
        let env = build_goose_env(&cfg);
        assert!(env.get("CLAUDE_CODE_COMMAND").is_none());
        assert!(env.get("CODEX_COMMAND").is_none());
        assert!(env.get("GEMINI_CLI_COMMAND").is_none());
    }

    #[test]
    fn env_builder_claude_acp_does_not_inject_command_env() {
        // 2026-05-02 reversal of the earlier "claude-acp shares
        // CLAUDE_CODE_COMMAND" assumption. Goose v1.31.0 strings dump
        // confirms claude-acp has NO `*_COMMAND` env override — it
        // resolves the `claude-agent-acp` npm adapter via PATH only.
        // build_goose_env intentionally does NOT inject CLAUDE_CODE_COMMAND
        // for claude-acp; the augmented PATH (which includes nvm/asdf)
        // covers adapter discovery.
        let tmp = std::env::temp_dir().join("octopal-env-claude-acp-test");
        let claude_path = std::path::PathBuf::from("/usr/local/bin/claude");
        let cfg = GooseSpawnConfig {
            provider: "claude-acp".into(),
            model: "current".into(),
            api_key: None,
            ollama_host: None,
            xdg: xdg(&tmp),
            permissions: None,
            cwd: tmp.clone(),
            cli_command: Some(claude_path.clone()),
        };
        let env = build_goose_env(&cfg);
        // No *_COMMAND envs leaked — claude-acp doesn't read them.
        assert!(env.get("CLAUDE_CODE_COMMAND").is_none());
    }

    #[test]
    fn env_builder_unknown_provider_with_cli_command_is_silent_noop() {
        // Defense in depth: an unknown provider with cli_command set
        // (which shouldn't happen — resolver gates this) must NOT
        // accidentally inject the path under some default env var.
        // Silent no-op = safe failure; Goose surfaces "provider not
        // configured" instead of running the binary unexpectedly.
        let tmp = std::env::temp_dir().join("octopal-env-unknown-cmd-test");
        let cfg = GooseSpawnConfig {
            provider: "mystery-provider".into(),
            model: "x".into(),
            api_key: None,
            ollama_host: None,
            xdg: xdg(&tmp),
            permissions: None,
            cwd: tmp.clone(),
            cli_command: Some(std::path::PathBuf::from("/tmp/anything")),
        };
        let env = build_goose_env(&cfg);
        // None of the known *_COMMAND keys appear.
        for key in ["CLAUDE_CODE_COMMAND", "CODEX_COMMAND", "GEMINI_CLI_COMMAND"] {
            assert!(
                env.get(key).is_none(),
                "unknown provider must not synthesize {key}",
            );
        }
    }

    #[test]
    fn env_builder_cli_subscription_shape() {
        // End-to-end env shape for the CliSubscription path: provider
        // reported to goose is `claude-code`, no ANTHROPIC_API_KEY, and
        // PATH is present.
        let tmp = std::env::temp_dir().join("octopal-env-cli-sub-shape");
        let cfg = GooseSpawnConfig {
            provider: "claude-code".into(),
            model: "claude-sonnet-4-6".into(),
            api_key: None, // always None for CliSubscription — it's the contract
            ollama_host: None,
            xdg: xdg(&tmp),
            permissions: None,
            cwd: tmp.clone(),
            cli_command: None,
        };
        let env = build_goose_env(&cfg);
        assert_eq!(
            env.get("GOOSE_PROVIDER").map(|s| s.as_str()),
            Some("claude-code"),
        );
        assert!(
            env.get("ANTHROPIC_API_KEY").is_none(),
            "CliSubscription must not inject ANTHROPIC_API_KEY",
        );
        assert!(
            env.get("PATH").is_some(),
            "PATH must be present for claude subprocess resolution",
        );
        // XDG still enforced — cli_subscription doesn't exempt isolation.
        assert!(env.get("XDG_CONFIG_HOME").is_some());
    }

    #[test]
    fn env_builder_api_key_mode_still_injects_key_and_path() {
        // Regression guard: ApiKey mode should be unchanged by the Phase 5a
        // PATH addition. Key still injected, PATH still there (since we
        // inject it universally), ollama_host absent.
        let tmp = std::env::temp_dir().join("octopal-env-api-key-regression");
        let cfg = GooseSpawnConfig {
            provider: "anthropic".into(),
            model: "claude-sonnet-4-6".into(),
            api_key: Some("sk-ant-fake".into()),
            ollama_host: None,
            xdg: xdg(&tmp),
            permissions: None,
            cwd: tmp.clone(),
            cli_command: None,
        };
        let env = build_goose_env(&cfg);
        assert_eq!(
            env.get("ANTHROPIC_API_KEY").map(|s| s.as_str()),
            Some("sk-ant-fake"),
        );
        assert!(env.get("PATH").is_some());
        assert!(env.get("OLLAMA_HOST").is_none());
    }
}
