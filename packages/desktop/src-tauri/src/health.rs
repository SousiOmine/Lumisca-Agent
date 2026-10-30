//! The one HTTP probe this shell makes: `GET /api/health`.
//!
//! Two transports answer it — plain TCP for a loopback server, `reqwest` for
//! a remote one behind TLS — because a compiled server needs no TLS stack and
//! a remote host does. Both poll the same way and classify failures the same
//! way, so the caller only sees "healthy" or a [`HealthFailure`].

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

/// Poll interval while waiting for a server to come up (a compiled server
/// answers in ~0.3s; a fast poll keeps the switch to the app page snappy).
pub(crate) const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Transport of a remote server URL. Lumisca itself always listens on
/// plain HTTP — TLS for a remote server is terminated in FRONT of it
/// (`tailscale serve`, a reverse proxy, …), so `https` only describes the
/// hop from this shell to that front end.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Scheme {
    Http,
    Https,
}

/// Per-attempt ceiling of one HTTPS probe. `timeout` is the caller's total
/// budget across retries (the startup path polls a server that is still
/// booting); a single TLS handshake must not be allowed to consume all of
/// it.
const HTTPS_HEALTH_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(2);

/// Install the process-wide rustls crypto provider (ring), once. reqwest is
/// built with `rustls-no-provider` (the feature tauri-plugin-updater
/// enables), which deliberately ships no provider: building a client
/// without one panics. The updater installs ring on its own first use, but
/// not necessarily before this shell's first health check, so the provider
/// is installed here — idempotent, and a no-op when someone got there
/// first.
pub(crate) fn install_crypto_provider() {
    static INSTALL: std::sync::Once = std::sync::Once::new();
    INSTALL.call_once(|| {
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
    });
}

/// Bracketed IPv6 literals for Host headers, URLs and connect addresses.
pub(crate) fn host_label(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

/// Why a health probe failed. The boolean callers (the local startup loops)
/// only need to know *that* it failed, but a server the user just typed in
/// deserves the difference: "nothing answered" (wrong address, front end
/// down) and "the server refused us" (403 from the Host guard, 401 from a
/// mistyped token) are fixed in completely different places.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum HealthFailure {
    /// No usable answer within the budget: connection refused, DNS failure,
    /// TLS handshake failure, timeout.
    Unreachable,
    /// The server answered with a status other than 200.
    Status(u16),
}

/// Check a server's GET /api/health. `host` may be a hostname or an IP
/// literal; `token` is optional (servers without token auth answer without
/// it). The Host header names the target host so the server's Host guard
/// accepts the probe. Replaces a bare TCP connect, which would accept ANY
/// process on the port — e.g. a stale server with a different database.
pub(crate) fn health_check(
    scheme: Scheme,
    host: &str,
    port: u16,
    token: Option<&str>,
    timeout: Duration,
) -> Result<(), HealthFailure> {
    match scheme {
        Scheme::Http => health_check_http(host, port, token, timeout),
        Scheme::Https => health_check_https(host, port, token, timeout),
    }
}

/// Status code of an HTTP/1.x response head, or None when the bytes are not
/// one (a truncated read, a non-HTTP answer on the port).
fn status_of(head: &str) -> Option<u16> {
    let mut parts = head.split_whitespace();
    if !parts.next()?.starts_with("HTTP/") {
        return None;
    }
    parts.next()?.parse().ok()
}

