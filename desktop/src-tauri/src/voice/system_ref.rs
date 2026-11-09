//! The system-audio echo reference of a voice session on speakers.
//!
//! On laptop speakers a call's audio (Zoom, Meet, a video) plays out loud,
//! the mic hears it, and dictation or voice mode used to transcribe it as the
//! user: the voice canceller's reference was only Native Intelligence's own read-aloud
//! (conversation, interactive) or nothing at all (dictation). Meeting
//! captures already solve this with the system-audio tap
//! (`audio::capture_aec`); a voice session now borrows the same tap:
//!
//! ```text
//! SystemCapture (reference only: Core Audio process tap minus Native Intelligence's PID,
//!   Swift sidecar, 16 kHz f32 over a pipe) ──sample callback──▶ TapSlot ══▶ DSP thread
//!                                                                 (summed with read-aloud
//!                                                                  in conversation / interactive,
//!                                                                  alone in dictation)
//! ```
//!
//! - **Echo reference only.** The tap's audio goes to the canceller and
//!   nowhere else: never transcribed, never written to disk
//!   ([`SystemCapture::start_reference_only`]), never sent anywhere.
//! - **When** ([`decide`]): the system-audio permission is granted, the
//!   sidecar exists, and the default output is not headphones. Headphones
//!   can't leak, and leaving the tap off there also keeps macOS's
//!   system-audio indicator away. A route that can't be read, or the built-in
//!   jack (desk speakers as often as headphones, the same call
//!   `session::headphones_hint` makes), counts as speakers: the tap only ever
//!   adds a reference, so the cost of a wrong "speakers" is the indicator and
//!   [`DEFAULT_HOLD_MS`] of latency. Without the permission nothing is asked:
//!   the session runs exactly as before and logs why.
//! - **Alignment**: the sidecar never timestamps the tap and its reference
//!   arrives late through the pipe, so while the tap runs the DSP thread holds
//!   the mic back capture_aec's measured [`DEFAULT_HOLD_MS`] (`voice::dsp`).
//!   Without the tap there is no hold: today's zero-added-latency path.
//! - **One tap at a time, app-wide.** [`AppRefTap`] owns the voice tap behind
//!   a leaf lock (taken with nothing else held but, from `end_for_recording`,
//!   the recording lock; nothing is taken under it). A session's start is
//!   refused once its mic lease is gone, and `VoiceService::end_now` takes
//!   the lease and then stops the tap before returning, so a meeting
//!   capture's own SystemCapture never starts while a voice tap still runs.
//!   `end_now` stops whatever voice tap runs ([`RefTapControl::stop_any`]),
//!   a replaced session's included.
//! - **A dead tap comes back.** When the reference stalls (the sidecar
//!   exited on a coreaudiod restart or a crash, or stopped delivering) the
//!   DSP thread drops the hold and the session reconciles with a restart,
//!   at most [`RESTARTS`] times per [`RESTART_WINDOW`] and never sooner than
//!   [`RESTART_GAP`] after the last ([`RestartBudget`]), so a crash loop
//!   can't spin. A reconcile also restarts a same-session tap whose sidecar
//!   is gone.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::audio::output_route::{OutputKind, OutputRoute};
use crate::audio::system_capture::SystemCapture;
use crate::audio::tap::TapSlot;
use crate::permissions::SystemAudioPermission;

use super::session::headphones_hint;
use super::turn::Mode;
use super::MicLease;

pub use crate::audio::capture_aec::DEFAULT_HOLD_MS;

/// The sidecar's rate (and the canceller's).
pub const SYSTEM_REF_RATE: u32 = crate::audio::capture_aec::SAMPLE_RATE;

/// What the voice canceller's reference is made of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefMix {
    /// Dictation without the tap: no reference (zero frames).
    None,
    /// Conversation / interactive without the tap: read-aloud only.
    ReadAloud,
    /// Dictation with the tap: the system audio alone.
    System,
    /// Conversation / interactive with the tap: read-aloud plus system audio.
    ReadAloudAndSystem,
}

