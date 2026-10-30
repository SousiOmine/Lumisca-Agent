//! Which server the main window displays: the local server, a remote
//! server the user picked in 設定 → 接続先サーバー, or — at startup — the
//! remote server the shell remembered from the last run.
//!
//! The displayed choice is remembered in `settings.json` so a restart
//! returns to the same server instead of always starting the local one.
//! Restoring it is not a silent fallback in either direction: when the
//! remembered server does not answer, the splash says so and offers the
//! local server in one click; when a start connects locally, that choice
//! replaces the remembered one.

use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::server::{
    ensure_local_server, health_check, host_label, page_url, HealthFailure, Scheme,
};
use crate::settings::{self, SavedConnection};
use crate::window::navigate_main;
use crate::{AppState, LockRecover};

/// Health-probe budget when the user connects by hand: long enough for a
/// slow tailnet hop, short enough that the button does not look dead.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Startup restore budget. The splash waits on it, and a server that misses
/// this is offered for a retry instead of stalling the launch.
const RESTORE_TIMEOUT: Duration = Duration::from_secs(3);

/// How long `connect-local` waits for the in-flight background startup
/// before giving up. The busy-wait loop below has no other termination
/// condition: if the startup thread died (panic, kill) without filling its
/// result slot, the bridge would otherwise spin forever. 30s covers the
/// startup's own worst case (10 attempts × the 3s health-check timeout,
/// plus the retry sleeps), so a healthy startup always beats the deadline.
const CONNECT_LOCAL_WAIT_TIMEOUT: Duration = Duration::from_secs(30);

/// A validated remote server URL: the transport to speak, the target host
/// and port, and the canonical base URL used for navigation, the health
/// probe and the "currently showing" state.
#[derive(Debug)]
pub(crate) struct RemoteTarget {
    scheme: Scheme,
    host: String,
    port: u16,
    /// `scheme://host[:port]` — the input normalized to its origin. A
    /// trailing slash, or the path/query of a URL pasted straight out of
    /// the server's output, is dropped: the UI is always served at the
    /// root, and only the fields of this connection carry the token.
    base: String,
}

/// Parse a server URL. Both `http://` (a LAN or Tailscale address served
/// directly) and `https://` (a TLS-terminating front end such as
/// `tailscale serve` in front of a MagicDNS name) are supported; every
/// other scheme is rejected instead of being handed to the window. A URL
/// carrying userinfo is refused rather than silently stripped — those
/// credentials would end up in the shell state and never reach the server.
pub(crate) fn parse_remote_url(url: &str) -> Result<RemoteTarget, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("URL が不正です: {e}"))?;
    let scheme = match parsed.scheme() {
        "http" => Scheme::Http,
        "https" => Scheme::Https,
        _ => return Err("http:// または https:// の URL のみサポートされています".into()),
    };
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URL にユーザー情報（user:pass@）は指定できません".into());
    }
    // `url::Host` rather than `host_str`: the latter serializes an IPv6
    // literal with its brackets, and brackets belong to the authority
    // spelling — `host_label` re-adds them for the Host header and the base
    // URL where they are required.
    let host = match parsed.host() {
        Some(url::Host::Domain(domain)) => domain.to_string(),
        Some(url::Host::Ipv4(address)) => address.to_string(),
        Some(url::Host::Ipv6(address)) => address.to_string(),
        None => return Err("URL にホストがありません".to_string()),
    };
    // The port actually used, and the port as spelled in the base URL: an
    // omitted one is filled in from the scheme's default and dropped from
    // the base (http://host:443 would be as wrong as https://host:80).
    let port = parsed.port().unwrap_or(match scheme {
        Scheme::Http => 80,
        Scheme::Https => 443,
    });
    let label = host_label(&host);
    let base = match parsed.port() {
        Some(port) => format!("{}://{label}:{port}", parsed.scheme()),
        None => format!("{}://{label}", parsed.scheme()),
    };
    Ok(RemoteTarget {
        scheme,
        host,
        port,
        base,
    })
}

/// Connect-time failure message for the settings UI. The probe says why it
/// failed instead of a bare "cannot connect": for a remote server the
/// likeliest causes are a Host guard 403 (the name is missing from the
/// server's `--allowed-hosts`) and a token mismatch, and neither is
/// something the user can see from the URL alone.
fn connect_failure(url: &str, failure: HealthFailure) -> String {
    match failure {
        HealthFailure::Unreachable => format!("サーバーに接続できません: {url}"),
        HealthFailure::Status(403) => format!(
            "サーバーに接続できません: {url}（HTTP 403: ホスト名が拒否されました。サーバーの --allowed-hosts にこのホスト名を追加してください）"
        ),
        HealthFailure::Status(401) => {
            format!("サーバーに接続できません: {url}（HTTP 401: トークンが一致しません）")
        }
        HealthFailure::Status(status) => {
            format!("サーバーに接続できません: {url}（HTTP {status}）")
        }
    }
}

/// Mark that the user (or the startup path) changed the display, so an
/// in-flight restore can tell that its answer is stale.
fn bump_epoch(app: &AppHandle) -> u64 {
    let state = app.state::<AppState>();
    let mut epoch = state.connect_epoch.lock_recover();
    *epoch += 1;
    *epoch
}

