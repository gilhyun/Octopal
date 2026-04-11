mod commands;
mod state;

use state::ManagedState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let is_dev = cfg!(debug_assertions);
    let managed = ManagedState::new(is_dev);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus existing window when a second instance is launched
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .manage(managed)
        .invoke_handler(tauri::generate_handler![
            // Workspace
            commands::workspace::load_state,
            commands::workspace::create_workspace,
            commands::workspace::rename_workspace,
            commands::workspace::remove_workspace,
            commands::workspace::set_active_workspace,
            // Folder
            commands::folder::pick_folder,
            commands::folder::remove_folder,
            commands::folder::list_octos,
            commands::folder::load_history,
            commands::folder::load_history_paged,
            commands::folder::append_user_message,
            // Octo (Agent CRUD)
            commands::octo::create_octo,
            commands::octo::update_octo,
            commands::octo::delete_octo,
            // Agent execution
            commands::agent::check_claude_cli,
            commands::agent::send_message,
            commands::agent::stop_agent,
            commands::agent::stop_all_agents,
            commands::agent::get_platform,
            // Wiki
            commands::wiki::wiki_list,
            commands::wiki::wiki_read,
            commands::wiki::wiki_write,
            commands::wiki::wiki_delete,
            // Git
            commands::git::git_get_history,
            commands::git::git_get_diff,
            commands::git::git_revert,
            commands::git::git_push,
            commands::git::git_has_remote,
            // Files
            commands::files::save_file,
            commands::files::read_file_base64,
            commands::files::get_absolute_path,
            // Settings
            commands::settings::load_settings,
            commands::settings::save_settings,
            commands::settings::get_version,
            // MCP
            commands::agent::mcp_health_check,
            commands::agent::mcp_install_package,
            // Multi-window
            commands::agent::new_window,
            commands::agent::get_window_count,
            // File access
            commands::agent::respond_file_access,
            // Observer / Router
            commands::observer::observer_update,
            commands::observer::observer_get_context,
            commands::observer::observer_reset,
            commands::observer::smart_observer_get_context,
            commands::observer::smart_observer_force_refresh,
            commands::observer::smart_observer_set_enabled,
            commands::observer::smart_observer_set_model,
            commands::observer::smart_observer_get_model,
            commands::observer::smart_observer_get_metrics,
            commands::observer::dispatcher_route,
            commands::observer::classify_mention,
            commands::observer::dispatcher_check_context,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
