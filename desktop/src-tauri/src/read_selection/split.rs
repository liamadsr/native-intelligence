//! Selected text → the sentences to speak, one `tts_speak`-sized piece each.
//!
//! A port of the web's `plainTextToSentences` (web
//! src/lib/read-aloud/speech-text.ts): bare URLs read as their host, emoji go,
//! each line reads as its own sentences and ends like one, and a sentence is
//! never cut at an abbreviation, a decimal, an initial or an ellipsis. Keep
//! the two in step.
//!
//! One addition for text selected outside the app: lines a terminal or a man
//! page hard-wrapped are joined back into their paragraph first
//! ([`unwrap_lines`]), or every line would read as a sentence of its own.

use std::sync::LazyLock;

use regex::Regex;

/// Abbreviations that never end a sentence ("Dr. Smith", "e.g. this", "Acme Inc. said").
const NEVER_SPLIT: &[&str] = &[
    "mr", "mrs", "ms", "mx", "dr", "prof", "sr", "jr", "st", "mt", "ft", "fr", "gen", "col", "lt", "sgt", "capt",
    "cmdr", "adm", "rep", "sen", "gov", "pres", "hon", "rev", "vs", "v", "cf", "approx", "appt", "dept", "est", "fig",
    "figs", "eq", "al", "ca", "viz", "inc", "ltd", "co", "corp", "llc", "plc", "bros", "jan", "feb", "mar", "apr",
    "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "e.g", "i.e", "u.s", "u.k", "u.n", "e.u", "u.s.a",
    "ph.d", "m.d", "b.a", "m.a", "b.sc", "m.sc", "a.k.a",
];
/// Abbreviations that end a sentence only when a capital follows ("… etc. Then").
const SPLIT_BEFORE_CAPITAL: &[&str] = &["etc", "a.m", "p.m", "no", "nos"];

const MAX_WORDS: usize = 40;
const MIN_PART_WORDS: usize = 6;
/// A piece with no comma to cut at (a run-on line, minified text) is cut
/// every this many words instead, so no piece outgrows the sidecar's limit.
const HARD_CUT_WORDS: usize = 60;

static EMOJI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\p{Extended_Pictographic}\x{1F1E6}-\x{1F1FF}\x{1F3FB}-\x{1F3FF}\x{200D}\x{FE0E}\x{FE0F}\x{20E3}]")
        .expect("emoji regex")
});
static URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)\bhttps?://[^\s<>()\[\]]*[^\s<>()\[\].,;:!?'"”’]"#).expect("url regex"));
static URL_SCHEME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^https?://(?:www\.)?").expect("scheme regex"));
static MAILTO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bmailto:").expect("mailto regex"));
static SPACE_BEFORE_PUNCT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+([.,;:!?])").expect("punct regex"));
/// Terminal punctuation run, closing quotes/brackets, then whitespace.
static BOUNDARY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"([.!?…]+)(["'”’)\]]*)(\s+)"#).expect("boundary regex"));
static TERMINAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"[.!?…:;]["'”’)\]]*$"#).expect("terminal regex"));
/// A list item's bullet: not read out ("•" and its kind; "- " and "* " as markdown writes them).
static BULLET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:[•◦▪‣●○■□►▸➤]\s*|[–—*-]\s+)").expect("bullet regex"));
static DOTTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:\p{L}\.)+\p{L}$").expect("dotted regex"));

/// Selected text → sentences, in order. Empty when nothing is speakable.
pub fn sentences(text: &str) -> Vec<String> {
    // A bullet mid-line is a list item's start that lost its line ("…storyboard• Phase three").
    let text = text.replace(['•', '◦', '▪', '‣'], "\n•");
    unwrap_lines(&text)
        .iter()
        .flat_map(|line| {
            let speech = plain_text_to_speech(&BULLET.replace(line, ""));
            if speech.is_empty() {
                Vec::new()
            } else {
                split_sentences(&with_terminal_punctuation(&speech))
            }
        })
        .collect()
}

/// Join hard-wrapped lines back into their paragraphs: a line that doesn't
/// end a sentence runs on into the next when that one starts in lowercase
/// ("…the quick brown\nfox jumps…"), as long as its paragraph opened like
/// prose (a letter, a digit or a quote), not like a list item or a shell
/// prompt ("- item", "$ npm install"). A blank line always keeps its break.
fn unwrap_lines(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut joinable = false;
    let mut prose = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            joinable = false;
            continue;
        }
        let starts_lower = line.chars().next().is_some_and(char::is_lowercase);
        match lines.last_mut() {
            Some(last) if joinable && starts_lower => {
                last.push(' ');
                last.push_str(line);
            }
            _ => {
                prose = line.chars().next().is_some_and(|c| c.is_alphanumeric() || "\"'“‘(".contains(c));
                lines.push(line.to_string());
            }
        }
        joinable = prose && !TERMINAL.is_match(lines.last().map(String::as_str).unwrap_or_default());
    }
    lines
}

