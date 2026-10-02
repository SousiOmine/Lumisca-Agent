//! Viewport geometry for the browser-lab host.
//!
//! The lab reproduces the agent-chosen viewport **without** a device
//! emulation API. The lab window's client area *is* the viewport, and when
//! the requested viewport does not fit the display the webview is zoomed
//! out: `window.innerWidth` counts client-area CSS pixels, so shrinking the
//! zoom widens the CSS viewport in inverse proportion. Setting
//!
//! ```text
//!   zoom = client_width / viewport_width
//! ```
//!
//! therefore makes the page LAY OUT at exactly `viewport_width` CSS px
//! (media queries, `innerWidth`, …) while the rendering is scaled to fit
//! the window — the same observable contract `Emulation.
//! setDeviceMetricsOverride {width, scale}` used to provide on Windows.
//!
//! Why not emulation: WKWebView and WebKitGTK expose no emulation API at
//! all, so the previous Windows-only CDP path left macOS and Linux with
//! "the window size is the viewport". Zoom is a public API on all three
//! platforms (`WebView2::SetZoomFactor`, `WKWebView.pageZoom`,
//! `webkit_web_view_set_zoom_level`), which is what makes one
//! implementation work everywhere.

/// Default viewport when `open` omits width/height. Mirrors
/// packages/core/browser/tools.ts (the Deno side always sends explicit
/// values; this is the protocol-level default for other clients).
pub const DEFAULT_VIEWPORT_WIDTH: u32 = 800;
pub const DEFAULT_VIEWPORT_HEIGHT: u32 = 600;

/// The largest scale (≤ 1) that shows a `viewport_w × viewport_h` page
/// fully inside an `area_w × area_h` surface. Never upscales: a viewport
/// smaller than the surface keeps its true size instead of being blown up.
pub fn fit_scale(viewport_w: u32, viewport_h: u32, area_w: f64, area_h: f64) -> f64 {
    if viewport_w == 0 || viewport_h == 0 || area_w <= 0.0 || area_h <= 0.0 {
        return 1.0;
    }
    (area_w / f64::from(viewport_w))
        .min(area_h / f64::from(viewport_h))
        .min(1.0)
}

/// The window geometry and zoom that give the webview the requested CSS
/// viewport.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ViewportFit {
    /// Window client-area width in logical pixels (`set_size` takes
    /// logical units, the same units CSS pixels use at zoom 1).
    pub window_width: f64,
    /// Window client-area height in logical pixels.
    pub window_height: f64,
    /// Webview zoom level (1.0 = 100 %). `window_width / zoom` is the CSS
    /// viewport width the page sees.
    pub zoom: f64,
}

/// Fit `viewport_w × viewport_h` into an `area_w × area_h` display.
///
/// The page always lays out at the requested size: when it fits, the
/// window is exactly the viewport at zoom 1; when it does not, the window
/// fills the available area and the zoom shrinks by the same factor, so the
/// CSS viewport stays at the requested size.
///
/// `area_w`/`area_h` may be `f64::INFINITY` when the display is unknown —
/// then nothing constrains the window and the zoom stays 1.
pub fn fit_viewport(viewport_w: u32, viewport_h: u32, area_w: f64, area_h: f64) -> ViewportFit {
    let zoom = fit_scale(viewport_w, viewport_h, area_w, area_h);
    // Round to whole logical pixels: window sizes are integral on every
    // platform, and a fractional size would be truncated by the OS anyway.
    // The rounding moves the CSS viewport by well under one CSS pixel (the
    // host reports the measured viewport back to the agent, so any residue
    // is visible rather than silent).
    ViewportFit {
        window_width: (f64::from(viewport_w) * zoom).round().max(1.0),
        window_height: (f64::from(viewport_h) * zoom).round().max(1.0),
        zoom,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_scale_fits_within_the_area() {
        // 800×600 into a 460×824 area → width-bound.
        assert!((fit_scale(800, 600, 460.0, 824.0) - 460.0 / 800.0).abs() < 1e-9);
        // 800×600 into 400×300 is the exact ratio → same scale on both axes.
        assert!((fit_scale(800, 600, 400.0, 300.0) - 0.5).abs() < 1e-9);
        // A smaller viewport than the area keeps its true size (no upscale).
        assert!((fit_scale(320, 480, 460.0, 824.0) - 1.0).abs() < 1e-9);
        // Degenerate inputs never divide by zero.
        assert!((fit_scale(0, 480, 460.0, 824.0) - 1.0).abs() < 1e-9);
        assert!((fit_scale(320, 480, 0.0, 824.0) - 1.0).abs() < 1e-9);
        // An unknown display constrains nothing.
        assert!((fit_scale(1440, 900, f64::INFINITY, f64::INFINITY) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn a_viewport_that_fits_becomes_the_window_at_zoom_one() {
        let fit = fit_viewport(800, 600, 1920.0, 1080.0);
        assert_eq!(fit.window_width, 800.0);
        assert_eq!(fit.window_height, 600.0);
        assert_eq!(fit.zoom, 1.0);
        // The phone layout of the tool description is an ordinary window.
        let phone = fit_viewport(390, 844, 1920.0, 1080.0);
        assert_eq!(phone.window_width, 390.0);
        assert_eq!(phone.window_height, 844.0);
        assert_eq!(phone.zoom, 1.0);
    }

    #[test]
    fn an_oversized_viewport_is_kept_by_zooming_out() {
        // 1440×900 on a 1280×800 display: the window takes the display and
        // the zoom shrinks by the same factor, so innerWidth stays 1440.
        let fit = fit_viewport(1440, 900, 1280.0, 800.0);
        assert_eq!(fit.zoom, 800.0 / 900.0);
        assert!(fit.window_width <= 1280.0);
        assert_eq!(fit.window_height, 800.0);
        // The contract: the CSS viewport is the requested size.
        assert!((fit.window_width / fit.zoom - 1440.0).abs() < 1.0);
        assert!((fit.window_height / fit.zoom - 900.0).abs() < 1.0);
    }

    #[test]
    fn the_window_never_exceeds_the_available_area() {
        for (vw, vh) in [(1440, 900), (3000, 2000), (390, 844), (800, 600)] {
            let fit = fit_viewport(vw, vh, 1280.0, 800.0);
            assert!(fit.window_width <= 1280.0, "{vw}x{vh} → {fit:?}");
            assert!(fit.window_height <= 800.0, "{vw}x{vh} → {fit:?}");
            assert!(fit.zoom > 0.0 && fit.zoom <= 1.0, "{vw}x{vh} → {fit:?}");
        }
    }

    #[test]
    fn a_degenerate_viewport_still_yields_a_usable_window() {
        let fit = fit_viewport(0, 0, 1280.0, 800.0);
        assert!(fit.window_width >= 1.0);
        assert!(fit.window_height >= 1.0);
    }
}
