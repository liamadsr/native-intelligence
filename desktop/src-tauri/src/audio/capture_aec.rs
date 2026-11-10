//! Echo cancellation in meeting captures (web/docs/plans/chat-voice.md
//! §3.5, work package W3).
//!
//! On laptop speakers the other participants' voices come back into the mic
//! and get transcribed a second time, as the user. In a dual-stream capture
//! the far end is already being recorded: the system-audio tap. This worker
//! feeds it to the shared canceller (`audio::aec`, [`AecTuning::Capture`]) as
//! the reference and hands the CLEANED mic to transcription (local-stt and
//! `audio://mic`, which feeds Deepgram and Voice ID) in place of the raw one.
//!
//! ```text
//! MicCapture 16 kHz (sample callback) ──Mic──┐
//!                                            ├─▶ worker thread ─▶ cleaned 16 kHz ─┬─▶ local-stt (STREAM_MIC)
//! SystemCapture 16 kHz (sample callback) ─Ref┘   (hold, render      (or the raw     └─▶ audio://mic emitter
//!                                                 then capture)      mic, bypassed)
//! ```
//!
//! What does NOT change: the mic WAV (MicCapture writes it itself, raw), the
//! level meter, the system WAV and every system-audio consumer.
//!
//! **The timeline is exact.** The capture side is MicCapture's own 16 kHz
//! output, the very samples the WAV gets, and every sample in comes out once,
//! in order (cleaned, or raw while bypassed): output sample k is mic sample k,
//! so transcript times match the recording. Alignment is achieved by delaying
//! when a mic frame is *processed*, never by inserting or dropping mic samples.
//! (The raw device-rate tap is not used on purpose: a second resampler on it
//! only matches MicCapture's while nothing is lost, and across a ring overflow
//! or a stream reopen the reader can't find the boundary in the ring, so the
//! cleaned stream would slip against the WAV.)
//!
//! **Alignment** (§3.5 item 3). The reference must reach the canceller before
//! the echo it explains. Nothing timestamps the tap: the Swift sidecar's IOProc
//! ignores its `AudioTimeStamp`s and writes bare float32 to a pipe. So the mic
//! is held back a fixed [`DEFAULT_HOLD_MS`]: a mic frame that arrived at `t`
//! is processed at `t + hold`, after every reference frame that arrived by then
//! went in. The health machine moves the hold if the canceller looks
//! misaligned. Both streams are stamped on arrival, in their callbacks.
//!
//! **The sidecar's reference runs 3906 ppm short.** It converts each IOProc
//! buffer on its own with `AVAudioConverter` and a floor() output capacity;
//! with 512-frame buffers at 48 kHz one input buffer in 256 is never consumed
//! (checked offline, see the W3 report), so 10.7 ms of far end goes missing
//! every ~2.7 s and the reference falls 14 s an hour behind the mic. aec3
//! absorbs that as render underruns and still removes ~20–24 dB of bleed in
//! simulation (a clean tap: 32–48 dB). Filling the holes with silence (~10 dB)
//! or stretching the reference (~5 dB) did worse, so nothing is inserted: the
//! [`Balance`] meter only measures the render/capture drift for the logs and
//! the ±2 s rule. The same underruns make aec3's own ERLE read ~0 dB, which is
//! why the health rules also look at a measured ERLE proxy.
//!
//! **Health and bypass** (§3.5 item 4): [`Health`], a pure state machine on
//! the mic clock. Bypassed, the raw mic goes out while the canceller keeps
//! running on the side so it can come back.
//!
//! The canceller is `!Send`: the worker builds it on its own thread.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::aec::{AecMetrics, AecTuning, EchoCanceller, AEC_FRAME};
use super::resample::StreamResampler;

/// The canceller's rate; MicCapture and the sidecar both deliver it.
pub const SAMPLE_RATE: u32 = 16_000;
/// One canceller frame.
pub const FRAME_MS: u64 = 10;
/// How long a mic frame waits for its reference, unmeasured (§3.5 item 3: a
/// tap arriving 100 ms after the mic leaked 45% of the remote words).
pub const DEFAULT_HOLD_MS: u64 = 100;
/// One hold adjustment, and its range.
pub const HOLD_STEP_MS: u64 = 100;
pub const MAX_HOLD_MS: u64 = 400;
/// Reference frames that arrived this much before the deadline of the mic
/// frame being processed belong to a mic gap (pause, dead device) and are
/// dropped, not pushed in one burst. In steady state every reference frame
/// is consumed by the next mic frame's deadline, at most one mic callback
/// (tens of ms) after it arrived. (The voice session's system reference
/// drops them by the same rule, `voice::dsp`.)
pub(crate) const STALE_REF_MS: u64 = 250;
/// The most reference kept waiting (3 s); older frames go first.
const MAX_REF_QUEUE_FRAMES: usize = 300;
/// A mic arrival gap this long (pause, a stall) re-settles the balance.
const MIC_GAP_MS: u64 = 500;
/// Past this much lateness a frame passes raw without the canceller, so a
/// stalled worker catches up instead of falling further behind.
const HARD_QUEUE_MS: u64 = 1_000;
/// A reference frame at or above this RMS counts as far-end activity
/// (-50 dBFS, the voice session's far-end threshold).
pub const REF_ACTIVE_RMS: f32 = 0.003;
/// ...and keeps the reference "active" this long after.
const REF_ACTIVE_HOLD_MS: u64 = 200;
/// A health line every this much mic time.
const HEALTH_LOG_MS: u64 = 30_000;

// ── the pure health machine ────────────────────────────────────────────────

