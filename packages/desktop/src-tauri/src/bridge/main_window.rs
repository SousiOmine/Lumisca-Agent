//! The window the shell is displayed in: its custom title bar controls, the
//! folder picker whose sheet hangs off it, and the close that ends the app.
//!
//! The window is undecorated (tauri.conf.json), so the page draws its own
//! title bar and drives these. They go through the same key gate as every
//! other action: the displayed server's page carries the key, and the splash
//! page (the only other page that drives them) runs while no token exists
//! yet, when the gate is open.
//!
//! The app page is served from http://127.0.0.1 (or a remote server), so it
//! has no Tauri IPC and `data-tauri-drag-region` cannot work; dragging goes
//! through the bridge instead.

use tauri::http::StatusCode;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use super::wire::{bridge_json, BridgeReply};

fn ok() -> BridgeReply {
    bridge_json(StatusCode::OK, serde_json::json!({ "ok": true }))
}

pub(super) fn minimize(app: &AppHandle) -> BridgeReply {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.minimize();
    }
    ok()
}

pub(super) fn toggle_maximize(app: &AppHandle) -> BridgeReply {
    if let Some(window) = app.get_webview_window("main") {
        let maximized = window.is_maximized().unwrap_or(false);
        let _ = if maximized {
            window.unmaximize()
        } else {
            window.maximize()
        };
    }
    ok()
}

pub(super) fn close(app: &AppHandle) -> BridgeReply {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.close();
    }
    ok()
}

pub(super) fn start_drag(app: &AppHandle) -> BridgeReply {
    if let Some(window) = app.get_webview_window("main") {
        // DefWindowProc starts the caption drag only on the active
        // window; force the activation first so the first drag on
        // an unfocused window moves it instead of merely
        // activating it.
        #[cfg(windows)]
        crate::window::focus_window_for_drag(&window);
        let _ = window.start_dragging();
    }
    ok()
}

/// Open the OS folder picker; the picked path is on THIS machine, so the
/// frontend only offers this for local workspaces.
///
/// `blocking_pick_folder` blocks the CALLING thread until the user answers,
/// so this must not run on the main thread: on macOS the picker is a sheet
/// whose completion arrives through the main run loop, and a blocked main
/// thread would freeze it unanswered. The bridge registration in lib.rs
/// answers every request from a blocking worker precisely so this stays off
/// the main thread.
pub(super) fn pick_folder(app: &AppHandle) -> BridgeReply {
    let picked = match app.get_webview_window("main") {
        Some(win) => win
            .dialog()
            .file()
            .set_title("フォルダーの選択")
            .blocking_pick_folder(),
        None => app
            .dialog()
            .file()
            .set_title("フォルダーの選択")
            .blocking_pick_folder(),
    };
    let path = picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned());
    bridge_json(StatusCode::OK, serde_json::json!({ "path": path }))
}
