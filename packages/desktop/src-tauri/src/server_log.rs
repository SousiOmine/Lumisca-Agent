//! Capture and retention of the local server's output.
//!
//! The desktop shell owns the server child process, so it is the only place
//! that can explain why the server died mid-session ("勝手に落ちる"
//! reports). Two stores answer two questions: an in-memory ring buffer for
//! the UI's copy-paste tail (short, always current) and an append-only file
//! for post-mortem (long, survives the app run).
//!
//! Split from `server.rs` so process management and log retention evolve
//! independently; both read the same `AppState.server_log` slot.

use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::AppState;

/// Lines kept in the in-memory tail surfaced to the UI.
const SERVER_LOG_TAIL_LINES: usize = 500;
/// Lines kept in the on-disk log across app runs.
const SERVER_LOG_FILE_LINES: usize = 2000;
/// Bytes of one captured server log line: a runaway tool log line must not
/// balloon the ring buffer.
const SERVER_LOG_LINE_MAX: usize = 4096;

/// One captured line of the local server's combined stdout/stderr.
#[derive(Clone)]
pub(crate) struct ServerLogLine {
    stream: &'static str,
    text: String,
}

/// Ring buffer of the local server's recent output (stdout+stderr merged),
/// plus the append-only log file path. Created once per app run in setup
/// (before the server starts), shared by the log-pump thread and the shell
/// bridge.
pub(crate) struct ServerLog {
    lines: Mutex<VecDeque<ServerLogLine>>,
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
        {
            let mut lines = self.lines.lock().unwrap_or_else(|e| e.into_inner());
            lines.push_back(ServerLogLine {
                stream,
                text: text.clone(),
            });
            while lines.len() > SERVER_LOG_TAIL_LINES {
                lines.pop_front();
            }
        }
        if let Some(file) = self.file.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            let _ = writeln!(file, "[{stream}] {text}");
            let _ = file.flush();
        }
    }

    /// The recent output as plain text (oldest first), for the UI's
    /// copy-paste. Each line is prefixed with its stream so stderr lines
    /// (where Deno prints uncaught errors) stand out.
    pub(crate) fn tail_text(&self) -> String {
        let lines = self.lines.lock().unwrap_or_else(|e| e.into_inner());
        let mut out = String::new();
        for line in lines.iter() {
            out.push_str(&format!("[{}] {}\n", line.stream, line.text));
        }
        out
    }

    pub(crate) fn clear(&self) {
        self.lines.lock().unwrap_or_else(|e| e.into_inner()).clear();
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
        state
            .server_log
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(stream, text);
    }
}

/// Clear the shared server log tail (a fresh start must not show the
/// previous instance's output).
pub(crate) fn clear(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state
            .server_log
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
}

/// Read the shared server log tail as text (for the bridge).
pub(crate) fn tail(app: &AppHandle) -> String {
    app.try_state::<AppState>()
        .map(|s| {
            s.server_log
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .tail_text()
        })
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
}
