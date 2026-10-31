//! Lumisca desktop shell.
//!
//! This module owns only the shared [`AppState`] (each field is a `Mutex`
//! so the sibling modules can borrow individual pieces without locking the
//! whole app) and the Tauri builder in [`run`]. Everything else lives in
//! the re-exported modules: [`server`] (local server process), [`bridge`]
//! and [`bridge_server`] (the shell bridge the page drives), [`update`]
//! (auto-update), [`window`] (window navigation and the Win32 drag hack).

use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{Manager, WindowEvent};

pub mod bridge;
pub mod bridge_server;
pub mod browser_lab;
pub mod connection;
pub mod health;
pub mod notify;
pub mod server;
pub mod server_log;
pub mod settings;
pub mod update;
pub mod window;

/// Lock a `Mutex`, recovering the guard when the lock is poisoned.
///
/// Every lock in this shell guards plain state (window handles, child
/// processes, progress counters) whose invariants do not span a panic, and a
/// panic inside a Tauri command leaves the UI with no answer at all —
/// recovering is strictly better than aborting. One implementation, so the
/// policy cannot drift between call sites.
pub(crate) trait LockRecover<T> {
    fn lock_recover(&self) -> MutexGuard<'_, T>;
}

impl<T> LockRecover<T> for Mutex<T> {
    fn lock_recover(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Result slot of the background local-server startup: the thread fills it
/// with the page URL once the server answers `/api/health`.
type StartupTask = Arc<Mutex<Option<Result<String, String>>>>;

/// Local server startup progress, surfaced to the splash page.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StartupStatus {
    /// What the shell is doing with the window's connection:
    /// - "starting": the local server is booting.
    /// - "connecting": the remembered remote server is being probed.
    /// - "ready": the server answered and the window is navigating to it.
    /// - "error": the local server failed to start.
    /// - "remote-unreachable": the remembered remote server did not answer;
    ///   the splash offers a retry and the local server instead.
    status: String,
    /// Error message when status is "error" / "remote-unreachable".
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
pub(crate) struct AppState {
    /// The spawned local server, when running.
    local: Mutex<Option<server::LocalServer>>,
    /// The spawned local server's captured output (in-memory tail +
    /// on-disk log), for crash diagnosis from the UI.
    server_log: Mutex<server_log::ServerLog>,
    /// The last remote server the user switched to — the "current display"
    /// reported by the bridge state, name included (the page cannot name
    /// itself: a remote page's registry is that server's own).
    last_remote: Mutex<Option<settings::SavedConnection>>,
    /// The connection `settings.json` holds for the next launch. Kept here
    /// so the splash's 150 ms poll of `state` never reads the file, and so
    /// the display and the persisted choice are written together.
    remembered: Mutex<Option<settings::SavedConnection>>,
    /// Bumped whenever the display is switched by hand (connect-local /
    /// connect-remote). A startup restore that finishes after a manual
    /// switch must not pull the window back to the remembered server, so it
    /// compares this counter with the value it started under.
    connect_epoch: Mutex<u64>,
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
    /// The browser lab (the agent's debug WebView, an ordinary top-level
    /// window of its own): RPC endpoint + on-demand window. Created in
    /// setup; None when the lab failed to start (logged — the agent then
    /// simply has no browser tools).
    browser_lab: Mutex<Option<browser_lab::BrowserLab>>,
    /// The shell bridge's loopback listener. Its origin is injected into
    /// every page the main window loads, so the page can drive the shell.
    bridge: Mutex<Option<bridge_server::BridgeServer>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        // OS notifications for background agent events (see notify.rs).
        // Used from Rust only, so no frontend IPC capability is needed.
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let prefs = settings::load(&handle);
            // The browser lab starts before the local server: the server
            // child receives the lab endpoint through its environment.
            let lab = match browser_lab::BrowserLab::start(&handle) {
                Ok(lab) => Some(lab),
                Err(error) => {
                    eprintln!("[lumisca] browser disabled: {error}");
                    None
                }
            };
            // The shell bridge first: the main window's initialization
            // script carries its origin, and it has to be created below.
            let bridge = match bridge_server::BridgeServer::start(handle.clone()) {
                Ok(bridge) => Some(bridge),
                Err(error) => {
                    // Without the bridge the page is still usable; the
                    // title bar's controls are not (see bridge_server.rs).
                    eprintln!("[lumisca] shell bridge disabled: {error}");
                    None
                }
            };
            app.manage(AppState {
                local: Mutex::new(None),
                server_log: Mutex::new(server_log::ServerLog::new(&handle)),
                last_remote: Mutex::new(None),
                remembered: Mutex::new(prefs.last_remote),
                connect_epoch: Mutex::new(0),
                update: Mutex::new(update::UpdateState::new(prefs.auto_update)),
                pending: Mutex::new(None),
                startup: Mutex::new(StartupStatus::new("starting", None)),
                startup_task: Mutex::new(None),
                browser_lab: Mutex::new(lab),
                bridge: Mutex::new(bridge),
            });
            // The main window is defined in tauri.conf.json with
            // `create: false`, so it can be built here with the bridge's
            // origin as an initialization script — the page's own scripts
            // read it on mount, and every navigation (splash, local server,
            // remote server) gets it again.
            create_main_window(&handle)?;
            // Keep only the recent on-disk server log across runs, then mark
            // this run's boundary in it: the file is append-only and spans
            // app runs, so a timestamped header line is what separates one
            // run from the next in a post-mortem.
            server_log::trim_log_file(&handle);
            server_log::note(
                &handle,
                format!(
                    "Lumisca desktop shell started (version {}, pid {})",
                    app.package_info().version,
                    std::process::id()
                ),
            );

            // Register the updater's `on_before_exit` hook exactly once
            // and keep the built updater for every future check (see
            // update::init_updater).
            if let Err(e) = update::init_updater(&handle) {
                eprintln!("[lumisca] updater init failed: {e}");
            }

            // Display the server this shell showed last time: the local one
            // (started here in the background, so the splash paints right
            // away) or the remote server the user was connected to.
            // Blocking setup on either would keep the placeholder visible
            // for the whole probe.
            connection::start(&handle);

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
        // the local server and UI switching through the loopback bridge
        // started in setup (see bridge_server.rs) — not through a custom
        // URI scheme, which WKWebView refuses to fetch from an http(s)
        // page.
        .on_window_event(|window, event| {
            // The lab window is an ordinary top-level window, so nothing
            // follows the main window's geometry any more. Its own
            // destruction is what matters here: the user closed it, so
            // forget it — later RPCs answer "not_open" instead of using a
            // dead handle.
            if matches!(event, WindowEvent::Destroyed) {
                if window.label() == browser_lab::LAB_WINDOW_LABEL {
                    browser_lab::forget_window(window.app_handle());
                }
                // The app window is gone: stop the local server so no
                // orphaned process keeps the port/db locked after exit, and
                // shut the browser lab (window + RPC listener).
                if window.label() == "main" && window.app_handle().try_state::<AppState>().is_some()
                {
                    shutdown_services(
                        window.app_handle(),
                        "the main window was destroyed (app exit)",
                    );
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Stop every spawned service on app exit: the local server process, the
/// browser lab (its WebView and RPC listener) and the shell bridge (its
/// loopback listener). Idempotent — called from the main window's Destroyed
/// event and the updater's exit hook. `reason` is recorded in the captured
/// server log, which is the only trace a hard-killed server leaves behind.
pub(crate) fn shutdown_services(app: &tauri::AppHandle, reason: &str) {
    server::stop_local_server(app, reason);
    browser_lab::shutdown(app);
    if let Some(state) = app.try_state::<AppState>() {
        // Dropping the server joins its listener thread.
        *state.bridge.lock_recover() = None;
    }
}

/// Build the main window from tauri.conf.json's definition, adding the
/// bridge's origin as an initialization script.
///
/// The window cannot be created by Tauri's config pass (`create: true`):
/// the script has to name the bridge's port, and that is only known once
/// the listener is bound in setup. An initialization script (rather than an
/// inline `<script>` in the page) is what carries it across every
/// navigation — the splash, the local server, a remote server — and past
/// the page's CSP, which bans inline scripts.
fn create_main_window(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .ok_or("tauri.conf.json must define the main window")?
        .clone();
    let state = app.state::<AppState>();
    let script = match state.bridge.lock_recover().as_ref() {
        Some(bridge) => bridge_server::main_window_initialization_script(&bridge.origin()),
        None => String::new(),
    };
    let mut builder = tauri::WebviewWindowBuilder::from_config(app, &config)?;
    if !script.is_empty() {
        builder = builder.initialization_script(script);
    }
    builder.build()?;
    Ok(())
}
