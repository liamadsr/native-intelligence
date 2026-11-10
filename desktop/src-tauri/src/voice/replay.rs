//! Offline replay of chat voice (noise design §3.2), and the regression
//! goldens that keep the "Quiet room" preset what 0.2.45 was.
//!
//! Three ways in:
//!
//! - **Recorded mode** ([`replay_recorded`]): a trace's machine inputs
//!   ([`super::trace`]: a debug capture's `events.jsonl`, or a committed
//!   fixture) fed to a fresh [`Machine`] at their recorded wall times. The
//!   machine is clock-injected, so this is deterministic; the actions are
//!   diffed against the recorded ones.
//! - **Full DSP mode** ([`replay_full`]): a debug capture's audio through a
//!   fresh [`DspCore`] (the real aec3 canceller and Silero, or whatever is
//!   given) in aec3's recorded render/capture interleaving
//!   ([`DspCore::replay_frame`]), with barge-in's inputs as recorded. The
//!   cleaned audio must come out bit for bit, the VAD within 1e-6.
//! - **Closed-loop capture mode** ([`closed`]): a debug capture's audio
//!   through a fresh DSP path under another preset or tuning, with a fresh
//!   machine fed the recorded inputs and the replay's own barge-ins, so the
//!   noisy room's gate learns S as the session would. Replies the recording
//!   cut but the replay doesn't go on for a few seconds.
//! - **Synthetic scenes** ([`sim`]): bench audio mixed with a "TV", run
//!   closed-loop through the DSP path and the machine, measured by
//!   [`metrics`] against the §3.3 bars.
//!
//! **Goldens** (`src-tauri/tests/fixtures/voice-replay/`): every bench scene
//! run under the quiet room at 94316dd behaviour (0.2.45): `<scene>.inputs.jsonl`
//! (a header, then every machine input) and `<scene>.quiet.actions.jsonl`
//! (every action). `replay::tests` replays the inputs through the quiet room
//! and requires the actions exactly (always, no audio needed); when the
//! bench audio and ONNX Runtime are there it also reruns the scenes live and
//! requires the same inputs (VAD within 1e-6) and actions. Regenerate only
//! for a deliberate quiet-room change, which the preset rules forbid:
//! `cargo run --example voice_replay -- goldens --write`.
//!
//! The CLI (`examples/voice_replay.rs`, [`cli_main`]):
//!
//! ```text
//! voice_replay sim [--profile quiet|noisy] [--scene NAME]   # metrics per scene
//! voice_replay capture DIR [--profile quiet|noisy] [--full]  # replay a debug capture
//! voice_replay goldens [--write]                             # check / rewrite the goldens
//! voice_replay capture DIR --closed [--profile P] [--hint DB|remember] [--set k=v]...
//! voice_replay capture DIR --no-hold [--skip-greeting] [--until S]  # without the intro's mute hold
//! voice_replay sweep ... --capture DIR [--capture-hint cold,-37,remember] [--capture-only]
//! voice_replay fixture DIR NAME [--write]                     # a capture as a redacted noisy fixture
//! voice_replay remember [--long] [--masked] [--sessions N]    # cold vs remembered level (WP7)
//! voice_replay auto [--long] [--masked] [--vary auto.k=a,b]... [--capture DIR]...  # Auto vs quiet (WP7)
//! ```
//!
//! Its log lines go to `$TMPDIR/native-intelligence-voice-replay.log`, never the app's
//! `native-intelligence-debug.log` ([`crate::redirect_log`]).

pub mod auto;
pub mod closed;
pub mod metrics;
pub mod sim;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::dsp::{AudioSink, DspCore, DspEvent, DspShared, ReplayFrame, SpeechControl};
use super::events::EchoMode;
use super::profile::{NoiseProfile, Tuning};
use super::trace::{self, Input, Record};
use super::turn::{Action, Machine, Mode, TurnConfig, DEFAULT_END_SILENCE_MS};
use super::vad::Vad;
use crate::audio::aec::{EchoCanceller, AEC_FRAME};
use crate::audio::tap::tap_channel;

// ─── traces ─────────────────────────────────────────────────────────────────

/// A machine's configuration, as a trace header records it.
#[derive(Debug, Clone, PartialEq)]
pub struct TraceConfig {
    pub mode: Mode,
    pub end_silence_ms: u32,
    pub barge_in: bool,
    pub profile: NoiseProfile,
}

impl TraceConfig {
    pub fn from_header(h: &Value) -> TraceConfig {
        TraceConfig {
            // (An unknown or missing mode: a conversation, as before.)
            mode: h["mode"].as_str().and_then(Mode::from_name).unwrap_or(Mode::Conversation),
            end_silence_ms: h["end_silence_ms"].as_u64().map_or(DEFAULT_END_SILENCE_MS, |v| v as u32),
            barge_in: h["barge_in"].as_bool().unwrap_or(true),
            profile: NoiseProfile::parse(h["noise_profile"].as_str()),
        }
    }

    pub fn turn_config(&self, profile: NoiseProfile) -> TurnConfig {
        TurnConfig::for_profile(self.mode, self.end_silence_ms, self.barge_in, profile)
    }
}

/// A trace: its header, the machine's inputs and the actions it answered.
#[derive(Debug, Clone, Default)]
pub struct Trace {
    pub header: Value,
    pub inputs: Vec<(u64, Input)>,
    pub actions: Vec<(u64, Action)>,
}

impl Trace {
    pub fn parse(text: &str) -> Result<Trace, String> {
        let mut t = Trace::default();
        for (n, line) in text.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let v: Value = serde_json::from_str(line).map_err(|e| format!("line {}: {e}", n + 1))?;
            if v["k"] == "header" {
                t.header = v;
                continue;
            }
            match trace::parse_line(line).map_err(|e| format!("line {}: {e}", n + 1))? {
                Record::Input { wall, input } => t.inputs.push((wall, input)),
                Record::Action { wall, action } => t.actions.push((wall, action)),
                Record::Other => {}
            }
        }
        Ok(t)
    }

    pub fn load(path: &Path) -> Result<Trace, String> {
        Trace::parse(&std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?)
    }

    pub fn config(&self) -> TraceConfig {
        TraceConfig::from_header(&self.header)
    }
}

/// Recorded mode: feed `inputs` to a fresh machine at their wall times.
pub fn replay_recorded(inputs: &[(u64, Input)], cfg: TurnConfig) -> Vec<(u64, Action)> {
    let mut m = Machine::new(cfg, EchoMode::Converging);
    let mut out = Vec::new();
    for (wall, input) in inputs {
        for a in trace::feed(&mut m, input, *wall) {
            out.push((*wall, a));
        }
    }
    out
}

/// The first difference between two action streams, if any.
pub fn diff_actions(want: &[(u64, Action)], got: &[(u64, Action)]) -> Option<String> {
    for (i, (w, g)) in want.iter().zip(got).enumerate() {
        if w != g {
            return Some(format!("action {i}: want {w:?}, got {g:?}"));
        }
    }
    (want.len() != got.len()).then(|| format!("{} actions wanted, {} got", want.len(), got.len()))
}

/// Inputs as JSONL (after a header line).
pub fn inputs_jsonl(header: &Value, inputs: &[(u64, Input)]) -> String {
    let mut out = format!("{header}\n");
    let mut clock = 0u64;
    for (wall, i) in inputs {
        if let Input::Vad { end, .. } = i {
            clock = clock.max(*end);
        }
        out.push_str(&trace::record(trace::input_json(i), *wall, clock).to_string());
        out.push('\n');
    }
    out
}

