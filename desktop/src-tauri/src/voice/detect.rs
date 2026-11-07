//! The two decisions the DSP thread makes itself, frame by frame, because
//! they can't wait on the async session: the echo mode, and barge-in.
//! Both are pure; the clock is the session's audio clock (16 kHz samples).

use super::events::EchoMode;
use super::profile::{BargeTuning, NoiseProfile};
use crate::audio::aec::AecMetrics;

/// Far-end speech this long without the canceller converging → half-duplex
/// (it isn't going to converge on this route; tap-to-interrupt instead).
pub const HALF_DUPLEX_AFTER_MS: u32 = 8_000;
/// A reference frame louder than this RMS is far-end activity (≈ −50 dBFS).
pub const FAR_END_ACTIVE_RMS: f32 = 0.003;
/// A reference frame this loud (RMS, ≈ −34 dBFS) is one AEC3's echo return
/// loss estimate learns from: quieter far end leaves it where it was (a −44
/// dBFS reference never moved it, even with a −6 dB echo).
pub const ERL_REF_RMS: f32 = 0.02;
/// ERL (dB) below this: no echo seen on the mic. AEC3 starts at −30 dB (its
/// ERL estimator's ceiling) and only moves once its filter has found an echo
/// to remove, so with no acoustic path at all (headphones) it stays at −30
/// (S1b measured −29 dB).
pub const NO_PATH_ERL_DB: f32 = -10.0;
/// ERL (dB) at or above this: the agent's voice comes back into the mic.
/// Speakers read +9 to +20 dB once the filter has found the echo.
pub const ECHO_PATH_ERL_DB: f32 = 3.0;
/// Loud far end (≥ [`ERL_REF_RMS`]) for this long with ERL below
/// [`NO_PATH_ERL_DB`] the whole time → no echo path.
///
/// Why 4 s and not less: on speakers ERL also sits at −30 dB until AEC3's
/// filter has converged on the echo. With the real canceller on synthetic
/// scenes (echo −6 to −36 dB, 20–400 ms delays, −60/−80 dBFS noise) that took
/// up to 1.6 s of loud far end (2.6 s of any far end), after which ERL
/// crossed −10 and +3 dB within ~0.3 s. An echo quieter still sits at or
/// under the mic's noise floor, where it can't pass for speech.
pub const NO_PATH_AFTER_MS: u32 = 4_000;

/// What the signal says about the output → mic path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EchoPath {
    /// Not measured yet (or ambiguous).
    Unknown,
    /// Loud far end, and the canceller has found no echo: headphones, or an
    /// output the mic can't hear.
    None,
    /// The canceller found the agent's voice in the mic: speakers rules,
    /// whatever the route's name says. Holds until [`EchoTracker::reset`].
    Present,
}

/// Echo mode from the canceller's metrics and the far end (chat-voice.md
/// §3.1, §3.3a). The route's name is only a hint; the signal decides:
/// - no working canceller (passthrough) → `half_duplex`;
/// - no echo path measured ([`EchoPath::None`]) → `headphones`;
/// - converged → `cancelling`;
/// - otherwise `converging`, until [`HALF_DUPLEX_AFTER_MS`] of far-end
///   activity has passed without convergence → `half_duplex`, which holds
///   until the canceller converges, is reset, or no echo path is measured.
///
/// Barge-in (`headphones` / `cancelling`) is never allowed before the signal
/// or a converged canceller confirms it.
#[derive(Debug, Clone)]
pub struct EchoTracker {
    canceller_real: bool,
    /// The route's name says headphones (logged; resets the measurement when
    /// it changes; never allows barge-in by itself).
    hint: bool,
    path: EchoPath,
    /// Loud far end (ms) with ERL below [`NO_PATH_ERL_DB`], in a row.
    no_echo_ms: u32,
    /// Far-end activity (ms) since the canceller was last converged or reset.
    unconverged_far_ms: u32,
    converged: bool,
}

impl EchoTracker {
    pub fn new(canceller_real: bool) -> Self {
        Self {
            canceller_real,
            hint: false,
            path: EchoPath::Unknown,
            no_echo_ms: 0,
            unconverged_far_ms: 0,
            converged: false,
        }
    }

