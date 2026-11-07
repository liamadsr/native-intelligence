//! local-tts adapter: read-aloud through the Pocket TTS sidecar, played on the
//! Mac's speakers (dial8-website/docs/plans/local-modules.md, Part 3).
//!
//! Commands (bridge contract, optional on the web like the rest):
//! - `tts_speak { id, text, voice? }` → `Result<(), String>`; errors
//!   `"recording"`, `"not_ready"`, `"unavailable"`, `"text_too_long"` (over
//!   [`MAX_SPEAK_BYTES`]). Queues one sentence, normalized here
//!   ([`normalize`]) off the main thread. Sentences queue in the order their
//!   calls return, so callers chain them (the web does).
//! - `tts_cancel {}`  stops sound now and clears the queue.
//! - `tts_prepare {}` starts the sidecar ahead of the first sentence.
//! - `tts_voices {}`  the compiled-in voice catalogue; never starts anything.
//!
//! The webview that last called `tts_speak` owns the speech: when its page
//! reloads or navigates away, or its window closes, the speech is cancelled
//! ([`TtsService::cancel_if_owner`]), since no page is left to show a Stop
//! control for it.
//!
//! Event `tts://state` `{ id, state, error? }`, per utterance, in order:
//! `queued` → `speaking` (its first sample reaches the device) → `done` (its
//! last sample has played), or `cancelled` / `error` instead.
//!
//! Lifecycle ([`Lifecycle::IdleTimeout`]): one long-lived sidecar, started on
//! the first `speak` or `prepare`, reused for every later sentence, stopped
//! gracefully (`shutdown`, stdin EOF, reap) after 5 idle minutes, on
//! `module_disable` / `module_remove_assets`, and at app exit. After an
//! unexpected exit it restarts on the next demand, at most 3 times in 10
//! minutes; beyond that `tts_speak` answers `"unavailable"`.
//!
//! Everything runs through one actor task ([`Actor`]) that owns the sidecar
//! link, the utterance queue, the resampler and the output stream, so there
//! are no locks on the hot path. Only cancel reaches past it: it silences the
//! output through the shared [`CancelGate`] before the actor even sees it.
//!
//! Voice-mode hooks (Rust only, for the voice session; nothing here changes
//! the commands or the `tts://state` payloads):
//! - [`TtsService::hold_output`] keeps the output stream open for as long as
//!   the returned [`OutputHold`] lives, instead of closing it ~2 s after the
//!   queue drains (each close/reopen restarts the echo canceller's
//!   convergence), and installs a playback reference tap
//!   ([`crate::audio::tap`]) on whichever output stream is open meanwhile.
//! - [`TtsService::subscribe_speaking`]: a watch channel that is `true` from
//!   the moment an utterance's first sample reaches the device until its
//!   last one has played — the points where `tts://state` emits `speaking`
//!   and `done` — and `false` in between sentences and after a cancel.
//! - [`TtsService::refresh_output`]: reopen a held output where speech
//!   should play now once playback is idle (call it on an output-route or
//!   pairing change; [`TtsService::refresh_output_unless_on`] skips the
//!   reopen when the stream is already on that device).
//!
//! Every open plays on the device `audio::speech_output` picks: the chosen
//! mic's own output for a USB or Bluetooth headset, else the system default.

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;

use super::manager::{LaunchConfig, ModuleManager, ModuleState};
use super::protocol::Frame;
use super::registry::{self, Lifecycle};
use super::supervisor::{Link, Sidecar, SidecarProcess};
use crate::audio::playback::{CancelGate, Player, SpeechResampler, SPEECH_RATE};
use crate::audio::time_stretch::{clamp_rate, TimeStretch};
use crate::audio::tap::TapWriter;

pub const MODULE_ID: &str = "local-tts";
pub const STATE_EVENT: &str = "tts://state";
/// Event `tts://word` `{ id, index, count, word }`: the word now being said
/// (spike: read-along in the HUD). Sent a moment before it's heard
/// ([`WORD_LEAD`]): a word seen just before it's heard reads as in step,
/// one seen after as late. Where each word falls: [`crate::audio::word_marks`].
pub const WORD_EVENT: &str = "tts://word";
/// How early a word is sent before its place in the audio.
const WORD_LEAD: Duration = Duration::from_millis(60);

/// Synthesis settings decided by listening (plan §3.2).
const THREADS: u32 = 2;
const LSD_STEPS: u32 = 8;
/// Model load + handshake. ~0.3 s warm; generous for a cold disk cache.
const START_TIMEOUT: Duration = Duration::from_secs(30);
/// Everything app quit waits for, at most (quit.rs).
const EXIT_TIMEOUT: Duration = Duration::from_secs(3);
/// Opening the output device, at most. A wedged CoreAudio (seen while the Mac
/// is locked) can block the HAL client's init forever.
const OUTPUT_OPEN_TIMEOUT: Duration = Duration::from_secs(5);
/// Longest text one `tts_speak` takes, before normalization. The web sends
/// one sentence of ≤ 40 words per call; this keeps the normalizer's work
/// (linear, ~5–7 µs per byte) small.
pub const MAX_SPEAK_BYTES: usize = 4_000;
/// Longest normalized text handed to the sidecar. Normalizing expands text
/// (~2.5×); a frame the sidecar can't read would end its session.
const MAX_SIDECAR_TEXT_BYTES: usize = 12_000;
/// Sentences the sidecar may hold beyond the one playing. It synthesizes
/// ~6× faster than real time, so this bounds buffered audio (and the work a
/// cancel throws away) without ever starving playback.
const READ_AHEAD: usize = 3;

const VOICES_JSON: &str = include_str!("../../sidecars/local-tts/voices/voices.json");

// ─── voices ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct Catalogue {
    #[allow(dead_code)] // format version; checked by the sidecar's build
    version: u32,
    default: String,
    voices: Vec<CatalogueVoice>,
}

#[derive(Deserialize)]
struct CatalogueVoice {
    id: String,
    name: String,
    #[serde(default)]
    description: String,
}

/// One `tts_voices` entry.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct VoiceInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "default")]
    pub is_default: bool,
}

fn catalogue() -> Catalogue {
    serde_json::from_str(VOICES_JSON).unwrap_or_else(|e| panic!("voices.json is invalid: {e}"))
}

/// The compiled-in voice catalogue (the same file the sidecar embeds).
pub fn voices() -> Vec<VoiceInfo> {
    let c = catalogue();
    c.voices
        .into_iter()
        .map(|v| VoiceInfo { is_default: v.id == c.default, id: v.id, name: v.name, description: v.description })
        .collect()
}

fn default_voice() -> String {
    catalogue().default
}

/// The voice to send: the requested one if the engine has it, else the
/// catalogue default, else whatever the engine has first. An id the engine
/// (or, before its `ready` listed any, the catalogue) doesn't know never
/// reaches the sidecar, which would answer `unknown_voice`: a page that
/// saved a voice since removed (the Kyutai voices, until 2026-09) still
/// speaks, in the default voice.
fn resolve_voice(requested: Option<&str>, engine_voices: &[String]) -> String {
    let has = |v: &str| {
        if engine_voices.is_empty() {
            catalogue().voices.iter().any(|c| c.id == v)
        } else {
            engine_voices.iter().any(|e| e == v)
        }
    };
    if let Some(v) = requested {
        if has(v) {
            return v.to_string();
        }
        crate::log_to_file(&format!("[module:{}] unknown voice {:?}; using the default", MODULE_ID, v));
    }
    let default = default_voice();
    if has(&default) {
        return default;
    }
    engine_voices.first().cloned().unwrap_or(default)
}

// ─── text normalization ─────────────────────────────────────────────────────

/// Numbers and symbols to words ("$4.2M" → "four point two million
/// dollars"), links shortened first ([`links`]). The web has already turned
/// markdown into plain sentences; Pocket TTS reads text literally and does no
/// expansion of its own.
///
/// Apostrophes go out straight ([`apostrophes_in`]).
pub fn normalize(text: &str) -> String {
    let (pre, kept) = shield(&per_units(&prepass(&links(&apostrophes_in(text)))));
    let out = |s: String| s.replace(['’', '‘', 'ʼ'], "'");
    // spoken_forms runs last: the normalizer would join "A R R" back up.
    match std::panic::catch_unwind(|| text_processing_rs::tn_normalize_sentence(&pre)) {
        Ok(normalized) => spoken_forms(&out(unshield(&normalized, &kept))),
        Err(_) => {
            crate::log_to_file(&format!("[module:{}] normalizer panicked; speaking the text as written", MODULE_ID));
            spoken_forms(&out(unshield(&pre, &kept)))
        }
    }
}

/// Apostrophes as the normalizer needs them; [`normalize`] then sends every
/// one out straight. The model needs straight ones: with the curly one Mail,
/// Teams and smart quotes type it garbles a contraction in every voice
/// ("I’ll" → "I shall", "couldn’t" → "could", "you’re" → "you were").
///
/// The normalizer splits a word at a straight one, which lets it read
/// "5th's", "B2B's", "Henry VIII's" and "amazon.com's", but it then reads a
/// word of numeral letters before it as a numeral: "The part I'm" → "The
/// part one'm", "Our CI's" → "Our one hundred first's". So only after the
/// words [`shield`] would set aside (as it reads them: "Super Bowl LX's"
/// stays a numeral) and the pronoun "I" ("I'm", "I'll"; "Article I's" is a
/// numeral) does an apostrophe with a letter next go in curly, which the
/// normalizer keeps whole.
fn apostrophes_in(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    for (i, &c) in chars.iter().enumerate() {
        if !matches!(c, '\'' | '’' | '‘' | 'ʼ') {
            out.push(c);
            continue;
        }
        // The word before it, back to a space or an opening mark.
        let start = chars[..i]
            .iter()
            .rposition(|&p| p.is_whitespace() || matches!(p, '(' | '[' | '<' | '"' | '“' | '‘' | '\'' | '’' | 'ʼ' | '`' | '*'))
            .map_or(0, |p| p + 1);
        let word: String = chars[start..i].iter().collect();
        let letter_next = chars.get(i + 1).is_some_and(|n| n.is_alphabetic());
        let curl = letter_next
            && !word.is_empty()
            && if word == "I" || word == "i" {
                chars.get(i + 1) != Some(&'s')
            } else {
                misread_as_numeral(&word) && !numbered_numeral(&word, &previous_word(&chars, start))
            };
        out.push(if curl { '’' } else { '\'' });
    }
    out
}

/// The word before the one starting at `chars[start]`, its punctuation
/// trimmed as [`shield`] trims it.
fn previous_word(chars: &[char], start: usize) -> String {
    let mut end = start;
    while end > 0 && !chars[end - 1].is_whitespace() {
        end -= 1;
    }
    while end > 0 && chars[end - 1].is_whitespace() {
        end -= 1;
    }
    let from = chars[..end].iter().rposition(|c| c.is_whitespace()).map_or(0, |p| p + 1);
    let token: String = chars[from..end].iter().collect();
    token
        .trim_start_matches(['(', '[', '<', '"', '\'', '“', '‘', '`', '*'])
        .trim_end_matches(['.', ',', ';', ':', '!', '?', ')', ']', '>', '"', '\'', '”', '’', '…', '`', '*'])
        .to_string()
}

