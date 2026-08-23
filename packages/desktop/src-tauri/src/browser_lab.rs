//! Browser lab: the Desktop's debug WebView, exposed to the agent running
//! in the local (Deno) server as an authenticated loopback RPC endpoint.
//!
//! Lifecycle:
//! - setup() of lib.rs starts the lab **once per app run**: binds
//!   127.0.0.1:0, generates the per-run random token, and hands both to
//!   the local server through `LUMISCA_BROWSER_IPC_URL` /
//!   `LUMISCA_BROWSER_TOKEN` (server.rs). No window exists yet.
//! - the `open` RPC creates the single `browser-lab` WebviewWindow on
//!   demand, OVERLAID on the app's `main` window as the right-side lab
//!   pane: borderless, taskbar-hidden, resizable-off, and positioned
//!   exactly over the main window's client area below the title bar and
//!   the pane header (see `place_pane`). It is NOT a child WebView of
//!   the main window: multiple WebView2 controllers inside one top-level
//!   window break mouse routing to the main webview (windows show up as
//!   an unresponsive title bar), so the lab keeps its own window and is
//!   kept on top of the main window instead (see `raise` / `sync`).
//! - observe/act/wait/screenshot drive the page through
//!   `eval_with_callback` — the probe runs in the page, results come back
//!   through the eval callback. No polling, no push channel. These work
//!   whether or not the pane is currently shown: hiding the pane is a UI
//!   choice (bridge `pane/set-visible` / the header's hide button),
//!   not a protocol state.
//! - `close` destroys the window (idempotent); a window closed by the
//!   user makes every later call fail with `not_open` (no recreation
//!   behind the caller's back).
//! - the main window's destruction and the updater's exit hook shut the
//!   lab down (destroy window + stop the RPC listener), so no orphaned
//!   WebView or listener outlives the app.
//!
//! Security: the lab window is a separate window (no capability file
//! covers its label), and its page is always a REMOTE origin — the
//! "main" capability resolves only for LOCAL origins (the tauri:// app
//! origin; no `remote` URL patterns are configured), so every Tauri IPC
//! call from the lab page is denied by the ACL. The lumisca:// shell
//! bridge is additionally unreachable from the lab page (it requires the
//! displayed server's token, which the page never has), and `lumisca:`
//! navigations are blocked outright (BLOCKED_SCHEMES).
//!
//! Screenshots use the WebView2 DevTools protocol directly on Windows
//! (`Page.captureScreenshot` via `CallDevToolsProtocolMethod`). macOS and
//! Linux have no stable capture API in wry 0.55 — the host answers with
//! an explicit `screenshot_unsupported` error instead of a blank image.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

// Not cfg(windows): DEFAULT_VIEWPORT_* are the protocol-level default for
// `open` on every platform; only the CDP calls themselves are Windows-only.
use lumisca_browser_rpc::emulation;
use lumisca_browser_rpc::server::RpcHandler;
use lumisca_browser_rpc::{error_codes, limits, methods, policy, probe, RpcError};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewWindow, WebviewWindowBuilder};

use crate::AppState;

/// Label of the lab window. Deliberately NOT covered by any capability
/// file, so the lab page can never call Tauri IPC (see the module docs).
pub const LAB_WINDOW_LABEL: &str = "browser-lab";
/// The lab is overlaid on the app's main window (see tauri.conf.json).
const MAIN_WINDOW_LABEL: &str = "main";
/// The lumisca:// shell bridge must never be reachable from the lab.
const BLOCKED_SCHEMES: [&str; 1] = ["lumisca:"];
/// Pane width in logical pixels. Must match `--pane-width`
/// in packages/web/src/styles.css (the React UI reserves this space).
/// The pane itself is content-agnostic: today it hosts the browser lab,
/// later surfaces can reuse the same dock.
const PANE_WIDTH: f64 = 460.0;
/// Height of the pane's header strip (rendered by the React UI in the
/// main window) in logical pixels. The pane window is positioned BELOW
/// this strip so the header never overlaps it. Must match
/// `--pane-header-height` in styles.css.
const PANE_HEADER_HEIGHT: f64 = 36.0;
/// Height of the app's title bar in logical pixels. Must match
/// `--tab-height` in styles.css (the pane starts below it).
const APP_TITLEBAR_HEIGHT: f64 = 40.0;

