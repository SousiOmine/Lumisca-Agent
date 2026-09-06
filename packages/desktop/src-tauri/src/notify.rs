//! OS notifications for agent events observed while the window is hidden.
//!
//! The agent loop lives in the local server process; its events reach the
//! shell only through the web UI (server → WebSocket → frontend). When the
//! frontend notices an `agent_end` / `question` event while the main window
//! has no focus (minimized, another app in front, another virtual
//! desktop), it asks the shell to show an OS notification through the
//! `notify` bridge action handled here.
//!
//! Platform paths:
//! - Windows: a WinRT toast under our own AppUserModelID (the bundle
//!   identifier), so the toast shows the Lumisca name and icon and its
//!   click returns to the app — even from another virtual desktop. A
//!   custom AUMID only displays while a Start Menu shortcut carrying it
//!   is registered, so dev runs (`target/debug|release`, which have no
//!   installer shortcut) register a shim shortcut on first use; installed
//!   builds already carry the installer's shortcut and skip that step.
//!   When the branded path is unavailable for any reason, the
//!   plugin-based toast (PowerShell-attributed, but guaranteed to show)
//!   is used as a fallback.
//! - macOS / Linux: the notification plugin default (correct attribution
//!   out of the box).
//!
//! The notification plugin is used from Rust only — never through
//! frontend IPC — so no capability entry is needed (same pattern as the
//! updater and dialog plugins).

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

/// Longest title / body forwarded to the OS. The bridge carries them as
/// URL query parameters, so they are short by construction; the caps keep
/// a misbehaving caller from polluting the notification center.
const MAX_TITLE_CHARS: usize = 80;
const MAX_BODY_CHARS: usize = 200;

/// Window visibility reported to the frontend (`window/state`). The
/// frontend notifies whenever the window is not focused — minimized, on
/// another virtual desktop, or simply behind another app — so every field
/// is needed to tell "the user can see us" apart from "we exist but are
/// hidden".
#[derive(serde::Serialize)]
pub(crate) struct WindowState {
    focused: bool,
    minimized: bool,
    visible: bool,
    maximized: bool,
}

/// Truncate to `max` characters on a char boundary (never splits UTF-8).
fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect()
}

/// Read the main window's visibility. A missing window (shutting down)
/// reports "not visible" so the caller notifies rather than dropping the
/// event silently.
pub(crate) fn window_state(app: &AppHandle) -> WindowState {
    match app.get_webview_window("main") {
        Some(window) => WindowState {
            focused: window.is_focused().unwrap_or(false),
            minimized: window.is_minimized().unwrap_or(false),
            visible: window.is_visible().unwrap_or(false),
            maximized: window.is_maximized().unwrap_or(false),
        },
        None => WindowState {
            focused: false,
            minimized: false,
            visible: false,
            maximized: false,
        },
    }
}

/// Show an OS notification for a background agent event. `urgent`
/// (the ask-tool question) keeps the toast on screen longer on Windows;
/// elsewhere it is accepted and ignored. Best-effort throughout: a
/// denied or failing notification path only logs — the agent event itself
/// was already applied to the UI state, so failing the bridge would gain
/// nothing.
pub(crate) fn show_notification(app: &AppHandle, title: &str, body: &str, urgent: bool) {
    let title = truncate(title, MAX_TITLE_CHARS);
    let body = truncate(body, MAX_BODY_CHARS);
    #[cfg(windows)]
    if !windows_toast::show(app, &title, &body, urgent) {
        // The branded path is unavailable (no shortcut, COM failure):
        // fall back to the plugin toast, which is attributed to
        // PowerShell but guaranteed to display.
        plugin_notification(app, &title, &body);
    }
    #[cfg(not(windows))]
    {
        let _ = urgent;
        plugin_notification(app, &title, &body);
    }
    // Flash the taskbar as well: a toast can be missed (or suppressed by
    // focus-assist), while the flashing icon persists until the user looks.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
}