impl RefMix {
    pub fn of(mode: Mode, tap: bool) -> RefMix {
        match (mode.converses(), tap) {
            (false, false) => RefMix::None,
            (true, false) => RefMix::ReadAloud,
            (false, true) => RefMix::System,
            (true, true) => RefMix::ReadAloudAndSystem,
        }
    }

    pub fn describe(self) -> &'static str {
        match self {
            RefMix::None => "no reference",
            RefMix::ReadAloud => "read-aloud only",
            RefMix::System => "system audio alone",
            RefMix::ReadAloudAndSystem => "read-aloud plus system audio",
        }
    }
}

/// Whether the session runs the system tap, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub on: bool,
    pub reason: String,
    pub mix: RefMix,
}

/// The default output can't leak into the mic.
pub fn is_headphones(route: &OutputRoute) -> bool {
    headphones_hint(route)
}

/// When the tap runs: route × permission × sidecar, for `mode` (every mode
/// runs it on speakers; the mode only says what it is mixed with).
pub fn decide(mode: Mode, permission: SystemAudioPermission, sidecar: bool, route: Option<&OutputRoute>) -> Decision {
    let off = |reason: String| Decision { on: false, reason, mix: RefMix::of(mode, false) };
    let on = |reason: String| Decision { on: true, reason, mix: RefMix::of(mode, true) };
    if permission != SystemAudioPermission::Granted {
        return off(format!("no system-audio permission ({})", permission.as_str()));
    }
    if !sidecar {
        return off("the system-audio sidecar is missing".into());
    }
    match route {
        None => on("output route unknown, treated as speakers".into()),
        Some(r) if is_headphones(r) => off(format!("headphones: {:?}", r.name)),
        Some(r) => {
            let what = match r.kind {
                OutputKind::BuiltInSpeakers => "speakers",
                OutputKind::WiredHeadphones => "the built-in jack, maybe speakers",
                OutputKind::Bluetooth => "a Bluetooth output not named as headphones",
                OutputKind::Display => "a display's speakers",
                OutputKind::Other => "an output that may be speakers",
            };
            on(format!("{what}: {:?}", r.name))
        }
    }
}

/// The mic hold while the tap does (or doesn't) run.
pub fn hold_ms(system_on: bool) -> u64 {
    if system_on {
        DEFAULT_HOLD_MS
    } else {
        0
    }
}

/// Sum `src` into `dst` (the read-aloud frame gets the system audio played
/// at about the same time: the tap excludes Native Intelligence's own PID, so nothing is
/// counted twice).
pub fn mix_into<const N: usize>(dst: &mut [f32; N], src: &[f32; N]) {
    for (d, s) in dst.iter_mut().zip(src) {
        *d += *s;
    }
}

/// One reconcile job at a time (each runs on a blocking thread): a request
/// while one runs makes it run once more when it ends, so the last word
/// (a route that changed twice) always wins and two jobs never race.
#[derive(Debug, Default)]
pub struct Serial {
    busy: bool,
    again: bool,
}

impl Serial {
    /// A job is wanted: true when it should start now.
    pub fn request(&mut self) -> bool {
        if self.busy {
            self.again = true;
            false
        } else {
            self.busy = true;
            true
        }
    }

    /// The running job ended: true when another should start now.
    pub fn finished(&mut self) -> bool {
        if self.again {
            self.again = false;
            true
        } else {
            self.busy = false;
            false
        }
    }
}

/// Stall-driven restarts: at most this many...
pub const RESTARTS: usize = 3;
/// ...per this long...
pub const RESTART_WINDOW: Duration = Duration::from_secs(60);
/// ...and never sooner than this after the last.
pub const RESTART_GAP: Duration = Duration::from_secs(5);

/// The restarts a stalled tap may still get ([`RESTARTS`] per
/// [`RESTART_WINDOW`], [`RESTART_GAP`] apart).
#[derive(Debug, Default)]
pub struct RestartBudget(VecDeque<Instant>);