    /// The output route's headphones hint. A change means another output:
    /// the path is measured again.
    pub fn set_route_hint(&mut self, headphones: bool) {
        if headphones != self.hint {
            self.hint = headphones;
            self.path = EchoPath::Unknown;
            self.no_echo_ms = 0;
        }
    }

    pub fn path(&self) -> EchoPath {
        self.path
    }

    /// The canceller was reset (a stream behind a tap was replaced): it
    /// starts converging again, and the path is measured again.
    pub fn reset(&mut self) {
        self.unconverged_far_ms = 0;
        self.converged = false;
        self.path = EchoPath::Unknown;
        self.no_echo_ms = 0;
    }

    /// One 10 ms capture frame: the canceller's metrics, and the RMS of the
    /// far end it was handed before it (0 when none).
    pub fn update(&mut self, metrics: &AecMetrics, far_rms: f32) -> EchoMode {
        self.converged = metrics.converged;
        if self.converged {
            self.unconverged_far_ms = 0;
        } else if far_rms > FAR_END_ACTIVE_RMS {
            self.unconverged_far_ms = self.unconverged_far_ms.saturating_add(10);
        }
        if self.canceller_real && far_rms >= ERL_REF_RMS {
            self.measure(metrics.erl_db);
        }
        self.mode()
    }

    /// One loud far-end frame's ERL.
    fn measure(&mut self, erl_db: Option<f32>) {
        match erl_db {
            Some(erl) if erl >= ECHO_PATH_ERL_DB => {
                self.path = EchoPath::Present;
                self.no_echo_ms = 0;
            }
            Some(erl) if erl < NO_PATH_ERL_DB => {
                if self.path == EchoPath::Unknown {
                    self.no_echo_ms = self.no_echo_ms.saturating_add(10);
                    if self.no_echo_ms >= NO_PATH_AFTER_MS {
                        self.path = EchoPath::None;
                    }
                }
            }
            // Ambiguous: some echo is being found. Start over, and stop
            // trusting an earlier "no path".
            Some(_) => {
                self.no_echo_ms = 0;
                if self.path == EchoPath::None {
                    self.path = EchoPath::Unknown;
                }
            }
            // Not measured: no evidence either way.
            None => self.no_echo_ms = 0,
        }
    }

    pub fn mode(&self) -> EchoMode {
        if !self.canceller_real {
            EchoMode::HalfDuplex
        } else if self.path == EchoPath::None {
            EchoMode::Headphones
        } else if self.converged {
            EchoMode::Cancelling
        } else if self.unconverged_far_ms >= HALF_DUPLEX_AFTER_MS {
            EchoMode::HalfDuplex
        } else {
            EchoMode::Converging
        }
    }
}

/// Barge-in criterion (§3.3a): a run that starts on a frame ≥ 0.65, continues
/// while frames stay ≥ 0.5, and lasts 320 ms. Frames only count while armed
/// (the agent is audible, the echo mode allows it, barge-in is on, not
/// muted); any unarmed frame drops the run.
#[derive(Debug, Clone)]
pub struct BargeInDetector {
    pub onset: f32,
    pub off: f32,
    pub sustain_samples: u64,
    run_start: Option<u64>,
}

impl Default for BargeInDetector {
    /// The quiet room's (0.2.45): onset 0.65, off 0.5, 320 ms.
    fn default() -> Self {
        Self::for_profile(NoiseProfile::Quiet)
    }
}

impl BargeInDetector {
    pub fn for_profile(profile: NoiseProfile) -> Self {
        Self::for_tuning(&profile.tuning().barge)
    }

    pub fn for_tuning(b: &BargeTuning) -> Self {
        Self { onset: b.onset, off: b.off, sustain_samples: b.sustain_samples(), run_start: None }
    }

    /// Where the current run started (audio clock), if one is under way.
    pub fn run_start(&self) -> Option<u64> {
        self.run_start
    }

    pub fn reset(&mut self) {
        self.run_start = None;
    }

