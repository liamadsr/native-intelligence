// ─────────────────────── Desktop bots (retired) ────────────────────────────
// The roaming bots' desktop overlay is gone (2026-10-17). Two commands stay as
// no-op stubs so a web build that still asks never hits "command not found":
// the web's one-time startup cleanup calls hide_desktop_bots, and older web
// builds probe desktop_bots_status. Both stay in build.rs APP_COMMANDS and the
// default capability. Nothing here builds a window.

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// The retired overlay's window label. No build opens it any more; kept only
/// so hide_desktop_bots can close one left over from an older binary's
/// session (it can't be, after a relaunch, but closing is harmless).
const DESKTOP_BOTS_LABEL: &str = "desktop-bots";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBotsStatus {
    /// Always false: this build has no overlay. The web reads it as
    /// unavailable and shows no control.
    pub available: bool,
    /// Always false.
    pub visible: bool,
}

/// The overlay is unavailable in this build.
#[tauri::command]
pub fn desktop_bots_status() -> DesktopBotsStatus {
    DesktopBotsStatus { available: false, visible: false }
}

/// Close a window with the retired overlay's label if one exists, else
/// nothing. Idempotent and never fails.
#[tauri::command]
pub fn hide_desktop_bots(app: AppHandle) {
    if let Some(window) = app.get_webview_window(DESKTOP_BOTS_LABEL) {
        let _ = window.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_reads_as_unavailable() {
        let status = desktop_bots_status();
        assert_eq!(status, DesktopBotsStatus { available: false, visible: false });
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({ "available": false, "visible": false })
        );
    }
}