impl RestartBudget {
    /// One more restart at `now`, if the budget allows (counted when it does).
    pub fn allow(&mut self, now: Instant) -> bool {
        if self.0.back().is_some_and(|t| now.saturating_duration_since(*t) < RESTART_GAP) {
            return false;
        }
        while self.0.front().is_some_and(|t| now.saturating_duration_since(*t) >= RESTART_WINDOW) {
            self.0.pop_front();
        }
        if self.0.len() >= RESTARTS {
            return false;
        }
        self.0.push_back(now);
        true
    }

    pub fn used(&self) -> usize {
        self.0.len()
    }
}

/// What a start does with the one slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotAction {
    /// Nothing runs: start one.
    Start,
    /// This session's tap runs and delivers: nothing to do.
    Keep,
    /// This session's tap is dead, or a restart was asked for: stop it, start
    /// a new one.
    Restart,
    /// Another session's tap runs: stop it, start this one.
    Replace,
}

/// `current`: the running tap's session and whether its sidecar still
/// delivers; `restart`: the session asked for a fresh one (a stall).
pub fn slot_action(current: Option<(u64, bool)>, token: u64, restart: bool) -> SlotAction {
    match current {
        None => SlotAction::Start,
        Some((t, _)) if t != token => SlotAction::Replace,
        Some((_, alive)) if alive && !restart => SlotAction::Keep,
        Some(_) => SlotAction::Restart,
    }
}

/// Start and stop the voice tap (the app's [`AppRefTap`]; a fake in tests).
pub trait RefTapControl: Send + Sync {
    /// Run the tap for session `token`, feeding `feed`. Refused once the
    /// session's mic lease is gone (a capture took over, or it ended); a no-op
    /// when that session's tap already runs and delivers, unless `restart`;
    /// restarted when its sidecar is gone; another session's tap is stopped
    /// first ([`slot_action`]). Blocking (the sidecar starts).
    fn start(&self, token: u64, lease: &MicLease, feed: Arc<TapSlot>, restart: bool) -> Result<(), String>;
    /// Stop session `token`'s tap, if it runs. Returns whether one did.
    /// Blocking (the sidecar is waited for).
    fn stop(&self, token: u64) -> bool;
    /// Stop whatever voice tap runs, any session's (a capture is taking
    /// over). Returns whether one did. Blocking.
    fn stop_any(&self) -> bool;
}

/// No tap (tests, and anything without the app).
pub struct NoRefTap;

impl RefTapControl for NoRefTap {
    fn start(&self, _token: u64, _lease: &MicLease, _feed: Arc<TapSlot>, _restart: bool) -> Result<(), String> {
        Err("no system tap here".into())
    }

    fn stop(&self, _token: u64) -> bool {
        false
    }

    fn stop_any(&self) -> bool {
        false
    }
}

struct Running {
    token: u64,
    capture: SystemCapture,
}

/// The app's one voice tap (see the module docs for its lock).
#[derive(Default)]
pub struct AppRefTap {
    slot: Mutex<Option<Running>>,
}

impl AppRefTap {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Running>> {
        self.slot.lock().unwrap_or_else(|p| p.into_inner())
    }
}

fn stop_running(mut r: Running) {
    r.capture.set_sample_callback(None);
    if let Err(e) = r.capture.stop() {
        crate::log_to_file(&format!("[voice] system tap stop failed: {e}"));
    }
}

