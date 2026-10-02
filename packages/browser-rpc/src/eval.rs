//! Shared eval driver utilities used by the browser-lab host to drive the
//! in-page probe through `eval_with_callback` / `ExecuteScript`.
//!
//! The same probe script runs on every platform, so nothing here is
//! platform-specific: the host evaluates the driver expression and reads
//! the completion value back.

use serde_json::Value;

use crate::methods;

/// How long one eval (observe/act) may take before the RPC answers
/// `timeout`.
pub const EVAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// Headroom added on top of a wait's own timeout: the probe's in-page
/// deadline governs, and this covers the last poll's round trip.
pub const WAIT_HEADROOM: std::time::Duration = std::time::Duration::from_secs(3);

/// How often the host re-checks a pending wait.
///
/// The wait is host-driven because not every platform's eval awaits a
/// promise (WebKitGTK's does not): the probe holds the wait state and the
/// host polls it. 100 ms keeps a wait's own deadline accurate to a tenth of
/// a second while costing one cheap eval per interval — an observe/act call
/// cannot be starved because the host holds the lab's single-eval lock for
/// the whole wait either way.
pub const WAIT_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

/// The probe entry points that begin and advance a host-driven wait.
pub const PROBE_WAIT_BEGIN: &str = "waitBegin";
pub const PROBE_WAIT_POLL: &str = "waitPoll";

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

/// RPC method → probe function name. Only the call-per-action methods map
/// one-to-one: `wait` has its own host-driven entry points
/// ([`PROBE_WAIT_BEGIN`] / [`PROBE_WAIT_POLL`]) and `screenshot` never
/// reaches the page. The wire protocol says `observe`; the probe's snapshot
/// builder is called `snapshot`.
pub fn probe_method_of(rpc_method: &str) -> &str {
    match rpc_method {
        methods::OBSERVE => "snapshot",
        other => other,
    }
}

/// The `timeoutMs` a wait request asks for, defaulting to 10s (the
/// protocol default; the Deno tools always send an explicit value).
pub fn wait_timeout_ms(params: &Value) -> u64 {
    params
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(10_000)
}

/// Whether a wait answer is the probe's "not settled yet" marker. Anything
/// else — including the probe-missing / probe-error shapes the driver
/// produces — is a settled answer the caller must act on.
pub fn wait_pending(value: &Value) -> bool {
    value
        .get("pending")
        .and_then(Value::as_bool)
        .unwrap_or(false)
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

    #[test]
    fn probe_method_of_renames_only_observe() {
        assert_eq!(probe_method_of(methods::OBSERVE), "snapshot");
        assert_eq!(probe_method_of(methods::ACT), "act");
    }

    #[test]
    fn wait_timeout_defaults_to_ten_seconds() {
        assert_eq!(wait_timeout_ms(&serde_json::json!({})), 10_000);
        assert_eq!(
            wait_timeout_ms(&serde_json::json!({ "timeoutMs": 250 })),
            250
        );
    }

    #[test]
    fn wait_pending_reads_the_probe_marker() {
        assert!(wait_pending(&serde_json::json!({ "pending": true })));
        // A settled answer (any shape) is never pending — including the
        // driver's own failure shapes, which must reach the caller.
        assert!(!wait_pending(
            &serde_json::json!({ "ok": true, "reason": "loaded" })
        ));
        assert!(!wait_pending(
            &serde_json::json!({ "ok": false, "code": "probe_missing" })
        ));
        assert!(!wait_pending(&serde_json::json!({})));
    }
}
