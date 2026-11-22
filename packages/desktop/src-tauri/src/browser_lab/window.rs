//! The lab window itself: creating it on demand, sizing it to the agent's
//! viewport, showing or hiding it, and destroying it.
//!
//! The window is an ordinary decorated top-level window (see the module
//! docs of [`crate::browser_lab`]); nothing here docks it to the app window
//! or asks the OS for a z-order.

use std::sync::mpsc;

use lumisca_browser_rpc::eval::EVAL_TIMEOUT;
use lumisca_browser_rpc::{viewport, RpcError};
use serde_json::{json, Value};
use tauri::{LogicalSize, Manager, WebviewWindow, WebviewWindowBuilder};

use super::LabCore;
use super::LAB_WINDOW_LABEL;
use crate::LockRecover;

impl LabCore {
    /// The usable area of the display the lab window lives on, in logical
    /// pixels. `work_area` excludes the taskbar/dock/menu bar, so a
    /// viewport that fits there becomes a window that is fully visible.
    fn work_area(&self) -> (f64, f64) {
        let monitor = self.app.primary_monitor().ok().flatten().or_else(|| {
            self.app
                .available_monitors()
                .ok()
                .and_then(|m| m.into_iter().next())
        });
        match monitor {
            Some(monitor) => {
                let scale = monitor.scale_factor();
                let area = monitor.work_area();
                (
                    f64::from(area.size.width) / scale,
                    f64::from(area.size.height) / scale,
                )
            }
            // No display information (headless session): nothing constrains
            // the window, and the zoom stays 1.
            None => (f64::INFINITY, f64::INFINITY),
        }
    }

    /// Create the lab window on demand (idempotent per call — this IS
    /// open()'s job), or navigate the existing one. Runs on the RPC
    /// thread: window creation/navigation are message-driven and
    /// thread-safe. The window starts hidden so it never flashes at a
    /// default position, and the viewport is applied before the first show.
    pub(super) fn ensure_window(
        &self,
        url: &str,
        visible: bool,
    ) -> Result<WebviewWindow, RpcError> {
        let parsed =
            url::Url::parse(url).map_err(|e| RpcError::invalid(format!("URL が不正です: {e}")))?;
        // Self-heal: if the manager no longer knows the lab (destroyed
        // outside close(), e.g. after a WebView crash), forget the stale
        // handle so the next open builds a fresh window.
        if self.app.get_webview_window(LAB_WINDOW_LABEL).is_none() {
            *self.window.lock_recover() = None;
        }
        if let Some(window) = self.window.lock_recover().clone() {
            let _ = window.navigate(parsed);
            self.apply_viewport(&window)?;
            self.apply_visibility(&window, visible)?;
            *self.visible.lock_recover() = visible;
            return Ok(window);
        }
        let builder = WebviewWindowBuilder::new(
            &self.app,
            LAB_WINDOW_LABEL,
            tauri::WebviewUrl::External(parsed.clone()),
        )
        // The title names the app being debugged: this is an ordinary
        // window now, so the OS window list and the taskbar show it.
        .title(parsed.as_str())
        // The viewport is the agent's choice, so the user cannot resize it
        // out from under a layout being tested. `open` sizes it instead.
        .resizable(false)
        .visible(false)
        .initialization_script(self.probe_source);
        let window = builder
            .build()
            .map_err(|e| RpcError::internal(format!("ブラウザウィンドウを作成できません: {e}")))?;
        self.apply_viewport(&window)?;
        self.apply_visibility(&window, visible)?;
        *self.window.lock_recover() = Some(window.clone());
        *self.visible.lock_recover() = visible;
        Ok(window)
    }