    /// One VAD frame covering `[start, end)`. Returns the run's onset when
    /// barge-in fires (once per run). The noisy room's level gate (always
    /// near in the quiet room): a run starts only on a frame near enough to
    /// start one (`near.0`), and a frame not near enough to go on
    /// (`near.1`) counts as below `off`.
    pub fn update(&mut self, prob: f32, start: u64, end: u64, armed: bool, near: (bool, bool)) -> Option<u64> {
        let prob = match (self.run_start, near) {
            (_, (_, false)) | (None, (false, _)) => f32::NEG_INFINITY,
            _ => prob,
        };
        if !armed {
            self.run_start = None;
            return None;
        }
        match self.run_start {
            None if prob >= self.onset => self.run_start = Some(start),
            None => return None,
            Some(_) if prob < self.off => {
                self.run_start = None;
                return None;
            }
            Some(_) => {}
        }
        let onset = self.run_start?;
        if end.saturating_sub(onset) >= self.sustain_samples {
            self.run_start = None;
            return Some(onset);
        }
        None
    }
}

/// A frame's level in dBFS from its RMS; silence reads [`MIN_LEVEL_DB`].
pub fn level_db(rms: f32) -> f32 {
    if rms > 0.0 {
        (20.0 * rms.log10()).max(MIN_LEVEL_DB)
    } else {
        MIN_LEVEL_DB
    }
}

/// The level a digital zero reads.
pub const MIN_LEVEL_DB: f32 = -120.0;
/// The noise floor starts here...
pub const FLOOR_START_DB: f32 = -60.0;
/// ...and stays within this.
pub const FLOOR_MIN_DB: f32 = -90.0;
pub const FLOOR_MAX_DB: f32 = -20.0;
/// Per VAD frame (32 ms): a quieter frame pulls the floor down fast
/// (~0.1 s), a louder one lifts it slowly (~3 s).
pub const FLOOR_DOWN: f32 = 0.3;
pub const FLOOR_UP: f32 = 0.01;

/// The room's noise floor N (noise design §2.1), tracked over the VAD
/// frames' levels. Steady beds (fans, hum) set it; speech, the user's or a
/// TV's, sits above it. Measured under every preset; only the noisy one
/// will use it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NoiseFloor {
    db: f32,
}

impl Default for NoiseFloor {
    fn default() -> Self {
        Self { db: FLOOR_START_DB }
    }
}

impl NoiseFloor {
    #[allow(dead_code)]
    pub fn db(&self) -> f32 {
        self.db
    }