/// How long one eval (observe/act/screenshot) may take before the RPC
/// answers `timeout`. Waits are exempt: their in-page deadline governs,
/// and the host adds headroom below.
const EVAL_TIMEOUT: Duration = Duration::from_secs(8);
/// Headroom added on top of a wait's own timeout.
const WAIT_HEADROOM: Duration = Duration::from_secs(3);
/// How long the page gets to answer a CDP method call.
const CDP_TIMEOUT: Duration = Duration::from_secs(8);

/// Shared lab state: the live window (None while closed) and the eval
/// correlation map. Created once per app run, owned by AppState.
struct LabCore {
    app: AppHandle,
    /// The single lab window, created on demand by `open`. None while the
    /// lab is closed (user or RPC) — `open` recreates it, everything else
    /// answers `not_open`.
    window: Mutex<Option<WebviewWindow>>,
    /// Whether the lab pane is currently shown. UI-only state: hiding the
    /// pane keeps the lab alive (the agent keeps operating the browser in
    /// the background); the bridge reads/writes this, RPC close() resets
    /// it.
    visible: Mutex<bool>,
    /// The agent-chosen viewport in CSS pixels, set by every open() (the
    /// Deno tools always send explicit values; the protocol default is
    /// 800×600). The page LAYS OUT at this size and the rendering is
    /// scaled to fit the pane via CDP device emulation (Windows).
    viewport: Mutex<Option<(u32, u32)>>,
    /// Fit scale of the last applied emulation. Reapplied only when it
    /// changes, so window-move/focus events do not re-run CDP calls.
    applied_scale: Mutex<Option<f64>>,
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
            applied_scale: Mutex::new(None),
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
        let window = self.core.window.lock().unwrap().take();
        if let Some(window) = window {
            let _ = window.destroy();
        }
        *self.core.visible.lock().unwrap() = false;
    }
}

/// The RPC dispatcher: runs on the listener's connection threads and
/// coordinates with the WebView through the main-thread dispatchers.
struct LabHandler {
    core: Arc<LabCore>,
}

impl RpcHandler for LabHandler {
    fn handle(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        match method {
            methods::OPEN => self.open(&params),
            methods::OBSERVE => self.eval_call(methods::OBSERVE, &params, EVAL_TIMEOUT),
            methods::ACT => self.eval_call(methods::ACT, &params, EVAL_TIMEOUT),
            methods::WAIT => self.wait(&params),
            methods::SCREENSHOT => self.screenshot(&params),
            methods::CLOSE => self.close(),
            _ => Err(RpcError::invalid(format!("unknown method: {method}"))),
        }
    }
}

