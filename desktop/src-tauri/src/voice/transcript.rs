//! Transcript assembly for a voice session: local-stt's Deepgram-shaped
//! `Results` in, the text of a turn (or of the whole dictation) out.
//!
//! Word times are seconds on the session audio clock (cleaned samples pushed
//! into the transcription since the session started), the same clock the
//! turn machine's onsets are on.
//!
//! - Final words accumulate, in start order. A final word that repeats one
//!   already held (same word, start within [`DUP_WINDOW_S`]) is dropped, so a
//!   forced final that re-emits the tail of the previous segment is not
//!   counted twice; but when the repeat carries punctuation the held word
//!   lacks ("it" then "it."), the held word takes it: the engine only
//!   punctuates a word once it has heard what follows.
//! - Sentence ends at segment boundaries (Liam, 2026-10-25: "zero
//!   punctuation"): the engine punctuates within a segment but never ends one
//!   with a full stop, then starts the next with a capital when it begins a
//!   sentence. So where a segment ending in a bare word meets one starting
//!   with a capital (not "I"), the full stop goes back, unless the word before
//!   is one no sentence ends on ("to", "the", "and"…), so "talk to / Austin"
//!   stays one sentence ([`sentence_break`]).
//! - An interim result replaces the previous interim (it is "the utterance
//!   so far"), and any final clears it.
//! - A turn is the words whose start is in `[from, until)` and after every
//!   word an earlier turn took ([`Transcript::consume`]).

use crate::modules::stt::{SttResults, SttWord};

/// Two final words this close with the same text are one word.
pub const DUP_WINDOW_S: f64 = 0.05;

#[derive(Debug, Default)]
pub struct Transcript {
    finals: Vec<SttWord>,
    interim: Vec<SttWord>,
    /// Start of the last word an emitted turn took; later turns only take
    /// words that start after it.
    consumed_through: Option<f64>,
}

/// Lowercase letters and digits only: "Hello," and "hello" are one word.
pub(crate) fn norm(word: &str) -> String {
    word.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// The punctuation a word ends with ("there," → ",", "Friday?" → "?").
fn trailing_punct(word: &str) -> &str {
    let keep = word.trim_end_matches(|c: char| !c.is_alphanumeric());
    &word[keep.len()..]
}

/// Words no sentence ends on: articles, prepositions, conjunctions, auxiliaries,
/// determiners and fillers. English grammar, not a list of terms.
const NO_SENTENCE_END: &[&str] = &[
    "a", "an", "the", "to", "of", "in", "on", "at", "by", "for", "with", "from", "about", "into", "onto",
    "over", "under", "and", "or", "but", "nor", "so", "because", "if", "than", "that", "which", "who", "whose",
    "is", "are", "was", "were", "am", "be", "been", "being", "my", "your", "his", "her", "our", "their", "its",
    "this", "these", "those", "very", "just", "um", "uh", "er", "like",
];

/// Where a segment ending in `prev` meets one starting with `next`, is that a
/// sentence end the engine left unpunctuated?
pub(crate) fn sentence_break(prev: &str, next: &str) -> bool {
    if !trailing_punct(prev).is_empty() || !prev.chars().last().is_some_and(|c| c.is_alphanumeric()) {
        return false;
    }
    if !next.chars().next().is_some_and(|c| c.is_uppercase()) {
        return false;
    }
    let next_core = next.trim_end_matches(|c: char| !c.is_alphanumeric());
    if next_core == "I" || ["I'", "I’"].iter().any(|p| next_core.starts_with(p)) {
        return false;
    }
    !NO_SENTENCE_END.contains(&norm(prev).as_str())
}

fn same_word(a: &SttWord, b: &SttWord) -> bool {
    (a.start - b.start).abs() < DUP_WINDOW_S && norm(&a.word) == norm(&b.word)
}

/// The words of a result; a result with a transcript but no word timings
/// becomes one word spanning the result.
fn words_of(r: &SttResults) -> Vec<SttWord> {
    let words: Vec<SttWord> = r.words.iter().filter(|w| !w.word.trim().is_empty()).cloned().collect();
    if !words.is_empty() || r.transcript.trim().is_empty() {
        return words;
    }
    vec![SttWord {
        word: r.transcript.trim().to_string(),
        start: r.start,
        end: r.start + r.duration,
        confidence: 0.0,
    }]
}

/// Text of a word run, in order, one space apart.
fn join<'a>(words: impl Iterator<Item = &'a SttWord>) -> String {
    let mut out = String::new();
    for w in words {
        let t = w.word.trim();
        if t.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(t);
    }
    out
}

