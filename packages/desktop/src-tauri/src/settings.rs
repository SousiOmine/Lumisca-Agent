//! Desktop-level settings, persisted next to the server database.
//!
//! The settings UI may be served by a remote server, so the shell's own
//! preferences cannot live in that server's settings file: they are kept in
//! `<app data>/settings.json`, read and written by this shell alone.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;

use crate::LockRecover;

/// A remote server this shell displays, by URL + token. Persisted so the
/// next launch returns to it instead of the local server.
#[derive(serde::Serialize, serde::Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedConnection {
    /// The server's origin (`scheme://host[:port]`): the page is always
    /// served at the root, so a path or query from the pasted URL is not
    /// part of the connection.
    pub(crate) url: String,
    pub(crate) token: String,
}

/// Shell preferences.
#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopSettings {
    pub(crate) auto_update: bool,
    /// The server the window showed when the app last quit; `None` means
    /// the local server. Absent from a file written before this choice was
    /// remembered — a missing field must not discard the auto-update
    /// choice stored beside it.
    #[serde(default)]
    pub(crate) last_remote: Option<SavedConnection>,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            auto_update: true,
            last_remote: None,
        }
    }
}

/// Serializes the read-modify-write updates: the auto-update toggle and the
/// remembered connection are changed from different threads, and a plain
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

/// Set the server to restore on the next launch (`None`: the local one).
pub(crate) fn set_remembered(
    app: &AppHandle,
    conn: Option<&SavedConnection>,
) -> Result<(), String> {
    update(app, |settings| {
        settings.last_remote = conn.cloned();
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

    const REMOTE: &str = r#"{"url":"https://host.tailnet.ts.net","token":"abc"}"#;

    #[test]
    fn saved_connection_round_trips() {
        let file = TempFile::new("round-trip");
        let settings = DesktopSettings {
            auto_update: false,
            last_remote: Some(SavedConnection {
                url: "https://host.tailnet.ts.net".into(),
                token: "abc".into(),
            }),
        };
        save_to(&file.0, &settings).unwrap();
        assert_eq!(load_from(&file.0), settings);
    }

    #[test]
    fn a_file_without_a_remembered_connection_keeps_the_auto_update_choice() {
        let file = TempFile::new("legacy");
        // Written by a shell that did not remember the connection yet.
        std::fs::write(&file.0, r#"{"autoUpdate":false}"#).unwrap();
        assert_eq!(
            load_from(&file.0),
            DesktopSettings {
                auto_update: false,
                last_remote: None,
            }
        );
    }

    #[test]
    fn a_missing_file_is_the_defaults() {
        let file = TempFile::new("missing");
        assert_eq!(load_from(&file.0), DesktopSettings::default());
        assert!(DesktopSettings::default().auto_update);
        assert!(DesktopSettings::default().last_remote.is_none());
    }

    /// The default `derive` spelling is what the shell itself writes, so
    /// this pins the field names a stale file may be found with.
    #[test]
    fn the_file_names_fields_in_camel_case() {
        let file = TempFile::new("spelling");
        std::fs::write(
            &file.0,
            format!(r#"{{"autoUpdate":true,"lastRemote":{REMOTE}}}"#),
        )
        .unwrap();
        assert_eq!(
            load_from(&file.0).last_remote,
            Some(SavedConnection {
                url: "https://host.tailnet.ts.net".into(),
                token: "abc".into(),
            })
        );
    }
}