/// The eval driver: a catch-all IIFE so a missing probe or a probe
/// exception reads as a well-formed result, never as an eval failure.
fn driver(probe_call: &str) -> String {
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
fn to_js_literal(value: &Value) -> String {
    serde_json::to_string(value)
        .unwrap_or_else(|_| "null".to_string())
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

/// RPC method → probe function name. The wire protocol says `observe`;
/// the probe's snapshot builder is called `snapshot`.
fn probe_method_of(rpc_method: &str) -> &str {
    match rpc_method {
        methods::OBSERVE => "snapshot",
        other => other,
    }
}

/// Position and size the lab window so it overlays the main window's
/// client area as the right-side pane: below the title bar and the
/// pane's header strip (both rendered by the main window's webview),
/// `PANE_WIDTH` wide, down to the bottom edge. Coordinates are
/// logical (tauri's set_position/set_size take logical values); the
/// main window's inner position/size are physical, converted here.
fn place_pane(pane: &WebviewWindow, main: &WebviewWindow) {
    let scale = main.scale_factor().unwrap_or(1.0);
    let inner_pos = main.inner_position().unwrap_or_default();
    let inner_size = main.inner_size().unwrap_or_default();
    let top = APP_TITLEBAR_HEIGHT + PANE_HEADER_HEIGHT;
    let x = (inner_pos.x as f64 + inner_size.width as f64) / scale - PANE_WIDTH;
    let y = inner_pos.y as f64 / scale + top;
    let height = (inner_size.height as f64 / scale - top).max(0.0);
    let _ = pane.set_position(tauri::LogicalPosition::new(x, y));
    let _ = pane.set_size(tauri::LogicalSize::new(PANE_WIDTH, height));
}

/// The lab window's logical (CSS-pixel) size — the surface the emulated
/// viewport must fit into. Coordinates are physical in tauri's
/// inner_size; scale_factor converts (the pane overlays the main window,
/// so both share one monitor). Windows-only: the emulation that consumes
/// it does not exist elsewhere.
#[cfg(windows)]
fn pane_size(pane: &WebviewWindow) -> (f64, f64) {
    let factor = pane.scale_factor().unwrap_or(1.0);
    let size = pane.inner_size().unwrap_or_default();
    (size.width as f64 / factor, size.height as f64 / factor)
}

/// Bring the lab window above the main window without activating it.
/// Only meaningful on Windows (the z-order of a child window cannot be
/// raised on other platforms; macOS keeps the lab window key when
/// clicked, Linux is X11-dependent — the pane still overlays correctly
/// in the common cases).
#[cfg(windows)]
fn raise_pane(pane: &WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };
    if let Ok(hwnd) = pane.hwnd() {
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOP),
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
            );
        }
    }
}

#[cfg(not(windows))]
fn raise_pane(_pane: &WebviewWindow) {}

impl LabCore {
    /// Create the lab window on demand (idempotent per call — this IS
    /// open()'s job), or navigate the existing one. Runs on the RPC
    /// thread: window creation/navigation are message-driven and
    /// thread-safe; the geometry is applied right after creation (the
    /// window starts hidden so it never flashes at a default position).
    fn ensure_window(&self, url: &str, visible: bool) -> Result<WebviewWindow, RpcError> {
        let parsed =
            url::Url::parse(url).map_err(|e| RpcError::invalid(format!("URL が不正です: {e}")))?;
        let main = self
            .app
            .get_webview_window(MAIN_WINDOW_LABEL)
            .ok_or_else(|| RpcError::internal("main ウィンドウがありません"))?;
        // Self-heal: if the manager no longer knows the lab (destroyed
        // outside close(), e.g. after a WebView2 crash), forget the stale
        // handle so the next open builds a fresh window.
        if self.app.get_webview_window(LAB_WINDOW_LABEL).is_none() {
            *self.window.lock().unwrap() = None;
        }
        if let Some(window) = self.window.lock().unwrap().clone() {
            let _ = window.navigate(parsed);
            place_pane(&window, &main);
            self.apply_visibility(&window, visible)?;
            *self.visible.lock().unwrap() = visible;
            return Ok(window);
        }
        let builder = WebviewWindowBuilder::new(
            &self.app,
            LAB_WINDOW_LABEL,
            tauri::WebviewUrl::External(parsed),
        )
        .title("")
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .shadow(false)
        // Start hidden: `place_pane` runs after creation, and an
        // unplaced flash at the default position would be ugly.
        .visible(false)
        .initialization_script(self.probe_source)
        // The lab page must never open the lumisca:// shell
        // bridge: block those navigations outright.
        .on_navigation(|candidate| {
            !BLOCKED_SCHEMES
                .iter()
                .any(|scheme| candidate.as_str().starts_with(scheme))
        });
        let window = builder
            .build()
            .map_err(|e| RpcError::internal(format!("ブラウザペインを作成できません: {e}")))?;
        place_pane(&window, &main);
        raise_pane(&window);
        self.apply_visibility(&window, visible)?;
        *self.window.lock().unwrap() = Some(window.clone());
        *self.visible.lock().unwrap() = visible;
        Ok(window)
    }

