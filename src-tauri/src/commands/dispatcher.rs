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

#[derive(Debug, Clone, PartialEq, Eq)]
struct HeuristicRoute {
    leader: String,
    collaborators: Vec<String>,
}

#[derive(Debug, Clone)]
struct AgentCandidate {
    name: String,
    role: String,
    index: usize,
}

fn candidates_from_agents(agents: &[serde_json::Value]) -> Vec<AgentCandidate> {
    agents
        .iter()
        .enumerate()
        .filter_map(|(index, a)| {
            let name = a.get("name").and_then(|v| v.as_str())?;
            if name.trim().is_empty() {
                return None;
            }
            let role = a
                .get("role")
                .and_then(|v| v.as_str())
                .unwrap_or("general assistant");
            Some(AgentCandidate {
                name: name.to_string(),
                role: role.to_string(),
                index,
            })
        })
        .collect()
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|part| part.chars().count() >= 2)
        .map(str::to_string)
        .collect()
}

fn last_non_user_agent(recent_history: &[serde_json::Value]) -> Option<String> {
    recent_history.iter().rev().find_map(|m| {
        let agent = m.get("agentName").and_then(|v| v.as_str())?;
        if agent == "user" || agent == "__dispatcher__" || agent == "__system__" {
            None
        } else {
            Some(agent.to_lowercase())
        }
    })
}

fn looks_like_followup(message_lower: &str) -> bool {
    contains_any(
        message_lower,
        &[
            "continue",
            "same",
            "that",
            "this",
            "again",
            "next",
            "follow up",
            "keep going",
            "계속",
            "이어서",
            "그거",
            "그 부분",
            "다음",
            "방금",
        ],
    )
}

fn domain_score(message_lower: &str, candidate_lower: &str) -> i32 {
    let rules: [(&[&str], &[&str], i32); 8] = [
        (
            &[
                "code", "bug", "fix", "implement", "refactor", "api", "component", "build",
                "compile", "typescript", "rust", "react", "tauri", "코드", "버그", "수정",
                "구현", "리팩터", "빌드", "컴파일",
            ],
            &["developer", "dev", "engineer", "coder", "frontend", "backend", "개발", "엔지니어"],
            45,
        ),
        (
            &["ui", "ux", "design", "css", "layout", "screen", "visual", "button", "modal", "디자인", "화면", "레이아웃", "스타일"],
            &["designer", "design", "ui", "ux", "디자이너", "디자인"],
            45,
        ),
        (
            &["test", "qa", "spec", "regression", "verify", "coverage", "테스트", "검증", "회귀"],
            &["tester", "qa", "test", "테스터", "검증"],
            42,
        ),
        (
            &["security", "xss", "csrf", "injection", "auth", "permission", "sanitize", "보안", "권한", "인젝션"],
            &["security", "sec", "보안"],
            48,
        ),
        (
            &["review", "audit", "risk", "pr", "리뷰", "검토", "위험"],
            &["reviewer", "review", "auditor", "리뷰어", "검토"],
            40,
        ),
        (
            &["plan", "roadmap", "task", "schedule", "milestone", "todo", "계획", "일정", "작업", "태스크"],
            &["planner", "pm", "project", "planning", "manager", "기획", "플래너"],
            35,
        ),
        (
            &["doc", "docs", "readme", "writing", "copy", "문서", "설명", "작성"],
            &["writer", "docs", "document", "technical writer", "문서", "라이터"],
            32,
        ),
        (
            &["hello", "hi", "hey", "thanks", "thank", "morning", "안녕", "고마워", "굿모닝"],
            &["assistant", "general", "help", "어시스턴트", "도우미"],
            30,
        ),
    ];

    rules
        .iter()
        .filter(|(message_needles, candidate_needles, _)| {
            contains_any(message_lower, message_needles)
                && contains_any(candidate_lower, candidate_needles)
        })
        .map(|(_, _, score)| *score)
        .sum()
}

