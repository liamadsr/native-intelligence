//! Synthetic scenes for the replay harness (noise design §3.2): a user, a
//! "TV" and an agent mixed from local audio, run closed-loop through the real
//! DSP path ([`DspCore::step`] on taps, the canceller and VAD given) and the
//! turn machine, with a scripted transcription and a scripted agent.
//!
//! - **User**: utterances cut from the bench's `interview.wav` at its
//!   Deepgram word timings, placed on a timeline, active speech level
//!   [`USER_LEVEL_DB`].
//! - **TV**: `teams-call.wav` through a synthetic room (sparse exponential
//!   impulse response, RT60 ~0.5 s), `tv_rel_db` below the user's active
//!   speech level. Active levels are the RMS over the reference word spans
//!   (a stand-in for P.56).
//! - **Agent**: `fast-talk.wav`, replying [`REPLY_LATENCY_MS`] after every
//!   turn for `reply_s`, cut off by barge-in. On speakers its voice comes
//!   back into the mic through a sparse echo path.
//! - **Transcription**: every word of the user and of the TV is heard
//!   (worst case), as tokens `u<n>` / `t<n>`: interim results at each word's
//!   end + 200 ms, the utterance's final at its end + 300 ms, and a finalize
//!   answered in ~100 ms with every word heard so far.
//!
//! No downloads: only `~/code/speech-audio-bench/*.wav` and their
//! `*.deepgram.json`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::sync::mpsc;

use crate::audio::aec::{EchoCanceller, AEC_FRAME};
use crate::audio::tap::tap_channel;
use crate::modules::stt::{SttResults, SttWord, VoiceSttEvent};
use crate::voice::capture::Capture;
use crate::voice::dsp::{AudioSink, DspCore, DspEvent, DspShared, SpeechControl};
use crate::voice::events::EchoMode;
use crate::voice::profile::Tuning;
use crate::voice::trace::{self, Input};
use crate::voice::turn::{Action, Machine, Mode, TurnConfig, DEFAULT_END_SILENCE_MS};
use crate::voice::vad::Vad;
use crate::voice::SAMPLE_RATE;

pub const FS: usize = SAMPLE_RATE as usize;
/// The user's active speech level at the mic (a laptop mic, arm's length).
pub const USER_LEVEL_DB: f32 = -26.0;
/// The agent's voice on the reference.
pub const AGENT_LEVEL_DB: f32 = -20.0;
/// Room noise at the mic.
pub const NOISE_DB: f32 = -70.0;
/// A turn → the agent starts talking this much later.
pub const REPLY_LATENCY_MS: u64 = 1_000;
/// Transcription is ready this long after the start.
pub const STT_READY_MS: u64 = 300;

// ─── randomness, levels ─────────────────────────────────────────────────────

/// Deterministic xorshift.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }
    pub fn next_f32(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 40) as f32 / (1u64 << 24) as f32
    }
    pub fn gauss(&mut self) -> f32 {
        let u1 = self.next_f32().max(1e-7);
        let u2 = self.next_f32();
        (-2.0 * u1.ln()).sqrt() * (2.0 * std::f32::consts::PI * u2).cos()
    }
}

pub fn db_to_amp(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

/// RMS over the given spans (seconds) of `x`.
pub fn active_rms(x: &[f32], spans: &[(f64, f64)]) -> f32 {
    let (mut sq, mut n) = (0f64, 0usize);
    for &(a, b) in spans {
        let (a, b) = (((a * FS as f64) as usize).min(x.len()), ((b * FS as f64) as usize).min(x.len()));
        for &v in &x[a..b.max(a)] {
            sq += (v as f64) * (v as f64);
            n += 1;
        }
    }
    if n == 0 {
        0.0
    } else {
        (sq / n as f64).sqrt() as f32
    }
}

// ─── the bench ──────────────────────────────────────────────────────────────

/// One word of a reference transcript.
#[derive(Debug, Clone, PartialEq)]
pub struct Word {
    pub text: String,
    pub start: f64,
    pub end: f64,
}

/// Local audio with its word timings, 16 kHz mono, seconds from `offset`.
pub struct Clip {
    pub audio: Vec<f32>,
    pub words: Vec<Word>,
}

pub fn bench_dir() -> PathBuf {
    std::env::var_os("NI_SPEECH_BENCH")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("code/speech-audio-bench"))
}

