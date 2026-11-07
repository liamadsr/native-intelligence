//! The voice session's state machine (chat-voice.md §3.1, §3.3, §3.3a):
//! pure, fed inputs with an injected clock, answering with [`Action`]s the
//! session carries out (emit an event, send a finalize, end).
//!
//! Two clocks, both injected:
//! - the session **audio clock**, in 16 kHz samples of cleaned mic: VAD frames
//!   and onsets are on it, and so are local-stt's word times (in seconds);
//! - **wall time** in ms (`now`): the finalize timeout, the idle end, the
//!   agent-quiet grace and the echo guard.
//!
//! Conversation:
//! ```text
//! starting ──stt ready──▶ listening ──VAD onset──▶ user_speaking
//!    ▲                      ▲  ▲                     │ silence ≥ hangover
//!    │         empty / done │  │ agent quiet         ▼ (after min speech)
//!    │                      │  └── agent_speaking  processing ── finalize(seq)
//!    │                      │        ▲    │ barge-in    │  └ wait for Finalized{seq} (≤ 1.5 s)
//!    │                      └────────┼────┼─────────────┘ voice://turn { text }
//!    │                  TTS audible ─┘    └──▶ user_speaking (onset = the barge-in's)
//! muted overlays any state: no VAD, no new turn (the session stays open).
//! ```
//!
//! - **Mute mid-turn sends what was said.** Muting while the user speaks
//!   ends the turn at the mute exactly like its pause would (a run with
//!   enough speech, [`TurnConfig::min_speech_ms`], goes to `processing` and
//!   is finalized and sent; a shorter one is dropped). A follow-on run queued
//!   behind a turn being finalized is cut at the mute the same way and sent
//!   after it; what the user says after unmuting while it waits is a run of
//!   its own from its first onset past the cut, queued behind it. After the
//!   mute local-stt gets silence, so the finalize flushes the words said
//!   before it and nothing later can join the turn.
//!
//! - **Finalize deadline.** The ≤ 1.5 s wait for the ack starts when
//!   local-stt has actually forwarded the finalize to the engine
//!   (`FinalizeSent`), not when it was asked for: while the engine loads, the
//!   finalize queues behind all the audio that piled up. Up to
//!   [`FINALIZE_FORWARD_MS`] is allowed for that. A turn (or dictation) that
//!   still times out takes its interim tail too, so it isn't lost.
//! - **The agent starting while the user holds the floor** without barge-in
//!   (converging or half-duplex): the user was first, so the run stays open
//!   and ends on its own hangover; the VAD is ignored only once it ends, and
//!   echo opens no new run. Echo that keeps the run from ever going quiet is
//!   bounded ([`TurnConfig::overlap_soft_ms`], [`TurnConfig::overlap_max_ms`]).
//! - **Idle** counts only in `listening` with no reply pending: from a sent
//!   turn until the agent next speaks (at most [`TurnConfig::reply_wait_ms`])
//!   the session waits for the reply, not for the user. An interactive
//!   session never idles out (below).
//! - **An aside** (`voice_set_aside`: voice mode's greeting, spoken before
//!   the user's first turn, with its text) may be talked over before the
//!   echo mode allows barge-in: the DSP thread fires barge-in into it on the
//!   route's headphones hint alone, unless an echo path has been measured
//!   ([`Machine::barge_aside`]). The run such a barge-in opens is the user's
//!   from its onset and counts its sustain like any barge-in, so a short
//!   "Hello?" is a turn. What keeps the aside's own echo (a speaker whose
//!   name says headphones) from being one is its words: a run opened over
//!   an aside drops the aside's words it begins with ([`AsideEcho`]), and a
//!   run left with none sends nothing.
//!   Where barge-in isn't allowed (laptop speakers never carry the hint) the
//!   aside plays out, but speech over it is tracked (a shadow run): if the
//!   user is still talking when the aside ends, or starts again within the
//!   echo guard, that run becomes the turn from its onset, less the aside's
//!   words. The aside ends with the agent going quiet, a barge-in, or a sent
//!   turn.
//!
//! Dictation: no turns, no barge-in; `listening` ↔ `user_speaking` for the
//! UI, the transcript is everything since the start, and stop finalizes and
//! ends with the whole text.
//!
//! **Interactive** (`voice_start { mode: "interactive" }`, the web's
//! Interactive toggle: listen mode reading aloud while the mic waits for the
//! agent's name) is a conversation in every state and transition above, with
//! three differences:
//! - it never idle-ends (the mic stays open for as long as the toggle is on;
//!   every other end is unchanged);
//! - it starts with the barge policy [`BargePolicy::Wake`] (below);
//! - the session feeds local-stt only around speech ([`super::feed`]), which
//!   the machine never sees: word times reach it on the session audio clock
//!   as always.
//!
//! Every end of turn emits `voice://turn` and goes straight back to resting
//! (listening, or agent speaking while the reading plays), as a conversation
//! does: nothing waits for a reply. The web drops the turns that don't hold
//! the name.
//!
//! **Barge policy** (`voice_set_barge`, switchable mid-session in a
//! conversation or an interactive session; a conversation starts with
//! `speech`, or `off` for `bargeIn: false`): what the user talking over
//! audible agent speech does.
//! - `speech`: barge-in as above (the DSP thread cancels the speech,
//!   `voice://interrupted`, the run is the user's from its onset).
//! - `wake`: the same detector, with the same echo-mode rule (only while
//!   `cancelling` or `headphones`: on speakers before the canceller converges
//!   the agent's own voice would be the "user"), fires without cancelling
//!   anything ([`Machine::on_wake`]): the run opens from its onset, its words
//!   stream as `voice://transcript` and it ends in a `voice://turn` like any
//!   other, while the agent's speech goes on. The web decides: on the name it
//!   pauses the reading itself, which the run doesn't notice (it was already
//!   the user's; it just stops being bounded as overlap). Armed while the
//!   agent speaks and nobody holds the floor, or while a turn is being
//!   finalized with nothing queued behind it (the user going on after a pause
//!   is the next turn, not lost). A wake run is bounded like any run the
//!   agent talks over without barge-in ([`TurnConfig::overlap_soft_ms`],
//!   [`TurnConfig::overlap_max_ms`]): the agent's echo left in the cleaned
//!   mic can't hold it open for ever while the reading goes on.
//! - `off`: talking over the agent opens no turn (the 0.2.45 `bargeIn: false`).
//!
//! Asides (above) only ever barge in under `speech`.

use std::collections::VecDeque;

use crate::modules::stt::{SttWord, VoiceSttEvent};

use super::events::{EchoMode, EndReason, NoiseMode, SessionState};
use super::profile::{AutoSwitch, GateLevel, LevelGate, NoiseProfile, Tuning, TurnTuning, WordFilter};
use super::transcript::{norm, Text, Transcript};
use super::SAMPLE_RATE;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Dictation,
    Conversation,
    /// A conversation that never idle-ends and starts on the `wake` barge
    /// policy, its STT fed around speech only (module docs).
    Interactive,
}

impl Mode {
    /// `voice_start`'s `mode` (and a trace header's).
    pub fn from_name(name: &str) -> Option<Mode> {
        match name {
            "dictation" => Some(Mode::Dictation),
            "conversation" => Some(Mode::Conversation),
            "interactive" => Some(Mode::Interactive),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Mode::Dictation => "dictation",
            Mode::Conversation => "conversation",
            Mode::Interactive => "interactive",
        }
    }

    /// Turns, barge-in, agent speech, the held TTS output: a conversation or
    /// an interactive session (everything but dictation).
    pub fn converses(self) -> bool {
        matches!(self, Mode::Conversation | Mode::Interactive)
    }
}

/// What the user talking over audible agent speech does (`voice_set_barge`;
/// module docs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BargePolicy {
    /// Barge-in: the speech is cancelled, `voice://interrupted`, the turn
    /// proceeds.
    Speech,
    /// The speech goes on; the user's run opens, streams and ends in a turn.
    Wake,
    /// No turn opens (the 0.2.45 `bargeIn: false`).
    Off,
}

impl BargePolicy {
    pub fn from_name(name: &str) -> Option<BargePolicy> {
        match name.trim() {
            "speech" => Some(BargePolicy::Speech),
            "wake" => Some(BargePolicy::Wake),
            "off" => Some(BargePolicy::Off),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            BargePolicy::Speech => "speech",
            BargePolicy::Wake => "wake",
            BargePolicy::Off => "off",
        }
    }

    /// A session's policy at its start: an interactive one's is `wake`
    /// (`bargeIn` is ignored), a conversation's `speech` or `off` by its
    /// `bargeIn`; dictation has none (`off`).
    pub fn initial(mode: Mode, barge_in: bool) -> BargePolicy {
        match mode {
            Mode::Interactive => BargePolicy::Wake,
            Mode::Conversation if barge_in => BargePolicy::Speech,
            Mode::Conversation | Mode::Dictation => BargePolicy::Off,
        }
    }
}

/// Default pause that ends a turn (the web's "Normal").
pub const DEFAULT_END_SILENCE_MS: u32 = 700;
/// The web offers 500 / 700 / 1200; anything outside this is clamped.
pub const MIN_END_SILENCE_MS: u32 = 200;
pub const MAX_END_SILENCE_MS: u32 = 3_000;
/// Silero's frame, until the DSP thread reports the real one.
pub const DEFAULT_VAD_FRAME: usize = 512;
/// The turn id dictation's transcript events carry.
pub const DICTATION_TURN_ID: &str = "dictation";
/// How long a finalize may take to reach the engine (queued behind audio
/// that piled up while it loaded) before the turn goes with what it has.
pub const FINALIZE_FORWARD_MS: u64 = 3_000;
/// A turn cut by mute ends this much audio after the last VAD frame seen:
/// the DSP thread's partial VAD frame (≤ 32 ms) and the frames in flight when
/// the mute landed, plus local-stt's word-time rounding. Only speech from
/// before the mute can start in it (local-stt gets silence after it).
pub const MUTE_TAIL_MS: u64 = 250;
/// The web's dictation stop timeout (use-dictation.ts
/// `DICTATION_STOP_TIMEOUT_MS`): the desktop's stop must end well before it.
pub const WEB_DICTATION_STOP_TIMEOUT_MS: u64 = 5_500;
/// A dictation stop always ends within this: the ready wait, the forward and
/// the ack all fit inside it, a second under the web's timeout.
pub const STOP_MAX_MS: u64 = 4_500;
const _: () = assert!(STOP_MAX_MS + 1_000 <= WEB_DICTATION_STOP_TIMEOUT_MS);
const _: () = assert!(Tuning::QUIET.turn.finalize_forward_ms == FINALIZE_FORWARD_MS);
const _: () = assert!(Tuning::QUIET.turn.stop_max_ms == STOP_MAX_MS);
const _: () = assert!(Tuning::NOISY.turn.stop_max_ms + 1_000 <= WEB_DICTATION_STOP_TIMEOUT_MS);
/// After a barge-in into an aside, its echo may reach the mic this much
/// longer (the output's latency, the room): the aside's words that start
/// before then may be its own.
pub const ASIDE_ECHO_TAIL_MS: u64 = 400;
/// An aside that played out over speech (no barge-in): speech heard this
/// recently when it ends is the user still talking, not its echo (the echo
/// stopped with the audio, [`TurnConfig::agent_quiet_grace_ms`] earlier).
pub const ASIDE_LIVE_MS: u32 = 160;

