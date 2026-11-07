//! Closed-loop replay of a debug capture under another preset or tuning.
//!
//! [`super::replay_recorded`] feeds the recorded inputs as they were, so the
//! barge-ins are the recorded preset's. [`super::replay_full`] reruns the
//! DSP path but has no turn machine, so the noisy room's barge-in gate never
//! learns S. This runs both, as the session does:
//!
//! - The capture's audio goes through a fresh [`DspCore`] with the tuning,
//!   in aec3's recorded interleaving (as [`super::replay_full`]). Its VAD,
//!   levels and echo mode don't depend on the preset, so they match the
//!   recording (counted in [`ClosedRun::vad_mismatches`]).
//! - A fresh [`Machine`] with the tuning gets the recorded inputs in their
//!   recorded order and wall times, except the recorded barge-ins: the
//!   replayed DSP's barge-ins go in instead, right after the VAD frame that
//!   fired them. Before each VAD frame the DSP sees the machine's S and
//!   barge-in arming as they stand then (the session publishes both after
//!   every input).
//! - The agent's replies are the recorded ones (`speaking` inputs), but only
//!   those the replay gave it something to answer: a recorded reply that
//!   answers a turn the recording sent (one since the reply before it) plays
//!   only if the replay has sent a turn since the last reply it played.
//!   Otherwise it is an orphan and is skipped whole (its `speaking` on and
//!   off, and any barge-in into it can't happen): live, the agent would have
//!   had nothing to say. Replies that answer no recorded turn (the greeting)
//!   always play. The replay's turns are matched to replies by order only: a
//!   turn it sends later than the recording did, after the recorded reply
//!   started, is answered by the next one. A reply the replay cuts stops
//!   there. A reply the recording cut but the replay
//!   doesn't is taken to go on for [`ClosedSetup::extend_cut_ms`] more (or
//!   until the next reply or a mute), so a barge-in that fires later than
//!   the recorded one still can. Only sound with no echo path (headphones):
//!   on speakers the rest of the reply isn't in the mic.
//! - Transcription is the recorded one. A finalize the replay sends at
//!   another time than the recording did gets no recorded ack and completes
//!   on the machine's forward timeout.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use tokio::sync::mpsc;

use super::{CaptureData, RecordedSpeech, Recorder};
use crate::audio::aec::{EchoCanceller, AEC_FRAME};
use crate::audio::tap::tap_channel;
use crate::voice::dsp::{DspCore, DspEvent, DspShared, ReplayFrame};
use crate::voice::events::{EchoMode, SessionState};
use crate::voice::profile::Tuning;
use crate::voice::trace::{self, Input};
use crate::voice::turn::{Action, Machine, TurnConfig};
use crate::voice::vad::Vad;

/// How to replay.
#[derive(Debug, Clone, Copy)]
pub struct ClosedSetup {
    pub tuning: Tuning,
    /// A remembered speech level ([`Machine::with_speech_hint`]).
    pub speech_hint: Option<f32>,
    /// A reply the recording cut and the replay doesn't goes on this long.
    pub extend_cut_ms: u64,
}

/// What a closed-loop replay did.
#[derive(Debug, Clone, Default)]
pub struct ClosedRun {
    /// Every input the machine got, with its wall time.
    pub inputs: Vec<(u64, Input)>,
    pub actions: Vec<(u64, Action)>,
    /// Each barge-in the replay fired: (wall, onset).
    pub barge_ins: Vec<(u64, u64)>,
    /// The wall of each barge-in in the recording.
    pub recorded_barge_ins: Vec<u64>,
    /// Each recorded reply skipped as an orphan (the replay sent no turn for
    /// it to answer): (start, end) wall, end `u64::MAX` if it never ended.
    pub orphan_replies: Vec<(u64, u64)>,
    /// Replayed VAD frames that differ from the recorded ones (0 expected).
    pub vad_mismatches: usize,
    /// S after each sent turn: (wall, dBFS).
    pub speech_after_turns: Vec<(u64, f32)>,
    /// S at the end, and the sent turns that measured it.
    pub speech_end: Option<(f32, bool)>,
    pub measured_turns: u32,
}

struct Loop {
    machine: Machine,
    run: ClosedRun,
    /// The speaking state fed last.
    speaking: bool,
    /// The replay cut the current reply.
    reply_cut: bool,
    /// A recorded cut the replay didn't make: the reply goes on until then.
    extended_until: Option<u64>,
    /// The replay sent a turn since the last reply it played.
    turn_since_reply: bool,
    /// Inside a recorded reply skipped as an orphan.
    orphan: bool,
}