/// The bench files the scenes need are all there.
pub fn bench_available(dir: &Path) -> bool {
    ["interview", "teams-call", "fast-talk"]
        .iter()
        .all(|n| dir.join(format!("{n}.wav")).is_file() && dir.join(format!("{n}.deepgram.json")).is_file())
}

/// `[from, to)` seconds of `<dir>/<name>.wav` (16 kHz mono) and the words
/// wholly inside it, times relative to `from`.
pub fn load_clip(dir: &Path, name: &str, from: f64, to: f64) -> Result<Clip, String> {
    let wav = dir.join(format!("{name}.wav"));
    let mut r = hound::WavReader::open(&wav).map_err(|e| format!("{}: {e}", wav.display()))?;
    let spec = r.spec();
    let ch = spec.channels as usize;
    let rate = spec.sample_rate;
    let first = (from * rate as f64) as u32;
    let frames = ((to - from) * rate as f64) as usize;
    r.seek(first.min(r.duration())).map_err(|e| e.to_string())?;
    let n = frames * ch;
    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => r.samples::<f32>().take(n).map(|s| s.unwrap_or(0.0)).collect(),
        hound::SampleFormat::Int => {
            let scale = (1i64 << (spec.bits_per_sample - 1)) as f32;
            r.samples::<i32>().take(n).map(|s| s.unwrap_or(0) as f32 / scale).collect()
        }
    };
    let mono: Vec<f32> = interleaved.chunks_exact(ch).map(|c| c.iter().sum::<f32>() / ch as f32).collect();
    let mut rs = crate::audio::resample::StreamResampler::new(rate, SAMPLE_RATE as u32)?;
    let mut audio = Vec::with_capacity(mono.len() * FS / rate as usize + 2048);
    for chunk in mono.chunks(4096) {
        audio.reserve(rs.max_output_frames(chunk.len()));
        rs.process(chunk, &mut audio);
    }
    rs.flush(&mut audio);
    let json = dir.join(format!("{name}.deepgram.json"));
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&json).map_err(|e| format!("{}: {e}", json.display()))?)
        .map_err(|e| e.to_string())?;
    let words = v["results"]["channels"][0]["alternatives"][0]["words"]
        .as_array()
        .ok_or("no words")?
        .iter()
        .filter_map(|w| {
            let (s, e) = (w["start"].as_f64()?, w["end"].as_f64()?);
            let text = w["punctuated_word"].as_str().or(w["word"].as_str())?.to_string();
            (s >= from && e <= to).then_some(Word { text, start: s - from, end: e - from })
        })
        .collect();
    Ok(Clip { audio, words })
}

/// Cut a word stream into utterances of 1.5–4 s at the pauses between words.
pub fn utterances(words: &[Word]) -> Vec<Vec<Word>> {
    let mut out = Vec::new();
    let mut cur: Vec<Word> = Vec::new();
    for (i, w) in words.iter().enumerate() {
        cur.push(w.clone());
        let dur = w.end - cur[0].start;
        let gap = words.get(i + 1).map_or(f64::INFINITY, |n| n.start - w.end);
        if (dur >= 1.5 && gap >= 0.12) || dur >= 4.0 || gap.is_infinite() {
            out.push(std::mem::take(&mut cur));
        }
    }
    out
}

// ─── scenes ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// The agent's voice comes back into the mic.
    Speakers,
    /// It doesn't (and the route's name says headphones).
    Headphones,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SceneSpec {
    pub name: &'static str,
    pub duration_s: f64,
    /// The user talks.
    pub user: bool,
    /// TV speech this many dB below the user's active speech level.
    pub tv_rel_db: Option<f32>,
    pub route: Route,
    /// Each agent reply lasts this long (unless cut off).
    pub reply_s: f64,
    /// The user's next utterance starts this long after their last one ended.
    pub user_gap_s: f64,
    /// The user's active speech level at the mic (dBFS).
    pub user_db: f32,
    /// The transcription hears only the loudest talker: a TV word that
    /// overlaps a user word isn't heard. Otherwise every TV word is (worst
    /// case, the goldens').
    pub tv_masked: bool,
    /// The noisy room starts from the user's own speech level (what a
    /// per-device level remembered from earlier sessions gives, WP7)
    /// instead of the bootstrap...
    pub warm: bool,
    /// ...this many dB over it (a level left too high: one loud turn, or
    /// another device's).
    pub warm_offset_db: f32,
}

