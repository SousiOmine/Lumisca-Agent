//! Browser lab: the Desktop's debug WebView, exposed to the agent running
//! in the local (Deno) server as an authenticated loopback RPC endpoint.
//!
//! Lifecycle:
//! - setup() of lib.rs starts the lab **once per app run**: binds
//!   127.0.0.1:0, generates the per-run random token, and hands both to
//!   the local server through `LUMISCA_BROWSER_IPC_URL` /
//!   `LUMISCA_BROWSER_TOKEN` (server.rs). No window exists yet.
//! - the `open` RPC creates the single `browser-lab` window on demand: an
//!   ordinary, decorated top-level window titled with the page URL. It is
//!   deliberately NOT docked to the app window — docking meant a
//!   borderless window overlaid on the main window's right edge, which
//!   needed per-platform z-order and virtual-desktop handling
//!   (SetWindowPos, IVirtualDesktopManager) that macOS and Linux cannot
//!   provide at all. A window of its own needs none of that, and the OS
//!   supplies the title bar, focus and placement for free.
//! - the agent-chosen viewport is reproduced BY the window: its client
//!   area is sized to the viewport and, when the viewport does not fit the
//!   display, the webview is zoomed out so the page still lays out at the
//!   requested CSS size (see `lumisca_browser_rpc::viewport`). No device
//!   emulation API is involved, so one implementation covers WebView2,
//!   WKWebView and WebKitGTK.
//! - observe/act drive the page through `eval_with_callback` — the probe
//!   runs in the page, results come back through the eval callback. They
//!   work whether or not the window is currently shown: hiding it is a UI
//!   choice, not a protocol state.
//! - wait is host-driven: the probe holds the wait state and the host
//!   polls it (`waitBegin` / `waitPoll`), because WebView2 executes
//!   scripts without awaiting and WebKitGTK never resolves promises.
//! - screenshot is the lab's only platform-specific capability, and each
//!   platform uses its own public API: WebView2 over the DevTools Protocol
//!   (Windows), `WKWebView.takeSnapshot` (macOS) and WebKitGTK's
//!   `webkit_web_view_get_snapshot` (Linux).
//! - `close` destroys the window (idempotent); a window the user closed
//!   makes every later call fail with `not_open` — no recreation behind
//!   the caller's back.
//! - the main window's destruction and the updater's exit hook shut the
//!   lab down (destroy window + stop the RPC listener), so no orphaned
//!   WebView or listener outlives the app.
//!
//! Security: the lab window is a separate window (no capability file
//! covers its label), and its page is always a REMOTE origin — the "main"
//! capability resolves only for LOCAL origins, so every Tauri IPC call
//! from the lab page is denied by the ACL. The lumisca:// shell bridge is
//! additionally unreachable from the lab page (it requires the displayed
//! server's token, which the page never has), and `lumisca:` navigations
//! are blocked outright (BLOCKED_SCHEMES).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(windows)]
use lumisca_browser_rpc::cdp;
use lumisca_browser_rpc::eval::{
    driver, probe_method_of, to_js_literal, wait_pending, wait_timeout_ms, EVAL_TIMEOUT,
    PROBE_WAIT_BEGIN, PROBE_WAIT_POLL, WAIT_HEADROOM, WAIT_POLL_INTERVAL,
};
use lumisca_browser_rpc::server::RpcHandler;
use lumisca_browser_rpc::viewport;
use lumisca_browser_rpc::{error_codes, methods, policy, probe, RpcError};
use serde_json::{json, Value};
use tauri::{AppHandle, LogicalSize, Manager, WebviewWindow, WebviewWindowBuilder};

use crate::{AppState, LockRecover};

/// Label of the lab window. Deliberately NOT covered by any capability
/// file, so the lab page can never call Tauri IPC (see the module docs).
pub const LAB_WINDOW_LABEL: &str = "browser-lab";

/// The lumisca:// shell bridge must never be reachable from the lab.
const BLOCKED_SCHEMES: [&str; 1] = ["lumisca:"];

/// How long the page gets to answer a CDP method call (Windows only: the
/// CDP transport is WebView2's).
#[cfg(windows)]
const CDP_TIMEOUT: Duration = Duration::from_secs(8);