/// No echo path (headphones): reference active, ERL < 0 dB and ERLE < 1 dB for
/// 30 s of active reference. Back on after ERL > +3 dB and ERLE > +3 dB for 5 s.
pub const NO_ECHO_TRIP_MS: u64 = 30_000;
pub const NO_ECHO_CLEAR_MS: u64 = 5_000;
/// Misaligned: judged only after 10 s of active reference; a 20 s run of
/// misaligned frames moves the hold; the third run in one episode (60 s)
/// bypasses. 5 s of aligned frames ends an episode, or a bypass.
pub const MISALIGNED_AFTER_REF_MS: u64 = 10_000;
pub const MISALIGNED_RUN_MS: u64 = 20_000;
pub const MISALIGNED_BYPASS_RUNS: u32 = 3;
pub const MISALIGNED_CLEAR_MS: u64 = 5_000;
/// Delay estimates at or beyond this, or below [`DELAY_NEAR_ZERO_MS`], look
/// like a reference outside the canceller's reach.
pub const DELAY_STUCK_HIGH_MS: i32 = 450;
pub const DELAY_NEAR_ZERO_MS: i32 = 10;
/// Reference stalled: this long with no reference frame at all, or a
/// render/capture backlog beyond ±[`MAX_BACKLOG_MS`].
pub const REF_STALL_MS: u64 = 500;
pub const MAX_BACKLOG_MS: i64 = 2_000;
/// Sustained low health: < 50% healthy frames over the last 5 minutes, only
/// after the first minute, and only with at least 30 s of frames to judge.
/// Back on at 60%.
pub const LOW_HEALTH_WINDOW_S: usize = 300;
pub const LOW_HEALTH_AFTER_MS: u64 = 60_000;
pub const LOW_HEALTH_MIN_JUDGED_MS: u64 = 30_000;
pub const LOW_HEALTH_TRIP: f64 = 0.5;
pub const LOW_HEALTH_CLEAR: f64 = 0.6;
/// A judged frame is healthy at this API ERLE or more (healthy reads 8–9 dB).
pub const HEALTHY_ERLE_DB: f32 = 4.0;
/// Too slow: worker p99 over [`SLOW_WINDOW_FRAMES`] beyond 5 ms a frame, or
/// a mic queue (lateness past the hold) beyond 500 ms. Back on when a whole
/// window's p99 is within budget and the queue is under 100 ms.
pub const SLOW_P99_US: u32 = 5_000;
pub const SLOW_QUEUE_MS: u64 = 500;
pub const SLOW_CLEAR_QUEUE_MS: u64 = 100;
pub const SLOW_WINDOW_FRAMES: u32 = 3_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BypassReason {
    RefStalled,
    TooSlow,
    Misaligned,
    NoEchoPath,
    LowHealth,
}

impl BypassReason {
    /// Highest priority first: the reason a bypass is reported under.
    pub const ALL: [BypassReason; 5] = [
        BypassReason::RefStalled,
        BypassReason::TooSlow,
        BypassReason::Misaligned,
        BypassReason::NoEchoPath,
        BypassReason::LowHealth,
    ];

    pub fn name(self) -> &'static str {
        match self {
            BypassReason::RefStalled => "reference stalled",
            BypassReason::TooSlow => "too slow",
            BypassReason::Misaligned => "misaligned",
            BypassReason::NoEchoPath => "no echo path (headphones?)",
            BypassReason::LowHealth => "sustained low health",
        }
    }

    fn index(self) -> usize {
        match self {
            BypassReason::RefStalled => 0,
            BypassReason::TooSlow => 1,
            BypassReason::Misaligned => 2,
            BypassReason::NoEchoPath => 3,
            BypassReason::LowHealth => 4,
        }
    }
}

/// What the machine sees for one processed mic frame.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct FrameObs {
    /// At least one reference frame went in with this mic frame.
    pub ref_present: bool,
    /// The reference carried signal recently (far-end speech).
    pub ref_active: bool,
    /// aec3's own ERLE (the API metric).
    pub erle_db: Option<f32>,
    /// Measured ERLE: smoothed mic power over the canceller's output power,
    /// on far-end-active frames. Reads low in double talk, but unlike the API
    /// metric it doesn't collapse when aec3 resets its estimators.
    pub erle_proxy_db: Option<f32>,
    pub erl_db: Option<f32>,
    pub delay_ms: Option<i32>,
    /// Render minus capture frames against where they settled, in ms.
    pub backlog_ms: i64,
    /// Worker time spent on this frame.
    pub cost_us: u32,
    /// How late past its hold this frame was processed.
    pub queue_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthAction {
    /// This rule now bypasses the canceller.
    Bypass(BypassReason),
    /// This rule no longer does.
    Resume(BypassReason),
    /// Move the mic hold by this many ms (misalignment, before bypassing).
    AdjustHold(i64),
    /// Reset the canceller (the reference came back, or the backlog blew up).
    ResetCanceller,
}

/// Per-second buckets of (healthy, judged) frames over the last 5 minutes.
#[derive(Debug, Clone)]
struct HealthWindow {
    buckets: VecDeque<(u32, u32)>,
    current: (u32, u32),
    current_frames: u32,
}

impl HealthWindow {
    fn new() -> Self {
        Self { buckets: VecDeque::with_capacity(LOW_HEALTH_WINDOW_S + 1), current: (0, 0), current_frames: 0 }
    }

    fn push(&mut self, judged: bool, healthy: bool) {
        if judged {
            self.current.1 += 1;
            if healthy {
                self.current.0 += 1;
            }
        }
        self.current_frames += 1;
        if self.current_frames as u64 * FRAME_MS >= 1_000 {
            self.buckets.push_back(self.current);
            if self.buckets.len() > LOW_HEALTH_WINDOW_S {
                self.buckets.pop_front();
            }
            self.current = (0, 0);
            self.current_frames = 0;
        }
    }

    /// (healthy, judged) frames over the window.
    fn totals(&self) -> (u64, u64) {
        self.buckets
            .iter()
            .chain(std::iter::once(&self.current))
            .fold((0, 0), |(h, j), &(bh, bj)| (h + bh as u64, j + bj as u64))
    }
}

/// Worker cost per frame: a histogram in 100 µs steps (the last bucket holds
/// everything from 50 ms up), for p50/p99 without sorting.
#[derive(Debug, Clone)]
pub struct CostHistogram {
    buckets: [u32; 501],
    count: u32,
}

impl Default for CostHistogram {
    fn default() -> Self {
        Self { buckets: [0; 501], count: 0 }
    }
}

impl CostHistogram {
    pub fn push(&mut self, us: u32) {
        let i = ((us / 100) as usize).min(self.buckets.len() - 1);
        self.buckets[i] += 1;
        self.count += 1;
    }

    pub fn count(&self) -> u32 {
        self.count
    }

