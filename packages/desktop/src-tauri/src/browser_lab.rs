//! Browser lab: the Desktop's debug WebView, exposed to the agent running
//! in the local (Bun) server as an authenticated loopback RPC endpoint.
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
//! from the lab page is denied by the ACL. The shell bridge (bridge_server)
//! is unreachable from the lab page for the same reason: every action
//! requires the displayed server's token as `key`, which the lab page never
//! has, and the bridge's origin is injected into the main window only.
//!
//! Where each piece lives: [`session`] runs the RPC listener and its
//! open/close methods, [`window`] creates, sizes and destroys the lab window,
//! [`page`] drives the probe (observe/act/wait), [`screenshot`] states the
//! format rules and the reply shape, and [`platform`] holds the one capture
//! implementation each OS has.

mod page;
mod platform;
mod screenshot;
mod session;
mod window;

use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::{mpsc, Arc, Mutex};

use lumisca_browser_rpc::probe;
use lumisca_browser_rpc::{error_codes, RpcError};
use tauri::{AppHandle, Manager, WebviewWindow};

pub use session::BrowserLab;

use crate::{AppState, LockRecover};

/// Label of the lab window. Deliberately NOT covered by any capability
/// file, so the lab page can never call Tauri IPC (see the module docs).
pub const LAB_WINDOW_LABEL: &str = "browser-lab";

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
    /// server always sends explicit values; the protocol default is
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

impl LabCore {
    /// Shared state of one lab. Fails when the probe cannot be extracted,
    /// which leaves the agent without browser tools — the "no browser
    /// surface" state [`BrowserLab::start`] reports to its caller.
    fn new(app: &AppHandle) -> Result<LabCore, String> {
        Ok(LabCore {
            app: app.clone(),
            window: Mutex::new(None),
            visible: Mutex::new(false),
            viewport: Mutex::new(None),
            busy: Mutex::new(()),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_req: AtomicU64::new(1),
            probe_source: probe::extract().map_err(|e| format!("ブラウザ: {e}"))?,
        })
    }
}

/// The one error a call gets while another page operation is in flight.
pub(super) fn busy_error() -> RpcError {
    RpcError::new(
        error_codes::TIMEOUT,
        "ブラウザは前の操作を処理中です（ページが応答しない可能性があります）",
    )
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
            lab.forget_window();
        }
    }
}
