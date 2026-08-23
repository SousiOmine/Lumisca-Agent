//! lumisca-browser-host — the CLI's browser lab.
//!
//! A small Rust process that owns one OS-standard WebView (WebView2 /
//! WKWebView / WebKitGTK via wry + tao), serves the shared browser-lab
//! RPC protocol on 127.0.0.1 (see packages/browser-rpc), and exits on:
//! - the `close` RPC (after the reply flush grace)
//! - the parent CLI process's death (stdin EOF)
//! - an idle timeout (default 15 min since the last RPC)
//!
//! It is launched ON DEMAND by the CLI (never at startup), never spawns an
//! external browser, and refuses to start when the OS has no display (the
//! GUI event loop fails loudly instead of falling back to anything).

use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

// Not cfg(windows): DEFAULT_VIEWPORT_* are the protocol-level default for
// `open` on every platform; only the CDP calls themselves are Windows-only.
use lumisca_browser_rpc::emulation;
use lumisca_browser_rpc::server::RpcHandler;
use lumisca_browser_rpc::{error_codes, limits, methods, policy, probe, RpcError, RpcServer};
use serde_json::{json, Value};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy, EventLoopWindowTarget};
use tao::window::WindowBuilder;
use wry::{WebView, WebViewBuilder};

/// How long one eval (observe/act/screenshot) may take before the RPC
/// answers `timeout`.
const EVAL_TIMEOUT: Duration = Duration::from_secs(8);
/// Headroom added on top of a wait's own timeout (its in-page deadline
/// governs).
const WAIT_HEADROOM: Duration = Duration::from_secs(3);
/// Default idle timeout when --idle-timeout-ms is not given.
const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// How long the process stays alive after replying to `close`, so the HTTP
/// response reaches the client before the process exits.
const CLOSE_FLUSH_GRACE: Duration = Duration::from_millis(300);

/// One command from the RPC threads to the GUI thread.
enum HostCommand {
    Open { params: Value, reply: Reply },
    Observe { params: Value, reply: Reply },
    Act { params: Value, reply: Reply },
    Wait { params: Value, reply: Reply },
    Screenshot { params: Value, reply: Reply },
    Close { reply: Reply },
    Shutdown,
}

