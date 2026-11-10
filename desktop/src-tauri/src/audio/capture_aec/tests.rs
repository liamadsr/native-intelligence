//! Capture echo cancellation: the pure health machine, the reference count
//! lock, the core's timeline and hold, echo scenes through the real aec3
//! capture tuning, and the worker thread. Synthetic signals only.

use super::*;
use crate::audio::aec::{AecMetrics, EchoCanceller, PassthroughCanceller, AEC_FRAME};
use crate::audio::aec3_canceller::tests::{synthetic_speech, Rng};
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Mutex;

// ── health machine ─────────────────────────────────────────────────────────

/// A healthy, far-end-active frame: reference in, echo present and cancelled.
fn healthy() -> FrameObs {
    FrameObs {
        ref_present: true,
        ref_active: true,
        erle_db: Some(8.5),
        erle_proxy_db: None,
        erl_db: Some(12.0),
        delay_ms: Some(180),
        backlog_ms: 0,
        cost_us: 300,
        queue_ms: 0,
    }
}

struct Driver {
    h: Health,
    now_ms: u64,
    hold_ms: u64,
    log: Vec<(u64, HealthAction)>,
}

impl Driver {
    fn new() -> Self {
        Self { h: Health::new(), now_ms: 0, hold_ms: DEFAULT_HOLD_MS, log: Vec::new() }
    }

    /// Feed `ms` of mic time of `obs`; returns the actions it produced.
    fn run(&mut self, ms: u64, obs: FrameObs) -> Vec<HealthAction> {
        let mut all = Vec::new();
        for _ in 0..ms / FRAME_MS {
            let mut a = Vec::new();
            self.h.tick(self.now_ms, &obs, self.hold_ms, &mut a);
            for act in &a {
                if let HealthAction::AdjustHold(step) = act {
                    self.hold_ms = (self.hold_ms as i64 + step) as u64;
                }
                self.log.push((self.now_ms, *act));
            }
            all.extend(a);
            self.now_ms += FRAME_MS;
        }
        all
    }
}

#[test]
fn a_healthy_capture_never_bypasses() {
    let mut d = Driver::new();
    assert!(d.run(10 * 60_000, healthy()).is_empty());
    assert!(!d.h.bypassed());
}

#[test]
fn no_echo_path_trips_after_30_s_of_quiet_reference_and_clears_after_5_s() {
    let headphones = FrameObs { erle_db: Some(0.2), erl_db: Some(-29.0), ..healthy() };
    let mut d = Driver::new();
    assert!(d.run(NO_ECHO_TRIP_MS - FRAME_MS, headphones).is_empty(), "not before 30 s");
    assert_eq!(d.run(FRAME_MS, headphones), vec![HealthAction::Bypass(BypassReason::NoEchoPath)]);
    assert_eq!(d.h.reason(), Some(BypassReason::NoEchoPath));
    assert!(d.run(60_000, headphones).is_empty(), "stays bypassed");

    // Far-end silence says nothing either way.
    let silent = FrameObs { ref_active: false, erle_db: None, erl_db: None, ..headphones };
    assert!(d.run(60_000, silent).is_empty());

    // Back to speakers: echo there and cancelled for 5 s.
    let back = FrameObs { erle_db: Some(4.0), erl_db: Some(6.0), ..healthy() };
    assert!(d.run(NO_ECHO_CLEAR_MS - FRAME_MS, back).is_empty());
    assert_eq!(d.run(FRAME_MS, back), vec![HealthAction::Resume(BypassReason::NoEchoPath)]);
    assert!(!d.h.bypassed());
}

#[test]
fn no_echo_path_needs_an_unbroken_30_s() {
    let headphones = FrameObs { erle_db: Some(0.2), erl_db: Some(-29.0), ..healthy() };
    let mut d = Driver::new();
    for _ in 0..10 {
        assert!(d.run(25_000, headphones).is_empty());
        // One healthy-looking stretch (echo back) restarts the count.
        assert!(d.run(FRAME_MS, healthy()).is_empty());
    }
    assert!(!d.h.bypassed());
}

#[test]
fn double_talk_and_brief_dips_never_bypass() {
    // Double talk: the canceller's ERLE sags and ERL reads low while the user
    // talks over the far end; delay estimates wander. Seconds at a time, over
    // and over, for ten minutes.
    let dip = FrameObs { erle_db: Some(0.5), erl_db: Some(-2.0), delay_ms: Some(4), ..healthy() };
    let mut d = Driver::new();
    for _ in 0..60 {
        assert!(d.run(4_000, dip).is_empty());
        assert!(d.run(6_000, healthy()).is_empty());
    }
    assert!(!d.h.bypassed());
}