#[derive(Debug, Clone)]
pub struct TurnConfig {
    pub mode: Mode,
    pub end_silence_ms: u32,
    /// "Interrupt by talking": the start's barge policy, `speech` or `off`
    /// ([`BargePolicy::initial`]; an interactive session starts on `wake`
    /// whatever this says). `voice_set_barge` changes the machine's policy,
    /// never this.
    pub barge_in: bool,
    /// Turn VAD thresholds (§3.3a): onset, and the off level below which a
    /// frame is silence.
    pub onset: f32,
    pub off: f32,
    pub min_speech_ms: u32,
    /// Barge-in's sustain (its onset run counts as this much speech).
    pub barge_in_ms: u32,
    /// Words this far before the onset still belong to the turn.
    pub onset_slack_ms: u32,
    /// The ack wait, from when the finalize reached the engine.
    pub finalize_timeout_ms: u64,
    /// ...and how long it may take to get there ([`FINALIZE_FORWARD_MS`]).
    pub finalize_forward_ms: u64,
    /// Dictation stop before local-stt is ready: wait this long for it.
    pub stop_wait_ready_ms: u64,
    /// A dictation stop always ends within this ([`STOP_MAX_MS`]).
    pub stop_max_ms: u64,
    pub idle_ms: u64,
    /// A reply pending (a turn sent, the agent not yet speaking) holds the
    /// idle clock for at most this long.
    pub reply_wait_ms: u64,
    /// The agent speaking over the user's run with no barge-in (converging,
    /// half-duplex): after this long the run ends at its next silent frame...
    pub overlap_soft_ms: u64,
    /// ...and after this long regardless (echo that never goes quiet).
    pub overlap_max_ms: u64,
    /// The TTS watch reads false between sentences: only this much quiet
    /// counts as the agent having stopped.
    pub agent_quiet_grace_ms: u64,
    /// After the agent stops, onsets this soon are its echo tail.
    pub echo_guard_ms: u64,
    /// Keep this many seconds of unclaimed words while nobody is talking.
    pub keep_words_s: f64,
    /// The background-noise preset these values came from.
    pub profile: NoiseProfile,
    /// Noise mechanisms (noise design §2): all `None` in the quiet room.
    /// The near-field level gate: onset confirmation, far speech as silence,
    /// the user's speech level.
    pub gate: Option<LevelGate>,
    /// Words no near frame vouches for leave the turn.
    pub word_filter: Option<WordFilter>,
    /// A hard cap on one run (wall ms).
    pub max_run_ms: Option<u64>,
    /// Auto (noise design WP7): the quiet room's values above until the
    /// switch, then these.
    pub auto: Option<AutoConfig>,
}

/// Auto's two rooms: what the session switches to (and back from).
#[derive(Debug, Clone, Copy)]
pub struct AutoConfig {
    pub switch: AutoSwitch,
    /// The quiet room's thresholds (the start, and a revert).
    pub quiet: TurnTuning,
    /// The noisy room's, with its mechanisms.
    pub noisy: TurnTuning,
    /// The level gate: it judges every frame from the first (S, N,
    /// near/far), and gates turns once switched.
    pub gate: LevelGate,
    pub word_filter: Option<WordFilter>,
    pub max_run_ms: Option<u64>,
}

impl TurnConfig {
    /// The quiet room ([`Tuning::QUIET`], the 0.2.45 tuning). The tests' way
    /// in; sessions use [`TurnConfig::for_profile`].
    #[allow(dead_code)]
    pub fn new(mode: Mode, end_silence_ms: u32, barge_in: bool) -> Self {
        Self::for_profile(mode, end_silence_ms, barge_in, NoiseProfile::Quiet)
    }

    /// Whether the idle end applies: never to an interactive session (its
    /// mic stays open while the toggle is on).
    fn idles(&self) -> bool {
        self.mode != Mode::Interactive
    }

    /// `profile`'s tuning with the user's settings (end silence, clamped to
    /// 200..=3000; "Interrupt by talking").
    pub fn for_profile(mode: Mode, end_silence_ms: u32, barge_in: bool, profile: NoiseProfile) -> Self {
        Self::for_tuning(mode, end_silence_ms, barge_in, profile.tuning())
    }

    /// [`Self::for_profile`] with any tuning (the replay harness tries
    /// variants).
    ///
    /// An Auto tuning ([`Tuning::auto`]) starts as [`Tuning::QUIET`] and
    /// carries the rest of the tuning as the room it switches to.
    pub fn for_tuning(mode: Mode, end_silence_ms: u32, barge_in: bool, tuning: &Tuning) -> Self {
        if let (Some(switch), Some(gate)) = (tuning.auto, tuning.gate) {
            let mut cfg = Self::for_tuning(mode, end_silence_ms, barge_in, &Tuning::QUIET);
            cfg.profile = tuning.profile;
            cfg.auto = Some(AutoConfig {
                switch,
                quiet: Tuning::QUIET.turn,
                noisy: tuning.turn,
                gate,
                word_filter: tuning.word_filter,
                max_run_ms: tuning.max_run_ms,
            });
            return cfg;
        }
        let t = tuning.turn;
        Self {
            mode,
            end_silence_ms: end_silence_ms.clamp(MIN_END_SILENCE_MS, MAX_END_SILENCE_MS),
            barge_in,
            onset: t.onset,
            off: t.off,
            min_speech_ms: t.min_speech_ms,
            barge_in_ms: t.barge_in_ms,
            onset_slack_ms: t.onset_slack_ms,
            finalize_timeout_ms: t.finalize_timeout_ms,
            finalize_forward_ms: t.finalize_forward_ms,
            stop_wait_ready_ms: t.stop_wait_ready_ms,
            stop_max_ms: t.stop_max_ms,
            idle_ms: t.idle_ms,
            reply_wait_ms: t.reply_wait_ms,
            overlap_soft_ms: t.overlap_soft_ms,
            overlap_max_ms: t.overlap_max_ms,
            agent_quiet_grace_ms: t.agent_quiet_grace_ms,
            echo_guard_ms: t.echo_guard_ms,
            keep_words_s: t.keep_words_s,
            profile: tuning.profile,
            gate: tuning.gate,
            word_filter: tuning.word_filter,
            max_run_ms: tuning.max_run_ms,
            auto: None,
        }
    }

    /// Auto switched rooms: `t`'s thresholds and timers (the user's end
    /// silence and barge-in setting stay).
    fn set_turn(&mut self, t: &TurnTuning) {
        self.onset = t.onset;
        self.off = t.off;
        self.min_speech_ms = t.min_speech_ms;
        self.barge_in_ms = t.barge_in_ms;
        self.onset_slack_ms = t.onset_slack_ms;
        self.finalize_timeout_ms = t.finalize_timeout_ms;
        self.finalize_forward_ms = t.finalize_forward_ms;
        self.stop_wait_ready_ms = t.stop_wait_ready_ms;
        self.stop_max_ms = t.stop_max_ms;
        self.idle_ms = t.idle_ms;
        self.reply_wait_ms = t.reply_wait_ms;
        self.overlap_soft_ms = t.overlap_soft_ms;
        self.overlap_max_ms = t.overlap_max_ms;
        self.agent_quiet_grace_ms = t.agent_quiet_grace_ms;
        self.echo_guard_ms = t.echo_guard_ms;
        self.keep_words_s = t.keep_words_s;
    }
}

/// What the session does next.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    State { state: SessionState, echo: EchoMode },
    Transcript { turn_id: String, text: String, is_final: bool },
    Turn { turn_id: String, text: String },
    Interrupted { turn_id: String },
    /// Send `finalize(seq)` to local-stt; its `Finalized{seq}` comes back as
    /// an input.
    Finalize { seq: u64 },
    /// Auto switched rooms (`reason`: what it heard). Never under the quiet
    /// or noisy preset, so their action streams are unchanged.
    NoiseMode { mode: NoiseMode, reason: String },
    /// The session is over (always the last action).
    End { reason: EndReason, text: Option<String>, error: Option<String> },
}

/// A run open now, as [`Machine::open_runs`] shows it (audio clock samples).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunView {
    pub turn_id: String,
    /// Where its words are taken from: the onset less the onset slack.
    pub from: u64,
    /// Where its audio ends: the turn's end once it went to `processing`, or
    /// the mute that cut it; None while it goes on.
    pub until: Option<u64>,
}

/// One speech run: a turn in progress (or, in dictation, just the UI's
/// "user speaking").
#[derive(Debug, Clone)]
struct Run {
    id: String,
    /// Audio clock (samples) of its first speech frame.
    onset: u64,
    speech_frames: u32,
    silence_frames: u32,
    /// The transcript text last emitted for it.
    shown: String,
    /// When the agent became audible over this run (wall ms).
    overlap_since: Option<u64>,
    /// When the run started (wall ms; [`TurnConfig::max_run_ms`]).
    started_wall: u64,
    /// A run queued behind a turn being finalized that mute cut: the audio
    /// clock it ends at. It is sent after that turn, and the mic (after an
    /// unmute) no longer steps it.
    cut: Option<u64>,
    /// Behind a cut run: what the user says after unmuting, a run of its own
    /// from its first onset past the cut (stepped as a queued run is). It
    /// becomes the queued run once the cut run goes to `processing`.
    after: Option<Box<Run>>,
    /// Opened over an aside: its words it may begin with.
    echo: Option<AsideEcho>,
}

/// The words of an aside a run opened over it may begin with (its echo on
/// the mic), up to audio clock `until`.
#[derive(Debug, Clone)]
struct AsideEcho {
    /// Normalized ([`norm`]), in order.
    words: Vec<String>,
    until: u64,
}

impl AsideEcho {
    /// How many of `words` (in order) are the aside's own: the leading
    /// stretch that starts before `until` and follows the aside's words in
    /// order (the echo may begin mid-line or skip a word the engine missed).
    /// The first word that doesn't is the user's, and so is all after it.
    fn leading(&self, words: &[(&SttWord, bool)]) -> usize {
        let until = secs(self.until);
        let mut next = 0;
        let mut n = 0;
        for (w, _) in words {
            if w.start >= until {
                break;
            }
            let heard = norm(&w.word);
            let at = self.words.get(next..).and_then(|rest| rest.iter().position(|a| alike(a, &heard)));
            match at {
                Some(k) => next += k + 1,
                None if heard.is_empty() => {}
                None => break,
            }
            n += 1;
        }
        n
    }
}

/// The aside's words, normalized.
fn aside_words(text: &str) -> Vec<String> {
    text.split_whitespace().map(norm).filter(|w| !w.is_empty()).collect()
}

/// The engine heard the aside's word `a` as `b`: the same, or one edit
/// apart ("yo" / "you", "doing" / "doin").
fn alike(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    if a.is_empty() || b.is_empty() || a.len().abs_diff(b.len()) > 1 {
        return false;
    }
    let (short, long) = if a.len() <= b.len() { (&a, &b) } else { (&b, &a) };
    let pre = short.iter().zip(long.iter()).take_while(|(x, y)| x == y).count();
    if short.len() == long.len() {
        // One substitution.
        short[pre + 1..] == long[pre + 1..]
    } else {
        // One insertion.
        short[pre..] == long[pre + 1..]
    }
}

impl Run {
    /// The last run of the chain queued behind this one (cut, cut, ...).
    fn tail(&mut self) -> &mut Run {
        match self.after {
            Some(ref mut a) => a.tail(),
            None => self,
        }
    }

    /// [`Self::tail`], read-only.
    fn last(&self) -> &Run {
        self.after.as_deref().map_or(self, Run::last)
    }

    /// Drops the chain's last run (never this one).
    fn drop_tail(&mut self) {
        match self.after {
            Some(ref mut a) if a.after.is_some() => a.drop_tail(),
            _ => self.after = None,
        }
    }
}

/// The level gate's view of one VAD frame (the noisy room's frame ring).
#[derive(Debug, Clone, Copy)]
struct FrameRec {
    start: u64,
    end: u64,
    /// Wall ms it arrived.
    wall: u64,
    prob: f32,
    /// The level the gate judged ([`GateLevel`]).
    level_db: f32,
    near_on: bool,
    near_sus: bool,
    /// Near enough on its own level, unsmoothed, to vouch for a word
    /// ([`WordFilter`]; the smoothed level lingers into the next word).
    vouch: bool,
}