fn current_epoch(app: &AppHandle) -> u64 {
    let state = app.state::<AppState>();
    let epoch = *state.connect_epoch.lock_recover();
    epoch
}

/// Probe `conn` and, when it answers, make it the displayed server and
/// remember it for the next launch.
///
/// The write to `settings.json` comes before the navigation: when it
/// fails, the window stays where it is and the caller reports why, instead
/// of switching to a server the next launch will not return to.
pub(crate) fn connect_remote(app: &AppHandle, conn: &SavedConnection) -> Result<String, String> {
    bump_epoch(app);
    let target = parse_remote_url(&conn.url)?;
    if let Err(failure) = health_check(
        target.scheme,
        &target.host,
        target.port,
        Some(&conn.token),
        CONNECT_TIMEOUT,
    ) {
        return Err(connect_failure(&conn.url, failure));
    }
    // The base URL is what the probe and the window use; the stored token
    // may carry surrounding whitespace from the input field.
    let saved = SavedConnection {
        url: target.base,
        token: conn.token.trim().to_string(),
    };
    remember(app, Some(saved.clone()))?;
    display_remote(app, &saved)
}

/// Retry the server the shell remembered (the splash's 再試行 button).
pub(crate) fn connect_saved(app: &AppHandle) -> Result<String, String> {
    let state = app.state::<AppState>();
    let saved = state.remembered.lock_recover().clone();
    match saved {
        Some(conn) => connect_remote(app, &conn),
        None => Err("保持している接続先がありません".to_string()),
    }
}

/// Reachability probe without switching (設定 → 接続先サーバー → テスト).
pub(crate) fn test_remote(url: &str, token: &str) -> Result<(), String> {
    let target = parse_remote_url(url)?;
    health_check(
        target.scheme,
        &target.host,
        target.port,
        Some(token),
        CONNECT_TIMEOUT,
    )
    .map_err(|failure| connect_failure(url, failure))
}

/// Write the choice that survives a restart. The single place that touches
/// `settings.json`'s connection field, so the in-memory copy the splash
/// reads and the file cannot disagree.
fn remember(app: &AppHandle, conn: Option<SavedConnection>) -> Result<(), String> {
    settings::set_remembered(app, conn.as_ref())?;
    let state = app.state::<AppState>();
    *state.remembered.lock_recover() = conn;
    Ok(())
}

/// Make `conn` the displayed server: state, then navigation.
fn display_remote(app: &AppHandle, conn: &SavedConnection) -> Result<String, String> {
    let page = page_url(&conn.url, &conn.token);
    *app.state::<AppState>().last_remote.lock_recover() =
        Some((conn.url.clone(), conn.token.clone()));
    navigate_main(app, &page)?;
    Ok(page)
}

