//! ACP `session/update` → Octopal internal events.
//!
//! Pure translation layer. Does NOT emit Tauri events — that's the caller's
//! job (the caller owns `runId` / `folderPath` / `agentName` context that
//! doesn't belong in a JSON-RPC message).
//!
//! # Stream pipeline (ADR §6.3)
//! ```text
//! raw stdout chunk
//!      ↓
//! [1] line buffer / JSON parse            (AcpClient reader)
//!      ↓
//! [2] translate_notification              ← this module
//!      ↓
//! [3] tool name normalize map             ← this module
//!      ↓
//! [4] Tauri emit with runId/folder/agent  (agent.rs, stage 5)
//! ```
//!
//! # Event shapes handled
//! ACP v1 `session/update` params carry a `sessionUpdate.sessionUpdate`
//! discriminator. Known variants and their Octopal mapping:
//!
//! | ACP variant            | Mapped event(s)                                  |
//! |------------------------|--------------------------------------------------|
//! | `agentMessageChunk`    | `AssistantTextChunk` (+ `Activity("Writing…")` on first chunk) |
//! | `agentThoughtChunk`    | `AssistantThoughtChunk` (+ `Activity("Thinking…")` on first chunk) |
//! | `toolCall`             | `Activity(label)` + optional `ActivityLog`       |
//! | `toolCallUpdate`       | `Activity(label)` when status/title changes      |
//! | `plan` / `availableCommandsUpdate` / `currentModeUpdate` | ignored (informational, no UI contract) |
//!
//! `session/request_permission` is an incoming **request** (has `id`), not
//! a notification, so it takes a separate mapper path — see
//! [`translate_permission_request`].
//!
//! # Why the mapper is stateless
//! ACP doesn't send "message start" / "message end" framing for text —
//! chunks just arrive until the `session/prompt` response resolves. The
//! "Writing response…" / "Thinking…" activity labels want to fire only
//! once per run, not per chunk, but that's *run*-scoped state which
//! belongs on the caller (agent.rs) not in a per-notification translator.
//! So we emit the activity hint on **every** chunk and let the caller
//! dedupe via `run_id`. Simpler contract, fewer bugs.

use serde_json::Value;

// ── Normalized tool name (agent.rs:900 compatibility) ────────────────

/// Octopal's canonical tool names, matching what agent.rs uses for
/// `activity:log` and permission checks. Goose-side names like
/// `developer__shell` map into these.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NormalizedTool {
    Bash,
    Edit,
    Write,
    Read,
    Grep,
    Glob,
    WebFetch,
    /// Unknown/unmapped Goose tool. Preserves the original name so it
    /// still renders something useful in the UI and is grep-able in logs.
    /// Unknown tools should NOT trigger a backup snapshot — agent.rs only
    /// snapshots for the four canonical write/edit/bash/fetch names.
    Passthrough(String),
}

impl NormalizedTool {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Bash => "Bash",
            Self::Edit => "Edit",
            Self::Write => "Write",
            Self::Read => "Read",
            Self::Grep => "Grep",
            Self::Glob => "Glob",
            Self::WebFetch => "WebFetch",
            Self::Passthrough(s) => s.as_str(),
        }
    }

    /// True when the tool warrants a backup snapshot + `activity:log`
    /// record. Matches agent.rs:898 — only Write/Edit/Bash/WebFetch.
    pub fn is_logged(&self) -> bool {
        matches!(self, Self::Bash | Self::Edit | Self::Write | Self::WebFetch)
    }
}

