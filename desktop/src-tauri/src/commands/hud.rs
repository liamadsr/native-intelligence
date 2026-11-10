use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri::utils::config::BackgroundThrottlingPolicy;

use crate::meeting_detection::mlog;
use crate::state::{AppState, CalendarEvent};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingHudData {
    pub display_name: String,
    pub bundle_id: String,
    pub is_auto_record: bool,
}

/// Show the floating meeting detection HUD window.
/// Called from Rust (meeting_detection.rs) — not typically invoked from frontend.
pub fn show_hud(app: &AppHandle, display_name: &str, bundle_id: &str, is_auto_record: bool) {
    let data = MeetingHudData {
        display_name: display_name.to_string(),
        bundle_id: bundle_id.to_string(),
        is_auto_record,
    };

    // If window already exists, just show it and send updated data
    if let Some(window) = app.get_webview_window("meeting-hud") {
        mlog("HUD window exists, showing and emitting data");
        let _ = window.show();
        let _ = app.emit("meeting-hud-data", &data);
        return;
    }

    mlog("Creating new HUD window");

    // Get screen dimensions for positioning
    let (x, y) = if let Some(window) = app.get_webview_window("main") {
        if let Ok(monitor) = window.current_monitor() {
            if let Some(monitor) = monitor {
                let size = monitor.size();
                let position = monitor.position();
                let scale = monitor.scale_factor();
                // Top-right corner with 20px padding (in logical pixels)
                let logical_w = size.width as f64 / scale;
                let x = position.x as f64 / scale + logical_w - 400.0;
                let y = position.y as f64 / scale + 40.0;
                (x, y)
            } else {
                (1100.0, 40.0)
            }
        } else {
            (1100.0, 40.0)
        }
    } else {
        (1100.0, 40.0)
    };

    // Load the HUD from the same origin as the main window so it works in
    // both dev (localhost) and production (dial8.ai). Falls back to the
    // compile-time default when the main window URL isn't readable.
    let origin = app
        .get_webview_window("main")
        .and_then(|w| w.url().ok())
        .map(|u| u.origin().ascii_serialization())
        .filter(|o| o.starts_with("http"))
        .unwrap_or_else(|| crate::tray::api_base_url().to_string());

    let hud_url = format!("{}/hud/meeting-detected", origin);
    let url = match hud_url.parse() {
        Ok(parsed) => WebviewUrl::External(parsed),
        Err(e) => {
            mlog(&format!("Invalid HUD URL {:?}: {}", hud_url, e));
            return;
        }
    };

    match WebviewWindowBuilder::new(app, "meeting-hud", url)
        // Windows: never activated by showing or clicking (WS_EX_NOACTIVATE),
        // so the prompt never pulls focus from the call. (macOS: a panel.)
        .focusable(!cfg!(target_os = "windows"))
        .title("")
        .inner_size(380.0, 86.0)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .shadow(false)
        .visible_on_all_workspaces(true)
        // Keep the HUD's JS/timers alive while it (or the main window) is
        // occluded by another app — the HUD exists FOR the backgrounded case
        // (user in a video-call window), and without this macOS suspends the
        // WebContent process after occlusion, freezing the nudge listener and
        // the type-out render even though Rust delivered the event. Every
        // other programmatic window already sets this (workspace_window.rs);
        // omitting it here was an oversight. (macOS 14+/iOS 17+.)
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .build()
    {
        Ok(_) => {
            mlog("HUD window created successfully");
            // Emit data after a short delay to let the page load
            let app_clone = app.clone();
            std::thread::spawn(move || {
                // Wait for Next.js page to load and hydrate
                std::thread::sleep(std::time::Duration::from_millis(1500));
                // The user may have disabled detection (or a call-end may
                // have reset it) during the delay — showing the HUD then
                // would offer a capture from a pipeline that is off, with
                // nothing left running to ever dismiss it.
                let still_wanted = {
                    let state = app_clone.state::<crate::state::AppState>();
                    let detector = state.meeting_detector.lock().unwrap();
                    let status = detector.status();
                    status.is_enabled
                        && matches!(
                            status.state,
                            crate::meeting_detection::MeetingDetectionState::Detected
                                | crate::meeting_detection::MeetingDetectionState::Recording
                        )
                };
                if !still_wanted {
                    mlog("HUD show aborted — detection no longer active");
                    if let Some(window) = app_clone.get_webview_window("meeting-hud") {
                        let _ = window.close();
                    }
                    return;
                }
                if let Some(window) = app_clone.get_webview_window("meeting-hud") {
                    let _ = app_clone.emit("meeting-hud-data", &data);
                    // Small extra delay for the event to be processed
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    let _ = window.show();
                    mlog("HUD window shown with data");
                }
            });
        }
        Err(e) => {
            mlog(&format!("Failed to create HUD window: {}", e));
        }
    }
}

/// Hide the floating meeting detection HUD window.
pub fn hide_hud(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("meeting-hud") {
        mlog("Hiding HUD window");
        let _ = window.close();
    }
}

