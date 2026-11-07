use super::*;
use crate::voice::transcript::tests::results;

/// One Silero frame: 512 samples, 32 ms.
const F: u64 = 512;
const F_MS: u64 = 32;

/// The machine plus both clocks: `now` (wall ms) and `at` (audio samples),
/// advanced together by VAD frames.
struct H {
    m: Machine,
    now: u64,
    at: u64,
}

impl H {
    fn with(cfg: TurnConfig, echo: EchoMode) -> (H, Vec<Action>) {
        let mut m = Machine::new(cfg, echo);
        let first = m.start(0);
        (H { m, now: 0, at: 0 }, first)
    }

    fn conv() -> H {
        Self::conv_with(DEFAULT_END_SILENCE_MS, true, EchoMode::Converging)
    }

    fn conv_with(end_silence_ms: u32, barge_in: bool, echo: EchoMode) -> H {
        let (mut h, _) = Self::with(TurnConfig::new(Mode::Conversation, end_silence_ms, barge_in), echo);
        h.ready();
        h
    }

    fn dictation() -> H {
        let (mut h, _) = Self::with(TurnConfig::new(Mode::Dictation, DEFAULT_END_SILENCE_MS, true), EchoMode::Converging);
        h.ready();
        h
    }

    fn ready(&mut self) -> Vec<Action> {
        self.m.on_stt(VoiceSttEvent::Ready, self.now)
    }

    fn secs(&self) -> f64 {
        self.at as f64 / 16_000.0
    }

    /// `n` VAD frames at `prob`, each seen at its end (as the DSP thread
    /// reports them).
    fn vad(&mut self, prob: f32, n: usize) -> Vec<Action> {
        let mut out = Vec::new();
        for _ in 0..n {
            self.now += F_MS;
            out.extend(self.m.on_vad(prob, self.at, self.at + F, self.now));
            self.at += F;
        }
        out
    }

    fn words(&mut self, is_final: bool, words: &[(&str, f64)]) -> Vec<Action> {
        self.m.on_stt(VoiceSttEvent::Results(results(is_final, words)), self.now)
    }

    fn finalized(&mut self, seq: u64) -> Vec<Action> {
        self.m.on_stt(VoiceSttEvent::Finalized { seq }, self.now)
    }

    /// local-stt handed finalize `seq` to the engine.
    fn sent(&mut self, seq: u64) -> Vec<Action> {
        self.m.on_stt(VoiceSttEvent::FinalizeSent { seq }, self.now)
    }

    fn wait(&mut self, ms: u64) -> Vec<Action> {
        self.now += ms;
        self.m.on_tick(self.now)
    }

    fn speaking(&mut self, s: bool) -> Vec<Action> {
        self.m.on_speaking(s, self.now)
    }

    fn state(&self) -> SessionState {
        self.m.state()
    }

    /// Speech long enough to be a turn, then the pause that ends it.
    fn say_a_turn(&mut self) -> Vec<Action> {
        let mut out = self.vad(0.9, 20);
        out.extend(self.vad(0.1, 22));
        out
    }
}

fn states(actions: &[Action]) -> Vec<SessionState> {
    actions.iter().filter_map(|a| if let Action::State { state, .. } = a { Some(*state) } else { None }).collect()
}

fn finalize_seq(actions: &[Action]) -> Option<u64> {
    actions.iter().find_map(|a| if let Action::Finalize { seq } = a { Some(*seq) } else { None })
}

fn turn(actions: &[Action]) -> Option<(String, String)> {
    actions.iter().find_map(|a| match a {
        Action::Turn { turn_id, text } => Some((turn_id.clone(), text.clone())),
        _ => None,
    })
}

fn transcripts(actions: &[Action]) -> Vec<(String, String, bool)> {
    actions
        .iter()
        .filter_map(|a| match a {
            Action::Transcript { turn_id, text, is_final } => Some((turn_id.clone(), text.clone(), *is_final)),
            _ => None,
        })
        .collect()
}

fn ended(actions: &[Action]) -> Option<(EndReason, Option<String>, Option<String>)> {
    actions.iter().find_map(|a| match a {
        Action::End { reason, text, error } => Some((*reason, text.clone(), error.clone())),
        _ => None,
    })
}

fn interrupted(actions: &[Action]) -> Option<String> {
    actions.iter().find_map(|a| if let Action::Interrupted { turn_id } = a { Some(turn_id.clone()) } else { None })
}

// ─── start ──────────────────────────────────────────────────────────────────

#[test]
fn starts_in_starting_then_listens_once_transcription_is_ready() {
    let (mut h, first) = H::with(TurnConfig::new(Mode::Conversation, 700, true), EchoMode::HalfDuplex);
    assert_eq!(first, vec![Action::State { state: SessionState::Starting, echo: EchoMode::HalfDuplex }]);
    assert_eq!(states(&h.ready()), vec![SessionState::Listening]);
    // The echo mode changing is a state event too.
    assert_eq!(
        h.m.on_echo(EchoMode::Cancelling),
        vec![Action::State { state: SessionState::Listening, echo: EchoMode::Cancelling }]
    );
    assert!(h.m.on_echo(EchoMode::Cancelling).is_empty(), "no repeat");
}

#[test]
fn speech_before_ready_is_a_turn_whose_finalize_waits_for_ready() {
    let (mut h, _) = H::with(TurnConfig::new(Mode::Conversation, 700, true), EchoMode::Converging);
    let a = h.say_a_turn();
    assert_eq!(h.state(), SessionState::Processing);
    assert_eq!(finalize_seq(&a), None, "no finalize before local-stt is ready");
    let a = h.ready();
    assert_eq!(finalize_seq(&a), Some(1));
    // The ack wait counts from when the finalize reached the engine: after
    // the backlog queued while it loaded, which can take a while.
    assert!(turn(&h.wait(2_000)).is_none());
    h.sent(1);
    assert!(turn(&h.wait(1_400)).is_none());
    h.words(true, &[("early", 0.1)]);
    assert_eq!(turn(&h.wait(100)), Some(("t1".into(), "early".into())));
}

#[test]
fn a_turn_spoken_while_local_stt_loads_is_not_lost_to_the_finalize_deadline() {
    // D1-4: a long load; the user speaks meanwhile; the engine is still
    // decoding the backlog when the ack wait runs out. The words it has
    // decoded so far (interim) are the turn, not nothing.
    let (mut h, _) = H::with(TurnConfig::new(Mode::Conversation, 700, true), EchoMode::Converging);
    h.wait(15_000);
    let t = h.secs();
    h.say_a_turn();
    h.wait(5_000);
    let seq = finalize_seq(&h.ready()).unwrap();
    h.wait(200);
    h.sent(seq);
    h.words(false, &[("remind", t + 0.1), ("me", t + 0.3), ("at", t + 0.4)]);
    let a = h.wait(1_500);
    assert_eq!(turn(&a), Some(("t1".into(), "remind me at".into())), "the interim tail inside the turn");
    // The engine catches up: those words come back final, and the ack. None
    // of it is sent again, and the next turn doesn't take them.
    h.words(true, &[("Remind", t + 0.1), ("me", t + 0.3), ("at", t + 0.4), ("noon.", t + 0.5)]);
    assert!(turn(&h.finalized(seq)).is_none());
    let t2 = h.secs();
    h.vad(0.9, 20);
    h.words(true, &[("Thanks.", t2 + 0.1)]);
    let a = h.vad(0.1, 22);
    let seq = finalize_seq(&a).unwrap();
    assert_eq!(turn(&h.finalized(seq)), Some(("t2".into(), "Thanks.".into())));
}

#[test]
fn a_finalize_that_never_reaches_the_engine_still_times_out() {
    let mut h = H::conv();
    let t = h.secs();
    h.vad(0.9, 20);
    h.words(true, &[("go", t + 0.1)]);
    let a = h.vad(0.1, 22);
    assert!(finalize_seq(&a).is_some());
    assert!(turn(&h.wait(FINALIZE_FORWARD_MS - 1)).is_none());
    assert_eq!(turn(&h.wait(1)), Some(("t1".into(), "go".into())));
}

#[test]
fn a_short_run_before_ready_goes_back_to_starting() {
    let (mut h, _) = H::with(TurnConfig::new(Mode::Conversation, 700, true), EchoMode::Converging);
    h.vad(0.9, 3);
    assert_eq!(h.state(), SessionState::UserSpeaking);
    h.vad(0.1, 22);
    assert_eq!(h.state(), SessionState::Starting);
}

// ─── onset, minimum speech, hangover ────────────────────────────────────────

#[test]
fn onset_is_the_first_frame_at_or_above_half() {
    let mut h = H::conv();
    h.vad(0.49, 10);
    assert_eq!(h.state(), SessionState::Listening);
    let onset_at = h.at;
    let a = h.vad(0.5, 1);
    assert_eq!(states(&a), vec![SessionState::UserSpeaking]);
    // Words from 300 ms before the onset belong to the turn, older ones don't.
    let t = onset_at as f64 / 16_000.0;
    h.vad(0.9, 10);
    h.words(true, &[("noise", t - 0.5), ("hey", t - 0.25), ("there", t + 0.1)]);
    let a = h.vad(0.1, 22);
    let seq = finalize_seq(&a).unwrap();
    assert_eq!(turn(&h.finalized(seq)), Some(("t1".into(), "hey there".into())));
}

#[test]
fn minimum_speech_is_256_ms() {
    // 7 frames = 224 ms: dropped.
    let mut h = H::conv();
    h.vad(0.9, 7);
    let a = h.vad(0.1, 22);
    assert_eq!(finalize_seq(&a), None);
    assert_eq!(states(&a), vec![SessionState::Listening]);
    // 8 frames = 256 ms: a turn.
    let mut h = H::conv();
    h.vad(0.9, 8);
    let a = h.vad(0.1, 22);
    assert_eq!(finalize_seq(&a), Some(1));
    assert_eq!(states(&a), vec![SessionState::Processing]);
}

#[test]
fn hangover_follows_end_silence_ms() {
    // ceil(endSilenceMs / 32 ms): 500 → 16, 700 → 22, 1200 → 38 frames.
    for (end_silence, frames) in [(500, 16), (700, 22), (1_200, 38)] {
        let mut h = H::conv_with(end_silence, true, EchoMode::Converging);
        h.vad(0.9, 10);
        h.vad(0.1, frames - 1);
        assert_eq!(h.state(), SessionState::UserSpeaking, "{end_silence} ms: one frame short");
        let a = h.vad(0.1, 1);
        assert_eq!(h.state(), SessionState::Processing, "{end_silence} ms");
        assert_eq!(finalize_seq(&a), Some(1));
    }
}

#[test]
fn hangover_follows_the_vads_frame_length() {
    let mut h = H::conv();
    h.m.set_vad_frame(256); // 16 ms frames: 700 ms → 44 frames
    for _ in 0..20 {
        h.m.on_vad(0.9, h.at, h.at + 256, h.now);
        h.at += 256;
    }
    for i in 0..44 {
        assert_eq!(h.state(), SessionState::UserSpeaking, "frame {i}");
        h.m.on_vad(0.1, h.at, h.at + 256, h.now);
        h.at += 256;
    }
    assert_eq!(h.state(), SessionState::Processing);
}

#[test]
fn a_mid_sentence_pause_shorter_than_the_hangover_is_kept() {
    let mut h = H::conv();
    let t0 = h.secs();
    h.vad(0.9, 10);
    h.words(true, &[("so", t0 + 0.05), ("the", t0 + 0.2)]);
    // 21 frames of pause (672 ms < 704 ms), then more speech.
    h.vad(0.1, 21);
    assert_eq!(h.state(), SessionState::UserSpeaking);
    let t1 = h.secs();
    h.vad(0.9, 10);
    h.words(true, &[("plan", t1 + 0.05), ("works", t1 + 0.3)]);
    let a = h.vad(0.1, 22);
    let seq = finalize_seq(&a).unwrap();
    assert_eq!(turn(&h.finalized(seq)), Some(("t1".into(), "so the plan works".into())));
}

#[test]
fn frames_between_off_and_onset_keep_counting_once_silence_started() {
    let mut h = H::conv();
    h.vad(0.9, 10);
    // 10 silent frames, then 12 in-between ones: 22 → the turn ends.
    h.vad(0.2, 10);
    h.vad(0.4, 11);
    assert_eq!(h.state(), SessionState::UserSpeaking);
    h.vad(0.4, 1);
    assert_eq!(h.state(), SessionState::Processing);
}

#[test]
fn frames_between_off_and_onset_before_any_silence_are_speech() {
    let mut h = H::conv();
    h.vad(0.6, 1); // onset
    h.vad(0.4, 7); // in between, no silence yet: speech (8 frames = 256 ms)
    let a = h.vad(0.1, 22);
    assert_eq!(finalize_seq(&a), Some(1), "in-between frames counted toward the minimum");
}

#[test]
fn an_onset_frame_resets_the_silence() {
    let mut h = H::conv();
    h.vad(0.9, 10);
    h.vad(0.1, 20);
    h.vad(0.4, 1); // in between: silence continues (21)
    h.vad(0.6, 1); // ≥ onset: reset
    h.vad(0.1, 21);
    assert_eq!(h.state(), SessionState::UserSpeaking);
    h.vad(0.1, 1);
    assert_eq!(h.state(), SessionState::Processing);
}

// ─── finalize, turn text, transcript ────────────────────────────────────────

#[test]
fn a_turn_is_finalized_then_sent_with_its_final_words() {
    let mut h = H::conv();
    let t = h.secs();
    let a = h.vad(0.9, 20);
    assert_eq!(states(&a), vec![SessionState::UserSpeaking]);
    let a = h.words(false, &[("what's", t + 0.1)]);
    assert_eq!(transcripts(&a), vec![("t1".into(), "what's".into(), false)]);
    let a = h.words(false, &[("what's", t + 0.1), ("the", t + 0.3)]);
    assert_eq!(transcripts(&a), vec![("t1".into(), "what's the".into(), false)]);
    let a = h.words(false, &[("what's", t + 0.1), ("the", t + 0.3)]);
    assert!(transcripts(&a).is_empty(), "unchanged text is not re-sent");
    let a = h.vad(0.1, 22);
    assert_eq!(states(&a), vec![SessionState::Processing]);
    let seq = finalize_seq(&a).unwrap();
    let a = h.words(true, &[("What's", t + 0.1), ("the", t + 0.3), ("plan?", t + 0.45)]);
    assert_eq!(transcripts(&a), vec![("t1".into(), "What's the plan?".into(), true)]);
    let a = h.finalized(seq);
    assert_eq!(turn(&a), Some(("t1".into(), "What's the plan?".into())));
    assert_eq!(states(&a), vec![SessionState::Listening]);
    assert!(!h.m.barge_armed());
}

/// The speech audio's view of the runs (`voice://speech`): open from the
/// onset, its words' window (less the onset slack), under the very id its
/// transcript and turn carry; bounded once processing; gone with the turn.
#[test]
fn open_runs_carry_the_turn_id_from_the_onset_to_the_turn() {
    let mut h = H::conv();
    h.vad(0.1, 10);
    assert!(h.m.open_runs().is_empty());
    let onset = h.at;
    let a = h.vad(0.9, 20);
    let slack = TurnConfig::new(Mode::Conversation, DEFAULT_END_SILENCE_MS, true).onset_slack_ms as u64 * 16;
    assert_eq!(h.m.open_runs(), vec![RunView { turn_id: "t1".into(), from: onset.saturating_sub(slack), until: None }]);
    assert!(states(&a).contains(&SessionState::UserSpeaking));
    let t = onset as f64 / 16_000.0;
    let a = h.words(false, &[("hi", t + 0.1)]);
    assert_eq!(transcripts(&a)[0].0, h.m.open_runs()[0].turn_id);
    let a = h.vad(0.1, 22);
    let seq = finalize_seq(&a).unwrap();
    let runs = h.m.open_runs();
    assert_eq!((runs.len(), runs[0].turn_id.as_str(), runs[0].until), (1, "t1", Some(h.at)));
    h.words(true, &[("hi", t + 0.1)]);
    let a = h.finalized(seq);
    assert_eq!(turn(&a).unwrap().0, "t1");
    assert!(h.m.open_runs().is_empty());
    // A run too short to be a turn just goes.
    h.vad(0.9, 3);
    assert_eq!(h.m.open_runs()[0].turn_id, "t2");
    h.vad(0.1, 22);
    assert!(h.m.open_runs().is_empty());
    // Dictation: none (one id for every run, no turns).
    let mut d = H::dictation();
    d.vad(0.9, 20);
    assert!(d.m.open_runs().is_empty());
}

#[test]
fn a_finalize_timeout_sends_what_is_final() {
    let mut h = H::conv();
    let t = h.secs();
    h.vad(0.9, 20);
    h.words(true, &[("book", t + 0.1), ("it", t + 0.3)]);
    h.words(false, &[("tomorrow", t + 0.5)]);
    let a = h.vad(0.1, 22);
    let seq = finalize_seq(&a).unwrap();
    // A stale FinalizeSent doesn't move the deadline.
    h.sent(seq + 7);
    h.sent(seq);
    assert!(turn(&h.wait(1_499)).is_none());
    let a = h.wait(1);
    assert_eq!(turn(&a), Some(("t1".into(), "book it tomorrow".into())), "the interim tail is sent too");
    assert_eq!(h.state(), SessionState::Listening);
    // The late ack changes nothing.
    assert!(turn(&h.finalized(seq)).is_none());
}