/// The notification-plugin toast. Correct attribution on macOS/Linux;
/// PowerShell-attributed on Windows (dev fallback only).
fn plugin_notification(app: &AppHandle, title: &str, body: &str) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        eprintln!("[lumisca] notification failed: {e}");
    }
}

/// Bring the main window to the front: restore when minimized, show, then
/// focus. On Windows the foreground lock can refuse the focus change, so
/// the same force-activation used for bridge-started caption drags runs
/// first (see window::focus_window_for_drag).
pub(crate) fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        #[cfg(windows)]
        crate::window::focus_window_for_drag(&window);
        let _ = window.set_focus();
    }
}

/// Windows toasts under our own AppUserModelID.
///
/// `ToastNotificationManager::CreateToastNotifierWithId` only displays
/// while a Start Menu shortcut carrying the AUMID is registered — without
/// one the toast is silently dropped. Installed builds carry the
/// installer's shortcut; dev runs (`target/debug|release`) register the
/// shim below on first use instead.
#[cfg(windows)]
mod windows_toast {
    use std::path::{Component, Path, PathBuf};
    use std::sync::OnceLock;

    use tauri::AppHandle;
    use tauri_winrt_notification::{Duration, Toast};
    use windows::{
        core::{Interface, HSTRING, PWSTR},
        Win32::{
            Foundation::RPC_E_CHANGED_MODE,
            Storage::EnhancedStorage::PKEY_AppUserModel_ID,
            System::{
                Com::StructuredStorage::PROPVARIANT,
                Com::{
                    CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile,
                    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, COINIT_MULTITHREADED,
                },
                Variant::VT_LPWSTR,
            },
            UI::{
                Shell::PropertiesSystem::IPropertyStore,
                Shell::{IShellLinkW, ShellLink},
            },
        },
    };

    /// Cached result of the one-time shortcut setup: the COM work runs at
    /// most once per process, on the first background notification.
    static SHORTCUT_READY: OnceLock<bool> = OnceLock::new();

    /// Show a Lumisca-branded toast. Returns false when the branded path
    /// is unavailable (the caller falls back to the plugin toast).
    pub(super) fn show(app: &AppHandle, title: &str, body: &str, urgent: bool) -> bool {
        let app_id = app.config().identifier.clone();
        if !shortcut_ready(&app_id) {
            return false;
        }
        let handle = app.clone();
        let toast = Toast::new(&app_id)
            .title(title)
            .text2(body)
            .duration(if urgent {
                Duration::Long
            } else {
                Duration::Short
            })
            .on_activated(move |_| {
                // Click — even from another virtual desktop: the OS
                // activates the app, and this restores + focuses the main
                // window on top of that activation.
                super::focus_main(&handle);
                Ok(())
            });
        match toast.show() {
            Ok(()) => true,
            Err(e) => {
                eprintln!("[lumisca] windows toast failed: {e:?}");
                false
            }
        }
    }

    /// Whether toasts under `app_id` will display: true once a carrying
    /// shortcut is registered (or known to exist).
    fn shortcut_ready(app_id: &str) -> bool {
        *SHORTCUT_READY.get_or_init(|| ensure_shortcut(app_id))
    }