impl Loop {
    fn feed(&mut self, input: Input, wall: u64) {
        if let Input::Speaking(s) = input {
            self.speaking = s;
            if s {
                self.reply_cut = false;
                self.extended_until = None;
                self.turn_since_reply = false;
            }
        }
        for a in trace::feed(&mut self.machine, &input, wall) {
            if matches!(a, Action::Turn { .. }) {
                self.turn_since_reply = true;
                if let Some((db, _)) = self.machine.speech_level() {
                    self.run.speech_after_turns.push((wall, db));
                }
            }
            self.run.actions.push((wall, a));
        }
        self.run.inputs.push((wall, input));
    }

    /// An extended reply that has run its time ends (fed at its end).
    fn end_extension_by(&mut self, wall: u64) {
        if let Some(until) = self.extended_until {
            if wall >= until {
                self.extended_until = None;
                self.feed(Input::Speaking(false), until);
            }
        }
    }

    /// An extended reply ends now (a new reply, a mute).
    fn end_extension_now(&mut self, wall: u64) {
        if self.extended_until.take().is_some() {
            self.feed(Input::Speaking(false), wall);
        }
    }
}

/// Closed-loop replay of `data` (see the module docs).
pub fn replay_closed(
    data: &CaptureData,
    canceller: Box<dyn EchoCanceller>,
    canceller_real: bool,
    vad: Box<dyn Vad>,
    setup: ClosedSetup,
) -> Result<ClosedRun, String> {
    let rec = &data.trace.inputs;
    let cfg = data.trace.config();
    let turn_cfg = TurnConfig::for_tuning(cfg.mode, cfg.end_silence_ms, cfg.barge_in, &setup.tuning);

    // The recorded VAD frames by span, and the `speaking: false` that
    // follows each recorded barge-in (the TTS stopping because of it).
    let vad_at: HashMap<(u64, u64), usize> = rec
        .iter()
        .enumerate()
        .filter_map(|(i, (_, inp))| match inp {
            Input::Vad { start, end, .. } => Some(((*start, *end), i)),
            _ => None,
        })
        .collect();
    let mut cut_offs: HashSet<usize> = HashSet::new();
    let mut recorded_barge_ins = Vec::new();
    for (i, (w, inp)) in rec.iter().enumerate() {
        if matches!(inp, Input::BargeIn { .. }) {
            recorded_barge_ins.push(*w);
            if let Some(j) = rec[i..]
                .iter()
                .position(|(w2, x)| *w2 > w + 500 || matches!(x, Input::Speaking(false)))
                .map(|p| i + p)
                .filter(|&j| matches!(rec[j].1, Input::Speaking(false)))
            {
                cut_offs.insert(j);
            }
        }
    }

    // The recorded replies that answer a recorded turn (sent since the reply
    // before): the replay plays each only if it sent a turn too.
    let recorded_turns: Vec<u64> =
        data.trace.actions.iter().filter(|(_, a)| matches!(a, Action::Turn { .. })).map(|(w, _)| *w).collect();
    let mut answers: HashSet<usize> = HashSet::new();
    let mut last_reply: Option<u64> = None;
    for (i, (w, inp)) in rec.iter().enumerate() {
        if *inp == Input::Speaking(true) {
            if recorded_turns.iter().any(|&t| t <= *w && last_reply.is_none_or(|p| t > p)) {
                answers.insert(i);
            }
            last_reply = Some(*w);
        }
    }

    let (_mw, mic_r) = tap_channel(16);
    let (_rw, ref_r) = tap_channel(16);
    let speech = RecordedSpeech::default();
    let shared = Arc::new(DspShared::default());
    let (tx, mut events) = mpsc::unbounded_channel();
    let mut core = DspCore::new(
        mic_r,
        Some(ref_r),
        canceller,
        canceller_real,
        Some(vad),
        Box::new(Recorder::default()),
        Box::new(speech.clone()),
        shared.clone(),
        tx,
        0,
    )
    .with_tuning(&setup.tuning);

    let mut lp = Loop {
        machine: Machine::new(turn_cfg, EchoMode::Converging).with_speech_hint(setup.speech_hint),
        run: ClosedRun { recorded_barge_ins, ..ClosedRun::default() },
        speaking: false,
        reply_cut: false,
        extended_until: None,
        turn_since_reply: false,
        orphan: false,
    };

    // One recorded input, adjusted for the replay's cuts.
    let recorded = |lp: &mut Loop, i: usize| {
        let (wall, input) = (rec[i].0, rec[i].1.clone());
        lp.end_extension_by(wall);
        match input {
            // The replay's own barge-ins go in instead.
            Input::BargeIn { .. } => {}
            // A reply to a turn the replay never sent: skipped whole.
            Input::Speaking(true) if answers.contains(&i) && !lp.turn_since_reply => {
                lp.orphan = true;
                lp.run.orphan_replies.push((wall, u64::MAX));
            }
            Input::Speaking(false) if lp.orphan => {
                lp.orphan = false;
                if let Some(r) = lp.run.orphan_replies.last_mut() {
                    r.1 = wall;
                }
            }
            Input::Speaking(false) if lp.reply_cut => {}
            Input::Speaking(false) if cut_offs.contains(&i) && lp.speaking && setup.extend_cut_ms > 0 => {
                lp.extended_until = Some(wall + setup.extend_cut_ms);
            }
            Input::Speaking(true) | Input::Mute(true) => {
                lp.end_extension_now(wall);
                lp.feed(input, wall);
            }
            _ => lp.feed(input, wall),
        }
    };

    let (mut rp, mut vpos, mut rpos) = (0usize, 0usize, 0usize);
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
        // The VAD frame that completes in this capture frame: the machine
        // catches up to just before it, and the DSP sees what it publishes.
        let frame_end = row.clock + AEC_FRAME as u64;
        let vad_here = match data.vads.get(vpos).filter(|v| v.end > row.clock && v.end <= frame_end) {
            Some(v) => {
                vpos += 1;
                let k = *vad_at.get(&(v.start, v.end)).ok_or(format!("VAD frame {}..{} is not in events.jsonl", v.start, v.end))?;
                while rp < k {
                    recorded(&mut lp, rp);
                    rp += 1;
                }
                lp.end_extension_by(rec[k].0);
                shared.barge_armed.store(lp.machine.barge_armed(), Ordering::SeqCst);
                shared.barge_aside.store(lp.machine.barge_aside(), Ordering::SeqCst);
                shared.speech_level.set(lp.machine.barge_level());
                speech.audible.store(lp.speaking, Ordering::SeqCst);
                Some(k)
            }
            None => None,
        };
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
        let mut fired = None;
        while let Ok(e) = events.try_recv() {
            match e {
                DspEvent::Vad { prob, start, end, level_db, floor_db } => {
                    let same = vad_here.is_some_and(|k| {
                        rec[k].1 == Input::Vad { prob, start, end, level_db, floor_db }
                            || matches!(rec[k].1, Input::Vad { prob: p, start: s, end: e, level_db: l, floor_db: f }
                                if s == start && e == end && (p - prob).abs() <= 1e-6 && (l - level_db).abs() <= 1e-6 && (f - floor_db).abs() <= 1e-6)
                    });
                    if !same {
                        lp.run.vad_mismatches += 1;
                    }
                }
                DspEvent::BargeIn { onset } => fired = Some(onset),
                _ => {}
            }
        }
        if let Some(k) = vad_here {
            // The VAD frame (as recorded), then this replay's barge-in.
            recorded(&mut lp, k);
            rp = k + 1;
            if let Some(onset) = fired {
                let wall = rec[k].0;
                lp.run.barge_ins.push((wall, onset));
                lp.feed(Input::BargeIn { onset }, wall);
                lp.extended_until = None;
                if lp.speaking {
                    lp.feed(Input::Speaking(false), wall);
                    lp.reply_cut = true;
                }
            }
        }
    }
    drop(core);
    while rp < rec.len() {
        recorded(&mut lp, rp);
        rp += 1;
    }
    lp.run.speech_end = lp.machine.speech_level();
    lp.run.measured_turns = lp.machine.measured_turns();
    Ok(lp.run)
}

