//! Where each word starts in a sentence being read aloud (spike: read-along,
//! one word at a time in the HUD, in step with the voice).
//!
//! Pocket TTS gives audio, no word timings. So the words are placed on the
//! audio as it's played: its loudness every 10 ms ([`Envelope`], fed the very
//! samples the device gets, after the speed change and resampling, so 2× is
//! in step by construction), then each word given its share of the voiced
//! time by its syllables ([`word_starts`]), shown at its onset (after any
//! pause before it). Measured against two references (local-stt's and
//! whisper.cpp's DTW word times, sidecars/local-tts/bench/word_marks.py):
//! ~95–115 ms from either, as far as the references are from each other;
//! even spacing was ~175–190 ms. A finished sentence is placed clause by
//! clause ([`sentence_starts`]: each word after punctuation at the pause the
//! voice made there, ~80 ms from whisper on long sentences); one still being
//! made as it plays the same way on the audio so far ([`partial_starts`]), the
//! rest at the rate it's being said at. Nothing in yet: [`provisional_starts`],
//! the voice's usual rate, learned from the sentences before.

/// Loudness (mean square) per hop of the samples pushed, a hop being 10 ms.
#[derive(Debug, Clone)]
pub struct Envelope {
    hop: usize,
    frames: Vec<f32>,
    sum: f64,
    n: usize,
}

impl Envelope {
    pub fn new(rate: u32) -> Self {
        Self { hop: (rate as usize / 100).max(1), frames: Vec::new(), sum: 0.0, n: 0 }
    }

    /// Samples per hop.
    pub fn hop(&self) -> usize {
        self.hop
    }

    pub fn push(&mut self, samples: &[f32]) {
        for &s in samples {
            self.sum += (s as f64) * (s as f64);
            self.n += 1;
            if self.n == self.hop {
                self.frames.push((self.sum / self.n as f64) as f32);
                self.sum = 0.0;
                self.n = 0;
            }
        }
    }

    /// Per hop, in dB.
    pub fn db(&self) -> Vec<f32> {
        self.frames.iter().map(|&ms| 10.0 * (ms + 1e-12).log10()).collect()
    }
}

/// Syllables in a word as written (a weight for its share of the time).
pub fn syllables(word: &str) -> f32 {
    let w: String = word.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase();
    if w.is_empty() {
        return 0.5;
    }
    if w.chars().all(|c| c.is_ascii_digit()) {
        return 1.5 * w.len() as f32;
    }
    let letters: Vec<char> = w.chars().collect();
    let upper = word.chars().filter(|c| c.is_alphabetic()).all(|c| c.is_uppercase());
    if upper && (2..=5).contains(&letters.len()) {
        return letters.len() as f32; // spelled out (API)
    }
    let vowel = |c: char| "aeiouy".contains(c);
    let mut groups = 0;
    let mut prev = false;
    for &c in &letters {
        let v = vowel(c);
        if v && !prev {
            groups += 1;
        }
        prev = v;
    }
    if groups > 1 && w.ends_with('e') && !(w.ends_with("le") || w.ends_with("ee") || w.ends_with("ye")) {
        groups -= 1;
    }
    if groups > 1 && w.ends_with("ed") && !(w.ends_with("ted") || w.ends_with("ded")) {
        groups -= 1;
    }
    groups.max(1) as f32
}

/// A pause is at least this long (80 ms): a word after punctuation starts at one's end.
const PAUSE_HOPS: usize = 8;
/// How far from where its syllables put it a word after punctuation looks for its pause.
const SNAP_REACH_HOPS: usize = 40;

/// A word's weight: its syllables and a little for its edges.
fn weight(word: &str) -> f32 {
    syllables(word) + 0.35
}

/// The words of a sentence to show (anything with a letter or a digit), one
/// spoken word each: words joined by a dash, a slash or an ellipsis
/// ("this—that", "and/or", "wait…what") are said as two and shown as two.
///
/// A sentence's end with no space before the next ("today.Next", "done!So")
/// is two words too; an abbreviation ("U.S.A", "e.g.") and a domain
/// ("nativeintelligence.dev", lowercase after the dot) stay whole.
pub fn words_of(text: &str) -> Vec<String> {
    let spaced = text.replace("...", " ").replace(['\u{2014}', '\u{2013}', '/', '\u{2026}'], " ");
    spaced
        .split_whitespace()
        .flat_map(split_run_on)
        .filter(|w| w.chars().any(|c| c.is_alphanumeric()))
        .collect()
}

