//! A minimal HTTP/1.1 server for the browser-lab RPC protocol.
//!
//! Deliberately dependency-free beyond std: the protocol is one POST to
//! /rpc with a JSON body and a token header. Highlights:
//! - binds 127.0.0.1 only (the caller picks the port; the host prints it)
//! - every request is authenticated against the per-run random token
//! - request bodies capped (413), responses capped (no unbounded replies)
//! - one request per connection (Connection: close) — simplicity over
//!   throughput for a local debug channel
//! - each connection handled on its own thread; the handler is the host's
//!   own dispatcher (blocking is fine — hosts run their own deadlines)

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::Value;

use crate::limits;
use crate::rpc::{parse_request, RpcError, RpcReply};
use crate::TOKEN_HEADER;

/// The host-side dispatcher: turns one RPC method call into a reply.
/// Implementations may be long-running (observe waits for the page);
/// the server itself does not impose deadlines — hosts do.
pub trait RpcHandler: Send + Sync + 'static {
    fn handle(&self, method: &str, params: Value) -> Result<Value, RpcError>;
}

/// A running RPC server: the listener thread plus the shared last-request
/// clock (used by hosts for their idle timeout).
pub struct RpcServer {
    /// Port the listener is bound to (127.0.0.1).
    pub port: u16,
    /// Monotonic millis of the last authenticated request, or 0 when none
    /// arrived yet. Hosts read this for their idle timeout.
    pub last_request_at: Arc<AtomicU64>,
    handle: Option<JoinHandle<()>>,
    stop: Arc<std::sync::atomic::AtomicBool>,
}

impl RpcServer {
    /// Bind 127.0.0.1:{port} (port 0 → ephemeral) and start serving.
    /// Returns the running server; drop it or call [`RpcServer::stop`] to
    /// shut the listener down.
    pub fn start(
        port: u16,
        token: String,
        handler: Arc<dyn RpcHandler>,
        connect_timeout: Duration,
    ) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", port))
            .map_err(|e| format!("cannot start the browser RPC server: {e}"))?;
        // Non-blocking accept + flag polling: stop() must be able to join
        // this thread even while it is waiting for connections (a blocking
        // accept could never be woken).
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("listener setup failed: {e}"))?;
        let bound_port = listener
            .local_addr()
            .map_err(|e| format!("listener address unavailable: {e}"))?
            .port();
        let last_request_at = Arc::new(AtomicU64::new(0));
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_flag = stop.clone();
        let clock = last_request_at.clone();
        let handle = thread::Builder::new()
            .name("lumisca-browser-rpc".into())
            .spawn(move || {
                loop {
                    if stop_flag.load(Ordering::Relaxed) {
                        break;
                    }
                    match listener.accept() {
                        Ok((stream, _)) => {
                            // BSD/macOS inherits O_NONBLOCK from the listener
                            // on accept (Linux does not), which would make the
                            // first read return WouldBlock before the client's
                            // bytes arrive: the handler would drop the stream
                            // with the request unread and the client would see
                            // ECONNRESET. Accepted connections must block.
                            let _ = stream.set_nonblocking(false);
                            let token = token.clone();
                            let handler = handler.clone();
                            let clock = clock.clone();
                            let _ = thread::Builder::new()
                                .name("lumisca-browser-conn".into())
                                .spawn(move || {
                                    let _ = handle_connection(
                                        stream,
                                        &token,
                                        handler.as_ref(),
                                        &clock,
                                        connect_timeout,
                                    );
                                });
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(50));
                        }
                        Err(_) => {
                            if stop_flag.load(Ordering::Relaxed) {
                                break;
                            }
                            // transient accept error — keep serving
                            thread::sleep(Duration::from_millis(50));
                        }
                    }
                }
            })
            .map_err(|e| format!("listener thread failed: {e}"))?;
        Ok(RpcServer {
            port: bound_port,
            last_request_at,
            handle: Some(handle),
            stop,
        })
    }

    /// Stop accepting connections (in-flight handlers finish on their
    /// own). Idempotent.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for RpcServer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// One connection: read the request, authenticate, dispatch, reply.
fn handle_connection(
    stream: TcpStream,
    token: &str,
    handler: &dyn RpcHandler,
    clock: &AtomicU64,
    connect_timeout: Duration,
) -> std::io::Result<()> {
    let _ = stream.set_read_timeout(Some(connect_timeout));
    let _ = stream.set_write_timeout(Some(connect_timeout));
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(()); // client closed before sending anything
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    // Consume headers.
    let mut content_length: Option<usize> = None;
    let mut supplied_token: Option<String> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            let name = name.trim().to_ascii_lowercase();
            let value = value.trim().to_string();
            if name == "content-length" {
                content_length = value.parse::<usize>().ok();
            } else if name == TOKEN_HEADER {
                supplied_token = Some(value);
            }
        }
    }
    let reply = dispatch(
        method.as_str(),
        path.as_str(),
        content_length,
        supplied_token.as_deref(),
        token,
        reader,
        handler,
        clock,
    )?;
    let mut out = stream;
    out.write_all(reply.as_bytes())?;
    out.flush()
}