#[test]
fn an_acked_turn_is_its_final_words_only() {
    let mut h = H::conv();
    let t = h.secs();
    h.vad(0.9, 20);
    h.words(true, &[("book", t + 0.1), ("it", t + 0.3)]);
    h.words(false, &[("tomorrow", t + 0.5)]);
    let seq = finalize_seq(&h.vad(0.1, 22)).unwrap();
    h.sent(seq);
    assert_eq!(turn(&h.finalized(seq)), Some(("t1".into(), "book it".into())));
}

#[test]
fn a_stale_finalized_is_ignored() {
    let mut h = H::conv();
    h.say_a_turn();
    assert!(turn(&h.finalized(99)).is_none());
    assert_eq!(h.state(), SessionState::Processing);
}

#[test]
fn an_empty_turn_goes_quietly_back_to_listening() {
    let mut h = H::conv();
    let a = h.say_a_turn();
    let seq = finalize_seq(&a).unwrap();
    let a = h.finalized(seq);
    assert!(turn(&a).is_none());
    assert!(transcripts(&a).is_empty());
    assert_eq!(states(&a), vec![SessionState::Listening]);
}

#[test]
fn an_empty_turn_after_an_interim_clears_the_caption() {
    let mut h = H::conv();
    let t = h.secs();
    h.vad(0.9, 20);
    h.words(false, &[("um", t + 0.1)]);
    let a = h.vad(0.1, 22);
    let seq = finalize_seq(&a).unwrap();
    let a = h.finalized(seq);
    assert!(turn(&a).is_none());
    assert_eq!(transcripts(&a), vec![("t1".into(), String::new(), true)]);
}

#[test]
fn words_are_never_sent_in_two_turns() {
    let mut h = H::conv();
    let t = h.secs();
    let a = h.say_a_turn();
    // A late word, started during the pause (word times lag the voice).
    h.words(true, &[("first", t + 1.1)]);
    assert_eq!(turn(&h.finalized(finalize_seq(&a).unwrap())).unwrap().1, "first");
    // The next onset follows at once: its window (onset − 300 ms) reaches
    // back over "first".
    let t2 = h.secs();
    let a = h.say_a_turn();
    // A forced final re-emits the old word next to the new one.
    h.words(true, &[("first", t + 1.1), ("second", t2 + 0.1)]);
    assert_eq!(turn(&h.finalized(finalize_seq(&a).unwrap())), Some(("t2".into(), "second".into())));
}

#[test]
fn the_user_going_on_during_processing_starts_the_next_turn() {
    let mut h = H::conv();
    let t = h.secs();
    let a = h.say_a_turn();
    let seq = finalize_seq(&a).unwrap();
    h.words(true, &[("one", t + 0.1)]);
    // Speech again before the ack.
    let t2 = h.secs();
    let a = h.vad(0.9, 5);
    assert!(states(&a).is_empty(), "still processing");
    let a = h.finalized(seq);
    assert_eq!(turn(&a), Some(("t1".into(), "one".into())));
    assert_eq!(states(&a), vec![SessionState::UserSpeaking]);
    h.vad(0.9, 5);
    h.words(true, &[("two", t2 + 0.05)]);
    let a = h.vad(0.1, 22);
    let seq = finalize_seq(&a).unwrap();
    assert_eq!(turn(&h.finalized(seq)), Some(("t2".into(), "two".into())));
}

#[test]
fn a_blip_during_processing_is_dropped() {
    let mut h = H::conv();
    let a = h.say_a_turn();
    let seq = finalize_seq(&a).unwrap();
    h.vad(0.9, 2);
    h.vad(0.1, 22);
    let a = h.finalized(seq);
    assert_eq!(states(&a), vec![SessionState::Listening]);
}

// ─── the agent speaking, barge-in, half-duplex ──────────────────────────────

#[test]
fn agent_speaking_follows_tts_with_a_grace_and_an_echo_guard() {
    let mut h = H::conv();
    assert_eq!(states(&h.speaking(true)), vec![SessionState::AgentSpeaking]);
    // Mic speech is ignored while the agent speaks (barge-in is the DSP's).
    assert!(states(&h.vad(0.95, 30)).is_empty());
    // Quiet between two sentences: no flap.
    assert!(states(&h.speaking(false)).is_empty());
    assert!(states(&h.wait(200)).is_empty());
    assert!(states(&h.speaking(true)).is_empty());
    // Really done: listening after 300 ms of quiet.
    h.speaking(false);
    assert!(states(&h.wait(299)).is_empty());
    assert_eq!(states(&h.wait(1)), vec![SessionState::Listening]);
    // The echo tail right after is not an onset...
    assert!(states(&h.vad(0.9, 7)).is_empty(), "7 × 32 = 224 ms < 250 ms guard");
    // ...speech after the guard is.
    assert_eq!(states(&h.vad(0.9, 1)), vec![SessionState::UserSpeaking]);
}

/// With the system tap the DSP thread holds the mic 100 ms: the same echo
/// tail reaches the machine 100 ms later in wall time. The guard stretches
/// by the hold, so it covers the same audio; unstretched it would let the
/// tail's end open a run.
#[test]
fn the_echo_guard_covers_the_same_audio_when_the_mic_is_held() {
    fn after_the_agent(delay: Option<u64>) -> H {
        let mut h = H::conv();
        if let Some(ms) = delay {
            h.m.on_audio_delay(ms);
        }
        h.speaking(true);
        h.speaking(false);
        h.wait(300);
        assert_eq!(h.state(), SessionState::Listening);
        // The held audio arrives 100 ms behind.
        h.now += 100;
        h
    }
    let mut held = after_the_agent(Some(100));
    assert!(states(&held.vad(0.9, 7)).is_empty(), "the tail (224 ms of audio after the agent) is still guarded");
    assert_eq!(states(&held.vad(0.9, 1)), vec![SessionState::UserSpeaking], "speech after the guard's audio is a turn");
    // Without the stretch the same audio would open a run inside the tail.
    let mut unstretched = after_the_agent(None);
    assert_eq!(states(&unstretched.vad(0.9, 7)), vec![SessionState::UserSpeaking]);
    // And no hold: exactly as before (the 250 ms guard).
    let mut h = H::conv();
    assert!(h.m.on_audio_delay(0).iter().all(|a| matches!(a, Action::State { .. })));
}

#[test]
fn barge_in_interrupts_and_starts_the_turn_at_its_onset() {
    let mut h = H::conv_with(700, true, EchoMode::Cancelling);
    h.speaking(true);
    assert!(h.m.barge_armed());
    h.vad(0.2, 5);
    let onset = h.at;
    let t = h.secs();
    h.vad(0.9, 10); // the DSP thread's sustained run
    let a = h.m.on_barge_in(onset, h.now);
    assert_eq!(interrupted(&a), Some("t1".into()));
    assert_eq!(states(&a), vec![SessionState::UserSpeaking]);
    // TTS goes quiet (it was cancelled): the user keeps the floor.
    assert!(states(&h.speaking(false)).is_empty());
    h.words(true, &[("wait", t + 0.15), ("stop", t + 0.4)]);
    let a = h.vad(0.1, 22);
    let seq = finalize_seq(&a).expect("the barge-in run counts as speech");
    assert_eq!(turn(&h.finalized(seq)), Some(("t1".into(), "wait stop".into())));
}

#[test]
fn barge_in_while_the_user_already_holds_the_floor_keeps_the_turn() {
    let mut h = H::conv_with(700, true, EchoMode::Headphones);
    h.vad(0.9, 5);
    assert_eq!(h.state(), SessionState::UserSpeaking);
    // The previous reply starts playing while the user talks: allowed echo,
    // so the user keeps the floor and barge-in is armed.
    assert!(states(&h.speaking(true)).is_empty());
    assert!(h.m.barge_armed());
    let a = h.m.on_barge_in(h.at, h.now);
    assert_eq!(interrupted(&a), Some("t1".into()));
    assert!(states(&a).is_empty());
}

#[test]
fn barge_in_arming() {
    // Needs: conversation, bargeIn on, not muted, TTS audible, the agent's
    // or the user's turn.
    let mut h = H::conv();
    assert!(!h.m.barge_armed(), "listening");
    h.speaking(true);
    assert!(h.m.barge_armed());
    h.m.on_mute(true, h.now);
    assert!(!h.m.barge_armed(), "muted");
    h.m.on_mute(false, h.now);
    assert!(h.m.barge_armed());

    let mut h = H::conv_with(700, false, EchoMode::Cancelling);
    h.speaking(true);
    assert!(!h.m.barge_armed(), "Interrupt by talking is off");

    let mut h = H::dictation();
    h.speaking(true);
    assert!(!h.m.barge_armed(), "dictation");
}

#[test]
fn the_agent_starting_while_the_user_holds_the_floor_never_cuts_them_mid_word() {
    // D1-3: converging or half-duplex (no barge-in), the user adds an
    // afterthought while the reply is generated, and the reply starts
    // speaking mid-sentence. The user was first: the run stays open and ends
    // on its own hangover, as one turn.
    for echo in [EchoMode::Converging, EchoMode::HalfDuplex] {
        let mut h = H::conv_with(700, true, echo);
        let t = h.secs();
        h.vad(0.9, 10);
        h.words(false, &[("oh", t + 0.1), ("and", t + 0.2), ("ma", t + 0.3)]);
        let a = h.speaking(true);
        assert!(finalize_seq(&a).is_none(), "{echo:?}: not cut at the reply's start");
        assert_eq!(h.state(), SessionState::UserSpeaking);
        // The user finishes the word and the sentence, then pauses.
        h.vad(0.9, 15);
        h.words(true, &[("oh", t + 0.1), ("and", t + 0.2), ("make", t + 0.3), ("it", t + 0.6), ("blue", t + 0.8)]);
        let a = h.vad(0.1, 22);
        assert_eq!(states(&a), vec![SessionState::Processing], "{echo:?}");
        let seq = finalize_seq(&a).unwrap();
        let a = h.finalized(seq);
        assert_eq!(turn(&a), Some(("t1".into(), "oh and make it blue".into())), "{echo:?}: one turn");
        assert_eq!(states(&a), vec![SessionState::AgentSpeaking]);
    }
}

#[test]
fn a_run_too_short_to_be_a_turn_is_dropped_on_its_own_hangover() {
    let mut h = H::conv_with(700, true, EchoMode::HalfDuplex);
    h.vad(0.9, 3);
    let a = h.speaking(true);
    assert!(finalize_seq(&a).is_none());
    assert_eq!(h.state(), SessionState::UserSpeaking);
    let a = h.vad(0.1, 22);
    assert_eq!(finalize_seq(&a), None);
    assert_eq!(states(&a), vec![SessionState::AgentSpeaking]);
}

#[test]
fn echo_opens_no_new_run_once_the_users_run_ended() {
    let mut h = H::conv_with(700, true, EchoMode::Converging);
    h.vad(0.9, 10);
    h.speaking(true);
    h.vad(0.9, 5);
    let seq = finalize_seq(&h.vad(0.1, 22)).unwrap();
    // The agent's voice on the mic while the turn finalizes: no next turn.
    h.vad(0.9, 30);
    let a = h.finalized(seq);
    assert_eq!(states(&a), vec![SessionState::AgentSpeaking]);
    assert!(h.vad(0.9, 30).is_empty(), "ignored while the agent speaks");
    // With barge-in allowed, the user going on during processing is still
    // the next turn (the DSP thread's barge-in guards the echo there).
    let mut h = H::conv_with(700, true, EchoMode::Cancelling);
    h.vad(0.9, 10);
    h.speaking(true);
    let seq = finalize_seq(&h.vad(0.1, 22)).unwrap();
    h.vad(0.9, 10);
    assert_eq!(states(&h.finalized(seq)), vec![SessionState::UserSpeaking]);
}

#[test]
fn echo_that_never_goes_quiet_cannot_hold_the_users_run_open() {
    let cfg = TurnConfig::new(Mode::Conversation, 700, true);
    let (soft, max) = (cfg.overlap_soft_ms, cfg.overlap_max_ms);
    // After the soft limit the run ends at its next silent frame...
    let mut h = H::conv_with(700, true, EchoMode::Converging);
    h.vad(0.9, 10);
    h.speaking(true);
    let frames = (soft / F_MS) as usize;
    assert!(finalize_seq(&h.vad(0.9, frames)).is_none(), "user and echo, never quiet");
    assert!(finalize_seq(&h.vad(0.5, 3)).is_none(), "in between: not silence");
    assert!(finalize_seq(&h.vad(0.2, 1)).is_some(), "one silent frame ends it");
    // ...and after the hard one regardless.
    let mut h = H::conv_with(700, true, EchoMode::HalfDuplex);
    h.vad(0.9, 10);
    h.speaking(true);
    let mut ended_after = None;
    for i in 1..=(max / F_MS + 2) {
        if finalize_seq(&h.vad(0.9, 1)).is_some() {
            ended_after = Some(i * F_MS);
            break;
        }
    }
    let ms = ended_after.expect("ended");
    assert!((max..max + 2 * F_MS).contains(&ms), "{ms}");
    // The agent quiet (between sentences), nothing is capped.
    let mut h = H::conv_with(700, true, EchoMode::HalfDuplex);
    h.vad(0.9, 10);
    assert!(finalize_seq(&h.vad(0.9, (max / F_MS) as usize + 10)).is_none());
}

#[test]
fn barge_in_off_keeps_the_floor_like_half_duplex_even_on_headphones() {
    let mut h = H::conv_with(700, false, EchoMode::Headphones);
    h.vad(0.9, 10);
    let a = h.speaking(true);
    assert!(finalize_seq(&a).is_none());
    assert_eq!(h.state(), SessionState::UserSpeaking);
    assert!(!h.m.barge_armed());
    assert_eq!(states(&h.vad(0.1, 22)), vec![SessionState::Processing]);
}

// ─── the intro: no mute hold, the greeting as an aside ─────────────────────

#[test]
fn the_start_chime_heard_as_speech_makes_no_turn() {
    // The web's start chime plays with the mic live (no hold). Page audio is
    // not in the canceller's reference, so on laptop speakers it may pass for
    // speech: a run opens (the web then skips the greeting), but the chime
    // has no words, so the run ends as an empty turn: nothing is sent.
    let mut h = H::conv();
    let a = h.vad(0.9, 45); // ~1.4 s of chime
    assert_eq!(states(&a), vec![SessionState::UserSpeaking]);
    let a = h.vad(0.05, 40);
    let seq = finalize_seq(&a).expect("long enough to be finalized");
    let a = h.finalized(seq);
    assert!(turn(&a).is_none(), "{a:?}");
    assert!(transcripts(&a).is_empty());
    assert_eq!(states(&a), vec![SessionState::Listening]);
}

#[test]
fn speech_that_began_before_the_greeting_survives_its_cancel() {
    // The user talks first; the greeting (already sent) starts over them on
    // a route with no barge-in yet, and the web cuts it on user_speaking.
    // The run that began first is the user's whole turn, from its onset.
    let mut h = H::conv_with(700, true, EchoMode::Converging);
    let t = h.secs();
    h.vad(0.9, 6);
    assert_eq!(h.state(), SessionState::UserSpeaking);
    h.m.on_aside(true, None);
    assert!(finalize_seq(&h.speaking(true)).is_none());
    h.vad(0.9, 4);
    assert!(states(&h.speaking(false)).is_empty(), "the web cut the greeting: the user keeps the floor");
    h.vad(0.9, 10);
    h.words(true, &[("so", t + 0.05), ("about", t + 0.3), ("that", t + 0.6)]);
    let a = h.vad(0.1, 22);
    let seq = finalize_seq(&a).unwrap();
    assert_eq!(turn(&h.finalized(seq)), Some(("t1".into(), "so about that".into())));
}

#[test]
fn barge_in_arming_for_an_aside() {
    // Converging: barge-in is armed (the machine's side), and an aside says
    // the DSP may fire it on the headphones hint alone.
    let mut h = H::conv();
    h.m.on_aside(true, None);
    assert!(!h.m.barge_aside(), "nothing is playing yet");
    h.speaking(true);
    assert!(h.m.barge_armed() && h.m.barge_aside());
    // Between the greeting's sentences: still the aside.
    h.speaking(false);
    h.wait(100);
    h.speaking(true);
    assert!(h.m.barge_aside());
    // The agent went quiet: the aside is over; the next speech is a reply.
    h.speaking(false);
    h.wait(300);
    h.speaking(true);
    assert!(h.m.barge_armed() && !h.m.barge_aside());

    // Taken back by the web.
    let mut h = H::conv();
    h.m.on_aside(true, None);
    h.speaking(true);
    h.m.on_aside(false, None);
    assert!(!h.m.barge_aside());

    // A sent turn ends it (a greeting that never played).
    let mut h = H::conv();
    h.m.on_aside(true, None);
    let seq = finalize_seq(&h.say_a_turn()).unwrap();
    h.words(true, &[("hi", 0.2)]);
    assert!(turn(&h.finalized(seq)).is_some());
    h.speaking(true);
    assert!(h.m.barge_armed() && !h.m.barge_aside());

    // Muted, or "Interrupt by talking" off: not armed at all.
    let mut h = H::conv();
    h.m.on_aside(true, None);
    h.speaking(true);
    h.m.on_mute(true, h.now);
    assert!(!h.m.barge_aside());
    let mut h = H::conv_with(700, false, EchoMode::Converging);
    h.m.on_aside(true, None);
    h.speaking(true);
    assert!(!h.m.barge_aside());

    // Dictation has no asides.
    let mut h = H::dictation();
    h.m.on_aside(true, None);
    h.speaking(true);
    assert!(!h.m.barge_aside());
}