    /// Make the webview's CSS viewport the agent's requested size.
    ///
    /// The window's client area carries the viewport (Tauri's `set_size`
    /// sets the INNER size), and when the viewport is larger than the
    /// display the zoom shrinks by the same factor — `window.innerWidth`
    /// counts client-area CSS pixels, so `client_width / zoom` stays at the
    /// requested width. This is what device emulation used to do on
    /// Windows, expressed with an API every platform has.
    ///
    /// The client area is only *requested* here; [`Self::settle_client_size`]
    /// confirms it once the window server has answered.
    fn apply_viewport(&self, window: &WebviewWindow) -> Result<(), RpcError> {
        let target = match self.viewport_target() {
            Some(target) => target,
            None => return Ok(()),
        };
        window
            .set_size(LogicalSize::new(target.window_width, target.window_height))
            .map_err(|e| {
                RpcError::internal(format!("ブラウザウィンドウのサイズを変更できません: {e}"))
            })?;
        window
            .set_zoom(target.zoom)
            .map_err(|e| RpcError::internal(format!("ブラウザのズームを設定できません: {e}")))?;
        Ok(())
    }

    /// Reconcile the window with the viewport the page actually got.
    ///
    /// The window APIs cannot be trusted for this: on macOS `set_size`
    /// gives the window server a size it reinterprets, and the webview
    /// comes back one title bar shorter than the size asked for (measured:
    /// 390×844 requested → 390×816 reported by the page, 390×700 →
    /// 390×672), while `outer_size` and `inner_size` both keep reporting
    /// the size that was asked for. The page is the only authority, and
    /// `observe` already carries the viewport it measured, so the
    /// correction rides on a call the agent makes anyway: the first
    /// snapshot may still report the size from before the correction, the
    /// next reports the settled one. A window that already matches is left
    /// alone, which is the whole steady state.
    pub(super) fn reconcile_viewport(&self, window: &WebviewWindow, answer: &Value) {
        let Some(asked) = *self.viewport.lock_recover() else {
            return;
        };
        let (Some(width), Some(height)) = (
            answer
                .pointer("/viewport/width")
                .and_then(Value::as_u64)
                .map(|v| v as u32),
            answer
                .pointer("/viewport/height")
                .and_then(Value::as_u64)
                .map(|v| v as u32),
        ) else {
            return;
        };
        if (width, height) == asked {
            return;
        }
        let Some(target) = self.viewport_target() else {
            return;
        };
        // A CSS-pixel shortage converts to window pixels through the zoom
        // the page is rendered at.
        let delta_width = (f64::from(asked.0) - f64::from(width)) * target.zoom;
        let delta_height = (f64::from(asked.1) - f64::from(height)) * target.zoom;
        let _ = window.set_size(LogicalSize::new(
            target.window_width + delta_width,
            target.window_height + delta_height,
        ));
    }

    /// The window geometry the current viewport asks for.
    fn viewport_target(&self) -> Option<viewport::ViewportFit> {
        let viewport = (*self.viewport.lock_recover())?;
        let (area_w, area_h) = self.work_area();
        Some(viewport::fit_viewport(
            viewport.0, viewport.1, area_w, area_h,
        ))
    }

    /// Show or hide the window (a UI choice). The lab keeps running while
    /// hidden; the agent's observe/act calls are unaffected. Never steals
    /// keyboard focus: the agent opens the browser on its own, and taking
    /// focus from the user's input would be rude.
    fn apply_visibility(&self, window: &WebviewWindow, visible: bool) -> Result<(), RpcError> {
        if visible {
            window
                .show()
                .map_err(|e| RpcError::internal(format!("ブラウザを表示できません: {e}")))
        } else {
            window
                .hide()
                .map_err(|e| RpcError::internal(format!("ブラウザを隠せません: {e}")))
        }
    }

    pub(super) fn close(&self) -> Result<Value, RpcError> {
        if let Some(window) = self.window.lock_recover().take() {
            let (tx, rx) = mpsc::channel();
            let app = self.app.clone();
            app.run_on_main_thread(move || {
                let result = window.destroy();
                let _ = tx.send(result);
            })
            .map_err(|e| RpcError::internal(format!("main thread dispatch に失敗しました: {e}")))?;
            let _ = rx.recv_timeout(EVAL_TIMEOUT);
        }
        *self.visible.lock_recover() = false;
        Ok(json!({ "closed": true }))
    }

    pub(super) fn require_window(&self) -> Result<WebviewWindow, RpcError> {
        self.window.lock_recover().clone().ok_or_else(|| {
            RpcError::not_open("ブラウザは開いていません（先に browser_open を呼んでください）")
        })
    }
}