/// The frame ring keeps this much audio: a whole capped run and its onset
/// slack, with room to spare...
const RING_S: f64 = 60.0;
/// ...or in dictation, where the word filter judges the whole text at the
/// stop, all of it (bounded all the same: ~35 bytes a 32 ms frame).
const RING_DICTATION_S: f64 = 2.0 * 3600.0;

/// Auto's running state ([`AutoSwitch`]).
#[derive(Debug)]
struct AutoState {
    cfg: AutoConfig,
    /// The room the session runs now.
    mode: NoiseMode,
    /// Far-speech frames `[start, end)` (audio clock), oldest first.
    far: VecDeque<(u64, u64)>,
    /// Frames before this (audio clock) are the user's (an onset-near
    /// frame just before).
    near_until: u64,
    /// The latest far frame (wall ms; the switch counts as one).
    last_far: u64,
    /// A switch decided (wall ms), waiting for nobody to hold the floor.
    pending: Option<(NoiseMode, String, u64)>,
    /// Went back to the quiet room once: the next switch is for good.
    reverted: bool,
    /// S is the user's level, so far speech can be judged against it: this
    /// mic remembered it, or a sent turn was heard mostly within its reach
    /// ([`AutoSwitch::known_share`]). Cleared with S (a mic swap, a stale
    /// remembered level relaxing to the bootstrap).
    s_known: bool,
}

#[derive(Debug)]
enum Phase {
    Starting,
    Listening,
    UserSpeaking(Run),
    /// End of turn: finalize sent (`seq`) or waiting for local-stt to be
    /// ready (`None`); `until` is the audio clock at the end of the turn.
    Processing { run: Run, until: u64, seq: Option<u64>, deadline: Option<u64>, next: Option<Run> },
    AgentSpeaking,
}

/// Dictation's stop: finalize sent (`seq`), or waiting for readiness.
#[derive(Debug)]
struct Stopping {
    seq: Option<u64>,
    deadline: u64,
    /// `deadline` never goes past this ([`TurnConfig::stop_max_ms`]).
    hard: u64,
}

pub struct Machine {
    cfg: TurnConfig,
    phase: Phase,
    muted: bool,
    echo: EchoMode,
    /// What talking over the agent does now ([`BargePolicy::initial`], then
    /// `voice_set_barge`).
    barge: BargePolicy,
    /// TTS audible (the watch), whatever the phase.
    speaking: bool,
    stt_ready: bool,
    /// The DSP thread reported it is up (`Input::Started`).
    dsp_up: bool,
    vad_frame: usize,
    transcript: Transcript,
    turns: u32,
    finalizes: u64,
    /// While `AgentSpeaking`: when the TTS went quiet.
    quiet_since: Option<u64>,
    /// Onsets before this (ms) are the agent's echo tail.
    guard_until: u64,
    /// How far behind wall time the audio the VAD frames describe arrives
    /// (the DSP thread's mic hold while the system tap runs; 0 otherwise):
    /// the echo guard, measured on wall time, stretches by it so it covers
    /// the same audio.
    audio_delay_ms: u64,
    /// Idle end counts from here while listening.
    idle_since: u64,
    /// The agent's speech is an aside (`voice_set_aside`) until it goes
    /// quiet, is barged into, or a turn is sent.
    aside: bool,
    /// The aside's words ([`aside_words`]).
    aside_words: Vec<String>,
    /// Speech over an aside that can't be barged into (no id yet): while it
    /// plays, and after it through the echo guard. It becomes the user's run
    /// if they are still talking as the aside ends, or talk again within
    /// the guard ([`Self::check_agent_quiet`]).
    shadow: Option<Run>,
    /// A turn was sent and the agent hasn't spoken since (wall ms of the
    /// turn): idle doesn't count meanwhile.
    reply_pending: Option<u64>,
    last_state: Option<(SessionState, EchoMode)>,
    dictation_shown: String,
    stopping: Option<Stopping>,
    ended: bool,
    /// Audio clock at the end of the latest VAD frame.
    clock: u64,
    /// The level gate (noisy room only): recent frames...
    frames: VecDeque<FrameRec>,
    /// ...the user's speech level S (dBFS)...
    speech_db: f32,
    /// ...whether a sent turn has measured it yet...
    speech_measured: bool,
    /// ...how many sent turns in a row were too far under it to move it
    /// ([`LevelGate::adapt`]), what S was before turns last lifted it
    /// (until a turn lands within reach of it, or it relaxes back), and the
    /// frames of speech since the last onset that level would have heard
    /// ([`LevelGate::relax_missed_ms`])...
    low_turns: u32,
    lift_from: Option<f32>,
    /// ...(a remembered level over the bootstrap relaxes back to the
    /// bootstrap, and on reaching it S is unmeasured again: the cold start
    /// it replaced)...
    lift_cold: bool,
    missed_frames: u32,
    /// ...how many sent turns measured a level for it (never reset: the
    /// session's per-device memory counts from its own marks, WP7)...
    measured_turns: u32,
    /// ...and the level the gate judges.
    gate_level: GateLevel,
    /// Auto (None under the quiet and noisy presets).
    auto: Option<AutoState>,
    out: Vec<Action>,
}

fn secs(samples: u64) -> f64 {
    samples as f64 / SAMPLE_RATE as f64
}

/// The word filter: a frame that vouches ([`WordFilter::vouches`]), at or
/// above `off`, overlaps the word's span widened by `slack` on each side.
fn vouched(frames: &VecDeque<FrameRec>, off: f32, w: &SttWord, slack: f64) -> bool {
    let (a, b) = (w.start - slack, w.end + slack);
    // (Frames are in audio-clock order: the first one ending after `a`, and
    // on while they start before `b`. A dictation's ring is long.)
    let first = frames.partition_point(|f| secs(f.end) <= a);
    frames.range(first..).take_while(|f| secs(f.start) < b).any(|f| f.vouch && f.prob >= off)
}

/// The words of `[from, until)` a turn (or its caption) shows: all of them,
/// or with the word filter only those a near frame vouches for; less, for a
/// run opened over an aside (`echo`), the aside's words it begins with.
fn words_text(
    cfg: &TurnConfig,
    transcript: &Transcript,
    frames: &VecDeque<FrameRec>,
    echo: Option<&AsideEcho>,
    from: f64,
    until: f64,
    interim: bool,
) -> Text {
    let words = transcript.words(from, until, interim);
    let words: Vec<(&SttWord, bool)> = match cfg.word_filter {
        None => words,
        Some(f) => words.into_iter().filter(|(w, _)| vouched(frames, cfg.off, w, f.slack_s)).collect(),
    };
    let skip = echo.map_or(0, |e| e.leading(&words));
    Text::of(words.into_iter().skip(skip))
}

impl Machine {
    pub fn new(cfg: TurnConfig, echo: EchoMode) -> Self {
        let speech_db = cfg.gate.or(cfg.auto.map(|a| a.gate)).map_or(0.0, |g| g.bootstrap_speech_db);
        let auto = cfg.auto.map(|a| AutoState {
            cfg: a,
            mode: NoiseMode::Quiet,
            far: VecDeque::new(),
            near_until: 0,
            last_far: 0,
            pending: None,
            reverted: false,
            s_known: false,
        });
        let barge = BargePolicy::initial(cfg.mode, cfg.barge_in);
        Self {
            cfg,
            phase: Phase::Starting,
            muted: false,
            echo,
            barge,
            speaking: false,
            stt_ready: false,
            dsp_up: false,
            vad_frame: DEFAULT_VAD_FRAME,
            transcript: Transcript::new(),
            turns: 0,
            finalizes: 0,
            quiet_since: None,
            guard_until: 0,
            audio_delay_ms: 0,
            idle_since: 0,
            aside: false,
            aside_words: Vec::new(),
            shadow: None,
            reply_pending: None,
            last_state: None,
            dictation_shown: String::new(),
            stopping: None,
            ended: false,
            clock: 0,
            frames: VecDeque::new(),
            speech_db,
            speech_measured: false,
            low_turns: 0,
            lift_from: None,
            lift_cold: false,
            missed_frames: 0,
            measured_turns: 0,
            gate_level: GateLevel::default(),
            auto,
            out: Vec::new(),
        }
    }

    /// The level gate's parameters: the noisy room's, or Auto's (which
    /// judges every frame from the first, switched or not). None in the
    /// quiet room.
    fn level_gate(&self) -> Option<LevelGate> {
        self.cfg.gate.or(self.auto.as_ref().map(|a| a.cfg.gate))
    }

    /// The room the session runs now: its preset's, or Auto's current one.
    pub fn noise_mode(&self) -> NoiseMode {
        match (&self.auto, self.cfg.profile) {
            (Some(a), _) => a.mode,
            (None, NoiseProfile::Noisy) => NoiseMode::Noisy,
            (None, _) => NoiseMode::Quiet,
        }
    }

    pub fn mode(&self) -> Mode {
        self.cfg.mode
    }

    pub fn profile(&self) -> NoiseProfile {
        self.cfg.profile
    }

    /// Start from a remembered speech level S (the web's per-device hint,
    /// WP7) instead of the bootstrap; it counts as measured. No-op without a
    /// gate or a hint.
    ///
    /// A remembered level over the bootstrap may be stale (another louder
    /// talker, the user closer to the mic that day, a TV's turns): nothing
    /// this session measured lifted it, so the relax rule may take it back
    /// down to the bootstrap, where S is unmeasured again, if the user's
    /// speech goes unheard under it ([`LevelGate::relax_missed_ms`]). A turn
    /// within reach of it confirms it.
    pub fn with_speech_hint(mut self, db: Option<f32>) -> Self {
        if let Some(db) = db {
            self.apply_speech_hint(db);
        }
        self
    }

    /// [`Self::with_speech_hint`] / [`Self::on_speech_hint`]. No-op without a
    /// gate or for a hint that isn't a number.
    fn apply_speech_hint(&mut self, db: f32) {
        let Some(g) = self.level_gate() else { return };
        if !db.is_finite() {
            return;
        }
        self.speech_db = db.clamp(g.speech_min_db, g.speech_max_db);
        self.speech_measured = true;
        if let Some(a) = self.auto.as_mut() {
            a.s_known = true;
        }
        self.low_turns = 0;
        self.missed_frames = 0;
        let stale_high = self.speech_db > g.bootstrap_speech_db;
        self.lift_from = stale_high.then_some(g.bootstrap_speech_db);
        self.lift_cold = stale_high;
    }

    /// The level gate's view of the latest frame: the level it judged, and
    /// whether it was onset-near and sustain-near (diagnostics).
    pub fn gate_view(&self) -> Option<(f32, bool, bool)> {
        self.frames.back().map(|f| (f.level_db, f.near_on, f.near_sus))
    }

    /// The user's speech level S (dBFS) the level gate works with, and
    /// whether a sent turn has measured it, for the DSP thread's barge-in
    /// detector; `None` without a gate (quiet room).
    pub fn speech_level(&self) -> Option<(f32, bool)> {
        self.level_gate().map(|_| (self.speech_db, self.speech_measured))
    }

    /// What the DSP thread's barge-in detector gates on: S when barge-in is
    /// the noisy room's, `None` for the quiet room's. The noisy preset
    /// always; Auto once switched, or before that once S is known (with
    /// [`AutoSwitch::barge_when_known`]).
    pub fn barge_level(&self) -> Option<(f32, bool)> {
        match &self.auto {
            None => self.speech_level(),
            Some(a) => {
                let gated = a.mode == NoiseMode::Noisy || (a.cfg.switch.barge_when_known && self.speech_measured);
                gated.then_some((self.speech_db, self.speech_measured))
            }
        }
    }

    /// How many sent turns so far measured the user's level (0 without a
    /// gate). A remembered level ([`Self::with_speech_hint`]) is not a turn.
    pub fn measured_turns(&self) -> u32 {
        self.measured_turns
    }

    #[cfg(test)]
    pub fn ended(&self) -> bool {
        self.ended
    }

    /// The first state event.
    pub fn start(&mut self, now: u64) -> Vec<Action> {
        self.idle_since = now;
        self.finish()
    }