#[test]
fn misaligned_moves_the_hold_twice_then_bypasses_at_60_s() {
    // The echo is there (ERL +12) but nothing is removed: the reference comes
    // too late for the canceller.
    let late = FrameObs { erle_db: Some(0.8), erl_db: Some(12.0), delay_ms: Some(0), ..healthy() };
    let mut d = Driver::new();
    // Judged only after 10 s of reference.
    assert!(d.run(MISALIGNED_AFTER_REF_MS, late).is_empty());
    assert!(d.run(MISALIGNED_RUN_MS - FRAME_MS, late).is_empty());
    assert_eq!(d.run(FRAME_MS, late), vec![HealthAction::AdjustHold(HOLD_STEP_MS as i64)]);
    assert_eq!(d.hold_ms, DEFAULT_HOLD_MS + HOLD_STEP_MS);
    assert_eq!(d.run(MISALIGNED_RUN_MS, late), vec![HealthAction::AdjustHold(HOLD_STEP_MS as i64)]);
    assert!(!d.h.bypassed(), "the hold is adjusted first");
    // (A minute of it is also sustained low health; misaligned is the reason.)
    assert!(d.run(MISALIGNED_RUN_MS, late).contains(&HealthAction::Bypass(BypassReason::Misaligned)));
    assert_eq!(d.h.reason(), Some(BypassReason::Misaligned));
    let bypass_at = d.log.iter().find(|(_, a)| *a == HealthAction::Bypass(BypassReason::Misaligned)).unwrap().0;
    assert_eq!(bypass_at + FRAME_MS, MISALIGNED_AFTER_REF_MS + 3 * MISALIGNED_RUN_MS, "60 s after judging began");

    // Aligned again for 5 s: that rule clears.
    assert!(d.run(MISALIGNED_CLEAR_MS - FRAME_MS, healthy()).is_empty());
    assert_eq!(d.run(FRAME_MS, healthy()), vec![HealthAction::Resume(BypassReason::Misaligned)]);
}

#[test]
fn a_collapsed_api_erle_does_not_count_while_the_proxy_shows_cancelling() {
    // aec3's API ERLE reads ~0 dB when a short reference keeps resetting its
    // estimator, while the echo is in fact 20 dB down: nothing trips.
    let collapsed = FrameObs { erle_db: Some(0.2), erle_proxy_db: Some(21.0), erl_db: Some(15.0), ..healthy() };
    let mut d = Driver::new();
    assert!(d.run(10 * 60_000, collapsed).is_empty());
    // With both low, it is misaligned.
    let both_low = FrameObs { erle_proxy_db: Some(0.5), ..collapsed };
    d.run(MISALIGNED_RUN_MS, both_low);
    assert_eq!(d.log.iter().map(|(_, a)| *a).collect::<Vec<_>>(), vec![HealthAction::AdjustHold(HOLD_STEP_MS as i64)]);
}

#[test]
fn a_delay_at_the_top_of_the_search_holds_the_mic_less() {
    let early = FrameObs { erle_db: Some(1.0), erl_db: Some(12.0), delay_ms: Some(700), ..healthy() };
    let mut d = Driver::new();
    d.run(MISALIGNED_AFTER_REF_MS + MISALIGNED_RUN_MS, early);
    assert_eq!(d.log.iter().map(|(_, a)| *a).collect::<Vec<_>>(), vec![HealthAction::AdjustHold(-(HOLD_STEP_MS as i64))]);
    assert_eq!(d.hold_ms, 0);
    // At 0 there is nowhere lower to go: the next run only counts.
    d.run(MISALIGNED_RUN_MS, early);
    assert_eq!(d.hold_ms, 0);
    assert_eq!(d.log.len(), 1);
    d.run(MISALIGNED_RUN_MS, early);
    assert!(d.h.is_tripped(BypassReason::Misaligned));
}

#[test]
fn a_working_canceller_at_a_long_delay_is_left_alone() {
    // A Bluetooth speaker: 520 ms of delay, but the echo is going away.
    let long = FrameObs { delay_ms: Some(520), ..healthy() };
    let mut d = Driver::new();
    assert!(d.run(5 * 60_000, long).is_empty());
}

#[test]
fn misalignment_is_not_judged_in_the_first_10_s_of_reference() {
    let late = FrameObs { erle_db: Some(0.8), erl_db: Some(12.0), ..healthy() };
    let mut d = Driver::new();
    // 60 s of mic time, but the far end only talked for 9.99 s of it.
    for _ in 0..999 {
        d.run(FRAME_MS, late);
        d.run(5 * FRAME_MS, FrameObs { ref_active: false, ..late });
    }
    assert!(d.log.is_empty());
}

#[test]
fn reference_stall_bypasses_after_500_ms_and_resets_on_resume() {
    let none = FrameObs { ref_present: false, ref_active: false, ..healthy() };
    let mut d = Driver::new();
    d.run(10_000, healthy());
    assert!(d.run(REF_STALL_MS - FRAME_MS, none).is_empty());
    assert_eq!(d.run(FRAME_MS, none), vec![HealthAction::Bypass(BypassReason::RefStalled)]);
    assert!(d.run(30_000, none).is_empty());
    assert_eq!(
        d.run(FRAME_MS, healthy()),
        vec![HealthAction::ResetCanceller, HealthAction::Resume(BypassReason::RefStalled)]
    );
    assert!(!d.h.bypassed());
}

#[test]
fn bursty_reference_arrival_is_not_a_stall() {
    // The pipe can deliver the reference 64 ms at a time: 5 of 6 frames empty.
    let mut d = Driver::new();
    for _ in 0..10_000 {
        d.run(FRAME_MS, healthy());
        d.run(5 * FRAME_MS, FrameObs { ref_present: false, ..healthy() });
    }
    assert!(d.log.is_empty());
}

#[test]
fn a_backlog_beyond_2_s_resets_once_and_resumes() {
    let mut d = Driver::new();
    d.run(10_000, healthy());
    assert!(d.run(FRAME_MS, FrameObs { backlog_ms: -MAX_BACKLOG_MS, ..healthy() }).is_empty(), "±2 s itself is fine");
    assert_eq!(
        d.run(FRAME_MS, FrameObs { backlog_ms: -MAX_BACKLOG_MS - FRAME_MS as i64, ..healthy() }),
        vec![HealthAction::ResetCanceller, HealthAction::Bypass(BypassReason::RefStalled)]
    );
    // The reset re-settled the balance: on again, without a second reset.
    assert_eq!(d.run(FRAME_MS, healthy()), vec![HealthAction::Resume(BypassReason::RefStalled)]);
}

