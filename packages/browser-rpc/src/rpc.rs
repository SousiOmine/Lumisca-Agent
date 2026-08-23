//! RPC wire types and helpers. Mirrors packages/core/browser/types.ts:
//! `{id, method, params}` requests and `{id, ok, result | error}` replies
//! over POST /rpc, authenticated by the token header.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One RPC request.
#[derive(Debug, Deserialize)]
pub struct RpcRequest {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// A structured failure of one RPC call.
#[derive(Debug, Clone, Serialize)]
pub struct RpcError {
    pub code: String,
    pub message: String,
}

impl RpcError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }

    /// Invalid method / malformed params.
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(crate::error_codes::INVALID, message)
    }

    /// The host has no lab window / is shutting down.
    pub fn not_open(message: impl Into<String>) -> Self {
        Self::new(crate::error_codes::NOT_OPEN, message)
    }

    /// The page has no probe installed (non-page, error page, blocked).
    pub fn probe_missing(message: impl Into<String>) -> Self {
        Self::new(crate::error_codes::PROBE_MISSING, message)
    }

    /// Platform limitation — no silent fallback, an explicit error.
    pub fn unsupported(code: &str, message: impl Into<String>) -> Self {
        Self::new(code, message)
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(crate::error_codes::TIMEOUT, message)
    }

    /// The host is shutting down / already gone.
    pub fn closed(message: impl Into<String>) -> Self {
        Self::new(crate::error_codes::CLOSED, message)
    }

    pub fn too_large(message: impl Into<String>) -> Self {
        Self::new(crate::error_codes::TOO_LARGE, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(crate::error_codes::INTERNAL, message)
    }
}

/// The reply the server sends: success carries `result`, failure carries
/// `error` with a stable code. Serialized as
/// `{id, ok: true, result}` / `{id, ok: false, error: {code, message}}`.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum RpcReply {
    Success { id: u64, ok: bool, result: Value },
    Failure { id: u64, ok: bool, error: RpcError },
}

impl RpcReply {
    pub fn success(id: u64, result: Value) -> Self {
        RpcReply::Success {
            id,
            ok: true,
            result,
        }
    }

    pub fn failure(id: u64, error: RpcError) -> Self {
        RpcReply::Failure {
            id,
            ok: false,
            error,
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            // The reply must serialize (plain values only); fall back to an
            // internal error if it ever cannot.
            let fallback = RpcReply::Failure {
                id: 0,
                ok: false,
                error: RpcError::new(crate::error_codes::INTERNAL, "reply serialization failed"),
            };
            serde_json::to_string(&fallback).unwrap_or_else(|_| "{}".to_string())
        })
    }
}

/// Bounded JSON body parsing for requests (see limits::MAX_REQUEST_BYTES).
pub fn parse_request(body: &[u8], max_bytes: usize) -> Result<RpcRequest, RpcError> {
    if body.len() > max_bytes {
        return Err(RpcError::too_large(format!(
            "browser RPC リクエストが大きすぎます ({} bytes)",
            body.len()
        )));
    }
    serde_json::from_slice(body)
        .map_err(|e| RpcError::invalid(format!("リクエストが不正です: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_round_trip() {
        let body = br#"{"id":7,"method":"observe","params":{"includeText":true}}"#;
        let request = parse_request(body, 1024).expect("must parse");
        assert_eq!(request.id, 7);
        assert_eq!(request.method, "observe");
        assert_eq!(request.params["includeText"], Value::Bool(true));
    }

    #[test]
    fn oversized_requests_are_rejected() {
        let body = vec![b'x'; 10_000];
        let error = parse_request(&body, 1024).expect_err("must reject");
        assert_eq!(error.code, crate::error_codes::TOO_LARGE);
    }

    #[test]
    fn malformed_requests_are_rejected() {
        let error = parse_request(br#"not json"#, 1024).expect_err("must reject");
        assert_eq!(error.code, crate::error_codes::INVALID);
    }

    #[test]
    fn replies_serialize_to_the_wire_shape() {
        let success = RpcReply::success(3, serde_json::json!({"url": "http://127.0.0.1:1/"}));
        let success_json: Value = serde_json::from_str(&success.to_json()).unwrap();
        assert_eq!(success_json["id"], 3);
        assert_eq!(success_json["ok"], true);
        assert_eq!(success_json["result"]["url"], "http://127.0.0.1:1/");

        let failure = RpcReply::failure(
            4,
            RpcError::new(crate::error_codes::REF_NOT_FOUND, "ref not found: e1"),
        );
        let failure_json: Value = serde_json::from_str(&failure.to_json()).unwrap();
        assert_eq!(failure_json["ok"], false);
        assert_eq!(failure_json["error"]["code"], "ref_not_found");
        assert_eq!(failure_json["error"]["message"], "ref not found: e1");
    }
}
