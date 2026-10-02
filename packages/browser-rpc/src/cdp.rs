//! CDP request/response pieces for the browser-lab host.
//!
//! Windows is the one platform whose WebView exposes the Chrome DevTools
//! Protocol (WebView2), and the lab uses it for one thing only: capturing a
//! screenshot at the agent's viewport resolution. Everything else — the
//! probe channel, the viewport, the wait — is platform-neutral (see
//! [`crate::eval`] and [`crate::viewport`]).
//!
//! Keeping the request parameters and the response unwrapping here (rather
//! than inline in the host) means the call sites cannot drift apart.
//! Everything here is pure: build a params object, or interpret a reply.

use serde_json::{json, Value};

use crate::{error_codes, limits, RpcError};

/// `Page.captureScreenshot` params for the requested format.
///
/// With a viewport the capture covers the FULL viewport at 1:1 (1 CSS px =
/// 1 image px), so the agent sees the resolution it asked for instead of
/// the scaled window view. Without one the capture is the surface as-is; an
/// unknown format is an explicit error rather than a silent png fallback.
pub fn screenshot_params(
    format: &str,
    quality: Option<u64>,
    viewport: Option<(u32, u32)>,
) -> Result<Value, RpcError> {
    if format != "png" && format != "jpeg" {
        return Err(RpcError::invalid(format!(
            "不明な format: {format} (png / jpeg)"
        )));
    }
    let mut params = json!({ "format": format, "fromSurface": true });
    if format == "jpeg" {
        params["quality"] = json!(quality.unwrap_or(80).clamp(1, 100));
    }
    if let Some((width, height)) = viewport {
        // The clip is in CSS pixels and the page lays out at exactly the
        // requested viewport (see crate::viewport), so this is the whole
        // viewport. `captureBeyondViewport` keeps the clip honoured even if
        // a window manager clamped the lab window below the requested size.
        params["captureBeyondViewport"] = json!(true);
        params["clip"] = json!({
            "x": 0,
            "y": 0,
            "width": width,
            "height": height,
            "scale": 1,
        });
    }
    Ok(params)
}

/// Interpret a `Page.captureScreenshot` reply: the base64 payload plus the
/// mime type, and the viewport's dimensions when one was requested. Fails
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screenshot_params_reject_an_unknown_format() {
        let error = screenshot_params("webp", None, None).expect_err("webp must be refused");
        assert_eq!(error.code, error_codes::INVALID);
    }

    #[test]
    fn screenshot_params_omit_the_clip_without_a_viewport() {
        let png = screenshot_params("png", None, None).expect("png is supported");
        assert_eq!(png["format"], "png");
        assert_eq!(png["fromSurface"], true);
        assert!(png.get("clip").is_none());

        let jpeg = screenshot_params("jpeg", Some(200), None).expect("jpeg is supported");
        assert_eq!(jpeg["quality"], 100); // clamped
    }

    #[test]
    fn screenshot_params_clip_the_viewport_at_one_to_one() {
        let params = screenshot_params("png", None, Some((800, 600))).expect("png is supported");
        assert_eq!(params["clip"]["width"], 800);
        assert_eq!(params["clip"]["height"], 600);
        assert_eq!(params["clip"]["scale"], 1);
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
}
