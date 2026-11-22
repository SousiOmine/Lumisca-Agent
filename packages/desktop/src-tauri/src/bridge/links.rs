//! Links the page cannot open itself.
//!
//! A `target="_blank"` click reaches the window's new-window handler, but a
//! script's `window.open` after an awaited request is not a user gesture:
//! WebKitGTK drops it before the handler runs. The MCP sign-in learns its
//! authorization URL only after the server answers, so it asks the shell to
//! hand the URL to the OS browser, where no popup rule applies.

use tauri::http::StatusCode;

use super::wire::{bridge_error, bridge_json, BridgeReply, Params};
use crate::window::{open_externally, opens_externally};

pub(super) fn open_url(params: &Params) -> BridgeReply {
    let Some(raw) = params.get("url") else {
        return bridge_error(StatusCode::BAD_REQUEST, "url required");
    };
    let url = match url::Url::parse(&raw) {
        Ok(url) => url,
        Err(_) => return bridge_error(StatusCode::BAD_REQUEST, "invalid url"),
    };
    if !opens_externally(&url) {
        return bridge_error(StatusCode::BAD_REQUEST, "url scheme is not allowed");
    }
    match open_externally(&url) {
        Ok(()) => bridge_json(StatusCode::OK, serde_json::json!({ "ok": true })),
        Err(e) => bridge_error(StatusCode::BAD_GATEWAY, &e),
    }
}