/// "today.Next" → "today." "Next": a sentence's end run into the next one.
fn split_run_on(token: &str) -> Vec<String> {
    let chars: Vec<char> = token.chars().collect();
    let mut out = Vec::new();
    let mut from = 0;
    for i in 1..chars.len().saturating_sub(1) {
        let end = matches!(chars[i], '.' | '!' | '?' | ',' | ';' | ':');
        // Two letters at least before it (not "U.S.A"), and a capital after
        // ("nativeintelligence.dev" stays), or any letter after ! ? , ; : ("wait,what").
        let before = chars[from..i].iter().rev().take_while(|c| c.is_alphabetic()).count();
        let next = chars[i + 1];
        let starts = next.is_uppercase() || (chars[i] != '.' && next.is_alphabetic());
        if end && before >= 2 && starts {
            out.push(chars[from..=i].iter().collect());
            from = i + 1;
        }
    }
    out.push(chars[from..].iter().collect());
    out
}

/// The hop each word starts at, from the sentence's envelope (dB per hop):
/// the voiced time shared out by syllables, each word shown at its onset.
/// Empty when there's nothing voiced.
pub fn word_starts(db: &[f32], words: &[String]) -> Vec<usize> {
    if words.is_empty() || db.is_empty() {
        return Vec::new();
    }
    word_starts_at(db, words, voiced_threshold(db))
}

/// The loudness (dB) above which a hop is speech: well over the quiet, and
/// within 38 dB of the loudest.
fn voiced_threshold(db: &[f32]) -> f32 {
    let top = db.iter().cloned().fold(f32::MIN, f32::max);
    let mut sorted = db.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let floor = sorted[sorted.len() / 10];
    (floor + 10.0).max(top - 38.0)
}

/// [`word_starts`] with speech above `thr` (a part of a sentence is placed
/// with the whole one's: a clause all speech has no quiet of its own).
fn word_starts_at(db: &[f32], words: &[String], thr: f32) -> Vec<usize> {
    if words.is_empty() || db.is_empty() {
        return Vec::new();
    }
    let voiced: Vec<bool> = db.iter().map(|&e| e > thr).collect();
    let Some(first) = voiced.iter().position(|&v| v) else { return Vec::new() };
    let last = voiced.len() - 1 - voiced.iter().rev().position(|&v| v).unwrap_or(0);
    let mut cum = vec![0usize; voiced.len() + 1];
    for (i, &v) in voiced.iter().enumerate() {
        cum[i + 1] = cum[i] + v as usize;
    }
    let total_voiced = (cum[last + 1] - cum[first]) as f32;
    let weights: Vec<f32> = words.iter().map(|w| weight(w)).collect();
    let all: f32 = weights.iter().sum();
    // The pauses (at least PAUSE_HOPS of silence) inside the speech: (start, end).
    let mut pauses: Vec<(usize, usize)> = Vec::new();
    let mut i = first;
    while i <= last {
        if !voiced[i] {
            let j = (i..=last).find(|&k| voiced[k]).unwrap_or(last + 1);
            if j - i >= PAUSE_HOPS {
                pauses.push((i, j));
            }
            i = j;
        } else {
            i += 1;
        }
    }
    let mut starts = Vec::with_capacity(words.len());
    let mut acc = 0.0f32;
    let mut t = first;
    for (k, w) in weights.iter().enumerate() {
        let target = acc / all * total_voiced;
        while t <= last && ((cum[t] - cum[first]) as f32) < target {
            t += 1;
        }
        let mut onset = t;
        // After punctuation the voice pauses: the word starts where the
        // nearest pause within reach ends.
        if k > 0 && words[k - 1].ends_with([',', '.', ';', ':', '!', '?']) {
            let reach = SNAP_REACH_HOPS as i64;
            if let Some(&(_, end)) = pauses
                .iter()
                .filter(|(a, e)| (*e as i64 - t as i64).abs() <= reach || (*a as i64 - t as i64).abs() <= reach)
                .min_by_key(|(_, e)| (*e as i64 - t as i64).abs())
            {
                onset = end;
                t = t.max(end);
            }
        }
        // At its onset: past any silence before it.
        while onset <= last && !voiced[onset] {
            onset += 1;
        }
        let onset = onset.min(last).max(starts.last().copied().unwrap_or(0));
        starts.push(onset);
        acc += w;
    }
    starts
}