/// Words the normalizer reads as something else, set aside so they reach the
/// model as written (Liam heard "did" read as "nine hundred ninety nine"):
/// - a word of Roman-numeral letters, which it reads as an ordinal after a
///   capitalised word: "That did it" → "That nine hundred ninety ninth it",
///   "Ask Liv" → "Ask fifty fourth", "Our CI" → "Our one hundred first",
///   "Plan C". Kept as a numeral in capitals shaped like one after a name
///   ("Henry VIII", "Super Bowl LVIII", "MMXXVI"), and in any case after a
///   word that numbers things ("chapter iv", "Super Bowl LX");
/// - "in", which it reads as inches at the end of a sentence ("Come in." →
///   "Come inches", the period lost). After a number it is a unit ("5 in."),
///   unless a determiner or a name follows ("3 in a row", "1990 in Paris").
///
/// Only a whole word between spaces counts, punctuation around it aside:
/// "README.md", "CI/CD", "a.m." and "i.e." are the normalizer's to read. A
/// word right after a number is its unit ("10 m", "30 C", "$5 m"). Text that
/// already holds a private-use character (an icon font's glyph) goes through
/// as it is. Each word set aside goes out as one private-use character and
/// comes back in [`unshield`].
fn shield(text: &str) -> (String, Vec<String>) {
    if text.chars().any(|c| ('\u{E000}'..='\u{F8FF}').contains(&c)) {
        return (text.to_string(), Vec::new());
    }
    let mut tokens: Vec<(usize, usize)> = Vec::new();
    let mut start = None;
    for (i, c) in text.char_indices() {
        if c.is_whitespace() {
            if let Some(s) = start.take() {
                tokens.push((s, i));
            }
        } else if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(s) = start {
        tokens.push((s, text.len()));
    }
    // A token's word: the token without the punctuation around it.
    let core = |&(s, e): &(usize, usize)| -> (usize, usize) {
        let token = &text[s..e];
        let body = token.trim_start_matches(['(', '[', '<', '"', '\'', '“', '‘', '`', '*']);
        let lead = s + token.len() - body.len();
        let rest = body.trim_end_matches(['.', ',', ';', ':', '!', '?', ')', ']', '>', '"', '\'', '”', '’', '…', '`', '*']);
        (lead, lead + rest.len())
    };
    let word_at = |k: Option<usize>| k.and_then(|k| tokens.get(k)).map_or("", |t| {
        let (a, b) = core(t);
        &text[a..b]
    });

    let mut out = String::with_capacity(text.len());
    let mut kept: Vec<String> = Vec::new();
    let mut last = 0;
    for (k, token) in tokens.iter().enumerate() {
        let (a, b) = core(token);
        let word = &text[a..b];
        let previous = word_at(k.checked_sub(1));
        let next = word_at(Some(k + 1));
        out.push_str(&text[last..a]);
        if kept.len() < 0x1900 && misread_word(word, previous, next) {
            out.push(char::from_u32(0xE000 + kept.len() as u32).unwrap_or(' '));
            kept.push(word.to_string());
        } else {
            out.push_str(word);
        }
        last = b;
    }
    out.push_str(&text[last..]);
    (out, kept)
}

/// Words that number what follows them ("chapter iv", "Super Bowl LX").
const NUMBERING_WORDS: &[&str] = &[
    "chapter", "section", "part", "volume", "vol", "book", "act", "scene", "phase", "step", "appendix", "article",
    "clause", "title", "unit", "level", "stage", "round", "season", "episode", "page", "figure", "fig", "table",
    "item", "bowl", "war",
];

/// Words after which "in" is the word, not inches ("3 in a row").
const DETERMINERS: &[&str] = &[
    "a", "an", "the", "my", "your", "our", "their", "his", "her", "its", "this", "that", "these", "those", "each",
    "every", "all", "some", "one",
];

/// Whether [`shield`] sets `word` aside, given the words around it.
fn misread_word(word: &str, previous: &str, next: &str) -> bool {
    if word.is_empty() || !word.chars().all(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    let after_number = previous.ends_with(|c: char| c.is_ascii_digit());
    if word.eq_ignore_ascii_case("in") {
        let lower = next.to_ascii_lowercase();
        return !after_number || DETERMINERS.contains(&lower.as_str()) || next.starts_with(|c: char| c.is_ascii_uppercase());
    }
    !after_number && !numbered_numeral(word, previous) && misread_as_numeral(word)
}

/// After a numbering word only a real numeral reads as one: "chapter iv",
/// "Super Bowl LX"; not "The Act did", "Section D" or "Book Liv".
fn numbered_numeral(word: &str, previous: &str) -> bool {
    let one_case = word == word.to_ascii_lowercase() || word == word.to_ascii_uppercase();
    let upper = word.to_ascii_uppercase();
    let numeral = one_case
        && (upper.chars().all(|c| matches!(c, 'I' | 'V' | 'X')) || (upper.len() >= 2 && roman_value(&upper).is_some()));
    numeral && NUMBERING_WORDS.contains(&previous.to_ascii_lowercase().as_str())
}

fn unshield(text: &str, kept: &[String]) -> String {
    if kept.is_empty() {
        return text.to_string();
    }
    text.chars()
        .map(|c| match (c as u32).checked_sub(0xE000).and_then(|k| kept.get(k as usize)) {
            Some(word) => word.clone(),
            None => c.to_string(),
        })
        .collect()
}

/// A word of Roman-numeral letters the normalizer would read as a number, and
/// isn't one: any with a lowercase letter ("did", "Liv", "mix"), a single
/// letter other than "I" ("Plan C"), and capitals that aren't a numeral's
/// shape: only I, V and X ("II", "VIII", "XIV"), or a valid numeral of four or
/// more letters ("LVIII", "MMXXVI"), read as numerals; "CI", "CLI", "ML",
/// "DC", "XL", "DID" don't.
fn misread_as_numeral(word: &str) -> bool {
    if !word.chars().all(|c| "IVXLCDMivxlcdm".contains(c)) || word == "I" {
        return false;
    }
    if word.chars().any(|c| c.is_ascii_lowercase()) || word.len() == 1 {
        return true;
    }
    let ivx_only = word.len() >= 2 && word.chars().all(|c| matches!(c, 'I' | 'V' | 'X'));
    !(ivx_only || (word.len() >= 4 && roman_value(word).is_some()))
}

/// A Roman numeral in its standard form ("XIV" → 14; "IIII", "VX", "IC" → None).
fn roman_value(word: &str) -> Option<u32> {
    let digit = |c: char| match c {
        'I' => Some(1),
        'V' => Some(5),
        'X' => Some(10),
        'L' => Some(50),
        'C' => Some(100),
        'D' => Some(500),
        'M' => Some(1000),
        _ => None,
    };
    let values: Vec<u32> = word.chars().map(digit).collect::<Option<_>>()?;
    let mut total = 0;
    for (k, v) in values.iter().enumerate() {
        if values.get(k + 1).is_some_and(|next| next > v) {
            total -= *v as i64;
        } else {
            total += *v as i64;
        }
    }
    let value = u32::try_from(total).ok().filter(|v| (1..4000).contains(v))?;
    // Standard form only: re-encode and compare.
    let mut n = value;
    let mut canonical = String::new();
    for (v, s) in [(1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"), (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")] {
        while n >= v {
            canonical.push_str(s);
            n -= v;
        }
    }
    (canonical == word).then_some(value)
}

/// Links, paths and IDs, shortened. The normalizer spells them out a character
/// at a time ("H T T P S colon slash slash … thread eight f three a two c one d
/// dash …"), and the model takes 8–15 s over one sentence, drops the words
/// after a path, or babbles; a "…" glued to a link skips the normalizer and
/// reaches the model raw. People say a link as the site's name, so, for text
/// from anywhere (Read anywhere, email, chat link text; the web's
/// `urlsToHosts` has already cut a markdown link to its host):
/// - "https://www.amazon.com/dp/…", "shopify.com", "docs.dial8.ai/api" →
///   "Amazon", "Shopify", "Dial8"; a GitHub pull request or issue →
///   "pull request 915" / "issue 915", any other GitHub link → "Github";
/// - a "…" or ".." glued to a link or path means it was cut short: the
///   ellipsis goes, with the cut-off part;
/// - "owner/repo#915" → "number 915";
/// - a path ("src/lib/speech-text.ts", "~/notes/today.md") → its last part;
/// - a commit hash or UUID ("b31e14e", "8f3a2c1d-77b9-…"), or any ASCII token
///   over 40 characters with no space (a key, base64) → nothing.
///
/// Prose with slashes stays ("in-person/remote/hybrid", "Fly.io/Render",
/// "$9.99/user/month", which `per_units` reads next), and so do codes that
/// only look like hashes ("ed25519", "A1234567").
fn links(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut skip_space = false;
    while !rest.is_empty() {
        let word_at = rest.find(|c: char| !c.is_whitespace()).unwrap_or(rest.len());
        if !skip_space {
            out.push_str(&rest[..word_at]);
        }
        skip_space = false;
        rest = &rest[word_at..];
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        match spoken_token(&rest[..end]) {
            // Dropped: only its punctuation is left ("pushed b31e14e." →
            // "pushed."), and a colon that introduced it goes ("Ref: b31e14e." → "Ref.").
            Some(spoken) if !spoken.chars().any(char::is_alphanumeric) => {
                out.truncate(out.trim_end().trim_end_matches(':').len());
                out.push_str(&spoken);
                skip_space = out.is_empty();
            }
            Some(spoken) => out.push_str(&spoken),
            None => out.push_str(&rest[..end]),
        }
        rest = &rest[end..];
    }
    out
}

/// One whitespace-free token as [`links`] reads it; `None` keeps it as written.
fn spoken_token(token: &str) -> Option<String> {
    let body = token.trim_start_matches(['(', '[', '<', '"', '\'', '“', '‘', '`', '*']);
    let lead = &token[..token.len() - body.len()];
    let core = body.trim_end_matches(['.', ',', ';', ':', '!', '?', ')', ']', '>', '"', '\'', '”', '’', '…', '`', '*']);
    let trail = &body[core.len()..];
    // Cut short: only the ellipsis goes; a period after it ends the sentence.
    let after_cut = trail.strip_prefix('…').or_else(|| trail.strip_prefix("...")).or_else(|| trail.strip_prefix(".."));
    let spoken = spoken_link(core, after_cut.is_some())?;
    let trail = after_cut.unwrap_or(trail);
    if spoken.is_empty() {
        // Its brackets and quotes go with it: "(b31e14e)." → ".".
        return Some(trail.chars().filter(|&c| !matches!(c, ')' | ']' | '>' | '"' | '\'' | '”' | '’' | '`' | '*')).collect());
    }
    // Markdown markers and brackets around it are not speech:
    // "**github.com/a**" → "Github", "(liamadsr/dial8-website#915" → "number 915".
    let unmark = |s: &str| s.chars().filter(|&c| !matches!(c, '`' | '*' | '(' | ')' | '[' | ']' | '<' | '>')).collect::<String>();
    Some(format!("{}{spoken}{}", unmark(lead), unmark(trail)))
}

fn spoken_link(core: &str, cut: bool) -> Option<String> {
    if let Some((host, path)) = url_parts(core) {
        return Some(spoken_site(host, path, cut));
    }
    if let Some((path, number)) = core.split_once('#') {
        if let Some((owner, repo)) = path.split_once('/') {
            if is_name(owner) && is_name(repo) && !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()) {
                return Some(format!("number {number}"));
            }
        }
    }
    // A cut-off path: "liamadsr/dial8-corss-p…" → "liamadsr". Only with what a
    // path or repo name has and a list of words doesn't: a path's start, or a
    // 5+ character part with a digit or underscore ("red/green/blue…",
    // "Mon/Tue…", "in-person/remote…", "Q1/Q2…" and "cd a/b/.." stay).
    let path_like = has_path_prefix(core)
        || core.split('/').any(|part| part.len() >= 5 && part.contains(|c: char| c.is_ascii_digit() || c == '_'));
    if cut && path_like && core.chars().all(is_path_char) && !is_amount(core.split('/').next().unwrap_or("")) {
        if let Some((head, _)) = core.rsplit_once('/') {
            if head.chars().any(|c| c.is_ascii_alphabetic()) {
                return Some(last_part(head).to_string());
            }
        }
    }
    if is_path(core) {
        return Some(last_part(core).to_string());
    }
    // A key or base64 has a digit; a long hyphenated word or a path doesn't
    // count, nor a CJK sentence (no spaces either) or an email (reads well).
    let blob = core.len() > 40
        && core.is_ascii()
        && !core.contains(['@', '/'])
        && core.contains(|c: char| c.is_ascii_digit());
    if is_hex_id(core) || blob {
        return Some(String::new());
    }
    None
}

/// A link's host and what follows it ("https://www.github.com/a?b" →
/// ("github.com", "/a?b")): a link with a scheme or "www.", or a lowercase
/// domain with a known ending and a path ("github.com/a/b"; not
/// "Next.js/React", "Fly.io/Render" or the email "liam@dial8.ai"). Alone, a
/// domain needs a common ending ("amazon.com", "bbc.co.uk"): "good.it" and
/// "know.no" are a missing space after a period.
fn url_parts(core: &str) -> Option<(&str, &str)> {
    let lower = core.to_ascii_lowercase();
    let scheme = ["https://", "http://", "ftp://"].into_iter().find(|s| lower.starts_with(s));
    let rest = &core[scheme.map_or(0, str::len)..];
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, path) = rest.split_at(end);
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host);
    let host = match host.get(..4) {
        Some(www) if www.eq_ignore_ascii_case("www.") && host.len() > 4 => &host[4..],
        _ => host,
    };
    if host.is_empty() {
        return None;
    }
    if scheme.is_some() || lower.starts_with("www.") {
        return Some((host, path));
    }
    let named = !authority.contains('@') && !host.contains(|c: char| c.is_ascii_uppercase()) && is_domain(host);
    (named && (!path.is_empty() || is_common_domain(host))).then_some((host, path))
}