#[test]
fn sustained_low_health_needs_5_minutes_of_evidence_after_the_first_minute() {
    let poor = FrameObs { erle_db: Some(2.5), erl_db: Some(10.0), delay_ms: Some(200), ..healthy() };
    let mut d = Driver::new();
    // Not in the first minute, whatever happens.
    assert!(d.run(LOW_HEALTH_AFTER_MS, poor).is_empty());
    // After it: < 50% healthy over the window trips.
    assert_eq!(d.run(FRAME_MS, poor), vec![HealthAction::Bypass(BypassReason::LowHealth)]);
    // Recovery needs the 5-minute share back at 60%: 40% healthy isn't it...
    for _ in 0..30 {
        d.run(4_000, healthy());
        d.run(6_000, poor);
    }
    assert!(d.h.is_tripped(BypassReason::LowHealth));
    // ...a clean five minutes is.
    let resumed = d.run(5 * 60_000, healthy());
    assert_eq!(resumed, vec![HealthAction::Resume(BypassReason::LowHealth)]);
}

#[test]
fn low_health_ignores_frames_with_nothing_to_cancel() {
    // Headphones (ERL < 0) and far-end silence are neither healthy nor not.
    let headphones = FrameObs { erle_db: Some(0.1), erl_db: Some(-25.0), ..healthy() };
    let mut d = Driver::new();
    d.run(10 * 60_000, FrameObs { ref_active: false, ..healthy() });
    d.run(20_000, headphones);
    assert!(!d.h.is_tripped(BypassReason::LowHealth));
}

#[test]
fn too_slow_on_a_long_queue_or_a_slow_p99() {
    let mut d = Driver::new();
    assert!(d.run(FRAME_MS, FrameObs { queue_ms: SLOW_QUEUE_MS, ..healthy() }).is_empty(), "500 ms is fine");
    assert_eq!(
        d.run(FRAME_MS, FrameObs { queue_ms: SLOW_QUEUE_MS + 1, ..healthy() }),
        vec![HealthAction::Bypass(BypassReason::TooSlow)]
    );
    // Caught up, but no whole cost window has been judged yet: stays off.
    assert!(d.run(10_000, healthy()).is_empty());
    let cleared = d.run(SLOW_WINDOW_FRAMES as u64 * FRAME_MS, healthy());
    assert_eq!(cleared, vec![HealthAction::Resume(BypassReason::TooSlow)]);

    // A window whose p99 is over 5 ms: 2% of frames at 40 ms (E-core spikes).
    let mut d = Driver::new();
    let spike = FrameObs { cost_us: 40_000, ..healthy() };
    let mut actions = Vec::new();
    for i in 0..SLOW_WINDOW_FRAMES {
        actions.extend(d.run(FRAME_MS, if i % 50 == 0 { spike } else { healthy() }));
    }
    assert_eq!(actions, vec![HealthAction::Bypass(BypassReason::TooSlow)]);
    // ...while 0.5% of frames spiking is within p99.
    let mut d = Driver::new();
    for i in 0..SLOW_WINDOW_FRAMES {
        d.run(FRAME_MS, if i % 200 == 0 { spike } else { healthy() });
    }
    assert!(d.log.is_empty());
}

#[test]
fn the_reported_reason_follows_priority() {
    let mut d = Driver::new();
    let headphones = FrameObs { erle_db: Some(0.2), erl_db: Some(-29.0), ..healthy() };
    d.run(NO_ECHO_TRIP_MS, headphones);
    d.run(REF_STALL_MS, FrameObs { ref_present: false, ..headphones });
    assert_eq!(d.h.reason(), Some(BypassReason::RefStalled));
    d.run(FRAME_MS, headphones);
    assert_eq!(d.h.reason(), Some(BypassReason::NoEchoPath));
}

#[test]
fn a_canceller_reset_starts_the_echo_path_rules_over() {
    let headphones = FrameObs { erle_db: Some(0.2), erl_db: Some(-29.0), ..healthy() };
    let mut d = Driver::new();
    d.run(NO_ECHO_TRIP_MS, headphones);
    assert!(d.h.bypassed());
    let mut a = Vec::new();
    d.h.reset_echo_path(&mut a);
    assert_eq!(a, vec![HealthAction::Resume(BypassReason::NoEchoPath)]);
    assert!(!d.h.bypassed());
}

#[test]
fn cost_histogram_quantiles() {
    let mut h = CostHistogram::default();
    for i in 0..100u32 {
        h.push(i * 100 + 50); // 50, 150, ... 9950 µs
    }
    assert_eq!(h.quantile_us(0.5), 5_000);
    assert_eq!(h.quantile_us(0.99), 9_900);
    h.push(1_000_000);
    assert_eq!(h.quantile_us(1.0), 50_100, "the top bucket holds everything beyond 50 ms");
}

// ── render/capture balance ─────────────────────────────────────────────────

#[test]
fn the_balance_settles_on_the_window_max_and_reports_drift() {
    let mut b = Balance::default();
    assert_eq!(b.backlog_frames(), 0);
    // First window: jitter between 3 and 5, max 5.
    for i in 0..100 {
        b.observe(1, 3 + (i % 3));
    }
    assert!(b.settled());
    assert_eq!(b.backlog_frames(), 0);
    // The reference falls three frames behind.
    for i in 0..100 {
        b.observe(1, (i % 3) as i64);
    }
    assert_eq!(b.backlog_frames(), -3);
    b.resync();
    assert!(!b.settled());
    assert_eq!(b.backlog_frames(), 0);
}

