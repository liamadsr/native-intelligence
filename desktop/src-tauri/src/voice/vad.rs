//! Voice activity detection on the cleaned 16 kHz mic
//! (dial8-website/docs/plans/chat-voice.md §3.3a).
//!
//! A detector may be `!Send`: the voice session builds it on its DSP thread
//! and keeps it there. [`new_vad`] is Silero (on the ONNX Runtime local-tts
//! ships), falling back to earshot when ONNX Runtime or the model can't be
//! loaded; conversation mode needs it to be `Ok`.

use super::earshot_vad::EarshotVad;
use super::silero::SileroVad;

pub trait Vad {
    /// Samples at 16 kHz per call (Silero: 512).
    fn frame_len(&self) -> usize;
    /// Speech probability 0..1.
    fn process(&mut self, frame: &[f32]) -> f32;
    fn reset(&mut self);
}

/// Silero v6.2.3 16k op15 via ort load-dynamic against the bundled ORT
/// 1.23.2, falling back to earshot 1.2.2. Conversation mode needs Ok.
pub fn new_vad() -> Result<Box<dyn Vad>, String> {
    choose(SileroVad::new())
}

/// Silero when it built, else earshot, else both reasons.
fn choose(silero: Result<SileroVad, String>) -> Result<Box<dyn Vad>, String> {
    let silero_err = match silero {
        Ok(vad) => return Ok(Box::new(vad)),
        Err(e) => e,
    };
    match EarshotVad::new() {
        Ok(vad) => {
            eprintln!("[vad] Silero unavailable ({silero_err}); using earshot");
            Ok(Box::new(vad))
        }
        Err(e) => Err(format!("no VAD: Silero: {silero_err}; earshot: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::super::ort_runtime::{self, tests::test_runtime};
    use super::*;
    use std::path::Path;

    #[test]
    fn a_bogus_dylib_path_falls_back_to_earshot() {
        let runtime = ort_runtime::load(Path::new("/nonexistent/Frameworks/libonnxruntime.1.23.2.dylib"));
        assert!(runtime.is_err());
        let vad = choose(SileroVad::new_with(runtime)).expect("earshot is always there");
        assert_eq!(vad.frame_len(), super::super::earshot_vad::FRAME);

        let tmp = tempfile::tempdir().unwrap();
        let fake = tmp.path().join("libonnxruntime.1.23.2.dylib");
        std::fs::write(&fake, b"not a dylib").unwrap();
        let vad = choose(SileroVad::new_with(ort_runtime::load(&fake))).unwrap();
        assert_eq!(vad.frame_len(), 256);
    }

    #[test]
    fn new_vad_is_silero_when_onnx_runtime_loads() {
        let Some(_) = test_runtime() else { return };
        let mut vad = new_vad().unwrap();
        assert_eq!(vad.frame_len(), 512);
        assert!(vad.process(&[0.0; 512]) < 0.1);
    }
}
