use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::State;

use super::path_guard;
use crate::state::ManagedState;

/// Maximum allowed length for the role field (short description, not full prompt).
const MAX_ROLE_LENGTH: usize = 200;
const MAX_AGENT_NAME_LENGTH: usize = 80;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentLayout {
    Directory,
    Legacy,
}

struct ValidatedAgentPath {
    config_path: PathBuf,
    workspace: PathBuf,
    agents_root: PathBuf,
    agent_dir: PathBuf,
    layout: AgentLayout,
}

fn sanitize_agent_identity(name: &str) -> Result<(String, String), String> {
    let filtered: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let display: String = filtered.chars().take(MAX_AGENT_NAME_LENGTH).collect();
    if display.is_empty() {
        return Err("Invalid agent name".to_string());
    }
    let dirname = display.to_lowercase().replace(' ', "-");
    path_guard::safe_segment(&dirname, "agent name")?;
    Ok((display, dirname))
}

fn validate_agent_path(
    state: &ManagedState,
    requested: &Path,
) -> Result<ValidatedAgentPath, String> {
    let folders: Vec<String> = state
        .app_state
        .lock()
        .map_err(|e| e.to_string())?
        .workspaces
        .iter()
        .flat_map(|workspace| workspace.folders.iter().cloned())
        .collect();
    validate_agent_path_in_folders(requested, &folders)
}

pub(crate) fn validate_agent_config_for_workspace(
    state: &ManagedState,
    requested: &Path,
    workspace: &Path,
) -> Result<PathBuf, String> {
    let validated = validate_agent_path(state, requested)?;
    let workspace = fs::canonicalize(workspace).map_err(|e| e.to_string())?;
    if validated.workspace != workspace {
        return Err("agent config belongs to a different workspace".to_string());
    }
    Ok(validated.config_path)
}

fn validate_agent_path_in_folders(
    requested: &Path,
    folders: &[String],
) -> Result<ValidatedAgentPath, String> {
    let final_meta = fs::symlink_metadata(requested).map_err(|e| e.to_string())?;
    if final_meta.file_type().is_symlink() || !final_meta.is_file() {
        return Err("agent config must be a regular file".to_string());
    }
    let config_path = fs::canonicalize(requested).map_err(|e| e.to_string())?;

    for folder in folders {
        let Ok(workspace) = fs::canonicalize(folder) else {
            continue;
        };
        let agents_lexical = workspace.join("octopal-agents");
        let Ok(agents_meta) = fs::symlink_metadata(&agents_lexical) else {
            continue;
        };
        if agents_meta.file_type().is_symlink() || !agents_meta.is_dir() {
            continue;
        }
        let Ok(agents_root) = fs::canonicalize(&agents_lexical) else {
            continue;
        };
        if !agents_root.starts_with(&workspace) || !config_path.starts_with(&agents_root) {
            continue;
        }
        let Ok(relative) = config_path.strip_prefix(&agents_root) else {
            continue;
        };
        let components: Vec<_> = relative.components().collect();
        let layout = match components.as_slice() {
            [Component::Normal(agent), Component::Normal(file)]
                if file == &std::ffi::OsStr::new("config.json") =>
            {
                let agent_name = agent.to_string_lossy();
                path_guard::safe_segment(&agent_name, "agent directory")?;
                let dir = agents_root.join(agent);
                let meta = fs::symlink_metadata(&dir).map_err(|e| e.to_string())?;
                if meta.file_type().is_symlink() || !meta.is_dir() {
                    return Err("agent directory may not be a symlink".to_string());
                }
                AgentLayout::Directory
            }
            [Component::Normal(file)] => {
                let file_name = file.to_string_lossy();
                path_guard::safe_segment(&file_name, "legacy agent file")?;
                let extension = Path::new(file).extension().and_then(|ext| ext.to_str());
                if !matches!(extension, Some("json" | "octo")) {
                    continue;
                }
                AgentLayout::Legacy
            }
            _ => continue,
        };
        return Ok(ValidatedAgentPath {
            agent_dir: config_path
                .parent()
                .ok_or_else(|| "agent config has no parent".to_string())?
                .to_path_buf(),
            config_path,
            workspace,
            agents_root,
            layout,
        });
    }
    Err("agent config is outside registered workspace agent roots".to_string())
}

