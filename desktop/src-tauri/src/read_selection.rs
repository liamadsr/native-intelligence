//! Read selection aloud, anywhere on the Mac: select text in any app (a
//! terminal, a browser, a PDF) and press the hotkey (⌃⌥R by default) to hear
//! it in the local-tts voice. Press it again to stop.
//!
//! Off until the user turns it on in Settings → Read aloud
//! ([`crate::settings::ReadSelectionSettings`]); only then is the hotkey
//! registered. The settings page asks for the Accessibility permission (its
//! "Allow access", [`read_selection_request_access`]) and only lets the
//! feature be turned on once it's granted; nothing else in Dial8 needs it.
//!
//! - The hotkey is a Carbon hotkey (`native/selection_helper.m`), which needs
//!   no permission. macOS 15+ refuses Option-only and Option-Shift-only
//!   combos, so the system's own ⌥⎋ "Speak selection" can't be offered.
//! - The text is the focused element's AXSelectedText, else ⌘C posted to the
//!   frontmost app with the clipboard put back after. Both need the
//!   Accessibility permission (the ⌘C also the key-event grant, which the
//!   same System Settings switch gives); a press without it just beeps.
//! - Sentences ([`split`]) are normalized and queued a few at a time
//!   ([`AHEAD`]), so a long selection costs nothing up front and a stop drops
//!   at most a few sentences of work.
//!
//! The speech belongs to no webview ([`OWNER`]), so no page reload stops it.
//! It follows `tts_speak`'s rules ([`tts::refusal`]): never over a recording.
//!
//! Commands (for the settings page; every one answers the new [`Status`]):
//! `read_selection_status`, `read_selection_set_enabled { enabled }`,
//! `read_selection_set_hotkey { hotkey }` (a preset, or `"custom"` for the
//! recorded one), `read_selection_record_hotkey` (waits for the user to press
//! a shortcut, fn included, [`keys`]), `read_selection_cancel_record`,
//! `read_selection_set_voice { voice }`,
//! `read_selection_request_access`, `read_selection_open_accessibility_settings`,
//! and `read_selection_relaunch` (answers nothing).

pub mod keys;
mod split;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Listener, Manager};
use tokio::sync::{mpsc, oneshot};

use crate::modules::tts::{self, TtsService};
use crate::settings::{self, ReadSelectionSettings};

/// The owner `TtsService::claim` records for this speech: not a webview
/// label, so `cancel_if_owner` never matches it.
const OWNER: &str = "read-selection";
/// Sentences queued but not yet played. The sidecar synthesizes ~6× faster
/// than real time, so this never starves playback.
const AHEAD: usize = 4;
/// Longest selection read, in bytes (~1 hour of speech). Anything past it is
/// dropped (logged).
const MAX_SELECTION_BYTES: usize = 60_000;

use keys::{CONTROL, OPTION};

/// A hotkey the settings page offers. Each is one macOS accepts (not
/// Option-only) and that no common app or terminal binds.
struct Hotkey {
    id: &'static str,
    label: &'static str,
    keycode: u32,
    modifiers: u32,
}

pub const DEFAULT_HOTKEY: &str = "ctrl_opt_r";

const HOTKEYS: &[Hotkey] = &[
    Hotkey { id: "ctrl_opt_r", label: "⌃⌥R", keycode: 15, modifiers: CONTROL | OPTION },
    Hotkey { id: "ctrl_opt_s", label: "⌃⌥S", keycode: 1, modifiers: CONTROL | OPTION },
    Hotkey { id: "ctrl_opt_space", label: "⌃⌥Space", keycode: 49, modifiers: CONTROL | OPTION },
    Hotkey { id: "ctrl_esc", label: "⌃⎋", keycode: 53, modifiers: CONTROL },
];

/// The id `"custom"` names the recorded shortcut.
pub const CUSTOM_HOTKEY: &str = "custom";

/// The shortcut `current` names: (key code, Carbon modifiers, label, id).
fn hotkey(current: &ReadSelectionSettings) -> (u32, u32, String, String) {
    if current.hotkey == CUSTOM_HOTKEY {
        if let Some(k) = &current.custom_hotkey {
            return (k.keycode, k.modifiers, k.label.clone(), CUSTOM_HOTKEY.to_string());
        }
    }
    let h = HOTKEYS.iter().find(|h| h.id == current.hotkey).unwrap_or(&HOTKEYS[0]);
    (h.keycode, h.modifiers, h.label.to_string(), h.id.to_string())
}

static APP: OnceLock<AppHandle> = OnceLock::new();
/// Bumped by every press: a reading whose run is no longer current stops.
static RUN: AtomicU64 = AtomicU64::new(0);
/// A press is grabbing text or its sentences are playing.
static READING: AtomicBool = AtomicBool::new(false);
/// Why the hotkey could not be registered (another app holds it), while it
/// is enabled and unregistered.
static HOTKEY_ERROR: Mutex<Option<String>> = Mutex::new(None);

