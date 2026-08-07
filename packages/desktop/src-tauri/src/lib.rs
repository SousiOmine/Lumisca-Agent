use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, WindowEvent};

/// Server process handle stored in Tauri state.
struct ServerProcess(Mutex<Option<Child>>);

const DEFAULT_PORT: u16 = 8000;
const SERVER_PORT_ENV: &str = "LUMISCA_PORT";

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
/// 1. packaged: resources/server/lumisca-server(.exe) next to the app exe
/// 2. repository layout during development (cwd is packages/desktop/src-tauri)
fn find_server_command() -> Option<ServerCommand> {
    // Bundled resource: resources/server/lumisca-server.exe
    if let Ok(exe) = std::env::current_exe() {
        let bin = if cfg!(windows) {
            "lumisca-server.exe"
        } else {
            "lumisca-server"
        };
        let bundled = exe.parent()?.join("resources/server").join(bin);
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

fn server_db_path(app: &tauri::App) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("lumisca"));
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

/// Per-instance auth token for the spawned server. Beyond blocking casual
/// local processes from driving the agent, it lets the health check tell
/// OUR server apart from a stale instance of a previous run (which has a
/// different token and answers 401 to ours).
fn generate_token() -> String {
    let mut hasher = DefaultHasher::new();
    std::process::id().hash(&mut hasher);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    nanos.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Wait until OUR server answers GET /api/health (replaces a fixed sleep and
/// a bare TCP connect, which would accept ANY process on the port — e.g. a
/// stale server with a different database). The token is sent so a stale
/// instance cannot pass the check.
fn wait_for_server_health(port: u16, token: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Lumisca-Token: {token}\r\nConnection: close\r\n\r\n"
    );
    while Instant::now() < deadline {
        if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) {
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
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

fn start_server(app: &tauri::App, port: u16, token: &str) -> Result<Child, String> {
    let db_path = server_db_path(app);
    let command = find_server_command()
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
            // cwd, so pass it explicitly.
            let repo_root = entry
                .parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.parent())
                .map(|p| p.to_path_buf())
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

fn api_base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let token = generate_token();
            // Start the server; if it does not pass the health check within
            // the timeout (port taken by another process, bind race), kill it
            // and retry on a fresh port.
            let mut server_child: Option<Child> = None;
            let mut server_port: Option<u16> = None;
            for attempt in 0..10 {
                let port = resolve_port();
                let mut child = start_server(app, port, &token)?;
                if wait_for_server_health(port, &token, Duration::from_secs(5)) {
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
            app.manage(ServerProcess(Mutex::new(server_child)));
            let url = api_base_url(port);
            if let Some(window) = app.get_webview_window("main") {
                let parsed = url.parse::<url::Url>().map_err(|e| e.to_string())?;
                let _ = window.navigate(parsed);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<ServerProcess>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        kill_process_tree(&mut child);
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
