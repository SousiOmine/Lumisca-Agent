//! The shell bridge, served over loopback HTTP.
//!
//! The bundled UI cannot call Tauri commands over the loopback listener, so
//! it drives the shell through this listener instead:
//! `GET http://127.0.0.1:<port>/shell/<action>?...`, with the current
//! server's token as `key` (see `bridge::handle_shell_action`). Only the
//! bundled UI's origins may call it; a page served by any other origin is
//! refused before its action is read.
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

/// Origins the bundled UI is served from: `tauri://localhost` on macOS and
/// Linux, `http://tauri.localhost` on Windows. Any other page that reaches
/// this port — a website open in the same browser, a document served by a
/// remote server — is refused before its action is looked at. A request
/// without an Origin is a non-browser client; the action handler's key gate
/// is what authenticates those.
const ALLOWED_ORIGINS: [&str; 2] = ["tauri://localhost", "http://tauri.localhost"];

fn origin_allowed(origin: Option<&str>) -> bool {
    match origin {
        None => true,
        Some(origin) => ALLOWED_ORIGINS.contains(&origin),
    }
}

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

/// One request's first line and the headers this listener reads.
struct RequestHead {
    method: String,
    target: String,
    origin: Option<String>,
}

/// Read the request line and headers up to the blank line. The body is
/// ignored: every action is a GET whose parameters are in the query string.
fn read_request_head(reader: &mut BufReader<TcpStream>) -> Option<RequestHead> {
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return None;
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let mut origin: Option<String> = None;
    let mut total = request_line.len();
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        total += line.len();
        if total > 16 * 1024 || line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("origin") {
                origin = Some(value.trim().to_string());
            }
        }
    }
    Some(RequestHead {
        method,
        target,
        origin,
    })
}

/// Read one request and answer it.
fn serve_connection(app: &AppHandle, mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(REQUEST_TIMEOUT));
    let _ = stream.set_write_timeout(Some(REQUEST_TIMEOUT));
    let Ok(reader_stream) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(reader_stream);
    let Some(head) = read_request_head(&mut reader) else {
        return;
    };
    let origin = head.origin.as_deref();
    // Refuse a foreign page before looking at the action: the bundled UI is
    // the only document this listener serves a purpose for.
    if !origin_allowed(origin) {
        write_response(&mut stream, 403, "Forbidden", b"{}", origin);
        return;
    }
    if head.method == "OPTIONS" {
        write_response(&mut stream, 204, "No Content", b"", origin);
        return;
    }
    if head.method != "GET" {
        write_response(&mut stream, 405, "Method Not Allowed", b"{}", origin);
        return;
    }

    // Absolute form so the parser yields path + query without a Host header.
    let Some((action, params)) = parse_target(&head.target) else {
        write_response(&mut stream, 400, "Bad Request", b"{}", origin);
        return;
    };
    let (status, body) = crate::bridge::handle_shell_action(app, &action, &params);
    write_response(&mut stream, status.as_u16(), status.as_str(), &body, origin);
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

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    body: &[u8],
    origin: Option<&str>,
) {
    let mut head = format!("HTTP/1.1 {status} {reason}\r\n");
    head.push_str("Content-Type: application/json\r\n");
    // Echo only an origin this listener accepts. The old `*` let any page
    // read answers, and `connections/list` used to carry every token.
    if let Some(origin) = origin {
        head.push_str(&format!("Access-Control-Allow-Origin: {origin}\r\n"));
        head.push_str("Access-Control-Allow-Methods: GET, OPTIONS\r\n");
        head.push_str("Access-Control-Allow-Headers: content-type\r\n");
    }
    head.push_str("Vary: Origin\r\n");
    head.push_str("Cache-Control: no-store\r\n");
    head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    head.push_str("Connection: close\r\n\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

/// The script a window starts every page with: where the bridge is, and which
/// OS draws the window. It must be an initialization script (not an inline
/// script in the page), because the page is served by the server and its CSP
/// bans inline scripts, and because every navigation of this window — the
/// splash, the local server, a remote server — has to receive it.
///
/// The platform is a fact about the window, not about the page: the page may
/// be served by a remote machine, so its own environment answers nothing. It
/// travels here rather than in the bridge's `state` because the window
/// controls have to be drawn before (and even without) a bridge answer: a
/// title bar that waited for one disappeared entirely whenever the bridge
/// refused a call.
pub(crate) fn main_window_initialization_script(origin: &str) -> String {
    format!(
        "window.__LUMISCA_BRIDGE__ = {}; window.__LUMISCA_PLATFORM__ = {};",
        serde_json::to_string(&format!("{origin}/shell")).unwrap_or_default(),
        serde_json::to_string(platform_name()).unwrap_or_default()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_bundled_ui_origins_are_accepted() {
        assert!(origin_allowed(None));
        assert!(origin_allowed(Some("tauri://localhost")));
        assert!(origin_allowed(Some("http://tauri.localhost")));
        assert!(!origin_allowed(Some("https://evil.example.com")));
        assert!(!origin_allowed(Some("http://127.0.0.1:8000")));
    }

    /// The script carries both facts the page reads before it renders: the
    /// bridge's origin and the OS. The window controls are drawn from the
    /// second one alone, so a script that dropped it would leave the page
    /// unable to tell macOS (native traffic lights) from Windows and Linux
    /// (drawn buttons) — and the title bar would draw the wrong chrome.
    #[test]
    fn the_initialization_script_names_the_bridge_and_the_platform() {
        let script = main_window_initialization_script("http://127.0.0.1:1234");
        assert!(script.contains(r#"window.__LUMISCA_BRIDGE__ = "http://127.0.0.1:1234/shell";"#));
        assert!(script.contains(&format!(
            r#"window.__LUMISCA_PLATFORM__ = "{}";"#,
            platform_name()
        )));
    }
}