    /// The upper edge of the bucket holding quantile `q`, in µs.
    pub fn quantile_us(&self, q: f64) -> u32 {
        if self.count == 0 {
            return 0;
        }
        let rank = ((self.count as f64) * q).ceil().max(1.0) as u32;
        let mut seen = 0;
        for (i, &n) in self.buckets.iter().enumerate() {
            seen += n;
            if seen >= rank {
                return (i as u32 + 1) * 100;
            }
        }
        self.buckets.len() as u32 * 100
    }

    pub fn clear(&mut self) {
        *self = Self::default();
    }
}

/// The auto-bypass rules of chat-voice.md §3.5 item 4, as a pure machine.
/// "ERLE" in the rules is the better of aec3's API ERLE and the measured
/// proxy (see [`FrameObs::erle_proxy_db`]).
/// Time is the mic clock (`now_ms`, 10 ms per processed frame), injected by
/// the caller, so a pause stops every timer and tests need no clock. Each rule
/// trips and clears on its own; the canceller is bypassed while any is
/// tripped. Double talk and brief dips never trip anything: every rule needs
/// seconds of evidence.
#[derive(Debug, Clone)]
pub struct Health {
    tripped: [bool; 5],
    // no echo path
    no_echo_run_ms: u64,
    echo_back_run_ms: u64,
    // misaligned
    ref_seen_ms: u64,
    misaligned_run_ms: u64,
    aligned_run_ms: u64,
    misaligned_runs: u32,
    // reference stalled
    no_ref_run_ms: u64,
    /// The stall was a backlog blow-up, already answered with a reset.
    stall_was_backlog: bool,
    // low health
    window: HealthWindow,
    // too slow
    costs: CostHistogram,
    last_window_p99_us: Option<u32>,
}

impl Default for Health {
    fn default() -> Self {
        Self::new()
    }
}

impl Health {
    pub fn new() -> Self {
        Self {
            tripped: [false; 5],
            no_echo_run_ms: 0,
            echo_back_run_ms: 0,
            ref_seen_ms: 0,
            misaligned_run_ms: 0,
            aligned_run_ms: 0,
            misaligned_runs: 0,
            no_ref_run_ms: 0,
            stall_was_backlog: false,
            window: HealthWindow::new(),
            costs: CostHistogram::default(),
            last_window_p99_us: None,
        }
    }

    /// The canceller is bypassed (any rule tripped).
    pub fn bypassed(&self) -> bool {
        self.tripped.iter().any(|&t| t)
    }

    /// The reason a bypass is reported under (the highest-priority tripped rule).
    pub fn reason(&self) -> Option<BypassReason> {
        BypassReason::ALL.into_iter().find(|r| self.tripped[r.index()])
    }

    pub fn is_tripped(&self, reason: BypassReason) -> bool {
        self.tripped[reason.index()]
    }

    fn set(&mut self, reason: BypassReason, on: bool, actions: &mut Vec<HealthAction>) {
        let slot = &mut self.tripped[reason.index()];
        if *slot != on {
            *slot = on;
            actions.push(if on { HealthAction::Bypass(reason) } else { HealthAction::Resume(reason) });
        }
    }

    /// The canceller was reset (new mic stream, or the reference came back):
    /// the echo-path rules start over. The others (stall, speed, the 5-minute
    /// health window) describe the plumbing and carry on.
    pub fn reset_echo_path(&mut self, actions: &mut Vec<HealthAction>) {
        self.no_echo_run_ms = 0;
        self.echo_back_run_ms = 0;
        self.ref_seen_ms = 0;
        self.misaligned_run_ms = 0;
        self.aligned_run_ms = 0;
        self.misaligned_runs = 0;
        self.set(BypassReason::NoEchoPath, false, actions);
        self.set(BypassReason::Misaligned, false, actions);
    }

