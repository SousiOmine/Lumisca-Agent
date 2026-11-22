//! The screenshot request as the protocol states it: which formats exist and
//! how the encoded image becomes a reply. The capture itself is the one
//! platform-specific piece ([`super::platform`]).

use lumisca_browser_rpc::RpcError;
#[cfg(not(windows))]
use serde_json::json;
use serde_json::Value;

use super::LabCore;
use crate::LockRecover;

impl LabCore {
    /// Capture the lab viewport as an image.
    ///
    /// The format is validated here so every platform refuses the same
    /// values with the same error; the capture itself is the lab's one
    /// platform-specific piece.
    pub(super) fn screenshot(&self, params: &Value) -> Result<Value, RpcError> {
        let window = self.require_window()?;
        let format = params
            .get("format")
            .and_then(Value::as_str)
            .unwrap_or("png");
        if format != "png" && format != "jpeg" {
            return Err(RpcError::invalid(format!(
                "unknown format: {format} (png / jpeg)"
            )));
        }
        let quality = params.get("quality").and_then(Value::as_u64);
        let viewport = *self.viewport.lock_recover();
        self.screenshot_impl(&window, format, quality, viewport)
    }
}

/// Wrap encoded image bytes in the protocol's image result. Windows gets
/// its base64 straight from CDP, so this is the non-Windows tail.
/// The size is reported from the agent's viewport (the capture covers it at
/// 1:1), and an oversized payload is refused rather than truncated.
#[cfg(not(windows))]
pub(super) fn image_result(
    format: &str,
    viewport: Option<(u32, u32)>,
    bytes: Vec<u8>,
) -> Result<Value, RpcError> {
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    if data.len() > lumisca_browser_rpc::limits::MAX_SCREENSHOT_BYTES {
        return Err(RpcError::too_large(format!(
            "screenshot is too large ({} bytes)",
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
