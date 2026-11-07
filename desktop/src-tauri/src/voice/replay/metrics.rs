//! The noise design's §3.3 measures, from a synthetic run and its ground
//! truth (who said which word, when; when the agent spoke).

use std::collections::{HashMap, HashSet};

use super::sim::{Mix, SimRun, Who};
use crate::voice::events::{NoiseMode, SessionState};
use crate::voice::trace::Input;
use crate::voice::turn::Action;

/// A user utterance of at least this long, started while the agent was
/// audible, should barge in.
pub const TRUE_BARGE_MIN_S: f64 = 0.6;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Metrics {
    pub scene: String,
    pub minutes: f64,
    pub turns: usize,
    /// Turns whose words are ≥ 50 % TV (every turn, in a TV-only scene)...
    pub false_turns: usize,
    /// ...and when each was sent (wall ms).
    pub false_turn_ms: Vec<u64>,
    /// Turns with no user word at all (the TV alone started them).
    pub tv_only_turns: usize,
    pub user_utterances: usize,
    /// Utterances with ≥ 50 % of their words delivered in turns.
    pub recalled: usize,
    /// Onset → `user_speaking` (ms), per recalled utterance.
    pub onset_ms: Vec<i64>,
    /// Last word's end → its turn (ms).
    pub end_ms: Vec<i64>,
    pub user_words: usize,
    /// User words in no turn.
    pub clipped_words: usize,
    /// TV words within ±2 s of a user utterance (every TV word, in a
    /// TV-only scene)...
    pub tv_words_near: usize,
    /// ...and how many of those ended up in turns.
    pub tv_words_leaked: usize,
    pub barge_ins: usize,
    /// Barge-ins with no user utterance under way.
    pub false_cuts: usize,
    /// User utterances ≥ 0.6 s that started while the agent was audible.
    pub true_barge_chances: usize,
    pub true_barges_detected: usize,
    /// Utterance start → barge-in (ms).
    pub barge_ms: Vec<i64>,
    /// Holds that resumed (hold → confirm; not built yet: always 0).
    pub holds_resumed: usize,
    /// When each false cut fired (wall ms).
    pub false_cut_ms: Vec<u64>,
    /// Auto's switches: (wall ms, the room it switched to).
    pub noise_switches: Vec<(u64, NoiseMode)>,
}

fn percentile(v: &[i64], p: f64) -> Option<i64> {
    if v.is_empty() {
        return None;
    }
    let mut s = v.to_vec();
    s.sort_unstable();
    let i = ((p / 100.0) * (s.len() - 1) as f64).round() as usize;
    Some(s[i.min(s.len() - 1)])
}

impl Metrics {
    pub fn recall(&self) -> f64 {
        if self.user_utterances == 0 {
            1.0
        } else {
            self.recalled as f64 / self.user_utterances as f64
        }
    }
    pub fn onset_p50(&self) -> Option<i64> {
        percentile(&self.onset_ms, 50.0)
    }
    pub fn onset_p95(&self) -> Option<i64> {
        percentile(&self.onset_ms, 95.0)
    }
    pub fn end_p50(&self) -> Option<i64> {
        percentile(&self.end_ms, 50.0)
    }
    pub fn end_p95(&self) -> Option<i64> {
        percentile(&self.end_ms, 95.0)
    }
    pub fn barge_p50(&self) -> Option<i64> {
        percentile(&self.barge_ms, 50.0)
    }
    pub fn clipped_rate(&self) -> f64 {
        self.clipped_words as f64 / self.user_words.max(1) as f64
    }
    pub fn leak_rate(&self) -> f64 {
        self.tv_words_leaked as f64 / self.tv_words_near.max(1) as f64
    }
    /// False turns per 10 minutes.
    /// Auto's first switch to the noisy room (wall ms).
    pub fn switched_at(&self) -> Option<u64> {
        self.noise_switches.iter().find(|s| s.1 == NoiseMode::Noisy).map(|s| s.0)
    }

