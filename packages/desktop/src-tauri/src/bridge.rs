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

use crate::server::{
    ensure_local_server, health_check, host_label, local_server_status, page_url,
    restart_local_server, HealthFailure, Scheme,
};
use crate::update::{
    check_for_updates, download_update, install_update, set_auto_update, update_status_json,
};
use crate::window::navigate_main;
use crate::{notify, AppState, LockRecover};

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
        .lock_recover()
        .as_ref()
        .map(|(_, t)| t.clone());
    if remote.is_some() {
        return remote;
    }
    let local = state.local.lock_recover().as_ref().map(|l| l.token.clone());
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

/// A validated remote server URL: the transport to speak, the target host
/// and port, and the canonical base URL used for navigation, the health
/// probe and the "currently showing" state.
#[derive(Debug)]
struct RemoteTarget {
    scheme: Scheme,
    host: String,
    port: u16,
    /// `scheme://host[:port]` — the input normalized to its origin. A
    /// trailing slash, or the path/query of a URL pasted straight out of
    /// the server's output, is dropped: the UI is always served at the
    /// root, and only the fields of this connection carry the token.
    base: String,
}

/// Parse a server URL. Both `http://` (a LAN or Tailscale address served
/// directly) and `https://` (a TLS-terminating front end such as
/// `tailscale serve` in front of a MagicDNS name) are supported; every
/// other scheme is rejected instead of being handed to the window. A URL
/// carrying userinfo is refused rather than silently stripped — those
/// credentials would end up in the bridge state and never reach the
/// server.
fn parse_remote_url(url: &str) -> Result<RemoteTarget, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("URL が不正です: {e}"))?;
    let scheme = match parsed.scheme() {
        "http" => Scheme::Http,
        "https" => Scheme::Https,
        _ => return Err("http:// または https:// の URL のみサポートされています".into()),
    };
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URL にユーザー情報（user:pass@）は指定できません".into());
    }
    // `url::Host` rather than `host_str`: the latter serializes an IPv6
    // literal with its brackets, and brackets belong to the authority
    // spelling — `host_label` re-adds them for the Host header and the base
    // URL where they are required.
    let host = match parsed.host() {
        Some(url::Host::Domain(domain)) => domain.to_string(),
        Some(url::Host::Ipv4(address)) => address.to_string(),
        Some(url::Host::Ipv6(address)) => address.to_string(),
        None => return Err("URL にホストがありません".to_string()),
    };
    // The port actually used, and the port as spelled in the base URL: an
    // omitted one is filled in from the scheme's default and dropped from
    // the base (http://host:443 would be as wrong as https://host:80).
    let port = parsed.port().unwrap_or(match scheme {
        Scheme::Http => 80,
        Scheme::Https => 443,
    });
    let label = host_label(&host);
    let base = match parsed.port() {
        Some(port) => format!("{}://{label}:{port}", parsed.scheme()),
        None => format!("{}://{label}", parsed.scheme()),
    };
    Ok(RemoteTarget {
        scheme,
        host,
        port,
        base,
    })
}

/// Connect-time failure message for the settings UI. The probe says why it
/// failed instead of a bare "cannot connect": for a remote server the
/// likeliest causes are a Host guard 403 (the name is missing from the
/// server's `--allowed-hosts`) and a token mismatch, and neither is
/// something the user can see from the URL alone.
fn connect_failure(url: &str, failure: HealthFailure) -> String {
    match failure {
        HealthFailure::Unreachable => format!("サーバーに接続できません: {url}"),
        HealthFailure::Status(403) => format!(
            "サーバーに接続できません: {url}（HTTP 403: ホスト名が拒否されました。サーバーの --allowed-hosts にこのホスト名を追加してください）"
        ),
        HealthFailure::Status(401) => {
            format!("サーバーに接続できません: {url}（HTTP 401: トークンが一致しません）")
        }
        HealthFailure::Status(status) => {
            format!("サーバーに接続できません: {url}（HTTP {status}）")
        }
    }
}

