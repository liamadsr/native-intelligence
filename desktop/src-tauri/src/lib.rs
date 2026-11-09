#[cfg(target_os = "macos")]
mod app_menu;
mod app_update;
mod audio;
// Debug builds and the `automation-bridge` feature only: never a release
// (automation/mod.rs).
#[cfg(any(debug_assertions, feature = "automation-bridge"))]
mod automation;
mod browser_exit;
mod commands;
mod dictate;
mod incoming_url;
mod local_agent;
mod meeting_detection;
mod modules;
mod native;
mod nav_guard;
mod notifications;
mod permissions;
mod power;
mod quit;
mod read_selection;
mod settings;
mod sidecar;
mod sleep_guard;
mod state;
mod sysctl;
mod tray;
mod voice;
mod window_backdrop;

/// The chat voice replay harness's CLI (`examples/voice_replay.rs`).
#[doc(hidden)]
pub use voice::replay::cli_main as voice_replay_main;

use state::AppState;
use tauri::{Emitter, EventTarget, Listener, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

/// Labels that are floating overlays rather than dashboard webviews. They mount
/// none of the web app's window-scoped listeners, so per-window focus signals
/// aimed at the dashboard have nothing to reach there.
///
/// SINGLE OWNER of the HUD label set for the whole crate — `notifications.rs`
/// and `tray.rs` classify against this list too. Adding an overlay window means
/// editing exactly this one place.
pub(crate) const HUD_LABELS: [&str; 3] = ["meeting-hud", "agent-hud", crate::dictate::PANEL];

/// Whether `label` is a floating overlay rather than a window running the web app.
pub(crate) fn is_hud_label(label: &str) -> bool {
    HUD_LABELS.contains(&label)
}

/// Whether `label` is a dashboard webview (`main` or a `workspace-*` popout),
/// i.e. a window running the web app and able to act on focus.
fn is_dashboard_label(label: &str) -> bool {
    !is_hud_label(label)
}

/// Last time each window label saw `Focused(true)`, keyed by label. Read and
/// written only from the Tauri event thread, but a `Mutex` anyway because the
/// map is process-global and `on_window_event` makes no thread guarantees.
///
/// `SystemTime`, not `Instant`: on Apple targets `Instant` is CLOCK_UPTIME_RAW,
/// which does NOT advance while the machine is asleep — the gap would measure
/// awake time only and skip the nudge in the wake-from-sleep case it exists for.
#[cfg(target_os = "macos")]
static LAST_FOCUS_NUDGE: std::sync::Mutex<Option<std::collections::HashMap<String, std::time::SystemTime>>> =
    std::sync::Mutex::new(None);

/// How long a window stays "recently focused" for repaint-nudge purposes. The
/// nudge exists for the wake-from-sleep case, where the WKWebView surface can
/// come back blank and needs a forced recomposite; a window that had focus
/// seconds ago has a live, painted surface and needs nothing. Measured in WALL
/// CLOCK time, so time spent asleep counts toward the gap; short enough that a
/// window left alone for a few minutes still gets nudged on return.
#[cfg(target_os = "macos")]
const FOCUS_NUDGE_MIN_GAP: std::time::Duration = std::time::Duration::from_secs(300);

/// Record this focus and report whether the repaint nudge should run.
///
/// First focus of a label always nudges (no prior timestamp), as does any focus
/// more than `FOCUS_NUDGE_MIN_GAP` after the previous one. Rapid A↔B switching
/// between two workspace windows — where each `set_size` pair costs a
/// synchronous full-dashboard relayout + repaint — pays nothing.
///
/// FAILS OPEN: any uncertainty (poisoned lock, wall clock moved backwards under
/// an NTP correction) nudges, because a redundant nudge only costs a relayout
/// while a skipped one can leave a blank window.
#[cfg(target_os = "macos")]
fn should_nudge_repaint(label: &str) -> bool {
    let now = std::time::SystemTime::now();
    let Ok(mut guard) = LAST_FOCUS_NUDGE.lock() else {
        // Poisoned lock: prefer the (merely expensive) nudge over a window that
        // may be left blank after sleep.
        return true;
    };
    let map = guard.get_or_insert_with(std::collections::HashMap::new);
    map.insert(label.to_string(), now)
        .map(|prev| {
            // Err(_) = clock moved backwards; treat the entry as stale and nudge.
            now.duration_since(prev)
                .unwrap_or(FOCUS_NUDGE_MIN_GAP)
                >= FOCUS_NUDGE_MIN_GAP
        })
        .unwrap_or(true)
}

/// Drop a destroyed window's focus timestamp.
///
/// A label can be RECREATED (a reopened workspace popout), and the new window's
/// brand-new WKWebView surface is exactly when the recomposite is most needed —
/// inheriting the dead window's timestamp would suppress it.
#[cfg(target_os = "macos")]
fn forget_focus_nudge(label: &str) {
    if let Ok(mut guard) = LAST_FOCUS_NUDGE.lock() {
        if let Some(map) = guard.as_mut() {
            map.remove(label);
        }
    }
}

// FFI: app_nap_helper.m compiled into the main binary via build.rs.
// Suppresses macOS App Nap for the process lifetime so the backgrounded
// WebView keeps getting scheduled (no freeze / multi-minute catch-up on wake).
#[cfg(target_os = "macos")]
extern "C" {
    fn app_nap_disable() -> bool;
    // window_helper.m — paint the NSWindow + web content layer with the app
    // background color so live-resize doesn't flash empty space before the
    // WebView repaints. Takes a raw NSWindow pointer.
    fn window_apply_background(ns_window: *mut std::ffi::c_void) -> bool;
    // window_helper.m — the inverse of window_apply_background: make the NSWindow
    // genuinely transparent (clear backgroundColor, non-opaque window + content
    // layer + WKWebView layer) so a transparent Tauri window doesn't flash an
    // opaque white square on repaint (e.g. the agent HUD after a theme switch).
    fn window_clear_background(ns_window: *mut std::ffi::c_void) -> bool;
    // window_helper.m — disable the implicit CoreAnimation animation on the
    // WKWebView's backing layer so it tracks the window frame synchronously on
    // maximize/zoom instead of easing into place a beat behind.
    fn window_sync_webview_resize(ns_window: *mut std::ffi::c_void) -> bool;
    // window_helper.m — make zoom/maximize an instant frame change instead of an
    // animated grow, so the WebView gets one resize to lay out instead of churning
    // through hundreds of intermediate sizes.
    fn window_disable_zoom_animation(ns_window: *mut std::ffi::c_void) -> bool;
    // window_helper.m — shrink the macOS traffic lights to `diameter` points and
    // vertically center them at `center_y` points below the window top, so they
    // line up with the web tab bar's buttons instead of sitting larger + higher.
    fn window_style_traffic_lights(
        ns_window: *mut std::ffi::c_void,
        diameter: f64,
        center_y: f64,
    ) -> bool;
    // window_helper.m — make a floating HUD a non-activating panel that shows on
    // every Space, full-screen ones included (the agent HUD during a
    // full-screen call). 0, or why the window was left a plain window.
    fn window_make_overlay_panel(ns_window: *mut std::ffi::c_void) -> std::ffi::c_int;
    // window_helper.m — bring a window to the front without making it key.
    fn window_order_front_without_focus(ns_window: *mut std::ffi::c_void);
}

/// Diameter (points) for the traffic lights — smaller than the macOS 26 default
/// so they don't dwarf the tab-bar buttons next to them.
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_DIAMETER: f64 = 12.0;
/// Distance (points) from the window top to the traffic-light centers. The web
/// top bar adds 8pt top padding (`pt-2`) above 32pt-tall (`h-8`) buttons, so the
/// button centers sit at 8 + 32/2 = 30pt — match that to line the lights up with
/// them. (Measured live: buttons span top=14pt … bottom=46pt → center 30pt.)
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_CENTER_Y: f64 = 30.0;

/// Apply the appearance-matched background color to a window so the brief gap
/// during live resize blends into the app instead of flashing white. Re-run on
/// theme changes so it tracks light/dark. Accepts the raw NSWindow pointer
/// (from either `Window::ns_window()` or `WebviewWindow::ns_window()`).
#[cfg(target_os = "macos")]
fn apply_window_background(ns_window: *mut std::ffi::c_void) {
    unsafe {
        window_apply_background(ns_window);
    }
}

/// Make a window genuinely transparent at the native layer (the Tauri
/// `.transparent(true)` flag alone leaves an opaque NSWindow backing that shows
/// as a white square on repaint). For floating transparent panels like the agent
/// HUD. Re-run on appearance change to be safe.
#[cfg(target_os = "macos")]
pub(crate) fn clear_window_background(ns_window: *mut std::ffi::c_void) {
    unsafe {
        window_clear_background(ns_window);
    }
}

/// No-op on non-macOS so callers (e.g. the agent HUD in hud.rs) don't need cfg
/// guards. The transparent-window fix is macOS-specific.
#[cfg(not(target_os = "macos"))]
pub(crate) fn clear_window_background(_ns_window: *mut std::ffi::c_void) {}

/// Make a floating HUD a non-activating panel that floats over every Space,
/// full-screen apps included (window_helper.m). Main thread, before the window
/// is first shown. Err says why the window couldn't be converted and keeps its
/// old behavior.
#[cfg(target_os = "macos")]
pub(crate) fn make_overlay_panel(ns_window: *mut std::ffi::c_void) -> Result<(), &'static str> {
    // window_helper.h DIAL8_OVERLAY_*
    match unsafe { window_make_overlay_panel(ns_window) } {
        0 => Ok(()),
        1 => Err("its class is not a plain NSWindow subclass"),
        2 => Err("tao's window class has a destructor"),
        _ => Err("the panel class did not fit"),
    }
}

