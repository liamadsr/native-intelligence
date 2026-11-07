//! Dev-only debug capture of a voice session (noise design §3.1): the audio
//! the DSP thread saw and everything the turn machine was fed, for replaying
//! offline ([`super::replay`]).
//!
//! **Off by default, and debug builds only** (the dev app). On only when the
//! app is launched with `DIAL8_VOICE_CAPTURE=1` (into
//! `~/Library/Application Support/ai.dial8.desktop/voice-captures/`) or
//! `DIAL8_VOICE_CAPTURE=<dir>`. The dev app is a bundle started by `open`, so
//! the variable goes in with `open --env` on a quit app (a running one
//! ignores it):
//!
//! ```text
//! osascript -e 'quit app "Dial8"'
//! open --env DIAL8_VOICE_CAPTURE=1 src-tauri/target/debug/bundle/macos/Dial8.app
//! ```
//!
//! Each session writes
//! `<base>/<yyyymmdd-hhmmss>-<sessionId>/`:
//!
//! - `mic_16k.wav`: every 10 ms capture frame before the canceller;
//! - `ref_16k.wav`: every render frame handed to the canceller, in order,
//!   the zero frame it gets when the reference is absent included. Only
//!   the read-aloud part: the system-audio echo reference (speakers,
//!   [`super::system_ref`]) is never written, so a capture made with it
//!   replays without it;
//! - `cleaned_16k.wav`: the canceller's output for every capture frame
//!   (the real cleaned audio also while muted, when transcription gets zeros);
//! - `aec.csv`: one row per capture frame, with how many render frames went
//!   in before it (the exact render/capture interleaving aec3 saw), the
//!   canceller's metrics and the echo mode;
//! - `frames.csv`: one row per VAD frame: probability, level, floor, and the
//!   barge-in detector's inputs and state;
//! - `events.jsonl`: every machine input and action ([`super::trace`]) and a
//!   header, from the session thread;
//! - `header.json` and, at the end, `meta.json` (drops, caps).
//!
//! Replay one offline: `cargo run --example voice_replay -- capture <dir>
//! [--full] [--profile noisy]` ([`super::replay`]).
//!
//! Local only. The DSP thread never blocks on it: everything goes through a
//! bounded queue to a writer thread, and a full queue drops (and counts) the
//! record. It stops writing at [`MAX_AUDIO_SAMPLES`] (30 min) or
//! [`MAX_BYTES`] (500 MB), whichever comes first.

use std::ffi::OsString;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::Arc;

use serde_json::{json, Value};

use super::events::EchoMode;
use super::SAMPLE_RATE;
use crate::audio::aec::{AecMetrics, AEC_FRAME};
use crate::audio::wav_writer::WavWriter;

/// The switch.
pub const ENV: &str = "DIAL8_VOICE_CAPTURE";
/// 30 minutes of mic audio.
pub const MAX_AUDIO_SAMPLES: u64 = 30 * 60 * SAMPLE_RATE;
/// 500 MB written.
pub const MAX_BYTES: u64 = 500 * 1024 * 1024;
/// Records in flight (~40 s of 10 ms frames).
const QUEUE: usize = 4_096;

/// Where captures go, from the variable's value: unset, empty, `0` or
/// `false` → off; `1` or `true` → `<app data>/voice-captures`; anything else
/// is a directory.
pub fn base_dir(value: Option<OsString>, app_data: Option<PathBuf>) -> Option<PathBuf> {
    let value = value?;
    let text = value.to_string_lossy();
    match text.trim() {
        "" | "0" | "false" | "off" => None,
        "1" | "true" | "on" => {
            Some(app_data.unwrap_or_else(|| std::env::temp_dir().join("dial8")).join("voice-captures"))
        }
        _ => Some(PathBuf::from(value)),
    }
}

/// A session's capture folder name: `<yyyymmdd-hhmmss>-<sessionId>` (the id
/// sanitized for a path).
pub fn session_dir_name(stamp: &str, session_id: &str) -> String {
    let id: String = session_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(64)
        .collect();
    format!("{stamp}-{id}")
}