    /// False cuts before and after Auto's first switch (all "before" when
    /// it never switched).
    pub fn false_cuts_split(&self) -> (usize, usize) {
        let at = self.switched_at().unwrap_or(u64::MAX);
        let before = self.false_cut_ms.iter().filter(|&&w| w < at).count();
        (before, self.false_cut_ms.len() - before)
    }

    pub fn false_turns_per_10min(&self) -> f64 {
        self.false_turns as f64 * 10.0 / self.minutes.max(1e-9)
    }

    pub fn header() -> &'static str {
        "scene                      turns false/10m tv-only/10m recall  onset p50/p95   end p50/p95  clipped  tv-leak barge false-cut true-barge  barge p50"
    }

    pub fn row(&self) -> String {
        let o = |v: Option<i64>| v.map_or("-".to_string(), |v| v.to_string());
        format!(
            "{:<26} {:>5} {:>9.1} {:>11.1} {:>6.3} {:>6}/{:<6} {:>6}/{:<6} {:>6.3} {:>8.3} {:>5} {:>9} {:>5}/{:<5} {:>9}",
            self.scene,
            self.turns,
            self.false_turns_per_10min(),
            self.tv_only_turns as f64 * 10.0 / self.minutes.max(1e-9),
            self.recall(),
            o(self.onset_p50()),
            o(self.onset_p95()),
            o(self.end_p50()),
            o(self.end_p95()),
            self.clipped_rate(),
            self.leak_rate(),
            self.barge_ins,
            self.false_cuts,
            self.true_barges_detected,
            self.true_barge_chances,
            o(self.barge_p50()),
        )
    }
}

/// One §3.3 pass bar, checked.
#[derive(Debug, Clone, PartialEq)]
pub struct Bar {
    pub name: &'static str,
    pub pass: bool,
    pub detail: String,
}

/// The noise design's §3.3 bars for the noisy room's run of a scene, against
/// the quiet room's run of the same scene (latency and clipping are relative
/// to it). `tv_rel_db`: the scene's TV level (None: no TV); `soft`: the soft
/// speaker scene; `end_silence_ms`: the user's setting.
pub fn bars(quiet: &Metrics, noisy: &Metrics, tv_rel_db: Option<f32>, soft: bool, end_silence_ms: u32) -> Vec<Bar> {
    let mut out = Vec::new();
    let mut bar = |name, pass, detail: String| out.push(Bar { name, pass, detail });
    let per10 = |n: usize| n as f64 * 10.0 / noisy.minutes.max(1e-9);
    if let Some(rel) = tv_rel_db {
        let max = if rel <= -15.0 { 1.0 } else { 3.0 };
        let f = noisy.false_turns_per_10min();
        bar("false turns/10 min", f <= max, format!("{f:.1} (≤ {max})"));
        let cuts = per10(noisy.false_cuts);
        bar("false cuts/10 min", cuts <= 1.0, format!("{cuts:.1} (≤ 1)"));
        if let Some(p95) = noisy.end_p95() {
            let max = end_silence_ms as i64 + 300;
            bar("end p95", p95 <= max, format!("{p95} ms (≤ {max})"));
        }
        let leak = noisy.leak_rate();
        bar("TV words leaked", leak <= 0.05, format!("{:.1} % (≤ 5 %)", leak * 100.0));
    }
    if noisy.user_utterances > 0 {
        let min = if soft { 0.95 } else if tv_rel_db.is_some_and(|r| r > -15.0) { 0.97 } else { 0.98 };
        bar("recall", noisy.recall() >= min, format!("{:.3} (≥ {min}; quiet {:.3})", noisy.recall(), quiet.recall()));
        if let (Some(n), Some(q)) = (noisy.onset_p50(), quiet.onset_p50()) {
            bar("onset p50", n <= q + 120, format!("{n} ms (≤ quiet {q} + 120)"));
        }
        if let (Some(n), Some(q)) = (noisy.onset_p95(), quiet.onset_p95()) {
            bar("onset p95", n <= q + 250, format!("{n} ms (≤ quiet {q} + 250)"));
        }
        let (n, q) = (noisy.clipped_rate(), quiet.clipped_rate());
        bar("clipped words", n <= q + 0.01 && n <= 0.02, format!("{:.1} % (≤ quiet {:.1} + 1, ≤ 2)", n * 100.0, q * 100.0));
    }
    if noisy.true_barge_chances > 0 {
        let rate = noisy.true_barges_detected as f64 / noisy.true_barge_chances as f64;
        bar("true barge-ins", rate >= 0.95, format!("{}/{} (≥ 95 %)", noisy.true_barges_detected, noisy.true_barge_chances));
        if let Some(p50) = noisy.barge_p50() {
            bar("barge p50", p50 <= 600, format!("{p50} ms (≤ 600)"));
        }
    }
    out
}

