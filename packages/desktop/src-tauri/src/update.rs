//! Auto-update: the state machine surfaced to the settings UI through the
//! bridge, the background check/download/install tasks, and the single
//! `on_before_exit` hook that stops the local server when the installer
//! is launched on Windows.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

use crate::shutdown_services;
use crate::AppState;

/// How often the periodic check runs, and the delay before the first one
/// after startup (so the UI is up before the first network round-trip).
pub(crate) const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
pub(crate) const FIRST_UPDATE_CHECK_DELAY: Duration = Duration::from_secs(10);

/// Auto-update state. Written by the background check/download tasks, read
/// by the bridge (and thus the settings UI).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateState {
    auto_update: bool,
    checking: bool,
    available: bool,
    latest_version: Option<String>,
    downloading: bool,
    progress: Option<f64>,
    downloaded: Option<u64>,
    total: Option<u64>,
    ready: bool,
    error: Option<String>,
}

impl UpdateState {
    pub(crate) fn new(auto_update: bool) -> Self {
        Self {
            auto_update,
            checking: false,
            available: false,
            latest_version: None,
            downloading: false,
            progress: None,
            downloaded: None,
            total: None,
            ready: false,
            error: None,
        }
    }
}

/// A downloaded update awaiting installation.
pub(crate) struct PendingUpdate {
    update: Update,
    bytes: Vec<u8>,
}

/// Desktop-level settings (auto-update etc.). Kept next to the server
/// database: the settings UI may be served by a remote server, so these
/// flags cannot live in that server's settings.
#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct DesktopSettings {
    pub(crate) auto_update: bool,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self { auto_update: true }
    }
}

fn desktop_settings_path(app: &AppHandle) -> PathBuf {
    crate::server::app_data_dir(app).join("settings.json")
}

