//! Lumisca desktop shell.
//!
//! This module owns only the shared [`AppState`] (each field is a `Mutex`
//! so the sibling modules can borrow individual pieces without locking the
//! whole app) and the Tauri builder in [`run`]. Everything else lives in
//! the re-exported modules: [`server`] (local server process), [`bridge`]
//! (the `lumisca://` protocol), [`update`] (auto-update), [`window`]
//! (window navigation and the Win32 drag hack).

use std::sync::{Arc, Mutex};
use tauri::{Manager, WindowEvent};

pub mod bridge;
pub mod browser_lab;
pub mod server;
pub mod update;
pub mod window;

/// Result slot of the background local-server startup: the thread fills it
/// with the page URL once the server answers `/api/health`.
type StartupTask = Arc<Mutex<Option<Result<String, String>>>>;

/// Local server startup progress, surfaced to the splash page.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StartupStatus {
    /// "starting" | "ready" | "error"
    status: String,
    /// Error message when status is "error".
    error: Option<String>,
}

impl StartupStatus {
    fn new(status: &str, error: Option<String>) -> Self {
        Self {
            status: status.to_string(),
            error,
        }
    }
}

/// State shared by the shell bridge and the window lifecycle.
struct AppState {
    /// The spawned local server, when running.
    local: Mutex<Option<server::LocalServer>>,
    /// The last remote server the user switched to (url, token) — the
    /// "current display" reported by the bridge state.
    last_remote: Mutex<Option<(String, String)>>,
    /// Auto-update state, surfaced to the settings UI through the bridge.
    update: Mutex<update::UpdateState>,
    /// Downloaded update awaiting installation.
    pending: Mutex<Option<update::PendingUpdate>>,
    /// Local server startup progress, read by the splash page (the
    /// initial frontend) through the bridge until the window navigates.
    startup: Mutex<StartupStatus>,
    /// The in-flight local server start: the background thread fills it
    /// with the result. connect-local waits on it instead of spawning a
    /// second server while the startup is still running.
    startup_task: Mutex<Option<StartupTask>>,
    /// The browser lab (the agent's debug WebView, overlaid on the main
    /// window as the right lab pane): RPC endpoint + on-demand window.
    /// Created in setup; None when the lab failed to start (logged — the
    /// agent then simply has no browser tools).
    browser_lab: Mutex<Option<browser_lab::BrowserLab>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = update::load_desktop_settings(&handle);
            // The browser lab starts before the local server: the server
            // child receives the lab endpoint through its environment.
            let lab = match browser_lab::BrowserLab::start(&handle) {
                Ok(lab) => Some(lab),
                Err(error) => {
                    eprintln!("[lumisca] browser disabled: {error}");
                    None
                }
            };
            app.manage(AppState {
                local: Mutex::new(None),
                last_remote: Mutex::new(None),
                update: Mutex::new(update::UpdateState::new(settings.auto_update)),
                pending: Mutex::new(None),
                startup: Mutex::new(StartupStatus::new("starting", None)),
                startup_task: Mutex::new(None),
                browser_lab: Mutex::new(lab),
            });

            // Register the updater's `on_before_exit` hook exactly once
            // and keep the built updater for every future check (see
            // update::init_updater).
            if let Err(e) = update::init_updater(&handle) {
                eprintln!("[lumisca] updater init failed: {e}");
            }

            // Start the local server in the background: the initial splash
            // page paints right away and the window navigates to the
            // server as soon as it answers /api/health. Blocking setup
            // here would keep the placeholder visible for the whole
            // server startup.
            server::start_local_server_async(&handle);

            // Periodic auto-update loop: the first check shortly after
            // startup so the UI is up, then every 6 hours. Each cycle is
            // skipped while a check, download or pending install is in
            // flight.
            std::thread::spawn(move || {
                std::thread::sleep(update::FIRST_UPDATE_CHECK_DELAY);
                loop {
                    if update::auto_update_enabled(&handle) {
                        tauri::async_runtime::spawn(update::check_for_updates(
                            handle.clone(),
                            true,
                        ));
                    }
                    std::thread::sleep(update::UPDATE_CHECK_INTERVAL);
                }
            });

            Ok(())
        })
        // The settings UI (served by the local or remote server) drives
        // the local server and UI switching through this bridge.
        .register_uri_scheme_protocol("lumisca", |ctx, request| {
            bridge::handle_shell_request(ctx.app_handle(), request)
        })
        .on_window_event(|window, event| {
            match event {
                // The lab pane is a separate window overlaid on the
                // main window's right edge: keep its geometry glued to
                // the main window (move/resize/maximize) and, while the
                // main window holds focus, keep the lab above it.
                WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::Focused(_) => {
                    if window.label() == "main" {
                        browser_lab::sync_pane(window.app_handle());
                    }
                }
                // The lab window died on its own (user closed it, e.g.
                // Alt+F4): forget it — later RPCs answer "not_open"
                // instead of using a dead handle.
                WindowEvent::Destroyed => {
                    if window.label() == browser_lab::LAB_WINDOW_LABEL {
                        browser_lab::forget_window(window.app_handle());
                    }
                    // The only app window is gone: stop the local server
                    // so no orphaned process keeps the port/db locked
                    // after exit, and shut the browser lab (window + RPC
                    // listener).
                    if window.label() == "main"
                        && window.app_handle().try_state::<AppState>().is_some()
                    {
                        shutdown_services(window.app_handle());
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Stop every spawned service on app exit: the local server process and
/// the browser lab (its WebView and RPC listener). Idempotent — called
/// from the main window's Destroyed event and the updater's exit hook.
pub(crate) fn shutdown_services(app: &tauri::AppHandle) {
    server::stop_local_server(app);
    browser_lab::shutdown(app);
}