#[test]
fn talking_over_the_greeting_cuts_it_and_keeps_the_words_from_the_first() {
    // Headphones by name, the canceller still converging: the DSP fires
    // barge-in into the aside. The run starts at the barge-in's onset (words
    // from its slack on), and the user going on after the cut makes the turn.
    let mut h = H::conv_with(700, true, EchoMode::Converging);
    h.m.on_aside(true, Some("What's up?"));
    assert_eq!(states(&h.speaking(true)), vec![SessionState::AgentSpeaking]);
    h.vad(0.1, 5);
    let onset = h.at;
    let t = h.secs();
    // The barge-in's sustain: the machine shows nothing meanwhile.
    assert!(states(&h.vad(0.9, 10)).is_empty());
    let a = h.m.on_barge_in(onset, h.now);
    assert_eq!(interrupted(&a), Some("t1".into()));
    assert_eq!(states(&a), vec![SessionState::UserSpeaking]);
    assert!(!h.m.barge_aside(), "the aside is over");
    assert!(states(&h.speaking(false)).is_empty());
    h.vad(0.9, 15);
    h.words(true, &[("actually", t + 0.05), ("wait", t + 0.5), ("one", t + 0.9), ("thing", t + 1.1)]);
    let a = h.vad(0.1, 22);
    let seq = finalize_seq(&a).expect("the user went on after the cut");
    assert_eq!(turn(&h.finalized(seq)), Some(("t1".into(), "actually wait one thing".into())));
}

#[test]
fn a_short_reply_over_the_greeting_is_a_turn() {
    // Headphones (the canceller still converging): "Hello?" over the
    // greeting fires barge-in after its sustain and stops just after the
    // cut. The barge-in's sustain counts, so the reply is a turn, not
    // silence with the greeting gone.
    let mut h = H::conv_with(700, true, EchoMode::Converging);
    h.m.on_aside(true, Some("What's up?"));
    h.speaking(true);
    h.vad(0.1, 3);
    let onset = h.at;
    let t = h.secs();
    h.vad(0.9, 10);
    let a = h.m.on_barge_in(onset, h.now);
    assert_eq!(interrupted(&a), Some("t1".into()));
    h.speaking(false);
    h.vad(0.9, 2);
    h.words(true, &[("Hello?", t + 0.05)]);
    let a = h.vad(0.1, 40);
    let seq = finalize_seq(&a).expect("a short reply is still a turn");
    assert_eq!(turn(&h.finalized(seq)), Some(("t1".into(), "Hello?".into())));

    // The same in the noisy room, whose turns need more speech (400 ms).
    let mut h = H::noisy();
    h.m.on_aside(true, Some("Yo"));
    h.speaking(true);
    h.lvad(0.05, -72.0, 3);
    let onset = h.at;
    let t = h.secs();
    h.lvad(0.95, NEAR, 10);
    h.m.on_barge_in(onset, h.now);
    h.speaking(false);
    h.lvad(0.95, NEAR, 2);
    h.words(true, &[("Yeah", t + 0.05)]);
    let a = h.lvad(0.05, -72.0, 40);
    let seq = finalize_seq(&a).expect("a short reply is still a turn");
    assert_eq!(turn(&h.finalized(seq)).map(|t| t.1), Some("Yeah".into()));
}

#[test]
fn an_asides_own_echo_never_makes_a_turn() {
    // A speaker whose name says headphones: the greeting's echo fires the
    // barge-in, which cancels it. Its run is finalized like any other, but
    // its words are the aside's own: nothing is sent.
    let mut h = H::conv_with(700, true, EchoMode::Converging);
    h.m.on_aside(true, Some("What's up?"));
    h.speaking(true);
    let onset = h.at;
    let t = h.secs();
    h.vad(0.9, 10);
    h.m.on_barge_in(onset, h.now);
    h.speaking(false);
    // The echo tail after the cancel, then quiet.
    h.vad(0.9, 3);
    h.words(true, &[("what's", t + 0.05), ("up", t + 0.3)]);
    let a = h.vad(0.1, 40);
    let seq = finalize_seq(&a).expect("finalized like any run");
    let a = h.finalized(seq);
    assert!(turn(&a).is_none(), "{a:?}");
    assert_eq!(h.state(), SessionState::Listening);

    // Heard a little off ("Yo" as "you"): still the aside's.
    let mut h = H::conv_with(700, true, EchoMode::Converging);
    h.m.on_aside(true, Some("Yo"));
    h.speaking(true);
    let (onset, t) = (h.at, h.secs());
    h.vad(0.9, 10);
    h.m.on_barge_in(onset, h.now);
    h.speaking(false);
    h.words(true, &[("you", t + 0.05)]);
    let seq = finalize_seq(&h.vad(0.1, 40)).unwrap();
    assert!(turn(&h.finalized(seq)).is_none());

    // A barge-in into a reply (no aside) still counts its sustain, as before.
    let mut h = H::conv_with(700, true, EchoMode::Cancelling);
    h.speaking(true);
    let onset = h.at;
    h.vad(0.9, 10);
    h.m.on_barge_in(onset, h.now);
    h.speaking(false);
    let a = h.vad(0.1, 22);
    assert!(finalize_seq(&a).is_some());
}

#[test]
fn the_asides_echo_is_dropped_and_the_reply_after_it_kept() {
    // The greeting's echo and the user's reply in one run: the aside's
    // words it begins with go, the user's stay, even one that happens to be
    // a word of the aside later on.
    let mut h = H::conv_with(700, true, EchoMode::Converging);
    h.m.on_aside(true, Some("What we doing?"));
    h.speaking(true);
    let (onset, t) = (h.at, h.secs());
    h.vad(0.9, 10);
    h.m.on_barge_in(onset, h.now);
    h.speaking(false);
    h.vad(0.9, 20);
    h.words(true, &[("what", t), ("we", t + 0.15), ("check", t + 0.4), ("what", t + 0.6), ("we", t + 0.8), ("have", t + 1.0)]);
    let seq = finalize_seq(&h.vad(0.1, 22)).unwrap();
    assert_eq!(turn(&h.finalized(seq)).map(|t| t.1), Some("check what we have".into()));

    // The user's first word isn't the aside's: nothing is dropped.
    let mut h = H::conv_with(700, true, EchoMode::Converging);
    h.m.on_aside(true, Some("What we doing?"));
    h.speaking(true);
    let (onset, t) = (h.at, h.secs());
    h.vad(0.9, 10);
    h.m.on_barge_in(onset, h.now);
    h.speaking(false);
    h.vad(0.9, 20);
    h.words(true, &[("hey", t), ("what", t + 0.2), ("we", t + 0.4), ("doing", t + 0.6), ("today", t + 0.8)]);
    let seq = finalize_seq(&h.vad(0.1, 22)).unwrap();
    assert_eq!(turn(&h.finalized(seq)).map(|t| t.1), Some("hey what we doing today".into()));

    // Past the echo's tail after the cut, the aside's words are the user's.
    let mut h = H::conv_with(700, true, EchoMode::Converging);
    h.m.on_aside(true, Some("Hey"));
    h.speaking(true);
    let onset = h.at;
    h.vad(0.9, 10);
    h.m.on_barge_in(onset, h.now);
    h.speaking(false);
    let late = h.secs() + ASIDE_ECHO_TAIL_MS as f64 / 1000.0 + 0.1;
    h.vad(0.9, 30);
    h.words(true, &[("hey", late), ("there", late + 0.2)]);
    let seq = finalize_seq(&h.vad(0.1, 22)).unwrap();
    assert_eq!(turn(&h.finalized(seq)).map(|t| t.1), Some("hey there".into()));
}

#[test]
fn heard_as_the_asides_word() {
    for (a, b, same) in [
        ("yo", "yo", true),
        ("yo", "you", true),
        ("doing", "doin", true),
        ("whats", "was", false),
        ("hey", "hay", true),
        ("hey", "hi", false),
        ("up", "", false),
        ("we", "check", false),
    ] {
        assert_eq!(super::alike(a, b), same, "{a} / {b}");
        assert_eq!(super::alike(b, a), same, "{b} / {a}");
    }
}

// ─── laptop speakers: the greeting plays out, the words over it are kept ───

/// Laptop speakers: no headphones hint, so no barge-in into the aside while
/// the canceller converges. The greeting is playing.
fn speakers_greeting(text: &str) -> H {
    let mut h = H::conv_with(700, true, EchoMode::Converging);
    h.m.on_aside(true, Some(text));
    assert_eq!(states(&h.speaking(true)), vec![SessionState::AgentSpeaking]);
    h
}

#[test]
fn on_speakers_speech_over_the_greeting_is_kept_from_its_onset() {
    let mut h = speakers_greeting("What's up?");
    // The greeting's echo, then the user over its end, still talking as it
    // stops.
    let t = h.secs();
    let a = h.vad(0.9, 20);
    assert!(states(&a).is_empty(), "the aside plays out: {a:?}");
    h.speaking(false);
    h.vad(0.9, 5);
    h.wait(0);
    let a = h.vad(0.9, 5);
    assert!(states(&a).is_empty());
    let a = h.wait(0);
    assert_eq!(states(&a), vec![SessionState::UserSpeaking], "the user was still talking");
    h.vad(0.9, 15);
    h.words(true, &[("what's", t + 0.05), ("up", t + 0.25), ("can", t + 0.5), ("you", t + 0.7), ("check", t + 0.9), ("my", t + 1.1), ("calendar", t + 1.3)]);
    let a = h.vad(0.1, 22);
    let seq = finalize_seq(&a).expect("their turn");
    assert_eq!(turn(&h.finalized(seq)), Some(("t1".into(), "can you check my calendar".into())));
}

#[test]
fn on_speakers_the_greetings_echo_alone_opens_nothing() {
    let mut h = speakers_greeting("What we doing?");
    let t = h.secs();
    h.vad(0.9, 25);
    h.words(true, &[("what", t + 0.05), ("we", t + 0.3), ("doing", t + 0.5)]);
    h.speaking(false);
    // The echo stops with the audio; the grace, then quiet.
    let mut a = h.vad(0.1, 10);
    a.extend(h.wait(0));
    assert_eq!(states(&a), vec![SessionState::Listening]);
    let a = h.vad(0.1, 40);
    assert!(states(&a).is_empty(), "{a:?}");
    assert_eq!(finalize_seq(&a), None);
    // The next thing the user says is a turn of its own.
    let t = h.secs();
    let mut a = h.vad(0.9, 20);
    h.words(true, &[("hello", t + 0.05)]);
    a.extend(h.vad(0.1, 22));
    let seq = finalize_seq(&a).unwrap();
    assert_eq!(turn(&h.finalized(seq)).map(|t| t.1), Some("hello".into()));
}

#[test]
fn on_speakers_a_pause_as_the_greeting_ends_is_bridged_within_the_guard() {
    // The user talks over the greeting, pauses as it ends, and goes on
    // within the echo guard: one turn from their first word.
    let mut h = speakers_greeting("Hey");
    h.vad(0.1, 3);
    let t = h.secs();
    h.vad(0.9, 15);
    h.speaking(false);
    h.vad(0.1, 10);
    let a = h.wait(0);
    assert_eq!(states(&a), vec![SessionState::Listening], "a pause: not yet theirs");
    let a = h.vad(0.9, 3);
    assert_eq!(states(&a), vec![SessionState::UserSpeaking], "they went on within the guard");
    h.vad(0.9, 10);
    h.words(true, &[("so", t + 0.05), ("about", t + 0.3), ("tomorrow", t + 1.0)]);
    let seq = finalize_seq(&h.vad(0.1, 22)).unwrap();
    assert_eq!(turn(&h.finalized(seq)), Some(("t1".into(), "so about tomorrow".into())));

    // Past the guard the shadow is gone: a new onset is a run of its own.
    let mut h = speakers_greeting("Hey");
    let t0 = h.secs();
    h.vad(0.9, 15);
    h.words(true, &[("early", t0 + 0.05)]);
    h.speaking(false);
    h.vad(0.1, 10);
    h.wait(0);
    h.vad(0.1, 10);
    let t = h.secs();
    let a = h.vad(0.9, 20);
    assert_eq!(states(&a), vec![SessionState::UserSpeaking]);
    h.words(true, &[("later", t + 0.05)]);
    let seq = finalize_seq(&h.vad(0.1, 22)).unwrap();
    assert_eq!(turn(&h.finalized(seq)), Some(("t1".into(), "later".into())));
}

#[test]
fn on_speakers_a_mute_or_a_taken_back_aside_drops_the_shadow() {
    // Speech before a mute is never a turn.
    let mut h = speakers_greeting("Hey");
    h.vad(0.9, 15);
    h.m.on_mute(true, h.now);
    h.speaking(false);
    h.wait(400);
    let a = h.m.on_mute(false, h.now);
    assert_eq!(states(&a), vec![SessionState::Listening]);
    let a = h.vad(0.1, 30);
    assert!(states(&a).is_empty(), "{a:?}");

    // The web took the aside back: the rest is agent speech like any other
    // (its echo guard holds).
    let mut h = speakers_greeting("Hey");
    h.vad(0.9, 15);
    h.m.on_aside(false, None);
    h.speaking(false);
    h.vad(0.9, 10);
    assert_eq!(states(&h.wait(0)), vec![SessionState::Listening]);
    let a = h.vad(0.9, 5);
    assert!(states(&a).is_empty(), "{a:?}");
}

#[test]
fn on_speakers_in_the_noisy_room_speech_over_the_greeting_is_kept() {
    let mut h = H::noisy();
    h.m.on_aside(true, Some("What's up?"));
    h.speaking(true);
    h.lvad(0.05, -72.0, 3);
    let t = h.secs();
    let a = h.lvad(0.95, NEAR, 20);
    assert!(states(&a).is_empty());
    h.speaking(false);
    h.lvad(0.95, NEAR, 10);
    let a = h.wait(0);
    assert_eq!(states(&a), vec![SessionState::UserSpeaking]);
    h.lvad(0.95, NEAR, 10);
    h.words(true, &[("what's", t + 0.05), ("up", t + 0.25), ("book", t + 0.6), ("lunch", t + 0.9)]);
    let seq = finalize_seq(&h.lvad(0.05, -72.0, 30)).expect("their turn");
    assert_eq!(turn(&h.finalized(seq)).map(|t| t.1), Some("book lunch".into()));

    // Far speech over the greeting (a TV) is no one's turn.
    let mut h = H::noisy();
    h.m.on_aside(true, Some("Hey"));
    h.speaking(true);
    h.lvad(0.95, FAR, 20);
    h.speaking(false);
    h.lvad(0.95, FAR, 10);
    let mut a = h.wait(0);
    a.extend(h.lvad(0.95, FAR, 40));
    assert!(!states(&a).contains(&SessionState::UserSpeaking), "{a:?}");
}

#[test]
fn barge_in_during_processing_is_the_next_turn() {
    let mut h = H::conv_with(700, true, EchoMode::Cancelling);
    let a = h.say_a_turn();
    let seq = finalize_seq(&a).unwrap();
    // (Not armed in processing; a race that fired anyway still counts.)
    let onset = h.at;
    let a = h.m.on_barge_in(onset, h.now);
    assert_eq!(interrupted(&a), Some("t2".into()));
    let a = h.finalized(seq);
    assert_eq!(states(&a), vec![SessionState::UserSpeaking]);
}

#[test]
fn barge_in_racing_the_agent_quiet_grace_still_starts_a_turn() {
    let mut h = H::conv_with(700, true, EchoMode::Cancelling);
    h.speaking(true);
    h.speaking(false);
    h.wait(300);
    assert_eq!(h.state(), SessionState::Listening);
    let a = h.m.on_barge_in(h.at, h.now);
    assert_eq!(interrupted(&a), Some("t1".into()));
    assert_eq!(h.state(), SessionState::UserSpeaking);
}

// ─── mute ───────────────────────────────────────────────────────────────────

impl H {
    /// Audio time passing with no VAD frames (muted: local-stt gets silence,
    /// the DSP thread feeds the VAD nothing).
    fn muted_audio(&mut self, frames: u64) {
        self.at += frames * F;
        self.now += frames * F_MS;
    }
}

