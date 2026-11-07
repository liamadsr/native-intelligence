//! Background-noise presets for chat voice ("Auto" / "Quiet room" / "Noisy
//! room").
//!
//! A preset is a [`Tuning`]: the turn machine's thresholds and timers, the
//! barge-in detector, and the noise mechanisms that only the noisy preset
//! uses (a near-field level gate, a word filter, a cap on one run, a barge-in
//! confirmation). Every one of those is an `Option` that is `None` under
//! [`Tuning::QUIET`], so the quiet preset is today's behaviour exactly.
//!
//! **Auto** ([`Tuning::AUTO`], noise design WP7) starts as the quiet room and
//! switches to the noisy room when it hears voices in the background
//! ([`AutoSwitch`]); the level machinery (N, S, near/far) runs from the first
//! frame so the switch has what it needs.
//!
//! The web picks the preset with `voice_start { noiseProfile }` (`"auto"`,
//! `"quiet"` or `"noisy"`); absent or unknown is quiet (an older web).
//! `voice_status { noiseProfiles }` lists what this desktop understands.

use super::SAMPLE_RATE;

/// Which background-noise preset a session runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NoiseProfile {
    /// "Quiet room": the 0.2.45 tuning, bit for bit.
    #[default]
    Quiet,
    /// "Noisy room": TV or people talking nearby.
    Noisy,
    /// "Auto": the quiet room until voices in the background are heard,
    /// then the noisy room ([`AutoSwitch`]).
    Auto,
}

impl NoiseProfile {
    /// `voice_status`'s `noiseProfiles`: every name `voice_start` accepts.
    pub const NAMES: [&'static str; 3] = ["quiet", "noisy", "auto"];

    pub fn name(self) -> &'static str {
        match self {
            NoiseProfile::Quiet => "quiet",
            NoiseProfile::Noisy => "noisy",
            NoiseProfile::Auto => "auto",
        }
    }

    /// The web's `noiseProfile`: `None` for a name this desktop doesn't know.
    pub fn from_name(name: &str) -> Option<Self> {
        match name.trim() {
            "quiet" => Some(NoiseProfile::Quiet),
            "noisy" => Some(NoiseProfile::Noisy),
            "auto" => Some(NoiseProfile::Auto),
            _ => None,
        }
    }

    /// Absent or unknown → quiet.
    pub fn parse(name: Option<&str>) -> Self {
        name.and_then(Self::from_name).unwrap_or_default()
    }

    pub fn tuning(self) -> &'static Tuning {
        match self {
            NoiseProfile::Quiet => &Tuning::QUIET,
            NoiseProfile::Noisy => &Tuning::NOISY,
            NoiseProfile::Auto => &Tuning::AUTO,
        }
    }
}

/// The turn machine's thresholds and timers ([`super::turn::TurnConfig`]
/// minus the user's own settings: mode, end silence, barge-in on/off).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TurnTuning {
    pub onset: f32,
    pub off: f32,
    pub min_speech_ms: u32,
    pub barge_in_ms: u32,
    pub onset_slack_ms: u32,
    pub finalize_timeout_ms: u64,
    pub finalize_forward_ms: u64,
    pub stop_wait_ready_ms: u64,
    pub stop_max_ms: u64,
    pub idle_ms: u64,
    pub reply_wait_ms: u64,
    pub overlap_soft_ms: u64,
    pub overlap_max_ms: u64,
    pub agent_quiet_grace_ms: u64,
    pub echo_guard_ms: u64,
    pub keep_words_s: f64,
}

/// The DSP thread's barge-in detector ([`super::detect::BargeInDetector`]).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BargeTuning {
    /// A run starts on a frame at or above this...
    pub onset: f32,
    /// ...continues while frames stay at or above this...
    pub off: f32,
    /// ...and fires after this long.
    pub sustain_ms: u32,
    /// `None`: firing cancels the speech at once (quiet). `Some`: firing
    /// holds it, and the turn machine confirms or resumes (noise design §2.2).
    pub confirm: Option<BargeConfirm>,
}

impl BargeTuning {
    pub fn sustain_samples(&self) -> u64 {
        self.sustain_ms as u64 * SAMPLE_RATE / 1000
    }
}

/// Hold → confirm → cut or resume (noise design §2.2). Not built yet (WP5):
/// every preset has `None`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BargeConfirm {
    /// Resume unless confirmed within this.
    pub window_ms: u64,
    /// Near speech needed after the hold...
    pub more_near_ms: u64,
    /// ...and either a filtered word, or this much near speech since onset.
    pub total_near_ms: u64,
    /// This much continuous far (not near) audio rejects it early.
    pub reject_far_ms: u64,
}

