//! Silero VAD v6.2.3, the 16 kHz opset-15 model, on ONNX Runtime
//! (web/docs/plans/chat-voice.md §3.3a; picked by the S2 bake-off).
//!
//! The model (1.3 MB, MIT, `resources/vad/`, see its UPSTREAM.md) is built
//! into the executable and handed to ONNX Runtime from memory; ONNX Runtime is
//! the dylib local-tts ships ([`super::ort_runtime`]).
//!
//! Per call: 512 new samples (32 ms at 16 kHz), preceded by the last 64
//! samples of the previous call as context (the model's input is 576
//! samples), plus the recurrent state `[2, 1, 128]` carried from call to call
//! and the sample rate as an int64 scalar. Output: one speech probability.
//!
//! **Not `Send`** by contract (the trait allows `!Send`): the voice session
//! builds it on its DSP thread and keeps it there. Each call allocates the
//! session's output tensors; run it on a DSP thread, never in an audio callback.

use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::TensorRef;

use super::vad::Vad;

/// The model, verified against resources/vad/UPSTREAM.md's SHA-256 in a test.
pub(crate) static MODEL: &[u8] = include_bytes!("../../resources/vad/silero_vad_16k_op15.onnx");

/// New samples per call (32 ms at 16 kHz).
pub const FRAME: usize = 512;
/// Samples of the previous call prepended as context.
pub const CONTEXT: usize = 64;
const STATE_LEN: usize = 2 * 128;
const SAMPLE_RATE: i64 = 16_000;

pub struct SileroVad {
    session: Session,
    /// [context (64) | this frame (512)]
    input: [f32; CONTEXT + FRAME],
    state: [f32; STATE_LEN],
    sr: [i64; 1],
    /// An inference error has been logged (one line per detector).
    logged_error: bool,
}

impl SileroVad {
    /// Loads ONNX Runtime (once per process) and the model.
    pub fn new() -> Result<Self, String> {
        Self::new_with(super::ort_runtime::init().map(|_| ()))
    }

    /// The model on a runtime whose loading came out as `runtime`; an `Err`
    /// there is returned as is (ONNX Runtime isn't touched).
    pub fn new_with(runtime: Result<(), String>) -> Result<Self, String> {
        runtime?;
        let built = std::panic::catch_unwind(|| -> Result<Session, String> {
            let e = |e: ort::Error<_>| format!("silero: {e}");
            Session::builder()
                .map_err(|e| format!("silero: {e}"))?
                .with_optimization_level(GraphOptimizationLevel::Level3)
                .map_err(e)?
                .with_intra_threads(1)
                .map_err(e)?
                .with_inter_threads(1)
                .map_err(e)?
                .commit_from_memory(MODEL)
                .map_err(|e| format!("silero: {e}"))
        });
        let session = built.map_err(|_| "silero: ONNX Runtime panicked while building the session".to_string())??;
        Ok(Self { session, input: [0.0; CONTEXT + FRAME], state: [0.0; STATE_LEN], sr: [SAMPLE_RATE], logged_error: false })
    }

    fn infer(&mut self) -> Result<f32, ort::Error> {
        let input = TensorRef::from_array_view(([1usize, CONTEXT + FRAME], &self.input[..]))?;
        let state = TensorRef::from_array_view(([2usize, 1, 128], &self.state[..]))?;
        let sr = TensorRef::from_array_view(([0usize; 0], &self.sr[..]))?;
        let outputs = self.session.run(ort::inputs!["input" => input, "state" => state, "sr" => sr])?;
        let (_, prob) = outputs["output"].try_extract_tensor::<f32>()?;
        let prob = prob.first().copied().unwrap_or(0.0);
        let (_, next) = outputs["stateN"].try_extract_tensor::<f32>()?;
        if next.len() == STATE_LEN {
            self.state.copy_from_slice(next);
        }
        Ok(prob)
    }
}

impl Vad for SileroVad {
    fn frame_len(&self) -> usize {
        FRAME
    }

