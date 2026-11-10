//! The quiet room against its goldens, and the harness against itself.

use super::sim::{HeardWord, Mix, Route, Utterance, Who};
use super::*;
use crate::voice::profile::Tuning;
use crate::audio::aec3_canceller::tests::synthetic_speech;
use crate::audio::aec3_canceller::Aec3Canceller;
use crate::voice::capture::Capture;
use crate::voice::ort_runtime::tests::test_runtime;

/// Every bench scene has its committed goldens.
fn golden_scenes() -> Vec<String> {
    sim::scenes().iter().map(|s| s.name.to_string()).collect()
}

/// **The quiet room is still 0.2.45**: every golden scene's recorded inputs,
/// replayed through `TurnConfig::for_profile(.., Quiet)`, give exactly the
/// actions 94316dd gave. No audio or ONNX Runtime needed.
#[test]
fn the_quiet_room_replays_its_goldens_exactly() {
    let dir = fixtures_dir();
    for scene in golden_scenes() {
        let inputs = Trace::load(&dir.join(format!("{scene}.inputs.jsonl"))).unwrap();
        let golden = Trace::load(&dir.join(format!("{scene}.quiet.actions.jsonl"))).unwrap();
        assert!(inputs.inputs.len() > 1_000, "{scene}: {} inputs", inputs.inputs.len());
        assert!(!golden.actions.is_empty(), "{scene}");
        let cfg = inputs.config();
        assert_eq!(cfg.profile, NoiseProfile::Quiet, "{scene}: goldens are the quiet room's");
        assert_eq!(inputs.header["tuning"], "quiet-2026-09-26");
        let got = replay_recorded(&inputs.inputs, cfg.turn_config(NoiseProfile::Quiet));
        if let Some(d) = diff_actions(&golden.actions, &got) {
            panic!("{scene}: the quiet room changed: {d}");
        }
    }
}

/// **Auto in a quiet room is the quiet room**: the golden scenes with no TV
/// replayed through Auto never switch, and with its barge-in left the quiet
/// room's (`barge_when_known` off) give the goldens exactly. With it on (the
/// preset), a measured S gates barge-in as the noisy room does: in the quiet
/// room with no barge-ins nothing changes; where the user barges in, the
/// turn's onset reaches back over their near frames (backdated) and may take
/// a word more. The TV scenes do switch, once, to the noisy room.
#[test]
fn auto_replays_the_quiet_goldens_as_the_quiet_room() {
    let dir = fixtures_dir();
    let mut exact = Tuning::AUTO;
    exact.auto.as_mut().unwrap().barge_when_known = false;
    let switched = |a: &[(u64, Action)]| a.iter().filter(|(_, a)| matches!(a, Action::NoiseMode { .. })).count();
    for scene in golden_scenes() {
        let inputs = Trace::load(&dir.join(format!("{scene}.inputs.jsonl"))).unwrap();
        let golden = Trace::load(&dir.join(format!("{scene}.quiet.actions.jsonl"))).unwrap();
        let cfg = inputs.config();
        let turn = |t: &Tuning| TurnConfig::for_tuning(cfg.mode, cfg.end_silence_ms, cfg.barge_in, t);
        let auto = replay_recorded(&inputs.inputs, turn(&Tuning::AUTO));
        let tv = inputs.header["tv_rel_db"].is_number();
        if !tv {
            assert_eq!(switched(&auto), 0, "{scene}: a quiet room switched");
            let got = replay_recorded(&inputs.inputs, turn(&exact));
            if let Some(d) = diff_actions(&golden.actions, &got) {
                panic!("{scene}: Auto differs from the quiet room: {d}");
            }
            if !golden.actions.iter().any(|(_, a)| matches!(a, Action::Interrupted { .. })) {
                assert!(diff_actions(&golden.actions, &auto).is_none(), "{scene}: no barge-in, nothing to differ");
            }
        } else {
            // At most once; at −20 dB the synthetic TV is rarely speech to
            // the VAD, and a TV alone at −10 dB (−36 dBFS, 4 dB under the
            // bootstrap S) is as loud as a user: neither switches cold.
            let want = if ["tv-15db", "tv-10db"].contains(&scene.as_str()) { 1..=1 } else { 0..=1 };
            assert!(want.contains(&switched(&auto)), "{scene}: switched {} times", switched(&auto));
        }
    }
}

