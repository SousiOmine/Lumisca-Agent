//! What the window displays: the local server or one remembered remote one.
//!
//! Three readers ask the same question — the `state` action (drawn by the
//! title bar and polled by the splash), the key gate (which token a request
//! must present) and the connections list (which row is the current one) —
//! so the answer is computed here and nowhere else.

use tauri::http::StatusCode;
use tauri::{AppHandle, Manager};

use super::wire::{bridge_json, BridgeReply};
use crate::server::page_url;
use crate::settings::SavedConnection;
use crate::{AppState, LockRecover};

/// Current display, shown by the settings UI. Also carries the local
/// server startup progress for the splash page.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ConnectionState {
    /// "local" | "remote"
    pub(super) mode: String,
    /// Page URL of the current display, if known.
    pub(super) url: Option<String>,
    /// The id of the connection row the window is showing, or null for the
    /// local server. The page looks the row up in the same list it edits,
    /// so the displayed name follows a rename without the shell keeping a
    /// second copy of it.
    pub(super) connection_id: Option<String>,
    /// What the shell is doing with the connection: "starting" (local
    /// server booting), "connecting" (probing the remembered remote
    /// server), "ready", "error" (local start failed),
    /// "remote-unreachable" (the remembered server did not answer).
    pub(super) status: String,
    /// Error message when status is "error" / "remote-unreachable".
    pub(super) error: Option<String>,
    /// Whether a remote server is remembered, i.e. whether the splash can
    /// offer "reconnect" beside "use the local server".
    pub(super) saved: bool,
    /// Whether the main window is maximized (custom title bar icon).
    pub(super) maximized: bool,
}

/// A connection as the list endpoint returns it: the token is not part of
/// the answer. Ranking and switching need only the identity and address;
/// a page that edits a row fetches the secret with `connections/get`, which
/// is a separate, key-gated request.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ConnectionSummary {
    id: String,
    url: String,
    name: String,
    /// Whether a token is stored, so the editor can say one exists without
    /// receiving it.
    has_token: bool,
}

impl From<&SavedConnection> for ConnectionSummary {
    fn from(conn: &SavedConnection) -> Self {
        Self {
            id: conn.id.clone(),
            url: conn.url.clone(),
            name: conn.name.clone(),
            has_token: !conn.token.is_empty(),
        }
    }
}

/// Whether a server (local or remote) is currently displayed. The splash
/// runs before either exists; a tokenless server still counts as displayed,
/// so its settings page keeps working.
pub(super) fn display_ready(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    state.displayed.lock_recover().is_some() || state.local.lock_recover().is_some()
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
pub(super) fn current_connection_token(app: &AppHandle) -> Option<String> {
    let state = app.state::<AppState>();
    let remote = state
        .displayed
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
pub(super) fn bridge_key(remote: Option<String>, local: Option<String>) -> Option<String> {
    let token = if remote.is_some() { remote } else { local };
    token.filter(|token| !token.is_empty())
}

/// The `state` answer: what is displayed, and what the window looks like.
pub(super) fn state(app: &AppHandle) -> BridgeReply {
    let state = app.state::<AppState>();
    let startup = state.startup.lock_recover();
    let remote = state.displayed.lock_recover().clone();
    let mode = if remote.is_some() { "remote" } else { "local" };
    let url = match &remote {
        Some(conn) => Some(page_url(&conn.url, &conn.token)),
        None => state
            .local
            .lock_recover()
            .as_ref()
            .map(|l| crate::server::Endpoint::loopback(l.port, &l.token).page_url()),
    };
    let maximized = app
        .get_webview_window("main")
        .map(|window| window.is_maximized().unwrap_or(false))
        .unwrap_or(false);
    // The splash polls this every 150 ms, so the remembered choice
    // is read from memory rather than from the settings file on
    // every poll.
    let saved = state.remembered.lock_recover().is_some();
    let connection_id = remote.as_ref().map(|conn| conn.id.clone());
    let state = ConnectionState {
        mode: mode.to_string(),
        url,
        connection_id,
        status: startup.status.clone(),
        error: startup.error.clone(),
        saved,
        maximized,
    };
    bridge_json(StatusCode::OK, serde_json::to_value(state).unwrap())
}
