//! Whether a request may drive the shell at all.

use tauri::http::StatusCode;

use super::wire::{bridge_error, BridgeReply};

/// Actions the splash page may drive before any server is displayed. It is
/// an allowlist, not a denylist: a new action is closed to the startup
/// window until somebody decides it is safe there.
fn startup_action(action: &str) -> bool {
    matches!(
        action,
        "state" | "connect-local" | "connect-saved" | "open-url"
    ) || action.starts_with("window/")
        || action.starts_with("update/")
}

/// Whether this request may drive the shell.
///
/// `current` is the displayed server's token, already normalised so that an
/// empty one reads as "none" (see [`super::display::current_connection_token`]).
/// `displayed` says whether there is a server at all: during startup and in
/// the splash there is none, and only [`startup_action`] may run. Once a
/// server is displayed, a tokenless one leaves the gate open — it has
/// nothing to check against, and its own API is equally open. With a token,
/// every action must present it.
///
/// Split out from [`crate::bridge::handle_shell_action`] so the rule can be
/// stated as a test without an `AppHandle`: the failure it prevents (a
/// tokenless remote window losing its whole title bar) is exactly the kind
/// a test has to be able to pin down.
pub(super) fn key_gate(
    current: Option<&str>,
    supplied: Option<&str>,
    displayed: bool,
    action: &str,
) -> Result<(), BridgeReply> {
    if let Some(current) = current {
        return if supplied == Some(current) {
            Ok(())
        } else {
            Err(bridge_error(StatusCode::UNAUTHORIZED, "invalid key"))
        };
    }
    if !displayed && !startup_action(action) {
        return Err(bridge_error(
            StatusCode::UNAUTHORIZED,
            "no server displayed",
        ));
    }
    Ok(())
}