/// The goldens themselves are what they claim: turns were taken, TV was on
/// where the scene says, barge-in happened in the barge scenes.
#[test]
fn the_goldens_cover_what_they_should() {
    let dir = fixtures_dir();
    let count = |scene: &str, f: &dyn Fn(&Action) -> bool| {
        Trace::load(&dir.join(format!("{scene}.quiet.actions.jsonl"))).unwrap().actions.iter().filter(|(_, a)| f(a)).count()
    };
    let turns = |s: &str| count(s, &|a| matches!(a, Action::Turn { .. }));
    let interrupted = |s: &str| count(s, &|a| matches!(a, Action::Interrupted { .. }));
    for s in golden_scenes() {
        assert!(turns(&s) >= 1, "{s}: no turns");
    }
    assert!(interrupted("barge-speakers") + interrupted("barge-headphones-tv-15db") >= 1, "no barge-in in the barge scenes");
}

/// With the bench audio and ONNX Runtime (Liam's Mac), the scenes rerun
/// live through aec3 and Silero give the committed inputs (VAD within 1e-6)
/// and actions. Skips elsewhere.
#[test]
fn the_bench_scenes_rerun_live_match_their_goldens() {
    let dir = sim::bench_dir();
    if !sim::bench_available(&dir) {
        eprintln!("skipping: no bench audio in {}", dir.display());
        return;
    }
    if test_runtime().is_none() {
        return;
    }
    let bench = sim::BenchAudio::load(&dir).unwrap();
    let fixtures = fixtures_dir();
    let specs = sim::scenes();
    for (spec, r) in specs.iter().zip(run_scenes(&specs, &bench, &Tuning::QUIET)) {
        let (_, run) = r.unwrap();
        let want_inputs = Trace::load(&fixtures.join(format!("{}.inputs.jsonl", spec.name))).unwrap().inputs;
        let want_actions = Trace::load(&fixtures.join(format!("{}.quiet.actions.jsonl", spec.name))).unwrap().actions;
        if let Some(d) = diff_inputs(&want_inputs, &run.inputs, 1e-6) {
            panic!("{}: the DSP path changed: {d}", spec.name);
        }
        if let Some(d) = diff_actions(&want_actions, &run.actions) {
            panic!("{}: the quiet room changed: {d}", spec.name);
        }
    }
}

// ─── the harness on a synthetic scene (no bench, no ONNX Runtime) ───────────

/// Loud frames are speech.
struct LoudnessVad;

impl Vad for LoudnessVad {
    fn frame_len(&self) -> usize {
        512
    }
    fn process(&mut self, frame: &[f32]) -> f32 {
        let rms = (frame.iter().map(|v| v * v).sum::<f32>() / frame.len() as f32).sqrt();
        if rms > 0.01 {
            0.9
        } else if rms > 0.004 {
            0.4
        } else {
            0.05
        }
    }
    fn reset(&mut self) {}
}

/// A user saying three things (synthetic speech), an agent answering on
/// speakers, long replies so the third one is talked over.
fn synthetic_mix() -> Mix {
    synthetic_mix_at(&[(1.0, 2.0), (9.0, 1.5), (15.0, 2.5)], 7.0)
}

/// Utterances at `(start s, length s)`, replies `reply_s` long.
fn synthetic_mix_at(at: &[(f64, f32)], reply_s: f64) -> Mix {
    let fs = sim::FS;
    let duration_s = 24.0;
    let mut bed = vec![0.0f32; (duration_s * fs as f64) as usize];
    let mut words = Vec::new();
    let mut utterances = Vec::new();
    for (k, &(at, len)) in at.iter().enumerate() {
        let speech = synthetic_speech(len, 30 + k as u64);
        let a = (at * fs as f64) as usize;
        for (b, s) in bed[a..].iter_mut().zip(&speech) {
            *b += 0.8 * s;
        }
        let mut idx = Vec::new();
        let n = (len / 0.4) as usize;
        for w in 0..n {
            idx.push(words.len());
            let start = at + w as f64 * 0.4;
            words.push(HeardWord { token: format!("u{}", words.len()), who: Who::User, start, end: start + 0.3, utterance: Some(k) });
        }
        utterances.push(Utterance { start: at, end: at + len as f64, words: idx });
    }
    let mut rng = sim::Rng::new(4);
    bed.iter_mut().for_each(|v| *v += 0.0003 * rng.gauss());
    Mix {
        name: "synthetic".into(),
        duration_s,
        bed,
        agent_voice: synthetic_speech(30.0, 77),
        words,
        utterances,
        route: Route::Speakers,
        echo: sim::speaker_echo_path(),
        reply_s,
        tv_only: false,
    }
}

