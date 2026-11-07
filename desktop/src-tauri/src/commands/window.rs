/// Window-behavior commands.
///
/// The close-to-tray setting: whether closing the MAIN window hides it (app
/// keeps running, tray + notifications + any live recording stay alive) or
/// really closes it. The interception itself lives in lib.rs's
/// `on_window_event` CloseRequested arm; these commands only own the setting.
///
/// And `focus_own_window`: a dashboard window bringing ITSELF forward.
use std::sync::atomic::Ordering;

use tauri::{AppHandle, State, WebviewWindow};

use crate::state::AppState;

/// Read the current close-to-tray setting from the in-memory cache (seeded from
/// the persisted store at setup, so it can't disagree with what the window
/// handler will actually do).
#[tauri::command]
pub fn get_close_to_tray(state: State<'_, AppState>) -> bool {
    state.close_to_tray_enabled.load(Ordering::Relaxed)
}

/// Persist the close-to-tray setting AND update the in-memory cache the
/// `on_window_event` handler reads. Both, always — the handler never touches
/// the store, so skipping the cache update would leave the setting inert until
/// the next launch.
#[tauri::command]
pub fn set_close_to_tray(state: State<'_, AppState>, app_handle: AppHandle, enabled: bool) {
    state
        .close_to_tray_enabled
        .store(enabled, Ordering::Relaxed);
    crate::settings::set_close_to_tray_enabled(&app_handle, enabled);
}

/// Bring the CALLING dashboard window forward: unminimize, show, focus.
///
/// For the live agent HUD's back-to-the-capture button: the HUD emits the click
/// to the recording window (`main` or a `workspace-*` popout), which opens the
/// capture's card and then calls this to surface itself. Deliberately narrow
/// instead of granting the web `core:window:allow-set-focus` / `allow-show` /
/// `allow-unminimize`: those take a target label from the page, so any webview
/// could raise, show or unminimize ANY window. Here the target is always the
/// invoking window (`WebviewWindow` is injected by tauri, never sent by the
/// page) and the HUD overlays are refused, so the only thing a page can do is
/// raise its own dashboard window.
#[tauri::command]
pub fn focus_own_window(window: WebviewWindow) -> Result<(), String> {
    check_focus_caller(window.label())?;
    // unminimize -> show -> set_focus, in that order: set_focus alone is
    // unreliable on a hidden or minimized window (as notifications.rs).
    window.unminimize().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

/// Only a dashboard window may raise itself; a floating overlay never.
fn check_focus_caller(label: &str) -> Result<(), String> {
    if crate::is_hud_label(label) {
        return Err("Only a dashboard window can bring itself forward".into());
    }
    Ok(())
}

#[cfg(test)]
mod focus_own_window_tests {
    use super::check_focus_caller;

    #[test]
    fn dashboard_windows_may_raise_themselves() {
        for label in ["main", "workspace-4f1c2d"] {
            assert!(check_focus_caller(label).is_ok(), "{label}");
        }
    }

    #[test]
    fn overlays_may_not() {
        for label in crate::HUD_LABELS {
            assert!(check_focus_caller(label).is_err(), "{label}");
        }
    }
}
