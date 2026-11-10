//! Dictate anywhere (web/docs/plans/dictate-anywhere.md): tap the
//! RIGHT Option key, talk, tap it again, and what was said is pasted where the
//! cursor is, in any app.
//!
//! - **The key** (native/dictate_helper.m): a listen-only event tap, so nothing
//!   is swallowed. Only a clean tap of right ⌥ counts: pressed alone and let go
//!   within 0.6 s, no other key, modifier or click meanwhile. Left ⌥, a long
//!   hold, right ⌥ typing a character (⌥E, AltGr) never do. Esc cancels.
//! - **The words**: the `dictate` panel, a small floating web page
//!   (`{origin}/hud/dictate`), non-activating so the app being typed in keeps
//!   focus. Its page runs the same dictation as the chat box (local-stt, the
//!   vocabulary correction, its log lines) and hands the text back. It may
//!   open the mic only to dictate, while a press is listening, and its session
//!   ends here when the press is over ([`press_end`]).
//! - **The paste**: ⌘V into the app that was in front at the first tap, with a
//!   space first when the cursor follows a word, and the clipboard put back.
//!   A password field, another app in front, or no key permission: the text is
//!   copied instead, and the panel says so. Only the panel's, for the
//!   person's latest dictation, once (the page is the server's code: security
//!   review 2026-10-31 P1-4); any other paste is refused, nothing copied. Always
//!   on one line: a line break pasted into a terminal is Return.
//!
//! Off until turned on in Settings (`dictate_set_enabled`), with the
//! Accessibility permission Read aloud already asks for.
//!
//! Commands: `dictate_status`, `dictate_set_enabled { enabled }`; for the
//! panel, `dictate_state`, `dictate_phase { run, phase }` and
//! `dictate_paste { run, text }`. Event to the panel:
//! `dictate://toggle { run, action: "start" | "stop" | "cancel" }`.

use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::settings::{self, DictateSettings};

/// The panel window's label.
pub const PANEL: &str = "dictate";
const TOGGLE_EVENT: &str = "dictate://toggle";
/// The card itself (two lines of words): the window is exactly the card, so the
/// native glass behind it (`build_panel`) has the card's size and corners.
const PANEL_W: f64 = 390.0;
const PANEL_H: f64 = 66.0;
/// The card's corner radius, for the glass and the page alike (/hud/dictate).
const PANEL_RADIUS: f64 = 18.0;
/// The card's smallest size ("Listening…"): it starts there and grows with the
/// words (`dictate_panel_size`), up to PANEL_W × PANEL_H (two lines).
const PANEL_MIN_W: f64 = 112.0;
const PANEL_MIN_H: f64 = 46.0;
/// A held press's conversation is a circle this size (/hud/dictate CIRCLE),
/// the smallest the page may ask for.
const PANEL_CIRCLE: f64 = 104.0;
/// The glass's corner radius now: the card's, or the circle's (half its size).
/// Space between the panel and the top of the Dock (or the screen's bottom
/// when the Dock is hidden or elsewhere), at the panel's lowest: the circle,
/// which widens out from the card's middle (dictate_resize_window) and so
/// reaches below the card's bottom edge.
const PANEL_DOCK_GAP: f64 = 12.0;
/// From the usable area's bottom to the card's bottom edge: room for the
/// circle's overhang below it, plus the gap.
const PANEL_BOTTOM_GAP: f64 = PANEL_DOCK_GAP + (PANEL_CIRCLE - PANEL_MIN_H) / 2.0;
/// Where the card grows from: the centre of its bottom edge, set at each start.
static PANEL_ANCHOR: Mutex<(f64, f64)> = Mutex::new((600.0, 760.0));
/// From the first tap to the panel saying it listens: a cold panel (page load,
/// vocabulary) plus local-stt's start. Past it the tap gives up with a beep.
const START_TIMEOUT: Duration = Duration::from_secs(8);
/// From the second tap to the paste (the dictation's own stop wait is 5.5 s).
const STOP_TIMEOUT: Duration = Duration::from_secs(8);

/// A press held this long goes to the agent; released sooner, it's a tap (dictation).
pub const HOLD_AFTER: Duration = Duration::from_millis(800);
/// A clean press starts listening this far in (a quick tap, at its release), so
/// right ⌥ typing a character (⌥E, AltGr) never opens the mic.
pub const LISTEN_AFTER: Duration = Duration::from_millis(200);
/// From sending to the agent to the main window saying it took the words.
const TALK_ACK_TIMEOUT: Duration = Duration::from_secs(4);

static APP: OnceLock<AppHandle> = OnceLock::new();
/// Where the key and the panel are ([`Mode`]).
static MODE: Mutex<Mode> = Mutex::new(Mode::Idle);
/// Keys and timers, handled one at a time and in order ([`handle`]).
static KEYS: OnceLock<tokio::sync::mpsc::UnboundedSender<Key>> = OnceLock::new();
/// The last talk run the main window answered for.
static TALK_ACK_RUN: AtomicU64 = AtomicU64::new(0);
/// Bumped by every press that starts something: the panel's answers name the run they belong to.
static RUN: AtomicU64 = AtomicU64::new(0);
static LISTENING_RUN: AtomicU64 = AtomicU64::new(0);
/// The last press that turned out a tap (dictation): the only run that pastes.
static DICTATION_RUN: AtomicU64 = AtomicU64::new(0);
/// The last run whose words were taken for a paste (or cancelled): each dictation pastes once.
static PASTED_RUN: AtomicU64 = AtomicU64::new(0);
/// The app in front at the first tap: where the words go.
static TARGET_PID: AtomicI32 = AtomicI32::new(0);
/// Why the key can't be watched, while the feature is on.
static TAP_ERROR: Mutex<Option<String>> = Mutex::new(None);

// ─── native ─────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod sys {
    use std::ffi::CString;
    use std::os::raw::c_char;

    extern "C" {
        fn dictate_tap_start(cb: extern "C" fn(i32)) -> i32;
        fn dictate_tap_stop();
        fn dictate_set_capture_escape(on: bool);
        fn dictate_frontmost_pid() -> i32;
        fn dictate_char_before_caret(pid: i32) -> i32;
        fn dictate_paste(pid: i32, text: *const c_char) -> i32;
        fn dictate_accessibility_trusted() -> bool;
        fn dictate_may_post_keys() -> bool;
        fn dictate_beep();
        fn dictate_window_class_chain(ns_window: *mut std::ffi::c_void) -> *mut c_char;
        fn dictate_resize_window(ns_window: *mut std::ffi::c_void, width: f64, height: f64, radius: f64);
        fn dictate_watch_hover(ns_window: *mut std::ffi::c_void, cb: extern "C" fn(i32));
        fn dictate_set_glass_radius(ns_window: *mut std::ffi::c_void, radius: f64);
        fn dictate_hide_window(ns_window: *mut std::ffi::c_void, return_pid: i32) -> i32;
        fn dictate_watch_begin(pid: i32) -> i32;
        fn dictate_watch_read() -> *mut c_char;
        fn dictate_watch_end();
        fn free(p: *mut std::ffi::c_void);
    }

    /// Remember the focused field before a paste; its caret (UTF-16 offset). Main thread only.
    pub fn watch_begin(pid: i32) -> Option<usize> {
        let c = unsafe { dictate_watch_begin(pid) };
        (c >= 0).then_some(c as usize)
    }

    /// That field's text now, while it's still the focused field in front. Main thread only.
    pub fn watch_read() -> Option<String> {
        let p = unsafe { dictate_watch_read() };
        if p.is_null() {
            return None;
        }
        let s = unsafe { std::ffi::CStr::from_ptr(p) }.to_string_lossy().into_owned();
        unsafe { free(p as *mut std::ffi::c_void) };
        Some(s)
    }

    /// Main thread only.
    pub fn watch_end() {
        unsafe { dictate_watch_end() }
    }

    /// Main thread only.
    pub fn resize_window(ns_window: *mut std::ffi::c_void, width: f64, height: f64, radius: f64) {
        unsafe { dictate_resize_window(ns_window, width, height, radius) }
    }

    /// Main thread only.
    pub fn watch_hover(ns_window: *mut std::ffi::c_void, cb: extern "C" fn(i32)) {
        unsafe { dictate_watch_hover(ns_window, cb) }
    }

    /// Main thread only.
    pub fn hide_window(ns_window: *mut std::ffi::c_void, return_pid: i32) -> i32 {
        unsafe { dictate_hide_window(ns_window, return_pid) }
    }

    /// Main thread only.
    pub fn set_glass_radius(ns_window: *mut std::ffi::c_void, radius: f64) {
        unsafe { dictate_set_glass_radius(ns_window, radius) }
    }

    pub fn class_chain(ns_window: *mut std::ffi::c_void) -> String {
        let p = unsafe { dictate_window_class_chain(ns_window) };
        if p.is_null() {
            return String::new();
        }
        let s = unsafe { std::ffi::CStr::from_ptr(p) }.to_string_lossy().into_owned();
        unsafe { free(p as *mut std::ffi::c_void) };
        s
    }

    pub const SUPPORTED: bool = true;

    /// Main thread only.
    pub fn tap_start(cb: extern "C" fn(i32)) -> bool {
        unsafe { dictate_tap_start(cb) == 0 }
    }
    /// Main thread only.
    pub fn tap_stop() {
        unsafe { dictate_tap_stop() }
    }
    pub fn capture_escape(on: bool) {
        unsafe { dictate_set_capture_escape(on) }
    }
    pub fn frontmost_pid() -> i32 {
        unsafe { dictate_frontmost_pid() }
    }
    pub fn char_before_caret(pid: i32) -> Option<char> {
        let c = unsafe { dictate_char_before_caret(pid) };
        if c < 0 {
            None
        } else {
            char::from_u32(c as u32)
        }
    }
    fn c_text(text: &str) -> CString {
        CString::new(text.replace('\0', "")).unwrap_or_default()
    }
    /// One of dictate_helper.h's DICTATE_PASTE_* codes.
    pub fn paste(pid: i32, text: &str) -> i32 {
        let t = c_text(text);
        unsafe { dictate_paste(pid, t.as_ptr()) }
    }
    pub fn trusted() -> bool {
        unsafe { dictate_accessibility_trusted() }
    }
    pub fn may_post() -> bool {
        unsafe { dictate_may_post_keys() }
    }
    pub fn beep() {
        unsafe { dictate_beep() }
    }
}