/// IPC command to hide the HUD from the frontend.
#[tauri::command]
pub fn hide_meeting_hud(app: AppHandle) {
    hide_hud(&app);
}

/// Return the tray's cached calendar events for today.
#[tauri::command]
pub fn get_cached_calendar_events(state: State<'_, AppState>) -> Vec<CalendarEvent> {
    let cache = state.calendar_cache.lock().unwrap();
    cache.today_events.clone()
}

/// Request capture start from the HUD window.
/// If an event is provided, emits `start-capture-from-event` (same as tray "Start Capture").
/// If no event, emits `start-capture-from-hud` with null for a plain capture.
#[tauri::command]
pub fn request_capture_from_hud(app: AppHandle, event: Option<CalendarEvent>) {
    mlog(&format!("HUD requesting capture, event: {:?}", event.as_ref().map(|e| &e.title)));
    if let Some(ref evt) = event {
        // Reuse the exact same event the tray uses — proven to work
        let _ = app.emit("start-capture-from-event", evt);
    } else {
        let _ = app.emit("start-capture-from-hud", Option::<CalendarEvent>::None);
    }
}

/// Resize the HUD window (called from JS when dropdown opens/closes).
#[tauri::command]
pub fn resize_meeting_hud(app: AppHandle, width: f64, height: f64) {
    if let Some(window) = app.get_webview_window("meeting-hud") {
        let _ = window.set_size(LogicalSize::new(width, height));
    }
}

/// Update the linked calendar event on the active capture.
/// Emits `hud-link-event` so the main window can PATCH the running capture.
#[tauri::command]
pub fn hud_link_event(app: AppHandle, event: Option<CalendarEvent>) {
    mlog(&format!("HUD link event: {:?}", event.as_ref().map(|e| &e.title)));
    let _ = app.emit("hud-link-event", &event);
}

// ───────────────────────────── Agent HUD ──────────────────────────────────
// A second floating window, separate from the meeting-detection HUD: the live
// agent's "talk back" display. While a live meeting runs with the agent on, the
// agent can call its say_to_user tool; each message is relayed to this window
// (push_agent_nudge) and typed out. It's draggable (data-tauri-drag-region in
// the page), always-on-top, and follows the user across spaces — a discreet
// heads-up display they can park anywhere.

/// One agent message forwarded to the HUD. Mirrors the web AgentNudge shape
/// (the relay hook passes the broadcast payload straight through).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentNudgePayload {
    pub id: String,
    pub message: String,
    pub kind: String,
    pub capture_id: String,
    pub ts: f64,
}

/// Buffer for nudges that arrive before the HUD page has loaded + registered its
/// `agent-nudge` listener. The window is created `visible(false)` and shown after
/// a delay, and the page then polls for `window.__TAURI__` before subscribing —
/// so a `say_to_user` in the first second or two of a meeting would otherwise be
/// emitted into a window with no listener and lost (Tauri events aren't buffered,
/// and the page has no replay). We hold those here until the page calls
/// `agent_hud_ready`, then flush them in order. Bounded so a HUD that never
/// becomes ready can't grow this unbounded.
static AGENT_NUDGE_BUFFER: std::sync::Mutex<Vec<AgentNudgePayload>> =
    std::sync::Mutex::new(Vec::new());
/// Whether the HUD page has signaled it's listening. Until true, nudges buffer.
static AGENT_HUD_READY: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
const AGENT_NUDGE_BUFFER_MAX: usize = 50;

/// Whether the agent HUD shows in screen sharing and recordings (the eye in the
/// HUD's top-left). Closed (false) is the default: the window is built
/// content-protected, so the people on a call never see the user's nudges.
/// Open (true) is for demoing the app. Reset to hidden on every fresh window
/// (every new meeting); a hide→show of the same window keeps the choice.
static AGENT_HUD_CAPTURE_VISIBLE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// A fresh HUD window starts hidden from capture.
fn reset_agent_hud_capture_visible() {
    AGENT_HUD_CAPTURE_VISIBLE.store(false, std::sync::atomic::Ordering::SeqCst);
}

/// Record the capture visibility the window now has; returns it.
fn record_agent_hud_capture_visible(visible: bool) -> bool {
    AGENT_HUD_CAPTURE_VISIBLE.store(visible, std::sync::atomic::Ordering::SeqCst);
    visible
}

fn agent_hud_capture_visible() -> bool {
    AGENT_HUD_CAPTURE_VISIBLE.load(std::sync::atomic::Ordering::SeqCst)
}

/// The agent HUD's window between hide_agent_hud and the window really going
/// (on_agent_hud_destroyed). Destroying a window only queues it: the window
/// stays registered until AppKit tears it down, so a show in that gap (one
/// meeting's end, then the next one's start) used to find the dying window,
/// "show" it, and leave nothing once it went.
struct AgentHudLifecycle {
    /// The window hide_agent_hud destroyed and that hasn't gone yet.
    closing: Option<ClosingWindow>,
    /// A show or ensure that came in meanwhile: the HUD to build once the
    /// window is gone. The latest call's, capture and all.
    recreate: Option<PendingRecreate>,
    /// Bumped by every hide_agent_hud: a recreate taken before one (and not
    /// yet built) is for a meeting that has ended, and is dropped.
    hides: u64,
}

