//! The `voice://*` events (web/docs/plans/chat-voice.md §3.3).
//!
//! Every payload carries `sessionId`, in camelCase, field for field what the
//! web's `toVoiceEvent` (src/lib/tauri-bridge.ts) parses. They are broadcast
//! to every webview; the web drops other sessions' events.

use serde::Serialize;
use serde_json::Value;

pub const STATE: &str = "voice://state";
pub const TRANSCRIPT: &str = "voice://transcript";
pub const TURN: &str = "voice://turn";
pub const INTERRUPTED: &str = "voice://interrupted";
pub const LEVEL: &str = "voice://level";
pub const ENDED: &str = "voice://ended";
/// A candidate turn's audio (`voice_start { speechAudio: true }` only;
/// [`super::speech`]).
pub const SPEECH: &str = "voice://speech";

/// `voice://speech`'s closing `outcome`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeechOutcome {
    /// The run became a turn: this closes before its `voice://turn`.
    Turn,
    /// It ended without one (too short, nothing heard, the session ended).
    Abandoned,
}

/// One `voice://speech` chunk: `pcm` is base64 of 16-bit little-endian mono
/// samples of the cleaned 16 kHz audio local-stt hears, from `startMs` on
/// the session audio clock; `seq` counts from 0 per turn.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechChunkPayload<'a> {
    pub session_id: &'a str,
    pub turn_id: &'a str,
    pub seq: u32,
    pub start_ms: u64,
    pub sample_rate: u32,
    pub pcm: &'a str,
    /// Always false (the closing event is [`SpeechEndPayload`]).
    pub end: bool,
}

/// The closing `voice://speech` of a turn's audio (`seq`: the chunks sent).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechEndPayload<'a> {
    pub session_id: &'a str,
    pub turn_id: &'a str,
    pub seq: u32,
    /// Always true.
    pub end: bool,
    pub outcome: SpeechOutcome,
}

/// `voice://state` `state`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Starting,
    Listening,
    UserSpeaking,
    Processing,
    AgentSpeaking,
    Muted,
}

/// `voice://state` `echo`: how talking over the agent is handled right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EchoMode {
    /// The canceller has converged: barge-in works on speakers.
    Cancelling,
    /// The canceller runs but hasn't converged yet: no barge-in.
    Converging,
    /// No working canceller: mic speech is ignored while the agent speaks and
    /// the UI offers tap-to-interrupt.
    HalfDuplex,
    /// The output is worn on the head: barge-in works regardless.
    Headphones,
}

impl EchoMode {
    /// Barge-in by voice is allowed (§3.3a: only `cancelling` or `headphones`).
    pub fn allows_barge_in(self) -> bool {
        matches!(self, EchoMode::Cancelling | EchoMode::Headphones)
    }
}

/// `voice://state` `noiseMode`: the background-noise room the session runs
/// now. Under "Auto" it starts `quiet` and may switch to `noisy` when voices
/// in the background are heard (noise design WP7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NoiseMode {
    Quiet,
    Noisy,
}

/// `voice://ended` `reason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EndReason {
    Stopped,
    Cancelled,
    Recording,
    Page,
    Idle,
    Device,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatePayload<'a> {
    pub session_id: &'a str,
    pub state: SessionState,
    pub echo: EchoMode,
    /// local-stt reported Ready for this session and the DSP thread is up:
    /// the web's cue that the model is listening (its start sounds). Sent
    /// again when it flips under an unchanged `state` ([`ShownState`]), so it
    /// shows through `muted` and through speech that began while loading.
    /// `voice_status { readyFlag }` says it is there; older webs ignore it.
    pub ready: bool,
    /// The background-noise room running now ([`NoiseMode`]): sent again
    /// when Auto switches. Older webs ignore it.
    pub noise_mode: NoiseMode,
}

/// One `voice://state` as shown: the machine's state and echo mode, the
/// session's readiness and background-noise room.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Shown {
    pub state: SessionState,
    pub echo: EchoMode,
    pub ready: bool,
    pub noise_mode: NoiseMode,
}

/// What `voice://state` last showed. The machine's `Action::State` carries
/// the state and echo mode only (the replay goldens stay 0.2.45's); the
/// session adds `ready` and `noiseMode` here, and shows the state again when
/// either flips while the state and echo mode hold.
#[derive(Debug, Default)]
pub struct ShownState(Option<Shown>);