    /// Show or hide the pane (UI choice). The lab keeps running while
    /// hidden; the agent's observe/act calls are unaffected. Never
    /// focuses the window: the agent opens the browser on its own, and
    /// stealing keyboard focus from the user's input would be rude;
    /// clicking the page gives it focus naturally.
    fn apply_visibility(&self, window: &WebviewWindow, visible: bool) -> Result<(), RpcError> {
        if visible {
            window
                .show()
                .map_err(|e| RpcError::internal(format!("ブラウザペインを表示できません: {e}")))
        } else {
            window
                .hide()
                .map_err(|e| RpcError::internal(format!("ブラウザペインを隠せません: {e}")))
        }
    }

    /// Keep the pane glued to the main window: re-apply the overlay
    /// geometry, and — while the main window is the focused one — bring
    /// the lab above it (without stealing activation). Called from
    /// lib.rs on the main window's Moved / Resized / Focused events.
    fn sync(&self) {
        let Some(pane) = self.window.lock().unwrap().clone() else {
            return;
        };
        let Some(main) = self.app.get_webview_window(MAIN_WINDOW_LABEL) else {
            return;
        };
        place_pane(&pane, &main);
        self.reapply_emulation(&pane);
        // Only raise when the main window holds focus: raising while
        // another app is active would float the lab over that app, and
        // raising while the lab itself is focused is unnecessary (it is
        // already on top by virtue of being the active window).
        if main.is_focused().unwrap_or(false) {
            raise_pane(&pane);
        }
    }

    /// Re-apply the emulated viewport with a fresh fit scale after the
    /// pane resized. Fire-and-forget: sync() runs on the main thread and
    /// cannot block on the CDP reply (the reply needs this thread's
    /// message pump); only a changed scale actually re-sends. A failed
    /// send loses only the fit update — the next open or resize retries.
    #[cfg(windows)]
    fn reapply_emulation(&self, pane: &WebviewWindow) {
        let (width, height) = match *self.viewport.lock().unwrap() {
            Some(vp) => vp,
            None => return,
        };
        let (area_w, area_h) = pane_size(pane);
        let scale = emulation::fit_scale(width, height, area_w, area_h);
        if *self.applied_scale.lock().unwrap() == Some(scale) {
            return;
        }
        self.applied_scale.lock().unwrap().replace(scale);
        let params = emulation::device_metrics_params(width, height, scale);
        let _ = pane.with_webview(move |platform| {
            use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
            use windows::core::HSTRING;
            let Ok(core_webview) = (|| unsafe { platform.controller().CoreWebView2() })()
            else {
                return;
            };
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |_status: windows::core::Result<()>, _result: String| Ok(()),
            ));
            let method = HSTRING::from("Emulation.setDeviceMetricsOverride");
            let cdp_params = HSTRING::from(params.to_string());
            let _ = unsafe {
                core_webview.CallDevToolsProtocolMethod(&method, &cdp_params, &handler)
            };
        });
    }

    #[cfg(not(windows))]
    fn reapply_emulation(&self, _pane: &WebviewWindow) {}

    /// Current pane state for the bridge (`pane/state` and friends):
    /// does the pane exist, is it shown, and which content is hosted.
    /// The response uses the generic pane protocol shape — a `content`
    /// object carrying a `kind` and a header `label` — so surfaces other
    /// than the browser lab can be hosted in the same dock later. The
    /// lab reports itself as kind "browser" with the loaded page URL as
    /// the label.
    fn state_json(&self) -> Value {
        let open = self.window.lock().unwrap().is_some();
        let visible = *self.visible.lock().unwrap();
        let content = if open {
            let label = self
                .window
                .lock()
                .unwrap()
                .as_ref()
                .and_then(|w| w.url().ok())
                .map(|u| u.to_string());
            Some(json!({ "kind": "browser", "label": label }))
        } else {
            None
        };
        json!({ "open": open, "visible": visible && open, "content": content })
    }

    /// Show or hide the pane (UI choice). The lab keeps running while
    /// hidden; the agent's observe/act calls are unaffected.
    fn set_pane_visible(&self, visible: bool) -> Value {
        if let Some(window) = self.window.lock().unwrap().clone() {
            let _ = if visible {
                window.show()
            } else {
                window.hide()
            };
            *self.visible.lock().unwrap() = visible;
        }
        self.state_json()
    }

    fn toggle_pane(&self) -> Value {
        let visible = !*self.visible.lock().unwrap();
        self.set_pane_visible(visible)
    }
}