/// A domain that reads as one on its own: a common ending, or a country's
/// "co.uk" / "com.au" kind.
fn is_common_domain(host: &str) -> bool {
    let labels: Vec<&str> = host.split('.').collect();
    let n = labels.len();
    let tld = labels[n - 1];
    matches!(tld, "com" | "net" | "org" | "io" | "ai" | "dev" | "app")
        || (n >= 3 && tld.len() == 2 && matches!(labels[n - 2], "co" | "com" | "org" | "net" | "gov" | "ac" | "edu"))
}

/// A link as a person says it: a GitHub pull request or issue by its number
/// ("github.com/a/b/pull/915" → "pull request 915"; a cut-off link's number
/// may be cut too, so it is just "Github"), anything else by its site's name.
fn spoken_site(host: &str, path: &str, cut: bool) -> String {
    if host.eq_ignore_ascii_case("github.com") && !cut {
        let path = path.split(['?', '#']).next().unwrap_or("");
        let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
        if let [_, _, kind, number, ..] = parts.as_slice() {
            if !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()) {
                match *kind {
                    "pull" | "pulls" => return format!("pull request {number}"),
                    "issues" => return format!("issue {number}"),
                    _ => {}
                }
            }
        }
    }
    site_name(host)
}

/// "www.amazon.co.uk" → "Amazon", "docs.dial8.ai" → "Dial8", "GitHub.com" →
/// "GitHub", "bbc.co.uk" → "BBC" (no vowel: an acronym, which `spoken_forms`
/// may space out); "localhost" and an IP address stay as they are.
fn site_name(host: &str) -> String {
    let labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
    let n = labels.len();
    if n < 2 || labels.iter().all(|l| l.chars().all(|c| c.is_ascii_digit())) {
        return host.to_string();
    }
    // "co.uk", "com.au": the name is one label further in.
    let second_level = n >= 3
        && labels[n - 1].len() == 2
        && matches!(labels[n - 2].to_ascii_lowercase().as_str(), "co" | "com" | "org" | "net" | "gov" | "ac" | "edu");
    let name = labels[if second_level { n - 3 } else { n - 2 }];
    if name.contains(|c: char| c.is_ascii_uppercase()) {
        return name.to_string();
    }
    if !name.contains(['a', 'e', 'i', 'o', 'u', 'y']) && name.chars().all(|c| c.is_ascii_alphabetic()) {
        return name.to_ascii_uppercase();
    }
    let mut chars = name.chars();
    chars.next().map_or_else(String::new, |c| c.to_ascii_uppercase().to_string() + chars.as_str())
}

/// Domain endings a link without a scheme is recognised by. No file
/// extensions that are also country codes ("md", "rs", "py", "sh", "cc",
/// "so", "in"): "release.sh" and "main.cc" are files.
const TLDS: &[&str] = &[
    "com", "net", "org", "io", "ai", "dev", "app", "co", "me", "gg", "tv", "xyz", "info", "biz", "us", "uk", "ca", "au",
    "nz", "de", "fr", "es", "it", "nl", "se", "no", "fi", "dk", "ch", "at", "be", "ie", "eu", "jp", "cn", "br", "mx",
    "kr", "ly", "to", "fm", "gl", "im", "is", "la", "gov", "edu", "cloud", "tech", "site", "page", "run", "link",
    "blog", "news",
];

fn is_domain(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    let tld = host.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    host.contains('.')
        && host.split('.').all(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        && TLDS.contains(&tld.as_str())
}

fn is_name(part: &str) -> bool {
    !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

fn is_path_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '-' | '_' | '~' | '@' | '+')
}

/// A leading "/", "~/", "./" or "../" ("~10/user/month" and "...and/or" are
/// not paths).
fn has_path_prefix(core: &str) -> bool {
    core.starts_with('/') || core.starts_with("~/") || core.starts_with("./") || core.starts_with("../")
}

/// Two or more slashes, and a path's shape: a path's start ("~/notes/today.md")
/// or a file with an extension after lowercase folders ("src/lib/speech-text.ts")
/// or after three or more folders ("packages/ui/src/Button/Button.tsx"). Not
/// prose ("in-person/remote/hybrid", "Next.js/React/Vue.js", "U.S./U.K./EU",
/// "v2.1/v2.2/v3.0"), dates or rates ("9.99/user/month").
fn is_path(core: &str) -> bool {
    let parts: Vec<&str> = core.split('/').collect();
    if parts.len() < 3 || !core.chars().all(is_path_char) || is_amount(parts[0]) {
        return false;
    }
    if has_path_prefix(core) {
        return core.chars().any(|c| c.is_ascii_alphabetic());
    }
    let Some((file, folders)) = parts.split_last() else {
        return false;
    };
    let named = file.rsplit_once('.').is_some_and(|(name, ext)| {
        !name.is_empty() && (1..=5).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_lowercase())
    });
    let lowercase = folders.iter().all(|f| !f.is_empty() && !f.contains(|c: char| c.is_ascii_uppercase()));
    named && (lowercase || folders.len() >= 3)
}

fn last_part(path: &str) -> &str {
    let path = path.trim_end_matches('/');
    path.rsplit('/').next().unwrap_or(path)
}

/// A UUID, or a commit hash: 7+ lowercase hex characters where letters and
/// digits interleave ("b31e14e", "d41528f"; not "ed25519", "a1234567" or the
/// order code "7A2F9C1").
fn is_hex_id(core: &str) -> bool {
    let b = core.as_bytes();
    let uuid = b.len() == 36
        && b.iter().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { *c == b'-' } else { c.is_ascii_hexdigit() });
    let switches = b.windows(2).filter(|w| w[0].is_ascii_digit() != w[1].is_ascii_digit()).count();
    let hash = b.len() >= 7 && b.iter().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c)) && switches >= 2;
    uuid || hash
}

/// Words Pocket TTS garbles, in forms it says well (measured by reading the
/// audio back with local-stt; sidecars/local-tts/UPSTREAM.md):
/// - "Mm-hmm", "Mhm", "Mmhmm"…: "mamma", "mom" or nothing; "Uh-huh" comes
///   out every time.
/// - QoQ, YoY, MoM: read as letters run together ("CO two"), so spelled out.
/// - An all-caps acronym with a doubled letter and no vowel ("LLM", "MRR"),
///   and "ARR": a letter is lost ("LM", "AR"); spaced out ("L L M") they
///   are read right. Other acronyms read well as written and stay, as do
///   all-caps words ("KEEP", "TOO") and interjections ("HMM", "SHH").
fn spoken_forms(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() + 16);
    let mut i = 0;
    while i < chars.len() {
        // A word: letters, with hyphens only between letters ("Mm-hmm").
        let starts_word = chars[i].is_ascii_alphabetic() && (i == 0 || !chars[i - 1].is_alphanumeric());
        if !starts_word {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let mut j = i;
        while j < chars.len()
            && (chars[j].is_ascii_alphabetic()
                || (chars[j] == '-' && j > i && chars.get(j + 1).is_some_and(|c| c.is_ascii_alphabetic())))
        {
            j += 1;
        }
        let word: String = chars[i..j].iter().collect();
        if j < chars.len() && chars[j].is_alphanumeric() {
            out.push_str(&word); // part of a longer token ("B2B", "é")
        } else {
            out.push_str(&spoken_word(&word));
        }
        i = j;
    }
    out
}

fn spoken_word(word: &str) -> std::borrow::Cow<'_, str> {
    use std::borrow::Cow;
    let bare: String = word.chars().filter(|c| *c != '-').collect::<String>().to_ascii_lowercase();
    if matches!(bare.as_str(), "mmhmm" | "mmhm" | "mhm" | "mhmm" | "mmmhmm" | "mmhmmm" | "mmmhm") {
        return Cow::Borrowed(if word.starts_with('M') { "Uh-huh" } else { "uh-huh" });
    }
    match word {
        "QoQ" => return Cow::Borrowed("quarter over quarter"),
        "YoY" => return Cow::Borrowed("year over year"),
        "MoM" => return Cow::Borrowed("month over month"),
        _ => {}
    }
    let upper = (2..=6).contains(&word.len()) && word.chars().all(|c| c.is_ascii_uppercase());
    let doubled = word.as_bytes().windows(2).any(|w| w[0] == w[1]);
    let vowelless = !word.chars().any(|c| matches!(c, 'A' | 'E' | 'I' | 'O' | 'U' | 'Y'));
    let interjection = matches!(word, "HMM" | "HMMM" | "MMM" | "SHH" | "BRR" | "GRR" | "ZZZ" | "PSST" | "PFFT");
    if upper && doubled && ((vowelless && !interjection) || word == "ARR") {
        let mut spaced = String::with_capacity(word.len() * 2);
        for (k, c) in word.chars().enumerate() {
            if k > 0 {
                spaced.push(' ');
            }
            spaced.push(c);
        }
        return Cow::Owned(spaced);
    }
    Cow::Borrowed(word)
}

/// Symbols the normalizer leaves alone: `~` before an amount means "about".
fn prepass(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '~' {
            out.push(c);
            continue;
        }
        let mut rest = chars.clone();
        while rest.peek() == Some(&' ') {
            rest.next();
        }
        if rest.peek().is_some_and(|&n| n.is_ascii_digit() || matches!(n, '$' | '€' | '£' | '.')) {
            chars = rest;
            if !out.is_empty() && !out.ends_with(char::is_whitespace) {
                out.push(' ');
            }
            out.push_str("about ");
        } else {
            out.push(c);
        }
    }
    out
}

