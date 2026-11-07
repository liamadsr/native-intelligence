//! An interactive session feeds local-stt around speech only (the
//! interactive-mode spec's "desktop ⇄ web contract"): its mic is open for as
//! long as the Interactive toggle is on, and transcribing every second of a
//! quiet room would keep about a core busy for nothing. Conversation and
//! dictation feed everything, as before.
//!
//! ```text
//! cleaned 16k ─▶ FeedGate ─(open)─▶ local-stt (SttSink)          engine clock = samples fed
//!                  │  ▲ VAD frames (open at OPEN_PROB, close after the tail)
//!                  └──┴─ pre-roll ring (PRE_ROLL_MS before the opening frame)
//!                  └──▶ FeedClock: (fed, session) at every discontinuity ──▶ actor:
//!                       VoiceSttEvent times → session audio clock → Machine
//! ```
//!
//! - **The gate** ([`FeedGate`], on the DSP thread) opens on the first VAD
//!   frame at or above [`OPEN_PROB`], feeding first what the pre-roll ring
//!   holds from [`PRE_ROLL_MS`] before that frame, then every frame live. It
//!   closes once [`TAIL_MARGIN_MS`] more than the session's end silence has
//!   passed with no frame at that level. Muting closes it at once (local-stt
//!   gets nothing while muted, where continuous feed sends silence).
//! - **Why it never cuts a turn**: [`OPEN_PROB`] is no higher than any
//!   level that starts, holds or ends a run under any preset (the quiet
//!   room's `off`, 0.35; the noisy room's is 0.45; barge-in's onsets are
//!   0.65 and 0.7). A frame under it is silence to every preset's run, so the
//!   machine's silence count is never behind the gate's, and the gate's tail
//!   outlasts the longest pause a turn waits for: whenever the machine holds
//!   a run, the gate is open, and the audio is fed up to the end of every
//!   turn. The turn's finalize needs no audio after it (local-stt pads its
//!   own silence, `sidecars/local-stt/src/main.cpp` "Finalize"), so a
//!   finalize sent while the gate is closed (a mute cut) is acked as ever.
//! - **The clocks**: local-stt's word times are seconds of audio it was fed
//!   (dropped chunks are repaid as silence, its finalize padding hidden), and
//!   the turn machine works on the session audio clock (every cleaned
//!   sample). The gate records where each stretch it feeds starts on both
//!   ([`FeedClock::begin`]); the actor maps every [`VoiceSttEvent`]'s times
//!   back before the machine (and the debug capture) sees it
//!   ([`FeedClock::translate`]), so the machine, its traces and the replay
//!   harness are unchanged. The engine sees one stream with the silences
//!   between speech left out: each stretch begins with its pre-roll and ends
//!   in the tail's silence, so the joins are silence against silence.
//! - **Not covered**: a word that starts more than [`PRE_ROLL_MS`] before
//!   the first frame reaching [`OPEN_PROB`] is never fed. The quiet room's
//!   turns reach back [`super::profile::TurnTuning::onset_slack_ms`] (300 ms)
//!   from their onset, which the pre-roll covers; the noisy room's level gate
//!   may backdate a run up to 1 s over soft near frames, whose first word
//!   would only be heard if the VAD had already passed 0.35 on it.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use super::SAMPLE_RATE;
use crate::modules::stt::{SttResults, SttWord, VoiceSttEvent};

/// The gate opens on a VAD frame at or above this: the quiet room's turn
/// `off` level, the lowest any preset starts, holds or ends a run at (module
/// docs; `tests::the_gate_opens_no_later_than_any_run_or_barge_in`).
pub const OPEN_PROB: f32 = 0.35;
/// Fed with the gate's opening, from before the opening VAD frame's start:
/// past the turn's onset slack (300 ms), so the word the VAD caught late is
/// whole.
pub const PRE_ROLL_MS: u64 = 400;
/// The gate closes after the session's end silence plus this with no frame
/// at [`OPEN_PROB`]: always after the machine has ended the run (and sent its
/// finalize), with silence for the engine to settle its last words on.
pub const TAIL_MARGIN_MS: u64 = 500;
/// The ring holds the pre-roll plus room for the VAD frame the gate opens
/// on (up to two of them behind the clock) and a capture frame.
const RING_SLACK: usize = 4_096;
/// Stretches the engine may still be timing words in: the last this many
/// fed samples' worth (10 minutes of speech; the engine lags by seconds, or
/// by its load backlog, bounded by its queue).
const KEEP_FED: u64 = 10 * 60 * SAMPLE_RATE;