/// Switch the window to the local server, starting it if it is not
/// running. The local choice replaces the remembered remote one.
pub(crate) fn connect_local(app: &AppHandle) -> Result<String, String> {
    bump_epoch(app);
    // If the background startup is still running, wait for its result
    // instead of spawning a second server instance.
    let pending = app.state::<AppState>().startup_task.lock_recover().clone();
    if let Some(shared) = pending {
        let deadline = std::time::Instant::now() + CONNECT_LOCAL_WAIT_TIMEOUT;
        loop {
            if let Some(result) = shared.lock_recover().clone() {
                return result.and_then(|url| display_local(app, &url));
            }
            if std::time::Instant::now() >= deadline {
                // The background startup never completed (e.g. its thread
                // panicked and never filled the slot). Forget it so the
                // next attempt starts a server directly instead of waiting
                // again.
                *app.state::<AppState>().startup_task.lock_recover() = None;
                return Err(
                    "サーバーの起動待機時間が超過しました。しばらく時間をおいてから再度お試しください。"
                        .into(),
                );
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    let url = ensure_local_server(app)?;
    display_local(app, &url)
}

/// Point the window at the local server. The local choice also replaces
/// the remembered remote one, so the next launch starts locally too; a
/// failed write keeps the window where it is rather than switching to a
/// display the next launch will not restore. Also used by the server-down
/// banner's restart, which is explicitly about the local server.
pub(crate) fn display_local(app: &AppHandle, url: &str) -> Result<String, String> {
    remember(app, None)?;
    *app.state::<AppState>().last_remote.lock_recover() = None;
    navigate_main(app, url)?;
    // A restore that was abandoned in favour of the local server leaves
    // "connecting" behind otherwise, and the splash would keep waiting
    // after a failed navigation.
    set_startup(app, "ready", None);
    Ok(url.to_string())
}

/// Startup: display the remembered remote server, or start the local one
/// when there is nothing remembered (or the user connected locally last
/// time).
pub(crate) fn start(app: &AppHandle) {
    let state = app.state::<AppState>();
    let remembered = state.remembered.lock_recover().clone();
    match remembered {
        None => crate::server::start_local_server_async(app),
        Some(conn) => restore_remote_async(app, conn),
    }
}

fn restore_remote_async(app: &AppHandle, conn: SavedConnection) {
    set_startup(app, "connecting", None);
    let epoch = current_epoch(app);
    let handle = app.clone();
    std::thread::spawn(move || {
        let result = restore_remote(&handle, &conn, epoch);
        match result {
            Ok(()) => {
                // A restore that lost the race already navigated nowhere;
                // the winner reports "ready" itself.
                if current_epoch(&handle) == epoch {
                    set_startup(&handle, "ready", None);
                }
            }
            Err(message) => set_startup(&handle, "remote-unreachable", Some(message)),
        }
    });
}

/// Probe the remembered server and display it. A user who connected from
/// the splash while the probe ran wins: their choice is already showing,
/// and yanking the window away from it would lose their click.
fn restore_remote(app: &AppHandle, conn: &SavedConnection, epoch: u64) -> Result<(), String> {
    let target = parse_remote_url(&conn.url)?;
    if let Err(failure) = health_check(
        target.scheme,
        &target.host,
        target.port,
        Some(&conn.token),
        RESTORE_TIMEOUT,
    ) {
        return Err(connect_failure(&conn.url, failure));
    }
    if current_epoch(app) != epoch {
        return Ok(());
    }
    display_remote(app, conn)?;
    Ok(())
}

fn set_startup(app: &AppHandle, status: &str, error: Option<String>) {
    let state = app.state::<AppState>();
    let mut startup = state.startup.lock_recover();
    startup.status = status.to_string();
    startup.error = error;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The base URL is the input normalized to its origin: what the window
    /// is navigated to, what the health probe targets, and what the settings
    /// UI reports as the current display.
    #[test]
    fn parse_remote_url_normalizes_the_base_url() {
        let https = parse_remote_url("https://host.tailnet.ts.net/").unwrap();
        assert_eq!(https.scheme, Scheme::Https);
        assert_eq!(https.host, "host.tailnet.ts.net");
        assert_eq!(https.port, 443);
        assert_eq!(https.base, "https://host.tailnet.ts.net");

        let http = parse_remote_url("http://100.64.0.5:8000").unwrap();
        assert_eq!(http.scheme, Scheme::Http);
        assert_eq!(http.host, "100.64.0.5");
        assert_eq!(http.port, 8000);
        assert_eq!(http.base, "http://100.64.0.5:8000");

        // A URL pasted straight out of the server's output carries a path,
        // query and fragment the page does not live at (and a token that
        // belongs in its own field): only the origin is kept.
        let pasted = parse_remote_url("https://host.tailnet.ts.net/?token=abc#top").unwrap();
        assert_eq!(pasted.base, "https://host.tailnet.ts.net");
    }

    #[test]
    fn parse_remote_url_accepts_and_fills_the_default_ports() {
        assert_eq!(parse_remote_url("http://host").unwrap().port, 80);
        assert_eq!(parse_remote_url("https://host").unwrap().port, 443);
        // An explicit default port is normalized away by the URL parser, so
        // the base never spells out http://host:80 or https://host:443.
        let explicit = parse_remote_url("https://host:443").unwrap();
        assert_eq!(explicit.port, 443);
        assert_eq!(explicit.base, "https://host");
    }

    #[test]
    fn parse_remote_url_brackets_ipv6_literals() {
        let target = parse_remote_url("https://[::1]:8443").unwrap();
        assert_eq!(target.host, "::1");
        assert_eq!(target.port, 8443);
        assert_eq!(target.base, "https://[::1]:8443");
    }

    #[test]
    fn parse_remote_url_rejects_other_schemes() {
        assert_eq!(
            parse_remote_url("ftp://host").unwrap_err(),
            "http:// または https:// の URL のみサポートされています"
        );
        // A bare "host:port" parses as the scheme "host" — rejected here
        // rather than navigated to.
        assert!(parse_remote_url("homeserver:8000").is_err());
        assert!(parse_remote_url("file:///tmp").is_err());
        assert!(parse_remote_url("ws://host:8000").is_err());
    }

    #[test]
    fn parse_remote_url_rejects_malformed_urls() {
        assert!(parse_remote_url("").is_err());
        assert!(parse_remote_url("https://").is_err());
        assert_eq!(
            parse_remote_url("https://user:pass@host").unwrap_err(),
            "URL にユーザー情報（user:pass@）は指定できません"
        );
    }

    /// The failure message names the operationally distinct causes: a 403
    /// comes from the server's Host guard and is fixed in ITS
    /// `--allowed-hosts`, not on this side.
    #[test]
    fn connect_failure_explains_the_http_status() {
        let url = "https://host.tailnet.ts.net";
        assert_eq!(
            connect_failure(url, HealthFailure::Unreachable),
            "サーバーに接続できません: https://host.tailnet.ts.net"
        );
        let forbidden = connect_failure(url, HealthFailure::Status(403));
        assert!(forbidden.contains("HTTP 403"));
        assert!(forbidden.contains("--allowed-hosts"));
        assert!(connect_failure(url, HealthFailure::Status(401)).contains("HTTP 401"));
        assert!(connect_failure(url, HealthFailure::Status(502)).contains("HTTP 502"));
    }
}