/// The raw eval-result string is shipped to the RPC thread, which parses
/// and validates it (platforms differ in what eval returns).
type Reply = mpsc::Sender<String>;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let token = arg_value(&args, "--token").unwrap_or_default();
    if token.is_empty() {
        eprintln!("lumisca-browser-host: --token <token> が必要です");
        std::process::exit(2);
    }
    let idle_timeout = arg_value(&args, "--idle-timeout-ms")
        .and_then(|v| v.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_IDLE_TIMEOUT);

    // The GUI event loop must run on the main thread.
    let event_loop = EventLoopBuilder::<HostCommand>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    // RPC server first (its port goes into the ready line the CLI reads).
    let handler = Arc::new(HostHandler {
        proxy: proxy.clone(),
    });
    let mut rpc = match RpcServer::start(0, token, handler, Duration::from_secs(30)) {
        Ok(server) => server,
        Err(error) => {
            eprintln!("lumisca-browser-host: {error}");
            std::process::exit(1);
        }
    };
    // The idle monitor reads the server's last-request clock.
    let last_activity: Arc<AtomicU64> = rpc.last_request_at.clone();

    // Tell the CLI where to reach us. One line on stdout; the CLI waits
    // for it with a deadline.
    println!("LUMISCA_BROWSER_READY {}", rpc.port);
    let _ = std::io::Write::flush(&mut std::io::stdout());

    // Parent watch: stdin reaches EOF when the CLI process dies (the OS
    // closes its write end of the pipe). Cross-platform, no polling.
    let exit_proxy = proxy.clone();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        loop {
            match std::io::stdin().read(&mut buffer) {
                Ok(0) | Err(_) => break, // EOF or closed
                Ok(_) => {}
            }
        }
        let _ = exit_proxy.send_event(HostCommand::Shutdown);
    });

    // Idle monitor: exit when no RPC has arrived for `idle_timeout`
    // (measured from the host's own start when nothing arrived yet, so an
    // unused host does not sit around forever either).
    let idle_proxy = proxy.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let last_millis = last_activity.load(Ordering::Relaxed);
            let reference = if last_millis == 0 {
                // Never used: count from process start.
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)
            } else {
                last_millis
            };
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            if now.saturating_sub(reference) >= idle_timeout.as_millis() as u64 {
                let _ = idle_proxy.send_event(HostCommand::Shutdown);
                return;
            }
        }
    });

    // The GUI state lives on the main thread.
    let mut host = Host::default();

    event_loop.run(move |event, target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(command) => match command {
                HostCommand::Open { params, reply } => {
                    host.open(target, &params, reply);
                }
                HostCommand::Observe { params, reply } => {
                    host.probe_call(methods::OBSERVE, &params, reply);
                }
                HostCommand::Act { params, reply } => {
                    host.probe_call(methods::ACT, &params, reply);
                }
                HostCommand::Wait { params, reply } => {
                    // Windows: WebView2's ExecuteScript does not await
                    // promises — the in-page wait runs over CDP
                    // Runtime.evaluate with awaitPromise. macOS
                    // (WKWebView) resolves promises in eval and uses the
                    // plain path; Linux reports an explicit
                    // wait_unsupported error (no poll fallback).
                    #[cfg(windows)]
                    host.wait_cdp(&params, reply);
                    #[cfg(not(windows))]
                    host.probe_call(methods::WAIT, &params, reply);
                }
                HostCommand::Screenshot { params, reply } => {
                    host.screenshot(&params, reply);
                }
                HostCommand::Close { reply } => host.close(reply),
                HostCommand::Shutdown => {
                    // The parent died, or the idle timeout fired: leave
                    // immediately. The OS reclaims the WebView.
                    drop(host.webview.take());
                    *control_flow = ControlFlow::Exit;
                }
            },
            Event::WindowEvent { event, .. } => match event {
                // The user closed the lab window: destroy the webview.
                // Later RPCs answer `not_open` — the next open rebuilds
                // everything. The host itself stays (idle timeout rules).
                WindowEvent::CloseRequested => {
                    host.webview = None;
                    host.owning_window = None;
                }
                // A user resize re-scales the emulated viewport to fit
                // the window instead of changing the page layout.
                WindowEvent::Resized(_) => {
                    host.reapply_emulation();
                }
                _ => {}
            },
            Event::LoopDestroyed => {
                rpc.stop();
            }
            _ => {}
        }
    });
}

/// The RpcHandler bridge: forwards every method to the GUI thread as a
/// UserEvent and waits (bounded) for the eval result.
struct HostHandler {
    proxy: EventLoopProxy<HostCommand>,
}

impl RpcHandler for HostHandler {
    fn handle(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        match method {
            methods::OPEN => {
                self.round_trip(|reply| HostCommand::Open { params, reply }, EVAL_TIMEOUT)
            }
            methods::OBSERVE => {
                self.round_trip(|reply| HostCommand::Observe { params, reply }, EVAL_TIMEOUT)
            }
            methods::ACT => {
                self.round_trip(|reply| HostCommand::Act { params, reply }, EVAL_TIMEOUT)
            }
            methods::WAIT => {
                let timeout_ms = params
                    .get("timeoutMs")
                    .and_then(Value::as_u64)
                    .unwrap_or(10_000);
                let headroom = Duration::from_millis(timeout_ms) + WAIT_HEADROOM;
                let value =
                    self.round_trip(|reply| HostCommand::Wait { params, reply }, headroom)?;
                // settle check: Windows/macOS evals await promises;
                // WebKitGTK does not. Anything without an `ok` boolean is
                // an explicit platform error — never a poll fallback.
                if value.get("ok").and_then(Value::as_bool).is_none() {
                    return Err(RpcError::unsupported(
                        error_codes::WAIT_UNSUPPORTED,
                        concat!(
                            "このプラットフォームの WebView は eval の Promise 解決に",
                            "対応していません (wait は Windows/macOS のみ)。",
                        ),
                    ));
                }
                Ok(value)
            }
            methods::SCREENSHOT => self.round_trip(
                |reply| HostCommand::Screenshot { params, reply },
                EVAL_TIMEOUT,
            ),
            methods::CLOSE => {
                self.round_trip(|reply| HostCommand::Close { reply }, Duration::from_secs(5))
            }
            _ => Err(RpcError::invalid(format!("unknown method: {method}"))),
        }
    }
}