/// Plain HTTP probe, spoken over raw TCP: the local server path, kept free
/// of dependencies and of the TLS client's per-call worker thread.
fn health_check_http(
    host: &str,
    port: u16,
    token: Option<&str>,
    timeout: Duration,
) -> Result<(), HealthFailure> {
    let deadline = Instant::now() + timeout;
    let host_label = host_label(host);
    let mut request = format!("GET /api/health HTTP/1.1\r\nHost: {host_label}:{port}\r\n");
    if let Some(t) = token {
        request.push_str(&format!("X-Lumisca-Token: {t}\r\n"));
    }
    request.push_str("Connection: close\r\n\r\n");
    let addr = format!("{host_label}:{port}");
    // An answer that is not a 200 is remembered: a server that refuses us
    // (403 Host guard, 401 token) is up, and reporting it as unreachable
    // would send the user looking for a network problem.
    let mut failure = HealthFailure::Unreachable;
    while Instant::now() < deadline {
        if let Ok(mut stream) = TcpStream::connect(addr.as_str()) {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
            let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
            if stream.write_all(request.as_bytes()).is_ok() {
                let mut buf = [0u8; 256];
                if let Ok(n) = stream.read(&mut buf) {
                    match status_of(&String::from_utf8_lossy(&buf[..n])) {
                        Some(200) => return Ok(()),
                        Some(status) => failure = HealthFailure::Status(status),
                        None => {}
                    }
                }
            }
        }
        std::thread::sleep(HEALTH_POLL_INTERVAL);
    }
    Err(failure)
}

/// HTTPS probe: the same GET /api/health over TLS. The certificate is
/// verified against the OS trust store (Tailscale's `serve` hands out a
/// publicly trusted certificate), and the Host header comes from the URL,
/// so the server's Host guard accepts a MagicDNS name. Retried until
/// `timeout` because the front end may be mid-restart; only a 200 counts
/// (redirects are not followed — the probe must answer for the URL the user
/// registered, not for whatever it points at).
fn health_check_https(
    host: &str,
    port: u16,
    token: Option<&str>,
    timeout: Duration,
) -> Result<(), HealthFailure> {
    install_crypto_provider();
    let deadline = Instant::now() + timeout;
    let url = format!("https://{}:{port}/api/health", host_label(host));
    let client = match reqwest::blocking::Client::builder()
        .connect_timeout(HTTPS_HEALTH_ATTEMPT_TIMEOUT)
        .timeout(HTTPS_HEALTH_ATTEMPT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        // The probe targets a tailnet/LAN address directly; a proxy from the
        // environment would only get in the way.
        .no_proxy()
        .build()
    {
        Ok(client) => client,
        Err(_) => return Err(HealthFailure::Unreachable),
    };
    let mut failure = HealthFailure::Unreachable;
    while Instant::now() < deadline {
        let mut request = client.get(&url);
        if let Some(t) = token {
            request = request.header("X-Lumisca-Token", t);
        }
        match request.send() {
            Ok(response) if response.status() == reqwest::StatusCode::OK => return Ok(()),
            Ok(response) => failure = HealthFailure::Status(response.status().as_u16()),
            // A TLS failure (untrusted certificate here, since that is the
            // one class of error the OS store rejects for a live server)
            // and a connection refusal are both "nothing usable answered".
            Err(_) => {}
        }
        std::thread::sleep(HEALTH_POLL_INTERVAL);
    }
    Err(failure)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_of_reads_the_status_line_and_ignores_anything_else() {
        assert_eq!(status_of("HTTP/1.1 200 OK\r\n"), Some(200));
        assert_eq!(status_of("HTTP/1.0 403 Forbidden\r\n"), Some(403));
        // A truncated read (no status line) or a non-HTTP answer must not
        // masquerade as a healthy server.
        assert_eq!(status_of(""), None);
        assert_eq!(status_of("SSH-2.0-OpenSSH_9.0\r\n"), None);
        assert_eq!(status_of("HTTP/1.1\r\n"), None);
    }

    #[test]
    fn an_endpoint_carries_its_token_into_the_page_url() {
        let endpoint = crate::server::Endpoint::loopback(8000, "abc");
        assert_eq!(endpoint.page_url(), "http://127.0.0.1:8000/?token=abc");
        // A trailing slash on the base must not double up.
        let remote = crate::server::Endpoint {
            base: "https://example.test/".to_string(),
            token: "t".to_string(),
        };
        assert_eq!(remote.page_url(), "https://example.test/?token=t");
    }
}
