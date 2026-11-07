//! Chat voice on the desktop: dictation, voice mode and Interactive mode
//! (dial8-website/docs/plans/chat-voice.md §3.1, bridge contract §3.3;
//! Interactive: the interactive-mode spec's desktop ⇄ web contract, a
//! conversation-like session behind the web's Interactive toggle that reads
//! aloud and listens for the agent's name).
//!
//! One session app-wide, owned by the webview that started it (like the TTS
//! claim). Pieces:
//! - [`commands`]: `voice_status`, `voice_start`, `voice_stop`,
//!   `voice_cancel`, `voice_set_muted`, `voice_set_aside`, `voice_set_barge`,
//!   and `voice_log` (the web's Voice focus lines, into the debug log);
//! - [`speech`]: a candidate turn's audio as `voice://speech` chunks
//!   (`voice_start { speechAudio: true }`: Voice focus);
//! - [`session`]: the async actor that owns a live session (local-stt, the
//!   held TTS output, the route watcher) and runs the [`turn`] machine;
//! - [`dsp`]: the DSP thread (resample, echo canceller, VAD, barge-in);
//! - [`system_ref`]: on speakers, the system-audio tap as an extra echo
//!   reference (a call playing out loud is not transcribed as the user);
//! - [`feed`]: an interactive session's STT feed gate (local-stt hears
//!   speech, not the quiet room) and the clock map back to the session's;
//! - [`turn`], [`transcript`], [`detect`]: the pure logic, clock-injected;
//! - [`profile`]: the background-noise presets ("Quiet room" = 0.2.45,
//!   "Noisy room", and "Auto", which switches from the one to the other);
//! - [`levels`]: the user's speech level remembered per mic (noisy room,
//!   Auto);
//! - [`trace`]: the machine's inputs and actions as records; [`capture`]:
//!   the dev-only debug capture (`DIAL8_VOICE_CAPTURE`); [`replay`]: the
//!   offline replay harness and the quiet room's goldens;
//! - [`events`]: the `voice://*` payloads;
//! - [`vad`]: the VAD interface (W2b fills in the detector).
//!
//! Threads: the command handlers; one tokio task per session (the actor);
//! one `voice-dsp` std thread per session; local-stt's own task. Channels:
//! commands → actor (`Ctl`, unbounded); DSP → actor (`DspEvent`, unbounded);
//! local-stt → actor (`VoiceSttEvent`); actor → DSP through the atomics in
//! [`dsp::DspShared`]; TTS → actor and DSP through its `speaking` watch;
//! DSP → actor through an interactive session's [`feed::FeedClock`], whose
//! lock is a leaf (taken with nothing else held, released before anything
//! else is taken), outside the order below.
//!
//! Locks, app-wide, always in this order:
//!
//! ```text
//! AppState.dual_stream → AppState.mic_capture → AppState.system_capture
//!     → AppState.session → VoiceService's registry
//! ```
//!
//! A path may skip any of them, never take one after a later one.
//! `start_recording`, `pause_recording`, `resume_recording` and
//! `stop_recording` (which used to take the mic before the dual stream, the
//! inversion that could deadlock against a voice start) all follow it;
//! `reset_recording_state` only ever `try_lock`s. The voice start
//! ([`commands`]' `start_mic`, on a blocking thread) takes the dual stream,
//! then the mic, admits and registers the session under the registry lock,
//! and then lets go of the dual stream **before** the slow `mic.start` (up to
//! 2.5 s on a reused stream, plus a reopen), keeping only the mic: dropping an
//! earlier lock early can't invert the order, and main-thread readers of the
//! dual stream (`get_recording_status`, pause/resume, TTS's recording guard)
//! no longer wait on the mic. A capture starting in that window finds the
//! session already registered: `end_for_recording` (under the dual stream)
//! waits for the mic lock, takes the lease and stops the mic. The registry
//! lock is never held while taking any of the others, and [`MicControl`]
//! takes the mic lock with nothing else held.
//!
//! The voice system tap ([`system_ref::AppRefTap`]) has a leaf lock of its
//! own, outside the order above: taken with nothing else held (from
//! `end_for_recording`, under the recording lock only, after the mic lock is
//! released), and nothing is taken under it. [`VoiceService::end_now`] takes
//! the session's mic lease and then stops its tap before returning, and a tap
//! start is refused once the lease is gone, so a capture's own SystemCapture
//! never starts while a voice tap runs.
//!
//! Page lifetime: a session belongs to the page that started it. Every page
//! load and window teardown bumps that webview's page generation
//! ([`VoiceService::end_for_page`]), even when no session is registered yet;
//! `voice_start` reads the generation on entry and [`VoiceService::admit`]
//! refuses, under the registry lock, a start whose page has gone since, so a
//! reload or close during a slow start (TCC prompt, model probe, mic reopen)
//! can't leave an orphan session with the mic on.

