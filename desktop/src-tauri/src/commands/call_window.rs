//! The call window: a team call or meeting in its own floating window, apart
//! from the app's (Liam, 11-18: the call controls "pop out … the same way the
//! live agent pops up"). Made like the live agent's HUD (hud.rs
//! create_agent_hud) and the Studio's recording control: no frame,
//! transparent, always on top, on every Space, never suspended when covered
//! (its sound and video go on behind other windows), hidden from screen
//! sharing. Unlike them it can be resized.
//!
//! The call lives in this window and nowhere else: a camera or microphone
//! stream cannot be handed from one web view to another, so the page here
//! (`{origin}/hud/call`) joins the call itself and the dashboard windows only
//! mirror what it says about it.
//!
//!   open_call_window    a dashboard asks for the window with the call to
//!                       join (what the server answered its start, join or
//!                       accept: the call and its join token). Kept here, in
//!                       memory only and never logged, until the page asks.
//!   call_window_ready   the page is up: it takes the call. A page loaded
//!                       again (a crashed web view's recovery) gets the same
//!                       call marked not fresh: its token may be spent, so the
//!                       page asks the server for a new one.
//!   show_call_window    bring it forward (the app's "Open the call").
//!   close_call_window   the page, once it has left the call. A call handed
//!                       over while the window is on its way out is kept, and
//!                       the window is made again for it once the old one is
//!                       gone (a label is free only then).
//!
//! Signing out in a dashboard closes the window (lib.rs on_page_load): the
//! call was that person's.
//!
//! The page and the dashboards talk about the call's state between
//! themselves, over events (web: src/lib/team-calls/call-window.ts). When the
//! window goes, however it goes, every window is told (CLOSED_EVENT).
//!
//! Windows and Linux: the same window, with nothing of its own; the macOS
//! parts (the panel that floats over full-screen apps, showing without taking
//! the keyboard) are no-ops there.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::log_to_file;

/// The call window's label.
pub const LABEL: &str = "call";
/// To the call window's page: a call to join (now, or instead of the one it is in).
pub const BEGIN_EVENT: &str = "call-window://begin";
/// To every window: the call window is gone.
pub const CLOSED_EVENT: &str = "call-window://closed";

const CALL_W: f64 = 420.0;
const CALL_H: f64 = 380.0;
const CALL_MIN_W: f64 = 340.0;
const CALL_MIN_H: f64 = 300.0;
/// The most a call to join may weigh, serialized (a call, its token and its guests are a few KB).
const MAX_CALL_BYTES: usize = 256 * 1024;

/// The call the window is for, and whether its page has been handed it yet.
struct Held {
    call: Value,
    delivered: bool,
}

static HELD: Mutex<Option<Held>> = Mutex::new(None);
/// The page is up and listening for BEGIN_EVENT.
static READY: AtomicBool = AtomicBool::new(false);
/// close_call_window has been asked and the window is not gone yet: nothing in it will take a call.
static CLOSING: AtomicBool = AtomicBool::new(false);

/// Only a dashboard window starts or raises a call's window.
fn check_dashboard(label: &str) -> Result<(), String> {
    if crate::is_hud_label(label) {
        return Err("Only a dashboard window can open the call window".into());
    }
    Ok(())
}

/// A call to join is an object, of a sane size.
fn check_call(call: &Value) -> Result<(), String> {
    if !call.is_object() {
        return Err("The call to open must be an object".into());
    }
    let size = serde_json::to_vec(call).map(|v| v.len()).unwrap_or(usize::MAX);
    if size > MAX_CALL_BYTES {
        return Err("The call to open is too large".into());
    }
    Ok(())
}

/// Keep `call` for the page. `ready`: the page is up, so it is being handed over now.
fn hold(call: Value, ready: bool) {
    if let Ok(mut held) = HELD.lock() {
        *held = Some(Held { call, delivered: ready });
    }
}

/// What the page gets when it says it is up: the call, and whether this is its first hand-over.
fn take_for_page() -> Option<Value> {
    let mut held = HELD.lock().ok()?;
    let held = held.as_mut()?;
    let fresh = !held.delivered;
    held.delivered = true;
    Some(json!({ "call": held.call, "fresh": fresh }))
}

/// The window that was closing is gone: is a call waiting that was handed over meanwhile?
fn reopen_after_close() -> bool {
    let was_closing = CLOSING.swap(false, Ordering::SeqCst);
    was_closing && HELD.lock().map(|held| held.as_ref().is_some_and(|h| !h.delivered)).unwrap_or(false)
}