/// Measure a run of `mix`.
pub fn measure(mix: &Mix, run: &SimRun) -> Metrics {
    let mut m = Metrics { scene: mix.name.clone(), minutes: mix.duration_s / 60.0, ..Default::default() };
    let token_of: HashMap<&str, usize> = mix.words.iter().enumerate().map(|(i, w)| (w.token.as_str(), i)).collect();
    let mut delivered: HashSet<usize> = HashSet::new();
    // Turn wall time per delivered word.
    let mut turn_wall: HashMap<usize, u64> = HashMap::new();
    for (wall, a) in &run.actions {
        if let Action::Turn { text, .. } = a {
            m.turns += 1;
            let idx: Vec<usize> = text.split_whitespace().filter_map(|t| token_of.get(t).copied()).collect();
            let tv = idx.iter().filter(|&&i| mix.words[i].who == Who::Tv).count();
            if mix.tv_only || (!idx.is_empty() && tv * 2 >= idx.len()) {
                m.false_turns += 1;
                m.false_turn_ms.push(*wall);
            }
            if tv == idx.len() {
                m.tv_only_turns += 1;
            }
            for i in idx {
                delivered.insert(i);
                turn_wall.entry(i).or_insert(*wall);
            }
        }
    }
    // User utterances.
    let user_speaking: Vec<u64> = run
        .actions
        .iter()
        .filter(|(_, a)| matches!(a, Action::State { state: SessionState::UserSpeaking, .. }))
        .map(|(w, _)| *w)
        .collect();
    m.user_utterances = mix.utterances.len();
    for u in &mix.utterances {
        let got = u.words.iter().filter(|i| delivered.contains(i)).count();
        m.user_words += u.words.len();
        m.clipped_words += u.words.len() - got;
        if got * 2 >= u.words.len().max(1) {
            m.recalled += 1;
            let start_ms = (u.start * 1000.0) as i64;
            if let Some(w) = user_speaking.iter().find(|&&w| w as i64 >= start_ms - 300 && (w as f64) <= u.end * 1000.0 + 1000.0) {
                m.onset_ms.push(*w as i64 - start_ms);
            }
            if let Some(&last) = u.words.iter().rev().find(|i| delivered.contains(i)) {
                if let Some(w) = turn_wall.get(&last) {
                    m.end_ms.push(*w as i64 - (mix.words[last].end * 1000.0) as i64);
                }
            }
        }
    }
    // TV words near the user, and leaked.
    for (i, w) in mix.words.iter().enumerate().filter(|(_, w)| w.who == Who::Tv) {
        let near = mix.utterances.iter().any(|u| w.end >= u.start - 2.0 && w.start <= u.end + 2.0);
        if near || mix.tv_only {
            m.tv_words_near += 1;
            if delivered.contains(&i) {
                m.tv_words_leaked += 1;
            }
        }
    }
    m.noise_switches = run
        .actions
        .iter()
        .filter_map(|(w, a)| if let Action::NoiseMode { mode, .. } = a { Some((*w, *mode)) } else { None })
        .collect();
    // Barge-in.
    let barges: Vec<(u64, u64)> = run
        .inputs
        .iter()
        .filter_map(|(w, i)| if let Input::BargeIn { onset } = i { Some((*w, *onset)) } else { None })
        .collect();
    m.barge_ins = barges.len();
    let in_utterance = |t: f64| mix.utterances.iter().any(|u| t >= u.start - 0.2 && t <= u.end + 0.2);
    m.false_cut_ms = barges.iter().filter(|(w, _)| !in_utterance(*w as f64 / 1000.0)).map(|(w, _)| *w).collect();
    m.false_cuts = m.false_cut_ms.len();
    for u in &mix.utterances {
        if u.end - u.start < TRUE_BARGE_MIN_S {
            continue;
        }
        let start_ms = (u.start * 1000.0) as u64;
        let agent_on = run.replies.iter().any(|r| start_ms >= r.start && start_ms < r.end);
        if !agent_on {
            continue;
        }
        m.true_barge_chances += 1;
        if let Some((w, _)) = barges.iter().find(|(w, _)| *w >= start_ms && (*w as f64) <= u.end * 1000.0 + 500.0) {
            m.true_barges_detected += 1;
            m.barge_ms.push(*w as i64 - start_ms as i64);
        }
    }
    m
}