    fn process(&mut self, frame: &[f32]) -> f32 {
        if frame.len() != FRAME {
            return 0.0; // not a Silero frame: refused, the stream untouched
        }
        // The last 64 samples of the previous frame become this frame's context.
        self.input.copy_within(FRAME.., 0);
        self.input[CONTEXT..].copy_from_slice(frame);
        match self.infer() {
            Ok(p) if p.is_finite() => p.clamp(0.0, 1.0),
            Ok(_) => 0.0,
            Err(e) => {
                if !self.logged_error {
                    self.logged_error = true;
                    eprintln!("[vad] silero inference failed: {e} (reporting silence; further errors not logged)");
                }
                0.0
            }
        }
    }

    fn reset(&mut self) {
        self.input = [0.0; CONTEXT + FRAME];
        self.state = [0.0; STATE_LEN];
    }
}

#[cfg(test)]
mod tests {
    use super::super::ort_runtime::tests::test_runtime;
    use super::*;
    use crate::audio::aec3_canceller::tests::{synthetic_speech, Rng};
    use sha2::{Digest, Sha256};

    fn upstream_field(name: &str) -> String {
        let md = include_str!("../../resources/vad/UPSTREAM.md");
        let line = md.lines().find(|l| l.starts_with(&format!("- {name}: "))).unwrap_or_else(|| panic!("UPSTREAM.md has no '- {name}: ' line"));
        line.split_once(": ").unwrap().1.trim().trim_matches('`').to_string()
    }

    #[test]
    fn the_bundled_model_is_the_pinned_one() {
        let sha: String = Sha256::digest(MODEL).iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(sha, upstream_field("SHA-256"));
        assert_eq!(MODEL.len().to_string(), upstream_field("Size (bytes)"));
    }

    #[test]
    fn a_failed_runtime_is_passed_through() {
        let err = SileroVad::new_with(Err("no runtime".into())).err().unwrap();
        assert_eq!(err, "no runtime");
    }

    #[test]
    fn framing_and_context_carry_over() {
        let Some(_) = test_runtime() else { return };
        let mut vad = SileroVad::new().unwrap();
        assert_eq!(vad.frame_len(), 512);
        let a: Vec<f32> = (0..FRAME).map(|i| i as f32 / 1e4).collect();
        let b: Vec<f32> = (0..FRAME).map(|i| -(i as f32) / 1e4).collect();
        vad.process(&a);
        assert_eq!(&vad.input[..CONTEXT], &[0.0; CONTEXT], "the first frame has zero context");
        assert_eq!(&vad.input[CONTEXT..], &a[..]);
        vad.process(&b);
        assert_eq!(&vad.input[..CONTEXT], &a[FRAME - CONTEXT..], "context = the previous frame's last 64 samples");
        assert_eq!(&vad.input[CONTEXT..], &b[..]);
        // A wrong frame length is refused without touching the stream.
        let before = vad.input;
        assert_eq!(vad.process(&a[..100]), 0.0);
        assert_eq!(vad.input, before);
    }

    #[test]
    fn state_carries_over_and_reset_clears_it() {
        let Some(_) = test_runtime() else { return };
        let mut vad = SileroVad::new().unwrap();
        let speech = synthetic_speech(2.0, 21);
        let probs: Vec<f32> = speech.as_chunks::<FRAME>().0.iter().map(|f| vad.process(f)).collect();
        assert!(vad.state.iter().any(|&s| s != 0.0), "the recurrent state was updated");
        assert!(probs.iter().all(|p| (0.0..=1.0).contains(p)));

        // Same audio, same state → same answer; a reset stream gives the first answer again.
        let first = {
            let mut fresh = SileroVad::new().unwrap();
            fresh.process(&speech[..FRAME])
        };
        vad.reset();
        assert_eq!(vad.state, [0.0; STATE_LEN]);
        assert_eq!(vad.input, [0.0; CONTEXT + FRAME]);
        assert_eq!(vad.process(&speech[..FRAME]), first);
        // With the state carried, the same frame later in a stream scores differently.
        let mut carried = SileroVad::new().unwrap();
        for f in speech.as_chunks::<FRAME>().0.iter().take(20) {
            carried.process(f);
        }
        assert_ne!(carried.process(&speech[..FRAME]), first);
    }