pub mod capture;
pub mod commands;
pub mod detect;
pub mod dsp;
pub mod events;
pub mod feed;
pub mod levels;
pub mod session;
pub mod speech;
pub mod system_ref;
pub mod transcript;
pub mod turn;
pub mod earshot_vad;
pub mod ort_runtime;
pub mod profile;
pub mod replay;
pub mod silero;
pub mod trace;
pub mod vad;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;

use events::EndReason;
use turn::{BargePolicy, Mode};

/// The session audio clock's rate (cleaned mic, local-stt's input).
pub const SAMPLE_RATE: u64 = 16_000;

/// What the session actor is told from outside.
#[derive(Debug, Clone, PartialEq)]
pub enum Ctl {
    Stop,
    Cancel,
    Mute(bool),
    /// `voice_set_aside`: the agent speech now starting is an aside (with
    /// its text: the words its echo may put in the user's turn).
    Aside { on: bool, text: Option<String> },
    /// `voice_set_barge`: what talking over the agent does from now on (a
    /// conversation or an interactive session; the command refuses the
    /// rest).
    Barge(BargePolicy),
    End(EndReason),
    /// A newer session from the same webview took over (another panel's
    /// start). Dictation ends as stopped with the words it has (a dictation
    /// that was finalizing is not thrown away); a conversation is cancelled.
    Replaced,
    /// The output route may have changed (RouteWatcher).
    RouteChanged,
}

/// Why `voice_start` refused (the web's `VoiceRefusal`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Recording,
    Busy,
    NotReady,
    MicDenied,
    Unavailable,
    /// The page that asked reloaded, navigated or closed while the start was
    /// in flight. Reported as `unavailable` (nobody is left to read it).
    PageGone,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Refusal::Recording => "recording",
            Refusal::Busy => "busy",
            Refusal::NotReady => "not_ready",
            Refusal::MicDenied => "mic_denied",
            Refusal::Unavailable | Refusal::PageGone => "unavailable",
        }
    }

    /// The command's error string: the code, or `code: detail` (the web
    /// reads both).
    pub fn with(self, detail: impl AsRef<str>) -> String {
        let d = detail.as_ref();
        if d.is_empty() {
            self.code().to_string()
        } else {
            format!("{}: {}", self.code(), d)
        }
    }
}

/// A session's claim on the mic. Whoever takes it (under the mic lock)
/// stops the mic; a session replaced by a newer one on the same mic has its
/// lease taken without a stop.
#[derive(Debug)]
pub struct MicLease {
    held: AtomicBool,
}

impl MicLease {
    pub fn new() -> Self {
        Self { held: AtomicBool::new(true) }
    }

    /// true exactly once. Call with the mic lock held.
    pub fn take(&self) -> bool {
        self.held.swap(false, Ordering::SeqCst)
    }

    /// Still held (nobody took it). Read under the mic lock to act on it.
    pub fn held(&self) -> bool {
        self.held.load(Ordering::SeqCst)
    }
}

impl Default for MicLease {
    fn default() -> Self {
        Self::new()
    }
}

/// Releases a session's mic: in the app, lock `AppState.mic_capture`, and if
/// the lease is still held, remove the raw tap and stop the mic.
pub trait MicControl: Send + Sync {
    fn release(&self, lease: &MicLease);
}

struct AppMic(AppHandle);

impl MicControl for AppMic {
    fn release(&self, lease: &MicLease) {
        let state = self.0.state::<crate::state::AppState>();
        let mut mic = state.mic_capture.lock().unwrap_or_else(|p| p.into_inner());
        if lease.take() {
            drop(mic.remove_raw_tap());
            if let Err(e) = mic.stop() {
                crate::log_to_file(&format!("[voice] mic stop failed: {e}"));
            }
            crate::log_to_file("[voice] mic released");
        }
    }
}

/// The live session, as the registry knows it.
#[derive(Clone, Debug)]
pub struct Active {
    pub session_id: String,
    /// The webview label that started it.
    pub owner: String,
    pub mode: Mode,
    pub token: u64,
    pub ctl: mpsc::UnboundedSender<Ctl>,
    pub lease: Arc<MicLease>,
}

/// After a dictation took the mic from an Interactive session, this long for
/// Interactive to start again once without its window in front
/// ([`VoiceService::interactive_restart`]).
pub const INTERACTIVE_RESTART_WINDOW: Duration = Duration::from_secs(30);

/// A webview's Interactive session that a dictation (in the same webview) took the mic from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Preempted {
    /// The dictation (its token) still runs.
    During(u64),
    /// It ended: Interactive may start again unfocused, once, until then.
    Until(Instant),
}