/// Shared lab state: the live window (None while closed) and the eval
/// correlation map. Created once per app run, owned by AppState.
struct LabCore {
    app: AppHandle,
    /// The single lab window, created on demand by `open`. None while the
    /// lab is closed (user or RPC) — `open` recreates it, everything else
    /// answers `not_open`.
    window: Mutex<Option<WebviewWindow>>,
    /// Whether the lab window is currently shown. UI-only state: hiding the
    /// window keeps the lab alive (the agent keeps operating the browser in
    /// the background); RPC close() resets it.
    visible: Mutex<bool>,
    /// The agent-chosen viewport in CSS pixels, set by every open() (the
    /// Deno tools always send explicit values; the protocol default is
    /// 800×600). The window is sized (and zoomed) to reproduce it, and the
    /// screenshot clips to it.
    viewport: Mutex<Option<(u32, u32)>>,
    /// One eval at a time (the protocol is strict request/response per
    /// host; a second call while one is in flight is refused, never
    /// queued — a stuck page must not pile requests).
    busy: Mutex<()>,
    /// Eval correlation: req id → result sender. The eval callback (any
    /// thread) sends here; the RPC thread waits with a deadline.
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<String>>>>,
    next_req: AtomicU64,
    /// Cached probe source (extracted once at construction).
    probe_source: &'static str,
}

/// The running lab: RPC listener + core state. Stored in AppState;
/// created during setup, stopped when the app exits.
pub struct BrowserLab {
    token: String,
    rpc: Option<lumisca_browser_rpc::RpcServer>,
    core: Arc<LabCore>,
}

impl BrowserLab {
    /// Bind the loopback RPC endpoint and generate the per-run token.
    /// Fails loudly (the desktop shell logs it and the server simply gets
    /// no browser environment — the agent then has no browser tools,
    /// which is the "no browser surface" state, never a proxy).
    pub fn start(app: &AppHandle) -> Result<BrowserLab, String> {
        let token = crate::server::generate_token();
        let core = Arc::new(LabCore {
            app: app.clone(),
            window: Mutex::new(None),
            visible: Mutex::new(false),
            viewport: Mutex::new(None),
            busy: Mutex::new(()),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_req: AtomicU64::new(1),
            probe_source: probe::extract().map_err(|e| format!("ブラウザ: {e}"))?,
        });
        let handler = Arc::new(LabHandler { core: core.clone() });
        let rpc = lumisca_browser_rpc::RpcServer::start(
            0,
            token.clone(),
            handler,
            Duration::from_secs(30),
        )?;
        Ok(BrowserLab {
            token,
            rpc: Some(rpc),
            core,
        })
    }

    /// The caller (server.rs) embeds these into the Deno child's
    /// environment: the endpoint URL and the token.
    pub fn endpoint(&self) -> (String, String) {
        let port = self.rpc.as_ref().map(|r| r.port).unwrap_or(0);
        (format!("http://127.0.0.1:{port}"), self.token.clone())
    }

    /// Destroy the lab window (if any) and stop the RPC listener.
    /// Idempotent; called on app exit.
    pub fn shutdown(&mut self) {
        if let Some(mut rpc) = self.rpc.take() {
            rpc.stop();
        }
        let window = self.core.window.lock_recover().take();
        if let Some(window) = window {
            let _ = window.destroy();
        }
        *self.core.visible.lock_recover() = false;
    }
}

/// The RPC dispatcher: runs on the listener's connection threads and
/// drives the WebView through the eval channel.
struct LabHandler {
    core: Arc<LabCore>,
}

impl RpcHandler for LabHandler {
    fn handle(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        match method {
            methods::OPEN => self.open(&params),
            methods::OBSERVE | methods::ACT => self.core.eval_probe(method, &params, EVAL_TIMEOUT),
            methods::WAIT => self.core.wait(&params),
            methods::SCREENSHOT => self.core.screenshot(&params),
            methods::CLOSE => self.close(),
            _ => Err(RpcError::invalid(format!("unknown method: {method}"))),
        }
    }
}

impl LabHandler {
    /// Create or navigate the lab window and report where it landed.
    fn open(&self, params: &Value) -> Result<Value, RpcError> {
        let url = params
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::invalid("open には url が必要です"))?;
        // Host-side policy enforcement (the Deno tools validate first).
        policy::check(url).map_err(RpcError::invalid)?;