fn wait_for(path: &Path) {
    for _ in 0..500 {
        if path.is_file() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    panic!("{} never appeared", path.display());
}

/// A run recorded with the debug capture replays exactly both ways: its
/// `events.jsonl` through the machine (recorded mode), and its audio through
/// a fresh aec3 in the recorded interleaving (full DSP mode: cleaned audio
/// bit for bit, the same VAD frames and barge-ins).
#[test]
fn a_debug_capture_replays_exactly() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("session");
    let header = json!({ "session_id": "sim", "mode": "conversation", "end_silence_ms": 700, "barge_in": true, "noise_profile": "quiet" });
    let capture = Capture::start(&dir, header).unwrap();
    let mix = synthetic_mix();
    let run = sim::run(
        &mix,
        sim::SimSetup {
            tuning: Tuning::QUIET,
            vad: Box::new(LoudnessVad),
            canceller: Box::new(Aec3Canceller::new().unwrap()),
            canceller_real: true,
            speech_hint: None,
            capture: Some(capture),
        },
    );
    wait_for(&dir.join("meta.json"));
    let turns = run.actions.iter().filter(|(_, a)| matches!(a, Action::Turn { .. })).count();
    assert!(turns >= 2, "the scene takes turns: {:?}", run.actions);
    assert!(!run.replies.is_empty());

    let data = CaptureData::load(&dir).unwrap();
    let meta: Value = serde_json::from_slice(&std::fs::read(dir.join("meta.json")).unwrap()).unwrap();
    assert_eq!(meta["dropped"], json!({ "frames": 0, "vad_frames": 0, "events": 0 }));
    // The capture's trace is the run's.
    assert_eq!(data.trace.inputs, run.inputs);
    assert_eq!(data.trace.actions, run.actions);
    assert_eq!(data.trace.config().profile, NoiseProfile::Quiet);

    // Recorded mode.
    let replayed = replay_recorded(&data.trace.inputs, data.trace.config().turn_config(NoiseProfile::Quiet));
    assert_eq!(diff_actions(&data.trace.actions, &replayed), None);

    // Full DSP mode.
    let full = replay_full(&data, Box::new(Aec3Canceller::new().unwrap()), true, Box::new(LoudnessVad), NoiseProfile::Quiet).unwrap();
    assert_eq!(diff_full(&data, &full, 0.0), Vec::<String>::new());
    let vads_in_run = run.inputs.iter().filter(|(_, i)| matches!(i, Input::Vad { .. })).count();
    assert_eq!(full.vads.len(), vads_in_run);
    // And a replay that isn't faithful is caught: drop one render frame.
    let mut broken = CaptureData::load(&dir).unwrap();
    let k = broken.aec.iter().position(|r| r.renders > 0).unwrap();
    broken.aec[k].renders -= 1;
    let bad = replay_full(&broken, Box::new(Aec3Canceller::new().unwrap()), true, Box::new(LoudnessVad), NoiseProfile::Quiet).unwrap();
    assert!(!diff_full(&broken, &bad, 0.0).is_empty(), "a shifted interleaving must not replay identically");
}

/// The synthetic run is deterministic, and the recorded replay of a quiet
/// run under the (for now identical) noisy preset gives the same actions.
#[test]
fn the_closed_loop_is_deterministic() {
    let mix = synthetic_mix();
    let go = || {
        sim::run(
            &mix,
            sim::SimSetup {
                tuning: Tuning::QUIET,
                vad: Box::new(LoudnessVad),
                canceller: Box::new(Aec3Canceller::new().unwrap()),
                canceller_real: true,
                speech_hint: None,
                capture: None,
            },
        )
    };
    let (a, b) = (go(), go());
    if let Some(d) = diff_inputs(&a.inputs, &b.inputs, 0.0) {
        panic!("not deterministic: {d}");
    }
    assert_eq!(a.actions, b.actions);
    // Round trip through the fixture format.
    let text = inputs_jsonl(&json!({ "k": "header", "mode": "conversation" }), &a.inputs);
    assert_eq!(diff_inputs(&a.inputs, &Trace::parse(&text).unwrap().inputs, 0.0), None);
    let text = actions_jsonl(&a.actions);
    assert_eq!(Trace::parse(&text).unwrap().actions, a.actions);
    let m = metrics::measure(&mix, &a);
    assert_eq!(m.user_utterances, 3);
    assert!(m.recalled >= 2, "{m:?}");
}

