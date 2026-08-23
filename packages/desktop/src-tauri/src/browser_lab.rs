//! Browser lab: the Desktop's debug WebView, exposed to the agent running
//! in the local (Deno) server as an authenticated loopback RPC endpoint.
//!
//! Lifecycle:
//! - setup() of lib.rs starts the lab **once per app run**: binds
//!   127.0.0.1:0, generates the per-run random token, and hands both to
//!   the local server through `LUMISCA_BROWSER_IPC_URL` /
//!   `LUMISCA_BROWSER_TOKEN` (server.rs). No WebView exists yet.
//! - the `open` RPC creates the single `browser-lab` WebviewWindow on
//!   demand (reused for every later open) and injects the shared probe at
//!   document start of every page load.
//! - observe/act/wait/screenshot drive the page through
//!   `eval_with_callback` — the probe runs in the page, results come back
//!   through the eval callback. No polling, no push channel.
//! - `close` destroys the window (idempotent); a window closed by the
//!   user makes every later call fail with `not_open` (no recreation
//!   behind the caller's back).
//! - the main window's destruction and the updater's exit hook shut the
//!   lab down (destroy window + stop the RPC listener), so no orphaned
//!   WebView or listener outlives the app.
//!
//! Screenshots use the WebView2 DevTools protocol directly on Windows
//! (`Page.captureScreenshot` via `CallDevToolsProtocolMethod`). macOS and
//! Linux have no stable capture API in wry 0.55 — the host answers with
//! an explicit `screenshot_unsupported` error instead of a blank image.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use lumisca_browser_rpc::server::RpcHandler;
use lumisca_browser_rpc::{error_codes, limits, methods, policy, probe, RpcError};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewWindow, WebviewWindowBuilder};

use crate::AppState;

/// Label of the lab window. Distinct from the app's `main` window — and
/// deliberately NOT covered by any capability file, so the lab page can
/// never call Tauri IPC (the WebView2/WKWebView/WebKitGTK core is enough
/// for a debugged page).
pub const LAB_WINDOW_LABEL: &str = "browser-lab";
/// The lumisca:// shell bridge must never be reachable from the lab.
const BLOCKED_SCHEMES: [&str; 1] = ["lumisca:"];

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
            busy: Mutex::new(()),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_req: AtomicU64::new(1),
            probe_source: probe::extract().map_err(|e| format!("browser lab: {e}"))?,
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

impl LabHandler {
    fn open(&self, params: &Value) -> Result<Value, RpcError> {
        let url = params
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::invalid("open には url が必要です"))?;
        // Host-side policy enforcement (the Deno tools validate first).
        policy::check(url).map_err(RpcError::invalid)?;

        let width = params
            .get("width")
            .and_then(Value::as_u64)
            .map(|w| w as u32);
        let height = params
            .get("height")
            .and_then(Value::as_u64)
            .map(|h| h as u32);
        let visible = params
            .get("visible")
            .and_then(Value::as_bool)
            .unwrap_or(true);