// ─── native ─────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod sys {
    use std::os::raw::c_char;

    extern "C" {
        fn selection_hotkey_register(keycode: u32, carbon_mods: u32, cb: extern "C" fn()) -> i32;
        fn selection_hotkey_unregister();
        fn selection_fn_hotkey_register(keycode: i32, carbon_mods: u32, cb: extern "C" fn()) -> i32;
        fn selection_fn_hotkey_unregister();
        fn selection_capture_begin(cb: extern "C" fn(i32, u32, bool, *const c_char)) -> i32;
        fn selection_capture_cancel();
        fn selection_accessibility_trusted(prompt: bool) -> bool;
        fn selection_post_events_allowed(request: bool) -> bool;
        fn selection_request_post_events() -> bool;
        fn selection_copy_text(out_source: *mut i32) -> *mut c_char;
        fn selection_frontmost_app() -> *mut c_char;
        fn selection_free(text: *mut c_char);
        fn selection_beep();
    }

    pub const SUPPORTED: bool = true;

    /// Main thread only.
    pub fn register(keycode: u32, modifiers: u32, cb: extern "C" fn()) -> i32 {
        unsafe { selection_hotkey_register(keycode, modifiers, cb) }
    }

    /// Main thread only.
    pub fn unregister() {
        unsafe { selection_hotkey_unregister() }
    }

    /// A shortcut with fn (`keycode` -1: fn alone), through the event tap.
    /// Main thread only.
    pub fn register_fn(keycode: i32, modifiers: u32, cb: extern "C" fn()) -> i32 {
        unsafe { selection_fn_hotkey_register(keycode, modifiers, cb) }
    }

    /// Main thread only.
    pub fn unregister_fn() {
        unsafe { selection_fn_hotkey_unregister() }
    }

    /// Main thread only.
    pub fn capture_begin(cb: extern "C" fn(i32, u32, bool, *const c_char)) -> i32 {
        unsafe { selection_capture_begin(cb) }
    }

    /// Main thread only.
    pub fn capture_cancel() {
        unsafe { selection_capture_cancel() }
    }

    /// The grant the feature needs: the Accessibility API (reading the
    /// selection, pressing the app's Edit → Copy). Posting keys (the ⌘C
    /// fallback) is a separate grant, asked for only when an app needs it.
    pub fn trusted(prompt: bool) -> bool {
        unsafe { selection_accessibility_trusted(prompt) }
    }

    pub fn may_post() -> bool {
        unsafe { selection_post_events_allowed(false) }
    }

    pub fn request_post() -> bool {
        unsafe { selection_request_post_events() }
    }

    pub fn beep() {
        unsafe { selection_beep() }
    }

    fn take(ptr: *mut c_char) -> Option<String> {
        if ptr.is_null() {
            return None;
        }
        let text = unsafe { std::ffi::CStr::from_ptr(ptr) }.to_string_lossy().into_owned();
        unsafe { selection_free(ptr) };
        Some(text)
    }

    /// The frontmost app's selected text and how it was read, or why there
    /// was none (`selection_helper.h`'s codes). Blocking.
    pub fn grab() -> Result<(String, &'static str), &'static str> {
        let mut source = 0i32;
        let text = take(unsafe { selection_copy_text(&mut source) });
        match (text, source) {
            (Some(text), 1) => Ok((text, "accessibility")),
            (Some(text), 3) => Ok((text, "⌘C keystroke")),
            (Some(text), 4) => Ok((text, "copied on select")),
            (Some(text), 5) => Ok((text, "copied on select, clipboard put back")),
            (Some(text), _) => Ok((text, "Edit → Copy")),
            (None, -1) => Err("secure input is on"),
            (None, -2) => Err("no Accessibility permission"),
            (None, -3) => Err("no Copy menu item, and ⌘C left the clipboard unchanged"),
            (None, -6) => Err("the app's Copy menu item is disabled (nothing selected)"),
            (None, -7) => Err("no Copy menu item, and macOS refuses Dial8 posting ⌘C"),
            (None, -9) => Err("Edit → Copy changed nothing, and macOS refuses Dial8 posting ⌘C"),
            (None, -8) => Err("neither Edit → Copy nor ⌘C changed the clipboard"),
            (None, -4) => Err("the copy put no text on the clipboard"),
            (None, -5) => Err("the shortcut's keys were still held"),
            (None, _) => Err("nothing selected"),
        }
    }

    /// The frontmost app's bundle id, for the log.
    pub fn frontmost_app() -> String {
        take(unsafe { selection_frontmost_app() }).unwrap_or_default()
    }
}