    /// One frame at `level` dBFS. Returns the floor that frame is judged
    /// against: the one before it.
    pub fn update(&mut self, level: f32) -> f32 {
        let before = self.db;
        let rate = if level < self.db { FLOOR_DOWN } else { FLOOR_UP };
        self.db = (self.db + rate * (level - self.db)).clamp(FLOOR_MIN_DB, FLOOR_MAX_DB);
        before
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_in_dbfs() {
        assert_eq!(level_db(1.0), 0.0);
        assert!((level_db(0.1) + 20.0).abs() < 1e-4);
        assert!((level_db(0.001) + 60.0).abs() < 1e-3);
        assert_eq!(level_db(0.0), MIN_LEVEL_DB);
        assert_eq!(level_db(1e-9), MIN_LEVEL_DB);
    }

    #[test]
    fn the_noise_floor_drops_fast_and_rises_slowly() {
        let mut n = NoiseFloor::default();
        assert_eq!(n.db(), -60.0);
        // Judged against the floor before the frame.
        assert_eq!(n.update(-80.0), -60.0);
        assert!((n.db() + 66.0).abs() < 1e-4);
        // ~0.1 s (3 frames) of a quieter room gets most of the way down.
        let mut n = NoiseFloor::default();
        for _ in 0..3 {
            n.update(-80.0);
        }
        assert!(n.db() < -72.0, "{}", n.db());
        // 3 s (94 frames) of speech at −30 lifts it only part way.
        let mut n = NoiseFloor::default();
        for _ in 0..94 {
            n.update(-30.0);
        }
        assert!(n.db() > -50.0 && n.db() < -40.0, "{}", n.db());
        // Clamped.
        for _ in 0..10_000 {
            n.update(0.0);
        }
        assert_eq!(n.db(), FLOOR_MAX_DB);
        for _ in 0..100 {
            n.update(MIN_LEVEL_DB);
        }
        assert_eq!(n.db(), FLOOR_MIN_DB);
    }

    /// Metrics for one frame.
    fn m(converged: bool, erl_db: Option<f32>) -> AecMetrics {
        AecMetrics { erle_db: None, delay_ms: None, erl_db, converged }
    }

    const LOUD: f32 = 0.1; // −20 dBFS far end
    const QUIET: f32 = 0.01; // active, but too quiet for ERL to learn from

    /// `ms` of frames with the same metrics and far end; the last mode.
    fn run(e: &mut EchoTracker, ms: u32, metrics: AecMetrics, far: f32) -> EchoMode {
        let mut mode = e.mode();
        for _ in 0..ms / 10 {
            mode = e.update(&metrics, far);
        }
        mode
    }

    #[test]
    fn no_echo_path_is_measured_then_allows_barge_in() {
        // Sony / Bose / a USB dongle: the name says nothing (no hint), and
        // ERL stays at AEC3's −30 dB start while the agent talks.
        let mut e = EchoTracker::new(true);
        assert_eq!(run(&mut e, NO_PATH_AFTER_MS - 10, m(false, Some(-30.0)), LOUD), EchoMode::Converging);
        assert!(!e.mode().allows_barge_in(), "not before the signal confirms it");
        assert_eq!(e.update(&m(false, Some(-30.0)), LOUD), EchoMode::Headphones);
        assert_eq!(e.path(), EchoPath::None);
        assert!(e.mode().allows_barge_in());
        // The far end going quiet keeps it.
        assert_eq!(run(&mut e, 20_000, m(false, Some(-30.0)), 0.0), EchoMode::Headphones);
    }

    #[test]
    fn a_speaker_named_like_headphones_never_counts_as_headphones() {
        // "Beats Pill": the hint says headphones, but the canceller finds the
        // echo. ERL sits at −30 dB for the first ~2 s (the filter hasn't
        // converged), then reads the real echo loss.
        let mut e = EchoTracker::new(true);
        e.set_route_hint(true);
        assert_eq!(run(&mut e, 2_500, m(false, Some(-30.0)), LOUD), EchoMode::Converging);
        assert_eq!(run(&mut e, 300, m(false, Some(12.0)), LOUD), EchoMode::Converging);
        assert_eq!(e.path(), EchoPath::Present);
        // The echo path holds: ERL drifting back to −30 dB between replies
        // (AEC3's hold expiring) doesn't make it headphones.
        assert_eq!(run(&mut e, 20_000, m(false, Some(-30.0)), LOUD), EchoMode::HalfDuplex);
        assert_eq!(e.path(), EchoPath::Present);
        // Speakers rules: barge-in only once the canceller converges.
        assert_eq!(e.update(&m(true, Some(14.0)), LOUD), EchoMode::Cancelling);
    }

    #[test]
    fn the_hint_alone_never_allows_barge_in() {
        let mut e = EchoTracker::new(true);
        e.set_route_hint(true);
        // No far end, far end too quiet to learn from, or no ERL measured.
        assert_eq!(run(&mut e, 10_000, m(false, Some(-30.0)), 0.0), EchoMode::Converging);
        assert_eq!(run(&mut e, 10_000, m(false, Some(-30.0)), QUIET), EchoMode::HalfDuplex);
        let mut e = EchoTracker::new(true);
        e.set_route_hint(true);
        assert_eq!(run(&mut e, 10_000, m(false, None), LOUD), EchoMode::HalfDuplex);
        // A passthrough canceller can't measure anything: half-duplex.
        let mut e = EchoTracker::new(false);
        e.set_route_hint(true);
        assert_eq!(run(&mut e, 10_000, m(false, Some(-30.0)), LOUD), EchoMode::HalfDuplex);
        assert_eq!(e.update(&m(true, Some(-30.0)), LOUD), EchoMode::HalfDuplex, "even a bogus converged flag");
    }

    #[test]
    fn ambiguous_erl_restarts_the_measurement_and_revokes_no_path() {
        let mut e = EchoTracker::new(true);
        run(&mut e, 3_000, m(false, Some(-30.0)), LOUD);
        // Some echo found: start over.
        run(&mut e, 10, m(false, Some(-5.0)), LOUD);
        assert_eq!(run(&mut e, 3_000, m(false, Some(-30.0)), LOUD), EchoMode::Converging);
        assert_eq!(run(&mut e, 1_000, m(false, Some(-30.0)), LOUD), EchoMode::Headphones);
        // Headphones decided, then the canceller starts finding an echo (an
        // open-back pair turned up, or the route changed under it).
        assert_eq!(e.update(&m(false, Some(-5.0)), LOUD), EchoMode::Converging);
        assert_eq!(e.path(), EchoPath::Unknown);
        assert_eq!(run(&mut e, NO_PATH_AFTER_MS, m(false, Some(-30.0)), LOUD), EchoMode::Headphones);
        assert!(!e.update(&m(false, Some(9.0)), LOUD).allows_barge_in());
        assert_eq!(e.path(), EchoPath::Present, "a real echo overrides an earlier no-path");
    }

    #[test]
    fn only_loud_far_end_counts_towards_no_path() {
        let mut e = EchoTracker::new(true);
        // Quiet far end (ERL can't move) for ever: never headphones.
        assert_eq!(run(&mut e, 7_000, m(false, Some(-30.0)), QUIET), EchoMode::Converging);
        // Loud frames count; quiet ones in between neither count nor reset.
        for _ in 0..NO_PATH_AFTER_MS / 10 - 1 {
            e.update(&m(false, Some(-30.0)), LOUD);
            e.update(&m(false, Some(-30.0)), QUIET);
        }
        assert!(!e.mode().allows_barge_in());
        assert_eq!(e.path(), EchoPath::Unknown);
        assert_eq!(e.update(&m(false, Some(-30.0)), LOUD), EchoMode::Headphones);
    }

    #[test]
    fn a_reset_or_a_route_change_measures_again() {
        let mut e = EchoTracker::new(true);
        run(&mut e, NO_PATH_AFTER_MS, m(false, Some(-30.0)), LOUD);
        assert_eq!(e.mode(), EchoMode::Headphones);
        e.reset();
        assert_eq!(e.mode(), EchoMode::Converging);
        run(&mut e, NO_PATH_AFTER_MS, m(false, Some(-30.0)), LOUD);
        assert_eq!(e.mode(), EchoMode::Headphones);
        e.set_route_hint(true);
        assert_eq!(e.mode(), EchoMode::Converging, "another output");
        e.set_route_hint(true);
        run(&mut e, 10, m(false, Some(15.0)), LOUD);
        assert_eq!(e.path(), EchoPath::Present);
        e.reset();
        assert_eq!(e.path(), EchoPath::Unknown);
    }

    #[test]
    fn echo_mode_converging_then_cancelling_then_lost() {
        let mut e = EchoTracker::new(true);
        assert_eq!(e.update(&m(false, None), 0.0), EchoMode::Converging);
        assert_eq!(run(&mut e, 3_000, m(false, Some(10.0)), LOUD), EchoMode::Converging);
        assert_eq!(e.update(&m(true, Some(10.0)), LOUD), EchoMode::Cancelling);
        assert_eq!(e.update(&m(false, Some(10.0)), LOUD), EchoMode::Converging, "losing convergence stops barge-in");
    }

    #[test]
    fn echo_mode_gives_up_to_half_duplex_after_far_end_without_convergence() {
        let mut e = EchoTracker::new(true);
        let echo = m(false, Some(10.0));
        let frames = HALF_DUPLEX_AFTER_MS / 10;
        for i in 0..frames {
            let mode = e.update(&echo, LOUD);
            assert_eq!(mode, if i + 1 >= frames { EchoMode::HalfDuplex } else { EchoMode::Converging });
        }
        // Silence on the far end doesn't bring it back...
        assert_eq!(run(&mut e, 10_000, echo, 0.0), EchoMode::HalfDuplex);
        // ...convergence does, and so does a reset.
        assert_eq!(e.update(&m(true, Some(10.0)), LOUD), EchoMode::Cancelling);
        run(&mut e, HALF_DUPLEX_AFTER_MS, echo, LOUD);
        assert_eq!(e.mode(), EchoMode::HalfDuplex);
        e.reset();
        assert_eq!(e.mode(), EchoMode::Converging);
    }

    const F: u64 = 512; // one Silero frame, 32 ms

    fn feed(d: &mut BargeInDetector, probs: &[f32], armed: bool, at: &mut u64) -> Option<u64> {
        let mut fired = None;
        for &p in probs {
            if let Some(o) = d.update(p, *at, *at + F, armed, (true, true)) {
                assert!(fired.is_none(), "fires once per run");
                fired = Some(o);
            }
            *at += F;
        }
        fired
    }

    #[test]
    fn barge_in_fires_after_320_ms_sustained() {
        let mut d = BargeInDetector::default();
        let mut at = 10 * F;
        // 9 frames = 288 ms: not yet.
        assert_eq!(feed(&mut d, &[0.9; 9], true, &mut at), None);
        // The 10th frame reaches 320 ms: fires with the run's onset.
        assert_eq!(feed(&mut d, &[0.9], true, &mut at), Some(10 * F));
    }

    #[test]
    fn barge_in_needs_the_stricter_onset_and_stays_above_off() {
        let mut d = BargeInDetector::default();
        let mut at = 0;
        // 0.6 is speech for turns but not a barge-in onset.
        assert_eq!(feed(&mut d, &[0.6; 20], true, &mut at), None);
        // Onset at 0.7, then hovering at 0.55 (≥ off) keeps the run.
        let start = at;
        let mut probs = vec![0.7];
        probs.extend([0.55; 9]);
        assert_eq!(feed(&mut d, &probs, true, &mut at), Some(start));
        // A dip below 0.5 drops the run.
        let mut probs = vec![0.9; 5];
        probs.push(0.4);
        probs.extend([0.9; 5]);
        assert_eq!(feed(&mut d, &probs, true, &mut at), None);
    }

    /// The noisy room's detector: a stricter probability, and far frames
    /// (the level gate's) break a run like quiet ones.
    #[test]
    fn the_noisy_barge_in_counts_near_frames_only() {
        let mut d = BargeInDetector::for_profile(NoiseProfile::Noisy);
        assert_eq!((d.onset, d.off, d.sustain_samples), (0.7, 0.55, 5120));
        let mut at = 0;
        // 0.65 would start the quiet room's run; not this one.
        assert_eq!(feed(&mut d, &[0.65; 20], true, &mut at), None);
        // 9 frames = 288 ms: not yet; the 10th (320 ms) fires.
        let start = at;
        assert_eq!(feed(&mut d, &[0.9; 9], true, &mut at), None);
        assert_eq!(feed(&mut d, &[0.9], true, &mut at), Some(start));
        // Loud-probability frames that aren't near never start a run, nor
        // do ones only near enough to go on with one...
        for near in [(false, false), (false, true)] {
            for _ in 0..30 {
                assert_eq!(d.update(0.99, at, at + F, true, near), None);
                at += F;
            }
        }
        // ...which, once a run started, carry it...
        let start = at;
        assert_eq!(d.update(0.99, at, at + F, true, (true, true)), None);
        at += F;
        for _ in 0..8 {
            assert_eq!(d.update(0.99, at, at + F, true, (false, true)), None);
            at += F;
        }
        assert_eq!(d.update(0.99, at, at + F, true, (false, true)), Some(start));
        at += F;
        // ...while one that isn't near at all breaks it.
        assert_eq!(feed(&mut d, &[0.9; 8], true, &mut at), None);
        assert_eq!(d.update(0.99, at, at + F, true, (true, false)), None);
        at += F;
        assert_eq!(d.run_start(), None);
    }

    #[test]
    fn barge_in_suppressed_when_not_armed() {
        let mut d = BargeInDetector::default();
        let mut at = 0;
        assert_eq!(feed(&mut d, &[0.95; 30], false, &mut at), None);
        // A run straddling arming starts counting only once armed.
        assert_eq!(feed(&mut d, &[0.95; 5], false, &mut at), None);
        let armed_at = at;
        assert_eq!(feed(&mut d, &[0.95; 10], true, &mut at), Some(armed_at));
    }
}