fn plain_text_to_speech(input: &str) -> String {
    let hosts = URL.replace_all(input, |caps: &regex::Captures| {
        let rest = URL_SCHEME.replace(&caps[0], "");
        rest.split(['/', '?', '#']).next().unwrap_or_default().to_string()
    });
    let text = MAILTO.replace_all(&hosts, "");
    finish_speech(&EMOJI.replace_all(&text, ""))
}

/// Collapse whitespace; "" when nothing speakable is left (only punctuation).
fn finish_speech(s: &str) -> String {
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let text = SPACE_BEFORE_PUNCT.replace_all(&collapsed, "$1").trim().to_string();
    if text.chars().any(char::is_alphanumeric) {
        text
    } else {
        String::new()
    }
}

/// Headings and list items read as sentences: add a period when missing.
fn with_terminal_punctuation(text: &str) -> String {
    if TERMINAL.is_match(text) {
        text.to_string()
    } else {
        format!("{text}.")
    }
}

fn split_sentences(text: &str) -> Vec<String> {
    text.lines()
        .flat_map(|line| split_line(&line.split_whitespace().collect::<Vec<_>>().join(" ")))
        .flat_map(|s| split_long_sentence(&s))
        .flat_map(|s| hard_cut(&s))
        .collect()
}

fn split_line(line: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    if line.is_empty() {
        return sentences;
    }
    let mut start = 0;
    for caps in BOUNDARY.captures_iter(line) {
        let whole = caps.get(0).expect("match");
        let punct = &caps[1];
        let end_of_sentence = whole.start() + punct.len() + caps[2].len();
        let next = &line[whole.end()..];
        if next.is_empty() {
            break;
        }
        if !is_boundary(&line[start..whole.start()], punct, next) {
            continue;
        }
        sentences.push(line[start..end_of_sentence].trim().to_string());
        start = whole.end();
    }
    let rest = line[start..].trim();
    if !rest.is_empty() {
        sentences.push(rest.to_string());
    }
    sentences
}

/// Should the text before `punct` end here, given what follows?
fn is_boundary(before: &str, punct: &str, next: &str) -> bool {
    // Ellipses trail off mid-thought: "Well… maybe". Never a cut.
    if punct.contains('…') || punct.contains("..") {
        return false;
    }
    // "?" and "!" always end a sentence.
    if !punct.starts_with('.') {
        return true;
    }
    let Some(next_char) = next.chars().next() else {
        return false;
    };
    // "e.g. the", "approx. two": a lowercase continuation is never a new sentence.
    if next_char.is_lowercase() {
        return false;
    }
    let token = before
        .split_whitespace()
        .next_back()
        .unwrap_or_default()
        .trim_start_matches(['"', '\'', '“', '‘', '(', '[']);
    let key = token.to_lowercase();
    if NEVER_SPLIT.contains(&key.as_str()) {
        return false;
    }
    if SPLIT_BEFORE_CAPITAL.contains(&key.as_str()) {
        if key == "no" || key == "nos" {
            return !next_char.is_ascii_digit();
        }
        return next_char.is_uppercase();
    }
    // Initials: "J. R. R. Tolkien", "John F. Kennedy" (but "So did I. Then").
    let mut chars = token.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_uppercase() && c != 'I' {
            return false;
        }
    }
    // Dotted abbreviations not in the list: "N.A.S.A. rocket" / "a.b.c.".
    if DOTTED.is_match(token) {
        return false;
    }
    // A bare number opening a sentence ("1. Setup") is a label, not a sentence.
    if (1..=3).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_digit()) && before.trim() == token {
        return false;
    }
    true
}

fn ends_with_mark(word: &str, mark: char) -> bool {
    word.trim_end_matches(['"', '\'', '”', '’', ')', ']']).ends_with(mark)
}