/// The near-field level gate (noise design §2.1).
///
/// L is a VAD frame's level (dBFS), N the noise floor, S the user's speech
/// level. A frame is onset-near when `L ≥ max(S − onset_below_speech_db,
/// N + onset_above_floor_db)` (before the first measured turn, the floor
/// margin is `bootstrap_above_floor_db`), sustain-near with the sustain
/// margins. Only near frames are the user; the rest is the room (a TV,
/// people nearby, a fan) and counts as silence.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LevelGate {
    pub onset_below_speech_db: f32,
    pub onset_above_floor_db: f32,
    pub sustain_below_speech_db: f32,
    pub sustain_above_floor_db: f32,
    /// A barge-in run starts on a frame at most this far under S (before a
    /// measured turn, the bootstrap margin)...
    pub barge_start_below_speech_db: f32,
    /// ...and goes on while frames stay at most this far under it (both
    /// with sustain-near's margin over the floor).
    pub barge_below_speech_db: f32,
    /// S before any measured turn (and after a device change).
    pub bootstrap_speech_db: f32,
    /// Until the first accepted turn, onset-near needs this over the floor...
    pub bootstrap_above_floor_db: f32,
    /// ...and only this under S (wider than `onset_below_speech_db`: a
    /// speaker softer than the bootstrap must still get the first turn,
    /// which measures them).
    pub bootstrap_below_speech_db: f32,
    /// A turn starts on `confirm_frames` onset-near frames at or above the
    /// onset probability among the last `confirm_window` (backdated to the
    /// first of them).
    pub confirm_frames: u32,
    pub confirm_window: u32,
    /// ...and, once a turn has measured S, the loudest of them within this
    /// of S (a user's syllables peak near their level; a TV that only just
    /// reaches the onset margin doesn't).
    pub confirm_peak_below_speech_db: f32,
    /// The level the gate judges is the energy mean of this many VAD frames
    /// (the frame and the ones before it): syllable dips don't make the
    /// user far, and a TV's short peaks don't make it near.
    pub smooth_frames: u32,
    /// The smoothing only holds a level up, never delays its rise: the gate
    /// judges `max(frame, mean)` (fast attack, slow release), so a turn's
    /// first syllable is near at once.
    pub fast_attack: bool,
    /// A confirmed onset (or a barge-in's) reaches back over the
    /// sustain-near frames right before it, at most this far, so a soft
    /// first word isn't clipped.
    pub backdate_ms: u32,
    /// ...across pauses (far frames) of up to this long.
    pub backdate_gap_ms: u32,
    /// Once a silence has started, a sustain-near frame that isn't onset-near
    /// holds the countdown where it is (`true`) or counts as silence
    /// (`false`: a TV just under the onset margin can't hold a turn open).
    pub hold_on_sustain: bool,
    /// After each sent turn, S moves toward this percentile (0..=1) of the
    /// turn's sustain-near frame levels...
    pub speech_percentile: f32,
    /// ...by this fraction of the difference...
    pub speech_rate: f32,
    /// ...at most this far up (from the bootstrap)...
    pub speech_up_db: f32,
    /// ...or this far once a turn has measured S (one loud turn, the user
    /// raising their voice over the TV, can't lift S far above their usual
    /// level)...
    pub measured_up_db: f32,
    /// ...or this far down (a TV turn that slips through can't drag S
    /// down fast)...
    pub speech_down_db: f32,
    /// ...and only from a turn at most this far under S once a turn has
    /// measured it (one further down is the room, not the user: following
    /// it would let the room in)...
    pub speech_down_within_db: f32,
    /// ...unless this many sent turns in a row were that far under it: then
    /// S is too high for the user (a loud turn lifted it, or a TV turn did
    /// before the user spoke), and each of them moves it down the slow
    /// `speech_down_db` step, so the gate can't stay shut on the user.
    pub speech_recover_turns: u32,
    /// When turns lifted a measured S (a loud turn) and then this much
    /// speech (at or above the onset probability, and onset-near at the
    /// level S had before the lift) went by unconfirmed while listening, S
    /// steps `relax_step_db` back toward that level, never below it: the
    /// way back down when the user's turns no longer get through at all.
    /// It never takes S under a level the user's own turns set, so a room
    /// the gate kept out before the lift stays out. 0: off.
    pub relax_missed_ms: u32,
    pub relax_step_db: f32,
    /// ...and stays within this.
    pub speech_min_db: f32,
    pub speech_max_db: f32,
}

impl LevelGate {
    /// The frame is loud enough, near enough, to start the user's turn.
    /// `measured`: a turn has set S (otherwise the bootstrap floor margin).
    pub fn onset_near(&self, level_db: f32, floor_db: f32, speech_db: f32, measured: bool) -> bool {
        let (below, above) = if measured {
            (self.onset_below_speech_db, self.onset_above_floor_db)
        } else {
            (self.bootstrap_below_speech_db, self.bootstrap_above_floor_db)
        };
        level_db >= (speech_db - below).max(floor_db + above)
    }

    /// The frame is loud enough to keep the user's turn going (and to count
    /// toward barge-in, and to vouch for a word).
    pub fn sustain_near(&self, level_db: f32, floor_db: f32, speech_db: f32) -> bool {
        level_db >= (speech_db - self.sustain_below_speech_db).max(floor_db + self.sustain_above_floor_db)
    }