    /// The DSP thread is up (its `Started`, with or without a VAD).
    pub fn set_dsp_up(&mut self) {
        self.dsp_up = true;
    }

    /// `voice://state`'s `ready`: local-stt reported Ready for this session
    /// and the DSP thread is up. Not part of [`Action::State`] (the replay
    /// goldens); the session shows it ([`super::events::ShownState`]).
    pub fn ready(&self) -> bool {
        self.stt_ready && self.dsp_up
    }

    /// The VAD's real frame length (samples at 16 kHz).
    pub fn set_vad_frame(&mut self, samples: usize) {
        if samples > 0 {
            self.vad_frame = samples;
        }
    }

    /// Whether the DSP thread may fire barge-in (it also checks the echo mode
    /// and that TTS is audible at that very frame), or under the `wake`
    /// policy its wake ([`Self::barge_wakes`]).
    ///
    /// `speech`: while the agent speaks, or the user holds the floor (the
    /// reply starting over them is cut when they go on). `wake`: while the
    /// agent speaks with nobody holding the floor, or a turn is being
    /// finalized with nothing queued behind it; never inside the user's run,
    /// which is theirs already. `off`: never.
    pub fn barge_armed(&self) -> bool {
        let phase = match self.barge {
            BargePolicy::Speech => matches!(self.phase, Phase::AgentSpeaking | Phase::UserSpeaking(_)),
            BargePolicy::Wake => matches!(self.phase, Phase::AgentSpeaking | Phase::Processing { next: None, .. }),
            BargePolicy::Off => false,
        };
        !self.ended && self.cfg.mode.converses() && !self.muted && self.speaking && phase
    }

    /// The DSP thread's barge-in, when it fires, opens the user's run
    /// without cancelling the speech ([`DspEvent::Wake`](super::dsp::DspEvent::Wake),
    /// [`Self::on_wake`]): the `wake` policy.
    pub fn barge_wakes(&self) -> bool {
        self.barge == BargePolicy::Wake
    }

    /// The barge policy now.
    pub fn barge_policy(&self) -> BargePolicy {
        self.barge
    }

    /// Barge-in is armed ([`Self::barge_armed`]) and the agent's speech is
    /// an aside: the DSP thread may fire it on the route's headphones hint
    /// alone (no echo path measured), before the echo mode allows it. Only
    /// under `speech`: a wake waits for the echo mode.
    pub fn barge_aside(&self) -> bool {
        self.aside && self.barge == BargePolicy::Speech && self.barge_armed()
    }

    /// The state the web is shown.
    pub fn state(&self) -> SessionState {
        if self.muted {
            return SessionState::Muted;
        }
        match self.phase {
            Phase::Starting => SessionState::Starting,
            Phase::Listening => SessionState::Listening,
            Phase::UserSpeaking(_) => SessionState::UserSpeaking,
            Phase::Processing { .. } => SessionState::Processing,
            Phase::AgentSpeaking => SessionState::AgentSpeaking,
        }
    }

    /// The runs open now that may become turns, for the session's speech
    /// audio (`voice://speech`): the run the user holds, or the turn being
    /// finalized and the runs queued behind it, each with its turn id, the
    /// audio clock its words are taken from (its onset less
    /// [`TurnConfig::onset_slack_ms`], as [`Self::window_start`]) and, once
    /// known, where its audio ends. Read-only. None in dictation (one id for
    /// every run, and no turns), and never a shadow run (no id until it is
    /// promoted).
    pub fn open_runs(&self) -> Vec<RunView> {
        if !self.cfg.mode.converses() {
            return Vec::new();
        }
        let slack = self.cfg.onset_slack_ms as u64 * SAMPLE_RATE / 1000;
        // A run, then the cut chain queued behind it.
        fn chain(run: &Run, until: Option<u64>, slack: u64, out: &mut Vec<RunView>) {
            let mut r = Some(run);
            let mut until = until;
            while let Some(run) = r {
                out.push(RunView { turn_id: run.id.clone(), from: run.onset.saturating_sub(slack), until: until.or(run.cut) });
                r = run.after.as_deref();
                until = None;
            }
        }
        let mut out = Vec::new();
        match &self.phase {
            Phase::UserSpeaking(run) => chain(run, None, slack, &mut out),
            Phase::Processing { run, until, next, .. } => {
                chain(run, Some(*until), slack, &mut out);
                if let Some(next) = next {
                    chain(next, None, slack, &mut out);
                }
            }
            Phase::Starting | Phase::Listening | Phase::AgentSpeaking => {}
        }
        out
    }

    fn frames(&self, ms: u32) -> u32 {
        let samples = ms as u64 * SAMPLE_RATE / 1000;
        samples.div_ceil(self.vad_frame as u64).max(1) as u32
    }

    fn hangover_frames(&self) -> u32 {
        self.frames(self.cfg.end_silence_ms)
    }

    fn min_speech_frames(&self) -> u32 {
        self.frames(self.cfg.min_speech_ms)
    }

    fn new_run(&mut self, onset: u64, speech_frames: u32, now: u64) -> Run {
        let mut run = self.blank_run(onset, speech_frames, now);
        self.name_run(&mut run);
        run
    }

    /// The next turn id for `run`.
    fn name_run(&mut self, run: &mut Run) {
        self.turns += 1;
        run.id = match self.cfg.mode {
            Mode::Conversation | Mode::Interactive => format!("t{}", self.turns),
            Mode::Dictation => DICTATION_TURN_ID.to_string(),
        };
    }

    /// A run with no id yet ([`Self::name_run`]): a shadow's.
    fn blank_run(&self, onset: u64, speech_frames: u32, now: u64) -> Run {
        Run {
            id: String::new(),
            onset,
            speech_frames,
            silence_frames: 0,
            shown: String::new(),
            overlap_since: None,
            started_wall: now,
            cut: None,
            after: None,
            echo: None,
        }
    }

    /// The turn id an interruption with no turn of its own reports.
    fn last_turn_id(&self) -> String {
        format!("t{}", self.turns)
    }

    /// §3.3a silence counting: a frame < off starts or extends the silence, a
    /// frame ≥ onset resets it, one in between keeps counting once started
    /// (and is speech otherwise).
    ///
    /// With the level gate the same hysteresis runs on the level too: a
    /// frame resets the silence only at or above onset *and* onset-near
    /// (`near.0`); at or above off and sustain-near (`near.1`) it is speech
    /// until a silence starts and then holds the silence where it is (soft
    /// speech neither ends nor restarts the turn); anything else is
    /// silence. Far speech (a TV,
    /// people nearby) is silence whatever its probability, and only near
    /// frames count as speech.
    fn step(cfg: &TurnConfig, run: &mut Run, prob: f32, near: (bool, bool)) {
        if cfg.gate.is_some() {
            if prob >= cfg.onset && near.0 {
                run.silence_frames = 0;
                run.speech_frames += 1;
            } else if prob >= cfg.off && near.1 {
                // Soft speech: more of the run, or (once a silence started)
                // it holds the silence where it is (or, without
                // `hold_on_sustain`, extends it).
                if run.silence_frames == 0 {
                    run.speech_frames += 1;
                } else if !cfg.gate.is_some_and(|g| g.hold_on_sustain) {
                    run.silence_frames += 1;
                }
            } else {
                run.silence_frames += 1;
            }
        } else if prob < cfg.off {
            run.silence_frames += 1;
        } else if prob >= cfg.onset {
            run.silence_frames = 0;
            run.speech_frames += 1;
        } else if run.silence_frames > 0 {
            run.silence_frames += 1;
        } else {
            run.speech_frames += 1;
        }
    }

    fn window_start(&self, run: &Run) -> f64 {
        secs(run.onset) - self.cfg.onset_slack_ms as f64 / 1000.0
    }

    /// Talking over the agent may interrupt it now.
    fn barge_ok(&self) -> bool {
        self.barge == BargePolicy::Speech && self.echo.allows_barge_in()
    }

    /// The agent is audible and talking over it can't interrupt it
    /// (converging, half-duplex, or the policy is `off` or `wake`): the mic
    /// carries its voice. Under `wake` the speech goes on over the user's run
    /// by design, so the run is bounded as overlap.
    fn talk_over_blocked(&self) -> bool {
        self.cfg.mode.converses() && self.speaking && !self.barge_ok()
    }

    // ── inputs ────────────────────────────────────────────────────────────

    /// One VAD frame covering `[start, end)` of the audio clock, with its
    /// level and the room's noise floor (dBFS, [`super::dsp::DspEvent::Vad`]).
    /// The quiet room ignores both ([`Self::on_vad`]); the noisy room's
    /// level gate judges the frame by them.
    pub fn on_vad_level(&mut self, prob: f32, start: u64, end: u64, level_db: f32, floor_db: f32, now: u64) -> Vec<Action> {
        if self.auto.is_some() {
            return self.on_vad_auto(prob, start, end, level_db, floor_db, now);
        }
        match self.cfg.gate {
            None => self.on_vad(prob, start, end, now),
            Some(gate) => self.on_vad_gated(gate, prob, start, end, level_db, floor_db, now),
        }
    }

    /// Auto's VAD frame: the gate judges it whichever room runs (the quiet
    /// room ignores the verdict), the room steps it, then the frame counts
    /// toward a switch ([`Self::auto_frame`]).
    fn on_vad_auto(&mut self, prob: f32, start: u64, end: u64, level_db: f32, floor_db: f32, now: u64) -> Vec<Action> {
        if self.ended || self.muted {
            return self.finish();
        }
        let mut out = match self.cfg.gate {
            Some(gate) => self.on_vad_gated(gate, prob, start, end, level_db, floor_db, now),
            None => {
                let Some(a) = self.auto.as_ref() else { return self.on_vad(prob, start, end, now) };
                let (gate, filter) = (a.cfg.gate, a.cfg.word_filter);
                self.clock = self.clock.max(end);
                self.record_frame(gate, filter, prob, start, end, level_db, floor_db, now);
                self.on_vad(prob, start, end, now)
            }
        };
        if let Some(f) = self.frames.back().copied().filter(|f| f.start == start && f.end == end) {
            self.auto_frame(prob, &f, floor_db, now);
        }
        out.extend(self.finish());
        out
    }