/// No hotkey and no selection off macOS (the voice is macOS-only anyway).
#[cfg(not(target_os = "macos"))]
mod sys {
    pub const SUPPORTED: bool = false;
    pub fn register(_keycode: u32, _modifiers: u32, _cb: extern "C" fn()) -> i32 {
        -1
    }
    pub fn unregister() {}
    pub fn register_fn(_keycode: i32, _modifiers: u32, _cb: extern "C" fn()) -> i32 {
        -1
    }
    pub fn unregister_fn() {}
    pub fn capture_begin(_cb: extern "C" fn(i32, u32, bool, *const std::os::raw::c_char)) -> i32 {
        -1
    }
    pub fn capture_cancel() {}
    pub fn may_post() -> bool {
        false
    }
    pub fn request_post() -> bool {
        false
    }
    pub fn trusted(_prompt: bool) -> bool {
        false
    }
    pub fn beep() {}
    pub fn grab() -> Result<(String, &'static str), &'static str> {
        Err("unsupported")
    }
    pub fn frontmost_app() -> String {
        String::new()
    }
}

// ─── hotkey ─────────────────────────────────────────────────────────────────

/// Register the hotkey if the feature is on. Call once, on the main thread,
/// after the `TtsService` is managed (lib.rs setup()).
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let current = settings::read_selection(app);
    if current.enabled {
        set_hotkey_error(register_now(&current));
    }
}

/// (Un)register for `current`, on the main thread. Returns the error.
fn register_now(current: &ReadSelectionSettings) -> Option<String> {
    sys::unregister();
    sys::unregister_fn();
    if !current.enabled {
        crate::log_to_file("[read-selection] hotkey unregistered");
        return None;
    }
    let (keycode, modifiers, label, _) = hotkey(current);
    if modifiers & keys::FN != 0 {
        // Carbon can't take fn: the event tap matches it.
        let key = if keycode == keys::FN_KEYCODE { -1 } else { keycode as i32 };
        if sys::register_fn(key, modifiers & !keys::FN, on_hotkey) == 0 {
            crate::log_to_file(&format!("[read-selection] hotkey {label} registered (event tap)"));
            return None;
        }
        crate::log_to_file(&format!("[read-selection] hotkey {label} not registered (no event tap)"));
        return Some(format!("Dial8 couldn’t watch for {label}. Check the permission above, then pick it again."));
    }
    let status = sys::register(keycode, modifiers, on_hotkey);
    if status == 0 {
        crate::log_to_file(&format!("[read-selection] hotkey {label} registered"));
        None
    } else {
        crate::log_to_file(&format!("[read-selection] hotkey {label} not registered (OSStatus {status})"));
        Some(format!("{label} is taken by macOS or another app. Pick another shortcut."))
    }
}

/// [`register_now`] from any thread: Carbon hotkeys live on the main thread.
async fn apply(app: &AppHandle, current: ReadSelectionSettings) {
    let (tx, rx) = oneshot::channel();
    let ran = app.run_on_main_thread(move || {
        let _ = tx.send(register_now(&current));
    });
    let error = if ran.is_ok() { rx.await.ok().flatten() } else { Some("Couldn't set the shortcut.".into()) };
    set_hotkey_error(error);
}

fn set_hotkey_error(error: Option<String>) {
    *HOTKEY_ERROR.lock().unwrap_or_else(|p| p.into_inner()) = error;
}

/// Stop the reading in progress, if any.
fn stop(tts: &TtsService) {
    RUN.fetch_add(1, Ordering::SeqCst);
    if READING.swap(false, Ordering::SeqCst) {
        tts.cancel();
        crate::log_to_file("[read-selection] stopped");
    }
}

/// Carbon calls this on the main thread: hand off at once.
extern "C" fn on_hotkey() {
    if let Some(app) = APP.get() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { on_press(app).await });
    }
}

async fn on_press(app: AppHandle) {
    let run = RUN.fetch_add(1, Ordering::SeqCst) + 1;
    let Some(tts) = app.try_state::<TtsService>() else { return };

    // A second press stops the reading (or the grab still under way).
    if READING.swap(false, Ordering::SeqCst) {
        tts.cancel();
        crate::log_to_file("[read-selection] stopped");
        return;
    }

    // The grant was taken back in System Settings: the settings page says so
    // and asks again. A press never opens System Settings by itself.
    if !sys::trusted(false) {
        crate::log_to_file("[read-selection] needs the Accessibility permission");
        sys::beep();
        return;
    }
    if let Some(why) = tts::refusal(&app, &tts) {
        crate::log_to_file(&format!("[read-selection] can't speak now: {why}"));
        sys::beep();
        return;
    }

    READING.store(true, Ordering::SeqCst);
    tts.prepare();

    let app_id = sys::frontmost_app();
    let grabbed = tauri::async_runtime::spawn_blocking(sys::grab).await.unwrap_or(Err("nothing selected"));
    if RUN.load(Ordering::SeqCst) != run {
        return; // stopped while grabbing
    }
    let (text, source) = match grabbed {
        Ok(found) => found,
        Err(why) => {
            READING.store(false, Ordering::SeqCst);
            crate::log_to_file(&format!("[read-selection] nothing read in {app_id}: {why}"));
            sys::beep();
            return;
        }
    };
    crate::log_to_file(&format!("[read-selection] read {} bytes in {app_id} ({source})", text.len()));
    // Anything already speaking (a chat reply read aloud) gives way.
    tts.cancel();

    let voice = settings::read_selection(&app).voice;
    read(&app, &tts, run, text, voice, &app_id).await;
    if RUN.load(Ordering::SeqCst) == run {
        READING.store(false, Ordering::SeqCst);
    }
}

