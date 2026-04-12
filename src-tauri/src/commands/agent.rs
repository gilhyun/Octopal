use crate::state::ManagedState;
use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::Stdio;
use tauri::{AppHandle, Emitter, State};

use super::claude_cli::claude_command;

#[cfg(unix)]
extern crate libc;

/// Defense-in-depth: strip control characters (newlines, tabs, etc.) from any
/// string before interpolating it into a system prompt. This prevents prompt
/// injection even if upstream sanitization is bypassed (e.g. hand-edited .octo files).
pub fn sanitize_prompt_field(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ")
}

#[derive(Clone, Serialize)]
struct ActivityEvent {
    #[serde(rename = "runId")]
    run_id: String,
    text: String,
    #[serde(rename = "folderPath")]
    folder_path: String,
    #[serde(rename = "agentName")]
    agent_name: String,
}

#[derive(Clone, Serialize)]
struct ActivityLogEvent {
    #[serde(rename = "folderPath")]
    folder_path: String,
    #[serde(rename = "agentName")]
    agent_name: String,
    tool: String,
    target: String,
    ts: u64,
    #[serde(rename = "backupId", skip_serializing_if = "Option::is_none")]
    backup_id: Option<String>,
    #[serde(rename = "conflictWith", skip_serializing_if = "Option::is_none")]
    conflict_with: Option<crate::commands::file_lock::LockHolder>,
}

#[derive(Clone, Serialize)]
struct UsageEvent {
    #[serde(rename = "runId")]
    run_id: String,
    usage: UsageData,
}

#[derive(Clone, Serialize)]
struct UsageData {
    #[serde(rename = "inputTokens")]
    input_tokens: u64,
    #[serde(rename = "outputTokens")]
    output_tokens: u64,
    #[serde(rename = "cacheReadTokens", skip_serializing_if = "Option::is_none")]
    cache_read_tokens: Option<u64>,
    #[serde(rename = "cacheCreationTokens", skip_serializing_if = "Option::is_none")]
    cache_creation_tokens: Option<u64>,
    #[serde(rename = "costUsd", skip_serializing_if = "Option::is_none")]
    cost_usd: Option<f64>,
    #[serde(rename = "durationMs", skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
}

#[derive(Serialize)]
pub struct SendResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct StopResult {
    pub ok: bool,
    pub stopped: Option<bool>,
}

#[derive(Serialize)]
pub struct StopAllResult {
    pub ok: bool,
    pub stopped: u32,
}

/// Check if claude CLI is installed and logged in
#[tauri::command]
pub async fn check_claude_cli() -> Result<serde_json::Value, String> {
    let output = claude_command()
        .arg("--version")
        .output();

    match output {
        Ok(out) if out.status.success() => {
            Ok(serde_json::json!({ "installed": true, "loggedIn": true }))
        }
        _ => Ok(serde_json::json!({ "installed": false, "loggedIn": false })),
    }
}