pub fn actions_jsonl(actions: &[(u64, Action)]) -> String {
    let mut out = String::new();
    for (wall, a) in actions {
        out.push_str(&trace::record(trace::action_json(a), *wall, 0).to_string());
        out.push('\n');
    }
    out
}

/// Inputs equal, the VAD's and levels' floats within `tol`.
pub fn diff_inputs(want: &[(u64, Input)], got: &[(u64, Input)], tol: f32) -> Option<String> {
    let close = |a: f32, b: f32| (a - b).abs() <= tol;
    for (i, ((ww, w), (gw, g))) in want.iter().zip(got).enumerate() {
        let same = ww == gw
            && match (w, g) {
                (
                    Input::Vad { prob: p1, start: s1, end: e1, level_db: l1, floor_db: f1 },
                    Input::Vad { prob: p2, start: s2, end: e2, level_db: l2, floor_db: f2 },
                ) => s1 == s2 && e1 == e2 && close(*p1, *p2) && close(*l1, *l2) && close(*f1, *f2),
                (Input::Level { mic: m1, agent: a1 }, Input::Level { mic: m2, agent: a2 }) => {
                    close(*m1, *m2) && close(*a1, *a2)
                }
                _ => w == g,
            };
        if !same {
            return Some(format!("input {i}: want {ww} {w:?}, got {gw} {g:?}"));
        }
    }
    (want.len() != got.len()).then(|| format!("{} inputs wanted, {} got", want.len(), got.len()))
}

// ─── debug captures ─────────────────────────────────────────────────────────

/// One `aec.csv` row.
#[derive(Debug, Clone, PartialEq)]
pub struct AecRow {
    pub clock: u64,
    pub now_ms: u64,
    pub renders: usize,
    pub absent_zero: bool,
    pub echo: EchoMode,
    pub converged: bool,
    pub muted: bool,
    pub headphones_hint: bool,
    pub resynced: bool,
    pub mute_toggled: bool,
    /// (Absent from captures made before it was recorded: no.)
    pub mic_replaced: bool,
}

/// One `frames.csv` row.
#[derive(Debug, Clone, PartialEq)]
pub struct VadCsvRow {
    pub start: u64,
    pub end: u64,
    pub prob: f32,
    pub level_db: f32,
    pub floor_db: f32,
    pub barge_armed: bool,
    /// (Absent from captures made before it was recorded: no.)
    pub barge_aside: bool,
    pub echo: EchoMode,
    pub agent_audible: Option<bool>,
    pub barge_fired: Option<u64>,
}

/// A debug capture folder, loaded.
pub struct CaptureData {
    pub dir: PathBuf,
    pub trace: Trace,
    pub aec: Vec<AecRow>,
    pub vads: Vec<VadCsvRow>,
    pub mic: Vec<f32>,
    pub reference: Vec<f32>,
    pub cleaned: Vec<f32>,
}

fn read_wav(path: &Path) -> Result<Vec<f32>, String> {
    let mut r = hound::WavReader::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    r.samples::<f32>().map(|s| s.map_err(|e| e.to_string())).collect()
}

fn csv(path: &Path) -> Result<Vec<Vec<String>>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(text.lines().skip(1).filter(|l| !l.is_empty()).map(|l| l.split(',').map(str::to_string).collect()).collect())
}

fn field<T: std::str::FromStr>(row: &[String], i: usize) -> Result<T, String> {
    row.get(i).and_then(|v| v.parse().ok()).ok_or_else(|| format!("bad column {i} in {row:?}"))
}

fn flag(row: &[String], i: usize) -> Result<bool, String> {
    Ok(field::<u8>(row, i)? == 1)
}

fn opt_field<T: std::str::FromStr>(row: &[String], i: usize) -> Option<T> {
    row.get(i).filter(|v| !v.is_empty()).and_then(|v| v.parse().ok())
}