/// Before the sentence's audio is all in: each word's start, in hops from the
/// sentence's first sample, at `hops_per_syllable` (the voice's rate, at the
/// current speed).
pub fn provisional_starts(words: &[String], hops_per_syllable: f32) -> Vec<usize> {
    let mut at = 0.0f32;
    words
        .iter()
        .map(|w| {
            let here = at.round() as usize;
            at += weight(w) * hops_per_syllable;
            here
        })
        .collect()
}

/// While a sentence's audio is still coming in (it plays as it's made): each
/// word's start from the audio so far. A guess at the voice's usual rate
/// drifted from the real words (up to ~250 ms) until the sentence was all in
/// (Liam, 10-25), so the guess is only for what isn't in yet: clause by
/// clause, each word after punctuation is matched to the pause the voice
/// made there, the words up to it placed on the audio as [`word_starts`]
/// places them, and the rest go at the rate this sentence is being said at.
/// `hops_per_syllable` (the usual rate, at the current speed) only until a
/// clause is in.
pub fn partial_starts(db: &[f32], words: &[String], hops_per_syllable: f32) -> Vec<usize> {
    clause_starts(db, words, hops_per_syllable, false)
}

/// A finished sentence's words, clause by clause as [`partial_starts`] places
/// them, the last clause on its own audio too. Sharing the whole sentence's
/// voiced time out by syllables ([`word_starts`]) let a clause said faster or
/// slower than the rest pull its words off until a pause in reach put them
/// back (a sentence mid-paragraph out of step, Liam 10-25); each clause on
/// its own time: 89 ms from whisper's word times vs 99 ms (8 long sentences,
/// bench/word_marks_stream.py).
pub fn sentence_starts(db: &[f32], words: &[String], hops_per_syllable: f32) -> Vec<usize> {
    let pace = self::hops_per_syllable(db, words).unwrap_or(hops_per_syllable);
    clause_starts(db, words, pace, true)
}

fn clause_starts(db: &[f32], words: &[String], hops_per_syllable: f32, complete: bool) -> Vec<usize> {
    if words.is_empty() {
        return Vec::new();
    }
    let first = if db.is_empty() {
        None
    } else {
        let thr = voiced_threshold(db);
        db.iter().position(|&e| e > thr).map(|f| (f, thr))
    };
    let Some((first, thr)) = first else { return provisional_starts(words, hops_per_syllable) };
    let voiced: Vec<bool> = db.iter().map(|&e| e > thr).collect();
    // The pauses the voice has finished (speech after them): (start, end).
    let mut pauses: Vec<(usize, usize)> = Vec::new();
    let mut i = first;
    while i < voiced.len() {
        if !voiced[i] {
            let j = (i..voiced.len()).find(|&k| voiced[k]);
            match j {
                Some(j) => {
                    if j - i >= PAUSE_HOPS {
                        pauses.push((i, j));
                    }
                    i = j;
                }
                None => break,
            }
        } else {
            i += 1;
        }
    }
    let weights: Vec<f32> = words.iter().map(|w| weight(w)).collect();
    let mut starts: Vec<usize> = Vec::with_capacity(words.len());
    let (mut at_word, mut at_hop) = (0usize, first);
    // The rate it's being said at: speaking time (the clauses, not the pauses
    // between them: a long one after the first word read as a slow voice)
    // per unit of weight, starting from the usual rate as if it had been
    // heard for PRIOR_WEIGHT.
    const PRIOR_WEIGHT: f32 = 6.0;
    let (mut spoken_hops, mut spoken_weight) = (hops_per_syllable * PRIOR_WEIGHT, PRIOR_WEIGHT);
    let mut pace = hops_per_syllable;
    for b in 1..words.len() {
        if !words[b - 1].ends_with([',', '.', ';', ':', '!', '?']) {
            continue;
        }
        let w: f32 = weights[at_word..b].iter().sum();
        let predicted = at_hop as f32 + w * pace;
        if predicted > db.len() as f32 + SNAP_REACH_HOPS as f32 {
            break; // not said yet
        }
        // Where the clause's speech should end: the pause starts there.
        let reach = (SNAP_REACH_HOPS as f32).max(0.25 * (predicted - at_hop as f32));
        let Some(&(p_start, p_end)) = pauses
            .iter()
            .filter(|(a, _)| *a > at_hop)
            .filter(|(a, _)| (*a as f32 - predicted).abs() <= reach)
            .min_by(|x, y| (x.0 as f32 - predicted).abs().total_cmp(&(y.0 as f32 - predicted).abs()))
        else {
            continue; // no pause there: the next punctuation, from the same place
        };
        // The clause (or clauses) up to the pause: on the audio.
        let placed = word_starts_at(&db[at_hop..p_start], &words[at_word..b], thr);
        if placed.len() != b - at_word {
            continue;
        }
        starts.extend(placed.into_iter().map(|h| at_hop + h));
        spoken_hops += (p_start - at_hop) as f32;
        spoken_weight += w;
        pace = spoken_hops / spoken_weight;
        at_word = b;
        at_hop = p_end;
    }
    // The rest: on its own audio once it's all in; until then from the last
    // pause, at the rate this sentence is being said at.
    let last = if complete { word_starts_at(&db[at_hop..], &words[at_word..], thr) } else { Vec::new() };
    if last.len() == words.len() - at_word {
        starts.extend(last.into_iter().map(|h| at_hop + h));
    } else {
        let mut t = at_hop as f32;
        for w in &weights[at_word..] {
            starts.push(t.round() as usize);
            t += w * pace;
        }
    }
    for k in 1..starts.len() {
        starts[k] = starts[k].max(starts[k - 1]);
    }
    starts
}