    #[test]
    fn silence_and_faint_noise_are_not_speech() {
        let Some(_) = test_runtime() else { return };
        let mut vad = SileroVad::new().unwrap();
        let silent: Vec<f32> = (0..30).map(|_| vad.process(&[0.0; FRAME])).collect();
        assert!(silent.iter().all(|&p| p < 0.1), "silence: {silent:?}");
        let mut rng = Rng::new(9);
        let noise: Vec<f32> = (0..30)
            .map(|_| {
                let f: Vec<f32> = (0..FRAME).map(|_| 0.001 * rng.gauss()).collect(); // -60 dBFS
                vad.process(&f)
            })
            .collect();
        // The first frame after the silence scores ~0.2 (a transient); it never
        // gets near the 0.5 onset, and settles near zero.
        assert!(noise.iter().all(|&p| p < 0.35), "faint noise: {noise:?}");
        let mut sorted = noise.clone();
        sorted.sort_by(f32::total_cmp);
        assert!(sorted[sorted.len() / 2] < 0.1, "faint noise median: {noise:?}");
    }

    /// Real speech: ~/code/speech-audio-bench/interview.wav against its
    /// Deepgram word timings. Run with `cargo test --lib -- --ignored silero`.
    #[test]
    #[ignore]
    fn detects_speech_in_the_interview_bench() {
        let Some(_) = test_runtime() else { return };
        let home = std::env::var("HOME").unwrap();
        let wav = Path::new(&home).join("code/speech-audio-bench/interview.wav");
        let json = Path::new(&home).join("code/speech-audio-bench/interview.deepgram.json");
        if !wav.is_file() || !json.is_file() {
            eprintln!("skipping: {} not present", wav.display());
            return;
        }
        let audio = read_mono_16k(&wav);
        let words = word_spans(&json);
        let mut vad = SileroVad::new().unwrap();
        let (mut in_words, mut hits, mut flagged, mut flagged_outside) = (0usize, 0usize, 0usize, 0usize);
        for (i, f) in audio.as_chunks::<FRAME>().0.iter().enumerate() {
            let p = vad.process(f);
            let t = (i * FRAME + FRAME / 2) as f64 / 16_000.0;
            let inside = words.iter().any(|&(s, e)| t >= s && t <= e);
            let near = words.iter().any(|&(s, e)| t >= s - 0.3 && t <= e + 0.3);
            if inside {
                in_words += 1;
                hits += (p >= 0.5) as usize;
            }
            if p >= 0.5 {
                flagged += 1;
                flagged_outside += (!near) as usize;
            }
        }
        let recall = hits as f64 / in_words.max(1) as f64;
        let outside = flagged_outside as f64 / flagged.max(1) as f64;
        eprintln!("silero on interview.wav: recall in words {recall:.3}, speech frames far from any word {outside:.3}");
        assert!(recall > 0.8, "recall {recall:.3}");
        assert!(outside < 0.1, "{outside:.3} of speech frames are > 300 ms from any word");
    }

    use std::path::Path;

    /// A WAV file as 16 kHz mono f32 (channels averaged, resampled).
    pub(crate) fn read_mono_16k(path: &Path) -> Vec<f32> {
        let mut r = hound::WavReader::open(path).unwrap();
        let spec = r.spec();
        let ch = spec.channels as usize;
        let interleaved: Vec<f32> = match spec.sample_format {
            hound::SampleFormat::Float => r.samples::<f32>().map(|s| s.unwrap()).collect(),
            hound::SampleFormat::Int => {
                let scale = (1i64 << (spec.bits_per_sample - 1)) as f32;
                r.samples::<i32>().map(|s| s.unwrap() as f32 / scale).collect()
            }
        };
        let mono: Vec<f32> = interleaved.chunks_exact(ch).map(|c| c.iter().sum::<f32>() / ch as f32).collect();
        let mut rs = crate::audio::resample::StreamResampler::new(spec.sample_rate, 16_000).unwrap();
        let mut out = Vec::with_capacity(mono.len() * 16_000 / spec.sample_rate as usize + 1024);
        for chunk in mono.chunks(4096) {
            out.reserve(rs.max_output_frames(chunk.len()));
            rs.process(chunk, &mut out);
        }
        rs.flush(&mut out);
        out
    }

    /// (start, end) seconds of every word in a Deepgram response.
    pub(crate) fn word_spans(path: &Path) -> Vec<(f64, f64)> {
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        v["results"]["channels"][0]["alternatives"][0]["words"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| (w["start"].as_f64().unwrap(), w["end"].as_f64().unwrap()))
            .collect()
    }
}
