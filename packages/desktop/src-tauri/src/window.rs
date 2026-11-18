//! Window helpers: navigation of the main webview window, the links it hands
//! to the OS instead of opening them itself, and the Win32 hack that
//! force-activates the window so a bridge-started caption drag works on the
//! first gesture even when the app is unfocused.

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

/// Whether a URL the page asked to open belongs outside the app window.
///
/// http(s) and mailto only: the links are model output, so a scheme that
/// names a local file or runs code must never reach the OS handler. The
/// window has no address bar, tabs or back button either, so a page it
/// opened itself would leave the reader no way back to the conversation.
pub(crate) fn opens_externally(url: &url::Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

/// Open `url` with the OS: the browser for http(s), the mail client for
/// mailto.
///
/// Returns once the handler is started. Waiting for it would hold the
/// webview's callback until the browser exits, and the child is reaped on a
/// thread of its own so a click does not leave a zombie behind.
pub(crate) fn open_externally(url: &url::Url) -> Result<(), String> {
    spawn_external(url.as_str()).map_err(|e| format!("{url}: {e}"))
}

/// The URL reaches the handler as one argument of a program, never as a
/// shell word: its content is the model's.
#[cfg(unix)]
fn spawn_external(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(not(target_os = "macos"))]
    let program = "xdg-open";

    let mut child = std::process::Command::new(program)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(windows)]
fn spawn_external(url: &str) -> std::io::Result<()> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let operation = HSTRING::from("open");
    let target = HSTRING::from(url);
    // ShellExecuteW passes the URL to the registered handler as one string.
    // `cmd /C start` would re-parse it as a command line, where `&` and `|`
    // in model output become operators.
    let opened = unsafe {
        ShellExecuteW(
            None,
            &operation,
            &target,
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // Anything above 32 is a handle; 32 and below are error codes.
    if (opened.0 as isize) <= 32 {
        return Err(std::io::Error::other(format!(
            "ShellExecuteW returned {}",
            opened.0 as isize
        )));
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn spawn_external(_url: &str) -> std::io::Result<()> {
    Err(std::io::Error::other(
        "opening a link is not supported on this platform",
    ))
}

#[cfg(test)]
mod tests {
    use super::opens_externally;

    #[test]
    fn links_to_the_web_and_the_mail_client_open_outside() {
        for url in [
            "https://example.com/a?b=1",
            "http://127.0.0.1:8000/code",
            "mailto:someone@example.com",
        ] {
            assert!(opens_externally(&url.parse().unwrap()), "{url}");
        }
    }

    #[test]
    fn other_schemes_never_reach_the_os() {
        for url in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,hi",
            "about:blank",
        ] {
            assert!(!opens_externally(&url.parse().unwrap()), "{url}");
        }
    }
}