/// The bench scenes (60 s each).
pub fn scenes() -> Vec<SceneSpec> {
    let base = SceneSpec {
        name: "",
        duration_s: 60.0,
        user: true,
        tv_rel_db: None,
        route: Route::Speakers,
        reply_s: 3.0,
        user_gap_s: 6.0,
        user_db: USER_LEVEL_DB,
        tv_masked: false,
        warm: false,
        warm_offset_db: 0.0,
    };
    vec![
        SceneSpec { name: "quiet-room", ..base.clone() },
        SceneSpec { name: "tv-20db", tv_rel_db: Some(-20.0), ..base.clone() },
        SceneSpec { name: "tv-15db", tv_rel_db: Some(-15.0), ..base.clone() },
        SceneSpec { name: "tv-10db", tv_rel_db: Some(-10.0), ..base.clone() },
        SceneSpec { name: "tv-only-10db", user: false, tv_rel_db: Some(-10.0), ..base.clone() },
        SceneSpec { name: "barge-speakers", reply_s: 6.0, user_gap_s: 3.0, ..base.clone() },
        SceneSpec {
            name: "barge-headphones-tv-15db",
            route: Route::Headphones,
            tv_rel_db: Some(-15.0),
            reply_s: 6.0,
            user_gap_s: 3.0,
            ..base
        },
    ]
}

/// The tuning set (noise design §3.3): the golden scenes at three times the
/// length (3 minutes each, from [`BenchAudio::load_long`]), and a soft
/// speaker 6 dB under the noisy room's bootstrap speech level (active −42
/// dBFS: its turn level S ≈ −38), in a quiet room and with a TV; and two
/// softer speakers still (active −46 and −48 dBFS) in a quiet room, under
/// the bootstrap's whole acceptance window: Auto must never switch on them
/// (their own speech is more than the far margin under the bootstrap S).
pub fn long_scenes() -> Vec<SceneSpec> {
    let mut out: Vec<SceneSpec> = scenes().into_iter().map(|s| SceneSpec { duration_s: 180.0, ..s }).collect();
    let soft = SceneSpec { name: "soft-quiet", user_db: USER_LEVEL_DB - 16.0, ..out[0].clone() };
    out.push(SceneSpec { name: "soft-tv-15db", tv_rel_db: Some(-15.0), ..soft.clone() });
    out.push(soft.clone());
    out.push(SceneSpec { name: "soft-quiet-46", user_db: USER_LEVEL_DB - 20.0, ..soft.clone() });
    out.push(SceneSpec { name: "soft-quiet-48", user_db: USER_LEVEL_DB - 22.0, ..soft });
    out
}

/// Who said a word.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Who {
    User,
    Tv,
}

/// A word the scripted transcription hears.
#[derive(Debug, Clone, PartialEq)]
pub struct HeardWord {
    /// `u<n>` or `t<n>`.
    pub token: String,
    pub who: Who,
    pub start: f64,
    pub end: f64,
    /// The user utterance it belongs to.
    pub utterance: Option<usize>,
}

/// One placed user utterance (seconds on the scene clock).
#[derive(Debug, Clone, PartialEq)]
pub struct Utterance {
    pub start: f64,
    pub end: f64,
    /// Indexes into [`Mix::words`].
    pub words: Vec<usize>,
}

/// A scene's open-loop audio and ground truth.
pub struct Mix {
    pub name: String,
    pub duration_s: f64,
    /// User + TV + noise at the mic (the agent's echo is added live).
    pub bed: Vec<f32>,
    /// The agent's voice, consumed reply by reply.
    pub agent_voice: Vec<f32>,
    pub words: Vec<HeardWord>,
    pub utterances: Vec<Utterance>,
    pub route: Route,
    /// Sparse echo path (delay in samples, gain); empty on headphones.
    pub echo: Vec<(usize, f32)>,
    pub reply_s: f64,
    /// TV-only scene: every turn is a false one.
    pub tv_only: bool,
}

/// A laptop-speaker echo path: direct sound at 45 ms, a few reflections, a
/// sparse tail to 300 ms. ~−11 dB overall.
pub fn speaker_echo_path() -> Vec<(usize, f32)> {
    let ms = |t: f32| (t * FS as f32 / 1000.0) as usize;
    let mut h = vec![(ms(45.0), 0.25), (ms(52.0), 0.1), (ms(61.0), -0.07), (ms(83.0), 0.05), (ms(120.0), -0.03)];
    let mut rng = Rng::new(17);
    for k in 0..40 {
        let t = 125.0 + 175.0 * k as f32 / 40.0;
        h.push((ms(t) + (rng.next_f32() * 20.0) as usize, 0.02 * rng.gauss() * (-(t - 120.0) / 60.0).exp()));
    }
    h
}