/// Cut a finished sentence over ~40 words at the ; or , nearest its middle.
fn split_long_sentence(sentence: &str) -> Vec<String> {
    let words: Vec<&str> = sentence.split(' ').collect();
    if words.len() <= MAX_WORDS {
        return vec![sentence.to_string()];
    }
    let mid = words.len() as f64 / 2.0;
    let mut best: Option<usize> = None;
    let mut best_score = f64::INFINITY;
    for i in (MIN_PART_WORDS - 1)..words.len().saturating_sub(MIN_PART_WORDS) {
        let semicolon = ends_with_mark(words[i], ';');
        if !semicolon && !ends_with_mark(words[i], ',') {
            continue;
        }
        // Prefer semicolons (a stronger pause), then the cut nearest the middle.
        let bonus = if semicolon { words.len() as f64 / 4.0 } else { 0.0 };
        let score = ((i + 1) as f64 - mid).abs() - bonus;
        if score < best_score {
            best_score = score;
            best = Some(i);
        }
    }
    let Some(best) = best else {
        return vec![sentence.to_string()];
    };
    let mut parts = split_long_sentence(&words[..=best].join(" "));
    parts.extend(split_long_sentence(&words[best + 1..].join(" ")));
    parts
}

/// A finished sentence from elsewhere (the web's who-said-what), cut the way
/// [`sentences`] cuts its own: at the pause nearest the middle past ~40 words,
/// else every [`HARD_CUT_WORDS`], so no piece outgrows what the voice takes.
pub fn pieces(sentence: &str) -> Vec<String> {
    split_long_sentence(sentence).iter().flat_map(|part| hard_cut(part)).collect()
}

/// The last resort for a piece with nowhere to cut: every [`HARD_CUT_WORDS`].
fn hard_cut(piece: &str) -> Vec<String> {
    let words: Vec<&str> = piece.split(' ').collect();
    if words.len() <= HARD_CUT_WORDS {
        return vec![piece.to_string()];
    }
    words.chunks(HARD_CUT_WORDS).map(|chunk| chunk.join(" ")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_plain_sentences() {
        assert_eq!(sentences("Hello there. How are you? Fine!"), ["Hello there.", "How are you?", "Fine!"]);
    }

    #[test]
    fn keeps_abbreviations_decimals_and_initials_together() {
        assert_eq!(
            sentences("Dr. Smith paid $4.2M, e.g. for J. R. R. Tolkien's books. Then he left."),
            ["Dr. Smith paid $4.2M, e.g. for J. R. R. Tolkien's books.", "Then he left."]
        );
    }

    #[test]
    fn ellipses_never_cut() {
        assert_eq!(sentences("Well… maybe. Or not."), ["Well… maybe.", "Or not."]);
    }

    #[test]
    fn lines_read_as_sentences_and_get_a_period() {
        assert_eq!(sentences("Install\n\nRun the app"), ["Install.", "Run the app."]);
    }

    #[test]
    fn hard_wrapped_lines_join_back_into_their_paragraph() {
        let wrapped = "The quick brown fox jumps over\nthe lazy dog and keeps\nrunning. It stops.\nNext paragraph";
        assert_eq!(
            sentences(wrapped),
            ["The quick brown fox jumps over the lazy dog and keeps running.", "It stops.", "Next paragraph."]
        );
    }

    #[test]
    fn list_items_and_prompts_keep_their_breaks() {
        assert_eq!(sentences("- first item\n- second item"), ["first item.", "second item."]);
        assert_eq!(sentences("-5 degrees\n* starred"), ["-5 degrees.", "starred."]);
        assert_eq!(sentences("$ npm install\nadded 3 packages"), ["$ npm install.", "added 3 packages."]);
    }

    #[test]
    fn a_list_that_lost_its_lines_reads_item_by_item() {
        // As a Chromium or Electron app's accessibility text gives it.
        assert_eq!(
            sentences("In order:• Phase two: storyboard• Phase three: record into placeholders"),
            ["In order:", "Phase two: storyboard.", "Phase three: record into placeholders."]
        );
    }

    #[test]
    fn urls_read_as_their_host_and_emoji_go() {
        assert_eq!(sentences("See https://www.docs.dial8.ai/api?x=1. 🎉 Done"), ["See docs.dial8.ai.", "Done."]);
    }

    #[test]
    fn nothing_speakable_is_empty() {
        assert!(sentences("  \n--- ***\n").is_empty());
        assert!(sentences("🎉🎉").is_empty());
    }

    #[test]
    fn long_sentences_cut_at_a_comma_near_the_middle() {
        let long = (0..50).map(|i| if i == 24 { "word,".to_string() } else { "word".to_string() }).collect::<Vec<_>>();
        let parts = sentences(&long.join(" "));
        assert_eq!(parts.len(), 2);
        assert!(parts[0].ends_with("word,"));
    }

    #[test]
    fn run_on_text_is_hard_cut() {
        let run_on = vec!["word"; 150].join(" ");
        let parts = sentences(&run_on);
        assert_eq!(parts.len(), 3);
        assert!(parts.iter().all(|p| p.split(' ').count() <= HARD_CUT_WORDS));
    }
}
