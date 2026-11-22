//! The servers this window can display, and the switch between them.
//!
//! The list belongs to the shell, not to the displayed server. A page
//! served by a remote server must not know, or change, which other servers
//! this computer connects to.

use tauri::http::StatusCode;
use tauri::AppHandle;

use super::display::ConnectionSummary;
use super::wire::{bridge_error, bridge_json, BridgeReply, Params};
use crate::connection;
use crate::settings::SavedConnection;

/// The list, without tokens.
pub(super) fn list(app: &AppHandle) -> BridgeReply {
    let summaries: Vec<ConnectionSummary> = connection::list_connections(app)
        .iter()
        .map(ConnectionSummary::from)
        .collect();
    bridge_json(
        StatusCode::OK,
        serde_json::json!({ "connections": summaries }),
    )
}

/// One row with its token, for the editor. Separate from the list so a page
/// that only shows names never receives every stored secret.
pub(super) fn get(app: &AppHandle, params: &Params) -> BridgeReply {
    let Some(id) = params.get("id") else {
        return bridge_error(StatusCode::BAD_REQUEST, "id required");
    };
    match connection::list_connections(app)
        .into_iter()
        .find(|conn| conn.id == id)
    {
        Some(conn) => bridge_json(
            StatusCode::OK,
            serde_json::to_value(conn).unwrap_or_default(),
        ),
        None => bridge_error(StatusCode::NOT_FOUND, "connection not found"),
    }
}

pub(super) fn save(app: &AppHandle, params: &Params) -> BridgeReply {
    let (Some(id), Some(url)) = (params.get("id"), params.get("url")) else {
        return bridge_error(StatusCode::BAD_REQUEST, "id and url required");
    };
    let conn = SavedConnection {
        id,
        url,
        token: params.get("token").unwrap_or_default(),
        name: params.get("name").unwrap_or_default(),
    };
    match connection::save_connection(app, conn) {
        Ok(()) => bridge_json(StatusCode::OK, serde_json::json!({ "ok": true })),
        Err(e) => bridge_error(StatusCode::BAD_REQUEST, &e),
    }
}

pub(super) fn delete(app: &AppHandle, params: &Params) -> BridgeReply {
    let Some(id) = params.get("id") else {
        return bridge_error(StatusCode::BAD_REQUEST, "id required");
    };
    match connection::delete_connection(app, &id) {
        Ok(()) => bridge_json(StatusCode::OK, serde_json::json!({ "ok": true })),
        Err(e) => bridge_error(StatusCode::BAD_REQUEST, &e),
    }
}

/// Switch the window to a remembered remote server.
pub(super) fn connect_remote(app: &AppHandle, params: &Params) -> BridgeReply {
    let Some(id) = params.get("id") else {
        return bridge_error(StatusCode::BAD_REQUEST, "id required");
    };
    match connection::connect_remote(app, &id) {
        Ok(page) => bridge_json(
            StatusCode::OK,
            serde_json::json!({ "ok": true, "url": page }),
        ),
        Err(e) => bridge_error(StatusCode::BAD_GATEWAY, &e),
    }
}

/// Both switches remember the choice in `settings.json`, so the next launch
/// returns to the server the window was showing.
pub(super) fn connect_local(app: &AppHandle) -> BridgeReply {
    match connection::connect_local(app) {
        Ok(url) => bridge_json(
            StatusCode::OK,
            serde_json::json!({ "ok": true, "url": url }),
        ),
        Err(e) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

/// Retry the remembered remote server from the splash, without a navigation
/// away from it (it failed to answer at startup).
pub(super) fn connect_saved(app: &AppHandle) -> BridgeReply {
    match connection::connect_saved(app) {
        Ok(url) => bridge_json(
            StatusCode::OK,
            serde_json::json!({ "ok": true, "url": url }),
        ),
        Err(e) => bridge_error(StatusCode::BAD_GATEWAY, &e),
    }
}

/// Reachability check for the settings UI, without switching.
pub(super) fn test(params: &Params) -> BridgeReply {
    let (url, token) = match (params.get("url"), params.get("token")) {
        (Some(url), token) => (url, token.unwrap_or_default()),
        _ => return bridge_error(StatusCode::BAD_REQUEST, "url required"),
    };
    match connection::test_remote(&url, &token) {
        Ok(()) => bridge_json(StatusCode::OK, serde_json::json!({ "ok": true })),
        Err(e) => bridge_error(StatusCode::BAD_GATEWAY, &e),
    }
}
