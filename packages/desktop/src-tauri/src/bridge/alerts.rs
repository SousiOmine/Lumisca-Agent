//! Background agent-event notifications.
//!
//! The frontend watches the agent event stream; when a run ends
//! (`agent_end`) or the agent asks a question (the ask tool) while the main
//! window has no focus (minimized, behind another app, on another virtual
//! desktop), it shows an OS notification here. Windows toasts carry our
//! AppUserModelID (Lumisca name + icon) with an explicit click-to-focus
//! handler; `window/focus` covers the programmatic path.

use tauri::http::StatusCode;
use tauri::AppHandle;

use super::wire::{bridge_error, bridge_json, BridgeReply, Params};
use crate::notify;

pub(super) fn window_state(app: &AppHandle) -> BridgeReply {
    bridge_json(
        StatusCode::OK,
        serde_json::to_value(notify::window_state(app)).unwrap(),
    )
}

pub(super) fn focus(app: &AppHandle) -> BridgeReply {
    notify::focus_main(app);
    bridge_json(StatusCode::OK, serde_json::json!({ "ok": true }))
}

pub(super) fn notify(app: &AppHandle, params: &Params) -> BridgeReply {
    let title = params.get("title").unwrap_or_default();
    let body = params.get("body").unwrap_or_default();
    if title.is_empty() && body.is_empty() {
        return bridge_error(StatusCode::BAD_REQUEST, "title or body required");
    }
    // The ask-tool question keeps its toast on screen longer (Windows); the
    // run-end toast uses the default duration.
    let urgent = matches!(params.get("urgent").as_deref(), Some("1") | Some("true"));
    notify::show_notification(app, &title, &body, urgent);
    bridge_json(StatusCode::OK, serde_json::json!({ "ok": true }))
}