        let visible = params
            .get("visible")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let width = params
            .get("width")
            .and_then(Value::as_u64)
            .unwrap_or(u64::from(viewport::DEFAULT_VIEWPORT_WIDTH)) as u32;
        let height = params
            .get("height")
            .and_then(Value::as_u64)
            .unwrap_or(u64::from(viewport::DEFAULT_VIEWPORT_HEIGHT)) as u32;
        // The viewport drives the window geometry, so it is recorded before
        // the window is created or resized.
        *self.core.viewport.lock_recover() = Some((width, height));

        let window = self.core.ensure_window(url, visible)?;
        // Only the URL is reported: the navigation has just been requested,
        // so the document title and ready state do not exist yet. Both
        // arrive with the first observe (the probe's snapshot carries
        // them), which is also where the agent reads page state anyway.
        Ok(json!({
            "url": window
                .url()
                .map(|u| u.to_string())
                .unwrap_or_else(|_| url.to_string()),
        }))
    }

    fn close(&self) -> Result<Value, RpcError> {
        self.core.close()
    }
}

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
    fn ensure_window(&self, url: &str, visible: bool) -> Result<WebviewWindow, RpcError> {
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
        .initialization_script(self.probe_source)
        // The lab page must never open the lumisca:// shell bridge: block
        // those navigations outright.
        .on_navigation(|candidate| {
            !BLOCKED_SCHEMES
                .iter()
                .any(|scheme| candidate.as_str().starts_with(scheme))
        });
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
    fn reconcile_viewport(&self, window: &WebviewWindow, answer: &Value) {
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

    /// One probe call under the lab's single-eval lock. A busy lab is an
    /// error, never a queue — a stuck page must not accumulate requests.
    fn eval_probe(
        &self,
        rpc_method: &str,
        params: &Value,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        let window = self.require_window()?;
        let _busy = self.busy.try_lock().map_err(|_| busy_error())?;
        let answer = self.probe_call(&window, probe_method_of(rpc_method), params, timeout)?;
        // A snapshot carries the viewport the page measured, so the window
        // is reconciled with it while the answer is already in hand — no
        // extra round trip, and no window API to trust (see
        // `reconcile_viewport`).
        self.reconcile_viewport(&window, &answer);
        Ok(answer)
    }

    /// One probe call. The caller owns the lab's single-eval lock.
    fn probe_call(
        &self,
        window: &WebviewWindow,
        probe_method: &str,
        params: &Value,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        let probe_call = format!(
            "return p.{probe_method}({args});",
            args = to_js_literal(params)
        );
        let script = driver(&probe_call);
        let req_id = self.next_req.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.pending.lock_recover().insert(req_id, tx);

        let pending = self.pending.clone();
        if let Err(e) = window.eval_with_callback(script, move |result| {
            let _ = pending
                .lock_recover()
                .remove(&req_id)
                .map(|tx| tx.send(result));
        }) {
            self.pending.lock_recover().remove(&req_id);
            return Err(RpcError::probe_missing(format!(
                "ブラウザウィンドウが利用できません: {e}"
            )));
        }

        let result = rx.recv_timeout(timeout).map_err(|_| {
            self.pending.lock_recover().remove(&req_id);
            RpcError::timeout(format!("ページが応答しませんでした（{timeout:?}）"))
        })?;
        self.parse_eval_result(&result)
    }

    /// The eval callback returns the JSON text of the completion value;
    /// an exception (only possible for a driver bug — the driver catches
    /// everything) comes back as plain text. Parse, or fail explicitly.
    fn parse_eval_result(&self, result: &str) -> Result<Value, RpcError> {
        match serde_json::from_str::<Value>(result) {
            Ok(value) => Ok(value),
            Err(_) => {
                let snippet: String = result.chars().take(200).collect();
                Err(RpcError::new(
                    error_codes::PROBE_ERROR,
                    format!("プローブの応答を解析できません: {snippet}"),
                ))
            }
        }
    }

    /// The wait, driven from here rather than awaited in the page.
    ///
    /// A single eval that awaits the promise would be shorter, but WebView2
    /// executes scripts without awaiting and WebKitGTK never resolves
    /// promises at all — only CDP could await, which would put the wait
    /// back behind a Windows-only code path. The probe's `waitCheck` is a
    /// pure "is the condition met yet?" function, so the host polls it and
    /// the conditions, the deadline and the result shape stay in one place.
    fn wait(&self, params: &Value) -> Result<Value, RpcError> {
        let window = self.require_window()?;
        // The lock is held for the whole wait: an observe/act arriving
        // mid-wait is refused rather than racing the probe's wait state.
        let _busy = self.busy.try_lock().map_err(|_| busy_error())?;
        let timeout_ms = wait_timeout_ms(params);
        let deadline = Instant::now() + Duration::from_millis(timeout_ms) + WAIT_HEADROOM;
        let mut answer = self.probe_call(&window, PROBE_WAIT_BEGIN, params, EVAL_TIMEOUT)?;
        while wait_pending(&answer) {
            if Instant::now() >= deadline {
                // The page never reached a verdict — a blocked main thread,
                // or a navigation that dropped the probe's wait state.
                return Err(RpcError::timeout(format!(
                    "wait がページ内で完了しませんでした（{timeout_ms} ms）"
                )));
            }
            std::thread::sleep(WAIT_POLL_INTERVAL);
            answer = self.probe_call(&window, PROBE_WAIT_POLL, &json!({}), EVAL_TIMEOUT)?;
        }
        Ok(answer)
    }

    /// Capture the lab viewport as an image.
    ///
    /// The format is validated here so every platform refuses the same
    /// values with the same error; the capture itself is the lab's one
    /// platform-specific piece.
    fn screenshot(&self, params: &Value) -> Result<Value, RpcError> {
        let window = self.require_window()?;
        let format = params
            .get("format")
            .and_then(Value::as_str)
            .unwrap_or("png");
        if format != "png" && format != "jpeg" {
            return Err(RpcError::invalid(format!(
                "不明な format: {format} (png / jpeg)"
            )));
        }
        let quality = params.get("quality").and_then(Value::as_u64);
        let viewport = *self.viewport.lock_recover();
        self.screenshot_impl(&window, format, quality, viewport)
    }

    /// Windows: WebView2 speaks the DevTools Protocol, and the capture is
    /// taken straight on the controller — no remote debugging port is ever
    /// opened. The clip covers the FULL agent viewport at 1:1 (1 CSS px = 1
    /// image px), so the agent sees the resolution it asked for instead of
    /// the scaled window view.
    #[cfg(windows)]
    fn screenshot_impl(
        &self,
        window: &WebviewWindow,
        format: &str,
        quality: Option<u64>,
        viewport: Option<(u32, u32)>,
    ) -> Result<Value, RpcError> {
        let cdp_params = cdp::screenshot_params(format, quality, viewport)?;
        let answer =
            self.cdp_call_sync(window, "Page.captureScreenshot", &cdp_params, CDP_TIMEOUT)?;
        cdp::screenshot_result(format, viewport, &answer)
    }

    /// macOS: `WKWebView.takeSnapshot`, the platform's public snapshot API.
    /// `with_webview` runs the closure on the main thread (where the view
    /// must be touched); the completion handler also fires there, and this
    /// RPC thread waits on a channel with a deadline.
    ///
    /// JPEG uses the platform's default compression. Choosing a quality
    /// means handing Cocoa a properties dictionary, and building one for a
    /// single optional value is not worth the extra unsafe surface.
    #[cfg(target_os = "macos")]
    fn screenshot_impl(
        &self,
        window: &WebviewWindow,
        format: &str,
        _quality: Option<u64>,
        viewport: Option<(u32, u32)>,
    ) -> Result<Value, RpcError> {
        use block2::RcBlock;
        use objc2::rc::Retained;
        use objc2::runtime::AnyObject;
        use objc2_app_kit::{
            NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSImage,
        };
        use objc2_foundation::{NSDictionary, NSError};
        use objc2_web_kit::WKWebView;

        let jpeg = format == "jpeg";
        let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
        window
            .with_webview(move |platform| {
                // Main thread: the WKWebView this window renders with.
                let view: &WKWebView = unsafe { &*platform.inner().cast() };
                let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                    let outcome = (|| -> Result<Vec<u8>, String> {
                        if !error.is_null() {
                            return Err("スナップショットに失敗しました".to_string());
                        }
                        let image = unsafe { image.as_ref() }
                            .ok_or_else(|| "画像が返りませんでした".to_string())?;
                        let tiff = image
                            .TIFFRepresentation()
                            .ok_or_else(|| "TIFF 表現を取得できません".to_string())?;
                        let rep = NSBitmapImageRep::imageRepWithData(&tiff)
                            .ok_or_else(|| "ビットマップ表現を作成できません".to_string())?;
                        let kind = if jpeg {
                            NSBitmapImageFileType::JPEG
                        } else {
                            NSBitmapImageFileType::PNG
                        };
                        let properties: Retained<
                            NSDictionary<NSBitmapImageRepPropertyKey, AnyObject>,
                        > = NSDictionary::new();
                        let data =
                            unsafe { rep.representationUsingType_properties(kind, &properties) }
                                .ok_or_else(|| "画像を符号化できません".to_string())?;
                        Ok(data.to_vec())
                    })();
                    let _ = tx.send(outcome);
                });
                unsafe {
                    view.takeSnapshotWithConfiguration_completionHandler(None, &handler);
                }
            })
            .map_err(|e| RpcError::internal(format!("with_webview に失敗しました: {e}")))?;

        let bytes = rx
            .recv_timeout(EVAL_TIMEOUT)
            .map_err(|_| {
                RpcError::timeout(format!(
                    "スナップショットが応答しませんでした（{EVAL_TIMEOUT:?}）"
                ))
            })?
            .map_err(|e| RpcError::new(error_codes::ACTION_FAILED, e))?;
        image_result(format, viewport, bytes)
    }

    /// Linux: WebKitGTK's `webkit_web_view_get_snapshot`, reached through
    /// the `webkit2gtk` bindings Tauri itself builds against. The snapshot
    /// arrives as a cairo surface, which writes PNG directly; the GTK stack
    /// carries no JPEG encoder, so that one combination is refused
    /// explicitly instead of silently served as PNG.
    #[cfg(not(any(windows, target_os = "macos")))]
    fn screenshot_impl(
        &self,
        window: &WebviewWindow,
        format: &str,
        _quality: Option<u64>,
        viewport: Option<(u32, u32)>,
    ) -> Result<Value, RpcError> {
        use webkit2gtk::{gio, SnapshotOptions, SnapshotRegion, WebViewExt};

        if format != "png" {
            return Err(RpcError::invalid(
                "この environment のスクリーンショットは png のみ対応です（jpeg は Windows/macOS のみ）"
                    .to_string(),
            ));
        }
        let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
        window
            .with_webview(move |platform| {
                // Main thread: the WebKitGTK view this window renders with.
                // The surface's own type is left to inference so no cairo or
                // glib dependency is needed here.
                let view = platform.inner();
                view.snapshot(
                    SnapshotRegion::Visible,
                    SnapshotOptions::empty(),
                    None::<&gio::Cancellable>,
                    move |result| {
                        let outcome = (|| -> Result<Vec<u8>, String> {
                            let surface = result
                                .map_err(|e| format!("スナップショットに失敗しました: {e}"))?;
                            let mut png = Vec::new();
                            surface
                                .write_to_png(&mut png)
                                .map_err(|e| format!("画像を符号化できません: {e}"))?;
                            Ok(png)
                        })();
                        let _ = tx.send(outcome);
                    },
                );
            })
            .map_err(|e| RpcError::internal(format!("with_webview に失敗しました: {e}")))?;

        let bytes = rx
            .recv_timeout(EVAL_TIMEOUT)
            .map_err(|_| {
                RpcError::timeout(format!(
                    "スナップショットが応答しませんでした（{EVAL_TIMEOUT:?}）"
                ))
            })?
            .map_err(|e| RpcError::new(error_codes::ACTION_FAILED, e))?;
        image_result(format, viewport, bytes)
    }

    /// One CDP method call with a bounded wait. WebView2's controller and
    /// core are STA objects: every method must run on the thread that
    /// created them (the app's main thread) — calling them from this RPC
    /// thread fails with 0x802A000C. The whole call therefore happens
    /// inside the `with_webview` closure, which executes on the main
    /// thread; only the reply crosses back over the channel. The RPC
    /// thread blocks with a deadline while the main thread keeps pumping
    /// the completion handler.
    #[cfg(windows)]
    fn cdp_call_sync(
        &self,
        window: &WebviewWindow,
        method: &str,
        params: &Value,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
        use windows::core::HSTRING;

        // `with_webview` only QUEUES the message from this (non-main)
        // thread — the closure runs asynchronously on the main thread's
        // event loop — so the call is initiated there and awaited here.
        let (tx, rx) = mpsc::channel::<Result<String, String>>();
        let method = method.to_string();
        let params_json = params.to_string();
        window
            .with_webview(move |platform| {
                // Runs on the main thread: obtain the core WebView2 and
                // start the CDP call. Its completion handler also fires
                // on the main thread's message pump; only the result
                // string (or the setup error) is sent back.
                let outcome = (|| -> Result<(), windows::core::Error> {
                    let core_webview = unsafe { platform.controller().CoreWebView2() }?;
                    let handler_tx = tx.clone();
                    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                        move |_status: windows::core::Result<()>, result: String| {
                            let _ = handler_tx.send(Ok(result));
                            Ok(())
                        },
                    ));
                    let method = HSTRING::from(method.as_str());
                    let cdp_params = HSTRING::from(params_json.as_str());
                    unsafe {
                        core_webview.CallDevToolsProtocolMethod(&method, &cdp_params, &handler)
                    }
                })();
                if let Err(error) = outcome {
                    let _ = tx.send(Err(error.to_string()));
                }
            })
            .map_err(|e| RpcError::internal(format!("with_webview に失敗しました: {e}")))?;

        let answer = rx
            .recv_timeout(timeout)
            .map_err(|_| {
                RpcError::timeout(format!("CDP の応答がタイムアウトしました（{timeout:?}）"))
            })?
            .map_err(|e| {
                RpcError::new(
                    error_codes::ACTION_FAILED,
                    format!("WebView2 CDP 呼び出しに失敗しました: {e}"),
                )
            })?;
        let answer: Value = serde_json::from_str(&answer).map_err(|e| {
            RpcError::new(
                error_codes::PROBE_ERROR,
                format!("CDP の応答を解析できません: {e}"),
            )
        })?;
        if let Some(error) = answer.get("error") {
            return Err(RpcError::new(
                error_codes::ACTION_FAILED,
                format!("CDP エラー: {error}"),
            ));
        }
        Ok(answer)
    }

    fn close(&self) -> Result<Value, RpcError> {
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

    fn require_window(&self) -> Result<WebviewWindow, RpcError> {
        self.window.lock_recover().clone().ok_or_else(|| {
            RpcError::not_open("ブラウザは開いていません（先に browser_open を呼んでください）")
        })
    }
}

