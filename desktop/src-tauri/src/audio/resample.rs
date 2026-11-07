//! Streaming mono resampler for live audio: any device rate → a fixed target
//! rate (16 kHz for the mic, see `types::TARGET_SAMPLE_RATE`).
//!
//! - Anti-aliased: rubato's synchronous FFT resampler ([`FftFixedInOut`]),
//!   whose filter is a Blackman-Harris² windowed sinc as long as one input
//!   chunk (480 taps at 48 kHz), cut off just below the lower Nyquist. A
//!   12 kHz tone at 48 kHz comes out far more than 40 dB down; the speech
//!   band is flat.
//! - Stateful: one instance per stream. Input arrives in callbacks of any size
//!   and is gathered into fixed ~10 ms chunks, so nothing is dropped or
//!   rounded away at callback boundaries (the per-callback linear resampler
//!   this replaces lost ~0.4 % of the mic at 48 kHz with 512-frame
//!   callbacks, ~14 s an hour, and aliased everything above 8 kHz).
//! - Exact accounting: after `n` input frames the output count is
//!   `n × out / in` minus at most [`latency_frames`](StreamResampler::latency_frames)
//!   (the partial chunk still gathering plus the filter delay), and
//!   [`flush`](StreamResampler::flush) makes it exactly
//!   `round(n × out / in)`. The filter delay is trimmed from the front, so
//!   output frame `k` lines up with input time `k / out`.
//! - Realtime-safe after construction: [`process`](StreamResampler::process)
//!   and [`reset`](StreamResampler::reset) never allocate (as long as the
//!   caller's output `Vec` has room, see
//!   [`max_output_frames`](StreamResampler::max_output_frames)), take no locks
//!   and do O(frames) work: two small real FFTs per 10 ms chunk. Construction
//!   allocates and plans the FFTs, so build it off the audio thread.

use rubato::{FftFixedInOut, Resampler};

/// Target chunk length: 10 ms of input. rubato rounds it up to a multiple of
/// the rates' reduced ratio (441 frames at 44.1 kHz, 480 at 48 kHz).
const CHUNK_MS: usize = 10;
/// The filter is as long as a chunk and its cutoff follows the shorter side
/// (input or output chunk), so neither side goes below this: 160 frames puts
/// the -6 dB point at ~92 % of the lower Nyquist (7.3 kHz at 16 kHz out).
/// Only upsampling (an 8 kHz Bluetooth mic) needs it: 20 ms chunks there.
const MIN_CHUNK_SIDE: usize = 160;

#[allow(dead_code)] // rates/counters/flush: tests and diagnostics (the live paths use new/process/reset)
pub struct StreamResampler {
    in_rate: u32,
    out_rate: u32,
    /// `None` when the rates match (passthrough).
    fft: Option<FftFixedInOut<f32>>,
    chunk_in: usize,
    chunk_out: usize,
    /// One input chunk being gathered; `acc[..acc_len]` is filled.
    acc: Vec<f32>,
    acc_len: usize,
    /// One output chunk.
    out_chunk: Vec<f32>,
    /// The filter's delay in output frames; that many leading frames are
    /// dropped after every reset so the output lines up with the input.
    delay: usize,
    skip: usize,
    in_total: u64,
    out_total: u64,
}

#[allow(dead_code)] // rates/counters/flush: tests and diagnostics (the live paths use new/process/reset)
impl StreamResampler {
    /// A resampler for `in_rate → out_rate`, mono. Allocates; call off the
    /// realtime thread.
    pub fn new(in_rate: u32, out_rate: u32) -> Result<Self, String> {
        if in_rate == 0 || out_rate == 0 {
            return Err(format!("invalid sample rates {in_rate} → {out_rate}"));
        }
        if in_rate == out_rate {
            return Ok(Self {
                in_rate,
                out_rate,
                fft: None,
                chunk_in: 0,
                chunk_out: 0,
                acc: Vec::new(),
                acc_len: 0,
                out_chunk: Vec::new(),
                delay: 0,
                skip: 0,
                in_total: 0,
                out_total: 0,
            });
        }
        let (inr, outr) = (in_rate as usize, out_rate as usize);
        let desired = (inr * CHUNK_MS / 1000).max((MIN_CHUNK_SIDE * inr).div_ceil(inr.min(outr))).max(1);
        let fft = FftFixedInOut::<f32>::new(in_rate as usize, out_rate as usize, desired, 1)
            .map_err(|e| format!("resampler {in_rate} → {out_rate}: {e}"))?;
        let chunk_in = fft.input_frames_next();
        let chunk_out = fft.output_frames_next();
        let delay = fft.output_delay();
        Ok(Self {
            in_rate,
            out_rate,
            fft: Some(fft),
            chunk_in,
            chunk_out,
            acc: vec![0.0; chunk_in],
            acc_len: 0,
            out_chunk: vec![0.0; chunk_out],
            delay,
            skip: delay,
            in_total: 0,
            out_total: 0,
        })
    }