        let window = self.ensure_window(url, width, height, visible)?;
        let info = json!({
            "url": window.url().map(|u| u.to_string()).unwrap_or_else(|_| url.to_string()),
            "title": window.title().unwrap_or_default(),
            "readyState": "",
        });
        Ok(info)
    }

    /// Create the lab window on demand (idempotent per call — this IS
    /// open()'s job), or navigate the existing one. Runs on the main
    /// thread; blocks the RPC thread until the window is ready.
    fn ensure_window(
        &self,
        url: &str,
        width: Option<u32>,
        height: Option<u32>,
        visible: bool,
    ) -> Result<WebviewWindow, RpcError> {
        let core = self.core.clone();
        let app = core.app.clone();
        let url = url.to_string();
        let (tx, rx) = mpsc::channel();
        app.run_on_main_thread(move || {
            let result = build_or_navigate(&core, &url, width, height, visible);
            let _ = tx.send(result);
        })
        .map_err(|e| {
            RpcError::internal(format!("main thread への dispatch に失敗しました: {e}"))
        })?;
        rx.recv_timeout(EVAL_TIMEOUT)
            .map_err(|_| RpcError::timeout("browser lab ウィンドウの起動がタイムアウトしました"))?
            .map_err(|e| RpcError::internal(format!("browser lab: {e}")))
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
                "browser lab は前の操作を処理中です (ページが応答しない可能性があります)",
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
                "browser lab ウィンドウが利用できません: {e}"
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
        let core_webview = self.webview2_core(window)?;
        let probe_call = format!("return p.wait({});", to_js_literal(params));
        let expression = driver(&probe_call);
        let cdp_params = json!({
            "expression": expression,
            "awaitPromise": true,
            "returnByValue": true,
        });
        let answer = self.cdp_call_sync(&core_webview, "Runtime.evaluate", &cdp_params, timeout)?;
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
    #[cfg(windows)]
    fn cdp_screenshot(&self, window: &WebviewWindow, params: &Value) -> Result<Value, RpcError> {
        let format = params
            .get("format")
            .and_then(Value::as_str)
            .unwrap_or("png");
        let quality = params.get("quality").and_then(Value::as_u64);
        let cdp_params = match format {
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
        };
        let core_webview = self.webview2_core(window)?;
        let answer = self.cdp_call_sync(
            &core_webview,
            "Page.captureScreenshot",
            &cdp_params,
            CDP_TIMEOUT,
        )?;
        let data = answer.get("data").and_then(Value::as_str).ok_or_else(|| {
            RpcError::new(error_codes::ACTION_FAILED, "CDP は画像を返しませんでした")
        })?;
        if data.len() > limits::MAX_SCREENSHOT_BYTES {
            return Err(RpcError::too_large(format!(
                "スクリーンショットが大きすぎます ({} bytes)",
                data.len()
            )));
        }
        Ok(json!({
            "mimeType": if format == "png" { "image/png" } else { "image/jpeg" },
            "data": data,
        }))
    }

    /// The lab window's WebView2 core (Windows). Runs the main-thread
    /// with_webview through a raw slot (COM interfaces are not Send);
    /// callers use the returned handle from their own thread — CDP calls
    /// are async and their completion handlers fire on the UI thread.
    #[cfg(windows)]
    fn webview2_core(
        &self,
        window: &WebviewWindow,
    ) -> Result<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2, RpcError> {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2, ICoreWebView2Controller,
        };

        // `with_webview` runs on the main thread and hands out the
        // platform handle; the closure must be Send, and COM interfaces
        // are not — carry the controller out through a raw slot (the
        // closure runs synchronously inside with_webview, so the slot is
        // read only after the call returns).
        struct SendPtr<T>(*mut T);
        // SAFETY: the pointer is only dereferenced on the main thread,
        // inside the synchronous with_webview call.
        unsafe impl<T> Send for SendPtr<T> {}
        impl<T> SendPtr<T> {
            /// Method access so closures capture the whole (Send) wrapper
            /// instead of the raw pointer field.
            fn write(&self, value: T) {
                // SAFETY: the caller guarantees the slot outlives the
                // writer and that both sides run on the main thread.
                unsafe {
                    *self.0 = value;
                }
            }
        }

        let slot = Box::into_raw(Box::new(None::<ICoreWebView2Controller>));
        let send_ptr = SendPtr(slot);
        let result = window.with_webview(move |platform| {
            send_ptr.write(Some(platform.controller()));
        });
        // SAFETY: consumed exactly once, after with_webview returned.
        let controller = unsafe { Box::from_raw(slot) }
            .take()
            .ok_or_else(|| RpcError::internal("WebView2 コントローラーを取得できません"))?;
        result.map_err(|e| RpcError::internal(format!("with_webview に失敗しました: {e}")))?;
        let core_webview: ICoreWebView2 = unsafe { controller.CoreWebView2() }
            .map_err(|e| RpcError::internal(format!("WebView2 ハンドルを取得できません: {e}")))?;
        Ok(core_webview)
    }

    /// One CDP method call with a bounded wait. Runs on the RPC thread —
    /// blocking is fine here because the completion handler fires on the
    /// app's main thread, which keeps pumping independently.
    #[cfg(windows)]
    fn cdp_call_sync(
        &self,
        core_webview: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
        method: &str,
        params: &Value,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
        use windows::core::HSTRING;

        let (tx, rx) = mpsc::channel();
        let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
            move |_status: windows::core::Result<()>, result: String| {
                let _ = tx.send(result);
                Ok(())
            },
        ));
        let method = HSTRING::from(method);
        let cdp_params = HSTRING::from(params.to_string());
        unsafe { core_webview.CallDevToolsProtocolMethod(&method, &cdp_params, &handler) }
            .map_err(|e| RpcError::internal(format!("CDP 呼び出しに失敗しました: {e}")))?;

        let answer = rx.recv_timeout(timeout).map_err(|_| {
            RpcError::timeout(format!("CDP の応答がタイムアウトしました ({timeout:?})"))
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
            // The destroyed event also clears any stale state; the window
            // is already taken from the map either way.
            let _ = rx.recv_timeout(EVAL_TIMEOUT);
        }
        Ok(json!({ "closed": true }))
    }

    fn require_window(&self) -> Result<WebviewWindow, RpcError> {
        self.core.window.lock().unwrap().clone().ok_or_else(|| {
            RpcError::not_open("browser lab は開いていません (先に browser_open を呼んでください)")
        })
    }
}

