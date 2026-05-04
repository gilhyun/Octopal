//! Message dispatching — routes a user message to the most appropriate
//! agent based on role + recent history.
//!
//! Uses either the legacy Claude CLI router or a Goose ACP planner turn,
//! depending on the configured agent runtime. Both paths fall back to the
//! deterministic heuristic router if the planner cannot run.

use std::io::BufRead;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, State};

use super::agent::sanitize_prompt_field;
use super::goose_acp::{GooseSpawnConfig, GooseXdgRoots, TurnEvent};
use super::process_pool::ProcessPool;
use crate::commands::providers_manifest::{ModelList, ProvidersManifest};
use crate::state::{AuthMode, ManagedState, OctoPermissions, ProvidersSettings};

const DISPATCHER_PROMPT_TIMEOUT_SECS: u64 = 45;

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

#[derive(Debug, Clone, PartialEq, Eq)]
struct PlannerRuntime {
    provider: String,
    raw_model: String,
    goose_provider: String,
    goose_model: String,
    auth_mode: AuthMode,
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
                "code",
                "bug",
                "fix",
                "implement",
                "refactor",
                "api",
                "component",
                "build",
                "compile",
                "typescript",
                "rust",
                "react",
                "tauri",
                "코드",
                "버그",
                "수정",
                "구현",
                "리팩터",
                "빌드",
                "컴파일",
            ],
            &[
                "developer",
                "dev",
                "engineer",
                "coder",
                "frontend",
                "backend",
                "개발",
                "엔지니어",
            ],
            45,
        ),
        (
            &[
                "ui",
                "ux",
                "design",
                "css",
                "layout",
                "screen",
                "visual",
                "button",
                "modal",
                "디자인",
                "화면",
                "레이아웃",
                "스타일",
            ],
            &["designer", "design", "ui", "ux", "디자이너", "디자인"],
            45,
        ),
        (
            &[
                "test",
                "qa",
                "spec",
                "regression",
                "verify",
                "coverage",
                "테스트",
                "검증",
                "회귀",
            ],
            &["tester", "qa", "test", "테스터", "검증"],
            42,
        ),
        (
            &[
                "security",
                "xss",
                "csrf",
                "injection",
                "auth",
                "permission",
                "sanitize",
                "보안",
                "권한",
                "인젝션",
            ],
            &["security", "sec", "보안"],
            48,
        ),
        (
            &["review", "audit", "risk", "pr", "리뷰", "검토", "위험"],
            &["reviewer", "review", "auditor", "리뷰어", "검토"],
            40,
        ),
        (
            &[
                "plan",
                "roadmap",
                "task",
                "schedule",
                "milestone",
                "todo",
                "계획",
                "일정",
                "작업",
                "태스크",
            ],
            &[
                "planner",
                "pm",
                "project",
                "planning",
                "manager",
                "기획",
                "플래너",
            ],
            35,
        ),
        (
            &[
                "doc", "docs", "readme", "writing", "copy", "문서", "설명", "작성",
            ],
            &[
                "writer",
                "docs",
                "document",
                "technical writer",
                "문서",
                "라이터",
            ],
            32,
        ),
        (
            &[
                "hello",
                "hi",
                "hey",
                "thanks",
                "thank",
                "morning",
                "안녕",
                "고마워",
                "굿모닝",
            ],
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

fn route_json(route: HeuristicRoute) -> Value {
    json!({
        "ok": true,
        "leader": route.leader,
        "collaborators": route.collaborators,
        "model": null
    })
}

fn parse_route_json(text: &str) -> Result<Value, String> {
    let text = text.trim();
    if let Ok(parsed) = serde_json::from_str::<Value>(text) {
        return Ok(parsed);
    }
    if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            if start <= end {
                if let Ok(parsed) = serde_json::from_str::<Value>(&text[start..=end]) {
                    return Ok(parsed);
                }
            }
        }
    }
    Err(format!("Failed to parse routing response: {text}"))
}

