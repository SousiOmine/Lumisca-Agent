//! The shell bridge's actions.
//!
//! The settings UI is served by the (possibly remote) server, so it cannot
//! call Tauri commands. It drives the shell through the loopback listener in
//! [`crate::bridge_server`], which forwards to [`handle_shell_action`]: one
//! action per request, named in the path (`/shell/<action>`), parameters in
//! the query string. The bridge only manages the local server and UI
//! switching; the peer registry lives in the server's own database.
//!
//! Every request must carry `key` = the auth token of the CURRENTLY
//! DISPLAYED server — a value only the page served by that server knows, so
//! arbitrary pages cannot drive the bridge.

use tauri::http::StatusCode;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::server::{local_server_status, page_url, restart_local_server};
use crate::settings::SavedConnection;
use crate::update::{
    check_for_updates, download_update, install_update, set_auto_update, update_status_json,
};
use crate::{connection, notify, AppState, LockRecover};

/// One bridge action's answer: the HTTP status and the JSON body.
type BridgeReply = (StatusCode, Vec<u8>);

/// Current display, shown by the settings UI. Also carries the local
/// server startup progress for the splash page.
#[derive(serde::Serialize)]
struct ConnectionState {
    /// "local" | "remote"
    mode: String,
    /// Page URL of the current display, if known.
    url: Option<String>,
    /// What to call the displayed server (the name of the registry entry it
    /// was switched with), or null when there is none to show: the local
    /// server, or a remote reached without a name of its own. The page
    /// cannot answer this — a remote page's registry is that server's own,
    /// which usually has no entry for itself.
    name: Option<String>,
    /// What the shell is doing with the connection: "starting" (local
    /// server booting), "connecting" (probing the remembered remote
    /// server), "ready", "error" (local start failed),
    /// "remote-unreachable" (the remembered server did not answer).
    status: String,
    /// Error message when status is "error" / "remote-unreachable".
    error: Option<String>,
    /// Whether a remote server is remembered, i.e. whether the splash can
    /// offer "reconnect" beside "use the local server".
    saved: bool,
    /// Whether the main window is maximized (custom title bar icon).
    maximized: bool,
}

/// Current display's auth token (the bridge key).
///
/// Empty is no token: a server started without `LUMISCA_TOKEN` injects no
/// `__LUMISCA_TOKEN__` into its page (see `packages/server/render.ts`), so
/// the page cannot present one. Returning `Some("")` here made the gate
/// compare its `None` against `Some("")`, refuse every action with 401, and
/// — because the title bar draws the window controls only from that
/// answer — leave a remote window with no minimise, maximise, close or drag
/// at all. The server normalises the same way (`startupEnv.LUMISCA_TOKEN ||
/// undefined`); the shell has to agree with it.
fn current_connection_token(app: &AppHandle) -> Option<String> {
    let state = app.state::<AppState>();
    let remote = state
        .last_remote
        .lock_recover()
        .as_ref()
        .map(|conn| conn.token.clone());
    let local = state.local.lock_recover().as_ref().map(|l| l.token.clone());
    bridge_key(remote, local)
}

/// The key the gate checks against, from the tokens the shell holds.
///
/// The displayed server's token wins: while a remote server is shown, the
/// local server's token must not open the window to that page. An empty
/// token is no token — the server draws the same line for `LUMISCA_TOKEN`
/// (`startupEnv.LUMISCA_TOKEN || undefined`, packages/server/mod.ts), and
/// the two sides decide independently whether a page carries a key. A server
/// without one injects none into its page (`packages/server/render.ts`), so
/// the page cannot present one; treating "" as a key refused every action
/// with 401 and left the window with no title bar at all.
///
/// Pure, so the rule is testable without an `AppHandle`.
fn bridge_key(remote: Option<String>, local: Option<String>) -> Option<String> {
    let token = if remote.is_some() { remote } else { local };
    token.filter(|token| !token.is_empty())
}

fn bridge_json(status: StatusCode, value: serde_json::Value) -> BridgeReply {
    (status, serde_json::to_vec(&value).unwrap_or_default())
}

fn bridge_error(status: StatusCode, message: &str) -> BridgeReply {
    bridge_json(status, serde_json::json!({ "error": message }))
}

