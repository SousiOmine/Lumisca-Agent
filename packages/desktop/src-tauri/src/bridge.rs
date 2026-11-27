//! The shell bridge's actions.
//!
//! The main window shows the bundled UI (`tauri://localhost` or
//! `http://tauri.localhost`), which calls the API of the server it displays.
//! The UI drives the shell through the loopback listener in
//! [`crate::bridge_server`], which forwards to [`handle_shell_action`]: one
//! action per request, named in the path (`/shell/<action>`), parameters in
//! the query string. The bridge manages the window: its server list, which
//! server it displays, the local child process, updates and folder loans.
//! The servers this window federates with are the displayed server's own
//! (see `/api/connections`) and are not reachable from here.
//!
//! Every request must carry `key` = the auth token of the CURRENTLY
//! DISPLAYED server, and the listener accepts only the bundled UI's origins
//! (see `bridge_server::origin_allowed`). The key is a second lock: while no
//! server is displayed only the startup actions run.
//!
//! This module is the dispatch table and nothing else. What a request must
//! present lives in [`gate`]; what the window displays (and the key its page
//! carries) in [`display`]; the request's shape and the reply's in [`wire`].
//! Each group of actions has its own module: [`connections`] (the server
//! list and the switch between them), [`sharing`] (folder loans),
//! [`diagnostics`] (the local server), [`links`], [`updates`],
//! [`main_window`] (title bar controls and the folder picker) and
//! [`alerts`] (OS notifications).

mod alerts;
mod connections;
mod diagnostics;
mod display;
mod gate;
mod links;
mod main_window;
mod save_file;
mod sharing;
mod updates;
mod wire;

use tauri::http::StatusCode;
use tauri::AppHandle;

#[cfg(test)]
use crate::settings::SavedConnection;
#[cfg(test)]
use display::{bridge_key, ConnectionState, ConnectionSummary};
#[cfg(test)]
use wire::bridge_reply_to_result;