#[cfg(not(target_os = "macos"))]
mod sys {
    pub const SUPPORTED: bool = false;
    pub fn tap_start(_cb: extern "C" fn(i32)) -> bool {
        false
    }
    pub fn tap_stop() {}
    pub fn capture_escape(_on: bool) {}
    pub fn frontmost_pid() -> i32 {
        0
    }
    pub fn char_before_caret(_pid: i32) -> Option<char> {
        None
    }
    pub fn paste(_pid: i32, _text: &str) -> i32 {
        -3
    }
    pub fn watch_begin(_pid: i32) -> Option<usize> {
        None
    }
    pub fn watch_read() -> Option<String> {
        None
    }
    pub fn watch_end() {}
    pub fn trusted() -> bool {
        false
    }
    pub fn may_post() -> bool {
        false
    }
    pub fn beep() {}
}

const EVENT_ESCAPE: i32 = 2;
const EVENT_DOWN: i32 = 3;
const EVENT_UP_CLEAN: i32 = 4;
const EVENT_UP_DIRTY: i32 = 5;
const EVENT_DIRTY: i32 = 6;

// ─── the key machine ────────────────────────────────────────────────────────

/// Where the key and the panel are.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Idle,
    /// Pressed from idle; `listening` once [`LISTEN_AFTER`] has passed (the card is up).
    Pressed { run: u64, listening: bool },
    /// A tap: dictation, listening until the next press.
    Dictating { run: u64 },
    /// Pressed while dictating: its release ends the dictation.
    StopPress { run: u64 },
    /// The dictation is ending: waiting for the panel's paste.
    Pasting { run: u64 },
    /// Held: listening, and the words go to the agent on release.
    Holding { run: u64 },
    /// The circle: the agent thinking or speaking, then waiting for the next
    /// hold. Never listening, so no noise can interrupt.
    Circle { run: u64 },
}

impl Mode {
    /// Esc is ours (it never reaches the app in front) whenever something is up.
    fn claims_escape(self) -> bool {
        !matches!(self, Mode::Idle | Mode::Pasting { .. } | Mode::Pressed { listening: false, .. })
    }
}

/// What reaches the machine: the key watcher's reports and the press's timers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Down,
    UpClean,
    UpDirty,
    /// Another key, modifier or click while right ⌥ is held.
    Dirty,
    Escape,
    ListenTimer(u64),
    HoldTimer(u64),
}

/// What the machine asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Act {
    /// A new press: remember the app in front, start its timers.
    Press { run: u64 },
    /// Show the card and listen; `agent`: the words go to the agent.
    Listen { run: u64, agent: bool },
    /// The press became a hold: the words go to the agent.
    ToAgent { run: u64 },
    /// The press was a tap: it's dictation (the circle, if up, becomes the card).
    Tapped { run: u64 },
    /// End the dictation: the words are pasted.
    StopDictation { run: u64 },
    /// Send the words to the agent; the card becomes the circle.
    Send { run: u64 },
    /// Stop listening; nothing pasted or sent; the panel goes.
    Cancel { run: u64 },
    /// Cut the agent's reply (to `run`) short.
    Interrupt { run: u64 },
    /// Close the circle.
    Close { run: u64 },
}

/// The key machine (docs/plans/talk-anywhere.md §3.1): what a key does in a
/// mode. A tap is dictation; a hold of [`HOLD_AFTER`] talks to the agent; a
/// press while the circle is up cuts the reply and talks again at once; Esc
/// cancels, or closes the circle. `next_run` is the run a new press gets. Pure.
pub fn step(mode: Mode, key: Key, next_run: u64) -> (Mode, Vec<Act>) {
    use Mode::*;
    match (mode, key) {
        (Idle, Key::Down) => (Pressed { run: next_run, listening: false }, vec![Act::Press { run: next_run }]),
        (Pressed { run, listening: false }, Key::ListenTimer(r)) if r == run => {
            (Pressed { run, listening: true }, vec![Act::Listen { run, agent: false }])
        }
        (Pressed { run, listening }, Key::HoldTimer(r)) if r == run => {
            let mut acts = Vec::new();
            if !listening {
                acts.push(Act::Listen { run, agent: false });
            }
            acts.push(Act::ToAgent { run });
            (Holding { run }, acts)
        }
        (Pressed { run, listening }, Key::UpClean) => {
            let mut acts = if listening { vec![] } else { vec![Act::Listen { run, agent: false }] };
            acts.push(Act::Tapped { run });
            (Dictating { run }, acts)
        }
        (Pressed { run, listening }, Key::UpDirty | Key::Dirty | Key::Escape) => {
            (Idle, if listening { vec![Act::Cancel { run }] } else { vec![] })
        }
        (Dictating { run }, Key::Down) => (StopPress { run }, vec![]),
        (Dictating { run } | StopPress { run }, Key::Escape) => (Idle, vec![Act::Cancel { run }]),
        (StopPress { run }, Key::UpClean | Key::UpDirty) => (Pasting { run }, vec![Act::StopDictation { run }]),
        (Holding { run }, Key::UpClean) => (Circle { run }, vec![Act::Send { run }]),
        (Holding { run }, Key::UpDirty | Key::Dirty | Key::Escape) => (Idle, vec![Act::Cancel { run }]),
        // Any press on the circle cuts the reply and listens at once (the panel
        // is already up): a quick tap dictates and pastes, a hold talks to the
        // agent again, in the same home thread.
        (Circle { run }, Key::Down) => (
            Pressed { run: next_run, listening: true },
            vec![Act::Interrupt { run }, Act::Press { run: next_run }, Act::Listen { run: next_run, agent: false }],
        ),
        (Circle { run }, Key::Escape) => (Idle, vec![Act::Interrupt { run }, Act::Close { run }]),
        (m, _) => (m, vec![]),
    }
}

/// Whether webview `label` may paste `run`'s words now (security review
/// 2026-10-31 P1-4: the panel's page is the server's code): only the panel,
/// only for the person's latest press (`current`) and only if it was a tap
/// (`dictation`: the agent's hold never pastes), once (`pasted`: the last run
/// that pasted, or was cancelled). Until the next press, so words that come
/// late (past STOP_TIMEOUT) still land. Pure.
pub fn may_paste(label: &str, run: u64, current: u64, dictation: u64, pasted: u64) -> bool {
    label == PANEL && run == current && run == dictation && run > pasted
}

/// The press is listening, or a dictation of it is ending: the panel may open
/// the mic (voice_start's gate for the panel, voice/commands.rs). Never idle,
/// before the press is a clean one, or in the circle (it never listens).
pub fn mic_wanted() -> bool {
    matches!(
        mode(),
        Mode::Pressed { listening: true, .. } | Mode::Dictating { .. } | Mode::StopPress { .. } | Mode::Pasting { .. } | Mode::Holding { .. }
    )
}

/// The run a panel answer must name to count: the current mode's.
fn mode_run(mode: Mode) -> Option<u64> {
    match mode {
        Mode::Idle => None,
        Mode::Pressed { run, .. }
        | Mode::Dictating { run }
        | Mode::StopPress { run }
        | Mode::Pasting { run }
        | Mode::Holding { run }
        | Mode::Circle { run } => Some(run),
    }
}

fn set_mode(mode: Mode) {
    let before = std::mem::replace(&mut *MODE.lock().unwrap_or_else(|p| p.into_inner()), mode);
    sys::capture_escape(mode.claims_escape());
    end_panel_voice(before, mode);
}

/// How the panel's voice session ends when the press is over ([`press_end`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PressEnd {
    /// Gracefully: a dictation finalizes and keeps its words (a repeated stop does nothing).
    Stop,
    /// At once, nothing kept.
    Cancel,
}

