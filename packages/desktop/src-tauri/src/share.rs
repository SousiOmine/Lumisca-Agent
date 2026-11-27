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

use crate::{server, server_log, settings, AppState, LockRecover};

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
    /// The loan this grant belongs to, when the user lent several places at
    /// once ("this computer"). The page draws one row per loan and withdraws
    /// them together; a folder lent on its own has none.
    pub(crate) group: Option<String>,
}

/// One place a whole-computer loan may cover: a drive on Windows, the root
/// on macOS and Linux. The shell enumerates these; the page chooses among
/// them, and the grant path of a computer loan accepts nothing else.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ComputerRoot {
    /// The path to lend, absolute.
    pub(crate) path: String,
    /// What the row is called: the drive letter, or the root's own path.
    pub(crate) label: String,
    /// "drive" or "root": the page says which kind of place it is.
    pub(crate) kind: String,
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
    group: Option<&'a str>,
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
    fn write_line(&mut self, value: serde_json::Value) -> Result<(), String> {
        let Some(stdin) = self.stdin.as_mut() else {
            return Err("フォルダ共有のプロセスに接続できていません".to_string());
        };
        let text = value.to_string();
        writeln!(stdin, "{text}")
            .and_then(|_| stdin.flush())
            .map_err(|error| format!("フォルダ共有のプロセスに書き込めません: {error}"))
    }

    /// Announce the complete list, and with it the idle deadline the lending
    /// process must apply. Both travel together because a list without the
    /// deadline would leave the process on whatever it was told last; the
    /// setting is read here rather than kept beside the grants so the file
    /// stays the one place it lives.
    fn send_grants(&mut self, app: &AppHandle) -> Result<(), String> {
        let grants: Vec<GrantLine> = self
            .grants
            .iter()
            .map(|grant| GrantLine {
                id: &grant.id,
                session_id: &grant.session_id,
                path: &grant.path,
                write: grant.write,
                group: grant.group.as_deref(),
            })
            .collect();
        self.write_line(serde_json::json!({
            "type": "grants",
            "grants": grants,
            "idleMs": idle_ms(app),
        }))
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
        self.send_grants(app)
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
    if let Some(remote) = state.displayed.lock_recover().clone() {
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
    let folder = simplify(path);
    remember_approved(app, &folder)?;
    Ok(Some(folder))
}

/// Record a folder the picker returned. This is the consent `grant` checks:
/// the page cannot approve a path, only the picker can.
fn remember_approved(app: &AppHandle, folder: &str) -> Result<(), String> {
    settings::update(app, |settings| {
        if !settings
            .approved_share_folders
            .iter()
            .any(|path| path == folder)
        {
            settings.approved_share_folders.push(folder.to_string());
        }
    })
}

/// The idle deadline in the settings: minutes, or `None` for "do not end a
/// loan on its own".
pub(crate) fn idle_minutes(app: &AppHandle) -> Option<u32> {
    settings::load(app).share_idle_minutes
}

/// The deadlines Settings → アプリ offers. Anything else is refused before it
/// is written: the page's list and this one are the same choices, and a value
/// neither side names would leave the process on a clock no page shows.
const IDLE_MINUTES: [u32; 4] = [5, 10, 15, 30];

/// The deadline the lending process is told, in milliseconds.
fn idle_ms(app: &AppHandle) -> Option<u64> {
    idle_minutes(app).map(|minutes| u64::from(minutes) * 60_000)
}

/// Change the idle deadline. A running lending process hears about it at
/// once: its clock is what ends a loan, and waiting for the next grant would
/// leave the old deadline in force until the user lent something else.
pub(crate) fn set_idle_minutes(app: &AppHandle, minutes: Option<u32>) -> Result<(), String> {
    if let Some(minutes) = minutes {
        if !IDLE_MINUTES.contains(&minutes) {
            return Err(format!("自動切断の時間として使えない値です: {minutes}分"));
        }
    }
    settings::update(app, |settings| {
        settings.share_idle_minutes = minutes;
    })?;
    let state = app.state::<AppState>();
    let mut lender = state.share.lock_recover();
    if lender.child.is_some() {
        lender.send_grants(app)?;
    }
    drop(lender);
    server_log::note(
        app,
        match minutes {
            Some(minutes) => format!("フォルダー共有の自動切断を{minutes}分に変更しました。"),
            None => "フォルダー共有の自動切断を無効にしました。".to_string(),
        },
    );
    Ok(())
}

/// Whether `folder` may be lent: the picker returned it at some point, or it
/// is already lent (changing the terms of an existing loan).
fn may_lend(approved: &[String], granted: &[ShareGrantView], folder: &str) -> bool {
    approved.iter().any(|path| path == folder) || granted.iter().any(|grant| grant.path == folder)
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
) -> Result<ShareGrantView, String> {
    let folder = lendable_folder(path)?;
    let state = app.state::<AppState>();
    let approved = settings::load(app).approved_share_folders;
    {
        let lender = state.share.lock_recover();
        if !may_lend(&approved, &lender.grants, &folder) {
            return Err(
                "このフォルダーは選択されていません。フォルダーを選択してから共有してください。"
                    .to_string(),
            );
        }
    }
    grant_at(app, session_id, &folder, write, None)
}

/// Lend every place the user chose as one loan ("this computer").
///
/// The shell enumerated these roots and the user confirmed the list, so the
/// folder picker's approval check does not apply; the paths are checked
/// against the shell's own enumeration instead. One group id ties the grants
/// together, which is how the page and the user withdraw the loan at once.
pub(crate) fn grant_computer(
    app: &AppHandle,
    session_id: &str,
    write: bool,
) -> Result<Vec<ShareGrantView>, String> {
    let allowed = detect_computer_roots();
    if allowed.is_empty() {
        return Err("貸せる場所が見つかりませんでした".to_string());
    }
    let group = format!("pc-{}", server::generate_token());
    let mut grants = Vec::with_capacity(allowed.len());
    for root in allowed {
        let folder = lendable_folder(&root.path)?;
        grants.push(grant_at(app, session_id, &folder, write, Some(&group))?);
    }
    server_log::note(
        app,
        format!("このパソコンを貸しました: {}か所", grants.len()),
    );
    Ok(grants)
}

/// The places a whole-computer loan may cover on this machine.
///
/// Windows has one root per drive and no single one above them, so a loan of
/// "this computer" is a list: every drive the shell can see. A drive that is
/// not ready is not enumerated.
#[cfg(windows)]
pub(crate) fn detect_computer_roots() -> Vec<ComputerRoot> {
    let mut roots = Vec::new();
    for letter in b'A'..=b'Z' {
        let path = format!("{}:\\", letter as char);
        if PathBuf::from(&path).exists() {
            roots.push(ComputerRoot {
                path,
                label: format!("{}:", letter as char),
                kind: "drive".to_string(),
            });
        }
    }
    roots
}

/// The places a whole-computer loan may cover on this machine.
///
/// macOS and Linux have one root, and every volume is below it.
#[cfg(not(windows))]
pub(crate) fn detect_computer_roots() -> Vec<ComputerRoot> {
    vec![ComputerRoot {
        path: "/".to_string(),
        label: "/".to_string(),
        kind: "root".to_string(),
    }]
}

/// The folder a path names, canonical and absolute, or why it cannot be
/// lent. The disk boundary is checked before the path is measured.
fn lendable_folder(path: &str) -> Result<String, String> {
    let requested = PathBuf::from(path);
    if !requested.is_absolute() {
        return Err("フォルダは絶対パスで指定してください".to_string());
    }
    let canonical = std::fs::canonicalize(&requested)
        .map_err(|_| format!("フォルダが見つかりません: {}", requested.display()))?;
    if !canonical.is_dir() {
        return Err(format!("フォルダではありません: {}", requested.display()));
    }
    Ok(simplify(canonical))
}

/// One grant, made with the terms and group the caller decided.
fn grant_at(
    app: &AppHandle,
    session_id: &str,
    folder: &str,
    write: bool,
    group: Option<&str>,
) -> Result<ShareGrantView, String> {
    if session_id.is_empty() {
        return Err("借りる会話が指定されていません".to_string());
    }
    let (url, token) =
        displayed_endpoint(app).ok_or_else(|| "表示中のサーバーがありません".to_string())?;

    let state = app.state::<AppState>();
    let mut lender = state.share.lock_recover();
    let mut added = false;
    let view = if let Some(existing) = lender
        .grants
        .iter_mut()
        .find(|grant| grant.session_id == session_id && grant.path == folder)
    {
        // The same folder lent again with other terms: one grant, new terms.
        // A second grant would give the conversation `/lend/proj-2` for the
        // same folder, which is a name the user never asked for.
        existing.write = write;
        existing.group = group.map(str::to_string);
        existing.clone()
    } else {
        let view = ShareGrantView {
            id: server::generate_token(),
            session_id: session_id.to_string(),
            path: folder.to_string(),
            write,
            group: group.map(str::to_string),
        };
        lender.grants.push(view.clone());
        added = true;
        view
    };
    if let Err(error) = lender.prepare(app, &url, &token) {
        // Nothing reached the server, so the list must not keep promising a
        // folder no process is serving. (An updated grant keeps its place:
        // its folder was already lent and is still served.)
        if added {
            lender.grants.retain(|grant| grant.id != view.id);
        }
        return Err(error);
    }
    server_log::note(
        app,
        format!(
            "フォルダを貸しました: {} (書き込み: {})",
            view.path,
            if write { "可" } else { "不可" }
        ),
    );
    Ok(view)
}

/// Withdraw every grant of one loan ("this computer").
pub(crate) fn revoke_group(app: &AppHandle, group: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut lender = state.share.lock_recover();
    if !without_group(&mut lender.grants, group) {
        return Ok(());
    }
    if lender.child.is_some() {
        lender.send_grants(app)?;
    }
    Ok(())
}

/// Drop every grant of `group`, and say whether any was dropped.
fn without_group(grants: &mut Vec<ShareGrantView>, group: &str) -> bool {
    let before = grants.len();
    grants.retain(|grant| grant.group.as_deref() != Some(group));
    grants.len() != before
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
        lender.send_grants(app)?;
    }
    Ok(())
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
        let _ = lender.send_grants(app);
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
                        "アクセスが無いまま自動切断の時間を過ぎたため、共有を終了しました: {}",
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

#[cfg(test)]
mod tests {
    use super::*;

    fn grant(path: &str) -> ShareGrantView {
        ShareGrantView {
            id: "g".to_string(),
            session_id: "s".to_string(),
            path: path.to_string(),
            write: false,
            group: None,
        }
    }

    fn grouped(path: &str, group: &str) -> ShareGrantView {
        ShareGrantView {
            group: Some(group.to_string()),
            ..grant(path)
        }
    }

    #[test]
    fn a_folder_is_lendable_only_after_the_picker_or_as_an_existing_loan() {
        let approved = vec!["/home/user/proj".to_string()];
        let lent = vec![grant("/home/user/notes")];

        // The picker returned it: the user consented to lending this one.
        assert!(may_lend(&approved, &lent, "/home/user/proj"));
        // Already lent: this call only changes the terms.
        assert!(may_lend(&approved, &lent, "/home/user/notes"));
        // A path the page named on its own is refused before the lending
        // child hears of it.
        assert!(!may_lend(&approved, &lent, "/home/user"));
        assert!(!may_lend(&[], &[], "/home/user/.ssh"));
    }

    #[test]
    fn a_computer_loan_is_withdrawn_as_one_group() {
        let mut lent = vec![
            grouped("/", "pc-1"),
            grouped("/home/user/proj", "pc-1"),
            grant("/home/user/notes"),
        ];

        // One withdrawal takes every place of the loan, and nothing else.
        assert!(without_group(&mut lent, "pc-1"));
        assert_eq!(lent.len(), 1);
        assert_eq!(lent[0].path, "/home/user/notes");

        // A group nobody lent is not an error: the page may disconnect a
        // list that already ended by itself.
        assert!(!without_group(&mut lent, "pc-1"));
    }

    #[test]
    #[cfg(not(windows))]
    fn the_root_is_what_a_unix_computer_loan_covers() {
        let roots = detect_computer_roots();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].path, "/");
        assert_eq!(roots[0].kind, "root");
    }
}