#[test]
fn the_balance_ignores_windows_without_the_reference() {
    let mut b = Balance::default();
    for _ in 0..100 {
        b.observe(1, 5);
    }
    // No reference for a second: the balance sinks, but that is a stall (the
    // health machine's business), not drift.
    for i in 0..100 {
        b.observe(0, 5 - i);
    }
    assert_eq!(b.backlog_frames(), 0);
}

// ── the core ───────────────────────────────────────────────────────────────

/// A canceller that records the call order and marks its output.
#[derive(Default)]
struct Recorder {
    calls: Vec<String>,
    resets: usize,
}

struct RecordingCanceller(Rc<RefCell<Recorder>>);

impl EchoCanceller for RecordingCanceller {
    fn render(&mut self, frame: &[f32; AEC_FRAME]) {
        self.0.borrow_mut().calls.push(format!("r{}", frame[0]));
    }
    fn capture(&mut self, frame: &[f32; AEC_FRAME], out: &mut [f32; AEC_FRAME]) -> AecMetrics {
        self.0.borrow_mut().calls.push(format!("c{}", frame[0]));
        out.copy_from_slice(frame);
        AecMetrics { erle_db: Some(8.0), erl_db: Some(12.0), delay_ms: Some(150), converged: true }
    }
    fn reset(&mut self) {
        self.0.borrow_mut().resets += 1;
    }
}

fn recording_core() -> (CaptureAecCore, Rc<RefCell<Recorder>>) {
    let rec = Rc::new(RefCell::new(Recorder::default()));
    (CaptureAecCore::new(Some(Box::new(RecordingCanceller(rec.clone()))), SAMPLE_RATE), rec)
}

fn frame_of(v: f32) -> Vec<f32> {
    vec![v; AEC_FRAME]
}

#[test]
fn a_mic_frame_waits_out_the_hold_and_its_reference_goes_in_first() {
    let (mut core, rec) = recording_core();
    let mut out = Vec::new();
    core.push_mic(&frame_of(1.0), 0, 1);
    core.process(DEFAULT_HOLD_MS - 1, &mut out);
    assert!(out.is_empty(), "held");
    // A reference frame that arrives 90 ms after the mic frame (a late tap)
    // still goes in before it.
    core.push_ref(&frame_of(7.0), 90);
    // One arriving after the deadline waits for the next mic frame.
    core.push_ref(&frame_of(8.0), DEFAULT_HOLD_MS + 1);
    core.process(DEFAULT_HOLD_MS, &mut out);
    assert_eq!(out, frame_of(1.0));
    assert_eq!(rec.borrow().calls, vec!["r7", "c1"]);
    core.push_mic(&frame_of(2.0), 10, 1);
    core.process(DEFAULT_HOLD_MS + 10, &mut out);
    assert_eq!(rec.borrow().calls, vec!["r7", "c1", "r8", "c2"]);
}

#[test]
fn every_mic_sample_comes_out_once_in_order_over_irregular_chunks() {
    // PassthroughCanceller copies, so out == in proves the timeline: output
    // sample k is mic sample k. Irregular chunks on both sides, a device
    // switch, a pause, a reference stall, and the flush of a partial frame.
    let mut core = CaptureAecCore::new(Some(Box::new(PassthroughCanceller)), SAMPLE_RATE);
    let mut rng = Rng::new(9);
    let mic: Vec<f32> = (0..16_000 * 20 + 77).map(|i| i as f32).collect();
    let mut out = Vec::new();
    let (mut at, mut t_ms, mut generation) = (0usize, 0u64, 1u64);
    let sizes = [160usize, 171, 512, 1, 333, 480, 1024];
    let mut k = 0;
    while at < mic.len() {
        let n = sizes[k % sizes.len()].min(mic.len() - at);
        k += 1;
        if k == 400 {
            generation = 2; // recover_mic reopened the stream
        }
        if k == 700 {
            t_ms += 3_000; // a pause
        }
        t_ms += (n as u64 * 1000 / 16_000).max(1);
        core.push_mic(&mic[at..at + n], t_ms, generation);
        if !(900..1_000).contains(&k) {
            let r: Vec<f32> = (0..170).map(|_| rng.gauss() * 0.1).collect();
            core.push_ref(&r, t_ms + 3);
        }
        core.process(t_ms, &mut out);
        at += n;
    }
    core.flush(&mut out);
    assert_eq!(out.len(), mic.len(), "same count in and out");
    assert!(out == mic, "same samples, same order");
    let s = core.stats();
    assert_eq!((s.mic_samples_in, s.samples_out), (mic.len() as u64, mic.len() as u64));
    assert!(core.summary_line().contains("exact"), "{}", core.summary_line());
}

#[test]
fn bypass_outputs_the_raw_mic_and_keeps_the_canceller_running() {
    let (mut core, rec) = recording_core();
    let mut out = Vec::new();
    // No reference at all: after 500 ms the stall rule bypasses.
    for i in 0..100u64 {
        core.push_mic(&frame_of(i as f32), i * 10, 1);
        core.process(i * 10, &mut out);
    }
    core.process(1_100, &mut out);
    assert!(core.health().is_tripped(BypassReason::RefStalled));
    assert_eq!(out.len(), 100 * AEC_FRAME);
    let captures = rec.borrow().calls.iter().filter(|c| c.starts_with('c')).count();
    assert_eq!(captures, 100, "the canceller ran on every frame, bypassed or not");
    assert!(core.logs.iter().any(|l| l.contains("bypass ON (reference stalled)")), "{:?}", core.logs);
    // The reference comes back: reset, and on.
    core.push_ref(&frame_of(0.5), 1_000);
    core.push_mic(&frame_of(0.25), 1_000, 1);
    core.process(1_100, &mut out);
    assert!(!core.health().bypassed());
    assert_eq!(rec.borrow().resets, 1);
}