#[allow(clippy::too_many_arguments)]
fn dispatch(
    method: &str,
    path: &str,
    content_length: Option<usize>,
    supplied_token: Option<&str>,
    expected_token: &str,
    mut reader: BufReader<TcpStream>,
    handler: &dyn RpcHandler,
    clock: &AtomicU64,
) -> std::io::Result<String> {
    // 404 for anything but POST /rpc.
    if method != "POST" || path != crate::RPC_PATH {
        return Ok(http_response(
            404,
            r#"{"ok":false,"error":{"code":"invalid","message":"not found"}}"#,
        ));
    }
    // Token gate first: refuse to even read the body of an unknown caller.
    let token_ok = match supplied_token {
        Some(supplied) => {
            // Constant-time-ish comparison for a local token (length leak
            // is irrelevant; timing is not).
            supplied.len() == expected_token.len()
                && supplied
                    .as_bytes()
                    .iter()
                    .zip(expected_token.as_bytes())
                    .all(|(a, b)| a == b)
        }
        None => false,
    };
    if !token_ok {
        return Ok(http_response(
            401,
            r#"{"ok":false,"error":{"code":"auth","message":"invalid token"}}"#,
        ));
    }
    // Bounded body read.
    let length = match content_length {
        Some(n) if n <= limits::MAX_REQUEST_BYTES => n,
        Some(_) => {
            return Ok(http_response(
                413,
                r#"{"ok":false,"error":{"code":"too_large","message":"request body too large"}}"#,
            ));
        }
        None => 0,
    };
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    let request = match parse_request(&body, limits::MAX_REQUEST_BYTES) {
        Ok(request) => request,
        Err(error) => {
            let id = 0u64;
            return Ok(http_response(400, &RpcReply::failure(id, error).to_json()));
        }
    };
    clock.store(millis(), Ordering::Relaxed);
    let result = handler.handle(&request.method, request.params.clone());
    let reply = match result {
        Ok(value) => RpcReply::success(request.id, value),
        Err(error) => RpcReply::failure(request.id, error),
    };
    let json = reply.to_json();
    if json.len() > limits::MAX_RESPONSE_BYTES {
        // The host produced an oversized reply — surface it as an error
        // instead of shipping megabytes to the agent.
        let error = RpcReply::failure(
            request.id,
            RpcError::too_large(format!(
                "browser host response is too large ({} bytes)",
                json.len()
            )),
        );
        return Ok(http_response(200, &error.to_json()));
    }
    Ok(http_response(200, &json))
}

fn http_response(status: u16, body: &str) -> String {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        413 => "Payload Too Large",
        _ => "Internal Server Error",
    };
    let head = format!(
        concat!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\n",
            "Content-Length: {len}\r\nConnection: close\r\n",
            "Access-Control-Allow-Origin: *\r\n\r\n",
        ),
        status = status,
        reason = reason,
        len = body.len(),
    );
    format!("{head}{body}")
}