#[test]
fn mute_mid_turn_sends_the_words_said_before_it() {
    let mut h = H::conv();
    let t = h.secs();
    h.vad(0.9, 10);
    h.words(false, &[("turn", t + 0.1), ("the", t + 0.2)]);
    let muted_at = h.secs();
    let a = h.m.on_mute(true, h.now);
    // The turn ends at the mute like at its pause: finalize, then send.
    let seq = finalize_seq(&a).expect("the turn is finalized");
    assert_eq!(states(&a), vec![SessionState::Muted], "the web sees muted, not processing");
    assert!(transcripts(&a).is_empty(), "the caption stays: the turn is on its way");
    // VAD frames while muted do nothing (the DSP doesn't send them anyway).
    assert!(h.vad(0.9, 40).is_empty());
    h.muted_audio(20);
    // The finalize flushes what was said before the mute (its last word
    // starting just after the last VAD frame seen); nothing starts later
    // (local-stt hears silence), but a word that did can't join.
    h.words(true, &[("turn", t + 0.1), ("the", t + 0.2), ("tv", muted_at + 0.1), ("later", muted_at + 1.0)]);
    let a = h.finalized(seq);
    assert_eq!(turn(&a), Some(("t1".into(), "turn the tv".into())));
    assert!(states(&a).is_empty(), "still muted");
    assert_eq!(h.state(), SessionState::Muted);
    // Agent speech while muted is still tracked, but the state stays muted.
    assert!(states(&h.speaking(true)).is_empty());
    let a = h.m.on_mute(false, h.now);
    assert_eq!(states(&a), vec![SessionState::AgentSpeaking]);
}

#[test]
fn mute_mid_turn_times_out_with_the_interim_words() {
    // No ack in time: the turn goes with its interim words, as at a pause.
    let mut h = H::conv();
    let t = h.secs();
    h.vad(0.9, 10);
    h.words(false, &[("almost", t + 0.1)]);
    let seq = finalize_seq(&h.m.on_mute(true, h.now)).unwrap();
    h.sent(seq);
    let a = h.wait(1_500);
    assert_eq!(turn(&a), Some(("t1".into(), "almost".into())));
    assert_eq!(h.state(), SessionState::Muted);
}

#[test]
fn a_run_too_short_for_a_turn_is_dropped_by_mute() {
    let mut h = H::conv();
    let t = h.secs();
    // 160 ms of speech: under min speech (256 ms), as a pause would drop it.
    h.vad(0.9, 5);
    h.words(false, &[("uh", t + 0.05)]);
    let a = h.m.on_mute(true, h.now);
    assert_eq!(states(&a), vec![SessionState::Muted]);
    assert_eq!(transcripts(&a), vec![("t1".into(), String::new(), true)], "the caption is cleared");
    assert_eq!(finalize_seq(&a), None);
    h.words(true, &[("uh", t + 0.05)]);
    assert!(turn(&h.wait(5_000)).is_none());
    // Trailing silence doesn't count as speech: 5 speech frames and a pause
    // shorter than the hangover is still too short.
    let mut h = H::conv();
    h.vad(0.9, 5);
    h.vad(0.1, 15);
    assert_eq!(h.state(), SessionState::UserSpeaking);
    assert_eq!(finalize_seq(&h.m.on_mute(true, h.now)), None);
}

#[test]
fn mute_during_processing_sends_the_queued_next_turn_after_it() {
    let mut h = H::conv();
    let t = h.secs();
    let seq1 = finalize_seq(&h.say_a_turn()).unwrap();
    h.words(true, &[("first", t + 0.1)]);
    // The user goes on while the first turn is finalized...
    let t2 = h.secs();
    h.vad(0.9, 10);
    h.words(false, &[("second", t2 + 0.1)]);
    // ...and mutes: the queued run is cut here, not dropped.
    let a = h.m.on_mute(true, h.now);
    assert_eq!(states(&a), vec![SessionState::Muted]);
    assert_eq!(finalize_seq(&a), None, "one finalize at a time");
    h.muted_audio(20);
    let a = h.finalized(seq1);
    assert_eq!(turn(&a), Some(("t1".into(), "first".into())));
    // The cut run ends at once: its own finalize, then its turn.
    let seq2 = finalize_seq(&a).expect("the cut run is finalized");
    assert!(states(&a).is_empty(), "still muted");
    h.words(true, &[("second", t2 + 0.1), ("thing", t2 + 0.25)]);
    let a = h.finalized(seq2);
    assert_eq!(turn(&a), Some(("t2".into(), "second thing".into())));
    assert_eq!(h.state(), SessionState::Muted);

    // A queued run too short to be a turn is dropped.
    let mut h = H::conv();
    let seq1 = finalize_seq(&h.say_a_turn()).unwrap();
    h.vad(0.9, 4);
    h.m.on_mute(true, h.now);
    let a = h.finalized(seq1);
    assert_eq!(finalize_seq(&a), None);
    assert_eq!(h.state(), SessionState::Muted);
}

#[test]
fn a_cut_run_takes_nothing_said_after_an_unmute() {
    let mut h = H::conv();
    let seq1 = finalize_seq(&h.say_a_turn()).unwrap();
    let t2 = h.secs();
    h.vad(0.9, 10);
    h.m.on_mute(true, h.now);
    h.muted_audio(20);
    // Unmuted and talking again before the first turn's ack: the cut run
    // isn't stepped by it (and doesn't take its words).
    assert_eq!(states(&h.m.on_mute(false, h.now)), vec![SessionState::Processing]);
    let t3 = h.secs();
    assert!(h.vad(0.9, 10).is_empty());
    h.words(true, &[("second", t2 + 0.1), ("third", t3 + 0.1)]);
    let a = h.finalized(seq1);
    let seq2 = finalize_seq(&a).expect("the cut run ends at once");
    let a = h.finalized(seq2);
    assert_eq!(turn(&a), Some(("t2".into(), "second".into())));
    // The speech after the unmute is a run of its own, from its onset.
    assert_eq!(h.state(), SessionState::UserSpeaking);
    let t4 = h.secs();
    let seq3 = finalize_seq(&h.say_a_turn()).unwrap();
    h.words(true, &[("fourth", t4 + 0.1)]);
    assert_eq!(turn(&h.finalized(seq3)), Some(("t3".into(), "third fourth".into())));
}

#[test]
fn speech_after_an_unmute_while_a_cut_run_waits_is_the_next_turn() {
    let mut h = H::conv();
    let t1 = h.secs();
    let seq1 = finalize_seq(&h.say_a_turn()).unwrap();
    let t2 = h.secs();
    h.vad(0.9, 10);
    h.m.on_mute(true, h.now);
    h.muted_audio(10);
    h.m.on_mute(false, h.now);
    // 2 s of speech after the unmute, all before the first turn's (slow)
    // ack: none of it may fall between the turns.
    let t3 = h.secs();
    h.vad(0.9, 62);
    let late = h.secs();
    h.words(true, &[("first", t1 + 0.1), ("second", t2 + 0.1), ("third", t3 + 0.1), ("words", t3 + 1.0), ("more", late - 0.2)]);
    let a = h.finalized(seq1);
    assert_eq!(turn(&a), Some(("t1".into(), "first".into())));
    let seq2 = finalize_seq(&a).expect("the cut run ends at once");
    let a = h.finalized(seq2);
    assert_eq!(turn(&a), Some(("t2".into(), "second".into())));
    assert_eq!(h.state(), SessionState::UserSpeaking);
    let seq3 = finalize_seq(&h.vad(0.1, 22)).expect("the run after the unmute ends at its pause");
    assert_eq!(turn(&h.finalized(seq3)), Some(("t3".into(), "third words more".into())));

    // Muted again before the ack: that run is cut too, and sent in turn.
    let mut h = H::conv();
    let seq1 = finalize_seq(&h.say_a_turn()).unwrap();
    let t2 = h.secs();
    h.vad(0.9, 10);
    h.m.on_mute(true, h.now);
    h.muted_audio(10);
    h.m.on_mute(false, h.now);
    let t3 = h.secs();
    h.vad(0.9, 20);
    h.m.on_mute(true, h.now);
    h.muted_audio(10);
    h.m.on_mute(false, h.now);
    // Too short a third run is dropped by its pause.
    h.vad(0.9, 4);
    h.vad(0.1, 22);
    h.words(true, &[("second", t2 + 0.1), ("third", t3 + 0.1)]);
    let seq2 = finalize_seq(&h.finalized(seq1)).unwrap();
    let a = h.finalized(seq2);
    assert_eq!(turn(&a), Some(("t2".into(), "second".into())));
    let seq3 = finalize_seq(&a).expect("the second cut run ends at once");
    assert_eq!(turn(&h.finalized(seq3)), Some(("t3".into(), "third".into())));
    assert_eq!(h.state(), SessionState::Listening);
}

#[test]
fn a_barge_in_after_an_unmute_follows_the_cut_run() {
    // The agent speaks over the turns queued at a mute (headphones), and the
    // user, unmuted, talks over it: the barge-in's run is the next one.
    let mut h = H::conv_with(DEFAULT_END_SILENCE_MS, true, EchoMode::Headphones);
    let seq1 = finalize_seq(&h.say_a_turn()).unwrap();
    h.vad(0.9, 10);
    h.m.on_mute(true, h.now);
    h.muted_audio(10);
    h.m.on_mute(false, h.now);
    h.speaking(true);
    let t3 = h.secs();
    assert_eq!(interrupted(&h.m.on_barge_in(h.at, h.now)), Some("t3".into()));
    h.vad(0.9, 10);
    h.speaking(false);
    h.words(true, &[("over", t3 + 0.1)]);
    let seq2 = finalize_seq(&h.finalized(seq1)).unwrap();
    h.finalized(seq2);
    let seq3 = finalize_seq(&h.vad(0.1, 22)).unwrap();
    assert_eq!(turn(&h.finalized(seq3)), Some(("t3".into(), "over".into())));
}

#[test]
fn mute_then_unmute_then_a_new_turn_works() {
    let mut h = H::conv();
    let t = h.secs();
    h.vad(0.9, 10);
    let seq1 = finalize_seq(&h.m.on_mute(true, h.now)).unwrap();
    h.muted_audio(30);
    h.words(true, &[("one", t + 0.1)]);
    assert_eq!(turn(&h.finalized(seq1)), Some(("t1".into(), "one".into())));
    assert_eq!(states(&h.m.on_mute(false, h.now)), vec![SessionState::Listening]);
    let t2 = h.secs();
    let a = h.say_a_turn();
    assert_eq!(states(&a), vec![SessionState::UserSpeaking, SessionState::Processing]);
    let seq2 = finalize_seq(&a).unwrap();
    assert!(seq2 > seq1);
    h.words(true, &[("two", t2 + 0.1)]);
    assert_eq!(turn(&h.finalized(seq2)), Some(("t2".into(), "two".into())));

    // Unmuted before the ack: a new run queues behind the cut turn as usual.
    let mut h = H::conv();
    let t = h.secs();
    h.vad(0.9, 10);
    let seq1 = finalize_seq(&h.m.on_mute(true, h.now)).unwrap();
    h.muted_audio(30);
    h.m.on_mute(false, h.now);
    let t2 = h.secs();
    h.vad(0.9, 10);
    h.words(true, &[("one", t + 0.1), ("two", t2 + 0.1)]);
    let a = h.finalized(seq1);
    assert_eq!(turn(&a), Some(("t1".into(), "one".into())));
    assert_eq!(h.state(), SessionState::UserSpeaking);
    let seq2 = finalize_seq(&h.vad(0.1, 22)).unwrap();
    assert_eq!(turn(&h.finalized(seq2)), Some(("t2".into(), "two".into())));
}

#[test]
fn mute_during_processing_still_sends_the_turn() {
    let mut h = H::conv();
    let t = h.secs();
    let a = h.say_a_turn();
    let seq = finalize_seq(&a).unwrap();
    h.words(true, &[("done", t + 0.1)]);
    assert_eq!(states(&h.m.on_mute(true, h.now)), vec![SessionState::Muted]);
    let a = h.finalized(seq);
    assert_eq!(turn(&a), Some(("t1".into(), "done".into())));
    assert!(states(&a).is_empty(), "still muted");
    assert_eq!(states(&h.m.on_mute(false, h.now)), vec![SessionState::Listening]);
}

// ─── idle ───────────────────────────────────────────────────────────────────

const IDLE: u64 = 5 * 60 * 1000;

#[test]
fn five_minutes_idle_in_listening_ends_the_session() {
    let mut h = H::conv();
    assert!(ended(&h.wait(IDLE - 1)).is_none());
    assert_eq!(ended(&h.wait(1)), Some((EndReason::Idle, None, None)));
    assert!(h.m.ended());
    assert!(h.wait(1).is_empty(), "nothing after the end");
}

#[test]
fn speech_resets_the_idle_timer() {
    let mut h = H::conv();
    h.wait(IDLE - 1_000);
    h.vad(0.9, 3);
    h.vad(0.1, 22); // a blip: back to listening, timer restarted
    assert!(ended(&h.wait(IDLE - 2_000)).is_none());
    assert!(ended(&h.wait(2_000)).is_some());
}

#[test]
fn a_pending_reply_holds_the_idle_clock_but_not_for_ever() {
    // D1-7: a turn was sent and the agent is working on it (tools, no speech
    // yet). That's not the user being idle.
    let cfg = TurnConfig::new(Mode::Conversation, 700, true);
    let wait = cfg.reply_wait_ms;
    assert!(wait < IDLE);
    let mut h = H::conv();
    let seq = finalize_seq(&h.say_a_turn()).unwrap();
    h.words(true, &[("research", h.secs() - 1.0)]);
    assert!(turn(&h.finalized(seq)).is_some());
    assert_eq!(h.state(), SessionState::Listening);
    assert!(ended(&h.wait(wait - 1)).is_none());
    // The reply is never spoken: after the wait, idle counts as usual.
    assert!(ended(&h.wait(IDLE)).is_none());
    assert_eq!(ended(&h.wait(1)).map(|e| e.0), Some(EndReason::Idle));

    // The reply spoken within the wait: idle counts from when it ends.
    let mut h = H::conv();
    let seq = finalize_seq(&h.say_a_turn()).unwrap();
    h.words(true, &[("plan", h.secs() - 1.0)]);
    h.finalized(seq);
    h.wait(wait - 10_000);
    h.speaking(true);
    h.wait(20_000);
    h.speaking(false);
    h.wait(300); // the agent-quiet grace
    assert!(ended(&h.wait(IDLE - 1)).is_none());
    assert!(ended(&h.wait(1)).is_some());
}

#[test]
fn no_idle_end_while_muted_or_while_the_agent_speaks() {
    let mut h = H::conv();
    h.m.on_mute(true, h.now);
    assert!(ended(&h.wait(IDLE * 2)).is_none());
    h.m.on_mute(false, h.now);
    h.speaking(true);
    assert!(ended(&h.wait(IDLE * 2)).is_none());
    h.speaking(false);
    h.wait(300);
    assert!(ended(&h.wait(IDLE - 1)).is_none());
    assert!(ended(&h.wait(1)).is_some());
}

// ─── stop, cancel, errors ───────────────────────────────────────────────────

#[test]
fn conversation_stop_and_cancel_end_without_text() {
    let mut h = H::conv();
    h.vad(0.9, 10);
    assert_eq!(ended(&h.m.stop(h.now)), Some((EndReason::Stopped, None, None)));
    assert!(h.m.stop(h.now).is_empty());
    let mut h = H::conv();
    assert_eq!(ended(&h.m.cancel()), Some((EndReason::Cancelled, None, None)));
    let mut h = H::conv();
    assert_eq!(ended(&h.m.end_with(EndReason::Page, None)), Some((EndReason::Page, None, None)));
}

#[test]
fn transcription_failure_ends_with_an_error() {
    let mut h = H::conv();
    let a = h.m.on_stt(VoiceSttEvent::Failed { reason: "engine exited".into() }, h.now);
    assert_eq!(ended(&a), Some((EndReason::Error, None, Some("engine exited".into()))));
    let mut h = H::conv();
    assert_eq!(ended(&h.m.on_stt(VoiceSttEvent::Finished, h.now)).unwrap().0, EndReason::Error);
}

// ─── dictation ──────────────────────────────────────────────────────────────

#[test]
fn dictation_streams_the_whole_text_and_never_makes_turns() {
    let mut h = H::dictation();
    let t = h.secs();
    h.vad(0.9, 10);
    let a = h.words(false, &[("dear", t + 0.1)]);
    assert_eq!(transcripts(&a), vec![(DICTATION_TURN_ID.into(), "dear".into(), false)]);
    h.words(true, &[("Dear", t + 0.1), ("team,", t + 0.3)]);
    let a = h.vad(0.1, 30);
    assert_eq!(finalize_seq(&a), None, "no end of turn");
    assert_eq!(states(&a), vec![SessionState::Listening]);
    let t2 = h.secs();
    h.vad(0.9, 10);
    let a = h.words(false, &[("thanks", t2 + 0.1)]);
    assert_eq!(transcripts(&a), vec![(DICTATION_TURN_ID.into(), "Dear team, thanks".into(), false)]);
    // TTS and barge-in don't apply.
    assert!(states(&h.speaking(true)).is_empty());
    assert!(interrupted(&h.m.on_barge_in(h.at, h.now)).is_none());
}

