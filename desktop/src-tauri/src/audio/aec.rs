//! Acoustic echo cancellation: the shared `audio::aec` component
//! (dial8-website/docs/plans/chat-voice.md §3.3a).
//!
//! The voice session runs it on 10 ms frames of 16 kHz mono: every far-end
//! (render) frame that has arrived goes in through [`EchoCanceller::render`]
//! before the capture frame it precedes goes through
//! [`EchoCanceller::capture`]. The canceller's own delay estimator absorbs the
//! offset between the two device streams, so nothing is buffered on the
//! reference path.
//!
//! A canceller may be `!Send`: its user builds it on the thread that runs it
//! (the voice session's DSP thread) and keeps it there.
//!
//! [`new_echo_canceller`] is the real canceller: `aec3` (WebRTC AEC3 in pure
//! Rust, HPF on, NS off; see [`super::aec3_canceller`]). If it can't be built
//! the voice session falls back to [`PassthroughCanceller`], which never
//! converges, so barge-in on speakers is half-duplex.
//!
//! Two tunings ([`AecTuning`]): the voice session keeps aec3's stock
//! suppressor ([`AecTuning::Voice`], the default of [`new_echo_canceller`]);
//! meeting captures use the softer one S1b picked ([`AecTuning::Capture`],
//! chat-voice.md §3.5), built with [`new_echo_canceller_tuned`].

/// Samples per frame: 10 ms at 16 kHz mono f32.
pub const AEC_FRAME: usize = 160;

/// How the canceller is doing, reported for every capture frame.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct AecMetrics {
    /// Echo return loss enhancement, when the canceller measures it.
    pub erle_db: Option<f32>,
    /// The render → capture delay the canceller has locked onto.
    pub delay_ms: Option<i32>,
    /// Echo return loss (how much quieter the echo is than the reference), when
    /// the canceller measures it. Negative with no acoustic echo path at all
    /// (headphones).
    pub erl_db: Option<f32>,
    /// The echo is being removed well enough to trust mic speech while the far
    /// end plays (ERLE ≥ 6 dB, held for 1 s).
    pub converged: bool,
}

pub trait EchoCanceller {
    /// Far-end: call for every reference frame that has arrived, before the
    /// capture frame.
    fn render(&mut self, frame: &[f32; AEC_FRAME]);
    fn capture(&mut self, frame: &[f32; AEC_FRAME], out: &mut [f32; AEC_FRAME]) -> AecMetrics;
    fn reset(&mut self);
}

/// Which aec3 setup to build (chat-voice.md §3.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AecTuning {
    /// The voice session: aec3's stock suppressor and delay search. Less
    /// residual echo means fewer false barge-ins, and double talk there ends
    /// within ~320 ms because barge-in stops the speech.
    #[default]
    Voice,
    /// Meeting captures: S1b's "softer" suppressor (it loses fewer of the
    /// user's words in double talk than the raw mic, where stock loses more)
    /// and a ~1 s delay search instead of ~0.5 s.
    Capture,
}

impl AecTuning {
    pub fn name(self) -> &'static str {
        match self {
            AecTuning::Voice => "voice (stock)",
            AecTuning::Capture => "capture (softer, num_filters=10)",
        }
    }
}

/// aec3 "=0.4.0" (HPF on, NS off), stock tuning ([`AecTuning::Voice`]).
/// `!Send`: build it on the thread that runs it.
pub fn new_echo_canceller() -> Result<Box<dyn EchoCanceller>, String> {
    new_echo_canceller_tuned(AecTuning::Voice)
}

/// aec3 with the given tuning. `!Send`: build it on the thread that runs it.
pub fn new_echo_canceller_tuned(tuning: AecTuning) -> Result<Box<dyn EchoCanceller>, String> {
    Ok(Box::new(super::aec3_canceller::Aec3Canceller::with_tuning(tuning)?))
}

/// Always available: out = in, converged = false (so barge-in on speakers is
/// half-duplex).
pub struct PassthroughCanceller;

impl EchoCanceller for PassthroughCanceller {
    fn render(&mut self, _frame: &[f32; AEC_FRAME]) {}

    fn capture(&mut self, frame: &[f32; AEC_FRAME], out: &mut [f32; AEC_FRAME]) -> AecMetrics {
        out.copy_from_slice(frame);
        AecMetrics::default()
    }

    fn reset(&mut self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_copies_and_never_converges() {
        let mut c = PassthroughCanceller;
        let mut frame = [0.0f32; AEC_FRAME];
        for (i, s) in frame.iter_mut().enumerate() {
            *s = i as f32 / AEC_FRAME as f32;
        }
        c.render(&[0.5; AEC_FRAME]);
        let mut out = [9.0f32; AEC_FRAME];
        let m = c.capture(&frame, &mut out);
        assert_eq!(out, frame);
        assert_eq!(m, AecMetrics { erle_db: None, delay_ms: None, erl_db: None, converged: false });
        c.reset();
    }

    #[test]
    fn the_real_canceller_builds() {
        let mut c = new_echo_canceller().expect("aec3 builds");
        let mut out = [1.0f32; AEC_FRAME];
        c.render(&[0.0; AEC_FRAME]);
        let m = c.capture(&[0.0; AEC_FRAME], &mut out);
        assert!(!m.converged);
        assert!(out.iter().all(|s| s.abs() < 1e-3), "silence in, silence out");
    }

    #[test]
    fn the_default_tuning_is_the_voice_one() {
        assert_eq!(AecTuning::default(), AecTuning::Voice);
        let mut c = new_echo_canceller_tuned(AecTuning::Capture).expect("the capture tuning builds");
        let mut out = [1.0f32; AEC_FRAME];
        c.render(&[0.0; AEC_FRAME]);
        c.capture(&[0.0; AEC_FRAME], &mut out);
        assert!(out.iter().all(|s| s.abs() < 1e-3));
    }
}