/// One 10 ms capture frame, as the DSP thread processed it.
#[derive(Debug, Clone)]
pub struct AecFrame {
    /// The session audio clock at the frame's start.
    pub clock: u64,
    pub now_ms: u64,
    /// The render frames handed to the canceller before it (the zero frame
    /// of an absent reference is not in here: see `absent_zero`).
    pub renders: Vec<[f32; AEC_FRAME]>,
    /// No render frame arrived and the reference is absent: one zero frame
    /// went in instead.
    pub absent_zero: bool,
    pub capture: [f32; AEC_FRAME],
    pub cleaned: [f32; AEC_FRAME],
    pub metrics: AecMetrics,
    pub far_rms: f32,
    pub echo: EchoMode,
    pub muted: bool,
    pub headphones_hint: bool,
    /// The canceller and echo tracker were reset (a tap's stream was
    /// replaced) since the previous frame...
    pub resynced: bool,
    /// ...because the mic's stream was (the level gate starts over).
    pub mic_replaced: bool,
    /// Mute was toggled since the previous frame (the VAD, its buffer and
    /// the barge-in detector restart).
    pub mute_toggled: bool,
}

/// One VAD frame.
#[derive(Debug, Clone, PartialEq)]
pub struct VadRow {
    pub start: u64,
    pub end: u64,
    pub now_ms: u64,
    pub prob: f32,
    pub level_db: f32,
    pub floor_db: f32,
    /// The noisy room's level gate as barge-in saw it: the speech level S,
    /// and whether the frame was near enough to start a barge-in run
    /// (`near_on` column) and to go on with one (`near_sus`; `None`: no
    /// gate).
    pub gate: Option<(f32, bool, bool)>,
    /// `DspShared::barge_armed` as read for this frame.
    pub barge_armed: bool,
    /// `DspShared::barge_aside` as read for this frame (the last column;
    /// captures from before it have none).
    pub barge_aside: bool,
    pub echo: EchoMode,
    /// `agent_audible()` as read for this frame (`None`: not read, because
    /// the arming or the echo mode already ruled barge-in out).
    pub agent_audible: Option<bool>,
    /// The barge-in detector's run start after this frame.
    pub barge_run: Option<u64>,
    /// Barge-in fired on this frame (its onset).
    pub barge_fired: Option<u64>,
}

enum Msg {
    Frame(Box<AecFrame>),
    Vad(VadRow),
    Event(Value),
}

#[derive(Default)]
struct Shared {
    /// Stop taking records (a cap was reached, or writing failed).
    closed: AtomicBool,
    dropped_frames: AtomicU64,
    dropped_vads: AtomicU64,
    dropped_events: AtomicU64,
}

/// The sending side, shared by the DSP thread and the session. Cheap to
/// clone; the writer finishes the files when the last clone is dropped.
#[derive(Clone)]
pub struct Capture {
    tx: SyncSender<Msg>,
    shared: Arc<Shared>,
    dir: Arc<PathBuf>,
}

impl std::fmt::Debug for Capture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Capture").field("dir", &self.dir).finish()
    }
}

impl Capture {
    /// Create `dir` and its files, write `header`, start the writer thread.
    pub fn start(dir: &Path, header: Value) -> std::io::Result<Capture> {
        std::fs::create_dir_all(dir)?;
        let files = Files::create(dir, &header)?;
        let (tx, rx) = sync_channel(QUEUE);
        let shared = Arc::new(Shared::default());
        let writer_shared = shared.clone();
        let writer_dir = dir.to_path_buf();
        std::thread::Builder::new()
            .name("voice-capture".into())
            .spawn(move || write_loop(rx, files, writer_shared, writer_dir))?;
        Ok(Capture { tx, shared, dir: Arc::new(dir.to_path_buf()) })
    }

    #[allow(dead_code)]
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn send(&self, msg: Msg, dropped: &AtomicU64) {
        if self.shared.closed.load(Ordering::Relaxed) {
            return;
        }
        match self.tx.try_send(msg) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                dropped.fetch_add(1, Ordering::Relaxed);
            }
            Err(TrySendError::Disconnected(_)) => self.shared.closed.store(true, Ordering::Relaxed),
        }
    }

    /// DSP thread: one capture frame. Never blocks.
    pub fn frame(&self, frame: AecFrame) {
        self.send(Msg::Frame(Box::new(frame)), &self.shared.dropped_frames);
    }

    /// DSP thread: one VAD frame. Never blocks.
    pub fn vad(&self, row: VadRow) {
        self.send(Msg::Vad(row), &self.shared.dropped_vads);
    }

    /// Session: one `events.jsonl` record. Never blocks.
    pub fn event(&self, record: Value) {
        self.send(Msg::Event(record), &self.shared.dropped_events);
    }
}