    /// The frame is loud enough to start a barge-in run, and to go on with
    /// one.
    pub fn barge_near(&self, level_db: f32, floor_db: f32, speech_db: f32, measured: bool) -> (bool, bool) {
        let start = if measured { self.barge_start_below_speech_db } else { self.bootstrap_below_speech_db };
        let floor = floor_db + self.sustain_above_floor_db;
        (level_db >= (speech_db - start).max(floor), level_db >= (speech_db - self.barge_below_speech_db).max(floor))
    }

    /// S after a sent turn whose near frames put the user at `turn_db`
    /// (`measured`: a turn has set S before). `low_turns` counts the sent
    /// turns in a row more than `speech_down_within_db` under S (this one
    /// included when it is); the caller keeps it.
    pub fn adapt(&self, speech_db: f32, turn_db: f32, measured: bool, low_turns: &mut u32) -> f32 {
        if measured && turn_db < speech_db - self.speech_down_within_db {
            *low_turns += 1;
            if *low_turns < self.speech_recover_turns.max(1) {
                return speech_db;
            }
        } else {
            *low_turns = 0;
        }
        let up = if measured { self.measured_up_db } else { self.speech_up_db };
        let step = (self.speech_rate * (turn_db - speech_db)).clamp(-self.speech_down_db, up);
        (speech_db + step).clamp(self.speech_min_db, self.speech_max_db)
    }

    /// The `speech_percentile` of `levels` (None when empty).
    pub fn turn_level(&self, levels: &mut [f32]) -> Option<f32> {
        if levels.is_empty() {
            return None;
        }
        levels.sort_by(f32::total_cmp);
        let i = (self.speech_percentile * (levels.len() - 1) as f32).round() as usize;
        Some(levels[i.min(levels.len() - 1)])
    }
}

/// The level the gate judges ([`LevelGate::smooth_frames`]): the energy
/// mean of the last few VAD frames' levels.
#[derive(Debug, Clone, Default)]
pub struct GateLevel {
    recent: std::collections::VecDeque<f32>,
}

impl GateLevel {
    /// One frame at `level_db`: the mean of it and the `frames − 1` before
    /// (with [`LevelGate::fast_attack`], never below the frame's own).
    pub fn push(&mut self, level_db: f32, gate: &LevelGate) -> f32 {
        let mean = self.mean(level_db, gate.smooth_frames);
        if gate.fast_attack {
            mean.max(level_db)
        } else {
            mean
        }
    }

    fn mean(&mut self, level_db: f32, frames: u32) -> f32 {
        let n = frames.max(1) as usize;
        self.recent.push_back(level_db);
        while self.recent.len() > n {
            self.recent.pop_front();
        }
        let power: f64 = self.recent.iter().map(|l| 10f64.powf(*l as f64 / 10.0)).sum::<f64>() / self.recent.len() as f64;
        if power > 0.0 {
            (10.0 * power.log10()) as f32
        } else {
            level_db
        }
    }

    /// After a gap (mute): no history.
    pub fn clear(&mut self) {
        self.recent.clear();
    }
}

/// Drop words no near frame vouches for (noise design §2.3): a word is kept
/// only if a frame at or above the off probability, its own (unsmoothed)
/// level at most `below_speech_db` under S (and sustain-near's margin over
/// the floor), overlaps its span widened by `slack_s` on each side.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WordFilter {
    /// A word's span is widened by this on each side.
    pub slack_s: f64,
    pub below_speech_db: f32,
    /// Dictation's margin instead: no turn measures S there (it is the
    /// bootstrap, or the level this mic remembers from conversations), so a
    /// dictating user's softer words sit further under it (Liam's
    /// dictation captures: their words to S − 11, the TV's from S − 14).
    pub dictation_below_speech_db: f32,
}

impl WordFilter {
    /// The frame at `level_db` can vouch for a word (`dictation`: with
    /// dictation's margin).
    pub fn vouches(&self, level_db: f32, floor_db: f32, speech_db: f32, gate: &LevelGate, dictation: bool) -> bool {
        let below = if dictation { self.dictation_below_speech_db } else { self.below_speech_db };
        level_db >= (speech_db - below).max(floor_db + gate.sustain_above_floor_db)
    }
}

