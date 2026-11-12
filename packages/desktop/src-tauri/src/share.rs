//! Lending a folder from this computer to the conversation the window shows.
//!
//! The shell owns the CONSENT and the list; the process this module spawns
//! (`lumisca-server share`, see packages/server/share-host.ts) owns the disk
//! and the idle clock. That split is why nothing here reads the folder: the
//! picker chose it, the user set the terms, and the lending child answers the
//! agent's calls with the same sandbox code mode uses.
//!
//! The child is spawned lazily — a window that never lends anything pays
//! nothing — and lives as long as the app. Its stdin carries two kinds of
//! line, `hello` (which server to dial) and `grants` (the complete list, so a
//! withdrawal is just a list without it). Its stdout carries `expired`, which
//! is how the idle clock's verdict reaches the list here: without it, the next
//! lending would re-announce a folder that had already lapsed.
//!
//! Every grant is dropped when the window changes which server it shows. A
//! loan names one conversation on one server; carrying it to another server
//! would lend a folder to something the user never chose.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Stdio};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::{server, server_log, AppState, LockRecover};

/// One folder this shell has lent, as both this module and the page see it.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShareGrantView {
    pub(crate) id: String,
    /// The stella conversation (its server-side session id) it was lent to.
    pub(crate) session_id: String,
    /// The folder on this computer, absolute.
    pub(crate) path: String,
    pub(crate) write: bool,
    pub(crate) exec: bool,
}

/// The line the child receives for one grant. The field names are the
/// child's contract (`LocalGrant` in packages/server/share-host.ts).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GrantLine<'a> {
    id: &'a str,
    session_id: &'a str,
    path: &'a str,
    write: bool,
    exec: bool,
}

struct Endpoint {
    url: String,
    token: String,
}

/// The lending child and what it was told, behind one mutex in `AppState`.
#[derive(Default)]
pub(crate) struct ShareLender {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    grants: Vec<ShareGrantView>,
    /// What the child was last told to dial. Cleared when it is respawned or
    /// the display changes, so the next lending says hello first.
    endpoint: Option<Endpoint>,
}

impl ShareLender {
    fn view(&self) -> Vec<ShareGrantView> {
        self.grants.clone()
    }

    fn write_line(&mut self, value: serde_json::Value) -> Result<(), String> {
        let Some(stdin) = self.stdin.as_mut() else {
            return Err("フォルダ共有のプロセスに接続できていません".to_string());
        };
        let text = value.to_string();
        writeln!(stdin, "{text}")
            .and_then(|_| stdin.flush())
            .map_err(|error| format!("フォルダ共有のプロセスに書き込めません: {error}"))
    }

    fn send_grants(&mut self) -> Result<(), String> {
        let grants: Vec<GrantLine> = self
            .grants
            .iter()
            .map(|grant| GrantLine {
                id: &grant.id,
                session_id: &grant.session_id,
                path: &grant.path,
                write: grant.write,
                exec: grant.exec,
            })
            .collect();
        self.write_line(serde_json::json!({ "type": "grants", "grants": grants }))
    }

    /// Start the child if it is not running, and say hello when this is a new
    /// child or a new server.
    fn prepare(&mut self, app: &AppHandle, url: &str, token: &str) -> Result<(), String> {
        self.ensure_child(app)?;
        let same = self
            .endpoint
            .as_ref()
            .map(|endpoint| endpoint.url == url && endpoint.token == token)
            .unwrap_or(false);
        if !same {
            self.write_line(serde_json::json!({
                "type": "hello",
                "url": url,
                "token": token,
            }))?;
            self.endpoint = Some(Endpoint {
                url: url.to_string(),
                token: token.to_string(),
            });
        }
        self.send_grants()
    }

    fn ensure_child(&mut self, app: &AppHandle) -> Result<(), String> {
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(None) => return Ok(()),
                // It exited (a crash, or something killed it): forget it and
                // start a fresh one on this lending.
                _ => {
                    self.child = None;
                    self.stdin = None;
                }
            }
        }
        let mut command = server::share_process_command(app)?;
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("フォルダ共有のプロセスを起動できません: {error}"))?;
        let stdin = child.stdin.take();
        if let Some(stdout) = child.stdout.take() {
            pump_stdout(app.clone(), stdout);
        }
        if let Some(stderr) = child.stderr.take() {
            pump_stderr(app.clone(), stderr);
        }
        server_log::note(app, "フォルダ共有のプロセスを起動しました。");
        self.child = Some(child);
        self.stdin = stdin;
        // A new process has been told nothing: the next `prepare` says hello.
        self.endpoint = None;
        Ok(())
    }
}

/// The endpoint of the server the window is showing: the remote one while a
/// remote server is displayed, otherwise the local child. `None` before a
/// server exists (the splash page has no conversation to lend to).
pub(crate) fn displayed_endpoint(app: &AppHandle) -> Option<(String, String)> {
    let state = app.state::<AppState>();
    if let Some(remote) = state.last_remote.lock_recover().clone() {
        return Some((remote.url, remote.token));
    }
    let local = state.local.lock_recover();
    local.as_ref().map(|local| {
        (
            format!("http://127.0.0.1:{}", local.port),
            local.token.clone(),
        )
    })
}