/// Closed-loop replay of `data` as if the mic had never been muted: the
/// intro's hold (the web muted the desktop while its start chime played,
/// before 0.2.46's web) taken out, for a capture whose only mute is that.
///
/// Every recorded mute is dropped and the DSP runs unmuted on the whole
/// recorded mic (the capture keeps it while muted), so its VAD frames are
/// the replay's own (the recording has none while muted, and its frames
/// after the unmute start where the unmute reset the VAD): each goes to the
/// machine at its capture frame's wall time, with the recorded inputs up to
/// then. Barge-ins are the replay's, as in [`replay_closed`].
/// `skip_greeting`: the agent speech before the recording's first turn
/// (the greeting) is dropped, as the web now does when the user talks first.
///
/// Transcription is the recorded one: local-stt got silence while the mic
/// was muted, so words said under the hold can't come back here; the run
/// structure (when the user's turn opens, whether a run survives) can.
pub fn replay_no_hold(
    data: &CaptureData,
    canceller: Box<dyn EchoCanceller>,
    canceller_real: bool,
    vad: Box<dyn Vad>,
    tuning: Tuning,
    skip_greeting: bool,
) -> Result<ClosedRun, String> {
    let rec = &data.trace.inputs;
    let cfg = data.trace.config();
    let turn_cfg = TurnConfig::for_tuning(cfg.mode, cfg.end_silence_ms, cfg.barge_in, &tuning);
    let first_turn =
        data.trace.actions.iter().find(|(_, a)| matches!(a, Action::Turn { .. })).map_or(u64::MAX, |(w, _)| *w);

    let (_mw, mic_r) = tap_channel(16);
    let (_rw, ref_r) = tap_channel(16);
    let speech = RecordedSpeech::default();
    let shared = Arc::new(DspShared::default());
    let (tx, mut events) = mpsc::unbounded_channel();
    let mut core = DspCore::new(
        mic_r,
        Some(ref_r),
        canceller,
        canceller_real,
        Some(vad),
        Box::new(Recorder::default()),
        Box::new(speech.clone()),
        shared.clone(),
        tx,
        0,
    )
    .with_tuning(&tuning);

    let mut lp = Loop {
        machine: Machine::new(turn_cfg, EchoMode::Converging),
        run: ClosedRun::default(),
        speaking: false,
        reply_cut: false,
        extended_until: None,
        turn_since_reply: false,
        orphan: false,
    };
    let recorded = |lp: &mut Loop, i: usize| {
        let (wall, input) = (rec[i].0, rec[i].1.clone());
        match input {
            Input::Vad { .. } | Input::BargeIn { .. } | Input::Mute(_) => {}
            Input::Speaking(_) if skip_greeting && wall < first_turn => {}
            // The reply the replay cut ends there (a new one lifts the cut).
            Input::Speaking(false) if lp.reply_cut => {}
            _ => lp.feed(input, wall),
        }
    };

    let (mut rp, mut rpos) = (0usize, 0usize);
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
        while rp < rec.len() && rec[rp].0 <= row.now_ms {
            recorded(&mut lp, rp);
            rp += 1;
        }
        shared.barge_armed.store(lp.machine.barge_armed(), Ordering::SeqCst);
        shared.barge_aside.store(lp.machine.barge_aside(), Ordering::SeqCst);
        shared.speech_level.set(lp.machine.barge_level());
        speech.audible.store(lp.speaking, Ordering::SeqCst);
        core.replay_frame(&ReplayFrame {
            now_ms: row.now_ms,
            renders: &renders,
            absent_zero: row.absent_zero,
            capture,
            muted: false,
            mute_toggled: false,
            headphones_hint: row.headphones_hint,
            resynced: row.resynced,
            mic_replaced: row.mic_replaced,
        });
        while let Ok(e) = events.try_recv() {
            match e {
                DspEvent::Vad { prob, start, end, level_db, floor_db } => {
                    lp.feed(Input::Vad { prob, start, end, level_db, floor_db }, row.now_ms)
                }
                DspEvent::BargeIn { onset } => {
                    lp.run.barge_ins.push((row.now_ms, onset));
                    lp.feed(Input::BargeIn { onset }, row.now_ms);
                    if lp.speaking {
                        lp.feed(Input::Speaking(false), row.now_ms);
                        lp.reply_cut = true;
                    }
                }
                _ => {}
            }
        }
    }
    drop(core);
    while rp < rec.len() {
        recorded(&mut lp, rp);
        rp += 1;
    }
    lp.run.speech_end = lp.machine.speech_level();
    lp.run.measured_turns = lp.machine.measured_turns();
    Ok(lp.run)
}