    /// Auto: one frame, judged by the gate (`f`), toward a switch or a
    /// revert ([`AutoSwitch`]); a decided one lands when nobody holds the
    /// floor.
    ///
    /// Far speech is judged against S only once S is known
    /// ([`Self::auto_s_known`]). The bootstrap S says nothing about the
    /// user: a soft or distant user (a laptop mic at arm's length, −44..−48
    /// dBFS) is more than `far_below_speech_db` under it without ever being
    /// onset-near, so their own speech would read as a TV, switch the
    /// session and then be gated out by the noisy room, and in dictation
    /// (which never measures S) the word filter would drop their words. A
    /// turn of theirs measures S from its loudest syllables only (the frames
    /// within the bootstrap's reach), which leaves S as far over them. With
    /// S unknown nothing is far: Auto is the quiet room until the mic's
    /// memory or a turn heard mostly within S's reach says who the user is,
    /// and a switch decided before S went unknown again (a mic swap, a stale
    /// remembered level relaxing to the bootstrap) is dropped.
    fn auto_frame(&mut self, prob: f32, f: &FrameRec, floor_db: f32, now: u64) {
        let (speech_db, clock, guard_until) = (self.speech_db, self.clock, self.guard_until);
        let known = self.auto_s_known();
        let agent_on_mic = self.speaking && self.echo != EchoMode::Headphones;
        let Some(a) = self.auto.as_mut() else { return };
        let sw = a.cfg.switch;
        let ms = |ms: u64| ms * SAMPLE_RATE / 1000;
        if !known {
            a.far.clear();
            if a.pending.as_ref().is_some_and(|p| p.0 == NoiseMode::Noisy) {
                a.pending = None;
            }
        }
        // The user talking (a confirmed run and its soft edges): not far.
        if f.near_on && prob >= sw.far_prob {
            a.near_until = f.end + ms(sw.near_mask_ms as u64);
            let back = f.start.saturating_sub(ms(sw.near_mask_before_ms as u64));
            while a.far.back().is_some_and(|x| x.1 > back) {
                a.far.pop_back();
            }
        }
        let far = known
            && f.start >= a.near_until
            && prob >= sw.far_prob
            && f.level_db < speech_db - sw.far_below_speech_db
            && f.level_db >= floor_db + sw.far_above_floor_db
            && !agent_on_mic
            && now >= guard_until;
        if far {
            a.far.push_back((f.start, f.end));
            a.last_far = now;
        }
        let keep = ms(sw.window_ms.max(sw.burst_ms) as u64);
        while a.far.front().is_some_and(|x| x.1 + keep < clock) {
            a.far.pop_front();
        }
        if a.pending.is_none() {
            let within = |far: &VecDeque<(u64, u64)>, window: u64| -> u64 {
                let from = clock.saturating_sub(window);
                far.iter().filter(|x| x.1 > from).map(|x| x.1 - x.0.max(from)).sum()
            };
            let what = |share: u64, window: u64| {
                format!("far speech {:.0} % of the last {:.0} s (S {:.1} dB)", share as f64 * 100.0 / window as f64, window as f64 / SAMPLE_RATE as f64, speech_db)
            };
            match a.mode {
                NoiseMode::Quiet => {
                    let (w, b) = (ms(sw.window_ms as u64), ms(sw.burst_ms as u64));
                    let (in_w, in_b) = (within(&a.far, w), within(&a.far, b));
                    if w > 0 && in_w as f64 >= sw.ratio as f64 * w as f64 {
                        a.pending = Some((NoiseMode::Noisy, what(in_w, w), now));
                    } else if b > 0 && in_b as f64 >= sw.burst_ratio as f64 * b as f64 {
                        a.pending = Some((NoiseMode::Noisy, format!("burst: {}", what(in_b, b)), now));
                    } else if sw.floor_db.is_some_and(|n| floor_db >= n) {
                        a.pending = Some((NoiseMode::Noisy, format!("noise floor {floor_db:.1} dB"), now));
                    }
                }
                NoiseMode::Noisy => {
                    if sw.revert_ms > 0 && !a.reverted && now.saturating_sub(a.last_far) >= sw.revert_ms {
                        a.pending = Some((NoiseMode::Quiet, format!("no far speech for {} s", sw.revert_ms / 1000), now));
                    }
                }
            }
        }
        self.land_noise_mode(now);
    }

    /// Auto: S is the user's level, far speech can be judged against it: this
    /// mic remembered it, or a sent turn measured it with most of its speech
    /// within S's reach ([`AutoSwitch::known_share`]).
    fn auto_s_known(&self) -> bool {
        self.speech_measured && self.auto.as_ref().is_some_and(|a| a.s_known)
    }

    /// Auto: a decided switch lands once nobody holds the floor, never
    /// inside the user's run or turn. A run (or a turn being finalized) with
    /// no onset-near speech in it isn't the user's but the room's (the quiet
    /// room opens a run on a TV): the switch to the noisy room lands in it,
    /// the run is dropped and the turn's words go through the word filter.
    /// Only with S known: with S unknown a run with no onset-near frame may
    /// be a soft user's (onset-near is judged against the bootstrap), so the
    /// switch waits for it to end like any other.
    fn land_noise_mode(&mut self, now: u64) {
        let Some((mode, _, _)) = self.auto.as_ref().and_then(|a| a.pending.as_ref()) else { return };
        let mode = *mode;
        let far_prob = self.auto.as_ref().map_or(1.0, |a| a.cfg.switch.far_prob);
        let known = self.auto_s_known();
        let rooms = |onset: u64| known && !self.frames.iter().any(|f| f.start >= onset && f.near_on && f.prob >= far_prob);
        let drop_run = match &self.phase {
            Phase::Starting | Phase::Listening | Phase::AgentSpeaking => false,
            Phase::UserSpeaking(run) if mode == NoiseMode::Noisy && run.cut.is_none() && run.after.is_none() && rooms(run.onset) => true,
            Phase::Processing { run, next: None, .. } if mode == NoiseMode::Noisy && rooms(run.onset) => false,
            _ => return,
        };
        let Some(a) = self.auto.as_mut() else { return };
        let Some((mode, reason, decided)) = a.pending.take() else { return };
        let reason = if now > decided + 100 { format!("{reason}; landed {:.1} s later", (now - decided) as f64 / 1000.0) } else { reason };
        let c = a.cfg;
        a.mode = mode;
        a.far.clear();
        match mode {
            NoiseMode::Noisy => {
                a.last_far = now;
                self.cfg.set_turn(&c.noisy);
                self.cfg.gate = Some(c.gate);
                self.cfg.word_filter = c.word_filter;
                self.cfg.max_run_ms = c.max_run_ms;
            }
            NoiseMode::Quiet => {
                a.reverted = true;
                self.cfg.set_turn(&c.quiet);
                self.cfg.gate = None;
                self.cfg.word_filter = None;
                self.cfg.max_run_ms = None;
            }
        }
        self.out.push(Action::NoiseMode { mode, reason });
        if drop_run {
            self.abandon(now);
        }
    }

    /// One VAD frame covering `[start, end)` of the audio clock (the quiet
    /// room: probability only).
    pub fn on_vad(&mut self, prob: f32, start: u64, end: u64, now: u64) -> Vec<Action> {
        if self.ended || self.muted {
            return self.finish();
        }
        self.clock = self.clock.max(end);
        let hangover = self.hangover_frames();
        let min_speech = self.min_speech_frames();
        let onset_hit = prob >= self.cfg.onset;
        let blocked = self.talk_over_blocked();
        let (soft, max, off) = (self.cfg.overlap_soft_ms, self.cfg.overlap_max_ms, self.cfg.off);
        // (After an aside that played out over speech.)
        let resumed = matches!(self.phase, Phase::Starting | Phase::Listening)
            && self.shadow_goes_on(prob, (true, true), onset_hit, now);
        match self.phase {
            _ if resumed => self.promote_shadow(now),
            Phase::Starting | Phase::Listening => {
                if onset_hit && now >= self.guard_until {
                    let run = self.new_run(start, 1, now);
                    self.phase = Phase::UserSpeaking(run);
                    self.idle_since = now;
                } else if matches!(self.phase, Phase::Listening) && self.cfg.mode.converses() {
                    // Nobody is talking: words this old can't join a turn.
                    let keep = secs(self.clock) - self.cfg.keep_words_s;
                    self.transcript.forget_before(keep);
                }
            }
            Phase::UserSpeaking(ref mut run) => {
                Self::step(&self.cfg, run, prob, (true, true));
                let mut over = run.silence_frames >= hangover;
                if !over && blocked {
                    // The agent talks over a run the user started first: the
                    // run ends on its own hangover, but echo that never goes
                    // quiet can't hold it open for ever.
                    let held = now.saturating_sub(*run.overlap_since.get_or_insert(now));
                    over = held >= max || (held >= soft && prob < off);
                }
                if over {
                    if run.speech_frames >= min_speech {
                        self.end_of_turn(now);
                    } else {
                        self.abandon(now);
                    }
                }
            }
            // The user goes on while the last turn is being finalized: the
            // next turn is tracked from its own onset. Not while the agent's
            // voice is on the mic and can't be talked over: that onset is
            // (most likely) its echo.
            Phase::Processing { next: None, .. } => {
                if onset_hit && !blocked {
                    let run = self.new_run(start, 1, now);
                    if let Phase::Processing { next, .. } = &mut self.phase {
                        *next = Some(run);
                    }
                }
            }
            // A run mute cut waits for its own finalize: the mic after an
            // unmute can't join it, but opens a run of its own behind it.
            Phase::Processing { next: Some(ref mut run), .. } if run.cut.is_some() => {
                if let Some(cut) = Self::step_after_cut(&self.cfg, run, prob, (true, true), blocked, now, hangover, min_speech) {
                    if onset_hit && !blocked && start >= cut {
                        let follow = self.new_run(start, 1, now);
                        self.queue_after_cut(follow);
                    }
                }
            }
            Phase::Processing { next: Some(ref mut run), .. } => {
                Self::step(&self.cfg, run, prob, (true, true));
                if blocked {
                    run.overlap_since.get_or_insert(now);
                }
                let too_short = run.silence_frames >= hangover && run.speech_frames < min_speech;
                if too_short {
                    if let Phase::Processing { next, .. } = &mut self.phase {
                        *next = None;
                    }
                }
            }
            // Talking over the agent is barge-in's business (DSP thread).
            // Over an aside it may be the user's turn all the same.
            Phase::AgentSpeaking => {
                let shadow = (onset_hit && now >= self.guard_until).then(|| self.blank_run(start, 1, now));
                self.step_shadow(prob, (true, true), shadow);
            }
        }
        self.finish()
    }

    /// A VAD frame while an aside plays and can't be barged into: the
    /// shadow run steps as any run does (dropped at its pause), or `open`
    /// starts one.
    fn step_shadow(&mut self, prob: f32, near: (bool, bool), open: Option<Run>) {
        if !self.aside || !self.cfg.mode.converses() {
            self.shadow = None;
            return;
        }
        match self.shadow {
            Some(ref mut run) => {
                Self::step(&self.cfg, run, prob, near);
                if run.silence_frames >= self.hangover_frames() {
                    self.shadow = None;
                }
            }
            None => self.shadow = open,
        }
    }

    /// A VAD frame after an aside that played out over speech, within the
    /// echo guard: steps the shadow run; true when the user talks again
    /// (`onset`), and the shadow is their run ([`Self::promote_shadow`]).
    /// Past the guard (or at its pause) it is dropped, and onsets are the
    /// listening phase's again.
    fn shadow_goes_on(&mut self, prob: f32, near: (bool, bool), onset: bool, now: u64) -> bool {
        if self.shadow.is_none() {
            return false;
        }
        if now >= self.guard_until {
            self.shadow = None;
            return false;
        }
        let hangover = self.hangover_frames();
        let Some(run) = self.shadow.as_mut() else { return false };
        Self::step(&self.cfg, run, prob, near);
        if onset {
            return true;
        }
        if run.silence_frames >= hangover {
            self.shadow = None;
        }
        false
    }

    /// The shadow run is the user's: it goes on as their run, from its onset
    /// (the aside's own words it begins with are dropped, [`AsideEcho`]).
    fn promote_shadow(&mut self, now: u64) {
        let Some(mut run) = self.shadow.take() else { return };
        self.name_run(&mut run);
        self.phase = Phase::UserSpeaking(run);
        self.quiet_since = None;
        self.idle_since = now;
        self.missed_frames = 0;
        self.show_transcript();
    }