/// Whether this request may drive the shell.
///
/// `current` is the displayed server's token, already normalised so that an
/// empty one reads as "none" (see [`current_connection_token`]). A server
/// without a token leaves the gate open — it has nothing to check against,
/// and its own API is equally open. With one, the request must present it.
///
/// Split out from [`handle_shell_action`] so the rule can be stated as a
/// test without an `AppHandle`: the failure it prevents (a tokenless remote
/// window losing its whole title bar) is exactly the kind a test has to be
/// able to pin down.
fn key_gate(current: Option<&str>, supplied: Option<&str>) -> Result<(), BridgeReply> {
    let Some(current) = current else {
        return Ok(());
    };
    if supplied == Some(current) {
        return Ok(());
    }
    Err(bridge_error(StatusCode::UNAUTHORIZED, "invalid key"))
}

/// Turn the loopback bridge's HTTP answer into the IPC command's result:
/// the JSON body on success, the bridge's own error text on failure.
fn bridge_reply_to_result(reply: BridgeReply) -> Result<serde_json::Value, String> {
    let (status, body) = reply;
    let value = serde_json::from_slice::<serde_json::Value>(&body)
        .map_err(|e| format!("invalid shell reply: {e}"))?;
    if status.is_success() {
        Ok(value)
    } else {
        Err(value
            .get("error")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("shell action failed: {status}")))
    }
}

/// Run one shell action over Tauri's IPC.
///
/// The loopback bridge ([`crate::bridge_server`]) is unreachable from a page
/// served over HTTPS: WebKit (macOS) refuses a mixed-content fetch from an
/// HTTPS document to `http://127.0.0.1`, loopback or not. A remote server is
/// normally reached over HTTPS, so the page falls back to this command
/// (`packages/web/src/shell.ts`). The action and its key gate are the same
/// ones the listener uses, so a shell action has one implementation.
///
/// The action runs on a blocking worker: `pick-folder` opens a modal sheet
/// and `connect-local` may wait for a server, and neither may occupy the IPC
/// thread.
#[tauri::command]
pub(crate) async fn shell_action(
    app: AppHandle,
    action: String,
    params: std::collections::HashMap<String, String>,
) -> Result<serde_json::Value, String> {
    let params = params.into_iter().collect::<Vec<_>>();
    tauri::async_runtime::spawn_blocking(move || {
        bridge_reply_to_result(handle_shell_action(&app, &action, &params))
    })
    .await
    .map_err(|e| format!("shell action task failed: {e}"))?
}

