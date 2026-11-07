//! earshot 1.2.2 (pure Rust, MIT OR Apache-2.0): the VAD when ONNX Runtime
//! can't be loaded (dial8-website/docs/plans/chat-voice.md §3.3a).
//!
//! 256-sample frames (16 ms at 16 kHz) — half of Silero's, so the caller asks
//! [`Vad::frame_len`]. In the S2 bake-off its probabilities worked with the
//! same turn thresholds as Silero's (onset 0.5, off 0.35, barge-in 0.65); its
//! useful threshold window is 0.4–0.6 and its noise floor 0.2–0.3, a little
//! higher than Silero's.
//!
//! Samples are clamped to [-1, 1] on the way in (earshot asserts it in debug
//! builds; the canceller's output can overshoot slightly).

use super::vad::Vad;

/// Samples per call (16 ms at 16 kHz).
pub const FRAME: usize = 256;

pub struct EarshotVad {
    detector: Box<earshot::Detector>,
    frame: [f32; FRAME],
}

impl EarshotVad {
    pub fn new() -> Result<Self, String> {
        Ok(Self { detector: earshot::Detector::default_boxed(), frame: [0.0; FRAME] })
    }
}

impl Vad for EarshotVad {
    fn frame_len(&self) -> usize {
        FRAME
    }

    fn process(&mut self, frame: &[f32]) -> f32 {
        if frame.len() != FRAME {
            return 0.0; // not an earshot frame: refused, the stream untouched
        }
        for (d, s) in self.frame.iter_mut().zip(frame) {
            *d = if s.is_finite() { s.clamp(-1.0, 1.0) } else { 0.0 };
        }
        let p = self.detector.predict_f32(&self.frame);
        if p.is_finite() {
            p.clamp(0.0, 1.0)
        } else {
            0.0
        }
    }

    fn reset(&mut self) {
        self.detector.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::aec3_canceller::tests::{synthetic_speech, Rng};

    #[test]
    fn framing() {
        let mut vad = EarshotVad::new().unwrap();
        assert_eq!(vad.frame_len(), 256);
        let p = vad.process(&[0.0; FRAME]);
        assert!((0.0..=1.0).contains(&p));
        // Out-of-range and non-finite samples are tamed, not asserted on.
        let mut loud = [1.7f32; FRAME];
        loud[3] = f32::NAN;
        loud[4] = -3.0;
        assert!((0.0..=1.0).contains(&vad.process(&loud)));
        assert_eq!(vad.process(&[0.1; 512]), 0.0, "a Silero-sized frame is refused");
    }

    #[test]
    fn silence_is_not_speech_and_reset_restarts_the_stream() {
        let mut vad = EarshotVad::new().unwrap();
        let silent: Vec<f32> = (0..60).map(|_| vad.process(&[0.0; FRAME])).collect();
        assert!(silent.iter().all(|&p| p < 0.3), "silence: {silent:?}");
        let mut rng = Rng::new(4);
        for _ in 0..40 {
            let f: Vec<f32> = (0..FRAME).map(|_| 0.001 * rng.gauss()).collect();
            assert!(vad.process(&f) < 0.35, "-60 dBFS noise");
        }

        let speech = synthetic_speech(1.0, 8);
        let mut fresh = EarshotVad::new().unwrap();
        let first: Vec<f32> = speech.as_chunks::<FRAME>().0.iter().map(|f| fresh.process(f)).collect();
        vad.reset();
        let again: Vec<f32> = speech.as_chunks::<FRAME>().0.iter().map(|f| vad.process(f)).collect();
        assert_eq!(first, again, "after reset the detector behaves like a new one");
    }
}