fn millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct EchoHandler {
        seen: Mutex<Vec<(String, Value)>>,
    }

    impl RpcHandler for EchoHandler {
        fn handle(&self, method: &str, params: Value) -> Result<Value, RpcError> {
            self.seen
                .lock()
                .unwrap()
                .push((method.to_string(), params.clone()));
            if method == "boom" {
                return Err(RpcError::new(crate::error_codes::ACTION_FAILED, "boom"));
            }
            Ok(params)
        }
    }

    fn post(url: &str, token: &str, body: &str) -> (u16, String) {
        let mut stream = TcpStream::connect(url).expect("connect");
        send_over(&mut stream, url, token, body)
    }

    /// The request/reply half of [`post`], over a connection the caller
    /// already holds (so a test can let the server accept it first).
    fn send_over(stream: &mut TcpStream, url: &str, token: &str, body: &str) -> (u16, String) {
        let request = format!(
            concat!(
                "POST /rpc HTTP/1.1\r\nHost: {url}\r\nContent-Type: application/json\r\n",
                "{token_header}: {token}\r\nContent-Length: {len}\r\n",
                "Connection: close\r\n\r\n{body}",
            ),
            url = url,
            token_header = TOKEN_HEADER,
            token = token,
            len = body.len(),
            body = body,
        );
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        let status: u16 = response
            .lines()
            .next()
            .unwrap_or("")
            .split_whitespace()
            .nth(1)
            .unwrap_or("000")
            .parse()
            .unwrap_or(0);
        let json = response.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
        (status, json)
    }

    fn start_server() -> RpcServer {
        let handler = Arc::new(EchoHandler {
            seen: Mutex::new(Vec::new()),
        });
        RpcServer::start(0, "sekrit".into(), handler, Duration::from_secs(5)).unwrap()
    }

    #[test]
    fn authenticated_round_trip() {
        let server = start_server();
        let url = format!("127.0.0.1:{}", server.port);
        let (status, json) = post(
            &url,
            "sekrit",
            r#"{"id":1,"method":"observe","params":{"a":1}}"#,
        );
        assert_eq!(status, 200);
        let parsed: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["id"], 1);
        assert_eq!(parsed["result"]["a"], 1);
        assert!(server.last_request_at.load(Ordering::Relaxed) > 0);
    }

    // Regression test for a macOS-only failure: `accept` inherits
    // O_NONBLOCK from the non-blocking listener there (Linux clears it), so
    // a request whose bytes had not arrived yet hit WouldBlock, the handler
    // closed the socket, and the client got ECONNRESET instead of a reply.
    // Waiting before the first write makes that window wide enough to hit on
    // every platform.
    #[test]
    fn a_request_that_arrives_late_is_still_answered() {
        let server = start_server();
        let url = format!("127.0.0.1:{}", server.port);
        let mut stream = TcpStream::connect(&url).expect("connect");
        std::thread::sleep(Duration::from_millis(200));
        let (status, json) = send_over(
            &mut stream,
            &url,
            "sekrit",
            r#"{"id":1,"method":"observe","params":{}}"#,
        );
        assert_eq!(status, 200, "reply: {json}");
        assert!(json.contains(r#""ok":true"#), "reply: {json}");
    }

    #[test]
    fn wrong_token_is_401() {
        let server = start_server();
        let url = format!("127.0.0.1:{}", server.port);
        let (status, json) = post(&url, "wrong", r#"{"id":1,"method":"observe"}"#);
        assert_eq!(status, 401);
        let parsed: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["error"]["code"], "auth");
    }

    #[test]
    fn missing_token_is_401() {
        let server = start_server();
        let url = format!("127.0.0.1:{}", server.port);
        let mut stream = TcpStream::connect(&url).unwrap();
        stream
            .write_all(b"POST /rpc HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}")
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 401"));
    }

    #[test]
    fn unknown_path_or_method_is_404() {
        let server = start_server();
        let url = format!("127.0.0.1:{}", server.port);
        let mut stream = TcpStream::connect(&url).unwrap();
        stream.write_all(b"GET /rpc HTTP/1.1\r\n\r\n").unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 404"));
    }

    #[test]
    fn oversized_body_is_413() {
        let server = start_server();
        let url = format!("127.0.0.1:{}", server.port);
        // The server rejects on Content-Length alone and never reads the
        // body — send the header with an empty body (writing the big body
        // would hit the RST the server's close causes).
        let request = format!(
            "POST /rpc HTTP/1.1\r\n{}: sekrit\r\nContent-Length: {}\r\n\r\n",
            TOKEN_HEADER,
            limits::MAX_REQUEST_BYTES + 1
        );
        let mut stream = TcpStream::connect(&url).unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 413"));
    }

    #[test]
    fn handler_errors_become_rpc_failures() {
        let server = start_server();
        let url = format!("127.0.0.1:{}", server.port);
        let (status, json) = post(&url, "sekrit", r#"{"id":5,"method":"boom"}"#);
        assert_eq!(status, 200);
        let parsed: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["ok"], false);
        assert_eq!(parsed["error"]["code"], "action_failed");
    }

    #[test]
    fn the_listener_binds_loopback_only() {
        // `start()` binds 127.0.0.1 explicitly; this checks the consequence
        // that matters rather than the constant. The port is not reachable
        // on this machine's own non-loopback address, which is what a token
        // holder on the network would need to drive the page.
        let server = start_server();
        let loopback = format!("127.0.0.1:{}", server.port);
        TcpStream::connect(&loopback)
            .expect("the server must answer on loopback")
            .shutdown(std::net::Shutdown::Both)
            .ok();

        // The first address of this host that is not loopback. A machine
        // with nothing but loopback (a CI sandbox) has nothing to prove
        // here, so the test says so instead of passing vacuously.
        let external = local_addresses()
            .into_iter()
            .find(|ip| !ip.is_loopback() && !ip.is_unspecified());
        match external {
            Some(ip) => {
                let target = format!("{}:{}", ip, server.port);
                let refused = TcpStream::connect_timeout(
                    &target.parse().expect("address parses"),
                    Duration::from_millis(500),
                );
                assert!(
                    refused.is_err(),
                    "the RPC port must not answer on {target}: the server \\
                     binds loopback only"
                );
            }
            None => eprintln!("no non-loopback address on this host: skipped"),
        }
    }

    /// The IP addresses this host holds, read from the local routing table.
    /// `UdpSocket::connect` picks the source address without sending
    /// anything, and a DNS lookup of the host name covers the rest; both are
    /// best-effort, so an empty list is a valid answer.
    fn local_addresses() -> Vec<std::net::IpAddr> {
        let mut found = Vec::new();
        for probe in ["192.0.2.1:9", "198.51.100.1:9"] {
            if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
                if socket.connect(probe).is_ok() {
                    if let Ok(local) = socket.local_addr() {
                        found.push(local.ip());
                    }
                }
            }
        }
        found.sort();
        found.dedup();
        found
    }
}