#[derive(Deserialize)]
struct StatePayload {
    id: String,
    state: String,
}

// ─── chats: who said what ──────────────────────────────────────────────────

/// Chat and mail apps whose selection reads as who said what ("Emily said: …
/// Jianmin then said: …", Liam, 2026-10-22): the web runs its own reader on the text
/// (web lib/read-aloud/read-anywhere-chat.ts → browser-speech.ts) and sends
/// the sentences back. Teams, Outlook, Slack, Discord.
const CHAT_APPS: &[&str] = &[
    "com.microsoft.teams2",
    "com.microsoft.teams",
    "com.microsoft.Outlook",
    "com.tinyspeck.slackmacgap",
    "com.hnc.Discord",
];
/// Read anywhere's text from a chat app, for the web: `{ run, text, app }`.
const CONVERT_EVENT: &str = "read-selection://convert";
/// How long a press waits for a window's sentences before reading the text
/// as it would anywhere else (no window open, or an older web).
const WEB_WAIT: std::time::Duration = std::time::Duration::from_millis(1200);
/// The wait once a window has failed to answer, until one answers again: a
/// press with no Dial8 page listening (signed out, a docs page, a web older
/// than this build) shouldn't pause each time.
const WEB_WAIT_UNANSWERED: std::time::Duration = std::time::Duration::from_millis(150);

/// The press waiting for the web's sentences, and where they go.
static CONVERTING: Mutex<Option<(u64, oneshot::Sender<Vec<String>>)>> = Mutex::new(None);
/// The last request was answered (or none has been sent yet).
static WEB_ANSWERED: AtomicBool = AtomicBool::new(true);

fn reads_as_chat(app_id: &str) -> bool {
    CHAT_APPS.contains(&app_id)
}

/// The web's sentences for `text` from a chat app, or None: no window
/// answered in time, or it sent none. The caller then splits the text itself.
async fn chat_sentences(app: &AppHandle, run: u64, text: &str, app_id: &str) -> Option<Vec<String>> {
    use tauri::Emitter;
    let (tx, rx) = oneshot::channel();
    *CONVERTING.lock().unwrap_or_else(|p| p.into_inner()) = Some((run, tx));
    let asked = app.emit(CONVERT_EVENT, serde_json::json!({ "run": run, "text": text, "app": app_id }));
    let wait = if WEB_ANSWERED.load(Ordering::SeqCst) { WEB_WAIT } else { WEB_WAIT_UNANSWERED };
    let answer = match asked {
        Ok(()) => tokio::time::timeout(wait, rx).await.ok().and_then(Result::ok),
        Err(_) => None,
    };
    WEB_ANSWERED.store(answer.is_some(), Ordering::SeqCst);
    {
        let mut slot = CONVERTING.lock().unwrap_or_else(|p| p.into_inner());
        if slot.as_ref().is_some_and(|(waiting, _)| *waiting == run) {
            *slot = None;
        }
    }
    let sentences = answer.and_then(kept_sentences);
    if sentences.is_none() {
        crate::log_to_file(&format!("[read-selection] no who-said-what from a window for {app_id}; reading it plainly"));
    }
    sentences
}

/// The web's sentences without blanks, a long one cut as the splitter cuts
/// its own, within what a selection may hold; None when nothing is left.
fn kept_sentences(sentences: Vec<String>) -> Option<Vec<String>> {
    let mut total = 0;
    let kept: Vec<String> = sentences
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .flat_map(|s| split::pieces(&s))
        .take_while(|s| {
            total += s.len();
            total <= 2 * MAX_SELECTION_BYTES
        })
        .collect();
    (!kept.is_empty()).then_some(kept)
}

/// The web's answer to `read-selection://convert` for press `run`; an answer
/// for any other press (late, or from a second window) is dropped.
#[tauri::command]
pub fn read_selection_sentences(run: u64, sentences: Vec<String>) {
    let mut slot = CONVERTING.lock().unwrap_or_else(|p| p.into_inner());
    if slot.as_ref().is_some_and(|(waiting, _)| *waiting == run) {
        if let Some((_, tx)) = slot.take() {
            let _ = tx.send(sentences);
        }
    }
}