#[test]
fn a_new_mic_stream_resets_the_canceller() {
    let (mut core, rec) = recording_core();
    let mut out = Vec::new();
    core.push_mic(&frame_of(1.0), 0, 4);
    core.push_mic(&frame_of(2.0), 10, 4);
    core.push_mic(&frame_of(3.0), 20, 5);
    core.process(1_000, &mut out);
    assert_eq!(rec.borrow().resets, 1);
    assert_eq!(out.len(), 3 * AEC_FRAME);
    assert!(core.logs.iter().any(|l| l.contains("new mic stream")));
}

#[test]
fn reference_that_piled_up_during_a_pause_is_dropped_not_burst_in() {
    let (mut core, rec) = recording_core();
    let mut out = Vec::new();
    core.push_mic(&frame_of(1.0), 0, 1);
    core.process(200, &mut out);
    // Paused 5 s: the tap keeps delivering (only the last 3 s are kept).
    for i in 0..500u64 {
        core.push_ref(&frame_of(2.0), 100 + i * 10);
    }
    assert_eq!(core.stats().overflow_ref_frames, 200);
    core.push_mic(&frame_of(3.0), 5_100, 1);
    core.process(5_300, &mut out);
    let renders = rec.borrow().calls.iter().filter(|c| c.starts_with('r')).count();
    assert!(renders <= 1 + (STALE_REF_MS / FRAME_MS) as usize + 1, "{renders} render frames went in after the pause");
    assert!(core.stats().stale_ref_frames > 0);
}

#[test]
fn a_worker_that_fell_far_behind_catches_up_raw_then_resets() {
    let (mut core, rec) = recording_core();
    let mut out = Vec::new();
    for i in 0..200u64 {
        core.push_mic(&frame_of(i as f32), i * 10, 1);
        core.push_ref(&frame_of(0.1), i * 10);
    }
    // Processed only at 3 s: the first frames are > 1 s late.
    core.process(3_000, &mut out);
    assert_eq!(out.len(), 200 * AEC_FRAME, "nothing lost");
    let s = core.stats();
    assert!(s.skipped_frames > 0 && s.skipped_frames < 200, "{s:?}");
    assert_eq!(rec.borrow().resets, 1, "reset once caught up");
    let captures = rec.borrow().calls.iter().filter(|c| c.starts_with('c')).count() as u64;
    assert_eq!(captures, 200 - s.skipped_frames);
}

#[test]
fn flush_runs_the_partial_tail_and_every_waiting_reference() {
    let (mut core, rec) = recording_core();
    let mut out = Vec::new();
    core.push_mic(&[0.5; AEC_FRAME + 37], 0, 1);
    core.push_ref(&frame_of(0.2), 5);
    core.push_ref(&frame_of(0.3), 500);
    core.flush(&mut out);
    assert_eq!(out.len(), AEC_FRAME + 37);
    assert!(out.iter().all(|&v| v == 0.5));
    assert_eq!(rec.borrow().calls, vec!["r0.2", "c0.5", "r0.3", "c0.5"]);
}

#[test]
fn without_a_canceller_the_mic_passes_straight_through_unheld() {
    let mut core = CaptureAecCore::new(None, SAMPLE_RATE);
    assert_eq!(core.hold_ms(), 0);
    let mut out = Vec::new();
    core.push_mic(&[0.1, 0.2, 0.3], 0, 1);
    core.push_mic(&[0.4; AEC_FRAME], 0, 1);
    core.push_ref(&[0.9; 400], 0);
    core.process(0, &mut out);
    assert_eq!(out.len(), AEC_FRAME);
    core.flush(&mut out);
    assert_eq!(out.len(), AEC_FRAME + 3);
    assert_eq!(&out[..3], &[0.1, 0.2, 0.3]);
}

#[test]
fn the_health_line_carries_the_spec_fields() {
    let (mut core, _rec) = recording_core();
    let mut out = Vec::new();
    for i in 0..3_000u64 {
        core.push_mic(&frame_of(0.01), i * 10, 1);
        core.push_ref(&frame_of(0.02), i * 10);
        core.process(i * 10, &mut out);
    }
    core.process(30_100, &mut out);
    let line = core.logs.iter().find(|l| l.contains("health t=30s")).expect("a 30 s health line");
    for field in ["state=active", "api_erle=8.0", "api_erl=12.0", "delay_ms=150", "erle_proxy_db=", "ref_backlog_ms=", "ref_drift_ppm=", "starved=", "hold_ms=100", "cpu_us p50="] {
        assert!(line.contains(field), "{field} missing from {line}");
    }
    assert!(core.summary_line().contains("summary"));
}

// ── echo scenes through the real aec3 capture tuning ───────────────────────

const FS: usize = 16_000;

fn db(p: f64) -> f64 {
    10.0 * p.max(1e-20).log10()
}