/// "$9.99/month" → "$9.99 per month", and "24/7" → "twenty four seven". The
/// normalizer leaves an amount glued to "/unit" untouched (the model then
/// garbles it) and reads "24/7" as a fraction. Only a slash between an amount
/// ("$9.99", "19", "1.2M", "40%") and a word is rewritten, so paths ("v2/api"),
/// URLs, dates and fractions stay as they are; a chain like "$9.99/user/month"
/// continues ("per user per month").
fn per_units(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() + 16);
    let mut chain = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let boundary_before = i == 0 || !chars[i - 1].is_alphanumeric();
        if boundary_before && chars[i..].starts_with(&['2', '4', '/', '7']) {
            let end = i + 4;
            if end == chars.len() || !(chars[end].is_alphanumeric() || chars[end] == '/') {
                out.push_str("twenty four seven");
                i = end;
                chain = false;
                continue;
            }
        }
        if c == '/' && (chain || is_amount(trailing_token(&out))) {
            let mut j = i + 1;
            while j < chars.len() && chars[j] == ' ' {
                j += 1;
            }
            let start = j;
            while j < chars.len() && chars[j].is_ascii_alphabetic() {
                j += 1;
            }
            if j > start && (j == chars.len() || !chars[j].is_alphanumeric()) {
                let word: String = chars[start..j].iter().collect();
                out.truncate(out.trim_end().len());
                out.push_str(" per ");
                out.push_str(unit_word(&word));
                chain = true;
                i = j;
                continue;
            }
        }
        chain = false;
        out.push(c);
        i += 1;
    }
    out
}

/// The run of non-space characters `out` ends with, ignoring trailing spaces.
fn trailing_token(out: &str) -> &str {
    let t = out.trim_end();
    // Past the whole whitespace char: a no-break or thin space is 2-3 bytes.
    let start = t
        .char_indices()
        .rev()
        .find(|(_, c)| c.is_whitespace())
        .map_or(0, |(p, c)| p + c.len_utf8());
    &t[start..]
}

/// "$9.99", "€19", "1,200", "1.2M", "40%": a number, maybe with a currency
/// sign, a K/M/B scale or a percent sign.
fn is_amount(token: &str) -> bool {
    let t = token.trim_start_matches(['(', '"', '\'', '“']);
    let t = t.strip_prefix(['$', '€', '£', '¥']).unwrap_or(t);
    let t = t.strip_suffix('%').unwrap_or(t);
    let t = t.strip_suffix(['K', 'M', 'B', 'k', 'm', 'b']).unwrap_or(t);
    t.starts_with(|c: char| c.is_ascii_digit()) && t.chars().all(|c| c.is_ascii_digit() || c == ',' || c == '.')
}

/// Spell out the unit abbreviations that follow "per".
fn unit_word(word: &str) -> &str {
    match word.to_ascii_lowercase().as_str() {
        "mo" | "mos" | "mth" | "mths" => "month",
        "yr" | "yrs" => "year",
        "wk" | "wks" => "week",
        "hr" | "hrs" => "hour",
        "min" | "mins" => "minute",
        "sec" | "secs" => "second",
        _ => word,
    }
}

// ─── events ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UtteranceState {
    Queued,
    Speaking,
    Done,
    Cancelled,
    Error,
}

/// `tts://state` payload. `error` (only with `state: "error"`) is a short
/// code: `not_ready`, `unavailable`, `engine_exited`, `engine_stalled`,
/// `output_device`, `text_too_long`, or the sidecar's own error code; details
/// go to the log.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WordEvent {
    pub id: String,
    pub index: usize,
    pub count: usize,
    pub word: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StateEvent {
    pub id: String,
    pub state: UtteranceState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ─── the host seam (real app vs. tests) ────────────────────────────────────

pub(crate) type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

pub(crate) enum StartError {
    /// The module stopped being enabled + ready.
    NotReady,
    /// Spawn or handshake failed; counts toward the restart budget.
    Failed(String),
}

/// A running, handshaken sidecar.
pub(crate) struct Engine {
    pub link: Link,
    /// `None` for in-process fakes in tests.
    pub process: Option<SidecarProcess>,
    /// Voices compiled into this sidecar (from its `ready`).
    pub voices: Vec<String>,
}

/// Everything the actor needs from the outside world.
pub(crate) trait Host: Send + Sync + 'static {
    fn start_engine(&self) -> BoxFuture<Result<Engine, StartError>>;
    fn open_output(&self, gate: Arc<CancelGate>) -> BoxFuture<Result<Player, String>>;
    /// Dropping a player closes its device stream, which blocks.
    fn close_output(&self, player: Player);
    fn emit(&self, event: StateEvent);
    /// The word now being said (read-along); nothing by default.
    fn emit_word(&self, _event: WordEvent) {}
}

struct AppHost {
    app: AppHandle,
    opener: OutputOpener,
}

/// Opens the output device on its own thread with a deadline. While an
/// earlier open is still stuck, later ones fail at once instead of piling up
/// blocked threads. A plain thread, not `spawn_blocking`: a runtime waits for
/// its blocking tasks when it shuts down, and a hung open never returns.
pub(crate) struct OutputOpener {
    busy: Arc<AtomicBool>,
    timeout: Duration,
}

pub(crate) const OUTPUT_NOT_RESPONDING: &str = "output device not responding";

impl OutputOpener {
    pub(crate) fn new(timeout: Duration) -> Self {
        Self { busy: Arc::new(AtomicBool::new(false)), timeout }
    }

    pub(crate) fn open<F>(&self, open: F) -> BoxFuture<Result<Player, String>>
    where
        F: FnOnce() -> Result<Player, String> + Send + 'static,
    {
        if self.busy.swap(true, Ordering::SeqCst) {
            return Box::pin(async { Err(format!("{OUTPUT_NOT_RESPONDING} (an earlier open is still stuck)")) });
        }
        struct Release(Arc<AtomicBool>);
        impl Drop for Release {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let release = Release(self.busy.clone());
        let (tx, rx) = oneshot::channel();
        let spawned = std::thread::Builder::new().name("tts-output-open".into()).spawn(move || {
            let result = {
                let _release = release; // also on panic
                open()
            };
            // After a timeout nobody listens: a late player drops here.
            let _ = tx.send(result);
        });
        if let Err(e) = spawned {
            // The closure (and its Release) dropped with the error.
            return Box::pin(async move { Err(format!("output open thread failed: {e}")) });
        }
        let timeout = self.timeout;
        Box::pin(async move {
            match tokio::time::timeout(timeout, rx).await {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => Err("output open thread failed".to_string()),
                Err(_) => Err(format!("{OUTPUT_NOT_RESPONDING} after {timeout:?}")),
            }
        })
    }
}

/// The voices a sidecar's `ready` lists.
fn ready_voices(ready: &Value) -> Vec<String> {
    ready
        .get("voices")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn configure(launch: &LaunchConfig) -> Value {
    json!({
        "assets": launch.assets_json(),
        "threads": THREADS,
        "lsdSteps": LSD_STEPS,
        "warmup": false,
    })
}

impl Host for AppHost {
    fn start_engine(&self) -> BoxFuture<Result<Engine, StartError>> {
        let app = self.app.clone();
        Box::pin(async move {
            let launch = app
                .state::<ModuleManager>()
                .launch_config(&app, MODULE_ID)
                .ok_or(StartError::NotReady)?;
            let started = std::time::Instant::now();
            let Sidecar { mut link, process } =
                Sidecar::spawn(MODULE_ID, &launch.exe, &[]).map_err(|e| StartError::Failed(e.to_string()))?;
            match link.handshake(MODULE_ID, configure(&launch), START_TIMEOUT).await {
                Ok(hello) => {
                    let voices = ready_voices(&hello.ready);
                    crate::log_to_file(&format!(
                        "[module:{}] ready in {:.2}s (v{}, voices {:?})",
                        MODULE_ID,
                        started.elapsed().as_secs_f64(),
                        hello.version,
                        voices
                    ));
                    Ok(Engine { link, process: Some(process), voices })
                }
                Err(e) => {
                    drop(link);
                    process.reap(Duration::from_secs(2)).await;
                    Err(StartError::Failed(e.to_string()))
                }
            }
        })
    }

    fn open_output(&self, gate: Arc<CancelGate>) -> BoxFuture<Result<Player, String>> {
        let app = self.app.clone();
        self.opener.open(move || crate::audio::speech_output::open(&app, gate))
    }

    fn close_output(&self, player: Player) {
        // Its own thread for the same reason as OutputOpener.
        let _ = std::thread::Builder::new().name("tts-output-close".into()).spawn(move || drop(player));
    }

    fn emit(&self, event: StateEvent) {
        let _ = self.app.emit(STATE_EVENT, event);
    }

    fn emit_word(&self, event: WordEvent) {
        let _ = self.app.emit(WORD_EVENT, event);
    }
}

// ─── the service (Tauri state) ─────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub(crate) struct Timing {
    pub idle: Duration,
    /// Close the output stream this long after the queue drains.
    pub linger: Duration,
    /// Playback bookkeeping cadence while the output is open.
    pub tick: Duration,
    /// No word from a sidecar that has work this long → it's hung.
    pub stall: Duration,
    pub restart_window: Duration,
    pub max_restarts: usize,
    pub shutdown_grace: Duration,
    /// A held output that failed to open, or whose device failed, is retried
    /// this often.
    pub reopen_backoff: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        let idle = match registry::find(MODULE_ID).map(|m| m.lifecycle) {
            Some(Lifecycle::IdleTimeout(d)) => d,
            _ => Duration::from_secs(5 * 60),
        };
        Self {
            idle,
            linger: Duration::from_secs(2),
            tick: Duration::from_millis(20),
            stall: Duration::from_secs(20),
            restart_window: Duration::from_secs(10 * 60),
            max_restarts: 3,
            shutdown_grace: Duration::from_secs(2),
            reopen_backoff: Duration::from_secs(1),
        }
    }
}

/// Unexpected exits and failed starts in the restart window.
struct CrashLog {
    times: Mutex<VecDeque<Instant>>,
    window: Duration,
    max_restarts: usize,
}

impl CrashLog {
    fn record(&self) {
        let mut times = self.times.lock().unwrap();
        times.push_back(Instant::now());
    }

    /// Each crash in the window allows one restart, up to `max_restarts`.
    fn exhausted(&self) -> bool {
        let mut times = self.times.lock().unwrap();
        let now = Instant::now();
        while times.front().is_some_and(|t| now.duration_since(*t) >= self.window) {
            times.pop_front();
        }
        times.len() > self.max_restarts
    }
}

enum Cmd {
    /// `epoch`: the service's cancel count when the speak was requested; a
    /// cancel since then (while the text was being normalized) cancels it.
    Speak { id: String, text: String, voice: Option<String>, epoch: u64 },
    Prepare,
    /// Paired with one `CancelGate::request`.
    Cancel,
    /// Paired with one `CancelGate::request`.
    Stop { reply: Option<oneshot::Sender<()>> },
    /// Keep the output open (see `OutputHold`), with this reference tap.
    Hold { token: u64, tap: Option<TapWriter> },
    /// End the hold `token`, if it is still the current one.
    Release { token: u64 },
    /// Reopen a held output where speech should play now, when idle; not
    /// when it is already on `unless_on` (an AudioObjectID).
    RefreshOutput { unless_on: Option<u32> },
}