#[test]
fn utterances_are_cut_at_pauses_within_bounds() {
    let w = |s: f64, e: f64| sim::Word { text: "x".into(), start: s, end: e };
    let words = vec![w(0.0, 0.5), w(0.5, 1.0), w(1.0, 1.6), w(1.8, 2.0), w(2.0, 2.5), w(2.5, 3.0), w(3.0, 3.5), w(3.5, 4.0), w(4.0, 4.3)];
    let u = sim::utterances(&words);
    // Cut at the 0.2 s pause after 1.6 s (≥ 1.5 s long); the rest runs on.
    assert_eq!(u.iter().map(|u| u.len()).collect::<Vec<_>>(), vec![3, 6]);
    // Speech with no pause at all is cut at 4 s.
    let run: Vec<sim::Word> = (0..10).map(|i| w(i as f64 * 0.5, i as f64 * 0.5 + 0.5)).collect();
    assert_eq!(sim::utterances(&run).iter().map(|u| u.len()).collect::<Vec<_>>(), vec![8, 2]);
}

/// The same with the real pieces on both sides (aec3 and Silero on ONNX
/// Runtime): the VAD comes back within 1e-6. Skips without ONNX Runtime.
#[test]
fn a_debug_capture_replays_through_silero() {
    if test_runtime().is_none() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("session");
    let capture = Capture::start(&dir, json!({ "mode": "conversation", "noise_profile": "quiet" })).unwrap();
    let mix = synthetic_mix();
    let (canceller, vad) = real_dsp().unwrap();
    let run = sim::run(&mix, sim::SimSetup { tuning: Tuning::QUIET, vad, canceller, canceller_real: true, capture: Some(capture), speech_hint: None });
    wait_for(&dir.join("meta.json"));
    assert!(run.inputs.iter().any(|(_, i)| matches!(i, Input::Vad { prob, .. } if *prob > 0.5)), "Silero heard speech");
    let data = CaptureData::load(&dir).unwrap();
    let (canceller, vad) = real_dsp().unwrap();
    let full = replay_full(&data, canceller, true, vad, NoiseProfile::Quiet).unwrap();
    assert_eq!(diff_full(&data, &full, 1e-6), Vec::<String>::new());
    let replayed = replay_recorded(&data.trace.inputs, data.trace.config().turn_config(NoiseProfile::Quiet));
    assert_eq!(diff_actions(&data.trace.actions, &replayed), None);
}

// ─── closed-loop capture replay, and the real TV-room capture ───────────────

/// [`LoudnessVad`] held through the synthetic speech's short gaps.
#[derive(Default)]
struct HangoverVad(u32);

impl Vad for HangoverVad {
    fn frame_len(&self) -> usize {
        512
    }
    fn process(&mut self, frame: &[f32]) -> f32 {
        if LoudnessVad.process(frame) > 0.5 {
            self.0 = 4;
            0.9
        } else if self.0 > 0 {
            self.0 -= 1;
            0.9
        } else {
            0.05
        }
    }
    fn reset(&mut self) {
        self.0 = 0;
    }
}