/// A turn's (or dictation's) text so far.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Text {
    pub text: String,
    /// Some of it is interim (still being revised).
    pub has_interim: bool,
}

impl Text {
    /// The text of some words (each with whether it is interim).
    pub fn of<'a>(words: impl Iterator<Item = (&'a SttWord, bool)>) -> Text {
        let mut has_interim = false;
        let text = join(words.map(|(w, interim)| {
            has_interim |= interim;
            w
        }));
        Text { text, has_interim }
    }
}

impl Transcript {
    pub fn new() -> Self {
        Self::default()
    }

    /// Take one `Results` message.
    pub fn add(&mut self, r: &SttResults) {
        let words = words_of(r);
        if !r.is_final {
            self.interim = words;
            return;
        }
        self.interim.clear();
        let mut first_new = true;
        for w in words {
            if let Some(held) = self.finals.iter_mut().rev().take(64).find(|f| same_word(f, &w)) {
                // The engine re-sent a word: keep its punctuation if it now has some.
                if trailing_punct(&w.word).len() > trailing_punct(&held.word).len() {
                    held.word = w.word.clone();
                }
                continue;
            }
            // Keep start order; results arrive in order, so this is almost
            // always a push.
            let at = self.finals.partition_point(|f| f.start <= w.start);
            if first_new && at > 0 && at == self.finals.len() {
                // A new segment after the last: put back the full stop the engine left off.
                let prev = &mut self.finals[at - 1];
                if sentence_break(&prev.word, &w.word) {
                    prev.word.push('.');
                }
            }
            first_new = false;
            self.finals.insert(at, w);
        }
    }

    fn taken(&self, w: &SttWord) -> bool {
        self.consumed_through.is_some_and(|c| w.start <= c)
    }

    fn in_window(&self, w: &SttWord, from: f64, until: f64) -> bool {
        w.start >= from && w.start < until && !self.taken(w)
    }

    /// The words starting in `[from, until)` not taken by an earlier turn:
    /// finals, then (with `interim`) the interim words that don't repeat a
    /// final, each with whether it is interim.
    pub fn words(&self, from: f64, until: f64, interim: bool) -> Vec<(&SttWord, bool)> {
        let finals = self.finals.iter().filter(|w| self.in_window(w, from, until));
        let mut words: Vec<(&SttWord, bool)> = finals.map(|w| (w, false)).collect();
        if interim {
            for w in self.interim.iter().filter(|w| self.in_window(w, from, until)) {
                if self.finals.iter().any(|f| same_word(f, w)) {
                    continue;
                }
                words.push((w, true));
            }
        }
        words
    }

    /// [`Self::words`] as text (tests: the machine filters the words first).
    #[cfg(test)]
    pub fn text(&self, from: f64, until: f64, interim: bool) -> Text {
        Text::of(self.words(from, until, interim).into_iter())
    }

    /// Everything so far, interim tail included (tests: dictation's text is
    /// the machine's, filtered).
    #[cfg(test)]
    pub fn all(&self) -> Text {
        self.text(f64::NEG_INFINITY, f64::INFINITY, true)
    }

    /// A turn took the final words in `[from, until)`: later turns never see
    /// them again, and older words are forgotten.
    pub fn consume(&mut self, from: f64, until: f64) {
        self.consume_words(from, until, false);
    }

    /// A turn that timed out took the final and the interim words in
    /// `[from, until)`: the same, and the finals those interim words become
    /// when the engine catches up are taken too.
    pub fn consume_with_interim(&mut self, from: f64, until: f64) {
        self.consume_words(from, until, true);
    }