/// Bring a window to the front without making it key (window_helper.m), so a
/// floating HUD that shows up never takes the keyboard. Main thread.
#[cfg(target_os = "macos")]
pub(crate) fn order_front_without_focus(ns_window: *mut std::ffi::c_void) {
    unsafe { window_order_front_without_focus(ns_window) }
}

/// Make the WKWebView's layer resize synchronously with the window. Idempotent;
/// re-applied on resize events because AppKit can rebuild the layer (and reset
/// its actions) across some window-state transitions.
#[cfg(target_os = "macos")]
fn sync_webview_resize(ns_window: *mut std::ffi::c_void) {
    unsafe {
        window_sync_webview_resize(ns_window);
    }
}

/// Make zoom/maximize instant (no grow animation) so the WebView lays out once
/// at the final size instead of trailing the animation. Install once at setup.
#[cfg(target_os = "macos")]
fn disable_zoom_animation(ns_window: *mut std::ffi::c_void) {
    unsafe {
        window_disable_zoom_animation(ns_window);
    }
}

/// Shrink + vertically center the macOS traffic lights to align with the web
/// tab-bar buttons. Idempotent and cheap; re-applied on resize because AppKit
/// resets the button frames across some window-state transitions.
#[cfg(target_os = "macos")]
fn style_traffic_lights(ns_window: *mut std::ffi::c_void) {
    unsafe {
        window_style_traffic_lights(ns_window, TRAFFIC_LIGHT_DIAMETER, TRAFFIC_LIGHT_CENTER_Y);
    }
}

/// Max size of the debug log before it's rotated. Recording-lifecycle
/// breadcrumbs (ownership decisions, device-stall warnings) add volume over a
/// long session, so cap the file and keep only the most recent slice rather than
/// letting it grow unbounded in /tmp.
const LOG_MAX_BYTES: u64 = 10 * 1024 * 1024; // 10 MB

/// Where [`log_to_file`] writes when something other than the app runs the
/// library: unset in the app (the debug log), `Some(path)` for a tool's own
/// log, `None` for nowhere. See [`redirect_log`].
static LOG_SINK: std::sync::OnceLock<Option<std::path::PathBuf>> = std::sync::OnceLock::new();

/// Send [`log_to_file`] somewhere other than the app's debug log (`None`:
/// nowhere), so a tool's runs (the voice replay harness) never read as the
/// app's. First call wins; the app never calls it.
pub fn redirect_log(path: Option<std::path::PathBuf>) {
    let _ = LOG_SINK.set(path);
}

/// The file [`log_to_file`] writes: the app's debug log unless redirected,
/// `None` when redirected to nowhere. Unit tests (`cfg(test)`) never log.
fn log_path(sink: Option<&Option<std::path::PathBuf>>) -> Option<std::path::PathBuf> {
    match sink {
        None => Some(std::env::temp_dir().join("dial8-debug.log")),
        Some(path) => path.clone(),
    }
}