pub struct TtsService {
    cmds: mpsc::UnboundedSender<Cmd>,
    gate: Arc<CancelGate>,
    crashes: Arc<CrashLog>,
    /// Cancels and stops requested so far (see `Cmd::Speak`).
    epoch: AtomicU64,
    /// Label of the webview that last asked to speak. `tts_prepare` doesn't
    /// claim it: starting the engine queues nothing, and a turn starting in
    /// one window must not take over speech another window is playing.
    owner: Mutex<Option<String>>,
    /// Hold tokens handed out so far (see `hold_output`).
    holds: AtomicU64,
    /// Audibly speaking right now (see `subscribe_speaking`).
    speaking: watch::Receiver<bool>,
    /// Speed, as f32 bits, shared with the actor (see `set_rate`).
    rate: Arc<AtomicU32>,
}

/// Keeps the speech output stream open, with its reference tap installed,
/// until dropped (see [`TtsService::hold_output`]). Dropping it lets the
/// stream close ~2 s after playback goes idle again, as without a hold.
pub struct OutputHold {
    token: u64,
    cmds: mpsc::UnboundedSender<Cmd>,
}

impl Drop for OutputHold {
    fn drop(&mut self) {
        let _ = self.cmds.send(Cmd::Release { token: self.token });
    }
}

impl TtsService {
    /// Create the service and start its actor on Tauri's runtime.
    pub fn spawn(app: AppHandle) -> Self {
        let host = AppHost { app, opener: OutputOpener::new(OUTPUT_OPEN_TIMEOUT) };
        let (service, actor) = Self::with_host(Arc::new(host), Timing::default());
        tauri::async_runtime::spawn(actor.run());
        service
    }

    pub(crate) fn with_host(host: Arc<dyn Host>, timing: Timing) -> (Self, Actor) {
        let (tx, rx) = mpsc::unbounded_channel();
        let gate = Arc::new(CancelGate::new());
        let crashes = Arc::new(CrashLog {
            times: Mutex::new(VecDeque::new()),
            window: timing.restart_window,
            max_restarts: timing.max_restarts,
        });
        let (speaking_tx, speaking) = watch::channel(false);
        let rate = Arc::new(AtomicU32::new(1.0f32.to_bits()));
        let actor = Actor {
            host,
            timing,
            gate: gate.clone(),
            crashes: crashes.clone(),
            cmds: rx,
            engine: EngineSlot::Stopped,
            output: OutputSlot::Closed,
            queue: VecDeque::new(),
            current: None,
            resampler: None,
            rate: rate.clone(),
            stretch: TimeStretch::new(SPEECH_RATE),
            stretched: Vec::new(),
            stash: Vec::new(),
            scratch: Vec::new(),
            drained_since: None,
            last_activity: Instant::now(),
            last_sidecar: Instant::now(),
            epoch: 0,
            hold: None,
            tap: None,
            refresh_output: false,
            reopen_at: None,
            speaking: speaking_tx,
            filling: None,
            pace: 15.0,
        };
        let service = Self {
            cmds: tx,
            gate,
            crashes,
            epoch: AtomicU64::new(0),
            owner: Mutex::new(None),
            holds: AtomicU64::new(0),
            speaking,
            rate,
        };
        (service, actor)
    }

    /// How fast speech plays, 0.5×–4× (the Speed setting; 1× by default).
    pub fn rate(&self) -> f32 {
        f32::from_bits(self.rate.load(Ordering::Relaxed))
    }

    /// Applies to sentences not yet synthesized: up to READ_AHEAD sentences
    /// already stretched and queued keep the speed they were made at.
    pub fn set_rate(&self, rate: f32) -> f32 {
        let rate = clamp_rate(rate);
        self.rate.store(rate.to_bits(), Ordering::Relaxed);
        rate
    }

    /// Queue one (already normalized) sentence.
    #[cfg(test)]
    pub fn speak(&self, id: String, text: String, voice: Option<String>) {
        self.speak_at(self.epoch(), id, text, voice);
    }

    /// Queue a sentence requested at `epoch` ([`Self::epoch`]); cancelled
    /// instead if a cancel has been requested since.
    pub(crate) fn speak_at(&self, epoch: u64, id: String, text: String, voice: Option<String>) {
        let _ = self.cmds.send(Cmd::Speak { id, text, voice, epoch });
    }

    fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    /// Record `label` (a webview) as the owner of the current speech, and
    /// return the epoch the speak it is about to queue belongs to. Both under
    /// the owner lock, as `cancel_if_owner`'s check and cancel are: a page
    /// going away either cancels before this (the speak gets the new epoch)
    /// or not at all (`label` owns the speech by then), never in between.
    pub fn claim(&self, label: &str) -> u64 {
        let mut owner = self.owner.lock().unwrap_or_else(|p| p.into_inner());
        if owner.as_deref() != Some(label) {
            *owner = Some(label.to_string());
        }
        self.epoch()
    }

    /// The page in webview `label` is going away (reload, navigation, window
    /// closed): cancel the speech it started. Speech another webview owns
    /// keeps playing. Returns whether it cancelled. Never blocks.
    pub fn cancel_if_owner(&self, label: &str) -> bool {
        {
            let mut owner = self.owner.lock().unwrap_or_else(|p| p.into_inner());
            if owner.as_deref() != Some(label) {
                return false;
            }
            *owner = None;
            // Under the lock (see `claim`); cancel never blocks.
            self.cancel();
        }
        crate::log_to_file(&format!("[module:{}] cancelled speech: its page in {:?} went away", MODULE_ID, label));
        true
    }

    /// Start the sidecar if it isn't running.
    pub fn prepare(&self) {
        let _ = self.cmds.send(Cmd::Prepare);
    }

    /// Stop sound now (next audio callback) and drop every pending sentence.
    /// Never blocks; safe from any thread.
    pub fn cancel(&self) {
        self.send_gated(Cmd::Cancel);
    }

    /// Cancel and stop the sidecar (module disabled). Never blocks.
    pub fn stop(&self) {
        self.send_gated(Cmd::Stop { reply: None });
    }

    /// Cancel, stop the sidecar and wait until it has exited (bounded), for
    /// app exit.
    pub async fn shutdown(&self) {
        let (reply, done) = oneshot::channel();
        self.send_gated(Cmd::Stop { reply: Some(reply) });
        if tokio::time::timeout(EXIT_TIMEOUT, done).await.is_err() {
            crate::log_to_file(&format!("[module:{}] shutdown timed out", MODULE_ID));
        }
    }

    /// Keep the output stream open until the returned guard is dropped (a
    /// voice session), opening it now if it is closed, and install `tap` as
    /// the playback reference: every mono sample the output renders,
    /// silence included, at the device rate ([`TapReader::rate`]). If the
    /// stream is reopened meanwhile (device failure, [`refresh_output`]) the
    /// tap moves to the new stream and its epoch changes
    /// ([`TapReader::epoch`]).
    ///
    /// One hold at a time: a new hold replaces the previous one (and its
    /// tap), and dropping a replaced guard does nothing. Never blocks.
    ///
    /// [`TapReader::rate`]: crate::audio::tap::TapReader::rate
    /// [`TapReader::epoch`]: crate::audio::tap::TapReader::epoch
    /// [`refresh_output`]: Self::refresh_output
    pub fn hold_output(&self, tap: Option<TapWriter>) -> OutputHold {
        let token = self.holds.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.cmds.send(Cmd::Hold { token, tap });
        OutputHold { token, cmds: self.cmds.clone() }
    }

    /// `true` while speech is audible: from the first sample of an utterance
    /// reaching the device (`tts://state` `speaking`) until its last sample
    /// has played (`done`); `false` between sentences, after a cancel, and
    /// with nothing queued. An utterance shorter than one bookkeeping tick
    /// (20 ms) may never show as `true`.
    pub fn subscribe_speaking(&self) -> watch::Receiver<bool> {
        self.speaking.clone()
    }

    /// Reopen the held output where speech should play now (the paired or
    /// the default device, `audio::speech_output`) as soon as playback is
    /// idle (now, if it already is). For output-route and pairing changes
    /// during a hold; without a hold the stream closes on its own and the
    /// next reply opens the current pick anyway. Never blocks.
    pub fn refresh_output(&self) {
        let _ = self.cmds.send(Cmd::RefreshOutput { unless_on: None });
    }

    /// [`refresh_output`](Self::refresh_output), unless the open stream is
    /// already on device `device_id` (an AudioObjectID): a reopen restarts
    /// the echo canceller's convergence for nothing. Never blocks.
    pub fn refresh_output_unless_on(&self, device_id: u32) {
        let _ = self.cmds.send(Cmd::RefreshOutput { unless_on: Some(device_id) });
    }

    /// Too many crashes recently; no restart until the window passes.
    pub fn exhausted(&self) -> bool {
        self.crashes.exhausted()
    }

    fn send_gated(&self, cmd: Cmd) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.gate.request();
        if self.cmds.send(cmd).is_err() {
            self.gate.ack(); // no actor to acknowledge it
        }
    }
}

// ─── the actor ─────────────────────────────────────────────────────────────

enum EngineSlot {
    Stopped,
    Starting(BoxFuture<Result<Engine, StartError>>),
    Running(Engine),
}

enum OutputSlot {
    Closed,
    Opening(BoxFuture<Result<Player, String>>),
    Open(Player),
}

/// Audio on its way to the player, in sidecar order. Held in `stash` while
/// the output stream opens.
enum Item {
    Start(String),
    Samples(u32, Vec<f32>),
    End(String),
}

struct Utterance {
    id: String,
    text: String,
    voice: Option<String>,
    /// Handed to the sidecar.
    sent: bool,
    /// The sidecar said `started`.
    started: bool,
    /// The sidecar said `done`; all its audio is in the player (or stash).
    synthesized: bool,
    /// `speaking` emitted.
    speaking: bool,
    /// Player timeline position of its first and one-past-last frame.
    start_mark: Option<u64>,
    end_mark: Option<u64>,
    /// Read-along: its words, the loudness of its audio as played, where each
    /// word starts on the player's timeline (placed at its syllable rate till
    /// its audio is all in, then from the audio), and the next to send.
    words: Vec<String>,
    envelope: Option<crate::audio::word_marks::Envelope>,
    word_marks: Vec<u64>,
    next_word: usize,
    /// Read-along: the envelope's length (hops) the marks were last placed on.
    marked_hops: usize,
    /// Read-along spike, debug builds: the sentence's audio as played, saved
    /// with its words' places (/tmp/dial8-readalong) to check against whisper.
    capture: Vec<f32>,
}

enum Event {
    Cmd(Option<Cmd>),
    Frame(Option<Frame>),
    Started(Result<Engine, StartError>),
    Opened(Result<Player, String>),
    Tick,
}

pub(crate) struct Actor {
    host: Arc<dyn Host>,
    timing: Timing,
    gate: Arc<CancelGate>,
    crashes: Arc<CrashLog>,
    cmds: mpsc::UnboundedReceiver<Cmd>,
    engine: EngineSlot,
    output: OutputSlot,
    /// Utterances not yet finished, in order.
    queue: VecDeque<Utterance>,
    /// The utterance whose audio frames are arriving (after its `started`).
    /// `None` drops frames, e.g. the tail of a cancelled one.
    current: Option<String>,
    resampler: Option<SpeechResampler>,
    /// Speed (`TtsService::rate`), taken at each sentence's start.
    rate: Arc<AtomicU32>,
    /// Plays a sentence faster or slower at the same pitch; ahead of the
    /// resampler, so it always works on the sidecar's 24 kHz.
    stretch: TimeStretch,
    stretched: Vec<f32>,
    stash: Vec<Item>,
    scratch: Vec<f32>,
    drained_since: Option<Instant>,
    /// Last request or playback progress; the idle timer runs from here.
    last_activity: Instant,
    /// Last sign of life from the sidecar (a frame, its start, or new work
    /// handed to it while it had none); the stall timer runs from here, so
    /// requests arriving can't hide a hung sidecar.
    last_sidecar: Instant,
    /// Cancels and stops handled so far; mirrors `TtsService::epoch`.
    epoch: u64,
    /// The current output hold's token: keep the output open while set.
    hold: Option<u64>,
    /// The hold's reference tap while no output stream is open (it lives in
    /// the player while one is).
    tap: Option<TapWriter>,
    /// Reopen the output (where speech should play now) once idle.
    refresh_output: bool,
    /// While held and closed: don't retry opening before this.
    reopen_at: Option<Instant>,
    /// Audibly speaking (see `TtsService::subscribe_speaking`).
    speaking: watch::Sender<bool>,
    /// The utterance whose audio is going into the player now (read-along's envelope).
    filling: Option<String>,
    /// The voice's pace: hops (10 ms) of voiced audio per unit of word weight
    /// at 1× ([`crate::audio::word_marks::hops_per_syllable`]), learned from
    /// each sentence played; places a sentence's words till its audio is in.
    pace: f32,
}

