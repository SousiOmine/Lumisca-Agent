//! CDP device-emulation pieces shared by the two Windows hosts. WebView2
//! exposes Chrome's DevTools Protocol, so the agent-chosen viewport is
//! applied as `Emulation.setDeviceMetricsOverride` (the same mechanism
//! DevTools device mode uses): the page LAYS OUT at the requested size
//! (media queries, `innerWidth`, … all follow it) while the rendering is
//! scaled to fit the host's window/pane. WKWebView/WebKitGTK expose no
//! emulation API, so nothing here runs on macOS/Linux — those hosts keep
//! the window size as the viewport.

/// Default viewport when `open` omits width/height. Mirrors
/// packages/core/browser/tools.ts (the Deno side always sends explicit
/// values; this is the protocol-level default for other clients).
pub const DEFAULT_VIEWPORT_WIDTH: u32 = 800;
pub const DEFAULT_VIEWPORT_HEIGHT: u32 = 600;

/// The largest scale (≤ 1) that shows a `viewport_w × viewport_h` page
/// fully inside an `area_w × area_h` surface. Never upscales: a viewport
/// smaller than the surface keeps its true size (centered) instead of
/// being blown up.
pub fn fit_scale(viewport_w: u32, viewport_h: u32, area_w: f64, area_h: f64) -> f64 {
    if viewport_w == 0 || viewport_h == 0 || area_w <= 0.0 || area_h <= 0.0 {
        return 1.0;
    }
    (area_w / f64::from(viewport_w))
        .min(area_h / f64::from(viewport_h))
        .min(1.0)
}

/// `Emulation.setDeviceMetricsOverride` params: layout viewport
/// `viewport_w × viewport_h`, rendering scaled by `scale` to fit the
/// surface. deviceScaleFactor 1 pins the DPR to 1, so the capture is
/// 1 CSS px = 1 image px on any display (0 would keep the host DPR and
/// yield a larger image than the reported width/height on scaled
/// displays); screenWidth/screenHeight mirror the viewport so
/// `screen.width` agrees with `innerWidth`. `mobile` stays false —
/// width/height change the layout, not the input modality.
pub fn device_metrics_params(viewport_w: u32, viewport_h: u32, scale: f64) -> serde_json::Value {
    serde_json::json!({
        "width": viewport_w,
        "height": viewport_h,
        "deviceScaleFactor": 1,
        "mobile": false,
        "scale": scale,
        "screenWidth": viewport_w,
        "screenHeight": viewport_h,
    })
}

/// `Page.captureScreenshot` params capturing the FULL emulated viewport
/// at 1:1 (1 CSS px = 1 image px) instead of the scaled pane view — the
/// agent sees the resolution it asked for, whatever the window shows.
pub fn capture_screenshot_params(
    viewport_w: u32,
    viewport_h: u32,
    format: &str,
    quality: Option<u64>,
) -> serde_json::Value {
    let mut params = serde_json::json!({
        "format": format,
        "fromSurface": true,
        "captureBeyondViewport": true,
        "clip": {
            "x": 0,
            "y": 0,
            "width": viewport_w,
            "height": viewport_h,
            "scale": 1,
        },
    });
    if format == "jpeg" {
        params["quality"] = serde_json::json!(quality.unwrap_or(80).min(100).max(1));
    }
    params
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_scale_fits_within_the_area() {
        // 800×600 into a 460×824 pane → width-bound.
        assert!((fit_scale(800, 600, 460.0, 824.0) - 460.0 / 800.0).abs() < 1e-9);
        // 460×824 is the exact ratio → same scale on both axes.
        assert!((fit_scale(800, 600, 400.0, 300.0) - 0.5).abs() < 1e-9);
        // A smaller viewport than the area keeps its true size (no upscale).
        assert!((fit_scale(320, 480, 460.0, 824.0) - 1.0).abs() < 1e-9);
        // Degenerate inputs never divide by zero.
        assert!((fit_scale(0, 480, 460.0, 824.0) - 1.0).abs() < 1e-9);
        assert!((fit_scale(320, 480, 0.0, 824.0) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn device_metrics_params_carry_the_viewport_and_scale() {
        let params = device_metrics_params(390, 844, 0.5);
        assert_eq!(params["width"], 390);
        assert_eq!(params["height"], 844);
        assert_eq!(params["scale"], 0.5);
        assert_eq!(params["screenWidth"], 390);
        assert_eq!(params["screenHeight"], 844);
        // 1 pins the DPR to 1: 1 CSS px = 1 image px whatever the display
        // scale is (0 would keep the host DPR and break the 1:1 contract).
        assert_eq!(params["deviceScaleFactor"], 1);
    }

    #[test]
    fn capture_params_clip_the_full_viewport() {
        let params = capture_screenshot_params(800, 600, "png", None);
        assert_eq!(params["captureBeyondViewport"], true);
        assert_eq!(params["clip"]["width"], 800);
        assert_eq!(params["clip"]["height"], 600);
        assert_eq!(params["clip"]["scale"], 1);
        assert!(params.get("quality").is_none());
        let jpeg = capture_screenshot_params(800, 600, "jpeg", Some(200));
        assert_eq!(jpeg["quality"], 100); // clamped
    }
}