/// Speak `text`, [`AHEAD`] sentences at a time, until it ends or `run` is
/// no longer current (stopped, or replaced by a newer press). Text from a chat
/// or mail app reads as who said what when a window answers.
async fn read(app: &AppHandle, tts: &TtsService, run: u64, mut text: String, voice: Option<String>, app_id: &str) {
    if text.len() > MAX_SELECTION_BYTES {
        let mut cut = MAX_SELECTION_BYTES;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        crate::log_to_file(&format!("[read-selection] reading the first {cut} of {} bytes", text.len()));
        text.truncate(cut);
    }
    let from_chat = if reads_as_chat(app_id) { chat_sentences(app, run, &text, app_id).await } else { None };
    if RUN.load(Ordering::SeqCst) != run {
        return; // stopped while the web read it
    }
    let sentences = match from_chat {
        Some(sentences) => sentences,
        None => tauri::async_runtime::spawn_blocking(move || split::sentences(&text)).await.unwrap_or_default(),
    };
    if sentences.is_empty() {
        return;
    }

    let prefix = format!("{OWNER}-{run}-");
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let listener = {
        let prefix = prefix.clone();
        app.listen_any(tts::STATE_EVENT, move |event| {
            let Ok(payload) = serde_json::from_str::<StatePayload>(event.payload()) else { return };
            if payload.id.starts_with(&prefix) && matches!(payload.state.as_str(), "done" | "cancelled" | "error") {
                let _ = tx.send(payload.state);
            }
        })
    };

    let epoch = tts.claim(OWNER);
    let (mut queued, mut finished) = (0usize, 0usize);
    while finished < sentences.len() && RUN.load(Ordering::SeqCst) == run {
        while queued < sentences.len() && queued - finished < AHEAD {
            let sentence = sentences[queued].clone();
            let normalized = tauri::async_runtime::spawn_blocking(move || tts::normalize(&sentence))
                .await
                .unwrap_or_default();
            tts.speak_at(epoch, format!("{prefix}{queued}"), normalized, voice.clone());
            queued += 1;
        }
        match rx.recv().await.as_deref() {
            // Stopped (here, from a page, or by a recording starting).
            Some("cancelled") | None => break,
            // A sentence that failed is skipped, as the web reader does.
            Some(_) => finished += 1,
        }
    }
    app.unlisten(listener);
}

// ─── commands ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyOption {
    id: &'static str,
    label: &'static str,
}

/// What the settings page shows.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// This build can read selections (macOS).
    supported: bool,
    enabled: bool,
    /// The Accessibility permission is granted (reading selections; the
    /// feature can't be turned on without it).
    accessibility: bool,
    /// macOS lets Dial8 post key events: the ⌘C that reads terminals (Warp)
    /// and other apps that don't share their selection. The same System
    /// Settings switch grants it on macOS 27.
    keystrokes: bool,
    /// A preset id, or `"custom"`.
    hotkey: String,
    hotkey_label: String,
    hotkeys: Vec<HotkeyOption>,
    /// The recorded shortcut's label, when there is one (picked or not).
    custom_hotkey_label: Option<String>,
    /// `None`: the catalogue default.
    voice: Option<String>,
    /// The hotkey is on but couldn't be registered.
    hotkey_error: Option<String>,
}

fn status(app: &AppHandle) -> Status {
    let current = settings::read_selection(app);
    Status {
        supported: sys::SUPPORTED,
        enabled: current.enabled,
        accessibility: sys::trusted(false),
        keystrokes: sys::may_post(),
        hotkey: hotkey(&current).3,
        hotkey_label: hotkey(&current).2,
        hotkeys: HOTKEYS.iter().map(|h| HotkeyOption { id: h.id, label: h.label }).collect(),
        custom_hotkey_label: current.custom_hotkey.as_ref().map(|k| k.label.clone()),
        voice: current.voice,
        hotkey_error: HOTKEY_ERROR.lock().unwrap_or_else(|p| p.into_inner()).clone(),
    }
}

#[tauri::command]
pub fn read_selection_status(app: AppHandle) -> Status {
    status(&app)
}

/// Turning it on registers the hotkey. It needs the Accessibility permission
/// first ([`read_selection_request_access`]): without it, `needs_permission`.
#[tauri::command]
pub async fn read_selection_set_enabled(app: AppHandle, enabled: bool) -> Result<Status, String> {
    if !sys::SUPPORTED {
        return Err("unsupported".into());
    }
    if enabled && !sys::trusted(false) {
        return Err("needs_permission".into());
    }
    let current = ReadSelectionSettings { enabled, ..settings::read_selection(&app) };
    settings::set_read_selection(&app, &current);
    apply(&app, current).await;
    if !enabled {
        if let Some(tts) = app.try_state::<TtsService>() {
            stop(&tts);
        }
    }
    Ok(status(&app))
}

