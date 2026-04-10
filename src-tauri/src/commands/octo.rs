use serde::Serialize;
use std::fs;
use std::path::Path;

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
    icon: Option<String>,
    color: Option<String>,
    permissions: Option<serde_json::Value>,
    mcp_servers: Option<serde_json::Value>,
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

    let filename = sanitized_name.to_lowercase().replace(' ', "-");
    let octo_path = Path::new(&folder_path).join(format!("{}.octo", filename));

    if octo_path.exists() {
        return CreateResult {
            ok: false,
            path: None,
            error: Some(format!("Agent '{}' already exists", sanitized_name)),
        };
    }

    let mut octo = serde_json::json!({
        "name": sanitized_name,
        "role": role,
        "icon": icon.unwrap_or_else(|| "🤖".to_string()),
        "history": [],
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

    match fs::write(&octo_path, serde_json::to_string_pretty(&octo).unwrap()) {
        Ok(_) => CreateResult {
            ok: true,
            path: Some(octo_path.to_string_lossy().to_string()),
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
pub fn update_octo(
    octo_path: String,
    name: Option<String>,
    role: Option<String>,
    icon: Option<String>,
    color: Option<String>,
    permissions: Option<serde_json::Value>,
    mcp_servers: Option<serde_json::Value>,
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
        octo["role"] = serde_json::Value::String(r);
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

    // If name changed, we may need to rename the file
    let mut final_path = octo_path.clone();
    if let Some(new_name) = &name {
        let new_filename = new_name.to_lowercase().replace(' ', "-");
        let new_path = path
            .parent()
            .unwrap()
            .join(format!("{}.octo", new_filename));
        if new_path != path && !new_path.exists() {
            match fs::write(&new_path, serde_json::to_string_pretty(&octo).unwrap()) {
                Ok(_) => {
                    fs::remove_file(path).ok();
                    final_path = new_path.to_string_lossy().to_string();
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
                        error: Some(e.to_string()),
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

    match fs::remove_file(path) {
        Ok(_) => CreateResult {
            ok: true,
            path: None,
            error: None,
        },
        Err(e) => CreateResult {
            ok: false,
            path: None,
            error: Some(e.to_string()),
        },
    }
}