fn heuristic_route(
    message: &str,
    agents: &[serde_json::Value],
    recent_history: &[serde_json::Value],
) -> Option<HeuristicRoute> {
    let candidates = candidates_from_agents(agents);
    if candidates.is_empty() {
        return None;
    }

    let message_lower = message.to_lowercase();
    let message_tokens = tokenize(message);
    let followup_agent = if looks_like_followup(&message_lower) {
        last_non_user_agent(recent_history)
    } else {
        None
    };

    let mut scored: Vec<(i32, usize, String)> = candidates
        .iter()
        .map(|candidate| {
            let name_lower = candidate.name.to_lowercase();
            let candidate_lower = format!("{} {}", name_lower, candidate.role.to_lowercase());
            let candidate_tokens = tokenize(&candidate_lower);

            let mut score = 0;
            if message_lower.contains(&name_lower) {
                score += 50;
            }
            score += domain_score(&message_lower, &candidate_lower);
            score += message_tokens
                .iter()
                .filter(|token| candidate_tokens.contains(token))
                .take(6)
                .count() as i32
                * 4;
            if followup_agent.as_deref() == Some(name_lower.as_str()) {
                score += 18;
            }

            (score, candidate.index, candidate.name.clone())
        })
        .collect();

    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let (top_score, _, leader) = scored.first()?.clone();
    if top_score <= 0 {
        let fallback = candidates
            .iter()
            .find(|a| a.name.eq_ignore_ascii_case("assistant"))
            .unwrap_or(&candidates[0]);
        return Some(HeuristicRoute {
            leader: fallback.name.clone(),
            collaborators: vec![],
        });
    }

    let collaborators = scored
        .iter()
        .skip(1)
        .filter(|(score, _, _)| *score >= 35 && *score >= top_score - 8)
        .map(|(_, _, name)| name.clone())
        .take(2)
        .collect();

    Some(HeuristicRoute {
        leader,
        collaborators,
    })
}

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

    // Dispatcher still runs on Claude Haiku on the legacy path. When agent
    // execution is on Goose, avoid spawning a separate Claude router and use
    // the deterministic role/keyword router instead.
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
        let route = heuristic_route(&message, &agents, &recent_history).unwrap_or_else(|| {
            HeuristicRoute {
                leader: agent_names[0].to_string(),
                collaborators: vec![],
            }
        });
        eprintln!(
            "[dispatcher:gate] legacy={} dev_override={} → heuristic leader={} collaborators={:?}",
            legacy, dev_override, route.leader, route.collaborators
        );
        return Ok(serde_json::json!({
            "ok": true,
            "leader": route.leader,
            "collaborators": route.collaborators,
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
            let route = heuristic_route(&message, &agents, &recent_history).unwrap_or_else(|| {
                HeuristicRoute {
                    leader: agent_names[0].to_string(),
                    collaborators: vec![],
                }
            });
            Ok(serde_json::json!({
                "ok": true,
                "leader": route.leader,
                "collaborators": route.collaborators
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn agents() -> Vec<serde_json::Value> {
        vec![
            json!({ "name": "designer", "role": "UI and product design" }),
            json!({ "name": "developer", "role": "Rust and TypeScript implementation" }),
            json!({ "name": "tester", "role": "QA, tests, regression coverage" }),
            json!({ "name": "assistant", "role": "General assistant" }),
        ]
    }

    #[test]
    fn heuristic_routes_code_to_developer_even_when_not_first() {
        let route = heuristic_route("Fix the Rust build error", &agents(), &[]).unwrap();
        assert_eq!(route.leader, "developer");
    }

    #[test]
    fn heuristic_routes_design_to_designer() {
        let route = heuristic_route("The modal layout needs better UI spacing", &agents(), &[]).unwrap();
        assert_eq!(route.leader, "designer");
    }

    #[test]
    fn heuristic_routes_tests_to_tester() {
        let route = heuristic_route("Add regression tests for this bug", &agents(), &[]).unwrap();
        assert_eq!(route.leader, "tester");
    }

    #[test]
    fn heuristic_uses_recent_agent_for_followups() {
        let history = vec![json!({ "agentName": "developer", "text": "I changed the build script" })];
        let route = heuristic_route("Continue with that same fix", &agents(), &history).unwrap();
        assert_eq!(route.leader, "developer");
    }

    #[test]
    fn heuristic_prefers_assistant_for_unscored_general_message() {
        let route = heuristic_route("What is this project?", &agents(), &[]).unwrap();
        assert_eq!(route.leader, "assistant");
    }
}