fn normalize_parsed_route(parsed: &Value, agent_names: &[String]) -> HeuristicRoute {
    let leader = parsed.get("leader").and_then(|v| v.as_str()).unwrap_or("");
    let valid_leader = agent_names
        .iter()
        .find(|name| name.as_str() == leader)
        .or_else(|| {
            agent_names
                .iter()
                .find(|name| name.eq_ignore_ascii_case(leader))
        })
        .cloned()
        .unwrap_or_else(|| agent_names[0].clone());

    let collaborators = parsed
        .get("collaborators")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .filter_map(|name| {
                    agent_names
                        .iter()
                        .find(|candidate| candidate.eq_ignore_ascii_case(name))
                        .cloned()
                })
                .filter(|name| name != &valid_leader)
                .collect()
        })
        .unwrap_or_default();

    HeuristicRoute {
        leader: valid_leader,
        collaborators,
    }
}

fn default_model_for_provider(provider: &str, manifest: &ProvidersManifest) -> Option<String> {
    match provider {
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

fn model_belongs_to_provider(provider: &str, model: &str, manifest: &ProvidersManifest) -> bool {
    if model.trim().is_empty() {
        return false;
    }
    if provider == "anthropic"
        && matches!(
            model,
            "opus"
                | "sonnet"
                | "haiku"
                | "current"
                | "claude-4-opus"
                | "claude-4-sonnet"
                | "claude-haiku-4-5"
        )
    {
        return true;
    }
    match manifest.get(provider).map(|entry| &entry.models) {
        Some(ModelList::Static(models)) => models.iter().any(|m| m == model),
        Some(ModelList::Dynamic(_)) => true,
        None => false,
    }
}

fn choose_model_for_provider(
    provider: &str,
    preferred: &str,
    manifest: &ProvidersManifest,
) -> Option<String> {
    if model_belongs_to_provider(provider, preferred, manifest) {
        Some(preferred.to_string())
    } else {
        default_model_for_provider(provider, manifest)
    }
}

fn auth_for_provider(settings: &ProvidersSettings, provider: &str) -> AuthMode {
    settings
        .configured_providers
        .get(provider)
        .copied()
        .unwrap_or(AuthMode::None)
}

fn push_candidate(candidates: &mut Vec<(String, String)>, provider: &str, preferred_model: &str) {
    if provider.trim().is_empty() || candidates.iter().any(|(p, _)| p == provider) {
        return;
    }
    candidates.push((provider.to_string(), preferred_model.to_string()));
}

fn choose_planner_runtime(
    settings: &ProvidersSettings,
    manifest: &ProvidersManifest,
) -> Result<PlannerRuntime, String> {
    let mut candidates: Vec<(String, String)> = Vec::new();

    // The planner model setting is currently Anthropic-shaped in the UI, so
    // prefer Anthropic when it is configured. If it is not, fall through to the
    // workspace provider instead of pairing a Claude model with OpenAI/Google.
    push_candidate(
        &mut candidates,
        "anthropic",
        settings.providers_planner_model_or_default().as_str(),
    );
    push_candidate(
        &mut candidates,
        settings.default_provider.as_str(),
        settings.default_model.as_str(),
    );
    for provider in settings.configured_providers.keys() {
        push_candidate(&mut candidates, provider, "");
    }

    for (provider, preferred_model) in candidates {
        let auth_mode = auth_for_provider(settings, &provider);
        if !auth_mode.is_configured() {
            continue;
        }
        let Some(goose_provider) =
            crate::commands::goose_acp::resolve_goose_provider(&provider, auth_mode)
        else {
            continue;
        };
        let raw_model = choose_model_for_provider(&provider, &preferred_model, manifest)
            .ok_or_else(|| format!("No planner model available for provider \"{provider}\""))?;
        let goose_model =
            crate::commands::model_alias::resolve_for_goose_provider(&raw_model, goose_provider);
        return Ok(PlannerRuntime {
            provider,
            raw_model,
            goose_provider: goose_provider.to_string(),
            goose_model,
            auth_mode,
        });
    }

    Err("No configured provider is available for dispatcher routing".to_string())
}

trait PlannerModelExt {
    fn providers_planner_model_or_default(&self) -> String;
}

impl PlannerModelExt for ProvidersSettings {
    fn providers_planner_model_or_default(&self) -> String {
        if self.planner_model.trim().is_empty() {
            "claude-haiku-4-5-20251001".to_string()
        } else {
            self.planner_model.clone()
        }
    }
}

async fn run_goose_planner(
    app: &AppHandle,
    runtime: &PlannerRuntime,
    folder_path: Option<&str>,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<Value, String> {
    let app_data_root = dirs::home_dir()
        .ok_or_else(|| "home_dir not available".to_string())?
        .join(".octopal");
    std::fs::create_dir_all(&app_data_root).map_err(|e| format!("mkdir .octopal: {e}"))?;

    let cwd = folder_path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    let mut cfg = GooseSpawnConfig {
        provider: runtime.goose_provider.clone(),
        model: runtime.goose_model.clone(),
        api_key: None,
        ollama_host: None,
        xdg: GooseXdgRoots::under(&app_data_root),
        permissions: Some(OctoPermissions {
            file_write: Some(false),
            bash: Some(false),
            network: Some(false),
            allow_paths: Some(vec![]),
            deny_paths: Some(vec![]),
        }),
        cwd,
        cli_command: None,
    };

    match runtime.auth_mode {
        AuthMode::ApiKey => {
            cfg.api_key = Some(
                crate::commands::api_keys::load_api_key(&runtime.provider)?
                    .ok_or_else(|| {
                        format!(
                            "No API key configured for provider \"{}\". Add one in Settings → Providers.",
                            runtime.provider
                        )
                    })?,
            );
        }
        AuthMode::CliSubscription => {
            if let Some(binary) = match runtime.provider.as_str() {
                "anthropic" => Some("claude"),
                "openai" => Some("codex"),
                _ => None,
            } {
                cfg.cli_command = crate::commands::binary_discovery::discover_binary(binary);
            }
        }
        AuthMode::None => return Err("planner provider has no auth mode".to_string()),
    }

    eprintln!(
        "[dispatcher:goose] provider={} auth={} goose_provider={} model={}",
        runtime.provider,
        runtime.auth_mode.as_pool_key_segment(),
        runtime.goose_provider,
        runtime.goose_model
    );

    let client = super::goose_acp::spawn_initialized(app, &cfg).await?;
    let session_id = match super::goose_acp::open_turn_session(&client, &cfg).await {
        Ok(sid) => sid,
        Err(e) => {
            client.shutdown().await;
            return Err(e);
        }
    };
    let mut stream = match client.take_stream().await {
        Some(stream) => stream,
        None => {
            let _ = client.close_session(&session_id).await;
            client.shutdown().await;
            return Err("goose planner stream already taken".to_string());
        }
    };

    let prompt = format!(
        "--- OCTOPAL DISPATCHER INSTRUCTIONS ---\n\
         {}\n\
         --- END INSTRUCTIONS ---\n\n\
         {}",
        system_prompt, user_prompt
    );
    let mut collected_text = String::new();
    let turn_result = super::goose_acp::run_turn(
        &client,
        &mut stream,
        &session_id,
        &prompt,
        Duration::from_secs(DISPATCHER_PROMPT_TIMEOUT_SECS),
        |ev| match ev {
            TurnEvent::Mapped(super::goose_acp_mapper::MappedEvent::AssistantTextChunk {
                text,
            }) => {
                collected_text.push_str(&text);
                None
            }
            TurnEvent::Permission(req) => Some(json!({
                "outcome": {
                    "outcome": "cancelled",
                    "message": format!("Dispatcher cannot use tools ({})", req.payload.tool_name)
                }
            })),
            _ => None,
        },
    )
    .await;

    let _ = client.close_session(&session_id).await;
    client.shutdown().await;
    turn_result?;
    parse_route_json(&collected_text)
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
    folder_path: Option<String>,
    app: AppHandle,
    state: State<'_, ManagedState>,
) -> Result<serde_json::Value, String> {
    let msg_lower = message.to_lowercase();

    // ── Fast path: explicit @mention in the user message ──
    for agent in &agents {
        let name = agent.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if msg_lower.contains(&format!("@{}", name.to_lowercase())) {
            return Ok(json!({
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

    let agent_names: Vec<String> = agents
        .iter()
        .filter_map(|a| a.get("name").and_then(|v| v.as_str()))
        .map(str::to_string)
        .collect();

    if agent_names.is_empty() {
        return Ok(json!({
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

    // Dispatcher follows the selected runtime. Legacy keeps the historical
    // persistent Claude CLI router; Goose/new-provider mode now runs a real
    // ACP planner turn instead of silently choosing the first visible agent.
    let (legacy, planner_runtime) = {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        (
            settings.providers.use_legacy_claude_cli,
            choose_planner_runtime(&settings.providers, &state.providers_manifest),
        )
    };
    let dev_override =
        cfg!(debug_assertions) && std::env::var("OCTOPAL_USE_GOOSE").as_deref() == Ok("1");
    let use_goose = !legacy || dev_override;
    if use_goose {
        match planner_runtime {
            Ok(runtime) => {
                match run_goose_planner(
                    &app,
                    &runtime,
                    folder_path.as_deref(),
                    &system_prompt,
                    &user_prompt,
                )
                .await
                {
                    Ok(parsed) => {
                        return Ok(route_json(normalize_parsed_route(&parsed, &agent_names)));
                    }
                    Err(e) => {
                        eprintln!(
                            "[dispatcher:goose] planner failed: {e}. Falling back to heuristic."
                        );
                    }
                }
            }
            Err(e) => {
                eprintln!(
                    "[dispatcher:goose] planner unavailable: {e}. Falling back to heuristic."
                );
            }
        }
        let route =
            heuristic_route(&message, &agents, &recent_history).unwrap_or_else(|| HeuristicRoute {
                leader: agent_names[0].clone(),
                collaborators: vec![],
            });
        return Ok(route_json(route));
    }

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
                        "-p".into(),
                        "--print".into(),
                        "--verbose".into(),
                        "--output-format".into(),
                        "stream-json".into(),
                        "--input-format".into(),
                        "stream-json".into(),
                        "--model".into(),
                        "haiku".into(),
                        "--no-session-persistence".into(),
                        "--system-prompt".into(),
                        system_prompt.clone(),
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
                    "-p".into(),
                    "--print".into(),
                    "--verbose".into(),
                    "--output-format".into(),
                    "stream-json".into(),
                    "--input-format".into(),
                    "stream-json".into(),
                    "--model".into(),
                    "haiku".into(),
                    "--no-session-persistence".into(),
                    "--system-prompt".into(),
                    system_prompt.clone(),
                ];
                let mut p = ProcessPool::create_process(&args, ".")?;
                p.config_hash = config_hash;
                p
            }
        };

        // Send routing query via stdin
        process
            .send_message(&user_prompt)
            .map_err(|e| format!("Failed to send routing query: {}", e))?;

        // Read until result event
        let mut final_text = String::new();
        let mut process_died = false;

        loop {
            let mut line = String::new();
            match process.reader.read_line(&mut line) {
                Ok(0) => {
                    process_died = true;
                    break;
                }
                Ok(_) => {}
                Err(e) => {
                    eprintln!("[dispatcher] read error: {}", e);
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

            if event_type == "system" {
                continue;
            }

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
        if let Ok(parsed) = serde_json::from_str::<Value>(text) {
            return Ok(parsed);
        }
        if let Some(start) = text.find('{') {
            if let Some(end) = text.rfind('}') {
                if let Ok(parsed) = serde_json::from_str::<Value>(&text[start..=end]) {
                    return Ok(parsed);
                }
            }
        }

        Err(format!("Failed to parse routing response: {}", text))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;

    match result {
        Ok(parsed) => Ok(route_json(normalize_parsed_route(&parsed, &agent_names))),
        Err(e) => {
            eprintln!(
                "[dispatcher_route] LLM routing failed: {}. Falling back.",
                e
            );
            let route = heuristic_route(&message, &agents, &recent_history).unwrap_or_else(|| {
                HeuristicRoute {
                    leader: agent_names[0].clone(),
                    collaborators: vec![],
                }
            });
            Ok(route_json(route))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    use serde_json::json;

    fn agents() -> Vec<serde_json::Value> {
        vec![
            json!({ "name": "designer", "role": "UI and product design" }),
            json!({ "name": "developer", "role": "Rust and TypeScript implementation" }),
            json!({ "name": "tester", "role": "QA, tests, regression coverage" }),
            json!({ "name": "assistant", "role": "General assistant" }),
        ]
    }

    fn manifest() -> ProvidersManifest {
        serde_json::from_str(include_str!("../../resources/providers.json")).unwrap()
    }

    #[test]
    fn heuristic_routes_code_to_developer_even_when_not_first() {
        let route = heuristic_route("Fix the Rust build error", &agents(), &[]).unwrap();
        assert_eq!(route.leader, "developer");
    }

    #[test]
    fn heuristic_routes_design_to_designer() {
        let route =
            heuristic_route("The modal layout needs better UI spacing", &agents(), &[]).unwrap();
        assert_eq!(route.leader, "designer");
    }

    #[test]
    fn heuristic_routes_tests_to_tester() {
        let route = heuristic_route("Add regression tests for this bug", &agents(), &[]).unwrap();
        assert_eq!(route.leader, "tester");
    }

    #[test]
    fn heuristic_uses_recent_agent_for_followups() {
        let history =
            vec![json!({ "agentName": "developer", "text": "I changed the build script" })];
        let route = heuristic_route("Continue with that same fix", &agents(), &history).unwrap();
        assert_eq!(route.leader, "developer");
    }

    #[test]
    fn heuristic_prefers_assistant_for_unscored_general_message() {
        let route = heuristic_route("What is this project?", &agents(), &[]).unwrap();
        assert_eq!(route.leader, "assistant");
    }

    #[test]
    fn planner_runtime_prefers_anthropic_planner_when_configured() {
        let mut configured = BTreeMap::new();
        configured.insert("anthropic".to_string(), AuthMode::ApiKey);
        configured.insert("openai".to_string(), AuthMode::ApiKey);
        let settings = ProvidersSettings {
            use_legacy_claude_cli: false,
            default_provider: "openai".to_string(),
            default_model: "gpt-5.5".to_string(),
            planner_model: "claude-haiku-4-5-20251001".to_string(),
            configured_providers: configured,
            api_key_stored: BTreeMap::new(),
        };

        let runtime = choose_planner_runtime(&settings, &manifest()).unwrap();

        assert_eq!(runtime.provider, "anthropic");
        assert_eq!(runtime.raw_model, "claude-haiku-4-5-20251001");
        assert_eq!(runtime.goose_provider, "anthropic");
    }

    #[test]
    fn planner_runtime_uses_workspace_provider_when_anthropic_unconfigured() {
        let mut configured = BTreeMap::new();
        configured.insert("openai".to_string(), AuthMode::ApiKey);
        let settings = ProvidersSettings {
            use_legacy_claude_cli: false,
            default_provider: "openai".to_string(),
            // Simulates stale settings after switching providers. The planner
            // must not pass a Claude model to OpenAI.
            default_model: "claude-sonnet-4-6".to_string(),
            planner_model: "claude-haiku-4-5-20251001".to_string(),
            configured_providers: configured,
            api_key_stored: BTreeMap::new(),
        };

        let runtime = choose_planner_runtime(&settings, &manifest()).unwrap();

        assert_eq!(runtime.provider, "openai");
        assert_eq!(runtime.raw_model, "gpt-5");
        assert_eq!(runtime.goose_provider, "openai");
        assert_eq!(runtime.goose_model, "gpt-5");
    }

    #[test]
    fn normalize_parsed_route_matches_agent_names_case_insensitively() {
        let names = vec![
            "designer".to_string(),
            "developer".to_string(),
            "tester".to_string(),
        ];
        let route = normalize_parsed_route(
            &json!({ "leader": "Developer", "collaborators": ["TESTER", "ghost"] }),
            &names,
        );

        assert_eq!(route.leader, "developer");
        assert_eq!(route.collaborators, vec!["tester"]);
    }
}
