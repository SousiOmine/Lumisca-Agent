use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::http::{header, Request as HttpRequest, Response as HttpResponse, StatusCode};
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_updater::{Update, UpdaterExt};

/// State shared by the shell bridge and the window lifecycle.
struct AppState {
    /// The spawned local server, when running.
    local: Mutex<Option<LocalServer>>,
    /// The last remote server the user switched to (url, token) — the
    /// "current display" reported by the bridge state.
    last_remote: Mutex<Option<(String, String)>>,
    /// Auto-update state, surfaced to the settings UI through the bridge.
    update: Mutex<UpdateState>,
    /// Downloaded update awaiting installation.
    pending: Mutex<Option<PendingUpdate>>,
    /// Local server startup progress, read by the splash page (the
    /// initial frontend) through the bridge until the window navigates.
    startup: Mutex<StartupStatus>,
    /// The in-flight local server start: the background thread fills it
    /// with the result. connect-local waits on it instead of spawning a
    /// second server while the startup is still running.
    startup_task: Mutex<Option<Arc<Mutex<Option<Result<String, String>>>>>>,
}

/// Local server startup progress, surfaced to the splash page.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StartupStatus {
    /// "starting" | "ready" | "error"
    status: String,
    /// Error message when status is "error".
    error: Option<String>,
}

impl StartupStatus {
    fn new(status: &str, error: Option<String>) -> Self {
        Self {
            status: status.to_string(),
            error,
        }
    }
}

/// Auto-update state. Written by the background check/download tasks, read
/// by the bridge (and thus the settings UI).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateState {
    auto_update: bool,
    checking: bool,
    available: bool,
    latest_version: Option<String>,
    downloading: bool,
    progress: Option<f64>,
    downloaded: Option<u64>,
    total: Option<u64>,
    ready: bool,
    error: Option<String>,
}

impl UpdateState {
    fn new(auto_update: bool) -> Self {
        Self {
            auto_update,
            checking: false,
            available: false,
            latest_version: None,
            downloading: false,
            progress: None,
            downloaded: None,
            total: None,
            ready: false,
            error: None,
        }
    }
}

/// A downloaded update awaiting installation.
struct PendingUpdate {
    update: Update,
    bytes: Vec<u8>,
}

/// A locally spawned server process.
struct LocalServer {
    child: Child,
    port: u16,
    token: String,
}

/// Current display, shown by the settings UI. Also carries the local
/// server startup progress for the splash page.
#[derive(serde::Serialize)]
struct ConnectionState {
    /// "local" | "remote"
    mode: String,
    /// Page URL of the current display, if known.
    url: Option<String>,
    /// "starting" | "ready" | "error" — local server startup progress.
    status: String,
    /// Error message when status is "error".
    error: Option<String>,
}

/// JSON body of a lumisca://shell/* bridge response.
type BridgeResponse = HttpResponse<Vec<u8>>;

const DEFAULT_PORT: u16 = 8000;
const SERVER_PORT_ENV: &str = "LUMISCA_PORT";
/// Poll interval while waiting for the local server to come up (the
/// compiled server answers in ~0.3s; a fast poll keeps the switch to the
/// app page snappy).
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(50);
/// How long one local startup attempt may wait before the port is
/// abandoned and a fresh one is tried. 3s covers a cold deno run; a
/// healthy server answers in well under a second.
const LOCAL_START_TIMEOUT: Duration = Duration::from_secs(3);

fn find_deno() -> Option<PathBuf> {
    // Respect an explicit override.
    if let Ok(explicit) = std::env::var("LUMISCA_DENO") {
        let p = PathBuf::from(explicit);
        if p.exists() {
            return Some(p);
        }
    }
    // Look up PATH.
    let path_var = std::env::var_os("PATH")?;
    let exe = if cfg!(windows) { "deno.exe" } else { "deno" };
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(exe);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// How to launch the server: a compiled binary (packaged builds) or a
/// deno run of the repository entry point (development).
enum ServerCommand {
    Compiled(PathBuf),
    Deno(PathBuf),
}

/// Locate the server runtime:
/// 1. packaged: server/lumisca-server(.exe) in Tauri's resource directory
/// 2. repository layout during development (cwd is packages/desktop/src-tauri)
fn find_server_command(app: &AppHandle) -> Option<ServerCommand> {
    // `tauri.conf.json` maps the bundled files to `server/*` relative to
    // Tauri's platform-specific resource directory.
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("server").join(if cfg!(windows) {
            "lumisca-server.exe"
        } else {
            "lumisca-server"
        });
        if bundled.is_file() {
            return Some(ServerCommand::Compiled(bundled));
        }
    }
    for c in [
        "../../../packages/server/mod.ts",
        "../../server/mod.ts",
        "../server/mod.ts",
    ] {
        let p = Path::new(c);
        if p.is_file() {
            return Some(ServerCommand::Deno(p.to_path_buf()));
        }
    }
    None
}

