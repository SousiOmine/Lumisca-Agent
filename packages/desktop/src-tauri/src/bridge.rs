//! The `lumisca://` shell bridge.
//!
//! The settings UI is served by the (possibly remote) server, so it cannot
//! call Tauri commands. Instead it fetches the shell bridge — the `lumisca://`
//! custom protocol handled here — under the action path `/shell/<action>`.
//! The bridge only manages the local server and UI switching; the peer
//! registry lives in the server's own database.
//!
//! How the bridge URL reaches this handler differs per webview engine, but
//! the request path is identical in every form (`/shell/<action>`):
//! - Windows (WebView2) cannot fetch custom schemes, so wry re-homes the
//!   protocol to `http://lumisca.localhost/...` (its resource filter
//!   reverts it to `lumisca:///...` before dispatching here).
//! - macOS (WKWebView) and Linux (WebKitGTK) fetch `lumisca://` directly;
//!   the frontend uses `lumisca://lumisca.localhost/shell/...` so the host
//!   does not swallow the first path segment.
//!
//! Every request must carry `key` = the auth token of the CURRENTLY
//! DISPLAYED server — a value only the page served by that server knows, so
//! arbitrary pages in the webview cannot drive the bridge.

use std::collections::HashMap;
use std::time::{Duration, Instant};
use tauri::http::{header, Request as HttpRequest, Response as HttpResponse, StatusCode};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::server::{ensure_local_server, health_check, page_url};
use crate::update::{
    check_for_updates, download_update, install_update, set_auto_update, update_status_json,
};
use crate::window::navigate_main;
use crate::{browser_lab, AppState};

/// JSON body of a lumisca://shell/* bridge response.
type BridgeResponse = HttpResponse<Vec<u8>>;

/// How long `connect-local` waits for the in-flight background startup
/// before giving up. The busy-wait loop below has no other termination
/// condition: if the startup thread died (panic, kill) without filling its
/// result slot, the bridge would otherwise spin forever. 30s covers the
/// startup's own worst case (10 attempts × the 3s health-check timeout,
/// plus the retry sleeps), so a healthy startup always beats the deadline.
const CONNECT_LOCAL_WAIT_TIMEOUT: Duration = Duration::from_secs(30);

/// Current display, shown by the settings UI. Also carries the local
/// server startup progress for the splash page.
#[derive(serde::Serialize)]
struct ConnectionState {
    /// "local" | "remote"
    mode: String,
    /// Page URL of the current display, if known.
    url: Option<String>,
    /// "starting" | "ready" | "error" — local server startup progress.
    status: String,
    /// Error message when status is "error".
    error: Option<String>,
    /// Whether the main window is maximized (custom title bar icon).
    maximized: bool,
}

/// Current display's auth token (the bridge key).
fn current_connection_token(app: &AppHandle) -> Option<String> {
    let state = app.state::<AppState>();
    let remote = state
        .last_remote
        .lock()
        .unwrap()
        .as_ref()
        .map(|(_, t)| t.clone());
    if remote.is_some() {
        return remote;
    }
    let local = state
        .local
        .lock()
        .unwrap()
        .as_ref()
        .map(|l| l.token.clone());
    local
}

fn bridge_json(status: StatusCode, value: serde_json::Value) -> BridgeResponse {
    // `builder()` is defined on Response<()>; `.body()` yields Response<T>.
    tauri::http::Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        // The page origin is dynamic (local or remote server); `*` is fine
        // because the key gate above already authenticates the caller.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(serde_json::to_vec(&value).unwrap_or_default())
        .unwrap()
}

fn bridge_error(status: StatusCode, message: &str) -> BridgeResponse {
    bridge_json(status, serde_json::json!({ "error": message }))
}

/// Parse a server URL into (host, port). Only http:// is supported
/// (v1: Tailscale / trusted LAN, no TLS).
fn parse_remote_url(url: &str) -> Result<(String, u16), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("URL が不正です: {e}"))?;
    if parsed.scheme() != "http" {
        return Err("http:// URL のみサポートされています".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "URL にホストがありません".to_string())?
        .to_string();
    let port = parsed.port().unwrap_or(80);
    Ok((host, port))
}

fn connect_remote_impl(app: &AppHandle, url: &str, token: &str) -> Result<String, String> {
    let (host, port) = parse_remote_url(url)?;
    if !health_check(&host, port, Some(token), Duration::from_secs(5)) {
        return Err(format!("サーバーに接続できません: {url}"));
    }
    let page = page_url(url, token);
    *app.state::<AppState>().last_remote.lock().unwrap() =
        Some((url.to_string(), token.to_string()));
    navigate_main(app, &page)?;
    Ok(page)
}