/// A capture recorded under the quiet room replays closed loop under the
/// quiet room with the same VAD frames and barge-ins (the DSP's S and arming
/// come from the replay's own machine), and a tuning that never fires keeps
/// a reply the recording cut going for `extend_cut_ms`, then stops it.
#[test]
fn a_debug_capture_replays_closed_loop() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("session");
    let header = json!({ "session_id": "sim", "mode": "conversation", "end_silence_ms": 700, "barge_in": true, "noise_profile": "quiet" });
    let capture = Capture::start(&dir, header).unwrap();
    // On headphones (no echo path: barge-in once that is measured), the
    // second utterance well into a long reply.
    let mix = Mix { route: Route::Headphones, echo: Vec::new(), ..synthetic_mix_at(&[(1.0, 2.0), (13.0, 2.0)], 12.0) };
    let run = sim::run(
        &mix,
        sim::SimSetup {
            tuning: Tuning::QUIET,
            vad: Box::new(HangoverVad::default()),
            canceller: Box::new(Aec3Canceller::new().unwrap()),
            canceller_real: true,
            speech_hint: None,
            capture: Some(capture),
        },
    );
    wait_for(&dir.join("meta.json"));
    let recorded: Vec<u64> = run.inputs.iter().filter(|(_, i)| matches!(i, Input::BargeIn { .. })).map(|(w, _)| *w).collect();
    assert!(!recorded.is_empty(), "the scene talks over the agent");
    let data = CaptureData::load(&dir).unwrap();
    let go = |tuning: Tuning, extend_cut_ms: u64| {
        closed::replay_closed(
            &data,
            Box::new(Aec3Canceller::new().unwrap()),
            true,
            Box::new(HangoverVad::default()),
            closed::ClosedSetup { tuning, speech_hint: None, extend_cut_ms },
        )
        .unwrap()
    };
    let quiet = go(Tuning::QUIET, 4_000);
    assert_eq!(quiet.vad_mismatches, 0);
    assert_eq!(quiet.orphan_replies, Vec::new(), "the same turns: every reply answers one");
    assert_eq!(quiet.recorded_barge_ins, recorded);
    assert_eq!(quiet.barge_ins.iter().map(|b| b.0).collect::<Vec<_>>(), recorded);
    let turns = |a: &[(u64, Action)]| a.iter().filter(|(_, a)| matches!(a, Action::Turn { .. })).count();
    assert_eq!(turns(&quiet.actions), turns(&run.actions));
    let sum = closed::Summary::of(&quiet);
    assert!(sum.against(&recorded, 4_000).iter().all(|(_, d)| *d == Some(0)), "{sum:?}");

    // Barge-in off in effect: the cut reply goes on 3 s more, then ends.
    let mut deaf = Tuning::QUIET;
    deaf.barge.onset = 2.0;
    let never = go(deaf, 3_000);
    assert_eq!(never.vad_mismatches, 0);
    assert!(never.barge_ins.is_empty());
    let off_at = |w: u64| never.inputs.iter().find(|(t, i)| *t >= w && *i == Input::Speaking(false)).map(|(t, _)| *t);
    for w in &recorded {
        let next_on = never.inputs.iter().find(|(t, i)| t > w && *i == Input::Speaking(true)).map(|(t, _)| *t);
        let off = off_at(*w).expect("the reply ends");
        assert_eq!(off, next_on.map_or(w + 3_000, |n| n.min(w + 3_000)), "recorded cut at {w}");
    }
}