    /// [`Self::on_vad`] behind the near-field level gate (noise design §2.1,
    /// §2.4):
    /// - a turn starts only on `confirm_frames` onset-near frames at or above
    ///   the onset probability among the last `confirm_window`, and is
    ///   backdated to the first of them (so no word is clipped);
    /// - far frames are silence, and only onset-near ones reset a silence
    ///   ([`Self::step`]);
    /// - a run lasts at most [`TurnConfig::max_run_ms`].
    #[allow(clippy::too_many_arguments)]
    fn on_vad_gated(
        &mut self,
        gate: LevelGate,
        prob: f32,
        start: u64,
        end: u64,
        level_db: f32,
        floor_db: f32,
        now: u64,
    ) -> Vec<Action> {
        if self.ended || self.muted {
            return self.finish();
        }
        self.clock = self.clock.max(end);
        let (level_db, near_on, near_sus) = self.record_frame(gate, self.cfg.word_filter, prob, start, end, level_db, floor_db, now);
        let hangover = self.hangover_frames();
        let min_speech = self.min_speech_frames();
        let blocked = self.talk_over_blocked();
        let (soft, max, off) = (self.cfg.overlap_soft_ms, self.cfg.overlap_max_ms, self.cfg.off);
        let max_run = self.cfg.max_run_ms;
        let onset_near = prob >= self.cfg.onset && near_on;
        let resumed = matches!(self.phase, Phase::Starting | Phase::Listening)
            && self.shadow_goes_on(prob, (near_on, near_sus), onset_near, now);
        match self.phase {
            _ if resumed => self.promote_shadow(now),
            Phase::Starting | Phase::Listening => {
                if let Some(run) = self.confirmed_onset(gate, now) {
                    self.phase = Phase::UserSpeaking(run);
                    self.idle_since = now;
                    self.missed_frames = 0;
                } else if matches!(self.phase, Phase::Listening) && self.cfg.mode.converses() {
                    let keep = secs(self.clock) - self.cfg.keep_words_s;
                    self.transcript.forget_before(keep);
                    self.relax(gate, prob, level_db, near_on, now);
                }
            }
            Phase::UserSpeaking(ref mut run) => {
                Self::step(&self.cfg, run, prob, (near_on, near_sus));
                let mut over = run.silence_frames >= hangover;
                if !over && blocked {
                    let held = now.saturating_sub(*run.overlap_since.get_or_insert(now));
                    over = held >= max || (held >= soft && prob < off);
                }
                // Background speech that never pauses can't hold a turn open
                // for ever.
                if max_run.is_some_and(|m| now.saturating_sub(run.started_wall) >= m) {
                    over = true;
                }
                if over {
                    if run.speech_frames >= min_speech {
                        self.end_of_turn(now);
                    } else {
                        self.abandon(now);
                    }
                }
            }
            Phase::Processing { next: None, .. } => {
                if !blocked {
                    if let Some(run) = self.confirmed_onset(gate, now) {
                        if let Phase::Processing { next, .. } = &mut self.phase {
                            *next = Some(run);
                        }
                    }
                }
            }
            Phase::Processing { next: Some(ref mut run), .. } if run.cut.is_some() => {
                if let Some(cut) = Self::step_after_cut(&self.cfg, run, prob, (near_on, near_sus), blocked, now, hangover, min_speech) {
                    if !blocked && start >= cut {
                        if let Some(mut follow) = self.confirmed_onset(gate, now) {
                            // Backdating never reaches into the cut turn.
                            follow.onset = follow.onset.max(cut);
                            self.queue_after_cut(follow);
                        }
                    }
                }
            }
            Phase::Processing { next: Some(ref mut run), .. } => {
                Self::step(&self.cfg, run, prob, (near_on, near_sus));
                if blocked {
                    run.overlap_since.get_or_insert(now);
                }
                let too_short = run.silence_frames >= hangover && run.speech_frames < min_speech;
                if too_short {
                    if let Phase::Processing { next, .. } = &mut self.phase {
                        *next = None;
                    }
                }
            }
            Phase::AgentSpeaking => {
                let shadow = if self.shadow.is_none() && self.aside { self.onset_confirmed(gate, now) } else { None };
                self.step_shadow(prob, (near_on, near_sus), shadow);
            }
        }
        self.finish()
    }

    /// The level gate judges one VAD frame (its level smoothed,
    /// [`GateLevel`]) into the frame ring: the level it judged, onset-near,
    /// sustain-near. The ring keeps [`RING_S`] (a dictation's,
    /// [`RING_DICTATION_S`]).
    #[allow(clippy::too_many_arguments)]
    fn record_frame(
        &mut self,
        gate: LevelGate,
        word_filter: Option<WordFilter>,
        prob: f32,
        start: u64,
        end: u64,
        level_db: f32,
        floor_db: f32,
        now: u64,
    ) -> (f32, bool, bool) {
        let dictation = self.cfg.mode == Mode::Dictation;
        let vouch = word_filter.is_some_and(|w| w.vouches(level_db, floor_db, self.speech_db, &gate, dictation));
        let level_db = self.gate_level.push(level_db, &gate);
        let near_on = gate.onset_near(level_db, floor_db, self.speech_db, self.speech_measured);
        let near_sus = gate.sustain_near(level_db, floor_db, self.speech_db);
        self.frames.push_back(FrameRec { start, end, wall: now, prob, level_db, near_on, near_sus, vouch });
        let keep = if self.cfg.mode == Mode::Dictation { RING_DICTATION_S } else { RING_S };
        let horizon = self.clock.saturating_sub((keep * SAMPLE_RATE as f64) as u64);
        while self.frames.front().is_some_and(|f| f.end < horizon) {
            self.frames.pop_front();
        }
        (level_db, near_on, near_sus)
    }

    /// A VAD frame while the queued run is one mute cut (`run`): the run the
    /// user started after unmuting, if any, is stepped as a queued run is
    /// (and dropped if too short at its pause). Returns the cut a new run
    /// may start after when the chain ends in a cut run (the caller opens
    /// it on an onset past it, [`Self::queue_after_cut`]).
    #[allow(clippy::too_many_arguments)]
    fn step_after_cut(
        cfg: &TurnConfig,
        run: &mut Run,
        prob: f32,
        near: (bool, bool),
        blocked: bool,
        now: u64,
        hangover: u32,
        min_speech: u32,
    ) -> Option<u64> {
        let tail = run.tail();
        if let Some(cut) = tail.cut {
            return Some(cut);
        }
        Self::step(cfg, tail, prob, near);
        if blocked {
            tail.overlap_since.get_or_insert(now);
        }
        if tail.silence_frames >= hangover && tail.speech_frames < min_speech {
            run.drop_tail();
        }
        None
    }

    /// Queues `follow` behind the cut run(s) waiting to be finalized.
    fn queue_after_cut(&mut self, follow: Run) {
        if let Phase::Processing { next: Some(run), .. } = &mut self.phase {
            run.tail().after = Some(Box::new(follow));
        }
    }

    /// While listening, a lifted S ([`LevelGate::relax_missed_ms`]): a frame
    /// of speech the gate turned away but the level before the lift would
    /// have heard counts; enough of them step S back toward that level.
    ///
    /// Back from a remembered level ([`Self::with_speech_hint`]) the level
    /// before is the bootstrap, unmeasured, and reaching it makes S
    /// unmeasured again. Nothing this session measured stands behind that
    /// level, so the speech that counts against it is wider: any the
    /// bootstrap would hold a turn on (sustain-near at it), since a stale
    /// level shuts the user out while relaxing a right one only costs the
    /// cold start's keeping out of the room.
    fn relax(&mut self, gate: LevelGate, prob: f32, level_db: f32, near_on: bool, now: u64) {
        let Some(base) = self.lift_from else { return };
        if gate.relax_missed_ms == 0 || near_on || prob < self.cfg.onset || now < self.guard_until {
            return;
        }
        let below = if self.lift_cold { gate.sustain_below_speech_db } else { gate.onset_below_speech_db };
        if level_db < base - below {
            return;
        }
        self.missed_frames += 1;
        if self.missed_frames >= self.frames(gate.relax_missed_ms) {
            self.missed_frames = 0;
            self.speech_db = (self.speech_db - gate.relax_step_db).max(base);
            if self.speech_db <= base {
                self.lift_from = None;
                if std::mem::take(&mut self.lift_cold) {
                    self.speech_measured = false;
                    self.low_turns = 0;
                    if let Some(a) = self.auto.as_mut() {
                        a.s_known = false;
                    }
                }
            }
        }
    }

    /// A frame that counts toward confirming an onset.
    fn onset_frame(&self, f: &FrameRec) -> bool {
        f.near_on && f.prob >= self.cfg.onset && f.wall >= self.guard_until
    }

    /// The level gate's onset: `confirm_frames` onset frames among the last
    /// `confirm_window` frames of audio. The run starts at the first of them,
    /// with the frames since stepped into it.
    fn confirmed_onset(&mut self, gate: LevelGate, now: u64) -> Option<Run> {
        let mut run = self.onset_confirmed(gate, now)?;
        self.name_run(&mut run);
        Some(run)
    }

    /// [`Self::confirmed_onset`]'s run, with no id yet.
    fn onset_confirmed(&self, gate: LevelGate, now: u64) -> Option<Run> {
        let window = gate.confirm_window.max(1) as u64 * self.vad_frame as u64;
        let from = self.clock.saturating_sub(window);
        let recent: Vec<FrameRec> = self.frames.iter().rev().take_while(|f| f.start >= from).copied().collect();
        // (Newest first.) The current frame must be one of them: an onset is
        // confirmed on an onset frame, never on the trailing silence.
        if !recent.first().is_some_and(|f| self.onset_frame(f)) {
            return None;
        }
        let hits = recent.iter().filter(|f| self.onset_frame(f)).count() as u32;
        if hits < gate.confirm_frames.max(1) {
            return None;
        }
        let peak = recent.iter().filter(|f| self.onset_frame(f)).map(|f| f.level_db).fold(f32::MIN, f32::max);
        if self.speech_measured && peak < self.speech_db - gate.confirm_peak_below_speech_db {
            return None;
        }
        let first = recent.iter().rposition(|f| self.onset_frame(f))?;
        let mut run = self.blank_run(recent[first].start, 0, now);
        for f in recent[..=first].iter().rev() {
            Self::step(&self.cfg, &mut run, f.prob, (f.near_on, f.near_sus));
        }
        run.onset = self.backdate(gate, recent[first].start);
        Some(run)
    }

    /// Reach back from `onset` over the near frames just before it (a soft
    /// first word, or the start of a barge-in whose probability rose late
    /// under the agent's echo), at most [`LevelGate::backdate_ms`], across
    /// pauses of up to [`LevelGate::backdate_gap_ms`].
    fn backdate(&self, gate: LevelGate, onset: u64) -> u64 {
        let limit = onset.saturating_sub(gate.backdate_ms as u64 * SAMPLE_RATE / 1000);
        let max_gap = (gate.backdate_gap_ms as u64 * SAMPLE_RATE / 1000).div_ceil(self.vad_frame as u64) as u32;
        let (mut at, mut next, mut gap) = (onset, onset, 0);
        for f in self.frames.iter().rev().skip_while(|f| f.start >= onset) {
            if f.end != next || f.start < limit {
                break;
            }
            next = f.start;
            if f.near_sus {
                at = f.start;
                gap = 0;
            } else {
                gap += 1;
                if gap > max_gap {
                    break;
                }
            }
        }
        at
    }

    /// The words of `[from, until)` `run`'s turn (or its caption) shows
    /// ([`words_text`]).
    fn turn_text(&self, run: &Run, from: f64, until: f64, interim: bool) -> Text {
        words_text(&self.cfg, &self.transcript, &self.frames, run.echo.as_ref(), from, until, interim)
    }

    /// A turn over `[onset, until)` was sent: S moves toward its near frames'
    /// level.
    fn measure_speech(&mut self, onset: u64, until: u64) {
        let Some(gate) = self.level_gate() else { return };
        let span = |f: &&FrameRec| f.start >= onset && f.end <= until;
        let mut levels: Vec<f32> = self.frames.iter().filter(span).filter(|f| f.near_sus).map(|f| f.level_db).collect();
        if let Some(a) = self.auto.as_mut() {
            // Auto: the turn's speech heard mostly within S's reach says S
            // is the user's; mostly under it (a soft user under the
            // bootstrap), S only heard their loudest syllables.
            let onset_p = self.cfg.onset;
            let speech = self.frames.iter().filter(span).filter(|f| f.prob >= onset_p).count();
            let near = self.frames.iter().filter(span).filter(|f| f.prob >= onset_p && f.near_sus).count();
            if speech > 0 && near as f32 >= a.cfg.switch.known_share * speech as f32 {
                a.s_known = true;
            }
        }
        if let Some(turn_db) = gate.turn_level(&mut levels) {
            self.measured_turns += 1;
            let before = self.speech_db;
            self.speech_db = gate.adapt(before, turn_db, self.speech_measured, &mut self.low_turns);
            if self.speech_measured {
                if (turn_db - before).abs() <= gate.speech_down_within_db {
                    // A turn within reach: S is the user's level.
                    self.lift_from = None;
                } else if self.speech_db > before {
                    self.lift_from.get_or_insert(before);
                }
                if self.lift_from.is_some_and(|b| self.speech_db <= b) {
                    self.lift_from = None;
                }
                if self.lift_from.is_none() {
                    // (A measured level, not the bootstrap, from here.)
                    self.lift_cold = false;
                }
            }
            self.speech_measured = true;
        }
    }