/// The settings page's "Allow access", the only place Dial8 asks:
/// - no Accessibility yet: macOS's prompt (shown once ever), else the pane;
/// - Accessibility but no key events: ask for those. A grant left from an
///   older build (pinned to that build's code hash, which no later build
///   matches) refuses without a prompt, so it is cleared and asked again,
///   then the pane is opened if that still fails.
#[tauri::command]
pub fn read_selection_request_access(app: AppHandle) -> Status {
    if !sys::trusted(false) {
        if !sys::trusted(true) {
            crate::permissions::open_accessibility_settings();
        }
        crate::log_to_file("[read-selection] asked for the Accessibility permission");
        return status(&app);
    }
    if !sys::request_post() {
        reset_post_event_grant();
        if !sys::request_post() {
            crate::permissions::open_accessibility_settings();
        }
    }
    crate::log_to_file(&format!("[read-selection] asked to post key events: {}", sys::may_post()));
    status(&app)
}

/// Drop this app's key-event grant (`tccutil reset PostEvent <bundle id>`),
/// so the next request makes a fresh one for this build's signature.
fn reset_post_event_grant() {
    #[cfg(target_os = "macos")]
    {
        let result = std::process::Command::new("/usr/bin/tccutil")
            .args(["reset", "PostEvent", "ai.dial8.desktop"])
            .output();
        let ok = result.as_ref().map(|o| o.status.success()).unwrap_or(false);
        crate::log_to_file(&format!("[read-selection] reset the key-event grant: {ok}"));
    }
}

/// A grant made while Dial8 runs can need a relaunch before macOS honors it.
/// `request_restart`, not `restart`: a sync command runs on the main thread,
/// where `restart()` skips the exit events, and with them the quit cleanup
/// (quit.rs) that finalizes a recording.
#[tauri::command]
pub fn read_selection_relaunch(app: AppHandle) {
    app.request_restart();
}

#[tauri::command]
pub async fn read_selection_set_hotkey(app: AppHandle, hotkey: String) -> Result<Status, String> {
    let current = settings::read_selection(&app);
    let known = HOTKEYS.iter().any(|h| h.id == hotkey) || (hotkey == CUSTOM_HOTKEY && current.custom_hotkey.is_some());
    if !known {
        return Err("unknown_hotkey".into());
    }
    switch_hotkey(&app, ReadSelectionSettings { hotkey, ..current }).await
}

/// What the user pressed while recording (`selection_capture_cb`).
struct Pressed {
    /// -1: fn alone; -3: cancelled.
    keycode: i32,
    modifiers: u32,
    fn_held: bool,
    typed: String,
}

/// A recording in progress: the window it's for, and its answer until the
/// press (or a cancel) takes it. The slot stays taken until the command that
/// claimed it has stopped the tap, so no later recording starts while this
/// one's tap could still answer it.
struct Recording {
    window: String,
    answer: Option<oneshot::Sender<Pressed>>,
}
static RECORDING: Mutex<Option<Recording>> = Mutex::new(None);
/// How long a recording waits for a press.
const RECORD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Take the recording slot for `window`; `"busy"` while another recording
/// holds it. One press per recording, one recording at a time.
fn claim_recording(slot: &mut Option<Recording>, window: &str, tx: oneshot::Sender<Pressed>) -> Result<(), String> {
    if slot.is_some() {
        return Err("busy".into());
    }
    *slot = Some(Recording { window: window.to_string(), answer: Some(tx) });
    Ok(())
}

/// Whether the recording in `slot` is for `window` and still waiting.
fn recording_for(slot: &Option<Recording>, window: &str) -> bool {
    slot.as_ref().is_some_and(|r| r.window == window && r.answer.is_some())
}

/// The waiting recording's answer, taken by its press; the slot stays held.
fn take_answer(slot: &mut Option<Recording>) -> Option<oneshot::Sender<Pressed>> {
    slot.as_mut()?.answer.take()
}

/// A recording starts only for a window the person is looking at and
/// typing in: visible and focused.
fn may_record(visible: bool, focused: bool) -> Result<(), &'static str> {
    if visible && focused {
        Ok(())
    } else {
        Err("not_focused")
    }
}

extern "C" fn on_pressed(keycode: i32, modifiers: u32, fn_held: bool, typed: *const std::os::raw::c_char) {
    let typed = if typed.is_null() {
        String::new()
    } else {
        unsafe { std::ffi::CStr::from_ptr(typed) }.to_string_lossy().into_owned()
    };
    if let Some(tx) = take_answer(&mut RECORDING.lock().unwrap_or_else(|p| p.into_inner())) {
        let _ = tx.send(Pressed { keycode, modifiers, fn_held, typed });
    }
}

/// A window lost focus (or went away; lib.rs, every window): a recording for
/// it stops (`"cancelled"`). Main thread.
pub fn on_window_blurred(app: &AppHandle, label: &str) {
    let ours = recording_for(&RECORDING.lock().unwrap_or_else(|p| p.into_inner()), label);
    if ours {
        let _ = app.run_on_main_thread(sys::capture_cancel);
    }
}

