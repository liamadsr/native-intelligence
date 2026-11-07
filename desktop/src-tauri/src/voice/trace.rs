//! The turn machine's inputs and outputs as records (noise design §3):
//! what the session feeds its [`Machine`], one [`Input`] at a time, and the
//! [`Action`]s it gets back. One format, three users:
//!
//! - the session feeds every input through [`feed`] (so a recording is
//!   exactly what the machine saw);
//! - the dev-only debug capture writes each input and action to
//!   `events.jsonl` ([`super::capture`]);
//! - the replay harness reads them back and feeds them again
//!   ([`super::replay`]).
//!
//! Records are one JSON object per line: `k` (kind), `w` (wall ms, the `now`
//! the machine was given), `c` (the audio clock: the end of the last VAD
//! frame seen). Floats are written as strings in Rust's shortest round-trip
//! form (JSON number parsing may be off by an ulp), so a record reads back
//! bit for bit.

use serde_json::{json, Value};

use super::events::{EchoMode, EndReason, NoiseMode, SessionState};
use super::turn::{Action, BargePolicy, Machine};
use crate::modules::stt::{SttResults, SttWord, VoiceSttEvent};

/// One input to the session's machine.
#[derive(Debug, Clone, PartialEq)]
pub enum Input {
    /// The echo mode (`on_echo`; the session starts with `converging`).
    Echo(EchoMode),
    /// The first state (`start`).
    Start,
    /// The TTS speaking watch (`on_speaking`).
    Speaking(bool),
    /// The DSP thread is up (`vad_frame: None` = no VAD).
    Started { vad_frame: Option<usize>, canceller: bool },
    Vad { prob: f32, start: u64, end: u64, level_db: f32, floor_db: f32 },
    /// A `voice://level` sample: no machine call, but the session publishes
    /// the barge-in arming after it like after any other input.
    Level { mic: f32, agent: f32 },
    BargeIn { onset: u64 },
    /// The barge-in detector fired under the `wake` policy (`on_wake`): the
    /// speech went on.
    Wake { onset: u64 },
    Stt(VoiceSttEvent),
    Tick,
    Stop,
    Cancel,
    Mute(bool),
    /// `voice_set_aside` (`on_aside`).
    Aside { on: bool, text: Option<String> },
    /// `voice_set_barge` (`on_barge_policy`).
    Barge(BargePolicy),
    Replaced,
    /// The DSP thread saw the mic's stream replaced (a device change, or the
    /// same device reopened): the level gate starts over.
    MicReplaced,
    /// After a mic swap, the new device's remembered speech level (WP7).
    SpeechHint { db: f32 },
    /// The DSP thread's mic hold changed (the system tap, `system_ref`): the
    /// audio arrives this far behind wall time (`on_audio_delay`).
    AudioDelay { ms: u64 },
    /// Ended from outside: a command, the page, a device, an error.
    EndWith { reason: EndReason, error: Option<String> },
}

pub const NO_VAD: &str = "the voice activity detector is unavailable";