fn samples(ms: u64) -> u64 {
    ms * SAMPLE_RATE / 1000
}

/// Where a stretch of fed audio starts, on both clocks: fed sample `fed`
/// (local-stt's clock) is session sample `session`, and so on, sample for
/// sample, until the next stretch.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Stretch {
    fed: u64,
    session: u64,
}

/// The map from local-stt's clock (samples fed) to the session audio clock.
/// Written by the [`FeedGate`] (DSP thread) when a stretch starts, read by
/// the session actor for every transcription event; a short lock either way.
#[derive(Debug, Default)]
pub struct FeedClock {
    stretches: Mutex<VecDeque<Stretch>>,
}

impl FeedClock {
    fn lock(&self) -> std::sync::MutexGuard<'_, VecDeque<Stretch>> {
        self.stretches.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Fed sample `fed` is session sample `session`, and the audio fed from
    /// it on follows the session clock until the next stretch. Stretches the
    /// engine can no longer be timing words in ([`KEEP_FED`]) are forgotten.
    pub fn begin(&self, fed: u64, session: u64) {
        let mut s = self.lock();
        s.push_back(Stretch { fed, session });
        let horizon = fed.saturating_sub(KEEP_FED);
        while s.len() > 1 && s[1].fed <= horizon {
            s.pop_front();
        }
    }

    /// What to add to a time on local-stt's clock (seconds) to put it on the
    /// session clock: the silence left out before the stretch it falls in.
    /// Nothing before anything was fed.
    fn shift_at(&self, secs: f64) -> f64 {
        let s = self.lock();
        let x = secs * SAMPLE_RATE as f64;
        let at = s.iter().rev().find(|g| g.fed as f64 <= x).or(s.front());
        at.map_or(0.0, |g| (g.session as f64 - g.fed as f64) / SAMPLE_RATE as f64)
    }

    /// `secs` on local-stt's clock, on the session clock.
    pub fn to_session(&self, secs: f64) -> f64 {
        secs + self.shift_at(secs)
    }