/// A short laptop echo path at 16 kHz: direct sound after `delay_ms`, a few
/// early reflections and a 30 ms tail, sparse enough to convolve fast in an
/// unoptimized test build.
fn short_echo_path(delay_ms: f32, gain: f32, seed: u64) -> Vec<(usize, f32)> {
    let mut rng = Rng::new(seed);
    let d = (delay_ms * FS as f32 / 1000.0) as usize;
    let mut taps = vec![(d, gain)];
    for k in 0..10 {
        taps.push((d + 8 + (rng.next_f32() * 200.0) as usize + k, gain * 0.25 * (rng.next_f32() - 0.5)));
    }
    for i in (0..480).step_by(3) {
        let t = i as f32 / FS as f32;
        taps.push((d + 40 + i, gain * 0.03 * rng.gauss() * (-6.9 * t / 0.03).exp()));
    }
    taps
}

fn convolve_sparse(x: &[f32], taps: &[(usize, f32)]) -> Vec<f32> {
    let mut y = vec![0.0f32; x.len()];
    for &(k, h) in taps {
        for n in k..x.len() {
            y[n] += h * x[n - k];
        }
    }
    y
}

/// `on` for [start, end) seconds, with 10 ms ramps.
fn gate(len: usize, spans: &[(f32, f32)]) -> Vec<f32> {
    let mut g = vec![0.0f32; len];
    let ramp = FS / 100;
    for &(a, b) in spans {
        let (a, b) = ((a * FS as f32) as usize, ((b * FS as f32) as usize).min(len));
        for (i, v) in g.iter_mut().enumerate().take(b).skip(a) {
            let up = ((i - a) as f32 / ramp as f32).min(1.0);
            let down = ((b - i) as f32 / ramp as f32).min(1.0);
            *v = up.min(down);
        }
    }
    g
}

struct Scene {
    reference: Vec<f32>,
    mic: Vec<f32>,
    /// Stretches where only the far end talks (bleed), and only the user.
    far_only: Vec<(f32, f32)>,
    user_only: Vec<(f32, f32)>,
}

/// 10 s of far end alone to converge, then 3 s user alone / 3 s far alone,
/// three times. The echo reaches the mic `offset_ms` (plus 30 ms of room)
/// after the reference carries it.
fn meeting_scene(offset_ms: f32) -> Scene {
    let secs = 28.0f32;
    let n = (secs * FS as f32) as usize;
    let far_spans = [(0.0, 10.0), (13.0, 16.0), (19.0, 22.0), (25.0, 28.0)];
    let user_spans = [(10.0, 13.0), (16.0, 19.0), (22.0, 25.0)];
    let far_gate = gate(n, &far_spans);
    let user_gate = gate(n, &user_spans);
    let far: Vec<f32> = synthetic_speech(secs, 21).iter().zip(&far_gate).map(|(s, g)| s * g).collect();
    let user: Vec<f32> = synthetic_speech(secs, 5).iter().zip(&user_gate).map(|(s, g)| s * g).collect();
    // The echo as loud as the user (0 dB, S1b's middle level).
    let echo = convolve_sparse(&far, &short_echo_path(30.0 + offset_ms, 0.9, 13));
    let mut rng = Rng::new(17);
    let mic = user.iter().zip(&echo).map(|(u, e)| u + e + 0.0005 * rng.gauss()).collect();
    // Measure away from the edges: skip the echo tail after the far end stops.
    let far_only = vec![(13.5, 16.0), (19.5, 22.0), (25.5, 28.0)];
    let user_only = vec![(10.8, 13.0), (16.8, 19.0), (22.8, 25.0)];
    Scene { reference: far, mic, far_only, user_only }
}

/// Deliver the scene the way the app does: the mic in 10 ms chunks stamped
/// on arrival, the tap in 170-sample IOProc-sized chunks every 10.67 ms, both
/// a few ms after real time, the reference optionally thinned the way the
/// sidecar's converter thins it (one 512-frame buffer in 256 never consumed).
fn run_scene(core: &mut CaptureAecCore, s: &Scene, sidecar_deficit: bool) -> Vec<f32> {
    let mut reference = s.reference.clone();
    if sidecar_deficit {
        // Content lost: every 256th IOProc buffer (512 frames at 48 kHz =
        // 170.67 samples at 16 kHz).
        let mut kept = Vec::with_capacity(reference.len());
        let mut pos = 0.0f64;
        let mut call = 0u64;
        while (pos as usize) < reference.len() {
            let a = pos as usize;
            let b = ((pos + 512.0 / 3.0) as usize).min(reference.len());
            if call % 256 != 255 {
                kept.extend_from_slice(&reference[a..b]);
            }
            pos += 512.0 / 3.0;
            call += 1;
        }
        reference = kept;
    }
    // Events: (time_ms, is_mic, start, end).
    let mut events: Vec<(f64, bool, usize, usize)> = Vec::new();
    for (i, a) in (0..s.mic.len()).step_by(AEC_FRAME).enumerate() {
        let b = (a + AEC_FRAME).min(s.mic.len());
        events.push(((i + 1) as f64 * 10.0 + 2.0, true, a, b));
    }
    // The tap: one write per 512-frame IOProc (10.67 ms). A healthy tap
    // writes 170.67 samples a call on average (171, 170, 171, ...); the
    // sidecar's converter writes exactly 170 of the thinned content.
    let mut a = 0;
    let mut call = 0u64;
    while a < reference.len() {
        let size = if sidecar_deficit { 170 } else { ((call + 1) * 512 / 3 - call * 512 / 3) as usize };
        let b = (a + size).min(reference.len());
        call += 1;
        events.push((call as f64 * 512.0 / 48.0 + 4.0, false, a, b));
        a = b;
    }
    events.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap());
    let mut out = Vec::with_capacity(s.mic.len());
    for (t, is_mic, a, b) in events {
        let t_ms = t as u64;
        if is_mic {
            core.push_mic(&s.mic[a..b], t_ms, 1);
        } else {
            core.push_ref(&reference[a..b], t_ms);
        }
        core.process(t_ms, &mut out);
    }
    core.flush(&mut out);
    out
}

