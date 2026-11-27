//! Lending a folder from this computer.
//!
//! The page is served by the (possibly remote) server, so the folder
//! picker, the consent and the loan itself are here in the shell. The
//! server never asks for a folder: it only hears what the lending child
//! announces (see share.rs).

use tauri::http::StatusCode;
use tauri::AppHandle;

use super::wire::{bridge_error, bridge_json, BridgeReply, Params};
use crate::share;

pub(super) fn pick_folder(app: &AppHandle) -> BridgeReply {
    match share::pick_folder(app) {
        Ok(path) => bridge_json(StatusCode::OK, serde_json::json!({ "path": path })),
        Err(e) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

pub(super) fn grant(app: &AppHandle, params: &Params) -> BridgeReply {
    let Some(path) = params.get("path") else {
        return bridge_error(StatusCode::BAD_REQUEST, "path required");
    };
    let session_id = params.get("sessionId").unwrap_or_default();
    let write = params.get("write").as_deref() == Some("1");
    match share::grant(app, &session_id, &path, write) {
        Ok(grant) => bridge_json(
            StatusCode::OK,
            serde_json::json!({ "ok": true, "grant": grant }),
        ),
        Err(e) => bridge_error(StatusCode::BAD_REQUEST, &e),
    }
}

/// The idle deadline the settings page draws: minutes, or `null` for なし.
pub(super) fn idle(app: &AppHandle) -> BridgeReply {
    bridge_json(
        StatusCode::OK,
        serde_json::json!({ "minutes": share::idle_minutes(app) }),
    )
}

/// Set the idle deadline from the settings page. The page's five choices are
/// the only accepted values, spelled as the picker spells them: a typo must
/// not become a deadline nobody chose.
pub(super) fn set_idle(app: &AppHandle, params: &Params) -> BridgeReply {
    let Some(minutes) = params.get("minutes") else {
        return bridge_error(StatusCode::BAD_REQUEST, "minutes required");
    };
    let minutes = match minutes.as_str() {
        "5" => Some(5),
        "10" => Some(10),
        "15" => Some(15),
        "30" => Some(30),
        "never" => None,
        _ => {
            return bridge_error(
                StatusCode::BAD_REQUEST,
                "minutes must be 5, 10, 15, 30 or never",
            )
        }
    };
    match share::set_idle_minutes(app, minutes) {
        Ok(()) => bridge_json(StatusCode::OK, serde_json::json!({ "ok": true })),
        Err(e) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

pub(super) fn revoke(app: &AppHandle, params: &Params) -> BridgeReply {
    let Some(id) = params.get("id") else {
        return bridge_error(StatusCode::BAD_REQUEST, "id required");
    };
    match share::revoke(app, &id) {
        Ok(()) => bridge_json(StatusCode::OK, serde_json::json!({ "ok": true })),
        Err(e) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}