/// Wait for the user to press a shortcut (fn included; the key is
/// swallowed) and switch to it. The current shortcut is off meanwhile.
///
/// The tap sees every key on the Mac, so a recording is bounded (security
/// review 2026-10-31): it starts only for a visible window that has focus
/// (the settings page the person just clicked in), takes one press, and
/// stops when that window loses focus ([`on_window_blurred`]) or after
/// [`RECORD_TIMEOUT`]. A page can't keep it running behind the person's back
/// to read or swallow what they type elsewhere.
///
/// Errs with `"cancelled"` (Esc, `read_selection_cancel_record`, or the
/// window lost focus), `"timeout"`, `"no_tap"` (no permission),
/// `"not_focused"`, `"busy"` (a recording is already waiting), a
/// [`keys::Refusal`] code, or `"taken"` (macOS or another app holds it); the
/// code is followed by `:label` when there is one. The previous shortcut
/// stays on any error.
#[tauri::command]
pub async fn read_selection_record_hotkey(app: AppHandle, window: tauri::WebviewWindow) -> Result<Status, String> {
    let (tx, rx) = oneshot::channel();
    claim_recording(&mut RECORDING.lock().unwrap_or_else(|p| p.into_inner()), window.label(), tx)?;
    let (began_tx, began_rx) = oneshot::channel();
    let _ = app.run_on_main_thread(move || {
        // On the main thread, where a blur is handled too: the window can't
        // lose focus between this check and the tap starting unseen.
        if let Err(why) = may_record(window.is_visible().unwrap_or(false), window.is_focused().unwrap_or(false)) {
            let _ = began_tx.send(Err(why));
            return;
        }
        sys::unregister();
        sys::unregister_fn();
        let _ = began_tx.send(if sys::capture_begin(on_pressed) == 0 { Ok(()) } else { Err("no_tap") });
    });
    let outcome = match began_rx.await.unwrap_or(Err("no_tap")) {
        Ok(()) => match tokio::time::timeout(RECORD_TIMEOUT, rx).await {
            Ok(Ok(pressed)) => Ok(pressed),
            Ok(Err(_)) => Err("cancelled".to_string()),
            Err(_) => Err("timeout".to_string()),
        },
        Err(why) => Err(why.to_string()),
    };
    // A press only took the answer: the slot is still this call's. Free it
    // once the tap has stopped, so no later recording can start while this
    // one's tap (or this cancel) could still answer it.
    let (stopped_tx, stopped_rx) = oneshot::channel();
    let _ = app.run_on_main_thread(move || {
        sys::capture_cancel();
        let _ = stopped_tx.send(());
    });
    let _ = stopped_rx.await;
    *RECORDING.lock().unwrap_or_else(|p| p.into_inner()) = None;

    let current = settings::read_selection(&app);
    let result = outcome.and_then(|p| {
        if p.keycode == -3 {
            return Err("cancelled".to_string());
        }
        let keycode = (p.keycode >= 0).then_some(p.keycode as u32);
        keys::custom(keycode, p.modifiers, p.fn_held, &p.typed).map_err(|r| {
            let held = keys::modifier_label(p.modifiers | if p.fn_held { keys::FN } else { 0 });
            format!("{}:{held}", r.code())
        })
    });
    match result {
        Ok(recorded) => {
            let label = recorded.label.clone();
            switch_hotkey(
                &app,
                ReadSelectionSettings { hotkey: CUSTOM_HOTKEY.to_string(), custom_hotkey: Some(recorded), ..current },
            )
            .await
            .map_err(|e| format!("{e}:{label}"))
        }
        Err(e) => {
            // Back to the shortcut there was.
            apply(&app, current).await;
            Err(e)
        }
    }
}

/// Stop a recording; it answers `"cancelled"`.
#[tauri::command]
pub fn read_selection_cancel_record(app: AppHandle) {
    let _ = app.run_on_main_thread(sys::capture_cancel);
}

/// Save `next` and register its shortcut. When macOS refuses it, the
/// previous settings and shortcut come back and the answer is `"taken"`.
async fn switch_hotkey(app: &AppHandle, next: ReadSelectionSettings) -> Result<Status, String> {
    let previous = settings::read_selection(app);
    settings::set_read_selection(app, &next);
    if next.enabled {
        apply(app, next).await;
        if HOTKEY_ERROR.lock().unwrap_or_else(|p| p.into_inner()).is_some() {
            settings::set_read_selection(app, &previous);
            apply(app, previous).await;
            return Err("taken".into());
        }
    }
    Ok(status(app))
}

#[tauri::command]
pub fn read_selection_set_voice(app: AppHandle, voice: Option<String>) -> Status {
    let current = ReadSelectionSettings { voice, ..settings::read_selection(&app) };
    settings::set_read_selection(&app, &current);
    status(&app)
}