    /// One processed mic frame. `hold_ms` is the current mic hold (to know
    /// whether it can still move).
    pub fn tick(&mut self, now_ms: u64, o: &FrameObs, hold_ms: u64, actions: &mut Vec<HealthAction>) {
        let dt = FRAME_MS;
        // The better of the two ERLE readings: either one saying the echo is
        // going away is enough (the API one collapses on aec3's underruns,
        // the proxy one in double talk).
        let erle = match (o.erle_db, o.erle_proxy_db) {
            (Some(a), Some(p)) => Some(a.max(p)),
            (a, p) => a.or(p),
        };
        let erl = o.erl_db;

        // ── reference stalled ─────────────────────────────────────────
        if o.ref_present {
            self.no_ref_run_ms = 0;
        } else {
            self.no_ref_run_ms += dt;
        }
        let backlog_bad = o.backlog_ms.abs() > MAX_BACKLOG_MS;
        if backlog_bad {
            // The two streams have come apart: start them over.
            actions.push(HealthAction::ResetCanceller);
            self.stall_was_backlog = true;
            self.set(BypassReason::RefStalled, true, actions);
        } else if self.no_ref_run_ms >= REF_STALL_MS {
            self.stall_was_backlog = false;
            self.set(BypassReason::RefStalled, true, actions);
        } else if o.ref_present && self.is_tripped(BypassReason::RefStalled) {
            // It resumed: reset (whatever the canceller learned is stale,
            // unless that reset already happened), then on.
            if !self.stall_was_backlog {
                actions.push(HealthAction::ResetCanceller);
            }
            self.stall_was_backlog = false;
            self.set(BypassReason::RefStalled, false, actions);
        }

        // ── too slow ──────────────────────────────────────────────────
        self.costs.push(o.cost_us);
        if self.costs.count() >= SLOW_WINDOW_FRAMES {
            self.last_window_p99_us = Some(self.costs.quantile_us(0.99));
            self.costs.clear();
        }
        let p99_bad = self.last_window_p99_us.is_some_and(|p| p > SLOW_P99_US);
        if o.queue_ms > SLOW_QUEUE_MS || p99_bad {
            self.set(BypassReason::TooSlow, true, actions);
        } else if self.is_tripped(BypassReason::TooSlow)
            && o.queue_ms <= SLOW_CLEAR_QUEUE_MS
            && self.last_window_p99_us.is_some_and(|p| p <= SLOW_P99_US)
        {
            self.set(BypassReason::TooSlow, false, actions);
        }

        // Only frames with far-end signal say anything about the echo path.
        if o.ref_active {
            let judge_alignment = self.ref_seen_ms >= MISALIGNED_AFTER_REF_MS;
            self.ref_seen_ms += dt;

            // ── no echo path (headphones) ─────────────────────────────
            let quiet = erl.is_some_and(|l| l < 0.0) && erle.is_some_and(|e| e < 1.0);
            let echo_back = erl.is_some_and(|l| l > 3.0) && erle.is_some_and(|e| e > 3.0);
            if self.is_tripped(BypassReason::NoEchoPath) {
                self.echo_back_run_ms = if echo_back { self.echo_back_run_ms + dt } else { 0 };
                if self.echo_back_run_ms >= NO_ECHO_CLEAR_MS {
                    self.echo_back_run_ms = 0;
                    self.no_echo_run_ms = 0;
                    self.set(BypassReason::NoEchoPath, false, actions);
                }
            } else {
                self.no_echo_run_ms = if quiet { self.no_echo_run_ms + dt } else { 0 };
                if self.no_echo_run_ms >= NO_ECHO_TRIP_MS {
                    self.set(BypassReason::NoEchoPath, true, actions);
                }
            }

            // ── misaligned ────────────────────────────────────────────
            // The canceller isn't cancelling an echo that is there (ERLE < 2
            // with ERL > +3), or its delay sits at the edge of its reach while
            // it isn't cancelling. A delay alone never counts: a working
            // canceller at 450 ms is left alone.
            let not_cancelling = erle.is_some_and(|e| e < 2.0) && erl.is_some_and(|l| l > 3.0);
            let delay_high = o.delay_ms.is_some_and(|d| d >= DELAY_STUCK_HIGH_MS);
            let delay_zero = o.delay_ms.is_some_and(|d| d < DELAY_NEAR_ZERO_MS);
            let weak = erle.is_none_or(|e| e < HEALTHY_ERLE_DB);
            let misaligned = not_cancelling || ((delay_high || delay_zero) && weak);
            if judge_alignment {
                if misaligned {
                    self.aligned_run_ms = 0;
                    self.misaligned_run_ms += dt;
                    if self.misaligned_run_ms >= MISALIGNED_RUN_MS {
                        self.misaligned_run_ms = 0;
                        self.misaligned_runs += 1;
                        if self.misaligned_runs >= MISALIGNED_BYPASS_RUNS {
                            self.set(BypassReason::Misaligned, true, actions);
                        } else {
                            // Adjust the hold first: a delay at the top of the
                            // search means the reference leads too much (hold
                            // less); anything else, that it comes too late
                            // (hold more).
                            let step = if delay_high { -(HOLD_STEP_MS as i64) } else { HOLD_STEP_MS as i64 };
                            let next = hold_ms as i64 + step;
                            if (0..=MAX_HOLD_MS as i64).contains(&next) {
                                actions.push(HealthAction::AdjustHold(step));
                            }
                        }
                    }
                } else {
                    self.misaligned_run_ms = 0;
                    self.aligned_run_ms += dt;
                    if self.aligned_run_ms >= MISALIGNED_CLEAR_MS {
                        self.misaligned_runs = 0;
                        self.set(BypassReason::Misaligned, false, actions);
                    }
                }
            }
        }

        // ── sustained low health ──────────────────────────────────────
        // Judged: far-end signal and an echo path to cancel (ERL ≥ 0).
        let judged = o.ref_active && erl.is_some_and(|l| l >= 0.0);
        let healthy = erle.is_some_and(|e| e >= HEALTHY_ERLE_DB);
        self.window.push(judged, healthy);
        if now_ms >= LOW_HEALTH_AFTER_MS {
            let (h, j) = self.window.totals();
            if j * FRAME_MS >= LOW_HEALTH_MIN_JUDGED_MS {
                let share = h as f64 / j as f64;
                if share < LOW_HEALTH_TRIP {
                    self.set(BypassReason::LowHealth, true, actions);
                } else if share >= LOW_HEALTH_CLEAR {
                    self.set(BypassReason::LowHealth, false, actions);
                }
            }
        }
    }
}

// ── the render/capture balance ─────────────────────────────────────────────

/// Frames per balance window (1 s of mic).
const BALANCE_WINDOW_FRAMES: u32 = 100;
/// The reference must have flowed through the window for it to count.
const BALANCE_MIN_PRESENT: u32 = 90;

/// Render minus capture frames, measured. It jitters with how the two
/// streams arrive; its maximum over a 1 s window is the jitter-free level.
/// The first full window with the reference flowing sets the baseline; the
/// backlog is how far the latest level has moved from it (the reference
/// falling behind or running ahead of the mic). Nothing is corrected: see the
/// module docs for why.
#[derive(Debug, Clone, Default)]
pub struct Balance {
    base: Option<i64>,
    level: Option<i64>,
    win_max: Option<i64>,
    win_frames: u32,
    win_present: u32,
}

impl Balance {
    /// Start over: the next full window sets the baseline again.
    pub fn resync(&mut self) {
        *self = Self::default();
    }

    /// After a capture frame: `present` reference frames went in with it and
    /// render − capture is now `balance`.
    pub fn observe(&mut self, present: u32, balance: i64) {
        self.win_max = Some(self.win_max.map_or(balance, |m| m.max(balance)));
        self.win_frames += 1;
        self.win_present += present;
        if self.win_frames < BALANCE_WINDOW_FRAMES {
            return;
        }
        if self.win_present >= BALANCE_MIN_PRESENT {
            let max = self.win_max.unwrap_or(balance);
            self.level = Some(max);
            self.base.get_or_insert(max);
        }
        self.win_max = None;
        self.win_frames = 0;
        self.win_present = 0;
    }

    /// Latest level against the baseline, in frames (0 until settled).
    pub fn backlog_frames(&self) -> i64 {
        match (self.base, self.level) {
            (Some(b), Some(l)) => l - b,
            _ => 0,
        }
    }

    #[cfg(test)]
    pub fn settled(&self) -> bool {
        self.base.is_some()
    }
}

// ── the core: frames in, cleaned frames out ────────────────────────────────

struct MicFrame {
    data: [f32; AEC_FRAME],
    at_ms: u64,
    generation: u64,
}