fn agent_name_exists(agents_root: &Path, dirname: &str, exclude: Option<&Path>) -> bool {
    let candidates = [
        agents_root.join(dirname).join("config.json"),
        agents_root.join(format!("{dirname}.json")),
        agents_root.join(format!("{dirname}.octo")),
    ];
    candidates.iter().any(|candidate| {
        candidate.exists()
            && exclude
                .and_then(|path| fs::canonicalize(path).ok())
                .zip(fs::canonicalize(candidate).ok())
                .map(|(excluded, found)| excluded != found)
                .unwrap_or(true)
    })
}

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
        cleaned
            .chars()
            .take(MAX_ROLE_LENGTH)
            .collect::<String>()
            .trim_end()
            .to_string()
    } else {
        cleaned
    }
}

/// Read the prompt.md file for an agent given its config.json path.
#[tauri::command]
pub fn read_agent_prompt(octo_path: String, state: State<'_, ManagedState>) -> CreateResult {
    let validated = match validate_agent_path(&state, Path::new(&octo_path)) {
        Ok(path) => path,
        Err(error) => {
            return CreateResult {
                ok: false,
                path: None,
                error: Some(error),
            }
        }
    };
    let prompt_path = match validated.layout {
        AgentLayout::Directory => validated.agent_dir.join("prompt.md"),
        AgentLayout::Legacy => validated.config_path.with_extension("md"),
    };
    if prompt_path.exists() {
        let relative = match prompt_path.strip_prefix(&validated.workspace) {
            Ok(relative) => relative,
            Err(_) => {
                return CreateResult {
                    ok: false,
                    path: None,
                    error: Some("Prompt path escapes workspace".to_string()),
                }
            }
        };
        match path_guard::existing_regular_file_path(&validated.workspace, relative)
            .and_then(|path| fs::read_to_string(path).map_err(|e| e.to_string()))
        {
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
#[allow(clippy::too_many_arguments)]
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
    state: State<'_, ManagedState>,
) -> CreateResult {
    let folder = match path_guard::registered_folder(&state, Path::new(&folder_path)) {
        Ok(folder) => folder,
        Err(error) => return create_error(error),
    };
    create_octo_in_registered_folder(
        folder,
        name,
        role,
        prompt,
        icon,
        color,
        permissions,
        mcp_servers,
        provider,
        model,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn create_octo_in_registered_folder(
    folder: PathBuf,
    name: String,
    role: String,
    prompt: Option<String>,
    icon: Option<String>,
    color: Option<String>,
    permissions: Option<serde_json::Value>,
    mcp_servers: Option<serde_json::Value>,
    provider: Option<String>,
    model: Option<String>,
) -> CreateResult {
    let (sanitized_name, dirname) = match sanitize_agent_identity(&name) {
        Ok(identity) => identity,
        Err(error) => return create_error(error),
    };

    let agents_root = folder.join("octopal-agents");
    if let Ok(meta) = fs::symlink_metadata(&agents_root) {
        if meta.file_type().is_symlink() {
            return create_error("Agent root may not be a symlink".to_string());
        }
    }
    if let Err(e) = fs::create_dir_all(&agents_root) {
        return create_error(format!("Failed to create agent root: {e}"));
    }
    let agents_root = match fs::canonicalize(&agents_root) {
        Ok(root) if root.starts_with(&folder) => root,
        _ => return create_error("Agent root escapes workspace".to_string()),
    };
    if agent_name_exists(&agents_root, &dirname, None) {
        return create_error(format!("Agent '{sanitized_name}' already exists"));
    }
    let agent_dir = agents_root.join(&dirname);
    if let Ok(meta) = fs::symlink_metadata(&agent_dir) {
        if meta.file_type().is_symlink() {
            return create_error("Agent folder may not be a symlink".to_string());
        }
        return create_error(format!("Agent '{sanitized_name}' already exists"));
    }
    if let Err(e) = fs::create_dir_all(&agent_dir) {
        return CreateResult {
            ok: false,
            path: None,
            error: Some(format!("Failed to create agent folder: {}", e)),
        };
    }
    let agent_dir = match fs::canonicalize(&agent_dir) {
        Ok(dir) if dir.starts_with(&agents_root) => dir,
        _ => return create_error("Agent folder escapes workspace".to_string()),
    };
    let config_path = agent_dir.join("config.json");
    let prompt_path = agent_dir.join("prompt.md");

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
    let config_json = match serde_json::to_string_pretty(&octo) {
        Ok(json) => json,
        Err(error) => return create_error(error.to_string()),
    };
    match crate::commands::atomic_file::with_path_lock(&config_path, || {
        crate::commands::atomic_file::atomic_write(&config_path, config_json.as_bytes())
    }) {
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
    if let Err(error) = crate::commands::atomic_file::with_path_lock(&prompt_path, || {
        crate::commands::atomic_file::atomic_write(&prompt_path, prompt_content.as_bytes())
    }) {
        let _ = fs::remove_file(&config_path);
        return create_error(error.to_string());
    }

    CreateResult {
        ok: true,
        path: Some(config_path.to_string_lossy().to_string()),
        error: None,
    }
}

fn create_error(error: String) -> CreateResult {
    CreateResult {
        ok: false,
        path: None,
        error: Some(error),
    }
}

struct UpdatedOctoFiles {
    final_config: PathBuf,
    old_workspace: PathBuf,
    old_agent_name: Option<String>,
}

fn prospective_config_path(
    validated: &ValidatedAgentPath,
    new_identity: Option<&(String, String)>,
) -> PathBuf {
    let Some((_, dirname)) = new_identity else {
        return validated.config_path.clone();
    };
    match validated.layout {
        AgentLayout::Directory => validated.agents_root.join(dirname).join("config.json"),
        AgentLayout::Legacy => {
            let extension = validated
                .config_path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("json");
            validated.agents_root.join(format!("{dirname}.{extension}"))
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn update_octo_files(
    state: &ManagedState,
    requested_path: &Path,
    new_identity: Option<(String, String)>,
    role: Option<String>,
    prompt: Option<String>,
    icon: Option<String>,
    color: Option<String>,
    permissions: Option<serde_json::Value>,
    mcp_servers: Option<serde_json::Value>,
    provider: Option<String>,
    model: Option<String>,
) -> Result<UpdatedOctoFiles, String> {
    // Revalidate after waiting for the transaction locks. A concurrent rename
    // or symlink replacement must fail rather than operating on stale metadata.
    let validated = validate_agent_path(state, requested_path)?;
    let content = fs::read_to_string(&validated.config_path).map_err(|e| e.to_string())?;
    let mut octo: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    if !octo.is_object() {
        return Err("Agent config must be a JSON object".to_string());
    }

    if let Some((display, _)) = &new_identity {
        octo["name"] = serde_json::Value::String(display.clone());
    }
    if let Some(role) = role {
        octo["role"] = serde_json::Value::String(sanitize_role(&role));
    }
    if let Some(icon) = icon {
        octo["icon"] = serde_json::Value::String(icon);
    }
    if let Some(color) = color {
        octo["color"] = serde_json::Value::String(color);
    }
    if let Some(permissions) = permissions {
        octo["permissions"] = permissions;
    }
    if let Some(mcp_servers) = mcp_servers {
        if mcp_servers.is_null() {
            octo.as_object_mut()
                .map(|object| object.remove("mcpServers"));
        } else {
            octo["mcpServers"] = mcp_servers;
        }
    }
    if let Some(provider) = provider {
        if provider.is_empty() {
            octo.as_object_mut().map(|object| object.remove("provider"));
        } else {
            octo["provider"] = serde_json::Value::String(provider);
        }
    }
    if let Some(model) = model {
        if model.is_empty() {
            octo.as_object_mut().map(|object| object.remove("model"));
        } else {
            octo["model"] = serde_json::Value::String(model);
        }
    }

    let old_workspace = validated.workspace.clone();
    let old_agent_name = match validated.layout {
        AgentLayout::Directory => validated.agent_dir.file_name(),
        AgentLayout::Legacy => validated.config_path.file_stem(),
    }
    .and_then(|name| name.to_str())
    .map(str::to_string);
    let serialized = serde_json::to_vec_pretty(&octo).map_err(|e| e.to_string())?;
    let old_prompt = match validated.layout {
        AgentLayout::Directory => validated.agent_dir.join("prompt.md"),
        AgentLayout::Legacy => validated.config_path.with_extension("md"),
    };
    let mut final_config = validated.config_path.clone();
    let mut final_prompt = old_prompt.clone();

    if let Some((display, dirname)) = &new_identity {
        if agent_name_exists(
            &validated.agents_root,
            dirname,
            Some(&validated.config_path),
        ) {
            return Err(format!("Agent '{display}' already exists"));
        }
        match validated.layout {
            AgentLayout::Directory => {
                let new_agent_dir = validated.agents_root.join(dirname);
                if new_agent_dir != validated.agent_dir {
                    if new_agent_dir.exists() {
                        return Err(format!("Agent '{display}' already exists"));
                    }
                    fs::rename(&validated.agent_dir, &new_agent_dir)
                        .map_err(|e| format!("Failed to rename agent folder: {e}"))?;
                    final_config = new_agent_dir.join("config.json");
                    final_prompt = new_agent_dir.join("prompt.md");
                }
            }
            AgentLayout::Legacy => {
                let extension = validated
                    .config_path
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("json");
                let new_config = validated.agents_root.join(format!("{dirname}.{extension}"));
                let new_prompt = validated.agents_root.join(format!("{dirname}.md"));
                if new_config != validated.config_path {
                    if new_config.exists() || (old_prompt.exists() && new_prompt.exists()) {
                        return Err(format!("Agent '{display}' already exists"));
                    }
                    fs::rename(&validated.config_path, &new_config)
                        .map_err(|e| format!("Failed to rename legacy agent file: {e}"))?;
                    if old_prompt.exists() {
                        if let Err(error) = fs::rename(&old_prompt, &new_prompt) {
                            let _ = fs::rename(&new_config, &validated.config_path);
                            return Err(format!("Failed to rename legacy agent prompt: {error}"));
                        }
                    }
                    final_config = new_config;
                    final_prompt = new_prompt;
                }
            }
        }
    }

    let config_relative = final_config
        .strip_prefix(&validated.workspace)
        .map_err(|_| "Agent config path escapes workspace".to_string())?;
    let final_config = path_guard::write_target_path(&validated.workspace, config_relative)?;
    crate::commands::atomic_file::atomic_write(&final_config, &serialized)?;
    if let Some(prompt) = prompt {
        let relative = final_prompt
            .strip_prefix(&validated.workspace)
            .map_err(|_| "Prompt path escapes workspace".to_string())?;
        let final_prompt = path_guard::write_target_path(&validated.workspace, relative)?;
        crate::commands::atomic_file::atomic_write(&final_prompt, prompt.as_bytes())?;
    }

    Ok(UpdatedOctoFiles {
        final_config,
        old_workspace,
        old_agent_name,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
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
    let pool_invalidation_needed = provider.is_some() || model.is_some() || name.is_some();

    let validated = match validate_agent_path(&state, Path::new(&octo_path)) {
        Ok(path) => path,
        Err(error) => return Ok(create_error(error)),
    };
    let new_identity = match name.as_deref() {
        Some(name) => match sanitize_agent_identity(name) {
            Ok(identity) => Some(identity),
            Err(error) => return Ok(create_error(error)),
        },
        None => None,
    };

    let lock_paths = vec![
        validated.config_path.clone(),
        prospective_config_path(&validated, new_identity.as_ref()),
    ];
    let updated = match crate::commands::atomic_file::with_path_locks(&lock_paths, || {
        update_octo_files(
            &state,
            Path::new(&octo_path),
            new_identity,
            role,
            prompt,
            icon,
            color,
            permissions,
            mcp_servers,
            provider,
            model,
        )
    }) {
        Ok(updated) => updated,
        Err(error) => return Ok(create_error(error)),
    };

    // Phase 6 follow-up FU-001: write succeeded → invalidate pooled
    // sidecars for this agent so the next turn re-reads the freshly
    // written config.json. Done AFTER the write so we don't tear down
    // sidecars on a failed update. `invalidate_pool_for_agent` is keyed
    // by `{workspace}::{agent_name}::` prefix, which catches every
    // (provider, auth_mode, model) variant for the agent.
    if pool_invalidation_needed {
        if let Some(agent) = updated.old_agent_name {
            let folder = updated.old_workspace;
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
        path: Some(updated.final_config.to_string_lossy().into_owned()),
        error: None,
    })
}

#[tauri::command]
pub async fn delete_octo(
    state: tauri::State<'_, crate::state::ManagedState>,
    octo_path: String,
) -> Result<CreateResult, String> {
    let validated = match validate_agent_path(&state, Path::new(&octo_path)) {
        Ok(path) => path,
        Err(error) => return Ok(create_error(error)),
    };

    // Determine what to delete:
    // - v3 subfolder structure: config.json's parent folder (the agent folder)
    // - legacy flat file: just the file + companion .md
    let target = match validated.layout {
        AgentLayout::Directory => validated.agent_dir.clone(),
        AgentLayout::Legacy => validated.config_path.clone(),
    };
    let legacy_prompt = if validated.layout == AgentLayout::Legacy {
        Some(validated.config_path.with_extension("md"))
    } else {
        None
    };

    // Capture pool-key segments BEFORE the delete so we can invalidate
    // any pooled sidecar for this agent. Sister fix to FU-001 for
    // update_octo: a deleted agent's pool entries would otherwise sit
    // around until app shutdown / unrelated invalidation. Harmless but
    // unclean; doing it here keeps the pool's "live agents only"
    // invariant honest.
    let workspace = Some(validated.workspace.clone());
    let agent_name = match validated.layout {
        AgentLayout::Directory => validated.agent_dir.file_name(),
        AgentLayout::Legacy => validated.config_path.file_stem(),
    };
    let agent_name = agent_name
        .and_then(|name| name.to_str())
        .map(str::to_string);

    // Send to OS trash so deletes are recoverable.
    let delete_result = match trash::delete(&target) {
        Ok(_) => CreateResult {
            ok: true,
            path: None,
            error: None,
        },
        Err(e) => {
            // Fall back to hard delete
            let result = if validated.layout == AgentLayout::Directory {
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

    if delete_result.ok {
        if let Some(prompt) = legacy_prompt.filter(|path| path.exists()) {
            let relative = prompt
                .strip_prefix(&validated.workspace)
                .map_err(|_| "legacy prompt escapes workspace".to_string())?;
            if let Ok(prompt) =
                path_guard::existing_regular_file_path(&validated.workspace, relative)
            {
                let _ = trash::delete(&prompt).or_else(|_| fs::remove_file(&prompt));
            }
        }
    }

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

#[cfg(test)]
mod security_tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "octopal-octo-security-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn agent_config(workspace: &Path, name: &str) -> PathBuf {
        let dir = workspace.join("octopal-agents").join(name);
        fs::create_dir_all(&dir).unwrap();
        let config = dir.join("config.json");
        fs::write(&config, r#"{"name":"test","role":"test"}"#).unwrap();
        config
    }

    #[test]
    fn agent_path_must_use_registered_octopal_agents_layout() {
        let workspace = temp_dir("workspace");
        let outside = temp_dir("outside");
        let valid = agent_config(&workspace, "developer");
        let outside_config = agent_config(&outside, "attacker");
        let folders = vec![workspace.to_string_lossy().into_owned()];

        let validated = validate_agent_path_in_folders(&valid, &folders).unwrap();
        assert_eq!(validated.layout, AgentLayout::Directory);
        assert!(validate_agent_path_in_folders(&outside_config, &folders).is_err());

        let unrelated = workspace.join("config.json");
        fs::write(&unrelated, "{}").unwrap();
        assert!(validate_agent_path_in_folders(&unrelated, &folders).is_err());
        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn create_and_update_share_a_path_safe_name_sanitizer() {
        let (display, dirname) = sanitize_agent_identity("../../New / Agent").unwrap();
        assert_eq!(display, "New Agent");
        assert_eq!(dirname, "new-agent");
        assert!(path_guard::safe_segment(&dirname, "agent name").is_ok());
        assert!(sanitize_agent_identity("../../").is_err());
    }

    #[test]
    fn duplicate_agent_names_cover_directory_and_legacy_layouts() {
        let workspace = temp_dir("duplicates");
        let agents = workspace.join("octopal-agents");
        let config = agent_config(&workspace, "developer");
        assert!(agent_name_exists(&agents, "developer", None));
        assert!(!agent_name_exists(&agents, "developer", Some(&config)));
        fs::write(agents.join("legacy.octo"), "{}").unwrap();
        assert!(agent_name_exists(&agents, "legacy", None));
        let _ = fs::remove_dir_all(workspace);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_agent_config_cannot_escape_workspace() {
        use std::os::unix::fs::symlink;

        let workspace = temp_dir("symlink-workspace");
        let outside = temp_dir("symlink-outside");
        fs::write(outside.join("config.json"), "{}").unwrap();
        let agent_dir = workspace.join("octopal-agents/evil");
        fs::create_dir_all(&agent_dir).unwrap();
        symlink(outside.join("config.json"), agent_dir.join("config.json")).unwrap();
        let folders = vec![workspace.to_string_lossy().into_owned()];
        assert!(validate_agent_path_in_folders(&agent_dir.join("config.json"), &folders).is_err());
        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(outside);
    }
}
