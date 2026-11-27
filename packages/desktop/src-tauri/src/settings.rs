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
    /// How long a lent folder survives without an access, in minutes. `None`
    /// is the settings page's なし: the loan then lasts until the user
    /// disconnects it or the app quits.
    ///
    /// The default is the 30 minutes the shell lived with before the choice
    /// existed. A file written by that version has no key, so the serde
    /// default must be the old behaviour rather than `None`.
    #[serde(default = "default_share_idle_minutes")]
    pub(crate) share_idle_minutes: Option<u32>,
}

fn default_share_idle_minutes() -> Option<u32> {
    Some(30)
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            auto_update: true,
            connections: Vec::new(),
            current: None,
            approved_share_folders: Vec::new(),
            share_idle_minutes: default_share_idle_minutes(),
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
    write_private(path, &json).map_err(|e| format!("設定を保存できません: {e}"))
}

/// Write the file readable by its owner only. It holds the saved servers'
/// tokens; the default mode would let another local account read them.
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write as _;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(text.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
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
            share_idle_minutes: None,
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

    #[cfg(unix)]
    #[test]
    fn saved_settings_are_readable_by_the_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;
        let file = TempFile::new("private");
        save_to(&file.0, &DesktopSettings::default()).unwrap();
        let mode = std::fs::metadata(&file.0).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    /// A file written before the choice existed has no idle key: it must
    /// keep the 30 minutes those versions used, not read as "never".
    #[test]
    fn a_file_without_the_idle_key_keeps_the_thirty_minute_clock() {
        let file = TempFile::new("idle-default");
        std::fs::write(&file.0, r#"{"autoUpdate":true}"#).unwrap();
        assert_eq!(load_from(&file.0).share_idle_minutes, Some(30));
    }

    /// なし is stored as `null`; it must survive a read of the file.
    #[test]
    fn an_explicit_null_turns_the_idle_clock_off() {
        let file = TempFile::new("idle-never");
        std::fs::write(
            &file.0,
            r#"{"autoUpdate":true,"shareIdleMinutes":null}"#,
        )
        .unwrap();
        assert_eq!(load_from(&file.0).share_idle_minutes, None);
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
