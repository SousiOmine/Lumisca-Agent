//! Local server process management: locating the server runtime, spawning
//! it, probing its health, and keeping the single `LocalServer` instance
//! that the bridge reuses across connections. All shared state lives in
//! `crate::AppState` (defined in lib.rs); this module only touches it
//! through the `AppHandle`.

use std::ffi::OsStr;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use crate::window::navigate_main;
use crate::{AppState, StartupStatus, StartupTask};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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

/// A locally spawned server process.
pub(crate) struct LocalServer {
    child: Child,
    /// Port the server listens on (127.0.0.1 only).
    pub(crate) port: u16,
    /// Per-instance auth token; doubles as the bridge key while local.
    pub(crate) token: String,
}

/// Create a child process without letting console executables open a
/// Command Prompt window beside the desktop UI on Windows, and (on POSIX)
/// in its own process group so the whole server tree can be killed
/// together.
fn background_command<S: AsRef<OsStr>>(program: S) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Own process group: children spawned by the server (tool
        // processes) inherit it, so kill_process_tree can take the whole
        // tree down instead of leaving orphans.
        command.process_group(0);
    }
    command
}

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
/// 1. development: repository layout (cwd is packages/desktop/src-tauri) —
///    the server runs from current source via `deno run`, so code changes
///    take effect on the next dev launch
/// 2. packaged: server/lumisca-server(.exe) in Tauri's resource directory
///
/// Dev builds must NOT prefer the bundled binary: `tauri dev` copies every
/// bundle resource into target/debug, including any real
/// lumisca-server(.exe) left in resources/ by an earlier release build
/// (`npm run build:server` runs during `tauri build`). That silently boots
/// a stale compiled server (an old feature set, old MCP handling) while the
/// shell itself is freshly built — exactly the trap where the agent's tools
/// do not match the repository. Debug builds therefore start from the
/// repository entry point whenever one is reachable, and only fall back to
/// the bundled binary when no source tree exists (a dev build installed as
/// a standalone package).
fn find_server_command(app: &AppHandle) -> Option<ServerCommand> {
    let bundled = app.path().resource_dir().ok().map(|resource_dir| {
        // `tauri.conf.json` maps the bundled files to `server/*` relative
        // to Tauri's platform-specific resource directory.
        resource_dir.join("server").join(if cfg!(windows) {
            "lumisca-server.exe"
        } else {
            "lumisca-server"
        })
    });
    let repo_entry = [
        "../../../packages/server/mod.ts",
        "../../server/mod.ts",
        "../server/mod.ts",
    ]
        .into_iter()
        .map(PathBuf::from)
        .find(|p| p.is_file());
    if let Some(entry) = repo_entry.as_ref() {
        // Development always runs the repository source when it is
        // reachable; the bundled binary is for packaged (release) builds.
        if cfg!(debug_assertions) {
            return Some(ServerCommand::Deno(entry.clone()));
        }
    }
    if let Some(bundled) = bundled {
        // In dev, the build pipeline copies the zero-byte placeholder
        // produced by build:server:dev into the resource directory — an
        // empty file is never a runnable server, so ignore it. A real
        // binary (length > 0) is what packaged builds run.
        let real_binary = bundled.metadata().map(|m| m.len() > 0).unwrap_or(false);
        if real_binary {
            return Some(ServerCommand::Compiled(bundled));
        }
    }
    repo_entry.map(ServerCommand::Deno)
}

/// Desktop data directory (server database, desktop settings).
pub(crate) fn app_data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("lumisca"))
}