/// `voice_replay capture DIR --no-hold [--skip-greeting] [--until S]`: the
/// capture without the intro's mute hold ([`replay_no_hold`]), against the
/// recording: the user's runs, turns and the words they took, up to `S` s.
pub fn cli_no_hold(data: &CaptureData, args: &[String]) -> Result<(), String> {
    let tuning = super::tuning_arg(args)?;
    let skip = args.iter().any(|a| a == "--skip-greeting");
    let until: u64 = match super::arg_value(args, "--until") {
        Some(v) => (v.parse::<f64>().map_err(|e| format!("--until {v}: {e}"))? * 1000.0) as u64,
        None => u64::MAX,
    };
    let (canceller, vad) = super::real_dsp().ok_or("no ONNX Runtime for Silero")?;
    let run = replay_no_hold(data, canceller, true, vad, tuning, skip)?;
    let s = |ms: u64| format!("{:.2}", ms as f64 / 1000.0);
    let show = |label: &str, actions: &[(u64, Action)]| {
        println!("{label}:");
        let mut last: Option<SessionState> = None;
        for (w, a) in actions.iter().filter(|(w, _)| *w <= until) {
            match a {
                Action::State { state, .. } if last != Some(*state) => {
                    last = Some(*state);
                    println!("  {} {:?}", s(*w), state);
                }
                Action::Turn { turn_id, text } => {
                    println!("  {} turn {turn_id}: {} words", s(*w), text.split_whitespace().count())
                }
                Action::Interrupted { turn_id } => println!("  {} interrupted ({turn_id})", s(*w)),
                _ => {}
            }
        }
    };
    show("recorded (with the hold)", &data.trace.actions);
    show(if skip { "no hold, greeting skipped" } else { "no hold, greeting as recorded" }, &run.actions);
    for (w, onset) in run.barge_ins.iter().filter(|(w, _)| *w <= until) {
        println!("  replay barge-in {} (onset {:.2} s)", s(*w), *onset as f64 / 16_000.0);
    }
    let vads: Vec<String> = run
        .inputs
        .iter()
        .filter_map(|(w, i)| match i {
            Input::Vad { prob, start, .. } if *w <= until.min(5_000) && *prob >= 0.35 => {
                Some(format!("{:.2}:{:.2}", *start as f64 / 16_000.0, prob))
            }
            _ => None,
        })
        .collect();
    println!("  replayed VAD ≥ 0.35 (audio s: prob) to 5 s: {}", vads.join(" "));
    Ok(())
}