/// What the registry lock guards: the live session, every webview's page
/// generation, and the Interactive sessions a dictation took the mic from.
#[derive(Default)]
struct Registry {
    active: Option<Active>,
    /// Bumped by every page load / window teardown of that webview label.
    pages: HashMap<String, u64>,
    /// By webview label ([`VoiceService::interactive_restart`]).
    preempted: HashMap<String, Preempted>,
}

/// Tauri-managed: the one voice session, the page generations, and the
/// cached VAD probe.
pub struct VoiceService {
    registry: Mutex<Registry>,
    tokens: AtomicU64,
    vad_probe: OnceLock<Result<(), String>>,
    mic: Box<dyn MicControl>,
    /// The voice sessions' system-audio tap (one at a time, app-wide).
    ref_tap: Box<dyn system_ref::RefTapControl>,
}

impl VoiceService {
    pub fn new(app: AppHandle) -> Self {
        Self::with_controls(Box::new(AppMic(app)), Box::new(system_ref::AppRefTap::default()))
    }

    pub fn with_mic(mic: Box<dyn MicControl>) -> Self {
        Self::with_controls(mic, Box::new(system_ref::NoRefTap))
    }

    pub fn with_controls(mic: Box<dyn MicControl>, ref_tap: Box<dyn system_ref::RefTapControl>) -> Self {
        Self {
            registry: Mutex::new(Registry::default()),
            tokens: AtomicU64::new(0),
            vad_probe: OnceLock::new(),
            mic,
            ref_tap,
        }
    }