struct RefFrame {
    data: [f32; AEC_FRAME],
    at_ms: u64,
}

/// What the core has done, for the health lines and the summary.
#[derive(Debug, Clone, Default)]
pub struct CoreStats {
    pub mic_samples_in: u64,
    pub samples_out: u64,
    pub frames: u64,
    pub bypassed_frames: u64,
    pub skipped_frames: u64,
    pub ref_frames_in: u64,
    pub stale_ref_frames: u64,
    pub overflow_ref_frames: u64,
    pub resets: u64,
    pub starved_frames: u64,
    pub mic_chunk_max: usize,
    pub ref_chunk_max: usize,
}

/// A 30 s health window's sums.
#[derive(Debug, Clone, Default)]
struct WindowStats {
    frames: u64,
    starved: u64,
    ref_in: u64,
    active_frames: u64,
    active_mic_power: f64,
    active_out_power: f64,
    costs: CostHistogram,
    max_queue_ms: u64,
}

/// The single-threaded heart of the worker: stamp-ordered mic and reference
/// frames in, one output sample per mic sample out. Time (`now_ms`, arrival
/// stamps) is injected, so tests drive it with synthetic clocks.
pub struct CaptureAecCore {
    canceller: Option<Box<dyn EchoCanceller>>,
    health: Health,
    balance: Balance,
    hold_ms: u64,
    mic_partial: Vec<f32>,
    mic_frames: VecDeque<MicFrame>,
    last_mic_at: Option<u64>,
    generation: Option<u64>,
    ref_resampler: Option<StreamResampler>,
    ref_resampled: Vec<f32>,
    ref_partial: Vec<f32>,
    ref_frames: VecDeque<RefFrame>,
    render_since_sync: i64,
    capture_since_sync: i64,
    ref_active_until_ms: u64,
    last_metrics: AecMetrics,
    /// Smoothed mic and cleaned power on far-end-active frames (the proxy).
    proxy_mic: f64,
    proxy_out: f64,
    proxy_frames: u32,
    /// Frames were skipped for lateness: reset before the next processed one.
    needs_reset: bool,
    actions: Vec<HealthAction>,
    stats: CoreStats,
    window: WindowStats,
    next_log_ms: u64,
    /// Log lines for the owner to write (crate::log_to_file in the app).
    pub logs: Vec<String>,
}

impl CaptureAecCore {
    /// `canceller: None` passes the mic straight through, unheld (the
    /// canceller could not be built).
    pub fn new(canceller: Option<Box<dyn EchoCanceller>>, ref_rate: u32) -> Self {
        let passthrough = canceller.is_none();
        let ref_resampler = StreamResampler::new(ref_rate.max(1), SAMPLE_RATE).ok();
        Self {
            canceller,
            health: Health::new(),
            balance: Balance::default(),
            hold_ms: if passthrough { 0 } else { DEFAULT_HOLD_MS },
            mic_partial: Vec::with_capacity(AEC_FRAME),
            mic_frames: VecDeque::new(),
            last_mic_at: None,
            generation: None,
            ref_resampler,
            ref_resampled: Vec::new(),
            ref_partial: Vec::with_capacity(AEC_FRAME),
            ref_frames: VecDeque::new(),
            render_since_sync: 0,
            capture_since_sync: 0,
            ref_active_until_ms: 0,
            last_metrics: AecMetrics::default(),
            proxy_mic: 0.0,
            proxy_out: 0.0,
            proxy_frames: 0,
            needs_reset: false,
            actions: Vec::new(),
            stats: CoreStats::default(),
            window: WindowStats::default(),
            next_log_ms: HEALTH_LOG_MS,
            logs: Vec::new(),
        }
    }

    pub fn hold_ms(&self) -> u64 {
        self.hold_ms
    }

    #[cfg(test)]
    pub fn health(&self) -> &Health {
        &self.health
    }

    /// The measured ERLE (see [`FrameObs::erle_proxy_db`]), once it has
    /// half a second of far-end frames behind it.
    pub fn erle_proxy_db(&self) -> Option<f32> {
        (self.proxy_frames >= 50 && self.proxy_out > 0.0)
            .then(|| (10.0 * (self.proxy_mic / self.proxy_out).log10()) as f32)
    }

    #[cfg(test)]
    pub fn stats(&self) -> &CoreStats {
        &self.stats
    }

    /// When the oldest waiting mic frame is due, if any.
    pub fn next_due_ms(&self) -> Option<u64> {
        self.mic_frames.front().map(|f| f.at_ms + self.hold_ms)
    }

    /// 16 kHz mic samples that arrived at `at_ms`, from mic stream `generation`.
    pub fn push_mic(&mut self, samples: &[f32], at_ms: u64, generation: u64) {
        if samples.is_empty() {
            return;
        }
        self.stats.mic_samples_in += samples.len() as u64;
        self.stats.mic_chunk_max = self.stats.mic_chunk_max.max(samples.len());
        if self.last_mic_at.is_some_and(|last| at_ms.saturating_sub(last) >= MIC_GAP_MS) {
            // A pause or a stall: whatever balance had settled is from before it.
            self.balance.resync();
            self.render_since_sync = 0;
            self.capture_since_sync = 0;
        }
        self.last_mic_at = Some(at_ms);
        let mut rest = samples;
        while !rest.is_empty() {
            let take = (AEC_FRAME - self.mic_partial.len()).min(rest.len());
            self.mic_partial.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if self.mic_partial.len() == AEC_FRAME {
                let mut data = [0.0; AEC_FRAME];
                data.copy_from_slice(&self.mic_partial);
                self.mic_partial.clear();
                self.mic_frames.push_back(MicFrame { data, at_ms, generation });
            }
        }
    }

