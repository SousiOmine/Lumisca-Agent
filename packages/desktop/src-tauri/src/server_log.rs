//! Capture and retention of the local server's output.
//!
//! The desktop shell owns the server child process, so it is the only place
//! that can explain why the server died mid-session ("勝手に落ちる"
//! reports). Two stores answer two questions: an in-memory ring buffer for
//! the UI's copy-paste tail (short, always current) and an append-only file
//! for post-mortem (long, survives the app run).
//!
//! Every line is stamped with the local wall clock at capture time (see
//! `local_time_stamp`) and records the stream it arrived on. The shell's
//! own actions — starting, restarting, stopping the server, a missed health
//! check — are captured too, as `[shell]` lines (`note`), so a post-mortem
//! can tell "the server was stopped deliberately" apart from "the server
//! died on its own": the two look identical in the server's own output,
//! which is what a previous investigation of a mid-session death got stuck
//! on.
//!
//! Split from `server.rs` so process management and log retention evolve
//! independently; both read the same `AppState.server_log` slot.

use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::{AppState, LockRecover};

/// Lines kept in the in-memory tail surfaced to the UI.
const SERVER_LOG_TAIL_LINES: usize = 500;
/// Lines kept in the on-disk log across app runs.
const SERVER_LOG_FILE_LINES: usize = 2000;
/// Bytes of one captured server log line: a runaway tool log line must not
/// balloon the ring buffer.
const SERVER_LOG_LINE_MAX: usize = 4096;

/// Ring buffer of the local server's recent output (stdout+stderr merged),
/// plus the append-only log file path. Created once per app run in setup
/// (before the server starts), shared by the log-pump thread and the shell
/// bridge. Lines are stored already rendered (see `format_line`): the
/// timestamp is taken when the line is captured, not when it is read, so
/// the tail the UI shows can never drift from the file.
pub(crate) struct ServerLog {
    lines: Mutex<VecDeque<String>>,
    file: Mutex<Option<std::fs::File>>,
}

impl ServerLog {
    pub(crate) fn new(app: &AppHandle) -> Self {
        let file = server_log_path(app).and_then(|path| {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).ok()?;
            }
            OpenOptions::new().create(true).append(true).open(path).ok()
        });
        Self {
            lines: Mutex::new(VecDeque::new()),
            file: Mutex::new(file),
        }
    }

    pub(crate) fn push(&self, stream: &'static str, text: String) {
        let line = format_line(&local_time_stamp(), stream, &text);
        {
            let mut lines = self.lines.lock_recover();
            lines.push_back(line.clone());
            while lines.len() > SERVER_LOG_TAIL_LINES {
                lines.pop_front();
            }
        }
        if let Some(file) = self.file.lock_recover().as_mut() {
            let _ = writeln!(file, "{line}");
            let _ = file.flush();
        }
    }

    /// The recent output as plain text (oldest first), for the UI's
    /// copy-paste. Identical to the on-disk log: each line carries its
    /// timestamp and stream, so stderr lines (where Deno prints uncaught
    /// errors) and the shell's own notes stand out.
    pub(crate) fn tail_text(&self) -> String {
        let lines = self.lines.lock_recover();
        let mut out = String::new();
        for line in lines.iter() {
            out.push_str(line);
            out.push('\n');
        }
        out
    }

    pub(crate) fn clear(&self) {
        self.lines.lock_recover().clear();
    }
}

/// Drop one oversized line down to the cap. Called by the pump before
/// handing the text over, so the ring buffer and the file stay bounded.
///
/// Backs off to a UTF-8 boundary: `String::truncate` panics when the index
/// lands inside a multi-byte character, which a long non-ASCII server line
/// (a Japanese build log, say) would hit.
pub(crate) fn truncate_line(text: String) -> String {
    if text.len() <= SERVER_LOG_LINE_MAX {
        return text;
    }
    let mut end = SERVER_LOG_LINE_MAX;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}… (truncated)", &text[..end])
}

/// Render one captured line: timestamp first (what a post-mortem needs
/// before anything else), then the stream it arrived on. The tail the UI
/// copies and the on-disk log use the same rendering, so a pasted tail can
/// be matched against the file line by line.
pub(crate) fn format_line(time: &str, stream: &str, text: &str) -> String {
    format!("[{time}] [{stream}] {text}")
}