/// A recorded reply to a turn the replay never sent doesn't play: live, the
/// agent would have had nothing to answer, so nothing to barge into.
#[test]
fn a_closed_loop_replay_skips_replies_to_turns_it_never_sent() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("session");
    let header = json!({ "session_id": "sim", "mode": "conversation", "end_silence_ms": 700, "barge_in": true, "noise_profile": "quiet" });
    let capture = Capture::start(&dir, header).unwrap();
    // Four things said, the second short; each answered (2 s replies).
    let mix = Mix { route: Route::Headphones, echo: Vec::new(), ..synthetic_mix_at(&[(1.0, 2.0), (9.0, 0.8), (15.0, 2.0), (18.5, 2.0)], 2.0) };
    let run = sim::run(
        &mix,
        sim::SimSetup {
            tuning: Tuning::QUIET,
            vad: Box::new(HangoverVad::default()),
            canceller: Box::new(Aec3Canceller::new().unwrap()),
            canceller_real: true,
            speech_hint: None,
            capture: Some(capture),
        },
    );
    wait_for(&dir.join("meta.json"));
    let replies: Vec<u64> = run.inputs.iter().filter(|(_, i)| *i == Input::Speaking(true)).map(|(w, _)| *w).collect();
    let sent: Vec<u64> = run.actions.iter().filter(|(_, a)| matches!(a, Action::Turn { .. })).map(|(w, _)| *w).collect();
    assert!(replies.len() >= 3 && sent.len() >= 3, "replies {replies:?}, turns {sent:?}");
    let data = CaptureData::load(&dir).unwrap();
    let go = |tuning: Tuning| {
        closed::replay_closed(
            &data,
            Box::new(Aec3Canceller::new().unwrap()),
            true,
            Box::new(HangoverVad::default()),
            closed::ClosedSetup { tuning, speech_hint: None, extend_cut_ms: 4_000 },
        )
        .unwrap()
    };
    let turns = |r: &closed::ClosedRun| r.actions.iter().filter(|(_, a)| matches!(a, Action::Turn { .. })).map(|(w, _)| *w).collect::<Vec<_>>();
    let played = |r: &closed::ClosedRun| r.inputs.iter().filter(|(_, i)| *i == Input::Speaking(true)).map(|(w, _)| *w).collect::<Vec<_>>();

    // Under the recorded tuning every reply answers a turn and plays.
    let same = go(Tuning::QUIET);
    assert!(same.orphan_replies.is_empty());
    assert_eq!(played(&same), replies);

    // No turn is ever sent: every reply is an orphan, and no barge-in fires.
    let mut deaf = Tuning::QUIET;
    deaf.turn.onset = 2.0;
    let none = go(deaf);
    assert!(turns(&none).is_empty());
    assert!(played(&none).is_empty(), "{:?}", none.inputs.iter().filter(|(_, i)| matches!(i, Input::Speaking(_))).collect::<Vec<_>>());
    assert_eq!(none.orphan_replies.iter().map(|r| r.0).collect::<Vec<_>>(), replies);
    assert!(none.barge_ins.is_empty());
    // A recorded barge-in into an orphan reply can't happen, so it isn't
    // counted as missed.
    let sum = closed::Summary { orphan_replies: vec![(10_000, 12_000)], barge_ins: vec![3_100], ..Default::default() };
    assert!(sum.orphaned(11_000) && !sum.orphaned(3_000));
    let line = sum.line(&[3_000, 11_000, 20_000], 4_000);
    assert!(line.starts_with("cuts 3.0✓+0.1 11.0∅ 20.0✗ |"), "{line}");
    assert!(line.ends_with("orphan replies [10.0]"), "{line}");

    // The short thing said isn't a turn: its reply is skipped; a reply plays
    // exactly when the replay sent a turn since the last one that played.
    let mut long = Tuning::QUIET;
    long.turn.min_speech_ms = 700;
    let some = go(long);
    let (t, p) = (turns(&some), played(&some));
    assert!(t.len() < sent.len() && !t.is_empty(), "turns {t:?} vs recorded {sent:?}");
    assert!(!some.orphan_replies.is_empty() && p.len() >= 2, "played {p:?}, orphans {:?}", some.orphan_replies);
    let mut all: Vec<(u64, bool)> = p.iter().map(|&w| (w, true)).chain(some.orphan_replies.iter().map(|r| (r.0, false))).collect();
    all.sort();
    let mut last = 0;
    for (w, plays) in all {
        let answered = t.iter().any(|&x| x > last && x <= w);
        assert_eq!(plays, answered, "reply at {w}: turns {t:?}, played {p:?}");
        if plays {
            last = w;
        }
    }
}

/// Same norm, same token; the words themselves never come out.
#[test]
fn the_redactor_keeps_word_identity_only() {
    let mut r = closed::Redactor::default();
    assert_eq!(r.text("Hello, world hello"), "w1 w2 w1");
    assert_eq!(r.token("WORLD!"), "w2");
    assert_eq!(r.token("new"), "w3");
}

const TV_ROOM: &str = "capture-tv-room-headphones";

/// **The noisy room on Liam's TV room** (a 224 s debug capture, EarPods, a
/// TV on; the closed-loop replay's inputs with the words redacted): its
/// recorded inputs, replayed through the noisy room, give exactly the
/// committed actions.
#[test]
fn the_noisy_room_replays_the_tv_room_capture_exactly() {
    let dir = fixtures_dir();
    let inputs = Trace::load(&dir.join(format!("{TV_ROOM}.inputs.jsonl"))).unwrap();
    let golden = Trace::load(&dir.join(format!("{TV_ROOM}.noisy.actions.jsonl"))).unwrap();
    let cfg = inputs.config();
    assert_eq!(cfg.profile, NoiseProfile::Noisy);
    assert_eq!(inputs.header["tuning"], Tuning::NOISY.label, "regenerate with `voice_replay fixture DIR {TV_ROOM} --write` for a new noisy tuning");
    assert!(inputs.inputs.len() > 10_000);
    let got = replay_recorded(&inputs.inputs, cfg.turn_config(NoiseProfile::Noisy));
    if let Some(d) = diff_actions(&golden.actions, &got) {
        panic!("the noisy room changed on the TV room capture: {d}");
    }
    // What it pins: the TV never holds a turn open for long, and every mute
    // mid-turn sends what was said.
    let interrupted: Vec<u64> = got.iter().filter(|(_, a)| matches!(a, Action::Interrupted { .. })).map(|(w, _)| *w).collect();
    let sum = closed::Summary::of(&closed::ClosedRun { actions: got, ..Default::default() });
    assert!(sum.runs.iter().all(|(a, b)| b - a < 12_000), "{:?}", sum.runs);
    assert!(sum.turns.len() >= 8, "{:?}", sum.turns);
    // The recorded replies to turns the noisy room never sent (the TV's)
    // don't play, so nothing barges into them and no turn is sent muted:
    // the barge-ins are the user's at 42.7 s and the TV's at 62.7 s (into
    // the reply the recording cut at 61.2 s, taken to go on).
    assert_eq!(inputs.header["orphan_replies"], json!([81_250, 126_496, 139_256]));
    assert_eq!(interrupted, vec![42_680, 62_676]);
    assert_eq!(sum.turns_while_muted, 0);
}