    /// `(input rate, output rate)`.
    pub fn rates(&self) -> (u32, u32) {
        (self.in_rate, self.out_rate)
    }

    /// Input frames consumed since the last reset.
    pub fn input_frames(&self) -> u64 {
        self.in_total
    }

    /// Output frames produced since the last reset.
    pub fn output_frames(&self) -> u64 {
        self.out_total
    }

    /// The most output frames the resampler can owe at any moment: after `n`
    /// input frames, `floor(n × out / in) − latency_frames() ≤ output_frames()
    /// ≤ floor(n × out / in)`. 0 in passthrough.
    pub fn latency_frames(&self) -> usize {
        if self.fft.is_none() {
            0
        } else {
            self.chunk_out + self.delay
        }
    }

    /// The most frames one [`process`](Self::process) of `input_frames` can
    /// append; reserve this much in the output `Vec` to keep the call
    /// allocation-free.
    pub fn max_output_frames(&self, input_frames: usize) -> usize {
        if self.fft.is_none() {
            return input_frames;
        }
        (self.acc_len + input_frames) / self.chunk_in * self.chunk_out
    }

    /// Start again from a clean filter, as for a new stream. Allocation-free.
    pub fn reset(&mut self) {
        if let Some(fft) = self.fft.as_mut() {
            fft.reset();
        }
        self.acc_len = 0;
        self.skip = self.delay;
        self.in_total = 0;
        self.out_total = 0;
    }

    /// Resample `input`, appending every output frame that is ready to `out`.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        self.in_total += input.len() as u64;
        let Some(fft) = self.fft.as_mut() else {
            out.extend_from_slice(input);
            self.out_total += input.len() as u64;
            return;
        };
        let mut rest = input;
        while !rest.is_empty() {
            let take = (self.chunk_in - self.acc_len).min(rest.len());
            self.acc[self.acc_len..self.acc_len + take].copy_from_slice(&rest[..take]);
            self.acc_len += take;
            rest = &rest[take..];
            if self.acc_len == self.chunk_in {
                run_chunk(fft, &self.acc, &mut self.out_chunk, &mut self.skip, &mut self.out_total, out);
                self.acc_len = 0;
            }
        }
    }

    /// End of the stream: push out the partial chunk and the filter tail so
    /// the total output is exactly `round(input_frames × out / in)`, then
    /// reset. Pads with silence, so only call it when no more input follows.
    pub fn flush(&mut self, out: &mut Vec<f32>) {
        let Some(fft) = self.fft.as_mut() else {
            self.reset();
            return;
        };
        let expected = (self.in_total * self.out_rate as u64 + self.in_rate as u64 / 2) / self.in_rate as u64;
        let start = out.len();
        // The partial chunk and then the delay tail, zero-padded. Two chunks
        // cover it (delay < one chunk); the guard is only a backstop.
        let mut guard = 0;
        while self.out_total < expected && guard < 4 {
            self.acc[self.acc_len..].fill(0.0);
            run_chunk(fft, &self.acc, &mut self.out_chunk, &mut self.skip, &mut self.out_total, out);
            self.acc_len = 0;
            guard += 1;
        }
        if self.out_total > expected {
            let excess = ((self.out_total - expected) as usize).min(out.len() - start);
            out.truncate(out.len() - excess);
        }
        self.reset();
    }
}