/// The single rotation backup beside `path` (`dial8-debug.log.1`).
fn log_backup(path: &std::path::Path) -> std::path::PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".1");
    path.with_file_name(name)
}

/// Where a side log (`dial8-meeting.log`, `dial8-tray.log`) lives: `/tmp` on
/// macOS, where people already look for them; elsewhere the user's own temp
/// folder (`%TEMP%` on Windows has no `/tmp`).
pub(crate) fn side_log_path(name: &str) -> std::path::PathBuf {
    if cfg!(unix) {
        std::path::Path::new("/tmp").join(name)
    } else {
        std::env::temp_dir().join(name)
    }
}

/// Open the log at `path` to append to it, readable by this user alone. The
/// logs carry meeting titles, calendar events and what the person's agents
/// did, and two of them live in the shared /tmp (security review 2026-10-31):
/// - created 0600, and a file an older build left 0644 is made 0600;
/// - never through a symlink (O_NOFOLLOW), and never a file another user
///   owns (one could plant either in /tmp first): those aren't written.
pub(crate) fn open_log(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        let file = options.open(path)?;
        let meta = file.metadata()?;
        // SAFETY: geteuid has no preconditions.
        if meta.uid() != unsafe { libc::geteuid() } || !meta.is_file() {
            return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "not this user's log file"));
        }
        if meta.mode() & 0o077 != 0 {
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(file)
    }
    #[cfg(not(unix))]
    options.open(path)
}

pub fn log_to_file(msg: &str) {
    use std::io::Write;
    if cfg!(test) {
        return; // unit tests must not write into the real app log
    }
    let time = chrono::Local::now().format("%H:%M:%S").to_string();
    // A module's lines also go to its tail (module_log_tail), log file or not.
    modules::log_tail::record(&time, msg);
    let Some(path) = log_path(LOG_SINK.get()) else {
        return;
    };

    // Best-effort size-based rotation: if the file has grown past the cap, move
    // it to a single `.1` backup (overwriting any prior backup) and start fresh.
    // This keeps at most ~2× LOG_MAX_BYTES on disk and preserves recent history.
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > LOG_MAX_BYTES {
            let _ = std::fs::rename(&path, log_backup(&path));
        }
    }

    if let Ok(mut f) = open_log(&path) {
        let _ = writeln!(f, "[{}] {}", time, msg);
    }
}

#[cfg(test)]
mod log_tests {
    use super::*;

    #[test]
    fn the_app_logs_to_the_debug_log_unless_redirected() {
        let debug = std::env::temp_dir().join("dial8-debug.log");
        assert_eq!(log_path(None), Some(debug.clone()), "the app: unchanged");
        assert_eq!(log_backup(&debug), std::env::temp_dir().join("dial8-debug.log.1"), "its backup: unchanged");
        let replay = std::env::temp_dir().join("dial8-voice-replay.log");
        assert_eq!(log_path(Some(&Some(replay.clone()))), Some(replay));
        assert_eq!(log_path(Some(&None)), None, "nowhere");
    }

