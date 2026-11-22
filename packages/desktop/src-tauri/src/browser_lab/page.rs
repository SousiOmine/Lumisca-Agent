//! Driving the page: one probe call per observe/act, and the host-driven
//! wait.
//!
//! The same probe script runs on every platform (see
//! `lumisca_browser_rpc::eval`), so nothing here branches on the OS.

use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use lumisca_browser_rpc::eval::{
    driver, probe_method_of, to_js_literal, wait_pending, wait_timeout_ms, EVAL_TIMEOUT,
    PROBE_WAIT_BEGIN, PROBE_WAIT_POLL, WAIT_HEADROOM, WAIT_POLL_INTERVAL,
};
use lumisca_browser_rpc::{error_codes, RpcError};
use serde_json::{json, Value};
use tauri::WebviewWindow;

use super::busy_error;
use super::LabCore;
use crate::LockRecover;

impl LabCore {
    /// One probe call under the lab's single-eval lock. A busy lab is an
    /// error, never a queue — a stuck page must not accumulate requests.
    pub(super) fn eval_probe(
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
                    format!("cannot parse the probe response: {snippet}"),
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
    pub(super) fn wait(&self, params: &Value) -> Result<Value, RpcError> {
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
}