fn app_data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("lumisca"))
}

fn server_db_path(app: &AppHandle) -> PathBuf {
    let dir = app_data_dir(app);
    let _ = std::fs::create_dir_all(&dir);
    dir.join("lumisca.db")
}

/// Desktop-level settings (auto-update etc.). Kept next to the server
/// database: the settings UI may be served by a remote server, so these
/// flags cannot live in that server's settings.
#[derive(serde::Serialize, serde::Deserialize)]
struct DesktopSettings {
    auto_update: bool,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self { auto_update: true }
    }
}

fn desktop_settings_path(app: &AppHandle) -> PathBuf {
    app_data_dir(app).join("settings.json")
}

fn load_desktop_settings(app: &AppHandle) -> DesktopSettings {
    std::fs::read_to_string(desktop_settings_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_desktop_settings(app: &AppHandle, settings: &DesktopSettings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(desktop_settings_path(app), json).map_err(|e| e.to_string())
}

/// Pick a free port by binding to port 0, unless one was requested.
fn resolve_port() -> u16 {
    if let Some(p) = std::env::var(SERVER_PORT_ENV)
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
    {
        return p;
    }
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .unwrap_or(DEFAULT_PORT)
}

/// Per-instance auth token for the spawned server. 128 bits from the OS
/// CSPRNG. Beyond blocking casual local processes from driving the agent,
/// it lets the health check tell OUR server apart from a stale instance
/// of a previous run (which has a different token and answers 401 to
/// ours).
fn generate_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("OS random number source must be available");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Check a server's GET /api/health over raw TCP. `host` may be a hostname
/// or an IP literal; `token` is optional (servers without token auth answer
/// without it). The Host header names the target host so the server's Host
/// guard accepts the probe. Replaces a bare TCP connect, which would accept
/// ANY process on the port — e.g. a stale server with a different database.
fn health_check(host: &str, port: u16, token: Option<&str>, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    // Bracketed IPv6 literals for the Host header and the connect address.
    let is_ipv6 = host.contains(':') && !host.starts_with('[');
    let host_label = if is_ipv6 {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    let mut request = format!("GET /api/health HTTP/1.1\r\nHost: {host_label}:{port}\r\n");
    if let Some(t) = token {
        request.push_str(&format!("X-Lumisca-Token: {t}\r\n"));
    }
    request.push_str("Connection: close\r\n\r\n");
    let addr = format!("{host_label}:{port}");
    while Instant::now() < deadline {
        if let Ok(mut stream) = TcpStream::connect(addr.as_str()) {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
            let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
            if stream.write_all(request.as_bytes()).is_ok() {
                let mut buf = [0u8; 256];
                if let Ok(n) = stream.read(&mut buf) {
                    let head = String::from_utf8_lossy(&buf[..n]);
                    if head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200") {
                        return true;
                    }
                }
            }
        }
        std::thread::sleep(HEALTH_POLL_INTERVAL);
    }
    false
}

/// Parse a server URL into (host, port). Only http:// is supported
/// (v1: Tailscale / trusted LAN, no TLS).
fn parse_remote_url(url: &str) -> Result<(String, u16), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("URL が不正です: {e}"))?;
    if parsed.scheme() != "http" {
        return Err("http:// URL のみサポートされています".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "URL にホストがありません".to_string())?
        .to_string();
    let port = parsed.port().unwrap_or(80);
    Ok((host, port))
}

/// The page URL to open for a connection: the base URL plus `/?token=`
/// (the page is token-guarded in production mode).
fn page_url(base: &str, token: &str) -> String {
    format!("{}/?token={}", base.trim_end_matches('/'), token)
}

fn start_server(app: &AppHandle, port: u16, token: &str) -> Result<Child, String> {
    let db_path = server_db_path(app);
    let command = find_server_command(app)
        .ok_or_else(|| "Lumisca server not found. Build the project first.".to_string())?;

    let child = match command {
        ServerCommand::Compiled(bin) => {
            // Packaged build: prebuilt frontend assets sit next to the
            // binary in the resources dir.
            let assets_file = bin.parent().unwrap_or(Path::new(".")).join("assets.json");
            Command::new(&bin)
                .env("LUMISCA_DB", &db_path)
                .env("LUMISCA_PORT", port.to_string())
                .env("LUMISCA_TOKEN", token)
                .env("LUMISCA_ASSETS_FILE", assets_file)
                .spawn()
                .map_err(|e| format!("Failed to start Lumisca server: {e}"))?
        }
        ServerCommand::Deno(entry) => {
            let deno = find_deno().ok_or_else(|| {
                "Deno runtime not found. Install Deno (https://deno.com) and add it to PATH."
                    .to_string()
            })?;
            // The server resolves frontend assets relative to the
            // repository root; the spawned process runs from a different
            // cwd, so pass it explicitly. The entry is relative in the
            // development layout, so canonicalize it — a relative root
            // breaks esbuild (it rejects relative working directories).
            let repo_root = std::fs::canonicalize(&entry)
                .ok()
                .and_then(|e| e.parent().map(|p| p.to_path_buf()))
                .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                .unwrap_or_else(|| PathBuf::from("."));
            Command::new(&deno)
                .args([
                    "run",
                    "--allow-net",
                    "--allow-read",
                    "--allow-write",
                    "--allow-env",
                    "--allow-run",
                    "--allow-sys",
                ])
                .arg(&entry)
                .env("LUMISCA_DB", db_path)
                .env("LUMISCA_PORT", port.to_string())
                .env("LUMISCA_REPO_ROOT", repo_root)
                .env("LUMISCA_TOKEN", token)
                .spawn()
                .map_err(|e| format!("Failed to start Lumisca server: {e}"))?
        }
    };

    Ok(child)
}

/// Kill the server AND everything it spawned (bash tool children would
/// otherwise survive on Windows).
fn kill_process_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let pid = child.id();
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .spawn();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Start the local server (or reuse the running one) and return the page
/// URL. Retries on fresh ports when the health check fails (port taken by
/// another process, bind race).
fn ensure_local_server(app: &AppHandle) -> Result<String, String> {
    let state = app.state::<AppState>();
    if let Some(local) = state.local.lock().unwrap().as_ref() {
        return Ok(page_url(
            &format!("http://127.0.0.1:{}", local.port),
            &local.token,
        ));
    }
    let token = generate_token();
    let mut server_child: Option<Child> = None;
    let mut server_port: Option<u16> = None;
    for attempt in 0..10 {
        let port = resolve_port();
        let mut child = start_server(app, port, &token)?;
        if health_check("127.0.0.1", port, Some(&token), LOCAL_START_TIMEOUT) {
            server_child = Some(child);
            server_port = Some(port);
            break;
        }
        kill_process_tree(&mut child);
        if attempt == 9 {
            return Err("Lumisca server did not become ready".into());
        }
        // Give the previous port a moment to be released.
        std::thread::sleep(Duration::from_millis(300));
    }
    let port = server_port.ok_or("Lumisca server did not become ready")?;
    let child = server_child.ok_or("Lumisca server did not become ready")?;
    *state.local.lock().unwrap() = Some(LocalServer {
        child,
        port,
        token: token.clone(),
    });
    Ok(page_url(&format!("http://127.0.0.1:{port}"), &token))
}

/// Start the local server in the background and navigate the main window
/// to its page once it is healthy. setup() returns immediately so the
/// splash page paints without waiting; the bridge state reports the
/// progress ("starting" → "ready"/"error") for the splash to poll.
fn start_local_server_async(app: &AppHandle) {
    let shared: Arc<Mutex<Option<Result<String, String>>>> =
        Arc::new(Mutex::new(None));
    *app.state::<AppState>().startup_task.lock().unwrap() = Some(shared.clone());
    let handle = app.clone();
    std::thread::spawn(move || {
        let result = ensure_local_server(&handle);
        let (status, error) = match &result {
            Ok(_) => ("ready", None),
            Err(message) => ("error", Some(message.clone())),
        };
        {
            let state = handle.state::<AppState>();
            *shared.lock().unwrap() = Some(result.clone());
            *state.startup_task.lock().unwrap() = None;
            *state.startup.lock().unwrap() = StartupStatus::new(status, error);
        }
        if let Ok(url) = result {
            let handle = handle.clone();
            let inside = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                // A remote connection made while the local server was
                // starting wins: don't yank the window back to local.
                let remote = inside
                    .state::<AppState>()
                    .last_remote
                    .lock()
                    .unwrap()
                    .is_some();
                if !remote {
                    let _ = navigate_main(&inside, &url);
                }
            });
        }
    });
}

