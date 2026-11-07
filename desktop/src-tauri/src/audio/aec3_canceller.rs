//! The real [`EchoCanceller`]: WebRTC's AEC3, ported to pure Rust by the `aec3`
//! crate (RubyBit/aec3-rs, pinned "=0.4.0"), picked by the S1 bake-off
//! (dial8-website/docs/plans/chat-voice.md §3.3a).
//!
//! The crate's standard linear pipeline at 16 kHz mono, 10 ms frames:
//! high-pass filter on, AEC3, noise suppression off (VAD and STT want the
//! speech untouched), AGC2 off, the fullband post filter off (it only acts at
//! 48 kHz anyway), metrics exported.
//!
//! Frame order: every far-end frame that has arrived goes through
//! [`render`](EchoCanceller::render), then the capture frame through
//! [`capture`](EchoCanceller::capture). When there is no far end the caller
//! still pushes one zero render frame per capture frame, so the render timeline
//! never stalls. AEC3's own delay estimator finds the render → capture offset;
//! the reference path needs no buffering (the playback tap leads the echo).
//!
//! `converged` is the spec's rule, counted in capture frames, never wall clock:
//! the canceller's ERLE has been ≥ 6 dB on each of the last 100 frames (1 s).
//! AEC3's ERLE estimate lags the real cancellation by 2–4 s and drops back to
//! ~0 dB for a few seconds whenever its delay estimate moves (S1), so this
//! errs towards half-duplex, never towards trusting a leaky canceller.
//!
//! **Tunings** ([`AecTuning`]): the voice session runs the crate's stock
//! AEC3 config; meeting captures run S1b's "softer" suppressor with a ~1 s
//! delay search ([`capture_aec3_config`], chat-voice.md §3.5). Both keep the
//! same pipeline around it (HPF on, NS off, AGC2 off, metrics exported).
//!
//! **Not `Send`.** The crate's graph runtime holds `Rc`s and non-`Send` trait
//! objects: build the canceller on the thread that runs it (the voice
//! session's DSP thread) and keep it there. Construction allocates and plans
//! FFTs; `render` and `capture` allocate a little per frame (the graph's
//! packets), so run them on a DSP thread, never in an audio callback.

use aec3::api::config::{EchoCanceller3Config, MaskingThresholds, Tuning};
use aec3::nodes::audio::AudioFormat;
use aec3::pipelines::linear::{self, LinearPipeline};

use super::aec::{AecMetrics, AecTuning, EchoCanceller, AEC_FRAME};

const SAMPLE_RATE: usize = 16_000;
/// ERLE the canceller must report before barge-in on speakers is trusted.
pub const CONVERGED_ERLE_DB: f32 = 6.0;
/// ...on this many consecutive capture frames (1 s of 10 ms frames).
pub const CONVERGED_HOLD_FRAMES: u32 = 100;

/// The capture tuning's delay search: 10 matched filters (~1 s) instead of
/// the stock 5 (~0.5 s). A 500 ms tap offset leaked 56% of the remote words
/// with 5 and none with 10 (S1b), for ~15 CPU-seconds an hour more.
pub const CAPTURE_NUM_FILTERS: usize = 10;

/// S1b's "softer" suppressor masks, used for both the normal and the nearend
/// (double-talk) tuning: the echo may exceed the user by more before a band
/// is suppressed, so fewer of the user's words go in double talk.
pub fn capture_suppressor_tuning() -> Tuning {
    Tuning::new(MaskingThresholds::new(2.0, 4.0, 0.3), MaskingThresholds::new(0.5, 1.5, 0.3), 2.0, 0.25)
}

/// The AEC3 config for meeting captures (chat-voice.md §3.5, S1b's
/// `aec3softer` plus `delay.num_filters = 10`):
/// - `dominant_nearend_detection`: `snr_threshold` 10 (stock 30),
///   `trigger_threshold` 5 (stock 12): double talk is recognised sooner;
/// - `normal_tuning` = `nearend_tuning` = [`capture_suppressor_tuning`];
/// - transparent mode on (it is what keeps headphones harmless);
/// - `delay.num_filters` = [`CAPTURE_NUM_FILTERS`].
///
/// Everything else is the crate default. Pinned by a test.
pub fn capture_aec3_config() -> EchoCanceller3Config {
    let mut cfg = EchoCanceller3Config::default();
    cfg.delay.num_filters = CAPTURE_NUM_FILTERS;
    cfg.transparent_mode.enabled = true;
    cfg.suppressor.dominant_nearend_detection.snr_threshold = 10.0;
    cfg.suppressor.dominant_nearend_detection.trigger_threshold = 5;
    cfg.suppressor.normal_tuning = capture_suppressor_tuning();
    cfg.suppressor.nearend_tuning = capture_suppressor_tuning();
    cfg
}