/// The committed TV-room trace holds no transcript words: every word, every
/// transcript and every turn's text is placeholder tokens.
#[test]
fn the_tv_room_fixture_holds_no_words() {
    let token = |t: &str| t.split_whitespace().all(|w| w.len() > 1 && w.starts_with('w') && w[1..].chars().all(|c| c.is_ascii_digit()));
    let dir = fixtures_dir();
    let inputs = Trace::load(&dir.join(format!("{TV_ROOM}.inputs.jsonl"))).unwrap();
    let mut words = 0;
    for (_, i) in &inputs.inputs {
        if let Input::Stt(crate::modules::stt::VoiceSttEvent::Results(r)) = i {
            assert!(token(&r.transcript), "{r:?}");
            for w in &r.words {
                assert!(token(&w.word), "{w:?}");
                words += 1;
            }
        }
    }
    assert!(words > 100);
    for (_, a) in &Trace::load(&dir.join(format!("{TV_ROOM}.noisy.actions.jsonl"))).unwrap().actions {
        match a {
            Action::Turn { text, .. } | Action::Transcript { text, .. } => assert!(token(text), "{a:?}"),
            Action::End { text: Some(text), .. } => assert!(token(text), "{a:?}"),
            _ => {}
        }
    }
}

/// On Liam's Mac (the capture and ONNX Runtime there): the capture rerun
/// closed loop through aec3 and Silero gives the committed inputs and
/// actions again. Skips elsewhere.
#[test]
fn the_tv_room_capture_rerun_closed_matches_its_fixture() {
    let fixtures = fixtures_dir();
    let inputs = Trace::load(&fixtures.join(format!("{TV_ROOM}.inputs.jsonl"))).unwrap();
    let Some(dir) = inputs.header["capture"]
        .as_str()
        .and_then(|name| dirs::data_dir().map(|d| d.join("ai.dial8.desktop/voice-captures").join(name)))
        .filter(|d| d.join("events.jsonl").is_file())
    else {
        eprintln!("skipping: the TV room capture is not on this machine");
        return;
    };
    if test_runtime().is_none() {
        return;
    }
    let data = CaptureData::load(&dir).unwrap();
    let (got_inputs, got_actions, _) = closed::fixture(&data, &Tuning::NOISY, TV_ROOM, 4_000).unwrap();
    let want = Trace::load(&fixtures.join(format!("{TV_ROOM}.noisy.actions.jsonl"))).unwrap();
    if let Some(d) = diff_inputs(&inputs.inputs, &Trace::parse(&got_inputs).unwrap().inputs, 1e-6) {
        panic!("the TV room capture replays differently: {d}");
    }
    assert_eq!(diff_actions(&want.actions, &Trace::parse(&got_actions).unwrap().actions), None);
}

/// The intro without its mute hold, on a real capture (not committed: a
/// user's own): `NI_NO_HOLD_CAPTURE=DIR cargo test --lib
/// no_hold_on_a_real_capture -- --ignored --nocapture`. Prints the
/// recording's runs and turns against the replay's with the greeting kept,
/// then skipped.
#[test]
#[ignore]
fn no_hold_on_a_real_capture() {
    let Ok(dir) = std::env::var("NI_NO_HOLD_CAPTURE") else { return };
    let data = CaptureData::load(std::path::Path::new(&dir)).unwrap();
    for extra in [&[][..], &["--skip-greeting".to_string()][..]] {
        let mut args = vec!["--until".to_string(), "15".to_string()];
        args.extend_from_slice(extra);
        closed::cli_no_hold(&data, &args).unwrap();
    }
}