/// A closed run, by incident.
#[derive(Debug, Clone, Default)]
pub struct Summary {
    /// Wall of each barge-in the replay fired.
    pub barge_ins: Vec<u64>,
    /// Each sent turn: wall, id, words.
    pub turns: Vec<(u64, String, usize)>,
    /// Each stretch the web was shown `user_speaking`: (from, to) wall.
    pub runs: Vec<(u64, u64)>,
    /// Turns sent while muted.
    pub turns_while_muted: usize,
    /// Recorded replies skipped as orphans ([`ClosedRun::orphan_replies`]).
    pub orphan_replies: Vec<(u64, u64)>,
}

impl Summary {
    pub fn of(run: &ClosedRun) -> Summary {
        let mut s = Summary {
            barge_ins: run.barge_ins.iter().map(|b| b.0).collect(),
            orphan_replies: run.orphan_replies.clone(),
            ..Summary::default()
        };
        let (mut since, mut state) = (None, None);
        for (wall, a) in &run.actions {
            match a {
                Action::State { state: st, .. } => {
                    if *st == SessionState::UserSpeaking {
                        since.get_or_insert(*wall);
                    } else if let Some(from) = since.take() {
                        s.runs.push((from, *wall));
                    }
                    state = Some(*st);
                }
                Action::Turn { turn_id, text } => {
                    s.turns.push((*wall, turn_id.clone(), text.split_whitespace().count()));
                    if state == Some(SessionState::Muted) {
                        s.turns_while_muted += 1;
                    }
                }
                _ => {}
            }
        }
        if let (Some(from), Some((end, _))) = (since, run.actions.last()) {
            s.runs.push((from, *end));
        }
        s
    }

    /// A recorded barge-in into a reply the replay skipped as an orphan:
    /// it can't happen (nor be missed) in the replay.
    pub fn orphaned(&self, recorded: u64) -> bool {
        self.orphan_replies.iter().any(|&(a, b)| a <= recorded && recorded <= b)
    }

    /// For each recorded barge-in: the replay's barge-in from 2 s before it
    /// to `after_ms` after it, as its delay (ms, negative: earlier).
    pub fn against(&self, recorded: &[u64], after_ms: u64) -> Vec<(u64, Option<i64>)> {
        recorded
            .iter()
            .map(|&w| {
                let hit = self.barge_ins.iter().find(|&&b| b + 2_000 >= w && b <= w + after_ms);
                (w, hit.map(|&b| b as i64 - w as i64))
            })
            .collect()
    }

    /// Replay barge-ins not near any recorded one.
    pub fn extra_barge_ins(&self, recorded: &[u64], after_ms: u64) -> Vec<u64> {
        self.barge_ins.iter().copied().filter(|&b| !recorded.iter().any(|&w| b + 2_000 >= w && b <= w + after_ms)).collect()
    }