/// `converged` = ERLE ≥ [`CONVERGED_ERLE_DB`] on each of the last
/// [`CONVERGED_HOLD_FRAMES`] capture frames. No ERLE yet counts as below.
#[derive(Debug, Default, Clone, Copy)]
struct ConvergenceGate {
    frames_above: u32,
}

impl ConvergenceGate {
    fn update(&mut self, erle_db: Option<f32>) -> bool {
        match erle_db {
            Some(erle) if erle >= CONVERGED_ERLE_DB => {
                self.frames_above = self.frames_above.saturating_add(1);
            }
            _ => self.frames_above = 0,
        }
        self.converged()
    }

    fn converged(&self) -> bool {
        self.frames_above >= CONVERGED_HOLD_FRAMES
    }
}

pub struct Aec3Canceller {
    pipeline: LinearPipeline,
    out: [f32; AEC_FRAME],
    erle_db: Option<f32>,
    erl_db: Option<f32>,
    delay_ms: Option<i32>,
    gate: ConvergenceGate,
    /// A pipeline error has been logged (one line per canceller, not per frame).
    logged_error: bool,
}

impl Aec3Canceller {
    /// The stock (voice) tuning.
    #[allow(dead_code)] // the tests' shorthand; the app builds through aec::new_echo_canceller*
    pub fn new() -> Result<Self, String> {
        Self::with_tuning(AecTuning::Voice)
    }

    pub fn with_tuning(tuning: AecTuning) -> Result<Self, String> {
        let format = AudioFormat::ten_ms(SAMPLE_RATE as u32, 1);
        debug_assert_eq!(format.sample_count(), AEC_FRAME);
        let mut builder = linear::builder(format, format)
            .enable_high_pass_filter(true)
            .enable_noise_suppression(false)
            .enable_gain_controller2(false)
            .enable_post_filter(false)
            .export_metrics(true);
        if tuning == AecTuning::Capture {
            builder = builder.aec3_config(capture_aec3_config());
        }
        let pipeline = builder.build().map_err(|e| format!("aec3: {e}"))?;
        Ok(Self {
            pipeline,
            out: [0.0; AEC_FRAME],
            erle_db: None,
            erl_db: None,
            delay_ms: None,
            gate: ConvergenceGate::default(),
            logged_error: false,
        })
    }

    fn log_error(&mut self, what: &str, e: impl std::fmt::Display) {
        if !self.logged_error {
            self.logged_error = true;
            eprintln!("[aec] {what} failed: {e} (passing the mic through; further errors not logged)");
        }
    }

    fn metrics(&self) -> AecMetrics {
        AecMetrics { erle_db: self.erle_db, delay_ms: self.delay_ms, erl_db: self.erl_db, converged: self.gate.converged() }
    }
}

impl EchoCanceller for Aec3Canceller {
    fn render(&mut self, frame: &[f32; AEC_FRAME]) {
        if let Err(e) = self.pipeline.handle_render_frame(frame) {
            self.log_error("render", e);
        }
    }

    fn capture(&mut self, frame: &[f32; AEC_FRAME], out: &mut [f32; AEC_FRAME]) -> AecMetrics {
        match self.pipeline.process_capture_frame(frame, &mut self.out) {
            Ok(true) => out.copy_from_slice(&self.out),
            // No processed frame yet: never swallow the user's audio.
            Ok(false) => out.copy_from_slice(frame),
            Err(e) => {
                self.log_error("capture", e);
                out.copy_from_slice(frame);
                self.gate = ConvergenceGate::default();
                return self.metrics();
            }
        }
        // The metrics sink keeps only the latest packet (one per capture frame).
        loop {
            match self.pipeline.try_pull_metrics() {
                Ok(Some(m)) => {
                    let m = m.payload();
                    let erle = m.echo_return_loss_enhancement;
                    self.erle_db = erle.is_finite().then_some(erle as f32);
                    let erl = m.echo_return_loss;
                    self.erl_db = erl.is_finite().then_some(erl as f32);
                    self.delay_ms = Some(m.delay_ms);
                }
                Ok(None) => break,
                Err(e) => {
                    self.log_error("metrics", e);
                    break;
                }
            }
        }
        self.gate.update(self.erle_db);
        self.metrics()
    }