pub(crate) fn load_desktop_settings(app: &AppHandle) -> DesktopSettings {
    std::fs::read_to_string(desktop_settings_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_desktop_settings(app: &AppHandle, settings: &DesktopSettings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(desktop_settings_path(app), json).map_err(|e| e.to_string())
}

/// The single updater instance used by every check. It is built once (in
/// setup) with the `on_before_exit` hook registered, so the hook is
/// registered exactly once per process — registering it per check (as the
/// code did before) would stack a new registration with each 6-hourly
/// cycle. The hook travels from the builder into the `Update` returned by
/// `check()`, and runs when `install()` launches the installer.
static UPDATER: OnceLock<Arc<Updater>> = OnceLock::new();

fn build_updater(app: &AppHandle) -> Result<Updater, String> {
    let cleanup_app = app.clone();
    app.updater_builder()
        .on_before_exit(move || {
            // Stop the local server and the browser lab only now: the
            // updater runs this hook right before the installer launches,
            // so an earlier failure leaves the UI alive.
            shutdown_services(&cleanup_app);
            cleanup_app.cleanup_before_exit();
        })
        .build()
        .map_err(|e| format!("更新の確認に失敗しました: {e}"))
}

/// Called exactly once from setup: registers the `on_before_exit` hook
/// and keeps the built updater for every future check. Idempotent — if a
/// lazy path ever raced setup, the first built updater wins (every built
/// updater carries the hook, so the result is identical either way).
pub(crate) fn init_updater(app: &AppHandle) -> Result<(), String> {
    let updater = build_updater(app)?;
    let _ = UPDATER.set(Arc::new(updater));
    Ok(())
}

/// The shared updater, lazily (re-)initialised if setup's call failed.
fn updater(app: &AppHandle) -> Result<Arc<Updater>, String> {
    if let Some(updater) = UPDATER.get().cloned() {
        return Ok(updater);
    }
    init_updater(app)?;
    UPDATER
        .get()
        .cloned()
        .ok_or_else(|| "更新機能の初期化に失敗しました".to_string())
}

/// The current update state as JSON for the bridge, plus the running app
/// version (shown in the 一般 settings panel).
pub(crate) fn update_status_json(app: &AppHandle) -> serde_json::Value {
    let state = app.state::<AppState>();
    let st = state.update.lock().unwrap();
    let mut value = serde_json::to_value(&*st).unwrap_or_else(|_| serde_json::json!({}));
    value["currentVersion"] = app.package_info().version.to_string().into();
    value
}

fn fail_update(app: &AppHandle, message: &str) {
    let state = app.state::<AppState>();
    let mut st = state.update.lock().unwrap();
    st.checking = false;
    st.downloading = false;
    st.error = Some(message.to_string());
}

/// Whether automatic updates are enabled (the persisted desktop setting).
pub(crate) fn auto_update_enabled(app: &AppHandle) -> bool {
    app.state::<AppState>().update.lock().unwrap().auto_update
}

/// Persist and apply the auto-update toggle. Turning it on kicks off the
/// first check immediately.
pub(crate) fn set_auto_update(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = load_desktop_settings(app);
    settings.auto_update = enabled;
    save_desktop_settings(app, &settings)?;
    app.state::<AppState>().update.lock().unwrap().auto_update = enabled;
    if enabled {
        tauri::async_runtime::spawn(check_for_updates(app.clone(), true));
    }
    Ok(())
}

/// Check for a new version. In auto mode (startup, the periodic loop,
/// turning the toggle on) an available update is downloaded right away; a
/// manual check only records it and leaves the download to the user.
pub(crate) async fn check_for_updates(app: AppHandle, auto: bool) {
    // Decide what to do while holding the lock; the guard must be dropped
    // before the awaits below.
    let auto_download = {
        let state = app.state::<AppState>();
        let mut st = state.update.lock().unwrap();
        if st.checking || st.downloading || st.ready {
            return;
        }
        if st.available {
            // Already known (e.g. from a manual check); auto mode proceeds
            // to the download, otherwise there is nothing to do.
            if !(auto && st.auto_update) {
                return;
            }
            true
        } else {
            st.checking = true;
            st.error = None;
            false
        }
    };

    if auto_download {
        download_update(app).await;
        return;
    }

    // A fresh network check (the state was not marked available). The
    // updater (and with it the on_before_exit hook) is the single instance
    // built in setup; see `UPDATER`.
    let updater = match updater(&app) {
        Ok(updater) => updater,
        Err(e) => {
            fail_update(&app, &e);
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            {
                let state = app.state::<AppState>();
                let mut st = state.update.lock().unwrap();
                st.checking = false;
                st.available = true;
                st.latest_version = Some(update.version.to_string());
            }
            *app.state::<AppState>().pending.lock().unwrap() = Some(PendingUpdate {
                update,
                bytes: Vec::new(),
            });
            if auto {
                download_update(app).await;
            }
        }
        Ok(None) => {
            let state = app.state::<AppState>();
            let mut st = state.update.lock().unwrap();
            st.checking = false;
            st.available = false;
            st.latest_version = None;
            st.ready = false;
            st.downloading = false;
            st.progress = None;
            st.downloaded = None;
            st.total = None;
        }
        Err(e) => fail_update(&app, &format!("更新の確認に失敗しました: {e}")),
    }
}

/// Download the available update into memory, reporting progress through
/// the state. The bytes stay in `pending` until the user installs.
pub(crate) async fn download_update(app: AppHandle) {
    {
        let state = app.state::<AppState>();
        let mut st = state.update.lock().unwrap();
        if !st.available || st.downloading || st.ready {
            return;
        }
        st.downloading = true;
        st.progress = Some(0.0);
        st.downloaded = Some(0);
        st.error = None;
    }

    let pending = app.state::<AppState>().pending.lock().unwrap().take();
    let Some(pending) = pending else {
        let state = app.state::<AppState>();
        let mut st = state.update.lock().unwrap();
        st.downloading = false;
        st.error =
            Some("ダウンロードできる更新が見つかりません。もう一度確認してください。".into());
        return;
    };

    let mut received = 0u64;
    let result = pending
        .update
        .download(
            |chunk, total| {
                received += chunk as u64;
                let state = app.state::<AppState>();
                let mut st = state.update.lock().unwrap();
                st.downloaded = Some(received);
                st.total = total;
                st.progress = total.map(|t| received as f64 / t as f64);
            },
            || {},
        )
        .await;

    match result {
        Ok(bytes) => {
            *app.state::<AppState>().pending.lock().unwrap() = Some(PendingUpdate {
                update: pending.update,
                bytes,
            });
            let state = app.state::<AppState>();
            let mut st = state.update.lock().unwrap();
            st.downloading = false;
            st.ready = true;
            st.progress = Some(1.0);
        }
        Err(e) => {
            // Keep the update record so the download can be retried.
            *app.state::<AppState>().pending.lock().unwrap() = Some(PendingUpdate {
                update: pending.update,
                bytes: Vec::new(),
            });
            let state = app.state::<AppState>();
            let mut st = state.update.lock().unwrap();
            st.downloading = false;
            st.ready = false;
            st.progress = None;
            st.error = Some(format!("ダウンロードに失敗しました: {e}"));
        }
    }
}

/// Install the downloaded update. On Windows this launches the NSIS
/// installer and exits the process (the installer relaunches the app). The
/// updater's `on_before_exit` hook stops the local server only after the
/// installer is ready to launch, so an earlier failure leaves the UI alive.
pub(crate) fn install_update(app: AppHandle) {
    std::thread::spawn(move || {
        let pending = app.state::<AppState>().pending.lock().unwrap().take();
        let Some(pending) = pending else {
            let state = app.state::<AppState>();
            let mut st = state.update.lock().unwrap();
            st.error = Some("インストールできる更新がありません。".into());
            return;
        };
        if let Err(e) = pending.update.install(&pending.bytes) {
            *app.state::<AppState>().pending.lock().unwrap() = Some(pending);
            let state = app.state::<AppState>();
            let mut st = state.update.lock().unwrap();
            st.error = Some(format!("インストールに失敗しました: {e}"));
        }
        // On success the installer is running and this process has exited.
    });
}