    /// Start from a measured S of `db` that turns lifted from a measured
    /// `from` (tests: a level left too high by a loud turn).
    #[cfg(test)]
    pub fn with_lifted_speech(mut self, db: f32, from: f32) -> Self {
        self = self.with_speech_hint(Some(db));
        self.lift_from = (self.level_gate().is_some() && from < self.speech_db).then_some(from);
        self.lift_cold = false;
        self
    }

    /// The input device changed (the DSP thread saw the mic's stream
    /// replaced): the user's level on the old one says nothing about the new
    /// one, so S goes back to the bootstrap, unmeasured, and the gate's
    /// smoothed level starts over. The frame ring stays (its frames were
    /// judged when they arrived, and a turn in progress still needs them to
    /// vouch for its words). No-op without a gate.
    pub fn on_mic_replaced(&mut self) -> Vec<Action> {
        if let Some(g) = self.level_gate() {
            self.speech_db = g.bootstrap_speech_db;
            self.speech_measured = false;
            if let Some(a) = self.auto.as_mut() {
                a.s_known = false;
            }
            self.low_turns = 0;
            self.lift_from = None;
            self.lift_cold = false;
            self.missed_frames = 0;
            self.gate_level.clear();
        }
        self.finish()
    }

    /// After a mic swap ([`Self::on_mic_replaced`]), the new device's
    /// remembered level arrived (WP7): S starts from it, measured, as
    /// [`Self::with_speech_hint`] would have at the start (so a stale-high
    /// one can relax back to the bootstrap). No-op without a gate.
    /// The audio the VAD frames describe now arrives `ms` behind wall time
    /// (the DSP thread's mic hold, `voice::system_ref`).
    pub fn on_audio_delay(&mut self, ms: u64) -> Vec<Action> {
        self.audio_delay_ms = ms;
        self.finish()
    }

    pub fn on_speech_hint(&mut self, db: f32) -> Vec<Action> {
        self.apply_speech_hint(db);
        self.finish()
    }

    pub fn on_stt(&mut self, event: VoiceSttEvent, now: u64) -> Vec<Action> {
        if self.ended {
            return self.finish();
        }
        match event {
            VoiceSttEvent::Ready => {
                self.stt_ready = true;
                if matches!(self.phase, Phase::Starting) {
                    self.phase = Phase::Listening;
                    self.idle_since = now;
                }
                if matches!(self.phase, Phase::Processing { seq: None, .. }) {
                    self.send_turn_finalize(now);
                }
                if matches!(self.stopping, Some(Stopping { seq: None, .. })) {
                    self.send_stop_finalize(now);
                }
            }
            VoiceSttEvent::Results(r) => {
                self.transcript.add(&r);
                self.show_transcript();
            }
            // The finalize reached the engine: the ack wait starts now.
            VoiceSttEvent::FinalizeSent { seq } => {
                let wait = self.cfg.finalize_timeout_ms;
                if let Phase::Processing { seq: Some(s), deadline, .. } = &mut self.phase {
                    if *s == seq {
                        *deadline = Some(now + wait);
                    }
                }
                if let Some(stopping) = &mut self.stopping {
                    if stopping.seq == Some(seq) {
                        stopping.deadline = (now + wait).min(stopping.hard);
                    }
                }
            }
            VoiceSttEvent::Finalized { seq } => {
                if matches!(self.phase, Phase::Processing { seq: Some(s), .. } if s == seq) {
                    self.complete_turn(now, false);
                } else if matches!(self.stopping, Some(Stopping { seq: Some(s), .. }) if s == seq) {
                    self.finish_dictation();
                }
            }
            VoiceSttEvent::Failed { reason } => self.end(EndReason::Error, None, Some(reason)),
            VoiceSttEvent::Finished => {
                self.end(EndReason::Error, None, Some("the transcription session ended".into()))
            }
            VoiceSttEvent::SpeechStarted { .. } | VoiceSttEvent::UtteranceEnd { .. } => {}
        }
        self.finish()
    }

    /// TTS audible or not (`TtsService::subscribe_speaking`).
    pub fn on_speaking(&mut self, speaking: bool, now: u64) -> Vec<Action> {
        if self.ended || self.speaking == speaking {
            self.speaking = speaking;
            return self.finish();
        }
        self.speaking = speaking;
        if self.cfg.mode == Mode::Dictation {
            return self.finish();
        }
        if speaking {
            self.quiet_since = None;
            // The reply (or something) is being spoken: no longer pending.
            self.reply_pending = None;
            match self.phase {
                Phase::Starting | Phase::Listening => {
                    self.phase = Phase::AgentSpeaking;
                    // A shadow left from an aside: the agent speaks again.
                    self.shadow = None;
                }
                // The user holds the floor. With barge-in allowed the DSP
                // thread decides. Without it (converging, half-duplex) the
                // user was first: the run stays open and ends on its own
                // hangover (on_vad, bounded against echo), never mid-word
                // here; once it ends, the VAD is ignored and echo opens no
                // new run.
                Phase::UserSpeaking(_) | Phase::Processing { .. } | Phase::AgentSpeaking => {}
            }
        } else if matches!(self.phase, Phase::AgentSpeaking) {
            self.quiet_since = Some(now);
            self.check_agent_quiet(now);
        }
        self.finish()
    }

    /// The DSP thread fired barge-in at audio-clock `onset` and has already
    /// cancelled the speech.
    pub fn on_barge_in(&mut self, onset: u64, now: u64) -> Vec<Action> {
        if self.ended || self.cfg.mode == Mode::Dictation {
            return self.finish();
        }
        // Into an aside, the barge-in may have fired on the hint alone (its
        // echo, on a speaker whose name says headphones): the run counts its
        // sustain as any barge-in's does, but drops the aside's own words it
        // begins with, up to the echo's tail after the cancel.
        let echo = std::mem::take(&mut self.aside).then(|| AsideEcho {
            words: self.aside_words.clone(),
            until: self.clock + ASIDE_ECHO_TAIL_MS * SAMPLE_RATE / 1000,
        });
        self.shadow = None;
        let sustained = self.frames(self.cfg.barge_in_ms).max(self.min_speech_frames());
        // The noisy room's barge-in (Auto's too, once it gates on S) fires
        // later in a run than the quiet room's: its onset reaches back over
        // the near frames before it.
        let gated = self.cfg.gate.or(self.barge_level().and(self.level_gate()));
        let onset = match gated {
            Some(gate) => self.backdate(gate, onset),
            None => onset,
        };
        // Queued behind a run mute cut (the user unmuted and talks over the
        // agent): the barge-in's run follows the cut one.
        let after_cut = matches!(&self.phase, Phase::Processing { next: Some(run), .. } if run.cut.is_some());
        let turn_id = if self.muted {
            self.last_turn_id()
        } else if after_cut {
            let open = matches!(&self.phase, Phase::Processing { next: Some(run), .. } if run.last().cut.is_some());
            if open {
                let mut follow = self.new_run(onset, sustained, now);
                follow.echo = echo;
                let id = follow.id.clone();
                self.queue_after_cut(follow);
                id
            } else {
                match &self.phase {
                    Phase::Processing { next: Some(run), .. } => run.last().id.clone(),
                    _ => unreachable!("checked above"),
                }
            }
        } else {
            match self.phase {
                Phase::UserSpeaking(ref run) | Phase::Processing { next: Some(ref run), .. } => run.id.clone(),
                Phase::Processing { next: None, .. } => {
                    let mut run = self.new_run(onset, sustained, now);
                    run.echo = echo;
                    let id = run.id.clone();
                    if let Phase::Processing { next, .. } = &mut self.phase {
                        *next = Some(run);
                    }
                    id
                }
                Phase::Starting | Phase::Listening | Phase::AgentSpeaking => {
                    let mut run = self.new_run(onset, sustained, now);
                    run.echo = echo;
                    let id = run.id.clone();
                    self.phase = Phase::UserSpeaking(run);
                    self.quiet_since = None;
                    self.idle_since = now;
                    id
                }
            }
        };
        self.out.push(Action::Interrupted { turn_id });
        self.finish()
    }

    /// The DSP thread's barge-in detector fired at audio-clock `onset` under
    /// the `wake` policy, and cancelled nothing: the user talks over the
    /// agent's speech (the reading), which goes on. Their run opens from the
    /// onset (backdated as a barge-in's is, and counting its sustain as
    /// speech, so a short "Joseph?" is a turn) with no `voice://interrupted`;
    /// its words stream and it ends in a `voice://turn` like any run, bounded
    /// as overlap while the speech goes on ([`Self::talk_over_blocked`]).
    ///
    /// Over a turn being finalized it is the run queued behind it. A run the
    /// user already holds goes on (a stale fire, raced by the machine's own
    /// onset); so does nothing while muted (the DSP thread re-arms with the
    /// next input). Taken whatever the policy is by now: what happened to the
    /// speech is what the event says (it wasn't cancelled).
    pub fn on_wake(&mut self, onset: u64, now: u64) -> Vec<Action> {
        if self.ended || self.muted || !self.cfg.mode.converses() {
            return self.finish();
        }
        let sustained = self.frames(self.cfg.barge_in_ms).max(self.min_speech_frames());
        let gated = self.cfg.gate.or(self.barge_level().and(self.level_gate()));
        let onset = match gated {
            Some(gate) => self.backdate(gate, onset),
            None => onset,
        };
        match self.phase {
            Phase::Starting | Phase::Listening | Phase::AgentSpeaking => {
                let run = self.new_run(onset, sustained, now);
                self.phase = Phase::UserSpeaking(run);
                self.shadow = None;
                self.quiet_since = None;
                self.idle_since = now;
                // Words already in from the onset on (the detector's
                // sustain) show at once.
                self.show_transcript();
            }
            Phase::Processing { next: None, .. } => {
                let run = self.new_run(onset, sustained, now);
                if let Phase::Processing { next, .. } = &mut self.phase {
                    *next = Some(run);
                }
            }
            Phase::UserSpeaking(_) | Phase::Processing { next: Some(_), .. } => {}
        }
        self.finish()
    }

    /// `voice_set_barge`: what talking over the agent does from now on
    /// ([`BargePolicy`]). A conversation or an interactive session only; a
    /// run in progress keeps going under the new policy (under `speech`, the
    /// agent starting over it may now be cut by the user going on).
    pub fn on_barge_policy(&mut self, policy: BargePolicy) -> Vec<Action> {
        if !self.ended && self.cfg.mode.converses() {
            self.barge = policy;
        }
        self.finish()
    }

    /// `voice_set_aside`: the agent speech the web is about to play (or
    /// plays) is an aside, with its `text`, or no longer is. Conversation
    /// only.
    pub fn on_aside(&mut self, on: bool, text: Option<&str>) -> Vec<Action> {
        self.aside = on && !self.ended && self.cfg.mode.converses();
        if self.aside {
            self.aside_words = text.map(aside_words).unwrap_or_default();
        } else if matches!(self.phase, Phase::AgentSpeaking) {
            self.shadow = None;
        }
        self.finish()
    }

    pub fn on_echo(&mut self, echo: EchoMode) -> Vec<Action> {
        self.echo = echo;
        self.finish()
    }