/// Map a Goose tool identifier to an Octopal canonical tool.
///
/// Based on Goose's `developer` extension. When Goose ships new extensions
/// or renames tools, add a case here — the fallback `Passthrough` means
/// the UI still works, just with the raw name and no backup.
///
/// # Important
/// `developer__text_editor` is polymorphic — it's `Edit` for
/// `str_replace`/`undo_edit` and `Write` for `create`. The `input`
/// argument (the tool's `rawInput` field) is needed to disambiguate; when
/// it's missing we default to `Edit` because str_replace is the most
/// common case.
pub fn normalize_tool(goose_tool: &str, input: Option<&Value>) -> NormalizedTool {
    match goose_tool {
        "developer__shell" | "shell" => NormalizedTool::Bash,
        "developer__text_editor" | "text_editor" => {
            // Disambiguate create vs edit via the `command` sub-field.
            let cmd = input
                .and_then(|v| v.get("command"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if cmd == "create" {
                NormalizedTool::Write
            } else {
                NormalizedTool::Edit
            }
        }
        "developer__list_files" => NormalizedTool::Glob,
        "developer__search_files" | "developer__grep" => NormalizedTool::Grep,
        "developer__read_file" => NormalizedTool::Read,
        "developer__fetch" | "computercontroller__web_scrape" => NormalizedTool::WebFetch,
        other => NormalizedTool::Passthrough(other.to_string()),
    }
}

// ── Output events ──────────────────────────────────────────────────────

/// The internal events the caller re-emits as Tauri events. The caller
/// attaches run-scoped context (run_id, folder_path, agent_name) on the
/// way out — this enum stays context-free so the mapper is pure.
#[derive(Debug, Clone, PartialEq)]
pub enum MappedEvent {
    /// Human-readable progress label. Maps 1:1 to `octo:activity`.
    Activity { text: String },
    /// Persistent tool-invocation record. Maps 1:1 to `activity:log`.
    /// Only emitted for `NormalizedTool::is_logged()` tools.
    ActivityLog { tool: String, target: String },
    /// Chunk of assistant reply text. Caller accumulates for final_result.
    AssistantTextChunk { text: String },
    /// Chunk of assistant thinking/reasoning text. Distinct from assistant
    /// text because Octopal renders it in a separate "Thinking" UI block.
    AssistantThoughtChunk { text: String },
}

/// Incoming permission request mapped to the fields the resolver needs.
/// Stage 7 will consume this in the `session/request_permission` handler.
#[derive(Debug, Clone, PartialEq)]
pub struct PermissionRequest {
    pub tool_call_id: String,
    pub tool_name: String,
    /// Raw `options` array from the request — `[{optionId, name, kind}]`
    /// where `kind` is `allow_once` | `reject_once` | `allow_always` | `reject_always`.
    pub options: Value,
    /// The tool's input, passed straight through. Used by the resolver
    /// for allowPaths / denyPaths matching on Write/Edit targets.
    pub raw_input: Option<Value>,
}

// ── Main translation entry points ─────────────────────────────────────

/// Translate one `session/update` notification into zero or more Octopal
/// events. Unknown variants return an empty vec (not an error) — this
/// keeps future-compat: a new ACP variant arriving over the wire won't
/// crash the session, it'll just be silently dropped until we add a
/// handler. Debug-level logging (not UI-facing) happens at the caller.
pub fn translate_notification(notif: &Value) -> Vec<MappedEvent> {
    // Only `session/update` notifications carry stream updates. Other
    // methods go through their own mappers.
    if notif.get("method").and_then(|v| v.as_str()) != Some("session/update") {
        return Vec::new();
    }
    let Some(update) = notif.get("params").and_then(|p| p.get("update")) else {
        // Some agents emit the discriminator at the top of `params`
        // instead of nested under `update`. Accept both.
        let Some(params) = notif.get("params") else {
            return Vec::new();
        };
        return translate_update(params);
    };
    translate_update(update)
}

/// Translate a single `update` object (the `params.update` payload).
/// Public so unit tests can exercise the pure translation without
/// building the full JSON-RPC envelope every time.
pub fn translate_update(update: &Value) -> Vec<MappedEvent> {
    let Some(kind) = update.get("sessionUpdate").and_then(|v| v.as_str()) else {
        return Vec::new();
    };
    match kind {
        "agent_message_chunk" | "agentMessageChunk" => translate_message_chunk(update, false),
        "agent_thought_chunk" | "agentThoughtChunk" => translate_message_chunk(update, true),
        "tool_call" | "toolCall" => translate_tool_call(update),
        "tool_call_update" | "toolCallUpdate" => translate_tool_call_update(update),
        // Plan / available_commands_update / current_mode_update / user_message_chunk:
        // informational only, no UI contract in Octopal yet.
        _ => Vec::new(),
    }
}

/// Translate a `session/request_permission` *request* (not a notification).
/// Returns None if the request lacks the required fields — the caller
/// should then reject by default rather than allow.
pub fn translate_permission_request(req: &Value) -> Option<PermissionRequest> {
    let params = req.get("params")?;
    let tool_call = params.get("toolCall")?;
    let tool_call_id = tool_call
        .get("toolCallId")
        .and_then(|v| v.as_str())?
        .to_string();
    let tool_name = tool_call
        .get("title")
        .and_then(|v| v.as_str())
        .or_else(|| tool_call.get("kind").and_then(|v| v.as_str()))
        .unwrap_or("unknown")
        .to_string();
    let options = params
        .get("options")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let raw_input = tool_call.get("rawInput").cloned();
    Some(PermissionRequest {
        tool_call_id,
        tool_name,
        options,
        raw_input,
    })
}

// ── Per-variant translators ───────────────────────────────────────────

fn translate_message_chunk(update: &Value, is_thought: bool) -> Vec<MappedEvent> {
    // ACP text chunks use `content: { type: "text", text: "..." }` wrapper.
    // Some Goose builds nest it; others emit `text` directly on the update.
    // Handle both to stay resilient.
    let text = update
        .get("content")
        .and_then(|c| c.get("text"))
        .and_then(|v| v.as_str())
        .or_else(|| update.get("text").and_then(|v| v.as_str()))
        .unwrap_or("");
    if text.is_empty() {
        return Vec::new();
    }
    let activity_label = if is_thought {
        "Thinking…".to_string()
    } else {
        "Writing response…".to_string()
    };
    let chunk = if is_thought {
        MappedEvent::AssistantThoughtChunk { text: text.to_string() }
    } else {
        MappedEvent::AssistantTextChunk { text: text.to_string() }
    };
    vec![MappedEvent::Activity { text: activity_label }, chunk]
}

fn translate_tool_call(update: &Value) -> Vec<MappedEvent> {
    let tool_name_raw = update
        .get("title")
        .and_then(|v| v.as_str())
        .or_else(|| update.get("toolName").and_then(|v| v.as_str()))
        .unwrap_or("tool");
    let raw_input = update.get("rawInput");
    let normalized = normalize_tool(tool_name_raw, raw_input);
    let label = render_activity_label(&normalized, raw_input);

    let mut out = vec![MappedEvent::Activity { text: label }];
    if normalized.is_logged() {
        let target = render_activity_target(&normalized, raw_input);
        out.push(MappedEvent::ActivityLog {
            tool: normalized.as_str().to_string(),
            target,
        });
    }
    out
}

fn translate_tool_call_update(update: &Value) -> Vec<MappedEvent> {
    // Updates carry deltas like `status: "completed"` and `content: [...]`.
    // We only re-emit an activity label if `title` / `status` changed in a
    // user-visible way. Output tokens are not part of the ACP contract
    // here (they arrive via the final session/prompt response).
    let status = update.get("status").and_then(|v| v.as_str());
    let Some(status) = status else {
        return Vec::new();
    };
    let label = match status {
        "in_progress" => None, // already announced on tool_call
        "completed" => Some("Writing response…".to_string()),
        "failed" => Some("Tool failed".to_string()),
        _ => None,
    };
    label
        .map(|text| vec![MappedEvent::Activity { text }])
        .unwrap_or_default()
}

// ── Label/target rendering (matches agent.rs:860-919 behavior) ───────

/// Produce the short progress label shown in `octo:activity`. Deliberately
/// mirrors the v0.1.42 Claude-side formatting so the UI feels identical
/// across legacy and Goose runtimes.
fn render_activity_label(tool: &NormalizedTool, input: Option<&Value>) -> String {
    match tool {
        NormalizedTool::Bash => {
            let cmd = input
                .and_then(|v| v.get("command"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let head: String = cmd.chars().take(40).collect();
            if head.is_empty() {
                "Running Bash".to_string()
            } else {
                format!("Running: {head}")
            }
        }
        NormalizedTool::Grep => {
            let pat = input
                .and_then(|v| v.get("pattern"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let trunc: String = pat.chars().take(40).collect();
            format!("Searching for \"{trunc}\"")
        }
        NormalizedTool::Glob => {
            let pat = input
                .and_then(|v| v.get("pattern"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let trunc: String = pat.chars().take(40).collect();
            format!("Finding {trunc}")
        }
        NormalizedTool::Edit | NormalizedTool::Write | NormalizedTool::Read => {
            let fp = input
                .and_then(|v| v.get("path").or_else(|| v.get("file_path")))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let prefix = match tool {
                NormalizedTool::Edit => "Editing",
                NormalizedTool::Write => "Writing",
                NormalizedTool::Read => "Reading",
                _ => unreachable!(),
            };
            if fp.is_empty() {
                prefix.to_string()
            } else {
                format!("{prefix} {fp}")
            }
        }
        NormalizedTool::WebFetch => {
            let url = input
                .and_then(|v| v.get("url"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if url.is_empty() {
                "Fetching".to_string()
            } else {
                format!("Fetching {url}")
            }
        }
        NormalizedTool::Passthrough(name) => format!("Running {name}"),
    }
}

/// Produce the `target` field for `activity:log`. Matches agent.rs:898-918.
fn render_activity_target(tool: &NormalizedTool, input: Option<&Value>) -> String {
    match tool {
        NormalizedTool::Bash => input
            .and_then(|v| v.get("command"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .chars()
            .take(120)
            .collect(),
        NormalizedTool::Write | NormalizedTool::Edit => input
            .and_then(|v| v.get("path").or_else(|| v.get("file_path")))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        NormalizedTool::WebFetch => input
            .and_then(|v| v.get("url"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        _ => String::new(),
    }
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Tool name normalization ------------------------------------------

    #[test]
    fn normalize_shell_to_bash() {
        assert_eq!(normalize_tool("developer__shell", None), NormalizedTool::Bash);
        assert_eq!(normalize_tool("shell", None), NormalizedTool::Bash);
    }

    #[test]
    fn normalize_text_editor_is_polymorphic() {
        let write_input = json!({"command": "create", "path": "/tmp/x"});
        let edit_input = json!({"command": "str_replace", "path": "/tmp/x"});
        assert_eq!(
            normalize_tool("developer__text_editor", Some(&write_input)),
            NormalizedTool::Write
        );
        assert_eq!(
            normalize_tool("developer__text_editor", Some(&edit_input)),
            NormalizedTool::Edit
        );
        // Missing input → default Edit (str_replace is the common case).
        assert_eq!(
            normalize_tool("developer__text_editor", None),
            NormalizedTool::Edit
        );
    }

    #[test]
    fn normalize_unknown_passes_through() {
        let t = normalize_tool("memory__upsert", None);
        match t {
            NormalizedTool::Passthrough(s) => assert_eq!(s, "memory__upsert"),
            _ => panic!("expected passthrough"),
        }
    }

    #[test]
    fn passthrough_does_not_log() {
        let t = normalize_tool("weird_ext__thing", None);
        assert!(!t.is_logged());
    }

    // agent_message_chunk ----------------------------------------------

    #[test]
    fn agent_message_chunk_yields_activity_plus_text() {
        let update = json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "Hello " }
        });
        let events = translate_update(&update);
        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0],
            MappedEvent::Activity { text } if text == "Writing response…"
        ));
        assert!(matches!(
            &events[1],
            MappedEvent::AssistantTextChunk { text } if text == "Hello "
        ));
    }

    #[test]
    fn empty_text_chunk_is_dropped() {
        let update = json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "" }
        });
        assert!(translate_update(&update).is_empty());
    }

    #[test]
    fn agent_thought_chunk_yields_thinking_label() {
        let update = json!({
            "sessionUpdate": "agent_thought_chunk",
            "content": { "type": "text", "text": "pondering..." }
        });
        let events = translate_update(&update);
        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0],
            MappedEvent::Activity { text } if text == "Thinking…"
        ));
        assert!(matches!(
            &events[1],
            MappedEvent::AssistantThoughtChunk { text } if text == "pondering..."
        ));
    }

    #[test]
    fn chunk_accepts_flat_text_field() {
        // Defensive: some Goose builds may emit `text` flat on the update.
        let update = json!({
            "sessionUpdate": "agentMessageChunk",
            "text": "flat shape"
        });
        let events = translate_update(&update);
        assert!(matches!(
            &events[1],
            MappedEvent::AssistantTextChunk { text } if text == "flat shape"
        ));
    }

    // tool_call --------------------------------------------------------

    #[test]
    fn tool_call_bash_emits_label_and_log() {
        let update = json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "tc_1",
            "title": "developer__shell",
            "rawInput": { "command": "ls -la /tmp" }
        });
        let events = translate_update(&update);
        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0],
            MappedEvent::Activity { text } if text.starts_with("Running: ls -la")
        ));
        match &events[1] {
            MappedEvent::ActivityLog { tool, target } => {
                assert_eq!(tool, "Bash");
                assert!(target.starts_with("ls -la /tmp"));
            }
            _ => panic!("expected ActivityLog"),
        }
    }

    #[test]
    fn tool_call_grep_label_has_pattern() {
        let update = json!({
            "sessionUpdate": "tool_call",
            "title": "developer__search_files",
            "rawInput": { "pattern": "TODO" }
        });
        let events = translate_update(&update);
        assert!(matches!(
            &events[0],
            MappedEvent::Activity { text } if text == "Searching for \"TODO\""
        ));
        // Grep is NOT in the logged set (matches agent.rs:898).
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn tool_call_text_editor_create_logs_as_write() {
        let update = json!({
            "sessionUpdate": "tool_call",
            "title": "developer__text_editor",
            "rawInput": { "command": "create", "path": "/tmp/new.txt" }
        });
        let events = translate_update(&update);
        match &events[1] {
            MappedEvent::ActivityLog { tool, target } => {
                assert_eq!(tool, "Write");
                assert_eq!(target, "/tmp/new.txt");
            }
            _ => panic!("expected ActivityLog(Write)"),
        }
    }

    #[test]
    fn tool_call_unknown_yields_only_label_no_log() {
        let update = json!({
            "sessionUpdate": "tool_call",
            "title": "memory__upsert",
            "rawInput": { "key": "foo", "value": "bar" }
        });
        let events = translate_update(&update);
        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            MappedEvent::Activity { text } if text == "Running memory__upsert"
        ));
    }

    // tool_call_update --------------------------------------------------

    #[test]
    fn tool_call_update_completed_signals_writing() {
        let update = json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "tc_1",
            "status": "completed"
        });
        let events = translate_update(&update);
        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            MappedEvent::Activity { text } if text == "Writing response…"
        ));
    }

    #[test]
    fn tool_call_update_in_progress_is_silent() {
        let update = json!({
            "sessionUpdate": "tool_call_update",
            "status": "in_progress"
        });
        assert!(translate_update(&update).is_empty());
    }

    #[test]
    fn tool_call_update_failed_surfaces_error_label() {
        let update = json!({
            "sessionUpdate": "tool_call_update",
            "status": "failed"
        });
        let events = translate_update(&update);
        assert!(matches!(
            &events[0],
            MappedEvent::Activity { text } if text == "Tool failed"
        ));
    }

    // envelope handling ------------------------------------------------

    #[test]
    fn translate_notification_extracts_nested_update() {
        let notif = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "s1",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "hi" }
                }
            }
        });
        let events = translate_notification(&notif);
        assert_eq!(events.len(), 2);
    }

    #[test]
    fn translate_notification_handles_flat_params() {
        // Defensive: some builds put sessionUpdate at the top of params.
        let notif = json!({
            "method": "session/update",
            "params": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "flat" }
            }
        });
        assert_eq!(translate_notification(&notif).len(), 2);
    }

    #[test]
    fn translate_notification_ignores_non_update_methods() {
        let notif = json!({
            "method": "session/something_else",
            "params": {}
        });
        assert!(translate_notification(&notif).is_empty());
    }

    #[test]
    fn unknown_session_update_variant_is_dropped() {
        // Future-compat: a new ACP variant should not crash the mapper.
        let update = json!({
            "sessionUpdate": "some_future_variant",
            "foo": "bar"
        });
        assert!(translate_update(&update).is_empty());
    }

    // permission request -----------------------------------------------

    #[test]
    fn permission_request_extracts_tool_and_options() {
        let req = json!({
            "method": "session/request_permission",
            "id": 42,
            "params": {
                "sessionId": "s1",
                "toolCall": {
                    "toolCallId": "tc_1",
                    "title": "developer__shell",
                    "rawInput": { "command": "rm -rf /" }
                },
                "options": [
                    {"optionId": "allow_once", "name": "Allow", "kind": "allow_once"},
                    {"optionId": "reject_once", "name": "Reject", "kind": "reject_once"}
                ]
            }
        });
        let pr = translate_permission_request(&req).unwrap();
        assert_eq!(pr.tool_call_id, "tc_1");
        assert_eq!(pr.tool_name, "developer__shell");
        assert!(pr.options.as_array().unwrap().len() == 2);
        let ri = pr.raw_input.unwrap();
        assert_eq!(
            ri.get("command").and_then(|v| v.as_str()),
            Some("rm -rf /")
        );
    }

    #[test]
    fn permission_request_missing_tool_returns_none() {
        let req = json!({
            "method": "session/request_permission",
            "params": { "sessionId": "s1" }
        });
        assert!(translate_permission_request(&req).is_none());
    }
}