/// Auto's switch from the quiet room to the noisy room (noise design WP7).
///
/// A frame is **far speech** when S is known (remembered for this mic, or
/// measured by a turn heard mostly within its reach, `known_share`: the
/// bootstrap says nothing about the user, and a soft user sits more than
/// `far_below_speech_db` under it), its VAD probability
/// is at least `far_prob`, its level (the gate's, [`GateLevel`]) is more
/// than `far_below_speech_db` under S and at least `far_above_floor_db` over
/// the noise floor N, and nothing says it is the user or the agent:
/// - not within `near_mask_ms` after (or `near_mask_before_ms` before) an
///   onset-near frame at the onset probability (the user talking: a
///   confirmed user run, its soft edges included);
/// - not while the agent is audible, unless the echo mode is `headphones`
///   (on speakers its residual echo is soft speech too);
/// - not within the echo guard after the agent stops.
///
/// The session switches when far speech fills `ratio` of the last
/// `window_ms` of audio, or `burst_ratio` of the last `burst_ms` (0: off),
/// or the floor reaches `floor_db` (None: off). The switch lands when
/// nobody holds the floor (listening, the agent speaking), never inside a
/// run. It goes back to the quiet room after `revert_ms` with no far speech
/// (0: never), once per session: a second switch is for good, so it never
/// flaps.
///
/// Barge-in: before the switch, the noisy room's gated barge-in applies as
/// soon as S is known (`barge_when_known`: remembered for this mic, or
/// measured by a turn): a false cut is the worst symptom. With S unknown it
/// is the quiet room's until then.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AutoSwitch {
    pub far_prob: f32,
    pub far_below_speech_db: f32,
    pub far_above_floor_db: f32,
    pub near_mask_ms: u32,
    pub near_mask_before_ms: u32,
    pub window_ms: u32,
    pub ratio: f32,
    pub burst_ms: u32,
    pub burst_ratio: f32,
    pub floor_db: Option<f32>,
    pub revert_ms: u64,
    pub barge_when_known: bool,
    /// S counts as known for far speech once this mic remembers it, or once
    /// a sent turn had at least this share of its speech frames (VAD at the
    /// onset) sustain-near: a turn mostly under S's reach (a soft user under
    /// the bootstrap) only measured its loudest syllables, so S sits well
    /// over the user and their own speech would read as far.
    pub known_share: f32,
}

/// One preset, whole.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tuning {
    pub profile: NoiseProfile,
    /// A stable label for logs and replay goldens.
    pub label: &'static str,
    pub turn: TurnTuning,
    pub barge: BargeTuning,
    pub gate: Option<LevelGate>,
    pub word_filter: Option<WordFilter>,
    /// A hard cap on one speech run.
    pub max_run_ms: Option<u64>,
    /// Auto ([`AutoSwitch`]): the session starts as [`Tuning::QUIET`] and
    /// switches to the rest of this tuning (its turn thresholds, barge-in,
    /// gate, word filter and run cap). `None`: this tuning from the start.
    pub auto: Option<AutoSwitch>,
}

impl Tuning {
    /// **"Quiet room": a faithful snapshot of desktop 0.2.45 (`94316dd`),
    /// label `quiet-2026-09-26`.** Do not change a value here: a changed
    /// quiet room is a new preset. `profile::tests` pins every field to these
    /// literals and the voice replay goldens pin the behaviour
    /// (`tests/fixtures/voice-replay/`).
    ///
    /// Turn machine (was `TurnConfig::new`, turn.rs:116-137):
    ///
    /// | Setting | Value |
    /// |---|---|
    /// | onset | 0.5 |
    /// | off | 0.35 |
    /// | min_speech_ms | 256 |
    /// | barge_in_ms | 320 |
    /// | onset_slack_ms | 300 |
    /// | finalize_timeout_ms | 1500 |
    /// | finalize_forward_ms | 3000 |
    /// | stop_wait_ready_ms | 3000 |
    /// | stop_max_ms | 4500 |
    /// | idle_ms | 300000 |
    /// | reply_wait_ms | 180000 |
    /// | overlap_soft_ms | 3000 |
    /// | overlap_max_ms | 8000 |
    /// | agent_quiet_grace_ms | 300 |
    /// | echo_guard_ms | 250 |
    /// | keep_words_s | 30.0 |
    ///
    /// - end_silence_ms: the user's setting, default 700, clamped 200..=3000
    ///   (the web offers 500 / 700 / 1200). bargeIn: the user's, default on.
    /// - No level gate, no word filter, no run cap, no barge confirmation.
    ///
    /// Barge-in detector (was `BargeInDetector::default`, detect.rs:180-184):
    /// onset 0.65, off 0.5, sustain 320 ms (5120 samples); firing calls
    /// `cancel_speech()` at once.
    ///
    /// Shared by every preset, recorded here for the snapshot:
    ///
    /// | Echo tracker (detect.rs) | Value |
    /// |---|---|
    /// | HALF_DUPLEX_AFTER_MS | 8000 |
    /// | FAR_END_ACTIVE_RMS | 0.003 |
    /// | ERL_REF_RMS | 0.02 |
    /// | NO_PATH_ERL_DB | -10 |
    /// | ECHO_PATH_ERL_DB | 3 |
    /// | NO_PATH_AFTER_MS | 4000 |
    ///
    /// - Converged = ERLE ≥ 6 dB held for 1 s; barge-in only in `cancelling`
    ///   or `headphones`.
    /// - aec3 =0.4.0, `AecTuning::Voice` (stock suppressor), HPF on, NS off.
    /// - Silero v6.2.3 16k op15, 512-sample frames (intra/inter threads 1);
    ///   earshot 1.2.2 fallback, 256-sample frames.
    /// - DSP step 5 ms, AEC frame 160 samples, levels at 15 Hz.
    /// - Transcript `DUP_WINDOW_S` 0.05.
    pub const QUIET: Tuning = Tuning {
        profile: NoiseProfile::Quiet,
        label: "quiet-2026-09-26",
        turn: TurnTuning {
            onset: 0.5,
            off: 0.35,
            min_speech_ms: 256,
            barge_in_ms: 320,
            onset_slack_ms: 300,
            finalize_timeout_ms: 1_500,
            finalize_forward_ms: 3_000,
            stop_wait_ready_ms: 3_000,
            stop_max_ms: 4_500,
            idle_ms: 5 * 60 * 1_000,
            reply_wait_ms: 3 * 60 * 1_000,
            overlap_soft_ms: 3_000,
            overlap_max_ms: 8_000,
            agent_quiet_grace_ms: 300,
            echo_guard_ms: 250,
            keep_words_s: 30.0,
        },
        barge: BargeTuning { onset: 0.65, off: 0.5, sustain_ms: 320, confirm: None },
        gate: None,
        word_filter: None,
        max_run_ms: None,
        auto: None,
    };

