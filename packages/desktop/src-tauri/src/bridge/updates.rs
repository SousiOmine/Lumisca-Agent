//! Auto-update: the state the settings UI polls, and the three steps that
//! start or apply an update.

use tauri::http::StatusCode;
use tauri::AppHandle;

use super::wire::{bridge_error, bridge_json, BridgeReply, Params};
use crate::update::{
    check_for_updates, download_update, install_update, set_auto_update, update_status_json,
};

pub(super) fn status(app: &AppHandle) -> BridgeReply {
    bridge_json(StatusCode::OK, update_status_json(app))
}

pub(super) fn set_auto(app: &AppHandle, params: &Params) -> BridgeReply {
    let enabled = match params.get("enabled").and_then(|v| v.parse::<bool>().ok()) {
        Some(enabled) => enabled,
        None => return bridge_error(StatusCode::BAD_REQUEST, "enabled required"),
    };
    match set_auto_update(app, enabled) {
        Ok(()) => bridge_json(StatusCode::OK, update_status_json(app)),
        Err(e) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

pub(super) fn check(app: &AppHandle) -> BridgeReply {
    tauri::async_runtime::spawn(check_for_updates(app.clone(), false));
    bridge_json(StatusCode::OK, update_status_json(app))
}

pub(super) fn download(app: &AppHandle) -> BridgeReply {
    tauri::async_runtime::spawn(download_update(app.clone()));
    bridge_json(StatusCode::OK, update_status_json(app))
}

pub(super) fn install(app: &AppHandle) -> BridgeReply {
    install_update(app.clone());
    bridge_json(StatusCode::OK, update_status_json(app))
}