/// A room between the TV and the mic: sparse taps, exponential decay, RT60
/// `rt60` s, direct sound first.
pub fn room_response(rt60: f32, seed: u64) -> Vec<(usize, f32)> {
    let mut rng = Rng::new(seed);
    let mut h = vec![(0usize, 1.0f32)];
    let len = (rt60 * FS as f32) as usize;
    for _ in 0..200 {
        let d = 40 + (rng.next_f32() * len as f32) as usize;
        let t = d as f32 / FS as f32;
        h.push((d, 0.25 * rng.gauss() * (-6.9078 * t / rt60).exp()));
    }
    h
}

pub fn convolve_sparse(x: &[f32], h: &[(usize, f32)]) -> Vec<f32> {
    let mut y = vec![0.0f32; x.len()];
    for &(d, g) in h {
        if d >= x.len() {
            continue;
        }
        for (yn, xn) in y[d..].iter_mut().zip(x) {
            *yn += g * xn;
        }
    }
    y
}

/// The bench audio the scenes are made of, loaded once.
pub struct BenchAudio {
    /// The user's utterances (cut from interview.wav, each with its words).
    pub user: Vec<(Vec<f32>, Vec<Word>)>,
    /// teams-call.wav through the room, and its words.
    pub tv: Clip,
    /// fast-talk.wav, normalized to [`AGENT_LEVEL_DB`].
    pub agent: Vec<f32>,
}

impl BenchAudio {
    /// The three clips are read (and the TV put through the room) in
    /// parallel.
    pub fn load(dir: &Path) -> Result<BenchAudio, String> {
        Self::load_spans(dir, 120.0, 90.0)
    }

    /// Enough for the 3-minute tuning scenes ([`long_scenes`]).
    pub fn load_long(dir: &Path) -> Result<BenchAudio, String> {
        Self::load_spans(dir, 205.0, 205.0)
    }

    /// The user from `interview.wav` up to `user_to` s, the TV from
    /// `teams-call.wav` 20 s to `tv_to` s.
    fn load_spans(dir: &Path, user_to: f64, tv_to: f64) -> Result<BenchAudio, String> {
        let (interview, tv, fast) = std::thread::scope(|s| {
            let interview = s.spawn(|| load_clip(dir, "interview", 0.0, user_to));
            let tv = s.spawn(|| {
                load_clip(dir, "teams-call", 20.0, tv_to)
                    .map(|raw| Clip { audio: convolve_sparse(&raw.audio, &room_response(0.5, 5)), words: raw.words })
            });
            let fast = s.spawn(|| load_clip(dir, "fast-talk", 5.0, 125.0));
            let join = |h: std::thread::ScopedJoinHandle<'_, Result<Clip, String>>| h.join().unwrap_or_else(|_| Err("panicked".into()));
            (join(interview), join(tv), join(fast))
        });
        let (interview, tv, fast) = (interview?, tv?, fast?);
        let mut user = Vec::new();
        for u in utterances(&interview.words) {
            let (a, b) = (u[0].start - 0.04, u.last().unwrap().end + 0.06);
            let (a_i, b_i) = (((a.max(0.0)) * FS as f64) as usize, ((b * FS as f64) as usize).min(interview.audio.len()));
            let mut seg = interview.audio[a_i..b_i].to_vec();
            fade(&mut seg);
            let words = u.iter().map(|w| Word { text: w.text.clone(), start: w.start - a, end: w.end - a }).collect();
            user.push((seg, words));
        }
        let spans: Vec<(f64, f64)> = fast.words.iter().map(|w| (w.start, w.end)).collect();
        let g = db_to_amp(AGENT_LEVEL_DB) / active_rms(&fast.audio, &spans).max(1e-6);
        let agent = fast.audio.iter().map(|v| v * g).collect();
        Ok(BenchAudio { user, tv, agent })
    }
}

/// 10 ms fades at both ends.
fn fade(x: &mut [f32]) {
    let n = (FS / 100).min(x.len() / 2);
    let len = x.len();
    for i in 0..n {
        let g = i as f32 / n as f32;
        x[i] *= g;
        x[len - 1 - i] *= g;
    }
}

