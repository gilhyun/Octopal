use crate::state::ManagedState;
use serde::{Serialize, Deserialize};
use std::fs;
use std::io::BufRead;
use std::path::Path;
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

#[derive(Clone, Serialize, Deserialize)]
pub struct UsageData {
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<UsageData>,
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

/// Send a message to an agent via the claude CLI.
///
/// `pending_id` is the UI-side pending-bubble ID. When provided, it becomes
/// the `id` of the assistant entry persisted to room-history.json so the
/// folder watcher's history reload reconciles with the in-memory bubble
/// instead of producing a duplicate. Falls back to a fresh UUID when omitted.
#[tauri::command]
pub async fn send_message(
    folder_path: String,
    octo_path: String,
    prompt: String,
    user_ts: f64,
    run_id: String,
    pending_id: Option<String>,
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
            usage: None,
        });
    }

    // Read the agent config file (.json or legacy .octo)
    let octo_content: serde_json::Value = {
        let content = fs::read_to_string(&octo_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())?
    };

    let agent_name = octo_content
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("assistant")
        .to_string();

    // Load companion prompt.md file if it exists.
    // v3 subfolder: config.json sits next to prompt.md in the same directory.
    // Legacy flat: {name}.json sits next to {name}.md.
    let md_prompt: Option<String> = {
        let octo_file = Path::new(&octo_path);
        let parent = octo_file.parent().unwrap();

        // v3: same directory as config.json → prompt.md
        let v3_path = parent.join("prompt.md");
        if v3_path.exists() {
            fs::read_to_string(&v3_path).ok().filter(|s| !s.trim().is_empty())
        } else if let Some(stem) = octo_file.file_stem().and_then(|s| s.to_str()) {
            // Legacy flat: {stem}.md
            let legacy_path = parent.join(format!("{}.md", stem));
            fs::read_to_string(&legacy_path).ok().filter(|s| !s.trim().is_empty())
        } else {
            None
        }
    };

    // Isolated mode — this agent doesn't see peers or room history, and
    // can't emit handoff tags. Used for heavy single-shot research agents.
    let is_isolated = octo_content
        .get("isolated")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // Build system prompt
    let mut system_parts: Vec<String> = vec![];

    // World context — tells the agent what it is and how Octopal works
    system_parts.push("You are an agent in Octopal, a group-chat messenger for AI agents.\n\n\
        How your world works:\n\
        - You are a config.json file inside the octopal-agents/ folder that stores your name, role, memory, and conversation history. Each agent is a subfolder: octopal-agents/{name}/config.json + prompt.md.\n\
        - Your current project is the folder that contains your octopal-agents/ directory. Other agents in the same folder are your peers.\n\
        - Use @name to talk to peers. The human user talks to the whole room and can @mention any agent directly.\n\
        - You persist across sessions. Stay in character based on your role below.".to_string());

    // App context — capabilities including agent creation
    system_parts.push("\nAbout Octopal:\n\
        - Create new agents by making a subfolder in octopal-agents/ with config.json and prompt.md. Example: to create a \"developer\" agent, write octopal-agents/developer/config.json with {\"name\":\"developer\",\"role\":\"...\",\"icon\":\"👨‍💻\",\"memory\":[]} and octopal-agents/developer/prompt.md with the role description.\n\
        - @name mentions trigger agent responses. Wiki (.md files in the wiki directory) shares knowledge across all agents and sessions.\n\
        - Permissions (file write, shell, network) are per-agent, controlled in settings. Activity log shows all tool calls in real time.\n\
        - Agents can suggest hiring specialized teammates when the task calls for it. If the user asks to hire/create a new agent, create the config.json and prompt.md files directly.".to_string());

    // Use .md prompt file if available, otherwise fall back to role field
    if let Some(ref prompt) = md_prompt {
        system_parts.push(format!("\n{}", prompt));
    } else if let Some(role) = octo_content.get("role").and_then(|v| v.as_str()) {
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
            // Recursively collect pages so sub-folder pages (e.g. "docs/intro.md")
            // also show up in the agent's context, not just root-level files.
            let mut collected: Vec<super::wiki::WikiPage> = vec![];
            super::wiki::collect_pages(&wiki_dir, &wiki_dir, 0, &mut collected);
            collected.sort_by(|a, b| a.name.cmp(&b.name));
            let page_list = if collected.is_empty() {
                "(none yet)".to_string()
            } else {
                collected
                    .iter()
                    .map(|p| p.name.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            system_parts.push(format!(
                "\nWorkspace wiki — shared notes for the team:\n\
                 - Path: {}\n\
                 - Pages: {}\n\
                 - Read: use Read tool with absolute path. Write/Edit: same, .md files only.\n\
                 - Folder grouping: page names may contain forward slashes to nest into folders \
                 (e.g. `docs/intro.md`, `design/tokens.md`). When you create a new wiki page, \
                 prefer grouping related notes under a short, descriptive folder \
                 (e.g. docs/, design/, specs/) instead of dumping everything at the root. \
                 Create the parent directory implicitly by writing to the nested path — \
                 the app handles it automatically.",
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

    // Recent conversation — now injected as a user-message prefix (not in
    // the system prompt) so the persistent process can receive fresh context
    // with every message without needing to restart.
    //
    // Budget packing: newest to oldest, ~8000 chars ≈ 2000 tokens.
    // Noise filters: skip __dispatcher__/__system__, empty, current turn.
    // Isolated agents skip entirely.
    const RECENT_HISTORY_CHAR_BUDGET: usize = 8000;
    const HARD_PER_MESSAGE_CAP: usize = 2000;

    let mut history_prefix = String::new();

    if !is_isolated {
        let room_history_path = Path::new(&folder_path)
            .join(".octopal")
            .join("room-history.json");

        let all_msgs: Vec<serde_json::Value> = fs::read_to_string(&room_history_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        if !all_msgs.is_empty() {
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

                let label = if speaker == agent_name {
                    format!("{} (me)", speaker)
                } else {
                    speaker.to_string()
                };

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
                history_prefix.push_str(&format!(
                    "Recent conversation in this room (you are @{name}):\n\
                     Lines tagged \"(me)\" are your own earlier turns. Lines with other agents' names are peers speaking in the same room — you can reference what they said. Use this as context for your reply, but don't parrot back what's already been said.\n",
                    name = agent_name
                ));
                for (label, text) in included.into_iter().rev() {
                    history_prefix.push_str(&format!("[{}]: {}\n", label, text));
                }
                history_prefix.push('\n');
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

    // Build claude args — persistent session uses stream-json on both
    // stdin and stdout so the process can be reused across messages.
    let mut claude_args: Vec<String> = vec![
        "-p".to_string(),
        "--print".to_string(),
        "--verbose".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--no-session-persistence".to_string(),
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

    // Phase 6: read the agent's per-agent provider/model binding. Legacy
    // path (this function) is anthropic-only — if `binding.provider` is
    // set to anything else, log a warning and proceed with anthropic
    // (the user's intended provider only routes via Goose, which is the
    // goose_acp.rs path). The `binding.model` value, if present and a
    // valid alias, takes precedence over the caller-supplied `model`
    // suggestion below.
    let binding =
        crate::commands::agent_config::AgentBinding::read_or_default(Path::new(&octo_path));
    if let Some(p) = binding.provider.as_deref() {
        if p != "anthropic" {
            eprintln!(
                "[agent:legacy] agent={} has provider={} but legacy claude path \
                 is anthropic-only — falling back to anthropic. Switch off \
                 `useLegacyClaudeCli` in settings to route through Goose.",
                agent_name, p
            );
        }
    }

    // Model — extract settings values in a block to avoid holding MutexGuard across await.
    // The chosen alias is then passed through `resolve_model_for_cli`, which
    // substitutes the newest available Opus (e.g. `claude-opus-4-7`) when the
    // user's effective tier is `opus` and the startup probe found one on this
    // machine. This keeps the UI/settings simple (3 tiers) while letting
    // subscribers with Opus 4.7 access benefit automatically.
    //
    // Phase 6 priority order (most → least specific):
    //   1. `binding.model`  (per-agent override from config.json)
    //   2. `model`          (caller suggestion — typically the dispatcher
    //                        forcing a specific tier for routing decisions)
    //   3. `settings.advanced.default_agent_model`
    //   4. fallback "opus"
    let chosen_alias: Option<String> = {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        let auto_model = settings.advanced.auto_model_selection;
        let allowed = ["haiku", "sonnet", "opus"];
        // Fall back to the user's configured default whenever neither the
        // agent binding nor the caller pinned a specific tier. Without this,
        // auto-model mode would omit `--model` entirely and let the Claude
        // CLI pick its own default (often Haiku), contradicting the user's
        // "Default model: Opus" setting.
        let default_model = &settings.advanced.default_agent_model;
        let fallback = if allowed.contains(&default_model.as_str()) {
            default_model.clone()
        } else {
            "opus".to_string()
        };
        // Phase 6: agent-binding model takes precedence over caller model.
        // Only valid aliases are honored at this layer (concrete model IDs
        // pass through `resolve_model_for_cli` below); a non-alias binding
        // value falls through to caller / fallback.
        let binding_alias = binding
            .model
            .as_deref()
            .filter(|m| allowed.contains(m))
            .map(str::to_string);
        if auto_model {
            Some(
                binding_alias
                    .or_else(|| {
                        model.as_ref().and_then(|m| {
                            if allowed.contains(&m.as_str()) {
                                Some(m.clone())
                            } else {
                                None
                            }
                        })
                    })
                    .unwrap_or(fallback),
            )
        } else {
            Some(binding_alias.unwrap_or(fallback))
        }
    }; // settings guard dropped here
    if let Some(alias) = chosen_alias.clone() {
        let resolved = crate::commands::model_probe::resolve_model_for_cli(&alias, &state);
        eprintln!(
            "[agent:model] agent={} alias={} resolved={} (auto_model_in={:?})",
            agent_name, alias, resolved, model
        );
        claude_args.push("--model".to_string());
        claude_args.push(resolved);
    } else {
        eprintln!(
            "[agent:model] agent={} NO MODEL PUSHED (auto_model_in={:?})",
            agent_name, model
        );
    }

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
    // NOTE: We intentionally do NOT push `final_prompt` as a positional CLI
    // argument. Claude CLI's auto-mode classifier runs on positional prompts
    // and can downgrade to Haiku even when `--model claude-opus-4-7` is set
    // explicitly. The prompt is sent via stdin (stream-json) in
    // `process.send_message(&contextual_prompt)` below, so the positional
    // arg is redundant and actively harmful.

    // Emit activity
    let _ = app.emit("octo:activity", ActivityEvent {
        run_id: run_id.clone(),
        text: "Thinking…".to_string(),
        folder_path: folder_path.clone(),
        agent_name: agent_name.clone(),
    });

    // Spawn / reuse persistent claude CLI process.
    //
    // The process pool keeps long-running claude processes alive across
    // messages. This eliminates the macOS TCC permission popup that fires
    // every time a new process spawns and touches protected directories.
    let run_id_clone = run_id.clone();
    let app_clone = app.clone();
    let folder_clone = folder_path.clone();
    let agent_name_clone = agent_name.clone();
    let state_agents = state.running_agents.clone();
    let state_interrupted = state.interrupted_runs.clone();
    let backup_tracker = state.backup_tracker.clone();
    let file_lock_manager = state.file_lock_manager.clone();
    let process_pool = state.process_pool.clone();

    // Opportunistic prune of old backups for this folder.
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

    eprintln!("[agent:args] agent={} args={:?}", agent_name, claude_args);

    // Compute config hash for cache invalidation (model + perms + MCP change → restart)
    let config_hash = {
        let model_str = claude_args.iter().skip_while(|a| *a != "--model").nth(1)
            .cloned().unwrap_or_default();
        let perms_str = format!("{:?}", perms);
        let mcp_str = octo_content.get("mcpServers")
            .map(|v| v.to_string()).unwrap_or_default();
        super::process_pool::ProcessPool::hash_config(&[
            &agent_name, &model_str, &perms_str, &mcp_str,
        ])
    };

    // Prepend room history context to the user prompt
    let contextual_prompt = if history_prefix.is_empty() {
        final_prompt.clone()
    } else {
        format!("{}{}", history_prefix, final_prompt)
    };

    // Goose ACP vs legacy Claude CLI gate.
    //
    // Primary source: `settings.providers.use_legacy_claude_cli`. Default is
    // true in v0.2.0-beta (opt-in), flips to false in v0.2.0 stable, and the
    // entire branch disappears in v0.3.0 cleanup.
    //
    // Dev override: in debug builds, `OCTOPAL_USE_GOOSE=1` forces the Goose
    // path regardless of settings — avoids having to toggle the UI every
    // reload. The override block is stripped by `cfg!` in release builds.
    let legacy = state
        .settings
        .lock()
        .ok()
        .map(|s| s.providers.use_legacy_claude_cli)
        .unwrap_or(true);
    let dev_override = cfg!(debug_assertions)
        && std::env::var("OCTOPAL_USE_GOOSE").as_deref() == Ok("1");
    let use_goose = !legacy || dev_override;
    eprintln!(
        "[agent:gate] agent={} legacy={} dev_override={} → {}",
        agent_name,
        legacy,
        dev_override,
        if use_goose { "run_agent_turn" } else { "legacy claude_cli" }
    );
    if use_goose {
        let system_prompt_text = format!(
            "{}{}\n\nWorking folder: {}",
            system_parts.join("\n"),
            cap_line,
            folder_path
        );
        let resolved_model = chosen_alias
            .as_ref()
            .map(|alias| crate::commands::model_probe::resolve_model_for_cli(alias, &state))
            .unwrap_or_default();
        let permissions: Option<crate::state::OctoPermissions> = perms
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok());
        let params = crate::commands::goose_acp::RunAgentTurnParams {
            folder_path: folder_path.clone(),
            octo_path: octo_path.clone(),
            agent_name: agent_name.clone(),
            run_id: run_id.clone(),
            pending_id: pending_id.clone(),
            system_prompt: system_prompt_text,
            user_prompt: prompt.clone(),
            contextual_prompt: contextual_prompt.clone(),
            user_ts,
            model: resolved_model,
            permissions,
        };
        return crate::commands::goose_acp::run_agent_turn(&app, &state, params).await;
    }

    let pool_key = format!("{}::{}", folder_path, agent_name);
    let pool_key_clone = pool_key.clone();
    let claude_args_clone = claude_args.clone();

    let result = tokio::task::spawn_blocking(move || {
        // Try to reuse an existing persistent process
        let mut process = match process_pool.take(&pool_key_clone) {
            Some(mut existing) => {
                // Check if config changed or process died
                if existing.config_hash != config_hash || !existing.is_alive() {
                    eprintln!(
                        "[process-pool] config changed or process dead for {}, creating new",
                        pool_key_clone
                    );
                    existing.kill();
                    let mut p = super::process_pool::ProcessPool::create_process(
                        &claude_args_clone,
                        &folder_clone,
                    )?;
                    p.config_hash = config_hash;
                    p
                } else {
                    eprintln!("[process-pool] reusing process for {}", pool_key_clone);
                    existing
                }
            }
            None => {
                eprintln!("[process-pool] creating new process for {}", pool_key_clone);
                let mut p = super::process_pool::ProcessPool::create_process(
                    &claude_args_clone,
                    &folder_clone,
                )?;
                p.config_hash = config_hash;
                p
            }
        };

        // Store PID so stop_agent can kill it
        let pid = process.pid;
        state_agents.lock().unwrap().insert(run_id_clone.clone(), pid);

        // Send message via stdin (stream-json protocol)
        process.send_message(&contextual_prompt)
            .map_err(|e| format!("Failed to send message: {}", e))?;

        let mut final_result = String::new();
        let mut final_usage: Option<UsageData> = None;
        let mut process_died = false;
        // Authoritative model for this run — taken from the assistant message's
        // `message.model` field. Claude Code may consult Haiku for internal
        // steps while Opus generates the reply, so `modelUsage` can contain
        // multiple models; the assistant message's `.model` is the one that
        // actually produced the user-visible answer.
        let mut assistant_model: Option<String> = None;

        // Read stdout line-by-line until we get a `result` event.
        // Unlike the old code that read until EOF, we break on `result`
        // so the process stays alive for the next message.
        loop {
            let mut line = String::new();
            match process.reader.read_line(&mut line) {
                Ok(0) => {
                    // EOF — process died
                    process_died = true;
                    break;
                }
                Ok(_) => {}
                Err(e) => {
                    eprintln!("[process-pool] read error: {}", e);
                    process_died = true;
                    break;
                }
            }

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let event = match serde_json::from_str::<serde_json::Value>(trimmed) {
                Ok(e) => e,
                Err(_) => continue,
            };

            let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");

            // Skip system events (init, etc.)
            if event_type == "system" {
                continue;
            }

            // Handle assistant events (tool use, text)
            if event_type == "assistant" {
                // Capture the model that produced this assistant message.
                // The LAST assistant message's model wins (it's the one that
                // produced the final text).
                if let Some(m) = event
                    .get("message")
                    .and_then(|msg| msg.get("model"))
                    .and_then(|v| v.as_str())
                {
                    assistant_model = Some(m.to_string());
                }
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

            // Handle result event — this signals end of response
            if event_type == "result" {
                eprintln!("[octo:usage] result event received, has usage: {}, fast_mode_state: {:?}, modelUsage: {:?}",
                    event.get("usage").is_some(),
                    event.get("fast_mode_state"),
                    event.get("modelUsage")
                );
                final_result = event
                    .get("result")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

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
                    // Prefer the assistant message's `model` field — it's the
                    // actual model that produced the reply. Fall back to
                    // picking the `modelUsage` key with the most output_tokens
                    // (the primary generator) rather than alphabetically first,
                    // so "haiku" doesn't win over "opus" when Claude Code
                    // invokes Haiku for internal steps.
                    usage.model = assistant_model.clone().or_else(|| {
                        event.get("modelUsage").and_then(|mu| mu.as_object()).and_then(|obj| {
                            obj.iter()
                                .max_by_key(|(_, v)| {
                                    v.get("outputTokens").and_then(|n| n.as_u64()).unwrap_or(0)
                                })
                                .map(|(k, _)| k.clone())
                        })
                    });
                    eprintln!("[octo:usage] emitting usage event: runId={}, inputTokens={}, outputTokens={}, model={:?}",
                        run_id_clone, usage.input_tokens, usage.output_tokens, usage.model);
                    let _ = app_clone.emit(
                        "octo:usage",
                        UsageEvent {
                            run_id: run_id_clone.clone(),
                            usage: usage.clone(),
                        },
                    );
                    final_usage = Some(usage);
                }

                // Got the result — break out of the read loop.
                // The process stays alive for the next message.
                break;
            }
        }

        // Clean up run tracking (but keep process alive in pool)
        state_agents.lock().unwrap().remove(&run_id_clone);
        file_lock_manager.release_run(&run_id_clone);
        backup_tracker.finalize_run(&run_id_clone);

        let was_interrupted = state_interrupted.lock().unwrap().remove(&run_id_clone);

        // Return process to pool if still alive and not interrupted
        if !process_died && !was_interrupted && process.is_alive() {
            process_pool.put(pool_key_clone, process);
        } else if !was_interrupted && process_died {
            // Process died unexpectedly — don't return to pool
            eprintln!("[process-pool] process died during response for {}", pool_key_clone);
        }

        if was_interrupted {
            // User stopped the agent — process was killed externally
        }

        Ok::<(String, Option<UsageData>), String>((final_result.trim().to_string(), final_usage))
    })
    .await
    .map_err(|e| e.to_string())?;

    match result {
        Ok((output, usage)) => {
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

            // Reuse the UI's pending-bubble ID when provided so the folder
            // watcher's hot-reload can match the on-disk entry to the
            // in-memory bubble (preserving permission/handoff UI state
            // without producing a duplicate). Fall back to a fresh UUID for
            // any legacy callers that don't pass pending_id.
            let entry_id = pending_id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let mut history_entry = serde_json::json!({
                "id": entry_id,
                "agentName": agent_name,
                "text": output,
                "ts": chrono::Utc::now().timestamp_millis() as f64,
            });
            // Persist usage data so it survives reload
            if let Some(ref u) = usage {
                history_entry["usage"] = serde_json::to_value(u).unwrap_or_default();
            }
            room_history.push(history_entry);

            fs::write(
                &room_history_path,
                serde_json::to_string_pretty(&room_history).unwrap(),
            )
            .ok();

            Ok(SendResult {
                ok: true,
                output: Some(output),
                error: None,
                usage,
            })
        }
        Err(e) => Ok(SendResult {
            ok: false,
            output: None,
            error: Some(e),
            usage: None,
        }),
    }
}

#[tauri::command]
pub fn stop_agent(run_id: String, state: State<'_, ManagedState>) -> StopResult {
    let mut agents = state.running_agents.lock().unwrap();
    if let Some(pid) = agents.remove(&run_id) {
        state.interrupted_runs.lock().unwrap().insert(run_id);
        // Ask BOTH pools to drop by PID. The pool that spawned this PID
        // acts; the other is a cheap no-op HashMap scan (scope §4.3).
        // Neither kills — `kill_pid` below owns the SIGTERM.
        state.process_pool.remove_by_pid(pid);
        state.goose_acp_pool.remove_by_pid(pid);
        kill_pid(pid);
        eprintln!("[goose_acp_pool] stop_agent pid={} (may have been legacy)", pid);
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
        state.process_pool.remove_by_pid(pid);
        state.goose_acp_pool.remove_by_pid(pid);
        kill_pid(pid);
    }
    // Also kill any idle processes in both pools.
    // Legacy: synchronous SIGKILL via child.kill().
    // Goose: async SIGKILL via tauri-plugin-shell. We fire-and-forget on
    // a detached task so stop_all_agents stays sync (matches the Tauri
    // command surface). 0ms grace — this is the "nuke everything" path.
    state.process_pool.kill_all();
    let goose_pool = state.goose_acp_pool.clone();
    tauri::async_runtime::spawn(async move {
        let _ = goose_pool.shutdown_all(0).await;
    });
    StopAllResult {
        ok: true,
        stopped: count,
    }
}

/// Cross-platform process kill helper. Used by both `stop_agent` and
/// `stop_all_agents` so the platform branches live in one place.
///
/// On Unix: sends SIGTERM via `libc::kill`.
/// On Windows: spawns `taskkill /PID <pid> /T /F` to kill the process tree.
pub fn kill_pid(pid: u32) {
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
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

    // Cross-platform builder. Methods like `title_bar_style`, `hidden_title`,
    // and `accept_first_mouse` are macOS-only and don't exist on the
    // Windows/Linux builder, so we apply them inside a `cfg(target_os)`
    // block instead of chaining them directly.
    let builder = tauri::WebviewWindowBuilder::new(
        &app_handle,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Octopal")
    .inner_size(1200.0, 800.0)
    .min_inner_size(300.0, 400.0)
    .decorations(true)
    .focused(true);

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .accept_first_mouse(true);

    match builder.build() {
        Ok(_) => serde_json::json!({ "ok": true, "label": label }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

#[tauri::command]
pub fn get_window_count() -> serde_json::Value {
    serde_json::json!({ "count": 1, "max": 5 })
}

/// Called from the backend when OS opens an agent file (.json or legacy .octo).
/// Reads the file, determines the agent name and parent folder.
pub fn open_octo_file(app_handle: &tauri::AppHandle, file_path: &str) {
    let path = std::path::Path::new(file_path);
    let ext = path.extension().and_then(|e| e.to_str());
    if !path.exists() || (ext != Some("json") && ext != Some("octo")) {
        return;
    }

    // Read agent name from the agent JSON
    let _agent_name = if let Ok(contents) = std::fs::read_to_string(path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) {
            json.get("name")
                .and_then(|v| v.as_str())
                .unwrap_or_else(|| {
                    path.file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("agent")
                })
                .to_string()
        } else {
            path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("agent")
                .to_string()
        }
    } else {
        return;
    };

    // Determine the project folder:
    // v3 subfolder: octopal-agents/{name}/config.json → go up 3 levels
    // v2 flat: octopal-agents/{name}.json → go up 2 levels
    // v1 root: ./{name}.octo → go up 1 level
    let _folder_path = if let Some(parent) = path.parent() {
        if parent
            .parent()
            .and_then(|gp| gp.file_name())
            .and_then(|n| n.to_str())
            == Some("octopal-agents")
        {
            // v3: config.json inside agent subfolder inside octopal-agents/
            parent.parent().and_then(|p| p.parent()).unwrap_or(parent)
        } else if parent.file_name().and_then(|n| n.to_str()) == Some("octopal-agents") {
            // v2: flat file inside octopal-agents/
            parent.parent().unwrap_or(parent)
        } else {
            parent
        }
    } else {
        return;
    };

    // TODO: When DM/1:1 chat feature is re-implemented, open a chat window here.
    // For now, the file is just recognized — the main window handles agent interaction.
    let _ = app_handle; // suppress unused warning
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