fn server_db_path(app: &AppHandle) -> PathBuf {
    let dir = app_data_dir(app);
    let _ = std::fs::create_dir_all(&dir);
    dir.join("lumisca.db")
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
/// ours). Also reused by the browser lab (browser_lab.rs).
pub(crate) fn generate_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("OS random number source must be available");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Check a server's GET /api/health over raw TCP. `host` may be a hostname
/// or an IP literal; `token` is optional (servers without token auth answer
/// without it). The Host header names the target host so the server's Host
/// guard accepts the probe. Replaces a bare TCP connect, which would accept
/// ANY process on the port — e.g. a stale server with a different database.
pub(crate) fn health_check(host: &str, port: u16, token: Option<&str>, timeout: Duration) -> bool {
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

/// The page URL to open for a connection: the base URL plus `/?token=`
/// (the page is token-guarded in production mode).
pub(crate) fn page_url(base: &str, token: &str) -> String {
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
            let mut command = background_command(&bin);
            command
                .env("LUMISCA_DB", &db_path)
                .env("LUMISCA_PORT", port.to_string())
                .env("LUMISCA_TOKEN", token)
                .env("LUMISCA_ASSETS_FILE", assets_file);
            if let Some((url, browser_token)) = browser_lab_env(app) {
                command
                    .env("LUMISCA_BROWSER_IPC_URL", url)
                    .env("LUMISCA_BROWSER_TOKEN", browser_token);
            }
            command
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
            let mut command = background_command(&deno);
            command
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
                .env("LUMISCA_TOKEN", token);
            if let Some((url, browser_token)) = browser_lab_env(app) {
                command
                    .env("LUMISCA_BROWSER_IPC_URL", url)
                    .env("LUMISCA_BROWSER_TOKEN", browser_token);
            }
            command
                .spawn()
                .map_err(|e| format!("Failed to start Lumisca server: {e}"))?
        }
    };

    Ok(child)
}

/// The browser lab's RPC endpoint (URL + token) for the server child
/// process, when the lab is running. Absent → the server gets no browser
/// environment (and the agent no browser tools).
fn browser_lab_env(app: &AppHandle) -> Option<(String, String)> {
    let state = app.state::<AppState>();
    let guard = state.browser_lab.lock().unwrap();
    let lab = guard.as_ref()?;
    Some(lab.endpoint())
}

/// Kill the server AND everything it spawned (tool children would
/// otherwise survive as orphans): taskkill /T on Windows, the whole
/// process group on POSIX.
fn kill_process_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let pid = child.id();
        let _ = background_command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .spawn();
    }
    #[cfg(unix)]
    {
        // The server was spawned as a process-group leader
        // (background_command); every process it spawned shares the group.
        let pid = child.id() as i32;
        unsafe { libc::kill(-pid, libc::SIGKILL) };
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Kill and drop the running local server, if any. Used when the main
/// window is destroyed and by the updater's exit hook.
pub(crate) fn stop_local_server(app: &AppHandle) {
    if let Some(mut local) = app.state::<AppState>().local.lock().unwrap().take() {
        kill_process_tree(&mut local.child);
    }
}

/// Start the local server (or reuse the running one) and return the page
/// URL. Retries on fresh ports when the health check fails (port taken by
/// another process, bind race).
pub(crate) fn ensure_local_server(app: &AppHandle) -> Result<String, String> {
    let state = app.state::<AppState>();
    // Reuse the stored server only if it is actually alive: a crashed
    // process would otherwise leave the WebView stuck on an unreachable
    // page. The health check also rejects a stale instance of a previous
    // run (different token -> 401).
    let stored = state
        .local
        .lock()
        .unwrap()
        .as_ref()
        .map(|l| (l.port, l.token.clone()));
    if let Some((port, token)) = stored {
        if health_check("127.0.0.1", port, Some(&token), LOCAL_START_TIMEOUT) {
            return Ok(page_url(&format!("http://127.0.0.1:{port}"), &token));
        }
        // The stored server is dead (or never started): drop it and fall
        // through to a fresh start.
        if let Some(mut stale) = state.local.lock().unwrap().take() {
            kill_process_tree(&mut stale.child);
        }
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
pub(crate) fn start_local_server_async(app: &AppHandle) {
    let shared: StartupTask = Arc::new(Mutex::new(None));
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