impl RefTapControl for AppRefTap {
    fn start(&self, token: u64, lease: &MicLease, feed: Arc<TapSlot>, restart: bool) -> Result<(), String> {
        let mut slot = self.lock();
        if !lease.held() {
            return Err("the session no longer holds the mic".into());
        }
        let current = slot.as_mut().map(|r| (r.token, r.capture.sidecar_alive()));
        match slot_action(current, token, restart) {
            SlotAction::Keep => return Ok(()),
            SlotAction::Start => {}
            SlotAction::Restart => {
                let alive = current.is_some_and(|(_, a)| a);
                crate::log_to_file(&format!(
                    "[voice] system tap restarting ({})",
                    if alive { "it stopped delivering" } else { "its sidecar is gone" }
                ));
                if let Some(old) = slot.take() {
                    stop_running(old);
                }
            }
            SlotAction::Replace => {
                if let Some(old) = slot.take() {
                    crate::log_to_file(&format!("[voice] system tap of an earlier session ({}) stopped for a new one", old.token));
                    stop_running(old);
                }
            }
        }
        let mut capture = SystemCapture::new();
        // A new epoch for the DSP thread: whatever it queued is from before.
        feed.begin_stream(SYSTEM_REF_RATE);
        let cb_feed = feed.clone();
        capture.set_sample_callback(Some(Box::new(move |samples: &[f32]| {
            if let Some(mut w) = cb_feed.acquire() {
                w.push_slice(samples);
            }
        })));
        capture.start_reference_only()?;
        *slot = Some(Running { token, capture });
        Ok(())
    }

    fn stop(&self, token: u64) -> bool {
        let mut slot = self.lock();
        if !slot.as_ref().is_some_and(|r| r.token == token) {
            return false;
        }
        if let Some(r) = slot.take() {
            stop_running(r);
        }
        true
    }