/// Send a message to an agent via the claude CLI
#[tauri::command]
pub async fn send_message(
    folder_path: String,
    octo_path: String,
    prompt: String,
    user_ts: f64,
    run_id: String,
    peers: Option<Vec<serde_json::Value>>,
    collaborators: Option<Vec<serde_json::Value>>,
    is_leader: Option<bool>,
    image_paths: Option<Vec<String>>,
    text_paths: Option<Vec<String>>,
    model: Option<String>,
    app: AppHandle,
    state: State<'_, ManagedState>,
) -> Result<SendResult, String> {
    let folder = Path::new(&folder_path);
    if !folder.is_dir() {
        return Ok(SendResult {
            ok: false,
            output: None,
            error: Some("Invalid folder path".to_string()),
        });
    }

    // Read the octo file
    let octo_content: serde_json::Value = {
        let content = fs::read_to_string(&octo_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())?
    };

    let agent_name = octo_content
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("assistant")
        .to_string();

    // Isolated mode — this agent doesn't see peers or room history, and
    // can't emit handoff tags. Used for heavy single-shot research agents.
    let is_isolated = octo_content
        .get("isolated")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // Build system prompt
    let mut system_parts: Vec<String> = vec![];

    system_parts.push("You are a \".octo\" file: a JSON file on disk that stores your name, role, memory, and conversation history.".to_string());

    if let Some(role) = octo_content.get("role").and_then(|v| v.as_str()) {
        system_parts.push(format!("\nYour role: {}", sanitize_prompt_field(role)));
    }
    system_parts.push(format!("Your name: {}", agent_name));

    // Memory
    if let Some(memory) = octo_content.get("memory").and_then(|v| v.as_array()) {
        if !memory.is_empty() {
            system_parts.push("\nSaved memory:".to_string());
            for (i, m) in memory.iter().enumerate() {
                if let Some(text) = m.as_str() {
                    system_parts.push(format!("{}. {}", i + 1, text));
                }
            }
        }
    }

    // Wiki
    {
        let s = state.app_state.lock().map_err(|e| e.to_string())?;
        if let Some(ws) = s.workspaces.iter().find(|w| w.folders.contains(&folder_path)) {
            let wiki_dir = state.wiki_dir(&ws.id);
            fs::create_dir_all(&wiki_dir).ok();
            let pages: Vec<String> = fs::read_dir(&wiki_dir)
                .ok()
                .map(|rd| {
                    rd.flatten()
                        .filter_map(|e| {
                            let name = e.file_name().to_string_lossy().to_string();
                            if name.ends_with(".md") {
                                Some(name)
                            } else {
                                None
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();
            let page_list = if pages.is_empty() {
                "(none yet)".to_string()
            } else {
                pages.join(", ")
            };
            system_parts.push(format!(
                "\nWorkspace wiki — shared notes for the team:\n- Path: {}\n- Pages: {}\n- Read: use Read tool with absolute path. Write/Edit: same, .md files only.",
                wiki_dir.display(),
                page_list
            ));
        }
    }

    // Peers (sanitize name/role at injection point as defense-in-depth).
    // Skipped entirely when this agent is isolated — it works alone.
    if !is_isolated {
        if let Some(peer_list) = &peers {
            if !peer_list.is_empty() {
                system_parts.push("\nYou are in a group chat with these other agents:".to_string());
                for p in peer_list {
                    let pname = sanitize_prompt_field(p.get("name").and_then(|v| v.as_str()).unwrap_or("?"));
                    let prole = sanitize_prompt_field(p.get("role").and_then(|v| v.as_str()).unwrap_or("assistant"));
                    system_parts.push(format!("- @{}: {}", pname, prole));
                }
            }
        }
    }

    // Collaboration mode — isolated agents never collaborate
    if !is_isolated && is_leader == Some(true) {
        if let Some(collabs) = &collaborators {
            if !collabs.is_empty() {
                let collab_list: Vec<String> = collabs
                    .iter()
                    .map(|c| {
                        let n = sanitize_prompt_field(c.get("name").and_then(|v| v.as_str()).unwrap_or("?"));
                        let r = sanitize_prompt_field(c.get("role").and_then(|v| v.as_str()).unwrap_or("assistant"));
                        format!("- @{} ({})", n, r)
                    })
                    .collect();
                system_parts.push(format!(
                    "\n=== COLLABORATION MODE ===\nYou are the LEAD. Teammates:\n{}",
                    collab_list.join("\n")
                ));
            }
        }
    }

    // Auto-delegation: self-assessment instructions. Isolated agents don't
    // learn about the handoff protocol at all — they're single-shot.
    if !is_isolated {
    if let Some(peer_list) = &peers {
        if !peer_list.is_empty() {
            let peer_summary: Vec<String> = peer_list
                .iter()
                .map(|p| {
                    let pname = sanitize_prompt_field(p.get("name").and_then(|v| v.as_str()).unwrap_or("?"));
                    let prole = sanitize_prompt_field(p.get("role").and_then(|v| v.as_str()).unwrap_or("assistant"));
                    format!("@{} ({})", pname, prole)
                })
                .collect();
            system_parts.push(format!(
                "\n=== HANDOFF PROTOCOL ===\n\
                Before starting any task, assess:\n\
                1. Does this task match MY expertise ({name} — {role})?\n\
                2. Is there a better-suited agent among my peers?\n\
                \n\
                If the task clearly belongs to another agent's domain, you can hand it off by ending your reply with a <HANDOFF> tag. The user will be asked to approve, and the target agent will be invoked with the full context.\n\
                \n\
                Format (put this at the END of your reply, one per target):\n\
                <HANDOFF target=\"<peer_name>\" reason=\"<one-line why>\" />\n\
                \n\
                Important rules:\n\
                - The <HANDOFF> tag is the ONLY way to delegate — a free `@mention` in prose is just a reference and will NOT trigger a chain.\n\
                - `target` MUST exactly match one of the peer names below (case-insensitive).\n\
                - Only emit a <HANDOFF> tag when the target REALLY needs to act — don't CC people for no reason.\n\
                - Small/trivial tasks: just do them, don't over-delegate.\n\
                - Partial match (your domain + another's): handle YOUR part, then emit a <HANDOFF> for the rest.\n\
                - Clearly outside your expertise: emit <HANDOFF> immediately with a clear reason.\n\
                - Include the actual work/answer in the prose BEFORE the tag — the tag is just the routing instruction.\n\
                - You can emit multiple <HANDOFF> tags if multiple agents should be involved in parallel.\n\
                \n\
                Example end of reply:\n\
                \"I've added the API endpoint and wired it up. The frontend side still needs the new form — that's designer territory.\n\
                <HANDOFF target=\"designer\" reason=\"build the form UI for the new /api/foo endpoint\" />\"\n\
                \n\
                Available peers: {peers}",
                name = sanitize_prompt_field(&agent_name),
                role = sanitize_prompt_field(octo_content.get("role").and_then(|v| v.as_str()).unwrap_or("assistant")),
                peers = peer_summary.join(", ")
            ));
        }
    }
    } // end: !is_isolated wrapper for the handoff protocol block

    // Recent conversation — shared across the WHOLE room, not per-agent.
    //
    // Historical note: Octopal used to feed each agent only its own .octo
    // history. That siloed every agent: if @developer answered a question,
    // @designer would never see it on its next turn, making group chats
    // feel choppy ("the other agent doesn't know what just happened").
    //
    // Now every non-isolated agent reads the shared `.octopal/room-history.json`
    // and sees every turn in the room, self-tagged with "(me)" so it knows
    // which lines it wrote itself. This is how AutoGen GroupChat and the
    // OpenAI Agents SDK share context by default — there's no reason to
    // reinvent isolation here.
    //
    // Budget packing: we pack from newest to oldest, include each message
    // whole if it fits, and truncate the boundary message with "[…]" so
    // the model knows something was cut. ~8000 chars ≈ 2000 tokens.
    //
    // Noise filters:
    //   - `__dispatcher__` / `__system__` pseudo-agents (UI-only events)
    //   - Empty / whitespace-only messages
    //   - The CURRENT user turn (already on its way in as the prompt arg —
    //     including it in history too would confuse claude about what's new)
    //
    // Isolated agents skip this entirely — they're single-shot workers.
    const RECENT_HISTORY_CHAR_BUDGET: usize = 8000;
    const HARD_PER_MESSAGE_CAP: usize = 2000;

    if !is_isolated {
        let room_history_path = Path::new(&folder_path)
            .join(".octopal")
            .join("room-history.json");

        let all_msgs: Vec<serde_json::Value> = fs::read_to_string(&room_history_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        if !all_msgs.is_empty() {
            // Skip the tail user message if it's the one being processed
            // right now (appendUserMessage writes BEFORE send_message runs).
            let current_prompt_trimmed = prompt.trim();
            let skip_last = all_msgs.last().map(|m| {
                let is_user = m
                    .get("agentName")
                    .and_then(|v| v.as_str())
                    == Some("user");
                let text_matches = m
                    .get("text")
                    .and_then(|v| v.as_str())
                    .map(|t| {
                        let t_trim = t.trim();
                        !t_trim.is_empty()
                            && (current_prompt_trimmed == t_trim
                                || current_prompt_trimmed.contains(t_trim))
                    })
                    .unwrap_or(false);
                is_user && text_matches
            }).unwrap_or(false);

            let take_len = if skip_last {
                all_msgs.len().saturating_sub(1)
            } else {
                all_msgs.len()
            };

            let mut included: Vec<(String, String)> = Vec::new();
            let mut used_chars: usize = 0;

            for msg in all_msgs[..take_len].iter().rev() {
                let speaker = msg
                    .get("agentName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");

                // Drop UI-only pseudo-agents — dispatcher animations,
                // system bundle notices, interrupt confirmation bubbles.
                if speaker == "__dispatcher__" || speaker == "__system__" {
                    continue;
                }

                let text = msg
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if text.trim().is_empty() {
                    continue;
                }

                // Tag the speaker. "(me)" for the current agent's own
                // past turns, plain name for user and peers.
                let label = if speaker == agent_name {
                    format!("{} (me)", speaker)
                } else {
                    speaker.to_string()
                };

                // Per-message hard cap so a single giant paste can't
                // monopolize the budget.
                let capped: String = if text.chars().count() > HARD_PER_MESSAGE_CAP {
                    let head: String = text.chars().take(HARD_PER_MESSAGE_CAP).collect();
                    format!("{}[…]", head)
                } else {
                    text
                };

                let msg_len = capped.chars().count() + label.chars().count() + 4;
                if used_chars + msg_len > RECENT_HISTORY_CHAR_BUDGET {
                    let remaining = RECENT_HISTORY_CHAR_BUDGET.saturating_sub(used_chars);
                    if remaining > 80 {
                        let tail_chars = remaining - 40;
                        let start = capped.chars().count().saturating_sub(tail_chars);
                        let tail: String = capped.chars().skip(start).collect();
                        included.push((label, format!("[…] {}", tail)));
                    }
                    break;
                }

                used_chars += msg_len;
                included.push((label, capped));
            }

            if !included.is_empty() {
                system_parts.push(format!(
                    "\nRecent conversation in this room (you are @{name}):",
                    name = agent_name
                ));
                system_parts.push(
                    "Lines tagged \"(me)\" are your own earlier turns. Lines with other agents' names are peers speaking in the same room — you can reference what they said. Use this as context for your reply, but don't parrot back what's already been said."
                        .to_string(),
                );
                // We packed newest-first; flip back to chronological order.
                for (label, text) in included.into_iter().rev() {
                    system_parts.push(format!("[{}]: {}", label, text));
                }
            }
        }
    }

    // Permissions
    let perms = octo_content.get("permissions");
    let has_active_perms = perms
        .map(|p| {
            p.get("fileWrite").and_then(|v| v.as_bool()).unwrap_or(false)
                || p.get("bash").and_then(|v| v.as_bool()).unwrap_or(false)
                || p.get("network").and_then(|v| v.as_bool()).unwrap_or(false)
        })
        .unwrap_or(false);

    // Build claude args
    let mut claude_args: Vec<String> = vec![
        "-p".to_string(),
        "--print".to_string(),
        "--verbose".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
    ];

    // MCP config — always include, even if empty (matches Electron behavior)
    let mcp_config = if let Some(mcp) = octo_content.get("mcpServers") {
        if mcp.is_object() && !mcp.as_object().unwrap().is_empty() {
            serde_json::json!({ "mcpServers": mcp })
        } else {
            serde_json::json!({ "mcpServers": {} })
        }
    } else {
        serde_json::json!({ "mcpServers": {} })
    };
    claude_args.push("--mcp-config".to_string());
    claude_args.push(mcp_config.to_string());

    // Model — extract settings values in a block to avoid holding MutexGuard across await
    {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        let auto_model = settings.advanced.auto_model_selection;
        let allowed = ["haiku", "sonnet", "opus"];
        if auto_model {
            if let Some(ref m) = model {
                if allowed.contains(&m.as_str()) {
                    claude_args.push("--model".to_string());
                    claude_args.push(m.clone());
                }
            }
        } else {
            let default_model = &settings.advanced.default_agent_model;
            let m = if allowed.contains(&default_model.as_str()) {
                default_model.clone()
            } else {
                "opus".to_string()
            };
            claude_args.push("--model".to_string());
            claude_args.push(m);
        }
    } // settings guard dropped here

    // Permissions args — if any grant is set, use --dangerously-skip-permissions
    // and selectively block the ungranted tools. If no grants at all, claude's
    // default permission prompts still apply (the agent just can't do much).
    if has_active_perms {
        claude_args.push("--dangerously-skip-permissions".to_string());
        if let Some(p) = perms {
            if p.get("bash").and_then(|v| v.as_bool()) != Some(true) {
                claude_args.push("--disallowed-tools".to_string());
                claude_args.push("Bash".to_string());
            }
            if p.get("fileWrite").and_then(|v| v.as_bool()) != Some(true) {
                claude_args.push("--disallowed-tools".to_string());
                claude_args.push("Write".to_string());
                claude_args.push("--disallowed-tools".to_string());
                claude_args.push("Edit".to_string());
            }
            // Network permission — gates WebFetch. Previously read but not
            // enforced, which meant `"network": false` in a .octo file was a
            // silent lie. Now actually blocks the tool.
            if p.get("network").and_then(|v| v.as_bool()) != Some(true) {
                claude_args.push("--disallowed-tools".to_string());
                claude_args.push("WebFetch".to_string());
            }
        }
    }

    // Capabilities info
    let mut capabilities: Vec<&str> = vec![];
    if has_active_perms {
        if let Some(p) = perms {
            if p.get("fileWrite").and_then(|v| v.as_bool()) == Some(true) {
                capabilities.push("write and edit files");
            }
            if p.get("bash").and_then(|v| v.as_bool()) == Some(true) {
                capabilities.push("run shell commands");
            }
            if p.get("network").and_then(|v| v.as_bool()) == Some(true) {
                capabilities.push("make web requests");
            }
        }
    }
    let cap_line = if !capabilities.is_empty() {
        format!(
            "\n\nYou have permission to: {}. Use these tools when the user or a peer asks you to do something concrete.",
            capabilities.join(", ")
        )
    } else {
        [
            "",
            "",
            "You do NOT have permission to write files, run shell commands, or access the network. Answer with text only.",
            "If the user asks you to do something that requires these tools, briefly explain what you need and then output a permission request tag at the END of your message in this exact format:",
            "<!--NEEDS_PERMISSIONS: fileWrite, bash, network-->",
            "Only include the specific permissions you actually need (fileWrite for writing/editing files, bash for running shell commands, network for web access). The app will show the user a button to grant these permissions directly.",
            "Example: if the user asks you to create a file, say you need file write permission and end with <!--NEEDS_PERMISSIONS: fileWrite-->",
            "Example: if the user asks you to run a build, you need bash permission: <!--NEEDS_PERMISSIONS: bash-->",
            "Example: if you need multiple permissions: <!--NEEDS_PERMISSIONS: fileWrite, bash-->",
        ]
        .join("\n")
    };

    claude_args.push("--system-prompt".to_string());
    claude_args.push(format!(
        "{}{}\n\nWorking folder: {}",
        system_parts.join("\n"),
        cap_line,
        folder_path
    ));

    // Attachments — use absolute paths with @ references so Claude CLI
    // can read and include them as vision/text content blocks.
    let mut final_prompt = prompt.clone();
    let mut image_refs: Vec<String> = vec![];
    let mut text_refs: Vec<String> = vec![];
    if let Some(imgs) = &image_paths {
        for img in imgs {
            let abs = Path::new(&folder_path).join(img);
            if abs.exists() {
                // Use absolute path for reliable file resolution in -p mode
                image_refs.push(abs.to_string_lossy().to_string());
            }
        }
    }
    if let Some(txts) = &text_paths {
        for txt in txts {
            let abs = Path::new(&folder_path).join(txt);
            if abs.exists() {
                text_refs.push(abs.to_string_lossy().to_string());
            }
        }
    }
    // Add image files via @ reference with absolute paths
    let mut all_refs: Vec<String> = vec![];
    for img_path in &image_refs {
        all_refs.push(format!("@{}", img_path));
    }
    for txt_path in &text_refs {
        all_refs.push(format!("@{}", txt_path));
    }
    if !all_refs.is_empty() {
        final_prompt = format!("{}\n\n{}", all_refs.join(" "), prompt);
    }
    claude_args.push(final_prompt.clone());

    // Emit activity
    let _ = app.emit("octo:activity", ActivityEvent {
        run_id: run_id.clone(),
        text: "Thinking…".to_string(),
        folder_path: folder_path.clone(),
        agent_name: agent_name.clone(),
    });

    // Spawn claude CLI
    let run_id_clone = run_id.clone();
    let app_clone = app.clone();
    let folder_clone = folder_path.clone();
    let agent_name_clone = agent_name.clone();
    let state_agents = state.running_agents.clone();
    let state_interrupted = state.interrupted_runs.clone();
    let backup_tracker = state.backup_tracker.clone();
    let file_lock_manager = state.file_lock_manager.clone();

    // Opportunistic prune of old backups for this folder. Cheap if there's
    // nothing to do; runs once per send_message. Reads retention limits up
    // front so the spawned thread doesn't need access to ManagedState.
    {
        let prune_folder = folder_path.clone();
        let (max_count, max_age) = {
            let s = state.settings.lock().map_err(|e| e.to_string())?;
            (
                s.backup.max_backups_per_workspace as usize,
                s.backup.max_age_days as u64,
            )
        };
        std::thread::spawn(move || {
            let _ = crate::commands::backup::prune_with_limits(
                &prune_folder,
                max_count,
                max_age,
            );
        });
    }

    let result = tokio::task::spawn_blocking(move || {
        // GUI apps on macOS don't inherit shell PATH, and `claude`'s shebang
        // relies on `env node` — `claude_command()` handles both.
        let mut child = claude_command()
            .args(&claude_args)
            .current_dir(&folder_clone)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()) // Capture stderr to diagnose errors
            .stdin(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to spawn claude: {}", e))?;

        // Read stderr in a separate thread to avoid deadlock
        let stderr = child.stderr.take().unwrap();
        let stderr_handle = std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            let mut stderr_output = String::new();
            for line in reader.lines() {
                if let Ok(l) = line {
                    if stderr_output.len() < 8192 {
                        stderr_output.push_str(&l);
                        stderr_output.push('\n');
                    }
                }
            }
            stderr_output
        });

        // Store PID so stop_agent can kill it
        let pid = child.id();
        state_agents.lock().unwrap().insert(run_id_clone.clone(), pid);

        let stdout = child.stdout.take().unwrap();
        let reader = BufReader::new(stdout);

        let mut final_result = String::new();

        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) {
                // Handle assistant events (tool use, text)
                if event.get("type").and_then(|v| v.as_str()) == Some("assistant") {
                    if let Some(content) = event
                        .get("message")
                        .and_then(|m| m.get("content"))
                        .and_then(|c| c.as_array())
                    {
                        for block in content {
                            if block.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                                let tool = block
                                    .get("name")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("tool");
                                let input = block.get("input").cloned().unwrap_or_default();
                                let label = match tool {
                                    "Bash" => {
                                        let cmd = input
                                            .get("command")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        let trunc: String = cmd.chars().take(80).collect();
                                        format!("Running: {}", trunc)
                                    }
                                    "Write" => {
                                        let fp = input
                                            .get("file_path")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        let basename =
                                            Path::new(fp).file_name().unwrap_or_default();
                                        format!("Writing {}", basename.to_string_lossy())
                                    }
                                    "Edit" => {
                                        let fp = input
                                            .get("file_path")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        let basename =
                                            Path::new(fp).file_name().unwrap_or_default();
                                        format!("Editing {}", basename.to_string_lossy())
                                    }
                                    "Read" => {
                                        let fp = input
                                            .get("file_path")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        let basename =
                                            Path::new(fp).file_name().unwrap_or_default();
                                        format!("Reading {}", basename.to_string_lossy())
                                    }
                                    "Grep" => {
                                        let pat = input
                                            .get("pattern")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        let trunc: String = pat.chars().take(40).collect();
                                        format!("Searching for \"{}\"", trunc)
                                    }
                                    "Glob" => {
                                        let pat = input
                                            .get("pattern")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        let trunc: String = pat.chars().take(40).collect();
                                        format!("Finding {}", trunc)
                                    }
                                    _ => tool.to_string(),
                                };

                                let _ = app_clone.emit(
                                    "octo:activity",
                                    ActivityEvent {
                                        run_id: run_id_clone.clone(),
                                        text: label,
                                        folder_path: folder_clone.clone(),
                                        agent_name: agent_name_clone.clone(),
                                    },
                                );

                                // Log meaningful tool uses
                                if matches!(tool, "Write" | "Edit" | "Bash" | "WebFetch") {
                                    let target = match tool {
                                        "Bash" => input
                                            .get("command")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .chars()
                                            .take(120)
                                            .collect(),
                                        "Write" | "Edit" => input
                                            .get("file_path")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .to_string(),
                                        "WebFetch" => input
                                            .get("url")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .to_string(),
                                        _ => String::new(),
                                    };

                                    // For Write/Edit, snapshot the file (if first
                                    // touch in this run) and check for cross-run
                                    // lock conflicts. The snapshot races claude's
                                    // own write, but in practice the JSON tool_use
                                    // event reaches us before the disk write
                                    // resolves for the typical small-file case —
                                    // good enough for the safety net.
                                    let mut backup_id: Option<String> = None;
                                    let mut conflict_with: Option<
                                        crate::commands::file_lock::LockHolder,
                                    > = None;
                                    if matches!(tool, "Write" | "Edit") {
                                        let fp = input
                                            .get("file_path")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        if !fp.is_empty() {
                                            // Resolve to absolute for the lock key
                                            let abs_path = if Path::new(fp).is_absolute() {
                                                std::path::PathBuf::from(fp)
                                            } else {
                                                Path::new(&folder_clone).join(fp)
                                            };
                                            if let Err(existing) = file_lock_manager
                                                .try_acquire(
                                                    abs_path.clone(),
                                                    &run_id_clone,
                                                    &agent_name_clone,
                                                )
                                            {
                                                conflict_with = Some(existing);
                                            }
                                            backup_id = backup_tracker.snapshot(
                                                Path::new(&folder_clone),
                                                &run_id_clone,
                                                &agent_name_clone,
                                                fp,
                                            );
                                        }
                                    }

                                    let _ = app_clone.emit(
                                        "activity:log",
                                        ActivityLogEvent {
                                            folder_path: folder_clone.clone(),
                                            agent_name: agent_name_clone.clone(),
                                            tool: tool.to_string(),
                                            target,
                                            ts: std::time::SystemTime::now()
                                                .duration_since(std::time::UNIX_EPOCH)
                                                .unwrap()
                                                .as_millis()
                                                as u64,
                                            backup_id,
                                            conflict_with,
                                        },
                                    );
                                }
                            } else if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                                let _ = app_clone.emit(
                                    "octo:activity",
                                    ActivityEvent {
                                        run_id: run_id_clone.clone(),
                                        text: "Writing response…".to_string(),
                                        folder_path: folder_clone.clone(),
                                        agent_name: agent_name_clone.clone(),
                                    },
                                );
                            }
                        }
                    }
                }

                // Handle result event
                if event.get("type").and_then(|v| v.as_str()) == Some("result") {
                    final_result = event
                        .get("result")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();

                    // Extract usage
                    if let Some(u) = event.get("usage") {
                        let mut usage = UsageData {
                            input_tokens: u
                                .get("input_tokens")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0),
                            output_tokens: u
                                .get("output_tokens")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0),
                            cache_read_tokens: u
                                .get("cache_read_input_tokens")
                                .and_then(|v| v.as_u64()),
                            cache_creation_tokens: u
                                .get("cache_creation_input_tokens")
                                .and_then(|v| v.as_u64()),
                            cost_usd: event.get("total_cost_usd").and_then(|v| v.as_f64()),
                            duration_ms: event.get("duration_ms").and_then(|v| v.as_u64()),
                            model: None,
                        };
                        if let Some(model_usage) = event.get("modelUsage") {
                            if let Some(obj) = model_usage.as_object() {
                                usage.model = obj.keys().next().map(|k| k.clone());
                            }
                        }
                        let _ = app_clone.emit(
                            "octo:usage",
                            UsageEvent {
                                run_id: run_id_clone.clone(),
                                usage,
                            },
                        );
                    }
                }
            }
        }

        let status = child.wait().map_err(|e| e.to_string())?;

        // Collect stderr output
        let stderr_output = stderr_handle.join().unwrap_or_default();

        // Clean up: remove from running agents + drop file locks + drop
        // backup-tracker in-memory state (backup files on disk persist).
        state_agents.lock().unwrap().remove(&run_id_clone);
        file_lock_manager.release_run(&run_id_clone);
        backup_tracker.finalize_run(&run_id_clone);

        // Check if this run was interrupted (user stopped it)
        let was_interrupted = state_interrupted.lock().unwrap().remove(&run_id_clone);

        if !status.success() && !was_interrupted {
            let mut err = format!("claude exited with code {:?}", status.code());
            if !stderr_output.is_empty() {
                err.push_str(&format!("\nstderr: {}", stderr_output.trim()));
            }
            return Err(err);
        }

        // If result is empty but there's stderr, include it for debugging
        if final_result.trim().is_empty() && !stderr_output.is_empty() {
            eprintln!("[octopal] claude stderr: {}", stderr_output.trim());
        }

        Ok::<String, String>(final_result.trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    match result {
        Ok(output) => {
            // Update octo history
            let mut octo: serde_json::Value = {
                let content = fs::read_to_string(&octo_path).map_err(|e| e.to_string())?;
                serde_json::from_str(&content).map_err(|e| e.to_string())?
            };
            let history = octo
                .get_mut("history")
                .and_then(|h| h.as_array_mut());
            if let Some(hist) = history {
                hist.push(serde_json::json!({
                    "role": "user",
                    "text": prompt,
                    "ts": user_ts,
                    "roomTs": user_ts,
                }));
                hist.push(serde_json::json!({
                    "role": "assistant",
                    "text": output,
                    "ts": chrono::Utc::now().timestamp_millis() as f64,
                    "roomTs": chrono::Utc::now().timestamp_millis() as f64,
                }));
            }
            fs::write(&octo_path, serde_json::to_string_pretty(&octo).unwrap())
                .map_err(|e| e.to_string())?;

            // Append to room history
            let room_history_path = Path::new(&folder_path)
                .join(".octopal")
                .join("room-history.json");
            let octopal_dir = Path::new(&folder_path).join(".octopal");
            fs::create_dir_all(&octopal_dir).ok();

            // Rotate if the file has grown past our size threshold. Idempotent
            // + safe if the file is missing or malformed.
            crate::commands::folder::maybe_rotate_room_history(&room_history_path);

            let mut room_history: Vec<serde_json::Value> = if room_history_path.exists() {
                fs::read_to_string(&room_history_path)
                    .ok()
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default()
            } else {
                vec![]
            };

            room_history.push(serde_json::json!({
                "id": uuid::Uuid::new_v4().to_string(),
                "agentName": agent_name,
                "text": output,
                "ts": chrono::Utc::now().timestamp_millis() as f64,
            }));

            fs::write(
                &room_history_path,
                serde_json::to_string_pretty(&room_history).unwrap(),
            )
            .ok();

            Ok(SendResult {
                ok: true,
                output: Some(output),
                error: None,
            })
        }
        Err(e) => Ok(SendResult {
            ok: false,
            output: None,
            error: Some(e),
        }),
    }
}

#[tauri::command]
pub fn stop_agent(run_id: String, state: State<'_, ManagedState>) -> StopResult {
    let mut agents = state.running_agents.lock().unwrap();
    if let Some(pid) = agents.remove(&run_id) {
        state.interrupted_runs.lock().unwrap().insert(run_id);
        // Send SIGTERM
        #[cfg(unix)]
        {
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
        }
        #[cfg(windows)]
        {
            Command::new("taskkill")
                .args(&["/PID", &pid.to_string(), "/T", "/F"])
                .output()
                .ok();
        }
        StopResult {
            ok: true,
            stopped: Some(true),
        }
    } else {
        StopResult {
            ok: true,
            stopped: Some(false),
        }
    }
}

#[tauri::command]
pub fn stop_all_agents(state: State<'_, ManagedState>) -> StopAllResult {
    let mut agents = state.running_agents.lock().unwrap();
    let count = agents.len() as u32;
    for (run_id, pid) in agents.drain() {
        state
            .interrupted_runs
            .lock()
            .unwrap()
            .insert(run_id);
        #[cfg(unix)]
        {
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
        }
    }
    StopAllResult {
        ok: true,
        stopped: count,
    }
}

#[tauri::command]
pub fn get_platform() -> String {
    // Return Node.js-style platform names ("darwin"/"win32"/"linux") for
    // compatibility with existing CSS class hooks (`.platform-darwin`, etc.)
    // and any UI code that was written against Electron's `process.platform`.
    match std::env::consts::OS {
        "macos" => "darwin".to_string(),
        "windows" => "win32".to_string(),
        other => other.to_string(),
    }
}

// ── MCP stubs ──
#[tauri::command]
pub fn mcp_health_check(
    _mcp_servers: serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({ "ok": true, "results": {} })
}

#[tauri::command]
pub fn mcp_install_package(_package_name: String) -> serde_json::Value {
    serde_json::json!({ "ok": false, "error": "MCP install not yet implemented in Tauri" })
}

// ── Multi-window ──
#[tauri::command]
pub fn new_window(app_handle: tauri::AppHandle) -> serde_json::Value {
    let label = format!("window-{}", uuid::Uuid::new_v4());
    match tauri::WebviewWindowBuilder::new(
        &app_handle,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Octopal")
    .inner_size(1200.0, 800.0)
    .min_inner_size(300.0, 400.0)
    .decorations(true)
    .title_bar_style(tauri::TitleBarStyle::Overlay)
    .hidden_title(true)
    .accept_first_mouse(true)
    .focused(true)
    .build()
    {
        Ok(_) => serde_json::json!({ "ok": true, "label": label }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

#[tauri::command]
pub fn get_window_count() -> serde_json::Value {
    serde_json::json!({ "count": 1, "max": 5 })
}

// ── File access respond ──
#[tauri::command]
pub fn respond_file_access(
    _request_id: String,
    _decision: String,
    _target_path: Option<String>,
    _project_folder: Option<String>,
) -> serde_json::Value {
    serde_json::json!({ "ok": true })
}