    pub fn on_mute(&mut self, muted: bool, now: u64) -> Vec<Action> {
        if self.ended || self.muted == muted {
            return self.finish();
        }
        self.muted = muted;
        self.gate_level.clear();
        self.shadow = None;
        if muted {
            // Muting mid-turn sends what was said up to the mute (a run too
            // short to be a turn is dropped, as its pause would drop it).
            let min_speech = self.min_speech_frames();
            let cut = self.clock + MUTE_TAIL_MS * SAMPLE_RATE / 1000;
            let conversation = self.cfg.mode.converses();
            match &mut self.phase {
                Phase::UserSpeaking(run) if conversation && run.speech_frames >= min_speech => {
                    self.end_turn_at(now, cut)
                }
                Phase::UserSpeaking(_) => self.abandon(now),
                // A run queued behind the turn being finalized ends here too,
                // and is sent after it.
                Phase::Processing { next, .. } => match next {
                    // Already cut: what was said since the unmute (if
                    // anything) is cut here the same way.
                    Some(run) if run.cut.is_some() => {
                        let tail = run.tail();
                        if tail.cut.is_none() {
                            if tail.speech_frames >= min_speech {
                                tail.cut = Some(cut);
                            } else {
                                run.drop_tail();
                            }
                        }
                    }
                    Some(run) if run.speech_frames >= min_speech => run.cut = Some(cut),
                    _ => *next = None,
                },
                _ => {}
            }
        } else {
            self.idle_since = now;
        }
        self.finish()
    }

    /// Timers: finalize timeout, dictation stop timeout, agent quiet, idle.
    pub fn on_tick(&mut self, now: u64) -> Vec<Action> {
        if self.ended {
            return self.finish();
        }
        if matches!(self.phase, Phase::Processing { deadline: Some(d), .. } if now >= d) {
            // No ack in time: the turn is what's final, plus the interim
            // tail inside its bounds (the engine may still be working through
            // audio queued while it loaded).
            self.complete_turn(now, true);
        }
        if self.stopping.as_ref().is_some_and(|s| now >= s.deadline) {
            self.finish_dictation();
        }
        self.check_agent_quiet(now);
        // A reply that is never spoken holds the idle clock only so long.
        if let Some(sent) = self.reply_pending {
            if now.saturating_sub(sent) >= self.cfg.reply_wait_ms {
                self.reply_pending = None;
                self.idle_since = self.idle_since.max(sent + self.cfg.reply_wait_ms);
            }
        }
        if !self.ended
            && self.cfg.idles()
            && !self.muted
            && self.reply_pending.is_none()
            && matches!(self.phase, Phase::Listening)
            && now.saturating_sub(self.idle_since) >= self.cfg.idle_ms
        {
            self.end(EndReason::Idle, None, None);
        }
        self.finish()
    }

    /// `voice_stop`.
    pub fn stop(&mut self, now: u64) -> Vec<Action> {
        if self.ended {
            return self.finish();
        }
        match self.cfg.mode {
            Mode::Conversation | Mode::Interactive => self.end(EndReason::Stopped, None, None),
            Mode::Dictation => {
                if self.stopping.is_none() {
                    let hard = now + self.cfg.stop_max_ms;
                    let deadline = (now + self.cfg.stop_wait_ready_ms).min(hard);
                    self.stopping = Some(Stopping { seq: None, deadline, hard });
                    if self.stt_ready {
                        self.send_stop_finalize(now);
                    }
                }
            }
        }
        self.finish()
    }

    /// `voice_cancel`.
    pub fn cancel(&mut self) -> Vec<Action> {
        self.end(EndReason::Cancelled, None, None);
        self.finish()
    }

    /// A newer session from the same webview took over: dictation ends as
    /// stopped with the words so far (interim included), a conversation as
    /// cancelled.
    pub fn replaced(&mut self) -> Vec<Action> {
        if !self.ended {
            match self.cfg.mode {
                Mode::Dictation => self.finish_dictation(),
                Mode::Conversation | Mode::Interactive => self.end(EndReason::Cancelled, None, None),
            }
        }
        self.finish()
    }

    /// Ended from outside (page, recording, device, error…).
    pub fn end_with(&mut self, reason: EndReason, error: Option<String>) -> Vec<Action> {
        self.end(reason, None, error);
        self.finish()
    }

    // ── transitions ───────────────────────────────────────────────────────

    /// The run in progress ends at the latest VAD frame (its pause).
    fn end_of_turn(&mut self, now: u64) {
        self.end_turn_at(now, self.clock);
    }

    /// The run in progress ends at audio clock `until` (its pause, or the
    /// mute that cut it): finalize, then send it.
    fn end_turn_at(&mut self, now: u64, until: u64) {
        let phase = std::mem::replace(&mut self.phase, Phase::Listening);
        let Phase::UserSpeaking(run) = phase else {
            self.phase = phase;
            return;
        };
        if self.cfg.mode == Mode::Dictation {
            self.phase = self.resting();
            self.idle_since = now;
            return;
        }
        self.phase = Phase::Processing { run, until, seq: None, deadline: None, next: None };
        if self.stt_ready {
            self.send_turn_finalize(now);
        }
    }

    /// Ask for the finalize. The ack wait proper starts at `FinalizeSent`;
    /// until then the finalize has [`TurnConfig::finalize_forward_ms`] to
    /// reach the engine.
    fn send_turn_finalize(&mut self, now: u64) {
        self.finalizes += 1;
        let seq = self.finalizes;
        let forward = self.cfg.finalize_forward_ms;
        if let Phase::Processing { seq: s, deadline, .. } = &mut self.phase {
            *s = Some(seq);
            *deadline = Some(now + forward);
            self.out.push(Action::Finalize { seq });
        }
    }

    fn send_stop_finalize(&mut self, now: u64) {
        self.finalizes += 1;
        let seq = self.finalizes;
        if let Some(stopping) = &mut self.stopping {
            stopping.seq = Some(seq);
            stopping.deadline = (now + self.cfg.finalize_forward_ms).min(stopping.hard);
            self.out.push(Action::Finalize { seq });
        }
    }

    /// Where the session rests when nobody is talking.
    fn resting(&self) -> Phase {
        if self.speaking && self.cfg.mode.converses() {
            Phase::AgentSpeaking
        } else if !self.stt_ready {
            Phase::Starting
        } else {
            Phase::Listening
        }
    }

    /// A speech run too short to be a turn (at its pause, or cut off by
    /// mute): dropped.
    fn abandon(&mut self, now: u64) {
        let phase = std::mem::replace(&mut self.phase, Phase::Listening);
        if let Phase::UserSpeaking(run) = phase {
            if !run.shown.is_empty() && self.cfg.mode.converses() {
                self.out.push(Action::Transcript { turn_id: run.id, text: String::new(), is_final: true });
            }
        }
        self.phase = self.resting();
        self.idle_since = now;
    }

    /// The finalize was acknowledged (or, `timed_out`, wasn't in time):
    /// emit the turn. An acked turn is its final words; a timed-out one also
    /// takes the interim words inside its bounds.
    fn complete_turn(&mut self, now: u64, timed_out: bool) {
        let phase = std::mem::replace(&mut self.phase, Phase::Listening);
        let Phase::Processing { run, until, next, .. } = phase else {
            self.phase = phase;
            return;
        };
        let until_clock = until;
        let (from, until) = (self.window_start(&run), secs(until));
        let text = self.turn_text(&run, from, until, timed_out).text;
        if timed_out {
            self.transcript.consume_with_interim(from, until);
        } else {
            self.transcript.consume(from, until);
        }
        if !text.is_empty() {
            self.measure_speech(run.onset, until_clock);
            self.aside = false;
            self.out.push(Action::Turn { turn_id: run.id, text });
            self.reply_pending = Some(now);
        } else if !run.shown.is_empty() {
            // Nothing final: clear the caption quietly.
            self.out.push(Action::Transcript { turn_id: run.id, text: String::new(), is_final: true });
        }
        self.idle_since = now;
        self.phase = match next {
            Some(next) => Phase::UserSpeaking(next),
            None => self.resting(),
        };
        // A next turn mute cut, or one that already went quiet long enough,
        // ends now.
        if let Phase::UserSpeaking(run) = &mut self.phase {
            if let Some(cut) = run.cut {
                // What the user said after unmuting queues behind it.
                let after = run.after.take();
                self.end_turn_at(now, cut);
                if let Phase::Processing { next, .. } = &mut self.phase {
                    *next = after.map(|r| *r);
                }
            } else if run.silence_frames >= self.hangover_frames() {
                self.end_of_turn(now);
            } else {
                self.show_transcript();
            }
        }
    }

    fn check_agent_quiet(&mut self, now: u64) {
        if !matches!(self.phase, Phase::AgentSpeaking) || self.speaking {
            return;
        }
        let Some(since) = self.quiet_since else { return };
        if now.saturating_sub(since) >= self.cfg.agent_quiet_grace_ms {
            self.phase = self.resting();
            self.quiet_since = None;
            // (The VAD frames reaching the machine after this describe audio
            // `audio_delay_ms` older: the guard covers the same echo tail.)
            self.guard_until = now + self.cfg.echo_guard_ms + self.audio_delay_ms;
            self.idle_since = now;
            // An aside that played out over speech: the words it begins with
            // up to now may be its own.
            let aside = std::mem::take(&mut self.aside);
            let words = &self.aside_words;
            let clock = self.clock;
            self.shadow = self.shadow.take().filter(|_| aside).map(|mut run| {
                run.echo = Some(AsideEcho { words: words.clone(), until: clock });
                run
            });
            // Still talking: their run. Otherwise it waits out the echo guard
            // for them to go on (a pause between words).
            let live = self.frames(ASIDE_LIVE_MS);
            if self.shadow.as_ref().is_some_and(|run| run.silence_frames <= live) {
                self.promote_shadow(now);
            }
        }
    }

    /// Dictation's text: everything since the start (interim tail
    /// included), less, with the word filter (the noisy room, or Auto once
    /// switched), the words no near frame vouches for (a TV).
    fn dictation_text(&self) -> Text {
        words_text(&self.cfg, &self.transcript, &self.frames, None, f64::NEG_INFINITY, f64::INFINITY, true)
    }

    fn finish_dictation(&mut self) {
        let text = self.dictation_text().text;
        self.stopping = None;
        self.end(EndReason::Stopped, Some(text), None);
    }

    /// Emit the current turn's (or dictation's) text if it changed.
    fn show_transcript(&mut self) {
        if self.cfg.mode == Mode::Dictation {
            let t = self.dictation_text();
            if t.text != self.dictation_shown {
                self.dictation_shown = t.text.clone();
                self.out.push(Action::Transcript {
                    turn_id: DICTATION_TURN_ID.into(),
                    text: t.text,
                    is_final: !t.has_interim,
                });
            }
            return;
        }
        let slack = self.cfg.onset_slack_ms as f64 / 1000.0;
        let (run, until) = match &mut self.phase {
            Phase::UserSpeaking(run) => (run, f64::INFINITY),
            Phase::Processing { run, until, .. } => {
                let until = secs(*until);
                (run, until)
            }
            _ => return,
        };
        let from = secs(run.onset) - slack;
        let t = words_text(&self.cfg, &self.transcript, &self.frames, run.echo.as_ref(), from, until, true);
        if t.text != run.shown {
            run.shown = t.text.clone();
            self.out.push(Action::Transcript { turn_id: run.id.clone(), text: t.text, is_final: !t.has_interim });
        }
    }

    fn end(&mut self, reason: EndReason, text: Option<String>, error: Option<String>) {
        if self.ended {
            return;
        }
        self.ended = true;
        self.out.push(Action::End { reason, text, error });
    }

    /// Append a state event if the shown state changed; hand the actions over.
    fn finish(&mut self) -> Vec<Action> {
        if !self.ended {
            let now = (self.state(), self.echo);
            if self.last_state != Some(now) {
                self.last_state = Some(now);
                self.out.push(Action::State { state: now.0, echo: now.1 });
            }
        }
        std::mem::take(&mut self.out)
    }
}

#[cfg(test)]
mod tests;
