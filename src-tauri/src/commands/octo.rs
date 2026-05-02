use serde::Serialize;
use std::fs;
use std::path::Path;

/// Maximum allowed length for the role field (short description, not full prompt).
const MAX_ROLE_LENGTH: usize = 200;

/// Sanitize the role field: strip control characters (including newlines),
/// collapse whitespace, and enforce a length limit.
/// This prevents prompt injection via `.octo` files where a crafted role
/// could break out of the system prompt structure.
pub fn sanitize_role(role: &str) -> String {
    let cleaned: String = role
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ");
    if cleaned.len() > MAX_ROLE_LENGTH {
        cleaned.chars().take(MAX_ROLE_LENGTH).collect::<String>().trim_end().to_string()
    } else {
        cleaned
    }
}

/// Read the prompt.md file for an agent given its config.json path.
#[tauri::command]
pub fn read_agent_prompt(octo_path: String) -> CreateResult {
    let path = Path::new(&octo_path);
    if !path.exists() {
        return CreateResult {
            ok: false,
            path: None,
            error: Some("Agent file not found".to_string()),
        };
    }
    let agent_dir = path.parent().unwrap();
    let prompt_path = agent_dir.join("prompt.md");
    if prompt_path.exists() {
        match fs::read_to_string(&prompt_path) {
            Ok(content) => CreateResult {
                ok: true,
                path: Some(content), // reuse path field for prompt content
                error: None,
            },
            Err(e) => CreateResult {
                ok: false,
                path: None,
                error: Some(e.to_string()),
            },
        }
    } else {
        // No prompt.md — return empty
        CreateResult {
            ok: true,
            path: Some(String::new()),
            error: None,
        }
    }
}

#[derive(Serialize)]
pub struct CreateResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[tauri::command]
pub fn create_octo(
    folder_path: String,
    name: String,
    role: String,
    prompt: Option<String>,
    icon: Option<String>,
    color: Option<String>,
    permissions: Option<serde_json::Value>,
    mcp_servers: Option<serde_json::Value>,
    // Phase 6 §3: per-agent provider/model binding. Both optional —
    // absent / null / empty string ⇒ inherit settings defaults at
    // turn time (resolved by `agent_config::resolve_for_turn`).
    provider: Option<String>,
    model: Option<String>,
) -> CreateResult {
    let sanitized_name = name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == ' ')
        .collect::<String>()
        .trim()
        .to_string();

    if sanitized_name.is_empty() {
        return CreateResult {
            ok: false,
            path: None,
            error: Some("Invalid agent name".to_string()),
        };
    }

    let dirname = sanitized_name.to_lowercase().replace(' ', "-");
    let agent_dir = Path::new(&folder_path).join("octopal-agents").join(&dirname);
    if let Err(e) = fs::create_dir_all(&agent_dir) {
        return CreateResult {
            ok: false,
            path: None,
            error: Some(format!("Failed to create agent folder: {}", e)),
        };
    }
    let config_path = agent_dir.join("config.json");
    let prompt_path = agent_dir.join("prompt.md");

    if config_path.exists() {
        return CreateResult {
            ok: false,
            path: None,
            error: Some(format!("Agent '{}' already exists", sanitized_name)),
        };
    }

    let sanitized_role = sanitize_role(&role);

    let mut octo = serde_json::json!({
        "name": sanitized_name,
        "role": sanitized_role,
        "icon": icon.unwrap_or_else(|| "🤖".to_string()),
        "memory": [],
    });

    if let Some(c) = color {
        octo["color"] = serde_json::Value::String(c);
    }
    if let Some(p) = permissions {
        octo["permissions"] = p;
    }
    if let Some(m) = mcp_servers {
        octo["mcpServers"] = m;
    }
    // Phase 6: write provider/model only when explicitly set to a
    // non-empty string. Absent / null / empty ⇒ inherit defaults at
    // turn time. We deliberately don't write the field at all (vs.
    // writing `null`) so the JSON stays compatible with v0.1.42 readers.
    if let Some(p) = provider.as_deref().filter(|s| !s.is_empty()) {
        octo["provider"] = serde_json::Value::String(p.to_string());
    }
    if let Some(m) = model.as_deref().filter(|s| !s.is_empty()) {
        octo["model"] = serde_json::Value::String(m.to_string());
    }

    // Write agent config.json
    match fs::write(&config_path, serde_json::to_string_pretty(&octo).unwrap()) {
        Ok(_) => {}
        Err(e) => {
            return CreateResult {
                ok: false,
                path: None,
                error: Some(e.to_string()),
            }
        }
    }

    // Write prompt.md (use dedicated prompt if provided, otherwise role as fallback)
    let prompt_content = prompt.unwrap_or_else(|| sanitized_role.clone());
    let _ = fs::write(&prompt_path, &prompt_content);

    CreateResult {
        ok: true,
        path: Some(config_path.to_string_lossy().to_string()),
        error: None,
    }
}

