fn main() {
    // `shell_action` is the IPC fallback for the loopback shell bridge (see
    // src/bridge.rs). Declaring it in the app manifest generates
    // `allow-shell-action` / `deny-shell-action`, so a capability can grant
    // it to remote pages — which is exactly the case that needs the IPC
    // fallback: a page served over HTTPS cannot fetch the loopback listener.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["shell_action"])),
    )
    .expect("failed to run tauri-build");
}