    /// Reference samples (the system tap, at the rate given to `new`) that
    /// arrived at `at_ms`.
    pub fn push_ref(&mut self, samples: &[f32], at_ms: u64) {
        if samples.is_empty() || self.canceller.is_none() {
            return;
        }
        self.stats.ref_chunk_max = self.stats.ref_chunk_max.max(samples.len());
        self.ref_resampled.clear();
        match self.ref_resampler.as_mut() {
            Some(r) => r.process(samples, &mut self.ref_resampled),
            None => return,
        }
        let mut i = 0;
        while i < self.ref_resampled.len() {
            let take = (AEC_FRAME - self.ref_partial.len()).min(self.ref_resampled.len() - i);
            self.ref_partial.extend_from_slice(&self.ref_resampled[i..i + take]);
            i += take;
            if self.ref_partial.len() == AEC_FRAME {
                let mut data = [0.0; AEC_FRAME];
                data.copy_from_slice(&self.ref_partial);
                self.ref_partial.clear();
                self.ref_frames.push_back(RefFrame { data, at_ms });
                self.stats.ref_frames_in += 1;
                self.window.ref_in += 1;
                if self.ref_frames.len() > MAX_REF_QUEUE_FRAMES {
                    self.ref_frames.pop_front();
                    self.stats.overflow_ref_frames += 1;
                }
            }
        }
    }

    /// Process every mic frame whose hold has passed at `now_ms`, appending
    /// the output (cleaned, or raw while bypassed) to `out`.
    pub fn process(&mut self, now_ms: u64, out: &mut Vec<f32>) {
        while let Some(due) = self.next_due_ms() {
            if due > now_ms {
                break;
            }
            let frame = self.mic_frames.pop_front().expect("a frame is due");
            self.process_frame(frame, Some(due), Some(now_ms - due), out);
        }
    }

    /// End of the capture: everything left, the partial frame included (run
    /// zero-padded, only its real samples come out), with every reference
    /// that arrived.
    pub fn flush(&mut self, out: &mut Vec<f32>) {
        while let Some(frame) = self.mic_frames.pop_front() {
            let deadline = frame.at_ms + self.hold_ms;
            self.process_frame(frame, Some(deadline), None, out);
        }
        if !self.mic_partial.is_empty() {
            let n = self.mic_partial.len();
            let mut data = [0.0; AEC_FRAME];
            data[..n].copy_from_slice(&self.mic_partial);
            self.mic_partial.clear();
            let generation = self.generation.unwrap_or(0);
            let mut tail = Vec::with_capacity(AEC_FRAME);
            let frame = MicFrame { data, at_ms: self.last_mic_at.unwrap_or(0), generation };
            self.process_frame(frame, None, None, &mut tail);
            out.extend_from_slice(&tail[..n]);
            // Only the real samples count as output.
            self.stats.samples_out -= (AEC_FRAME - n) as u64;
        }
    }

    fn reset_canceller(&mut self, why: &str) {
        if let Some(c) = self.canceller.as_mut() {
            c.reset();
        }
        self.balance.resync();
        self.proxy_mic = 0.0;
        self.proxy_out = 0.0;
        self.proxy_frames = 0;
        self.render_since_sync = 0;
        self.capture_since_sync = 0;
        self.stats.resets += 1;
        let mut actions = Vec::new();
        self.health.reset_echo_path(&mut actions);
        self.log_actions(&actions);
        self.logs.push(format!("[CaptureAEC] canceller reset: {why}"));
    }

    /// `deadline_ms`: reference that arrived by then goes in first (None: all
    /// of it, for the tail at flush). `lateness_ms`: how far past its hold the
    /// frame is (None at flush: nothing is late, nothing is stale).
    fn process_frame(&mut self, frame: MicFrame, deadline_ms: Option<u64>, lateness_ms: Option<u64>, out: &mut Vec<f32>) {
        let started = Instant::now();
        let mic_now_ms = self.stats.frames * FRAME_MS;

        if self.generation.is_some_and(|g| g != frame.generation) {
            self.reset_canceller("new mic stream (device switch or recovery)");
        }
        self.generation = Some(frame.generation);

        if self.canceller.is_none() {
            // No canceller: the mic as it came.
            out.extend_from_slice(&frame.data);
            self.stats.samples_out += AEC_FRAME as u64;
            self.stats.frames += 1;
            return;
        }

        // A worker that fell a second behind passes frames raw, without the
        // canceller (their reference is dropped with them), until it has
        // caught up; then the canceller starts over.
        let queue_ms = lateness_ms.unwrap_or(0);
        let skip = queue_ms > HARD_QUEUE_MS;
        let deadline = deadline_ms.unwrap_or(u64::MAX);
        if skip {
            while self.ref_frames.front().is_some_and(|r| r.at_ms <= deadline) {
                self.ref_frames.pop_front();
            }
            self.needs_reset = true;
            self.stats.skipped_frames += 1;
        } else if self.needs_reset {
            self.needs_reset = false;
            self.reset_canceller("caught up after falling behind");
        }
        let Some(canceller) = self.canceller.as_mut() else {
            unreachable!("checked above")
        };

        // Every reference frame that arrived by this frame's deadline goes in
        // first (S1's render-then-capture order).
        let mut present = 0u32;
        let mut ref_power = 0.0f64;
        let mut cleaned = [0.0f32; AEC_FRAME];
        if !skip {
            while self.ref_frames.front().is_some_and(|r| r.at_ms <= deadline) {
                let r = self.ref_frames.pop_front().expect("checked");
                if lateness_ms.is_some() && r.at_ms + STALE_REF_MS < deadline {
                    self.stats.stale_ref_frames += 1;
                    continue;
                }
                canceller.render(&r.data);
                present += 1;
                self.render_since_sync += 1;
                ref_power = ref_power.max(power(&r.data));
            }
            self.last_metrics = canceller.capture(&frame.data, &mut cleaned);
            self.capture_since_sync += 1;
            self.balance.observe(present, self.render_since_sync - self.capture_since_sync);
        }
        if ref_power.sqrt() >= REF_ACTIVE_RMS as f64 {
            self.ref_active_until_ms = mic_now_ms + REF_ACTIVE_HOLD_MS;
        }
        let ref_active = mic_now_ms < self.ref_active_until_ms;
        if ref_active && !skip {
            // ~1 s smoothing.
            const A: f64 = 0.01;
            self.proxy_mic += A * (power(&frame.data) - self.proxy_mic);
            self.proxy_out += A * (power(&cleaned) - self.proxy_out);
            self.proxy_frames = self.proxy_frames.saturating_add(1);
        }
        let cost_us = started.elapsed().as_micros().min(u32::MAX as u128) as u32;

        let m = self.last_metrics;
        let obs = FrameObs {
            ref_present: present > 0,
            ref_active,
            erle_db: m.erle_db,
            erle_proxy_db: self.erle_proxy_db(),
            erl_db: m.erl_db,
            delay_ms: m.delay_ms,
            backlog_ms: self.balance.backlog_frames() * FRAME_MS as i64,
            cost_us,
            queue_ms,
        };
        let mut actions = std::mem::take(&mut self.actions);
        actions.clear();
        self.health.tick(mic_now_ms, &obs, self.hold_ms, &mut actions);
        let mut reset = false;
        for a in &actions {
            match *a {
                HealthAction::AdjustHold(step) => {
                    let next = (self.hold_ms as i64 + step).clamp(0, MAX_HOLD_MS as i64) as u64;
                    self.logs.push(format!(
                        "[CaptureAEC] misaligned (ERLE {:?} dB, ERL {:?} dB, delay {:?} ms): mic hold {} → {} ms",
                        m.erle_db, m.erl_db, m.delay_ms, self.hold_ms, next
                    ));
                    self.hold_ms = next;
                }
                HealthAction::ResetCanceller => reset = true,
                HealthAction::Bypass(_) | HealthAction::Resume(_) => {}
            }
        }
        self.log_actions(&actions);
        self.actions = actions;
        if reset {
            self.reset_canceller("reference resumed or backlog out of range");
        }

        let bypass = skip || self.health.bypassed();
        let chosen: &[f32; AEC_FRAME] = if bypass { &frame.data } else { &cleaned };
        out.extend_from_slice(chosen);

        // Bookkeeping.
        self.stats.samples_out += AEC_FRAME as u64;
        self.stats.frames += 1;
        if bypass {
            self.stats.bypassed_frames += 1;
        }
        if present == 0 {
            self.stats.starved_frames += 1;
            self.window.starved += 1;
        }
        self.window.frames += 1;
        self.window.costs.push(cost_us);
        self.window.max_queue_ms = self.window.max_queue_ms.max(queue_ms);
        if ref_active && !skip {
            self.window.active_frames += 1;
            self.window.active_mic_power += power(&frame.data);
            self.window.active_out_power += power(&cleaned);
        }
        if self.stats.frames * FRAME_MS >= self.next_log_ms {
            self.next_log_ms += HEALTH_LOG_MS;
            let line = self.health_line();
            self.logs.push(line);
            self.window = WindowStats::default();
        }
    }

