//! Local server diagnostics.
//!
//! The page cannot tell "server crashed" apart from "server hung" on its
//! own — both just stop answering fetches/WS — so the shell (which owns the
//! child handle and captures its output) reports both. The connection-lost
//! banner polls `server/status` and shows "再起動" + log copy-paste when the
//! server is gone.

use tauri::http::StatusCode;
use tauri::AppHandle;

use super::wire::{bridge_error, bridge_json, BridgeReply};
use crate::server::{local_server_status, restart_local_server};

pub(super) fn status(app: &AppHandle) -> BridgeReply {
    bridge_json(
        StatusCode::OK,
        serde_json::to_value(local_server_status(app)).unwrap(),
    )
}

pub(super) fn restart(app: &AppHandle) -> BridgeReply {
    match restart_local_server(app) {
        Ok(url) => bridge_json(
            StatusCode::OK,
            serde_json::json!({ "ok": true, "url": url }),
        ),
        Err(e) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}
