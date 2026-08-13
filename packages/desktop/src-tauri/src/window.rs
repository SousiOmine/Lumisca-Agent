//! Window helpers: navigation of the main webview window, and the Win32
//! hack that force-activates the window so a bridge-started caption drag
//! works on the first gesture even when the app is unfocused.

use tauri::{AppHandle, Manager};

/// Force-activate the window so DefWindowProc starts the caption drag on
/// the first gesture even when the app is unfocused. The drag press lands
/// in the WebView2 child process, so the app itself never gains
/// foreground rights; the classic AttachThreadInput trick grants them.
#[cfg(windows)]
pub(crate) fn focus_window_for_drag(window: &tauri::WebviewWindow) {
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    unsafe {
        if SetForegroundWindow(hwnd).as_bool() {
            return;
        }
        let foreground = GetForegroundWindow();
        if foreground.0.is_null() {
            return;
        }
        let foreground_thread = GetWindowThreadProcessId(foreground, None);
        let current_thread = GetCurrentThreadId();
        if foreground_thread != current_thread {
            let _ = AttachThreadInput(current_thread, foreground_thread, true);
            let _ = SetForegroundWindow(hwnd);
            let _ = AttachThreadInput(current_thread, foreground_thread, false);
        }
    }
}

/// Navigate the main window to a URL (local server page or remote server
/// page).
pub(crate) fn navigate_main(app: &AppHandle, url: &str) -> Result<(), String> {
    let parsed = url
        .parse::<url::Url>()
        .map_err(|e| format!("URL が不正です: {e}"))?;
    if let Some(window) = app.get_webview_window("main") {
        window
            .navigate(parsed)
            .map_err(|e| format!("画面遷移に失敗しました: {e}"))?;
    }
    Ok(())
}