impl ShownState {
    /// A machine state event, shown with the session's readiness and room.
    pub fn state(&mut self, state: SessionState, echo: EchoMode, ready: bool, noise_mode: NoiseMode) -> Shown {
        let shown = Shown { state, echo, ready, noise_mode };
        self.0 = Some(shown);
        shown
    }

    /// After a batch of actions: the state to show again when readiness or
    /// the room flipped without a state event (none before the first state
    /// event).
    pub fn refresh(&mut self, ready: bool, noise_mode: NoiseMode) -> Option<Shown> {
        match self.0 {
            Some(s) if s.ready != ready || s.noise_mode != noise_mode => Some(self.state(s.state, s.echo, ready, noise_mode)),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPayload<'a> {
    pub session_id: &'a str,
    pub turn_id: &'a str,
    pub text: &'a str,
    /// No interim tail: the whole text is final.
    #[serde(rename = "final")]
    pub is_final: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnPayload<'a> {
    pub session_id: &'a str,
    pub turn_id: &'a str,
    pub text: &'a str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterruptedPayload<'a> {
    pub session_id: &'a str,
    pub turn_id: &'a str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelPayload<'a> {
    pub session_id: &'a str,
    /// RMS of the cleaned mic, 0..1 (0 while muted).
    pub mic: f32,
    /// RMS of the agent's voice (the playback reference), 0..1.
    pub agent: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndedPayload<'a> {
    pub session_id: &'a str,
    pub reason: EndReason,
    /// Dictation's final text (voice_stop only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'a str>,
}

/// Emits a webview event: the `AppHandle` in the app, a recorder in tests.
pub trait Emitter: Send + Sync + 'static {
    fn emit_json(&self, event: &str, payload: Value);
}

impl Emitter for tauri::AppHandle {
    fn emit_json(&self, event: &str, payload: Value) {
        use tauri::Emitter as _;
        let _ = self.emit(event, payload);
    }
}

/// Serialize and emit.
pub fn emit<T: Serialize>(emitter: &dyn Emitter, event: &str, payload: &T) {
    match serde_json::to_value(payload) {
        Ok(v) => emitter.emit_json(event, v),
        Err(e) => crate::log_to_file(&format!("[voice] could not serialize {event}: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v<T: Serialize>(t: &T) -> Value {
        serde_json::to_value(t).unwrap()
    }

    // The shapes the web's toVoiceEvent (tauri-bridge.ts) reads, key for key.

    #[test]
    fn state_payload() {
        let p = StatePayload {
            session_id: "s1",
            state: SessionState::UserSpeaking,
            echo: EchoMode::HalfDuplex,
            ready: true,
            noise_mode: NoiseMode::Noisy,
        };
        assert_eq!(
            v(&p),
            json!({ "sessionId": "s1", "state": "user_speaking", "echo": "half_duplex", "ready": true, "noiseMode": "noisy" })
        );
        assert_eq!(v(&NoiseMode::Quiet), json!("quiet"));
        for (state, name) in [
            (SessionState::Starting, "starting"),
            (SessionState::Listening, "listening"),
            (SessionState::UserSpeaking, "user_speaking"),
            (SessionState::Processing, "processing"),
            (SessionState::AgentSpeaking, "agent_speaking"),
            (SessionState::Muted, "muted"),
        ] {
            assert_eq!(v(&state), json!(name));
        }
        for (echo, name) in [
            (EchoMode::Cancelling, "cancelling"),
            (EchoMode::Converging, "converging"),
            (EchoMode::HalfDuplex, "half_duplex"),
            (EchoMode::Headphones, "headphones"),
        ] {
            assert_eq!(v(&echo), json!(name));
        }
    }

    #[test]
    fn shown_state_reshows_a_readiness_flip_under_an_unchanged_state() {
        use SessionState::*;
        use NoiseMode::{Noisy, Quiet};
        let s = |state, echo, ready, noise_mode| Shown { state, echo, ready, noise_mode };
        let mut shown = ShownState::default();
        assert_eq!(shown.refresh(true, Quiet), None, "nothing to re-show before the first state event");
        assert_eq!(shown.state(Muted, EchoMode::Converging, false, Quiet), s(Muted, EchoMode::Converging, false, Quiet));
        assert_eq!(shown.refresh(false, Quiet), None, "no flip");
        assert_eq!(shown.refresh(true, Quiet), Some(s(Muted, EchoMode::Converging, true, Quiet)));
        assert_eq!(shown.refresh(true, Quiet), None, "once");
        assert_eq!(shown.state(Listening, EchoMode::Cancelling, true, Quiet), s(Listening, EchoMode::Cancelling, true, Quiet));
        assert_eq!(shown.refresh(true, Quiet), None);
        // Auto switched rooms under an unchanged state: shown again.
        assert_eq!(shown.refresh(true, Noisy), Some(s(Listening, EchoMode::Cancelling, true, Noisy)));
        assert_eq!(shown.refresh(true, Noisy), None);
    }

    #[test]
    fn transcript_payload_uses_final() {
        let p = TranscriptPayload { session_id: "s1", turn_id: "t2", text: "hello there", is_final: true };
        assert_eq!(v(&p), json!({ "sessionId": "s1", "turnId": "t2", "text": "hello there", "final": true }));
    }

    #[test]
    fn turn_and_interrupted_payloads() {
        let p = TurnPayload { session_id: "s1", turn_id: "t3", text: "what's next?" };
        assert_eq!(v(&p), json!({ "sessionId": "s1", "turnId": "t3", "text": "what's next?" }));
        let p = InterruptedPayload { session_id: "s1", turn_id: "t4" };
        assert_eq!(v(&p), json!({ "sessionId": "s1", "turnId": "t4" }));
    }

    #[test]
    fn speech_payloads() {
        let p = SpeechChunkPayload {
            session_id: "s1",
            turn_id: "t3",
            seq: 0,
            start_ms: 800,
            sample_rate: 16_000,
            pcm: "AQD+/w==",
            end: false,
        };
        assert_eq!(
            v(&p),
            json!({ "sessionId": "s1", "turnId": "t3", "seq": 0, "startMs": 800, "sampleRate": 16000, "pcm": "AQD+/w==", "end": false })
        );
        let p = SpeechEndPayload { session_id: "s1", turn_id: "t3", seq: 2, end: true, outcome: SpeechOutcome::Turn };
        assert_eq!(v(&p), json!({ "sessionId": "s1", "turnId": "t3", "seq": 2, "end": true, "outcome": "turn" }));
        assert_eq!(v(&SpeechOutcome::Abandoned), json!("abandoned"));
    }

    #[test]
    fn level_payload() {
        let p = LevelPayload { session_id: "s1", mic: 0.25, agent: 0.5 };
        assert_eq!(v(&p), json!({ "sessionId": "s1", "mic": 0.25, "agent": 0.5 }));
    }

    #[test]
    fn ended_payload_omits_absent_fields() {
        let p = EndedPayload { session_id: "s1", reason: EndReason::Cancelled, text: None, error: None };
        assert_eq!(v(&p), json!({ "sessionId": "s1", "reason": "cancelled" }));
        let p = EndedPayload { session_id: "s1", reason: EndReason::Stopped, text: Some("hi"), error: None };
        assert_eq!(v(&p), json!({ "sessionId": "s1", "reason": "stopped", "text": "hi" }));
        let p = EndedPayload { session_id: "s1", reason: EndReason::Error, text: None, error: Some("boom") };
        assert_eq!(v(&p), json!({ "sessionId": "s1", "reason": "error", "error": "boom" }));
        for (reason, name) in [
            (EndReason::Stopped, "stopped"),
            (EndReason::Cancelled, "cancelled"),
            (EndReason::Recording, "recording"),
            (EndReason::Page, "page"),
            (EndReason::Idle, "idle"),
            (EndReason::Device, "device"),
            (EndReason::Error, "error"),
        ] {
            assert_eq!(v(&reason), json!(name));
        }
    }

    #[test]
    fn barge_in_only_when_cancelling_or_headphones() {
        assert!(EchoMode::Cancelling.allows_barge_in());
        assert!(EchoMode::Headphones.allows_barge_in());
        assert!(!EchoMode::Converging.allows_barge_in());
        assert!(!EchoMode::HalfDuplex.allows_barge_in());
    }
}