fn connect_local_impl(app: &AppHandle) -> Result<String, String> {
    // If the background startup is still running, wait for its result
    // instead of spawning a second server instance.
    let pending = app.state::<AppState>().startup_task.lock().unwrap().clone();
    if let Some(shared) = pending {
        let deadline = Instant::now() + CONNECT_LOCAL_WAIT_TIMEOUT;
        loop {
            if let Some(result) = shared.lock().unwrap().clone() {
                return result;
            }
            if Instant::now() >= deadline {
                // The background startup never completed (e.g. its thread
                // panicked and never filled the slot). Forget it so the
                // next attempt starts a server directly instead of waiting
                // again.
                *app.state::<AppState>().startup_task.lock().unwrap() = None;
                return Err(
                    "ローカルサーバーの起動がタイムアウトしました。しばらく待ってからもう一度お試しください。"
                        .into(),
                );
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    let url = ensure_local_server(app)?;
    *app.state::<AppState>().last_remote.lock().unwrap() = None;
    navigate_main(app, &url)?;
    Ok(url)
}

pub(crate) fn handle_shell_request(
    app: &AppHandle,
    request: HttpRequest<Vec<u8>>,
) -> BridgeResponse {
    let parsed = match url::Url::parse(&request.uri().to_string()) {
        Ok(parsed) => parsed,
        Err(_) => return bridge_error(StatusCode::BAD_REQUEST, "invalid uri"),
    };
    // Action = everything after the `/shell/` prefix (`state`,
    // `connect-remote`, `update/status`, ...), not just one segment.
    let mut segments = parsed.path().trim_start_matches('/').split('/');
    segments.next(); // skip "shell"
    let action = segments.collect::<Vec<_>>().join("/");
    let params: HashMap<String, String> = parsed.query_pairs().into_owned().collect();

    // Key gate: only the page of the currently displayed server may drive
    // the bridge, window controls included. Tokenless servers leave it
    // open (matching their own auth posture), and while no server is
    // displayed yet — the splash page, or a failed startup — there is no
    // token either, so the gate is open and the splash can drive the
    // window controls. Once a token exists, every action requires it.
    if let Some(current) = current_connection_token(app) {
        let supplied = params.get("key").map(String::as_str);
        if supplied != Some(current.as_str()) {
            return bridge_error(StatusCode::UNAUTHORIZED, "invalid key");
        }
    }

    let get = |name: &str| params.get(name).cloned();
    match action.as_str() {
        "state" => {
            let state = app.state::<AppState>();
            let startup = state.startup.lock().unwrap();
            let mode = if state.last_remote.lock().unwrap().is_some() {
                "remote"
            } else {
                "local"
            };
            let url = if mode == "remote" {
                state
                    .last_remote
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|(u, t)| page_url(u, t))
            } else {
                state
                    .local
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|l| page_url(&format!("http://127.0.0.1:{}", l.port), &l.token))
            };
            let maximized = app
                .get_webview_window("main")
                .map(|window| window.is_maximized().unwrap_or(false))
                .unwrap_or(false);
            let state = ConnectionState {
                mode: mode.to_string(),
                url,
                status: startup.status.clone(),
                error: startup.error.clone(),
                maximized,
            };
            bridge_json(StatusCode::OK, serde_json::to_value(state).unwrap())
        }
        "connect-remote" => {
            let (url, token) = match (get("url"), get("token")) {
                (Some(url), token) => (url, token.unwrap_or_default()),
                _ => return bridge_error(StatusCode::BAD_REQUEST, "url required"),
            };
            match connect_remote_impl(app, &url, &token) {
                Ok(page) => bridge_json(
                    StatusCode::OK,
                    serde_json::json!({ "ok": true, "url": page }),
                ),
                Err(e) => bridge_error(StatusCode::BAD_GATEWAY, &e),
            }
        }
        "connect-local" => match connect_local_impl(app) {
            Ok(url) => bridge_json(
                StatusCode::OK,
                serde_json::json!({ "ok": true, "url": url }),
            ),
            Err(e) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
        },
        "test" => {
            let (url, token) = match (get("url"), get("token")) {
                (Some(url), token) => (url, token.unwrap_or_default()),
                _ => return bridge_error(StatusCode::BAD_REQUEST, "url required"),
            };
            match parse_remote_url(&url).and_then(|(host, port)| {
                if health_check(&host, port, Some(&token), Duration::from_secs(5)) {
                    Ok(())
                } else {
                    Err(format!("サーバーに接続できません: {url}"))
                }
            }) {
                Ok(()) => bridge_json(StatusCode::OK, serde_json::json!({ "ok": true })),
                Err(e) => bridge_error(StatusCode::BAD_GATEWAY, &e),
            }
        }
        // --- auto-update ---
        "update/status" => bridge_json(StatusCode::OK, update_status_json(app)),
        "update/set-auto" => {
            let enabled = match get("enabled").and_then(|v| v.parse::<bool>().ok()) {
                Some(enabled) => enabled,
                None => return bridge_error(StatusCode::BAD_REQUEST, "enabled required"),
            };
            match set_auto_update(app, enabled) {
                Ok(()) => bridge_json(StatusCode::OK, update_status_json(app)),
                Err(e) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
            }
        }
        "update/check" => {
            tauri::async_runtime::spawn(check_for_updates(app.clone(), false));
            bridge_json(StatusCode::OK, update_status_json(app))
        }
        "update/download" => {
            tauri::async_runtime::spawn(download_update(app.clone()));
            bridge_json(StatusCode::OK, update_status_json(app))
        }
        "update/install" => {
            install_update(app.clone());
            bridge_json(StatusCode::OK, update_status_json(app))
        }
        // --- docked pane ------------------------------------------------
        //
        // The agent's lab is overlaid as a pane on the app window's
        // right edge (its own borderless window, glued to the main
        // window — see browser_lab.rs). The React UI polls `state` to
        // lay itself out around the pane (it must reserve the pane's
        // width and shift fixed-position panels away from it) and drives
        // show/hide here. Hiding the pane is a UI choice only: the lab
        // keeps running, and the agent's browser tools keep working
        // while it is hidden. The pane protocol is content-kind based,
        // so non-browser surfaces can be hosted later.
        "pane/state" => bridge_json(StatusCode::OK, browser_lab::pane_state(app)),
        "pane/set-visible" => {
            let visible = match get("visible").and_then(|v| v.parse::<bool>().ok()) {
                Some(visible) => visible,
                None => return bridge_error(StatusCode::BAD_REQUEST, "visible required"),
            };
            bridge_json(StatusCode::OK, browser_lab::set_pane_visible(app, visible))
        }
        "pane/toggle" => bridge_json(StatusCode::OK, browser_lab::toggle_pane(app)),
        // --- custom title bar window controls ----------------------------
        //
        // The window is undecorated (tauri.conf.json), so the page draws
        // its own title bar and drives these. They go through the same
        // key gate as every other action: the displayed server's page
        // carries the key, and the splash page (the only other page that
        // drives them) runs while no token exists yet, when the gate is
        // open.
        //
        // The app page is served from http://127.0.0.1 (or a remote
        // server), so it has no Tauri IPC and `data-tauri-drag-region`
        // cannot work; dragging goes through the bridge instead.
        "window/minimize" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.minimize();
            }
            bridge_json(StatusCode::OK, serde_json::json!({ "ok": true }))
        }
        "window/toggle-maximize" => {
            if let Some(window) = app.get_webview_window("main") {
                let maximized = window.is_maximized().unwrap_or(false);
                let _ = if maximized {
                    window.unmaximize()
                } else {
                    window.maximize()
                };
            }
            bridge_json(StatusCode::OK, serde_json::json!({ "ok": true }))
        }
        "window/close" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
            bridge_json(StatusCode::OK, serde_json::json!({ "ok": true }))
        }
        "window/start-drag" => {
            if let Some(window) = app.get_webview_window("main") {
                // DefWindowProc starts the caption drag only on the active
                // window; force the activation first so the first drag on
                // an unfocused window moves it instead of merely
                // activating it.
                #[cfg(windows)]
                crate::window::focus_window_for_drag(&window);
                let _ = window.start_dragging();
            }
            bridge_json(StatusCode::OK, serde_json::json!({ "ok": true }))
        }
        "quit" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
            bridge_json(StatusCode::OK, serde_json::json!({ "ok": true }))
        }
        // Open the OS folder picker; the picked path is on THIS machine,
        // so the frontend only offers this for local workspaces.
        "pick-folder" => {
            let picked = match app.get_webview_window("main") {
                Some(win) => win
                    .dialog()
                    .file()
                    .set_title("フォルダを選択")
                    .blocking_pick_folder(),
                None => app
                    .dialog()
                    .file()
                    .set_title("フォルダを選択")
                    .blocking_pick_folder(),
            };
            let path = picked
                .and_then(|p| p.into_path().ok())
                .map(|p| p.to_string_lossy().into_owned());
            bridge_json(StatusCode::OK, serde_json::json!({ "path": path }))
        }
        _ => bridge_error(StatusCode::NOT_FOUND, "unknown action"),
    }
}