    fn log_actions(&mut self, actions: &[HealthAction]) {
        for a in actions {
            match a {
                HealthAction::Bypass(r) => self.logs.push(format!(
                    "[CaptureAEC] bypass ON ({}): raw mic to transcription, canceller keeps running",
                    r.name()
                )),
                HealthAction::Resume(r) => self.logs.push(format!(
                    "[CaptureAEC] bypass rule cleared ({}); state now {}",
                    r.name(),
                    self.state_name()
                )),
                _ => {}
            }
        }
    }

    pub fn state_name(&self) -> String {
        match self.health.reason() {
            None if self.canceller.is_none() => "passthrough (no canceller)".into(),
            None => "active".into(),
            Some(r) => format!("bypass ({})", r.name()),
        }
    }

    /// The 30 s health line (§3.5 item 5).
    pub fn health_line(&self) -> String {
        let m = self.last_metrics;
        let w = &self.window;
        let erle_proxy = if w.active_frames > 0 && w.active_out_power > 0.0 {
            format!("{:.1}", 10.0 * (w.active_mic_power / w.active_out_power).log10())
        } else {
            "n/a".into()
        };
        let drift_ppm = if w.frames > 0 {
            (w.ref_in as f64 / w.frames as f64 - 1.0) * 1e6
        } else {
            0.0
        };
        format!(
            "[CaptureAEC] health t={}s state={} api_erle={} api_erl={} delay_ms={} erle_proxy_db={} (over {} far-end frames) \
ref_backlog_ms={} ref_drift_ppm={:.0} starved={}/{} stale_ref={} hold_ms={} cpu_us p50={} p99={} max_queue_ms={} bypassed_total={} skipped_total={}",
            self.stats.frames * FRAME_MS / 1000,
            self.state_name(),
            fmt_opt(m.erle_db),
            fmt_opt(m.erl_db),
            m.delay_ms.map_or("n/a".into(), |d| d.to_string()),
            erle_proxy,
            w.active_frames,
            self.balance.backlog_frames() * FRAME_MS as i64,
            drift_ppm,
            w.starved,
            w.frames,
            self.stats.stale_ref_frames,
            self.hold_ms,
            w.costs.quantile_us(0.5),
            w.costs.quantile_us(0.99),
            w.max_queue_ms,
            self.stats.bypassed_frames,
            self.stats.skipped_frames,
        )
    }

    /// The end-of-capture summary (§3.5 item 5).
    pub fn summary_line(&self) -> String {
        let s = &self.stats;
        let secs = s.frames as f64 * FRAME_MS as f64 / 1000.0;
        let bypassed_pct = if s.frames > 0 { 100.0 * s.bypassed_frames as f64 / s.frames as f64 } else { 0.0 };
        let drift_ppm = if s.frames > 0 { (s.ref_frames_in as f64 / s.frames as f64 - 1.0) * 1e6 } else { 0.0 };
        format!(
            "[CaptureAEC] summary: {:.1}s of mic, {} samples in / {} out ({}), bypassed {:.1}% of frames (final state {}), \
{} resets, reference {} frames ({:.0} ppm vs mic frames, pauses included), {} stale and {} overflowed reference frames, \
{} frames skipped for lateness, final hold {} ms, largest chunks mic {} / ref {} samples",
            secs,
            s.mic_samples_in,
            s.samples_out,
            if s.mic_samples_in == s.samples_out { "exact" } else { "MISMATCH" },
            bypassed_pct,
            self.state_name(),
            s.resets,
            s.ref_frames_in,
            drift_ppm,
            s.stale_ref_frames,
            s.overflow_ref_frames,
            s.skipped_frames,
            self.hold_ms,
            s.mic_chunk_max,
            s.ref_chunk_max,
        )
    }
}

fn fmt_opt(v: Option<f32>) -> String {
    v.map_or("n/a".into(), |x| format!("{x:.1}"))
}

