//! Message dispatching — routes a user message to the most appropriate
//! agent based on role + recent history.
//!
//! Uses a persistent Claude CLI process (haiku) to avoid spawning a new
//! process for every routing call. The process stays alive and communicates
//! via `--input-format stream-json` / `--output-format stream-json`.

use std::io::BufRead;

use tauri::State;

use super::agent::sanitize_prompt_field;
use super::process_pool::ProcessPool;
use crate::state::ManagedState;

/// Smart dispatcher: uses a persistent Claude CLI haiku process to analyze
/// the user's message and route it to the most appropriate agent.
///
/// Falls back to @mention parsing → first agent if the LLM call fails.
#[tauri::command]
pub async fn dispatcher_route(
    message: String,
    agents: Vec<serde_json::Value>,
    recent_history: Vec<serde_json::Value>,
    _folder_path: Option<String>,
    state: State<'_, ManagedState>,
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

    // Dispatcher still runs on Claude Haiku — Goose-based routing lands in
    // Stage 6b-ii (Phase 0 open question: Haiku dependency audit needs
    // live measurement first). When the agent path is on Goose, short-
    // circuit to "first available agent" so we don't spawn a Claude Haiku
    // process just to route. Matches the legacy fallback on line ~290.
    let legacy = state
        .settings
        .lock()
        .ok()
        .map(|s| s.providers.use_legacy_claude_cli)
        .unwrap_or(true);
    let dev_override = cfg!(debug_assertions)
        && std::env::var("OCTOPAL_USE_GOOSE").as_deref() == Ok("1");
    let use_goose = !legacy || dev_override;
    if use_goose {
        eprintln!(
            "[dispatcher:gate] legacy={} dev_override={} → skip Haiku, leader={}",
            legacy, dev_override, agent_names[0]
        );
        return Ok(serde_json::json!({
            "ok": true,
            "leader": agent_names[0],
            "collaborators": [],
            "model": null
        }));
    }

    // ── Build recent history summary (last 6 messages) ──
    let history_summary: String = recent_history
        .iter()
        .take(6)
        .filter_map(|m| {
            let agent = m.get("agentName").and_then(|v| v.as_str())?;
            let text = m.get("text").and_then(|v| v.as_str())?;
            // CRITICAL: use char-based slicing for CJK safety.
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

    // ── System prompt (static part — set once per persistent process) ──
    let system_prompt = format!(
        r#"You are a message router for a multi-agent chat system. Your ONLY job is to decide which agent should handle the user's message.

Available agents:
{}

Reply with ONLY a JSON object, no markdown, no explanation:
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
        agent_names
            .iter()
            .map(|n| format!("\"{}\"", n))
            .collect::<Vec<_>>()
            .join(", ")
    );

    // ── User prompt includes dynamic context (history + message) ──
    let user_prompt = if history_summary.is_empty() {
        format!("Route this message: {}", message)
    } else {
        format!(
            "Recent conversation:\n{}\n\nRoute this message: {}",
            history_summary, message
        )
    };

    // ── Config hash for process pool cache invalidation ──
    let agent_names_str = agent_names.join(",");
    let config_hash = ProcessPool::hash_config(&[&agent_names_str]);

    let pool_key = "__dispatcher__".to_string();
    let process_pool = state.process_pool.clone();

    // ── Call persistent Claude CLI haiku process ──
    let result = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        // Try to reuse existing dispatcher process
        let mut process = match process_pool.take(&pool_key) {
            Some(mut existing) => {
                if existing.config_hash != config_hash || !existing.is_alive() {
                    eprintln!("[dispatcher] config changed or process dead, creating new");
                    existing.kill();
                    let args: Vec<String> = vec![
                        "-p".into(), "--print".into(), "--verbose".into(),
                        "--output-format".into(), "stream-json".into(),
                        "--input-format".into(), "stream-json".into(),
                        "--model".into(), "haiku".into(),
                        "--no-session-persistence".into(),
                        "--system-prompt".into(), system_prompt.clone(),
                    ];
                    let mut p = ProcessPool::create_process(&args, ".")?;
                    p.config_hash = config_hash;
                    p
                } else {
                    eprintln!("[dispatcher] reusing persistent process");
                    existing
                }
            }
            None => {
                eprintln!("[dispatcher] creating new persistent process");
                let args: Vec<String> = vec![
                    "-p".into(), "--print".into(), "--verbose".into(),
                    "--output-format".into(), "stream-json".into(),
                    "--input-format".into(), "stream-json".into(),
                    "--model".into(), "haiku".into(),
                    "--no-session-persistence".into(),
                    "--system-prompt".into(), system_prompt.clone(),
                ];
                let mut p = ProcessPool::create_process(&args, ".")?;
                p.config_hash = config_hash;
                p
            }
        };

        // Send routing query via stdin
        process.send_message(&user_prompt)
            .map_err(|e| format!("Failed to send routing query: {}", e))?;

        // Read until result event
        let mut final_text = String::new();
        let mut process_died = false;

        loop {
            let mut line = String::new();
            match process.reader.read_line(&mut line) {
                Ok(0) => { process_died = true; break; }
                Ok(_) => {}
                Err(e) => {
                    eprintln!("[dispatcher] read error: {}", e);
                    process_died = true;
                    break;
                }
            }

            let trimmed = line.trim();
            if trimmed.is_empty() { continue; }

            let event = match serde_json::from_str::<serde_json::Value>(trimmed) {
                Ok(e) => e,
                Err(_) => continue,
            };

            let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");

            if event_type == "system" { continue; }

            if event_type == "result" {
                final_text = event
                    .get("result")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                break;
            }
        }

        // Return process to pool if still alive
        if !process_died && process.is_alive() {
            process_pool.put(pool_key, process);
        }

        // Parse the routing JSON from the result
        let text = final_text.trim();
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(text) {
            return Ok(parsed);
        }
        if let Some(start) = text.find('{') {
            if let Some(end) = text.rfind('}') {
                if let Ok(parsed) =
                    serde_json::from_str::<serde_json::Value>(&text[start..=end])
                {
                    return Ok(parsed);
                }
            }
        }

        Err(format!("Failed to parse routing response: {}", text))
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