fn connect_remote_impl(app: &AppHandle, url: &str, token: &str) -> Result<String, String> {
    let target = parse_remote_url(url)?;
    if let Err(failure) = health_check(
        target.scheme,
        &target.host,
        target.port,
        Some(token),
        Duration::from_secs(5),
    ) {
        return Err(connect_failure(url, failure));
    }
    let page = page_url(&target.base, token);
    *app.state::<AppState>().last_remote.lock_recover() = Some((target.base, token.to_string()));
    navigate_main(app, &page)?;
    Ok(page)
}

fn connect_local_impl(app: &AppHandle) -> Result<String, String> {
    // If the background startup is still running, wait for its result
    // instead of spawning a second server instance.
    let pending = app.state::<AppState>().startup_task.lock_recover().clone();
    if let Some(shared) = pending {
        let deadline = Instant::now() + CONNECT_LOCAL_WAIT_TIMEOUT;
        loop {
            if let Some(result) = shared.lock_recover().clone() {
                return result;
            }
            if Instant::now() >= deadline {
                // The background startup never completed (e.g. its thread
                // panicked and never filled the slot). Forget it so the
                // next attempt starts a server directly instead of waiting
                // again.
                *app.state::<AppState>().startup_task.lock_recover() = None;
                return Err(
                    "サーバーの起動待機時間が超過しました。しばらく時間をおいてから再度お試しください。"
                        .into(),
                );
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    let url = ensure_local_server(app)?;
    *app.state::<AppState>().last_remote.lock_recover() = None;
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
            let startup = state.startup.lock_recover();
            let mode = if state.last_remote.lock_recover().is_some() {
                "remote"
            } else {
                "local"
            };
            let url = if mode == "remote" {
                state
                    .last_remote
                    .lock_recover()
                    .as_ref()
                    .map(|(u, t)| page_url(u, t))
            } else {
                state
                    .local
                    .lock_recover()
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
        // --- local server diagnostics ------------------------------------
        //
        // The page cannot tell "server crashed" apart from "server hung"
        // on its own — both just stop answering fetches/WS — so the shell
        // (which owns the child handle and captures its output) reports
        // both. The connection-lost banner polls `server/status` and shows
        // "再起動" + log copy-paste when the server is gone.
        "server/status" => bridge_json(
            StatusCode::OK,
            serde_json::to_value(local_server_status(app)).unwrap(),
        ),
        "server/restart" => match restart_local_server(app) {
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
            match parse_remote_url(&url).and_then(|target| {
                health_check(
                    target.scheme,
                    &target.host,
                    target.port,
                    Some(&token),
                    Duration::from_secs(5),
                )
                .map_err(|failure| connect_failure(&url, failure))
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
        // --- background agent-event notifications -------------------------
        //
        // The frontend watches the agent event stream; when a run ends
        // (`agent_end`) or the agent asks a question (the ask tool) while
        // the main window has no focus (minimized, behind another app, on
        // another virtual desktop), it shows an OS notification here.
        // Windows toasts carry our AppUserModelID (Lumisca name + icon)
        // with an explicit click-to-focus handler; `window/focus` covers
        // the programmatic path.
        "window/state" => bridge_json(
            StatusCode::OK,
            serde_json::to_value(notify::window_state(app)).unwrap(),
        ),
        "window/focus" => {
            notify::focus_main(app);
            bridge_json(StatusCode::OK, serde_json::json!({ "ok": true }))
        }
        "notify" => {
            let title = get("title").unwrap_or_default();
            let body = get("body").unwrap_or_default();
            if title.is_empty() && body.is_empty() {
                return bridge_error(StatusCode::BAD_REQUEST, "title or body required");
            }
            // The ask-tool question keeps its toast on screen longer
            // (Windows); the run-end toast uses the default duration.
            let urgent = matches!(get("urgent").as_deref(), Some("1") | Some("true"));
            notify::show_notification(app, &title, &body, urgent);
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
        //
        // `blocking_pick_folder` blocks the CALLING thread until the user
        // answers, so this must not run on the main thread: on macOS the
        // picker is a sheet whose completion arrives through the main run
        // loop, and a blocked main thread would freeze it unanswered. The
        // bridge registration in lib.rs answers every request from a
        // blocking worker precisely so this stays off the main thread.
        "pick-folder" => {
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
        _ => bridge_error(StatusCode::NOT_FOUND, "unknown action"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The base URL is the input normalized to its origin: what the window
    /// is navigated to, what the health probe targets, and what the settings
    /// UI reports as the current display.
    #[test]
    fn parse_remote_url_normalizes_the_base_url() {
        let https = parse_remote_url("https://host.tailnet.ts.net/").unwrap();
        assert_eq!(https.scheme, Scheme::Https);
        assert_eq!(https.host, "host.tailnet.ts.net");
        assert_eq!(https.port, 443);
        assert_eq!(https.base, "https://host.tailnet.ts.net");

        let http = parse_remote_url("http://100.64.0.5:8000").unwrap();
        assert_eq!(http.scheme, Scheme::Http);
        assert_eq!(http.host, "100.64.0.5");
        assert_eq!(http.port, 8000);
        assert_eq!(http.base, "http://100.64.0.5:8000");

        // A URL pasted straight out of the server's output carries a path,
        // query and fragment the page does not live at (and a token that
        // belongs in its own field): only the origin is kept.
        let pasted = parse_remote_url("https://host.tailnet.ts.net/?token=abc#top").unwrap();
        assert_eq!(pasted.base, "https://host.tailnet.ts.net");
    }

    #[test]
    fn parse_remote_url_accepts_and_fills_the_default_ports() {
        assert_eq!(parse_remote_url("http://host").unwrap().port, 80);
        assert_eq!(parse_remote_url("https://host").unwrap().port, 443);
        // An explicit default port is normalized away by the URL parser, so
        // the base never spells out http://host:80 or https://host:443.
        let explicit = parse_remote_url("https://host:443").unwrap();
        assert_eq!(explicit.port, 443);
        assert_eq!(explicit.base, "https://host");
    }

    #[test]
    fn parse_remote_url_brackets_ipv6_literals() {
        let target = parse_remote_url("https://[::1]:8443").unwrap();
        assert_eq!(target.host, "::1");
        assert_eq!(target.port, 8443);
        assert_eq!(target.base, "https://[::1]:8443");
    }

    #[test]
    fn parse_remote_url_rejects_other_schemes() {
        assert_eq!(
            parse_remote_url("ftp://host").unwrap_err(),
            "http:// または https:// の URL のみサポートされています"
        );
        // A bare "host:port" parses as the scheme "host" — rejected here
        // rather than navigated to.
        assert!(parse_remote_url("homeserver:8000").is_err());
        assert!(parse_remote_url("file:///tmp").is_err());
        assert!(parse_remote_url("ws://host:8000").is_err());
    }

    #[test]
    fn parse_remote_url_rejects_malformed_urls() {
        assert!(parse_remote_url("").is_err());
        assert!(parse_remote_url("https://").is_err());
        assert_eq!(
            parse_remote_url("https://user:pass@host").unwrap_err(),
            "URL にユーザー情報（user:pass@）は指定できません"
        );
    }

    /// The failure message names the operationally distinct causes: a 403
    /// comes from the server's Host guard and is fixed in ITS
    /// `--allowed-hosts`, not on this side.
    #[test]
    fn connect_failure_explains_the_http_status() {
        let url = "https://host.tailnet.ts.net";
        assert_eq!(
            connect_failure(url, HealthFailure::Unreachable),
            "サーバーに接続できません: https://host.tailnet.ts.net"
        );
        let forbidden = connect_failure(url, HealthFailure::Status(403));
        assert!(forbidden.contains("HTTP 403"));
        assert!(forbidden.contains("--allowed-hosts"));
        assert!(connect_failure(url, HealthFailure::Status(401)).contains("HTTP 401"));
        assert!(connect_failure(url, HealthFailure::Status(502)).contains("HTTP 502"));
    }
}
