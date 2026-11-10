//! The voice session's DSP thread (chat-voice.md §3.1, §3.3a).
//!
//! ```text
//! mic raw tap (device rate) ──resample──▶ 16k capture ─┐
//!                                                      ├─▶ canceller ─▶ cleaned 16k ─┬─▶ local-stt (SttSink)
//! playback tap (device rate) ─resample──▶ 16k render ──┘   (render first)            ├─▶ VAD ─▶ Vad events
//!                                                                                    │        └▶ barge-in → TtsService::cancel()
//!                                                                                    └─▶ levels (~15 Hz)
//! ```
//!
//! A plain `std::thread` owns the canceller and the VAD (either may be
//! `!Send`, so they are built here and never leave) and both resamplers. Each
//! pass ([`DspCore::step`], every ~5 ms) drains the reference tap, then for
//! every whole 10 ms capture frame first hands the canceller every whole
//! render frame that has arrived, then the capture frame.
//!
//! - **The session audio clock** is the count of cleaned samples pushed into
//!   the transcription (silence included, while muted or across a gap), so
//!   local-stt's word times and the VAD frames are on one clock.
//! - **Taps**: a new epoch means the stream behind the tap was replaced
//!   (reopened, another device, maybe another rate): clear, rebuild the
//!   resampler, reset the canceller and the echo tracker, and drop render
//!   frames queued against the old timeline. Frames a full ring dropped come
//!   back as the same length of silence, on the mic and on the reference, so
//!   the two timelines stay aligned (and the clock stays on wall time).
//! - **No reference** (dictation, or the output isn't running): one zero
//!   render frame per capture frame, so the render timeline never stalls.
//!   With a live reference nothing is added: a frame that is merely late
//!   arrives on the next pass, and zeros would push the render timeline ahead
//!   of the capture one.
//! - **Mute**: the canceller keeps running on the real mic (it stays
//!   converged), the VAD is not fed, and local-stt gets silence instead of
//!   the mic, which keeps its clock on ours and its session warm.
//! - **Barge-in** is decided here, never waiting on the async session: when
//!   the session has armed it, the echo mode allows it, and TTS is audible
//!   this very frame, the criterion firing calls `TtsService::cancel()` (a few
//!   atomics and a channel send; it never blocks) and then tells the session.
//!   Under the `wake` barge policy ([`DspShared::barge_wakes`]) the same
//!   firing cancels nothing and tells the session [`DspEvent::Wake`] instead:
//!   the user's run opens while the speech goes on.
//! - **The system-audio reference** ([`super::system_ref`]): on speakers a
//!   session may also run the system-audio tap (everything playing on the
//!   Mac but Native Intelligence). Its frames are summed into the read-aloud frames
//!   (conversation, interactive) or rendered alone (dictation, or while the
//!   playback reference isn't flowing). The sidecar delivers them late, so
//!   while the tap runs ([`DspShared::system_ref_on`]) every mic frame is
//!   held [`super::system_ref::DEFAULT_HOLD_MS`] before it is processed:
//!   system frames that arrived by its deadline go in first (capture_aec's
//!   render-then-capture order), and so do the read-aloud frames that arrived
//!   by the time the mic frame did, exactly the ones that would have gone in
//!   before it unheld. The read-aloud reference keeps its alignment with the
//!   mic; its frames set the mixed render rate (a system frame rides along
//!   when one is waiting), so the sidecar's short clock costs the system part
//!   a hole now and then, never the read-aloud part. Without the tap the hold
//!   is zero and every mic frame is processed in the pass it arrived in, as
//!   before. Only frames are delayed, never samples added or dropped, and
//!   everything downstream (local-stt, the VAD, barge-in onsets) is on the
//!   session audio clock, so the hold adds latency and nothing else (the
//!   turn machine's end-of-utterance silence is counted in VAD frames of
//!   that clock, so it fires after the same audio, just later). Nothing
//!   held is ever lost: before a finalize goes to local-stt (a dictation
//!   stop, a turn's end) the session asks for a flush ([`request_flush`])
//!   and every held frame is processed and pushed first; the teardown
//!   flushes too; and a mic stream about to be replaced has its held frames
//!   processed before the switch drops its ring. The
//!   system audio is an echo reference only: the dev debug capture records
//!   the read-aloud part of the render frames and none of it.
//! - **Interactive sessions feed local-stt around speech only**
//!   ([`super::feed`]): a [`FeedGate`] stands between the cleaned audio and
//!   the sink, opening on the VAD with a pre-roll and closing after a tail of
//!   silence, and a [`FeedClock`] maps the engine's clock (samples fed) back
//!   onto the session audio clock for the actor. Every other session feeds
//!   everything, as before.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tokio::sync::mpsc;

use super::capture::{AecFrame, Capture, VadRow};
use super::detect::{self, BargeInDetector, EchoPath, EchoTracker, NoiseFloor};
use super::events::EchoMode;
use super::feed::{FeedClock, FeedGate};
use super::profile::{BargeTuning, GateLevel, LevelGate, NoiseProfile, Tuning};
use super::system_ref;
use super::vad::{self, Vad};
use super::SAMPLE_RATE;
use crate::audio::aec::{self, EchoCanceller, PassthroughCanceller, AEC_FRAME};
use crate::audio::capture_aec::{REF_STALL_MS, STALE_REF_MS};
use crate::audio::resample::StreamResampler;
use crate::audio::tap::TapReader;

/// A pass of the loop every this often.
pub const STEP_INTERVAL: Duration = Duration::from_millis(5);
/// `voice://level` cadence: every this many cleaned samples (~15 Hz).
pub const LEVEL_EVERY: usize = (SAMPLE_RATE as usize).div_ceil(15);
/// A reference with no frames for this long counts as absent.
pub const REFERENCE_STALL_MS: u64 = 100;
/// No mic frames for this long → the device is gone. The first frame gets
/// longer: a reused stream's proof of life alone may take 2.5 s.
pub const MIC_STALL_MS: u64 = 2_000;
pub const MIC_FIRST_FRAME_MS: u64 = 5_000;
/// Mixed with read-aloud, the system frames already due that may wait for
/// read-aloud frames to ride on; older ones are dropped (counted stale), so
/// the system part stays on capture_aec's alignment (the newest frames due
/// by the mic frame's deadline go in) and a sidecar gap or burst can't leave
/// it lagging.
pub const MIXED_SYSTEM_BACKLOG: usize = 2;
/// Raw frames popped per read.
const READ_CHUNK: usize = 2_048;

