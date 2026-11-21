//! Desktop-level settings, persisted next to the server database.
//!
//! The settings UI may be served by a remote server, so the shell's own
//! preferences cannot live in that server's settings file: they are kept in
//! `<app data>/settings.json`, read and written by this shell alone.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;

use crate::LockRecover;

/// A server this window can display, by URL + token. Persisted so the next
/// launch can return to it instead of always starting the local server.
///
/// The list of these belongs to the window, not to whichever server the
/// window happens to show: a page served by a remote server has no business
/// knowing which other servers this computer may connect to.
#[derive(serde::Serialize, serde::Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedConnection {
    /// Stable identity of the row. The displayed connection is recorded by
    /// this id, so renaming a server or changing its address does not lose
    /// which row the window is on.
    pub(crate) id: String,
    /// The server's origin (`scheme://host[:port]`): the page is always
    /// served at the root, so a path or query from the pasted URL is not
    /// part of the connection.
    pub(crate) url: String,
    pub(crate) token: String,
    /// What to call this server in the title bar. Empty when the row has no
    /// name yet; the page falls back to the URL's host.
    #[serde(default)]
    pub(crate) name: String,
}

/// Shell preferences.
#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopSettings {
    pub(crate) auto_update: bool,
    /// The servers this window can display. Owned by the shell because the
    /// page that edits it may be served by any one of the remote servers in
    /// it; a list stored on one of them would change with the display.
    #[serde(default)]
    pub(crate) connections: Vec<SavedConnection>,
    /// The entry the window shows; `None` means the local server.
    #[serde(default)]
    pub(crate) current: Option<String>,
    /// Folders this shell's picker returned, as paths the user consented to
    /// lend. `share/grant` accepts only these (or a folder already lent):
    /// the page can name any path, and a remote page must not be able to
    /// hand `/home/<user>` to a conversation the user never chose.
    #[serde(default)]
    pub(crate) approved_share_folders: Vec<String>,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            auto_update: true,
            connections: Vec::new(),
            current: None,
            approved_share_folders: Vec::new(),
        }
    }
}

/// Serializes the read-modify-write updates: the auto-update toggle and the
/// connection list are changed from different threads, and a plain
/// load → save would drop whichever change landed in between.
static UPDATE_LOCK: Mutex<()> = Mutex::new(());

/// `<app data>/settings.json` — beside `lumisca.db` (server::app_data_dir).
fn path(app: &AppHandle) -> PathBuf {
    crate::server::app_data_dir(app).join("settings.json")
}

pub(crate) fn load(app: &AppHandle) -> DesktopSettings {
    load_from(&path(app))
}

/// Change one preference and persist it, without clobbering a concurrent
/// change to another field.
pub(crate) fn update(
    app: &AppHandle,
    mutate: impl FnOnce(&mut DesktopSettings),
) -> Result<(), String> {
    let _guard = UPDATE_LOCK.lock_recover();
    let mut settings = load(app);
    mutate(&mut settings);
    save_to(&path(app), &settings)
}

/// Add `conn` to the list, or replace the entry with the same id.
pub(crate) fn save_connection(app: &AppHandle, conn: &SavedConnection) -> Result<(), String> {
    update(app, |settings| {
        match settings
            .connections
            .iter_mut()
            .find(|existing| existing.id == conn.id)
        {
            Some(existing) => *existing = conn.clone(),
            None => settings.connections.push(conn.clone()),
        }
    })
}

/// Remove one entry. Deleting the entry the window currently shows is
/// refused by the caller before this runs.
pub(crate) fn delete_connection(app: &AppHandle, id: &str) -> Result<(), String> {
    update(app, |settings| {
        settings.connections.retain(|conn| conn.id != id);
        if settings.current.as_deref() == Some(id) {
            settings.current = None;
        }
    })
}

/// Record which entry the window shows (`None`: the local server).
pub(crate) fn set_current(app: &AppHandle, id: Option<&str>) -> Result<(), String> {
    update(app, |settings| {
        settings.current = id.map(str::to_string);
    })
}

/// A missing or unreadable file is the first run (or a file the user
/// deleted), not an error: defaults apply.
fn load_from(path: &Path) -> DesktopSettings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_to(path: &Path, settings: &DesktopSettings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("設定を保存できません: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique scratch file for one test, removed on drop.
    struct TempFile(PathBuf);

    impl TempFile {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "lumisca-settings-{}-{name}.json",
                std::process::id()
            ));
            let _ = std::fs::remove_file(&path);
            Self(path)
        }
    }

    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    const REMOTE: &str = r#"{"id":"home","url":"https://host.tailnet.ts.net","token":"abc"}"#;

    #[test]
    fn saved_connection_round_trips() {
        let file = TempFile::new("round-trip");
        let settings = DesktopSettings {
            auto_update: false,
            connections: vec![SavedConnection {
                id: "home".into(),
                url: "https://host.tailnet.ts.net".into(),
                token: "abc".into(),
                name: "自宅".into(),
            }],
            current: Some("home".into()),
            approved_share_folders: vec!["/home/user/proj".into()],
        };
        save_to(&file.0, &settings).unwrap();
        assert_eq!(load_from(&file.0), settings);
    }

    #[test]
    fn a_missing_file_is_the_defaults() {
        let file = TempFile::new("missing");
        assert_eq!(load_from(&file.0), DesktopSettings::default());
        assert!(DesktopSettings::default().auto_update);
        assert!(DesktopSettings::default().connections.is_empty());
        assert!(DesktopSettings::default().current.is_none());
    }

    /// The default `derive` spelling is what the shell itself writes, so
    /// this pins the field names a stale file may be found with.
    #[test]
    fn the_file_names_fields_in_camel_case() {
        let file = TempFile::new("spelling");
        std::fs::write(
            &file.0,
            format!(r#"{{"autoUpdate":true,"connections":[{REMOTE}],"current":"home"}}"#),
        )
        .unwrap();
        let settings = load_from(&file.0);
        assert_eq!(settings.current.as_deref(), Some("home"));
        assert_eq!(settings.connections.len(), 1);
        assert_eq!(settings.connections[0].id, "home");
    }
}
