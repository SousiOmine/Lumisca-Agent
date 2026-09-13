//! Local server process management: locating the server runtime, spawning
//! it, probing its health, and keeping the single `LocalServer` instance
//! that the bridge reuses across connections. All shared state lives in
//! `crate::AppState` (defined in lib.rs); this module only touches it
//! through the `AppHandle`.

use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use crate::server_log;
use crate::window::navigate_main;
use crate::{AppState, LockRecover, StartupStatus, StartupTask};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const DEFAULT_PORT: u16 = 8000;
const SERVER_PORT_ENV: &str = "LUMISCA_PORT";
/// Marks the server child as shell-managed: its binary lives inside the app
/// bundle, which this app's own updater replaces, so the server must not try
/// to update itself (see packages/server/mod.ts).
const SERVER_DESKTOP_ENV: &str = "LUMISCA_DESKTOP";
/// Poll interval while waiting for the local server to come up (the
/// compiled server answers in ~0.3s; a fast poll keeps the switch to the
/// app page snappy).
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(50);
/// How long one local startup attempt may wait before the port is
/// abandoned and a fresh one is tried. 3s covers a cold deno run; a
/// healthy server answers in well under a second.
const LOCAL_START_TIMEOUT: Duration = Duration::from_secs(3);
/// Second, longer health budget for a child that is still alive after
/// missing the first one (see `ensure_local_server`): long enough for a
/// server busy inside a long synchronous step, short enough to keep the
/// settings UI responsive.
const HEALTH_RECHECK_TIMEOUT: Duration = Duration::from_secs(10);

/// A locally spawned server process.
pub(crate) struct LocalServer {
    child: Child,
    /// Port the server listens on (127.0.0.1 only).
    pub(crate) port: u16,
    /// Per-instance auth token; doubles as the bridge key while local.
    pub(crate) token: String,
}

/// Liveness of the local server child, reported to the UI through the
/// bridge (`server/status`): the page cannot tell "server crashed" apart
/// from "server hung" on its own — both just stop answering — so the shell
/// (which owns the child handle) classifies it.
#[derive(serde::Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ServerLiveness {
    /// The child process is alive.
    Running,
    /// The child exited (code + captured tail available for copy-paste).
    Exited,
    /// No local server is currently tracked (remote mode, or never started).
    None,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalServerStatus {
    pub(crate) liveness: ServerLiveness,
    pub(crate) port: Option<u16>,
    /// Process exit code when the child already exited (None = signaled).
    pub(crate) exit_code: Option<i32>,
    pub(crate) log_tail: String,
}