/// Where cleaned audio goes (local-stt's sink in the app, a recorder in tests).
pub trait AudioSink: Send {
    fn push(&self, samples: &[f32]);
}

impl AudioSink for Arc<crate::modules::stt::SttSink> {
    fn push(&self, samples: &[f32]) {
        crate::modules::stt::SttSink::push(self, crate::modules::stt::STREAM_MIC, samples);
    }
}

/// The agent's speech, as barge-in sees it.
pub trait SpeechControl: Send {
    /// TTS is audible right now.
    fn agent_audible(&self) -> bool;
    /// Stop it now. Must not block.
    fn cancel_speech(&self);
}

/// Flags the session sets and the DSP thread reads every pass.
#[derive(Debug, Default)]
pub struct DspShared {
    pub stop: AtomicBool,
    pub muted: AtomicBool,
    /// The session's machine allows barge-in now (conversation, "Interrupt by
    /// talking" on, not muted, the agent speaking).
    pub barge_armed: AtomicBool,
    /// ...and the agent's speech is an aside ([`super::turn::Machine::barge_aside`]):
    /// barge-in may fire on the headphones hint alone, before the echo mode
    /// allows it, unless an echo path was measured.
    pub barge_aside: AtomicBool,
    /// ...and the barge policy is `wake` ([`super::turn::Machine::barge_wakes`]):
    /// firing cancels nothing and is reported as [`DspEvent::Wake`]. False
    /// (the default) is barge-in proper.
    pub barge_wakes: AtomicBool,
    /// The output route's name says headphones: a hint only (the DSP
    /// thread measures whether there is an echo path; see
    /// [`EchoTracker`]).
    pub headphones_hint: AtomicBool,
    /// The user's speech level S the barge-in detector gates on
    /// ([`super::turn::Machine::barge_level`]): set in the noisy room, and
    /// under Auto once it switched or S is known; unset otherwise (the quiet
    /// room's barge-in).
    pub speech_level: SpeechLevel,
    /// The system-audio tap runs as an echo reference
    /// ([`super::system_ref`]): mix it in and hold the mic for it.
    pub system_ref_on: AtomicBool,
    /// The DSP thread holds mic frames back (the system tap runs): a
    /// finalize must [`request_flush`] first.
    pub holding: AtomicBool,
    /// The mic hold in force (ms): the turn machine's wall-time guards
    /// stretch by it ([`super::trace::Input::AudioDelay`]).
    pub hold_ms: AtomicU64,
    /// The running system tap has stalled (no frames for
    /// capture_aec's `REF_STALL_MS`): the session restarts it, bounded.
    pub system_stalled: AtomicBool,
    /// Flushes asked for ([`request_flush`]) and done: the DSP thread has
    /// processed every held frame and pushed it to local-stt.
    pub flush_req: AtomicU64,
    pub flush_done: AtomicU64,
}

/// Before a finalize goes to local-stt (a dictation stop, a turn's end):
/// ask the DSP thread to process every mic frame it holds, so the last words
/// are in local-stt's queue ahead of the finalize. `None` when nothing is
/// held (no system tap: today's path, nothing to wait for); else the flush
/// to wait for with [`flushed`].
pub fn request_flush(shared: &DspShared) -> Option<u64> {
    shared.holding.load(Ordering::Acquire).then(|| shared.flush_req.fetch_add(1, Ordering::AcqRel) + 1)
}

/// Flush `req` is done.
pub fn flushed(shared: &DspShared, req: u64) -> bool {
    shared.flush_done.load(Ordering::Acquire) >= req
}

/// How long a finalize waits for the flush (a few DSP passes; a stopped DSP
/// thread never answers, and then the finalize goes anyway).
pub const FLUSH_WAIT: Duration = Duration::from_millis(250);