#[tauri::command]
pub fn read_selection_open_accessibility_settings() {
    crate::permissions::open_accessibility_settings();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_and_mail_apps_read_as_who_said_what() {
        for id in ["com.microsoft.teams2", "com.microsoft.Outlook", "com.tinyspeck.slackmacgap", "com.hnc.Discord"] {
            assert!(reads_as_chat(id), "{id}");
        }
        for id in ["com.apple.Safari", "dev.warp.Warp-Stable", "com.google.Chrome", ""] {
            assert!(!reads_as_chat(id), "{id}");
        }
    }

    #[test]
    fn the_webs_sentences_are_kept_without_blanks() {
        assert_eq!(
            kept_sentences(vec!["Ann said: Hi.".into(), "  ".into(), " Bob then said: Hello. ".into()]),
            Some(vec!["Ann said: Hi.".to_string(), "Bob then said: Hello.".to_string()])
        );
        assert_eq!(kept_sentences(vec![]), None, "[]: read it plainly");
        assert_eq!(kept_sentences(vec!["".into(), " ".into()]), None);
        let long = vec!["x".repeat(MAX_SELECTION_BYTES); 5];
        assert_eq!(kept_sentences(long).map(|s| s.len()), Some(2), "within twice a selection");
        // A run-on with nowhere to pause is cut as the splitter cuts its own
        // (review of #79): 150 words → 60 + 60 + 30.
        let run_on = std::iter::repeat("word").take(150).collect::<Vec<_>>().join(" ");
        let pieces = kept_sentences(vec![format!("Ann said: {run_on}")]).unwrap();
        assert_eq!(pieces.len(), 3, "{pieces:?}");
        assert!(pieces.iter().all(|p| p.split(' ').count() <= 60));
    }

    #[test]
    fn one_recording_at_a_time_for_one_window() {
        let mut slot = None;
        let (tx, _rx) = oneshot::channel();
        claim_recording(&mut slot, "main", tx).unwrap();
        let (again, _rx2) = oneshot::channel();
        assert_eq!(claim_recording(&mut slot, "workspace-1", again), Err("busy".to_string()));
        assert!(recording_for(&slot, "main"), "the first one's");
        assert!(!recording_for(&slot, "workspace-1"), "another window's blur doesn't stop it");
    }

    /// The press takes the answer, not the slot: until the first call has
    /// stopped its tap and freed the slot, a second recording can't start
    /// (and so can't be cancelled by the first one's cleanup).
    #[test]
    fn the_slot_frees_only_after_its_call_cleans_up() {
        let mut slot = None;
        let (tx, mut rx) = oneshot::channel();
        claim_recording(&mut slot, "main", tx).unwrap();
        let answer = take_answer(&mut slot).expect("the press answers");
        let _ = answer.send(Pressed { keycode: 15, modifiers: 0, fn_held: false, typed: "r".into() });
        assert_eq!(rx.try_recv().unwrap().keycode, 15);
        assert!(take_answer(&mut slot).is_none(), "one press per recording");
        assert!(!recording_for(&slot, "main"), "nothing left to cancel");
        let (next, _rx2) = oneshot::channel();
        assert_eq!(claim_recording(&mut slot, "main", next), Err("busy".to_string()), "before cleanup");
        slot = None; // the first call's cleanup, after the tap stopped
        let (next, _rx3) = oneshot::channel();
        claim_recording(&mut slot, "main", next).unwrap();
    }

    #[test]
    fn only_a_visible_focused_window_records() {
        assert_eq!(may_record(true, true), Ok(()));
        for (visible, focused) in [(true, false), (false, true), (false, false)] {
            assert_eq!(may_record(visible, focused), Err("not_focused"), "visible={visible} focused={focused}");
        }
        assert!(RECORD_TIMEOUT <= std::time::Duration::from_secs(10));
    }

    /// Wiring a unit test can't reach without a running app, so pinned as
    /// source text: the command takes its calling window (whose focus
    /// [`may_record`] decides), and lib.rs stops a recording on that window's
    /// blur.
    #[test]
    fn the_recorder_is_wired_to_its_window() {
        let src = include_str!("read_selection.rs");
        assert!(src.contains("pub async fn read_selection_record_hotkey(app: AppHandle, window: tauri::WebviewWindow)"));
        assert!(src.contains("may_record(window.is_visible().unwrap_or(false), window.is_focused().unwrap_or(false))"));
        let lib_rs = include_str!("lib.rs");
        assert!(lib_rs.contains("crate::read_selection::on_window_blurred(window.app_handle(), window.label())"));
    }

    #[test]
    fn only_the_waiting_press_gets_the_answer() {
        let (tx, mut rx) = oneshot::channel();
        *CONVERTING.lock().unwrap() = Some((5, tx));
        read_selection_sentences(4, vec!["late".into()]);
        assert!(rx.try_recv().is_err(), "an older press's answer is dropped");
        assert!(CONVERTING.lock().unwrap().is_some(), "still waiting");
        read_selection_sentences(5, vec!["Ann said: Hi.".into()]);
        assert_eq!(rx.try_recv().unwrap(), vec!["Ann said: Hi.".to_string()]);
        assert!(CONVERTING.lock().unwrap().is_none());
        read_selection_sentences(5, vec!["again".into()]); // a second window: nothing waits
    }
}