fn span_power(x: &[f32], spans: &[(f32, f32)]) -> f64 {
    let mut sum = 0.0;
    let mut n = 0usize;
    for &(a, b) in spans {
        let (a, b) = ((a * FS as f32) as usize, ((b * FS as f32) as usize).min(x.len()));
        sum += x[a..b].iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>();
        n += b - a;
    }
    sum / n.max(1) as f64
}

struct SceneResult {
    bleed_drop_db: f64,
    user_change_db: f64,
}

fn score(s: &Scene, out: &[f32]) -> SceneResult {
    SceneResult {
        bleed_drop_db: db(span_power(&s.mic, &s.far_only)) - db(span_power(out, &s.far_only)),
        user_change_db: db(span_power(out, &s.user_only)) - db(span_power(&s.mic, &s.user_only)),
    }
}

fn capture_core() -> CaptureAecCore {
    let c = crate::audio::aec::new_echo_canceller_tuned(AecTuning::Capture).expect("aec3 builds");
    CaptureAecCore::new(Some(c), SAMPLE_RATE)
}

#[test]
fn removes_bleed_and_keeps_the_user_at_0_150_and_300_ms_offsets() {
    for offset in [0.0f32, 150.0, 300.0] {
        let s = meeting_scene(offset);
        let mut core = capture_core();
        let out = run_scene(&mut core, &s, false);
        assert_eq!(out.len(), s.mic.len(), "timeline");
        let r = score(&s, &out);
        eprintln!(
            "offset {offset} ms: bleed −{:.1} dB, user {:+.2} dB, state {}, {}",
            r.bleed_drop_db,
            r.user_change_db,
            core.state_name(),
            core.summary_line()
        );
        assert!(!core.health().bypassed(), "offset {offset}: {}", core.state_name());
        assert!(r.bleed_drop_db >= 20.0, "offset {offset} ms: bleed only down {:.1} dB", r.bleed_drop_db);
        assert!(r.user_change_db.abs() <= 1.0, "offset {offset} ms: the user changed {:+.2} dB", r.user_change_db);
    }
}

#[test]
fn the_sidecar_deficit_is_left_to_aec3_and_does_not_bypass() {
    // The sidecar thins the reference by 3906 ppm (see the module docs).
    // aec3 absorbs it as render underruns; its API ERLE collapses while it
    // does, and the proxy is what keeps the health machine from bypassing a
    // canceller that works.
    let s = meeting_scene(150.0);
    let mut core = capture_core();
    let out = run_scene(&mut core, &s, true);
    let r = score(&s, &out);
    eprintln!(
        "3906 ppm reference deficit: bleed −{:.1} dB, user {:+.2} dB, {} | {}",
        r.bleed_drop_db,
        r.user_change_db,
        core.state_name(),
        core.summary_line()
    );
    assert_eq!(out.len(), s.mic.len());
    assert!(!core.health().bypassed(), "{}", core.state_name());
    assert!(r.bleed_drop_db >= 15.0, "bleed only down {:.1} dB", r.bleed_drop_db);
    assert!(r.user_change_db.abs() <= 1.0);
}

#[test]
fn recovers_within_seconds_after_a_pause() {
    // Far end only: 12 s, then the capture is paused for 5 s (no mic, the tap
    // keeps delivering), then 12 s more. The timeline stays exact (the pause
    // simply isn't in the mic) and the bleed is back down 3 s after resuming.
    let secs = 29.0f32;
    let n = (secs * FS as f32) as usize;
    let far = synthetic_speech(secs, 21);
    let echo = convolve_sparse(&far, &short_echo_path(180.0, 0.9, 13));
    let mut rng = Rng::new(17);
    let mic: Vec<f32> = echo.iter().map(|e| e + 0.0005 * rng.gauss()).collect();
    let (pause_a, pause_b) = (12 * FS, 17 * FS);
    let mut core = capture_core();
    let mut out = Vec::new();
    let mut events: Vec<(u64, bool, usize, usize)> = Vec::new();
    for (i, a) in (0..n).step_by(AEC_FRAME).enumerate() {
        if a >= pause_a && a < pause_b {
            continue;
        }
        events.push(((i as u64 + 1) * 10 + 2, true, a, (a + AEC_FRAME).min(n)));
    }
    let (mut a, mut call) = (0usize, 0u64);
    while a < n {
        let b = (a + ((call + 1) * 512 / 3 - call * 512 / 3) as usize).min(n);
        call += 1;
        events.push((call * 512 / 48 + 4, false, a, b));
        a = b;
    }
    events.sort_by_key(|e| e.0);
    for (t, is_mic, a, b) in events {
        if is_mic {
            core.push_mic(&mic[a..b], t, 1);
        } else {
            core.push_ref(&far[a..b], t);
        }
        core.process(t, &mut out);
    }
    core.flush(&mut out);
    let kept: Vec<f32> = mic[..pause_a].iter().chain(&mic[pause_b..]).copied().collect();
    assert_eq!(out.len(), kept.len(), "the timeline is the mic's, pause excluded");
    // After resuming (at 12 s of output), from +3 s to the end.
    let from = pause_a + 3 * FS;
    let before = db(span_power(&kept[..pause_a], &[(4.0, 12.0)])) - db(span_power(&out[..pause_a], &[(4.0, 12.0)]));
    let after = db(span_power(&kept[from..], &[(0.0, 9.0)])) - db(span_power(&out[from..], &[(0.0, 9.0)]));
    eprintln!("pause: bleed −{before:.1} dB before, −{after:.1} dB from 3 s after resuming | {}", core.summary_line());
    assert!(before >= 20.0 && after >= 20.0, "before {before:.1} dB, after {after:.1} dB");
    assert!(!core.health().bypassed());
}

