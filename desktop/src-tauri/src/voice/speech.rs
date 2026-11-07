//! Speech audio for Voice focus (`voice_start { speechAudio: true }`): each
//! candidate user turn's cleaned 16 kHz audio, as `voice://speech` chunks,
//! for the web to check against the user's voiceprint. Never written to
//! disk.
//!
//! The DSP thread hands the actor the audio local-stt hears, on the session
//! audio clock ([`super::dsp::DspEvent::Audio`], ~100 ms at a time); this
//! keeps the last [`SPEECH_RING_MS`] of it. The actor shows it the machine's
//! open runs after every input ([`super::turn::Machine::open_runs`]): a run
//! that appears opens a stream from where its words are taken (its onset
//! less the onset slack, so a backdated barge-in, wake or promoted shadow
//! run starts in the past), and its audio goes out in [`SPEECH_CHUNK_MS`]
//! chunks, the first [`SPEECH_CAP_MS`] of it only. A run that ends in a turn
//! is closed by [`SpeechAudio::turn`] (its remaining audio, then the end)
//! BEFORE the session emits `voice://turn`; one that disappears without a
//! turn is closed as abandoned. All on the actor: the DSP thread only
//! converts and batches.

use std::collections::VecDeque;

use base64::Engine as _;

use super::events::SpeechOutcome;
use super::turn::RunView;
use super::SAMPLE_RATE;

/// A chunk every this much audio (the last one of a run may be shorter).
pub const SPEECH_CHUNK_MS: u64 = 500;
/// Only the first this much of a run's audio is sent.
pub const SPEECH_CAP_MS: u64 = 8_000;
/// Audio kept behind the clock: a run's onset (less its slack) may be this
/// far back when it is first seen (a shadow run promoted after an aside).
pub const SPEECH_RING_MS: u64 = 20_000;

const fn samples(ms: u64) -> u64 {
    ms * SAMPLE_RATE / 1000
}

const CHUNK: u64 = samples(SPEECH_CHUNK_MS);
const CAP: u64 = samples(SPEECH_CAP_MS);
const RING: u64 = samples(SPEECH_RING_MS);

/// What to emit, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpeechOut {
    /// `start`: the audio clock of `pcm[0]`.
    Chunk { turn_id: String, seq: u32, start: u64, pcm: Vec<i16> },
    /// `seq`: the next chunk's (how many were sent).
    End { turn_id: String, seq: u32, outcome: SpeechOutcome },
}

#[derive(Debug)]
struct Stream {
    turn_id: String,
    from: u64,
    until: Option<u64>,
    /// The next sample to send.
    next: u64,
    seq: u32,
}

/// The session's speech audio: the recent audio and one stream per open run.
#[derive(Debug, Default)]
pub struct SpeechAudio {
    ring: VecDeque<i16>,
    /// The audio clock of `ring[0]`.
    ring_start: u64,
    streams: Vec<Stream>,
}

impl SpeechAudio {
    fn ring_end(&self) -> u64 {
        self.ring_start + self.ring.len() as u64
    }

    /// Audio from the DSP thread, `pcm[0]` at audio clock `start`; returns
    /// the chunks now due. A short gap is filled with silence (the clock
    /// stays put), a long one starts the ring over; an overlap keeps what
    /// was there.
    pub fn push(&mut self, start: u64, pcm: &[i16]) -> Vec<SpeechOut> {
        let end = self.ring_end();
        let mut pcm = pcm;
        if self.ring.is_empty() {
            self.ring_start = start;
        } else if start > end {
            let gap = start - end;
            if gap <= RING {
                self.ring.extend(std::iter::repeat_n(0, gap as usize));
            } else {
                self.ring.clear();
                self.ring_start = start;
            }
        } else if start < end {
            let skip = (end - start) as usize;
            pcm = &pcm[skip.min(pcm.len())..];
        }
        self.ring.extend(pcm.iter().copied());
        let excess = (self.ring.len() as u64).saturating_sub(RING);
        if excess > 0 {
            self.ring.drain(..excess as usize);
            self.ring_start += excess;
        }
        self.drain()
    }

    /// The machine's open runs after an input: new ones open a stream, gone
    /// ones (no turn) end as abandoned, and a run's end, once known, bounds
    /// its audio. Returns what is due, ends first.
    pub fn sync(&mut self, open: &[RunView]) -> Vec<SpeechOut> {
        let mut out = Vec::new();
        self.streams.retain(|s| {
            let keep = open.iter().any(|v| v.turn_id == s.turn_id);
            if !keep {
                out.push(SpeechOut::End { turn_id: s.turn_id.clone(), seq: s.seq, outcome: SpeechOutcome::Abandoned });
            }
            keep
        });
        for v in open {
            match self.streams.iter_mut().find(|s| s.turn_id == v.turn_id) {
                Some(s) => s.until = v.until.or(s.until),
                None => self.streams.push(Stream { turn_id: v.turn_id.clone(), from: v.from, until: v.until, next: v.from, seq: 0 }),
            }
        }
        out.extend(self.drain());
        out
    }