/// The press is over (security review 2026-10-31 P1-5: the panel listens
/// unseen, so its mic never outlives the press): idle, or the circle, which
/// never listens. Gracefully when the words are on their way (a hold's to the
/// agent, a dictation's that STOP_TIMEOUT idled while it was being pasted),
/// else cancelled (Esc, a press that wasn't clean, a panel that never
/// started, done). None while the press goes on. Pure.
pub fn press_end(before: Mode, after: Mode) -> Option<PressEnd> {
    match (before, after) {
        (Mode::Idle, _) | (Mode::Circle { .. }, Mode::Circle { .. }) => None,
        (_, Mode::Circle { .. }) | (Mode::Pasting { .. }, Mode::Idle) => Some(PressEnd::Stop),
        (_, Mode::Idle) => Some(PressEnd::Cancel),
        _ => None,
    }
}

/// End the panel's voice session, if it still has one, when the press is over ([`press_end`]).
fn end_panel_voice(before: Mode, after: Mode) {
    let Some(end) = press_end(before, after) else { return };
    let Some(voice) = APP.get().and_then(|app| app.try_state::<crate::voice::VoiceService>()) else { return };
    let ctl = match end {
        PressEnd::Stop => crate::voice::Ctl::Stop,
        PressEnd::Cancel => crate::voice::Ctl::Cancel,
    };
    if voice.send_owned(PANEL, ctl) {
        crate::log_to_file(&format!("[dictate] the press is over ({before:?} → {after:?}): the panel's voice session ends ({end:?})"));
    }
}

fn mode() -> Mode {
    *MODE.lock().unwrap_or_else(|p| p.into_inner())
}

/// Feed the machine (from any thread): handled in order by [`handle`].
fn feed(key: Key) {
    if let Some(tx) = KEYS.get() {
        let _ = tx.send(key);
    }
}

/// One key or timer through the machine, then what it asks for.
fn handle(app: &AppHandle, key: Key) {
    let next = RUN.load(Ordering::SeqCst) + 1;
    let (before, after, acts) = {
        let mut m = MODE.lock().unwrap_or_else(|p| p.into_inner());
        let before = *m;
        let (after, acts) = step(before, key, next);
        *m = after;
        (before, after, acts)
    };
    sys::capture_escape(after.claims_escape());
    if before != after {
        crate::log_to_file(&format!("[dictate] {before:?} --{key:?}--> {after:?}"));
    }
    for act in acts {
        perform(app, act);
    }
    end_panel_voice(before, after);
}

#[derive(Clone, Serialize)]
struct Toggle {
    run: u64,
    /// "start", "start_agent", "to_agent", "tapped", "stop", "send", "cancel" or "close".
    action: &'static str,
}

fn emit_panel(app: &AppHandle, run: u64, action: &'static str) {
    let _ = app.emit_to(PANEL, TOGGLE_EVENT, Toggle { run, action });
}

fn perform(app: &AppHandle, act: Act) {
    match act {
        Act::Press { run } => {
            // A "learned" note up: the press takes the panel from it.
            if FLASHING.swap(false, Ordering::SeqCst) {
                hide_panel(app);
            }
            RUN.store(run, Ordering::SeqCst);
            TARGET_PID.store(sys::frontmost_pid(), Ordering::SeqCst);
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(LISTEN_AFTER).await;
                feed(Key::ListenTimer(run));
                tokio::time::sleep(HOLD_AFTER - LISTEN_AFTER).await;
                feed(Key::HoldTimer(run));
            });
        }
        Act::Listen { run, agent } => {
            RUN.fetch_max(run, Ordering::SeqCst);
            if !sys::trusted() {
                crate::log_to_file("[dictate] no Accessibility permission");
                sys::beep();
                set_mode(Mode::Idle);
                return;
            }
            crate::log_to_file(&format!("[dictate] {run} listening{}", if agent { " (to the agent)" } else { "" }));
            // Listening starts now, so no word is lost, but nothing shows till
            // the press is known (Liam 10-25): a tap shows the card when it's
            // let go (Tapped), a hold the agent's circle at once (ToAgent),
            // with no card first and no morph between. A press in a
            // conversation finds the circle already up.
            if agent {
                show_panel(app, PanelShape::Circle);
            } else {
                ensure_panel(app);
            }
            emit_panel(app, run, if agent { "start_agent" } else { "start" });
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(START_TIMEOUT).await;
                if LISTENING_RUN.load(Ordering::SeqCst) != run && mode_run(mode()) == Some(run) {
                    crate::log_to_file(&format!("[dictate] {run} gave up: the panel never started listening"));
                    sys::beep();
                    set_mode(Mode::Idle);
                    emit_panel(&app, run, "cancel");
                    hide_panel(&app);
                }
            });
        }
        Act::ToAgent { run } => {
            show_panel(app, PanelShape::Circle);
            emit_panel(app, run, "to_agent");
        }
        Act::Tapped { run } => {
            DICTATION_RUN.fetch_max(run, Ordering::SeqCst);
            show_panel(app, PanelShape::Card);
            emit_panel(app, run, "tapped");
        }
        Act::StopDictation { run } => {
            emit_panel(app, run, "stop");
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(STOP_TIMEOUT).await;
                if mode() == (Mode::Pasting { run }) {
                    crate::log_to_file(&format!("[dictate] {run} gave up: no text from the panel"));
                    set_mode(Mode::Idle);
                    hide_panel(&app);
                }
            });
        }
        Act::Send { run } => emit_panel(app, run, "send"),
        Act::Cancel { run } => {
            // Cancelled (Esc): its words never paste.
            PASTED_RUN.fetch_max(run, Ordering::SeqCst);
            emit_panel(app, run, "cancel");
            hide_panel(app);
        }
        Act::Interrupt { run } => {
            let _ = app.emit_to("main", TALK_INTERRUPT_EVENT, TalkRun { run });
        }
        Act::Close { run } => {
            emit_panel(app, run, "close");
            hide_panel(app);
        }
    }
}

// ─── pure ───────────────────────────────────────────────────────────────────

/// The text as pasted: a space first when the cursor follows a word or the end
/// of a sentence ("…the APIM" + "team" → " team"), never at the start of a
/// field, after a space or an opening bracket, or before punctuation.
pub fn with_leading_space(before: Option<char>, text: &str) -> String {
    let starts_with_word = text.chars().next().is_some_and(|c| c.is_alphanumeric());
    let needs = before.is_some_and(|c| c.is_alphanumeric() || ".,!?:;)]}\"'”’…".contains(c));
    if starts_with_word && needs {
        format!(" {text}")
    } else {
        text.to_string()
    }
}

/// The words on one line, into whatever app (security review 2026-10-31
/// P1-4): a line break pasted into a terminal is Return, which runs what's
/// typed, and which app (or which of an editor's panes) is a terminal can't be
/// told from outside. So every line break and tab is a space, no other control
/// character at all (an Esc could end a shell's bracketed paste and let a line
/// break through as Return), and spaces run together. Dictation itself has no
/// line breaks (there's no "new line" command), so the person's words land as
/// they said them; a page's can't run anything (they still press Return). Pure.
pub fn one_line(text: &str) -> String {
    let spaced: String = text
        .chars()
        .filter_map(|c| match c {
            '\n' | '\r' | '\t' | '\u{0B}' | '\u{0C}' | '\u{85}' | '\u{2028}' | '\u{2029}' => Some(' '),
            c if c.is_control() => None,
            c => Some(c),
        })
        .collect();
    spaced.split(' ').filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ")
}

/// What a paste code means for the panel: (pasted, why not).
pub fn paste_outcome(code: i32) -> (bool, Option<&'static str>) {
    match code {
        0 => (true, None),
        -1 => (false, Some("secure_input")),
        -2 => (false, Some("focus_changed")),
        _ => (false, Some("no_keys")),
    }
}

// ─── the key ────────────────────────────────────────────────────────────────

/// Watch the key if the feature is on. Call once, on the main thread, in setup().
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Key>();
    if KEYS.set(tx).is_ok() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(key) = rx.recv().await {
                handle(&app, key);
            }
        });
    }
    if settings::dictate(app).enabled {
        set_tap_error(start_tap_now());
        prepare_panel(app);
    }
}

/// Build the panel, hidden, ahead of the first tap: its page (and the
/// vocabulary) load now, so the first dictation starts as fast as the rest.
fn prepare_panel(app: &AppHandle) {
    if app.get_webview_window(PANEL).is_none() {
        *PANEL_ANCHOR.lock().unwrap_or_else(|p| p.into_inner()) = panel_anchor(app);
        let (x, y) = panel_origin(PANEL_MIN_W, PANEL_MIN_H);
        let _ = build_panel(app, x, y);
    }
}

/// Start the tap, on the main thread. Returns the error.
fn start_tap_now() -> Option<String> {
    if !sys::trusted() {
        crate::log_to_file("[dictate] needs the Accessibility permission: right ⌥ not watched");
        return Some("needs_permission".into());
    }
    if sys::tap_start(on_key) {
        crate::log_to_file("[dictate] watching right ⌥");
        None
    } else {
        crate::log_to_file("[dictate] no event tap: right ⌥ not watched");
        Some("no_event_tap".into())
    }
}

fn set_tap_error(error: Option<String>) {
    *TAP_ERROR.lock().unwrap_or_else(|p| p.into_inner()) = error;
}

/// Called by the tap, on the main thread: hand off at once. The tap is active
/// (it can keep Esc back), so every keystroke on the Mac waits while this runs.
extern "C" fn on_key(event: i32) {
    let key = match event {
        EVENT_DOWN => Key::Down,
        EVENT_UP_CLEAN => Key::UpClean,
        EVENT_UP_DIRTY => Key::UpDirty,
        EVENT_DIRTY => Key::Dirty,
        EVENT_ESCAPE => Key::Escape,
        _ => return,
    };
    feed(key);
}