/// One full input chunk through the FFT resampler, leading delay trimmed.
fn run_chunk(
    fft: &mut FftFixedInOut<f32>,
    input: &[f32],
    out_chunk: &mut [f32],
    skip: &mut usize,
    out_total: &mut u64,
    out: &mut Vec<f32>,
) {
    // Buffers are sized from the resampler itself, so this cannot fail; a
    // failure would only drop this chunk, never block or panic.
    if let Ok((_, n)) = fft.process_into_buffer(&[input], &mut [&mut *out_chunk], None) {
        let dropped = (*skip).min(n);
        *skip -= dropped;
        let kept = &out_chunk[dropped..n];
        out.extend_from_slice(kept);
        *out_total += kept.len() as u64;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    const OUT: u32 = 16_000;
    /// Irregular callback sizes, as CoreAudio delivers them (512 is the
    /// macOS default; Bluetooth and aggregate devices vary).
    const PIECES: &[usize] = &[441, 512, 480, 1024, 7, 256, 333, 4096, 1, 960, 2048, 100];

    fn sine(rate: u32, freq: f32, frames: usize, amp: f32) -> Vec<f32> {
        (0..frames).map(|i| amp * (2.0 * PI * freq * i as f32 / rate as f32).sin()).collect()
    }

    fn run_pieces(rs: &mut StreamResampler, input: &[f32], pieces: &[usize]) -> Vec<f32> {
        let mut out = Vec::new();
        let mut at = 0;
        let mut k = 0;
        while at < input.len() {
            let n = pieces[k % pieces.len()].min(input.len() - at);
            rs.process(&input[at..at + n], &mut out);
            at += n;
            k += 1;
        }
        out
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|s| s * s).sum::<f32>() / x.len().max(1) as f32).sqrt()
    }

    fn db(x: f32) -> f32 {
        20.0 * x.max(1e-12).log10()
    }

    #[test]
    fn length_is_exact_over_irregular_callbacks() {
        for &rate in &[44_100u32, 48_000, 96_000, 8_000, 22_050, 88_200] {
            for secs in [1usize, 7, 60] {
                let n = rate as usize * secs;
                let mut rs = StreamResampler::new(rate, OUT).unwrap();
                let latency = rs.latency_frames() as u64;
                let input = vec![0.01f32; n];
                let mut out = run_pieces(&mut rs, &input, PIECES);
                let due = (secs * OUT as usize) as u64;
                let got = out.len() as u64;
                assert!(got <= due && due - got <= latency, "{rate} Hz, {secs}s: {got} of {due} (latency {latency})");
                assert_eq!(rs.output_frames(), got);
                rs.flush(&mut out);
                assert_eq!(out.len() as u64, due, "{rate} Hz, {secs}s after flush");
            }
        }
    }

    #[test]
    fn no_drift_over_five_minutes_of_512_frame_callbacks() {
        // The old per-callback resampler emitted 170 per 512 frames at 48 kHz
        // (170.67 due): 1.2 s short after five minutes, 14 s after an hour.
        // Counting only, silence in. (Five minutes, not an hour: this runs
        // unoptimized.)
        let mut rs = StreamResampler::new(48_000, OUT).unwrap();
        let block = vec![0.0f32; 512];
        let mut out = Vec::with_capacity(1024);
        let mut total = 0u64;
        let blocks = 48_000u64 * 300 / 512;
        for _ in 0..blocks {
            out.clear();
            rs.process(&block, &mut out);
            total += out.len() as u64;
        }
        let due = blocks * 512 / 3;
        assert!(due - total <= rs.latency_frames() as u64, "{total} of {due}");
    }

    #[test]
    fn length_is_exact_for_odd_totals_at_44k() {
        // 44.1 → 16 is 441:160, so most totals don't divide evenly: flush
        // rounds to the nearest frame.
        for n in [1usize, 440, 441, 442, 12_345, 44_099] {
            let mut rs = StreamResampler::new(44_100, OUT).unwrap();
            let mut out = run_pieces(&mut rs, &vec![0.2; n], &[97, 512]);
            rs.flush(&mut out);
            let due = (n as u64 * 16_000 + 22_050) / 44_100;
            assert_eq!(out.len() as u64, due, "{n} frames");
        }
    }

    #[test]
    fn a_12k_tone_at_48k_is_rejected_by_40_db() {
        // 12 kHz folds to 4 kHz at 16 kHz without an anti-alias filter.
        let input = sine(48_000, 12_000.0, 48_000, 0.5);
        let mut rs = StreamResampler::new(48_000, OUT).unwrap();
        let out = run_pieces(&mut rs, &input, PIECES);
        let mid = &out[out.len() / 4..out.len() * 3 / 4];
        let atten = db(rms(mid)) - db(rms(&input));
        assert!(atten < -40.0, "12 kHz leaks at {atten:.1} dB");
    }

    #[test]
    fn out_of_band_tones_are_rejected_at_every_common_rate() {
        for &(rate, freq) in &[(44_100u32, 11_000.0f32), (96_000, 30_000.0), (96_000, 12_000.0), (48_000, 9_000.0)] {
            let input = sine(rate, freq, rate as usize, 0.5);
            let mut rs = StreamResampler::new(rate, OUT).unwrap();
            let out = run_pieces(&mut rs, &input, PIECES);
            let mid = &out[out.len() / 4..out.len() * 3 / 4];
            let atten = db(rms(mid)) - db(rms(&input));
            assert!(atten < -40.0, "{freq} Hz at {rate} Hz leaks at {atten:.1} dB");
        }
    }

    #[test]
    fn speech_band_tones_pass_within_1_db() {
        // Up to 6 kHz at 16 kHz out; an 8 kHz (narrowband Bluetooth) mic
        // only carries up to ~3.4 kHz in the first place.
        for &rate in &[44_100u32, 48_000, 96_000, 24_000, 32_000, 8_000] {
            for freq in [100.0f32, 300.0, 1_000.0, 3_000.0, 3_400.0, 6_000.0] {
                if freq > rate.min(OUT) as f32 / 2.0 * 0.85 {
                    continue;
                }
                let input = sine(rate, freq, rate as usize, 0.5);
                let mut rs = StreamResampler::new(rate, OUT).unwrap();
                let out = run_pieces(&mut rs, &input, PIECES);
                let mid = &out[out.len() / 4..out.len() * 3 / 4];
                let gain = db(rms(mid)) - db(0.5 / 2f32.sqrt());
                assert!(gain.abs() < 1.0, "{freq} Hz at {rate} Hz: {gain:.2} dB");
                // And it is the same tone, not something folded.
                let crossings = mid.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count();
                let f = crossings as f32 * OUT as f32 / mid.len() as f32;
                assert!((f - freq).abs() < freq * 0.02 + 2.0, "{freq} Hz at {rate} Hz came out at {f} Hz");
            }
        }
    }

    #[test]
    fn output_lines_up_with_the_input() {
        // An impulse at input frame 3k must peak at output frame k.
        let mut input = vec![0.0f32; 48_000];
        input[30_000] = 1.0;
        let mut rs = StreamResampler::new(48_000, OUT).unwrap();
        let mut out = run_pieces(&mut rs, &input, PIECES);
        rs.flush(&mut out);
        let peak = out
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.abs().partial_cmp(&b.1.abs()).unwrap())
            .unwrap()
            .0;
        assert!((peak as i64 - 10_000).abs() <= 1, "peak at {peak}");
    }

    #[test]
    fn callback_size_does_not_change_the_output() {
        let input = sine(48_000, 440.0, 20_000, 0.3);
        let mut a = StreamResampler::new(48_000, OUT).unwrap();
        let mut b = StreamResampler::new(48_000, OUT).unwrap();
        let oa = run_pieces(&mut a, &input, &[512]);
        let ob = run_pieces(&mut b, &input, PIECES);
        assert_eq!(oa.len(), ob.len());
        assert!(oa.iter().zip(&ob).all(|(x, y)| (x - y).abs() < 1e-6));
    }

    #[test]
    fn reset_starts_a_clean_stream() {
        let input = sine(44_100, 700.0, 10_000, 0.4);
        let mut rs = StreamResampler::new(44_100, OUT).unwrap();
        let first = run_pieces(&mut rs, &input, &[333]);
        run_pieces(&mut rs, &[0.9; 1234], &[100]); // leaves a partial chunk + history
        rs.reset();
        assert_eq!((rs.input_frames(), rs.output_frames()), (0, 0));
        let again = run_pieces(&mut rs, &input, &[333]);
        assert_eq!(first.len(), again.len());
        assert!(first.iter().zip(&again).all(|(x, y)| (x - y).abs() < 1e-6), "same input, same output");
    }

    #[test]
    fn passthrough_when_the_device_is_already_16k() {
        let input: Vec<f32> = (0..5000).map(|i| (i as f32 * 0.01).sin()).collect();
        let mut rs = StreamResampler::new(OUT, OUT).unwrap();
        assert_eq!(rs.latency_frames(), 0);
        let mut out = run_pieces(&mut rs, &input, PIECES);
        rs.flush(&mut out);
        assert_eq!(out, input);
    }

    #[test]
    fn process_does_not_allocate_once_the_output_has_room() {
        let mut rs = StreamResampler::new(44_100, OUT).unwrap();
        let block = vec![0.1f32; 512];
        let mut out = Vec::with_capacity(rs.max_output_frames(4096));
        let cap = out.capacity();
        let ptr = out.as_ptr();
        for _ in 0..1000 {
            out.clear();
            assert!(rs.max_output_frames(block.len()) <= cap);
            rs.process(&block, &mut out);
        }
        assert_eq!((out.capacity(), out.as_ptr()), (cap, ptr), "the output buffer never grew");
    }

    #[test]
    fn rejects_a_zero_rate() {
        assert!(StreamResampler::new(0, OUT).is_err());
        assert!(StreamResampler::new(48_000, 0).is_err());
    }
}
