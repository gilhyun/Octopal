mod commands;
mod state;

/// Public re-export for the `examples/keyring_smoke.rs` binary. Smoke
/// tests are the only in-tree consumer outside the Tauri entry. Do not
/// add more re-exports without a concrete external caller — widening
/// the public surface makes future refactors harder.
pub use commands::api_keys as keyring_smoke_api;

use state::ManagedState;
use tauri::Manager;

// ── macOS Dock menu ────────────────────────────────
#[cfg(target_os = "macos")]
#[allow(unexpected_cfgs, deprecated)]
mod dock_menu {
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::runtime::{Class, Object, Sel};
    use objc::{class, msg_send, sel, sel_impl};
    use std::sync::{Once, OnceLock};

    static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();
    static REGISTER_CLASS: Once = Once::new();

    extern "C" fn new_window_action(_this: &Object, _cmd: Sel, _sender: id) {
        if let Some(handle) = APP_HANDLE.get() {
            let label = format!("window-{}", uuid::Uuid::new_v4());
            let _ = tauri::WebviewWindowBuilder::new(
                handle,
                &label,
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Octopal")
            .inner_size(1200.0, 800.0)
            .min_inner_size(300.0, 400.0)
            .decorations(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .accept_first_mouse(true)
            .focused(true)
            .build();
        }
    }

    pub fn setup(app: &tauri::App) {
        let _ = APP_HANDLE.set(app.handle().clone());

        REGISTER_CLASS.call_once(|| {
            let superclass = Class::get("NSObject").unwrap();
            let mut decl =
                objc::declare::ClassDecl::new("OctoDockMenuTarget", superclass).unwrap();
            unsafe {
                decl.add_method(
                    sel!(newWindow:),
                    new_window_action as extern "C" fn(&Object, Sel, id),
                );
            }
            decl.register();
        });

        unsafe {
            let cls = Class::get("OctoDockMenuTarget").unwrap();
            let target: id = msg_send![cls, new];
            // Leak target so it lives for the app lifetime
            let _prevent_drop: id = msg_send![target, retain];

            let menu: id = msg_send![class!(NSMenu), new];
            let title = NSString::alloc(nil).init_str("New Window");
            let key = NSString::alloc(nil).init_str("");
            let item: id = msg_send![class!(NSMenuItem), alloc];
            let item: id = msg_send![item,
                initWithTitle: title
                action: sel!(newWindow:)
                keyEquivalent: key
            ];
            let _: () = msg_send![item, setTarget: target];
            let _: () = msg_send![menu, addItem: item];

            let ns_app: id = msg_send![class!(NSApplication), sharedApplication];
            let _: () = msg_send![ns_app, setDockMenu: menu];
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let is_dev = cfg!(debug_assertions);
    let managed = ManagedState::new(is_dev);

    // Clone the Arc so the background opus probe can write back to the cache
    // without needing access to the full `ManagedState` after `.manage()`
    // takes ownership.
    let opus_cache = managed.best_opus_model.clone();
    std::thread::spawn(move || {
        let best = commands::model_probe::detect_best_opus();
        if let Ok(mut guard) = opus_cache.lock() {
            *guard = Some(best);
        }
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Check if any .octo file was passed as argument
            let octo_file = args.iter().find(|a| a.ends_with(".octo"));
            if let Some(file_path) = octo_file {
                commands::agent::open_octo_file(app, file_path);
            } else {
                // Focus existing window when a second instance is launched
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(managed)
        .on_window_event(|window, event| {
            // Goose ACP pool: 200ms global grace on last-window close
            // (ADR §6.7 / scope §3.2). SIGTERM → 4ms exit in probes, so the
            // budget is pure defensive slack. Legacy process_pool is
            // already cleaned up elsewhere via `stop_all_agents` / drop.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let app_handle = window.app_handle();
                // Only fire on the last window — multi-window instances
                // shouldn't nuke pooled sidecars that other windows are
                // still using.
                let still_open = app_handle.webview_windows().len();
                if still_open > 1 {
                    return;
                }
                let Some(state) = app_handle.try_state::<ManagedState>() else {
                    return;
                };
                let pool = state.goose_acp_pool.clone();
                tauri::async_runtime::spawn(async move {
                    let killed = pool.shutdown_all(200).await;
                    eprintln!(
                        "[goose_acp_pool] shutdown_all grace=200ms sigkilled={}",
                        killed
                    );
                });
            }
        })
        .setup(|app| {
            // Allow asset protocol to access .octopal config directory only
            // (NOT the entire home directory — that triggers macOS permission popups)
            if let Some(home) = dirs::home_dir() {
                let octopal_dir = home.join(".octopal");
                let _ = app
                    .asset_protocol_scope()
                    .allow_directory(&octopal_dir, true);
            }
            // Also allow /tmp for temporary files
            let _ = app.asset_protocol_scope().allow_directory("/tmp", true);

            // Allow all existing workspace folders in asset protocol scope
            if let Ok(st) = app.state::<ManagedState>().app_state.lock() {
                for ws in &st.workspaces {
                    for folder in &ws.folders {
                        let folder_path = std::path::Path::new(folder);
                        let _ = app
                            .asset_protocol_scope()
                            .allow_directory(folder_path, true);
                        // Explicitly allow .octopal subdir — hidden dirs may be
                        // skipped by the glob matcher used in allow_directory.
                        let octopal_sub = folder_path.join(".octopal");
                        let _ = app
                            .asset_protocol_scope()
                            .allow_directory(&octopal_sub, true);
                    }
                }
            }

            #[cfg(target_os = "macos")]
            dock_menu::setup(app);

            // Handle .octo file opened via OS file association (first launch)
            let octo_file = std::env::args().find(|a| a.ends_with(".octo"));
            if let Some(file_path) = octo_file {
                let handle = app.handle().clone();
                // Delay slightly so the main window finishes setup first
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    commands::agent::open_octo_file(&handle, &file_path);
                });
            }

            Ok(())
        })
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
            commands::folder::read_pending_state,
            commands::folder::write_pending_state,
            // Octo (Agent CRUD)
            commands::octo::create_octo,
            commands::octo::update_octo,
            commands::octo::delete_octo,
            commands::octo::read_agent_prompt,
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
            // Files
            commands::files::save_file,
            commands::files::read_file_base64,
            commands::files::get_absolute_path,
            commands::files::read_dropped_file,
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
            // Router
            commands::dispatcher::dispatcher_route,
            // Backup / Revert
            commands::backup::list_backups,
            commands::backup::read_backup_file,
            commands::backup::read_current_file,
            commands::backup::revert_backup,
            commands::backup::prune_backups,
            // Model probe (detects newest available Opus, e.g. 4.7)
            commands::model_probe::get_best_opus_model,
            commands::model_probe::reprobe_best_opus_model,
            // Goose ACP sidecar (Phase 2+)
            commands::goose_acp::check_goose_sidecar,
            commands::goose_acp::acp_smoke_test,
            // DEBUG-ONLY: live pipeline test command. Not compiled into
            // release builds (see goose_acp::acp_turn_test doc).
            #[cfg(debug_assertions)]
            commands::goose_acp::acp_turn_test,
            // Phase 4: API key management (keyring-backed).
            // NOTE: NO load_api_key_cmd — keys only flow Rust-internal
            // after save (ADR §D5, scope §3.2 Zero Trust for Renderer).
            commands::api_keys::save_api_key_cmd,
            commands::api_keys::delete_api_key_cmd,
            commands::api_keys::has_api_key_cmd,
            commands::api_keys::keyring_available_cmd,
            commands::api_keys::keyring_status_cmd,
            commands::api_keys::test_provider_connection,
            commands::providers_manifest::get_providers_manifest,
            // Phase 5a: CLI subscription path (claude-code provider).
            commands::cli_subscription::detect_claude,
            commands::cli_subscription::set_auth_mode_cmd,
            commands::cli_subscription::clear_auth_mode_cmd,
            commands::cli_subscription::get_auth_mode_cmd,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
