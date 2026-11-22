//! One request's parameters and one answer's shape.
//!
//! Every action answers with an HTTP status and a JSON body: the loopback
//! listener ([`crate::bridge_server`]) writes them to the socket, and the
//! IPC fallback ([`crate::bridge::shell_action`]) turns them back into a
//! command result. Both read the same two pieces, so they live here.

use tauri::http::StatusCode;

/// One bridge action's answer: the HTTP status and the JSON body.
pub(crate) type BridgeReply = (StatusCode, Vec<u8>);

/// The query string of one request, by parameter name.
pub(super) struct Params<'a>(std::collections::HashMap<&'a str, &'a str>);

impl<'a> Params<'a> {
    pub(super) fn new(pairs: &'a [(String, String)]) -> Self {
        Self(
            pairs
                .iter()
                .map(|(name, value)| (name.as_str(), value.as_str()))
                .collect(),
        )
    }

    /// The value of `name`, if the request carried it.
    pub(super) fn get(&self, name: &str) -> Option<String> {
        self.0.get(name).map(|value| value.to_string())
    }
}

pub(super) fn bridge_json(status: StatusCode, value: serde_json::Value) -> BridgeReply {
    (status, serde_json::to_vec(&value).unwrap_or_default())
}

pub(super) fn bridge_error(status: StatusCode, message: &str) -> BridgeReply {
    bridge_json(status, serde_json::json!({ "error": message }))
}

/// Turn the loopback bridge's HTTP answer into the IPC command's result:
/// the JSON body on success, the bridge's own error text on failure.
pub(super) fn bridge_reply_to_result(reply: BridgeReply) -> Result<serde_json::Value, String> {
    let (status, body) = reply;
    let value = serde_json::from_slice::<serde_json::Value>(&body)
        .map_err(|e| format!("invalid shell reply: {e}"))?;
    if status.is_success() {
        Ok(value)
    } else {
        Err(value
            .get("error")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("shell action failed: {status}")))
    }
}