    fn consume_words(&mut self, from: f64, until: f64, interim: bool) {
        let interims = self.interim.iter().filter(|_| interim);
        let last = self
            .finals
            .iter()
            .chain(interims)
            .filter(|w| self.in_window(w, from, until))
            .map(|w| w.start)
            .fold(None, |acc: Option<f64>, s| Some(acc.map_or(s, |a| a.max(s))));
        if let Some(last) = last {
            self.consumed_through = Some(self.consumed_through.map_or(last, |c| c.max(last)));
        }
        if let Some(c) = self.consumed_through {
            self.finals.retain(|w| w.start > c);
            if interim {
                self.interim.retain(|w| w.start > c);
            }
        }
    }

    /// Forget final words that started before `t` (no turn can reach them
    /// any more). Bounds memory over a long conversation.
    pub fn forget_before(&mut self, t: f64) {
        self.finals.retain(|w| w.start >= t);
    }

    #[cfg(test)]
    pub fn final_count(&self) -> usize {
        self.finals.len()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn word(w: &str, start: f64) -> SttWord {
        SttWord { word: w.into(), start, end: start + 0.2, confidence: 0.9 }
    }

    pub(crate) fn results(is_final: bool, words: &[(&str, f64)]) -> SttResults {
        let ws: Vec<SttWord> = words.iter().map(|(w, s)| word(w, *s)).collect();
        SttResults {
            is_final,
            speech_final: is_final,
            from_finalize: false,
            transcript: ws.iter().map(|w| w.word.clone()).collect::<Vec<_>>().join(" "),
            start: ws.first().map_or(0.0, |w| w.start),
            duration: 1.0,
            words: ws,
        }
    }

    #[test]
    fn a_sentence_end_at_a_segment_boundary_gets_its_full_stop_back() {
        let mut t = Transcript::new();
        t.add(&results(true, &[("Okay", 1.0), ("it", 1.3), ("looks", 1.6), ("better", 1.9), ("now", 2.2)]));
        t.add(&results(true, &[("Um,", 3.5), ("but", 3.8), ("isn't", 4.1), ("it", 4.4)]));
        t.add(&results(true, &[("I", 6.0), ("think", 6.3), ("so", 6.6)]));
        t.add(&results(true, &[("talk", 8.0), ("to", 8.3)]));
        t.add(&results(true, &[("Austin", 9.5), ("today", 9.8)]));
        t.add(&results(true, &[("and", 11.0), ("then", 11.3)]));
        assert_eq!(t.all().text, "Okay it looks better now. Um, but isn't it I think so talk to Austin today and then");
    }

    #[test]
    fn sentence_breaks_follow_grammar_not_terms() {
        assert!(sentence_break("now", "Is"));
        assert!(sentence_break("APIM", "Then"));
        assert!(!sentence_break("now,", "Is"));
        assert!(!sentence_break("now", "is"));
        assert!(!sentence_break("now", "I'm"));
        assert!(!sentence_break("to", "Austin"));
        assert!(!sentence_break("the", "APIM"));
    }

    #[test]
    fn a_timed_out_turn_takes_its_interim_words_and_their_late_finals() {
        let mut t = Transcript::new();
        t.add(&results(true, &[("make", 1.0)]));
        t.add(&results(false, &[("it", 1.3), ("blue", 1.6)]));
        assert_eq!(t.text(0.7, 2.0, true).text, "make it blue");
        t.consume_with_interim(0.7, 2.0);
        // The engine catches up: those words come back as finals, and no
        // later turn takes them again.
        t.add(&results(true, &[("it", 1.3), ("blue", 1.6), ("please", 2.4)]));
        assert_eq!(t.text(0.0, 10.0, true).text, "please");
    }

    #[test]
    fn finals_accumulate_and_interim_is_replaced() {
        let mut t = Transcript::new();
        t.add(&results(false, &[("hello", 1.0)]));
        assert_eq!(t.all(), Text { text: "hello".into(), has_interim: true });
        t.add(&results(false, &[("hello", 1.0), ("wor", 1.3)]));
        assert_eq!(t.all().text, "hello wor");
        t.add(&results(true, &[("Hello", 1.0), ("world.", 1.3)]));
        assert_eq!(t.all(), Text { text: "Hello world.".into(), has_interim: false });
        t.add(&results(false, &[("how", 2.0)]));
        assert_eq!(t.all(), Text { text: "Hello world. how".into(), has_interim: true });
        // A final clears the interim even when it covers less.
        t.add(&results(true, &[("How", 2.0)]));
        assert_eq!(t.all(), Text { text: "Hello world. How".into(), has_interim: false });
    }

    #[test]
    fn a_repeated_final_across_a_finalize_boundary_counts_once() {
        let mut t = Transcript::new();
        t.add(&results(true, &[("send", 1.0), ("it", 1.2)]));
        // The forced final re-emits "it" (punctuated) and adds "now".
        let mut forced = results(true, &[("it.", 1.21), ("now", 1.5)]);
        forced.from_finalize = true;
        t.add(&forced);
        // The repeat's punctuation is the engine's own: it's kept.
        assert_eq!(t.all().text, "send it. now");
        assert_eq!(t.final_count(), 3);
        // The same word much later is a new word.
        t.add(&results(true, &[("it", 3.0)]));
        assert_eq!(t.all().text, "send it. now it");
    }

    #[test]
    fn interim_words_that_repeat_a_final_are_not_shown_twice() {
        let mut t = Transcript::new();
        t.add(&results(true, &[("one", 1.0)]));
        t.add(&results(false, &[("one", 1.01), ("two", 1.4)]));
        assert_eq!(t.all(), Text { text: "one two".into(), has_interim: true });
    }

    #[test]
    fn a_turn_takes_the_words_from_its_onset_window() {
        let mut t = Transcript::new();
        // Echo residue before the onset, then the user.
        t.add(&results(true, &[("echo", 2.0), ("tail", 2.4), ("so", 4.75), ("what", 5.1), ("now", 5.4)]));
        // Onset at 5.0 s: words from 4.7 s on count.
        let got = t.text(5.0 - 0.3, 6.0, false);
        assert_eq!(got.text, "so what now");
        // Bounded above by the finalize point.
        assert_eq!(t.text(4.7, 5.3, false).text, "so what");
    }

    #[test]
    fn consumed_words_never_reach_the_next_turn() {
        let mut t = Transcript::new();
        t.add(&results(true, &[("first", 1.0), ("turn", 1.3)]));
        assert_eq!(t.text(0.7, 2.0, false).text, "first turn");
        t.consume(0.7, 2.0);
        // The next turn's window reaches back over the previous turn's words.
        t.add(&results(true, &[("second", 1.9)]));
        assert_eq!(t.text(1.0, 3.0, false).text, "second");
        assert_eq!(t.final_count(), 1, "consumed words are forgotten");
    }

    #[test]
    fn an_empty_window_is_empty_text() {
        let mut t = Transcript::new();
        t.add(&results(true, &[("before", 1.0)]));
        assert_eq!(t.text(5.0, 9.0, true), Text::default());
        t.consume(5.0, 9.0);
        assert_eq!(t.all().text, "before", "consuming nothing takes nothing");
    }

    #[test]
    fn a_result_without_word_timings_is_one_word() {
        let mut t = Transcript::new();
        let r = SttResults {
            is_final: true,
            speech_final: true,
            from_finalize: false,
            transcript: " Okay then ".into(),
            start: 3.0,
            duration: 0.8,
            words: vec![],
        };
        t.add(&r);
        assert_eq!(t.text(2.9, 4.0, false).text, "Okay then");
        // An empty final adds nothing.
        t.add(&results(true, &[]));
        assert_eq!(t.all().text, "Okay then");
    }

    #[test]
    fn out_of_order_finals_are_kept_in_start_order() {
        let mut t = Transcript::new();
        t.add(&results(true, &[("b", 2.0)]));
        t.add(&results(true, &[("a", 1.0)]));
        assert_eq!(t.all().text, "a b");
    }

    #[test]
    fn forget_before_drops_old_words() {
        let mut t = Transcript::new();
        t.add(&results(true, &[("old", 1.0), ("new", 50.0)]));
        t.forget_before(30.0);
        assert_eq!(t.all().text, "new");
    }
}