fn power(x: &[f32]) -> f64 {
    x.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>() / x.len().max(1) as f64
}

// ── the worker thread ──────────────────────────────────────────────────────

/// Where the worker's output goes: local-stt and the `audio://mic` emitter in
/// the app, a recorder in tests.
pub trait CleanedSink: Send {
    fn push(&mut self, samples: &[f32]);
}

enum Msg {
    Mic { samples: Vec<f32>, at: Instant, generation: u64 },
    Ref { samples: Vec<f32>, at: Instant },
}

/// The capture callbacks' handle: stamps and queues. Cheap to clone; one
/// clone lives in the mic sample callback, one in the system one.
#[derive(Clone)]
pub struct AecFeed {
    tx: Sender<Msg>,
}

impl AecFeed {
    /// From the mic sample callback (the CoreAudio IO thread): one copy and a
    /// channel send, the same cost as the `audio://mic` hand-off it replaces.
    pub fn mic(&self, samples: &[f32], generation: u64) {
        let _ = self.tx.send(Msg::Mic { samples: samples.to_vec(), at: Instant::now(), generation });
    }

    /// From the system-audio sample callback (the sidecar pipe reader).
    pub fn reference(&self, samples: &[f32]) {
        let _ = self.tx.send(Msg::Ref { samples: samples.to_vec(), at: Instant::now() });
    }
}

/// Worker settings.
#[derive(Debug, Clone, Copy)]
pub struct WorkerConfig {
    /// The system tap's rate (the sidecar delivers 16 kHz).
    pub ref_rate: u32,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self { ref_rate: SAMPLE_RATE }
    }
}

/// The capture echo canceller's thread. [`finish`](Self::finish) flushes the
/// tail into the sink and joins (call it after the sample callbacks are
/// cleared, before the STT sink closes). Dropping it without `finish` stops
/// the thread without a flush and does not wait.
pub struct CaptureAecWorker {
    stop: Arc<AtomicBool>,
    finish: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl CaptureAecWorker {
    pub fn spawn<F>(
        sink: Box<dyn CleanedSink>,
        make_canceller: F,
        config: WorkerConfig,
        log: fn(&str),
    ) -> Result<(Self, AecFeed), String>
    where
        F: FnOnce() -> Result<Box<dyn EchoCanceller>, String> + Send + 'static,
    {
        let (tx, rx) = mpsc::channel::<Msg>();
        let stop = Arc::new(AtomicBool::new(false));
        let finish = Arc::new(AtomicBool::new(false));
        let epoch = Instant::now();
        let handle = {
            let stop = Arc::clone(&stop);
            let finish = Arc::clone(&finish);
            std::thread::Builder::new()
                .name("capture-aec".into())
                .spawn(move || {
                    let canceller = match make_canceller() {
                        Ok(c) => Some(c),
                        Err(e) => {
                            log(&format!("[CaptureAEC] canceller unavailable ({e}): passing the mic through"));
                            None
                        }
                    };
                    let mut core = CaptureAecCore::new(canceller, config.ref_rate);
                    log(&format!(
                        "[CaptureAEC] start: aec3 =0.4.0 tuning={} (HPF on, NS off, AGC2 off, transparent mode on), \
mic 16000 Hz (MicCapture's resampled stream, the WAV's samples), reference {} Hz (system tap) → 16000 Hz, 10 ms frames, \
latency estimate: unmeasured (the sidecar passes no IOProc timestamps), mic hold {} ms",
                        AecTuning::Capture.name(),
                        config.ref_rate,
                        core.hold_ms(),
                    ));
                    run_worker(&mut core, rx, sink, epoch, &stop, &finish, log);
                })
                .map_err(|e| format!("capture-aec thread: {e}"))?
        };
        Ok((Self { stop, finish, handle: Some(handle) }, AecFeed { tx }))
    }

    /// Flush and join. The feeds should be gone (the sample callbacks
    /// cleared): anything already queued is still processed, then the tail.
    pub fn finish(mut self) {
        self.finish.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for CaptureAecWorker {
    fn drop(&mut self) {
        if self.handle.is_some() {
            // Torn down without finish(): stop, don't wait.
            self.stop.store(true, Ordering::SeqCst);
        }
    }
}

fn ms_since(epoch: Instant, at: Instant) -> u64 {
    at.saturating_duration_since(epoch).as_millis() as u64
}

fn run_worker(
    core: &mut CaptureAecCore,
    rx: mpsc::Receiver<Msg>,
    mut sink: Box<dyn CleanedSink>,
    epoch: Instant,
    stop: &AtomicBool,
    finish: &AtomicBool,
    log: fn(&str),
) {
    let mut out: Vec<f32> = Vec::with_capacity(4 * AEC_FRAME);
    let accept = |core: &mut CaptureAecCore, msg: Msg| match msg {
        Msg::Mic { samples, at, generation } => core.push_mic(&samples, ms_since(epoch, at), generation),
        Msg::Ref { samples, at } => core.push_ref(&samples, ms_since(epoch, at)),
    };
    let mut disconnected = false;
    loop {
        if stop.load(Ordering::SeqCst) {
            log("[CaptureAEC] stopped without a flush (session torn down)");
            return;
        }
        let now_ms = ms_since(epoch, Instant::now());
        let wait_ms = core.next_due_ms().map_or(10, |due| due.saturating_sub(now_ms).clamp(1, 10));
        if !disconnected {
            match rx.recv_timeout(Duration::from_millis(wait_ms)) {
                Ok(msg) => {
                    accept(core, msg);
                    while let Ok(msg) = rx.try_recv() {
                        accept(core, msg);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => disconnected = true,
            }
        }
        let finishing = disconnected || finish.load(Ordering::SeqCst);
        if finishing {
            while let Ok(msg) = rx.try_recv() {
                accept(core, msg);
            }
            core.flush(&mut out);
        } else {
            core.process(ms_since(epoch, Instant::now()), &mut out);
        }
        if !out.is_empty() {
            sink.push(&out);
            out.clear();
        }
        for line in core.logs.drain(..) {
            log(&line);
        }
        if finishing {
            log(&core.health_line());
            log(&core.summary_line());
            return;
        }
    }
}

#[cfg(test)]
mod tests;