/// The voice's rate in a finished sentence: voiced hops per unit of weight.
pub fn hops_per_syllable(db: &[f32], words: &[String]) -> Option<f32> {
    let starts = word_starts(db, words);
    let (first, last) = (*starts.first()?, *starts.last()?);
    let weights: f32 = words[..words.len() - 1].iter().map(|w| weight(w)).sum();
    (weights > 0.0 && last > first).then(|| (last - first) as f32 / weights)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(s: &str) -> Vec<String> {
        words_of(s)
    }

    #[test]
    fn joined_words_are_split_and_bare_punctuation_dropped() {
        assert_eq!(words_of("this\u{2014}that and/or wait...what , ok \u{2014} fine"), vec!["this", "that", "and", "or", "wait", "what", "ok", "fine"]);
        assert_eq!(words_of("well-known 3.5 U.S. don't"), vec!["well-known", "3.5", "U.S.", "don't"]);
    }

    #[test]
    fn a_sentence_run_into_the_next_is_two_words() {
        assert_eq!(words_of("done today.Next week"), vec!["done", "today.", "Next", "week"]);
        assert_eq!(words_of("wait,what? ok!So"), vec!["wait,", "what?", "ok!", "So"]);
        assert_eq!(words_of("U.S.A e.g. nativeintelligence.dev Node.js 3.5"), vec!["U.S.A", "e.g.", "nativeintelligence.dev", "Node.js", "3.5"]);
    }

    #[test]
    fn partial_starts_place_finished_clauses_on_the_audio_and_the_rest_at_its_rate() {
        // "hello there," (3 syl over 50 hops), a 30-hop pause, then "everyone"
        // still coming in: the clause is on the audio, and "everyone" starts
        // where the voice did.
        let mut db = vec![-90.0; 20];
        db.extend(vec![-20.0; 50]);
        db.extend(vec![-90.0; 30]);
        db.extend(vec![-20.0; 10]);
        let w = words("hello there, everyone is here");
        let s = partial_starts(&db, &w, 15.0);
        assert_eq!(s.len(), 5);
        assert_eq!(s[0], 20);
        assert_eq!(s[2], 100, "{s:?}");
        // The rest at the rate this sentence is being said at.
        assert!(s[3] > s[2] && s[4] > s[3], "{s:?}");
        // Nothing in yet: the usual rate.
        assert_eq!(partial_starts(&[], &w, 20.0), provisional_starts(&w, 20.0));
    }

    /// Spike bench: each sentence's words as they'd be shown while it streams in
    /// (synthesis `R`× faster than it plays), the old guess and the final
    /// placement, in seconds, for bench/word_marks_stream.py to score.
    /// WORD_MARKS_DIR holds sentences.txt and wav/NN.wav.
    #[test]
    #[ignore]
    fn bench_streaming() {
        let dir = std::env::var("WORD_MARKS_DIR").expect("WORD_MARKS_DIR");
        let text = std::fs::read_to_string(format!("{dir}/sentences.txt")).unwrap();
        let sents: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        let mut dbs = Vec::new();
        for k in 0..sents.len() {
            let mut r = hound::WavReader::open(format!("{dir}/wav/{k:02}.wav")).unwrap();
            let spec = r.spec();
            let samples: Vec<f32> = match spec.sample_format {
                hound::SampleFormat::Int => r.samples::<i16>().map(|x| x.unwrap() as f32 / 32768.0).collect(),
                hound::SampleFormat::Float => r.samples::<f32>().map(|x| x.unwrap()).collect(),
            };
            let mono: Vec<f32> = samples.chunks(spec.channels as usize).map(|c| c.iter().sum::<f32>() / c.len() as f32).collect();
            let mut e = Envelope::new(spec.sample_rate);
            e.push(&mono);
            dbs.push(e.db());
        }
        let words: Vec<Vec<String>> = sents.iter().map(|s| words_of(s)).collect();
        let paces: Vec<f32> = (0..sents.len()).map(|k| hops_per_syllable(&dbs[k], &words[k]).unwrap_or(15.0)).collect();
        let sec = |v: &[usize]| v.iter().map(|&h| h as f64 / 100.0).collect::<Vec<_>>();
        let mut out = serde_json::Map::new();
        for k in 0..sents.len() {
            let others: Vec<f32> = paces.iter().enumerate().filter(|(i, _)| *i != k).map(|(_, p)| *p).collect();
            let usual = others.iter().sum::<f32>() / others.len().max(1) as f32;
            let db = &dbs[k];
            let fin = word_starts(db, &words[k]);
            let prov = provisional_starts(&words[k], usual);
            let mut row = serde_json::Map::new();
            row.insert("words".into(), serde_json::json!(words[k]));
            row.insert("final".into(), serde_json::json!(sec(&fin)));
            row.insert("prov".into(), serde_json::json!(sec(&prov)));
            row.insert("clauses".into(), serde_json::json!(sec(&sentence_starts(db, &words[k], usual))));
            for r in [2usize, 3, 4] {
                // Each word as shown: placed on the audio made by the time it plays.
                let shown: Vec<usize> = (0..words[k].len())
                    .map(|i| {
                        let len = (fin[i] * r + 5).min(db.len());
                        partial_starts(&db[..len], &words[k], usual)[i]
                    })
                    .collect();
                row.insert(format!("stream{r}"), serde_json::json!(sec(&shown)));
            }
            out.insert(format!("{k:02}"), serde_json::Value::Object(row));
        }
        std::fs::write(format!("{dir}/marks.json"), serde_json::to_string_pretty(&out).unwrap()).unwrap();
    }

    #[test]
    fn syllables_are_counted_roughly_right() {
        assert_eq!(syllables("the"), 1.0);
        assert_eq!(syllables("quarterly"), 3.0);
        assert_eq!(syllables("planned."), 1.0);
        assert_eq!(syllables("API"), 3.0);
        assert_eq!(syllables("make"), 1.0);
        assert_eq!(syllables("table"), 2.0);
    }

    #[test]
    fn words_are_spread_over_the_voiced_time_by_syllables_and_start_at_onsets() {
        // 10 ms hops: 20 silent, 50 voiced ("hello" 2 syl, "there" 1), a 30-hop
        // pause, 40 voiced ("everyone" 3 syl).
        let mut db = vec![-90.0; 20];
        db.extend(vec![-20.0; 50]);
        db.extend(vec![-90.0; 30]);
        db.extend(vec![-20.0; 40]);
        db.extend(vec![-90.0; 10]);
        let w = words("hello there, everyone");
        let s = word_starts(&db, &w);
        assert_eq!(s[0], 20); // at the first sound
        assert!(s[1] > 20 && s[1] < 70, "{s:?}");
        assert_eq!(s[2], 100, "{s:?}"); // after the pause, at its onset
    }

    #[test]
    fn the_envelope_is_per_10_ms() {
        let mut e = Envelope::new(48_000);
        e.push(&vec![0.5; 480 * 3 + 100]);
        assert_eq!(e.db().len(), 3);
        assert!((e.db()[0] - 10.0 * 0.25f32.log10()).abs() < 0.01);
    }

    #[test]
    fn provisional_starts_follow_the_rate() {
        let w = words("the quarterly numbers");
        let s = provisional_starts(&w, 20.0);
        assert_eq!(s[0], 0);
        assert_eq!(s[1], (1.35f32 * 20.0).round() as usize);
    }
}
