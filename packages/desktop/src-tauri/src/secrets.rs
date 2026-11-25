//! The master key for secrets at rest, kept in the OS keychain.
//!
//! The server encrypts credential-bearing settings entries before writing
//! them (packages/core/settings/secrets.ts). The key that opens them must
//! not sit beside the ciphertext, or a copy of the config directory carries
//! both. The shell therefore keeps the key in the platform store — Keychain
//! on macOS, Credential Manager on Windows, Secret Service on Linux — and
//! passes it to the server it starts through LUMISCA_SECRET_KEY.
//!
//! A headless server has no shell to ask: it creates or reads its own key
//! file. That path stays the fallback here too. When the keychain cannot be
//! reached, this module returns None and the server does what it would do
//! without a shell.
//!
//! One installation has one key. The first launch after this feature finds
//! no keychain entry and no key file, creates a key, and the server encrypts
//! the existing plaintext entries with it. An installation that already ran
//! a server with a key file has that file imported into the keychain, so the
//! ciphertext it wrote stays readable.

use base64::Engine as _;
use std::path::PathBuf;

/// Keychain entry identity. The service name is the app's bundle-style id,
/// so the entry is recognizable in Keychain Access and Credential Manager.
const KEYCHAIN_SERVICE: &str = "com.lumisca.agent";
const KEYCHAIN_USER: &str = "settings-master-key";

/// AES-256, the length packages/core/settings/secrets.ts requires.
const KEY_BYTES: usize = 32;

const KEY_ENV: &str = "LUMISCA_SECRET_KEY";
const KEY_FILE_ENV: &str = "LUMISCA_SECRET_KEY_FILE";
const KEY_FILE_NAME: &str = "secret.key";
const SETTINGS_DIR_NAME: &str = "lumisca-agent";

/// The base64 key to hand the server, or None to let it resolve one itself.
///
/// None is returned when the environment already names a key (the child
/// inherits the shell's environment, so the user's choice must win), when
/// the keychain is unavailable, or when reading or writing it fails. None is
/// not an error: the server's key file is a working fallback.
pub(crate) fn master_key() -> Option<String> {
    if std::env::var(KEY_ENV)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        return None;
    }
    let entry = match keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER) {
        Ok(entry) => entry,
        Err(error) => {
            eprintln!("[lumisca] keychain unavailable: {error}");
            return None;
        }
    };
    match entry.get_password() {
        Ok(value) => {
            if is_key(&value) {
                // One installation should have one key. A key file with a
                // different value means the install was also run headless
                // with its own key; the ciphertext each wrote stays readable
                // only with the key that wrote it. Say so rather than let
                // the other half look like "no providers configured".
                if let Some(path) = existing_key_file() {
                    if let Ok(text) = std::fs::read_to_string(&path) {
                        let file_key = text.trim();
                        if is_key(file_key) && file_key != value {
                            eprintln!(
                                "[lumisca] a different key file exists at {}; using the keychain key",
                                path.display()
                            );
                        }
                    }
                }
                return Some(value);
            }
            // A value of the wrong shape cannot open anything. Leaving it in
            // place and letting the server use its key file keeps the shell
            // startable; the entry has to be removed by hand to recover.
            eprintln!("[lumisca] keychain entry is not a 32-byte base64 key");
            return None;
        }
        Err(keyring::Error::NoEntry) => {}
        Err(error) => {
            eprintln!("[lumisca] keychain read failed: {error}");
            return None;
        }
    }

    // First run with the keychain, or an install that used a headless server
    // before: adopt the key file so its ciphertext stays readable.
    if let Some(path) = existing_key_file() {
        if let Ok(text) = std::fs::read_to_string(&path) {
            let value = text.trim().to_string();
            if is_key(&value) {
                if let Err(error) = entry.set_password(&value) {
                    eprintln!("[lumisca] keychain write failed: {error}");
                }
                return Some(value);
            }
            eprintln!(
                "[lumisca] key file {} is not a 32-byte base64 key",
                path.display()
            );
            return None;
        }
    }

    let mut bytes = [0u8; KEY_BYTES];
    if getrandom::fill(&mut bytes).is_err() {
        eprintln!("[lumisca] no OS random source for the settings key");
        return None;
    }
    let value = base64::engine::general_purpose::STANDARD.encode(bytes);
    if let Err(error) = entry.set_password(&value) {
        eprintln!("[lumisca] keychain write failed: {error}");
        return None;
    }
    Some(value)
}

/// Whether `text` is base64 for exactly 32 bytes.
fn is_key(text: &str) -> bool {
    base64::engine::general_purpose::STANDARD
        .decode(text.trim())
        .is_ok_and(|bytes| bytes.len() == KEY_BYTES)
}

/// An explicit key file, else the one the server creates beside its settings
/// file (packages/core/settings/path.ts).
fn existing_key_file() -> Option<PathBuf> {
    if let Ok(path) = std::env::var(KEY_FILE_ENV) {
        if !path.trim().is_empty() {
            return Some(PathBuf::from(path));
        }
    }
    let dir = settings_dir()?;
    let path = dir.join(KEY_FILE_NAME);
    path.exists().then_some(path)
}

/// `$XDG_CONFIG_HOME/lumisca-agent`, else `<home>/.config/lumisca-agent`.
/// Windows uses USERPROFILE, POSIX HOME — the same rule the server applies.
fn settings_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("XDG_CONFIG_HOME") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir).join(SETTINGS_DIR_NAME));
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    if home.is_empty() {
        return None;
    }
    Some(PathBuf::from(home).join(".config").join(SETTINGS_DIR_NAME))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_32_byte_base64_value_is_a_key() {
        let key = base64::engine::general_purpose::STANDARD.encode([7u8; KEY_BYTES]);
        assert!(is_key(&key));
        assert!(is_key(&format!("{key}\n")));
    }

    #[test]
    fn other_shapes_are_not_keys() {
        assert!(!is_key(""));
        assert!(!is_key("sk-test"));
        let short = base64::engine::general_purpose::STANDARD.encode([1u8; 16]);
        assert!(!is_key(&short));
    }
}