#[test]
fn dictation_stop_finalizes_then_ends_with_the_text() {
    let mut h = H::dictation();
    let t = h.secs();
    h.vad(0.9, 10);
    h.words(true, &[("Hello", t + 0.1)]);
    h.words(false, &[("wor", t + 0.4)]);
    let a = h.m.stop(h.now);
    let seq = finalize_seq(&a).unwrap();
    assert!(ended(&a).is_none());
    assert!(h.m.stop(h.now).is_empty(), "a second stop is a no-op");
    h.words(true, &[("world.", t + 0.4)]);
    let a = h.finalized(seq);
    assert_eq!(ended(&a), Some((EndReason::Stopped, Some("Hello world.".into()), None)));
}

#[test]
fn dictation_stop_timeout_keeps_the_interim_words() {
    let mut h = H::dictation();
    let t = h.secs();
    h.words(true, &[("Hello", t + 0.1)]);
    h.words(false, &[("there", t + 0.4)]);
    let seq = finalize_seq(&h.m.stop(h.now)).unwrap();
    h.wait(100);
    h.sent(seq);
    assert!(ended(&h.wait(1_499)).is_none());
    assert_eq!(ended(&h.wait(1)), Some((EndReason::Stopped, Some("Hello there".into()), None)));
}

#[test]
fn a_dictation_stop_always_ends_well_inside_the_webs_timeout() {
    // D1-5: the worst case. Stop before local-stt is ready; it gets ready
    // just before the ready wait runs out; the finalize reaches the engine
    // late and is never acked. The stop still ends by STOP_MAX_MS, a second
    // under the web's 5.5 s, with the words so far.
    let cfg = TurnConfig::new(Mode::Dictation, 700, true);
    assert!(cfg.stop_wait_ready_ms + cfg.finalize_timeout_ms <= cfg.stop_max_ms);
    assert!(cfg.stop_max_ms + 1_000 <= WEB_DICTATION_STOP_TIMEOUT_MS);
    let (mut h, _) = H::with(cfg, EchoMode::Converging);
    h.vad(0.9, 10);
    let stopped_at = h.now;
    h.m.stop(h.now);
    assert!(ended(&h.wait(2_900)).is_none());
    let seq = finalize_seq(&h.ready()).unwrap();
    h.words(false, &[("almost", 0.1)]);
    assert!(ended(&h.wait(1_000)).is_none());
    h.sent(seq);
    let mut end = None;
    for _ in 0..3_000 {
        if let Some(e) = ended(&h.wait(1)) {
            end = Some((h.now - stopped_at, e));
            break;
        }
    }
    let (ms, e) = end.expect("ended");
    assert_eq!(ms, STOP_MAX_MS);
    assert_eq!(e, (EndReason::Stopped, Some("almost".into()), None));
}

#[test]
fn dictation_stop_before_ready_waits_for_ready() {
    let (mut h, _) = H::with(TurnConfig::new(Mode::Dictation, 700, true), EchoMode::Converging);
    h.vad(0.9, 10);
    let a = h.m.stop(h.now);
    assert!(finalize_seq(&a).is_none() && ended(&a).is_none());
    h.wait(1_000);
    let a = h.ready();
    let seq = finalize_seq(&a).unwrap();
    h.words(true, &[("quick", 0.1)]);
    assert_eq!(ended(&h.finalized(seq)).unwrap().1, Some("quick".into()));
}

#[test]
fn dictation_stop_when_ready_never_comes_ends_after_the_wait() {
    let (mut h, _) = H::with(TurnConfig::new(Mode::Dictation, 700, true), EchoMode::Converging);
    h.m.stop(h.now);
    assert!(ended(&h.wait(2_999)).is_none());
    assert_eq!(ended(&h.wait(1)), Some((EndReason::Stopped, Some(String::new()), None)));
}

#[test]
fn a_dictation_replaced_by_another_panel_keeps_its_words() {
    // VL-5: dictation in one panel is finalizing (voice_stop sent) when
    // another panel of the same webview starts voice: it ends as stopped,
    // with its text, not cancelled.
    let mut h = H::dictation();
    let t = h.secs();
    h.words(true, &[("Ship", t + 0.1)]);
    h.words(false, &[("it", t + 0.3)]);
    h.m.stop(h.now);
    let a = h.m.replaced();
    assert_eq!(ended(&a), Some((EndReason::Stopped, Some("Ship it".into()), None)));
    // Not even stopping yet: the same.
    let mut h = H::dictation();
    h.words(true, &[("draft", 0.1)]);
    assert_eq!(ended(&h.m.replaced()), Some((EndReason::Stopped, Some("draft".into()), None)));
    // A conversation is cancelled.
    let mut h = H::conv();
    assert_eq!(ended(&h.m.replaced()), Some((EndReason::Cancelled, None, None)));
    assert!(h.m.replaced().is_empty());
}

#[test]
fn dictation_cancel_has_no_text() {
    let mut h = H::dictation();
    h.words(true, &[("private", 0.1)]);
    assert_eq!(ended(&h.m.cancel()), Some((EndReason::Cancelled, None, None)));
}

#[test]
fn dictation_idles_out_too() {
    let mut h = H::dictation();
    assert!(ended(&h.wait(IDLE)).is_some_and(|e| e.0 == EndReason::Idle));
}

#[test]
fn old_unclaimed_words_are_forgotten_in_conversation_but_not_in_dictation() {
    let mut h = H::conv();
    h.words(true, &[("ancient", 0.1)]);
    h.vad(0.1, 1_000); // 32 s of nobody talking
    let t = h.secs();
    h.vad(0.9, 10);
    h.words(true, &[("fresh", t + 0.1)]);
    let a = h.vad(0.1, 22);
    assert_eq!(turn(&h.finalized(finalize_seq(&a).unwrap())).unwrap().1, "fresh");

    let mut h = H::dictation();
    h.words(true, &[("ancient", 0.1)]);
    h.vad(0.1, 1_000);
    let a = h.m.stop(h.now);
    assert_eq!(ended(&h.finalized(finalize_seq(&a).unwrap())).unwrap().1, Some("ancient".into()));
}

// ─── the noisy room's level gate (noise design §2.1, §2.3, §2.4) ────────────

/// The room's floor in these tests (dBFS).
const FLOOR: f32 = -70.0;
/// The user's frames, and a TV's: loud enough for the VAD, far below the
/// user (the bootstrap S is −32: sustain-near needs −45, onset −40).
const NEAR: f32 = -25.0;
const FAR: f32 = -50.0;

/// The noisy room with its gate pinned to the values these tests were written
/// for (they test the mechanisms, not the preset's tuning, which moves with
/// the replay harness).
fn gate_test_tuning() -> Tuning {
    let mut t = Tuning::NOISY;
    let g = t.gate.as_mut().unwrap();
    g.sustain_below_speech_db = 13.0;
    g.confirm_frames = 2;
    g.confirm_window = 3;
    g.smooth_frames = 4;
    g.fast_attack = false;
    g.speech_down_within_db = 8.0;
    t.word_filter.as_mut().unwrap().below_speech_db = 11.0;
    t
}

impl H {
    fn noisy() -> H {
        let cfg = TurnConfig::for_tuning(Mode::Conversation, DEFAULT_END_SILENCE_MS, true, &gate_test_tuning());
        let (mut h, _) = Self::with(cfg, EchoMode::Converging);
        h.ready();
        h
    }

    /// `n` VAD frames at `prob` and `level` dBFS.
    fn lvad(&mut self, prob: f32, level: f32, n: usize) -> Vec<Action> {
        let mut out = Vec::new();
        for _ in 0..n {
            self.now += F_MS;
            out.extend(self.m.on_vad_level(prob, self.at, self.at + F, level, FLOOR, self.now));
            self.at += F;
        }
        out
    }
}

#[test]
fn the_quiet_room_ignores_levels() {
    let mut a = H::conv();
    let mut b = H::conv();
    for (p, n) in [(0.9, 20), (0.1, 22), (0.6, 3), (0.3, 30)] {
        let x = a.vad(p, n);
        let mut y = Vec::new();
        for _ in 0..n {
            b.now += F_MS;
            y.extend(b.m.on_vad_level(p, b.at, b.at + F, -100.0, 0.0, b.now));
            b.at += F;
        }
        assert_eq!(x, y);
    }
    assert_eq!(a.m.speech_level(), None);
}

#[test]
fn far_speech_never_starts_a_turn() {
    let mut h = H::noisy();
    let a = h.lvad(0.95, FAR, 200);
    assert!(states(&a).is_empty(), "{a:?}");
    assert_eq!(h.state(), SessionState::Listening);
    // The user, near: two onset frames of three confirm it.
    let a = h.lvad(0.95, NEAR, 1);
    assert!(states(&a).is_empty());
    let a = h.lvad(0.95, NEAR, 1);
    assert_eq!(states(&a), vec![SessionState::UserSpeaking]);
}

#[test]
fn a_confirmed_onset_reaches_back_over_a_soft_first_word() {
    let mut h = H::noisy();
    h.lvad(0.05, -72.0, 30);
    // 384 ms of soft speech (near enough to hold a turn, not to start one),
    // then the user at full level.
    let soft = h.secs();
    h.lvad(0.5, -42.0, 12);
    let loud = h.secs();
    h.lvad(0.95, NEAR, 20);
    let a = h.lvad(0.05, -72.0, 22);
    let seq = finalize_seq(&a).expect("the turn ended");
    // A word at the soft start: before the loud onset's slack, but inside
    // the backdated run.
    assert!(soft + 0.01 < loud - 0.2);
    h.words(true, &[("so", soft + 0.01), ("then", loud + 0.1)]);
    let a = h.finalized(seq);
    assert_eq!(turn(&a), Some(("t1".into(), "so then".into())));
}

#[test]
fn far_speech_is_silence_and_ends_the_turn() {
    let mut h = H::noisy();
    h.lvad(0.95, NEAR, 20);
    assert_eq!(h.state(), SessionState::UserSpeaking);
    // The TV goes on: the turn still ends one hangover later (plus the
    // smoothed level's lag: the first far frames still average near).
    let a = h.lvad(0.95, FAR, 21);
    assert!(finalize_seq(&a).is_none());
    let a = h.lvad(0.95, FAR, 4);
    assert!(finalize_seq(&a).is_some());
    assert_eq!(h.state(), SessionState::Processing);
}

#[test]
fn soft_speech_holds_a_turn_without_restarting_it() {
    let mut h = H::noisy();
    h.lvad(0.95, NEAR, 20);
    // A silence starts, soft speech holds it where it is, then it runs out.
    h.lvad(0.05, -72.0, 10);
    let a = h.lvad(0.9, -42.0, 30);
    assert!(finalize_seq(&a).is_none(), "soft speech doesn't end the turn");
    // (Its first two frames still read far: the gate's level is smoothed.)
    let a = h.lvad(0.05, -72.0, 9);
    assert!(finalize_seq(&a).is_none(), "nor does it restart the silence");
    let a = h.lvad(0.05, -72.0, 1);
    assert!(finalize_seq(&a).is_some(), "10 + 2 + 10 silent frames: the hangover");
}

#[test]
fn a_run_is_capped_at_30_seconds() {
    let mut h = H::noisy();
    let frames = (30_000 / F_MS) as usize;
    let a = h.lvad(0.95, NEAR, frames - 1);
    assert!(finalize_seq(&a).is_none());
    let a = h.lvad(0.95, NEAR, 4);
    assert!(finalize_seq(&a).is_some(), "30 s of speech that never pauses");
    // The quiet room has no cap.
    let mut q = H::conv();
    let a = q.vad(0.95, frames + 100);
    assert!(finalize_seq(&a).is_none());
}

#[test]
fn the_word_filter_drops_words_no_near_frame_vouches_for() {
    let mut h = H::noisy();
    h.lvad(0.05, -72.0, 30);
    let start = h.secs();
    h.lvad(0.95, NEAR, 25);
    let tv = h.secs() + 0.3;
    let a = h.lvad(0.95, FAR, 26);
    let seq = finalize_seq(&a).expect("the turn ended");
    h.words(true, &[("hello", start + 0.1), ("there", start + 0.5), ("breaking", tv), ("news", tv + 0.2)]);
    let a = h.finalized(seq);
    assert_eq!(turn(&a), Some(("t1".into(), "hello there".into())));
    // A turn with nothing near in it is no turn.
    h.lvad(0.05, -72.0, 30);
    h.lvad(0.95, NEAR, 20);
    let tv = h.secs() + 0.4;
    let a = h.lvad(0.95, FAR, 26);
    let seq = finalize_seq(&a).expect("the second turn ended");
    h.words(true, &[("weather", tv), ("today", tv + 0.2)]);
    let a = h.finalized(seq);
    assert_eq!(turn(&a), None);
}

#[test]
fn mute_mid_turn_in_the_noisy_room_keeps_the_word_filter() {
    let mut h = H::noisy();
    h.lvad(0.05, -72.0, 30);
    let start = h.secs();
    h.lvad(0.95, NEAR, 20);
    // The TV while the user reaches for mute (not long enough to end the
    // turn).
    let tv = h.secs() + 0.2;
    h.lvad(0.95, FAR, 10);
    assert_eq!(h.state(), SessionState::UserSpeaking);
    let a = h.m.on_mute(true, h.now);
    let seq = finalize_seq(&a).expect("sent at the mute");
    assert_eq!(states(&a), vec![SessionState::Muted]);
    h.muted_audio(20);
    h.words(true, &[("hello", start + 0.1), ("there", start + 0.5), ("breaking", tv), ("news", tv + 0.1)]);
    let a = h.finalized(seq);
    assert_eq!(turn(&a), Some(("t1".into(), "hello there".into())), "the TV's words are filtered as usual");
    // Nothing near left after the filter: nothing is sent.
    h.m.on_mute(false, h.now);
    h.lvad(0.05, -72.0, 30);
    h.lvad(0.95, NEAR, 20);
    let tv = h.secs() + 0.2;
    h.lvad(0.95, FAR, 10);
    let seq = finalize_seq(&h.m.on_mute(true, h.now)).unwrap();
    h.words(true, &[("weather", tv), ("today", tv + 0.1)]);
    assert_eq!(turn(&h.finalized(seq)), None);
}

#[test]
fn mute_in_the_noisy_room_counts_only_near_speech() {
    // Mostly the TV: only the near frames (and the smoothed level's lag)
    // count toward min speech (400 ms), so this run is dropped.
    let mut h = H::noisy();
    h.lvad(0.05, -72.0, 30);
    h.lvad(0.95, NEAR, 4);
    h.lvad(0.95, FAR, 16);
    assert_eq!(h.state(), SessionState::UserSpeaking);
    let a = h.m.on_mute(true, h.now);
    assert_eq!(finalize_seq(&a), None);
    assert_eq!(states(&a), vec![SessionState::Muted]);
    // As many frames all near: a turn.
    let mut h = H::noisy();
    h.lvad(0.05, -72.0, 30);
    h.lvad(0.95, NEAR, 20);
    assert!(finalize_seq(&h.m.on_mute(true, h.now)).is_some());
}

#[test]
fn speech_after_an_unmute_while_a_cut_run_waits_is_the_next_turn_in_the_noisy_room() {
    let mut h = H::noisy();
    h.lvad(0.05, -72.0, 30);
    let t1 = h.secs();
    h.lvad(0.95, NEAR, 20);
    let seq1 = finalize_seq(&h.lvad(0.05, -72.0, 24)).expect("the first turn ended");
    let t2 = h.secs();
    h.lvad(0.95, NEAR, 20);
    h.m.on_mute(true, h.now);
    h.muted_audio(10);
    h.m.on_mute(false, h.now);
    let t3 = h.secs();
    h.lvad(0.95, NEAR, 62);
    h.words(true, &[("first", t1 + 0.1), ("second", t2 + 0.1), ("third", t3 + 0.1), ("words", t3 + 1.5)]);
    let a = h.finalized(seq1);
    assert_eq!(turn(&a), Some(("t1".into(), "first".into())));
    let seq2 = finalize_seq(&a).unwrap();
    assert_eq!(turn(&h.finalized(seq2)), Some(("t2".into(), "second".into())));
    assert_eq!(h.state(), SessionState::UserSpeaking);
    let seq3 = finalize_seq(&h.lvad(0.05, -72.0, 24)).unwrap();
    assert_eq!(turn(&h.finalized(seq3)), Some(("t3".into(), "third words".into())));
}

#[test]
fn a_sent_turn_measures_the_speech_level() {
    let mut h = H::noisy();
    assert_eq!(h.m.speech_level(), Some((-32.0, false)));
    let start = h.secs();
    h.lvad(0.95, -20.0, 25);
    let a = h.lvad(0.05, -72.0, 22);
    let seq = finalize_seq(&a).unwrap();
    // No words: nothing is sent and nothing is measured.
    h.finalized(seq);
    assert_eq!(h.m.speech_level(), Some((-32.0, false)));
    h.lvad(0.95, -20.0, 25);
    let a = h.lvad(0.05, -72.0, 22);
    let seq = finalize_seq(&a).unwrap();
    h.words(true, &[("hi", start + 2.5)]);
    h.words(true, &[("again", h.secs() - 1.2)]);
    assert!(turn(&h.finalized(seq)).is_some());
    // −32 + min(0.8 × 12, 10) = −22.4.
    let (s, measured) = h.m.speech_level().unwrap();
    assert!(measured);
    assert_eq!(h.m.measured_turns(), 1, "the turn without words measured nothing");
    assert!((s + 22.4).abs() < 0.01, "{s}");
}