// ─── the panel ──────────────────────────────────────────────────────────────

/// The centre of the card's bottom edge on the screen the pointer is on, in
/// logical pixels: it grows up and out from there. Above the Dock: from the
/// screen's work area (macOS's visible frame, without the Dock and the menu
/// bar), read afresh at each press, so it follows the Dock's size, its side
/// and whether it's hidden.
fn panel_anchor(app: &AppHandle) -> (f64, f64) {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let scale = m.scale_factor();
        let area = m.work_area();
        return anchor_in(
            area.position.x as f64 / scale,
            area.position.y as f64 / scale,
            area.size.width as f64 / scale,
            area.size.height as f64 / scale,
        );
    }
    (600.0, 760.0)
}

/// The anchor in a usable area (left, top, width, height; logical pixels).
pub fn anchor_in(x: f64, y: f64, width: f64, height: f64) -> (f64, f64) {
    (x + width / 2.0, y + height - PANEL_BOTTOM_GAP)
}

/// The card's top-left corner for a size, from the anchor.
fn panel_origin(width: f64, height: f64) -> (f64, f64) {
    let (cx, bottom) = *PANEL_ANCHOR.lock().unwrap_or_else(|p| p.into_inner());
    (cx - width / 2.0, bottom - height)
}

/// The size the page asked for: from the circle (or a one-line card) up to the
/// two-line card. The circle (PANEL_CIRCLE square) is within both ranges.
pub fn clamp_panel_size(width: f64, height: f64) -> (f64, f64) {
    let w = if width.is_finite() { width.clamp(PANEL_CIRCLE, PANEL_W) } else { PANEL_MIN_W };
    let h = if height.is_finite() { height.clamp(PANEL_MIN_H, PANEL_H.max(PANEL_CIRCLE)) } else { PANEL_MIN_H };
    (w.round(), h.round())
}

/// The corner radius the page asked for: none keeps the card's, and it is
/// never more than half the shorter side (a circle at most).
pub fn clamp_panel_radius(radius: Option<f64>, width: f64, height: f64) -> f64 {
    let r = radius.filter(|r| r.is_finite()).unwrap_or(PANEL_RADIUS);
    r.clamp(0.0, width.min(height) / 2.0).round()
}

/// The mouse over the panel, or off it: the page shows Esc's hint while over.
const HOVER_EVENT: &str = "dictate://hover";

#[cfg(target_os = "macos")]
extern "C" fn on_hover(inside: i32) {
    if let Some(app) = APP.get() {
        let _ = app.emit_to(PANEL, HOVER_EVENT, inside != 0);
    }
}

/// macOS's frosted glass behind the page, with these corners.
fn glass(radius: f64) -> tauri::utils::config::WindowEffectsConfig {
    tauri::utils::config::WindowEffectsConfig {
        effects: vec![tauri::window::Effect::Popover],
        state: Some(tauri::window::EffectState::Active),
        radius: Some(radius),
        color: None,
    }
}

