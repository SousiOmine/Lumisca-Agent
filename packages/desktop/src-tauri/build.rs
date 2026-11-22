fn main() {
    // `shell_action` is the IPC fallback for the loopback shell bridge (see
    // src/bridge.rs). Declaring it in the app manifest generates
    // `allow-shell-action` / `deny-shell-action`. The main window shows the
    // bundled UI, so only the local capability grants it; pages from remote
    // origins are not given the command.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["shell_action"])),
    )
    .expect("failed to run tauri-build");
}