    /// One line: barge-ins against the recording, turns, long runs.
    pub fn line(&self, recorded: &[u64], after_ms: u64) -> String {
        let s = |ms: u64| format!("{:.1}", ms as f64 / 1000.0);
        let cuts: Vec<String> = self
            .against(recorded, after_ms)
            .iter()
            .map(|(w, d)| match d {
                Some(d) => format!("{}✓{:+.1}", s(*w), *d as f64 / 1000.0),
                None if self.orphaned(*w) => format!("{}∅", s(*w)),
                None => format!("{}✗", s(*w)),
            })
            .collect();
        let extra: Vec<String> = self.extra_barge_ins(recorded, after_ms).into_iter().map(s).collect();
        let long: Vec<String> = self.runs.iter().filter(|(a, b)| b - a >= 8_000).map(|(a, b)| format!("{}–{}", s(*a), s(*b))).collect();
        let orphans: Vec<String> = self.orphan_replies.iter().map(|r| s(r.0)).collect();
        format!(
            "cuts {} | extra [{}] | turns {} ({} words, {} muted) | runs≥8s [{}] | orphan replies [{}]",
            cuts.join(" "),
            extra.join(" "),
            self.turns.len(),
            self.turns.iter().map(|t| t.2).sum::<usize>(),
            self.turns_while_muted,
            long.join(" "),
            orphans.join(" ")
        )
    }
}

/// The level S at the end of a cold closed run (what the per-mic memory
/// would keep for the next session), or None.
pub fn remembered_level(data: &CaptureData, tuning: &Tuning, extend_cut_ms: u64) -> Result<Option<f32>, String> {
    let (canceller, vad) = super::real_dsp().ok_or("no ONNX Runtime for Silero")?;
    let run = replay_closed(data, canceller, true, vad, ClosedSetup { tuning: *tuning, speech_hint: None, extend_cut_ms })?;
    Ok(run.speech_end.filter(|s| s.1).map(|s| s.0))
}