/// Let the user choose a folder. Runs on a bridge thread, never the main
/// thread, which is what makes the blocking picker safe here.
pub(crate) fn pick_folder(app: &AppHandle) -> Result<Option<String>, String> {
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|error| format!("選んだフォルダを読み取れません: {error}"))?;
    Ok(Some(simplify(path)))
}

/// Lend `path` to `session_id`, replacing the terms if this conversation
/// already has that folder. The folder is validated here because this is the
/// side that owns the disk: a path the picker did not choose (a page bug, a
/// stale recent entry) must not reach the lending child.
pub(crate) fn grant(
    app: &AppHandle,
    session_id: &str,
    path: &str,
    write: bool,
    exec: bool,
) -> Result<ShareGrantView, String> {
    if session_id.is_empty() {
        return Err("借りる会話が指定されていません".to_string());
    }
    let requested = PathBuf::from(path);
    if !requested.is_absolute() {
        return Err("フォルダは絶対パスで指定してください".to_string());
    }
    let canonical = std::fs::canonicalize(&requested)
        .map_err(|_| format!("フォルダが見つかりません: {}", requested.display()))?;
    if !canonical.is_dir() {
        return Err(format!("フォルダではありません: {}", requested.display()));
    }
    let folder = simplify(canonical);
    let (url, token) =
        displayed_endpoint(app).ok_or_else(|| "表示中のサーバーがありません".to_string())?;

    let state = app.state::<AppState>();
    let mut lender = state.share.lock_recover();
    let view = if let Some(existing) = lender
        .grants
        .iter_mut()
        .find(|grant| grant.session_id == session_id && grant.path == folder)
    {
        // The same folder lent again with other terms: one grant, new terms.
        // A second grant would give the conversation `/lend/proj-2` for the
        // same folder, which is a name the user never asked for.
        existing.write = write;
        existing.exec = exec;
        existing.clone()
    } else {
        let view = ShareGrantView {
            id: server::generate_token(),
            session_id: session_id.to_string(),
            path: folder,
            write,
            exec,
        };
        lender.grants.push(view.clone());
        view
    };
    lender.prepare(app, &url, &token)?;
    server_log::note(
        app,
        format!(
            "フォルダを貸しました: {} (書き込み: {}, コマンド: {})",
            view.path,
            if write { "可" } else { "不可" },
            if exec { "可" } else { "不可" }
        ),
    );
    Ok(view)
}

/// Withdraw one grant. The child announces the shorter list, and the server
/// tells the conversation its folder is gone.
pub(crate) fn revoke(app: &AppHandle, id: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut lender = state.share.lock_recover();
    let before = lender.grants.len();
    lender.grants.retain(|grant| grant.id != id);
    if lender.grants.len() == before {
        return Ok(());
    }
    if lender.child.is_some() {
        lender.send_grants()?;
    }
    Ok(())
}

/// Every grant this shell holds, for the page to avoid re-lending a folder it
/// already lent.
pub(crate) fn list(app: &AppHandle) -> Vec<ShareGrantView> {
    app.state::<AppState>().share.lock_recover().view()
}

/// Drop every grant: the window is about to show a different server. The
/// child keeps running but is told nothing until the next lending says hello,
/// which is also what keeps it from dialing the old server.
pub(crate) fn revoke_all(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut lender = state.share.lock_recover();
    let had = lender.grants.len();
    lender.grants.clear();
    lender.endpoint = None;
    if had > 0 && lender.child.is_some() {
        let _ = lender.send_grants();
        server_log::note(
            app,
            "表示するサーバーが変わったため、貸出をすべて取り消しました。",
        );
    }
}

/// Stop the child (app exit). Closing its stdin is the contract: the lending
/// process leaves when its input ends, and every loan goes with it.
pub(crate) fn shutdown(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let mut lender = state.share.lock_recover();
    lender.grants.clear();
    lender.stdin = None;
    if let Some(mut child) = lender.child.take() {
        server::kill_process_tree(&mut child);
    }
}

/// Drain the child's stdout: `expired` lines update the list here; anything
/// else is logged. The thread ends when the pipe closes (the child exited).
fn pump_stdout(app: AppHandle, pipe: ChildStdout) {
    std::thread::spawn(move || {
        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Some(ids) = expired_ids(line) {
                let state = app.state::<AppState>();
                let mut lender = state.share.lock_recover();
                lender.grants.retain(|grant| !ids.contains(&grant.id));
                drop(lender);
                server_log::note(
                    &app,
                    format!(
                        "30分アクセスが無かったため貸出を終了しました: {}",
                        ids.join(", ")
                    ),
                );
                continue;
            }
            server_log::note(&app, format!("[share] {line}"));
        }
    });
}

fn pump_stderr(app: AppHandle, pipe: ChildStderr) {
    std::thread::spawn(move || {
        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            server_log::note(&app, line.to_string());
        }
    });
}

/// The grant ids in one `expired` line, or `None` when the line is not one.
fn expired_ids(line: &str) -> Option<Vec<String>> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("type")?.as_str()? != "expired" {
        return None;
    }
    let ids = value.get("ids")?.as_array()?;
    Some(
        ids.iter()
            .filter_map(|id| id.as_str().map(str::to_string))
            .collect(),
    )
}

/// The path as the user and the lending child see it: `canonicalize` answers
/// with a verbatim `\\?\C:\...` path on Windows, which is not what a folder
/// picker shows and not what a path segment can carry.
fn simplify(path: PathBuf) -> String {
    let text = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    text
}