/// Navigate the main window to a URL (local server page or remote server
/// page).
fn navigate_main(app: &AppHandle, url: &str) -> Result<(), String> {
    let parsed = url
        .parse::<url::Url>()
        .map_err(|e| format!("URL が不正です: {e}"))?;
    if let Some(window) = app.get_webview_window("main") {
        window
            .navigate(parsed)
            .map_err(|e| format!("画面遷移に失敗しました: {e}"))?;
    }
    Ok(())
}

fn connect_remote_impl(app: &AppHandle, url: &str, token: &str) -> Result<String, String> {
    let (host, port) = parse_remote_url(url)?;
    if !health_check(&host, port, Some(token), Duration::from_secs(5)) {
        return Err(format!("サーバーに接続できません: {url}"));
    }
    let page = page_url(url, token);
    *app.state::<AppState>().last_remote.lock().unwrap() =
        Some((url.to_string(), token.to_string()));
    navigate_main(app, &page)?;
    Ok(page)
}

fn connect_local_impl(app: &AppHandle) -> Result<String, String> {
    // If the background startup is still running, wait for its result
    // instead of spawning a second server instance.
    let pending = app
        .state::<AppState>()
        .startup_task
        .lock()
        .unwrap()
        .clone();
    if let Some(shared) = pending {
        loop {
            if let Some(result) = shared.lock().unwrap().clone() {
                return result;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    let url = ensure_local_server(app)?;
    *app.state::<AppState>().last_remote.lock().unwrap() = None;
    navigate_main(app, &url)?;
    Ok(url)
}

// --- auto-update ------------------------------------------------------------
//
// The desktop shell checks GitHub Releases through tauri-plugin-updater
// (configured in tauri.conf.json). The settings UI is served by the
// (possibly remote) server, so it drives updates through the bridge and
// polls the state below while a check/download is in flight.

const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const FIRST_UPDATE_CHECK_DELAY: Duration = Duration::from_secs(10);

/// The current update state as JSON for the bridge, plus the running app
/// version (shown in the 一般 settings panel).
fn update_status_json(app: &AppHandle) -> serde_json::Value {
    let state = app.state::<AppState>();
    let st = state.update.lock().unwrap();
    let mut value = serde_json::to_value(&*st).unwrap_or_else(|_| serde_json::json!({}));
    value["currentVersion"] = app.package_info().version.to_string().into();
    value
}

fn fail_update(app: &AppHandle, message: &str) {
    let state = app.state::<AppState>();
    let mut st = state.update.lock().unwrap();
    st.checking = false;
    st.downloading = false;
    st.error = Some(message.to_string());
}

/// Check for a new version. In auto mode (startup, the periodic loop,
/// turning the toggle on) an available update is downloaded right away; a
/// manual check only records it and leaves the download to the user.
async fn check_for_updates(app: AppHandle, auto: bool) {
    // Decide what to do while holding the lock; the guard must be dropped
    // before the awaits below.
    let auto_download = {
        let state = app.state::<AppState>();
        let mut st = state.update.lock().unwrap();
        if st.checking || st.downloading || st.ready {
            return;
        }
        if st.available {
            // Already known (e.g. from a manual check); auto mode proceeds
            // to the download, otherwise there is nothing to do.
            if !(auto && st.auto_update) {
                return;
            }
            true
        } else {
            st.checking = true;
            st.error = None;
            false
        }
    };

    if auto_download {
        download_update(app).await;
        return;
    }

    // A fresh network check (the state was not marked available).
    let cleanup_app = app.clone();
    let updater = match app
        .updater_builder()
        .on_before_exit(move || {
            if let Some(mut local) = cleanup_app.state::<AppState>().local.lock().unwrap().take() {
                kill_process_tree(&mut local.child);
            }
            cleanup_app.cleanup_before_exit();
        })
        .build()
    {
        Ok(updater) => updater,
        Err(e) => {
            fail_update(&app, &format!("更新の確認に失敗しました: {e}"));
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            {
                let state = app.state::<AppState>();
                let mut st = state.update.lock().unwrap();
                st.checking = false;
                st.available = true;
                st.latest_version = Some(update.version.to_string());
            }
            *app.state::<AppState>().pending.lock().unwrap() = Some(PendingUpdate {
                update,
                bytes: Vec::new(),
            });
            if auto {
                download_update(app).await;
            }
        }
        Ok(None) => {
            let state = app.state::<AppState>();
            let mut st = state.update.lock().unwrap();
            st.checking = false;
            st.available = false;
            st.latest_version = None;
            st.ready = false;
            st.downloading = false;
            st.progress = None;
            st.downloaded = None;
            st.total = None;
        }
        Err(e) => fail_update(&app, &format!("更新の確認に失敗しました: {e}")),
    }
}

/// Download the available update into memory, reporting progress through
/// the state. The bytes stay in `pending` until the user installs.
async fn download_update(app: AppHandle) {
    {
        let state = app.state::<AppState>();
        let mut st = state.update.lock().unwrap();
        if !st.available || st.downloading || st.ready {
            return;
        }
        st.downloading = true;
        st.progress = Some(0.0);
        st.downloaded = Some(0);
        st.error = None;
    }

    let pending = app.state::<AppState>().pending.lock().unwrap().take();
    let Some(pending) = pending else {
        let state = app.state::<AppState>();
        let mut st = state.update.lock().unwrap();
        st.downloading = false;
        st.error =
            Some("ダウンロードできる更新が見つかりません。もう一度確認してください。".into());
        return;
    };

    let mut received = 0u64;
    let result = pending
        .update
        .download(
            |chunk, total| {
                received += chunk as u64;
                let state = app.state::<AppState>();
                let mut st = state.update.lock().unwrap();
                st.downloaded = Some(received);
                st.total = total;
                st.progress = total.map(|t| received as f64 / t as f64);
            },
            || {},
        )
        .await;

    match result {
        Ok(bytes) => {
            *app.state::<AppState>().pending.lock().unwrap() = Some(PendingUpdate {
                update: pending.update,
                bytes,
            });
            let state = app.state::<AppState>();
            let mut st = state.update.lock().unwrap();
            st.downloading = false;
            st.ready = true;
            st.progress = Some(1.0);
        }
        Err(e) => {
            // Keep the update record so the download can be retried.
            *app.state::<AppState>().pending.lock().unwrap() = Some(PendingUpdate {
                update: pending.update,
                bytes: Vec::new(),
            });
            let state = app.state::<AppState>();
            let mut st = state.update.lock().unwrap();
            st.downloading = false;
            st.ready = false;
            st.progress = None;
            st.error = Some(format!("ダウンロードに失敗しました: {e}"));
        }
    }
}

/// Install the downloaded update. On Windows this launches the NSIS
/// installer and exits the process (the installer relaunches the app). The
/// updater's `on_before_exit` hook stops the local server only after the
/// installer is ready to launch, so an earlier failure leaves the UI alive.
fn install_update(app: AppHandle) {
    std::thread::spawn(move || {
        let pending = app.state::<AppState>().pending.lock().unwrap().take();
        let Some(pending) = pending else {
            let state = app.state::<AppState>();
            let mut st = state.update.lock().unwrap();
            st.error = Some("インストールできる更新がありません。".into());
            return;
        };
        if let Err(e) = pending.update.install(&pending.bytes) {
            *app.state::<AppState>().pending.lock().unwrap() = Some(pending);
            let state = app.state::<AppState>();
            let mut st = state.update.lock().unwrap();
            st.error = Some(format!("インストールに失敗しました: {e}"));
        }
        // On success the installer is running and this process has exited.
    });
}

// --- lumisca://shell bridge -------------------------------------------------
//
// The settings UI is served by the (possibly remote) server, so it cannot
// call Tauri commands. Instead it fetches `http://lumisca.localhost/shell/
// <action>` — the custom protocol re-homed for WebView2, where the scheme
// is handled here. The bridge only manages the local server and UI
// switching; the peer registry lives in the server's own database.
//
// Every request must carry `key` = the auth token of the CURRENTLY
// DISPLAYED server — a value only the page served by that server knows, so
// arbitrary pages in the webview cannot drive the bridge.

/// Current display's auth token (the bridge key).
fn current_connection_token(app: &AppHandle) -> Option<String> {
    let state = app.state::<AppState>();
    let remote = state
        .last_remote
        .lock()
        .unwrap()
        .as_ref()
        .map(|(_, t)| t.clone());
    if remote.is_some() {
        return remote;
    }
    let local = state
        .local
        .lock()
        .unwrap()
        .as_ref()
        .map(|l| l.token.clone());
    local
}

fn bridge_json(status: StatusCode, value: serde_json::Value) -> BridgeResponse {
    // `builder()` is defined on Response<()>; `.body()` yields Response<T>.
    tauri::http::Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        // The page origin is dynamic (local or remote server); `*` is fine
        // because the key gate above already authenticates the caller.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(serde_json::to_vec(&value).unwrap_or_default())
        .unwrap()
}

fn bridge_error(status: StatusCode, message: &str) -> BridgeResponse {
    bridge_json(status, serde_json::json!({ "error": message }))
}

fn handle_shell_request(app: &AppHandle, request: HttpRequest<Vec<u8>>) -> BridgeResponse {
    let parsed = match url::Url::parse(&request.uri().to_string()) {
        Ok(parsed) => parsed,
        Err(_) => return bridge_error(StatusCode::BAD_REQUEST, "invalid uri"),
    };
    // Action = everything after the `/shell/` prefix (`state`,
    // `connect-remote`, `update/status`, ...), not just one segment.
    let mut segments = parsed.path().trim_start_matches('/').split('/');
    segments.next(); // skip "shell"
    let action = segments.collect::<Vec<_>>().join("/");
    let params: std::collections::HashMap<String, String> =
        parsed.query_pairs().into_owned().collect();

    // Key gate: only the page of the currently displayed server may drive
    // the bridge. Tokenless servers leave it open (matching their own
    // auth posture).
    if let Some(current) = current_connection_token(app) {
        let supplied = params.get("key").map(String::as_str);
        if supplied != Some(current.as_str()) {
            return bridge_error(StatusCode::UNAUTHORIZED, "invalid key");
        }
    }

    let get = |name: &str| params.get(name).cloned();
    match action.as_str() {
        "state" => {
            let state = app.state::<AppState>();
            let startup = state.startup.lock().unwrap();
            let mode = if state.last_remote.lock().unwrap().is_some() {
                "remote"
            } else {
                "local"
            };
            let url = if mode == "remote" {
                state
                    .last_remote
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|(u, t)| page_url(u, t))
            } else {
                state
                    .local
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|l| page_url(&format!("http://127.0.0.1:{}", l.port), &l.token))
            };
            let state = ConnectionState {
                mode: mode.to_string(),
                url,
                status: startup.status.clone(),
                error: startup.error.clone(),
            };
            bridge_json(StatusCode::OK, serde_json::to_value(state).unwrap())
        }
        "connect-remote" => {
            let (url, token) = match (get("url"), get("token")) {
                (Some(url), token) => (url, token.unwrap_or_default()),
                _ => return bridge_error(StatusCode::BAD_REQUEST, "url required"),
            };
            match connect_remote_impl(app, &url, &token) {
                Ok(page) => bridge_json(
                    StatusCode::OK,
                    serde_json::json!({ "ok": true, "url": page }),
                ),
                Err(e) => bridge_error(StatusCode::BAD_GATEWAY, &e),
            }
        }
        "connect-local" => match connect_local_impl(app) {
            Ok(url) => bridge_json(
                StatusCode::OK,
                serde_json::json!({ "ok": true, "url": url }),
            ),
            Err(e) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
        },
        "test" => {
            let (url, token) = match (get("url"), get("token")) {
                (Some(url), token) => (url, token.unwrap_or_default()),
                _ => return bridge_error(StatusCode::BAD_REQUEST, "url required"),
            };
            match parse_remote_url(&url).and_then(|(host, port)| {
                if health_check(&host, port, Some(&token), Duration::from_secs(5)) {
                    Ok(())
                } else {
                    Err(format!("サーバーに接続できません: {url}"))
                }
            }) {
                Ok(()) => bridge_json(StatusCode::OK, serde_json::json!({ "ok": true })),
                Err(e) => bridge_error(StatusCode::BAD_GATEWAY, &e),
            }
        }
        // --- auto-update ---
        "update/status" => bridge_json(StatusCode::OK, update_status_json(app)),
        "update/set-auto" => {
            let enabled = match get("enabled").and_then(|v| v.parse::<bool>().ok()) {
                Some(enabled) => enabled,
                None => return bridge_error(StatusCode::BAD_REQUEST, "enabled required"),
            };
            let mut settings = load_desktop_settings(app);
            settings.auto_update = enabled;
            match save_desktop_settings(app, &settings) {
                Ok(()) => {
                    app.state::<AppState>().update.lock().unwrap().auto_update = enabled;
                    // Turning it on kicks off the first check immediately.
                    if enabled {
                        tauri::async_runtime::spawn(check_for_updates(app.clone(), true));
                    }
                    bridge_json(StatusCode::OK, update_status_json(app))
                }
                Err(e) => bridge_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
            }
        }
        "update/check" => {
            tauri::async_runtime::spawn(check_for_updates(app.clone(), false));
            bridge_json(StatusCode::OK, update_status_json(app))
        }
        "update/download" => {
            tauri::async_runtime::spawn(download_update(app.clone()));
            bridge_json(StatusCode::OK, update_status_json(app))
        }
        "update/install" => {
            install_update(app.clone());
            bridge_json(StatusCode::OK, update_status_json(app))
        }
        "quit" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
            bridge_json(StatusCode::OK, serde_json::json!({ "ok": true }))
        }
        _ => bridge_error(StatusCode::NOT_FOUND, "unknown action"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = load_desktop_settings(&handle);
            app.manage(AppState {
                local: Mutex::new(None),
                last_remote: Mutex::new(None),
                update: Mutex::new(UpdateState::new(settings.auto_update)),
                pending: Mutex::new(None),
                startup: Mutex::new(StartupStatus::new("starting", None)),
                startup_task: Mutex::new(None),
            });

            // Start the local server in the background: the initial splash
            // page paints right away and the window navigates to the
            // server as soon as it answers /api/health. Blocking setup
            // here would keep the placeholder visible for the whole
            // server startup.
            start_local_server_async(&handle);

            // Periodic auto-update loop: the first check shortly after
            // startup so the UI is up, then every 6 hours. Each cycle is
            // skipped while a check, download or pending install is in
            // flight.
            std::thread::spawn(move || {
                std::thread::sleep(FIRST_UPDATE_CHECK_DELAY);
                loop {
                    let state = handle.state::<AppState>();
                    let auto = state.update.lock().unwrap().auto_update;
                    if auto {
                        tauri::async_runtime::spawn(check_for_updates(handle.clone(), true));
                    }
                    std::thread::sleep(UPDATE_CHECK_INTERVAL);
                }
            });

            Ok(())
        })
        // The settings UI (served by the local or remote server) drives
        // the local server and UI switching through this bridge.
        .register_uri_scheme_protocol("lumisca", |ctx, request| {
            handle_shell_request(ctx.app_handle(), request)
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    if let Some(mut local) = state.local.lock().unwrap().take() {
                        kill_process_tree(&mut local.child);
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