/// Feed `input` to `machine` at wall time `now`, as the session does.
pub fn feed(machine: &mut Machine, input: &Input, now: u64) -> Vec<Action> {
    match input {
        Input::Echo(mode) => machine.on_echo(*mode),
        Input::Start => machine.start(now),
        Input::Speaking(s) => machine.on_speaking(*s, now),
        Input::Started { vad_frame, .. } => {
            machine.set_dsp_up();
            match vad_frame {
                Some(n) => {
                    machine.set_vad_frame(*n);
                    Vec::new()
                }
                None if machine.mode().converses() => machine.end_with(EndReason::Error, Some(NO_VAD.into())),
                None => Vec::new(),
            }
        }
        Input::Vad { prob, start, end, level_db, floor_db } => machine.on_vad_level(*prob, *start, *end, *level_db, *floor_db, now),
        Input::Level { .. } => Vec::new(),
        Input::BargeIn { onset } => machine.on_barge_in(*onset, now),
        Input::Wake { onset } => machine.on_wake(*onset, now),
        Input::Stt(e) => machine.on_stt(e.clone(), now),
        Input::Tick => machine.on_tick(now),
        Input::Stop => machine.stop(now),
        Input::Cancel => machine.cancel(),
        Input::Mute(m) => machine.on_mute(*m, now),
        Input::Aside { on, text } => machine.on_aside(*on, text.as_deref()),
        Input::Barge(policy) => machine.on_barge_policy(*policy),
        Input::Replaced => machine.replaced(),
        Input::MicReplaced => machine.on_mic_replaced(),
        Input::SpeechHint { db } => machine.on_speech_hint(*db),
        Input::AudioDelay { ms } => machine.on_audio_delay(*ms),
        Input::EndWith { reason, error } => machine.end_with(*reason, error.clone()),
    }
}

// ─── to JSON ────────────────────────────────────────────────────────────────