    /// The voice system tap's controls (start and stop are blocking).
    pub fn ref_tap(&self) -> &dyn system_ref::RefTapControl {
        self.ref_tap.as_ref()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Registry> {
        self.registry.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn next_token(&self) -> u64 {
        self.tokens.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// The VAD can be built (probed once, on a blocking thread).
    pub fn vad_probe(&self) -> &Result<(), String> {
        self.vad_probe.get_or_init(|| vad::new_vad().map(|_| ()))
    }

    /// The current page generation of webview `owner`: read by `voice_start`
    /// on entry, handed back to [`Self::admit`].
    pub fn page_generation(&self, owner: &str) -> u64 {
        self.lock().pages.get(owner).copied().unwrap_or(0)
    }

    /// A session is registered: the mic is open, or about to be (the menu bar's "● Mic").
    pub fn live(&self) -> bool {
        self.lock().active.is_some()
    }

    /// Webview `owner` may start Interactive again without its window in
    /// front (voice_start's gate, security review 2026-10-31 P1-5): a
    /// dictation of the same webview took the mic from its Interactive
    /// session, and ended less than [`INTERACTIVE_RESTART_WINDOW`] ago. Once:
    /// any start of `owner`'s takes it. Any other end of an Interactive
    /// session (stopped, cancelled, its page gone, a capture) leaves none.
    pub fn interactive_restart(&self, owner: &str) -> bool {
        self.interactive_restart_at(owner, Instant::now())
    }

    pub fn interactive_restart_at(&self, owner: &str, now: Instant) -> bool {
        matches!(self.lock().preempted.get(owner), Some(Preempted::Until(t)) if now < *t)
    }

    /// Tell `owner`'s live session something (dictate.rs: the press is over,
    /// its panel's session ends). Whether there was one.
    pub fn send_owned(&self, owner: &str, ctl: Ctl) -> bool {
        let live = self.lock().active.as_ref().filter(|a| a.owner == owner).cloned();
        live.is_some_and(|a| a.ctl.send(ctl).is_ok())
    }

    /// Cheap pre-check: another webview owns the live session.
    pub fn busy_for(&self, owner: &str) -> bool {
        self.lock().active.as_ref().is_some_and(|a| a.owner != owner)
    }

    /// Admit and register `active`, all under the registry lock. Call with
    /// the recording (dual-stream) and mic locks held, `recording` read under
    /// the first, and `page` = [`Self::page_generation`] as `voice_start` read
    /// it on entry.
    ///
    /// Refused during a capture, for another webview's session, and when the
    /// owner's page went away since `page` was read (a reload, navigation or
    /// close during the start). A session the owner already has is replaced:
    /// its lease is taken without stopping the mic (the new session carries on
    /// with it) and it is returned, for the caller to end.
    pub fn admit(&self, recording: bool, active: Active, page: u64) -> Result<Option<Active>, Refusal> {
        if recording {
            return Err(Refusal::Recording);
        }
        let mut reg = self.lock();
        if reg.pages.get(&active.owner).copied().unwrap_or(0) != page {
            return Err(Refusal::PageGone);
        }
        let replaced = match reg.active.as_ref() {
            Some(a) if a.owner != active.owner => return Err(Refusal::Busy),
            Some(_) => {
                let old = reg.active.take();
                if let Some(old) = &old {
                    old.lease.take();
                }
                old
            }
            None => None,
        };
        // A dictation taking the mic from this webview's Interactive session:
        // it may start again by itself once the dictation ends. Any other
        // start of this webview's (Interactive itself included) takes that.
        if replaced.as_ref().is_some_and(|old| old.mode == Mode::Interactive) && active.mode == Mode::Dictation {
            reg.preempted.insert(active.owner.clone(), Preempted::During(active.token));
        } else {
            reg.preempted.remove(&active.owner);
        }
        reg.active = Some(active);
        Ok(replaced)
    }

    /// The session `token` is over.
    pub fn deregister(&self, token: u64) {
        self.deregister_at(token, Instant::now());
    }

    pub fn deregister_at(&self, token: u64, now: Instant) {
        let mut reg = self.lock();
        if reg.active.as_ref().is_some_and(|a| a.token == token) {
            reg.active = None;
        }
        // The dictation that took the mic from an Interactive session ended.
        for preempted in reg.preempted.values_mut() {
            if *preempted == Preempted::During(token) {
                *preempted = Preempted::Until(now + INTERACTIVE_RESTART_WINDOW);
            }
        }
    }

    pub fn find(&self, session_id: &str) -> Option<Active> {
        self.lock().active.as_ref().filter(|a| a.session_id == session_id).cloned()
    }

    /// Tell the session `session_id` something; a no-op for an unknown or
    /// finished session.
    pub fn send(&self, session_id: &str, ctl: Ctl) -> bool {
        match self.find(session_id) {
            Some(a) => a.ctl.send(ctl).is_ok(),
            None => false,
        }
    }

    /// The page in webview `label` is going away (loading, navigating,
    /// closed, or hidden to the tray): a start still in flight for it will be
    /// refused, and the session it owns is ended. Returns whether one was.
    pub fn end_for_page(&self, label: &str) -> bool {
        let owned = {
            let mut reg = self.lock();
            *reg.pages.entry(label.to_string()).or_insert(0) += 1;
            reg.preempted.remove(label);
            reg.active.as_ref().filter(|a| a.owner == label).cloned()
        };
        match owned {
            Some(a) => {
                crate::log_to_file(&format!(
                    "[voice] ending {:?} session {}: its page in {:?} went away",
                    a.mode, a.session_id, label
                ));
                let _ = a.ctl.send(Ctl::End(EndReason::Page));
                true
            }
            None => false,
        }
    }

    /// End the live session, releasing the mic and stopping any voice
    /// system tap before returning (a capture is about to take both, or the
    /// app is quitting). The lease goes first: a tap start racing this is
    /// refused. Every voice tap goes, not only the live session's: a replaced
    /// session's may still be running its teardown (its lease went at the
    /// replace, so it can't start another).
    pub fn end_now(&self, reason: EndReason) -> bool {
        let live = {
            let mut reg = self.lock();
            reg.preempted.clear();
            reg.active.clone()
        };
        let ended = match &live {
            Some(a) => {
                crate::log_to_file(&format!("[voice] ending {:?} session {} ({:?})", a.mode, a.session_id, reason));
                self.mic.release(&a.lease);
                true
            }
            None => false,
        };
        if self.ref_tap.stop_any() {
            crate::log_to_file(&format!("[voice] echo reference: system tap off ({reason:?}: stopped before returning)"));
        }
        if let Some(a) = live {
            let _ = a.ctl.send(Ctl::End(reason));
        }
        ended
    }

    pub fn release_mic(&self, lease: &MicLease) {
        self.mic.release(lease);
    }
}

/// A capture is about to take the mic (`start_recording`, meeting
/// auto-start, capture resume): end the voice session first, mic released by
/// the time this returns. Mirrors `tts::cancel_for_recording`. No-op before
/// the service exists. Never call it holding the mic lock.
pub fn end_for_recording(app: &AppHandle) {
    if let Some(voice) = app.try_state::<VoiceService>() {
        voice.end_now(EndReason::Recording);
    }
}

/// The page in webview `label` is loading, its window was destroyed, or the
/// main window was hidden to the tray. Mirrors `tts::cancel_for_page`.
pub fn end_for_page(app: &AppHandle, label: &str) {
    if let Some(voice) = app.try_state::<VoiceService>() {
        voice.end_for_page(label);
    }
}

/// App exit: end any session, mic released synchronously.
pub fn shutdown(app: &AppHandle) {
    if let Some(voice) = app.try_state::<VoiceService>() {
        voice.end_now(EndReason::Cancelled);
    }
}

#[cfg(test)]
mod tests;