#[cfg(test)]
mod tests {
    use super::super::sim::{HeardWord, Reply, Route, Utterance};
    use super::*;
    use crate::voice::events::EchoMode;

    fn word(token: &str, who: Who, start: f64, utterance: Option<usize>) -> HeardWord {
        HeardWord { token: token.into(), who, start, end: start + 0.3, utterance }
    }

    #[test]
    fn counts_turns_words_and_barge_ins() {
        let words = vec![
            word("u0", Who::User, 1.0, Some(0)),
            word("u1", Who::User, 1.4, Some(0)),
            word("t0", Who::Tv, 1.5, None),
            word("t1", Who::Tv, 5.0, None),
            word("u2", Who::User, 10.0, Some(1)),
            word("u3", Who::User, 10.4, Some(1)),
        ];
        let mix = Mix {
            name: "t".into(),
            duration_s: 60.0,
            bed: vec![],
            agent_voice: vec![],
            words,
            utterances: vec![
                Utterance { start: 1.0, end: 1.7, words: vec![0, 1] },
                Utterance { start: 10.0, end: 10.7, words: vec![4, 5] },
            ],
            route: Route::Speakers,
            echo: vec![],
            reply_s: 3.0,
            tv_only: false,
        };
        let us = |w: u64| (w, Action::State { state: SessionState::UserSpeaking, echo: EchoMode::Cancelling });
        let run = SimRun {
            inputs: vec![(10_100, Input::BargeIn { onset: 160_000 }), (20_000, Input::BargeIn { onset: 1 })],
            actions: vec![
                us(1_100),
                (2_600, Action::Turn { turn_id: "t1".into(), text: "u0 u1 t0".into() }),
                (6_000, Action::Turn { turn_id: "t2".into(), text: "t1".into() }),
                us(10_050),
                (11_500, Action::Turn { turn_id: "t3".into(), text: "u2".into() }),
            ],
            replies: vec![Reply { start: 9_000, end: 10_100, cut: true }],
        };
        let m = measure(&mix, &run);
        assert_eq!((m.turns, m.false_turns), (3, 1));
        assert_eq!((m.user_utterances, m.recalled), (2, 2));
        assert_eq!(m.onset_ms, vec![100, 50]);
        assert_eq!(m.end_ms, vec![2_600 - 1_700, 11_500 - 10_300]);
        assert_eq!((m.user_words, m.clipped_words), (4, 1));
        assert_eq!((m.tv_words_near, m.tv_words_leaked), (1, 1), "t1 leaked too, but far from the user");
        assert_eq!((m.barge_ins, m.false_cuts), (2, 1));
        assert_eq!((m.true_barge_chances, m.true_barges_detected), (1, 1));
        assert_eq!(m.barge_ms, vec![100]);
        assert!(m.row().starts_with("t "));
    }
}