    /// The run `turn_id` became a turn: the rest of its audio (as much as
    /// has arrived, within its bounds and the cap), then its end. Call it
    /// before emitting the turn.
    pub fn turn(&mut self, turn_id: &str) -> Vec<SpeechOut> {
        let mut out = Vec::new();
        let seq = match self.streams.iter().position(|s| s.turn_id == turn_id) {
            Some(i) => {
                let mut s = self.streams.remove(i);
                chunks(&self.ring, self.ring_start, &mut s, true, &mut out);
                s.seq
            }
            None => 0,
        };
        out.push(SpeechOut::End { turn_id: turn_id.to_string(), seq, outcome: SpeechOutcome::Turn });
        out
    }

    /// The session ends: every open run is abandoned.
    pub fn close_all(&mut self) -> Vec<SpeechOut> {
        self.streams
            .drain(..)
            .map(|s| SpeechOut::End { turn_id: s.turn_id, seq: s.seq, outcome: SpeechOutcome::Abandoned })
            .collect()
    }

    fn drain(&mut self) -> Vec<SpeechOut> {
        let mut out = Vec::new();
        for s in &mut self.streams {
            chunks(&self.ring, self.ring_start, s, false, &mut out);
        }
        out
    }
}

/// `s`'s whole chunks that have arrived, and its last short one once all
/// its audio is in (or `force`). Bounded by its end and the cap; audio that
/// already left the ring is skipped.
fn chunks(ring: &VecDeque<i16>, ring_start: u64, s: &mut Stream, force: bool, out: &mut Vec<SpeechOut>) {
    let end = ring_start + ring.len() as u64;
    s.next = s.next.max(ring_start);
    let limit = s.until.unwrap_or(u64::MAX).min(s.from + CAP);
    let bound = end.min(limit);
    let complete = end >= limit;
    while s.next < bound {
        let avail = bound - s.next;
        if avail < CHUNK && !(force || complete) {
            break;
        }
        let n = avail.min(CHUNK);
        let at = (s.next - ring_start) as usize;
        let pcm: Vec<i16> = ring.range(at..at + n as usize).copied().collect();
        out.push(SpeechOut::Chunk { turn_id: s.turn_id.clone(), seq: s.seq, start: s.next, pcm });
        s.next += n;
        s.seq += 1;
    }
}

/// Cleaned audio (f32, ±1) to 16-bit PCM.
pub fn to_i16(s: f32) -> i16 {
    (s.clamp(-1.0, 1.0) * 32767.0).round() as i16
}