async fn engine_event(slot: &mut EngineSlot) -> Event {
    match slot {
        EngineSlot::Running(engine) => Event::Frame(engine.link.rx.recv().await),
        EngineSlot::Starting(start) => Event::Started(start.as_mut().await),
        EngineSlot::Stopped => std::future::pending().await,
    }
}

async fn output_event(slot: &mut OutputSlot) -> Event {
    match slot {
        OutputSlot::Opening(open) => Event::Opened(open.as_mut().await),
        _ => std::future::pending().await,
    }
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(d) => tokio::time::sleep_until(d).await,
        None => std::future::pending().await,
    }
}

fn emit(host: &Arc<dyn Host>, id: &str, state: UtteranceState, error: Option<&str>) {
    host.emit(StateEvent { id: id.to_string(), state, error: error.map(String::from) });
}

/// Graceful stop: `shutdown`, stdin EOF (by protocol it exits), reap.
async fn shutdown_engine(engine: Engine, grace: Duration) {
    let Engine { link, process, .. } = engine;
    let _ = link.tx.try_send(Frame::Json(json!({ "type": "shutdown" })));
    drop(link);
    if let Some(process) = process {
        process.reap(grace).await;
    }
}

impl Actor {
    pub(crate) async fn run(mut self) {
        loop {
            let deadline = self.deadline();
            let event = tokio::select! {
                cmd = self.cmds.recv() => Event::Cmd(cmd),
                ev = engine_event(&mut self.engine) => ev,
                ev = output_event(&mut self.output) => ev,
                _ = sleep_until(deadline) => Event::Tick,
            };
            match event {
                Event::Cmd(None) => {
                    // The service is gone (app teardown).
                    self.stop_everything(true).await;
                    return;
                }
                Event::Cmd(Some(cmd)) => self.on_command(cmd).await,
                Event::Frame(frame) => self.on_frame(frame),
                Event::Started(result) => self.on_started(result),
                Event::Opened(result) => self.on_opened(result),
                Event::Tick => {}
            }
            self.tick();
        }
    }

    fn deadline(&self) -> Option<Instant> {
        if matches!(self.output, OutputSlot::Open(_)) {
            return Some(Instant::now() + self.timing.tick);
        }
        if self.hold.is_some() && matches!(self.output, OutputSlot::Closed) {
            // Held but closed: the open to retry.
            return Some(self.reopen_at.unwrap_or_else(Instant::now));
        }
        if matches!(self.engine, EngineSlot::Running(_)) {
            if self.sendable() {
                // A full channel to the sidecar: retry shortly.
                return Some(Instant::now() + self.timing.tick);
            }
            if self.work_at_sidecar() {
                return Some(self.last_sidecar + self.timing.stall);
            }
            if self.queue.is_empty() {
                return Some(self.last_activity + self.timing.idle);
            }
        }
        None
    }

    /// Sentences handed to the sidecar that it hasn't finished.
    fn work_at_sidecar(&self) -> bool {
        self.queue.iter().any(|u| u.sent && !u.synthesized)
    }

    /// The read-ahead window: the sentence playing (the queue's front) and
    /// [`READ_AHEAD`] after it.
    fn window(&self) -> impl Iterator<Item = &Utterance> {
        self.queue.iter().take(READ_AHEAD + 1)
    }

    /// A sentence in the window still waits to be handed to the sidecar.
    fn sendable(&self) -> bool {
        self.window().any(|u| !u.sent)
    }

