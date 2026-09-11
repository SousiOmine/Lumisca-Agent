//! CDP request/response pieces for the browser-lab host.
//!
//! The desktop lab drives WebView2's DevTools Protocol synchronously from a
//! blocking RPC thread (`with_webview` + channel). Keeping the request
//! parameters, the response unwrapping and the error shapes here (rather
//! than inline in the host) means the pane's own call sites cannot drift
//! apart from each other.
//!
//! Everything here is pure: build a params object, or interpret a reply.

use serde_json::{json, Value};

use crate::{emulation, error_codes, limits, RpcError};

/// `Page.captureScreenshot` params for the requested format.
///
/// With an emulated viewport the capture covers the FULL viewport at 1:1
/// (see [`emulation::capture_screenshot_params`]), so the agent sees the
/// resolution it asked for instead of the scaled window/pane view.
/// Without one the capture is the surface as-is; an unknown format is an
/// explicit error rather than a silent png fallback.
pub fn screenshot_params(
    format: &str,
    quality: Option<u64>,
    viewport: Option<(u32, u32)>,
) -> Result<Value, RpcError> {
    match viewport {
        Some((width, height)) => Ok(emulation::capture_screenshot_params(
            width, height, format, quality,
        )),
        None => match format {
            "png" => Ok(json!({ "format": "png", "fromSurface": true })),
            "jpeg" => Ok(json!({
                "format": "jpeg",
                "quality": quality.unwrap_or(80).clamp(1, 100),
                "fromSurface": true,
            })),
            other => Err(RpcError::invalid(format!(
                "不明な format: {other} (png / jpeg)"
            ))),
        },
    }
}

/// Interpret a `Page.captureScreenshot` reply: the base64 payload plus the
/// mime type, and the emulated viewport's dimensions when one is set. Fails
/// when the host produced no image or the payload exceeds the protocol's
/// screenshot cap (see [`limits::MAX_SCREENSHOT_BYTES`]).
pub fn screenshot_result(
    format: &str,
    viewport: Option<(u32, u32)>,
    answer: &Value,
) -> Result<Value, RpcError> {
    let data = answer
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::new(error_codes::ACTION_FAILED, "CDP は画像を返しませんでした"))?;
    if data.len() > limits::MAX_SCREENSHOT_BYTES {
        return Err(RpcError::too_large(format!(
            "スクリーンショットが大きすぎます ({} bytes)",
            data.len()
        )));
    }
    let mut result = json!({
        "mimeType": if format == "png" { "image/png" } else { "image/jpeg" },
        "data": data,
    });
    if let Some((width, height)) = viewport {
        result["width"] = json!(width);
        result["height"] = json!(height);
    }
    Ok(result)
}

/// `Runtime.evaluate` params that await a promise and return its value by
/// value: the vehicle `wait` needs because WebView2's ExecuteScript never
/// awaits promises.
pub fn evaluate_params(expression: &str) -> Value {
    json!({
        "expression": expression,
        "awaitPromise": true,
        "returnByValue": true,
    })
}

/// Interpret a `Runtime.evaluate` reply: unwrap an in-page exception, then
/// the DevTools value. WebView2 returns the reply without the envelope, so
/// the payload lives at `/result/value`.
pub fn evaluate_value(answer: &Value) -> Result<Value, RpcError> {
    if let Some(details) = answer.pointer("/result/exceptionDetails") {
        let text = details
            .pointer("/exception/text")
            .and_then(Value::as_str)
            .unwrap_or("unknown exception");
        return Err(RpcError::new(
            error_codes::PROBE_ERROR,
            format!("プローブ例外: {text}"),
        ));
    }
    answer
        .pointer("/result/value")
        .cloned()
        .ok_or_else(|| RpcError::new(error_codes::PROBE_ERROR, "CDP の応答形式が不正です"))
}

/// The `timeoutMs` a wait request asks for, defaulting to 10s (the
/// protocol default; the Deno tools always send an explicit value).
pub fn wait_timeout_ms(params: &Value) -> u64 {
    params
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(10_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screenshot_params_reject_an_unknown_format() {
        let error = screenshot_params("webp", None, None).expect_err("webp must be refused");
        assert_eq!(error.code, error_codes::INVALID);
    }

    #[test]
    fn screenshot_params_fall_back_without_a_viewport() {
        let png = screenshot_params("png", None, None).expect("png is supported");
        assert_eq!(png["format"], "png");
        assert_eq!(png["fromSurface"], true);
        assert!(png.get("clip").is_none());

        let jpeg = screenshot_params("jpeg", Some(200), None).expect("jpeg is supported");
        assert_eq!(jpeg["quality"], 100); // clamped
    }

    #[test]
    fn screenshot_params_clip_the_emulated_viewport() {
        let params = screenshot_params("png", None, Some((800, 600))).expect("png is supported");
        assert_eq!(params["clip"]["width"], 800);
        assert_eq!(params["captureBeyondViewport"], true);
    }

    #[test]
    fn screenshot_result_rejects_a_missing_payload() {
        let error = screenshot_result("png", None, &json!({})).expect_err("no data");
        assert_eq!(error.code, error_codes::ACTION_FAILED);
    }

    #[test]
    fn screenshot_result_carries_the_mime_and_viewport() {
        let value = screenshot_result("jpeg", Some((390, 844)), &json!({ "data": "AAAA" }))
            .expect("payload present");
        assert_eq!(value["mimeType"], "image/jpeg");
        assert_eq!(value["width"], 390);
        assert_eq!(value["height"], 844);
    }

    #[test]
    fn evaluate_value_unwraps_the_devtools_reply() {
        let value =
            evaluate_value(&json!({ "result": { "type": "object", "value": { "ok": true } } }))
                .expect("well-formed reply");
        assert_eq!(value["ok"], true);
    }

    #[test]
    fn evaluate_value_reports_an_in_page_exception() {
        let error = evaluate_value(&json!({
            "result": { "exceptionDetails": { "exception": { "text": "boom" } } }
        }))
        .expect_err("exception must surface");
        assert_eq!(error.code, error_codes::PROBE_ERROR);
        assert!(error.message.contains("boom"));
    }

    #[test]
    fn evaluate_value_rejects_a_malformed_reply() {
        let error =
            evaluate_value(&json!({ "result": { "type": "object" } })).expect_err("no value");
        assert_eq!(error.code, error_codes::PROBE_ERROR);
    }

    #[test]
    fn evaluate_params_await_the_promise() {
        let params = evaluate_params("return 1;");
        assert_eq!(params["awaitPromise"], true);
        assert_eq!(params["returnByValue"], true);
        assert_eq!(params["expression"], "return 1;");
    }

    #[test]
    fn wait_timeout_defaults_to_ten_seconds() {
        assert_eq!(wait_timeout_ms(&json!({})), 10_000);
        assert_eq!(wait_timeout_ms(&json!({ "timeoutMs": 250 })), 250);
    }
}