/// Classify the tracked local server without blocking: `try_wait` reaps an
/// exited child exactly once, so the status (and its exit code) is stable
/// across polls.
pub(crate) fn local_server_status(app: &AppHandle) -> LocalServerStatus {
    let state = app.state::<AppState>();
    let tail = state.server_log.lock_recover().tail_text();
    let mut guard = state.local.lock_recover();
    let Some(local) = guard.as_mut() else {
        return LocalServerStatus {
            liveness: ServerLiveness::None,
            port: None,
            exit_code: None,
            log_tail: tail,
        };
    };
    match local.child.try_wait() {
        Ok(Some(status)) => LocalServerStatus {
            liveness: ServerLiveness::Exited,
            port: Some(local.port),
            exit_code: status.code(),
            log_tail: tail,
        },
        Ok(None) => LocalServerStatus {
            liveness: ServerLiveness::Running,
            port: Some(local.port),
            exit_code: None,
            // The tail is included while running too: when the server hangs
            // (alive but not answering), this output is the only clue, and
            // the UI offers it for copy-paste on its connection-lost banner.
            log_tail: tail.clone(),
        },
        Err(_) => LocalServerStatus {
            liveness: ServerLiveness::Running,
            port: Some(local.port),
            exit_code: None,
            log_tail: tail.clone(),
        },
    }
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

    // Capture the server's output: without piped stdout/stderr a mid-session
    // crash leaves nothing to diagnose ("勝手に落ちる" reports). The pumps
    // below tee every line into the in-memory tail (UI copy-paste) and the
    // on-disk log file (post-mortem); the pipes must be drained or the
    // child would block once their buffers fill.
    let mut child = match command {
        ServerCommand::Compiled(bin) => {
            // Packaged build: prebuilt frontend assets sit next to the
            // binary in the resources dir.
            let assets_file = bin.parent().unwrap_or(Path::new(".")).join("assets.json");
            let mut command = background_command(&bin);
            command
                .env("LUMISCA_DB", &db_path)
                .env("LUMISCA_PORT", port.to_string())
                .env("LUMISCA_TOKEN", token)
                .env(SERVER_DESKTOP_ENV, "1")
                .env("LUMISCA_ASSETS_FILE", assets_file);
            if let Some((url, browser_token)) = browser_lab_env(app) {
                command
                    .env("LUMISCA_BROWSER_IPC_URL", url)
                    .env("LUMISCA_BROWSER_TOKEN", browser_token);
            }
            command
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
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
                    "--allow-ffi",
                ])
                .arg(&entry)
                .env("LUMISCA_DB", db_path)
                .env("LUMISCA_PORT", port.to_string())
                .env("LUMISCA_REPO_ROOT", repo_root)
                .env("LUMISCA_TOKEN", token)
                .env(SERVER_DESKTOP_ENV, "1");
            if let Some((url, browser_token)) = browser_lab_env(app) {
                command
                    .env("LUMISCA_BROWSER_IPC_URL", url)
                    .env("LUMISCA_BROWSER_TOKEN", browser_token);
            }
            command
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to start Lumisca server: {e}"))?
        }
    };
    pump_server_output(app, child.stdout.take(), "stdout");
    pump_server_stderr(app, child.stderr.take());

    Ok(child)
}

/// Drain one of the server child's pipes on a background thread, teeing
/// every line into the shared ServerLog (in-memory tail + log file). Lines
/// are split on \n and carriage returns stripped (console progress output);
/// over-long lines are truncated so one runaway line cannot balloon the
/// buffer. The thread ends when the pipe closes (child exit).
fn pump_server_output(
    app: &AppHandle,
    pipe: Option<std::process::ChildStdout>,
    stream: &'static str,
) {
    let Some(pipe) = pipe else { return };
    let handle = app.clone();
    std::thread::spawn(move || {
        pump_server_stream(&handle, pipe, stream);
    });
}

fn pump_server_stderr(app: &AppHandle, pipe: Option<std::process::ChildStderr>) {
    let Some(pipe) = pipe else { return };
    let handle = app.clone();
    std::thread::spawn(move || {
        pump_server_stream(&handle, pipe, "stderr");
    });
}

fn pump_server_stream(handle: &AppHandle, pipe: impl Read + Send + 'static, stream: &'static str) {
    let reader = BufReader::new(pipe);
    // Buffer line-by-line (not read_to_string): the child keeps the
    // pipe open for its whole life, so a read-to-end would never yield.
    for chunk in reader.split(b'\n') {
        let Ok(bytes) = chunk else { break };
        // Strip a trailing \r (Windows console output) without touching
        // the rest of the line.
        let mut bytes = bytes;
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
        let text = server_log::truncate_line(String::from_utf8_lossy(&bytes).into_owned());
        // try_state: the app may already be torn down when the last
        // lines arrive (child exit races app exit).
        if handle.try_state::<AppState>().is_none() {
            break;
        }
        server_log::push(handle, stream, text);
    }
}

/// The browser lab's RPC endpoint (URL + token) for the server child
/// process, when the lab is running. Absent → the server gets no browser
/// environment (and the agent no browser tools).
fn browser_lab_env(app: &AppHandle) -> Option<(String, String)> {
    let state = app.state::<AppState>();
    let guard = state.browser_lab.lock_recover();
    let lab = guard.as_ref()?;
    Some(lab.endpoint())
}