/// Create the lab window against `core.app` (main thread only), or
/// navigate/resize/show the existing one.
fn build_or_navigate(
    core: &LabCore,
    url: &str,
    width: Option<u32>,
    height: Option<u32>,
    visible: bool,
) -> Result<WebviewWindow, String> {
    let app = &core.app;
    let parsed = url::Url::parse(url).map_err(|e| format!("URL が不正です: {e}"))?;
    if let Some(window) = app.get_webview_window(LAB_WINDOW_LABEL) {
        let _ = window.navigate(parsed);
        if visible {
            let _ = window.show();
            let _ = window.set_focus();
        } else {
            let _ = window.hide();
        }
        if let (Some(w), Some(h)) = (width, height) {
            let _ = window.set_size(tauri::LogicalSize::new(w, h));
        }
        *core.window.lock().unwrap() = Some(window.clone());
        return Ok(window);
    }
    let mut builder =
        WebviewWindowBuilder::new(app, LAB_WINDOW_LABEL, tauri::WebviewUrl::External(parsed))
            .title("Lumisca Browser Lab")
            .inner_size(
                f64::from(width.unwrap_or(1100)),
                f64::from(height.unwrap_or(800)),
            )
            .min_inner_size(320.0, 240.0)
            .visible(visible)
            .initialization_script(core.probe_source);
    if let Some(w) = width {
        if let Some(h) = height {
            builder = builder.inner_size(f64::from(w), f64::from(h));
        }
    }
    // The lab page must never open the lumisca:// shell bridge: block
    // those navigations outright.
    let builder = builder.on_navigation(|candidate| {
        !BLOCKED_SCHEMES
            .iter()
            .any(|scheme| candidate.as_str().starts_with(scheme))
    });
    let window = builder
        .build()
        .map_err(|e| format!("browser lab ウィンドウを作成できません: {e}"))?;
    *core.window.lock().unwrap() = Some(window.clone());
    Ok(window)
}

/// Forget a destroyed lab window (the user closed it, or close() ran).
/// Called from lib.rs's window-event handler for the lab label.
pub fn forget_window(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Some(lab) = state.browser_lab.lock().unwrap().as_ref() {
            *lab.core.window.lock().unwrap() = None;
        }
    }
}

/// Shut the lab down (app exit). Idempotent.
pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Some(mut lab) = state.browser_lab.lock().unwrap().take() {
            lab.shutdown();
        }
    }
}