    #[cfg(unix)]
    fn mode(path: &std::path::Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[cfg(unix)]
    #[test]
    fn a_log_is_this_users_alone() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();

        // New: created 0600.
        let new = dir.path().join("dial8-meeting.log");
        writeln!(open_log(&new).unwrap(), "one").unwrap();
        assert_eq!(mode(&new), 0o600);

        // An older build's 0644 log is made 0600, and appended to.
        let old = dir.path().join("dial8-tray.log");
        std::fs::write(&old, "before\n").unwrap();
        std::fs::set_permissions(&old, std::fs::Permissions::from_mode(0o644)).unwrap();
        writeln!(open_log(&old).unwrap(), "after").unwrap();
        assert_eq!(mode(&old), 0o600);
        assert_eq!(std::fs::read_to_string(&old).unwrap(), "before\nafter\n");

        // A symlink planted at the log's path is never followed.
        let target = dir.path().join("someone-elses-file");
        std::fs::write(&target, "keep\n").unwrap();
        let link = dir.path().join("dial8-debug.log");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(open_log(&link).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep\n");
    }
}

#[cfg(test)]
mod bundle_config_tests {
    /// Info.plist's CFBundleURLTypes REPLACES the array Tauri generates from the
    /// deep-link plugin config (it doesn't merge). An http/https entry once
    /// silently dropped `dial8desktop`, which breaks desktop sign-in / OAuth
    /// callbacks. Every configured deep-link scheme must be declared in
    /// Info.plist too, and http/https never are: Native Intelligence hands web links to the
    /// system browser and is never a default-browser choice.
    #[test]
    fn info_plist_declares_every_deep_link_scheme() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json parses");
        let plist = include_str!("../Info.plist");
        let schemes = conf["plugins"]["deep-link"]["desktop"]["schemes"]
            .as_array()
            .expect("deep-link desktop schemes configured");
        assert!(!schemes.is_empty());
        for s in schemes {
            let s = s.as_str().expect("scheme is a string");
            assert!(
                plist.contains(&format!("<string>{s}</string>")),
                "Info.plist CFBundleURLTypes is missing the deep-link scheme `{s}` — add it (see the comment there)"
            );
        }
        assert!(plist.contains("<string>dial8desktop</string>"), "Info.plist must declare dial8desktop");
        // Native Intelligence must never offer itself as a web browser to the OS.
        assert!(
            !plist.contains("<string>http</string>") && !plist.contains("<string>https</string>"),
            "Info.plist must not declare http/https URL schemes"
        );
        assert!(!plist.contains("ai.dial8.desktop.web"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        // FIRST in the chain, per the plugin's README ("plugins run in the order
        // they were added in to the builder, so make sure that this plugin is
        // registered first") — a second launch has to be detected and killed
        // before the rest of the stack starts spinning up.
        //
        // Close-to-tray makes this a prerequisite, not polish: with `main`
        // hidden, relaunching from the Dock/Finder used to fork a whole second
        // process (second tray icon, second realtime subscription, second
        // meeting detector). Now the second instance exits immediately and the
        // living one un-hides its window instead.
        //
        // `init()` wraps this callback with the deep-link forwarder itself
        // (verified in tauri-plugin-single-instance-2.4.0 src/lib.rs
        // `Builder::callback`), so a second launch carrying a dial8desktop://
        // URL still reaches tauri-plugin-deep-link — no deep-link code needed
        // here.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            log_to_file("[single-instance] second launch — restoring main window");
            crate::tray::focus_main_window(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        // Top-level navigation allowlist for every webview (main, workspace
        // popouts, HUDs). Keeps a Native Intelligence window from ever
        // rendering an origin that isn't Native Intelligence's; external web links are handed to the
        // system browser instead. Registered after the opener plugin because it
        // calls into it. See nav_guard.rs.
        .plugin(crate::nav_guard::init());

    // The updater must never run in debug builds. tauri.conf.json's version
    // trails the released one, so the frontend's auto-check (app-updater.tsx,
    // ~5s after launch) would downloadAndInstall() the notarized production
    // app OVER the debug bundle at target/debug/bundle/macos/Native Intelligence.app. That
    // on-disk swap makes tccd's static-code validation of the running client
    // fail mid-session ("Failed to match existing code requirement" /
    // SecStaticCodeCreateWithPath -67011), which silently kills the
    // microphone grant: cpal keeps delivering zero-filled buffers with no
    // prompt and no error, and the next launch from that path is secretly
    // production pointed at https://dial8.ai. See docs/PERMISSIONS.md.
    // The frontend tolerates the missing plugin: checkForUpdate() rejects and
    // app-updater.tsx catches it and treats it as "no update".
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    // macOS app menu = Tauri's default one plus Help → "Open Source Licenses"
    // (app_menu.rs). macOS only: elsewhere Tauri sets no menu by default, and
    // setting one would give every Windows window a menu bar.
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(app_menu::build)
        .on_menu_event(app_menu::on_menu_event);

    builder
        .manage(AppState::new())
        .manage(modules::ModuleManager::new())
        .on_page_load(|webview, payload| {
            // A HARD NAVIGATION IS A LISTENER BLACK HOLE, and nothing else
            // catches it. The native-notification click handler itself does
            // `window.location.assign('/account/agent-runs/<id>')`; any reload
            // or external-link navigation does the same thing. That tears down
            // the JS context — and with it the `notification-clicked` listener
            // — WITHOUT firing WindowEvent::Destroyed, because the window is
            // very much alive. The label therefore stays in READY_WINDOWS, so
            // the NEXT click is emitted straight at a page that has no listener
            // yet. The emit succeeds at the Tauri level, so the click is
            // silently swallowed instead of being buffered and flushed when the
            // new page calls notification_click_listener_ready.
            //
            // Started (not Finished): deregister the instant the old context is
            // on its way out, so no click can slip through the load window.
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                crate::notifications::forget_window(webview.label());
                // Read-aloud this page started would otherwise play on with no
                // page left to show its Stop control.
                use tauri::Manager;
                modules::tts::cancel_for_page(webview.app_handle(), webview.label());
                // Likewise a voice session this page owns: its mic, and the
                // controls to end it, would be gone.
                voice::end_for_page(webview.app_handle(), webview.label());
                // The agent HUD's page is going: its nudge listener with it.
                if webview.label() == "agent-hud" {
                    commands::hud::on_agent_hud_page_load_started();
                }
            }
            // The main window has painted: Native Intelligence's own CoreAudio can start
            // (audio::launch_gate).
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
                && webview.label() == "main"
            {
                crate::audio::launch_gate::main_page_loaded(payload.url().as_str());
            }
        })
        .on_window_event(|window, event| {
            // CLOSE-TO-TRAY. Closing the MAIN window hides it instead of
            // destroying it: the process, tray, webview, realtime subscription,
            // and any in-flight recording all keep running. Quitting for real is
            // Cmd+Q or the tray's "Quit Native Intelligence" — see the RunEvent::ExitRequested
            // arm at the bottom of this file for why the interception CANNOT
            // live there.
            //
            // "main" ONLY. workspace-* popouts and the two HUDs have their own
            // deliberate close/hide semantics and must keep today's behavior.
            //
            // This arm returns EARLY, and that early return is load-bearing: it
            // is what keeps the recording-cleanup block below from seeing this
            // event. reset_recording_state hard-stops the mic + system-audio
            // capture and finalizes the WAV — running it here would silently
            // kill the user's in-progress meeting recording the moment they hit
            // the red button, which is precisely the thing close-to-tray exists
            // to prevent. Nothing is stale either: `main` stays a live, gettable
            // window while hidden, so start_recording's ownership guard is still
            // satisfied and needs no cleanup.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                use tauri::Manager;
                if window.label() == "main"
                    && window
                        .state::<AppState>()
                        .close_to_tray_enabled
                        .load(std::sync::atomic::Ordering::Relaxed)
                {
                    api.prevent_close();

                    // Closing is the user's stop gesture for chat voice too:
                    // a voice session this window owns (its mic, its turns,
                    // its read-aloud replies) must not carry on hidden. Ended
                    // here, before either hide below; a voice start still in
                    // flight for this page is refused. A meeting capture is
                    // untouched (see above).
                    voice::end_for_page(window.app_handle(), window.label());

                    // A NATIVE-FULLSCREEN WINDOW CANNOT JUST BE HIDDEN. hide()
                    // is a bare orderOut: of the NSWindow, and macOS keeps the
                    // dedicated fullscreen Space that window owns. The Space
                    // survives with nothing in it, so the user is left staring
                    // at a blank desktop they have to swipe out of manually —
                    // the classic hide-on-close bug (tao's hide path does no
                    // fullscreen handling of its own; it goes straight to
                    // orderOut).
                    //
                    // So: leave fullscreen FIRST, and hide only once AppKit has
                    // finished the transition and torn the Space down. The
                    // transition is animated and asynchronous, so this polls off
                    // the event thread instead of blocking it. Window handles
                    // are Send + clonable, hence the move into the thread.
                    if window.is_fullscreen().unwrap_or(false) {
                        log_to_file("[window] main close intercepted while fullscreen — exiting fullscreen before hide");
                        let _ = window.set_fullscreen(false);
                        let w = window.clone();
                        std::thread::spawn(move || {
                            // ~2s cap: if the transition never reports done we
                            // still hide, because leaving the window on screen
                            // after the user clicked close is the worse outcome.
                            for _ in 0..20 {
                                std::thread::sleep(std::time::Duration::from_millis(100));
                                if !w.is_fullscreen().unwrap_or(false) {
                                    break;
                                }
                            }
                            let _ = w.hide();
                            log_to_file("[window] main hidden to tray after fullscreen exit");
                        });
                        return;
                    }

                    let _ = window.hide();
                    log_to_file("[window] main close intercepted — hidden to tray");
                    return;
                }
            }

            // If the window that OWNS the active recording is torn down, clear
            // the recording state so a relaunched/reloaded window isn't rejected
            // by start_recording's ownership guard with stale state (the resume
            // dead-transcript bug). Best-effort + try_lock inside the helper, so
            // it can't block the event thread. Destroyed is the authoritative
            // teardown signal; CloseRequested is belt-and-suspenders — and by
            // this point a CloseRequested is guaranteed to be one that will
            // actually proceed (non-main, or main with close-to-tray off),
            // because the hide path above already returned.
            if matches!(
                event,
                tauri::WindowEvent::Destroyed | tauri::WindowEvent::CloseRequested { .. }
            ) {
                use tauri::Manager;
                let state = window.state::<AppState>();
                let is_owner = state
                    .recording_window
                    .try_lock()
                    .map(|g| g.as_deref() == Some(window.label()))
                    .unwrap_or(false);
                if is_owner {
                    log_to_file(&format!(
                        "[window] recording-owner window '{}' closing — clearing recording state",
                        window.label()
                    ));
                    commands::recording::reset_recording_state(&state);
                }
            }

            // Drop this window's notification-click listener registration.
            // A window can be closed and later RECREATED with the SAME label
            // (a workspace popout being reopened, "main" after a close-to-tray
            // + reopen). Without this, the new window inherits the old one's
            // "listener ready" flag, so a click arriving before its JS has
            // re-registered is emitted into the void instead of being buffered
            // and flushed on notification_click_listener_ready.
            //
            // Destroyed ONLY, deliberately: CloseRequested can be cancelled, and
            // deregistering there would strand a still-live listener.
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if window.label() == "agent-hud" {
                    commands::hud::on_agent_hud_destroyed(window.app_handle());
                }
                crate::notifications::forget_window(window.label());
                // A recreated window starts opaque until its page asks again.
                window_backdrop::forget(window.label());
                {
                    use tauri::Manager;
                    modules::tts::cancel_for_page(window.app_handle(), window.label());
                    voice::end_for_page(window.app_handle(), window.label());
                }
                #[cfg(target_os = "macos")]
                forget_focus_nudge(window.label());
                // Same recreate-with-the-same-label hazard, one level nastier:
                // the watchdog's registry is keyed by the raw WKWebView pointer,
                // and a freed address gets recycled by malloc. A handler left
                // behind by a destroyed window would fire for whatever webview
                // lands on that address next, reloading the wrong window. This
                // also clears the window's reload budget so a reopened popout
                // starts with a fresh MAX_RELOADS.
                #[cfg(target_os = "macos")]
                crate::native::webcontent_watchdog::forget_window(window.label());
            }

            // A shortcut being recorded for this window stops when it loses
            // focus or goes away: the recorder's tap sees every key on the
            // Mac (read_selection.rs).
            if matches!(event, tauri::WindowEvent::Focused(false) | tauri::WindowEvent::Destroyed) {
                crate::read_selection::on_window_blurred(window.app_handle(), window.label());
            }

            // After wake-from-sleep / refocus, the macOS WKWebView surface can
            // stay blank until something forces it to re-composite. Nudge the
            // window size by 1px on focus to trigger a repaint, then restore it.
            //
            // RATE-LIMITED PER WINDOW (see should_nudge_repaint): the two
            // set_size calls force a synchronous full-dashboard relayout +
            // repaint, and with two workspace windows open the user switches
            // focus constantly, paying that cost on every switch. The blank
            // surface only happens after the window has been away long enough
            // for macOS to drop its backing, so skipping the nudge for a window
            // focused in the last FOCUS_NUDGE_MIN_GAP cannot reintroduce it.
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::Focused(true) = event {
                if should_nudge_repaint(window.label()) {
                    if let Ok(size) = window.inner_size() {
                        let bumped = tauri::PhysicalSize::new(size.width, size.height + 1);
                        let _ = window.set_size(bumped);
                        let _ = window.set_size(size);
                    }
                }
            }

            // Surface the MAIN window's focus state to the web app as
            // `main-focus-changed` (bool = focused). This is the reliable
            // "user switched away from Native Intelligence" signal for the live-agent HUD:
            // unlike the page Visibility API, WindowEvent::Focused fires on a
            // plain cmd-tab to another app even when Native Intelligence stays partially on
            // screen (the common case when the user is on their video call).
            //
            // SELF-FOCUS GUARD: focus handed to one of OUR OWN windows (the
            // agent HUD, meeting HUD, or a workspace popout) is NOT the user
            // leaving Native Intelligence — e.g. dragging the draggable HUD steals key status
            // from `main`. On a main-blur we consult the app's currently-focused
            // window and suppress the "backgrounded" report if it's one of ours,
            // so the HUD doesn't treat interacting with itself as a background.
            if let tauri::WindowEvent::Focused(focused) = event {
                use tauri::Manager;
                if window.label() == "main" {
                    let app = window.app_handle();
                    if *focused {
                        let _ = app.emit("main-focus-changed", true);
                    } else {
                        let to_own_window = app
                            .webview_windows()
                            .iter()
                            .any(|(label, w)| {
                                label != "main"
                                    && w.is_focused().unwrap_or(false)
                            });
                        if !to_own_window {
                            let _ = app.emit("main-focus-changed", false);
                        }
                    }
                }
            }

            // PER-WINDOW focus, additive to `main-focus-changed` above. That
            // event is the HUD relay: broadcast, main-only, and deliberately
            // silent on popout transitions — a workspace window therefore has no
            // way to learn whether IT is the focused one, which is what the web
            // app needs to stop per-window work (e.g. the PixelCanvas) in
            // windows the user isn't looking at.
            //
            // Emitted with the SAME bool payload, but targeted at the window's
            // own label so a window only ever hears about itself, and for EVERY
            // dashboard webview (main + workspace popouts). HUDs are skipped:
            // they run their own UI and listen for none of this.
            //
            // Old web bundles never listen for `window-focus-changed`, so the
            // extra emit is inert against them.
            if let tauri::WindowEvent::Focused(focused) = event {
                let label = window.label();
                if is_dashboard_label(label) {
                    let _ = window.emit_to(
                        EventTarget::labeled(label),
                        "window-focus-changed",
                        *focused,
                    );
                }
            }

            // Re-apply the appearance-matched window background when the system
            // switches between light and dark, so the live-resize gap keeps
            // matching the (OS-following) web app theme.
            //
            // GUARD BY LABEL: apply_window_background sets window.opaque = YES +
            // an opaque near-white (light) / near-black (dark) fill. That's right
            // for the OPAQUE main window, but it's exactly what put a white square
            // behind the TRANSPARENT floating HUDs on every theme switch — the
            // opaque backing showed through their translucent glass cards. For the
            // transparent HUDs, re-assert a CLEAR backing instead of opaquing it.
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::ThemeChanged(_) = event {
                if let Ok(ns_window) = window.ns_window() {
                    match window.label() {
                        label if is_hud_label(label) => clear_window_background(ns_window),
                        // A window on Glass (window_backdrop.rs) stays
                        // see-through: re-assert that instead of opaquing it.
                        label if window_backdrop::reapply(label, ns_window) => {}
                        _ => apply_window_background(ns_window),
                    }
                }
            }

            // AppKit re-lays-out the title bar on resize (and the fullscreen /
            // zoom transitions that go through it), resetting the traffic-light
            // frames to the system size + position. Re-assert our custom size
            // and centering. The native call is idempotent and no-ops when the
            // frames already match, so this is cheap on every resize tick.
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::Resized(_) = event {
                if let Ok(ns_window) = window.ns_window() {
                    style_traffic_lights(ns_window);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_update::app_update_check,
            app_update::app_update_install,
            app_update::app_update_apply,
            browser_exit::browser_exit_start,
            browser_exit::browser_exit_stop,
            browser_exit::browser_exit_status,
            commands::recording::list_input_devices,
            commands::recording::set_input_priority,
            commands::recording::reset_input_priority,
            commands::recording::forget_input_device,
            commands::recording::set_input_override,
            commands::recording::start_recording,
            commands::recording::stop_recording,
            commands::recording::pause_recording,
            commands::recording::resume_recording,
            commands::recording::recover_mic,
            commands::recording::get_recording_status,
            commands::recording::get_audio_levels,
            commands::recording::get_audio_preferences,
            commands::recording::check_mic_permission,
            commands::recording::request_mic_permission,
            commands::recording::request_speech_permission,
            commands::recording::request_screen_capture_permission,
            commands::recording::check_system_audio_permission,
            commands::recording::request_system_audio_permission,
            commands::recording::get_audio_health,
            commands::recording::restart_core_audio,
            commands::recording::get_mic_mode,
            commands::recording::open_mic_mode_picker,
            commands::recording::enable_meeting_detection,
            commands::recording::set_auto_record,
            commands::recording::get_echo_cancellation_in_captures,
            commands::recording::set_echo_cancellation_in_captures,
            commands::recording::dismiss_meeting_detection,
            commands::recording::get_meeting_detection_state,
            commands::hud::hide_meeting_hud,
            commands::hud::get_cached_calendar_events,
            commands::hud::request_capture_from_hud,
            commands::hud::resize_meeting_hud,
            commands::hud::hud_link_event,
            commands::hud::is_cursor_over_hud,
            commands::hud::show_agent_hud,
            commands::hud::ensure_agent_hud,
            commands::hud::hide_agent_hud,
            commands::hud::hide_agent_hud_transient,
            commands::hud::push_agent_nudge,
            commands::hud::agent_hud_ready,
            commands::hud::set_agent_hud_capture_visible,
            commands::hud::get_agent_hud_capture_visible,
            // Retired overlay: no-op stubs for web builds that still call them.
            commands::desktop_bots::desktop_bots_status,
            commands::desktop_bots::hide_desktop_bots,
            commands::tray::set_auth_token,
            commands::calendar::request_calendar_access,
            commands::calendar::get_local_calendar_status,
            commands::calendar::get_local_exchange_events,
            commands::calendar::create_local_exchange_event,
            commands::calendar::update_local_exchange_event,
            commands::calendar::delete_local_exchange_event,
            commands::files::save_file,
            commands::workspace_window::open_workspace_window,
            commands::notifications::show_native_notification,
            commands::notifications::notification_permission_state,
            commands::notifications::request_notification_permission,
            commands::notifications::notification_click_listener_ready,
            commands::notifications::notification_click_listener_gone,
            commands::notifications::remove_delivered_notification,
            commands::window::get_close_to_tray,
            commands::window::set_close_to_tray,
            commands::window::focus_own_window,
            window_backdrop::set_window_backdrop,
            commands::auth_session::auth_web_session_cmd,
            modules::commands::modules_list,
            modules::commands::module_enable,
            modules::commands::module_disable,
            modules::commands::module_remove_assets,
            modules::commands::module_log_tail,
            commands::system::system_info,
            commands::system::presence_state,
            modules::tts::tts_speak,
            modules::tts::tts_cancel,
            modules::tts::tts_prepare,
            modules::tts::tts_voices,
            modules::tts::tts_rate,
            modules::tts::tts_set_rate,
            dictate::dictate_panel_size,
            dictate::dictate_paste,
            dictate::dictate_phase,
            dictate::dictate_set_enabled,
            dictate::dictate_state,
            dictate::dictate_flash,
            dictate::dictate_watch_pointer,
            dictate::dictate_status,
            dictate::talk_send,
            dictate::talk_state,
            read_selection::read_selection_cancel_record,
            read_selection::read_selection_open_accessibility_settings,
            read_selection::read_selection_record_hotkey,
            read_selection::read_selection_relaunch,
            read_selection::read_selection_request_access,
            read_selection::read_selection_sentences,
            read_selection::read_selection_set_enabled,
            read_selection::read_selection_set_hotkey,
            read_selection::read_selection_set_voice,
            read_selection::read_selection_status,
            voice::commands::voice_status,
            voice::commands::voice_start,
            voice::commands::voice_stop,
            voice::commands::voice_cancel,
            voice::commands::voice_set_muted,
            voice::commands::voice_set_aside,
            voice::commands::voice_set_barge,
            voice::commands::voice_log,
            local_agent::commands::local_agent_device,
            local_agent::commands::local_agent_status,
            local_agent::commands::local_agent_pick_folder,
            local_agent::commands::local_agent_remove_grant,
            local_agent::commands::local_agent_start,
            local_agent::commands::local_agent_send,
            local_agent::commands::local_agent_stop,
            local_agent::commands::local_agent_resume,
            local_agent::commands::local_agent_events,
            local_agent::commands::local_agent_set_model_token,
        ])
        .setup(|app| {
            log_to_file("[setup] starting");

            // Local modules: load their persisted on/off settings and bring
            // enabled ones back to ready (or resume an interrupted download).
            app.state::<modules::ModuleManager>().init(app.handle());
            // Read-aloud (local-tts): an idle actor until the first
            // tts_speak / tts_prepare starts its sidecar.
            let tts = modules::tts::TtsService::spawn(app.handle().clone());
            tts.set_rate(crate::settings::tts_rate(app.handle()));
            app.manage(tts);
            // Chat voice (dictation + voice mode): idle until voice_start.
            app.manage(voice::VoiceService::new(app.handle().clone()));
            // Local agents (macOS): an idle actor; it marks jobs the last
            // run left live as interrupted, then waits for commands.
            app.manage(local_agent::LocalAgentService::spawn(app.handle().clone()));
            app.manage(browser_exit::BrowserExitService::default());

            // Opt out of macOS App Nap for the process lifetime. Without this,
            // macOS suspends the backgrounded WebView (pausing timers, realtime
            // sockets, and the render loop), which makes the app freeze and then
            // spend minutes "catching up" when brought back to the foreground.
            // This does NOT keep the system awake (see sleep_guard.rs for that).
            #[cfg(target_os = "macos")]
            {
                let ok = unsafe { app_nap_disable() };
                log_to_file(&format!("[setup] app_nap_disable -> {}", ok));
            }

            // Observe system sleep/wake (main thread, before any capture can
            // start). The mic capture stamps each stream with the sleep/wake
            // epoch and never reuses a paused stream across a sleep — CoreAudio
            // hands those back "playable" but dead (the overnight dead-mic bug).
            crate::power::install();

            // Read selection aloud: the system-wide hotkey, when the user has
            // turned it on (main thread, after the TtsService above).
            crate::read_selection::install(app.handle());
            crate::dictate::install(app.handle());

            // Build the native notification manager and install the click
            // handler. Done EARLY and on the main thread (which macOS requires
            // for the UNUserNotificationCenter delegate): a click on a
            // notification can itself launch the app, and the delegate has to
            // exist before the OS delivers that click or it is lost. Clicks
            // arriving before the webview's JS listener is up are buffered and
            // flushed on notification_click_listener_ready.
            crate::notifications::init(app.handle());

            // URLs the OS hands the app: our own dial8desktop:// callbacks.
            // incoming_url.rs sends each to the web DeepLinkHandler
            // (`deep-link-auth`) and drops anything else.
            #[cfg(desktop)]
            {
                match app.deep_link().get_current() {
                    Ok(Some(urls)) => {
                        log_to_file(&format!("[setup] launched with {} URL(s)", urls.len()));
                        for url in urls {
                            crate::incoming_url::route(app.handle(), url.as_str(), "launch");
                        }
                    }
                    _ => log_to_file("[setup] no launch URLs"),
                }
            }

            // Listen for deep-link events that arrive while app is running
            let handle = app.handle().clone();
            app.listen("deep-link://new-url", move |event| {
                for url in crate::incoming_url::parse_new_url_payload(event.payload()) {
                    crate::incoming_url::route(&handle, &url, "deep-link");
                }
            });

            // Meeting detection, the audio-health probe and the input-device
            // watcher below all start CoreAudio, and each waits for this gate
            // on its own thread: until the main window has painted, or 30 s.
            // Starting CoreAudio sets off a Mac-wide mic-mode re-sync that
            // freezes WebKit's GPU process if it's starting at the same time,
            // and the window stays black (audio::launch_gate).
            crate::audio::launch_gate::arm();

            // Load persisted settings and apply to meeting detector
            let saved = crate::settings::AppSettings::load(app.handle());
            {
                let state = app.state::<AppState>();
                // Seed the close-to-tray cache the CloseRequested handler reads.
                // It runs on the event thread and can't touch the store, so this
                // is the only point where persisted → in-memory happens (the
                // setter command keeps both in sync from here on).
                state.close_to_tray_enabled.store(
                    saved.close_to_tray_enabled,
                    std::sync::atomic::Ordering::Relaxed,
                );
                let mut detector = state.meeting_detector.lock().unwrap();
                detector.set_enabled(saved.meeting_detection_enabled);
                detector.set_auto_record(saved.auto_record);
                detector.start_polling(app.handle().clone());
                log_to_file(&format!(
                    "[setup] meeting detection started (enabled={}, auto_record={})",
                    saved.meeting_detection_enabled, saved.auto_record
                ));
            }

            // Is coreaudiod answering? It can deadlock (an Apple bug), and then
            // every CoreAudio call blocks forever: probe it on a thread of its
            // own and tell the windows (audio://health). Setup itself must
            // never call CoreAudio: a stuck call here means no window at all.
            crate::audio::health::start(app.handle().clone());

            // Old capture recordings in the temp dir (audio/recordings.rs):
            // keep the latest few, remove the rest. Its own thread, files only.
            crate::audio::recordings::prune_in_background("launch");

            // Input Device Priority: the CoreAudio device-list watcher and the
            // supervisor (records seen mics, emits
            // audio://input-devices-changed, flags a vanished in-use mic,
            // switches a live capture or voice session up the list, watches
            // the lid and digital silence). After the settings
            // load above, which migrates the store. The mic lock is taken
            // alone, once, for its handles.
            {
                let state = app.state::<AppState>();
                let (in_use, fault) = {
                    let mic = state.mic_capture.lock().unwrap();
                    (mic.in_use_handle(), mic.fault_handle())
                };
                crate::audio::input_devices::start_supervisor(app.handle(), in_use, fault);
            }

            // Set up system tray (menu bar icon with calendar dropdown)
            if let Err(e) = crate::tray::setup_tray(app) {
                log_to_file(&format!("[setup] tray setup failed: {}", e));
            }
            crate::tray::start_calendar_polling(app.handle().clone());

            // Focus existing window if present
            if let Some(window) = app.get_webview_window("main") {
                // tauri.conf.json's empty title suits the Mac's overlay title
                // bar; Windows shows a native one, and the window's name in
                // Alt-Tab and the taskbar.
                #[cfg(not(target_os = "macos"))]
                let _ = window.set_title("Native Intelligence");
                // Point the main window at the right frontend. A *built* debug
                // bundle (what dev.sh produces) does NOT honor tauri.conf.json's
                // `devUrl` — that only applies under `tauri dev` — so the window
                // loads `frontendDist` (production dial8.ai) even in debug. The
                // tray + secondary windows already switch on `debug_assertions`
                // via `api_base_url()`; do the same for the main window so a
                // local debug build loads the dev server instead of prod.
                #[cfg(debug_assertions)]
                {
                    let dev_url = crate::tray::api_base_url(); // http://localhost:3000
                    match window.url() {
                        Ok(current) if current.as_str().starts_with(dev_url) => {
                            // Already on dev (e.g. running under `tauri dev`).
                        }
                        _ => {
                            if let Ok(parsed) = dev_url.parse() {
                                if let Err(e) = window.navigate(parsed) {
                                    log_to_file(&format!(
                                        "[setup] failed to navigate main window to dev URL: {}",
                                        e
                                    ));
                                }
                            }
                        }
                    }
                }

                let _ = window.set_focus();
                // Paint the native window background to match the app theme so
                // live-resize doesn't flash empty space before the WebView
                // repaints into the newly exposed area, and make the WebView
                // layer track the window frame synchronously on maximize/zoom.
                #[cfg(target_os = "macos")]
                if let Ok(ns_window) = window.ns_window() {
                    apply_window_background(ns_window);
                    sync_webview_resize(ns_window);
                    // Make maximize/zoom an instant jump so the WebView lays out
                    // once instead of trailing an animated grow.
                    disable_zoom_animation(ns_window);
                    // Shrink + vertically center the traffic lights to line up
                    // with the web tab-bar buttons.
                    style_traffic_lights(ns_window);
                }

                // Recover from a WebContent (renderer) process kill. Nothing
                // else in the app observes that — the NSWindow survives with a
                // blank surface — and the 948 MB/7 h heap growth measured in
                // this window makes a jetsam OOM kill a real outcome, not a
                // theoretical one. `main` only; HUD windows are deliberately
                // excluded (transient overlays, recreatable, no state to save).
                #[cfg(target_os = "macos")]
                crate::native::webcontent_watchdog::install_default_recovery(&window);
            }

            // The retired in-app browser's per-workspace data stores (its sign-ins):
            // nothing opens or deletes them any more (native/retired_browser_stores.rs).
            #[cfg(target_os = "macos")]
            crate::native::retired_browser_stores::remove_all();

            // The automation bridge (automation/mod.rs): inert unless launched
            // with DIAL8_AUTOMATION_PORT and DIAL8_AUTOMATION_TOKEN, and not in
            // a release build at all. After the main window's own setup, since
            // it loads that window again.
            #[cfg(any(debug_assertions, feature = "automation-bridge"))]
            crate::automation::start(app.handle());

            log_to_file("[setup] done");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Native Intelligence desktop application")
        .run(|app_handle, event| {
            // On app exit, finalize recording, release the voice mic, stop
            // the read-aloud sidecar and the local agents before the process
            // goes away (quit.rs). From BOTH arms below, run once: Cmd+Q
            // raises only `Exit`, the tray's Quit and request_restart() raise
            // `ExitRequested`, then `Exit`.
            //
            // ⚠️ DO NOT ADD api.prevent_exit() HERE — not for close-to-tray, not
            // for anything. ExitRequested is the funnel for the tray's "Quit
            // Native Intelligence" (app.exit(0)), request_restart() and the last window
            // closing. They arrive as the same variant and are NOT
            // distinguishable here — the `code` field only separates
            // user-interaction (None) from programmatic (Some(_)) exits. A
            // prevent_exit() added here to "stop the window close from
            // quitting the app" would swallow tray Quit and relaunch too, and
            // leave the user with an app they cannot quit from the tray. (Cmd+Q
            // never comes here: by its `Exit`, AppKit is already terminating.)
            //
            // Close-to-tray is intercepted ONLY in the on_window_event
            // CloseRequested arm above, gated to the "main" label, where the
            // event genuinely is a window close and nothing else.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                quit::run(app_handle, "ExitRequested");
            }

            // Cmd+Q never reaches the ExitRequested arm above: the default
            // menu's Quit sends `terminate:`, and tao answers
            // applicationWillTerminate with LoopDestroyed, which Tauri hands us
            // as RunEvent::Exit, the last event before AppKit ends the process.
            // After a tray Quit this is the second call, which returns at once.
            if let tauri::RunEvent::Exit = event {
                quit::run(app_handle, "Exit");
            }

            // Dock-icon click (NSApplicationDelegate's
            // applicationShouldHandleReopen:hasVisibleWindows:). Without this,
            // a main window hidden by close-to-tray has no Dock affordance to
            // come back from — clicking the icon would just no-op.
            //
            // Decide on MAIN'S OWN visibility, NOT has_visible_windows. AppKit
            // counts every visible NSWindow in the process, and this app floats
            // borderless HUDs (meeting-hud / agent-hud) that are very much
            // visible windows. During a meeting, has_visible_windows is true
            // even though main is hidden — gating on it would make the Dock
            // click a no-op exactly when the user most needs it back. The flag
            // is kept only for the log line.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = event
            {
                use tauri::Manager;
                if let Some(main) = app_handle.get_webview_window("main") {
                    // is_visible() erring means we can't confirm it's on screen;
                    // restoring is the safe reading of a Dock click.
                    if !main.is_visible().unwrap_or(false) {
                        log_to_file(&format!(
                            "[reopen] dock click, main hidden (has_visible_windows={}) — restoring",
                            has_visible_windows
                        ));
                        crate::tray::focus_main_window(app_handle);
                    }
                }
            }
        });
}
