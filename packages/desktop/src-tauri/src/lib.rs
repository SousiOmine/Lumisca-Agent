use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;

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

/// Locate the server entry point:
/// 1. repository layout during development (workspace cwd is packages/desktop/src-tauri)
/// 2. bundled resource directory (packaging)
fn find_server_entry() -> Option<PathBuf> {
    let candidates = [
        Path::new("../../../packages/server/mod.ts").to_path_buf(),
        Path::new("../../server/mod.ts").to_path_buf(),
        Path::new("../server/mod.ts").to_path_buf(),
    ];
    for c in &candidates {
        if c.is_file() {
            return Some(c.clone());
        }
    }
    // Bundled resource: resources/server/main.ts
    #[cfg(debug_assertions)]
    let base = Path::new(".").to_path_buf();
    #[cfg(not(debug_assertions))]
    let base = {
        let exe = std::env::current_exe().ok()?;
        exe.parent()?.to_path_buf()
    };
    let bundled = base.join("resources/server/main.ts");
    if bundled.is_file() {
        return Some(bundled);
    }
    None
}

fn server_db_path(app: &tauri::App) -> PathBuf {
    let dir = app.path().app_data_dir().unwrap_or_else(|_| {
        std::env::temp_dir().join("lumisca")
    });
    let _ = std::fs::create_dir_all(&dir);
    dir.join("lumisca.db")
}

fn start_server(app: &tauri::App) -> Result<Child, String> {
    let deno = find_deno().ok_or_else(|| {
        "Deno runtime not found. Install Deno (https://deno.com) and add it to PATH.".to_string()
    })?;
    let entry = find_server_entry().ok_or_else(|| {
        "Lumisca server entry point not found. Build the project first.".to_string()
    })?;
    let db_path = server_db_path(app);
    let port = std::env::var(SERVER_PORT_ENV)
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);

    let child = Command::new(&deno)
        .args([
            "run",
            "--allow-net",
            "--allow-read",
            "--allow-write",
            "--allow-env",
            "--allow-run",
        ])
        .arg(&entry)
        .env("LUMISCA_DB", db_path)
        .env("LUMISCA_PORT", port.to_string())
        .spawn()
        .map_err(|e| format!("Failed to start Lumisca server: {e}"))?;

    Ok(child)
}

fn api_base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let child = start_server(app)?;
            app.manage(ServerProcess(Mutex::new(Some(child))));
            // Wait a moment for the server to bind before loading the UI.
            std::thread::sleep(std::time::Duration::from_millis(800));
            let port = std::env::var(SERVER_PORT_ENV)
                .ok()
                .and_then(|p| p.parse::<u16>().ok())
                .unwrap_or(DEFAULT_PORT);
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
                        let _ = child.kill();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