#[tauri::command]
pub async fn update_octo(
    state: tauri::State<'_, crate::state::ManagedState>,
    octo_path: String,
    name: Option<String>,
    role: Option<String>,
    prompt: Option<String>,
    icon: Option<String>,
    color: Option<String>,
    permissions: Option<serde_json::Value>,
    mcp_servers: Option<serde_json::Value>,
    // Phase 6 §3: per-agent provider/model. Three-state semantics:
    //   None         → don't touch the existing field (omitted from request)
    //   Some("")     → REMOVE the field (UI "Use workspace default" checkbox)
    //   Some(value)  → set to value
    // The empty-string-as-clear convention parallels how `mcp_servers`
    // already accepts JSON null to remove, but we reuse Option<String>
    // here for serde simplicity on the renderer side.
    provider: Option<String>,
    model: Option<String>,
) -> Result<CreateResult, String> {
    // Phase 6 follow-up FU-001: invalidate the Goose ACP pool whenever
    // provider / model / agent name changes. Without this, a pooled
    // sidecar spawned under the previous (provider, model) keeps serving
    // turns until the pool is invalidated for some other reason
    // (key rotation, app restart, agent delete) — i.e. the user updates
    // the model in the UI, the file flips on disk, but responses still
    // come from the stale Claude/Sonnet sidecar. See
    // wiki/specs/phase-followups.md FU-001 for the diagnosis.
    let pool_invalidation_needed =
        provider.is_some() || model.is_some() || name.is_some();

    let path = Path::new(&octo_path);
    if !path.exists() {
        return Ok(CreateResult {
            ok: false,
            path: None,
            error: Some("Agent file not found".to_string()),
        });
    }

    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            return Ok(CreateResult {
                ok: false,
                path: None,
                error: Some(e.to_string()),
            })
        }
    };

    let mut octo: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(e) => {
            return Ok(CreateResult {
                ok: false,
                path: None,
                error: Some(e.to_string()),
            })
        }
    };

    if let Some(n) = &name {
        octo["name"] = serde_json::Value::String(n.clone());
    }
    if let Some(r) = role {
        octo["role"] = serde_json::Value::String(sanitize_role(&r));
    }
    if let Some(i) = icon {
        octo["icon"] = serde_json::Value::String(i);
    }
    if let Some(c) = color {
        octo["color"] = serde_json::Value::String(c);
    }
    if let Some(p) = permissions {
        octo["permissions"] = p;
    }
    // mcpServers can be explicitly set to null to remove
    if let Some(m) = mcp_servers {
        if m.is_null() {
            octo.as_object_mut().map(|o| o.remove("mcpServers"));
        } else {
            octo["mcpServers"] = m;
        }
    }
    // Phase 6: provider/model 3-state semantics — empty string clears,
    // non-empty sets, None leaves untouched. See create_octo for the
    // "absent vs explicit clear" rationale.
    if let Some(p) = provider {
        if p.is_empty() {
            octo.as_object_mut().map(|o| o.remove("provider"));
        } else {
            octo["provider"] = serde_json::Value::String(p);
        }
    }
    if let Some(m) = model {
        if m.is_empty() {
            octo.as_object_mut().map(|o| o.remove("model"));
        } else {
            octo["model"] = serde_json::Value::String(m);
        }
    }

    // Resolve companion prompt.md path (in the same directory as config.json)
    let agent_dir = path.parent().unwrap();
    let prompt_path = agent_dir.join("prompt.md");

    // Capture the OLD pool-key segments (workspace folder + agent name)
    // before any rename. The pool is keyed under
    // `{workspace}::{agent_name}::…` — `agent_name` is derived from the
    // agent folder name (i.e. what's about to change if `name` is set).
    // We must invalidate under the OLD name so leftover entries don't
    // stick around indefinitely after a rename.
    let old_workspace = agent_dir
        .parent() // octopal-agents/
        .and_then(|p| p.parent()) // workspace folder
        .map(|p| p.to_path_buf());
    let old_agent_name = agent_dir
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::to_string);

    // Write prompt.md only when explicitly provided (decoupled from role)
    if let Some(p) = prompt {
        let _ = fs::write(&prompt_path, &p);
    }

    // If name changed, rename the entire agent folder
    let mut final_path = octo_path.clone();
    let mut write_succeeded = false;
    let mut error_result: Option<CreateResult> = None;

    if let Some(new_name) = &name {
        let new_dirname = new_name.to_lowercase().replace(' ', "-");
        // Agent folder's parent is octopal-agents/
        if let Some(agents_root) = agent_dir.parent() {
            let new_agent_dir = agents_root.join(&new_dirname);

            if new_agent_dir != agent_dir && !new_agent_dir.exists() {
                match fs::rename(agent_dir, &new_agent_dir) {
                    Ok(_) => {
                        // Write updated config to new location
                        let new_config = new_agent_dir.join("config.json");
                        let _ =
                            fs::write(&new_config, serde_json::to_string_pretty(&octo).unwrap());
                        final_path = new_config.to_string_lossy().to_string();
                        write_succeeded = true;
                    }
                    Err(e) => {
                        error_result = Some(CreateResult {
                            ok: false,
                            path: None,
                            error: Some(format!("Failed to rename agent folder: {}", e)),
                        });
                    }
                }
            }
        }
    }

    // Standard write path (no rename, or rename was a no-op).
    if error_result.is_none() && !write_succeeded {
        if let Err(e) = fs::write(path, serde_json::to_string_pretty(&octo).unwrap()) {
            error_result = Some(CreateResult {
                ok: false,
                path: None,
                error: Some(e.to_string()),
            });
        }
    }

    if let Some(err) = error_result {
        return Ok(err);
    }

    // Phase 6 follow-up FU-001: write succeeded → invalidate pooled
    // sidecars for this agent so the next turn re-reads the freshly
    // written config.json. Done AFTER the write so we don't tear down
    // sidecars on a failed update. `invalidate_pool_for_agent` is keyed
    // by `{workspace}::{agent_name}::` prefix, which catches every
    // (provider, auth_mode, model, sp_hash) variant for the agent.
    if pool_invalidation_needed {
        if let (Some(folder), Some(agent)) = (old_workspace, old_agent_name) {
            let folder_str = folder.to_string_lossy().to_string();
            let evicted = state
                .goose_acp_pool
                .invalidate_pool_for_agent(&folder_str, &agent);
            let evicted_count = evicted.len();
            for entry in evicted {
                entry.client.shutdown().await;
            }
            if evicted_count > 0 {
                eprintln!(
                    "[octo::update_octo] invalidate_pool_for_agent({} :: {}) → {} sidecars shut down (config changed)",
                    folder_str, agent, evicted_count
                );
            }
        }
    }

    Ok(CreateResult {
        ok: true,
        path: Some(final_path),
        error: None,
    })
}