    /// **"Noisy room"**: TV or people talking nearby (noise design §1b,
    /// tuned on the replay harness's synthetic scenes). Everything not
    /// listed is the quiet room's; end silence and barge-in stay the user's.
    ///
    /// - Turn VAD onset 0.6 / off 0.45 (Silero's 0.15 hysteresis), minimum
    ///   speech 400 ms of *near* frames, onset slack 200 ms.
    /// - The level gate ([`LevelGate`]): only frames near the user's own
    ///   level start, hold open or extend a turn; far speech is silence.
    /// - The word filter ([`WordFilter`]): words no near frame vouches for
    ///   are dropped from the turn.
    /// - A run lasts at most 30 s.
    /// - Barge-in: onset 0.7, off 0.55, 400 ms of sustain-near frames; it
    ///   still cancels at once (hold → confirm is WP5).
    pub const NOISY: Tuning = Tuning {
        profile: NoiseProfile::Noisy,
        label: "noisy-wp4-2026-09-26",
        turn: TurnTuning { onset: 0.6, off: 0.45, min_speech_ms: 400, onset_slack_ms: 200, ..Tuning::QUIET.turn },
        barge: BargeTuning { onset: 0.7, off: 0.55, sustain_ms: 320, confirm: None },
        gate: Some(LevelGate {
            onset_below_speech_db: 6.0,
            onset_above_floor_db: 9.0,
            sustain_below_speech_db: 11.0,
            sustain_above_floor_db: 6.0,
            barge_start_below_speech_db: 10.0,
            barge_below_speech_db: 16.0,
            bootstrap_speech_db: -32.0,
            bootstrap_above_floor_db: 12.0,
            bootstrap_below_speech_db: 8.0,
            confirm_frames: 3,
            confirm_window: 5,
            confirm_peak_below_speech_db: 30.0,
            smooth_frames: 6,
            fast_attack: true,
            backdate_ms: 1_000,
            backdate_gap_ms: 500,
            hold_on_sustain: true,
            speech_percentile: 0.9,
            speech_rate: 0.8,
            speech_up_db: 10.0,
            measured_up_db: 6.0,
            speech_down_db: 1.5,
            speech_down_within_db: 3.0,
            speech_recover_turns: 2,
            relax_missed_ms: 2_000,
            relax_step_db: 3.0,
            speech_min_db: -50.0,
            speech_max_db: -10.0,
        }),
        word_filter: Some(WordFilter { slack_s: 0.08, below_speech_db: 7.0, dictation_below_speech_db: 12.0 }),
        max_run_ms: Some(30_000),
        auto: None,
    };