/// Kill the server AND everything it spawned (tool children would
/// otherwise survive as orphans): taskkill /T on Windows, the whole
/// process group on POSIX. The tree kill is waited for (bounded) before
/// the server child itself is reaped, so the grandchildren are dead
/// before this returns — a spawned-and-forgotten taskkill races app exit
/// and orphans the tree.
fn kill_process_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let pid = child.id();
        // Wait for the tree kill to finish: the server's own shutdown
        // (SIGTERM → core.close → taskkill for each background command)
        // needs the tree gone before the process exits, and a fire-and-
        // forget taskkill may die with us before it runs.
        let _ = background_command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        // Give the OS a beat to reap the killed tree before reaping the
        // server child itself (bounded: at most ~2s).
        for _ in 0..20 {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(_) => break,
            }
        }
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
/// window is destroyed and by the updater's exit hook. The stop is a hard
/// tree kill (there is no console to send a signal to on Windows), so the
/// server prints nothing of its own and leaves its database un-checkpointed
/// — `reason` is what the captured log gets instead, so a post-mortem can
/// tell this apart from a crash.
pub(crate) fn stop_local_server(app: &AppHandle, reason: &str) {
    if let Some(mut local) = app.state::<AppState>().local.lock_recover().take() {
        server_log::note(
            app,
            format!(
                "Stopping the local server (pid {}, port {}): {reason}. The whole process tree is killed.",
                local.child.id(),
                local.port
            ),
        );
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
        .lock_recover()
        .as_ref()
        .map(|l| (l.port, l.token.clone(), l.child.id()));
    if let Some((port, token, pid)) = stored {
        if health_check("127.0.0.1", port, Some(&token), LOCAL_START_TIMEOUT) {
            return Ok(page_url(&format!("http://127.0.0.1:{port}"), &token));
        }
        // A missed health check does NOT mean a dead process: a server that
        // is busy inside a long synchronous step (a large database write, a
        // loaded machine) can miss the 3s budget while it is healthy and
        // mid-run, and killing it here would destroy the user's in-flight
        // work. Only a child that has really exited is replaced silently; a
        // live one is re-checked with a longer budget and then reported
        // instead of killed — the banner's "サーバーを再起動" is the
        // explicit way to force a hung server down.
        let alive = {
            let mut guard = state.local.lock_recover();
            match guard.as_mut() {
                Some(local) => matches!(local.child.try_wait(), Ok(None)),
                None => false,
            }
        };
        if alive {
            if health_check("127.0.0.1", port, Some(&token), HEALTH_RECHECK_TIMEOUT) {
                return Ok(page_url(&format!("http://127.0.0.1:{port}"), &token));
            }
            server_log::note(
                app,
                format!(
                    "The local server (pid {pid}, port {port}) is alive but did not answer /api/health in {}s + {}s; left running.",
                    LOCAL_START_TIMEOUT.as_secs(),
                    HEALTH_RECHECK_TIMEOUT.as_secs()
                ),
            );
            return Err(format!(
                "ローカルサーバーが応答していません（PID: {pid}, Port: {port}）。上部バナーの「サーバーを再起動」をクリックするか、アプリを再起動してください。"
            ));
        }
        server_log::note(
            app,
            format!(
                "The stored local server (pid {pid}, port {port}) has exited; starting a fresh one."
            ),
        );
        // The child is gone (or never started): drop it and reap its tree —
        // tool processes it spawned can outlive it.
        if let Some(mut stale) = state.local.lock_recover().take() {
            kill_process_tree(&mut stale.child);
        }
    }
    // A fresh start gets a fresh tail: the previous instance's output must
    // not masquerade as the new one's when diagnosing a crash loop.
    // (After the reuse check above, so a healthy reuse never wipes it.)
    server_log::clear(app);
    let token = generate_token();
    let mut server_child: Option<Child> = None;
    let mut server_port: Option<u16> = None;
    let mut last_detail = String::new();
    for attempt in 0..10 {
        let port = resolve_port();
        let mut child = start_server(app, port, &token)?;
        if health_check("127.0.0.1", port, Some(&token), LOCAL_START_TIMEOUT) {
            server_child = Some(child);
            server_port = Some(port);
            break;
        }
        // Keep the failed attempt's tail: it is usually the actual reason
        // (port clash, missing Deno, listen error) and would otherwise be
        // cleared by the next attempt before anyone can read it.
        last_detail = last_log_lines(&server_log::tail(app), 20);
        server_log::note(
            app,
            format!(
                "Start attempt {} on port {port} did not answer /api/health in {}s; killing it.",
                attempt + 1,
                LOCAL_START_TIMEOUT.as_secs()
            ),
        );
        kill_process_tree(&mut child);
        if attempt == 9 {
            return Err(startup_error_message(&last_detail));
        }
        // Give the previous port a moment to be released.
        std::thread::sleep(Duration::from_millis(300));
    }
    let port = server_port.ok_or_else(|| startup_error_message(&last_detail))?;
    let child = server_child.ok_or_else(|| startup_error_message(&last_detail))?;
    *state.local.lock_recover() = Some(LocalServer {
        child,
        port,
        token: token.clone(),
    });
    Ok(page_url(&format!("http://127.0.0.1:{port}"), &token))
}

/// Startup failure message: the generic "did not become ready" plus the
/// failed attempt's captured output (usually the real cause — a listen
/// error, a missing runtime) so the splash page can show it directly.
fn startup_error_message(last_detail: &str) -> String {
    const BASE: &str = "Lumisca server did not become ready";
    let detail = last_detail.trim();
    if detail.is_empty() {
        return BASE.into();
    }
    format!("{BASE}\n\nサーバーログ:\n{detail}")
}

/// Last `n` lines of `text` (oldest first), for failure messages.
fn last_log_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let skip = lines.len().saturating_sub(n);
    lines[skip..].join("\n")
}

