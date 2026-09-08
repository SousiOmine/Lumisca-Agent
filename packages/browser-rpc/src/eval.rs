//! Shared eval driver utilities used by both browser-lab hosts
//! (browser-host and desktop) to drive the in-page probe through
//! `eval_with_callback` / `ExecuteScript`.

use serde_json::Value;

use crate::methods;

/// How long one eval (observe/act/screenshot) may take before the RPC
/// answers `timeout`.
pub const EVAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// Headroom added on top of a wait's own timeout (its in-page deadline
/// governs).
pub const WAIT_HEADROOM: std::time::Duration = std::time::Duration::from_secs(3);

/// The eval driver: a catch-all IIFE so a missing probe or a probe
/// exception reads as a well-formed result, never as an eval failure.
pub fn driver(probe_call: &str) -> String {
    format!(
        concat!(
            "(function () {{ var p = window.__lumiscaProbe; ",
            "if (!p) {{ return {{ ok: false, code: \"probe_missing\", ",
            "error: \"probe is not installed on this page\" }}; }} ",
            "try {{ {probe_call} }} ",
            "catch (e) {{ return {{ ok: false, code: \"probe_error\", ",
            "error: String((e && (e.message || e)) || e) }}; }} }})()",
        ),
        probe_call = probe_call,
    )
}

/// JSON → JS literal for embedding into the driver (serde's JSON is valid
/// JS for our value shapes; line separators must be escaped for the JS
/// string literal).
pub fn to_js_literal(value: &Value) -> String {
    serde_json::to_string(value)
        .unwrap_or_else(|_| "null".to_string())
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

/// RPC method → probe function name. The wire protocol says `observe`;
/// the probe's snapshot builder is called `snapshot`.
pub fn probe_method_of(rpc_method: &str) -> &str {
    match rpc_method {
        methods::OBSERVE => "snapshot",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn driver_is_syntactically_valid_and_self_contained() {
        let script = driver("return p.snapshot({});");
        assert!(script.contains("__lumiscaProbe"));
        assert!(script.contains("probe_missing"));
        assert!(script.contains("probe_error"));
        assert!(!script.contains("`"));
        assert!(!script.contains("${"));
    }

    #[test]
    fn to_js_literal_escapes_js_line_separators() {
        let value = serde_json::json!({ "value": "a\u{2028}b\u{2029}c" });
        let literal = to_js_literal(&value);
        assert!(literal.contains("\\u2028"));
        assert!(literal.contains("\\u2029"));
    }
}
