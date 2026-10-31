//! The shell bridge, served over loopback HTTP.
//!
//! The settings UI is served by the (possibly remote) server, so it cannot
//! call Tauri commands. It drives the shell through this listener instead:
//! `GET http://127.0.0.1:<port>/shell/<action>?...`, with the current
//! server's token as `key` (see `bridge::handle_shell_action`).
//!
//! Why a listener and not a custom URI scheme: WKWebView (macOS) refuses to
//! fetch a non-http scheme from an http(s) page — the request is a
//! cross-origin fetch to a scheme the engine does not treat as CORS-capable
//! — so every bridge call failed there and the title bar (connection picker
//! and window controls) never rendered at all. WebView2 (Windows) re-homes
//! custom schemes to http, which is why the same code worked there, and why
//! Tauri's own IPC falls back to `postMessage` when its `ipc://` fetch fails.
//! A loopback listener is ordinary HTTP for all three engines, and it is
//! also reachable from a page served by a remote machine over https (loopback
//! is a potentially trustworthy origin, so it is not mixed content).
//!
//! The port is chosen by the OS (bind to 0) and handed to the page through
//! `window.__LUMISCA_BRIDGE__`, injected as the main window's initialization
//! script (see `main_window_initialization_script`).

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use tauri::AppHandle;

/// How long one connection may take to send its request line (a browser
/// preconnect, a port scanner, an abandoned fetch).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// The listener plus the stop flag its thread polls.
pub(crate) struct BridgeServer {
    port: u16,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl BridgeServer {
    /// Bind loopback and answer requests until dropped.
    pub(crate) fn start(app: AppHandle) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|e| format!("シェルブリッジを起動できません: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("シェルブリッジのアドレスを取得できません: {e}"))?
            .port();
        // Non-blocking accept, so dropping the server can join this thread
        // instead of waiting for a connection that never comes.
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("シェルブリッジの待ち受け設定に失敗しました: {e}"))?;
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = stop.clone();
        let handle = thread::Builder::new()
            .name("lumisca-shell-bridge".into())
            .spawn(move || {
                while !stop_flag.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            // BSD/macOS inherits O_NONBLOCK from the listener
                            // on accept (Linux does not), which would make the
                            // first read return WouldBlock before the request
                            // line arrives.
                            let _ = stream.set_nonblocking(false);
                            // One connection per action, each on its own
                            // thread: several actions wait by design
                            // (`pick-folder` opens a modal, `connect-local`
                            // polls for up to 30s) and must not queue.
                            let app = app.clone();
                            let _ = thread::Builder::new()
                                .name("lumisca-shell-bridge-conn".into())
                                .spawn(move || serve_connection(&app, stream));
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(20));
                        }
                        Err(_) => {
                            if stop_flag.load(Ordering::Relaxed) {
                                break;
                            }
                            thread::sleep(Duration::from_millis(20));
                        }
                    }
                }
            })
            .map_err(|e| format!("シェルブリッジのスレッドを起動できません: {e}"))?;
        Ok(BridgeServer {
            port,
            stop,
            handle: Some(handle),
        })
    }

    /// The origin the page talks to (`http://127.0.0.1:<port>`).
    pub(crate) fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

impl Drop for BridgeServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// Read one request line and answer it. The body of the request is ignored:
/// every action is a GET whose parameters are in the query string, which
/// keeps the bridge out of preflight (simple request) and out of any request
/// body handling.
fn serve_connection(app: &AppHandle, mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(REQUEST_TIMEOUT));
    let _ = stream.set_write_timeout(Some(REQUEST_TIMEOUT));
    let Ok(reader_stream) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(reader_stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    // `GET /shell/state?key=... HTTP/1.1`
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or("/");
    if method != "GET" {
        write_response(&mut stream, 405, "Method Not Allowed", b"{}");
        return;
    }

    // Absolute form so the parser yields path + query without a Host header.
    let Some((action, params)) = parse_target(target) else {
        write_response(&mut stream, 400, "Bad Request", b"{}");
        return;
    };
    let (status, body) = crate::bridge::handle_shell_action(app, &action, &params);
    write_response(&mut stream, status.as_u16(), status.as_str(), &body);
}

/// Split `/shell/<action>?a=b` into the action and its parameters. Returns
/// None when the path is not under `/shell/` (a mistyped URL, not an action).
fn parse_target(target: &str) -> Option<(String, Vec<(String, String)>)> {
    let url = format!("http://127.0.0.1{target}")
        .parse::<url::Url>()
        .ok()?;
    let path = url.path().strip_prefix("/shell/")?;
    if path.is_empty() {
        return None;
    }
    Some((path.to_string(), url.query_pairs().into_owned().collect()))
}

fn write_response(stream: &mut TcpStream, status: u16, reason: &str, body: &[u8]) {
    let mut head = format!("HTTP/1.1 {status} {reason}\r\n");
    head.push_str("Content-Type: application/json\r\n");
    // Any page the shell displays may call the bridge, including one served
    // by a remote machine; the action handler's key gate is what
    // authenticates the caller.
    head.push_str("Access-Control-Allow-Origin: *\r\n");
    head.push_str("Cache-Control: no-store\r\n");
    head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    head.push_str("Connection: close\r\n\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

/// The script a window starts every page with: where the bridge is. It must
/// be an initialization script (not an inline script in the page), because
/// the page is served by the server and its CSP bans inline scripts, and
/// because every navigation of this window — the splash, the local server,
/// a remote server — has to receive it.
pub(crate) fn main_window_initialization_script(origin: &str) -> String {
    format!(
        "window.__LUMISCA_BRIDGE__ = {};",
        serde_json::to_string(&format!("{origin}/shell")).unwrap_or_default()
    )
}

/// The OS this shell runs on, named the way the page's window controls
/// expect (`macos` / `windows` / `linux`). The page cannot derive it from
/// its own environment: it is served by a possibly remote machine.
pub(crate) fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}