impl HostHandler {
    fn round_trip(
        &self,
        build: impl FnOnce(Reply) -> HostCommand,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        let (tx, rx) = mpsc::channel();
        self.proxy
            .send_event(build(tx))
            .map_err(|_| RpcError::closed("browser host は終了しています"))?;
        let raw = rx
            .recv_timeout(timeout)
            .map_err(|_| RpcError::timeout(format!("ページが応答しませんでした ({timeout:?})")))?;
        match serde_json::from_str::<Value>(&raw) {
            Ok(value) => Ok(value),
            Err(_) => {
                let snippet: String = raw.chars().take(200).collect();
                Err(RpcError::new(
                    error_codes::PROBE_ERROR,
                    format!("プローブの応答を解析できません: {snippet}"),
                ))
            }
        }
    }
}

/// The main-thread GUI state: the owned window + webview.
#[derive(Default)]
struct Host {
    /// The tao window the webview is attached to.
    owning_window: Option<tao::window::Window>,
    webview: Option<WebView>,
    /// The agent-chosen viewport in CSS pixels (set by every open; the
    /// Deno tools always send explicit values, the protocol default is
    /// 800×600). The page lays out at this size; a user resize of the
    /// window re-scales the rendering to fit instead of changing the
    /// layout (Windows).
    viewport: Option<(u32, u32)>,
}

impl Host {
    fn open(&mut self, target: &EventLoopWindowTarget<HostCommand>, params: &Value, reply: Reply) {
        let result = self.open_inner(target, params);
        send_value(reply, result);
    }

    fn open_inner(
        &mut self,
        target: &EventLoopWindowTarget<HostCommand>,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let url = params
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::invalid("open には url が必要です"))?;
        // Host-side policy enforcement (the Deno tools validate first).
        policy::check(url).map_err(RpcError::invalid)?;
        let width = params
            .get("width")
            .and_then(Value::as_u64)
            .unwrap_or(emulation::DEFAULT_VIEWPORT_WIDTH as u64) as u32;
        let height = params
            .get("height")
            .and_then(Value::as_u64)
            .unwrap_or(emulation::DEFAULT_VIEWPORT_HEIGHT as u64) as u32;
        let visible = params
            .get("visible")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        // The agent-chosen viewport: the window is sized to it, and the
        // emulation pins the layout to it even if the user resizes the
        // window afterwards (Windows — see reapply_emulation).
        self.viewport = Some((width, height));