/// Round the glass to `radius` at once (each new card starts as one).
fn set_glass_radius(window: &tauri::WebviewWindow, radius: f64) {
    #[cfg(target_os = "macos")]
    {
        let win = window.clone();
        let _ = window.run_on_main_thread(move || {
            if let Ok(ns) = win.ns_window() {
                sys::set_glass_radius(ns, radius);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, radius);
}

/// What the panel first shows as: the dictation card, or the agent's circle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PanelShape {
    Card,
    Circle,
}

/// The panel built (hidden), so the page is there to listen.
fn ensure_panel(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window(PANEL) {
        return Some(w);
    }
    *PANEL_ANCHOR.lock().unwrap_or_else(|p| p.into_inner()) = panel_anchor(app);
    let (x, y) = panel_origin(PANEL_MIN_W, PANEL_MIN_H);
    build_panel(app, x, y)
}

/// Where a shape first shows: the card at its smallest, its bottom edge's
/// centre on the anchor; the circle round the card's middle (where the card
/// would have opened into it). Top-left corner and size, logical px.
pub fn panel_start(shape: PanelShape) -> (f64, f64, f64, f64, f64) {
    match shape {
        PanelShape::Card => {
            let (x, y) = panel_origin(PANEL_MIN_W, PANEL_MIN_H);
            (x, y, PANEL_MIN_W, PANEL_MIN_H, PANEL_RADIUS)
        }
        PanelShape::Circle => {
            let (cx, bottom) = *PANEL_ANCHOR.lock().unwrap_or_else(|p| p.into_inner());
            let middle = bottom - PANEL_MIN_H / 2.0;
            (cx - PANEL_CIRCLE / 2.0, middle - PANEL_CIRCLE / 2.0, PANEL_CIRCLE, PANEL_CIRCLE, PANEL_CIRCLE / 2.0)
        }
    }
}

/// Show the panel as `shape`, unless it's up already (a conversation's circle).
fn show_panel(app: &AppHandle, shape: PanelShape) {
    let Some(window) = ensure_panel(app) else { return };
    if window.is_visible().unwrap_or(false) {
        return;
    }
    *PANEL_ANCHOR.lock().unwrap_or_else(|p| p.into_inner()) = panel_anchor(app);
    let (x, y, w, h, radius) = panel_start(shape);
    // A card starts small; the page grows it with the words. The circle is
    // its own size from the first frame.
    set_glass_radius(&window, radius);
    let _ = window.set_size(tauri::LogicalSize::new(w, h));
    let _ = window.set_position(tauri::LogicalPosition::new(x, y));
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

fn build_panel(app: &AppHandle, x: f64, y: f64) -> Option<tauri::WebviewWindow> {
    use tauri::utils::config::BackgroundThrottlingPolicy;
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let origin = app
        .get_webview_window("main")
        .and_then(|w| w.url().ok())
        .map(|u| u.origin().ascii_serialization())
        .filter(|o| o.starts_with("http"))
        .unwrap_or_else(|| crate::tray::api_base_url().to_string());
    let url = format!("{origin}/hud/dictate").parse().ok()?;
    let window = WebviewWindowBuilder::new(app, PANEL, WebviewUrl::External(url))
        .title("")
        .inner_size(PANEL_MIN_W, PANEL_MIN_H)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        // macOS's own frosted glass behind the page (light or dark with the
        // system), so the apps behind show through blurred: a page's CSS blur
        // can't reach past its window. Active even though the panel is never
        // the key window, or it would turn flat grey. macOS draws the shadow.
        .effects(glass(PANEL_RADIUS))
        .shadow(true)
        .visible_on_all_workspaces(true)
        // It listens while another app is in front: never let macOS suspend it.
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .build();
    match window {
        Ok(w) => {
            #[cfg(target_os = "macos")]
            {
                let panel = w.clone();
                let _ = w.run_on_main_thread(move || {
                    if let Ok(ns) = panel.ns_window() {
                        sys::watch_hover(ns, on_hover);
                        match crate::make_overlay_panel(ns) {
                            Ok(()) => crate::log_to_file("[dictate] panel ready (floating, never takes focus)"),
                            Err(why) => crate::log_to_file(&format!(
                                "[dictate] panel stays a normal window: {why} ({})",
                                sys::class_chain(ns)
                            )),
                        }
                    }
                });
            }
            Some(w)
        }
        Err(e) => {
            crate::log_to_file(&format!("[dictate] couldn't build the panel: {e}"));
            None
        }
    }
}

/// Hide the panel, leaving the app you were in in front: Esc on the panel
/// must never bring Native Intelligence forward (dictate_hide_window).
fn hide_panel(app: &AppHandle) {
    let Some(w) = app.get_webview_window(PANEL) else { return };
    #[cfg(target_os = "macos")]
    {
        let win = w.clone();
        let back_to = TARGET_PID.load(Ordering::SeqCst);
        let _ = w.run_on_main_thread(move || {
            if let Ok(ns) = win.ns_window() {
                let seen = sys::hide_window(ns, back_to);
                if seen & 4 != 0 {
                    crate::log_to_file(&format!(
                        "[dictate] hidden with Native Intelligence in front (active before: {}, panel key: {}){}",
                        seen & 1 != 0,
                        seen & 2 != 0,
                        if seen & 8 != 0 { "; handed back to the app you were in" } else { "" }
                    ));
                }
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = w.hide();
}

// ─── commands ───────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelState {
    /// Listening right now (the card should be).
    armed: bool,
    /// The words go to the agent.
    agent: bool,
    run: u64,
}

/// The panel's page, on load: is something waiting to start?
#[tauri::command]
pub fn dictate_state() -> PanelState {
    let m = mode();
    let armed = matches!(m, Mode::Pressed { listening: true, .. } | Mode::Dictating { .. } | Mode::Holding { .. });
    PanelState { armed, agent: matches!(m, Mode::Holding { .. }), run: RUN.load(Ordering::SeqCst) }
}

/// The panel's progress: "listening", or "idle" when it's done (pasted,
/// cancelled, refused, nothing said, or the agent couldn't be reached).
#[tauri::command]
pub fn dictate_phase(app: AppHandle, run: u64, phase: String) {
    match phase.as_str() {
        "listening" => {
            LISTENING_RUN.store(run, Ordering::SeqCst);
        }
        "idle" => {
            if mode_run(mode()) == Some(run) {
                set_mode(Mode::Idle);
                crate::log_to_file(&format!("[dictate] {run} done"));
                hide_panel(&app);
            }
        }
        _ => {}
    }
}

/// `talk://ask` and `talk://interrupt` go to the main window, which holds the home thread.
const TALK_ASK_EVENT: &str = "talk://ask";
const TALK_INTERRUPT_EVENT: &str = "talk://interrupt";
/// The main window's answers, relayed to the panel.
const TALK_STATE_EVENT: &str = "dictate://agent";

#[derive(Clone, Serialize)]
struct TalkRun {
    run: u64,
}

#[derive(Clone, Serialize)]
struct TalkAsk {
    run: u64,
    text: String,
}

#[derive(Clone, Serialize)]
struct TalkState {
    run: u64,
    /// "thinking", "speaking", "done" or "failed".
    state: String,
}

/// The panel's words for the agent: to the main window, which sends them to
/// the home thread (web: components/voice/talk-anywhere-host.tsx). If it doesn't
/// take them in time, the panel hears "failed".
#[tauri::command]
pub fn talk_send(app: AppHandle, run: u64, text: String) {
    crate::log_to_file(&format!("[dictate] {run} to the agent: {} chars", text.len()));
    let _ = app.emit_to("main", TALK_ASK_EVENT, TalkAsk { run, text });
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(TALK_ACK_TIMEOUT).await;
        if TALK_ACK_RUN.load(Ordering::SeqCst) < run {
            crate::log_to_file(&format!("[dictate] {run} the main window never took the words"));
            let _ = app.emit_to(PANEL, TALK_STATE_EVENT, TalkState { run, state: "failed".into() });
        }
    });
}

/// The main window's progress on a talk run, relayed to the panel.
#[tauri::command]
pub fn talk_state(app: AppHandle, run: u64, state: String) {
    TALK_ACK_RUN.fetch_max(run, Ordering::SeqCst);
    crate::log_to_file(&format!("[dictate] {run} agent {state}"));
    let _ = app.emit_to(PANEL, TALK_STATE_EVENT, TalkState { run, state });
}

/// The pointer, for the agent's face in the circle (it looks at the mouse):
/// `dictate://pointer`, in the panel page's own coordinates (CSS px from its
/// top-left), about 30 times a second while it changes. The page can't follow
/// the mouse itself: it moves over other apps, and the panel never has focus.
const POINTER_EVENT: &str = "dictate://pointer";
const POINTER_EVERY: Duration = Duration::from_millis(33);
/// The current watch; a new call (on or off) ends the one before.
static POINTER_WATCH: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, PartialEq, Serialize)]
struct Pointer {
    x: f64,
    y: f64,
}

/// Follow the pointer for the panel (`on`), or stop. Stops by itself when the
/// panel goes.
#[tauri::command]
pub fn dictate_watch_pointer(app: AppHandle, on: bool) {
    let watch = POINTER_WATCH.fetch_add(1, Ordering::SeqCst) + 1;
    if !on {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut last: Option<Pointer> = None;
        while POINTER_WATCH.load(Ordering::SeqCst) == watch && mode() != Mode::Idle {
            if let Some(w) = app.get_webview_window(PANEL) {
                if let (Ok(c), Ok(at), Ok(scale)) = (app.cursor_position(), w.inner_position(), w.scale_factor()) {
                    let p = Pointer { x: ((c.x - at.x as f64) / scale).round(), y: ((c.y - at.y as f64) / scale).round() };
                    if last != Some(p) {
                        last = Some(p);
                        let _ = app.emit_to(PANEL, POINTER_EVENT, p);
                    }
                }
            }
            tokio::time::sleep(POINTER_EVERY).await;
        }
    });
}

/// The page's card size, as its words grow, or the conversation's circle: the
/// window follows, keeping the bottom edge's centre where it is, and the glass
/// takes the shape's corners (`radius`, the card's when not given).
#[tauri::command]
pub fn dictate_panel_size(app: AppHandle, width: f64, height: f64, radius: Option<f64>) {
    let Some(window) = app.get_webview_window(PANEL) else { return };
    let (w, h) = clamp_panel_size(width, height);
    let r = clamp_panel_radius(radius, w, h);
    #[cfg(target_os = "macos")]
    {
        // One animated frame change on macOS, so the card grows smoothly, the
        // corners going with it (card ↔ circle morphs).
        let win = window.clone();
        let _ = window.run_on_main_thread(move || {
            if let Ok(ns) = win.ns_window() {
                sys::resize_window(ns, w, h, r);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = r;
    #[cfg(not(target_os = "macos"))]
    {
        let (x, y) = panel_origin(w, h);
        let _ = window.set_size(tauri::LogicalSize::new(w, h));
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteResult {
    pasted: bool,
    /// Why it was copied instead: "secure_input", "focus_changed", "no_keys";
    /// or "stale": refused (not the panel's, not the latest dictation, or
    /// pasted already), not copied.
    reason: Option<&'static str>,
}

// ─── learning from edits ────────────────────────────────────────────────────

/// `dictate://edit`: words the person changed in what was pasted, for the
/// panel to learn from (it counts them, and adds one to their vocabulary the
/// second time). Never the text itself, only the words swapped.
const EDIT_EVENT: &str = "dictate://edit";
/// How long a paste is watched, how often its field is read, and how long the
/// app has to show the paste before the first read.
const WATCH_FOR: Duration = Duration::from_secs(120);
const WATCH_EVERY: Duration = Duration::from_millis(1000);
const WATCH_SETTLE: Duration = Duration::from_millis(400);
/// The current watch; a new paste's ends the one before.
static WATCH: AtomicU64 = AtomicU64::new(0);
/// The panel is up only to say what it learned (dictate_flash).
static FLASHING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The panel's note that it learned a word ("Learned  Koka Link → KokoLink"):
/// shown as a card a moment, while nothing else is up, then gone. A press
/// meanwhile takes the panel over (it's hidden first, as any press finds it).
#[tauri::command]
pub fn dictate_flash(app: AppHandle, on: bool) {
    if mode() != Mode::Idle {
        return;
    }
    if on {
        FLASHING.store(true, Ordering::SeqCst);
        show_panel(&app, PanelShape::Card);
    } else if FLASHING.swap(false, Ordering::SeqCst) {
        hide_panel(&app);
    }
}

/// One word (or a few) the person swapped for their own: what was heard, what they typed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WordEdit {
    pub heard: String,
    pub typed: String,
}

#[derive(Clone, Serialize)]
struct Edits {
    edits: Vec<WordEdit>,
}

async fn read_field(app: &AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(sys::watch_read());
    })
    .ok()?;
    rx.await.ok().flatten()
}

/// Watch what was pasted at `caret` for the person's own corrections: the
/// field is read every second for two minutes; the last clear reading counts,
/// once they leave the field, send it (it empties), or the time is up. The
/// text around the paste must stay as it was, or nothing is read into it.
async fn watch_edits(app: AppHandle, watch: u64, pasted: String, caret: Option<usize>) {
    // The paste in its field: where the caret was, or found by its words (the
    // app may take a moment to show it; its quotes may come back curled).
    let mut found_at: Option<(String, usize)> = None;
    for _ in 0..4 {
        tokio::time::sleep(WATCH_SETTLE).await;
        let Some(after) = read_field(&app).await else { break };
        if let Some(at) = locate(&pasted, caret, &after) {
            found_at = Some((after, at));
            break;
        }
    }
    let Some((after, at)) = found_at else {
        crate::log_to_file("[dictate] watch: the paste isn't readable in its field (an app that doesn't show its text)");
        return;
    };
    let mut last: Option<Vec<WordEdit>> = None;
    let mut why = "time up";
    let started = std::time::Instant::now();
    while started.elapsed() < WATCH_FOR {
        if WATCH.load(Ordering::SeqCst) != watch {
            why = "a newer paste";
            break;
        }
        tokio::time::sleep(WATCH_EVERY).await;
        let Some(now) = read_field(&app).await else {
            why = "left the field";
            break;
        };
        match edits(&pasted, at, &after, &now) {
            Some(found) => last = Some(found),
            None => {
                why = "sent or changed round it";
                break;
            }
        }
    }
    if WATCH.load(Ordering::SeqCst) == watch {
        let _ = app.run_on_main_thread(sys::watch_end);
    }
    let found = last.unwrap_or_default();
    crate::log_to_file(&format!("[dictate] watch ended ({why}): {} word(s) fixed", found.len()));
    if !found.is_empty() {
        let _ = app.emit_to(PANEL, EDIT_EVENT, Edits { edits: found });
    }
}

/// Curled quotes and non-breaking spaces as plain ones, one UTF-16 unit for
/// one: an app may curl a pasted apostrophe (Slack: he's → he’s).
fn plain(units: impl Iterator<Item = u16>) -> Vec<u16> {
    units
        .map(|u| match u {
            0x2018 | 0x2019 | 0x02BC => 0x27,
            0x201C | 0x201D => 0x22,
            0x00A0 | 0x202F => 0x20,
            other => other,
        })
        .collect()
}

/// Where `pasted` sits in the field's text `after` (UTF-16 offset): at the
/// caret it was pasted at if it's there, else its last place in the text.
pub fn locate(pasted: &str, caret: Option<usize>, after: &str) -> Option<usize> {
    let p = plain(pasted.encode_utf16());
    let a = plain(after.encode_utf16());
    if p.is_empty() || p.len() > a.len() {
        return None;
    }
    if let Some(c) = caret {
        if c + p.len() <= a.len() && a[c..c + p.len()] == p[..] {
            return Some(c);
        }
    }
    (0..=a.len() - p.len()).rev().find(|&i| a[i..i + p.len()] == p[..])
}

/// The words swapped in what was pasted (`pasted` at UTF-16 offset `caret` in
/// the field's text `after` the paste), as the field reads `now`. None when
/// the text round the paste has changed (the paste can't be found), or it
/// isn't there at all. Offsets are UTF-16, as macOS's accessibility gives them.
pub fn edits(pasted: &str, caret: usize, after: &str, now: &str) -> Option<Vec<WordEdit>> {
    // Compared with curled quotes as plain ones (an app may curl them), one
    // unit for one, so the offsets hold for the text as it really is, which is
    // what's reported: the words exactly as they were, apostrophes and all.
    let now_units: Vec<u16> = now.encode_utf16().collect();
    let p = plain(pasted.encode_utf16());
    let a = plain(after.encode_utf16());
    let n = plain(now_units.iter().copied());
    if caret + p.len() > a.len() || a[caret..caret + p.len()] != p[..] {
        return None;
    }
    let (before, behind) = (&a[..caret], &a[caret + p.len()..]);
    if n.len() < before.len() + behind.len() || &n[..before.len()] != before || &n[n.len() - behind.len()..] != behind {
        return None;
    }
    let span = before.len()..n.len() - behind.len();
    let region = String::from_utf16_lossy(&n[span.clone()]);
    if region.trim().is_empty() {
        return None;
    }
    let region_as_is = String::from_utf16_lossy(&now_units[span]);
    Some(swaps_between(&String::from_utf16_lossy(&p), &region, pasted, &region_as_is))
}

/// A word without the punctuation round it ("renewal." → "renewal").
fn bare(w: &str) -> &str {
    w.trim_matches(|c: char| !c.is_alphanumeric())
}

/// The runs of up to three words replaced by up to three others, `old` → `new`
/// (aligned on the words kept, case and inner punctuation counting). Words only
/// added or only removed don't count; nor does a rewrite (more than three
/// swaps, or more than half the words changed): that's not fixing a word.
pub fn word_swaps(old: &str, new: &str) -> Vec<WordEdit> {
    swaps_between(old, new, old, new)
}

/// [`word_swaps`], compared on `old` and `new` but told in `old_as_is` and
/// `new_as_is`: the same texts, character for character, as they really are
/// (`plain` only evens out quotes and spaces, one for one).
fn swaps_between(old: &str, new: &str, old_as_is: &str, new_as_is: &str) -> Vec<WordEdit> {
    let words = |t: &str| -> Vec<String> { t.split_whitespace().map(bare).filter(|w| !w.is_empty()).map(String::from).collect() };
    let (a, a_as_is) = (words(old), words(old_as_is));
    let (b, b_as_is) = (words(new), words(new_as_is));
    if a.len() != a_as_is.len() || b.len() != b_as_is.len() {
        return Vec::new(); // can't happen (one for one); never report words out of step
    }
    if a.is_empty() || b.is_empty() || a.len() > 400 || b.len() > 400 {
        return Vec::new();
    }
    // Longest common subsequence of the words, then the gaps between its matches.
    let (m, n) = (a.len(), b.len());
    let mut l = vec![vec![0u16; n + 1]; m + 1];
    for i in (0..m).rev() {
        for j in (0..n).rev() {
            l[i][j] = if a[i] == b[j] { l[i + 1][j + 1] + 1 } else { l[i + 1][j].max(l[i][j + 1]) };
        }
    }
    let (mut i, mut j) = (0, 0);
    // The gaps between matches, as word positions in each text.
    let mut gaps: Vec<(Vec<usize>, Vec<usize>)> = Vec::new();
    let mut gap: (Vec<usize>, Vec<usize>) = (Vec::new(), Vec::new());
    while i < m || j < n {
        if i < m && j < n && a[i] == b[j] {
            if !gap.0.is_empty() || !gap.1.is_empty() {
                gaps.push(std::mem::take(&mut gap));
            }
            i += 1;
            j += 1;
        } else if j < n && (i == m || l[i][j + 1] >= l[i + 1][j]) {
            gap.1.push(j);
            j += 1;
        } else {
            gap.0.push(i);
            i += 1;
        }
    }
    if !gap.0.is_empty() || !gap.1.is_empty() {
        gaps.push(gap);
    }
    let changed: usize = gaps.iter().map(|g| g.0.len()).sum();
    let swaps: Vec<WordEdit> = gaps
        .into_iter()
        .filter(|(o, t)| !o.is_empty() && !t.is_empty() && o.len() <= 3 && t.len() <= 3)
        .map(|(o, t)| WordEdit {
            heard: o.iter().map(|&k| a_as_is[k].as_str()).collect::<Vec<_>>().join(" "),
            typed: t.iter().map(|&k| b_as_is[k].as_str()).collect::<Vec<_>>().join(" "),
        })
        .filter(|e| e.heard != e.typed && e.heard.len() <= 48 && e.typed.len() <= 48)
        .collect();
    if swaps.len() > 3 || changed * 2 > a.len().max(2) {
        return Vec::new();
    }
    swaps
}

/// Webview `label` may paste `run`'s words now ([`may_paste`]): taken, so no
/// second paste of the run gets through.
fn take_paste(label: &str, run: u64) -> bool {
    let (current, dictation) = (RUN.load(Ordering::SeqCst), DICTATION_RUN.load(Ordering::SeqCst));
    may_paste(label, run, current, dictation, PASTED_RUN.load(Ordering::SeqCst)) && PASTED_RUN.fetch_max(run, Ordering::SeqCst) < run
}

/// The panel's words, into the app that was in front at the first tap: only
/// from the panel, for the person's latest dictation, once ([`may_paste`]),
/// on one line ([`one_line`]). Refused, nothing is pasted or copied (the
/// clipboard is left as it was), and the panel shows the words instead.
#[tauri::command]
pub async fn dictate_paste(app: AppHandle, webview: tauri::Webview, run: u64, text: String) -> PasteResult {
    let text = one_line(&text);
    if text.is_empty() {
        return PasteResult { pasted: false, reason: None };
    }
    if !take_paste(webview.label(), run) {
        crate::log_to_file(&format!("[dictate] {run} paste refused: no dictation of that run is waiting for its words"));
        return PasteResult { pasted: false, reason: Some("stale") };
    }
    let pid = TARGET_PID.load(Ordering::SeqCst);
    let (tx, rx) = tokio::sync::oneshot::channel();
    let ran = app.run_on_main_thread(move || {
        let text = with_leading_space(sys::char_before_caret(pid), &text);
        // The field it goes into, to see later what the person changed.
        let caret = sys::watch_begin(pid);
        let _ = tx.send((sys::paste(pid, &text), text, caret));
    });
    let (code, sent, caret) = if ran.is_ok() { rx.await.unwrap_or((-3, String::new(), None)) } else { (-3, String::new(), None) };
    let (pasted, reason) = paste_outcome(code);
    if pasted {
        crate::log_to_file(&format!("[dictate] {run} pasted {} chars", sent.len()));
        let watch = WATCH.fetch_add(1, Ordering::SeqCst) + 1;
        tauri::async_runtime::spawn(watch_edits(app.clone(), watch, sent, caret));
    } else {
        crate::log_to_file(&format!("[dictate] {run} copied instead ({})", reason.unwrap_or("?")));
    }
    PasteResult { pasted, reason }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    supported: bool,
    enabled: bool,
    /// The Accessibility permission (watching the key, reading the field).
    accessibility: bool,
    /// macOS lets Native Intelligence post ⌘V.
    keystrokes: bool,
    /// On, but the key can't be watched: "needs_permission" or "no_event_tap".
    error: Option<String>,
}

fn status(app: &AppHandle) -> Status {
    Status {
        supported: sys::SUPPORTED,
        enabled: settings::dictate(app).enabled,
        accessibility: sys::trusted(),
        keystrokes: sys::may_post(),
        error: TAP_ERROR.lock().unwrap_or_else(|p| p.into_inner()).clone(),
    }
}

#[tauri::command]
pub fn dictate_status(app: AppHandle) -> Status {
    status(&app)
}

/// Turn it on or off. On needs the Accessibility permission (the settings page
/// asks for it with Read aloud's `read_selection_request_access`).
#[tauri::command]
pub async fn dictate_set_enabled(app: AppHandle, enabled: bool) -> Result<Status, String> {
    if !sys::SUPPORTED {
        return Err("unsupported".into());
    }
    if enabled && !sys::trusted() {
        return Err("needs_permission".into());
    }
    settings::set_dictate(&app, &DictateSettings { enabled });
    let (tx, rx) = tokio::sync::oneshot::channel();
    let ran = app.run_on_main_thread(move || {
        let error = if enabled {
            if let Some(app) = APP.get() {
                prepare_panel(app);
            }
            start_tap_now()
        } else {
            sys::tap_stop();
            crate::log_to_file("[dictate] right ⌥ no longer watched");
            None
        };
        let _ = tx.send(error);
    });
    let error = if ran.is_ok() { rx.await.ok().flatten() } else { Some("no_event_tap".into()) };
    set_tap_error(error);
    if !enabled {
        if let Some(run) = mode_run(mode()) {
            set_mode(Mode::Idle);
            let _ = app.emit_to("main", TALK_INTERRUPT_EVENT, TalkRun { run });
            emit_panel(&app, run, "close");
            hide_panel(&app);
        }
    }
    Ok(status(&app))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_space_goes_first_only_after_a_word_or_a_sentence() {
        assert_eq!(with_leading_space(Some('t'), "team"), " team");
        assert_eq!(with_leading_space(Some('.'), "Then"), " Then");
        assert_eq!(with_leading_space(Some('”'), "and"), " and");
        assert_eq!(with_leading_space(Some(' '), "team"), "team");
        assert_eq!(with_leading_space(Some('('), "team"), "team");
        assert_eq!(with_leading_space(Some('\n'), "team"), "team");
        assert_eq!(with_leading_space(None, "team"), "team");
        assert_eq!(with_leading_space(Some('t'), ", and"), ", and");
    }

    /// Run a sequence of keys from idle; the last mode and every act.
    fn run(keys: &[Key]) -> (Mode, Vec<Act>) {
        let (mut m, mut acts, mut next) = (Mode::Idle, Vec::new(), 1);
        for &k in keys {
            let (after, a) = step(m, k, next);
            if a.iter().any(|x| matches!(x, Act::Press { .. } | Act::Listen { agent: true, .. })) {
                next += 1;
            }
            m = after;
            acts.extend(a);
        }
        (m, acts)
    }

    #[test]
    fn a_quick_tap_is_dictation_and_the_next_press_pastes() {
        let (m, acts) = run(&[Key::Down, Key::UpClean]);
        assert_eq!(m, Mode::Dictating { run: 1 });
        assert_eq!(acts, vec![Act::Press { run: 1 }, Act::Listen { run: 1, agent: false }, Act::Tapped { run: 1 }]);
        let (m, acts) = run(&[Key::Down, Key::UpClean, Key::Down, Key::UpClean]);
        assert_eq!(m, Mode::Pasting { run: 1 });
        assert_eq!(acts.last(), Some(&Act::StopDictation { run: 1 }));
    }

    #[test]
    fn listening_starts_a_moment_into_a_clean_press_and_a_typed_character_never_opens_the_mic() {
        let (m, acts) = run(&[Key::Down, Key::ListenTimer(1)]);
        assert_eq!(m, Mode::Pressed { run: 1, listening: true });
        assert_eq!(acts.last(), Some(&Act::Listen { run: 1, agent: false }));
        // ⌥E: the other key comes before the timer, and nothing listens.
        let (m, acts) = run(&[Key::Down, Key::Dirty, Key::ListenTimer(1), Key::UpDirty]);
        assert_eq!(m, Mode::Idle);
        assert_eq!(acts, vec![Act::Press { run: 1 }]);
    }

    #[test]
    fn a_hold_goes_to_the_agent_and_the_circle_waits_for_the_next_hold() {
        let (m, acts) = run(&[Key::Down, Key::ListenTimer(1), Key::HoldTimer(1)]);
        assert_eq!(m, Mode::Holding { run: 1 });
        assert_eq!(acts.last(), Some(&Act::ToAgent { run: 1 }));
        let (m, acts) = run(&[Key::Down, Key::ListenTimer(1), Key::HoldTimer(1), Key::UpClean]);
        assert_eq!(m, Mode::Circle { run: 1 });
        assert_eq!(acts.last(), Some(&Act::Send { run: 1 }));
        // Pressing again cuts the reply and listens at once...
        let circle = [Key::Down, Key::ListenTimer(1), Key::HoldTimer(1), Key::UpClean];
        let (m, acts) = run(&[&circle[..], &[Key::Down]].concat());
        assert_eq!(m, Mode::Pressed { run: 2, listening: true });
        assert_eq!(
            &acts[acts.len() - 3..],
            &[Act::Interrupt { run: 1 }, Act::Press { run: 2 }, Act::Listen { run: 2, agent: false }]
        );
        // ...a hold talks to the agent again...
        let (m, acts) = run(&[&circle[..], &[Key::Down, Key::ListenTimer(2), Key::HoldTimer(2), Key::UpClean]].concat());
        assert_eq!(m, Mode::Circle { run: 2 });
        assert_eq!(acts.last(), Some(&Act::Send { run: 2 }));
        // ...and a quick tap goes back to dictating, pasted on the next tap.
        // (the panel hears it was a tap: the circle becomes the card)
        let (m, acts) = run(&[&circle[..], &[Key::Down, Key::UpClean]].concat());
        assert_eq!(m, Mode::Dictating { run: 2 });
        assert_eq!(acts.last(), Some(&Act::Tapped { run: 2 }));
        let (m, acts) = run(&[&circle[..], &[Key::Down, Key::UpClean, Key::Down, Key::UpClean]].concat());
        assert_eq!(m, Mode::Pasting { run: 2 });
        assert_eq!(acts.last(), Some(&Act::StopDictation { run: 2 }));
    }

    #[test]
    fn esc_cancels_listening_or_closes_the_circle() {
        let (m, acts) = run(&[Key::Down, Key::UpClean, Key::Escape]);
        assert_eq!((m, acts.last()), (Mode::Idle, Some(&Act::Cancel { run: 1 })));
        let (m, acts) = run(&[Key::Down, Key::HoldTimer(1), Key::UpClean, Key::Escape]);
        assert_eq!(m, Mode::Idle);
        assert_eq!(&acts[acts.len() - 2..], &[Act::Interrupt { run: 1 }, Act::Close { run: 1 }]);
        // A stale timer from an old press does nothing.
        let (m, _) = run(&[Key::Down, Key::UpClean, Key::HoldTimer(1)]);
        assert_eq!(m, Mode::Dictating { run: 1 });
    }

    #[test]
    fn esc_is_ours_only_while_something_is_up() {
        assert!(!Mode::Idle.claims_escape());
        assert!(!(Mode::Pressed { run: 1, listening: false }).claims_escape());
        assert!((Mode::Dictating { run: 1 }).claims_escape());
        assert!((Mode::Circle { run: 1 }).claims_escape());
        assert!(!(Mode::Pasting { run: 1 }).claims_escape());
    }

    fn swap(heard: &str, typed: &str) -> WordEdit {
        WordEdit { heard: heard.into(), typed: typed.into() }
    }

    #[test]
    fn a_word_fixed_in_a_paste_is_learned_and_rewrites_are_not() {
        assert_eq!(
            word_swaps("ask Koka Link about the renewal.", "ask KokoLink about the renewal."),
            vec![swap("Koka Link", "KokoLink")]
        );
        assert_eq!(word_swaps("the apim team", "the APIM team"), vec![swap("apim", "APIM")]);
        // Words only added or taken out: nothing to learn.
        assert_eq!(word_swaps("send it now", "send it right now"), vec![]);
        assert_eq!(word_swaps("send it now please", "send it now"), vec![]);
        // A rewrite isn't a fix.
        assert_eq!(word_swaps("meet on Friday at noon", "lunch tomorrow works"), vec![]);
        // Punctuation round a word doesn't count as a change.
        assert_eq!(word_swaps("ok, see you", "ok see you"), vec![]);
    }

    #[test]
    fn the_paste_is_found_in_its_field_and_lost_when_round_it_changes() {
        let before = "Hi team, ";
        let pasted = "check the apim logs";
        let after = format!("{before}{pasted} today");
        let caret = before.encode_utf16().count();
        let now = format!("{before}check the APIM logs today");
        assert_eq!(edits(pasted, caret, &after, &now), Some(vec![swap("apim", "APIM")]));
        // Typing on after it: still read, the additions ignored.
        let more = format!("{before}check the APIM logs and the alerts today");
        assert_eq!(edits(pasted, caret, &after, &more), Some(vec![swap("apim", "APIM")]));
        // Sent: the field empties.
        assert_eq!(edits(pasted, caret, &after, ""), None);
        // Changed round it: can't tell.
        assert_eq!(edits(pasted, caret, &after, "Hello! check the APIM logs today"), None);
        // Curled by the app (Slack): still the paste.
        let curled = format!("{before}he’s on the apim team");
        let p2 = "he's on the apim team";
        assert_eq!(locate(p2, None, &curled), Some(caret));
        assert_eq!(edits(p2, caret, &curled, &format!("{before}he’s on the APIM team")), Some(vec![swap("apim", "APIM")]));
        // The words reported exactly as they were: what was heard as the model
        // wrote it (pasted), what was typed as the field has it, apostrophes
        // and all, though Slack curled the pasted one.
        let shown = format!("{before}Jay Ng’s not coming");
        assert_eq!(
            edits("Jay Ng's not coming", caret, &shown, &format!("{before}Giang’s not coming")),
            Some(vec![swap("Jay Ng's", "Giang’s")])
        );
        assert_eq!(
            edits("Jay Ng’s not coming", caret, &shown, &format!("{before}Giang’s not coming")),
            Some(vec![swap("Jay Ng’s", "Giang’s")])
        );
        // Found by its words when the caret wasn't readable.
        assert_eq!(locate(pasted, None, &after), Some(caret));
        // UTF-16 offsets: an emoji before the paste.
        let emoji = "🙂 ";
        let after = format!("{emoji}{pasted}");
        let caret = emoji.encode_utf16().count();
        assert_eq!(edits(pasted, caret, &after, &format!("{emoji}check the APIM logs")), Some(vec![swap("apim", "APIM")]));
    }

    #[test]
    fn it_sits_above_the_dock_with_room_for_the_circle() {
        // A 1440×900 screen, the menu bar 25 high, a Dock 70 high at the bottom.
        let (cx, bottom) = anchor_in(0.0, 25.0, 1440.0, 805.0);
        assert_eq!(cx, 720.0);
        // The circle, widened from the card's middle, still clears the Dock.
        let circle_bottom = bottom + (PANEL_CIRCLE - PANEL_MIN_H) / 2.0;
        assert_eq!(830.0 - circle_bottom, PANEL_DOCK_GAP);
        // The Dock on the left: centred in what's left.
        assert_eq!(anchor_in(80.0, 25.0, 1360.0, 875.0).0, 760.0);
    }

    #[test]
    fn the_card_stays_between_its_smallest_and_largest() {
        // As narrow as the circle; never shorter than one line of words.
        assert_eq!(clamp_panel_size(10.0, 10.0), (PANEL_CIRCLE, PANEL_MIN_H));
        assert_eq!(clamp_panel_size(104.0, 104.0), (104.0, 104.0));
        assert_eq!(clamp_panel_size(9999.0, 9999.0), (PANEL_W, PANEL_CIRCLE));
        assert_eq!(clamp_panel_size(300.4, 50.0), (300.0, 50.0));
        assert_eq!(clamp_panel_size(f64::NAN, f64::INFINITY), (PANEL_MIN_W, PANEL_MIN_H));
        // The corners: the card's by default, a circle at most.
        assert_eq!(clamp_panel_radius(None, 200.0, 46.0), PANEL_RADIUS);
        assert_eq!(clamp_panel_radius(Some(52.0), 104.0, 104.0), 52.0);
        assert_eq!(clamp_panel_radius(Some(99.0), 104.0, 104.0), 52.0);
        assert_eq!(clamp_panel_radius(Some(f64::NAN), 104.0, 104.0), PANEL_RADIUS);
    }

    #[test]
    fn only_the_panel_pastes_the_latest_dictation_and_only_once() {
        // Run 3 was a tap (a dictation), the latest press; run 2 pasted.
        assert!(may_paste(PANEL, 3, 3, 3, 2));
        // Any other webview: never, whatever else holds.
        for label in ["main", "workspace-1", "agent-hud", "meeting-hud", "Dictate", ""] {
            assert!(!may_paste(label, 3, 3, 3, 2), "{label}");
        }
        // Once: pasted (or cancelled) already.
        assert!(!may_paste(PANEL, 3, 3, 3, 3));
        // A newer press started: the old run's words no longer paste.
        assert!(!may_paste(PANEL, 3, 4, 3, 2));
        // Another run's words, older or newer than the latest press.
        assert!(!may_paste(PANEL, 2, 3, 3, 1));
        assert!(!may_paste(PANEL, 4, 3, 3, 2));
        // The latest press wasn't a tap (the agent's hold, or not known yet).
        assert!(!may_paste(PANEL, 3, 3, 2, 2));
    }

    /// The key machine and the paste gate together, as perform() keeps the
    /// runs: a dictation's words may come late (the mode idle already) until
    /// the next press, and a hold's never paste.
    #[test]
    fn late_words_paste_until_the_next_press_and_a_hold_never_does() {
        /// The mode and the runs perform() keeps: the latest press, the latest tap, the last pasted or cancelled.
        #[derive(Default)]
        struct Runs {
            mode: Option<Mode>,
            current: u64,
            dictation: u64,
            pasted: u64,
        }
        impl Runs {
            fn feed(&mut self, keys: &[Key]) -> Mode {
                for &key in keys {
                    let (after, acts) = step(self.mode.unwrap_or(Mode::Idle), key, self.current + 1);
                    self.mode = Some(after);
                    for act in acts {
                        match act {
                            Act::Press { run } => self.current = run,
                            Act::Tapped { run } => self.dictation = self.dictation.max(run),
                            Act::Cancel { run } => self.pasted = self.pasted.max(run),
                            _ => {}
                        }
                    }
                }
                self.mode.unwrap_or(Mode::Idle)
            }
            fn may(&self, run: u64) -> bool {
                may_paste(PANEL, run, self.current, self.dictation, self.pasted)
            }
        }
        let mut r = Runs::default();
        // A tap, a second tap: Pasting; then STOP_TIMEOUT idles it and the words come late.
        assert_eq!(r.feed(&[Key::Down, Key::UpClean, Key::Down, Key::UpClean]), Mode::Pasting { run: 1 });
        r.mode = Some(Mode::Idle);
        assert!(r.may(1));
        // A hold: the agent's, its run never pastes, nor does the old one.
        assert_eq!(r.feed(&[Key::Down, Key::ListenTimer(2), Key::HoldTimer(2), Key::UpClean]), Mode::Circle { run: 2 });
        assert!(!r.may(2));
        assert!(!r.may(1));
        // A tap from the circle dictates again; Esc cancels it: its words never paste.
        assert_eq!(r.feed(&[Key::Down, Key::UpClean]), Mode::Dictating { run: 3 });
        assert!(r.may(3));
        assert_eq!(r.feed(&[Key::Escape]), Mode::Idle);
        assert!(!r.may(3));
    }

    #[test]
    fn the_panels_voice_ends_when_the_press_does() {
        use Mode::*;
        // Idle: Esc, a press that wasn't clean, a panel that never started, the panel done.
        for before in [Pressed { run: 1, listening: true }, Pressed { run: 1, listening: false }, Dictating { run: 1 }, StopPress { run: 1 }, Holding { run: 1 }, Circle { run: 1 }] {
            assert_eq!(press_end(before, Idle), Some(PressEnd::Cancel), "{before:?}");
        }
        // The words on their way: a dictation idled by STOP_TIMEOUT while pasted, a hold's sent (the circle).
        assert_eq!(press_end(Pasting { run: 1 }, Idle), Some(PressEnd::Stop));
        assert_eq!(press_end(Holding { run: 1 }, Circle { run: 1 }), Some(PressEnd::Stop));
        // While the press goes on: nothing.
        for (before, after) in [
            (Idle, Pressed { run: 1, listening: false }),
            (Idle, Idle),
            (Pressed { run: 1, listening: false }, Pressed { run: 1, listening: true }),
            (Pressed { run: 1, listening: true }, Dictating { run: 1 }),
            (Pressed { run: 1, listening: true }, Holding { run: 1 }),
            (Dictating { run: 1 }, StopPress { run: 1 }),
            (StopPress { run: 1 }, Pasting { run: 1 }),
            (Circle { run: 1 }, Pressed { run: 2, listening: true }),
            (Circle { run: 1 }, Circle { run: 1 }),
        ] {
            assert_eq!(press_end(before, after), None, "{before:?} → {after:?}");
        }
        // The key machine's own ends, end to end: Esc while dictating, a hold's release.
        let (m, _) = step(Dictating { run: 1 }, Key::Escape, 2);
        assert_eq!(press_end(Dictating { run: 1 }, m), Some(PressEnd::Cancel));
        let (m, _) = step(Holding { run: 1 }, Key::UpClean, 2);
        assert_eq!(press_end(Holding { run: 1 }, m), Some(PressEnd::Stop));
    }

    #[test]
    fn the_words_go_on_one_line_into_any_app() {
        assert_eq!(one_line("git status\nrm -rf ~\r\n"), "git status rm -rf ~");
        assert_eq!(one_line("a\u{2028}b\u{2029}c\u{85}d\te\u{0B}f\u{0C}g"), "a b c d e f g");
        // No Esc (a bracketed paste's end, then Return), no other control character.
        assert_eq!(one_line("hi\u{1b}[201~\nwhoami"), "hi[201~ whoami");
        assert_eq!(one_line("ok\u{7}\u{0}\u{9b}done"), "okdone");
        assert_eq!(one_line("  check  the   logs "), "check the logs");
        assert_eq!(one_line("\n\u{1b}\t"), "");
        // Dictation's own words land as they were said.
        assert_eq!(one_line("he’s on the APIM team, “today”."), "he’s on the APIM team, “today”.");
        assert_eq!(one_line("Grüße 🙂 naïve"), "Grüße 🙂 naïve");
    }

    #[test]
    fn a_paste_that_could_not_happen_says_why() {
        assert_eq!(paste_outcome(0), (true, None));
        assert_eq!(paste_outcome(-1), (false, Some("secure_input")));
        assert_eq!(paste_outcome(-2), (false, Some("focus_changed")));
        assert_eq!(paste_outcome(-3), (false, Some("no_keys")));
    }
}