#[derive(Debug, Clone, Copy)]
struct ClosingWindow {
    since: std::time::Instant,
    /// It outlived AGENT_HUD_CLOSE_GRACE, so the HUD stopped waiting for it
    /// and is using it as a live window again.
    kept: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingRecreate {
    reason: String,
    capture_id: Option<String>,
}

static AGENT_HUD_LIFECYCLE: std::sync::Mutex<AgentHudLifecycle> =
    std::sync::Mutex::new(AgentHudLifecycle { closing: None, recreate: None, hides: 0 });

fn agent_hud_lifecycle() -> std::sync::MutexGuard<'static, AgentHudLifecycle> {
    AGENT_HUD_LIFECYCLE.lock().unwrap_or_else(|e| e.into_inner())
}

/// A destroyed window still there this long after is not going: the next
/// ensure stops waiting and brings it back rather than leave no HUD.
const AGENT_HUD_CLOSE_GRACE: std::time::Duration = std::time::Duration::from_secs(3);

fn close_is_stuck(since: std::time::Instant, now: std::time::Instant) -> bool {
    now.saturating_duration_since(since) >= AGENT_HUD_CLOSE_GRACE
}

/// Bumped for each window built, so a delayed first show only shows its own.
static AGENT_HUD_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// The generation of a freshly built window still waiting for its delayed
/// first show (0: none). Until then an ensure must not count it as hidden.
static AGENT_HUD_SHOW_PENDING: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Claim window `generation`'s first show. False if that window is gone or a
/// newer one replaced it (whose own thread shows it).
fn take_first_show(generation: u64) -> bool {
    use std::sync::atomic::Ordering;
    AGENT_HUD_SHOW_PENDING
        .compare_exchange(generation, 0, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

/// The agent HUD's window as ensure_agent_hud finds it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentHudPresence {
    /// No window.
    Missing,
    /// A window that hide_agent_hud destroyed and that is still going.
    Closing,
    /// A live window.
    Present { visible: bool, minimized: bool, on_screen: bool, show_pending: bool },
}

/// What ensure_agent_hud does about it, and what it reports back (`as_str`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentHudPlan {
    /// Build the window.
    Create,
    /// Build a new window once the closing one is gone.
    RecreateAfterClose,
    /// Bring a live window back: un-minimize, show, move back on screen.
    Restore { unminimize: bool, show: bool, reposition: bool },
    /// It's up: only re-assert it floats above everything.
    Keep,
}

impl AgentHudPlan {
    fn as_str(self) -> &'static str {
        match self {
            AgentHudPlan::Create => "created",
            AgentHudPlan::RecreateAfterClose => "recreating",
            AgentHudPlan::Restore { .. } => "restored",
            AgentHudPlan::Keep => "visible",
        }
    }
}

fn plan_agent_hud(presence: AgentHudPresence) -> AgentHudPlan {
    match presence {
        AgentHudPresence::Missing => AgentHudPlan::Create,
        AgentHudPresence::Closing => AgentHudPlan::RecreateAfterClose,
        AgentHudPresence::Present { visible, minimized, on_screen, show_pending } => {
            // A window still waiting for its first show is on its way up.
            let show = !visible && !show_pending;
            if !minimized && !show && on_screen {
                AgentHudPlan::Keep
            } else {
                AgentHudPlan::Restore { unminimize: minimized, show, reposition: !on_screen }
            }
        }
    }
}

/// Whether the window's centre lies on one of the monitors. Physical pixels,
/// (x, y, width, height). A window left on a display that has since gone (or
/// dragged almost entirely off one) is "off screen".
fn center_on_any_monitor(window: (i32, i32, u32, u32), monitors: &[(i32, i32, u32, u32)]) -> bool {
    let cx = window.0 as i64 + window.2 as i64 / 2;
    let cy = window.1 as i64 + window.3 as i64 / 2;
    monitors.iter().any(|&(x, y, w, h)| {
        let (x, y) = (x as i64, y as i64);
        cx >= x && cx < x + w as i64 && cy >= y && cy < y + h as i64
    })
}

/// The agent HUD's fixed size, in logical pixels. The window never resizes;
/// messages scroll inside the HUD's #list (see /hud/agent). The card is the
/// size of the capture's card in the app (456 wide, about 520 tall on a usual
/// window) plus the page's 8px margin round it: room for a few nudges, the
/// transcript line and the box to message the live agent.
const AGENT_HUD_W: f64 = 472.0;
const AGENT_HUD_H: f64 = 536.0;

/// Where a new agent HUD goes, in logical pixels: bottom-right of the main
/// window's monitor, with padding (mirrors the meeting-HUD monitor math, but
/// anchored to the bottom — less in the way of a call window, and where a
/// "coaching" HUD naturally lives).
fn default_agent_hud_position(app: &AppHandle) -> (f64, f64) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(Some(monitor)) = window.current_monitor() {
            let size = monitor.size();
            let position = monitor.position();
            let scale = monitor.scale_factor();
            let logical_w = size.width as f64 / scale;
            let logical_h = size.height as f64 / scale;
            let x = position.x as f64 / scale + logical_w - AGENT_HUD_W - 24.0;
            let y = position.y as f64 / scale + logical_h - AGENT_HUD_H - 60.0;
            return (x, y);
        }
    }
    (1000.0, 600.0)
}

