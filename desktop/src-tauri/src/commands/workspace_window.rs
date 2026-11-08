use std::path::PathBuf;
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Open a new window for a different workspace.
///
/// STORAGE IS SHARED WITH THE MAIN WINDOW — cookies, localStorage and
/// sessionStorage all live in the default `WKWebsiteDataStore`. The
/// `.data_directory()` call below does NOT change that on macOS: wry 0.54.3's
/// non-GTK `WebContextImpl` is an empty unit struct, so the path is accepted and
/// silently ignored. It only has an effect on Linux/WebKitGTK.
///
/// That is deliberate, not just an accident of the platform. Real isolation is
/// available (`data_store_identifier`, macOS 14+), but it would hand each popout
/// an EMPTY cookie jar — no Supabase session, so opening a workspace window
/// would drop the user at a sign-in wall instead of their workspace. Shared
/// storage is the right trade until popouts can be handed an auth session of
/// their own.
///
/// The window loads `/account?switch_to={workspace_id}` so the web app
/// automatically switches to the correct workspace on load. With storage shared,
/// that query param — not the browsing context — is what makes the window show a
/// different workspace.
#[tauri::command]
pub fn open_workspace_window(
    app: AppHandle,
    workspace_id: String,
    workspace_name: String,
) -> Result<(), String> {
    // A page can call this, and the id goes into a path, a window label and a
    // URL: accept only an id's characters (every real caller passes a UUID).
    if workspace_id.is_empty()
        || workspace_id.len() > 64
        || !workspace_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("Invalid workspace id".into());
    }

    let label = format!("workspace-{}", workspace_id);

    // If a window for this workspace already exists, focus it
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }

    // Per-workspace data directory. A no-op on macOS (see the doc comment above)
    // and kept only so the Linux/WebKitGTK path has somewhere to write.
    let data_dir: PathBuf = dirs::home_dir()
        .ok_or("Could not determine home directory")?
        .join(".dial8")
        .join("workspaces")
        .join(&workspace_id);

    // Ensure the directory exists
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create workspace data directory: {}", e))?;

    // Determine the frontend URL (dev or production)
    let base_url = if cfg!(debug_assertions) {
        "http://localhost:3000"
    } else {
        "https://dial8.ai"
    };

    let url_str = format!("{}/account?switch_to={}", base_url, workspace_id);
    let url = WebviewUrl::External(
        url_str.parse().map_err(|e| format!("Invalid URL: {}", e))?,
    );

    // macOS draws no title (the page sits under an overlay title bar, its
    // traffic lights over the tab bar); Windows has a native title bar.
    let title = if cfg!(target_os = "macos") { "" } else { "Native Intelligence" }.to_string();

    // Offset the new window from the current one so they're visually distinct
    // and can be arranged side by side
    let mut builder = WebviewWindowBuilder::new(&app, &label, url)
        .title(&title)
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .data_directory(data_dir)
        // Keep the WebView's JS/timers/WebSockets alive when this window is
        // hidden or fully occluded by another app (e.g. a video-call window).
        // Without this, macOS suspends the WebContent process after ~5 min of
        // occlusion, which silently kills live transcription mid-meeting even
        // though native audio capture keeps running. Mirrors the main window's
        // backgroundThrottling:"disabled" in tauri.conf.json. (macOS 14+/iOS 17+.)
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        // Disable the OS-level drag/drop handler so kanban DnD (and any other
        // in-page HTML5 drag) actually reaches the React handlers. Without
        // this, dropping a card produces a green-plus "add file" cursor and
        // the drop event never fires in JS. The main window has the same flag
        // set to false via tauri.conf.json — match it here for popout windows.
        .disable_drag_drop_handler();
    #[cfg(target_os = "macos")]
    {
        builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay);
    }

    // Position relative to the currently focused window (cascade offset)
    for (_lbl, win) in app.webview_windows() {
        if win.is_focused().unwrap_or(false) {
            if let Ok(pos) = win.outer_position() {
                let scale = win.scale_factor().unwrap_or(1.0);
                let offset = 30.0;
                builder = builder.position(
                    pos.x as f64 / scale + offset,
                    pos.y as f64 / scale + offset,
                );
            }
            break;
        }
    }

    let window = builder.build()
        .map_err(|e| format!("Failed to create workspace window: {}", e))?;

    // Recover from a WebContent (renderer) process kill on this popout, the
    // same way `main` does in lib.rs's setup(). A popout carries exactly the
    // state worth recovering — its own workspace's open tabs, rehydrated from
    // localStorage after the reload — and dies the same silent, blank-window
    // death without this. Installed right after build() because the WKWebView
    // (and wry's navigation delegate on it) exists by then.
    #[cfg(target_os = "macos")]
    crate::native::webcontent_watchdog::install_default_recovery(&window);
    #[cfg(not(target_os = "macos"))]
    let _ = window;

    crate::log_to_file(&format!(
        "[workspace_window] Opened window for workspace: {} ({})",
        workspace_name, workspace_id
    ));

    Ok(())
}
