//! The lab's lifecycle: the loopback RPC listener the agent calls, the
//! single window it drives, and the RPC methods that open and close it.

use std::sync::Arc;
use std::time::Duration;

use lumisca_browser_rpc::eval::EVAL_TIMEOUT;
use lumisca_browser_rpc::server::RpcHandler;
use lumisca_browser_rpc::viewport;
use lumisca_browser_rpc::{methods, policy, RpcError};
use serde_json::{json, Value};
use tauri::AppHandle;

use super::LabCore;
use crate::LockRecover;

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
        let core = Arc::new(LabCore::new(app)?);
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

    /// The caller (server.rs) embeds these into the server child's
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

    /// Forget a lab window that is gone (the user closed it, or `close`
    /// ran), so every later call answers `not_open` instead of driving a
    /// dead handle.
    pub(super) fn forget_window(&self) {
        *self.core.window.lock_recover() = None;
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
        // Host-side policy enforcement (the server validates first).
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