/// Make the HUD a non-activating panel that floats over every Space, full-screen
/// calls included (window_helper.m window_make_overlay_panel). On the main
/// thread; a no-op off macOS.
fn make_agent_hud_overlay(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let w = window.clone();
        let _ = window.run_on_main_thread(move || {
            if let Ok(ns) = w.ns_window() {
                if let Err(why) = crate::make_overlay_panel(ns) {
                    mlog(&format!("[hud] agent HUD stays a normal window: {why}"));
                }
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

/// Show the HUD without taking the keyboard. tao's show is
/// makeKeyAndOrderFront, and the HUD is a panel that can become key without
/// activating Native Intelligence, so a plain show would pull the user's typing out of their
/// call app or Native Intelligence's main window. A plain show off macOS.
fn show_agent_hud_window(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let w = window.clone();
        let _ = window.run_on_main_thread(move || {
            if let Ok(ns) = w.ns_window() {
                crate::order_front_without_focus(ns);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window.show();
}

fn agent_hud_presence(app: &AppHandle) -> AgentHudPresence {
    use std::sync::atomic::Ordering;
    let Some(window) = app.get_webview_window("agent-hud") else {
        return AgentHudPresence::Missing;
    };
    {
        let mut lifecycle = agent_hud_lifecycle();
        if let Some(closing) = lifecycle.closing.as_mut().filter(|c| !c.kept) {
            if !close_is_stuck(closing.since, std::time::Instant::now()) {
                return AgentHudPresence::Closing;
            }
            // It isn't going: use it. Its page may still be up but was told
            // it's gone (hide_agent_hud dropped the ready flag), so reload it
            // to say ready again and take nudges.
            closing.kept = true;
            lifecycle.recreate = None;
            drop(lifecycle);
            mlog("[hud] agent HUD window never went after hide_agent_hud; keeping it");
            let _ = window.reload();
        }
    }
    let on_screen = match (window.outer_position(), window.outer_size(), window.available_monitors()) {
        (Ok(pos), Ok(size), Ok(monitors)) if !monitors.is_empty() => {
            let rects: Vec<_> = monitors
                .iter()
                .map(|m| (m.position().x, m.position().y, m.size().width, m.size().height))
                .collect();
            center_on_any_monitor((pos.x, pos.y, size.width, size.height), &rects)
        }
        // Can't tell: leave it where it is.
        _ => true,
    };
    AgentHudPresence::Present {
        visible: window.is_visible().unwrap_or(true),
        minimized: window.is_minimized().unwrap_or(false),
        on_screen,
        show_pending: AGENT_HUD_SHOW_PENDING.load(Ordering::SeqCst) != 0,
    }
}

/// Make sure the agent HUD is up, whatever became of it: build it if it's
/// gone, wait out a close in flight and build it again, or bring a live window
/// back (un-minimize, show, move back on screen). A HUD that is already up is
/// left alone but for re-asserting that it floats, so this is cheap to call
/// often, and it never takes focus from a window the user is typing in.
///
/// `capture_id` is the call the HUD is for: on a fresh window, nudges buffered
/// for any other capture are dropped (a late one from the last meeting) and
/// this call's are kept (one that arrived while the window was gone). None
/// drops them all, as a new meeting's window always has.
///
/// Logs what it did unless the HUD was simply up, so the next "the HUD
/// vanished" has a trace in /tmp/native-intelligence-meeting.log.
fn ensure_agent_hud_inner(app: &AppHandle, reason: &str, capture_id: Option<&str>) -> AgentHudPlan {
    let presence = agent_hud_presence(app);
    let plan = plan_agent_hud(presence);
    match plan {
        AgentHudPlan::Keep => {
            if let Some(window) = app.get_webview_window("agent-hud") {
                let _ = window.set_always_on_top(true);
            }
        }
        AgentHudPlan::Restore { unminimize, show, reposition } => {
            mlog(&format!(
                "[hud] agent HUD restored ({reason}): minimized={unminimize} hidden={show} off_screen={reposition}"
            ));
            if let Some(window) = app.get_webview_window("agent-hud") {
                if unminimize {
                    let _ = window.unminimize();
                }
                if reposition {
                    let (x, y) = default_agent_hud_position(app);
                    let _ = window.set_position(tauri::LogicalPosition::new(x, y));
                }
                if show || unminimize {
                    show_agent_hud_window(&window);
                }
                let _ = window.set_always_on_top(true);
            }
        }
        AgentHudPlan::RecreateAfterClose => {
            // Built by on_agent_hud_destroyed once the window is gone, for the
            // latest caller; a hide_agent_hud meanwhile cancels it.
            let first = agent_hud_lifecycle()
                .recreate
                .replace(PendingRecreate { reason: reason.to_string(), capture_id: capture_id.map(str::to_string) })
                .is_none();
            if first {
                mlog(&format!("[hud] agent HUD closing; recreating once it's gone ({reason})"));
            }
        }
        AgentHudPlan::Create => {
            mlog(&format!("[hud] agent HUD missing; creating ({reason})"));
            create_agent_hud(app, capture_id);
        }
    }
    plan
}

/// Build the live-agent HUD window (ensure_agent_hud_inner's Create).
fn create_agent_hud(app: &AppHandle, capture_id: Option<&str>) {
    use std::sync::atomic::Ordering;
    // Fresh window: not ready until its page says so. Buffered nudges for
    // another capture are stale (all of them when the call isn't named), so
    // this meeting starts clean and buffers until its page is up.
    AGENT_HUD_READY.store(false, Ordering::SeqCst);
    if let Ok(mut buf) = AGENT_NUDGE_BUFFER.lock() {
        retain_nudges_for(&mut buf, capture_id);
    }
    // Every new meeting's HUD starts hidden from screen sharing (built
    // content-protected below); the eye opens it on demand.
    reset_agent_hud_capture_visible();

    let (x, y) = default_agent_hud_position(app);

    let origin = app
        .get_webview_window("main")
        .and_then(|w| w.url().ok())
        .map(|u| u.origin().ascii_serialization())
        .filter(|o| o.starts_with("http"))
        .unwrap_or_else(|| crate::tray::api_base_url().to_string());

    let hud_url = format!("{}/hud/agent", origin);
    let url = match hud_url.parse() {
        Ok(parsed) => WebviewUrl::External(parsed),
        Err(e) => {
            mlog(&format!("Invalid agent HUD URL {:?}: {}", hud_url, e));
            return;
        }
    };

    // Focusable on Windows too: its message box takes typing. A nudge's show
    // doesn't take focus from the call there either (Windows' foreground lock
    // keeps a background app's window from coming to the foreground).
    match WebviewWindowBuilder::new(app, "agent-hud", url)
        .title("")
        .inner_size(AGENT_HUD_W, AGENT_HUD_H)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        // The HUD has a box to message the live agent: the click that starts
        // typing there counts, even while the user is in their call app (no
        // first click lost to bringing the window forward).
        .accept_first_mouse(true)
        // Files dropped on the HUD (a screenshot during the call) go to the
        // page, which attaches them to the call's capture (/hud/agent's
        // HudFileDrop). Tauri's own handler would take the drop and hand the
        // page nothing; the main and workspace windows turn it off too.
        .disable_drag_drop_handler()
        .visible(false)
        .shadow(false)
        // Hidden from screen sharing and recordings by default, so the people
        // on a call don't see the nudges. set_agent_hud_capture_visible (the
        // eye in the HUD) lifts it for a demo.
        .content_protected(true)
        .visible_on_all_workspaces(true)
        // CRITICAL for this window in particular: the agent HUD's whole job is
        // to surface nudges while the user is in ANOTHER app (their call
        // window), i.e. while this webview is un-focused and often occluded.
        // Without this flag macOS suspends the WebContent process on occlusion
        // — rAF stops, so the nudge fade-in (opacity 0 → 1 gated behind
        // requestAnimationFrame in /hud/agent) never runs and a delivered
        // nudge sits painted at opacity 0 behind the placeholder ("HUD is
        // blank but I saw the say_to_user call"). Same flag as show_hud above.
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .build()
    {
        Ok(window) => {
            mlog("Agent HUD window created");
            // Assert a genuinely-clear NSWindow backing up front. Tauri's
            // `.transparent(true)` already does this, but we re-assert so the HUD
            // starts clean. (The RECURRENCE on theme switch — where the global
            // ThemeChanged handler used to re-opaque this window — is fixed in
            // lib.rs by label-guarding that handler to clear_window_background.)
            #[cfg(target_os = "macos")]
            if let Ok(ns) = window.ns_window() {
                crate::clear_window_background(ns);
            }
            // Float over full-screen calls too, before it is first shown.
            make_agent_hud_overlay(&window);
            // A crashed page would leave this transparent window blank, i.e.
            // invisible with no way back: reload it like the app's own windows.
            #[cfg(target_os = "macos")]
            crate::native::webcontent_watchdog::install_default_recovery(&window);
            let generation = AGENT_HUD_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
            AGENT_HUD_SHOW_PENDING.store(generation, Ordering::SeqCst);
            let app_clone = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(800));
                if !take_first_show(generation) {
                    return;
                }
                if let Some(window) = app_clone.get_webview_window("agent-hud") {
                    show_agent_hud_window(&window);
                    // Re-clear after show: the WKWebView is attached now, so this
                    // also clears its host layer (the pre-show call couldn't —
                    // the webview didn't exist yet).
                    #[cfg(target_os = "macos")]
                    if let Ok(ns) = window.ns_window() {
                        crate::clear_window_background(ns);
                    }
                }
            });
        }
        Err(e) => mlog(&format!("Failed to create agent HUD window: {}", e)),
    }
}

/// Keep only the buffered nudges for `capture_id` (none when it's None).
fn retain_nudges_for(buf: &mut Vec<AgentNudgePayload>, capture_id: Option<&str>) {
    match capture_id {
        Some(id) => buf.retain(|n| n.capture_id == id),
        None => buf.clear(),
    }
}

/// Show the live-agent HUD window. Called from the frontend relay hook when a
/// live meeting with the agent starts. Idempotent: an existing window is
/// brought back (un-minimized, shown, moved on screen) rather than left as it
/// was — a hidden window that a plain early-return left hidden is exactly the
/// "HUD sometimes doesn't come back" symptom. The buffer/ready state of a live
/// window are preserved (the page is still loaded), so it keeps its history.
#[tauri::command]
pub fn show_agent_hud(app: AppHandle) {
    ensure_agent_hud_inner(&app, "show", None);
}

/// Make sure the live-agent HUD is up (see ensure_agent_hud_inner), for the
/// relay hook to call whenever the HUD should be on screen: as each nudge
/// arrives, when the user comes back to Native Intelligence, and on a slow heartbeat. So a
/// HUD that went missing mid-call comes back by itself instead of only on an
/// app restart. Returns what it did: "visible", "restored", "created" or
/// "recreating", for the HUD's analytics.
#[tauri::command]
pub fn ensure_agent_hud(app: AppHandle, reason: Option<String>, capture_id: Option<String>) -> String {
    let reason = reason.unwrap_or_else(|| "ensure".to_string());
    ensure_agent_hud_inner(&app, &reason, capture_id.as_deref())
        .as_str()
        .to_string()
}

/// The agent HUD window was destroyed (lib.rs on_window_event). Expected after
/// hide_agent_hud; anything else (a close from the window itself) is logged so
/// it shows up next to the HUD's other lines. Either way the page is gone:
/// nudges buffer until a new window's page is ready. A show or ensure that came
/// in while it was closing builds the new window now.
pub(crate) fn on_agent_hud_destroyed(app: &AppHandle) {
    use std::sync::atomic::Ordering;
    AGENT_HUD_READY.store(false, Ordering::SeqCst);
    AGENT_HUD_SHOW_PENDING.store(0, Ordering::SeqCst);
    let (pending, hides) = {
        let mut lifecycle = agent_hud_lifecycle();
        if lifecycle.closing.take().is_none() {
            mlog("[hud] agent HUD window destroyed without hide_agent_hud");
        }
        (lifecycle.recreate.take(), lifecycle.hides)
    };
    let Some(pending) = pending else { return };
    // Not from inside this event, while the old window is still being torn
    // down: queued on the main thread from off it (on it, run_on_main_thread
    // runs at once).
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let main = app.clone();
        let _ = app.run_on_main_thread(move || {
            if agent_hud_lifecycle().hides != hides {
                return; // that meeting ended meanwhile
            }
            ensure_agent_hud_inner(&main, &pending.reason, pending.capture_id.as_deref());
        });
    });
}

/// The agent HUD's page is (re)loading (lib.rs on_page_load): a crash reload,
/// a new deploy, or its first load. Its `agent-nudge` listener is gone until
/// it calls agent_hud_ready again, so buffer nudges until then rather than
/// emitting them at a page with nobody listening.
pub(crate) fn on_agent_hud_page_load_started() {
    AGENT_HUD_READY.store(false, std::sync::atomic::Ordering::SeqCst);
}

/// Hide (CLOSE) the live-agent HUD window — for MEETING END only.
///
/// Destroys the webview and drops the ready flag + buffer so the next meeting
/// starts clean. Do NOT call this on a mere refocus: closing forces a full
/// window recreate (page reload + ~800ms show delay + agent_hud_ready
/// re-handshake) and loses buffered nudges. Use hide_agent_hud_transient for
/// the "user came back to Native Intelligence" case.
#[tauri::command]
pub fn hide_agent_hud(app: AppHandle) {
    // The page is gone — stop emitting to it and drop any buffered nudges so the
    // next session starts clean.
    AGENT_HUD_READY.store(false, std::sync::atomic::Ordering::SeqCst);
    if let Ok(mut buf) = AGENT_NUDGE_BUFFER.lock() {
        buf.clear();
    }
    reset_agent_hud_capture_visible();
    let window = app.get_webview_window("agent-hud");
    {
        let mut lifecycle = agent_hud_lifecycle();
        // A HUD waiting to be built, or about to be, was for this meeting.
        lifecycle.hides += 1;
        lifecycle.recreate = None;
        if window.is_none() || lifecycle.closing.is_some_and(|c| !c.kept) {
            return; // nothing to close, or already closing
        }
        // Until the window is actually gone, an ensure waits for it rather
        // than "showing" a window that is about to disappear.
        lifecycle.closing = Some(ClosingWindow { since: std::time::Instant::now(), kept: false });
    }
    // destroy, not close: nothing (a close-requested listener in the page)
    // can turn it down, so the window does go.
    if window.is_some_and(|w| w.destroy().is_err()) {
        agent_hud_lifecycle().closing = None;
    }
}

/// Show (true) or hide (false) the agent HUD in screen sharing and recordings —
/// the HUD's eye toggle. Sets content protection on the window to `!visible`.
/// Returns the resulting state, or an error when the HUD window isn't open (or
/// the window refused the change, in which case the state is unchanged).
#[tauri::command]
pub fn set_agent_hud_capture_visible(app: AppHandle, visible: bool) -> Result<bool, String> {
    let window = app
        .get_webview_window("agent-hud")
        .ok_or_else(|| "agent HUD window is not open".to_string())?;
    window
        .set_content_protected(!visible)
        .map_err(|e| format!("failed to set agent HUD capture visibility: {e}"))?;
    let visible = record_agent_hud_capture_visible(visible);
    mlog(&format!("[hud] capture visible: {}", visible));
    Ok(visible)
}

/// Whether the agent HUD currently shows in screen sharing (false = hidden, the
/// default). The HUD's eye reads it on mount to show the real state.
#[tauri::command]
pub fn get_agent_hud_capture_visible() -> bool {
    agent_hud_capture_visible()
}

/// Transiently HIDE the live-agent HUD without destroying it — for the
/// "user refocused Native Intelligence" case. The webview stays loaded and the nudge buffer +
/// ready flag are PRESERVED, so a later show_agent_hud brings the same window
/// (with its history) straight back with no reload or re-handshake. This is
/// what makes hide-on-refocus / show-on-reblur cheap and lossless.
#[tauri::command]
pub fn hide_agent_hud_transient(app: AppHandle) {
    if let Some(window) = app.get_webview_window("agent-hud") {
        let _ = window.hide();
    }
}

/// Relay one agent message to the HUD window. The frontend relay hook (which is
/// subscribed to the Realtime broadcast) calls this for each nudge.
///
/// If the HUD page has already signaled ready (`agent_hud_ready`), emit directly
/// TO the agent-hud window (not app-wide, so other webviews don't receive it).
/// Otherwise buffer the nudge so an early `say_to_user` — fired before the page
/// loaded and registered its listener — isn't lost; it's flushed on ready.
#[tauri::command]
pub fn push_agent_nudge(app: AppHandle, nudge: AgentNudgePayload) {
    use std::sync::atomic::Ordering;
    let ready = AGENT_HUD_READY.load(Ordering::SeqCst);
    let window = app.get_webview_window("agent-hud");
    if ready && window.is_some() {
        let _ = window.unwrap().emit("agent-nudge", &nudge);
        return;
    }
    // Not ready yet (or window gone) — buffer for the flush on agent_hud_ready.
    if let Ok(mut buf) = AGENT_NUDGE_BUFFER.lock() {
        if buf.len() >= AGENT_NUDGE_BUFFER_MAX {
            buf.remove(0); // drop oldest; a HUD this far behind won't miss the head
        }
        buf.push(nudge);
    }
}

/// Called by the HUD page once it has loaded and registered its `agent-nudge`
/// listener. Marks the HUD ready and flushes any nudges that arrived before the
/// listener existed, in arrival order. Idempotent.
#[tauri::command]
pub fn agent_hud_ready(app: AppHandle) {
    use std::sync::atomic::Ordering;
    AGENT_HUD_READY.store(true, Ordering::SeqCst);
    let pending: Vec<AgentNudgePayload> = match AGENT_NUDGE_BUFFER.lock() {
        Ok(mut buf) => std::mem::take(&mut *buf),
        Err(_) => return,
    };
    if let Some(window) = app.get_webview_window("agent-hud") {
        for nudge in pending {
            let _ = window.emit("agent-nudge", &nudge);
        }
    }
}

/// Check if the mouse cursor is currently over the HUD window.
/// Used by the HUD's JS timer to pause countdown on hover without requiring focus.
/// `cursor_position` reads the pointer without focus on every platform (the
/// dictate panel uses it too); it and `outer_position` are both physical
/// screen pixels, so the comparison needs no scale factor.
#[tauri::command]
pub fn is_cursor_over_hud(app: AppHandle) -> bool {
    let Some(window) = app.get_webview_window("meeting-hud") else {
        return false;
    };
    let (Ok(cursor), Ok(at), Ok(size)) = (app.cursor_position(), window.outer_position(), window.outer_size()) else {
        return false;
    };
    let (x, y) = (cursor.x, cursor.y);
    let (wx, wy) = (at.x as f64, at.y as f64);
    x >= wx && x <= wx + size.width as f64 && y >= wy && y <= wy + size.height as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    // One test for the shared static, so parallel tests can't race on it.
    #[test]
    fn agent_hud_capture_visibility_defaults_hidden_and_toggles() {
        // A fresh window starts hidden from capture, whatever came before.
        record_agent_hud_capture_visible(true);
        reset_agent_hud_capture_visible();
        assert!(!agent_hud_capture_visible());
        assert!(!get_agent_hud_capture_visible());

        // Toggling sets the state and returns it.
        assert!(record_agent_hud_capture_visible(true));
        assert!(get_agent_hud_capture_visible());
        assert!(!record_agent_hud_capture_visible(false));
        assert!(!get_agent_hud_capture_visible());

        // The next meeting's fresh window resets an open eye back to hidden.
        record_agent_hud_capture_visible(true);
        reset_agent_hud_capture_visible();
        assert!(!get_agent_hud_capture_visible());
    }

    fn present(visible: bool, minimized: bool, on_screen: bool, show_pending: bool) -> AgentHudPresence {
        AgentHudPresence::Present { visible, minimized, on_screen, show_pending }
    }

    #[test]
    fn ensure_builds_a_missing_hud_and_waits_out_a_closing_one() {
        assert_eq!(plan_agent_hud(AgentHudPresence::Missing), AgentHudPlan::Create);
        assert_eq!(plan_agent_hud(AgentHudPresence::Closing), AgentHudPlan::RecreateAfterClose);
        assert_eq!(AgentHudPlan::Create.as_str(), "created");
        assert_eq!(AgentHudPlan::RecreateAfterClose.as_str(), "recreating");
    }

    #[test]
    fn a_close_is_stuck_only_after_the_grace_period() {
        let since = std::time::Instant::now();
        assert!(!close_is_stuck(since, since));
        assert!(!close_is_stuck(since, since + AGENT_HUD_CLOSE_GRACE - std::time::Duration::from_millis(1)));
        assert!(close_is_stuck(since, since + AGENT_HUD_CLOSE_GRACE));
        // A clock read before `since` (another thread's) isn't stuck.
        assert!(!close_is_stuck(since + AGENT_HUD_CLOSE_GRACE, since));
    }

    // One test for the shared static, so parallel tests can't race on it.
    #[test]
    fn only_the_newest_window_gets_its_delayed_first_show() {
        use std::sync::atomic::Ordering;
        // Window 1 was replaced by window 2 before its show thread woke.
        AGENT_HUD_SHOW_PENDING.store(2, Ordering::SeqCst);
        assert!(!take_first_show(1));
        assert!(take_first_show(2));
        // Shown once only.
        assert!(!take_first_show(2));
        // A destroyed window (pending cleared) isn't shown either.
        AGENT_HUD_SHOW_PENDING.store(3, Ordering::SeqCst);
        AGENT_HUD_SHOW_PENDING.store(0, Ordering::SeqCst);
        assert!(!take_first_show(3));
    }

    #[test]
    fn ensure_leaves_a_hud_that_is_up_alone() {
        assert_eq!(plan_agent_hud(present(true, false, true, false)), AgentHudPlan::Keep);
        assert_eq!(AgentHudPlan::Keep.as_str(), "visible");
        // A new window still waiting for its delayed first show is on its way.
        assert_eq!(plan_agent_hud(present(false, false, true, true)), AgentHudPlan::Keep);
    }

    #[test]
    fn ensure_brings_back_a_hidden_minimized_or_off_screen_hud() {
        assert_eq!(
            plan_agent_hud(present(false, false, true, false)),
            AgentHudPlan::Restore { unminimize: false, show: true, reposition: false }
        );
        assert_eq!(
            plan_agent_hud(present(true, true, true, false)),
            AgentHudPlan::Restore { unminimize: true, show: false, reposition: false }
        );
        assert_eq!(
            plan_agent_hud(present(true, false, false, false)),
            AgentHudPlan::Restore { unminimize: false, show: false, reposition: true }
        );
        assert_eq!(plan_agent_hud(present(false, true, false, false)).as_str(), "restored");
    }

    #[test]
    fn a_window_whose_centre_is_on_no_monitor_is_off_screen() {
        let laptop = (0, 0, 3024, 1964);
        let external = (3024, 0, 3840, 2160);
        // Bottom-right of the laptop screen.
        assert!(center_on_any_monitor((2000, 1000, 944, 1072), &[laptop]));
        // On the external display, which is still there.
        assert!(center_on_any_monitor((5000, 800, 944, 1072), &[laptop, external]));
        // Left on the external display after it was unplugged.
        assert!(!center_on_any_monitor((5000, 800, 944, 1072), &[laptop]));
        // Dragged almost entirely off the left edge.
        assert!(!center_on_any_monitor((-900, 200, 944, 1072), &[laptop]));
        // A display left of the main one has negative coordinates.
        assert!(center_on_any_monitor((-1500, 200, 944, 1072), &[laptop, (-2560, 0, 2560, 1440)]));
    }

    fn nudge(id: &str, capture_id: &str) -> AgentNudgePayload {
        AgentNudgePayload {
            id: id.to_string(),
            message: "m".to_string(),
            kind: "tip".to_string(),
            capture_id: capture_id.to_string(),
            ts: 0.0,
        }
    }

    #[test]
    fn a_fresh_window_keeps_only_its_own_calls_buffered_nudges() {
        let mut buf = vec![nudge("a", "old-call"), nudge("b", "this-call"), nudge("c", "this-call")];
        retain_nudges_for(&mut buf, Some("this-call"));
        let ids: Vec<_> = buf.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, ["b", "c"]);

        // A new meeting's window (no call named) starts empty.
        retain_nudges_for(&mut buf, None);
        assert!(buf.is_empty());
    }
}