/// Place a scene's audio: the user's utterances, the TV, the noise.
pub fn build_mix(spec: &SceneSpec, bench: &BenchAudio) -> Mix {
    let n = (spec.duration_s * FS as f64) as usize;
    let mut user_track = vec![0.0f32; n];
    let mut words = Vec::new();
    let mut utts = Vec::new();
    let mut spans = Vec::new();
    if spec.user {
        let mut t = 2.0f64;
        let mut next_word = 0usize;
        for (seg, ws) in &bench.user {
            let len_s = seg.len() as f64 / FS as f64;
            if t + len_s > spec.duration_s - 3.0 {
                break;
            }
            let at = (t * FS as f64) as usize;
            user_track[at..at + seg.len()].copy_from_slice(seg);
            let mut idx = Vec::new();
            for w in ws {
                idx.push(words.len());
                words.push(HeardWord {
                    token: format!("u{next_word}"),
                    who: Who::User,
                    start: t + w.start,
                    end: t + w.end,
                    utterance: Some(utts.len()),
                });
                spans.push((t + w.start, t + w.end));
                next_word += 1;
            }
            let (s, e) = (t + ws[0].start, t + ws.last().unwrap().end);
            utts.push(Utterance { start: s, end: e, words: idx });
            t = e + spec.user_gap_s;
        }
        let g = db_to_amp(spec.user_db) / active_rms(&user_track, &spans).max(1e-6);
        user_track.iter_mut().for_each(|v| *v *= g);
    }
    let mut bed = user_track;
    if let Some(rel) = spec.tv_rel_db {
        let tv = &bench.tv;
        let tv_spans: Vec<(f64, f64)> = tv.words.iter().map(|w| (w.start, w.end)).collect();
        let g = db_to_amp(spec.user_db + rel) / active_rms(&tv.audio, &tv_spans).max(1e-6);
        for (b, v) in bed.iter_mut().zip(&tv.audio) {
            *b += g * v;
        }
        let user_spans = spans.clone();
        let masked = |w: &Word| spec.tv_masked && user_spans.iter().any(|&(a, b)| w.start < b && w.end > a);
        for (i, w) in tv.words.iter().enumerate().filter(|(_, w)| w.end < spec.duration_s && !masked(w)) {
            words.push(HeardWord { token: format!("t{i}"), who: Who::Tv, start: w.start, end: w.end, utterance: None });
        }
    }
    let mut rng = Rng::new(99);
    let noise = db_to_amp(NOISE_DB);
    bed.iter_mut().for_each(|v| *v += noise * rng.gauss());
    words.sort_by(|a, b| a.start.total_cmp(&b.start));
    // Utterance word indexes after the sort.
    for u in &mut utts {
        u.words.clear();
    }
    for (i, w) in words.iter().enumerate() {
        if let Some(k) = w.utterance {
            utts[k].words.push(i);
        }
    }
    Mix {
        name: spec.name.to_string(),
        duration_s: spec.duration_s,
        bed,
        agent_voice: bench.agent.clone(),
        words,
        utterances: utts,
        route: spec.route,
        echo: if spec.route == Route::Speakers { speaker_echo_path() } else { Vec::new() },
        reply_s: spec.reply_s,
        tv_only: !spec.user,
    }
}

// ─── the scripted transcription ─────────────────────────────────────────────

struct Stt {
    words: Vec<HeardWord>,
    finalized: Vec<bool>,
    /// (wall ms, event) not yet delivered, in order.
    queue: Vec<(u64, Pending)>,
}

#[derive(Debug, Clone)]
enum Pending {
    Ready,
    Interim { utt: usize, upto: usize },
    Final { utt: usize },
    FinalizeSent { seq: u64 },
    FlushFinal { heard_until: f64 },
    Finalized { seq: u64 },
}

/// The transcription's own utterances: words (user and TV together) with
/// less than 0.6 s between them.
fn stt_utterances(words: &[HeardWord]) -> Vec<Vec<usize>> {
    let mut out: Vec<Vec<usize>> = Vec::new();
    let mut last_end = f64::NEG_INFINITY;
    for (i, w) in words.iter().enumerate() {
        if w.start - last_end >= 0.6 || out.is_empty() {
            out.push(Vec::new());
        }
        out.last_mut().unwrap().push(i);
        last_end = last_end.max(w.end);
    }
    out
}

fn wall_of(audio_s: f64) -> u64 {
    // Audio at time t reaches the session one 10 ms block later.
    (audio_s * 1000.0).ceil() as u64 + 10
}