        match self.webview.as_ref() {
            // Reuse the lab: navigate, resize, show.
            Some(webview) => {
                webview
                    .load_url(url)
                    .map_err(|e| RpcError::internal(format!("navigate に失敗しました: {e}")))?;
                if let Some(window) = &self.owning_window {
                    let _ = window.set_inner_size(tao::dpi::LogicalSize::new(
                        f64::from(width),
                        f64::from(height),
                    ));
                    let _ = window.set_visible(visible);
                    if visible {
                        window.set_focus();
                    }
                }
            }
            // Create on demand: the lab window with the probe injected at
            // document start of every page load.
            None => {
                let mut builder = WindowBuilder::new()
                    .with_title("Lumisca Browser")
                    .with_inner_size(tao::dpi::LogicalSize::new(
                        f64::from(width),
                        f64::from(height),
                    ))
                    .with_min_inner_size(tao::dpi::LogicalSize::new(320.0, 240.0))
                    .with_visible(visible);
                if !visible {
                    builder = builder.with_visible(false);
                }
                let window = builder.build(target).map_err(|e| {
                    RpcError::new(
                        error_codes::INTERNAL,
                        format!("ブラウザのウィンドウを作成できません: {e}"),
                    )
                })?;
                let probe_source = probe::extract()
                    .map_err(|e| RpcError::internal(format!("browser host: {e}")))?;
                let webview = WebViewBuilder::new()
                    .with_url(url)
                    .with_initialization_script(probe_source)
                    .build(&window)
                    .map_err(|e| {
                        RpcError::new(
                            error_codes::INTERNAL,
                            format!("ブラウザの WebView を作成できません: {e}"),
                        )
                    })?;
                self.owning_window = Some(window);
                self.webview = Some(webview);
            }
        }
        self.reapply_emulation();
        Ok(json!({
            "url": url,
            "title": "",
            "readyState": "",
        }))
    }

    /// (Re-)apply the emulated viewport to the WebView: the page's
    /// layout stays at the agent-chosen size while the rendering scales
    /// to fit the current window (Windows; on macOS/Linux the window
    /// size is the viewport, no emulation exists). Fire-and-forget: open
    /// and resize run on the GUI thread, which must never block on a CDP
    /// reply (the reply needs this thread's message pump).
    fn reapply_emulation(&mut self) {
        #[cfg(windows)]
        {
            let (Some((width, height)), Some(webview), Some(window)) = (
                self.viewport,
                self.webview.as_ref(),
                self.owning_window.as_ref(),
            ) else {
                return;
            };
            let factor = window.scale_factor();
            let size = window.inner_size();
            apply_device_metrics(
                webview,
                (width, height),
                f64::from(size.width) / factor,
                f64::from(size.height) / factor,
            );
        }
    }

    /// Run one probe method through the eval channel. The driver is the
    /// same catch-all IIFE as the Desktop host: a missing probe or a
    /// probe exception reads as a well-formed result.
    fn probe_call(&mut self, method: &str, params: &Value, reply: Reply) {
        // The eval callback consumes the send end; the error path below
        // needs its own.
        let callback_reply = reply.clone();
        let result = self.probe_call_inner(method, params, callback_reply);
        if let Err(error) = result {
            let _ = reply_after_error(reply, error);
        }
    }

    fn probe_call_inner(
        &mut self,
        method: &str,
        params: &Value,
        reply: Reply,
    ) -> Result<(), RpcError> {
        let webview = self.webview.as_ref().ok_or_else(|| {
            RpcError::not_open("ブラウザは開いていません (先に browser_open を呼んでください)")
        })?;
        let probe_call = format!(
            "return p.{probe_method}({args});",
            probe_method = probe_method_of(method),
            args = to_js_literal(params),
        );
        let script = driver(&probe_call);
        webview
            .evaluate_script_with_callback(&script, move |result| {
                let _ = reply.send(result);
            })
            .map_err(|e| RpcError::not_open(format!("ブラウザウィンドウが利用できません: {e}")))
    }

    fn close(&mut self, reply: Reply) {
        self.webview = None;
        self.owning_window = None;
        let _ = reply.send(r#"{"closed":true}"#.to_string());
        // The HTTP response needs a moment to reach the client before the
        // process exits.
        std::thread::spawn(|| {
            std::thread::sleep(CLOSE_FLUSH_GRACE);
            std::process::exit(0);
        });
    }

    fn screenshot(&mut self, params: &Value, reply: Reply) {
        #[cfg(windows)]
        {
            let callback_reply = reply.clone();
            let result = self.screenshot_init_cdp(params, callback_reply);
            if let Err(error) = result {
                let _ = reply_after_error(reply, error);
            }
        }
        #[cfg(not(windows))]
        {
            let _ = params;
            let _ = reply_after_error(
                reply,
                RpcError::unsupported(
                    error_codes::SCREENSHOT_UNSUPPORTED,
                    concat!(
                        "このプラットフォームの WebView スクリーンショットは未実装です ",
                        "(Windows の WebView2 CDP のみ対応)",
                    ),
                ),
            );
        }
    }

    /// Initiate the CDP capture — the completion handler fires on the
    /// GUI thread's message pump, so the main thread must NOT block
    /// waiting for it (the pump IS the main thread). The wait happens on
    /// a helper thread. When a viewport is emulated the capture covers
    /// the FULL emulated viewport at 1:1 (clip + captureBeyondViewport),
    /// so the agent sees the resolution it asked for instead of the
    /// scaled window view.
    #[cfg(windows)]
    fn screenshot_init_cdp(&mut self, params: &Value, reply: Reply) -> Result<(), RpcError> {
        let webview = self.webview.as_ref().ok_or_else(|| {
            RpcError::not_open("ブラウザは開いていません (先に browser_open を呼んでください)")
        })?;
        let format = params
            .get("format")
            .and_then(Value::as_str)
            .unwrap_or("png");
        let quality = params.get("quality").and_then(Value::as_u64);
        let viewport = self.viewport;
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
        let format = format.to_string();
        cdp_call_async(
            webview,
            "Page.captureScreenshot",
            &cdp_params,
            reply,
            EVAL_TIMEOUT,
            move |answer| {
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
            },
        )
    }

    /// Windows wait: CDP Runtime.evaluate with awaitPromise (WebView2's
    /// ExecuteScript never awaits promises). The page-side wait still runs
    /// in the probe; only the eval vehicle differs.
    #[cfg(windows)]
    fn wait_cdp(&mut self, params: &Value, reply: Reply) {
        let callback_reply = reply.clone();
        let result = self.wait_cdp_init(params, callback_reply);
        if let Err(error) = result {
            let _ = reply_after_error(reply, error);
        }
    }

    #[cfg(windows)]
    fn wait_cdp_init(&mut self, params: &Value, reply: Reply) -> Result<(), RpcError> {
        let webview = self.webview.as_ref().ok_or_else(|| {
            RpcError::not_open("ブラウザは開いていません (先に browser_open を呼んでください)")
        })?;
        let probe_call = format!("return p.wait({args});", args = to_js_literal(params));
        let expression = driver(&probe_call);
        let timeout_ms = params
            .get("timeoutMs")
            .and_then(Value::as_u64)
            .unwrap_or(10_000);
        // The in-page wait deadline governs; the host adds headroom.
        let timeout = Duration::from_millis(timeout_ms) + WAIT_HEADROOM;
        let cdp_params = json!({
            "expression": expression,
            "awaitPromise": true,
            "returnByValue": true,
        });
        cdp_call_async(
            webview,
            "Runtime.evaluate",
            &cdp_params,
            reply,
            timeout,
            |result| {
                if let Some(details) = result.pointer("/result/exceptionDetails") {
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
                result.pointer("/result/value").cloned().ok_or_else(|| {
                    RpcError::new(error_codes::PROBE_ERROR, "CDP の応答形式が不正です")
                })
            },
        )
    }
}

/// The eval driver (same shape as the Desktop host): a catch-all IIFE.
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

/// JSON → JS literal for embedding into the driver.
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

/// The reply payload is the raw eval string; encode an RpcError into the
/// same shape when the main thread fails before any eval ran.
fn reply_after_error(reply: Reply, error: RpcError) -> Result<(), mpsc::SendError<String>> {
    let value = json!({
        "ok": false,
        "error": { "code": error.code, "message": error.message },
    });
    reply.send(serde_json::to_string(&value).unwrap_or_else(|_| "null".into()))
}

/// Send a `Result<Value, RpcError>`: the value on success, the error
/// shape on failure (never the Result enum itself).
fn send_value(reply: Reply, result: Result<Value, RpcError>) {
    match result {
        Ok(value) => {
            let _ = reply.send(serde_json::to_string(&value).unwrap_or_else(|_| "null".into()));
        }
        Err(error) => {
            let _ = reply_after_error(reply, error);
        }
    }
}

/// Apply `Emulation.setDeviceMetricsOverride` without waiting for the
/// reply: `reapply_emulation` runs on the GUI thread, whose message pump
/// delivers the completion — blocking here would deadlock the host. A
/// failed send loses only the fit update; the next open or resize
/// retries it.
#[cfg(windows)]
fn apply_device_metrics(
    webview: &WebView,
    viewport: (u32, u32),
    area_w: f64,
    area_h: f64,
) {
    use windows::core::HSTRING;
    use wry::WebViewExtWindows;

    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;

    let scale = emulation::fit_scale(viewport.0, viewport.1, area_w, area_h);
    let params = emulation::device_metrics_params(viewport.0, viewport.1, scale);
    let core_webview = webview.webview();
    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
        move |_status: windows::core::Result<()>, _result: String| Ok(()),
    ));
    let method = HSTRING::from("Emulation.setDeviceMetricsOverride");
    let cdp_params = HSTRING::from(params.to_string());
    let _ = unsafe { core_webview.CallDevToolsProtocolMethod(&method, &cdp_params, &handler) };
}

