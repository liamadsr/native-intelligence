//! Speech played faster or slower at the same pitch (Liam, 2026-10-22: a speed
//! setting from 0.5× to 4×). Pocket TTS has no speed of its own, so the speech
//! player stretches each sentence's audio between the sidecar and the
//! resampler (modules/tts.rs).
//!
//! WSOLA (waveform-similarity overlap-add): Hann-windowed frames of 30 ms are
//! taken from the input every `hop × rate` samples and overlap-added every
//! `hop` samples (50% overlap, so the windows sum to one). Each frame is
//! nudged up to 10 ms either way to where the waveform best continues the
//! previous one, so pitch periods line up and the voice stays clean. Speech
//! loses or repeats whole pitch periods, never its pitch.
//!
//! 1× is a passthrough: the samples go out untouched.

/// Slowest and fastest rates the setting offers.
pub const MIN_RATE: f32 = 0.5;
pub const MAX_RATE: f32 = 4.0;

/// A rate within [`MIN_RATE`, `MAX_RATE`]; anything not a number is 1×.
pub fn clamp_rate(rate: f32) -> f32 {
    if rate.is_finite() {
        rate.clamp(MIN_RATE, MAX_RATE)
    } else {
        1.0
    }
}

pub struct TimeStretch {
    /// Frame length (30 ms).
    frame: usize,
    /// Output hop: half a frame.
    hop: usize,
    /// How far a frame may move from its nominal place (10 ms).
    tolerance: usize,
    window: Vec<f32>,
    /// 1× for the current sentence: a passthrough.
    rate: f64,
    /// Input not yet consumed; `input[0]` is absolute sample `base`.
    input: Vec<f32>,
    base: usize,
    /// Input samples pushed this sentence.
    pushed: usize,
    /// Nominal absolute input position of the next frame.
    next: f64,
    /// Absolute start of the last frame taken, if any.
    previous: Option<usize>,
    /// The last frame's second half, still to be overlap-added.
    tail: Vec<f32>,
}

impl TimeStretch {
    pub fn new(sample_rate: u32) -> Self {
        let frame = ((sample_rate as usize * 30) / 1000).max(8) & !1;
        let hop = frame / 2;
        let window = (0..frame)
            .map(|n| (0.5 - 0.5 * (std::f64::consts::TAU * n as f64 / frame as f64).cos()) as f32)
            .collect();
        Self {
            frame,
            hop,
            tolerance: (sample_rate as usize * 10) / 1000,
            window,
            rate: 1.0,
            input: Vec::new(),
            base: 0,
            pushed: 0,
            next: 0.0,
            previous: None,
            tail: vec![0.0; hop],
        }
    }

    fn passthrough(&self) -> bool {
        (self.rate - 1.0).abs() < 1e-3
    }

    /// A new sentence at `rate` (clamped): drops whatever the last one left.
    pub fn begin(&mut self, rate: f32) {
        self.rate = clamp_rate(rate) as f64;
        self.input.clear();
        self.base = 0;
        self.pushed = 0;
        self.next = 0.0;
        self.previous = None;
        self.tail.iter_mut().for_each(|s| *s = 0.0);
    }

    /// Stretches `samples`, appending what is ready to `out`.
    pub fn push(&mut self, samples: &[f32], out: &mut Vec<f32>) {
        if self.passthrough() {
            out.extend_from_slice(samples);
            return;
        }
        self.input.extend_from_slice(samples);
        self.pushed += samples.len();
        self.run(out, false);
    }

    /// The sentence's end: flushes the rest into `out`.
    pub fn finish(&mut self, out: &mut Vec<f32>) {
        if self.passthrough() {
            return;
        }
        self.run(out, true);
        // A sentence with no audio stays silent: no tail, so nothing plays
        // and nothing says it is speaking.
        if self.previous.is_some() {
            out.extend_from_slice(&self.tail);
        }
        self.tail.iter_mut().for_each(|s| *s = 0.0);
        self.input.clear();
    }

    fn run(&mut self, out: &mut Vec<f32>, flushing: bool) {
        let analysis_hop = self.hop as f64 * self.rate;
        loop {
            let nominal = self.next.round() as usize;
            if flushing && nominal >= self.pushed {
                break;
            }
            // Input needed for this frame: the search window around the
            // nominal place, and the previous frame's natural continuation.
            let continuation = self.previous.map(|p| p + self.hop);
            let mut need = nominal + self.tolerance + self.frame;
            if let Some(c) = continuation {
                need = need.max(c + self.frame);
            }
            let have = self.base + self.input.len();
            if need > have {
                if !flushing {
                    break;
                }
                // At the end: silence after the last sample.
                self.input.resize(need - self.base, 0.0);
            }

            let start = match continuation {
                None => nominal,
                Some(c) => self.best_start(nominal, c),
            };
            let at = start - self.base;
            // The first frame has nothing to overlap: its first half goes out
            // at full level, so a sentence's first word keeps its attack.
            let first = self.previous.is_none();
            for k in 0..self.hop {
                let rising = if first { 1.0 } else { self.window[k] };
                out.push(self.tail[k] + self.input[at + k] * rising);
            }
            for k in 0..self.hop {
                self.tail[k] = self.input[at + self.hop + k] * self.window[self.hop + k];
            }
            self.previous = Some(start);
            self.next += analysis_hop;

            // Forget input no later frame can reach.
            let keep_from = (self.next.round() as usize)
                .saturating_sub(self.tolerance)
                .min(start + self.hop)
                .max(self.base);
            let drop = keep_from - self.base;
            if drop > 0 {
                self.input.drain(..drop);
                self.base = keep_from;
            }
        }
    }