impl Stt {
    fn new(words: Vec<HeardWord>) -> (Stt, Vec<Vec<usize>>) {
        let utts = stt_utterances(&words);
        let mut queue = vec![(STT_READY_MS, Pending::Ready)];
        for (u, idx) in utts.iter().enumerate() {
            for (k, &i) in idx.iter().enumerate() {
                queue.push((wall_of(words[i].end) + 200, Pending::Interim { utt: u, upto: k }));
            }
            let end = idx.iter().map(|&i| words[i].end).fold(0.0, f64::max);
            queue.push((wall_of(end) + 300, Pending::Final { utt: u }));
        }
        let finalized = vec![false; words.len()];
        let mut stt = Stt { words, finalized, queue };
        stt.sort();
        (stt, utts)
    }

    fn sort(&mut self) {
        // Stable: same-time events keep their order. Nothing before Ready.
        for e in self.queue.iter_mut() {
            if !matches!(e.1, Pending::Ready) {
                e.0 = e.0.max(STT_READY_MS + 1);
            }
        }
        self.queue.sort_by_key(|e| e.0);
    }

    fn finalize(&mut self, seq: u64, now: u64) {
        let heard_until = (now.saturating_sub(10)) as f64 / 1000.0;
        self.queue.push((now + 5, Pending::FinalizeSent { seq }));
        self.queue.push((now + 100, Pending::FlushFinal { heard_until }));
        self.queue.push((now + 105, Pending::Finalized { seq }));
        self.sort();
    }

    fn word(&self, i: usize) -> SttWord {
        let w = &self.words[i];
        SttWord { word: w.token.clone(), start: w.start, end: w.end, confidence: 0.9 }
    }

    fn results(&self, idx: &[usize], is_final: bool, from_finalize: bool) -> VoiceSttEvent {
        let words: Vec<SttWord> = idx.iter().map(|&i| self.word(i)).collect();
        let start = words.first().map_or(0.0, |w| w.start);
        let end = words.last().map_or(0.0, |w| w.end);
        VoiceSttEvent::Results(SttResults {
            is_final,
            speech_final: is_final && !from_finalize,
            from_finalize,
            transcript: words.iter().map(|w| w.word.clone()).collect::<Vec<_>>().join(" "),
            start,
            duration: end - start,
            words,
        })
    }

    /// Events due at or before `now`.
    fn due(&mut self, now: u64, utts: &[Vec<usize>]) -> Vec<VoiceSttEvent> {
        let mut out = Vec::new();
        while self.queue.first().is_some_and(|e| e.0 <= now) {
            let (_, p) = self.queue.remove(0);
            match p {
                Pending::Ready => out.push(VoiceSttEvent::Ready),
                Pending::Interim { utt, upto } => {
                    let idx: Vec<usize> = utts[utt][..=upto].iter().copied().filter(|&i| !self.finalized[i]).collect();
                    if !idx.is_empty() {
                        out.push(self.results(&idx, false, false));
                    }
                }
                Pending::Final { utt } => {
                    let idx: Vec<usize> = utts[utt].iter().copied().filter(|&i| !self.finalized[i]).collect();
                    if !idx.is_empty() {
                        idx.iter().for_each(|&i| self.finalized[i] = true);
                        out.push(self.results(&idx, true, false));
                    }
                }
                Pending::FinalizeSent { seq } => out.push(VoiceSttEvent::FinalizeSent { seq }),
                Pending::FlushFinal { heard_until } => {
                    let idx: Vec<usize> =
                        (0..self.words.len()).filter(|&i| !self.finalized[i] && self.words[i].end <= heard_until).collect();
                    if !idx.is_empty() {
                        idx.iter().for_each(|&i| self.finalized[i] = true);
                        out.push(self.results(&idx, true, true));
                    }
                }
                Pending::Finalized { seq } => out.push(VoiceSttEvent::Finalized { seq }),
            }
        }
        out
    }
}

// ─── the closed loop ────────────────────────────────────────────────────────

/// Barge-in's view of the scripted agent.
#[derive(Clone, Default)]
struct SimSpeech {
    audible: Arc<AtomicBool>,
    cancels: Arc<AtomicUsize>,
}

impl SpeechControl for SimSpeech {
    fn agent_audible(&self) -> bool {
        self.audible.load(Ordering::SeqCst)
    }
    fn cancel_speech(&self) {
        self.cancels.fetch_add(1, Ordering::SeqCst);
    }
}