/// Answer one bridge action. `action` is everything after `/shell/`
/// (`state`, `connect-remote`, `update/status`, ...) and `params` are the
/// query string's parameters (`key` included).
pub(crate) fn handle_shell_action(
    app: &AppHandle,
    action: &str,
    params: &[(String, String)],
) -> BridgeReply {
    let params: std::collections::HashMap<&str, &str> = params
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect();

    // Key gate: only the page of the currently displayed server may drive
    // the bridge, window controls included. Tokenless servers leave it
    // open (matching their own auth posture), and while no server is
    // displayed yet — the splash page, or a failed startup — there is no
    // token either, so the gate is open and the splash can drive the
    // window controls. Once a token exists, every action requires it.
    if let Err(reply) = key_gate(
        current_connection_token(app).as_deref(),
        params.get("key").copied(),
    ) {
        return reply;
    }

    let get = |name: &str| params.get(name).map(|value| value.to_string());
    match action {
        "state" => {
            let state = app.state::<AppState>();
            let startup = state.startup.lock_recover();
            let mode = if state.last_remote.lock_recover().is_some() {
                "remote"
            } else {
                "local"
            };
            let remote = state.last_remote.lock_recover().clone();
            let url = if mode == "remote" {
                remote.as_ref().map(|conn| page_url(&conn.url, &conn.token))
            } else {
                state
                    .local
                    .lock_recover()
                    .as_ref()
                    .map(|l| crate::server::Endpoint::loopback(l.port, &l.token).page_url())
            };
            let maximized = app
                .get_webview_window("main")
                .map(|window| window.is_maximized().unwrap_or(false))
                .unwrap_or(false);
            // The splash polls this every 150 ms, so the remembered choice
            // is read from memory rather than from the settings file on
            // every poll.
            let saved = state.remembered.lock_recover().is_some();
            let name = remote.as_ref().and_then(|conn| conn.name.clone());
            let state = ConnectionState {
                mode: mode.to_string(),
                url,
                name,
                status: startup.status.clone(),
                error: startup.error.clone(),
                saved,
                maximized,
            };
            bridge_json(StatusCode::OK, serde_json::to_value(state).unwrap())
        }
        // Both switches remember the choice in `settings.json`, so the next
        // launch returns to the server the window was showing.
        "connect-remote" => {
            let (url, token) = match (get("url"), get("token")) {
                (Some(url), token) => (url, token.unwrap_or_default()),
                _ => return bridge_error(StatusCode::BAD_REQUEST, "url required"),
            };
            // `name` is the registry entry's label (its name, or the host of
            // a nameless entry). It is kept with the connection so the title
            // bar can name the server after the page is loaded.
            let conn = SavedConnection {
                url,
                token,
                name: get("name"),
            };
            match connection::connect_remote(app, &conn) {
                Ok(page) => bridge_json(
                    StatusCode::OK,
                    serde_json::json!({ "ok": true, "url": page }),
                ),
                Err(e) => bridge_error(StatusCode::BAD_GATEWAY, &e),
            }
        }
        "connect-local" => match connection::connect_local(app) {
            Ok(url) => bridge_json(
                StatusCode::OK,
                serde_json::json!({ "ok": true, "url": url }),
            ),
            Err(e) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
        },
        // Retry the remembered remote server from the splash, without a
        // navigation away from it (it failed to answer at startup).
        "connect-saved" => match connection::connect_saved(app) {
            Ok(url) => bridge_json(
                StatusCode::OK,
                serde_json::json!({ "ok": true, "url": url }),
            ),
            Err(e) => bridge_error(StatusCode::BAD_GATEWAY, &e),
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
        // Reachability check for the settings UI, without switching.
        "test" => {
            let (url, token) = match (get("url"), get("token")) {
                (Some(url), token) => (url, token.unwrap_or_default()),
                _ => return bridge_error(StatusCode::BAD_REQUEST, "url required"),
            };
            match connection::test_remote(&url, &token) {
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

    #[test]
    fn bridge_reply_success_is_the_json_body() {
        let reply = (StatusCode::OK, br#"{"ok":true}"#.to_vec());
        assert_eq!(
            bridge_reply_to_result(reply).unwrap(),
            serde_json::json!({ "ok": true })
        );
    }

    #[test]
    fn bridge_reply_failure_uses_the_error_message() {
        let reply = (
            StatusCode::UNAUTHORIZED,
            br#"{"error":"invalid key"}"#.to_vec(),
        );
        assert_eq!(bridge_reply_to_result(reply).unwrap_err(), "invalid key");
    }

    #[test]
    fn a_tokenless_server_leaves_the_gate_open() {
        // The bug this pins down: a remote server started without
        // LUMISCA_TOKEN injects no token into its page, so the page sends no
        // `key`. When the shell still considered "" a token, the gate
        // compared its `None` against `Some("")`, answered 401 to every
        // action, and the title bar — which draws the window controls from
        // the `state` answer — rendered nothing: no minimise, maximise,
        // close or drag.
        //
        // The normalisation is part of the rule, so it is tested here: an
        // empty stored token has to arrive at the gate as None, which is
        // what `current_connection_token` now does. Testing `key_gate` with
        // a hand-written `None` would pass either way and prove nothing.
        // A remote server with no token, remembered as "": the key the gate
        // compares against must be None, not Some("").
        let key = bridge_key(Some(String::new()), Some("local-token".into()));
        assert_eq!(key, None);
        assert!(key_gate(key.as_deref(), None).is_ok());
        // A page that happens to send an empty key is the same case.
        assert!(key_gate(None, Some("")).is_ok());
    }

    #[test]
    fn the_displayed_servers_token_wins_over_the_other() {
        // While a remote server is shown, the local server's token must not
        // open the window to that page — and the other way round.
        assert_eq!(
            bridge_key(Some("remote".into()), Some("local".into())),
            Some("remote".into())
        );
        assert_eq!(bridge_key(None, Some("local".into())), Some("local".into()));
    }

    #[test]
    fn a_tokened_server_requires_its_own_key() {
        // The gate still does its job: only the displayed server's page may
        // drive the window.
        assert!(key_gate(Some("secret"), Some("secret")).is_ok());
        assert_eq!(
            key_gate(Some("secret"), None).unwrap_err().0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            key_gate(Some("secret"), Some("other")).unwrap_err().0,
            StatusCode::UNAUTHORIZED
        );
    }

    #[test]
    fn bridge_reply_failure_without_a_message_names_the_status() {
        let reply = (StatusCode::BAD_GATEWAY, b"{}".to_vec());
        assert_eq!(
            bridge_reply_to_result(reply).unwrap_err(),
            "shell action failed: 502 Bad Gateway"
        );
    }
}