    async fn on_command(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Speak { id, text, voice, epoch } => {
                if epoch < self.epoch {
                    // Cancelled while its text was being normalized.
                    emit(&self.host, &id, UtteranceState::Queued, None);
                    emit(&self.host, &id, UtteranceState::Cancelled, None);
                } else {
                    self.on_speak(id, text, voice);
                }
            }
            Cmd::Prepare => {
                self.last_activity = Instant::now();
                if matches!(self.engine, EngineSlot::Stopped) && !self.crashes.exhausted() {
                    self.start_engine();
                }
            }
            Cmd::Cancel => {
                self.epoch += 1;
                self.cancel_all(UtteranceState::Cancelled, None);
                self.gate.ack();
            }
            Cmd::Stop { reply } => {
                self.epoch += 1;
                self.stop_everything(reply.is_some()).await;
                self.gate.ack();
                if let Some(reply) = reply {
                    let _ = reply.send(());
                }
            }
            Cmd::Hold { token, tap } => self.on_hold(token, tap),
            Cmd::Release { token } => self.on_release(token),
            Cmd::RefreshOutput { unless_on } => {
                if let OutputSlot::Open(player) = &self.output {
                    if unless_on.is_some() && player.device_id() == unless_on {
                        crate::log_to_file(&format!("[module:{}] output already on the device to use; not reopening", MODULE_ID));
                    } else {
                        self.refresh_output = true;
                    }
                }
            }
        }
    }

    fn on_hold(&mut self, token: u64, tap: Option<TapWriter>) {
        self.hold = Some(token);
        self.reopen_at = None;
        self.drained_since = None;
        // The new tap replaces any earlier hold's; the old one drops here, on
        // the actor, never on the audio thread.
        match &mut self.output {
            OutputSlot::Open(player) => drop(player.set_tap(tap)),
            _ => self.tap = tap,
        }
        if matches!(self.output, OutputSlot::Closed) {
            self.open_output();
        }
        crate::log_to_file(&format!("[module:{}] output held open (hold {})", MODULE_ID, token));
    }

    fn on_release(&mut self, token: u64) {
        if self.hold != Some(token) {
            return; // replaced by a newer hold, or already ended by a stop
        }
        self.hold = None;
        self.reopen_at = None;
        self.tap = None;
        if let OutputSlot::Open(player) = &mut self.output {
            drop(player.set_tap(None));
        }
        // The linger starts now, as if playback had just drained.
        self.drained_since = None;
        crate::log_to_file(&format!("[module:{}] output hold {} released", MODULE_ID, token));
    }

    fn open_output(&mut self) {
        self.output = OutputSlot::Opening(self.host.open_output(self.gate.clone()));
    }

    fn on_speak(&mut self, id: String, text: String, voice: Option<String>) {
        self.last_activity = Instant::now();
        emit(&self.host, &id, UtteranceState::Queued, None);
        if text.trim().is_empty() {
            emit(&self.host, &id, UtteranceState::Done, None);
            return;
        }
        if text.len() > MAX_SIDECAR_TEXT_BYTES {
            crate::log_to_file(&format!("[module:{}] {} bytes to speak; refusing", MODULE_ID, text.len()));
            emit(&self.host, &id, UtteranceState::Error, Some("text_too_long"));
            return;
        }
        let running = matches!(self.engine, EngineSlot::Running(_));
        if !running && self.crashes.exhausted() {
            emit(&self.host, &id, UtteranceState::Error, Some("unavailable"));
            return;
        }
        let words = crate::audio::word_marks::words_of(&text);
        self.queue.push_back(Utterance {
            id,
            text,
            voice,
            sent: false,
            started: false,
            synthesized: false,
            speaking: false,
            start_mark: None,
            end_mark: None,
            words,
            envelope: None,
            word_marks: Vec::new(),
            next_word: 0,
            marked_hops: 0,
            capture: Vec::new(),
        });
        match self.engine {
            EngineSlot::Running(_) => self.send_unsent(),
            EngineSlot::Starting(_) => {}
            EngineSlot::Stopped => self.start_engine(),
        }
    }

    fn start_engine(&mut self) {
        crate::log_to_file(&format!("[module:{}] starting the engine", MODULE_ID));
        self.engine = EngineSlot::Starting(self.host.start_engine());
    }

    /// Hand the not-yet-sent utterances in the read-ahead window to the
    /// sidecar, in order; it queues them and synthesizes one after another.
    /// Called again as sentences finish playing (from `tick`).
    fn send_unsent(&mut self) {
        let idle_before = !self.work_at_sidecar();
        let EngineSlot::Running(engine) = &self.engine else { return };
        let mut sent_any = false;
        for (i, u) in self.queue.iter_mut().take(READ_AHEAD + 1).enumerate().filter(|(_, u)| !u.sent) {
            let voice = resolve_voice(u.voice.as_deref(), &engine.voices);
            // The front of the queue, not yet sent: everything before it has
            // played, so its speech starts from silence. The sidecar then
            // drops the model's ~0.3 s lead-in (first word heard 0.14 s after
            // the speak instead of 0.32 s); behind a sentence still playing,
            // that lead-in is the pause between the two and stays.
            let trim_lead = i == 0;
            let frame = Frame::Json(
                json!({ "type": "speak", "id": u.id, "text": u.text, "voice": voice, "trimLead": trim_lead }),
            );
            match engine.link.tx.try_send(frame) {
                Ok(()) => {
                    u.sent = true;
                    sent_any = true;
                }
                // Retried on the next tick (see `deadline`).
                Err(TrySendError::Full(_)) => break,
                // The exit is on its way and fails the rest.
                Err(TrySendError::Closed(_)) => break,
            }
        }
        if idle_before && sent_any {
            // The stall timer starts when a sidecar with nothing to do gets work.
            self.last_sidecar = Instant::now();
        }
    }

    fn on_started(&mut self, result: Result<Engine, StartError>) {
        match result {
            Ok(engine) => {
                self.engine = EngineSlot::Running(engine);
                self.last_activity = Instant::now();
                self.last_sidecar = Instant::now();
                self.send_unsent();
            }
            Err(StartError::NotReady) => {
                self.engine = EngineSlot::Stopped;
                self.fail(|u| !u.sent, UtteranceState::Error, Some("not_ready"));
            }
            Err(StartError::Failed(e)) => {
                crate::log_to_file(&format!("[module:{}] engine failed to start: {}", MODULE_ID, e));
                self.engine = EngineSlot::Stopped;
                self.crashes.record();
                self.fail(|u| !u.sent, UtteranceState::Error, Some("unavailable"));
            }
        }
    }

    fn on_frame(&mut self, frame: Option<Frame>) {
        let Some(frame) = frame else { return self.on_engine_exit() };
        self.last_activity = Instant::now();
        self.last_sidecar = self.last_activity;
        match frame {
            Frame::Audio { sample_rate, samples, .. } => {
                if self.current.is_some() {
                    self.feed(Item::Samples(sample_rate, samples));
                }
            }
            Frame::Json(v) => {
                let id = v.get("id").and_then(|i| i.as_str()).map(String::from);
                match v.get("type").and_then(|t| t.as_str()) {
                    Some("started") => self.on_sidecar_started(id),
                    Some("done") => self.on_sidecar_done(id, &v),
                    Some("cancelled") => {
                        let ids: Vec<String> = v
                            .get("ids")
                            .and_then(|i| i.as_array())
                            .map(|a| a.iter().filter_map(|i| i.as_str().map(String::from)).collect())
                            .unwrap_or_default();
                        // Normally all cancelled by us already; anything else
                        // the sidecar dropped on its own is cancelled here.
                        self.fail(|u| ids.contains(&u.id) && !u.synthesized, UtteranceState::Cancelled, None);
                    }
                    Some("error") => {
                        let code = v.get("code").and_then(|c| c.as_str()).unwrap_or("engine_error").to_string();
                        crate::log_to_file(&format!("[module:{}] engine error: {}", MODULE_ID, v));
                        if let Some(id) = id {
                            if self.current.as_deref() == Some(id.as_str()) {
                                self.current = None;
                            }
                            self.fail(|u| u.id == id && !u.synthesized, UtteranceState::Error, Some(&code));
                        }
                        // A fatal error ends the process; its EOF is handled
                        // as an exit.
                    }
                    _ => {}
                }
            }
        }
    }

    /// The sidecar works through its queue in order: when it reaches `id`,
    /// anything sent before it that it never finished never will be. Fail
    /// those so the in-order `done` bookkeeping can't wedge on them.
    fn skip_before(&mut self, id: &str) {
        let Some(pos) = self.queue.iter().position(|u| u.id == id) else { return };
        let skipped: Vec<String> = self
            .queue
            .iter()
            .take(pos)
            .filter(|u| u.sent && !u.synthesized)
            .map(|u| u.id.clone())
            .collect();
        if !skipped.is_empty() {
            crate::log_to_file(&format!("[module:{}] engine skipped {:?}", MODULE_ID, skipped));
            self.fail(|u| skipped.contains(&u.id), UtteranceState::Error, Some("engine_error"));
        }
    }

    fn on_sidecar_started(&mut self, id: Option<String>) {
        let Some(id) = id else { return };
        self.skip_before(&id);
        match self.queue.iter_mut().find(|u| u.id == id && u.sent && !u.started) {
            Some(u) => {
                u.started = true;
                self.current = Some(id.clone());
                self.feed(Item::Start(id));
            }
            // Cancelled before it began: drop its audio.
            None => self.current = None,
        }
    }

    fn on_sidecar_done(&mut self, id: Option<String>, v: &Value) {
        let Some(id) = id else { return };
        self.skip_before(&id);
        let Some(u) = self.queue.iter_mut().find(|u| u.id == id && u.sent && !u.synthesized) else {
            return; // cancelled or failed already
        };
        u.synthesized = true;
        let had_start = std::mem::replace(&mut u.started, true);
        if !had_start {
            // `done` without `started`: an utterance with no audio.
            self.feed(Item::Start(id.clone()));
        }
        if self.current.as_deref() == Some(id.as_str()) {
            self.current = None;
        }
        self.feed(Item::End(id));
        if let Some(secs) = v.get("audioSeconds").and_then(|s| s.as_f64()) {
            crate::log_to_file(&format!("[module:{}] synthesized {:.2}s", MODULE_ID, secs));
        }
    }

    /// The sidecar exited without being asked to.
    fn on_engine_exit(&mut self) {
        crate::log_to_file(&format!(
            "[module:{}] engine exited unexpectedly; restarting on the next request",
            MODULE_ID
        ));
        self.lose_engine("engine_exited");
    }

    /// The sidecar died or hung: reap (or kill) it, count it against the
    /// restart budget, and fail what it owed. Fully synthesized sentences
    /// still play out.
    fn lose_engine(&mut self, code: &str) {
        if let EngineSlot::Running(engine) = std::mem::replace(&mut self.engine, EngineSlot::Stopped) {
            tokio::spawn(shutdown_engine(engine, self.timing.shutdown_grace));
        }
        self.crashes.record();
        self.current = None;
        self.fail(|u| !u.synthesized, UtteranceState::Error, Some(code));
    }

    /// Route audio to the player, opening the output stream on first use.
    fn feed(&mut self, item: Item) {
        match self.output {
            OutputSlot::Open(_) => self.apply(item),
            OutputSlot::Opening(_) => self.stash.push(item),
            OutputSlot::Closed => {
                self.stash.push(item);
                self.open_output();
            }
        }
    }

    fn apply(&mut self, item: Item) {
        let OutputSlot::Open(player) = &mut self.output else { return };
        match item {
            Item::Start(id) => {
                if let Some(rs) = ensure_resampler(&mut self.resampler, SPEECH_RATE, player.rate()) {
                    rs.begin();
                }
                let speed = f32::from_bits(self.rate.load(Ordering::Relaxed));
                self.stretch.begin(speed);
                let mark = player.enqueued();
                let rate = player.rate();
                let pace = self.pace / clamp_rate(speed).max(0.1);
                if let Some(u) = self.queue.iter_mut().find(|u| u.id == id) {
                    u.start_mark = Some(mark);
                    let env = crate::audio::word_marks::Envelope::new(rate);
                    let hop = env.hop() as u64;
                    u.word_marks = crate::audio::word_marks::provisional_starts(&u.words, pace)
                        .into_iter()
                        .map(|h| mark + h as u64 * hop)
                        .collect();
                    u.envelope = Some(env);
                }
                self.filling = Some(id);
            }
            Item::Samples(rate, samples) => {
                self.scratch.clear();
                self.stretched.clear();
                self.stretch.push(&samples, &mut self.stretched);
                if let Some(rs) = ensure_resampler(&mut self.resampler, rate, player.rate()) {
                    rs.push(&self.stretched, &mut self.scratch);
                    player.push(&self.scratch);
                    // Read-along: the loudness of exactly what's played, and the
                    // words placed again on what's in so far (every 50 ms of it):
                    // a sentence plays as it's made, and a guess at the voice's
                    // usual rate drifted until it was all in.
                    if let Some(id) = &self.filling {
                        let speed = clamp_rate(f32::from_bits(self.rate.load(Ordering::Relaxed))).max(0.1);
                        let pace = self.pace / speed;
                        if let Some(u) = self.queue.iter_mut().find(|u| &u.id == id) {
                            if let (Some(env), Some(start)) = (u.envelope.as_mut(), u.start_mark) {
                                env.push(&self.scratch);
                                if cfg!(debug_assertions) {
                                    u.capture.extend_from_slice(&self.scratch);
                                }
                                let db = env.db();
                                if db.len() >= u.marked_hops + 5 {
                                    u.marked_hops = db.len();
                                    let hop = env.hop() as u64;
                                    let starts = crate::audio::word_marks::partial_starts(&db, &u.words, pace);
                                    if starts.len() == u.words.len() {
                                        u.word_marks = starts.into_iter().map(|h| start + h as u64 * hop).collect();
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Item::End(id) => {
                self.scratch.clear();
                self.stretched.clear();
                self.stretch.finish(&mut self.stretched);
                if let Some(rs) = self.resampler.as_mut() {
                    rs.push(&self.stretched, &mut self.scratch);
                    rs.finish(&mut self.scratch);
                }
                player.push(&self.scratch);
                let mark = player.enqueued();
                let speed = clamp_rate(f32::from_bits(self.rate.load(Ordering::Relaxed))).max(0.1);
                let usual = self.pace / speed;
                let mut learned = None;
                if let Some(u) = self.queue.iter_mut().find(|u| u.id == id) {
                    u.start_mark.get_or_insert(mark);
                    u.end_mark = Some(mark);
                    // Read-along: its words placed on its audio, now it's all in.
                    if let (Some(env), Some(start)) = (u.envelope.as_mut(), u.start_mark) {
                        env.push(&self.scratch);
                        let db = env.db();
                        let hop = env.hop() as u64;
                        let starts = crate::audio::word_marks::sentence_starts(&db, &u.words, usual);
                        if starts.len() == u.words.len() {
                            let fresh: Vec<u64> = starts.into_iter().map(|h| start + h as u64 * hop).collect();
                            // Read-along diagnostics (spike): how far the guess made while it
                            // was still being spoken was from the real places.
                            let played = player.played();
                            let ms = |f: u64| f * 1000 / player.rate().max(1) as u64;
                            let shift = u.word_marks.iter().zip(&fresh).skip(u.next_word).map(|(a, b)| ms(a.abs_diff(*b))).max().unwrap_or(0);
                            let early = u.word_marks.iter().zip(&fresh).take(u.next_word).map(|(a, b)| ms(a.abs_diff(*b))).max().unwrap_or(0);
                            if cfg!(debug_assertions) {
                                crate::log_to_file(&format!(
                                "[read-along] sentence done: {} words, playing for {} ms, {} shown on the guess (off by up to {} ms), rest moved up to {} ms, speed {:.2}",
                                u.words.len(),
                                if played > start { ms(played - start) as i64 } else { -1 },
                                u.next_word,
                                early,
                                shift,
                                speed,
                            ));
                            }
                            if cfg!(debug_assertions) {
                                u.capture.extend_from_slice(&self.scratch);
                                let audio = std::mem::take(&mut u.capture);
                                let hops: Vec<u64> = fresh.iter().map(|m| (m - start) / hop).collect();
                                let words = u.words.clone();
                                let (rate, name) = (player.rate(), format!("{}-{}", chrono::Local::now().format("%H%M%S"), u.id));
                                std::thread::spawn(move || save_capture(&name, rate, &audio, &words, &hops));
                            }
                            u.word_marks = fresh;
                        }
                        learned = crate::audio::word_marks::hops_per_syllable(&db, &u.words);
                    }
                    u.envelope = None;
                }
                if let Some(p) = learned {
                    // At 1×: what this sentence's speed made of it, undone.
                    self.pace = 0.7 * self.pace + 0.3 * (p * speed).clamp(5.0, 60.0);
                }
                if self.filling.as_deref() == Some(id.as_str()) {
                    self.filling = None;
                }
            }
        }
    }

    fn on_opened(&mut self, result: Result<Player, String>) {
        match result {
            Ok(mut player) => {
                // A hold's reference tap follows it to every stream it opens.
                if let Some(tap) = self.tap.take() {
                    player.set_tap(Some(tap));
                }
                self.output = OutputSlot::Open(player);
                self.drained_since = None;
                for item in std::mem::take(&mut self.stash) {
                    self.apply(item);
                }
            }
            Err(e) => {
                crate::log_to_file(&format!("[module:{}] could not open the output device: {}", MODULE_ID, e));
                self.output = OutputSlot::Closed;
                self.cancel_all(UtteranceState::Error, Some("output_device"));
                if self.hold.is_some() {
                    self.reopen_at = Some(Instant::now() + self.timing.reopen_backoff);
                }
            }
        }
    }

    /// Playback bookkeeping, after every event and on the tick.
    fn tick(&mut self) {
        let now = Instant::now();
        let mut device_error = None;
        let mut close = false;
        if let OutputSlot::Open(player) = &mut self.output {
            if let Some(e) = player.take_error() {
                device_error = Some(e);
            } else {
                player.pump();
                let played = player.played();
                // Finished utterances, in order.
                while let Some(u) = self.queue.front() {
                    let Some(end) = u.end_mark.filter(|e| played >= *e) else { break };
                    let u = self.queue.pop_front().unwrap();
                    if !u.speaking && u.start_mark.is_some_and(|s| end > s) {
                        emit(&self.host, &u.id, UtteranceState::Speaking, None);
                    }
                    emit(&self.host, &u.id, UtteranceState::Done, None);
                    self.last_activity = now;
                }
                // The one now playing.
                for u in self.queue.iter_mut() {
                    if let Some(start) = u.start_mark {
                        if !u.speaking && played > start {
                            u.speaking = true;
                            emit(&self.host, &u.id, UtteranceState::Speaking, None);
                        }
                    }
                }
                // Read-along: each word as its place in the audio comes up.
                let lead = (player.rate() as u64 * WORD_LEAD.as_millis() as u64) / 1000;
                for u in self.queue.iter_mut() {
                    if !u.speaking {
                        break;
                    }
                    while u.next_word < u.word_marks.len() && played + lead >= u.word_marks[u.next_word] {
                        // Only the latest word due: one that's been passed is skipped, not flashed.
                        let due = u.next_word;
                        u.next_word += 1;
                        if u.next_word < u.word_marks.len() && played + lead >= u.word_marks[u.next_word] {
                            continue;
                        }
                        self.host.emit_word(WordEvent {
                            id: u.id.clone(),
                            index: due,
                            count: u.words.len(),
                            word: u.words[due].clone(),
                        });
                    }
                }
                // Close the stream a little after the last sentence, so the
                // next reply opens whatever the default device is by then —
                // unless a hold keeps it open (it reopens at once on a
                // refresh instead).
                if self.queue.is_empty() && self.stash.is_empty() && player.drained() {
                    if self.refresh_output {
                        close = true;
                    } else if self.hold.is_some() {
                        self.drained_since = None;
                    } else {
                        let since = *self.drained_since.get_or_insert(now);
                        close = now.duration_since(since) >= self.timing.linger;
                    }
                } else {
                    self.drained_since = None;
                }
            }
        }
        if let Some(e) = device_error {
            crate::log_to_file(&format!("[module:{}] output device failed: {}", MODULE_ID, e));
            self.cancel_all(UtteranceState::Error, Some("output_device"));
            close = true;
            if self.hold.is_some() {
                self.reopen_at = Some(now + self.timing.reopen_backoff);
            }
        }
        if close {
            self.close_output();
            self.refresh_output = false;
        }
        // A held output that is closed (refreshed, failed) opens again.
        if self.hold.is_some()
            && matches!(self.output, OutputSlot::Closed)
            && self.reopen_at.is_none_or(|at| now >= at)
        {
            self.reopen_at = None;
            self.open_output();
        }

        // Audibly speaking: an utterance has emitted `speaking` and not yet
        // `done` (finished ones were popped above).
        let audible = matches!(self.output, OutputSlot::Open(_)) && self.queue.iter().any(|u| u.speaking);
        self.speaking.send_if_modified(|v| std::mem::replace(v, audible) != audible);

        // Refill the read-ahead window as sentences finish, and retry sends a
        // full channel refused.
        if matches!(self.engine, EngineSlot::Running(_)) && self.sendable() {
            self.send_unsent();
        }

        let silent = now.saturating_duration_since(self.last_sidecar);
        if matches!(self.engine, EngineSlot::Running(_)) && self.work_at_sidecar() && silent >= self.timing.stall {
            crate::log_to_file(&format!(
                "[module:{}] engine silent for {:?} with work pending; restarting it",
                MODULE_ID, silent
            ));
            self.lose_engine("engine_stalled");
        }
        let quiet = now.saturating_duration_since(self.last_activity);
        if matches!(self.engine, EngineSlot::Running(_)) && self.queue.is_empty() && quiet >= self.timing.idle {
            crate::log_to_file(&format!(
                "[module:{}] idle for {:?}; stopping the engine",
                MODULE_ID, self.timing.idle
            ));
            if let EngineSlot::Running(engine) = std::mem::replace(&mut self.engine, EngineSlot::Stopped) {
                tokio::spawn(shutdown_engine(engine, self.timing.shutdown_grace));
            }
        }
    }

    /// End every pending utterance with `state`, silence what's queued in the
    /// player, and tell the sidecar to drop its queue.
    fn cancel_all(&mut self, state: UtteranceState, error: Option<&str>) {
        let at_sidecar = self.queue.iter().any(|u| u.sent && !u.synthesized);
        for u in self.queue.drain(..) {
            emit(&self.host, &u.id, state, error);
        }
        self.current = None;
        self.stash.clear();
        if let Some(rs) = self.resampler.as_mut() {
            rs.begin();
        }
        if let OutputSlot::Open(player) = &mut self.output {
            player.flush();
        }
        self.drained_since = None;
        if at_sidecar {
            if let EngineSlot::Running(engine) = &self.engine {
                let _ = engine.link.tx.try_send(Frame::Json(json!({ "type": "cancel" })));
            }
        }
    }

    /// Remove the utterances matching `pred`, emitting `state` for each.
    fn fail(&mut self, pred: impl Fn(&Utterance) -> bool, state: UtteranceState, error: Option<&str>) {
        let mut kept = VecDeque::with_capacity(self.queue.len());
        for u in self.queue.drain(..) {
            if pred(&u) {
                emit(&self.host, &u.id, state, error);
            } else {
                kept.push_back(u);
            }
        }
        self.queue = kept;
    }

    fn close_output(&mut self) {
        if let OutputSlot::Open(mut player) = std::mem::replace(&mut self.output, OutputSlot::Closed) {
            // Keep a held tap for the next stream (without a hold there is
            // none: release removed it).
            if let Some(tap) = player.set_tap(None) {
                if self.hold.is_some() {
                    self.tap = Some(tap);
                }
            }
            self.host.close_output(player);
        }
        self.drained_since = None;
    }

    /// Module disabled, app exit: cancel, stop the sidecar, close the output,
    /// and end any hold (its guard's later release is a no-op).
    async fn stop_everything(&mut self, wait: bool) {
        self.hold = None;
        self.tap = None;
        self.reopen_at = None;
        self.refresh_output = false;
        self.cancel_all(UtteranceState::Cancelled, None);
        match std::mem::replace(&mut self.engine, EngineSlot::Stopped) {
            EngineSlot::Running(engine) => {
                crate::log_to_file(&format!("[module:{}] stopping the engine", MODULE_ID));
                if wait {
                    shutdown_engine(engine, self.timing.shutdown_grace).await;
                } else {
                    tokio::spawn(shutdown_engine(engine, self.timing.shutdown_grace));
                }
            }
            // Dropping a start in progress kills the process (kill_on_drop).
            EngineSlot::Starting(_) => {
                crate::log_to_file(&format!("[module:{}] abandoning an engine start", MODULE_ID));
            }
            EngineSlot::Stopped => {}
        }
        // An open in progress is simply dropped; its blocking task drops the
        // stream it built.
        self.close_output();
    }
}

/// The resampler for `in_rate → out_rate`, rebuilt if the rates changed.
fn ensure_resampler(slot: &mut Option<SpeechResampler>, in_rate: u32, out_rate: u32) -> Option<&mut SpeechResampler> {
    if slot.as_ref().map(|r| r.rates()) != Some((in_rate, out_rate)) {
        match SpeechResampler::new(in_rate, out_rate) {
            Ok(rs) => *slot = Some(rs),
            Err(e) => {
                crate::log_to_file(&format!("[module:{}] {}", MODULE_ID, e));
                *slot = None;
            }
        }
    }
    slot.as_mut()
}

// ─── Tauri commands ────────────────────────────────────────────────────────

/// A recording is starting, running or stopping. Speech must never play over
/// a meeting (and every recording start cancels it).
pub(crate) fn recording_active(app: &AppHandle) -> bool {
    use crate::audio::dual_stream::DualStreamState;
    let state = app.state::<crate::state::AppState>();
    let dual = state.dual_stream.lock().unwrap_or_else(|p| p.into_inner());
    dual.state != DualStreamState::Inactive
}

/// Cancel speech because a recording is about to start (`start_recording`,
/// meeting-detection auto-record). No-op before the service exists.
pub fn cancel_for_recording(app: &AppHandle) {
    if let Some(tts) = app.try_state::<TtsService>() {
        tts.cancel();
    }
}

/// The page in webview `label` is starting to load (reload, hard navigation)
/// or its window was destroyed: cancel the speech it owns. No-op before the
/// service exists.
pub fn cancel_for_page(app: &AppHandle, label: &str) {
    if let Some(tts) = app.try_state::<TtsService>() {
        tts.cancel_if_owner(label);
    }
}

/// Why speech can't start now, as a `tts_speak` refusal code; `None` when it
/// can. Shared with the system-wide read-selection hotkey.
pub(crate) fn refusal(app: &AppHandle, tts: &TtsService) -> Option<&'static str> {
    if recording_active(app) {
        return Some("recording");
    }
    let modules = app.state::<ModuleManager>();
    if matches!(modules.state(MODULE_ID), None | Some(ModuleState::Unavailable)) {
        return Some("unavailable");
    }
    if modules.launch_config(app, MODULE_ID).is_none() {
        return Some("not_ready");
    }
    if tts.exhausted() {
        return Some("unavailable");
    }
    None
}

/// Read-along spike (debug builds): one sentence's audio as played and its
/// words' places (10 ms hops from its first sample), for checking against
/// whisper's word times (sidecars/local-tts/bench/word_marks_captures.py).
fn save_capture(name: &str, rate: u32, audio: &[f32], words: &[String], hops: &[u64]) {
    let dir = std::path::Path::new("/tmp/dial8-readalong");
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let spec = hound::WavSpec { channels: 1, sample_rate: rate, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    if let Ok(mut w) = hound::WavWriter::create(dir.join(format!("{name}.wav")), spec) {
        for &s in audio {
            let _ = w.write_sample((s.clamp(-1.0, 1.0) * 32767.0) as i16);
        }
        let _ = w.finalize();
    }
    let _ = std::fs::write(dir.join(format!("{name}.json")), json!({ "words": words, "hops": hops }).to_string());
}

/// Async so it never runs on the main thread (normalizing is CPU work).
#[tauri::command]
pub async fn tts_speak(
    app: AppHandle,
    webview: tauri::Webview,
    tts: State<'_, TtsService>,
    id: String,
    text: String,
    voice: Option<String>,
) -> Result<(), String> {
    if let Some(why) = refusal(&app, &tts) {
        return Err(why.into());
    }
    if text.len() > MAX_SPEAK_BYTES {
        return Err("text_too_long".into());
    }
    let epoch = tts.claim(webview.label());
    let text = tauri::async_runtime::spawn_blocking(move || normalize(&text))
        .await
        .map_err(|_| "unavailable".to_string())?;
    tts.speak_at(epoch, id, text, voice);
    Ok(())
}

#[tauri::command]
pub fn tts_cancel(tts: State<'_, TtsService>) {
    tts.cancel();
}

#[tauri::command]
pub fn tts_prepare(app: AppHandle, tts: State<'_, TtsService>) {
    if recording_active(&app) {
        return;
    }
    if app.state::<ModuleManager>().launch_config(&app, MODULE_ID).is_none() {
        return;
    }
    tts.prepare();
}

#[tauri::command]
pub fn tts_voices() -> Vec<VoiceInfo> {
    voices()
}

/// The Speed setting: 0.5×–4×, 1× by default (Settings → Voice). It applies
/// to every speech this service plays: read aloud, Read anywhere, voice mode.
#[tauri::command]
pub fn tts_rate(tts: State<'_, TtsService>) -> f32 {
    tts.rate()
}

/// Sets the speed for sentences not yet synthesized (a few already queued
/// keep theirs) and keeps it in the app's
/// settings; returns it clamped.
#[tauri::command]
pub fn tts_set_rate(app: AppHandle, tts: State<'_, TtsService>, rate: f32) -> f32 {
    let rate = tts.set_rate(rate);
    crate::settings::set_tts_rate(&app, rate);
    rate
}

#[cfg(test)]
mod tests;