struct NullSink;

impl AudioSink for NullSink {
    fn push(&self, _samples: &[f32]) {}
}

/// One agent reply, in wall ms.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub start: u64,
    pub end: u64,
    /// Cut off by barge-in.
    pub cut: bool,
}

/// What a scene run produced.
#[derive(Debug, Clone, Default)]
pub struct SimRun {
    /// Every machine input, with its wall time.
    pub inputs: Vec<(u64, Input)>,
    pub actions: Vec<(u64, Action)>,
    pub replies: Vec<Reply>,
}

/// How to run a scene.
pub struct SimSetup {
    /// The preset (or a variant of one being tuned).
    pub tuning: Tuning,
    pub vad: Box<dyn Vad>,
    pub canceller: Box<dyn EchoCanceller>,
    pub canceller_real: bool,
    /// Record a debug capture of the run here.
    pub capture: Option<Capture>,
    /// The noisy room starts from this remembered speech level
    /// ([`Machine::with_speech_hint`]) instead of the bootstrap.
    pub speech_hint: Option<f32>,
}

struct Loop {
    machine: Machine,
    shared: Arc<DspShared>,
    run: SimRun,
    capture: Option<Capture>,
    clock: u64,
    ended: bool,
    finalizes: Vec<(u64, u64)>,
    /// A reply is due to start at this wall time.
    reply_due: Option<u64>,
}

impl Loop {
    fn input(&mut self, input: Input, now: u64) {
        if let Input::Vad { end, .. } = input {
            self.clock = self.clock.max(end);
        }
        if let Some(cap) = &self.capture {
            cap.event(trace::record(trace::input_json(&input), now, self.clock));
        }
        let actions = trace::feed(&mut self.machine, &input, now);
        self.run.inputs.push((now, input));
        for a in actions {
            if let Some(cap) = &self.capture {
                cap.event(trace::record(trace::action_json(&a), now, self.clock));
            }
            match &a {
                Action::Finalize { seq } => self.finalizes.push((*seq, now)),
                Action::Turn { .. } => self.reply_due = Some(now + REPLY_LATENCY_MS),
                Action::End { .. } => self.ended = true,
                _ => {}
            }
            self.run.actions.push((now, a));
        }
        self.shared.barge_armed.store(self.machine.barge_armed(), Ordering::Relaxed);
        self.shared.barge_aside.store(self.machine.barge_aside(), Ordering::Relaxed);
        self.shared.speech_level.set(self.machine.barge_level());
    }
}