fn forget() {
    READY.store(false, Ordering::SeqCst);
    CLOSING.store(false, Ordering::SeqCst);
    if let Ok(mut held) = HELD.lock() {
        *held = None;
    }
}

/// Open the call window for `call`, or hand `call` to the one already open.
/// Answers "created", "shown", or "reopening" (the window was closing: it is made again for this call).
#[tauri::command]
pub fn open_call_window(app: AppHandle, window: WebviewWindow, call: Value) -> Result<&'static str, String> {
    check_dashboard(window.label())?;
    check_call(&call)?;
    if let Some(existing) = app.get_webview_window(LABEL) {
        if CLOSING.load(Ordering::SeqCst) {
            hold(call, false);
            return Ok("reopening");
        }
        let ready = READY.load(Ordering::SeqCst);
        hold(call.clone(), ready);
        if ready {
            let _ = existing.emit_to(LABEL, BEGIN_EVENT, json!({ "call": call, "fresh": true }));
        }
        let _ = existing.unminimize();
        show_without_focus(&existing);
        return Ok("shown");
    }
    hold(call, false);
    create(&app).inspect_err(|_| forget())?;
    Ok("created")
}

/// The call window's page is up: the call it is for, if any.
#[tauri::command]
pub fn call_window_ready(window: WebviewWindow) -> Result<Option<Value>, String> {
    if window.label() != LABEL {
        return Err("Only the call window takes a call".into());
    }
    READY.store(true, Ordering::SeqCst);
    Ok(take_for_page())
}

/// Bring the call window forward, if there is one. Answers whether there was.
#[tauri::command]
pub fn show_call_window(app: AppHandle, window: WebviewWindow) -> Result<bool, String> {
    check_dashboard(window.label())?;
    match app.get_webview_window(LABEL) {
        Some(existing) => {
            let _ = existing.unminimize();
            show_without_focus(&existing);
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Close the call window: its own page once it has left the call, or a
/// dashboard whose call never came up in it.
#[tauri::command]
pub fn close_call_window(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    if window.label() != LABEL {
        check_dashboard(window.label())?;
    }
    if let Some(existing) = app.get_webview_window(LABEL) {
        CLOSING.store(true, Ordering::SeqCst);
        READY.store(false, Ordering::SeqCst);
        if existing.close().is_err() {
            CLOSING.store(false, Ordering::SeqCst);
        }
    }
    Ok(())
}

/// A dashboard is signing out: the call in the window was that person's. Nothing is kept for it.
pub fn close_for_sign_out(app: &AppHandle) {
    if let Some(existing) = app.get_webview_window(LABEL) {
        forget();
        log_to_file("[call-window] closed: signing out");
        let _ = existing.close();
    }
}

/// The page is loading (again): nothing listens until it says it is up.
pub fn on_page_load_started() {
    READY.store(false, Ordering::SeqCst);
}

/// The window is gone: its call with it, and every window is told. Unless a
/// call was handed over while it was closing: then the window is made again
/// for that call, and nobody is told it went.
pub fn on_destroyed(app: &AppHandle) {
    READY.store(false, Ordering::SeqCst);
    if !reopen_after_close() {
        forget();
        let _ = app.emit(CLOSED_EVENT, ());
        return;
    }
    // Not from inside this event, while the old window is still being torn
    // down (as hud.rs on_agent_hud_destroyed): queued on the main thread.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let main = app.clone();
        let _ = app.run_on_main_thread(move || {
            if main.get_webview_window(LABEL).is_some() {
                return;
            }
            if let Err(why) = create(&main) {
                log_to_file(&format!("[call-window] not reopened: {why}"));
                forget();
                let _ = main.emit(CLOSED_EVENT, ());
            }
        });
    });
}

fn create(app: &AppHandle) -> Result<(), String> {
    READY.store(false, Ordering::SeqCst);
    let origin = app
        .get_webview_window("main")
        .and_then(|w| w.url().ok())
        .map(|u| u.origin().ascii_serialization())
        .filter(|o| o.starts_with("http"))
        .unwrap_or_else(|| crate::tray::api_base_url().to_string());
    let parsed = format!("{origin}/hud/call").parse().map_err(|e| format!("bad call window URL: {e}"))?;
    let (x, y) = default_position(app);

    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(parsed))
        .title("Call")
        .inner_size(CALL_W, CALL_H)
        .min_inner_size(CALL_MIN_W, CALL_MIN_H)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .focused(false)
        // Mute and Leave work on the first click, even while another app is in front.
        .accept_first_mouse(true)
        .visible(false)
        .shadow(false)
        // Hidden from the person's own screen sharing and recordings, as the
        // live agent's HUD is: the people they share with see the screen, not
        // the call's window over it.
        .content_protected(true)
        .visible_on_all_workspaces(true)
        // The call's sound and video must go on while the person works in
        // another app with this window covered: never let the page be suspended.
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .build()
        .map_err(|e| format!("couldn't make the call window: {e}"))?;
    #[cfg(target_os = "macos")]
    {
        if let Ok(ns) = window.ns_window() {
            crate::clear_window_background(ns);
        }
        let w = window.clone();
        let _ = window.run_on_main_thread(move || {
            if let Ok(ns) = w.ns_window() {
                if let Err(why) = crate::make_overlay_panel(ns) {
                    log_to_file(&format!("[call-window] stays a normal window: {why}"));
                }
            }
        });
        // A crashed page reloads, and the page joins its call again (call_window_ready).
        crate::native::webcontent_watchdog::install_default_recovery(&window);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = &window;
    log_to_file("[call-window] created");
    // Shown once the page has had a moment to paint (the window is transparent).
    let app_clone = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        if let Some(window) = app_clone.get_webview_window(LABEL) {
            show_without_focus(&window);
        }
    });
    Ok(())
}