    /// The frame start within `tolerance` of `nominal` whose first half best
    /// matches the samples that would naturally follow the previous frame.
    fn best_start(&self, nominal: usize, continuation: usize) -> usize {
        let lo = nominal.saturating_sub(self.tolerance).max(self.base);
        let hi = nominal + self.tolerance;
        let target = &self.input[continuation - self.base..continuation - self.base + self.hop];
        let mut best = nominal.max(lo);
        let mut best_score = f32::NEG_INFINITY;
        // Every other sample: half the work, and a 1-sample step adds nothing
        // audible at 24 kHz.
        let mut candidate = lo;
        while candidate <= hi {
            let segment = &self.input[candidate - self.base..candidate - self.base + self.hop];
            let mut dot = 0.0f32;
            let mut energy = 1e-9f32;
            for (a, b) in segment.iter().zip(target) {
                dot += a * b;
                energy += a * a;
            }
            let score = dot / energy.sqrt();
            if score > best_score {
                best_score = score;
                best = candidate;
            }
            candidate += 2;
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 24_000;

    fn tone(freq: f32, seconds: f32) -> Vec<f32> {
        let n = (SR as f32 * seconds) as usize;
        (0..n).map(|i| 0.5 * (std::f32::consts::TAU * freq * i as f32 / SR as f32).sin()).collect()
    }

    /// Stretch `input` at `rate`, pushed in uneven chunks like the sidecar's.
    fn stretch(input: &[f32], rate: f32) -> Vec<f32> {
        let mut ts = TimeStretch::new(SR);
        ts.begin(rate);
        let mut out = Vec::new();
        for chunk in input.chunks(1_917) {
            ts.push(chunk, &mut out);
        }
        ts.finish(&mut out);
        out
    }

    /// Rising zero crossings per second over the middle of `x`: its pitch.
    fn pitch(x: &[f32]) -> f32 {
        let mid = &x[x.len() / 4..x.len() * 3 / 4];
        let rises = mid.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        rises as f32 / (mid.len() as f32 / SR as f32)
    }

    #[test]
    fn one_x_is_a_passthrough() {
        let input = tone(220.0, 0.5);
        assert_eq!(stretch(&input, 1.0), input);
    }

    #[test]
    fn length_follows_the_rate_and_pitch_stays() {
        let input = tone(200.0, 2.0);
        for rate in [0.5f32, 0.75, 1.25, 1.5, 2.0, 3.0, 4.0] {
            let out = stretch(&input, rate);
            let expected = input.len() as f32 / rate;
            let ratio = out.len() as f32 / expected;
            assert!((0.95..1.06).contains(&ratio), "rate {rate}: {} samples for {expected}", out.len());
            let p = pitch(&out);
            assert!((p - 200.0).abs() < 6.0, "rate {rate}: pitch {p} Hz");
            assert!(out.iter().all(|s| s.is_finite() && s.abs() <= 1.0), "rate {rate}: bad sample");
        }
    }

    #[test]
    fn a_steady_tone_keeps_its_level() {
        let input = tone(180.0, 1.0);
        for rate in [0.5f32, 2.0, 4.0] {
            let out = stretch(&input, rate);
            let mid = &out[out.len() / 4..out.len() * 3 / 4];
            let rms = (mid.iter().map(|s| s * s).sum::<f32>() / mid.len() as f32).sqrt();
            assert!((rms - 0.354).abs() < 0.04, "rate {rate}: rms {rms}");
        }
    }

    #[test]
    fn begin_forgets_the_last_sentence() {
        let mut ts = TimeStretch::new(SR);
        let mut out = Vec::new();
        ts.begin(2.0);
        ts.push(&tone(300.0, 0.3), &mut out);
        // Cancelled mid-sentence: the next one starts clean, at its own rate.
        ts.begin(1.0);
        out.clear();
        let next = tone(150.0, 0.2);
        ts.push(&next, &mut out);
        ts.finish(&mut out);
        assert_eq!(out, next);
    }

    #[test]
    fn a_sentence_with_no_audio_stays_silent() {
        for rate in [0.5f32, 2.0, 4.0] {
            assert!(stretch(&[], rate).is_empty(), "rate {rate}");
        }
    }

    #[test]
    fn the_first_word_keeps_its_attack() {
        let input = tone(220.0, 0.5);
        for rate in [0.5f32, 2.0, 4.0] {
            let out = stretch(&input, rate);
            let first_5ms = &out[..120];
            let rms = (first_5ms.iter().map(|s| s * s).sum::<f32>() / 120.0).sqrt();
            assert!(rms > 0.3, "rate {rate}: first 5 ms at rms {rms}, faded in");
        }
    }

    #[test]
    fn short_and_empty_sentences() {
        assert!(stretch(&[], 2.0).len() <= 400);
        let blip = tone(400.0, 0.01);
        let out = stretch(&blip, 4.0);
        assert!(out.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn rates_are_clamped() {
        assert_eq!(clamp_rate(10.0), MAX_RATE);
        assert_eq!(clamp_rate(0.1), MIN_RATE);
        assert_eq!(clamp_rate(f32::NAN), 1.0);
        assert_eq!(clamp_rate(1.5), 1.5);
    }
}