/// The local wall clock as `MM-DD HH:MM:SS.mmm`.
///
/// `std` has no local-time API, and this log is read by humans after the
/// fact — a UTC stamp would be actively misleading (09:00 UTC is 18:00 in
/// JST, which shifts every correlation with the event log). The platform
/// clock is therefore read directly: `GetLocalTime` on Windows,
/// `localtime_r` on POSIX. Both crates are already dependencies of the
/// shell (`windows` on Windows, `libc` elsewhere), so no new dependency is
/// pulled in for a diagnostic prefix.
pub(crate) fn local_time_stamp() -> String {
    #[cfg(windows)]
    {
        // SAFETY: GetLocalTime takes no arguments and cannot fail.
        let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
        format!(
            "{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
            t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, t.wMilliseconds
        )
    }
    #[cfg(unix)]
    {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        let seconds = now.as_secs() as libc::time_t;
        let mut broken_down: libc::tm = unsafe { std::mem::zeroed() };
        // SAFETY: localtime_r writes into `broken_down` and keeps no
        // reference to it.
        unsafe { libc::localtime_r(&seconds, &mut broken_down) };
        format!(
            "{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
            broken_down.tm_mon + 1,
            broken_down.tm_mday,
            broken_down.tm_hour,
            broken_down.tm_min,
            broken_down.tm_sec,
            now.subsec_millis()
        )
    }
}

fn server_log_path(app: &AppHandle) -> Option<PathBuf> {
    Some(crate::server::app_data_dir(app).join("server.log"))
}

/// Truncate the on-disk log to its last lines so it cannot grow without
/// bound across app runs. Best-effort: a failure only leaves a longer file.
pub(crate) fn trim_log_file(app: &AppHandle) {
    let Some(path) = server_log_path(app) else {
        return;
    };
    let Ok(content) = std::fs::read_to_string(&path) else {
        return;
    };
    let lines: Vec<&str> = content.lines().collect();
    if lines.len() <= SERVER_LOG_FILE_LINES {
        return;
    }
    let kept = lines[lines.len() - SERVER_LOG_FILE_LINES..].join("\n");
    let _ = std::fs::write(&path, kept + "\n");
}

/// Push one captured server output line into the shared log.
pub(crate) fn push(app: &AppHandle, stream: &'static str, text: String) {
    if let Some(state) = app.try_state::<AppState>() {
        state.server_log.lock_recover().push(stream, text);
    }
}

/// Record a shell-side action in the captured log, under the `shell` stream.
///
/// The server's own output cannot explain why it stopped producing any: a
/// hard kill (the shell's tree kill on app exit, a restart) and a crash
/// both end the same way, with the last line and nothing after it. These
/// notes are what makes the difference readable after the fact.
pub(crate) fn note(app: &AppHandle, text: impl Into<String>) {
    push(app, "shell", text.into());
}

/// Clear the shared server log tail (a fresh start must not show the
/// previous instance's output).
pub(crate) fn clear(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.server_log.lock_recover().clear();
    }
}

/// Read the shared server log tail as text (for the bridge).
pub(crate) fn tail(app: &AppHandle) -> String {
    app.try_state::<AppState>()
        .map(|s| s.server_log.lock_recover().tail_text())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_line_keeps_a_short_line_intact() {
        let text = "short".to_string();
        assert_eq!(truncate_line(text.clone()), text);
    }

    #[test]
    fn truncate_line_caps_a_runaway_line() {
        let text = "a".repeat(SERVER_LOG_LINE_MAX + 100);
        let cut = truncate_line(text);
        assert!(cut.len() < SERVER_LOG_LINE_MAX + 32);
        assert!(cut.ends_with("… (truncated)"));
    }

    #[test]
    fn truncate_line_never_splits_a_utf8_character() {
        // Every character is 3 bytes wide, so the cap lands mid-character.
        let text = "あ".repeat(SERVER_LOG_LINE_MAX);
        let cut = truncate_line(text);
        // A split would have panicked in String::truncate.
        assert!(cut.starts_with('あ'));
        assert!(cut.ends_with("… (truncated)"));
    }

    #[test]
    fn format_line_leads_with_the_timestamp_and_stream() {
        assert_eq!(
            format_line("09-12 08:18:16.123", "shell", "starting the server"),
            "[09-12 08:18:16.123] [shell] starting the server"
        );
    }

    #[test]
    fn local_time_stamp_has_a_stable_shape() {
        // A shape check, not a value check: the fields must line up at the
        // documented offsets (MM-DD HH:MM:SS.mmm), so a paste into a grep or
        // a timestamp parser keeps working whatever the clock says.
        let stamp = local_time_stamp();
        assert_eq!(stamp.len(), 18, "{stamp}");
        let byte = |i: usize| stamp.as_bytes()[i];
        let digit_at = |i: usize| byte(i).is_ascii_digit();
        assert!(digit_at(0) && digit_at(1), "{stamp}");
        assert_eq!(byte(2), b'-', "{stamp}");
        assert!(digit_at(3) && digit_at(4), "{stamp}");
        assert_eq!(byte(5), b' ', "{stamp}");
        assert!(digit_at(6) && digit_at(7), "{stamp}");
        assert_eq!(byte(8), b':', "{stamp}");
        assert!(digit_at(9) && digit_at(10), "{stamp}");
        assert_eq!(byte(11), b':', "{stamp}");
        assert!(digit_at(12) && digit_at(13), "{stamp}");
        assert_eq!(byte(14), b'.', "{stamp}");
        assert!(digit_at(15) && digit_at(16) && digit_at(17), "{stamp}");
    }
}