#[test]
fn a_barge_in_reaches_back_over_the_words_before_it() {
    let (mut h, _) =
        H::with(TurnConfig::for_profile(Mode::Conversation, DEFAULT_END_SILENCE_MS, true, NoiseProfile::Noisy), EchoMode::Cancelling);
    h.ready();
    h.speaking(true);
    assert_eq!(h.state(), SessionState::AgentSpeaking);
    h.lvad(0.05, -72.0, 10);
    // "Wait", a pause, then the part the DSP thread's detector fired on.
    let wait = h.secs();
    h.lvad(0.6, NEAR, 8);
    h.lvad(0.05, -72.0, 10);
    let onset = h.at;
    h.lvad(0.95, NEAR, 12);
    h.speaking(false);
    let a = h.m.on_barge_in(onset, h.now);
    assert_eq!(interrupted(&a), Some("t1".into()));
    let a = h.lvad(0.05, -72.0, 26);
    let seq = finalize_seq(&a).expect("the turn ended");
    h.words(true, &[("wait", wait + 0.05), ("stop", onset as f64 / 16_000.0 + 0.1)]);
    assert_eq!(turn(&h.finalized(seq)), Some(("t1".into(), "wait stop".into())));
}

/// A remembered level (the web's per-device hint) replaces the bootstrap and
/// counts as measured; the quiet room ignores it.
#[test]
fn a_speech_hint_starts_the_gate_at_the_users_level() {
    let cfg = TurnConfig::for_profile(Mode::Conversation, DEFAULT_END_SILENCE_MS, true, NoiseProfile::Noisy);
    let m = Machine::new(cfg.clone(), EchoMode::Converging).with_speech_hint(Some(-24.0));
    assert_eq!(m.speech_level(), Some((-24.0, true)));
    let m = Machine::new(cfg.clone(), EchoMode::Converging).with_speech_hint(Some(0.0));
    assert_eq!(m.speech_level(), Some((-10.0, true)), "clamped");
    let m = Machine::new(cfg.clone(), EchoMode::Converging).with_speech_hint(None);
    assert_eq!(m.speech_level(), Some((-32.0, false)));
    let q = Machine::new(TurnConfig::new(Mode::Conversation, DEFAULT_END_SILENCE_MS, true), EchoMode::Converging);
    assert_eq!(q.with_speech_hint(Some(-24.0)).speech_level(), None);
}

impl H {
    /// The noisy room with `tuning`, starting from a measured S of `speech`.
    fn noisy_at(tuning: &Tuning, speech: f32) -> H {
        let cfg = TurnConfig::for_tuning(Mode::Conversation, DEFAULT_END_SILENCE_MS, true, tuning);
        let mut m = Machine::new(cfg, EchoMode::Converging).with_speech_hint(Some(speech));
        m.start(0);
        let mut h = H { m, now: 0, at: 0 };
        h.ready();
        h
    }

    /// A quiet second, then the user at `level` for 800 ms and the pause
    /// that ends it: whether a turn was sent.
    fn gated_turn(&mut self, level: f32) -> bool {
        self.lvad(0.05, -72.0, 30);
        let start = self.secs();
        self.lvad(0.95, level, 25);
        let a = self.lvad(0.05, -72.0, 26);
        let Some(seq) = finalize_seq(&a) else { return false };
        self.words(true, &[("hello", start + 0.1), ("there", start + 0.5)]);
        turn(&self.finalized(seq)).is_some()
    }
}

/// One loud turn (or a TV turn before the user spoke) left S 6 dB over the
/// user's usual level: their turns, all that far under it, still bring it
/// back: the first counts as the room, then each one moves S down a slow
/// step until it is within reach and follows as usual.
#[test]
fn a_speech_level_left_too_high_comes_back_down_with_the_users_turns() {
    let mut t = gate_test_tuning();
    t.gate.as_mut().unwrap().speech_down_within_db = 3.0;
    let mut h = H::noisy_at(&t, -16.0);
    let mut levels = Vec::new();
    for _ in 0..5 {
        assert!(h.gated_turn(-22.0), "the user's turn at the onset margin gets through");
        levels.push(h.m.speech_level().unwrap().0);
    }
    assert_eq!(levels[..4], [-16.0, -17.5, -19.0, -20.5]);
    assert!((levels[4] + 21.7).abs() < 1e-3, "{levels:?}");
}

/// Loud turns lifted S so far that the user's turns no longer get through at
/// all: two seconds of their speech the gate turned away (but S before the
/// lift would have heard) step it 3 dB back down, never below that level.
/// Speech further down (a TV) never does, nor anything without a lift.
#[test]
fn a_lifted_speech_level_relaxes_back_on_speech_it_turns_away() {
    let t = gate_test_tuning();
    let mut h = H::noisy();
    h.m = Machine::new(TurnConfig::for_tuning(Mode::Conversation, DEFAULT_END_SILENCE_MS, true, &t), EchoMode::Converging)
        .with_lifted_speech(-12.0, -22.0);
    h.m.start(h.now);
    h.ready();
    let two_s = 2_000usize.div_ceil(F_MS as usize);
    h.lvad(0.95, -24.0, two_s - 1);
    assert_eq!(h.m.speech_level(), Some((-12.0, true)));
    assert_eq!(h.state(), SessionState::Listening);
    h.lvad(0.95, -24.0, 1);
    assert_eq!(h.m.speech_level(), Some((-15.0, true)));
    h.lvad(0.95, -24.0, two_s);
    assert_eq!(h.m.speech_level(), Some((-18.0, true)));
    // Now within the onset margin: the user gets a turn.
    h.lvad(0.95, -24.0, 2);
    assert_eq!(h.state(), SessionState::UserSpeaking);

    // A TV further down than the level before the lift would have heard.
    let mut tv = H::noisy();
    tv.m = Machine::new(TurnConfig::for_tuning(Mode::Conversation, DEFAULT_END_SILENCE_MS, true, &t), EchoMode::Converging)
        .with_lifted_speech(-12.0, -22.0);
    tv.m.start(tv.now);
    tv.ready();
    tv.lvad(0.95, -30.0, 10 * two_s);
    assert_eq!(tv.m.speech_level(), Some((-12.0, true)));
    // No lift (a level the user's own turns set, here a remembered one a
    // turn within reach confirmed): nothing relaxes.
    let mut set = H::noisy_at(&t, -12.0);
    assert!(set.gated_turn(-12.0));
    let (s, _) = set.m.speech_level().unwrap();
    set.lvad(0.95, -24.0, 10 * two_s);
    assert_eq!(set.m.speech_level(), Some((s, true)));
    // Never below the level before the lift.
    let mut low = H::noisy();
    low.m = Machine::new(TurnConfig::for_tuning(Mode::Conversation, DEFAULT_END_SILENCE_MS, true, &t), EchoMode::Converging)
        .with_lifted_speech(-12.0, -14.0);
    low.m.start(low.now);
    low.ready();
    low.lvad(0.95, -19.5, 3 * two_s);
    assert_eq!(low.m.speech_level(), Some((-14.0, true)));
}

/// A remembered level too high for the user (the first session was a TV's,
/// or a louder talker's, or the user was closer to the mic that day) can't
/// shut them out for good: nothing this session measured lifted it, so the
/// relax rule takes it back down to the bootstrap on the speech it turns
/// away, where S is unmeasured again and the user's first turn measures
/// them, as on a cold start. Both ways a remembered level arrives (at the
/// start, and after a mic swap) behave the same. Speech the bootstrap
/// wouldn't hold a turn on never relaxes it, a remembered level at or under
/// the bootstrap has nothing to relax to, and without the relax rule the
/// user stays shut out (what this guards against).
#[test]
fn a_remembered_level_too_high_relaxes_back_to_the_bootstrap() {
    use crate::voice::trace::{feed, Input};
    let t = gate_test_tuning();
    let two_s = 2_000usize.div_ceil(F_MS as usize);
    let at_start = || H::noisy_at(&t, -20.0);
    let after_swap = || {
        let mut h = H::noisy_at(&t, -36.0);
        assert!(feed(&mut h.m, &Input::MicReplaced, h.now).is_empty());
        assert!(feed(&mut h.m, &Input::SpeechHint { db: -20.0 }, h.now).is_empty());
        h
    };
    for (how, mk) in [("at the start", &at_start as &dyn Fn() -> H), ("after a mic swap", &after_swap)] {
        let mut h = mk();
        assert_eq!(h.m.speech_level(), Some((-20.0, true)), "{how}");
        // The user at −38: under the remembered level's onset margin (−26),
        // within the bootstrap's (−40).
        assert!(!h.gated_turn(-38.0), "{how}: shut out at first");
        h.lvad(0.95, -38.0, two_s);
        assert_eq!(h.m.speech_level(), Some((-23.0, true)), "{how}");
        h.lvad(0.95, -38.0, 2 * two_s);
        assert_eq!(h.m.speech_level(), Some((-29.0, true)), "{how}");
        assert_eq!(h.state(), SessionState::Listening, "{how}");
        h.lvad(0.95, -38.0, two_s);
        assert_eq!(h.m.speech_level(), Some((-32.0, false)), "{how}: the cold start, unmeasured");
        h.lvad(0.95, -38.0, 2);
        assert_eq!(h.state(), SessionState::UserSpeaking, "{how}: the user gets a turn");
        let mut h2 = mk();
        h2.lvad(0.95, -38.0, 4 * two_s);
        h2.lvad(0.05, -72.0, 30);
        assert!(h2.gated_turn(-38.0), "{how}: after relaxing, a whole turn");
        let (s, measured) = h2.m.speech_level().unwrap();
        assert!(measured && s < -32.0, "{how}: measured at the user's level: {s}");
    }
    // Speech further down than the bootstrap would hold a turn on (−47, a
    // TV): stays.
    let mut tv = at_start();
    tv.lvad(0.95, -47.0, 10 * two_s);
    assert_eq!(tv.m.speech_level(), Some((-20.0, true)));
    // A remembered level at or under the bootstrap: no floor under it.
    let mut low = H::noisy_at(&t, -32.0);
    low.lvad(0.95, -40.0, 10 * two_s);
    assert_eq!(low.m.speech_level(), Some((-32.0, true)));
    // Without the relax rule, the user never gets a turn.
    let mut off = t;
    off.gate.as_mut().unwrap().relax_missed_ms = 0;
    let mut h = H::noisy_at(&off, -20.0);
    h.lvad(0.95, -38.0, 10 * two_s);
    assert_eq!((h.m.speech_level(), h.state()), (Some((-20.0, true)), SessionState::Listening));
}

/// The input device changed: S measured on the old one goes back to the
/// bootstrap, so a user much softer on the new mic still gets a turn. The
/// quiet room has no S to reset.
#[test]
fn a_mic_swap_puts_the_speech_level_back_to_the_bootstrap() {
    let mut h = H::noisy_at(&gate_test_tuning(), -20.0);
    // A headset had the user at −20; the built-in mic hears them at −35:
    // under a measured S's onset margin, so no turn.
    assert!(!h.gated_turn(-35.0));
    assert_eq!(h.state(), SessionState::Listening);
    let a = crate::voice::trace::feed(&mut h.m, &crate::voice::trace::Input::MicReplaced, h.now);
    assert!(a.is_empty(), "{a:?}");
    assert_eq!(h.m.speech_level(), Some((-32.0, false)));
    assert!(h.gated_turn(-35.0), "within the bootstrap's margin");
    let (s, measured) = h.m.speech_level().unwrap();
    assert!(measured && s < -32.0, "measured on the new mic: {s}");
    let mut q = H::conv();
    assert!(q.m.on_mic_replaced().is_empty());
    assert_eq!(q.m.speech_level(), None);
}

/// A mic swap to a mic with a remembered level (WP7): S goes back to the
/// bootstrap on the swap, then to that level, measured, once the session
/// knows the mic, so a talker far under the user (a TV at −36 dBFS) is
/// turned away from the first word, where the bootstrap would let it
/// through. A hint that isn't a number changes nothing; the quiet room has
/// no S to set.
#[test]
fn a_mic_swap_to_a_remembered_mic_starts_from_its_level() {
    use crate::voice::trace::{feed, Input};
    let swapped = |hint: Option<f32>| {
        let mut h = H::noisy_at(&gate_test_tuning(), -20.0);
        assert!(h.gated_turn(-20.0));
        assert_eq!(h.m.measured_turns(), 1);
        assert!(feed(&mut h.m, &Input::MicReplaced, h.now).is_empty());
        assert_eq!(h.m.speech_level(), Some((-32.0, false)));
        if let Some(db) = hint {
            let a = feed(&mut h.m, &Input::SpeechHint { db }, h.now);
            assert!(a.is_empty(), "{a:?}");
        }
        h
    };
    let mut known = swapped(Some(-24.0));
    assert_eq!(known.m.speech_level(), Some((-24.0, true)));
    assert!(!known.gated_turn(-36.0), "the far talker is turned away");
    assert_eq!(known.m.speech_level(), Some((-24.0, true)));
    assert!(known.gated_turn(-24.0), "the user gets through");
    assert_eq!(known.m.measured_turns(), 2);
    let mut cold = swapped(None);
    assert!(cold.gated_turn(-36.0), "the bootstrap lets it through");

    let mut h = swapped(Some(f32::NAN));
    assert_eq!(h.m.speech_level(), Some((-32.0, false)));
    h.m.on_speech_hint(-4.0);
    assert_eq!(h.m.speech_level(), Some((-10.0, true)), "clamped");
    let mut q = H::conv();
    assert!(q.m.on_speech_hint(-24.0).is_empty());
    assert_eq!((q.m.speech_level(), q.m.measured_turns()), (None, 0));
}

/// Without `hold_on_sustain`, sustain-near speech after a silence started
/// counts toward the end instead of holding it.
#[test]
fn without_hold_on_sustain_soft_speech_extends_the_silence() {
    let mut t = gate_test_tuning();
    t.gate.as_mut().unwrap().hold_on_sustain = false;
    let (mut h, _) = H::with(TurnConfig::for_tuning(Mode::Conversation, DEFAULT_END_SILENCE_MS, true, &t), EchoMode::Converging);
    h.ready();
    h.lvad(0.95, NEAR, 20);
    h.lvad(0.05, -72.0, 10);
    let a = h.lvad(0.9, -42.0, 30);
    assert!(finalize_seq(&a).is_some(), "soft speech no longer holds the turn open");
}

// ─── readiness (voice://state `ready`) ──────────────────────────────────────

/// The session's view: every input through `trace::feed`, then what
/// `voice://state` shows ([`ShownState`]), `ready` included, as the actor
/// does it.
struct Shown {
    m: Machine,
    shown: crate::voice::events::ShownState,
    now: u64,
    at: u64,
}

impl Shown {
    fn conv() -> Shown {
        let m = Machine::new(TurnConfig::new(Mode::Conversation, DEFAULT_END_SILENCE_MS, true), EchoMode::Converging);
        Shown { m, shown: Default::default(), now: 0, at: 0 }
    }

    fn feed(&mut self, input: crate::voice::trace::Input) -> Vec<(SessionState, EchoMode, bool)> {
        let actions = crate::voice::trace::feed(&mut self.m, &input, self.now);
        let ready = self.m.ready();
        let noise = self.m.noise_mode();
        let triple = |s: crate::voice::events::Shown| (s.state, s.echo, s.ready);
        let mut out: Vec<_> = actions
            .iter()
            .filter_map(|a| match a {
                Action::State { state, echo } => Some(triple(self.shown.state(*state, *echo, ready, noise))),
                _ => None,
            })
            .collect();
        if !actions.iter().any(|a| matches!(a, Action::End { .. })) {
            out.extend(self.shown.refresh(ready, noise).map(triple));
        }
        out
    }

    fn dsp_up(&mut self) -> Vec<(SessionState, EchoMode, bool)> {
        self.feed(crate::voice::trace::Input::Started { vad_frame: Some(F as usize), canceller: true })
    }

    fn stt_ready(&mut self) -> Vec<(SessionState, EchoMode, bool)> {
        self.feed(crate::voice::trace::Input::Stt(VoiceSttEvent::Ready))
    }

    fn vad(&mut self, prob: f32, n: usize) -> Vec<(SessionState, EchoMode, bool)> {
        let mut out = Vec::new();
        for _ in 0..n {
            self.now += F_MS;
            let (start, end) = (self.at, self.at + F);
            self.at = end;
            out.extend(self.feed(crate::voice::trace::Input::Vad { prob, start, end, level_db: -30.0, floor_db: -70.0 }));
        }
        out
    }
}

#[test]
fn ready_needs_both_local_stt_and_the_dsp() {
    use SessionState::*;
    let mut s = Shown::conv();
    assert_eq!(s.feed(crate::voice::trace::Input::Start), vec![(Starting, EchoMode::Converging, false)]);
    assert_eq!(s.dsp_up(), vec![], "the DSP alone is not ready");
    assert!(!s.m.ready());
    assert_eq!(s.stt_ready(), vec![(Listening, EchoMode::Converging, true)], "ready rides the state event");
    assert!(s.m.ready());
    assert_eq!(s.stt_ready(), vec![], "no repeat");

    // The other order: local-stt first (listening, not ready), then the DSP.
    let mut s = Shown::conv();
    s.feed(crate::voice::trace::Input::Start);
    assert_eq!(s.stt_ready(), vec![(Listening, EchoMode::Converging, false)]);
    assert_eq!(s.dsp_up(), vec![(Listening, EchoMode::Converging, true)], "the flip alone is a state event");
}