/// [`request_flush`] and wait for it, up to [`FLUSH_WAIT`]. Returns false
/// only when the DSP thread didn't answer in time.
pub async fn flush_held_audio(shared: &DspShared) -> bool {
    let Some(req) = request_flush(shared) else { return true };
    let deadline = Instant::now() + FLUSH_WAIT;
    while !flushed(shared, req) {
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    true
}

/// The machine's speech level S (dBFS) and whether a sent turn measured
/// it yet, in one atomic (unset: NaN).
#[derive(Debug)]
pub struct SpeechLevel(AtomicU64);

impl Default for SpeechLevel {
    fn default() -> Self {
        Self(AtomicU64::new(f32::NAN.to_bits() as u64))
    }
}

impl SpeechLevel {
    pub fn set(&self, level: Option<(f32, bool)>) {
        let (db, measured) = level.unwrap_or((f32::NAN, false));
        self.0.store(db.to_bits() as u64 | (measured as u64) << 32, Ordering::Relaxed);
    }

    pub fn get(&self) -> Option<(f32, bool)> {
        let v = self.0.load(Ordering::Relaxed);
        let db = f32::from_bits(v as u32);
        (!db.is_nan()).then_some((db, v >> 32 & 1 == 1))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum DspEvent {
    /// The thread built its canceller and VAD (`None`: no VAD).
    Started { vad_frame: Option<usize>, canceller: bool },
    /// One VAD frame covering `[start, end)` of the audio clock, with its
    /// level (dBFS, RMS of the same cleaned samples) and the room's noise
    /// floor it is judged against ([`NoiseFloor`]). The level and floor are
    /// measured under every preset; the quiet room ignores them.
    Vad { prob: f32, start: u64, end: u64, level_db: f32, floor_db: f32 },
    Echo(EchoMode),
    Level { mic: f32, agent: f32 },
    /// Barge-in fired and the speech is already cancelled.
    BargeIn { onset: u64 },
    /// Barge-in's detector fired under the `wake` policy: the user talks
    /// over the agent from `onset`, and the speech was left playing.
    Wake { onset: u64 },
    /// No mic frames for [`MIC_STALL_MS`] (or the first for
    /// [`MIC_FIRST_FRAME_MS`]). Once per stream: a replaced stream re-arms it.
    MicStalled,
    /// The mic's stream was replaced (a device change, or the same device
    /// reopened): the noisy room's level gate starts over from the bootstrap
    /// S. Sent before the new stream's first VAD frame.
    MicReplaced,
    /// Speech audio ([`DspCore::with_speech_audio`] only): what local-stt
    /// hears (silence while muted), 16-bit, from audio clock `start`, about
    /// [`SPEECH_FLUSH`] samples at a time.
    Audio { start: u64, pcm: Vec<i16> },
}

/// Speech audio goes to the session this many samples at a time (100 ms).
pub const SPEECH_FLUSH: usize = SAMPLE_RATE as usize / 10;

/// The speech audio batch building up on the DSP thread.
#[derive(Debug)]
struct SpeechTap {
    start: u64,
    pcm: Vec<i16>,
}

/// One whole 10 ms frame at 16 kHz, stamped with the pass it was completed
/// in (the session's `now_ms`).
#[derive(Debug, Clone, Copy)]
struct Stamped {
    data: [f32; AEC_FRAME],
    at_ms: u64,
}

/// One tap's reader side: epoch and drop bookkeeping, resampling to 16 kHz,
/// and the whole frames waiting, each stamped with the pass it completed in.
struct TapInput {
    reader: TapReader,
    epoch: u64,
    seen: bool,
    dropped: u64,
    rate: u32,
    resampler: Option<StreamResampler>,
    raw: Vec<f32>,
    /// 16 kHz samples of the frame not yet whole, from `pos`.
    pending: Vec<f32>,
    pos: usize,
    /// Whole frames waiting.
    ready: VecDeque<Stamped>,
    last_data_ms: Option<u64>,
}

#[derive(Debug, Default, PartialEq)]
struct Polled {
    /// The stream behind the tap was replaced.
    replaced: bool,
    /// Any frames arrived.
    got: bool,
    /// Whole 10 ms frames completed.
    frames: usize,
}

impl TapInput {
    fn new(reader: TapReader) -> Self {
        Self {
            reader,
            epoch: 0,
            seen: false,
            dropped: 0,
            rate: 0,
            resampler: None,
            raw: vec![0.0; READ_CHUNK],
            pending: Vec::with_capacity(8 * AEC_FRAME),
            pos: 0,
            ready: VecDeque::new(),
            last_data_ms: None,
        }
    }

    fn waiting(&self) -> usize {
        self.pending.len() - self.pos
    }

    fn clear_pending(&mut self) {
        self.pending.clear();
        self.pos = 0;
        self.ready.clear();
    }

    /// Drop what has been consumed (keeps `pending` small).
    fn compact(&mut self) {
        if self.pos > 0 {
            self.pending.drain(..self.pos);
            self.pos = 0;
        }
    }

    fn poll(&mut self, now_ms: u64) -> Polled {
        let mut polled = Polled::default();
        let epoch = self.reader.epoch();
        if epoch != self.epoch {
            if self.seen {
                // A new stream: whatever is queued belongs to the old one,
                // and so do the drops counted so far.
                self.reader.clear();
                self.clear_pending();
                self.dropped = self.reader.dropped();
                polled.replaced = true;
            }
            // (First sight: drops since the tap was made are a real gap.)
            self.seen = true;
            self.epoch = epoch;
            self.rate = self.reader.rate();
            self.resampler = if self.rate > 0 {
                match StreamResampler::new(self.rate, SAMPLE_RATE as u32) {
                    Ok(r) => Some(r),
                    Err(e) => {
                        crate::log_to_file(&format!("[voice] no resampler for {} Hz: {}", self.rate, e));
                        None
                    }
                }
            } else {
                None
            };
        }
        let Some(resampler) = self.resampler.as_mut() else {
            // Not installed on a stream yet: nothing to read.
            self.reader.clear();
            return polled;
        };
        let dropped = self.reader.dropped();
        let gap = dropped.saturating_sub(self.dropped);
        self.dropped = dropped;
        loop {
            let n = self.reader.pop_slice(&mut self.raw);
            if n == 0 {
                break;
            }
            polled.got = true;
            resampler.process(&self.raw[..n], &mut self.pending);
        }
        if gap > 0 {
            // A full ring lost the newest frames: the same length of silence
            // keeps the timeline.
            let silence = (gap * SAMPLE_RATE / self.rate.max(1) as u64) as usize;
            self.pending.resize(self.pending.len() + silence, 0.0);
            polled.got = true;
        }
        if polled.got {
            self.last_data_ms = Some(now_ms);
        }
        // Whole frames, stamped with this pass.
        while self.waiting() >= AEC_FRAME {
            let mut data = [0.0; AEC_FRAME];
            data.copy_from_slice(&self.pending[self.pos..self.pos + AEC_FRAME]);
            self.pos += AEC_FRAME;
            self.ready.push_back(Stamped { data, at_ms: now_ms });
            polled.frames += 1;
        }
        self.compact();
        polled
    }

    /// The stream behind the tap has been replaced since the last poll
    /// (the next poll drops what is queued).
    fn switching(&self) -> bool {
        self.seen && self.reader.epoch() != self.epoch
    }

    /// The oldest whole frame, if its stamp passes `due`.
    fn pop_if(&mut self, due: impl Fn(u64) -> bool) -> Option<Stamped> {
        if self.ready.front().is_some_and(|f| due(f.at_ms)) {
            self.ready.pop_front()
        } else {
            None
        }
    }

    /// No frames lately (or none yet, or not on a stream).
    fn stalled(&self, now_ms: u64, stall_ms: u64) -> bool {
        self.resampler.is_none() || self.last_data_ms.is_none_or(|t| now_ms.saturating_sub(t) > stall_ms)
    }
}

/// The system reference's bookkeeping, for the logs.
#[derive(Debug, Default, Clone)]
struct SystemStats {
    frames_in: u64,
    mixed: u64,
    alone: u64,
    stale: u64,
}

fn sum_squares(frame: &[f32]) -> f64 {
    frame.iter().map(|&s| (s as f64) * (s as f64)).sum()
}

fn rms(sum_sq: f64, n: usize) -> f32 {
    if n == 0 {
        0.0
    } else {
        ((sum_sq / n as f64).sqrt() as f32).clamp(0.0, 1.0)
    }
}

pub struct DspCore {
    mic: TapInput,
    reference: Option<TapInput>,
    /// The system-audio reference ([`super::system_ref`]): installed for
    /// the session, flowing only while [`DspShared::system_ref_on`].
    system: Option<TapInput>,
    /// The tap runs (as last read from [`DspShared::system_ref_on`])...
    system_on: bool,
    /// ...since this pass (for the stall report).
    system_on_since: u64,
    system_stalled: bool,
    system_stats: SystemStats,
    /// How long a mic frame waits for its system reference while the tap
    /// runs ([`system_ref::DEFAULT_HOLD_MS`]).
    system_hold_ms: u64,
    /// The mic hold now: `system_hold_ms` while the tap runs, else 0.
    hold_ms: u64,
    /// The last flush done ([`DspShared::flush_req`]).
    flushed: u64,
    /// While holding: since when the agent has been audible (barge-in only
    /// counts held audio captured after that).
    audible_since: Option<u64>,
    canceller: Box<dyn EchoCanceller>,
    vad: Option<Box<dyn Vad>>,
    sink: Box<dyn AudioSink>,
    speech: Box<dyn SpeechControl>,
    shared: Arc<DspShared>,
    events: mpsc::UnboundedSender<DspEvent>,
    echo: EchoTracker,
    echo_sent: Option<EchoMode>,
    path_logged: EchoPath,
    barge: BargeInDetector,
    /// The noisy room's level gate: only sustain-near frames count toward
    /// barge-in (`None`: every frame does).
    gate: Option<LevelGate>,
    /// Auto: the quiet room's barge-in and the noisy room's, the detector
    /// running the noisy one (gated) while the machine publishes an S
    /// ([`DspShared::speech_level`]), the quiet one otherwise.
    auto_barge: Option<(BargeTuning, BargeTuning)>,
    auto_gated: bool,
    gate_level: GateLevel,
    floor: NoiseFloor,
    /// Session audio clock: cleaned samples out.
    clock: u64,
    muted: bool,
    vad_buf: Vec<f32>,
    vad_start: u64,
    stt_buf: Vec<f32>,
    /// Interactive: what of the cleaned audio reaches `stt_buf` (around
    /// speech only). `None`: all of it.
    feed: Option<FeedGate>,
    level_n: usize,
    mic_sq: f64,
    agent_sq: f64,
    agent_n: usize,
    started_ms: u64,
    last_mic_ms: Option<u64>,
    stalled: bool,
    /// The dev-only debug capture ([`super::capture`]), and what happened
    /// since its last frame row.
    capture: Option<Capture>,
    cap_resynced: bool,
    cap_mic_replaced: bool,
    cap_mute_toggled: bool,
    /// The headphones hint this pass runs with.
    hint: bool,
    /// Speech audio for the session (Voice focus); `None`: off.
    speech_tap: Option<SpeechTap>,
}

impl DspCore {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        mic: TapReader,
        reference: Option<TapReader>,
        canceller: Box<dyn EchoCanceller>,
        canceller_real: bool,
        vad: Option<Box<dyn Vad>>,
        sink: Box<dyn AudioSink>,
        speech: Box<dyn SpeechControl>,
        shared: Arc<DspShared>,
        events: mpsc::UnboundedSender<DspEvent>,
        now_ms: u64,
    ) -> Self {
        Self {
            mic: TapInput::new(mic),
            reference: reference.map(TapInput::new),
            system: None,
            system_on: false,
            system_on_since: now_ms,
            system_stalled: false,
            system_stats: SystemStats::default(),
            system_hold_ms: system_ref::hold_ms(true),
            hold_ms: 0,
            flushed: 0,
            audible_since: None,
            canceller,
            vad,
            sink,
            speech,
            shared,
            events,
            echo: EchoTracker::new(canceller_real),
            echo_sent: None,
            path_logged: EchoPath::Unknown,
            barge: BargeInDetector::default(),
            gate: None,
            auto_barge: None,
            auto_gated: false,
            gate_level: GateLevel::default(),
            floor: NoiseFloor::default(),
            clock: 0,
            muted: false,
            vad_buf: Vec::with_capacity(2048),
            vad_start: 0,
            stt_buf: Vec::with_capacity(4096),
            feed: None,
            level_n: 0,
            mic_sq: 0.0,
            agent_sq: 0.0,
            agent_n: 0,
            started_ms: now_ms,
            last_mic_ms: None,
            stalled: false,
            capture: None,
            cap_resynced: false,
            cap_mic_replaced: false,
            cap_mute_toggled: false,
            hint: false,
            speech_tap: None,
        }
    }

    /// Hand the session what local-stt hears as [`DspEvent::Audio`] (Voice
    /// focus). A bounded batch, converted to 16-bit here and sent every
    /// [`SPEECH_FLUSH`] samples; everything else happens on the actor.
    pub fn with_speech_audio(mut self, on: bool) -> Self {
        self.speech_tap = on.then(|| SpeechTap { start: 0, pcm: Vec::with_capacity(SPEECH_FLUSH + AEC_FRAME) });
        self
    }

    /// The system-audio reference's tap (`None`: never; the session runs it
    /// on speakers, [`super::system_ref`]).
    pub fn with_system_reference(mut self, reader: Option<TapReader>) -> Self {
        self.system = reader.map(TapInput::new);
        self
    }

    /// The mic hold while the system tap runs (tests: show what it is for).
    #[cfg(test)]
    pub fn with_system_hold_ms(mut self, ms: u64) -> Self {
        self.system_hold_ms = ms;
        self
    }

    /// The mic hold now (0 without the system tap).
    #[cfg(test)]
    pub fn hold_ms(&self) -> u64 {
        self.hold_ms
    }

    /// Record everything into `capture` (dev only; `None`: off).
    pub fn with_capture(mut self, capture: Option<Capture>) -> Self {
        self.capture = capture;
        self
    }

    /// Feed transcription around speech only, through `gate` (an
    /// interactive session; `None`: everything, as conversation and
    /// dictation do). Without a VAD the gate never opens, but such a session
    /// ends at once anyway (a conversation needs one).
    pub fn with_feed_gate(mut self, gate: Option<FeedGate>) -> Self {
        self.feed = gate;
        self
    }

    /// Run `profile`'s barge-in detector and level gate (the quiet room's,
    /// no gate, by default).
    pub fn with_profile(self, profile: NoiseProfile) -> Self {
        self.with_tuning(profile.tuning())
    }

    /// [`Self::with_profile`] with any tuning (the replay harness).
    ///
    /// Auto starts on the quiet room's barge-in and switches with the
    /// machine ([`Self::run_vad`]).
    pub fn with_tuning(mut self, tuning: &Tuning) -> Self {
        self.gate = tuning.gate;
        match tuning.auto {
            None => self.barge = BargeInDetector::for_tuning(&tuning.barge),
            Some(_) => {
                self.auto_barge = Some((Tuning::QUIET.barge, tuning.barge));
                self.auto_gated = false;
                self.barge = BargeInDetector::for_tuning(&Tuning::QUIET.barge);
            }
        }
        self
    }

    /// The session audio clock (cleaned samples so far).
    #[cfg(test)]
    pub fn clock(&self) -> u64 {
        self.clock
    }

    fn send(&self, event: DspEvent) {
        let _ = self.events.send(event);
    }

    /// The reference is not flowing: nothing installed, no stream yet, or
    /// no frames lately (the output is closed or reopening).
    fn reference_absent(&self, now_ms: u64) -> bool {
        match &self.reference {
            None => true,
            Some(r) => r.stalled(now_ms, REFERENCE_STALL_MS),
        }
    }

    /// The system reference is not flowing: the tap is off, or nothing came
    /// for capture_aec's [`REF_STALL_MS`] (the sidecar pipe is bursty: a
    /// shorter gap is a late frame, not an absent reference).
    fn system_absent(&self, now_ms: u64) -> bool {
        match &self.system {
            Some(s) if self.system_on => s.stalled(now_ms, REF_STALL_MS),
            _ => true,
        }
    }

    /// Follow [`DspShared::system_ref_on`]: the hold and the system queue.
    fn follow_system(&mut self, now_ms: u64) {
        let on = self.system.is_some() && self.shared.system_ref_on.load(Ordering::Relaxed);
        if on == self.system_on {
            return;
        }
        self.system_on = on;
        self.system_on_since = now_ms;
        self.system_stalled = false;
        let before = self.hold_ms;
        self.hold_ms = if on { self.system_hold_ms } else { 0 };
        if let Some(s) = self.system.as_mut() {
            // Whatever is queued is from before (or from a tap now gone).
            s.reader.clear();
            s.clear_pending();
            s.last_data_ms = None;
        }
        if on {
            crate::log_to_file(&format!(
                "[voice] DSP: system-audio echo reference in ({}), mic held {} ms (was {} ms)",
                if self.reference.is_some() { "summed with read-aloud" } else { "alone" },
                self.hold_ms,
                before
            ));
        } else {
            self.log_system_summary("out");
        }
    }

    fn log_system_summary(&mut self, why: &str) {
        let st = std::mem::take(&mut self.system_stats);
        if st.frames_in == 0 && why != "out" {
            return;
        }
        crate::log_to_file(&format!(
            "[voice] DSP: system-audio echo reference {why}: {} frames in, {} summed with read-aloud, {} alone, \
{} stale dropped; mic hold now {} ms",
            st.frames_in, st.mixed, st.alone, st.stale, self.hold_ms
        ));
    }

    /// The DSP thread is ending.
    pub fn finish(&mut self) {
        if self.system_on || self.system_stats.frames_in > 0 {
            self.log_system_summary("at the end");
        }
    }

    /// Mixed with read-aloud: keep at most [`MIXED_SYSTEM_BACKLOG`] system
    /// frames due by `deadline_ms` waiting, dropping the oldest. Each
    /// read-aloud frame carries one system frame, so without this a burst
    /// after a sidecar gap would stay queued and the system part would lag
    /// behind its echo (aec3 estimates one delay for the whole render
    /// signal); alone, every due frame goes in, so nothing is left due. The
    /// read-aloud part is never moved.
    fn trim_system_backlog(&mut self, deadline_ms: u64) {
        if !self.system_on {
            return;
        }
        let Some(s) = self.system.as_mut() else { return };
        let due = s.ready.iter().take_while(|f| f.at_ms <= deadline_ms).count();
        let excess = due.saturating_sub(MIXED_SYSTEM_BACKLOG);
        s.ready.drain(..excess);
        self.system_stats.stale += excess as u64;
    }

    /// System frames waiting (due or not).
    #[cfg(test)]
    pub fn system_waiting(&self) -> usize {
        self.system.as_ref().map_or(0, |s| s.ready.len())
    }

    /// The next system frame due by `deadline_ms`, dropping those that
    /// waited past capture_aec's [`STALE_REF_MS`].
    fn next_system(&mut self, deadline_ms: u64) -> Option<[f32; AEC_FRAME]> {
        if !self.system_on {
            return None;
        }
        let s = self.system.as_mut()?;
        while let Some(f) = s.pop_if(|at| at <= deadline_ms) {
            if f.at_ms + STALE_REF_MS < deadline_ms {
                self.system_stats.stale += 1;
                continue;
            }
            return Some(f.data);
        }
        None
    }

    /// Resynchronise after a stream behind a tap was replaced.
    fn resync(&mut self) {
        self.canceller.reset();
        self.echo.reset();
        if let Some(r) = self.reference.as_mut() {
            r.clear_pending();
        }
    }

    /// The mic's stream was replaced: the gate's smoothed level belongs to
    /// the old stream, and the session resets S ([`DspEvent::MicReplaced`]).
    /// A reference-only swap (the output device) leaves both alone.
    fn mic_replaced(&mut self) {
        self.gate_level.clear();
        self.cap_mic_replaced = true;
        self.send(DspEvent::MicReplaced);
    }

    /// Mute on or off: the VAD restarts clean after a transition. Muting
    /// closes the feed gate at once (an interactive session's local-stt gets
    /// nothing while muted rather than silence); unmuting leaves it to the
    /// VAD.
    fn set_muted(&mut self, muted: bool) {
        if muted != self.muted {
            self.muted = muted;
            self.cap_mute_toggled = true;
            self.vad_buf.clear();
            self.vad_start = self.clock;
            self.barge.reset();
            self.gate_level.clear();
            if muted {
                if let Some(g) = self.feed.as_mut() {
                    g.close();
                }
            } else if let Some(v) = self.vad.as_mut() {
                v.reset();
            }
        }
    }

    fn set_route_hint(&mut self, hint: bool) {
        self.hint = hint;
        self.echo.set_route_hint(hint);
    }

    /// One pass. Returns whether any capture frame was processed.
    pub fn step(&mut self, now_ms: u64) -> bool {
        self.set_route_hint(self.shared.headphones_hint.load(Ordering::Relaxed));
        self.set_muted(self.shared.muted.load(Ordering::Relaxed));
        self.follow_system(now_ms);

        // Reference first: everything that has arrived precedes the capture
        // frames of this pass.
        let mut replaced = false;
        if let Some(r) = self.reference.as_mut() {
            replaced |= r.poll(now_ms).replaced;
        }
        // The system reference: a new tap stream only clears its own queue
        // (in poll); the canceller and the read-aloud's convergence carry on.
        if let Some(s) = self.system.as_mut() {
            let polled = s.poll(now_ms);
            if self.system_on {
                self.system_stats.frames_in += polled.frames as u64;
            } else {
                // Off: nothing it delivers is used (a tap stopping, or one
                // starting before the session flips the flag).
                s.clear_pending();
            }
        }
        // A mic stream about to be replaced (a live switch, a recovery): the
        // old stream's held frames go first, on the canceller state they
        // belong to, instead of being dropped with its ring.
        let mut worked = false;
        if self.hold_ms > 0 && self.mic.switching() {
            worked |= self.process_held(now_ms, true);
        }
        let mic = self.mic.poll(now_ms);
        replaced |= mic.replaced;
        if replaced {
            self.resync();
            self.cap_resynced = true;
        }
        if mic.replaced {
            self.mic_replaced();
            // A new stream (a live switch, a recovery): its own first-frame
            // budget, and a stall of its own is reported again.
            self.stalled = false;
            self.last_mic_ms = None;
            self.started_ms = now_ms;
        }
        if mic.got {
            self.last_mic_ms = Some(now_ms);
        }
        self.check_stall(now_ms);
        self.check_system_stall(now_ms);

        // A flush asked for ([`request_flush`]: a finalize is about to go to
        // local-stt): every held frame now, whatever its hold.
        let flush_req = self.shared.flush_req.load(Ordering::Acquire);
        let flush = flush_req != self.flushed;
        worked |= self.process_held(now_ms, flush);
        // Before local-stt gets this pass's audio: a turn's finalize can only
        // be acked after it, so its speech audio is on the channel first.
        if let Some(tap) = self.speech_tap.as_mut() {
            if tap.pcm.len() >= SPEECH_FLUSH {
                let pcm = std::mem::replace(&mut tap.pcm, Vec::with_capacity(SPEECH_FLUSH + AEC_FRAME));
                let _ = self.events.send(DspEvent::Audio { start: tap.start, pcm });
            }
        }
        if !self.stt_buf.is_empty() {
            self.sink.push(&self.stt_buf);
            self.stt_buf.clear();
        }
        // Only now, with the audio on local-stt's queue ahead of the
        // finalize the session sends next.
        if flush {
            self.flushed = flush_req;
            self.shared.flush_done.store(flush_req, Ordering::Release);
        }
        self.shared.holding.store(self.hold_ms > 0, Ordering::Release);
        self.shared.hold_ms.store(self.hold_ms, Ordering::Release);
        self.shared.system_stalled.store(self.system_on && self.system_stalled, Ordering::Release);
        worked
    }

    /// Process the mic frames whose hold has passed at `now_ms` (`force`:
    /// every one waiting). Returns whether any was.
    fn process_held(&mut self, now_ms: u64, force: bool) -> bool {
        let absent = self.reference_absent(now_ms);
        let system_absent = self.system_absent(now_ms);
        // The read-aloud reference flows: it sets the render rate and the
        // system frames ride along; otherwise they go in alone.
        let read_aloud_flowing = !absent;
        let mut worked = false;
        let recording = self.capture.is_some();
        let mut renders: Vec<[f32; AEC_FRAME]> = Vec::new();
        let hold = self.hold_ms;
        while let Some(mic) = self.mic.pop_if(|at| force || at + hold <= now_ms) {
            worked = true;
            // (Forced, the deadline is still ahead: every system frame that
            // has arrived goes in.)
            let deadline = mic.at_ms + hold;
            // 1. Every render frame that has arrived (zeros when none can):
            // the read-aloud frames that had arrived when the mic frame did,
            // each with a system frame summed in, then (no read-aloud
            // flowing) the system frames due by the deadline alone.
            let mut far_sq = 0.0;
            let mut read_aloud = 0usize;
            let mut pushed = 0usize;
            // Mixed: the system part on capture_aec's alignment (the newest
            // frames due by the deadline), whatever the sidecar's bursts.
            if read_aloud_flowing {
                self.trim_system_backlog(deadline);
            }
            while let Some(r) = self.reference.as_mut().and_then(|r| r.pop_if(|at| at <= mic.at_ms)) {
                let mut render = r.data;
                far_sq += sum_squares(&render);
                read_aloud += 1;
                if let Some(sys) = self.next_system(deadline) {
                    system_ref::mix_into(&mut render, &sys);
                    self.system_stats.mixed += 1;
                }
                self.canceller.render(&render);
                pushed += 1;
                // (The debug capture gets the read-aloud part only: the
                // system audio is never written anywhere.)
                if recording {
                    renders.push(r.data);
                }
            }
            if !read_aloud_flowing {
                while let Some(sys) = self.next_system(deadline) {
                    self.canceller.render(&sys);
                    self.system_stats.alone += 1;
                    pushed += 1;
                }
            } else {
                self.trim_system_backlog(deadline);
            }
            self.after_render(&mic.data, pushed, read_aloud, far_sq, absent && system_absent, now_ms, &mut renders);
        }
        worked
    }

    /// One capture frame, its render frames (`pushed` of them) already
    /// handed to the canceller, `read_aloud` of them carrying the agent's
    /// speech (`far_sq` its energy, the system audio's left out): the zero
    /// render frame when none arrived and every reference is `absent`, then
    /// the capture frame, the echo mode, transcription, the VAD and
    /// barge-in, and the levels. The echo mode and the agent level follow
    /// the agent's speech only, as before the system reference.
    #[allow(clippy::too_many_arguments)]
    fn after_render(
        &mut self,
        capture: &[f32; AEC_FRAME],
        pushed: usize,
        read_aloud: usize,
        far_sq: f64,
        absent: bool,
        now_ms: u64,
        renders: &mut Vec<[f32; AEC_FRAME]>,
    ) {
        if pushed == 0 && absent {
            self.canceller.render(&[0.0; AEC_FRAME]);
        }
        self.agent_sq += far_sq;
        self.agent_n += read_aloud * AEC_FRAME;
        let far_rms = rms(far_sq, read_aloud * AEC_FRAME);

        // 2. The capture frame.
        let mut cleaned = [0.0f32; AEC_FRAME];
        let metrics = self.canceller.capture(capture, &mut cleaned);
        let mode = self.echo.update(&metrics, far_rms);
        self.log_path(&metrics);
        if self.echo_sent != Some(mode) {
            self.echo_sent = Some(mode);
            self.send(DspEvent::Echo(mode));
        }

        // 3. Transcription and the clock. (Muted: silence. Behind the feed
        // gate, what continuous feed would push goes into its pre-roll, and
        // on to the sink only while it is open.)
        const SILENCE: [f32; AEC_FRAME] = [0.0; AEC_FRAME];
        let fed = if self.muted { &SILENCE } else { &cleaned };
        if !self.muted {
            self.mic_sq += sum_squares(&cleaned);
        }
        match self.feed.as_mut() {
            None => self.stt_buf.extend_from_slice(fed),
            Some(gate) => gate.audio(self.clock, fed, &mut self.stt_buf),
        }
        // Speech audio: the same samples, on the session clock (an
        // interactive session's gate notwithstanding: runs are on this clock).
        if let Some(tap) = self.speech_tap.as_mut() {
            if tap.pcm.is_empty() {
                tap.start = self.clock;
            }
            tap.pcm.extend(fed.iter().map(|&s| super::speech::to_i16(s)));
        }
        self.clock += AEC_FRAME as u64;

        // 4. VAD (and barge-in), in its own frame size.
        if !self.muted {
            self.run_vad(&cleaned, mode, now_ms);
        } else {
            self.vad_start = self.clock;
        }

        if let Some(cap) = &self.capture {
            cap.frame(AecFrame {
                clock: self.clock - AEC_FRAME as u64,
                now_ms,
                renders: std::mem::take(renders),
                absent_zero: pushed == 0 && absent,
                capture: *capture,
                cleaned,
                metrics,
                far_rms,
                echo: mode,
                muted: self.muted,
                headphones_hint: self.hint,
                resynced: std::mem::take(&mut self.cap_resynced),
                mic_replaced: std::mem::take(&mut self.cap_mic_replaced),
                mute_toggled: std::mem::take(&mut self.cap_mute_toggled),
            });
        }

        // 5. Levels.
        self.level_n += AEC_FRAME;
        if self.level_n >= LEVEL_EVERY {
            let mic = if self.muted { 0.0 } else { rms(self.mic_sq, self.level_n) };
            let agent = rms(self.agent_sq, self.agent_n);
            self.send(DspEvent::Level { mic, agent });
            self.level_n = 0;
            self.mic_sq = 0.0;
            self.agent_sq = 0.0;
            self.agent_n = 0;
        }
    }

    /// Replay one recorded capture frame (voice/replay.rs): the controls in
    /// force for it (route hint, mute, and whether mute was toggled or the
    /// canceller reset since the previous frame), the render frames handed
    /// over before it, the absent-reference zero frame, and the capture
    /// frame, through the same path [`Self::step`] takes. The cleaned audio
    /// goes to the sink at once.
    pub fn replay_frame(&mut self, frame: &ReplayFrame<'_>) {
        self.set_route_hint(frame.headphones_hint);
        if frame.mute_toggled && frame.muted == self.muted {
            self.set_muted(!frame.muted);
        }
        self.set_muted(frame.muted);
        if frame.resynced {
            self.resync();
            self.cap_resynced = true;
        }
        if frame.mic_replaced {
            self.mic_replaced();
        }
        let mut far_sq = 0.0;
        for r in frame.renders {
            self.canceller.render(r);
            far_sq += sum_squares(r);
        }
        let mut none = Vec::new();
        let n = frame.renders.len();
        self.after_render(frame.capture, n, n, far_sq, frame.absent_zero, frame.now_ms, &mut none);
        if !self.stt_buf.is_empty() {
            self.sink.push(&self.stt_buf);
            self.stt_buf.clear();
        }
    }

    /// One log line whenever the measured echo path changes.
    fn log_path(&mut self, metrics: &aec::AecMetrics) {
        let path = self.echo.path();
        if path != self.path_logged {
            self.path_logged = path;
            let what = match path {
                EchoPath::None => "none measured (no echo while the agent spoke): barge-in allowed",
                EchoPath::Present => "the agent's voice reaches the mic: barge-in once the canceller converges",
                EchoPath::Unknown => "unknown again",
            };
            crate::log_to_file(&format!("[voice] echo path {what} (ERL {:?} dB)", metrics.erl_db));
        }
    }

    fn run_vad(&mut self, cleaned: &[f32; AEC_FRAME], mode: EchoMode, now_ms: u64) {
        let Some(vad) = self.vad.as_mut() else { return };
        let n = vad.frame_len().max(1);
        self.vad_buf.extend_from_slice(cleaned);
        while self.vad_buf.len() >= n {
            let prob = vad.process(&self.vad_buf[..n]);
            let level_db = detect::level_db(rms(sum_squares(&self.vad_buf[..n]), n));
            let floor_db = self.floor.update(level_db);
            let (start, end) = (self.vad_start, self.vad_start + n as u64);
            self.vad_buf.drain(..n);
            self.vad_start = end;
            // The feed gate opens (its pre-roll goes out first) or closes on
            // this frame, before the session hears of it: the run the frame
            // may start is fed from before its onset.
            if let Some(gate) = self.feed.as_mut() {
                gate.vad(prob, start, end, &mut self.stt_buf);
            }
            let _ = self.events.send(DspEvent::Vad { prob, start, end, level_db, floor_db });
            // Armed: the session allows it, the echo mode allows it, and TTS
            // is audible (asked last, only when the rest allow it). An aside
            // (the greeting) is allowed on the headphones hint alone while no
            // echo path has been measured: laptop speakers never carry the
            // hint, and a speaker whose name says headphones can't make a
            // turn of its own echo (the machine drops the aside's words).
            let barge_armed = self.shared.barge_armed.load(Ordering::Relaxed);
            let barge_aside = self.shared.barge_aside.load(Ordering::Relaxed);
            let allowed = mode.allows_barge_in() || (barge_aside && self.hint && self.echo.path() != EchoPath::Present);
            // Held audio is `hold_ms` old: it only counts as talking over the
            // agent once the agent has been audible that long (what the user
            // said just before it started is not a barge-in). Unheld, as
            // before: asked last, only when the rest allow it.
            let audible = if self.hold_ms == 0 {
                self.audible_since = None;
                (barge_armed && allowed).then(|| self.speech.agent_audible())
            } else {
                if self.speech.agent_audible() {
                    self.audible_since.get_or_insert(now_ms);
                } else {
                    self.audible_since = None;
                }
                let hold = self.hold_ms;
                (barge_armed && allowed).then(|| self.audible_since.is_some_and(|t| now_ms >= t + hold))
            };
            // The noisy room: only frames near the user's own level count
            // (a TV or people nearby never interrupt the agent). Auto: the
            // noisy room's barge-in while the machine publishes an S, the
            // quiet room's otherwise (a switch starts the detector over).
            let published = self.shared.speech_level.get();
            if let Some((quiet, noisy)) = self.auto_barge {
                let gated = published.is_some();
                if gated != self.auto_gated {
                    self.auto_gated = gated;
                    self.barge = BargeInDetector::for_tuning(if gated { &noisy } else { &quiet });
                }
            }
            let auto = self.auto_barge.is_some();
            let gated = self.gate.and_then(|g| {
                let level = self.gate_level.push(level_db, &g);
                let (speech, measured) = match published {
                    Some(s) => s,
                    None if auto => return None,
                    None => (g.bootstrap_speech_db, false),
                };
                Some((speech, g.barge_near(level, floor_db, speech, measured)))
            });
            // A barge-in run starts on a frame near the user's level and goes
            // on while frames stay near enough.
            let near = gated.map_or((true, true), |(_, near)| near);
            let fired = self.barge.update(prob, start, end, audible == Some(true), near);
            if let Some(onset) = fired {
                // `wake`: the speech goes on, and the session opens the
                // user's run. Either way it fires once; the session re-arms.
                let wake = self.shared.barge_wakes.load(Ordering::Relaxed);
                if !wake {
                    self.speech.cancel_speech();
                }
                self.shared.barge_armed.store(false, Ordering::Relaxed);
                self.shared.barge_aside.store(false, Ordering::Relaxed);
                let _ = self.events.send(if wake { DspEvent::Wake { onset } } else { DspEvent::BargeIn { onset } });
            }
            if let Some(cap) = &self.capture {
                cap.vad(VadRow {
                    start,
                    end,
                    now_ms,
                    prob,
                    level_db,
                    floor_db,
                    gate: gated.map(|(s, (start, go_on))| (s, start, go_on)),
                    barge_armed,
                    barge_aside,
                    echo: mode,
                    agent_audible: audible,
                    barge_run: self.barge.run_start(),
                    barge_fired: fired,
                });
            }
        }
    }

    /// One line when the running system tap goes quiet for
    /// [`REF_STALL_MS`] (the sidecar died, the tap broke), and one when it
    /// flows again. Meanwhile dictation renders zero frames, as without it.
    fn check_system_stall(&mut self, now_ms: u64) {
        if !self.system_on || now_ms.saturating_sub(self.system_on_since) <= REF_STALL_MS {
            return;
        }
        let stalled = self.system_absent(now_ms);
        if stalled != self.system_stalled {
            self.system_stalled = stalled;
            // Nothing to wait for while it's stalled: no hold (the frames
            // held now go at once); it comes back with the frames.
            self.hold_ms = if stalled { 0 } else { self.system_hold_ms };
            crate::log_to_file(&format!(
                "[voice] DSP: system-audio echo reference {}, mic hold {} ms",
                if stalled { "stalled (no frames for 500 ms)" } else { "flowing again" },
                self.hold_ms
            ));
        }
    }

    fn check_stall(&mut self, now_ms: u64) {
        if self.stalled {
            return;
        }
        let stalled = match self.last_mic_ms {
            None => now_ms.saturating_sub(self.started_ms) > MIC_FIRST_FRAME_MS,
            Some(t) => now_ms.saturating_sub(t) > MIC_STALL_MS,
        };
        if stalled {
            self.stalled = true;
            self.send(DspEvent::MicStalled);
        }
    }
}

/// One recorded capture frame for [`DspCore::replay_frame`].
pub struct ReplayFrame<'a> {
    pub now_ms: u64,
    pub renders: &'a [[f32; AEC_FRAME]],
    pub absent_zero: bool,
    pub capture: &'a [f32; AEC_FRAME],
    pub muted: bool,
    pub mute_toggled: bool,
    pub headphones_hint: bool,
    pub resynced: bool,
    /// ...and the stream replaced was the mic's.
    pub mic_replaced: bool,
}

/// Everything the thread needs, all `Send`.
pub struct DspParts {
    pub mic: TapReader,
    /// The playback reference (conversation), `None` in dictation.
    pub reference: Option<TapReader>,
    /// The system-audio reference's tap ([`super::system_ref`]): frames
    /// arrive only while the session runs the tap.
    pub system_reference: Option<TapReader>,
    pub sink: Box<dyn AudioSink>,
    pub speech: Box<dyn SpeechControl>,
    pub shared: Arc<DspShared>,
    pub events: mpsc::UnboundedSender<DspEvent>,
    /// The session's background-noise preset.
    pub profile: NoiseProfile,
    /// The dev-only debug capture, when on.
    pub capture: Option<Capture>,
    /// Interactive: transcription is fed around speech only, its clock
    /// mapped through the gate's [`FeedClock`] (which the actor holds too).
    /// `None`: everything is fed.
    pub feed: Option<FeedGate>,
    /// Hand the session the audio local-stt hears ([`DspEvent::Audio`]).
    pub speech_audio: bool,
}

/// An interactive session's feed gate and the clock map the actor reads,
/// for `end_silence_ms` (the gate outlasts the turn's own pause).
pub fn feed_gate(end_silence_ms: u32) -> (FeedGate, Arc<FeedClock>) {
    let clock = Arc::new(FeedClock::default());
    (FeedGate::new(end_silence_ms, clock.clone()), clock)
}

/// Start the DSP thread. It builds the canceller (falling back to
/// passthrough) and the VAD itself, reports [`DspEvent::Started`], and runs
/// until [`DspShared::stop`].
pub fn spawn(parts: DspParts) -> std::io::Result<JoinHandle<()>> {
    std::thread::Builder::new().name("voice-dsp".into()).spawn(move || {
        let (canceller, real): (Box<dyn EchoCanceller>, bool) = match aec::new_echo_canceller() {
            Ok(c) => (c, true),
            Err(e) => {
                crate::log_to_file(&format!("[voice] echo canceller unavailable ({e}); passthrough, half-duplex"));
                (Box::new(PassthroughCanceller), false)
            }
        };
        let vad = match vad::new_vad() {
            Ok(v) => Some(v),
            Err(e) => {
                crate::log_to_file(&format!("[voice] VAD unavailable: {e}"));
                None
            }
        };
        let _ = parts.events.send(DspEvent::Started { vad_frame: vad.as_ref().map(|v| v.frame_len()), canceller: real });
        let epoch = Instant::now();
        let now = || epoch.elapsed().as_millis() as u64;
        let shared = parts.shared.clone();
        let mut core = DspCore::new(
            parts.mic,
            parts.reference,
            canceller,
            real,
            vad,
            parts.sink,
            parts.speech,
            parts.shared,
            parts.events,
            now(),
        )
        .with_profile(parts.profile)
        .with_capture(parts.capture)
        .with_feed_gate(parts.feed)
        .with_speech_audio(parts.speech_audio)
        .with_system_reference(parts.system_reference);
        while !shared.stop.load(Ordering::Relaxed) {
            core.step(now());
            std::thread::sleep(STEP_INTERVAL);
        }
        core.finish();
    })
}

#[cfg(test)]
mod tests;