    /// Make sure a Start Menu shortcut carrying our AUMID exists.
    /// Installed builds rely on the installer's shortcut and skip the
    /// work; dev runs create the shim next to it.
    fn ensure_shortcut(app_id: &str) -> bool {
        let exe = match std::env::current_exe() {
            Ok(exe) => exe,
            Err(_) => return false,
        };
        // Production: the installer registers its shortcut; creating ours
        // next to it would duplicate the Start Menu entry.
        if !under_target_dir(&exe) {
            return true;
        }
        let link = match shortcut_path() {
            Some(link) => link,
            None => return false,
        };
        if link.exists() {
            return true;
        }
        if let Some(parent) = link.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                return false;
            }
        }
        let guard = match com_guard() {
            Some(guard) => guard,
            None => return false,
        };
        // The shortcut borrows nothing: every string is copied into COM /
        // the .lnk file before this returns.
        let ok = unsafe { create_shortcut_inner(&exe, &link, app_id).is_ok() };
        if guard {
            unsafe { CoUninitialize() };
        }
        if !ok {
            eprintln!("[lumisca] notification shortcut setup failed");
        }
        ok
    }

    /// The dev shim: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\
    /// Lumisca Agent\Lumisca Agent.lnk`. Deliberately distinct from the
    /// installer's `Lumisca\Lumisca.lnk` — the shim only ever exists on
    /// dev machines, pointing at the cargo-built exe.
    fn shortcut_path() -> Option<PathBuf> {
        std::env::var_os("APPDATA").map(|roaming| {
            Path::new(&roaming)
                .join("Microsoft\\Windows\\Start Menu\\Programs\\Lumisca Agent\\Lumisca Agent.lnk")
        })
    }

    /// Whether `exe` is a cargo dev build (`.../target/debug|release/`),
    /// mirroring the plugin's own heuristic for when to skip the app id.
    fn under_target_dir(exe: &Path) -> bool {
        let mut parts = exe.components().rev();
        let file_ok = matches!(parts.next(), Some(Component::Normal(_)));
        let profile_ok =
            matches!(parts.next(), Some(Component::Normal(p)) if p == "debug" || p == "release");
        let target_ok = matches!(parts.next(), Some(Component::Normal(p)) if p == "target");
        file_ok && profile_ok && target_ok
    }

    /// Make COM usable on this thread (the bridge runs off the main
    /// thread, whose apartment is unknown). Returns whether the matching
    /// `CoUninitialize` is ours to call: `Some(true)` after `S_OK`,
    /// `Some(false)` after `S_FALSE` (already initialized, not ours),
    /// `None` when COM is unusable here. `CoInitializeEx` returns the
    /// status directly (not a `Result`): success is `S_OK`/`S_FALSE`,
    /// anything else is an `HRESULT` error.
    fn com_guard() -> Option<bool> {
        let status = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        if status.is_ok() {
            return Some(status.0 == 0);
        }
        if status.0 == RPC_E_CHANGED_MODE.0 {
            // The thread already runs MTA (e.g. a WebView thread): join
            // it instead of failing — the shell-link object marshals fine.
            let mta = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            if mta.is_ok() {
                return Some(mta.0 == 0);
            }
        }
        None
    }

    /// Create the .lnk with our AUMID stamped through its property store.
    /// Caller holds COM initialized.
    unsafe fn create_shortcut_inner(
        exe: &Path,
        link: &Path,
        app_id: &str,
    ) -> windows::core::Result<()> {
        let exe_str = HSTRING::from(exe.to_string_lossy().as_ref());
        let link_str = HSTRING::from(link.to_string_lossy().as_ref());
        let workdir = exe
            .parent()
            .map(|p| HSTRING::from(p.to_string_lossy().as_ref()))
            .unwrap_or_default();
        let shell_link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        shell_link.SetPath(&exe_str)?;
        shell_link.SetWorkingDirectory(&workdir)?;
        shell_link.SetDescription(&HSTRING::from("Lumisca"))?;
        shell_link.SetIconLocation(&exe_str, 0)?;
        let store: IPropertyStore = shell_link.cast()?;
        // NUL-terminated UTF-16 borrowed for the duration of SetValue
        // (which copies it); never PropVariantClear this — the buffer is
        // ours, not CoTaskMemAlloc'd.
        let wide: Vec<u16> = app_id.encode_utf16().chain(std::iter::once(0)).collect();
        let mut value = PROPVARIANT::default();
        // Union fields behind ManuallyDrop need the explicit deref to
        // assign through (the compiler rejects the auto-deref).
        (*value.Anonymous.Anonymous).vt = VT_LPWSTR;
        (*value.Anonymous.Anonymous).Anonymous.pwszVal = PWSTR(wide.as_ptr() as *mut u16);
        store.SetValue(&PKEY_AppUserModel_ID as *const _, &value as *const _)?;
        store.Commit()?;
        let file: IPersistFile = shell_link.cast()?;
        file.Save(&link_str, true)?;
        Ok(())
    }
}
