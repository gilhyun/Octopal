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
pub fn update_octo(
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
) -> CreateResult {
    let path = Path::new(&octo_path);
    if !path.exists() {
        return CreateResult {
            ok: false,
            path: None,
            error: Some("Agent file not found".to_string()),
        };
    }

    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            return CreateResult {
                ok: false,
                path: None,
                error: Some(e.to_string()),
            }
        }
    };

    let mut octo: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(e) => {
            return CreateResult {
                ok: false,
                path: None,
                error: Some(e.to_string()),
            }
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

    // Write prompt.md only when explicitly provided (decoupled from role)
    if let Some(p) = prompt {
        let _ = fs::write(&prompt_path, &p);
    }

    // If name changed, rename the entire agent folder
    let mut final_path = octo_path.clone();
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
                        let _ = fs::write(&new_config, serde_json::to_string_pretty(&octo).unwrap());
                        final_path = new_config.to_string_lossy().to_string();
                        return CreateResult {
                            ok: true,
                            path: Some(final_path),
                            error: None,
                        };
                    }
                    Err(e) => {
                        return CreateResult {
                            ok: false,
                            path: None,
                            error: Some(format!("Failed to rename agent folder: {}", e)),
                        }
                    }
                }
            }
        }
    }

    match fs::write(path, serde_json::to_string_pretty(&octo).unwrap()) {
        Ok(_) => CreateResult {
            ok: true,
            path: Some(final_path),
            error: None,
        },
        Err(e) => CreateResult {
            ok: false,
            path: None,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub fn delete_octo(octo_path: String) -> CreateResult {
    let path = Path::new(&octo_path);
    if !path.exists() {
        return CreateResult {
            ok: false,
            path: None,
            error: Some("Agent file not found".to_string()),
        };
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

    // Send to OS trash so deletes are recoverable.
    match trash::delete(&target) {
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
    }
}