/// The one error a call gets while another page operation is in flight.
fn busy_error() -> RpcError {
    RpcError::new(
        error_codes::TIMEOUT,
        "ブラウザは前の操作を処理中です（ページが応答しない可能性があります）",
    )
}

/// Wrap encoded image bytes in the protocol's image result. Windows gets
/// its base64 straight from CDP, so this is the non-Windows tail.
/// The size is reported from the agent's viewport (the capture covers it at
/// 1:1), and an oversized payload is refused rather than truncated.
#[cfg(not(windows))]
fn image_result(
    format: &str,
    viewport: Option<(u32, u32)>,
    bytes: Vec<u8>,
) -> Result<Value, RpcError> {
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    if data.len() > lumisca_browser_rpc::limits::MAX_SCREENSHOT_BYTES {
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

/// Shut the lab down (app exit). Idempotent.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Some(mut lab) = state.browser_lab.lock_recover().take() {
            lab.shutdown();
        }
    }
}

/// Forget a destroyed lab window (the user closed it, or close() ran).
/// Called from lib.rs's window-event handler for the lab label.
pub fn forget_window(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Some(lab) = state.browser_lab.lock_recover().as_ref() {
            *lab.core.window.lock_recover() = None;
            *lab.core.visible.lock_recover() = false;
        }
    }
}