#[test]
fn ready_shows_through_mute() {
    use SessionState::*;
    let mut s = Shown::conv();
    s.feed(crate::voice::trace::Input::Start);
    s.dsp_up();
    assert_eq!(s.feed(crate::voice::trace::Input::Mute(true)), vec![(Muted, EchoMode::Converging, false)]);
    // The machine's state (muted) doesn't change: only the flip is shown.
    assert_eq!(s.stt_ready(), vec![(Muted, EchoMode::Converging, true)]);
    assert_eq!(s.feed(crate::voice::trace::Input::Mute(false)), vec![(Listening, EchoMode::Converging, true)]);
}

#[test]
fn speech_before_ready_shows_user_speaking_not_ready_then_the_flip() {
    use SessionState::*;
    let mut s = Shown::conv();
    s.feed(crate::voice::trace::Input::Start);
    s.dsp_up();
    // An onset while local-stt loads: user_speaking, but not ready (the web
    // must not play its start sounds yet).
    assert_eq!(s.vad(0.9, 10), vec![(UserSpeaking, EchoMode::Converging, false)]);
    // Ready arrives mid-run: the state holds, the flip is shown.
    assert_eq!(s.stt_ready(), vec![(UserSpeaking, EchoMode::Converging, true)]);
    assert_eq!(s.m.state(), UserSpeaking);
}

#[test]
fn no_ready_flip_is_shown_after_the_end() {
    let mut s = Shown::conv();
    s.feed(crate::voice::trace::Input::Start);
    s.stt_ready();
    // No VAD in conversation ends the session: nothing after the end.
    let out = s.feed(crate::voice::trace::Input::Started { vad_frame: None, canceller: false });
    assert_eq!(out, vec![]);
    assert!(s.m.ended());
}


// ─── Auto (noise design WP7) ────────────────────────────────────────────────

/// The level a mic remembers for the user in these tests (the NEAR speech's).
const KNOWN_S: f32 = -27.0;

fn noise_modes(actions: &[Action]) -> Vec<NoiseMode> {
    actions.iter().filter_map(|a| if let Action::NoiseMode { mode, .. } = a { Some(*mode) } else { None }).collect()
}

impl H {
    fn auto_with(mode: Mode, tuning: &Tuning) -> H {
        let cfg = TurnConfig::for_tuning(mode, DEFAULT_END_SILENCE_MS, true, tuning);
        let (mut h, _) = Self::with(cfg, EchoMode::Converging);
        h.ready();
        h
    }

    fn auto() -> H {
        Self::auto_with(Mode::Conversation, &Tuning::AUTO)
    }

    /// Auto with S known from the start (this mic's remembered level,
    /// [`KNOWN_S`]): far speech only counts once S is known.
    fn auto_known_with(mode: Mode, tuning: &Tuning) -> H {
        let cfg = TurnConfig::for_tuning(mode, DEFAULT_END_SILENCE_MS, true, tuning);
        let mut m = Machine::new(cfg, EchoMode::Converging).with_speech_hint(Some(KNOWN_S));
        m.start(0);
        let mut h = H { m, now: 0, at: 0 };
        h.ready();
        h
    }

    fn auto_known() -> H {
        Self::auto_known_with(Mode::Conversation, &Tuning::AUTO)
    }

    fn quiet_frames(&mut self, n: usize) -> Vec<Action> {
        self.lvad(0.05, -72.0, n)
    }
}

/// Auto starts as the quiet room, with the noisy room's gate judging every
/// frame, and nothing about it shows until it switches.
#[test]
fn auto_starts_as_the_quiet_room() {
    let h = H::auto();
    let q = TurnConfig::new(Mode::Conversation, DEFAULT_END_SILENCE_MS, true);
    let c = &h.m.cfg;
    assert_eq!((c.onset, c.off, c.min_speech_ms, c.onset_slack_ms), (q.onset, q.off, q.min_speech_ms, q.onset_slack_ms));
    assert_eq!((c.gate, c.word_filter, c.max_run_ms), (None, None, None));
    assert_eq!(c.profile, NoiseProfile::Auto);
    assert_eq!(h.m.noise_mode(), NoiseMode::Quiet);
    assert_eq!(h.m.speech_level(), Some((-32.0, false)), "S is kept from the start");
    assert_eq!(h.m.barge_level(), None, "the quiet room's barge-in while S is unknown");
    // The other presets' rooms.
    assert_eq!(H::conv().m.noise_mode(), NoiseMode::Quiet);
    assert_eq!(H::noisy().m.noise_mode(), NoiseMode::Noisy);
    assert_eq!(H::noisy().m.barge_level(), H::noisy().m.speech_level());
}

/// The user's own speech, soft edges included, is never background: Auto
/// acts exactly as the quiet room.
#[test]
fn the_users_own_speech_never_switches_auto() {
    let mut a = H::auto();
    let mut q = H::conv();
    let mut script: Vec<(f32, f32, usize)> = Vec::new();
    for _ in 0..12 {
        // A turn, its soft tail (well under S, still speech), the pause.
        script.extend([(0.95, NEAR, 25), (0.9, -46.0, 12), (0.05, -72.0, 40)]);
    }
    for (p, l, n) in script {
        let x = a.lvad(p, l, n);
        let y = q.lvad(p, l, n);
        assert_eq!(x, y);
    }
    assert_eq!(a.m.noise_mode(), NoiseMode::Quiet);
}

/// With S known (this mic's remembered level), voices well under the user
/// (a TV) switch Auto to the noisy room within about a second of them; the
/// quiet room's run the TV opened is dropped,
/// and from then on the TV starts nothing while the user still does.
#[test]
fn background_voices_switch_auto_to_the_noisy_room() {
    let mut h = H::auto_known();
    h.quiet_frames(30);
    let mut all = Vec::new();
    for _ in 0..60 {
        all.extend(h.lvad(0.95, FAR, 1));
        if !noise_modes(&all).is_empty() {
            break;
        }
    }
    assert_eq!(noise_modes(&all), vec![NoiseMode::Noisy], "{all:?}");
    let reason = all.iter().find_map(|a| if let Action::NoiseMode { reason, .. } = a { Some(reason.clone()) } else { None });
    assert!(reason.unwrap().starts_with("far speech "));
    assert!(h.secs() < 30.0 * 0.032 + 1.3, "switched after {:.2} s", h.secs());
    assert_eq!(states(&all), vec![SessionState::UserSpeaking, SessionState::Listening], "the TV's run is dropped");
    assert!(finalize_seq(&all).is_none());
    assert_eq!(h.m.noise_mode(), NoiseMode::Noisy);
    assert!(h.m.cfg.gate.is_some() && h.m.cfg.word_filter.is_some());
    assert_eq!(h.m.cfg.onset, Tuning::NOISY.turn.onset);
    assert_eq!(h.m.barge_level(), h.m.speech_level(), "the noisy room's barge-in");
    // The TV goes on: nothing.
    let a = h.lvad(0.95, FAR, 200);
    assert!(states(&a).is_empty() && noise_modes(&a).is_empty(), "{a:?}");
    // The user: a turn, with only their words.
    let start = h.secs();
    h.lvad(0.95, NEAR, 25);
    let tv = h.secs() + 0.3;
    let a = h.lvad(0.95, FAR, 30);
    let seq = finalize_seq(&a).expect("the user's turn ended");
    h.words(true, &[("hello", start + 0.1), ("there", start + 0.5), ("breaking", tv), ("news", tv + 0.2)]);
    assert_eq!(turn(&h.finalized(seq)), Some(("t2".into(), "hello there".into())));
}

/// A switch decided while the user holds the floor waits for their turn to
/// be sent: it never lands inside it.
#[test]
fn an_auto_switch_never_lands_inside_the_users_turn() {
    let mut h = H::auto_known();
    h.quiet_frames(30);
    let start = h.secs();
    h.lvad(0.95, NEAR, 20);
    assert_eq!(h.state(), SessionState::UserSpeaking);
    // The TV over the user's pause (the quiet room: soft speech holds it).
    let a = h.lvad(0.6, FAR, 80);
    assert!(noise_modes(&a).is_empty(), "not inside the user's run: {a:?}");
    let a = h.quiet_frames(25);
    let seq = finalize_seq(&a).expect("the turn ended at its pause");
    h.words(true, &[("hello", start + 0.1)]);
    let a = h.finalized(seq);
    assert_eq!(turn(&a), Some(("t1".into(), "hello".into())), "sent as the quiet room would");
    let a = h.quiet_frames(1);
    assert_eq!(noise_modes(&a), vec![NoiseMode::Noisy], "then it lands");
}

/// While the agent is audible on speakers its echo can read as soft speech:
/// it never counts. On headphones (no echo path) the TV does.
#[test]
fn auto_ignores_speech_under_the_agent_unless_on_headphones() {
    let mut h = H::auto_known();
    h.quiet_frames(30);
    h.speaking(true);
    assert_eq!(h.state(), SessionState::AgentSpeaking);
    let a = h.lvad(0.95, FAR, 400);
    assert!(noise_modes(&a).is_empty());
    h.m.on_echo(EchoMode::Cancelling);
    let a = h.lvad(0.95, FAR, 400);
    assert!(noise_modes(&a).is_empty(), "cancelling: still on speakers");
    h.m.on_echo(EchoMode::Headphones);
    let a = h.lvad(0.95, FAR, 40);
    assert_eq!(noise_modes(&a), vec![NoiseMode::Noisy], "lands while the agent speaks");
    assert_eq!(h.state(), SessionState::AgentSpeaking);
}

/// Hysteresis: back to the quiet room after `revert_ms` with no far speech,
/// once; a second switch is for good.
#[test]
fn auto_goes_back_to_the_quiet_room_once_then_stays_noisy() {
    let mut t = Tuning::AUTO;
    t.auto.as_mut().unwrap().revert_ms = 10_000;
    let mut h = H::auto_known_with(Mode::Conversation, &t);
    h.quiet_frames(30);
    assert_eq!(noise_modes(&h.lvad(0.95, FAR, 60)), vec![NoiseMode::Noisy]);
    let a = h.quiet_frames((9_000 / F_MS) as usize);
    assert!(noise_modes(&a).is_empty(), "not yet");
    let a = h.quiet_frames((2_000 / F_MS) as usize);
    assert_eq!(noise_modes(&a), vec![NoiseMode::Quiet]);
    assert_eq!(h.m.cfg.gate, None);
    assert_eq!(h.m.noise_mode(), NoiseMode::Quiet);
    // The TV again: noisy, and it stays.
    assert_eq!(noise_modes(&h.lvad(0.95, FAR, 60)), vec![NoiseMode::Noisy]);
    let a = h.quiet_frames((60_000 / F_MS) as usize);
    assert!(noise_modes(&a).is_empty(), "never flaps");
    assert_eq!(h.m.noise_mode(), NoiseMode::Noisy);
}

/// A known S (remembered for this mic, or measured) turns on the noisy
/// room's gated barge-in before any switch; the knob takes that back.
#[test]
fn auto_gates_barge_in_once_s_is_known() {
    let cfg = || TurnConfig::for_tuning(Mode::Conversation, DEFAULT_END_SILENCE_MS, true, &Tuning::AUTO);
    let m = Machine::new(cfg(), EchoMode::Converging).with_speech_hint(Some(-27.0));
    assert_eq!(m.noise_mode(), NoiseMode::Quiet);
    assert_eq!(m.barge_level(), Some((-27.0, true)));
    let mut t = Tuning::AUTO;
    t.auto.as_mut().unwrap().barge_when_known = false;
    let off = TurnConfig::for_tuning(Mode::Conversation, DEFAULT_END_SILENCE_MS, true, &t);
    let m = Machine::new(off, EchoMode::Converging).with_speech_hint(Some(-27.0));
    assert_eq!(m.barge_level(), None);
    // Measured by a turn.
    let mut h = H::auto();
    assert!(h.gated_turn(NEAR));
    assert_eq!(h.m.noise_mode(), NoiseMode::Quiet);
    assert!(h.m.barge_level().is_some_and(|(_, measured)| measured));
    // The quiet and noisy presets: as before.
    assert_eq!(H::conv().m.barge_level(), None);
}

/// Old unclaimed words the quiet room would forget are forgotten under Auto
/// too, and a mid-session mic swap puts S back to the bootstrap (and with it
/// the quiet room's barge-in, S being unknown again).
#[test]
fn auto_resets_s_on_a_mic_swap() {
    let mut h = H::auto();
    assert!(h.gated_turn(NEAR));
    assert!(h.m.barge_level().is_some());
    h.m.on_mic_replaced();
    assert_eq!(h.m.speech_level(), Some((-32.0, false)));
    assert_eq!(h.m.barge_level(), None);
}

/// A soft or distant user (−44..−48 dBFS: a laptop mic at arm's length)
/// with S unknown (the bootstrap, −32) is more than the far margin under it
/// and never onset-near, yet it is the user: Auto never counts their speech
/// as background, so it stays the quiet room, turn for turn, and never
/// drops their run or shuts them out.
#[test]
fn a_soft_users_own_speech_never_switches_auto_while_s_is_unknown() {
    for level in [-44.0, -46.0, -48.0] {
        let mut a = H::auto();
        let mut q = H::conv();
        let mut turns = 0;
        for _ in 0..12 {
            // ~1.9 s of the user's speech, then the pause that ends the turn.
            for (p, l, n) in [(0.9, level, 60), (0.05, -72.0, 40)] {
                let start = a.secs();
                let mut x = a.lvad(p, l, n);
                let mut y = q.lvad(p, l, n);
                if let Some(seq) = finalize_seq(&x) {
                    let w = [("hello", start - 1.0), ("there", start - 0.5)];
                    x.extend(a.words(true, &w));
                    y.extend(q.words(true, &w));
                    x.extend(a.finalized(seq));
                    y.extend(q.finalized(seq));
                    turns += usize::from(turn(&x).is_some_and(|t| t.1 == "hello there"));
                }
                assert_eq!(x, y, "{level} dB: Auto differs from the quiet room");
                assert!(noise_modes(&x).is_empty(), "{level} dB: switched on the user's own speech: {x:?}");
            }
        }
        assert_eq!(turns, 12, "{level} dB: every one of the user's runs ended as a turn");
        assert_eq!(a.m.noise_mode(), NoiseMode::Quiet);
    }
}

/// A soft user whose loudest syllables reach the bootstrap's sustain margin
/// gets S measured by their turns, from those syllables only: S sits well
/// over them, and most of their speech is more than the far margin under
/// it. Such a turn (mostly under S's reach) doesn't make S known for far
/// speech, so their own speech still never switches Auto; S only becomes
/// known once their turns have brought it down to them.
#[test]
fn a_soft_users_loud_syllables_dont_make_s_known_for_far_speech() {
    let mut a = H::auto();
    let mut q = H::conv();
    for i in 0..12 {
        for (p, l, n) in [(0.9, -40.0, 4), (0.9, -48.0, 20), (0.9, -40.0, 4), (0.9, -48.0, 32), (0.05, -72.0, 40)] {
            let start = a.secs();
            let mut x = a.lvad(p, l, n);
            let mut y = q.lvad(p, l, n);
            if let Some(seq) = finalize_seq(&x) {
                let w = [("hello", start - 1.0)];
                x.extend(a.words(true, &w));
                y.extend(q.words(true, &w));
                x.extend(a.finalized(seq));
                y.extend(q.finalized(seq));
                if i == 0 {
                    let (s, measured) = a.m.speech_level().unwrap();
                    assert!(measured && s > -40.0, "the first turn measured S from the loud syllables: {s}");
                    assert!(!a.m.auto.as_ref().unwrap().s_known, "but not as the user's level");
                }
            }
            assert_eq!(x, y, "Auto differs from the quiet room");
            assert!(noise_modes(&x).is_empty(), "switched on the user's own speech: {x:?}");
        }
    }
    assert_eq!(a.m.noise_mode(), NoiseMode::Quiet);
}

/// With S unknown a TV well under the bootstrap switches nothing; once the
/// user's first turn measures S, the same TV does.
#[test]
fn auto_switches_on_background_voices_once_a_turn_measured_s() {
    let mut h = H::auto();
    h.quiet_frames(30);
    let mut a = h.lvad(0.95, FAR, 400);
    a.extend(h.quiet_frames(30));
    if let Some(seq) = finalize_seq(&a) {
        a.extend(h.finalized(seq));
    }
    assert!(noise_modes(&a).is_empty(), "S unknown: nothing is far: {a:?}");
    assert!(!h.m.speech_level().is_some_and(|(_, measured)| measured), "the TV measured nothing");
    assert!(h.gated_turn(NEAR), "the user's turn");
    assert!(h.m.speech_level().is_some_and(|(_, measured)| measured));
    assert!(h.m.auto.as_ref().unwrap().s_known, "heard within S's reach: the user's level");
    let a = h.lvad(0.95, FAR, 80);
    assert_eq!(noise_modes(&a), vec![NoiseMode::Noisy]);
}