    /// **"Auto"** (the web's default): [`Tuning::QUIET`] until voices in the
    /// background are heard, then [`Tuning::NOISY`] ([`AutoSwitch`], tuned on
    /// the replay harness: Liam's TV captures and the synthetic scenes).
    pub const AUTO: Tuning = Tuning {
        profile: NoiseProfile::Auto,
        label: "auto-wp7-2026-09-26",
        auto: Some(AutoSwitch {
            far_prob: 0.5,
            far_below_speech_db: 10.0,
            far_above_floor_db: 6.0,
            near_mask_ms: 1_000,
            near_mask_before_ms: 500,
            window_ms: 10_000,
            ratio: 0.1,
            burst_ms: 0,
            burst_ratio: 0.6,
            floor_db: None,
            revert_ms: 120_000,
            barge_when_known: true,
            known_share: 0.7,
        }),
        ..Tuning::NOISY
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::detect::{self, BargeInDetector};
    use crate::voice::turn::{Mode, TurnConfig, FINALIZE_FORWARD_MS, STOP_MAX_MS};

    /// The quiet room is 0.2.45, literal by literal (noise design §1a).
    #[test]
    fn quiet_is_the_0_2_45_snapshot() {
        let q = Tuning::QUIET;
        assert_eq!(q.profile, NoiseProfile::Quiet);
        assert_eq!(q.label, "quiet-2026-09-26");
        let t = q.turn;
        assert_eq!(t.onset, 0.5);
        assert_eq!(t.off, 0.35);
        assert_eq!(t.min_speech_ms, 256);
        assert_eq!(t.barge_in_ms, 320);
        assert_eq!(t.onset_slack_ms, 300);
        assert_eq!(t.finalize_timeout_ms, 1500);
        assert_eq!(t.finalize_forward_ms, 3000);
        assert_eq!(t.stop_wait_ready_ms, 3000);
        assert_eq!(t.stop_max_ms, 4500);
        assert_eq!(t.idle_ms, 300_000);
        assert_eq!(t.reply_wait_ms, 180_000);
        assert_eq!(t.overlap_soft_ms, 3000);
        assert_eq!(t.overlap_max_ms, 8000);
        assert_eq!(t.agent_quiet_grace_ms, 300);
        assert_eq!(t.echo_guard_ms, 250);
        assert_eq!(t.keep_words_s, 30.0);
        let b = q.barge;
        assert_eq!(b.onset, 0.65);
        assert_eq!(b.off, 0.5);
        assert_eq!(b.sustain_ms, 320);
        assert_eq!(b.sustain_samples(), 5120);
        assert_eq!(b.confirm, None);
        assert_eq!(q.gate, None);
        assert_eq!(q.word_filter, None);
        assert_eq!(q.max_run_ms, None);
        // The constants the turn machine names elsewhere agree.
        assert_eq!(FINALIZE_FORWARD_MS, 3000);
        assert_eq!(STOP_MAX_MS, 4500);
    }

    /// The shared pieces the snapshot records (not part of a preset).
    #[test]
    fn the_shared_constants_are_the_snapshot_ones() {
        assert_eq!(detect::HALF_DUPLEX_AFTER_MS, 8000);
        assert_eq!(detect::FAR_END_ACTIVE_RMS, 0.003);
        assert_eq!(detect::ERL_REF_RMS, 0.02);
        assert_eq!(detect::NO_PATH_ERL_DB, -10.0);
        assert_eq!(detect::ECHO_PATH_ERL_DB, 3.0);
        assert_eq!(detect::NO_PATH_AFTER_MS, 4000);
        assert_eq!(crate::audio::aec::AEC_FRAME, 160);
        assert_eq!(crate::voice::silero::FRAME, 512);
        assert_eq!(crate::voice::transcript::DUP_WINDOW_S, 0.05);
        assert_eq!(crate::voice::dsp::STEP_INTERVAL.as_millis(), 5);
        assert_eq!(crate::voice::turn::DEFAULT_END_SILENCE_MS, 700);
    }

    #[test]
    fn turn_config_new_is_the_quiet_room() {
        for mode in [Mode::Conversation, Mode::Dictation] {
            for (es, bi) in [(700, true), (500, false), (10, true), (99_999, false)] {
                let a = TurnConfig::new(mode, es, bi);
                let b = TurnConfig::for_profile(mode, es, bi, NoiseProfile::Quiet);
                assert_eq!(format!("{a:?}"), format!("{b:?}"));
                assert_eq!(a.profile, NoiseProfile::Quiet);
            }
        }
        let c = TurnConfig::new(Mode::Conversation, 700, true);
        let t = Tuning::QUIET.turn;
        assert_eq!(
            (c.onset, c.off, c.min_speech_ms, c.barge_in_ms, c.onset_slack_ms),
            (t.onset, t.off, t.min_speech_ms, t.barge_in_ms, t.onset_slack_ms)
        );
        assert_eq!(
            (c.finalize_timeout_ms, c.finalize_forward_ms, c.stop_wait_ready_ms, c.stop_max_ms, c.idle_ms, c.reply_wait_ms),
            (t.finalize_timeout_ms, t.finalize_forward_ms, t.stop_wait_ready_ms, t.stop_max_ms, t.idle_ms, t.reply_wait_ms)
        );
        assert_eq!(
            (c.overlap_soft_ms, c.overlap_max_ms, c.agent_quiet_grace_ms, c.echo_guard_ms, c.keep_words_s),
            (t.overlap_soft_ms, t.overlap_max_ms, t.agent_quiet_grace_ms, t.echo_guard_ms, t.keep_words_s)
        );
        assert_eq!((c.gate, c.word_filter, c.max_run_ms), (None, None, None));
    }

    #[test]
    fn the_default_barge_in_detector_is_the_quiet_one() {
        let d = BargeInDetector::default();
        let q = BargeInDetector::for_profile(NoiseProfile::Quiet);
        assert_eq!((d.onset, d.off, d.sustain_samples), (0.65, 0.5, 5120));
        assert_eq!((q.onset, q.off, q.sustain_samples), (d.onset, d.off, d.sustain_samples));
    }

    #[test]
    fn names_parse_and_anything_else_is_quiet() {
        assert_eq!(NoiseProfile::parse(Some("quiet")), NoiseProfile::Quiet);
        assert_eq!(NoiseProfile::parse(Some("noisy")), NoiseProfile::Noisy);
        assert_eq!(NoiseProfile::parse(Some(" noisy ")), NoiseProfile::Noisy);
        assert_eq!(NoiseProfile::parse(Some("auto")), NoiseProfile::Auto);
        assert_eq!(NoiseProfile::parse(Some("concert")), NoiseProfile::Quiet);
        assert_eq!(NoiseProfile::parse(Some("")), NoiseProfile::Quiet);
        assert_eq!(NoiseProfile::parse(None), NoiseProfile::Quiet, "an older web sends none");
        for p in [NoiseProfile::Quiet, NoiseProfile::Noisy, NoiseProfile::Auto] {
            assert_eq!(NoiseProfile::from_name(p.name()), Some(p));
            assert_eq!(p.tuning().profile, p);
        }
        assert_eq!(NoiseProfile::NAMES, ["quiet", "noisy", "auto"]);
    }

    /// Auto switches to the noisy room, whole; the quiet room and the noisy
    /// room have no switch. Its turn machine starts as the quiet room.
    #[test]
    fn auto_is_the_noisy_room_behind_a_switch() {
        let a = Tuning::AUTO;
        assert_eq!(a.profile, NoiseProfile::Auto);
        assert_eq!((Tuning::QUIET.auto, Tuning::NOISY.auto), (None, None));
        assert_eq!(Tuning { profile: NoiseProfile::Noisy, label: Tuning::NOISY.label, auto: None, ..a }, Tuning::NOISY);
        let sw = a.auto.expect("the switch");
        assert!(sw.ratio > 0.0 && sw.ratio <= 1.0 && sw.window_ms >= 5_000);
        assert!(sw.far_below_speech_db >= a.gate.unwrap().onset_below_speech_db, "far is further under S than onset-near");
        assert!(sw.revert_ms >= 60_000, "reverts only after a long quiet");
        assert!(sw.barge_when_known);
        for mode in [Mode::Conversation, Mode::Dictation] {
            let c = TurnConfig::for_profile(mode, 700, true, NoiseProfile::Auto);
            let q = TurnConfig::new(mode, 700, true);
            assert_eq!((c.onset, c.off, c.min_speech_ms, c.onset_slack_ms), (q.onset, q.off, q.min_speech_ms, q.onset_slack_ms));
            assert_eq!((c.gate, c.word_filter, c.max_run_ms), (None, None, None));
            let auto = c.auto.expect("auto");
            assert_eq!((auto.noisy, Some(auto.gate), auto.word_filter), (Tuning::NOISY.turn, Tuning::NOISY.gate, Tuning::NOISY.word_filter));
            assert_eq!(auto.quiet, Tuning::QUIET.turn);
        }
        assert!(TurnConfig::for_profile(Mode::Conversation, 700, true, NoiseProfile::Noisy).auto.is_none());
    }

    /// The noisy room differs from the quiet one only where the noise design
    /// says, and every noise mechanism is on.
    #[test]
    fn noisy_is_the_quiet_room_plus_the_noise_mechanisms() {
        let (n, q) = (Tuning::NOISY, Tuning::QUIET);
        assert_eq!(n.profile, NoiseProfile::Noisy);
        assert_ne!(n.label, q.label);
        let t = TurnTuning { onset: q.turn.onset, off: q.turn.off, min_speech_ms: q.turn.min_speech_ms, onset_slack_ms: q.turn.onset_slack_ms, ..n.turn };
        assert_eq!(t, q.turn, "only onset, off, min speech and onset slack differ");
        assert!(n.turn.onset - n.turn.off >= 0.15 - 1e-6);
        assert!(n.barge.onset >= n.turn.onset && n.barge.sustain_ms >= q.barge.sustain_ms);
        assert_eq!(n.barge.confirm, None, "hold → confirm is WP5");
        let g = n.gate.expect("the level gate");
        // Onset-near is stricter than sustain-near, so a frame that starts a
        // turn always keeps it going.
        assert!(g.onset_below_speech_db <= g.sustain_below_speech_db);
        assert!(g.barge_start_below_speech_db <= g.barge_below_speech_db);
        assert!(g.onset_above_floor_db >= g.sustain_above_floor_db);
        assert!(g.bootstrap_above_floor_db >= g.onset_above_floor_db);
        assert!(g.confirm_frames >= 1 && g.confirm_frames <= g.confirm_window);
        assert!(n.word_filter.is_some());
        assert_eq!(n.max_run_ms, Some(30_000));
        let _ = NoiseProfile::Noisy.tuning();
    }

    #[test]
    fn the_gate_is_near_the_user_and_far_from_the_room() {
        let g = Tuning::NOISY.gate.unwrap();
        let (floor, speech) = (-60.0, -24.0);
        // The user at their level: near.
        assert!(g.onset_near(-22.0, floor, speech, true));
        assert!(g.sustain_near(-22.0, floor, speech));
        // 10 dB under: still holds a turn, can't start one.
        assert!(!g.onset_near(-34.0, floor, speech, true));
        assert!(g.sustain_near(-34.0, floor, speech));
        // A TV 20 dB under the user: far.
        assert!(!g.sustain_near(-44.0, floor, speech));
        // A loud floor raises the bar.
        assert!(!g.onset_near(-30.0, -38.0, speech, true));
        assert!(!g.sustain_near(-33.0, -38.0, speech));
        // Before the first turn S is only the bootstrap: a wider margin
        // under it (a softer speaker must get a first turn)...
        assert!(!g.onset_near(-47.0, floor, -40.0, true));
        assert!(g.onset_near(-47.0, floor, -40.0, false));
        // ...and a wider one over the floor.
        assert!(g.onset_near(-45.0, -55.0, -50.0, true));
        assert!(!g.onset_near(-45.0, -55.0, -50.0, false));
        // Barge-in starts nearer the user than it goes on.
        assert_eq!(g.barge_near(-33.0, floor, speech, true), (true, true));
        assert_eq!(g.barge_near(-36.0, floor, speech, true), (false, true));
        assert_eq!(g.barge_near(-41.0, floor, speech, true), (false, false));
    }

    /// Fast attack: a rise is judged at once, a dip only as the mean.
    #[test]
    fn the_gate_level_rises_at_once_and_falls_slowly() {
        let mut g = Tuning::NOISY.gate.unwrap();
        g.smooth_frames = 2;
        let mut slow = GateLevel::default();
        let mut fast = GateLevel::default();
        let mut s = g;
        s.fast_attack = false;
        g.fast_attack = true;
        assert_eq!(slow.push(-70.0, &s), -70.0);
        assert_eq!(fast.push(-70.0, &g), -70.0);
        assert!(slow.push(-20.0, &s) < -22.0, "the mean lags the rise");
        assert_eq!(fast.push(-20.0, &g), -20.0);
        let dip = fast.push(-40.0, &g);
        assert!(dip > -24.0 && dip < -20.0, "{dip}");
    }

    #[test]
    fn speech_level_rises_fast_and_falls_slowly_within_bounds() {
        let g = Tuning::NOISY.gate.unwrap();
        let adapt = |s: f32, t: f32, m: bool| g.adapt(s, t, m, &mut 0);
        assert!((adapt(-32.0, -20.0, false) + 22.4).abs() < 1e-4, "most of the way up from the bootstrap");
        assert_eq!(adapt(-40.0, -20.0, false), -30.0, "+10 dB at most on the first turn");
        assert_eq!(adapt(-40.0, -20.0, true), -34.0, "+6 dB at most per turn once measured");
        assert_eq!(adapt(-32.0, -45.0, false), -33.5, "−1.5 dB at most per turn");
        assert_eq!(adapt(-32.0, -34.0, true), -33.5);
        assert_eq!(adapt(-32.0, -38.0, true), -32.0, "the room, not the user");
        assert_eq!(adapt(-22.0, -31.0, true), -22.0, "a turn this far under a measured S is the room");
        assert_eq!(adapt(-12.0, 0.0, true), -10.0);
        assert_eq!(adapt(-49.5, -80.0, false), -50.0);
    }

    /// One loud turn lifts S; the user's usual turns, now more than
    /// `speech_down_within_db` under it, bring it back: the first is taken
    /// for the room, from the second on each one moves S down a slow step.
    #[test]
    fn speech_level_comes_back_down_after_turns_in_a_row_under_it() {
        let g = Tuning::NOISY.gate.unwrap();
        let usual = -24.0;
        let mut low = 0;
        // The user raises their voice over the TV for one turn: S goes up
        // +6, not +8 (and before the cap, +10).
        let mut s = g.adapt(usual, usual + 10.0, true, &mut low);
        assert_eq!(s, usual + 6.0);
        let mut path = Vec::new();
        for _ in 0..4 {
            s = g.adapt(s, usual, true, &mut low);
            path.push(s);
        }
        assert_eq!(path, vec![usual + 6.0, usual + 4.5, usual + 3.0, usual + 1.5], "then within reach: the usual step");
        assert_eq!(low, 0, "a turn within reach ends the streak");
        s = g.adapt(s, usual, true, &mut low);
        assert!((s - (usual + 0.3)).abs() < 1e-4, "{s}");
        // One TV turn that slips through is still the room; one of the
        // user's own in between starts the count again.
        let (mut low, s) = (0, -22.0);
        assert_eq!(g.adapt(s, -35.0, true, &mut low), s);
        assert_eq!(g.adapt(s, -23.0, true, &mut low), s - 0.8);
        assert_eq!(low, 0);
        assert_eq!(g.adapt(s, -35.0, true, &mut low), s);
        assert_eq!(low, 1);
        let mut v: Vec<f32> = (0..=100).map(|i| -(i as f32)).collect();
        assert_eq!(g.turn_level(&mut v), Some(-10.0));
        assert_eq!(g.turn_level(&mut []), None);
    }
}