pub const AEC_HEADER: &str = "clock,now_ms,render_frames_before,absent_zero,far_rms,erle_db,erl_db,delay_ms,converged,echo_mode,muted,headphones_hint,resynced,mute_toggled,mic_replaced";
pub const FRAMES_HEADER: &str = "start,end,now_ms,prob,level_db,floor_db,speech_db,near_on,near_sus,barge_armed,echo_mode,agent_audible,barge_run,barge_fired,barge_aside";

struct Files {
    mic: WavWriter,
    reference: WavWriter,
    cleaned: WavWriter,
    aec: BufWriter<File>,
    frames: BufWriter<File>,
    events: BufWriter<File>,
}

impl Files {
    fn create(dir: &Path, header: &Value) -> std::io::Result<Files> {
        let io = |e: hound::Error| std::io::Error::other(e.to_string());
        let wav = |name: &str| WavWriter::new(&dir.join(name), SAMPLE_RATE as u32, 1).map_err(io);
        std::fs::write(dir.join("header.json"), serde_json::to_vec_pretty(header).unwrap_or_default())?;
        let text = |name: &str, first: &str| -> std::io::Result<BufWriter<File>> {
            let mut w = BufWriter::new(File::create(dir.join(name))?);
            if !first.is_empty() {
                writeln!(w, "{first}")?;
            }
            Ok(w)
        };
        let mut events = text("events.jsonl", "")?;
        let mut head = header.clone();
        if let Value::Object(m) = &mut head {
            m.insert("k".into(), json!("header"));
        }
        writeln!(events, "{head}")?;
        Ok(Files {
            mic: wav("mic_16k.wav")?,
            reference: wav("ref_16k.wav")?,
            cleaned: wav("cleaned_16k.wav")?,
            aec: text("aec.csv", AEC_HEADER)?,
            frames: text("frames.csv", FRAMES_HEADER)?,
            events,
        })
    }
}

fn opt<T: std::fmt::Display>(v: Option<T>) -> String {
    v.map(|v| v.to_string()).unwrap_or_default()
}

/// f32 → the shortest decimal of its exact f64 value (reads back exactly).
fn x(v: f32) -> String {
    (v as f64).to_string()
}

