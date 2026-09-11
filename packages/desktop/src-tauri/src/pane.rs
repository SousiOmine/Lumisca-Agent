//! Geometry and OS-level placement of the docked pane window (the browser
//! lab today; the dock itself is content-agnostic).
//!
//! The pane is a separate OS window overlaid on the main window's right
//! edge — it is NOT a child view, so every move/resize/maximize of the main
//! window has to be mirrored here. Keeping that in one module means the
//! layout constants and the Windows-only z-order / virtual-desktop handling
//! have a single home, and `browser_lab.rs` stays about the RPC surface.

use tauri::{Manager, WebviewWindow};

/// Pane width in logical pixels. Must match `--pane-width`
/// in packages/web/src/styles/tokens.css (the Preact UI reserves this space).
pub const PANE_WIDTH: f64 = 460.0;
/// Height of the pane's header strip (rendered by the Preact UI in the
/// main window) in logical pixels. The pane window is positioned BELOW
/// this strip so the header never overlaps it. Must match
/// `--pane-header-height` in packages/web/src/styles/tokens.css.
pub const PANE_HEADER_HEIGHT: f64 = 36.0;
/// Height of the app's title bar in logical pixels. Must match
/// `--tab-height` in packages/web/src/styles/tokens.css (the pane starts
/// below it).
pub const APP_TITLEBAR_HEIGHT: f64 = 40.0;

/// The label of the window the pane docks to.
pub const MAIN_WINDOW_LABEL: &str = "main";

/// Position and size the pane against the main window's current geometry.
///
/// Tauri's `set_position`/`set_size` take logical values while the main
/// window's inner position/size are physical, so both are converted with
/// the window's scale factor.
pub fn place(pane: &WebviewWindow, main: &WebviewWindow) {
    let scale = main.scale_factor().unwrap_or(1.0);
    let inner_pos = main.inner_position().unwrap_or_default();
    let inner_size = main.inner_size().unwrap_or_default();
    let top = APP_TITLEBAR_HEIGHT + PANE_HEADER_HEIGHT;
    let x = (inner_pos.x as f64 + inner_size.width as f64) / scale - PANE_WIDTH;
    let y = inner_pos.y as f64 / scale + top;
    let height = (inner_size.height as f64 / scale - top).max(0.0);
    let _ = pane.set_position(tauri::LogicalPosition::new(x, y));
    let _ = pane.set_size(tauri::LogicalSize::new(PANE_WIDTH, height));
}

/// The pane's logical (CSS-pixel) size — the surface an emulated viewport
/// must fit into. `inner_size` is physical; scale_factor converts (the pane
/// overlays the main window, so both share one monitor).
///
/// Windows-only: the device emulation that consumes this does not exist on
/// the other platforms.
#[cfg(windows)]
pub fn size(pane: &WebviewWindow) -> (f64, f64) {
    let factor = pane.scale_factor().unwrap_or(1.0);
    let inner = pane.inner_size().unwrap_or_default();
    (inner.width as f64 / factor, inner.height as f64 / factor)
}

/// Bring the pane above the main window without activating it.
///
/// Only meaningful on Windows: a child window's z-order cannot be raised on
/// the other platforms (macOS keeps the pane key when clicked, Linux is
/// X11-dependent), but the pane still overlays correctly in the common
/// cases.
#[cfg(windows)]
pub fn raise(pane: &WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };
    if let Ok(hwnd) = pane.hwnd() {
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOP),
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
            );
        }
    }
}

#[cfg(not(windows))]
pub fn raise(_pane: &WebviewWindow) {}

/// Pin the pane to the main window's virtual desktop (Windows).
///
/// The pane is owned by the main window (see `browser_lab::ensure_window`),
/// which binds it to the owner's virtual desktop in the shell's tracking —
/// the real fix for the pane lingering on other desktops after a switch.
/// This function enforces that binding explicitly: it asks the shell
/// (`IVirtualDesktopManager`) which desktop the main window lives on and
/// moves the pane there. It runs right after creation, on every open,
/// whenever the pane is shown, and on every sync, so a desktop switch at any
/// point in the pane's life cannot leave it behind (task view would
/// otherwise show the borderless pane on every desktop).
///
/// Moving a window that is already there is a no-op, and any failure (no
/// virtual desktop support, a window destroyed meanwhile) only skips the
/// move.
#[cfg(windows)]
pub fn match_main_desktop(pane: &WebviewWindow, main: &WebviewWindow) {
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{IVirtualDesktopManager, VirtualDesktopManager};

    // Window creation runs on the RPC thread, which is not COM-initialized:
    // initialize this thread's apartment and release it again below
    // (S_OK = we initialized it; S_FALSE = it was already initialized in
    // the same mode, e.g. sync() on the app's main thread, and is not
    // ours to release; anything else skips the move entirely).
    let init = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if init.is_err() {
        return;
    }
    let must_uninit = init.0 == 0;
    let (Ok(pane_hwnd), Ok(main_hwnd)) = (pane.hwnd(), main.hwnd()) else {
        if must_uninit {
            unsafe { CoUninitialize() };
        }
        return;
    };
    // The manager is dropped before CoUninitialize below: releasing the
    // COM interface after the apartment went away would be a use-after-
    // uninit.
    if let Ok(manager) = unsafe {
        CoCreateInstance::<_, IVirtualDesktopManager>(
            &VirtualDesktopManager,
            None,
            CLSCTX_INPROC_SERVER,
        )
    } {
        if let Ok(desktop) = unsafe { manager.GetWindowDesktopId(main_hwnd) } {
            let _ = unsafe { manager.MoveWindowToDesktop(pane_hwnd, &desktop) };
        }
    }
    if must_uninit {
        unsafe { CoUninitialize() };
    }
}

#[cfg(not(windows))]
pub fn match_main_desktop(_pane: &WebviewWindow, _main: &WebviewWindow) {}

/// The main window the pane docks to, if it exists.
pub fn main_window(app: &tauri::AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW_LABEL)
}
