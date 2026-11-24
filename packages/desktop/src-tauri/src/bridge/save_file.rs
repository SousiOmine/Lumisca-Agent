//! Save one of the displayed server's files to a path the user picks.
//!
//! The page's file cards fetch a file and hand the blob to an `<a download>`,
//! which a browser saves through its own download settings. The desktop
//! window has no download settings of its own: WebKit's default either saves
//! without asking or does nothing, depending on the platform. This action
//! asks the OS for a destination and writes the bytes there, streaming the
//! body so a large file never has to fit in the page's heap.
//!
//! The URL must belong to the server whose page is displayed. The page
//! already holds that server's token, but the shell also runs with no key
//! gate on a tokenless server, and a download URL is the one parameter that
//! would otherwise let any displayed page use the window as a general
//! downloader.

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::http::StatusCode;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use url::Url;

use super::display;
use super::wire::{bridge_error, bridge_json, BridgeReply, Params};

/// Client for one download. No overall timeout: a large file over a slow
/// link is still a download the reader asked for. The connect timeout only
/// keeps an unreachable host from holding the blocking worker for minutes.
fn client() -> Result<reqwest::blocking::Client, String> {
    crate::health::install_crypto_provider();
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("HTTP client: {error}"))
}

fn outcome(status: &str) -> BridgeReply {
    bridge_json(StatusCode::OK, serde_json::json!({ "status": status }))
}

fn saved(path: &Path) -> BridgeReply {
    bridge_json(
        StatusCode::OK,
        serde_json::json!({
            "status": "saved",
            "path": path.to_string_lossy(),
        }),
    )
}

fn failed(detail: String) -> BridgeReply {
    bridge_json(
        StatusCode::OK,
        serde_json::json!({ "status": "failed", "detail": detail }),
    )
}

/// Save one file. Parameters: `url` (the server route, token included) and
/// `name` (the name the dialog suggests).
pub(super) fn save(app: &AppHandle, params: &Params) -> BridgeReply {
    let Some(url) = params.get("url") else {
        return bridge_error(StatusCode::BAD_REQUEST, "url is required");
    };
    let Some(name) = params.get("name") else {
        return bridge_error(StatusCode::BAD_REQUEST, "name is required");
    };
    let Some(base) = display::current_base(app) else {
        return bridge_error(StatusCode::CONFLICT, "no server displayed");
    };

    let target = match Url::parse(&url) {
        Ok(target) => target,
        Err(_) => return bridge_error(StatusCode::BAD_REQUEST, "invalid url"),
    };
    let base = match Url::parse(&base) {
        Ok(base) => base,
        Err(_) => return bridge_error(StatusCode::CONFLICT, "invalid display url"),
    };
    if !matches!(target.scheme(), "http" | "https") || target.origin() != base.origin() {
        return bridge_error(
            StatusCode::BAD_REQUEST,
            "url is not on the displayed server",
        );
    }

    // Ask the server first: a file the machine no longer has becomes a gone
    // card, not an empty destination the reader picked for nothing.
    let mut response = match client().and_then(|client| {
        client
            .get(target)
            // An attachment route does not redirect; following one would
            // step outside the origin checked above.
            .send()
            .map_err(|error| format!("GET: {error}"))
    }) {
        Ok(response) => response,
        Err(detail) => return failed(detail),
    };
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return outcome("gone");
    }
    if !response.status().is_success() {
        return failed(format!("server answered {}", response.status()));
    }

    let suggested = safe_file_name(&name);
    let picked = match app.get_webview_window("main") {
        Some(window) => window
            .dialog()
            .file()
            .set_title("保存先の選択")
            .set_file_name(&suggested)
            .blocking_save_file(),
        None => app
            .dialog()
            .file()
            .set_title("保存先の選択")
            .set_file_name(&suggested)
            .blocking_save_file(),
    };
    let Some(destination) = picked.and_then(|path| path.into_path().ok()) else {
        return outcome("cancelled");
    };

    match write_to(&mut response, &destination) {
        Ok(()) => saved(&destination),
        Err(error) => failed(error.to_string()),
    }
}

/// Write the response body to `destination` through a sibling `.part` file.
/// A failed transfer leaves no half file at the name the reader picked.
fn write_to(response: &mut reqwest::blocking::Response, destination: &Path) -> io::Result<()> {
    let part = part_path(destination);
    let result = (|| {
        let mut file = std::fs::File::create(&part)?;
        io::copy(response, &mut file)?;
        file.flush()?;
        drop(file);
        replace(&part, destination)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    result
}

/// The temporary sibling of `destination`: same directory, so the final
/// rename never crosses a file system.
fn part_path(destination: &Path) -> PathBuf {
    let mut name = destination.as_os_str().to_os_string();
    name.push(".part");
    PathBuf::from(name)
}

/// Move the finished file into place. The dialog already asked about an
/// existing file; Windows refuses a rename over one, so remove it first.
fn replace(part: &Path, destination: &Path) -> io::Result<()> {
    match std::fs::remove_file(destination) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    std::fs::rename(part, destination)
}

/// A file name the save dialog can show. The page sends the name the reader
/// knows; a name from an agent's reply is data, not a path, so separators and
/// characters the three platforms reject become underscores and the last
/// path component is all that survives.
fn safe_file_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let mut cleaned = String::with_capacity(last.len());
    for character in last.chars() {
        let rejected =
            character.is_control() || matches!(character, ':' | '*' | '?' | '"' | '<' | '>' | '|');
        cleaned.push(if rejected { '_' } else { character });
    }
    // Windows drops trailing dots and spaces; trimming them here keeps the
    // dialog's name and the saved name the same on every platform. A leading
    // dot is a hidden file, not a mistake, and stays.
    let trimmed = cleaned.trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        "download".to_string()
    } else {
        trimmed.chars().take(255).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_name_keeps_only_its_last_component() {
        assert_eq!(safe_file_name("reports/2026/summary.pdf"), "summary.pdf");
        assert_eq!(safe_file_name(r"C:\Users\me\notes.txt"), "notes.txt");
        assert_eq!(safe_file_name("plain.txt"), "plain.txt");
    }

    #[test]
    fn a_file_name_replaces_what_a_platform_rejects() {
        assert_eq!(
            safe_file_name("a:b*c?d\"e<f>g|h.txt"),
            "a_b_c_d_e_f_g_h.txt"
        );
        assert_eq!(safe_file_name("line\nbreak.txt"), "line_break.txt");
        // A name that is only dots or spaces has nothing to save under.
        assert_eq!(safe_file_name("..."), "download");
        assert_eq!(safe_file_name("   "), "download");
    }

    #[test]
    fn the_url_must_share_the_displayed_servers_origin() {
        let base = Url::parse("https://host.example").unwrap();
        let same = Url::parse("https://host.example/api/file?token=t").unwrap();
        let other_host = Url::parse("https://elsewhere.example/api/file").unwrap();
        let other_port = Url::parse("https://host.example:8443/api/file").unwrap();
        let other_scheme = Url::parse("http://host.example/api/file").unwrap();
        assert_eq!(same.origin(), base.origin());
        assert_ne!(other_host.origin(), base.origin());
        assert_ne!(other_port.origin(), base.origin());
        assert_ne!(other_scheme.origin(), base.origin());
    }
}