/// A switch decided while the user held the floor, with S then going unknown
/// (a mic swap) before it could land, is dropped: nothing measured stands
/// behind it any more.
#[test]
fn an_auto_switch_decided_before_s_went_unknown_is_dropped() {
    let mut h = H::auto_known();
    h.quiet_frames(30);
    h.lvad(0.95, NEAR, 20);
    assert_eq!(h.state(), SessionState::UserSpeaking);
    let a = h.lvad(0.6, FAR, 80);
    assert!(noise_modes(&a).is_empty(), "{a:?}");
    assert!(h.m.auto.as_ref().unwrap().pending.is_some(), "decided, waiting for the turn to end");
    h.m.on_mic_replaced();
    let mut all = h.quiet_frames(25);
    if let Some(seq) = finalize_seq(&all) {
        all.extend(h.finalized(seq));
    }
    all.extend(h.quiet_frames(10));
    all.extend(h.lvad(0.95, FAR, 400));
    assert!(noise_modes(&all).is_empty(), "{all:?}");
    assert!(h.m.auto.as_ref().unwrap().pending.is_none());
    assert_eq!(h.m.noise_mode(), NoiseMode::Quiet);
}

// ─── the word filter in dictation ───────────────────────────────────────────

fn end_text(actions: &[Action]) -> Option<String> {
    ended(actions).and_then(|e| e.1)
}

fn dictation_script(h: &mut H) -> Vec<Action> {
    let mut out = h.quiet_frames(30);
    let u1 = h.secs();
    out.extend(h.lvad(0.95, NEAR, 25));
    out.extend(h.quiet_frames(20));
    let tv = h.secs();
    out.extend(h.lvad(0.95, FAR, 60));
    out.extend(h.quiet_frames(20));
    let u2 = h.secs();
    out.extend(h.lvad(0.95, NEAR, 25));
    out.extend(h.quiet_frames(30));
    out.extend(h.words(true, &[("dear", u1 + 0.1), ("team", u1 + 0.4)]));
    out.extend(h.words(true, &[("breaking", tv + 0.2), ("news", tv + 0.6), ("tonight", tv + 1.0)]));
    out.extend(h.words(true, &[("see", u2 + 0.1), ("you", u2 + 0.4)]));
    out
}

/// The noisy room's dictation: the TV's words never reach the text (live or
/// at the stop), the user's do.
#[test]
fn noisy_dictation_keeps_the_tv_out_of_the_text() {
    let mut h = H::auto_with(Mode::Dictation, &Tuning::NOISY);
    let a = dictation_script(&mut h);
    let shown = transcripts(&a);
    assert_eq!(shown.last().map(|t| t.1.as_str()), Some("dear team see you"), "{shown:?}");
    assert!(shown.iter().all(|t| !t.1.contains("breaking")));
    let a = h.m.stop(h.now);
    let seq = finalize_seq(&a).unwrap();
    let a = h.finalized(seq);
    assert_eq!(end_text(&a), Some("dear team see you".into()));
}

/// Auto's dictation with S remembered for the mic: the TV switches it, and
/// from then on the text leaves out the TV's words, the ones before the
/// switch too.
#[test]
fn auto_dictation_switches_and_keeps_the_tv_out_of_the_text() {
    let mut h = H::auto_known_with(Mode::Dictation, &Tuning::AUTO);
    let a = dictation_script(&mut h);
    assert_eq!(noise_modes(&a), vec![NoiseMode::Noisy]);
    assert!(a.iter().all(|x| !matches!(x, Action::Turn { .. })), "dictation makes no turns");
    let a = h.m.stop(h.now);
    let a = h.finalized(finalize_seq(&a).unwrap());
    assert_eq!(end_text(&a), Some("dear team see you".into()));
    // Replaced by another panel, or the stop timing out: the same filter.
    let mut h = H::auto_known_with(Mode::Dictation, &Tuning::AUTO);
    dictation_script(&mut h);
    assert_eq!(end_text(&h.m.replaced()), Some("dear team see you".into()));
    let mut h = H::auto_known_with(Mode::Dictation, &Tuning::AUTO);
    dictation_script(&mut h);
    h.m.stop(h.now);
    assert_eq!(end_text(&h.wait(STOP_MAX_MS + 1)), Some("dear team see you".into()));
}

/// With no background voices Auto's dictation is the quiet room's, word
/// for word.
#[test]
fn auto_dictation_in_a_quiet_room_is_the_quiet_rooms() {
    let mut a = H::auto_with(Mode::Dictation, &Tuning::AUTO);
    let mut q = H::dictation();
    for h in [&mut a, &mut q] {
        h.quiet_frames(30);
    }
    let t = a.secs();
    for h in [&mut a, &mut q] {
        h.lvad(0.95, NEAR, 25);
        h.lvad(0.9, -46.0, 10);
        h.quiet_frames(20);
    }
    let x = a.words(true, &[("hello", t + 0.1), ("softly", t + 0.9)]);
    let y = q.words(true, &[("hello", t + 0.1), ("softly", t + 0.9)]);
    assert_eq!(x, y);
    assert_eq!(a.m.noise_mode(), NoiseMode::Quiet);
    assert_eq!(end_text(&a.m.replaced()), Some("hello softly".into()));
}

/// Dictation never measures S, so with no level remembered for the mic it
/// stays the bootstrap: a soft user's own speech (under −42, never
/// onset-near) must not switch Auto, which would turn on the word filter and
/// drop every word the bootstrap S can't vouch for (under −44). Their whole
/// text is kept, live and at the stop, as the quiet room keeps it.
#[test]
fn auto_dictation_keeps_a_soft_users_words_while_s_is_unknown() {
    for level in [-45.0, -46.0, -48.0] {
        let mut a = H::auto_with(Mode::Dictation, &Tuning::AUTO);
        let mut q = H::dictation();
        for h in [&mut a, &mut q] {
            h.quiet_frames(30);
        }
        let t = a.secs();
        let mut shown = a.lvad(0.9, level, 60);
        shown.extend(a.quiet_frames(20));
        q.lvad(0.9, level, 60);
        q.quiet_frames(20);
        let words = [("hello", t + 0.2), ("there", t + 0.8), ("friend", t + 1.4)];
        let x = a.words(true, &words);
        let y = q.words(true, &words);
        assert_eq!(x, y, "{level} dB: Auto's dictation differs from the quiet room's");
        shown.extend(x);
        assert!(noise_modes(&shown).is_empty(), "{level} dB: switched on the user's own speech");
        assert_eq!(a.m.noise_mode(), NoiseMode::Quiet);
        assert_eq!(a.m.cfg.word_filter, None);
        assert_eq!(transcripts(&shown).last().map(|t| t.1.as_str()), Some("hello there friend"), "{level} dB");
        let stop = a.m.stop(a.now);
        let seq = finalize_seq(&stop).unwrap();
        assert_eq!(end_text(&a.finalized(seq)), Some("hello there friend".into()), "{level} dB");
        // Replaced by another panel: the same text.
        let mut b = H::auto_with(Mode::Dictation, &Tuning::AUTO);
        b.quiet_frames(30);
        b.lvad(0.9, level, 60);
        b.quiet_frames(20);
        b.words(true, &words);
        assert_eq!(end_text(&b.m.replaced()), Some("hello there friend".into()), "{level} dB");
    }
}

/// Dictation's word filter judges the whole text at the stop: a word from
/// long before (past the conversation ring's minute) is still vouched for.
#[test]
fn a_long_dictation_keeps_its_first_words() {
    let mut h = H::auto_with(Mode::Dictation, &Tuning::NOISY);
    h.quiet_frames(10);
    let t = h.secs();
    h.lvad(0.95, NEAR, 25);
    h.quiet_frames((120_000 / F_MS) as usize);
    let late = h.secs();
    h.lvad(0.95, NEAR, 25);
    h.quiet_frames(30);
    h.words(true, &[("first", t + 0.1)]);
    h.words(true, &[("last", late + 0.1)]);
    assert_eq!(end_text(&h.m.replaced()), Some("first last".into()));
}

// ─── Interactive mode and the barge policy ──────────────────────────────────

impl H {
    /// An interactive session (Interactive toggle on), ready.
    fn inter(echo: EchoMode) -> H {
        let (mut h, _) = Self::with(TurnConfig::new(Mode::Interactive, DEFAULT_END_SILENCE_MS, true), echo);
        h.ready();
        h
    }

    /// The reading plays and the DSP thread's detector fires a wake at the
    /// current clock after 10 frames of the user's speech (the VAD alone
    /// opens nothing over the agent). Returns the wake's actions and the
    /// onset (seconds).
    fn wake_over_reading(&mut self) -> (Vec<Action>, f64) {
        let onset = self.at;
        let t = self.secs();
        assert!(states(&self.vad(0.9, 10)).is_empty(), "the VAD alone opens nothing over the agent");
        (self.m.on_wake(onset, self.now), t)
    }
}

#[test]
fn interactive_never_idles_out_and_otherwise_ends_as_a_conversation() {
    let mut h = H::inter(EchoMode::Converging);
    assert_eq!(h.m.barge_policy(), BargePolicy::Wake);
    assert!(ended(&h.wait(IDLE * 12)).is_none(), "an hour of a quiet room");
    let seq = finalize_seq(&h.say_a_turn()).unwrap();
    h.finalized(seq);
    assert!(ended(&h.wait(IDLE * 2)).is_none(), "no reply wait to run out either");
    h.speaking(true);
    h.wait(IDLE);
    h.speaking(false);
    h.wait(300);
    assert!(ended(&h.wait(IDLE * 2)).is_none());
    assert_eq!(ended(&h.m.stop(h.now)), Some((EndReason::Stopped, None, None)));
    let mut h = H::inter(EchoMode::Converging);
    assert_eq!(ended(&h.m.replaced()), Some((EndReason::Cancelled, None, None)));
    let mut h = H::inter(EchoMode::Converging);
    assert_eq!(ended(&h.m.end_with(EndReason::Recording, None)), Some((EndReason::Recording, None, None)));
}

#[test]
fn every_interactive_turn_goes_straight_back_to_listening() {
    let mut h = H::inter(EchoMode::Cancelling);
    let t = h.secs();
    h.vad(0.9, 20);
    h.words(true, &[("Joseph,", t + 0.1), ("what's", t + 0.5), ("next?", t + 0.8)]);
    let seq = finalize_seq(&h.vad(0.1, 22)).unwrap();
    let a = h.finalized(seq);
    assert_eq!(turn(&a), Some(("t1".into(), "Joseph, what's next?".into())));
    assert_eq!(states(&a), vec![SessionState::Listening]);
    // A follow-up without the name is a turn all the same: the web decides.
    let t = h.secs();
    h.vad(0.9, 20);
    h.words(true, &[("yes", t + 0.1)]);
    let seq = finalize_seq(&h.vad(0.1, 22)).unwrap();
    assert_eq!(turn(&h.finalized(seq)), Some(("t2".into(), "yes".into())));
}

#[test]
fn a_wake_opens_the_users_turn_over_the_reading_without_interrupting_it() {
    let mut h = H::inter(EchoMode::Cancelling);
    assert_eq!(states(&h.speaking(true)), vec![SessionState::AgentSpeaking]);
    assert!(h.m.barge_armed() && h.m.barge_wakes());
    h.vad(0.2, 5);
    let (a, t) = h.wake_over_reading();
    assert_eq!(interrupted(&a), None, "nothing was cancelled");
    assert_eq!(states(&a), vec![SessionState::UserSpeaking]);
    assert!(!h.m.barge_armed(), "the run is the user's: nothing more to fire");
    // Partials stream while the reading goes on.
    let a = h.words(false, &[("Joseph", t + 0.1)]);
    assert_eq!(transcripts(&a), vec![("t1".into(), "Joseph".into(), false)]);
    h.vad(0.9, 10);
    h.words(true, &[("Joseph,", t + 0.1), ("stop.", t + 0.5)]);
    let seq = finalize_seq(&h.vad(0.1, 22)).expect("its pause ends it");
    let a = h.finalized(seq);
    assert_eq!(turn(&a), Some(("t1".into(), "Joseph, stop.".into())));
    assert_eq!(states(&a), vec![SessionState::AgentSpeaking], "back to the reading, which never stopped");
    assert!(h.m.barge_armed());
}

#[test]
fn a_wake_run_is_bounded_while_the_reading_goes_on_and_free_once_the_web_pauses_it() {
    // The reading goes on (no name heard): the run is overlap, and after 3 s
    // its next dip ends it (the agent's echo can't hold it open).
    let mut h = H::inter(EchoMode::Cancelling);
    h.speaking(true);
    h.wake_over_reading();
    assert!(finalize_seq(&h.vad(0.9, 100)).is_none());
    assert!(finalize_seq(&h.vad(0.2, 1)).is_some(), "a dip past 3 s ends it while the reading plays");

    // The web heard the name and paused the reading: the run goes on as
    // the user's own, to its own pause.
    let mut h = H::inter(EchoMode::Cancelling);
    h.speaking(true);
    h.wake_over_reading();
    assert!(states(&h.speaking(false)).is_empty(), "the run goes on");
    h.wait(400);
    assert_eq!(h.state(), SessionState::UserSpeaking, "past the agent-quiet grace too");
    h.vad(0.9, 100);
    assert!(finalize_seq(&h.vad(0.2, 1)).is_none(), "no longer overlap: a dip is a dip");
    assert!(finalize_seq(&h.vad(0.1, 22)).is_some(), "its own pause ends it");
    assert!(!h.m.barge_armed(), "nothing plays");
}

#[test]
fn a_wake_while_a_turn_is_finalized_is_the_next_turn() {
    let mut h = H::inter(EchoMode::Cancelling);
    h.speaking(true);
    let (_, t) = h.wake_over_reading();
    h.words(true, &[("Joseph.", t + 0.1)]);
    let seq = finalize_seq(&h.vad(0.1, 22)).unwrap();
    assert_eq!(h.state(), SessionState::Processing);
    assert!(h.m.barge_armed(), "the user going on over the reading after a pause");
    let (a, t2) = h.wake_over_reading();
    assert_eq!(interrupted(&a), None);
    assert!(!h.m.barge_armed(), "queued");
    h.words(true, &[("look", t2 + 0.1), ("this", t2 + 0.3), ("up.", t2 + 0.5)]);
    let a = h.finalized(seq);
    assert_eq!(turn(&a), Some(("t1".into(), "Joseph.".into())));
    assert_eq!(h.state(), SessionState::UserSpeaking);
    let seq = finalize_seq(&h.vad(0.1, 22)).unwrap();
    assert_eq!(turn(&h.finalized(seq)), Some(("t2".into(), "look this up.".into())));
}

#[test]
fn the_barge_policy_switches_mid_session() {
    // A conversation (bargeIn on) starts on speech.
    let mut h = H::conv_with(700, true, EchoMode::Cancelling);
    assert_eq!(h.m.barge_policy(), BargePolicy::Speech);
    h.speaking(true);
    assert!(h.m.barge_armed() && !h.m.barge_wakes());
    // off: never armed, and talking over the agent opens nothing.
    h.m.on_barge_policy(BargePolicy::Off);
    assert!(!h.m.barge_armed());
    assert!(states(&h.vad(0.95, 30)).is_empty());
    // wake: armed while the agent speaks; its fire opens the run without an
    // interruption, and nothing is armed inside it.
    h.m.on_barge_policy(BargePolicy::Wake);
    assert!(h.m.barge_armed() && h.m.barge_wakes());
    let a = h.m.on_wake(h.at, h.now);
    assert_eq!((interrupted(&a), states(&a)), (None, vec![SessionState::UserSpeaking]));
    assert!(!h.m.barge_armed());
    assert!(h.m.on_wake(h.at, h.now).is_empty(), "a stale fire: the run goes on");
    // speech again: the agent talking over the user's run may be cut.
    h.m.on_barge_policy(BargePolicy::Speech);
    assert!(h.m.barge_armed());
    assert_eq!(interrupted(&h.m.on_barge_in(h.at, h.now)), Some("t1".into()));

    // An aside never wakes: only speech barges into it on the hint.
    let mut h = H::inter(EchoMode::Converging);
    h.m.on_aside(true, Some("Hi there"));
    h.speaking(true);
    assert!(h.m.barge_armed() && !h.m.barge_aside());
    h.m.on_barge_policy(BargePolicy::Speech);
    assert!(h.m.barge_aside());

    // Muted: nothing armed, and a wake opens nothing.
    let mut h = H::inter(EchoMode::Cancelling);
    h.speaking(true);
    h.m.on_mute(true, h.now);
    assert!(!h.m.barge_armed());
    assert!(states(&h.m.on_wake(h.at, h.now)).is_empty());
    assert_eq!(h.state(), SessionState::Muted);

    // Dictation has no policy.
    let mut d = H::dictation();
    d.m.on_barge_policy(BargePolicy::Wake);
    assert_eq!(d.m.barge_policy(), BargePolicy::Off);
    d.speaking(true);
    assert!(!d.m.barge_armed());
    assert!(d.m.on_wake(d.at, d.now).is_empty());
}