/// `voice_replay capture DIR --closed [--profile P] [--set k=v]... [--hint DB|remember] [--extend MS] [--dump PREFIX]`.
pub fn cli(data: &CaptureData, args: &[String]) -> Result<(), String> {
    let tuning = super::tuning_arg(args)?;
    let extend_cut_ms = match super::arg_value(args, "--extend") {
        Some(v) => v.parse().map_err(|e| format!("--extend {v}: {e}"))?,
        None => 4_000,
    };
    let speech_hint = match super::arg_value(args, "--hint").as_deref() {
        None => None,
        Some("remember") => remembered_level(data, &tuning, extend_cut_ms)?,
        Some(v) => Some(v.parse::<f32>().map_err(|e| format!("--hint {v}: {e}"))?),
    };
    let (canceller, vad) = super::real_dsp().ok_or("no ONNX Runtime for Silero")?;
    let run = replay_closed(data, canceller, true, vad, ClosedSetup { tuning, speech_hint, extend_cut_ms })?;
    let sum = Summary::of(&run);
    let s = |ms: u64| format!("{:.2}", ms as f64 / 1000.0);
    println!(
        "closed replay: {} ({}), hint {}, cut replies extended {} ms; {} VAD frames differ from the recording",
        tuning.profile.name(),
        tuning.label,
        speech_hint.map_or("none (cold)".into(), |h| format!("{h:.1} dB")),
        extend_cut_ms,
        run.vad_mismatches
    );
    println!("{}", sum.line(&run.recorded_barge_ins, extend_cut_ms));
    for (w, d) in sum.against(&run.recorded_barge_ins, extend_cut_ms) {
        let what = match d {
            Some(d) => format!("fired {d:+} ms"),
            None if sum.orphaned(w) => "none: its reply is an orphan here".to_string(),
            None => "no barge-in".to_string(),
        };
        println!("  recorded barge-in {}: {what}", s(w));
    }
    for (w, onset) in &run.barge_ins {
        println!("  replay barge-in {} (onset {:.2} s)", s(*w), *onset as f64 / 16_000.0);
    }
    for (a, b) in &run.orphan_replies {
        println!("  recorded reply {}–{} skipped: the replay sent no turn for it to answer", s(*a), if *b == u64::MAX { "end".into() } else { s(*b) });
    }
    for (a, b) in &sum.runs {
        println!("  user_speaking {}–{} ({:.1} s)", s(*a), s(*b), (*b - *a) as f64 / 1000.0);
    }
    for (w, id, n) in &sum.turns {
        println!("  turn {id} at {}: {n} words", s(*w));
    }
    let path: Vec<String> = run.speech_after_turns.iter().map(|(w, db)| format!("{}:{db:.1}", s(*w))).collect();
    println!("  S after turns: {}", path.join(" "));
    println!(
        "  S at the end: {} over {} measured turns; {} turns sent while muted",
        run.speech_end.map_or("-".into(), |(db, m)| format!("{db:.1} dB (measured={m})")),
        run.measured_turns,
        sum.turns_while_muted
    );
    if let Some(prefix) = super::arg_value(args, "--dump") {
        std::fs::write(format!("{prefix}.inputs.jsonl"), super::inputs_jsonl(&data.trace.header, &run.inputs)).map_err(|e| e.to_string())?;
        std::fs::write(format!("{prefix}.actions.jsonl"), super::actions_jsonl(&run.actions)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// A speech level a sweep starts the capture from.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Hint {
    Cold,
    Db(f32),
    /// The level the same tuning's cold run ended at.
    Remember,
}

impl Hint {
    pub fn parse_list(v: &str) -> Result<Vec<Hint>, String> {
        v.split(',')
            .map(|h| match h {
                "cold" => Ok(Hint::Cold),
                "remember" => Ok(Hint::Remember),
                n => n.parse::<f32>().map(Hint::Db).map_err(|e| format!("--capture-hint {n}: {e}")),
            })
            .collect()
    }

    fn label(self, remembered: Option<f32>) -> String {
        match self {
            Hint::Cold => "cold".into(),
            Hint::Db(db) => format!("{db:.0}"),
            Hint::Remember => format!("mem {}", remembered.map_or("-".into(), |d| format!("{d:.1}"))),
        }
    }
}

/// Each tuning over the capture from each hint, on a pool: per tuning, one
/// [`Summary::line`] per hint.
pub fn sweep(data: &CaptureData, tunings: &[Tuning], hints: &[Hint], extend_cut_ms: u64) -> Result<Vec<Vec<String>>, String> {
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex;
    let next = AtomicUsize::new(0);
    type Lines = Result<Vec<String>, String>;
    let results: Mutex<Vec<Option<Lines>>> = Mutex::new((0..tunings.len()).map(|_| None).collect());
    let workers = std::thread::available_parallelism().map_or(8, |n| n.get());
    let one = |t: &Tuning| -> Result<Vec<String>, String> {
        let mut out = Vec::new();
        let mut cold_end = None;
        let run_from = |hint: Option<f32>| -> Result<ClosedRun, String> {
            let (canceller, vad) = super::real_dsp().ok_or("no ONNX Runtime for Silero")?;
            replay_closed(data, canceller, true, vad, ClosedSetup { tuning: *t, speech_hint: hint, extend_cut_ms })
        };
        for &h in hints {
            let hint = match h {
                Hint::Cold => None,
                Hint::Db(db) => Some(db),
                Hint::Remember => {
                    if cold_end.is_none() {
                        cold_end = Some(run_from(None)?.speech_end.filter(|s| s.1).map(|s| s.0));
                    }
                    cold_end.flatten()
                }
            };
            let run = run_from(hint)?;
            if h == Hint::Cold {
                cold_end = Some(run.speech_end.filter(|s| s.1).map(|s| s.0));
            }
            out.push(format!("{:<9} {}", h.label(hint), Summary::of(&run).line(&run.recorded_barge_ins, extend_cut_ms)));
        }
        Ok(out)
    };
    std::thread::scope(|s| {
        for _ in 0..workers.min(tunings.len()) {
            s.spawn(|| loop {
                let j = next.fetch_add(1, Ordering::Relaxed);
                let Some(t) = tunings.get(j) else { break };
                let r = one(t);
                results.lock().unwrap()[j] = Some(r);
            });
        }
    });
    results.into_inner().unwrap().into_iter().map(|r| r.expect("every job ran")).collect()
}

// ─── redacted fixtures ──────────────────────────────────────────────────────

/// Every transcribed word replaced by a placeholder token (`w<n>`, numbered
/// by first appearance; one token per word as the transcript assembly
/// compares them: letters and digits, lowercased), so a trace from a real
/// session can be committed: the timing, confidences and word identity
/// structure stay, the words don't.
#[derive(Debug, Default)]
pub struct Redactor {
    tokens: HashMap<String, String>,
}

impl Redactor {
    pub fn token(&mut self, word: &str) -> String {
        let key = crate::voice::transcript::norm(word);
        let n = self.tokens.len() + 1;
        self.tokens.entry(key).or_insert_with(|| format!("w{n}")).clone()
    }

    /// A text of words, word by word.
    pub fn text(&mut self, text: &str) -> String {
        text.split_whitespace().map(|w| self.token(w)).collect::<Vec<_>>().join(" ")
    }

    pub fn input(&mut self, input: &Input) -> Input {
        use crate::modules::stt::VoiceSttEvent;
        match input {
            Input::Stt(VoiceSttEvent::Results(r)) => {
                let mut r = r.clone();
                for w in &mut r.words {
                    w.word = self.token(&w.word);
                }
                r.transcript = self.text(&r.transcript);
                Input::Stt(VoiceSttEvent::Results(r))
            }
            other => other.clone(),
        }
    }

    pub fn action(&mut self, action: &Action) -> Action {
        match action {
            Action::Transcript { turn_id, text, is_final } => {
                Action::Transcript { turn_id: turn_id.clone(), text: self.text(text), is_final: *is_final }
            }
            Action::Turn { turn_id, text } => Action::Turn { turn_id: turn_id.clone(), text: self.text(text) },
            Action::End { reason, text, error } => Action::End { reason: *reason, text: text.as_deref().map(|t| self.text(t)), error: error.clone() },
            other => other.clone(),
        }
    }
}

/// A capture as a noisy-room fixture: the closed-loop replay's inputs under
/// `tuning` (cold), words redacted, and the actions recorded mode gives for
/// them. Errs unless those actions are the closed run's own, redacted the
/// same way (the words' identity is all the machine looks at).
pub fn fixture(data: &CaptureData, tuning: &Tuning, name: &str, extend_cut_ms: u64) -> Result<(String, String, ClosedRun), String> {
    let (canceller, vad) = super::real_dsp().ok_or("no ONNX Runtime for Silero")?;
    let run = replay_closed(data, canceller, true, vad, ClosedSetup { tuning: *tuning, speech_hint: None, extend_cut_ms })?;
    if run.vad_mismatches > 0 {
        return Err(format!("{} VAD frames differ from the recording", run.vad_mismatches));
    }
    let mut red = Redactor::default();
    let inputs: Vec<(u64, Input)> = run.inputs.iter().map(|(w, i)| (*w, red.input(i))).collect();
    let cfg = data.trace.config();
    let got = super::replay_recorded(&inputs, TurnConfig::for_tuning(cfg.mode, cfg.end_silence_ms, cfg.barge_in, tuning));
    let want: Vec<(u64, Action)> = run.actions.iter().map(|(w, a)| (*w, red.action(a))).collect();
    if let Some(d) = super::diff_actions(&want, &got) {
        return Err(format!("the redacted inputs replay differently: {d}"));
    }
    let h = &data.trace.header;
    let header = serde_json::json!({
        "k": "header",
        "fixture": name,
        "capture": data.dir.file_name().map(|f| f.to_string_lossy().to_string()),
        "mode": h["mode"],
        "end_silence_ms": h["end_silence_ms"],
        "barge_in": h["barge_in"],
        "noise_profile": tuning.profile.name(),
        "tuning": tuning.label,
        "recorded_as": h["noise_profile"],
        "recorded_app_version": h["app_version"],
        "extend_cut_ms": extend_cut_ms,
        "speech_hint": null,
        "orphan_replies": run.orphan_replies.iter().map(|r| r.0).collect::<Vec<_>>(),
        "made_by": "voice_replay fixture --write: the capture's closed-loop replay (replay/closed.rs), cold, recorded replies to turns it never sent skipped; transcript words redacted to w<n> tokens",
    });
    Ok((super::inputs_jsonl(&header, &inputs), super::actions_jsonl(&got), run))
}

/// `voice_replay fixture DIR NAME [--write]`: the noisy-room fixture for a
/// capture ([`fixture`]), written to `tests/fixtures/voice-replay/` or
/// checked against what is there.
pub fn cli_fixture(args: &[String]) -> Result<(), String> {
    let dir = args.first().ok_or("fixture DIR NAME")?;
    let name = args.get(1).ok_or("fixture DIR NAME")?;
    let data = CaptureData::load(std::path::Path::new(dir))?;
    let (inputs, actions, run) = fixture(&data, &Tuning::NOISY, name, 4_000)?;
    let out = super::fixtures_dir();
    let (ip, ap) = (out.join(format!("{name}.inputs.jsonl")), out.join(format!("{name}.noisy.actions.jsonl")));
    let sum = Summary::of(&run);
    println!("{name}: {} inputs, {} actions; {}", run.inputs.len(), run.actions.len(), sum.line(&run.recorded_barge_ins, 4_000));
    if args.iter().any(|a| a == "--write") {
        std::fs::write(&ip, inputs).map_err(|e| e.to_string())?;
        std::fs::write(&ap, actions).map_err(|e| e.to_string())?;
        println!("written: {} and {}", ip.display(), ap.display());
        return Ok(());
    }
    let want_i = super::Trace::parse(&std::fs::read_to_string(&ip).map_err(|e| e.to_string())?)?.inputs;
    let want_a = super::Trace::parse(&std::fs::read_to_string(&ap).map_err(|e| e.to_string())?)?.actions;
    let got_i = super::Trace::parse(&inputs)?.inputs;
    let got_a = super::Trace::parse(&actions)?.actions;
    match super::diff_inputs(&want_i, &got_i, 1e-6).or_else(|| super::diff_actions(&want_a, &got_a)) {
        None => println!("{name}: matches"),
        Some(d) => return Err(format!("{name}: {d}")),
    }
    Ok(())
}