impl CaptureData {
    pub fn load(dir: &Path) -> Result<CaptureData, String> {
        let aec = csv(&dir.join("aec.csv"))?
            .iter()
            .map(|r| {
                Ok(AecRow {
                    clock: field(r, 0)?,
                    now_ms: field(r, 1)?,
                    renders: field(r, 2)?,
                    absent_zero: flag(r, 3)?,
                    converged: flag(r, 8)?,
                    echo: trace::echo_mode(r.get(9).map(String::as_str).unwrap_or(""))?,
                    muted: flag(r, 10)?,
                    headphones_hint: flag(r, 11)?,
                    resynced: flag(r, 12)?,
                    mute_toggled: flag(r, 13)?,
                    mic_replaced: opt_field::<u8>(r, 14) == Some(1),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let vads = csv(&dir.join("frames.csv"))?
            .iter()
            .map(|r| {
                Ok(VadCsvRow {
                    start: field(r, 0)?,
                    end: field(r, 1)?,
                    prob: field(r, 3)?,
                    level_db: field(r, 4)?,
                    floor_db: field(r, 5)?,
                    barge_armed: flag(r, 9)?,
                    echo: trace::echo_mode(r.get(10).map(String::as_str).unwrap_or(""))?,
                    agent_audible: opt_field::<u8>(r, 11).map(|v| v == 1),
                    barge_fired: opt_field(r, 13),
                    barge_aside: opt_field::<u8>(r, 14) == Some(1),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(CaptureData {
            dir: dir.to_path_buf(),
            trace: Trace::load(&dir.join("events.jsonl"))?,
            aec,
            vads,
            mic: read_wav(&dir.join("mic_16k.wav"))?,
            reference: read_wav(&dir.join("ref_16k.wav"))?,
            cleaned: read_wav(&dir.join("cleaned_16k.wav"))?,
        })
    }
}

#[derive(Clone, Default)]
struct Recorder(Arc<Mutex<Vec<f32>>>);

impl AudioSink for Recorder {
    fn push(&self, samples: &[f32]) {
        self.0.lock().unwrap().extend_from_slice(samples);
    }
}

/// Barge-in's inputs as recorded: `agent_audible()` answers what the
/// capture says it answered for the VAD frame at hand.
#[derive(Clone, Default)]
struct RecordedSpeech {
    audible: Arc<AtomicBool>,
    asked: Arc<AtomicUsize>,
    cancels: Arc<AtomicUsize>,
}

impl SpeechControl for RecordedSpeech {
    fn agent_audible(&self) -> bool {
        self.asked.fetch_add(1, Ordering::SeqCst);
        self.audible.load(Ordering::SeqCst)
    }
    fn cancel_speech(&self) {
        self.cancels.fetch_add(1, Ordering::SeqCst);
    }
}

/// What a full DSP replay produced.
#[derive(Debug, Default)]
pub struct FullReplay {
    pub cleaned: Vec<f32>,
    pub vads: Vec<(u64, u64, f32, f32, f32)>,
    pub barge_ins: Vec<u64>,
    pub echo_modes: Vec<EchoMode>,
}

/// Full DSP mode: the capture's audio through a fresh DSP path in its
/// recorded order.
pub fn replay_full(
    data: &CaptureData,
    canceller: Box<dyn EchoCanceller>,
    canceller_real: bool,
    vad: Box<dyn Vad>,
    profile: NoiseProfile,
) -> Result<FullReplay, String> {
    let (_mw, mic_r) = tap_channel(16);
    let (_rw, ref_r) = tap_channel(16);
    let sink = Recorder::default();
    let speech = RecordedSpeech::default();
    let shared = Arc::new(DspShared::default());
    let (tx, mut events) = mpsc::unbounded_channel();
    let mut core = DspCore::new(
        mic_r,
        Some(ref_r),
        canceller,
        canceller_real,
        Some(vad),
        Box::new(sink.clone()),
        Box::new(speech.clone()),
        shared.clone(),
        tx,
        0,
    )
    .with_profile(profile);
    let (mut rpos, mut vpos) = (0usize, 0usize);
    let mut out = FullReplay::default();
    for (i, row) in data.aec.iter().enumerate() {
        let capture: &[f32; AEC_FRAME] = data
            .mic
            .get(i * AEC_FRAME..(i + 1) * AEC_FRAME)
            .and_then(|s| s.try_into().ok())
            .ok_or("mic_16k.wav is shorter than aec.csv")?;
        let mut renders = Vec::with_capacity(row.renders);
        for _ in 0..row.renders {
            let r: [f32; AEC_FRAME] = data
                .reference
                .get(rpos..rpos + AEC_FRAME)
                .and_then(|s| s.try_into().ok())
                .ok_or("ref_16k.wav is shorter than aec.csv")?;
            renders.push(r);
            rpos += AEC_FRAME;
        }
        if row.absent_zero {
            rpos += AEC_FRAME;
        }
        // The VAD frame that completes in this capture frame, if any: its
        // barge-in inputs as recorded.
        let frame_end = row.clock + AEC_FRAME as u64;
        if let Some(v) = data.vads.get(vpos).filter(|v| v.end > row.clock && v.end <= frame_end) {
            shared.barge_armed.store(v.barge_armed, Ordering::SeqCst);
            shared.barge_aside.store(v.barge_aside, Ordering::SeqCst);
            speech.audible.store(v.agent_audible == Some(true), Ordering::SeqCst);
            vpos += 1;
        }
        core.replay_frame(&ReplayFrame {
            now_ms: row.now_ms,
            renders: &renders,
            absent_zero: row.absent_zero,
            capture,
            muted: row.muted,
            mute_toggled: row.mute_toggled,
            headphones_hint: row.headphones_hint,
            resynced: row.resynced,
            mic_replaced: row.mic_replaced,
        });
        while let Ok(e) = events.try_recv() {
            match e {
                DspEvent::Vad { prob, start, end, level_db, floor_db } => out.vads.push((start, end, prob, level_db, floor_db)),
                DspEvent::BargeIn { onset } => out.barge_ins.push(onset),
                DspEvent::Echo(m) => out.echo_modes.push(m),
                _ => {}
            }
        }
    }
    drop(core);
    out.cleaned = std::mem::take(&mut *sink.0.lock().unwrap());
    Ok(out)
}

/// Where a full replay differs from the capture (empty: identical).
/// `cleaned` is compared bit for bit, the VAD within `tol`.
pub fn diff_full(data: &CaptureData, got: &FullReplay, tol: f32) -> Vec<String> {
    let mut out = Vec::new();
    // The capture's cleaned audio is the canceller's output also while muted
    // (transcription got zeros then); compare where it was fed through.
    let mut want = Vec::with_capacity(data.cleaned.len());
    for (i, row) in data.aec.iter().enumerate() {
        let frame = &data.cleaned[(i * AEC_FRAME).min(data.cleaned.len())..((i + 1) * AEC_FRAME).min(data.cleaned.len())];
        if row.muted {
            want.extend(std::iter::repeat_n(0.0, frame.len()));
        } else {
            want.extend_from_slice(frame);
        }
    }
    if want.len() != got.cleaned.len() {
        out.push(format!("cleaned: {} samples recorded, {} replayed", want.len(), got.cleaned.len()));
    }
    if let Some(i) = want.iter().zip(&got.cleaned).position(|(a, b)| a.to_bits() != b.to_bits()) {
        out.push(format!("cleaned differs first at sample {i} ({} vs {})", want[i], got.cleaned[i]));
    }
    if data.vads.len() != got.vads.len() {
        out.push(format!("{} VAD frames recorded, {} replayed", data.vads.len(), got.vads.len()));
    }
    for (i, (w, g)) in data.vads.iter().zip(&got.vads).enumerate() {
        let (s, e, p, l, f) = *g;
        if w.start != s || w.end != e || (w.prob - p).abs() > tol || (w.level_db - l).abs() > tol || (w.floor_db - f).abs() > tol {
            out.push(format!("VAD frame {i}: recorded {w:?}, replayed ({s}, {e}, {p}, {l}, {f})"));
            break;
        }
    }
    let fired: Vec<u64> = data.vads.iter().filter_map(|v| v.barge_fired).collect();
    if fired != got.barge_ins {
        out.push(format!("barge-ins: recorded {fired:?}, replayed {:?}", got.barge_ins));
    }
    out
}

// ─── goldens ────────────────────────────────────────────────────────────────

pub fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/voice-replay")
}

/// The real DSP pieces: aec3 and Silero (None: no ONNX Runtime).
pub fn real_dsp() -> Option<(Box<dyn EchoCanceller>, Box<dyn Vad>)> {
    let vad = crate::voice::silero::SileroVad::new().ok()?;
    let canceller = crate::audio::aec::new_echo_canceller().ok()?;
    Some((canceller, Box::new(vad)))
}

/// A bench scene's header line in its fixture.
pub fn scene_header(spec: &sim::SceneSpec, profile: NoiseProfile) -> Value {
    json!({
        "k": "header",
        "scene": spec.name,
        "mode": "conversation",
        "end_silence_ms": DEFAULT_END_SILENCE_MS,
        "barge_in": true,
        "noise_profile": profile.name(),
        "tuning": profile.tuning().label,
        "duration_s": spec.duration_s,
        "tv_rel_db": spec.tv_rel_db,
        "route": format!("{:?}", spec.route),
        "reply_s": spec.reply_s,
        "user_gap_s": spec.user_gap_s,
        "made_by": "voice_replay goldens --write (aec3 =0.4.0, Silero v6.2.3 on ONNX Runtime 1.23.2)",
    })
}

/// Run one bench scene live with the real DSP, the noisy room starting from
/// `speech_hint` (a remembered level) or the bootstrap.
pub fn run_scene_hinted(
    spec: &sim::SceneSpec,
    bench: &sim::BenchAudio,
    tuning: &Tuning,
    speech_hint: Option<f32>,
) -> Result<(sim::Mix, sim::SimRun), String> {
    let (canceller, vad) = real_dsp().ok_or("no ONNX Runtime for Silero (build local-tts or set NI_ORT_DYLIB)")?;
    let mix = sim::build_mix(spec, bench);
    let setup = sim::SimSetup { tuning: *tuning, vad, canceller, canceller_real: true, capture: None, speech_hint };
    let run = sim::run(&mix, setup);
    Ok((mix, run))
}

/// A run's machine at its end, rebuilt from its inputs (the machine is pure):
/// S and the sent turns that measured it, as a session's per-mic memory
/// would read them. Errs if the rebuild doesn't answer what the run did.
pub fn speech_at_end(run: &sim::SimRun, tuning: &Tuning, speech_hint: Option<f32>) -> Result<(f32, u32), String> {
    let cfg = TurnConfig::for_tuning(Mode::Conversation, DEFAULT_END_SILENCE_MS, true, tuning);
    let mut m = Machine::new(cfg, EchoMode::Converging).with_speech_hint(speech_hint);
    let mut actions = Vec::new();
    for (wall, i) in &run.inputs {
        actions.extend(trace::feed(&mut m, i, *wall).into_iter().map(|a| (*wall, a)));
    }
    if actions != run.actions {
        return Err("the machine rebuilt from the run's inputs answered differently".into());
    }
    let (db, _) = m.speech_level().ok_or("no level gate")?;
    Ok((db, m.measured_turns()))
}

/// Run one bench scene live with the real DSP.
pub fn run_scene(spec: &sim::SceneSpec, bench: &sim::BenchAudio, tuning: &Tuning) -> Result<(sim::Mix, sim::SimRun), String> {
    let (canceller, vad) = real_dsp().ok_or("no ONNX Runtime for Silero (build local-tts or set NI_ORT_DYLIB)")?;
    let mix = sim::build_mix(spec, bench);
    // Warm: the level a sent turn measures for this user (≈ their active
    // level + 4 dB: the 90th percentile of the gate's level), as a
    // remembered per-device level would give it (WP7).
    // With an offset, a remembered level that far over the user's (another
    // talker's, or a louder day's): applied as the app applies any
    // remembered level, so only what the app does brings it back down.
    let speech_hint = spec.warm.then_some(spec.user_db + 4.0 + spec.warm_offset_db);
    let setup = sim::SimSetup { tuning: *tuning, vad, canceller, canceller_real: true, capture: None, speech_hint };
    let run = sim::run(&mix, setup);
    Ok((mix, run))
}

/// [`run_scene`] for every spec, one thread each (each builds its own
/// canceller and VAD), results in spec order.
pub fn run_scenes(
    specs: &[sim::SceneSpec],
    bench: &sim::BenchAudio,
    tuning: &Tuning,
) -> Vec<Result<(sim::Mix, sim::SimRun), String>> {
    std::thread::scope(|s| {
        let handles: Vec<_> = specs.iter().map(|spec| s.spawn(move || run_scene(spec, bench, tuning))).collect();
        handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("a scene panicked".into()))).collect()
    })
}

// ─── CLI ────────────────────────────────────────────────────────────────────

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

/// `--profile`'s tuning with every `--set key=value` applied (tuning
/// experiments; the presets themselves live in `profile.rs`).
fn tuning_arg(args: &[String]) -> Result<Tuning, String> {
    let mut t = *profile_arg(args)?.tuning();
    for (i, a) in args.iter().enumerate() {
        if a == "--set" {
            let kv = args.get(i + 1).ok_or("--set key=value")?;
            let (k, v) = kv.split_once('=').ok_or(format!("--set {kv}: key=value"))?;
            set_tuning(&mut t, k, v)?;
            t.label = "custom";
        }
    }
    Ok(t)
}

/// One field of a tuning by name (`turn.onset`, `gate.confirm_frames`, ...).
pub fn set_tuning(t: &mut Tuning, key: &str, v: &str) -> Result<(), String> {
    let f = || v.parse::<f32>().map_err(|e| format!("{key}={v}: {e}"));
    let u = || v.parse::<u64>().map_err(|e| format!("{key}={v}: {e}"));
    let none = v == "none";
    match key {
        "turn.onset" => t.turn.onset = f()?,
        "turn.off" => t.turn.off = f()?,
        "turn.min_speech_ms" => t.turn.min_speech_ms = u()? as u32,
        "turn.onset_slack_ms" => t.turn.onset_slack_ms = u()? as u32,
        "barge.onset" => t.barge.onset = f()?,
        "barge.off" => t.barge.off = f()?,
        "barge.sustain_ms" => t.barge.sustain_ms = u()? as u32,
        "max_run_ms" => t.max_run_ms = if none { None } else { Some(u()?) },
        "word_filter" if none => t.word_filter = None,
        "word_filter.slack_s" => t.word_filter.get_or_insert(Tuning::NOISY.word_filter.unwrap()).slack_s = f()? as f64,
        "word_filter.below_speech_db" => t.word_filter.get_or_insert(Tuning::NOISY.word_filter.unwrap()).below_speech_db = f()?,
        "word_filter.dictation_below_speech_db" => {
            t.word_filter.get_or_insert(Tuning::NOISY.word_filter.unwrap()).dictation_below_speech_db = f()?
        }
        "gate" if none => t.gate = None,
        "auto" if none => t.auto = None,
        k if k.starts_with("auto.") => {
            let a = t.auto.get_or_insert(Tuning::AUTO.auto.expect("auto has a switch"));
            let b = || v.parse::<bool>().map_err(|e| format!("{key}={v}: {e}"));
            match &k[5..] {
                "far_prob" => a.far_prob = f()?,
                "far_below_speech_db" => a.far_below_speech_db = f()?,
                "far_above_floor_db" => a.far_above_floor_db = f()?,
                "near_mask_ms" => a.near_mask_ms = u()? as u32,
                "near_mask_before_ms" => a.near_mask_before_ms = u()? as u32,
                "window_ms" => a.window_ms = u()? as u32,
                "ratio" => a.ratio = f()?,
                "burst_ms" => a.burst_ms = u()? as u32,
                "burst_ratio" => a.burst_ratio = f()?,
                "floor_db" => a.floor_db = if none { None } else { Some(f()?) },
                "revert_ms" => a.revert_ms = u()?,
                "barge_when_known" => a.barge_when_known = b()?,
                "known_share" => a.known_share = f()?,
                _ => return Err(format!("unknown tuning key {key:?}")),
            }
        }
        k if k.starts_with("gate.") => {
            let g = t.gate.get_or_insert(Tuning::NOISY.gate.expect("the noisy room has a gate"));
            match &k[5..] {
                "onset_below_speech_db" => g.onset_below_speech_db = f()?,
                "onset_above_floor_db" => g.onset_above_floor_db = f()?,
                "sustain_below_speech_db" => g.sustain_below_speech_db = f()?,
                "sustain_above_floor_db" => g.sustain_above_floor_db = f()?,
                "barge_below_speech_db" => g.barge_below_speech_db = f()?,
                "barge_start_below_speech_db" => g.barge_start_below_speech_db = f()?,
                "bootstrap_speech_db" => g.bootstrap_speech_db = f()?,
                "bootstrap_above_floor_db" => g.bootstrap_above_floor_db = f()?,
                "bootstrap_below_speech_db" => g.bootstrap_below_speech_db = f()?,
                "confirm_frames" => g.confirm_frames = u()? as u32,
                "confirm_window" => g.confirm_window = u()? as u32,
                "confirm_peak_below_speech_db" => g.confirm_peak_below_speech_db = f()?,
                "smooth_frames" => g.smooth_frames = u()? as u32,
                "fast_attack" => g.fast_attack = v.parse::<bool>().map_err(|e| format!("{key}={v}: {e}"))?,
                "backdate_ms" => g.backdate_ms = u()? as u32,
                "backdate_gap_ms" => g.backdate_gap_ms = u()? as u32,
                "hold_on_sustain" => g.hold_on_sustain = v.parse::<bool>().map_err(|e| format!("{key}={v}: {e}"))?,
                "speech_percentile" => g.speech_percentile = f()?,
                "speech_rate" => g.speech_rate = f()?,
                "speech_up_db" => g.speech_up_db = f()?,
                "measured_up_db" => g.measured_up_db = f()?,
                "speech_down_db" => g.speech_down_db = f()?,
                "speech_down_within_db" => g.speech_down_within_db = f()?,
                "speech_recover_turns" => g.speech_recover_turns = u()? as u32,
                "relax_missed_ms" => g.relax_missed_ms = u()? as u32,
                "relax_step_db" => g.relax_step_db = f()?,
                "speech_min_db" => g.speech_min_db = f()?,
                "speech_max_db" => g.speech_max_db = f()?,
                _ => return Err(format!("unknown tuning key {key:?}")),
            }
        }
        _ => return Err(format!("unknown tuning key {key:?}")),
    }
    Ok(())
}

fn profile_arg(args: &[String]) -> Result<NoiseProfile, String> {
    match arg_value(args, "--profile") {
        None => Ok(NoiseProfile::Quiet),
        Some(p) => NoiseProfile::from_name(&p).ok_or(format!("unknown profile {p:?}")),
    }
}

/// `examples/voice_replay.rs`. Returns the exit code.
pub fn cli_main(args: Vec<String>) -> i32 {
    // The harness runs the session's code, which logs ("[voice] echo path
    // ..."): into its own file, never the app's debug log.
    let log = std::env::temp_dir().join("native-intelligence-voice-replay.log");
    crate::redirect_log(Some(log));
    let result = match args.first().map(String::as_str) {
        Some("sim") => cli_sim(&args[1..]),
        Some("capture") => cli_capture(&args[1..]),
        Some("goldens") => cli_goldens(&args[1..]),
        Some("fixture") => closed::cli_fixture(&args[1..]),
        Some("levels") => cli_levels(&args[1..]),
        Some("timeline") => cli_timeline(&args[1..]),
        Some("eval") => cli_eval(&args[1..]),
        Some("frames") => cli_frames(&args[1..]),
        Some("sweep") => cli_sweep(&args[1..]),
        Some("remember") => cli_remember(&args[1..]),
        Some("auto") => auto::cli_auto(&args[1..]),
        _ => Err("usage: voice_replay sim [--profile quiet|noisy] [--scene NAME] [--set key=value]...\n       voice_replay eval|sweep [--long] [--masked] [--warm | --warm-offset DB] [--set key=value]... [--vary key=a,b,c]...\n       voice_replay remember [--long] [--masked] [--scene NAME] [--sessions N] [--set key=value]...\n       voice_replay auto [--long] [--masked] [--scene NAME] [--set auto.k=v]... [--vary auto.k=a,b]... [--capture DIR]... [--no-scenes]\n       voice_replay capture DIR [--profile quiet|noisy] [--full]\n       voice_replay capture DIR --closed [--profile quiet|noisy] [--hint DB] [--extend MS] [--set key=value]... [--dump FILE]\n       voice_replay capture DIR --no-hold [--skip-greeting] [--until S]\n       voice_replay goldens [--write]\n       voice_replay fixture DIR NAME [--write]".into()),
    };
    match result {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// The scenes a CLI run uses: the golden ones, or with `--long` the tuning
/// set ([`sim::long_scenes`]); `--scene NAME` picks one.
fn scene_set(args: &[String]) -> Result<(Vec<sim::SceneSpec>, sim::BenchAudio), String> {
    let dir = sim::bench_dir();
    if !sim::bench_available(&dir) {
        return Err(format!("the bench audio is not in {} (set NI_SPEECH_BENCH)", dir.display()));
    }
    let long = args.iter().any(|a| a == "--long");
    let masked = args.iter().any(|a| a == "--masked");
    let only = arg_value(args, "--scene");
    let all = if long { sim::long_scenes() } else { sim::scenes() };
    // `--warm-offset DB`: warm, from a level DB over the user's own.
    let warm_offset_db = match arg_value(args, "--warm-offset") {
        Some(v) => v.parse::<f32>().map_err(|e| format!("--warm-offset {v}: {e}"))?,
        None => 0.0,
    };
    let warm = args.iter().any(|a| a == "--warm" || a == "--warm-offset");
    let all: Vec<sim::SceneSpec> =
        all.into_iter().map(|s| sim::SceneSpec { tv_masked: masked, warm, warm_offset_db, ..s }).collect();
    let specs: Vec<sim::SceneSpec> = all.into_iter().filter(|s| only.as_deref().is_none_or(|o| o == s.name)).collect();
    if specs.is_empty() {
        return Err("no such scene".into());
    }
    let bench = if long { sim::BenchAudio::load_long(&dir)? } else { sim::BenchAudio::load(&dir)? };
    Ok((specs, bench))
}

fn cli_sim(args: &[String]) -> Result<(), String> {
    let tuning = tuning_arg(args)?;
    let (specs, bench) = scene_set(args)?;
    println!("profile {} ({}); TV words all transcribed (worst case)", tuning.profile.name(), tuning.label);
    println!("{}", metrics::Metrics::header());
    for r in run_scenes(&specs, &bench, &tuning) {
        let (mix, run) = r?;
        println!("{}", metrics::measure(&mix, &run).row());
    }
    Ok(())
}

/// The quiet room and the noisy room (with any `--set`) on the same scenes,
/// side by side, and the noisy room against the §3.3 bars.
fn cli_eval(args: &[String]) -> Result<(), String> {
    let mut noisy_args = args.to_vec();
    noisy_args.extend(["--profile".to_string(), "noisy".to_string()]);
    let noisy = tuning_arg(&noisy_args)?;
    let (specs, bench) = scene_set(args)?;
    let (q_runs, n_runs) =
        std::thread::scope(|s| {
            let q = s.spawn(|| run_scenes(&specs, &bench, &Tuning::QUIET));
            let n = s.spawn(|| run_scenes(&specs, &bench, &noisy));
            (q.join().unwrap(), n.join().unwrap())
        });
    let mut fails = Vec::new();
    let mut rows = (Vec::new(), Vec::new());
    for ((spec, q), n) in specs.iter().zip(q_runs).zip(n_runs) {
        let (qm, nm) = {
            let (mix, run) = q?;
            let qm = metrics::measure(&mix, &run);
            let (mix, run) = n?;
            (qm, metrics::measure(&mix, &run))
        };
        rows.0.push(qm.row());
        rows.1.push(nm.row());
        let soft = spec.user_db < sim::USER_LEVEL_DB - 3.0;
        for b in metrics::bars(&qm, &nm, spec.tv_rel_db, soft, DEFAULT_END_SILENCE_MS) {
            if !b.pass {
                fails.push(format!("{:<26} {:<20} {}", spec.name, b.name, b.detail));
            }
        }
    }
    println!("quiet ({})\n{}", Tuning::QUIET.label, metrics::Metrics::header());
    rows.0.iter().for_each(|r| println!("{r}"));
    println!("noisy ({})\n{}", noisy.label, metrics::Metrics::header());
    rows.1.iter().for_each(|r| println!("{r}"));
    println!("bars missed: {}", fails.len());
    fails.iter().for_each(|f| println!("  {f}"));
    Ok(())
}

/// Tuning sweep in one process (no recompiling per value): the noisy room
/// (with any `--set`) and every combination of the `--vary key=a,b,c`
/// values, each run over the scenes and checked against the §3.3 bars. The
/// scene runs share one pool of threads. One summary line per variant;
/// `--detail` lists each variant's missed bars.
fn cli_sweep(args: &[String]) -> Result<(), String> {
    let mut noisy_args = args.to_vec();
    noisy_args.extend(["--profile".to_string(), "noisy".to_string()]);
    let base = tuning_arg(&noisy_args)?;
    let variants = auto::variants(base, args)?;
    // `--capture DIR [--capture-hint cold,-37,remember]`: the variants over a
    // debug capture too, closed loop ([`closed`]); `--capture-only` skips the
    // scenes.
    let capture_lines = match arg_value(args, "--capture") {
        Some(dir) => {
            let data = CaptureData::load(Path::new(&dir))?;
            let hints = closed::Hint::parse_list(&arg_value(args, "--capture-hint").unwrap_or_else(|| "cold".into()))?;
            let tunings: Vec<Tuning> = variants.iter().map(|v| v.1).collect();
            Some(closed::sweep(&data, &tunings, &hints, 4_000)?)
        }
        None => None,
    };
    if args.iter().any(|a| a == "--capture-only") {
        let lines = capture_lines.ok_or("--capture-only needs --capture DIR")?;
        for ((name, _), lines) in variants.iter().zip(lines) {
            println!("{}", if name.is_empty() { "base" } else { name });
            lines.iter().for_each(|l| println!("    {l}"));
        }
        return Ok(());
    }
    let (specs, bench) = scene_set(args)?;
    let detail = args.iter().any(|a| a == "--detail");
    // Job 0..n: the quiet room; then each variant's scenes.
    let tunings: Vec<Tuning> = std::iter::once(Tuning::QUIET).chain(variants.iter().map(|v| v.1)).collect();
    let jobs: Vec<(usize, usize)> = (0..tunings.len()).flat_map(|t| (0..specs.len()).map(move |s| (t, s))).collect();
    let next = std::sync::atomic::AtomicUsize::new(0);
    let results: std::sync::Mutex<Vec<Option<Result<metrics::Metrics, String>>>> = std::sync::Mutex::new((0..jobs.len()).map(|_| None).collect());
    let workers = std::thread::available_parallelism().map_or(8, |n| n.get());
    std::thread::scope(|s| {
        for _ in 0..workers {
            s.spawn(|| loop {
                let j = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some(&(t, sc)) = jobs.get(j) else { break };
                let r = run_scene(&specs[sc], &bench, &tunings[t]).map(|(mix, run)| metrics::measure(&mix, &run));
                results.lock().unwrap()[j] = Some(r);
            });
        }
    });
    let results: Vec<metrics::Metrics> =
        results.into_inner().unwrap().into_iter().map(|r| r.expect("every job ran")).collect::<Result<_, _>>()?;
    let n = specs.len();
    let quiet = &results[..n];
    println!("quiet ({})\n{}", Tuning::QUIET.label, metrics::Metrics::header());
    quiet.iter().for_each(|m| println!("{}", m.row()));
    println!("\nper variant: bars missed | false turns/10m per TV scene | false cuts | recall min | onset p50/p95 max over quiet | end p95 max | leak max | barges p50");
    for (v, (name, _)) in variants.iter().enumerate() {
        let noisy = &results[(v + 1) * n..(v + 2) * n];
        let mut fails = Vec::new();
        let (mut ft, mut cuts, mut recall, mut on50, mut on95, mut end95, mut leak) = (Vec::new(), 0, 1.0f64, i64::MIN, i64::MIN, 0, 0.0f64);
        let (mut tb, mut tbc, mut bp) = (0, 0, Vec::new());
        for ((spec, q), m) in specs.iter().zip(quiet).zip(noisy) {
            let soft = spec.user_db < sim::USER_LEVEL_DB - 3.0;
            for b in metrics::bars(q, m, spec.tv_rel_db, soft, DEFAULT_END_SILENCE_MS) {
                if !b.pass {
                    fails.push(format!("{:<26} {:<20} {}", spec.name, b.name, b.detail));
                }
            }
            if spec.tv_rel_db.is_some() {
                ft.push(format!("{:.0}", m.false_turns_per_10min()));
                end95 = end95.max(m.end_p95().unwrap_or(0));
                leak = leak.max(m.leak_rate());
            }
            cuts += m.false_cuts;
            if m.user_utterances > 0 {
                recall = recall.min(m.recall());
            }
            if let (Some(a), Some(b)) = (m.onset_p50(), q.onset_p50()) {
                on50 = on50.max(a - b);
            }
            if let (Some(a), Some(b)) = (m.onset_p95(), q.onset_p95()) {
                on95 = on95.max(a - b);
            }
            tb += m.true_barges_detected;
            tbc += m.true_barge_chances;
            if let Some(p) = m.barge_p50() {
                bp.push(p.to_string());
            }
        }
        println!(
            "{:>2} miss | ft {} | cuts {} | rec {:.3} | on +{}/+{} | end {} | leak {:.2} | barge {}/{} {} | {}",
            fails.len(),
            ft.join("/"),
            cuts,
            recall,
            on50,
            on95,
            end95,
            leak,
            tb,
            tbc,
            bp.join("/"),
            if name.is_empty() { "base" } else { name }
        );
        if detail {
            fails.iter().for_each(|f| println!("      {f}"));
        }
        if let Some(lines) = &capture_lines {
            lines[v].iter().for_each(|l| println!("      capture {l}"));
        }
    }
    Ok(())
}

/// Every VAD frame of one scene between `--from` and `--to` seconds: its
/// probability, level L, floor N, the machine's S, the echo mode, and who
/// was talking (u = user word, t = TV word, a = agent audible).
fn cli_frames(args: &[String]) -> Result<(), String> {
    let tuning = tuning_arg(args)?;
    arg_value(args, "--scene").ok_or("--scene NAME")?;
    let from: f64 = arg_value(args, "--from").and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let to: f64 = arg_value(args, "--to").and_then(|v| v.parse().ok()).unwrap_or(f64::INFINITY);
    let (specs, bench) = scene_set(args)?;
    let (mix, run) = run_scene(&specs[0], &bench, &tuning)?;
    let mut m = Machine::new(TurnConfig::for_tuning(Mode::Conversation, DEFAULT_END_SILENCE_MS, true, &tuning), EchoMode::Converging);
    let mut echo = EchoMode::Converging;
    for (wall, i) in &run.inputs {
        let acts = trace::feed(&mut m, i, *wall);
        if let Input::Echo(e) = i {
            echo = *e;
        }
        for a in &acts {
            let t = *wall as f64 / 1000.0;
            if t >= from && t <= to && !matches!(a, Action::Transcript { .. }) {
                println!("{t:>7.2}   {a:?}");
            }
        }
        if let Input::BargeIn { onset } = i {
            println!("{:>7.2}   BARGE-IN onset {:.2}", *wall as f64 / 1000.0, *onset as f64 / 16_000.0);
        }
        if let Input::Vad { prob, start, end, level_db, floor_db } = i {
            let (a, b) = (*start as f64 / 16_000.0, *end as f64 / 16_000.0);
            if a < from || a > to {
                continue;
            }
            let over = |w: &sim::HeardWord| w.start < b && w.end > a;
            let u = mix.words.iter().any(|w| w.who == sim::Who::User && over(w));
            let t = mix.words.iter().any(|w| w.who == sim::Who::Tv && over(w));
            let agent = run.replies.iter().any(|r| (*wall) >= r.start && (*wall) < r.end);
            let (lg, on, sus) = m.gate_view().unwrap_or((f32::NAN, false, false));
            println!(
                "{a:>7.3} p {prob:.2} L {level_db:>6.1} Lg {lg:>6.1}{}{} N {floor_db:>6.1} S {:>6.1} {:?} {}{}{}",
                if on { "O" } else { " " },
                if sus { "S" } else { " " },
                m.speech_level().map_or(f32::NAN, |s| s.0),
                echo,
                if u { "u" } else { "." },
                if t { "t" } else { "." },
                if agent { "a" } else { "." },
            );
        }
    }
    Ok(())
}

/// Where the scenes' frame levels sit (the level gate's tuning aid): per
/// scene, the percentiles of L over frames inside a user word, inside a TV
/// word only, and in neither, the floor N, and S after each sent turn.
fn cli_levels(args: &[String]) -> Result<(), String> {
    let tuning = tuning_arg(args)?;
    let (specs, bench) = scene_set(args)?;
    let pct = |v: &mut Vec<f32>| -> String {
        if v.is_empty() {
            return "-".into();
        }
        v.sort_by(f32::total_cmp);
        [10, 50, 90].iter().map(|p| format!("{:.0}", v[(p * (v.len() - 1)) / 100])).collect::<Vec<_>>().join("/")
    };
    println!("L percentiles 10/50/90 (dBFS), probability ≥ 0.5 frames only");
    for r in run_scenes(&specs, &bench, &tuning) {
        let (mix, run) = r?;
        let (mut user, mut tv, mut none, mut floor) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let mut m = Machine::new(TurnConfig::for_tuning(Mode::Conversation, DEFAULT_END_SILENCE_MS, true, &tuning), EchoMode::Converging);
        let mut speech = Vec::new();
        let smooth: usize = arg_value(args, "--smooth").and_then(|v| v.parse().ok()).unwrap_or(1);
        let mut hist: Vec<f32> = Vec::new();
        for (wall, i) in &run.inputs {
            let acts = trace::feed(&mut m, i, *wall);
            if acts.iter().any(|a| matches!(a, Action::Turn { .. })) {
                speech.push(format!("{:.0}", m.speech_level().map_or(f32::NAN, |s| s.0)));
            }
            if let Input::Vad { prob, start, end, level_db, floor_db } = i {
                floor.push(*floor_db);
                hist.push(*level_db);
                if hist.len() > smooth {
                    hist.remove(0);
                }
                let e = hist.iter().map(|l| 10f32.powf(l / 10.0)).sum::<f32>() / hist.len() as f32;
                let level_db = &(10.0 * e.log10());
                if *prob < 0.5 {
                    continue;
                }
                let (a, b) = (*start as f64 / 16_000.0, *end as f64 / 16_000.0);
                let over = |w: &sim::HeardWord| w.start < b && w.end > a;
                if mix.words.iter().any(|w| w.who == sim::Who::User && over(w)) {
                    user.push(*level_db);
                } else if mix.words.iter().any(|w| w.who == sim::Who::Tv && over(w)) {
                    tv.push(*level_db);
                } else {
                    none.push(*level_db);
                }
            }
        }
        println!(
            "{:<26} user {:>12} ({:>4})  tv {:>12} ({:>4})  other {:>12} ({:>4})  N {:>12}  S {}",
            mix.name,
            pct(&mut user.clone()),
            user.len(),
            pct(&mut tv.clone()),
            tv.len(),
            pct(&mut none.clone()),
            none.len(),
            pct(&mut floor),
            speech.join(" ")
        );
    }
    Ok(())
}

/// One scene's story in time order: the user's utterances, the agent's
/// replies, the machine's states, turns (words marked user / TV) and
/// barge-ins.
fn cli_timeline(args: &[String]) -> Result<(), String> {
    let tuning = tuning_arg(args)?;
    arg_value(args, "--scene").ok_or("--scene NAME")?;
    let (specs, bench) = scene_set(args)?;
    let (mix, run) = run_scene(&specs[0], &bench, &tuning)?;
    let mut lines: Vec<(u64, String)> = Vec::new();
    for (k, u) in mix.utterances.iter().enumerate() {
        let toks: Vec<&str> = u.words.iter().map(|&i| mix.words[i].token.as_str()).collect();
        lines.push(((u.start * 1000.0) as u64, format!("USER {k} {:.2}–{:.2}: {}", u.start, u.end, toks.join(" "))));
    }
    for r in &run.replies {
        lines.push((r.start, format!("agent reply {}–{}{}", r.start, r.end, if r.cut { " (cut)" } else { "" })));
    }
    let who = |t: &str| mix.words.iter().find(|w| w.token == t).map_or("?", |w| if w.who == sim::Who::Tv { "TV" } else { "u" });
    for (wall, a) in &run.actions {
        let line = match a {
            Action::State { state, .. } => format!("  state {state:?}"),
            Action::Turn { turn_id, text } => {
                let marked: Vec<String> = text.split_whitespace().map(|t| format!("{t}{}", if who(t) == "TV" { "*" } else { "" })).collect();
                format!("  TURN {turn_id}: {}", marked.join(" "))
            }
            Action::Interrupted { turn_id } => format!("  interrupted {turn_id}"),
            _ => continue,
        };
        lines.push((*wall, line));
    }
    for (wall, i) in &run.inputs {
        if let Input::BargeIn { onset } = i {
            lines.push((*wall, format!("  BARGE-IN onset {:.2}", *onset as f64 / 16_000.0)));
        }
    }
    lines.sort_by_key(|l| l.0);
    for (w, l) in lines {
        println!("{:>7.2} {l}", w as f64 / 1000.0);
    }
    Ok(())
}

fn cli_capture(args: &[String]) -> Result<(), String> {
    let dir = PathBuf::from(args.first().ok_or("capture DIR")?);
    let data = CaptureData::load(&dir)?;
    let cfg = data.trace.config();
    let profile = match arg_value(args, "--profile") {
        Some(_) => profile_arg(args)?,
        None => cfg.profile,
    };
    println!(
        "{}: {} frames ({:.1} s), {} VAD frames, {} inputs, {} actions; recorded as {}, replaying as {}",
        data.dir.display(),
        data.aec.len(),
        data.aec.len() as f64 * AEC_FRAME as f64 / 16_000.0,
        data.vads.len(),
        data.trace.inputs.len(),
        data.trace.actions.len(),
        cfg.profile.name(),
        profile.name()
    );
    let got = replay_recorded(&data.trace.inputs, cfg.turn_config(profile));
    let turns = |a: &[(u64, Action)]| a.iter().filter(|(_, a)| matches!(a, Action::Turn { .. })).count();
    let interrupts = |a: &[(u64, Action)]| a.iter().filter(|(_, a)| matches!(a, Action::Interrupted { .. })).count();
    println!("recorded: {} turns, {} interruptions", turns(&data.trace.actions), interrupts(&data.trace.actions));
    println!("replayed: {} turns, {} interruptions", turns(&got), interrupts(&got));
    match diff_actions(&data.trace.actions, &got) {
        None => println!("recorded mode: identical"),
        Some(d) => println!("recorded mode: {d}"),
    }
    if args.iter().any(|a| a == "--closed") {
        return closed::cli(&data, args);
    }
    if args.iter().any(|a| a == "--no-hold") {
        return closed::cli_no_hold(&data, args);
    }
    if args.iter().any(|a| a == "--full") {
        let (canceller, vad) = real_dsp().ok_or("no ONNX Runtime for Silero")?;
        let full = replay_full(&data, canceller, true, vad, profile)?;
        let diffs = diff_full(&data, &full, 1e-6);
        if diffs.is_empty() {
            println!("full DSP mode: cleaned bit-identical, VAD within 1e-6, barge-ins identical");
        } else {
            diffs.iter().for_each(|d| println!("full DSP mode: {d}"));
        }
    }
    Ok(())
}

fn cli_goldens(args: &[String]) -> Result<(), String> {
    let write = args.iter().any(|a| a == "--write");
    let dir = sim::bench_dir();
    if !sim::bench_available(&dir) {
        return Err(format!("the bench audio is not in {}", dir.display()));
    }
    let bench = sim::BenchAudio::load(&dir)?;
    let out = fixtures_dir();
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let mut failed = false;
    let specs = sim::scenes();
    for (spec, r) in specs.iter().zip(run_scenes(&specs, &bench, &Tuning::QUIET)) {
        let (_, run) = r?;
        let inputs_path = out.join(format!("{}.inputs.jsonl", spec.name));
        let actions_path = out.join(format!("{}.quiet.actions.jsonl", spec.name));
        if write {
            std::fs::write(&inputs_path, inputs_jsonl(&scene_header(spec, NoiseProfile::Quiet), &run.inputs)).map_err(|e| e.to_string())?;
            std::fs::write(&actions_path, actions_jsonl(&run.actions)).map_err(|e| e.to_string())?;
            println!("{}: {} inputs, {} actions written", spec.name, run.inputs.len(), run.actions.len());
            continue;
        }
        let want_inputs = Trace::load(&inputs_path)?.inputs;
        let want_actions = Trace::load(&actions_path)?.actions;
        let d = diff_inputs(&want_inputs, &run.inputs, 1e-6).or_else(|| diff_actions(&want_actions, &run.actions));
        match d {
            None => println!("{}: matches", spec.name),
            Some(d) => {
                failed = true;
                println!("{}: {d}", spec.name);
            }
        }
    }
    if failed {
        Err("goldens differ".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests;

/// `remember`: the noisy room with the per-mic level memory (WP7) as the
/// app runs it. First the user's earlier sessions on this mic: `--sessions`
/// (default 1) runs of the quiet scene at the scene's user level, each
/// starting from what the memory holds ([`levels::Memory`]), measured at its
/// end and saved as a session's end saves it (≥ 3 turns, blended). Then every
/// scene three ways: cold (the bootstrap), `--warm` (the harness's synthetic
/// level, the user's active level + 4 dB) and remembered (the stored level).
/// Prints each scene's rows and a summary: false turns per 10 min and in the
/// first minute, false cuts, recall, onset p95.
fn cli_remember(args: &[String]) -> Result<(), String> {
    use super::levels;
    let mut noisy_args = args.to_vec();
    noisy_args.extend(["--profile".to_string(), "noisy".to_string()]);
    let tuning = tuning_arg(&noisy_args)?;
    let sessions: u32 = match arg_value(args, "--sessions") {
        Some(v) => v.parse().map_err(|e| format!("--sessions {v}: {e}"))?,
        None => 1,
    };
    // The scenes cold; warm and remembered are set per run below.
    let cold_args: Vec<String> = args.iter().filter(|a| a.as_str() != "--warm").cloned().collect();
    let (specs, bench) = scene_set(&cold_args)?;
    let long = args.iter().any(|a| a == "--long");
    let all = if long { sim::long_scenes() } else { sim::scenes() };
    let masked = args.iter().any(|a| a == "--masked");

    // The earlier sessions, once per user level.
    let mut user_levels: Vec<f32> = specs.iter().map(|s| s.user_db).collect();
    user_levels.sort_by(f32::total_cmp);
    user_levels.dedup();
    let device = levels::Device { uid: "bench-mic".into(), name: "bench mic".into(), input_db: None };
    let mut remembered: Vec<(f32, Option<levels::Level>)> = Vec::new();
    println!("earlier sessions on the mic ({sessions} per user level, the quiet scene at that level):");
    for &user_db in &user_levels {
        let quiet = all
            .iter()
            .find(|s| s.user && s.tv_rel_db.is_none() && s.route == sim::Route::Speakers && s.user_db == user_db)
            .ok_or(format!("no quiet scene at {user_db} dBFS"))?;
        let quiet = sim::SceneSpec { tv_masked: masked, warm: false, ..quiet.clone() };
        let mut store = levels::Levels::new();
        for n in 1..=sessions {
            let mut memory = levels::Memory::new(store.clone(), Some(device.clone()), std::time::Instant::now());
            let hint = memory.hint();
            let (_, run) = run_scene_hinted(&quiet, &bench, &tuning, hint)?;
            let (db, turns) = speech_at_end(&run, &tuning, hint)?;
            let save = memory.save_due(db, turns, std::time::Instant::now(), true, || format!("session {n}"));
            println!(
                "  {:<12} user {:>5.1} dB  session {n}: from {:<9} → S {db:.1} dB over {turns} turns → stored {}",
                quiet.name,
                user_db,
                hint.map_or("bootstrap".to_string(), |h| format!("{h:.1} dB")),
                save.as_ref().map_or("nothing (under 3 turns)".to_string(), |s| format!("{:.1} dB ({} turns)", s.level.db, s.level.turns))
            );
            if let Some(s) = save {
                store.insert(device.uid.clone(), s.level);
            }
        }
        remembered.push((user_db, store.get(&device.uid).cloned()));
    }

    // Every scene three ways, on a pool.
    #[derive(Clone, Copy)]
    enum Way {
        Cold,
        Warm,
        Remembered,
    }
    let ways = [Way::Cold, Way::Warm, Way::Remembered];
    let hint_for = |spec: &sim::SceneSpec, way: Way| -> Option<f32> {
        match way {
            Way::Cold => None,
            Way::Warm => Some(spec.user_db + 4.0),
            Way::Remembered => remembered
                .iter()
                .find(|(u, _)| *u == spec.user_db)
                .and_then(|(_, l)| l.as_ref())
                .map(|l| l.db),
        }
    };
    let jobs: Vec<(usize, usize)> = (0..specs.len()).flat_map(|s| (0..ways.len()).map(move |w| (s, w))).collect();
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Option<Result<metrics::Metrics, String>>>> = Mutex::new((0..jobs.len()).map(|_| None).collect());
    let workers = std::thread::available_parallelism().map_or(8, |n| n.get());
    std::thread::scope(|s| {
        for _ in 0..workers {
            s.spawn(|| loop {
                let j = next.fetch_add(1, Ordering::Relaxed);
                let Some(&(sc, w)) = jobs.get(j) else { break };
                let spec = &specs[sc];
                let r = run_scene_hinted(spec, &bench, &tuning, hint_for(spec, ways[w])).map(|(mix, run)| metrics::measure(&mix, &run));
                results.lock().unwrap()[j] = Some(r);
            });
        }
    });
    let results: Vec<metrics::Metrics> =
        results.into_inner().unwrap().into_iter().map(|r| r.expect("every job ran")).collect::<Result<_, _>>()?;
    let names = ["cold", "warm (--warm)", "remembered"];
    for (w, name) in names.iter().enumerate() {
        println!("\nnoisy ({}), {name}\n{}", tuning.label, metrics::Metrics::header());
        for sc in 0..specs.len() {
            println!("{}", results[sc * ways.len() + w].row());
        }
    }
    println!("\nper scene: hint (dB) | false turns/10 min | false turns in the first minute | false cuts | recall | onset p95 (ms)");
    println!("{:<26} {:>22} {:>22} {:>22}", "", names[0], names[1], names[2]);
    for (sc, spec) in specs.iter().enumerate() {
        let cell = |w: usize| {
            let m = &results[sc * ways.len() + w];
            let first = m.false_turn_ms.iter().filter(|&&t| t < 60_000).count();
            let hint = hint_for(spec, ways[w]).map_or("  -  ".to_string(), |h| format!("{h:5.1}"));
            let recall = if m.user_utterances > 0 { format!("{:.3}", m.recall()) } else { "  -  ".into() };
            format!("{hint} {:>5.1} {:>2} {:>2} {recall} {:>4}", m.false_turns_per_10min(), first, m.false_cuts, m.onset_p95().map_or("-".into(), |v| v.to_string()))
        };
        println!("{:<26} {} | {} | {}", spec.name, cell(0), cell(1), cell(2));
    }
    Ok(())
}
