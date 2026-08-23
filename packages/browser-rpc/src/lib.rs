//! lumisca-browser-rpc: protocol pieces shared by the two browser-lab
//! hosts — the Desktop shell (packages/desktop/src-tauri) and the CLI
//! browser host (packages/browser-host).
//!
//! Both hosts serve the SAME RPC protocol to the Deno side (see
//! packages/core/browser/types.ts): POST /rpc with a random-token header,
//! JSON bodies, strict size limits, explicit errors — no fallbacks. This
//! crate provides the probe extraction, the URL policy (defense in depth —
//! the Deno tools enforce it first), and a minimal HTTP/1.1 server so the
//! hosts share one implementation instead of drifting.

pub mod emulation;
pub mod policy;
pub mod probe;
pub mod rpc;
pub mod server;

pub use rpc::{RpcError, RpcReply};
pub use server::{RpcHandler, RpcServer};

/// Size limits; mirror packages/core/browser/types.ts.
pub mod limits {
    /// Max RPC request body (bytes).
    pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
    /// Max RPC response body (bytes).
    pub const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
    /// Max screenshot payload (bytes of base64 text).
    pub const MAX_SCREENSHOT_BYTES: usize = 8 * 1024 * 1024;
}

/// RPC method names; mirror packages/core/browser/types.ts.
pub mod methods {
    pub const OPEN: &str = "open";
    pub const OBSERVE: &str = "observe";
    pub const ACT: &str = "act";
    pub const WAIT: &str = "wait";
    pub const SCREENSHOT: &str = "screenshot";
    pub const CLOSE: &str = "close";
}

/// Stable RPC error codes; mirror packages/core/browser/types.ts.
pub mod error_codes {
    pub const NOT_OPEN: &str = "not_open";
    pub const REF_NOT_FOUND: &str = "ref_not_found";
    pub const PROBE_MISSING: &str = "probe_missing";
    pub const PROBE_ERROR: &str = "probe_error";
    pub const ACTION_FAILED: &str = "action_failed";
    pub const WAIT_UNSUPPORTED: &str = "wait_unsupported";
    pub const SCREENSHOT_UNSUPPORTED: &str = "screenshot_unsupported";
    pub const TIMEOUT: &str = "timeout";
    pub const TOO_LARGE: &str = "too_large";
    pub const CLOSED: &str = "closed";
    pub const AUTH: &str = "auth";
    pub const INVALID: &str = "invalid";
    pub const INTERNAL: &str = "internal";
}

/// The token header name; mirror packages/core/browser/types.ts.
pub const TOKEN_HEADER: &str = "x-lumisca-browser-token";
/// The RPC path.
pub const RPC_PATH: &str = "/rpc";
