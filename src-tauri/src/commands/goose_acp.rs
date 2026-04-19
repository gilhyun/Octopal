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
/// (Ollama = host URL only, `claude-code` / `gemini-cli` / `chatgpt-codex` =
/// piggyback on the user's CLI subscription, no key plumbed through env).
fn provider_api_key_env(goose_provider: &str) -> Option<&'static str> {
    match goose_provider {
        "anthropic" => Some("ANTHROPIC_API_KEY"),
        "openai" => Some("OPENAI_API_KEY"),
        "google" => Some("GOOGLE_API_KEY"),
        "databricks" => Some("DATABRICKS_TOKEN"),
        // CLI-subscription providers + Ollama: no API key env
        "claude-code" | "gemini-cli" | "gemini-oauth" | "chatgpt-codex" | "ollama" => None,
        // Unknown provider: don't guess. Caller falls back to no key injection
        // and the agent will surface the provider's own "missing credentials"
        // error in the stream.
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
    pub raw_response: Value,
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
                return Ok(TurnResult { stop_reason, raw_response: resp });
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

// ── acp_turn_test (stage 5 live pipeline proof) ───────────────────────

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

/// Live end-to-end pipeline test: spawn → initialize → new_session →
/// session/prompt → stream consume → shutdown. Requires a real
/// `ANTHROPIC_API_KEY` env var (read at command invocation time, not
/// persisted anywhere).
///
/// This is the stage-5 manual verification entry point — it exercises
/// every piece stage 1-5 added:
///   - sidecar resolution (stage 1)
///   - JSON-RPC client (stage 2)
///   - env isolation + mode lock (stage 3)
///   - event mapper + mpsc channel (stage 4)
///   - run_turn state machine (stage 5)
///
/// Not intended for production — `agent.rs` will consume `run_turn`
/// directly in stage 6 via the `use_legacy_claude_cli` flag branch.
#[tauri::command]
pub async fn acp_turn_test(app: AppHandle, prompt: String) -> Result<Value, String> {
    let start = Instant::now();
    let mut result = AcpTurnTestResult::default();

    let api_key = std::env::var("ANTHROPIC_API_KEY").ok();
    if api_key.is_none() {
        result
            .errors
            .push("ANTHROPIC_API_KEY env var not set".into());
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
/// On success the returned `SendResult.usage` is **always `None`** — Goose
/// doesn't emit usage in `session/prompt` response (ADR §6.5/Q-B). UI
/// must handle `None` gracefully (shows "N/A" per Plan §Risks #3).
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
    // ── Resolve env (Stage 6a only — 6b replaces with keyring) ───────
    let api_key = std::env::var("ANTHROPIC_API_KEY").ok();
    if api_key.is_none() {
        return Ok(SendResult {
            ok: false,
            output: None,
            error: Some(
                "ANTHROPIC_API_KEY env var not set. Stage 6a reads it \
                 directly from env; set it before launching the app. \
                 Stage 6b will read from OS keyring."
                    .into(),
            ),
            usage: None,
        });
    }

    // XDG roots under ~/.octopal/ — matches plan §9 "Goose data" paths.
    let app_data_root = dirs::home_dir()
        .ok_or_else(|| "home_dir not available".to_string())?
        .join(".octopal");
    std::fs::create_dir_all(&app_data_root)
        .map_err(|e| format!("mkdir .octopal: {e}"))?;
    let xdg = GooseXdgRoots::under(&app_data_root);

    let model = if params.model.is_empty() {
        "claude-sonnet-4-6".to_string()
    } else {
        params.model.clone()
    };

    let provider = "anthropic".to_string();
    let cfg = GooseSpawnConfig {
        provider: provider.clone(),
        model: model.clone(),
        api_key,
        ollama_host: None,
        xdg,
        permissions: params.permissions.clone(),
        cwd: std::path::PathBuf::from(&params.folder_path),
    };

    // ── Pool key + config hash (scope §2.1) ──────────────────────────
    // Hash excludes api_key by design (rotation goes through
    // invalidate_pool_for_provider; see scope §2.3).
    let expected_hash = crate::commands::goose_acp_pool::GooseAcpPool::hash_config(
        &params.folder_path,
        &params.agent_name,
        &provider,
        &model,
        &params.system_prompt,
    );
    let pool_key = crate::commands::goose_acp_pool::GooseAcpPool::key_for(
        &params.folder_path,
        &params.agent_name,
        &provider,
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
    let pool = state.goose_acp_pool.clone();
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
            spawn_initialized(app, &cfg).await?
        }
        None => {
            eprintln!("[goose_acp_pool] MISS key={} → spawn", pool_key);
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
        usage: None, // ADR §6.5 / Q-B: Goose doesn't emit usage
    })
}

// ── unit tests (env builder + mode mapper — pure logic) ───────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn xdg(tmp: &Path) -> GooseXdgRoots {
        GooseXdgRoots::under(tmp)
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
}