    fn stop_any(&self) -> bool {
        match self.lock().take() {
            Some(r) => {
                stop_running(r);
                true
            }
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(kind: OutputKind, name: &str, transport: &str) -> OutputRoute {
        OutputRoute { kind, name: name.into(), transport: transport.into(), data_source: None, device_id: 1 }
    }

    const MODES: [Mode; 3] = [Mode::Dictation, Mode::Conversation, Mode::Interactive];

    #[test]
    fn the_tap_runs_on_speakers_with_the_permission_in_every_mode() {
        let speakers = route(OutputKind::BuiltInSpeakers, "MacBook Pro Speakers", "bltn");
        for mode in MODES {
            let d = decide(mode, SystemAudioPermission::Granted, true, Some(&speakers));
            assert!(d.on, "{mode:?}: {d:?}");
            assert_eq!(d.mix, RefMix::of(mode, true));
        }
        assert_eq!(decide(Mode::Dictation, SystemAudioPermission::Granted, true, Some(&speakers)).mix, RefMix::System);
        assert_eq!(
            decide(Mode::Conversation, SystemAudioPermission::Granted, true, Some(&speakers)).mix,
            RefMix::ReadAloudAndSystem
        );
        assert_eq!(
            decide(Mode::Interactive, SystemAudioPermission::Granted, true, Some(&speakers)).mix,
            RefMix::ReadAloudAndSystem
        );
    }

    #[test]
    fn without_the_permission_or_the_sidecar_the_session_runs_as_before() {
        let speakers = route(OutputKind::BuiltInSpeakers, "MacBook Pro Speakers", "bltn");
        for mode in MODES {
            for perm in [
                SystemAudioPermission::Denied,
                SystemAudioPermission::NotDetermined,
                SystemAudioPermission::Unavailable,
                SystemAudioPermission::Unsupported,
                SystemAudioPermission::NotApplicable,
            ] {
                let d = decide(mode, perm, true, Some(&speakers));
                assert!(!d.on, "{mode:?} {perm:?}");
                assert!(d.reason.contains("permission"), "{}", d.reason);
                assert_eq!(d.mix, RefMix::of(mode, false), "today's reference");
            }
            let d = decide(mode, SystemAudioPermission::Granted, false, Some(&speakers));
            assert!(!d.on && d.reason.contains("sidecar"), "{d:?}");
        }
        assert_eq!(RefMix::of(Mode::Dictation, false), RefMix::None);
        assert_eq!(RefMix::of(Mode::Conversation, false), RefMix::ReadAloud);
    }

    #[test]
    fn headphones_never_run_the_tap_and_unknown_routes_count_as_speakers() {
        let headphones = [
            route(OutputKind::Bluetooth, "Liam's AirPods Pro", "blue"),
            route(OutputKind::Bluetooth, "Jabra Headset", "blue"),
            route(OutputKind::WiredHeadphones, "USB-C to 3.5mm Headphone Jack Adapter", "usb "),
        ];
        let speakers_or_unknown = [
            route(OutputKind::BuiltInSpeakers, "MacBook Pro Speakers", "bltn"),
            // The built-in jack: desk speakers as often as headphones.
            route(OutputKind::WiredHeadphones, "External Headphones", "bltn"),
            route(OutputKind::Bluetooth, "Beats Pill", "blue"),
            route(OutputKind::Display, "LG UltraFine", "dprt"),
            route(OutputKind::Other, "BlackHole 2ch", "virt"),
        ];
        for mode in MODES {
            for r in &headphones {
                let d = decide(mode, SystemAudioPermission::Granted, true, Some(r));
                assert!(!d.on, "{mode:?} {r:?}");
                assert!(d.reason.starts_with("headphones"), "{}", d.reason);
            }
            for r in &speakers_or_unknown {
                assert!(decide(mode, SystemAudioPermission::Granted, true, Some(r)).on, "{mode:?} {r:?}");
            }
            let d = decide(mode, SystemAudioPermission::Granted, true, None);
            assert!(d.on && d.reason.contains("unknown"), "{d:?}");
        }
    }

    #[test]
    fn the_hold_applies_only_with_the_tap() {
        assert_eq!(hold_ms(false), 0, "no tap: today's zero-added-latency path");
        assert_eq!(hold_ms(true), DEFAULT_HOLD_MS);
        assert_eq!(DEFAULT_HOLD_MS, 100, "capture_aec's measured hold");
    }

    #[test]
    fn mixing_sums_the_two_references_sample_by_sample() {
        let mut tts = [0.25f32, -0.5, 0.0, 0.1];
        mix_into(&mut tts, &[0.25, 0.25, -0.3, 0.0]);
        assert_eq!(tts, [0.5, -0.25, -0.3, 0.1]);
    }

    #[test]
    fn reconcile_jobs_never_overlap_and_the_last_request_runs() {
        let mut s = Serial::default();
        assert!(s.request(), "idle: runs now");
        assert!(!s.request(), "one runs: queued");
        assert!(!s.request(), "still just one more");
        assert!(s.finished(), "the queued one runs");
        assert!(!s.finished(), "and then nothing");
        assert!(s.request(), "idle again");
        assert!(!s.finished());
    }

    #[test]
    fn the_fake_tap_refuses() {
        let lease = MicLease::new();
        assert!(NoRefTap.start(1, &lease, Arc::new(TapSlot::new()), false).is_err());
        assert!(!NoRefTap.stop(1));
        assert!(!NoRefTap.stop_any());
    }

    #[test]
    fn a_dead_or_stalled_tap_of_the_same_session_is_restarted() {
        assert_eq!(slot_action(None, 7, false), SlotAction::Start);
        assert_eq!(slot_action(Some((7, true)), 7, false), SlotAction::Keep, "running and delivering: a no-op");
        assert_eq!(slot_action(Some((7, false)), 7, false), SlotAction::Restart, "its sidecar is gone");
        assert_eq!(slot_action(Some((7, true)), 7, true), SlotAction::Restart, "stalled although alive");
        assert_eq!(slot_action(Some((6, true)), 7, false), SlotAction::Replace, "another session's");
        assert_eq!(slot_action(Some((6, false)), 7, true), SlotAction::Replace);
    }

    #[test]
    fn stall_restarts_are_bounded_and_spaced() {
        let t0 = Instant::now();
        let s = |secs: u64| t0 + Duration::from_secs(secs);
        let mut b = RestartBudget::default();
        assert!(b.allow(s(0)));
        assert!(!b.allow(s(1)), "too soon after the last");
        assert!(b.allow(s(5)));
        assert!(b.allow(s(10)));
        assert!(!b.allow(s(20)), "three in the window already");
        assert_eq!(b.used(), 3);
        // The first ages out of the window: one more.
        assert!(b.allow(s(60)));
        assert!(!b.allow(s(62)), "too soon again");
        assert_eq!(b.used(), 3);
    }
}