    fn reset(&mut self) {
        let result = self.pipeline.reset_aec3().and_then(|_| self.pipeline.reset_high_pass());
        if let Err(e) = result {
            self.log_error("reset", e);
        }
        // Drop a metrics packet from before the reset.
        while let Ok(Some(_)) = self.pipeline.try_pull_metrics() {}
        self.erle_db = None;
        self.erl_db = None;
        self.delay_ms = None;
        self.gate = ConvergenceGate::default();
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::aec::PassthroughCanceller;
    use super::*;

    /// Deterministic xorshift, so the tests need no rand crate.
    pub(crate) struct Rng(u64);
    impl Rng {
        pub(crate) fn new(seed: u64) -> Self {
            Self(seed.max(1))
        }
        pub(crate) fn next_f32(&mut self) -> f32 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 >> 40) as f32 / (1u64 << 24) as f32 // [0, 1)
        }
        pub(crate) fn gauss(&mut self) -> f32 {
            let u1 = self.next_f32().max(1e-7);
            let u2 = self.next_f32();
            (-2.0 * u1.ln()).sqrt() * (2.0 * std::f32::consts::PI * u2).cos()
        }
    }

    fn power(x: &[f32]) -> f64 {
        x.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>() / x.len().max(1) as f64
    }

    /// Speech-like far end at 16 kHz: a gliding glottal pulse train plus
    /// breath noise, through formant resonators that move every 150 ms,
    /// syllable-rate envelope with short pauses, -20 dBFS RMS.
    pub(crate) fn synthetic_speech(seconds: f32, seed: u64) -> Vec<f32> {
        let n = (seconds * SAMPLE_RATE as f32) as usize;
        let fs = SAMPLE_RATE as f32;
        let mut rng = Rng::new(seed);
        let mut x = vec![0.0f32; n];
        let (mut phase, mut f0) = (0.0f32, 140.0f32);
        let formant_sets = [[700.0, 1200.0, 2600.0], [300.0, 2300.0, 3000.0], [500.0, 900.0, 2500.0], [400.0, 1900.0, 2700.0]];
        let mut state = [[0.0f32; 2]; 3];
        let mut formants = formant_sets[0];
        for (i, out) in x.iter_mut().enumerate() {
            if i % (fs as usize * 15 / 100) == 0 {
                formants = formant_sets[(rng.next_f32() * 4.0) as usize % 4];
                f0 = 100.0 + 120.0 * rng.next_f32();
            }
            phase += f0 / fs;
            let pulse = if phase >= 1.0 {
                phase -= 1.0;
                1.0
            } else {
                0.0
            };
            let exc = pulse + 0.08 * rng.gauss();
            let mut y = 0.0;
            for (k, f) in formants.iter().enumerate() {
                // Two-pole resonator, bandwidth ~100 Hz.
                let r = (-std::f32::consts::PI * 100.0 / fs).exp();
                let a1 = 2.0 * r * (2.0 * std::f32::consts::PI * f / fs).cos();
                let a2 = -r * r;
                let v = exc + a1 * state[k][0] + a2 * state[k][1];
                state[k][1] = state[k][0];
                state[k][0] = v;
                y += v / (k as f32 + 1.0);
            }
            // ~4 syllables a second; every 7th syllable slot is a pause.
            let t = i as f32 / fs;
            let syllable = (t * 4.0) as usize;
            let env = if syllable % 7 == 6 { 0.0 } else { 0.5 - 0.5 * (2.0 * std::f32::consts::PI * 4.0 * t).cos() };
            *out = y * env;
        }
        let g = (0.01 / power(&x).max(1e-12)).sqrt() as f32; // -20 dBFS RMS
        x.iter_mut().for_each(|v| *v *= g);
        x
    }

    /// A laptop-ish echo path at 16 kHz: direct path after `delay_ms`, a few
    /// early reflections, an exponential tail (RT60 `rt60` s), -6 dB overall.
    pub(crate) fn echo_path(delay_ms: f32, rt60: f32, seed: u64) -> Vec<f32> {
        let fs = SAMPLE_RATE as f32;
        let mut rng = Rng::new(seed);
        let d = (delay_ms * fs / 1000.0) as usize;
        let len = d + (rt60 * fs) as usize;
        let mut h = vec![0.0f32; len];
        h[d] = 0.5;
        for k in 0..8 {
            let t = d + 16 + (rng.next_f32() * 300.0) as usize + k;
            h[t] += 0.15 * (rng.next_f32() - 0.5);
        }
        for (i, v) in h.iter_mut().enumerate().skip(d + 80) {
            let t = (i - d - 80) as f32 / fs;
            *v += 0.02 * rng.gauss() * (-6.9078 * t / rt60).exp();
        }
        h
    }

    pub(crate) fn convolve(x: &[f32], h: &[f32]) -> Vec<f32> {
        let taps: Vec<(usize, f32)> = h.iter().copied().enumerate().filter(|(_, v)| v.abs() > 1e-6).collect();
        let mut y = vec![0.0f32; x.len()];
        for (n, yn) in y.iter_mut().enumerate() {
            let mut acc = 0.0;
            for &(k, hk) in &taps {
                if k <= n {
                    acc += hk * x[n - k];
                }
            }
            *yn = acc;
        }
        y
    }

    struct Scene {
        far: Vec<f32>,
        mic: Vec<f32>,
    }

    /// Far end only: the mic hears the echo plus -60 dBFS noise.
    fn scene(seconds: f32) -> Scene {
        let far = synthetic_speech(seconds, 7);
        let echo = convolve(&far, &echo_path(60.0, 0.25, 11));
        let mut rng = Rng::new(3);
        let mic = echo.iter().map(|e| e + 0.001 * rng.gauss()).collect();
        Scene { far, mic }
    }

    struct Run {
        out: Vec<f32>,
        metrics: Vec<AecMetrics>,
    }

    fn run(c: &mut dyn EchoCanceller, s: &Scene) -> Run {
        let frames = s.mic.len() / AEC_FRAME;
        let mut out = vec![0.0f32; frames * AEC_FRAME];
        let mut metrics = Vec::with_capacity(frames);
        let (mut r, mut m, mut o) = ([0.0; AEC_FRAME], [0.0; AEC_FRAME], [0.0; AEC_FRAME]);
        for f in 0..frames {
            let span = f * AEC_FRAME..(f + 1) * AEC_FRAME;
            r.copy_from_slice(&s.far[span.clone()]);
            m.copy_from_slice(&s.mic[span.clone()]);
            c.render(&r);
            metrics.push(c.capture(&m, &mut o));
            out[span].copy_from_slice(&o);
        }
        Run { out, metrics }
    }

    /// True ERLE (mic power over output power) from `from_s` to the end.
    fn erle_from(s: &Scene, r: &Run, from_s: f32) -> f64 {
        let a = (from_s * SAMPLE_RATE as f32) as usize;
        let b = r.out.len();
        10.0 * (power(&s.mic[a..b]) / power(&r.out[a..b]).max(1e-20)).log10()
    }

    fn first_converged_s(r: &Run) -> Option<f32> {
        r.metrics.iter().position(|m| m.converged).map(|f| f as f32 * AEC_FRAME as f32 / SAMPLE_RATE as f32)
    }

    #[test]
    fn the_capture_tuning_is_pinned() {
        // chat-voice.md §3.5 item 1 and 2 (S1b's `aec3softer` + num_filters 10).
        // Changing any of these needs a new S1b-style evaluation first.
        let cfg = capture_aec3_config();
        let dnd = &cfg.suppressor.dominant_nearend_detection;
        assert_eq!(dnd.snr_threshold, 10.0);
        assert_eq!(dnd.trigger_threshold, 5);
        let softer = Tuning {
            mask_lf: MaskingThresholds { enr_transparent: 2.0, enr_suppress: 4.0, emr_transparent: 0.3 },
            mask_hf: MaskingThresholds { enr_transparent: 0.5, enr_suppress: 1.5, emr_transparent: 0.3 },
            max_inc_factor: 2.0,
            max_dec_factor_lf: 0.25,
        };
        assert_eq!(cfg.suppressor.normal_tuning, softer);
        assert_eq!(cfg.suppressor.nearend_tuning, softer);
        assert!(cfg.transparent_mode.enabled, "transparent mode keeps headphones harmless");
        assert_eq!(cfg.delay.num_filters, 10);

        // Everything else is the crate's stock config.
        let stock = EchoCanceller3Config::default();
        let mut rest = cfg.clone();
        rest.delay.num_filters = stock.delay.num_filters;
        rest.suppressor.dominant_nearend_detection = stock.suppressor.dominant_nearend_detection.clone();
        rest.suppressor.normal_tuning = stock.suppressor.normal_tuning.clone();
        rest.suppressor.nearend_tuning = stock.suppressor.nearend_tuning.clone();
        assert_eq!(rest, stock, "only the pinned fields differ from stock");
        // The stock values the voice session keeps, for contrast.
        assert_eq!(stock.suppressor.dominant_nearend_detection.snr_threshold, 30.0);
        assert_eq!(stock.suppressor.dominant_nearend_detection.trigger_threshold, 12);
        assert_eq!(stock.delay.num_filters, 5);
        assert!(stock.transparent_mode.enabled);
    }

    #[test]
    fn the_capture_tuning_cancels_and_reports_erl() {
        let s = scene(12.0);
        let mut c = Aec3Canceller::with_tuning(AecTuning::Capture).unwrap();
        let r = run(&mut c, &s);
        let erle = erle_from(&s, &r, 3.0);
        let last = *r.metrics.last().unwrap();
        eprintln!("aec3 capture tuning: true ERLE after 3 s {erle:.1} dB, last {last:?}");
        assert!(erle > 15.0, "true ERLE after 3 s is {erle:.1} dB");
        assert!(last.erl_db.is_some(), "ERL is exported");
    }

    #[test]
    fn gate_needs_one_second_above_six_db() {
        let mut g = ConvergenceGate::default();
        for _ in 0..CONVERGED_HOLD_FRAMES - 1 {
            assert!(!g.update(Some(9.0)));
        }
        assert!(g.update(Some(6.0)), "the 100th frame at >= 6 dB converges");
        assert!(g.update(Some(12.0)));
        assert!(!g.update(Some(5.9)), "one frame below drops it");
        assert!(!g.update(Some(20.0)));
        assert!(!g.update(None), "no measurement counts as below");
        for _ in 0..CONVERGED_HOLD_FRAMES {
            g.update(Some(7.0));
        }
        assert!(g.converged());
    }

    #[test]
    fn cancels_a_synthetic_echo_and_converges() {
        let s = scene(12.0);
        let mut c = Aec3Canceller::new().unwrap();
        let r = run(&mut c, &s);
        let erle = erle_from(&s, &r, 3.0);
        let converged_at = first_converged_s(&r);
        let last = *r.metrics.last().unwrap();
        eprintln!("aec3: true ERLE after 3 s {erle:.1} dB, converged at {converged_at:?} s, last {last:?}");
        assert!(erle > 15.0, "true ERLE after 3 s is {erle:.1} dB");
        assert!(converged_at.is_some(), "converged never flipped true");
        assert!(last.erle_db.is_some() && last.delay_ms.is_some());
        assert!(converged_at.unwrap() >= 1.0, "needs 1 s of ERLE >= 6 dB first");
    }

    #[test]
    fn passthrough_never_converges_on_the_same_scene() {
        let s = scene(4.0);
        let r = run(&mut PassthroughCanceller, &s);
        assert!(r.metrics.iter().all(|m| !m.converged));
        assert!(erle_from(&s, &r, 0.0).abs() < 1e-6, "passthrough removes nothing");
    }

    #[test]
    fn reset_forgets_convergence_and_reconverges() {
        let s = scene(12.0);
        let mut c = Aec3Canceller::new().unwrap();
        let r = run(&mut c, &s);
        assert!(r.metrics.last().unwrap().converged);

        c.reset();
        let mut o = [0.0; AEC_FRAME];
        c.render(&[0.0; AEC_FRAME]);
        let m = c.capture(&[0.0; AEC_FRAME], &mut o);
        assert!(!m.converged, "converged right after reset: {m:?}");

        let again = run(&mut c, &s);
        let erle = erle_from(&s, &again, 3.0);
        assert!(erle > 15.0, "true ERLE after reset + 3 s is {erle:.1} dB");
        assert!(first_converged_s(&again).is_some());
    }

    #[test]
    fn missing_reference_frames_do_not_stall_capture() {
        // Capture frames with no render at all still come out, one per call.
        let mut c = Aec3Canceller::new().unwrap();
        let mut rng = Rng::new(5);
        let mut frame = [0.0f32; AEC_FRAME];
        let mut out = [0.0f32; AEC_FRAME];
        let mut energy = 0.0f64;
        for _ in 0..200 {
            frame.iter_mut().for_each(|v| *v = 0.05 * rng.gauss());
            c.capture(&frame, &mut out);
            energy += power(&out);
        }
        assert!(energy > 0.0, "the near end passes through when there's no far end");
    }
}
