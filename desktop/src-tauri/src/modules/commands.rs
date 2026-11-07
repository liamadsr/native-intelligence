//! Generic Tauri commands for every local module (bridge contract §1.6).
//! Module-specific traffic uses its own event namespace (e.g. `stt://…`).

use tauri::{AppHandle, State};

use super::manager::{ModuleInfo, ModuleManager};

#[tauri::command]
pub fn modules_list(app: AppHandle, manager: State<'_, ModuleManager>) -> Vec<ModuleInfo> {
    manager.list(&app)
}

#[tauri::command]
pub fn module_enable(app: AppHandle, manager: State<'_, ModuleManager>, id: String) -> Result<ModuleInfo, String> {
    manager.enable(&app, &id)
}

#[tauri::command]
pub fn module_disable(app: AppHandle, manager: State<'_, ModuleManager>, id: String) -> Result<ModuleInfo, String> {
    manager.disable(&app, &id)
}

#[tauri::command]
pub fn module_remove_assets(
    app: AppHandle,
    manager: State<'_, ModuleManager>,
    id: String,
) -> Result<ModuleInfo, String> {
    manager.remove_assets(&app, &id)
}

/// The module's last log lines (its manager's and its sidecar's), oldest
/// first, with the home folder written as `~`. The web attaches them to a
/// failure it reports (speech-diagnostics.ts).
#[tauri::command]
pub fn module_log_tail(id: String) -> Vec<String> {
    super::log_tail::tail(&id)
}