/// Initiate a WebView2 CDP call on the lab's controller and resolve the
/// reply on a helper thread. The completion handler fires on the GUI
/// thread's message pump, so this must NEVER block the calling thread
/// (the pump IS the main thread in this host). `parse` converts the raw
/// reply JSON into the RPC result.
#[cfg(windows)]
fn cdp_call_async(
    webview: &WebView,
    method: &str,
    cdp_params: &Value,
    reply: Reply,
    timeout: Duration,
    parse: impl FnOnce(Value) -> Result<Value, RpcError> + Send + 'static,
) -> Result<(), RpcError> {
    use windows::core::HSTRING;
    use wry::WebViewExtWindows;

    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;

    let core_webview: ICoreWebView2 = webview.webview();
    let (tx, rx) = mpsc::channel();
    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
        move |_status: windows::core::Result<()>, result: String| {
            let _ = tx.send(result);
            Ok(())
        },
    ));
    let method = HSTRING::from(method);
    let cdp_params = HSTRING::from(cdp_params.to_string());
    unsafe { core_webview.CallDevToolsProtocolMethod(&method, &cdp_params, &handler) }
        .map_err(|e| RpcError::internal(format!("CDP 呼び出しに失敗しました: {e}")))?;

    std::thread::spawn(move || {
        let outcome = rx
            .recv_timeout(timeout)
            .map_err(|_| RpcError::timeout("CDP の応答がタイムアウトしました"))
            .and_then(|raw| {
                let value: Value = serde_json::from_str(&raw).map_err(|e| {
                    RpcError::new(
                        error_codes::PROBE_ERROR,
                        format!("CDP の応答を解析できません: {e}"),
                    )
                })?;
                if let Some(error) = value.get("error") {
                    return Err(RpcError::new(
                        error_codes::ACTION_FAILED,
                        format!("CDP エラー: {error}"),
                    ));
                }
                parse(value)
            });
        send_value(reply, outcome);
    });
    Ok(())
}

/// Read `--name value` from args.
fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arg_value_parses_pair() {
        let args = vec!["--token".to_string(), "abc".to_string()];
        assert_eq!(arg_value(&args, "--token").as_deref(), Some("abc"));
        assert_eq!(arg_value(&args, "--nope"), None);
    }

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
        let value = json!({ "value": "a\u{2028}b\u{2029}c" });
        let literal = to_js_literal(&value);
        assert!(literal.contains("\\u2028"));
        assert!(literal.contains("\\u2029"));
    }
}