/// Run `mix` closed-loop: the DSP path on taps (as the DSP thread runs it,
/// one 10 ms block a pass), the turn machine fed as the session feeds it,
/// the scripted transcription and agent.
pub fn run(mix: &Mix, setup: SimSetup) -> SimRun {
    let (mut mic_w, mic_r) = tap_channel(16_384);
    let (mut ref_w, ref_r) = tap_channel(16_384);
    mic_w.begin_stream(SAMPLE_RATE as u32);
    ref_w.begin_stream(SAMPLE_RATE as u32);
    let speech = SimSpeech::default();
    let shared = Arc::new(DspShared::default());
    shared.headphones_hint.store(mix.route == Route::Headphones, Ordering::Relaxed);
    let (tx, mut events) = mpsc::unbounded_channel();
    let mut core = DspCore::new(
        mic_r,
        Some(ref_r),
        setup.canceller,
        setup.canceller_real,
        Some(setup.vad),
        Box::new(NullSink),
        Box::new(speech.clone()),
        shared.clone(),
        tx,
        0,
    )
    .with_tuning(&setup.tuning)
    .with_capture(setup.capture.clone());
    let cfg = TurnConfig::for_tuning(Mode::Conversation, DEFAULT_END_SILENCE_MS, true, &setup.tuning);
    let mut lp = Loop {
        machine: Machine::new(cfg, EchoMode::Converging).with_speech_hint(setup.speech_hint),
        shared: shared.clone(),
        run: SimRun::default(),
        capture: setup.capture,
        clock: 0,
        ended: false,
        finalizes: Vec::new(),
        reply_due: None,
    };
    let (mut stt, stt_utts) = Stt::new(mix.words.clone());

    // As the session starts: the echo mode, the first state, the TTS watch,
    // then the DSP thread reports in.
    lp.input(Input::Echo(EchoMode::Converging), 0);
    lp.input(Input::Start, 0);
    lp.input(Input::Speaking(false), 0);
    lp.input(Input::Started { vad_frame: Some(512), canceller: setup.canceller_real }, 0);

    let blocks = mix.bed.len() / AEC_FRAME;
    let hist = mix.echo.iter().map(|e| e.0).max().unwrap_or(0) + AEC_FRAME;
    let mut agent_out: Vec<f32> = vec![0.0; hist];
    let mut agent_pos = 0usize;
    let mut reply: Option<(u64, u64)> = None; // (start wall, end wall)
    let mut cancels_seen = 0usize;
    let mut speaking = false;
    for k in 0..blocks {
        if lp.ended {
            break;
        }
        let now = (k as u64 + 1) * 10;
        // The agent: start a due reply, finish one that ran its length.
        if reply.is_none() {
            if let Some(due) = lp.reply_due {
                if now >= due {
                    lp.reply_due = None;
                    reply = Some((now, now + (mix.reply_s * 1000.0) as u64));
                }
            }
        }
        if let Some((s, e)) = reply {
            if now > e {
                lp.run.replies.push(Reply { start: s, end: e, cut: false });
                reply = None;
            }
        }
        let audible = reply.is_some();
        if audible != speaking {
            speaking = audible;
            speech.audible.store(audible, Ordering::SeqCst);
            lp.input(Input::Speaking(audible), now);
        }
        // This block's audio.
        let mut block_ref = [0.0f32; AEC_FRAME];
        if audible {
            for v in block_ref.iter_mut() {
                *v = mix.agent_voice.get(agent_pos).copied().unwrap_or(0.0);
                agent_pos += 1;
            }
        }
        agent_out.extend_from_slice(&block_ref);
        let base = agent_out.len() - AEC_FRAME;
        let mut block_mic = [0.0f32; AEC_FRAME];
        for (i, m) in block_mic.iter_mut().enumerate() {
            let mut echo = 0.0;
            for &(d, g) in &mix.echo {
                echo += g * agent_out[base + i - d];
            }
            *m = mix.bed[k * AEC_FRAME + i] + echo;
        }
        if agent_out.len() > 4 * hist + 16_000 {
            agent_out.drain(..agent_out.len() - hist);
        }
        ref_w.push_slice(&block_ref);
        mic_w.push_slice(&block_mic);
        core.step(now);

        // What the session hears, in a fixed order: transcription, the DSP
        // thread, then the agent stopping, then the tick.
        for (seq, at) in std::mem::take(&mut lp.finalizes) {
            stt.finalize(seq, at);
        }
        for e in stt.due(now, &stt_utts) {
            lp.input(Input::Stt(e), now);
            for (seq, at) in std::mem::take(&mut lp.finalizes) {
                stt.finalize(seq, at);
            }
        }
        while let Ok(e) = events.try_recv() {
            let input = match e {
                DspEvent::Started { vad_frame, canceller } => Input::Started { vad_frame, canceller },
                DspEvent::Vad { prob, start, end, level_db, floor_db } => Input::Vad { prob, start, end, level_db, floor_db },
                DspEvent::Echo(m) => Input::Echo(m),
                DspEvent::Level { mic, agent } => Input::Level { mic, agent },
                DspEvent::BargeIn { onset } => Input::BargeIn { onset },
                DspEvent::Wake { onset } => Input::Wake { onset },
                DspEvent::MicReplaced => Input::MicReplaced,
                DspEvent::MicStalled | DspEvent::Audio { .. } => continue,
            };
            lp.input(input, now);
        }
        let cancels = speech.cancels.load(Ordering::SeqCst);
        if cancels != cancels_seen {
            cancels_seen = cancels;
            if let Some((s, _)) = reply.take() {
                lp.run.replies.push(Reply { start: s, end: now, cut: true });
            }
            if speaking {
                speaking = false;
                speech.audible.store(false, Ordering::SeqCst);
                lp.input(Input::Speaking(false), now);
            }
        }
        if now.is_multiple_of(50) {
            lp.input(Input::Tick, now);
        }
        for (seq, at) in std::mem::take(&mut lp.finalizes) {
            stt.finalize(seq, at);
        }
    }
    if let Some((s, e)) = reply {
        lp.run.replies.push(Reply { start: s, end: e, cut: false });
    }
    let end = (blocks as u64) * 10 + 10;
    if !lp.ended {
        lp.input(Input::Stop, end);
    }
    lp.run
}
