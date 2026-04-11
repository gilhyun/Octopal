use crate::state::ManagedState;
use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter, State};

#[cfg(unix)]
extern crate libc;

/// Resolve the full path to the `claude` CLI binary.
/// GUI apps on macOS don't inherit the shell PATH, so we check common locations.
fn resolve_claude_path() -> String {
    // 1. Try bare `claude` first (works when PATH is inherited, e.g. `cargo tauri dev`)
    if let Ok(output) = Command::new("which").arg("claude").output() {
        if output.status.success() {
            let p = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !p.is_empty() {
                return p;
            }
        }
    }

    // 2. Check common install locations
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{}/.nvm/versions/node/v22.15.1/bin/claude", home),
        format!("{}/.local/bin/claude", home),
        format!("{}/.npm-global/bin/claude", home),
        "/usr/local/bin/claude".to_string(),
        "/opt/homebrew/bin/claude".to_string(),
    ];
    for candidate in &candidates {
        if Path::new(candidate).exists() {
            return candidate.clone();
        }
    }

    // 3. Try to find via node/npm
    if let Ok(output) = Command::new("/bin/sh")
        .args(&["-l", "-c", "which claude"])
        .output()
    {
        if output.status.success() {
            let p = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !p.is_empty() {
                return p;
            }
        }
    }

    // Fallback — will fail with a clear error message
    "claude".to_string()
}

#[derive(Clone, Serialize)]
struct ActivityEvent {
    #[serde(rename = "runId")]
    run_id: String,
    text: String,
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
    let claude_bin = resolve_claude_path();
    let output = Command::new(&claude_bin)
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

    // Build system prompt
    let mut system_parts: Vec<String> = vec![];

    system_parts.push("You are a \".octo\" file: a JSON file on disk that stores your name, role, memory, and conversation history.".to_string());

    if let Some(role) = octo_content.get("role").and_then(|v| v.as_str()) {
        system_parts.push(format!("\nYour role: {}", role));
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

    // Peers
    if let Some(peer_list) = &peers {
        if !peer_list.is_empty() {
            system_parts.push("\nYou are in a group chat with these other agents:".to_string());
            for p in peer_list {
                let pname = p.get("name").and_then(|v| v.as_str()).unwrap_or("?");
                let prole = p.get("role").and_then(|v| v.as_str()).unwrap_or("assistant");
                system_parts.push(format!("- @{}: {}", pname, prole));
            }
        }
    }

    // Collaboration mode
    if is_leader == Some(true) {
        if let Some(collabs) = &collaborators {
            if !collabs.is_empty() {
                let collab_list: Vec<String> = collabs
                    .iter()
                    .map(|c| {
                        let n = c.get("name").and_then(|v| v.as_str()).unwrap_or("?");
                        let r = c.get("role").and_then(|v| v.as_str()).unwrap_or("assistant");
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

    // Recent history (last 10 entries from octo)
    if let Some(history) = octo_content.get("history").and_then(|v| v.as_array()) {
        let recent: Vec<_> = history.iter().rev().take(10).collect::<Vec<_>>();
        if !recent.is_empty() {
            system_parts.push("\nRecent conversation:".to_string());
            for msg in recent.iter().rev() {
                let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("user");
                let text = msg.get("text").and_then(|v| v.as_str()).unwrap_or("");
                let truncated = if text.chars().count() > 300 {
                    let prefix: String = text.chars().take(300).collect();
                    format!("{}...", prefix)
                } else {
                    text.to_string()
                };
                system_parts.push(format!("[{}]: {}", role, truncated));
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

    // Permissions args
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

    // Attachments
    let mut final_prompt = prompt.clone();
    let mut refs: Vec<String> = vec![];
    if let Some(imgs) = &image_paths {
        for img in imgs {
            let abs = Path::new(&folder_path).join(img);
            if abs.exists() {
                refs.push(format!("@{}", img));
            }
        }
    }
    if let Some(txts) = &text_paths {
        for txt in txts {
            let abs = Path::new(&folder_path).join(txt);
            if abs.exists() {
                refs.push(format!("@{}", txt));
            }
        }
    }
    if !refs.is_empty() {
        final_prompt = format!("Attached files: {}\n\n{}", refs.join(" "), prompt);
    }
    claude_args.push(final_prompt.clone());

    // Emit activity
    let _ = app.emit("octo:activity", ActivityEvent {
        run_id: run_id.clone(),
        text: "Thinking…".to_string(),
    });

    // Spawn claude CLI
    let run_id_clone = run_id.clone();
    let app_clone = app.clone();
    let folder_clone = folder_path.clone();
    let agent_name_clone = agent_name.clone();
    let state_agents = state.running_agents.clone();
    let state_interrupted = state.interrupted_runs.clone();

    let result = tokio::task::spawn_blocking(move || {
        // Resolve full path to `claude` — GUI apps on macOS don't inherit shell PATH
        let claude_bin = resolve_claude_path();

        let mut child = Command::new(&claude_bin)
            .args(&claude_args)
            .current_dir(&folder_clone)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()) // Capture stderr to diagnose errors
            .stdin(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to spawn claude ({}): {}", claude_bin, e))?;

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
                                        },
                                    );
                                }
                            } else if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                                let _ = app_clone.emit(
                                    "octo:activity",
                                    ActivityEvent {
                                        run_id: run_id_clone.clone(),
                                        text: "Writing response…".to_string(),
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

        // Clean up: remove from running agents
        state_agents.lock().unwrap().remove(&run_id_clone);

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
    std::env::consts::OS.to_string()
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

// ── Multi-window stubs ──
#[tauri::command]
pub fn new_window() -> serde_json::Value {
    serde_json::json!({ "ok": false, "error": "Multi-window not yet implemented in Tauri" })
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