/// Restart the local server after a mid-session death (crash or hang): drop
/// the dead child and run the normal start path. The caller navigates to
/// the returned page URL. Reported through the bridge (`server/restart`)
/// so the UI can offer "再起動" on its connection-lost banner.
pub(crate) fn restart_local_server(app: &AppHandle) -> Result<String, String> {
    server_log::note(app, "Restart requested from the page banner.");
    if let Some(mut stale) = app.state::<AppState>().local.lock_recover().take() {
        server_log::note(
            app,
            format!(
                "Killing the stored local server (pid {}, port {}) for the restart.",
                stale.child.id(),
                stale.port
            ),
        );
        kill_process_tree(&mut stale.child);
    }
    // Forget a remote display: the restart is explicitly about the local
    // server, so the window must come back to it.
    *app.state::<AppState>().last_remote.lock_recover() = None;
    let url = ensure_local_server(app)?;
    navigate_main(app, &url)?;
    Ok(url)
}

/// Start the local server in the background and navigate the main window
/// to its page once it is healthy. setup() returns immediately so the
/// splash page paints without waiting; the bridge state reports the
/// progress ("starting" → "ready"/"error") for the splash to poll.
pub(crate) fn start_local_server_async(app: &AppHandle) {
    let shared: StartupTask = Arc::new(Mutex::new(None));
    *app.state::<AppState>().startup_task.lock_recover() = Some(shared.clone());
    let handle = app.clone();
    std::thread::spawn(move || {
        let result = ensure_local_server(&handle);
        let (status, error) = match &result {
            Ok(_) => ("ready", None),
            Err(message) => ("error", Some(message.clone())),
        };
        {
            let state = handle.state::<AppState>();
            *shared.lock_recover() = Some(result.clone());
            *state.startup_task.lock_recover() = None;
            *state.startup.lock_recover() = StartupStatus::new(status, error);
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
                    .lock_recover()
                    .is_some();
                if !remote {
                    let _ = navigate_main(&inside, &url);
                }
            });
        }
    });
}