#[test]
fn headphones_pass_the_user_through() {
    // No echo path at all: the reference talks, the mic hears only the user.
    let mut s = meeting_scene(0.0);
    let n = s.mic.len();
    let user_gate = gate(n, &[(0.0, 28.0)]);
    let user = synthetic_speech(28.0, 5);
    s.mic = user.iter().zip(&user_gate).map(|(u, g)| u * g).collect();
    let mut core = capture_core();
    let out = run_scene(&mut core, &s, false);
    // Where both talk (the far-only spans of the speaker scene), the user
    // must come through: transparent mode.
    let change = db(span_power(&out, &s.far_only)) - db(span_power(&s.mic, &s.far_only));
    eprintln!("headphones: user during far-end speech {change:+.2} dB, {}", core.state_name());
    assert!(change > -3.0, "the user lost {change:.1} dB while the far end talked");
}

// ── the worker thread ──────────────────────────────────────────────────────

struct VecSink(Arc<Mutex<Vec<f32>>>);

impl CleanedSink for VecSink {
    fn push(&mut self, samples: &[f32]) {
        self.0.lock().unwrap().extend_from_slice(samples);
    }
}

fn no_log(_: &str) {}

#[test]
fn the_worker_flushes_every_sample_on_finish() {
    let got = Arc::new(Mutex::new(Vec::new()));
    let (worker, feed) = CaptureAecWorker::spawn(
        Box::new(VecSink(got.clone())),
        || Ok(Box::new(PassthroughCanceller) as Box<dyn EchoCanceller>),
        WorkerConfig::default(),
        no_log,
    )
    .unwrap();
    let mic: Vec<f32> = (0..16_000 + 55).map(|i| (i % 1000) as f32 / 1000.0).collect();
    let mic_feed = feed.clone();
    let producer = std::thread::spawn(move || {
        for chunk in mic.chunks(333) {
            mic_feed.mic(chunk, 1);
            feed.reference(&[0.0; 170]);
        }
        mic
    });
    let mic = producer.join().unwrap();
    // Everything is queued or held; finish flushes it, tail included.
    worker.finish();
    assert_eq!(*got.lock().unwrap(), mic);
}

#[test]
fn the_worker_streams_while_running_and_stops_without_hanging() {
    let got = Arc::new(Mutex::new(Vec::new()));
    let (worker, feed) = CaptureAecWorker::spawn(
        Box::new(VecSink(got.clone())),
        || Err("no aec3 today".to_string()),
        WorkerConfig::default(),
        no_log,
    )
    .unwrap();
    feed.mic(&[0.5; 4 * AEC_FRAME], 1);
    let deadline = Instant::now() + Duration::from_secs(5);
    while got.lock().unwrap().len() < 4 * AEC_FRAME && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(got.lock().unwrap().len(), 4 * AEC_FRAME, "a passthrough worker streams unheld");
    // Dropped without finish (the session torn down): the thread ends by
    // itself even though a feed still exists.
    drop(worker);
    let deadline = Instant::now() + Duration::from_secs(5);
    while Arc::strong_count(&got) > 1 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(Arc::strong_count(&got), 1, "the worker thread exited and dropped its sink");
    feed.mic(&[0.5; 10], 1); // a late callback: a no-op, not a panic
}

/// Long far-end-only runs, bleed reduction per 20 s window: a clean tap and
/// the sidecar's 3906 ppm deficit (left to aec3). Set NI_AEC_LONG_S for
/// the length (default 180 s).
/// Research, not a gate: `cargo test --lib deficit_long_run -- --ignored --nocapture`.
#[test]
#[ignore]
fn deficit_long_run() {
    let secs: f32 = std::env::var("NI_AEC_LONG_S").ok().and_then(|v| v.parse().ok()).unwrap_or(180.0);
    let n = (secs * FS as f32) as usize;
    let far = synthetic_speech(secs, 21);
    let echo = convolve_sparse(&far, &short_echo_path(30.0 + 150.0, 0.9, 13));
    let mut rng = Rng::new(17);
    let mic: Vec<f32> = echo.iter().map(|e| e + 0.0005 * rng.gauss()).collect();
    let windows: Vec<(f32, f32)> = (0..(secs / 20.0) as usize).map(|k| (k as f32 * 20.0, (k + 1) as f32 * 20.0)).collect();
    let s = Scene { reference: far, mic, far_only: vec![], user_only: vec![] };
    for (label, deficit) in [("clean", false), ("3906 ppm deficit", true)] {
        let mut core = capture_core();
        let out = run_scene(&mut core, &s, deficit);
        let per: Vec<String> = windows
            .iter()
            .map(|w| format!("{:.1}", db(span_power(&s.mic, &[*w])) - db(span_power(&out, &[*w]))))
            .collect();
        eprintln!("{label:22} bleed drop per 20 s: {} | {}", per.join(" "), core.state_name());
        for l in core.logs.iter().filter(|l| l.contains("health") || l.contains("bypass") || l.contains("reset")) {
            eprintln!("    {l}");
        }
    }
    let _ = n;
}