fn echo_name(m: EchoMode) -> String {
    serde_json::to_value(m).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

fn aec_row(f: &AecFrame) -> String {
    format!(
        "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}\n",
        f.clock,
        f.now_ms,
        f.renders.len(),
        f.absent_zero as u8,
        x(f.far_rms),
        opt(f.metrics.erle_db.map(x)),
        opt(f.metrics.erl_db.map(x)),
        opt(f.metrics.delay_ms),
        f.metrics.converged as u8,
        echo_name(f.echo),
        f.muted as u8,
        f.headphones_hint as u8,
        f.resynced as u8,
        f.mute_toggled as u8,
        f.mic_replaced as u8,
    )
}

fn frames_row(r: &VadRow) -> String {
    // speech_db / near_on / near_sus: the noisy room's gate (empty without).
    format!(
        "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}\n",
        r.start,
        r.end,
        r.now_ms,
        x(r.prob),
        x(r.level_db),
        x(r.floor_db),
        opt(r.gate.map(|g| x(g.0))),
        opt(r.gate.map(|g| g.1 as u8)),
        opt(r.gate.map(|g| g.2 as u8)),
        r.barge_armed as u8,
        echo_name(r.echo),
        opt(r.agent_audible.map(|a| a as u8)),
        opt(r.barge_run),
        opt(r.barge_fired),
        r.barge_aside as u8,
    )
}

fn write_loop(rx: Receiver<Msg>, mut files: Files, shared: Arc<Shared>, dir: PathBuf) {
    let mut bytes: u64 = 0;
    let mut mic_samples: u64 = 0;
    let mut capped: Option<&'static str> = None;
    let mut error: Option<String> = None;
    let (mut frames, mut vads, mut events) = (0u64, 0u64, 0u64);
    for msg in rx.iter() {
        if capped.is_some() || error.is_some() {
            continue; // drain until every sender is gone
        }
        let wrote: Result<u64, String> = (|| -> Result<u64, String> {
            let e = |e: &dyn std::fmt::Display| e.to_string();
            match msg {
                Msg::Frame(f) => {
                    let mut n = 0u64;
                    for r in &f.renders {
                        files.reference.write_samples(r).map_err(|x| e(&x))?;
                        n += 4 * AEC_FRAME as u64;
                    }
                    if f.absent_zero {
                        files.reference.write_samples(&[0.0; AEC_FRAME]).map_err(|x| e(&x))?;
                        n += 4 * AEC_FRAME as u64;
                    }
                    files.mic.write_samples(&f.capture).map_err(|x| e(&x))?;
                    files.cleaned.write_samples(&f.cleaned).map_err(|x| e(&x))?;
                    let row = aec_row(&f);
                    files.aec.write_all(row.as_bytes()).map_err(|x| e(&x))?;
                    mic_samples += AEC_FRAME as u64;
                    frames += 1;
                    Ok(n + 8 * AEC_FRAME as u64 + row.len() as u64)
                }
                Msg::Vad(r) => {
                    let row = frames_row(&r);
                    files.frames.write_all(row.as_bytes()).map_err(|x| e(&x))?;
                    vads += 1;
                    Ok(row.len() as u64)
                }
                Msg::Event(v) => {
                    let line = format!("{v}\n");
                    files.events.write_all(line.as_bytes()).map_err(|x| e(&x))?;
                    events += 1;
                    Ok(line.len() as u64)
                }
            }
        })();
        match wrote {
            Ok(n) => bytes += n,
            Err(e) => {
                crate::log_to_file(&format!("[voice] debug capture: writing failed ({e}); stopped"));
                error = Some(e);
                shared.closed.store(true, Ordering::Relaxed);
            }
        }
        if capped.is_none() && error.is_none() {
            if mic_samples >= MAX_AUDIO_SAMPLES {
                capped = Some("30 minutes");
            } else if bytes >= MAX_BYTES {
                capped = Some("500 MB");
            }
            if let Some(what) = capped {
                crate::log_to_file(&format!("[voice] debug capture: {what} reached; stopped writing {}", dir.display()));
                shared.closed.store(true, Ordering::Relaxed);
            }
        }
    }
    let Files { mic, reference, cleaned, mut aec, frames: mut frames_w, events: mut events_w } = files;
    let _ = aec.flush();
    let _ = frames_w.flush();
    let _ = events_w.flush();
    let _ = mic.finalize();
    let _ = reference.finalize();
    let _ = cleaned.finalize();
    let meta = json!({
        "frames": frames,
        "vad_frames": vads,
        "events": events,
        "seconds": mic_samples as f64 / SAMPLE_RATE as f64,
        "bytes": bytes,
        "dropped": {
            "frames": shared.dropped_frames.load(Ordering::Relaxed),
            "vad_frames": shared.dropped_vads.load(Ordering::Relaxed),
            "events": shared.dropped_events.load(Ordering::Relaxed),
        },
        "capped": capped,
        "error": error,
    });
    let _ = std::fs::write(dir.join("meta.json"), serde_json::to_vec_pretty(&meta).unwrap_or_default());
    crate::log_to_file(&format!("[voice] debug capture closed: {} ({meta})", dir.display()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_switch() {
        let data = Some(PathBuf::from("/data"));
        assert_eq!(base_dir(None, data.clone()), None);
        for off in ["", "0", "false", " off "] {
            assert_eq!(base_dir(Some(off.into()), data.clone()), None, "{off:?}");
        }
        assert_eq!(base_dir(Some("1".into()), data.clone()), Some(PathBuf::from("/data/voice-captures")));
        assert_eq!(base_dir(Some("true".into()), None), Some(std::env::temp_dir().join("dial8/voice-captures")));
        assert_eq!(base_dir(Some("/tmp/caps".into()), data), Some(PathBuf::from("/tmp/caps")));
        assert_eq!(session_dir_name("20260926-101500", "voice-a/b c"), "20260926-101500-voice-a_b_c");
    }

    #[test]
    fn writes_every_file_and_closes_when_the_senders_go() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("s1");
        let cap = Capture::start(&dir, json!({ "session_id": "s1" })).unwrap();
        let other = cap.clone();
        cap.frame(AecFrame {
            clock: 0,
            now_ms: 10,
            renders: vec![[0.25; AEC_FRAME], [0.5; AEC_FRAME]],
            absent_zero: false,
            capture: [0.1; AEC_FRAME],
            cleaned: [0.05; AEC_FRAME],
            metrics: AecMetrics { erle_db: Some(3.5), delay_ms: Some(40), erl_db: None, converged: false },
            far_rms: 0.4,
            echo: EchoMode::Converging,
            muted: false,
            headphones_hint: true,
            resynced: false,
            mic_replaced: false,
            mute_toggled: false,
        });
        cap.frame(AecFrame {
            clock: 160,
            now_ms: 20,
            renders: vec![],
            absent_zero: true,
            capture: [0.2; AEC_FRAME],
            cleaned: [0.1; AEC_FRAME],
            metrics: AecMetrics::default(),
            far_rms: 0.0,
            echo: EchoMode::Converging,
            muted: false,
            headphones_hint: true,
            resynced: true,
            mic_replaced: true,
            mute_toggled: false,
        });
        other.vad(VadRow {
            start: 0,
            end: 512,
            now_ms: 30,
            prob: 0.75,
            level_db: -30.5,
            floor_db: -60.0,
            gate: Some((-24.0, false, true)),
            barge_armed: true,
            barge_aside: false,
            echo: EchoMode::Headphones,
            agent_audible: Some(true),
            barge_run: Some(0),
            barge_fired: None,
        });
        other.event(json!({ "k": "tick", "w": 50, "c": 512 }));
        drop(cap);
        drop(other);
        // The writer finishes on its own; wait for meta.json.
        let meta = dir.join("meta.json");
        for _ in 0..200 {
            if meta.is_file() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let meta: Value = serde_json::from_slice(&std::fs::read(&meta).unwrap()).unwrap();
        assert_eq!(meta["frames"], 2);
        assert_eq!(meta["dropped"]["frames"], 0);
        let read = |name: &str| -> Vec<f32> {
            hound::WavReader::open(dir.join(name)).unwrap().samples::<f32>().map(|s| s.unwrap()).collect()
        };
        let reference = read("ref_16k.wav");
        assert_eq!(reference.len(), 3 * AEC_FRAME, "two renders, then the absent zero frame");
        assert_eq!((reference[0], reference[AEC_FRAME], reference[2 * AEC_FRAME]), (0.25, 0.5, 0.0));
        assert_eq!(read("mic_16k.wav").len(), 2 * AEC_FRAME);
        assert_eq!(read("cleaned_16k.wav")[AEC_FRAME], 0.1);
        let aec = std::fs::read_to_string(dir.join("aec.csv")).unwrap();
        let rows: Vec<&str> = aec.lines().collect();
        assert_eq!(rows[0], AEC_HEADER);
        assert_eq!(rows[1], "0,10,2,0,0.4000000059604645,3.5,,40,0,converging,0,1,0,0,0");
        assert_eq!(rows[2], "160,20,0,1,0,,,,0,converging,0,1,1,0,1");
        let frames = std::fs::read_to_string(dir.join("frames.csv")).unwrap();
        assert_eq!(frames.lines().nth(1).unwrap(), "0,512,30,0.75,-30.5,-60,-24,0,1,1,headphones,1,0,,0");
        let events = std::fs::read_to_string(dir.join("events.jsonl")).unwrap();
        let lines: Vec<Value> = events.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines[0], json!({ "k": "header", "session_id": "s1" }));
        assert_eq!(lines[1], json!({ "k": "tick", "w": 50, "c": 512 }));
        assert!(dir.join("header.json").is_file());
    }
}