use gate::key_gate;
use wire::{bridge_error, BridgeReply, Params};

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
        wire::bridge_reply_to_result(handle_shell_action(&app, &action, &params))
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
    let params = Params::new(params);

    // Key gate: only the page of the currently displayed server may drive
    // the bridge, window controls included. Before a server is displayed —
    // the splash page, or a failed startup — only the startup actions run.
    // A displayed tokenless server leaves the gate open, matching its own
    // API; once a token exists, every action requires it.
    if let Err(reply) = key_gate(
        display::current_connection_token(app).as_deref(),
        params.get("key").as_deref(),
        display::display_ready(app),
        action,
    ) {
        return reply;
    }

    match action {
        "state" => display::state(app),
        "connections/list" => connections::list(app),
        "connections/get" => connections::get(app, &params),
        "connections/save" => connections::save(app, &params),
        "connections/delete" => connections::delete(app, &params),
        "connect-remote" => connections::connect_remote(app, &params),
        "connect-local" => connections::connect_local(app),
        "connect-saved" => connections::connect_saved(app),
        "share/pick-folder" => sharing::pick_folder(app),
        "share/grant" => sharing::grant(app, &params),
        "share/revoke" => sharing::revoke(app, &params),
        "share/computer-roots" => sharing::computer_roots(),
        "share/grant-computer" => sharing::grant_computer(app, &params),
        "share/revoke-group" => sharing::revoke_group(app, &params),
        "share/idle" => sharing::idle(app),
        "share/set-idle" => sharing::set_idle(app, &params),
        "server/status" => diagnostics::status(app),
        "server/restart" => diagnostics::restart(app),
        "open-url" => links::open_url(&params),
        "test" => connections::test(&params),
        "update/status" => updates::status(app),
        "update/set-auto" => updates::set_auto(app, &params),
        "update/check" => updates::check(app),
        "update/download" => updates::download(app),
        "update/install" => updates::install(app),
        "window/minimize" => main_window::minimize(app),
        "window/toggle-maximize" => main_window::toggle_maximize(app),
        "window/close" => main_window::close(app),
        "window/start-drag" => main_window::start_drag(app),
        "window/state" => alerts::window_state(app),
        "window/focus" => alerts::focus(app),
        "pick-folder" => main_window::pick_folder(app),
        // One of the displayed server's files, saved where the user picks.
        "save-file" => save_file::save(app, &params),
        "notify" => alerts::notify(app, &params),
        "quit" => main_window::close(app),
        _ => bridge_error(StatusCode::NOT_FOUND, "unknown action"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The page reads `connectionId` (packages/web/src/shell.ts). The field
    /// was named `connection_id` on the wire when the connection list moved
    /// to the shell, so the title bar could not name a remote server and sat
    /// on "読み込み中..." instead.

    /// The page, the splash and this match must name the same actions. The
    /// list is the page's (web/src/shell-actions.ts); a name added there
    /// without an arm makes this fail, and so does an arm nobody can call.
    #[test]
    fn the_page_action_list_and_the_match_agree() {
        const TS: &str = include_str!("../../../web/src/shell-actions.ts");
        let list_start = TS.find("SHELL_ACTIONS = [").expect("the list marker");
        let list_end = TS[list_start..].find("] as const").expect("the list end");
        let listed: std::collections::BTreeSet<String> = TS[list_start..list_start + list_end]
            .split('"')
            .skip(1)
            .step_by(2)
            .map(str::to_owned)
            .collect();
        let source: &str = include_str!("bridge.rs");
        let mut arms = std::collections::BTreeSet::new();
        for line in source.lines() {
            let line = line.trim();
            if !line.contains("=>") {
                continue;
            }
            if let Some(rest) = line.strip_prefix('"') {
                if let Some(end) = rest.find('"') {
                    arms.insert(rest[..end].to_string());
                }
            }
        }
        assert_eq!(listed, arms);
    }

    #[test]
    fn connection_state_names_fields_in_camel_case() {
        let state = ConnectionState {
            mode: "remote".into(),
            url: Some("http://127.0.0.1:8000".into()),
            connection_id: Some("home".into()),
            status: "ready".into(),
            error: None,
            saved: true,
            maximized: false,
        };
        let json = serde_json::to_value(state).unwrap();
        assert_eq!(json["connectionId"], "home");
        assert_eq!(json["mode"], "remote");
        assert!(json.get("connection_id").is_none());
    }

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
        assert!(key_gate(key.as_deref(), None, true, "connections/list").is_ok());
        // A page that happens to send an empty key is the same case.
        assert!(key_gate(None, Some(""), true, "state").is_ok());
    }

    #[test]
    fn before_a_server_is_displayed_only_startup_actions_run() {
        // The splash drives the window and the two connect actions; nothing
        // else may run while no token can exist yet.
        for action in ["state", "connect-local", "connect-saved", "window/close"] {
            assert!(key_gate(None, None, false, action).is_ok(), "{action}");
        }
        for action in ["connections/list", "connections/get", "test", "quit"] {
            assert_eq!(
                key_gate(None, None, false, action).unwrap_err().0,
                StatusCode::UNAUTHORIZED,
                "{action}"
            );
        }
    }

    #[test]
    fn the_list_summary_carries_no_token() {
        let conn = SavedConnection {
            id: "home".into(),
            url: "https://home.example".into(),
            token: "secret".into(),
            name: "Home".into(),
        };
        let json = serde_json::to_value(ConnectionSummary::from(&conn)).unwrap();
        assert_eq!(json["id"], "home");
        assert_eq!(json["hasToken"], true);
        assert!(json.get("token").is_none());
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
        assert!(key_gate(Some("secret"), Some("secret"), true, "state").is_ok());
        assert_eq!(
            key_gate(Some("secret"), None, true, "state").unwrap_err().0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            key_gate(Some("secret"), Some("other"), true, "state")
                .unwrap_err()
                .0,
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