impl LabHandler {
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
            .unwrap_or(emulation::DEFAULT_VIEWPORT_WIDTH as u64) as u32;
        let height = params
            .get("height")
            .and_then(Value::as_u64)
            .unwrap_or(emulation::DEFAULT_VIEWPORT_HEIGHT as u64) as u32;
        // The agent-chosen viewport: the pane is a fixed-width strip, so
        // the page lays out at this size and is scaled to fit the pane
        // (device emulation, Windows only — see apply_emulation).
        *self.core.viewport.lock().unwrap() = Some((width, height));

        let window = self.core.ensure_window(url, visible)?;
        self.apply_emulation(&window)?;
        let info = json!({
            "url": window.url().map(|u| u.to_string()).unwrap_or_else(|_| url.to_string()),
            "title": window.title().unwrap_or_default(),
            "readyState": "",
        });
        Ok(info)
    }

    /// Apply the agent-chosen viewport to the lab window — the page lays
    /// out at that size, scaled to fit the pane. Windows: WebView2 CDP
    /// `Emulation.setDeviceMetricsOverride`. macOS/Linux: WebKit exposes
    /// no emulation API, so the pane size stays the viewport (a no-op).
    /// An emulation failure fails the open loudly — a silently wrong
    /// resolution would lie to the agent (observe reports innerWidth).
    fn apply_emulation(&self, window: &WebviewWindow) -> Result<(), RpcError> {
        #[cfg(windows)]
        {
            let viewport = *self.core.viewport.lock().unwrap();
            let (width, height) = match viewport {
                // open() always sets the viewport before calling.
                Some(vp) => vp,
                None => return Ok(()),
            };
            let (area_w, area_h) = pane_size(window);
            let scale = emulation::fit_scale(width, height, area_w, area_h);
            let params = emulation::device_metrics_params(width, height, scale);
            self.cdp_call_sync(
                window,
                "Emulation.setDeviceMetricsOverride",
                &params,
                CDP_TIMEOUT,
            )?;
            *self.core.applied_scale.lock().unwrap() = Some(scale);
        }
        #[cfg(not(windows))]
        {
            let _ = window;
        }
        Ok(())
    }

    /// One synchronous probe call through the eval channel.
    fn eval_call(
        &self,
        method: &str,
        params: &Value,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        let window = self.require_window()?;
        // Strictly one eval in flight. A busy lab is an error, never a
        // queue — a stuck page must not accumulate requests.
        let _busy = self.core.busy.try_lock().map_err(|_| {
            RpcError::new(
                error_codes::TIMEOUT,
                "ブラウザは前の操作を処理中です (ページが応答しない可能性があります)",
            )
        })?;
        let req_id = self.core.next_req.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.core.pending.lock().unwrap().insert(req_id, tx);

        let probe_call = format!(
            "return p.{probe_method}({args});",
            probe_method = probe_method_of(method),
            args = to_js_literal(params)
        );
        let script = driver(&probe_call);
        let pending = self.core.pending.clone();
        let callback_req_id = req_id;
        if let Err(e) = window.eval_with_callback(script, move |result| {
            let _ = pending
                .lock()
                .unwrap()
                .remove(&callback_req_id)
                .map(|tx| tx.send(result));
        }) {
            self.core.pending.lock().unwrap().remove(&req_id);
            return Err(RpcError::not_open(format!(
                "ブラウザペインが利用できません: {e}"
            )));
        }

        let result = rx.recv_timeout(timeout).map_err(|_| {
            self.core.pending.lock().unwrap().remove(&req_id);
            RpcError::timeout(format!(
                "ページが {method} に応答しませんでした ({timeout:?})"
            ))
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

    /// wait runs the in-page promise. Windows: WebView2's ExecuteScript
    /// does not await promises, so the wait goes over CDP
    /// Runtime.evaluate with awaitPromise (see wait_via_cdp). macOS:
    /// WKWebView's eval resolves promises and the plain eval path works.
    /// WebKitGTK: explicit `wait_unsupported` — never a poll fallback.
    fn wait(&self, params: &Value) -> Result<Value, RpcError> {
        let timeout_ms = params
            .get("timeoutMs")
            .and_then(Value::as_u64)
            .unwrap_or(10_000);
        let headroom = Duration::from_millis(timeout_ms) + WAIT_HEADROOM;
        #[cfg(windows)]
        {
            let window = self.require_window()?;
            self.wait_via_cdp(&window, params, headroom)
        }
        #[cfg(not(windows))]
        {
            let result = self.eval_call(methods::WAIT, params, headroom)?;
            let settled = result.get("ok").and_then(Value::as_bool);
            match settled {
                Some(_) => Ok(result),
                None => Err(RpcError::unsupported(
                    error_codes::WAIT_UNSUPPORTED,
                    concat!(
                        "このプラットフォームの WebView は eval の Promise 解決に",
                        "対応していません (wait は Windows/macOS のみ)。",
                    ),
                )),
            }
        }
    }

    /// Windows wait: CDP Runtime.evaluate with awaitPromise. The page-side
    /// wait still runs in the probe; only the eval vehicle differs. Runs
    /// on the RPC thread (blocking is fine here — the main thread pumps
    /// the completion handler).
    #[cfg(windows)]
    fn wait_via_cdp(
        &self,
        window: &WebviewWindow,
        params: &Value,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        let probe_call = format!("return p.wait({});", to_js_literal(params));
        let expression = driver(&probe_call);
        let cdp_params = json!({
            "expression": expression,
            "awaitPromise": true,
            "returnByValue": true,
        });
        let answer = self.cdp_call_sync(window, "Runtime.evaluate", &cdp_params, timeout)?;
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
        // WebView2 returns the DevTools reply without the envelope:
        // {"result": {"type": "object", "value": {...}}}.
        answer
            .pointer("/result/value")
            .cloned()
            .ok_or_else(|| RpcError::new(error_codes::PROBE_ERROR, "CDP の応答形式が不正です"))
    }

    /// Screenshot: WebView2 CDP on Windows; explicit unsupported error
    /// elsewhere (wry 0.55 has no stable cross-platform capture API).
    fn screenshot(&self, params: &Value) -> Result<Value, RpcError> {
        let window = self.require_window()?;
        #[cfg(windows)]
        {
            self.cdp_screenshot(&window, params)
        }
        #[cfg(not(windows))]
        {
            let _ = (window, params);
            Err(RpcError::unsupported(
                error_codes::SCREENSHOT_UNSUPPORTED,
                "このプラットフォームの WebView スクリーンショットは未実装です "
                    + "(Windows の WebView2 CDP のみ対応)",
            ))
        }
    }

    /// WebView2 CDP `Page.captureScreenshot` straight on the lab
    /// WebView2 controller — no remote debugging port is ever opened.
    /// When a viewport is emulated the capture covers the FULL emulated
    /// viewport at 1:1 (clip + captureBeyondViewport), so the agent sees
    /// the resolution it asked for instead of the scaled pane view.
    #[cfg(windows)]
    fn cdp_screenshot(&self, window: &WebviewWindow, params: &Value) -> Result<Value, RpcError> {
        let format = params
            .get("format")
            .and_then(Value::as_str)
            .unwrap_or("png");
        let quality = params.get("quality").and_then(Value::as_u64);
        let viewport = *self.core.viewport.lock().unwrap();
        let cdp_params = match viewport {
            Some((width, height)) => {
                emulation::capture_screenshot_params(width, height, format, quality)
            }
            None => match format {
                "png" => json!({ "format": "png", "fromSurface": true }),
                "jpeg" => json!({
                    "format": "jpeg",
                    "quality": quality.unwrap_or(80).min(100).max(1),
                    "fromSurface": true,
                }),
                other => {
                    return Err(RpcError::invalid(format!(
                        "不明な format: {other} (png / jpeg)"
                    )));
                }
            },
        };
        let answer =
            self.cdp_call_sync(window, "Page.captureScreenshot", &cdp_params, CDP_TIMEOUT)?;
        let data = answer.get("data").and_then(Value::as_str).ok_or_else(|| {
            RpcError::new(error_codes::ACTION_FAILED, "CDP は画像を返しませんでした")
        })?;
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
                RpcError::timeout(format!("CDP の応答がタイムアウトしました ({timeout:?})"))
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
        let window = self.core.window.lock().unwrap().take();
        if let Some(window) = window {
            let (tx, rx) = mpsc::channel();
            let app = self.core.app.clone();
            app.run_on_main_thread(move || {
                let result = window.destroy();
                let _ = tx.send(result);
            })
            .map_err(|e| RpcError::internal(format!("main thread dispatch に失敗しました: {e}")))?;
            let _ = rx.recv_timeout(EVAL_TIMEOUT);
        }
        *self.core.visible.lock().unwrap() = false;
        Ok(json!({ "closed": true }))
    }

    fn require_window(&self) -> Result<WebviewWindow, RpcError> {
        self.core.window.lock().unwrap().clone().ok_or_else(|| {
            RpcError::not_open("ブラウザは開いていません (先に browser_open を呼んでください)")
        })
    }
}

// --- bridge-facing pane state (pane/state, pane/set-visible, ...) ---

/// The pane state as JSON for the bridge: `open` = the pane window
/// exists, `visible` = the pane is shown, `content` = the hosted
/// surface's kind/label (the browser lab) or null. The React UI polls
/// this and drives the pane layout.
pub fn pane_state(app: &AppHandle) -> Value {
    match lab_of(app) {
        Some(core) => core.state_json(),
        None => json!({ "open": false, "visible": false, "content": null }),
    }
}

/// Show/hide the pane (the agent's browser keeps running while hidden).
/// Returns the fresh state.
pub fn set_pane_visible(app: &AppHandle, visible: bool) -> Value {
    match lab_of(app) {
        Some(core) => core.set_pane_visible(visible),
        None => json!({ "open": false, "visible": false, "content": null }),
    }
}

/// Flip the pane's visibility. Returns the fresh state.
pub fn toggle_pane(app: &AppHandle) -> Value {
    match lab_of(app) {
        Some(core) => core.toggle_pane(),
        None => json!({ "open": false, "visible": false, "content": null }),
    }
}

/// Keep the pane glued to the main window (geometry + z-order). Called
/// from lib.rs on the main window's Moved / Resized / Focused events.
pub fn sync_pane(app: &AppHandle) {
    if let Some(core) = lab_of(app) {
        core.sync();
    }
}

/// Forget a destroyed lab window (the user closed it, or close() ran).
/// Called from lib.rs's window-event handler for the lab label.
pub fn forget_window(app: &AppHandle) {
    if let Some(core) = lab_of(app) {
        *core.window.lock().unwrap() = None;
        *core.visible.lock().unwrap() = false;
    }
}

/// The lab's core state, if the lab is running (the RPC listener may have
/// failed to start, in which case the agent has no browser tools and the
/// pane never exists).
fn lab_of(app: &AppHandle) -> Option<Arc<LabCore>> {
    let state = app.try_state::<AppState>()?;
    let lab = state.browser_lab.lock().unwrap();
    lab.as_ref().map(|lab| lab.core.clone())
}

/// Shut the lab down (app exit). Idempotent.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Some(mut lab) = state.browser_lab.lock().unwrap().take() {
            lab.shutdown();
        }
    }
}