/// `pcm` as the contract's `pcm`: base64 of 16-bit little-endian samples.
pub fn pcm_base64(pcm: &[i16]) -> String {
    let bytes: Vec<u8> = pcm.iter().flat_map(|s| s.to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// The audio clock in ms (the contract's `startMs`).
pub fn clock_ms(samples: u64) -> u64 {
    samples * 1000 / SAMPLE_RATE
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(id: &str, from: u64, until: Option<u64>) -> RunView {
        RunView { turn_id: id.into(), from, until }
    }

    /// Audio whose every sample is its own clock (mod 30000), so a chunk
    /// shows where it came from.
    fn audio(start: u64, n: u64) -> Vec<i16> {
        (start..start + n).map(|c| (c % 30_000) as i16).collect()
    }

    fn feed(sp: &mut SpeechAudio, from: u64, to: u64, step: u64) -> Vec<SpeechOut> {
        let mut out = Vec::new();
        let mut at = from;
        while at < to {
            let n = step.min(to - at);
            out.extend(sp.push(at, &audio(at, n)));
            at += n;
        }
        out
    }

    fn chunk_spans(out: &[SpeechOut]) -> Vec<(u32, u64, usize)> {
        out.iter()
            .filter_map(|o| match o {
                SpeechOut::Chunk { seq, start, pcm, .. } => Some((*seq, *start, pcm.len())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_run_streams_half_second_chunks_from_its_slack_and_ends_before_its_turn() {
        let mut sp = SpeechAudio::default();
        // 1 s of audio before anyone speaks.
        assert!(feed(&mut sp, 0, 16_000, 1_600).is_empty());
        // A run opens with its words taken from 0.8 s (onset less slack).
        let out = sp.sync(&[view("t1", 12_800, None)]);
        assert!(out.is_empty(), "0.2 s in: no whole chunk yet");
        let out = feed(&mut sp, 16_000, 24_000, 1_600);
        assert_eq!(chunk_spans(&out), [(0, 12_800, 8_000)]);
        // Its first sample is the audio at its `from`.
        let SpeechOut::Chunk { pcm, .. } = &out[0] else { panic!() };
        assert_eq!(pcm[0], 12_800);
        // It ends at 1.3 s (processing): the short tail goes out once in.
        let out = sp.sync(&[view("t1", 12_800, Some(28_000))]);
        assert!(out.is_empty());
        let out = feed(&mut sp, 24_000, 30_000, 1_600);
        assert_eq!(chunk_spans(&out), [(1, 20_800, 7_200)]);
        // Its turn: nothing left, then the end, seq = chunks sent.
        assert_eq!(sp.turn("t1"), [SpeechOut::End { turn_id: "t1".into(), seq: 2, outcome: SpeechOutcome::Turn }]);
        assert!(sp.sync(&[]).is_empty(), "already closed");
    }

    #[test]
    fn a_turn_flushes_what_has_arrived_before_its_end() {
        let mut sp = SpeechAudio::default();
        sp.sync(&[view("t2", 0, None)]);
        feed(&mut sp, 0, 4_000, 1_000);
        let out = sp.turn("t2");
        assert_eq!(chunk_spans(&out), [(0, 0, 4_000)]);
        assert_eq!(out.last(), Some(&SpeechOut::End { turn_id: "t2".into(), seq: 1, outcome: SpeechOutcome::Turn }));
        // A turn never seen (no audio): just its end.
        assert_eq!(sp.turn("t9"), [SpeechOut::End { turn_id: "t9".into(), seq: 0, outcome: SpeechOutcome::Turn }]);
    }

    #[test]
    fn audio_is_capped_at_eight_seconds_per_run() {
        let mut sp = SpeechAudio::default();
        sp.sync(&[view("t3", 0, None)]);
        let out = feed(&mut sp, 0, samples(12_000), 1_600);
        let spans = chunk_spans(&out);
        assert_eq!(spans.len() as u64, SPEECH_CAP_MS / SPEECH_CHUNK_MS);
        assert_eq!(spans.iter().map(|s| s.2 as u64).sum::<u64>(), CAP);
        assert!(spans.iter().enumerate().all(|(i, s)| s.0 == i as u32));
        // Past the cap: nothing more, even at its turn.
        assert_eq!(sp.turn("t3"), [SpeechOut::End { turn_id: "t3".into(), seq: 16, outcome: SpeechOutcome::Turn }]);
    }

    #[test]
    fn a_run_that_goes_without_a_turn_is_abandoned() {
        let mut sp = SpeechAudio::default();
        feed(&mut sp, 0, 1_600, 1_600);
        sp.sync(&[view("t4", 0, None), view("t5", 800, None)]);
        let out = sp.sync(&[view("t5", 800, None)]);
        assert_eq!(out, [SpeechOut::End { turn_id: "t4".into(), seq: 0, outcome: SpeechOutcome::Abandoned }]);
        assert_eq!(sp.close_all(), [SpeechOut::End { turn_id: "t5".into(), seq: 0, outcome: SpeechOutcome::Abandoned }]);
    }

    #[test]
    fn a_run_older_than_the_ring_starts_at_its_oldest_audio_and_gaps_keep_the_clock() {
        let mut sp = SpeechAudio::default();
        feed(&mut sp, 0, RING + 16_000, 16_000);
        assert_eq!(sp.ring_start, 16_000);
        // All its (remaining) audio is in: out at once, from the oldest kept.
        let out = sp.sync(&[view("t6", 0, Some(16_000 + 8_000))]);
        assert_eq!(chunk_spans(&out), [(0, 16_000, 8_000)]);
        assert_eq!(sp.turn("t6"), [SpeechOut::End { turn_id: "t6".into(), seq: 1, outcome: SpeechOutcome::Turn }]);
        // A short gap is silence on the same clock.
        let mut sp = SpeechAudio::default();
        sp.push(0, &audio(0, 100));
        sp.push(200, &audio(200, 100));
        assert_eq!((sp.ring_start, sp.ring.len()), (0, 300));
        assert_eq!(sp.ring[150], 0);
        assert_eq!(sp.ring[250], 250);
    }

    #[test]
    fn pcm_is_base64_little_endian_and_start_is_in_ms() {
        assert_eq!(pcm_base64(&[1, -2]), base64::engine::general_purpose::STANDARD.encode([1u8, 0, 0xFE, 0xFF]));
        assert_eq!((to_i16(1.5), to_i16(-1.0), to_i16(0.0)), (32767, -32767, 0));
        assert_eq!(clock_ms(12_800), 800);
    }
}