fn name<T: serde::Serialize>(v: T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

/// An f32, exactly.
fn f(x: f32) -> Value {
    Value::String(x.to_string())
}

/// An f64, exactly.
fn d(x: f64) -> Value {
    Value::String(x.to_string())
}

fn words_json(words: &[SttWord]) -> Value {
    Value::Array(words.iter().map(|w| json!({ "w": w.word, "s": d(w.start), "e": d(w.end), "c": d(w.confidence) })).collect())
}

/// The body of an input record (without `w` / `c`).
pub fn input_json(input: &Input) -> Value {
    match input {
        Input::Echo(m) => json!({ "k": "echo", "mode": name(m) }),
        Input::Start => json!({ "k": "start" }),
        Input::Speaking(s) => json!({ "k": "speaking", "on": s }),
        Input::Started { vad_frame, canceller } => json!({ "k": "started", "vad_frame": vad_frame, "canceller": canceller }),
        Input::Vad { prob, start, end, level_db, floor_db } => {
            json!({ "k": "vad", "p": f(*prob), "s": start, "e": end, "l": f(*level_db), "f": f(*floor_db) })
        }
        Input::Level { mic, agent } => json!({ "k": "level", "mic": f(*mic), "agent": f(*agent) }),
        Input::BargeIn { onset } => json!({ "k": "barge_in", "onset": onset }),
        Input::Wake { onset } => json!({ "k": "wake", "onset": onset }),
        Input::Stt(e) => stt_json(e),
        Input::Tick => json!({ "k": "tick" }),
        Input::Stop => json!({ "k": "stop" }),
        Input::Cancel => json!({ "k": "cancel" }),
        Input::Mute(m) => json!({ "k": "mute", "on": m }),
        Input::Aside { on, text } => json!({ "k": "aside", "on": on, "text": text }),
        Input::Barge(policy) => json!({ "k": "barge", "policy": policy.name() }),
        Input::Replaced => json!({ "k": "replaced" }),
        Input::MicReplaced => json!({ "k": "mic_replaced" }),
        Input::SpeechHint { db } => json!({ "k": "speech_hint", "db": f(*db) }),
        Input::AudioDelay { ms } => json!({ "k": "audio_delay", "ms": ms }),
        Input::EndWith { reason, error } => json!({ "k": "end_with", "reason": name(reason), "error": error }),
    }
}

fn stt_json(e: &VoiceSttEvent) -> Value {
    match e {
        VoiceSttEvent::Ready => json!({ "k": "stt", "e": "ready" }),
        VoiceSttEvent::Results(r) => json!({
            "k": "stt", "e": "results", "final": r.is_final, "speech_final": r.speech_final,
            "from_finalize": r.from_finalize, "transcript": r.transcript, "start": d(r.start),
            "duration": d(r.duration), "words": words_json(&r.words),
        }),
        VoiceSttEvent::SpeechStarted { timestamp } => json!({ "k": "stt", "e": "speech_started", "t": d(*timestamp) }),
        VoiceSttEvent::UtteranceEnd { last_word_end } => json!({ "k": "stt", "e": "utterance_end", "t": d(*last_word_end) }),
        VoiceSttEvent::FinalizeSent { seq } => json!({ "k": "stt", "e": "finalize_sent", "seq": seq }),
        VoiceSttEvent::Finalized { seq } => json!({ "k": "stt", "e": "finalized", "seq": seq }),
        VoiceSttEvent::Failed { reason } => json!({ "k": "stt", "e": "failed", "reason": reason }),
        VoiceSttEvent::Finished => json!({ "k": "stt", "e": "finished" }),
    }
}

/// An action, as a record body (`k: "action"`).
pub fn action_json(action: &Action) -> Value {
    let a = match action {
        Action::State { state, echo } => json!({ "t": "state", "state": name(state), "echo": name(echo) }),
        Action::Transcript { turn_id, text, is_final } => {
            json!({ "t": "transcript", "turn": turn_id, "text": text, "final": is_final })
        }
        Action::Turn { turn_id, text } => json!({ "t": "turn", "turn": turn_id, "text": text }),
        Action::Interrupted { turn_id } => json!({ "t": "interrupted", "turn": turn_id }),
        Action::Finalize { seq } => json!({ "t": "finalize", "seq": seq }),
        Action::NoiseMode { mode, reason } => json!({ "t": "noise_mode", "mode": name(mode), "reason": reason }),
        Action::End { reason, text, error } => json!({ "t": "end", "reason": name(reason), "text": text, "error": error }),
    };
    json!({ "k": "action", "a": a })
}

/// A whole record: the body plus `w` and `c`.
pub fn record(mut body: Value, wall: u64, clock: u64) -> Value {
    if let Value::Object(m) = &mut body {
        m.insert("w".into(), json!(wall));
        m.insert("c".into(), json!(clock));
    }
    body
}

// ─── from JSON ──────────────────────────────────────────────────────────────

/// What one line of a trace is.
#[derive(Debug, Clone, PartialEq)]
pub enum Record {
    Input { wall: u64, input: Input },
    Action { wall: u64, action: Action },
    /// Anything else (the header, route changes, notes): not replayed.
    Other,
}

fn err(what: &str, v: &Value) -> String {
    format!("bad {what}: {v}")
}

fn u(v: &Value, key: &str) -> Result<u64, String> {
    v[key].as_u64().ok_or_else(|| err(key, v))
}

/// An f64 written by [`d`] (or a plain JSON number).
fn fl(v: &Value, key: &str) -> Result<f64, String> {
    match &v[key] {
        Value::String(s) => s.parse().map_err(|_| err(key, v)),
        n => n.as_f64().ok_or_else(|| err(key, v)),
    }
}

/// An f32 written by [`f`] (or a plain JSON number).
fn fl32(v: &Value, key: &str) -> Result<f32, String> {
    match &v[key] {
        Value::String(s) => s.parse().map_err(|_| err(key, v)),
        n => n.as_f64().map(|x| x as f32).ok_or_else(|| err(key, v)),
    }
}

fn b(v: &Value, key: &str) -> Result<bool, String> {
    v[key].as_bool().ok_or_else(|| err(key, v))
}

fn s(v: &Value, key: &str) -> Result<String, String> {
    v[key].as_str().map(str::to_string).ok_or_else(|| err(key, v))
}

fn opt_s(v: &Value, key: &str) -> Option<String> {
    v[key].as_str().map(str::to_string)
}

pub fn echo_mode(name: &str) -> Result<EchoMode, String> {
    Ok(match name {
        "cancelling" => EchoMode::Cancelling,
        "converging" => EchoMode::Converging,
        "half_duplex" => EchoMode::HalfDuplex,
        "headphones" => EchoMode::Headphones,
        _ => return Err(format!("unknown echo mode {name:?}")),
    })
}

pub fn end_reason(name: &str) -> Result<EndReason, String> {
    Ok(match name {
        "stopped" => EndReason::Stopped,
        "cancelled" => EndReason::Cancelled,
        "recording" => EndReason::Recording,
        "page" => EndReason::Page,
        "idle" => EndReason::Idle,
        "device" => EndReason::Device,
        "error" => EndReason::Error,
        _ => return Err(format!("unknown end reason {name:?}")),
    })
}

pub fn noise_mode(name: &str) -> Result<NoiseMode, String> {
    Ok(match name {
        "quiet" => NoiseMode::Quiet,
        "noisy" => NoiseMode::Noisy,
        _ => return Err(format!("unknown noise mode {name:?}")),
    })
}

pub fn session_state(name: &str) -> Result<SessionState, String> {
    Ok(match name {
        "starting" => SessionState::Starting,
        "listening" => SessionState::Listening,
        "user_speaking" => SessionState::UserSpeaking,
        "processing" => SessionState::Processing,
        "agent_speaking" => SessionState::AgentSpeaking,
        "muted" => SessionState::Muted,
        _ => return Err(format!("unknown state {name:?}")),
    })
}

fn stt_from(v: &Value) -> Result<VoiceSttEvent, String> {
    Ok(match s(v, "e")?.as_str() {
        "ready" => VoiceSttEvent::Ready,
        "results" => {
            let words = v["words"]
                .as_array()
                .ok_or_else(|| err("words", v))?
                .iter()
                .map(|w| Ok(SttWord { word: s(w, "w")?, start: fl(w, "s")?, end: fl(w, "e")?, confidence: fl(w, "c")? }))
                .collect::<Result<Vec<_>, String>>()?;
            VoiceSttEvent::Results(SttResults {
                is_final: b(v, "final")?,
                speech_final: b(v, "speech_final")?,
                from_finalize: b(v, "from_finalize")?,
                transcript: s(v, "transcript")?,
                start: fl(v, "start")?,
                duration: fl(v, "duration")?,
                words,
            })
        }
        "speech_started" => VoiceSttEvent::SpeechStarted { timestamp: fl(v, "t")? },
        "utterance_end" => VoiceSttEvent::UtteranceEnd { last_word_end: fl(v, "t")? },
        "finalize_sent" => VoiceSttEvent::FinalizeSent { seq: u(v, "seq")? },
        "finalized" => VoiceSttEvent::Finalized { seq: u(v, "seq")? },
        "failed" => VoiceSttEvent::Failed { reason: s(v, "reason")? },
        "finished" => VoiceSttEvent::Finished,
        other => return Err(format!("unknown stt event {other:?}")),
    })
}

pub fn input_from(v: &Value) -> Result<Input, String> {
    Ok(match s(v, "k")?.as_str() {
        "echo" => Input::Echo(echo_mode(&s(v, "mode")?)?),
        "start" => Input::Start,
        "speaking" => Input::Speaking(b(v, "on")?),
        "started" => Input::Started {
            vad_frame: v["vad_frame"].as_u64().map(|n| n as usize),
            canceller: b(v, "canceller")?,
        },
        "vad" => Input::Vad {
            prob: fl32(v, "p")?,
            start: u(v, "s")?,
            end: u(v, "e")?,
            level_db: fl32(v, "l")?,
            floor_db: fl32(v, "f")?,
        },
        "level" => Input::Level { mic: fl32(v, "mic")?, agent: fl32(v, "agent")? },
        "barge_in" => Input::BargeIn { onset: u(v, "onset")? },
        "wake" => Input::Wake { onset: u(v, "onset")? },
        "stt" => Input::Stt(stt_from(v)?),
        "tick" => Input::Tick,
        "stop" => Input::Stop,
        "cancel" => Input::Cancel,
        "mute" => Input::Mute(b(v, "on")?),
        "aside" => Input::Aside { on: b(v, "on")?, text: opt_s(v, "text") },
        "barge" => {
            let name = s(v, "policy")?;
            Input::Barge(BargePolicy::from_name(&name).ok_or_else(|| format!("unknown barge policy {name:?}"))?)
        }
        "replaced" => Input::Replaced,
        "mic_replaced" => Input::MicReplaced,
        "speech_hint" => Input::SpeechHint { db: fl32(v, "db")? },
        "audio_delay" => Input::AudioDelay { ms: u(v, "ms")? },
        "end_with" => Input::EndWith { reason: end_reason(&s(v, "reason")?)?, error: opt_s(v, "error") },
        other => return Err(format!("not an input: {other:?}")),
    })
}

pub fn action_from(a: &Value) -> Result<Action, String> {
    Ok(match s(a, "t")?.as_str() {
        "state" => Action::State { state: session_state(&s(a, "state")?)?, echo: echo_mode(&s(a, "echo")?)? },
        "transcript" => Action::Transcript { turn_id: s(a, "turn")?, text: s(a, "text")?, is_final: b(a, "final")? },
        "turn" => Action::Turn { turn_id: s(a, "turn")?, text: s(a, "text")? },
        "interrupted" => Action::Interrupted { turn_id: s(a, "turn")? },
        "finalize" => Action::Finalize { seq: u(a, "seq")? },
        "noise_mode" => Action::NoiseMode { mode: noise_mode(&s(a, "mode")?)?, reason: s(a, "reason")? },
        "end" => Action::End { reason: end_reason(&s(a, "reason")?)?, text: opt_s(a, "text"), error: opt_s(a, "error") },
        other => return Err(format!("unknown action {other:?}")),
    })
}

/// Kinds that are notes, not inputs or actions.
const NOTES: &[&str] = &["header", "route", "note", "capture_end"];

/// One line of a trace.
pub fn parse_line(line: &str) -> Result<Record, String> {
    let v: Value = serde_json::from_str(line).map_err(|e| format!("{e}: {line}"))?;
    let kind = s(&v, "k")?;
    if NOTES.contains(&kind.as_str()) {
        return Ok(Record::Other);
    }
    let wall = u(&v, "w")?;
    if kind == "action" {
        return Ok(Record::Action { wall, action: action_from(&v["a"])? });
    }
    Ok(Record::Input { wall, input: input_from(&v)? })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::turn::{Mode, TurnConfig};

    fn round_trip(input: Input) {
        let line = record(input_json(&input), 1234, 5678).to_string();
        assert_eq!(parse_line(&line).unwrap(), Record::Input { wall: 1234, input: input.clone() }, "{line}");
    }

    #[test]
    fn every_input_reads_back_exactly() {
        for i in [
            Input::Echo(EchoMode::HalfDuplex),
            Input::Start,
            Input::Speaking(true),
            Input::Started { vad_frame: Some(512), canceller: true },
            Input::Started { vad_frame: None, canceller: false },
            // An f32 that has no short decimal: it must come back bit for bit.
            Input::Vad { prob: 0.1f32 + 0.2f32, start: 512, end: 1024, level_db: -37.123_46, floor_db: -61.9 },
            Input::Level { mic: 0.012_345_67, agent: 0.0 },
            Input::BargeIn { onset: 9_000 },
            Input::Wake { onset: 9_512 },
            Input::Stt(VoiceSttEvent::Ready),
            Input::Stt(VoiceSttEvent::Results(SttResults {
                is_final: true,
                speech_final: false,
                from_finalize: true,
                transcript: "Hello, there".into(),
                start: 1.25,
                duration: 0.75,
                words: vec![
                    SttWord { word: "Hello,".into(), start: 1.25, end: 1.5, confidence: 0.93 },
                    SttWord { word: "there".into(), start: 1.6, end: 2.0, confidence: 0.1 + 0.2 },
                ],
            })),
            Input::Stt(VoiceSttEvent::SpeechStarted { timestamp: 3.5 }),
            Input::Stt(VoiceSttEvent::UtteranceEnd { last_word_end: 4.25 }),
            Input::Stt(VoiceSttEvent::FinalizeSent { seq: 3 }),
            Input::Stt(VoiceSttEvent::Finalized { seq: 3 }),
            Input::Stt(VoiceSttEvent::Failed { reason: "gone".into() }),
            Input::Stt(VoiceSttEvent::Finished),
            Input::Tick,
            Input::Stop,
            Input::Cancel,
            Input::Mute(false),
            Input::Aside { on: true, text: Some("What's up?".into()) },
            Input::Aside { on: false, text: None },
            Input::Barge(BargePolicy::Speech),
            Input::Barge(BargePolicy::Wake),
            Input::Barge(BargePolicy::Off),
            Input::Replaced,
            Input::MicReplaced,
            Input::SpeechHint { db: -27.345_68 },
            Input::AudioDelay { ms: 100 },
            Input::EndWith { reason: EndReason::Device, error: Some("the microphone stopped".into()) },
            Input::EndWith { reason: EndReason::Page, error: None },
        ] {
            round_trip(i);
        }
    }

    #[test]
    fn every_action_reads_back_exactly() {
        for a in [
            Action::State { state: SessionState::AgentSpeaking, echo: EchoMode::Cancelling },
            Action::Transcript { turn_id: "t3".into(), text: "so far".into(), is_final: false },
            Action::Turn { turn_id: "t3".into(), text: "make it blue".into() },
            Action::Interrupted { turn_id: "t4".into() },
            Action::Finalize { seq: 7 },
            Action::NoiseMode { mode: NoiseMode::Noisy, reason: "far speech 23 % of the last 10 s".into() },
            Action::NoiseMode { mode: NoiseMode::Quiet, reason: "no far speech for 120 s".into() },
            Action::End { reason: EndReason::Stopped, text: Some("all of it".into()), error: None },
            Action::End { reason: EndReason::Error, text: None, error: Some("boom".into()) },
        ] {
            let line = record(action_json(&a), 99, 0).to_string();
            assert_eq!(parse_line(&line).unwrap(), Record::Action { wall: 99, action: a.clone() }, "{line}");
        }
        assert_eq!(parse_line(r#"{"k":"route","w":1,"hint":true}"#).unwrap(), Record::Other);
        assert!(parse_line(r#"{"k":"karaoke","w":1}"#).is_err());
    }

    #[test]
    fn feed_is_what_the_session_does() {
        let mut m = Machine::new(TurnConfig::new(Mode::Conversation, 700, true), EchoMode::Converging);
        assert_eq!(
            feed(&mut m, &Input::Echo(EchoMode::Converging), 0),
            vec![Action::State { state: SessionState::Starting, echo: EchoMode::Converging }]
        );
        assert_eq!(feed(&mut m, &Input::Start, 0), vec![]);
        assert_eq!(feed(&mut m, &Input::Started { vad_frame: Some(512), canceller: true }, 1), vec![]);
        assert_eq!(feed(&mut m, &Input::Level { mic: 0.1, agent: 0.0 }, 1), vec![]);
        // No VAD ends a conversation, not a dictation.
        let ended = feed(&mut m, &Input::Started { vad_frame: None, canceller: true }, 2);
        assert_eq!(ended, vec![Action::End { reason: EndReason::Error, text: None, error: Some(NO_VAD.into()) }]);
        let mut d = Machine::new(TurnConfig::new(Mode::Dictation, 700, true), EchoMode::Converging);
        d.start(0);
        assert_eq!(feed(&mut d, &Input::Started { vad_frame: None, canceller: true }, 2), vec![]);
    }
}
