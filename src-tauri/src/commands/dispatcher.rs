//! Message dispatching — routes a user message to the most appropriate
//! agent based on role + recent history.
//!
//! Used to be called "observer.rs" with a pile of stubs for a never-built
//! state-tracking system (rule observer + smart observer + classify_mention
//! + dispatcher_check_context). All of those have been removed — they were
//! pure no-ops that gave the illusion of conversation awareness. What lives
//! here now is just the one function that is actually wired up:
//! `dispatcher_route`.

use std::io::Read;
use std::process::Stdio;

use super::agent::sanitize_prompt_field;
use super::claude_cli::claude_command;

/// Smart dispatcher: uses Claude CLI (haiku) to analyze the user's message
/// and route it to the most appropriate agent based on their roles and
/// recent conversation context.
///
/// Falls back to @mention parsing → first agent if the LLM call fails.
#[tauri::command]
pub async fn dispatcher_route(
    message: String,
    agents: Vec<serde_json::Value>,
    recent_history: Vec<serde_json::Value>,
    _folder_path: Option<String>,
) -> Result<serde_json::Value, String> {
    let msg_lower = message.to_lowercase();

    // ── Fast path: explicit @mention in the user message ──
    for agent in &agents {
        let name = agent.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if msg_lower.contains(&format!("@{}", name.to_lowercase())) {
            return Ok(serde_json::json!({
                "ok": true,
                "leader": name,
                "collaborators": [],
                "model": null
            }));
        }
    }

    // ── Build agent list for the routing prompt ──
    let agent_descriptions: Vec<String> = agents
        .iter()
        .filter_map(|a| {
            let name = a.get("name").and_then(|v| v.as_str())?;
            let role = a
                .get("role")
                .and_then(|v| v.as_str())
                .unwrap_or("general assistant");
            Some(format!(
                "- {} : {}",
                sanitize_prompt_field(name),
                sanitize_prompt_field(role)
            ))
        })
        .collect();

    let agent_names: Vec<&str> = agents
        .iter()
        .filter_map(|a| a.get("name").and_then(|v| v.as_str()))
        .collect();

    if agent_names.is_empty() {
        return Ok(serde_json::json!({
            "ok": false,
            "leader": "assistant",
            "collaborators": []
        }));
    }

    // ── Build recent history summary (last 6 messages) ──
    let history_summary: String = recent_history
        .iter()
        .take(6)
        .filter_map(|m| {
            let agent = m.get("agentName").and_then(|v| v.as_str())?;
            let text = m.get("text").and_then(|v| v.as_str())?;
            // CRITICAL: use char-based slicing, NOT byte-based.
            // `&text[..200]` panics on UTF-8 boundaries — Korean/Japanese/
            // Chinese characters are 3+ bytes each, and `len()` returns
            // byte length, so `text[..200]` lands mid-character ~66% of
            // the time for CJK text. This is the bug that caused the
            // SIGABRT crash report on 2026-04-12 10:41.
            let truncated = if text.chars().count() > 200 {
                let head: String = text.chars().take(200).collect();
                format!("{}...", head)
            } else {
                text.to_string()
            };
            Some(format!("[{}]: {}", agent, truncated))
        })
        .collect::<Vec<_>>()
        .join("\n");

    // ── Construct the routing prompt ──
    let system_prompt = format!(
        r#"You are a message router for a multi-agent chat system. Your ONLY job is to decide which agent should handle the user's message.

Available agents:
{}

{}Reply with ONLY a JSON object, no markdown, no explanation:
{{"leader": "<agent_name>", "collaborators": []}}

Rules:
- "leader" MUST be one of: [{}]
- Pick the agent whose role best matches the user's intent
- If the message is a general question or greeting, pick "assistant"
- If the message involves code/implementation, pick "developer" (if available)
- If the message involves UI/design, pick "designer" (if available)
- If the message involves planning/tasks, pick "planner" (if available)
- If the message involves testing, pick "tester" (if available)
- If the message involves security, pick "security" (if available)
- If the message involves code review, pick "reviewer" (if available)
- Use conversation context to understand continuity (e.g., follow-up questions should go to the same agent)
- "collaborators" should list agents who may need to contribute (can be empty)"#,
        agent_descriptions.join("\n"),
        if history_summary.is_empty() {
            String::new()
        } else {
            format!("Recent conversation:\n{}\n\n", history_summary)
        },
        agent_names
            .iter()
            .map(|n| format!("\"{}\"", n))
            .collect::<Vec<_>>()
            .join(", ")
    );

    let user_prompt = format!("Route this message: {}", message);

    // ── Call Claude CLI with haiku for fast routing ──
    let result = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let mut cmd = claude_command();
        cmd.args([
            "-p",
            "--print",
            "--output-format",
            "text",
            "--model",
            "haiku",
            "--system-prompt",
            &system_prompt,
            &user_prompt,
        ]);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn claude: {}", e))?;

        let stdout = child.stdout.take().ok_or("No stdout")?;
        let mut output = String::new();
        let mut reader = std::io::BufReader::new(stdout);
        reader
            .read_to_string(&mut output)
            .map_err(|e| format!("Read error: {}", e))?;

        let status = child.wait().map_err(|e| format!("Wait error: {}", e))?;
        if !status.success() {
            return Err(format!("Claude exited with status: {}", status));
        }

        let trimmed = output.trim();

        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed) {
            return Ok(parsed);
        }

        if let Some(start) = trimmed.find('{') {
            if let Some(end) = trimmed.rfind('}') {
                if let Ok(parsed) =
                    serde_json::from_str::<serde_json::Value>(&trimmed[start..=end])
                {
                    return Ok(parsed);
                }
            }
        }

        Err(format!("Failed to parse routing response: {}", trimmed))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;

    match result {
        Ok(parsed) => {
            let leader = parsed
                .get("leader")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let valid_leader = if agent_names.contains(&leader) {
                leader.to_string()
            } else {
                agent_names
                    .iter()
                    .find(|n| n.to_lowercase() == leader.to_lowercase())
                    .map(|n| n.to_string())
                    .unwrap_or_else(|| agent_names[0].to_string())
            };

            let collaborators: Vec<String> = parsed
                .get("collaborators")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .filter(|name| agent_names.contains(&name.as_str()))
                        .filter(|name| name != &valid_leader)
                        .collect()
                })
                .unwrap_or_default();

            Ok(serde_json::json!({
                "ok": true,
                "leader": valid_leader,
                "collaborators": collaborators,
                "model": null
            }))
        }
        Err(e) => {
            eprintln!("[dispatcher_route] LLM routing failed: {}. Falling back.", e);
            let fallback = agent_names[0];
            Ok(serde_json::json!({
                "ok": true,
                "leader": fallback,
                "collaborators": []
            }))
        }
    }
}