fn show_without_focus(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let w = window.clone();
        let _ = window.run_on_main_thread(move || {
            if let Ok(ns) = w.ns_window() {
                crate::order_front_without_focus(ns);
                crate::clear_window_background(ns);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window.show();
}

/// Top right of the main window's display, under the menu bar: clear of the
/// live agent's HUD, which stands at the bottom right.
fn default_position(app: &AppHandle) -> (f64, f64) {
    let monitor = app
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    match monitor {
        Some(m) => {
            let scale = m.scale_factor();
            let w = m.size().width as f64 / scale;
            let x = m.position().x as f64 / scale + w - CALL_W - 24.0;
            let y = m.position().y as f64 / scale + 56.0;
            (x, y)
        }
        None => (900.0, 56.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// HELD is one per process: the tests that use it take turns.
    static TURN: Mutex<()> = Mutex::new(());

    #[test]
    fn only_dashboards_open_the_call_window() {
        for label in ["main", "workspace-4f1c2d"] {
            assert!(check_dashboard(label).is_ok(), "{label}");
        }
        for label in crate::HUD_LABELS {
            assert!(check_dashboard(label).is_err(), "{label}");
        }
        assert!(crate::is_hud_label(LABEL));
    }

    #[test]
    fn a_call_is_an_object_of_a_sane_size() {
        assert!(check_call(&json!({ "call": { "id": "c1" } })).is_ok());
        assert!(check_call(&json!("c1")).is_err());
        assert!(check_call(&json!([1, 2])).is_err());
        assert!(check_call(&json!({ "blob": "x".repeat(MAX_CALL_BYTES) })).is_err());
    }

    #[test]
    fn the_page_gets_its_call_fresh_once_then_marked_stale() {
        let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
        forget();
        assert_eq!(take_for_page(), None);

        hold(json!({ "id": "c1" }), false);
        assert_eq!(take_for_page(), Some(json!({ "call": { "id": "c1" }, "fresh": true })));
        // The page loaded again: the same call, its token maybe spent.
        assert_eq!(take_for_page(), Some(json!({ "call": { "id": "c1" }, "fresh": false })));

        // Another call handed to a page that is up (it got the event): a reload finds it stale.
        hold(json!({ "id": "c2" }), true);
        assert_eq!(take_for_page(), Some(json!({ "call": { "id": "c2" }, "fresh": false })));

        forget();
        assert_eq!(take_for_page(), None);
        assert!(!READY.load(Ordering::SeqCst));
    }

    #[test]
    fn a_call_handed_over_while_closing_reopens_the_window() {
        let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
        forget();
        // Gone without being asked to close, or closed with its own (delivered) call: nothing to reopen for.
        hold(json!({ "id": "c1" }), false);
        assert!(!reopen_after_close());
        hold(json!({ "id": "c1" }), true);
        CLOSING.store(true, Ordering::SeqCst);
        assert!(!reopen_after_close());
        assert!(!CLOSING.load(Ordering::SeqCst));
        // Closing, and another call arrived meanwhile.
        CLOSING.store(true, Ordering::SeqCst);
        hold(json!({ "id": "c2" }), false);
        assert!(reopen_after_close());
        assert_eq!(take_for_page(), Some(json!({ "call": { "id": "c2" }, "fresh": true })));
        forget();
    }
}
