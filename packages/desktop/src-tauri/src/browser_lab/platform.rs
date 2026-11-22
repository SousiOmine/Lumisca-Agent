//! The per-platform window handles the lab needs: WebView2's DevTools
//! Protocol on Windows, `WKWebView` on macOS and WebKitGTK on Linux.
//!
//! Each platform reaches its own WebView through `with_webview`, which hands
//! over the raw native view and runs the closure on the main thread. Only
//! the screenshot lives here: the probe channel, the viewport and the wait
//! are the same everywhere (see [`super::page`] and [`super::window`]).

use std::sync::mpsc;
#[cfg(windows)]
use std::time::Duration;

#[cfg(windows)]
use lumisca_browser_rpc::cdp;
#[cfg(not(windows))]
use lumisca_browser_rpc::eval::EVAL_TIMEOUT;
use lumisca_browser_rpc::{error_codes, RpcError};
use serde_json::Value;
use tauri::WebviewWindow;

#[cfg(not(windows))]
use super::screenshot::image_result;
use super::LabCore;

/// How long the page gets to answer a CDP method call (Windows only: the
/// CDP transport is WebView2's).
#[cfg(windows)]
const CDP_TIMEOUT: Duration = Duration::from_secs(8);

impl LabCore {
    /// Windows: WebView2 speaks the DevTools Protocol, and the capture is
    /// taken straight on the controller — no remote debugging port is ever
    /// opened. The clip covers the FULL agent viewport at 1:1 (1 CSS px = 1
    /// image px), so the agent sees the resolution it asked for instead of
    /// the scaled window view.
    #[cfg(windows)]
    pub(super) fn screenshot_impl(
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
    pub(super) fn screenshot_impl(
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
    pub(super) fn screenshot_impl(
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
    pub(super) fn cdp_call_sync(
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
                format!("cannot parse the CDP response: {e}"),
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
}
