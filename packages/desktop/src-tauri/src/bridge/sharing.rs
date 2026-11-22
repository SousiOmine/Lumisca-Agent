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

pub(super) fn revoke(app: &AppHandle, params: &Params) -> BridgeReply {
    let Some(id) = params.get("id") else {
        return bridge_error(StatusCode::BAD_REQUEST, "id required");
    };
    match share::revoke(app, &id) {
        Ok(()) => bridge_json(StatusCode::OK, serde_json::json!({ "ok": true })),
        Err(e) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}