    /// `event` with its times on the session clock. A word moves by its
    /// start's shift, end and all (a word never straddles a gap: each stretch
    /// starts with its pre-roll and ends in the tail's silence).
    pub fn translate(&self, event: VoiceSttEvent) -> VoiceSttEvent {
        match event {
            VoiceSttEvent::Results(r) => {
                let words = r
                    .words
                    .into_iter()
                    .map(|w| {
                        let shift = self.shift_at(w.start);
                        SttWord { start: w.start + shift, end: w.end + shift, ..w }
                    })
                    .collect();
                VoiceSttEvent::Results(SttResults { start: self.to_session(r.start), words, ..r })
            }
            VoiceSttEvent::SpeechStarted { timestamp } => VoiceSttEvent::SpeechStarted { timestamp: self.to_session(timestamp) },
            VoiceSttEvent::UtteranceEnd { last_word_end } => {
                VoiceSttEvent::UtteranceEnd { last_word_end: self.to_session(last_word_end) }
            }
            other => other,
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.lock().len()
    }
}

/// The DSP thread's side: decides what of the cleaned audio reaches the sink
/// (module docs).
#[derive(Debug)]
pub struct FeedGate {
    clock: Arc<FeedClock>,
    /// Closes after this much audio (samples) with no frame at OPEN_PROB.
    tail: u64,
    pre_roll: u64,
    /// The latest audio continuous feed would have pushed, ending at
    /// `ring_end` (session clock).
    ring: VecDeque<f32>,
    ring_cap: usize,
    ring_end: u64,
    open: bool,
    /// The end of the latest VAD frame at OPEN_PROB (session clock).
    last_speech: u64,
    /// The end of the audio fed so far (session clock), once any was.
    fed_end: Option<u64>,
    /// Samples fed so far: local-stt's clock.
    fed: u64,
}

impl FeedGate {
    /// A closed gate for a session whose turns end after `end_silence_ms`
    /// of silence.
    pub fn new(end_silence_ms: u32, clock: Arc<FeedClock>) -> Self {
        let pre_roll = samples(PRE_ROLL_MS);
        let ring_cap = pre_roll as usize + RING_SLACK;
        Self {
            clock,
            tail: samples(end_silence_ms as u64 + TAIL_MARGIN_MS),
            pre_roll,
            ring: VecDeque::with_capacity(ring_cap),
            ring_cap,
            ring_end: 0,
            open: false,
            last_speech: 0,
            fed_end: None,
            fed: 0,
        }
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    /// Samples fed so far (local-stt's clock).
    #[cfg(test)]
    pub fn fed(&self) -> u64 {
        self.fed
    }

    /// One frame of what continuous feed would push (the cleaned mic, or
    /// silence while muted) at session clock `at`: into the pre-roll, and on
    /// to `out` (the sink's buffer) while the gate is open.
    pub fn audio(&mut self, at: u64, frame: &[f32], out: &mut Vec<f32>) {
        if at != self.ring_end {
            // (Never in a session: the DSP thread's frames tile the clock.)
            self.ring.clear();
        }
        self.ring.extend(frame.iter().copied());
        let over = self.ring.len().saturating_sub(self.ring_cap);
        self.ring.drain(..over);
        self.ring_end = at + frame.len() as u64;
        if self.open {
            self.feed(at, frame, out);
        }
    }

    /// One VAD frame `[start, end)` at `prob`, its audio already through
    /// [`Self::audio`]: open (the pre-roll first, never audio already fed) or
    /// close.
    pub fn vad(&mut self, prob: f32, start: u64, end: u64, out: &mut Vec<f32>) {
        if prob >= OPEN_PROB {
            self.last_speech = end;
            if !self.open {
                self.open = true;
                let ring_start = self.ring_end - self.ring.len() as u64;
                let mut from = start.saturating_sub(self.pre_roll).max(ring_start);
                if let Some(fed_end) = self.fed_end {
                    from = from.max(fed_end);
                }
                if from < self.ring_end {
                    let pre: Vec<f32> = self.ring.range((from - ring_start) as usize..).copied().collect();
                    self.feed(from, &pre, out);
                }
            }
        } else if self.open && end.saturating_sub(self.last_speech) >= self.tail {
            self.open = false;
        }
    }

    /// Mute: nothing more is fed until the VAD opens the gate again.
    pub fn close(&mut self) {
        self.open = false;
    }

    /// Feed `audio` from session clock `at`; a stretch begins where it
    /// doesn't follow what was fed last.
    fn feed(&mut self, at: u64, audio: &[f32], out: &mut Vec<f32>) {
        if self.fed_end != Some(at) {
            self.clock.begin(self.fed, at);
        }
        out.extend_from_slice(audio);
        self.fed += audio.len() as u64;
        self.fed_end = Some(at + audio.len() as u64);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::profile::Tuning;
    use crate::voice::turn::{Action, Machine, Mode, TurnConfig};
    use crate::voice::events::{EchoMode, SessionState};

    const AEC: usize = 160;
    const VAD: u64 = 512;

    /// The DSP thread's order: every 10 ms capture frame through the gate,
    /// and a VAD frame each time 512 samples have gathered. Each sample's
    /// value is its own session clock (exact in an f32 up to 17 minutes), so
    /// tests can tell what was fed.
    struct Rig {
        gate: FeedGate,
        clock: Arc<FeedClock>,
        at: u64,
        vad_start: u64,
        out: Vec<f32>,
    }

    impl Rig {
        fn new(end_silence_ms: u32) -> Rig {
            let clock = Arc::new(FeedClock::default());
            Rig { gate: FeedGate::new(end_silence_ms, clock.clone()), clock, at: 0, vad_start: 0, out: Vec::new() }
        }

        /// `ms` of audio whose VAD frames read `prob`. Returns what was fed.
        fn run(&mut self, prob: f32, ms: u64) -> Vec<f32> {
            for _ in 0..ms / 10 {
                let frame: Vec<f32> = (self.at..self.at + AEC as u64).map(|s| s as f32).collect();
                self.gate.audio(self.at, &frame, &mut self.out);
                self.at += AEC as u64;
                while self.at >= self.vad_start + VAD {
                    self.gate.vad(prob, self.vad_start, self.vad_start + VAD, &mut self.out);
                    self.vad_start += VAD;
                }
            }
            std::mem::take(&mut self.out)
        }
    }

    /// The session sample the first fed sample came from.
    fn first(fed: &[f32]) -> u64 {
        fed[0] as u64
    }

    /// Fed audio is the session's, sample for sample, from `first(fed)`.
    fn contiguous(fed: &[f32]) -> bool {
        fed.windows(2).all(|w| w[1] == w[0] + 1.0)
    }

    #[test]
    fn silence_feeds_nothing() {
        let mut r = Rig::new(700);
        assert!(r.run(0.05, 10_000).is_empty());
        assert!(r.run(OPEN_PROB - 0.01, 2_000).is_empty(), "just under the gate's level");
        assert!(!r.gate.is_open());
        assert_eq!(r.gate.fed(), 0);
        assert_eq!(r.clock.len(), 0);
    }

    #[test]
    fn speech_opens_the_gate_with_its_pre_roll_and_the_tail_closes_it() {
        let mut r = Rig::new(700);
        r.run(0.05, 2_000);
        let onset_frame_start = r.vad_start;
        let fed = r.run(0.9, 40); // the first VAD frame at 0.9 completes in here
        assert!(r.gate.is_open());
        // From PRE_ROLL_MS before the opening VAD frame, sample for sample.
        let from = first(&fed);
        assert_eq!(from, onset_frame_start - samples(PRE_ROLL_MS));
        assert!(contiguous(&fed));
        assert_eq!(fed.len() as u64, r.at - from, "up to the clock");
        assert_eq!(r.clock.to_session(0.0), from as f64 / 16_000.0);
        // Speech, then the pause: still open through the end silence and
        // the margin, closed after.
        let speech = r.run(0.9, 1_000);
        assert_eq!(speech.len(), 1_000 * 16);
        let pause = r.run(0.05, 700 + TAIL_MARGIN_MS - 40);
        assert!(r.gate.is_open(), "within the tail");
        assert_eq!(pause.len() as u64, samples(700 + TAIL_MARGIN_MS - 40));
        r.run(0.05, 80);
        assert!(!r.gate.is_open(), "past it");
        assert!(r.run(0.05, 5_000).is_empty());
    }

    #[test]
    fn soft_speech_between_the_gate_and_the_turns_onset_holds_it_open() {
        let mut r = Rig::new(500);
        r.run(0.9, 200);
        // 0.4: silence once a turn's pause has started, but not to the gate.
        r.run(0.4, 3_000);
        assert!(r.gate.is_open());
        r.run(0.2, 500 + TAIL_MARGIN_MS + 40);
        assert!(!r.gate.is_open());
    }

    #[test]
    fn reopening_soon_after_never_feeds_audio_twice() {
        let mut r = Rig::new(200);
        r.run(0.05, 1_000);
        r.run(0.9, 300);
        r.run(0.05, 200 + TAIL_MARGIN_MS + 40);
        assert!(!r.gate.is_open());
        let closed_at = r.gate.fed_end.unwrap();
        // 100 ms later: the pre-roll would reach back into what was fed.
        let gap = r.run(0.05, 100);
        assert!(gap.is_empty());
        let fed = r.run(0.9, 40);
        assert_eq!(first(&fed), closed_at, "picks up where feeding stopped");
        assert!(contiguous(&fed));
        assert_eq!(r.clock.len(), 1, "one stretch: nothing was left out");
        let stretch_start = (r.clock.to_session(0.0) * 16_000.0).round() as u64;
        assert_eq!(r.gate.fed(), r.gate.fed_end.unwrap() - stretch_start);
    }

    #[test]
    fn the_clock_map_puts_word_times_back_on_the_session_clock() {
        let mut r = Rig::new(700);
        r.run(0.05, 3_000);
        r.run(0.9, 1_000);
        r.run(0.05, 1_500);
        let first_fed = r.gate.fed();
        r.run(0.05, 20_000); // 20 s of quiet, left out
        let second_onset = r.vad_start;
        r.run(0.9, 1_000);
        r.run(0.05, 1_500);
        assert_eq!(r.clock.len(), 2);
        // The first stretch starts 400 ms before its onset at ~3.0 s.
        let first_start = r.clock.to_session(0.0);
        assert!((first_start - (3.0 - 0.4)).abs() < 0.04, "{first_start}");
        // A word 0.5 s into the second stretch (its pre-roll then 0.1 s of
        // speech) lands 0.1 s past the second onset's frame.
        let fed_s = first_fed as f64 / 16_000.0;
        let got = r.clock.to_session(fed_s + 0.5);
        let want = (second_onset - samples(PRE_ROLL_MS)) as f64 / 16_000.0 + 0.5;
        assert!((got - want).abs() < 1e-9, "{got} vs {want}");
        // Whole events: words move by their start's shift.
        let ev = VoiceSttEvent::Results(SttResults {
            is_final: true,
            speech_final: true,
            from_finalize: true,
            transcript: "Joseph, look".into(),
            start: fed_s + 0.5,
            duration: 0.6,
            words: vec![
                SttWord { word: "Joseph,".into(), start: fed_s + 0.5, end: fed_s + 0.9, confidence: 0.9 },
                SttWord { word: "look".into(), start: fed_s + 0.95, end: fed_s + 1.1, confidence: 0.9 },
            ],
        });
        let VoiceSttEvent::Results(t) = r.clock.translate(ev) else { panic!() };
        assert!((t.start - want).abs() < 1e-9);
        assert!((t.words[0].start - want).abs() < 1e-9 && (t.words[0].end - (want + 0.4)).abs() < 1e-9);
        assert!((t.words[1].start - (want + 0.45)).abs() < 1e-9);
        assert_eq!((t.transcript.as_str(), t.duration), ("Joseph, look", 0.6), "the rest as it was");
        assert_eq!(r.clock.translate(VoiceSttEvent::Finalized { seq: 4 }), VoiceSttEvent::Finalized { seq: 4 });
        let VoiceSttEvent::SpeechStarted { timestamp } = r.clock.translate(VoiceSttEvent::SpeechStarted { timestamp: fed_s + 0.5 })
        else {
            panic!()
        };
        assert!((timestamp - want).abs() < 1e-9);
    }

    #[test]
    fn nothing_fed_yet_maps_as_is_and_old_stretches_are_forgotten() {
        let clock = FeedClock::default();
        assert_eq!(clock.to_session(1.25), 1.25);
        clock.begin(0, 16_000);
        clock.begin(16_000, 64_000);
        assert_eq!(clock.to_session(0.5), 1.5);
        assert_eq!(clock.to_session(1.5), 4.5);
        clock.begin(KEEP_FED + 16_000, KEEP_FED + 640_000);
        assert_eq!(clock.len(), 2, "the first stretch ended more than KEEP_FED ago");
        clock.begin(KEEP_FED + 32_000, KEEP_FED + 700_000);
        assert_eq!(clock.len(), 3, "the second is still within it");
    }

    #[test]
    fn mute_closes_the_gate_at_once() {
        let mut r = Rig::new(700);
        r.run(0.9, 500);
        r.gate.close();
        // While muted the DSP thread runs no VAD: silence, through the ring.
        for _ in 0..100 {
            r.gate.audio(r.at, &[0.0; AEC], &mut r.out);
            r.at += AEC as u64;
        }
        r.vad_start = r.at;
        assert!(std::mem::take(&mut r.out).is_empty());
        // Unmuted, speech: the pre-roll is the muted stretch's silence.
        let fed = r.run(0.9, 40);
        assert!(fed[..samples(PRE_ROLL_MS) as usize - 1].iter().all(|&s| s == 0.0));
        assert_eq!(r.clock.len(), 2);
    }

    #[test]
    fn the_gate_opens_no_later_than_any_run_or_barge_in() {
        for t in [Tuning::QUIET, Tuning::NOISY, Tuning::AUTO] {
            assert!(OPEN_PROB <= t.turn.off && OPEN_PROB <= t.turn.onset, "{}", t.label);
            assert!(OPEN_PROB <= t.barge.onset && OPEN_PROB <= t.barge.off, "{}", t.label);
        }
        assert!(PRE_ROLL_MS >= Tuning::QUIET.turn.onset_slack_ms as u64);
        assert!(PRE_ROLL_MS >= Tuning::NOISY.turn.onset_slack_ms as u64);
    }

    /// The machine and the gate on the same VAD frames (an interactive
    /// session, the quiet room): whenever the machine holds a run, the gate
    /// is open, the run's audio from its onset slack on was fed, and the
    /// gate is still open when the turn's finalize goes out.
    #[test]
    fn every_run_the_machine_holds_is_fed_from_its_onset_slack_to_its_end() {
        let end_silence = 700;
        let mut m = Machine::new(TurnConfig::new(Mode::Interactive, end_silence, true), EchoMode::Cancelling);
        m.start(0);
        m.on_stt(VoiceSttEvent::Ready, 0);
        let clock = Arc::new(FeedClock::default());
        let mut gate = FeedGate::new(end_silence, clock.clone());
        let mut out = Vec::new();
        let (mut at, mut now) = (0u64, 0u64);
        // Quiet, speech with dips and soft stretches (0.3, 0.4, 0.45: under
        // the onset, silence to a run once its pause started), pauses short
        // and long, a 64 ms blip.
        let script: &[(f32, u64)] = &[
            (0.05, 3_000),
            (0.9, 600),
            (0.3, 200),
            (0.9, 400),
            (0.4, 600),
            (0.05, 2_000),
            (0.6, 64),
            (0.05, 3_000),
            (0.95, 1_500),
            (0.45, 900),
            (0.2, 800),
            (0.9, 300),
            (0.05, 4_000),
        ];
        let slack = samples(Tuning::QUIET.turn.onset_slack_ms as u64);
        let mut finalizes = 0;
        let mut onset: Option<u64> = None;
        for &(prob, ms) in script {
            for _ in 0..ms / 32 {
                gate.audio(at, &[0.1f32; VAD as usize], &mut out);
                gate.vad(prob, at, at + VAD, &mut out);
                now += 32;
                let actions = m.on_vad(prob, at, at + VAD, now);
                if m.state() == SessionState::UserSpeaking {
                    let o = *onset.get_or_insert(at);
                    assert!(gate.is_open(), "a run at {at} with the gate shut");
                    assert!(was_fed(&clock, gate.fed(), o - slack), "the run's onset slack ({}) was fed", o - slack);
                    assert!(was_fed(&clock, gate.fed(), at), "and this frame");
                } else {
                    onset = None;
                }
                at += VAD;
                for a in actions {
                    if let Action::Finalize { seq } = a {
                        finalizes += 1;
                        assert!(gate.is_open(), "the turn's end was fed");
                        m.on_stt(VoiceSttEvent::Finalized { seq }, now);
                    }
                }
            }
        }
        assert_eq!(finalizes, 3, "three turns (the 64 ms blip is none)");
        assert!(!gate.is_open());
    }

    /// Session sample `s` was fed (it lies in one of the stretches; `fed`:
    /// samples fed so far, the last stretch's end).
    fn was_fed(clock: &FeedClock, fed: u64, s: u64) -> bool {
        let st = clock.lock();
        st.iter().enumerate().any(|(i, g)| {
            let len = st.get(i + 1).map_or(fed, |n| n.fed) - g.fed;
            g.session <= s && s < g.session + len
        })
    }
}