#[tauri::command]
pub async fn delete_octo(
    state: tauri::State<'_, crate::state::ManagedState>,
    octo_path: String,
) -> Result<CreateResult, String> {
    let path = Path::new(&octo_path);
    if !path.exists() {
        return Ok(CreateResult {
            ok: false,
            path: None,
            error: Some("Agent file not found".to_string()),
        });
    }

    // Determine what to delete:
    // - v3 subfolder structure: config.json's parent folder (the agent folder)
    // - legacy flat file: just the file + companion .md
    let target = if path.file_name().and_then(|n| n.to_str()) == Some("config.json") {
        // v3: delete the entire agent folder
        path.parent().unwrap().to_path_buf()
    } else {
        // Legacy: delete the file itself + companion .md
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            if let Some(parent) = path.parent() {
                let md_path = parent.join(format!("{}.md", stem));
                if md_path.exists() {
                    let _ = trash::delete(&md_path).or_else(|_| fs::remove_file(&md_path));
                }
            }
        }
        path.to_path_buf()
    };

    // Capture pool-key segments BEFORE the delete so we can invalidate
    // any pooled sidecar for this agent. Sister fix to FU-001 for
    // update_octo: a deleted agent's pool entries would otherwise sit
    // around until app shutdown / unrelated invalidation. Harmless but
    // unclean; doing it here keeps the pool's "live agents only"
    // invariant honest.
    let (workspace, agent_name) = if target.is_dir() {
        // v3 subfolder layout: target is the agent folder itself.
        let workspace = target
            .parent() // octopal-agents/
            .and_then(|p| p.parent())
            .map(|p| p.to_path_buf());
        let name = target
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_string);
        (workspace, name)
    } else {
        // Legacy flat file: stem is the agent name, parent's parent is
        // the workspace (octopal-agents/{file}.octo or similar).
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_string);
        let workspace = path.parent().and_then(|p| p.parent()).map(|p| p.to_path_buf());
        (workspace, name)
    };

    // Send to OS trash so deletes are recoverable.
    let delete_result = match trash::delete(&target) {
        Ok(_) => CreateResult {
            ok: true,
            path: None,
            error: None,
        },
        Err(e) => {
            // Fall back to hard delete
            let result = if target.is_dir() {
                fs::remove_dir_all(&target)
            } else {
                fs::remove_file(&target)
            };
            match result {
                Ok(_) => CreateResult {
                    ok: true,
                    path: None,
                    error: None,
                },
                Err(fs_err) => CreateResult {
                    ok: false,
                    path: None,
                    error: Some(format!("trash: {}, fs: {}", e, fs_err)),
                },
            }
        }
    };

    // Only evict on a successful delete — keeping a sidecar around for
    // an agent whose delete failed is the correct behavior (the agent
    // is still on disk and may answer further turns).
    if delete_result.ok {
        if let (Some(folder), Some(agent)) = (workspace, agent_name) {
            let folder_str = folder.to_string_lossy().to_string();
            let evicted = state
                .goose_acp_pool
                .invalidate_pool_for_agent(&folder_str, &agent);
            let evicted_count = evicted.len();
            for entry in evicted {
                entry.client.shutdown().await;
            }
            if evicted_count > 0 {
                eprintln!(
                    "[octo::delete_octo] invalidate_pool_for_agent({} :: {}) → {} sidecars shut down (agent deleted)",
                    folder_str, agent, evicted_count
                );
            }
        }
    }

    Ok(delete_result)
}
