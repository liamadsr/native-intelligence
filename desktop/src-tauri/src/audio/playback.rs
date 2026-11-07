//! Speech playback: the app's first audio output (local-tts read-aloud).
//!
//! ```text
//! sidecar reader (tts actor)                         CoreAudio IO thread
//!   24 kHz f32 ─▶ SpeechResampler ─▶ Player ══ring══▶ Renderer ─▶ device
//!                 (rubato, per utterance)  (SPSC, lock-free)  (mono → every channel)
//! ```
//!
//! - The stream is opened at the device's default config when speech starts,
//!   on the device `audio::speech_output` picks (the chosen mic's own output
//!   for a headset, else the system default output), and the tts actor drops
//!   it ~2 s after the queue drains, so each reply follows the current pick.
//! - The callback never blocks or allocates: it pops samples from a lock-free
//!   ring and outputs silence on underrun.
//! - Positions are counted in device frames on one timeline shared by the
//!   producer (`Player::enqueued`) and the callback (`Player::played`), so the
//!   actor can tell exactly when an utterance's first and last samples play.
//! - Cancel is immediate: [`CancelGate::request`] silences every stream on
//!   the next callback, before the actor has even seen the cancel; the actor
//!   then marks everything queued so far as discarded ([`Player::flush`]) and
//!   acknowledges, and the callback skips it.
//! - Reference tap (voice mode's echo canceller): while a [`TapWriter`] is
//!   installed ([`Player::set_tap`]), the callback also pushes every mono
//!   sample it outputs, silence included, into the tap's ring at the device
//!   rate. Not installed, it costs one relaxed load per callback.
//!
//! This is main-process playback, so the system-audio tap (which excludes
//! our own PID, `native/tap_helper.m`) can never record it.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use cpal::{FromSample, Sample, SizedSample};
use ringbuf::traits::{Consumer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};
use rubato::{FftFixedIn, Resampler};

use super::tap::{TapSlot, TapWriter};

/// Pocket TTS output rate.
pub const SPEECH_RATE: u32 = 24_000;
/// Resampler input chunk: 80 ms at 24 kHz, one Pocket TTS frame.
const CHUNK_FRAMES: usize = 1920;
/// Ring capacity in seconds of device audio. The producer keeps anything
/// beyond it in its own overflow queue, so this only needs to cover the gap
/// between two actor ticks.
const RING_SECONDS: usize = 2;

/// Lets any thread silence playback at once, ahead of the actor that owns the
/// queue. Each [`request`](Self::request) is paired with exactly one
/// [`ack`](Self::ack), sent by the actor after it has flushed everything
/// queued before that request; output stays silent while any is outstanding.
#[derive(Default)]
pub struct CancelGate {
    requested: AtomicU64,
    acked: AtomicU64,
}

impl CancelGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// Silence output from the next callback on. Call before telling the actor.
    pub fn request(&self) {
        self.requested.fetch_add(1, Ordering::AcqRel);
    }

    /// The actor has flushed everything queued before one request.
    pub fn ack(&self) {
        self.acked.fetch_add(1, Ordering::AcqRel);
    }

    pub fn silenced(&self) -> bool {
        self.requested.load(Ordering::Acquire) != self.acked.load(Ordering::Acquire)
    }
}

/// State one output stream's callback shares with its [`Player`].
struct StreamShared {
    /// Frames the callback has consumed (played or discarded).
    played: AtomicU64,
    /// The callback discards frames before this position (set by a flush).
    discard_until: AtomicU64,
    /// The stream is being torn down; the callback outputs silence.
    retired: AtomicBool,
    /// Set by cpal's error callback (device unplugged, format change, …).
    error: Mutex<Option<String>>,
    errored: AtomicBool,
    /// The reference tap point (see the module docs).
    tap: TapSlot,
}

/// The audio-callback side of the ring.
pub struct Renderer {
    cons: HeapCons<f32>,
    shared: Arc<StreamShared>,
    gate: Arc<CancelGate>,
    read_pos: u64,
}

impl Renderer {
    /// Fill one interleaved output buffer. Realtime-safe: atomics and the
    /// lock-free rings only; silence on underrun. With a reference tap
    /// installed, each frame's mono sample (post-clamp, 0.0 for silence) is
    /// also pushed into it; a full tap ring drops rather than blocks.
    pub fn render<T: Sample + FromSample<f32>>(&mut self, out: &mut [T], channels: usize) {
        let channels = channels.max(1);
        let mut tap = self.shared.tap.acquire();
        if self.shared.retired.load(Ordering::Relaxed) || self.gate.silenced() {
            out.fill(T::EQUILIBRIUM);
            if let Some(tap) = tap.as_mut() {
                tap.push_silence(out.len() / channels);
            }
            return;
        }
        let until = self.shared.discard_until.load(Ordering::Acquire);
        if self.read_pos < until {
            self.read_pos += self.cons.skip((until - self.read_pos) as usize) as u64;
        }
        for frame in out.chunks_mut(channels) {
            let sample = match self.cons.try_pop() {
                Some(s) => {
                    self.read_pos += 1;
                    s.clamp(-1.0, 1.0)
                }
                None => 0.0,
            };
            frame.fill(T::from_sample(sample));
            if let Some(tap) = tap.as_mut() {
                tap.push(sample);
            }
        }
        self.shared.played.store(self.read_pos, Ordering::Release);
    }

    /// The player that owns this renderer has been dropped.
    #[cfg(test)]
    pub fn is_retired(&self) -> bool {
        self.shared.retired.load(Ordering::Relaxed)
    }
}

/// `cpal::Stream` is `!Send` on every platform by marker. On CoreAudio its
/// internals are an `Arc<Mutex<..>>` and the AudioUnit calls are thread-safe;
/// we only ever build it on one blocking thread and drop it on another, never
/// using it concurrently (the same reasoning as `mic_capture::StreamHandle`).
struct OutputStream(#[allow(dead_code)] cpal::Stream);
unsafe impl Send for OutputStream {}

/// The producer side: owned by the tts actor. Dropping it retires the
/// callback and closes the device stream (a blocking CoreAudio call — drop it
/// on a blocking thread).
pub struct Player {
    prod: HeapProd<f32>,
    shared: Arc<StreamShared>,
    /// Frames pushed into the ring.
    written: u64,
    /// Frames waiting for room in the ring, in order.
    overflow: VecDeque<f32>,
    rate: u32,
    stream: Option<OutputStream>,
    /// The CoreAudio AudioObjectID of the device the stream is on, when
    /// known (see [`Player::device_id`]).
    device_id: Option<u32>,
}

impl Player {
    /// A player/renderer pair with a ring of [`RING_SECONDS`] at `rate`.
    pub fn new(rate: u32, gate: Arc<CancelGate>) -> (Player, Renderer) {
        Self::with_capacity(rate, rate as usize * RING_SECONDS, gate)
    }

    pub fn with_capacity(rate: u32, capacity: usize, gate: Arc<CancelGate>) -> (Player, Renderer) {
        let (prod, cons) = HeapRb::<f32>::new(capacity.max(1)).split();
        let shared = Arc::new(StreamShared {
            played: AtomicU64::new(0),
            discard_until: AtomicU64::new(0),
            retired: AtomicBool::new(false),
            error: Mutex::new(None),
            errored: AtomicBool::new(false),
            tap: TapSlot::new(),
        });
        let player = Player {
            prod,
            shared: shared.clone(),
            written: 0,
            overflow: VecDeque::new(),
            rate,
            stream: None,
            device_id: None,
        };
        let renderer = Renderer { cons, shared, gate, read_pos: 0 };
        (player, renderer)
    }

    /// Device sample rate.
    pub fn rate(&self) -> u32 {
        self.rate
    }

    /// The CoreAudio AudioObjectID of the output device this plays on; None
    /// when it couldn't be read (and for test players).
    pub fn device_id(&self) -> Option<u32> {
        self.device_id
    }

    /// Record the device a stream is on (fake devices in tests).
    #[cfg(test)]
    pub(crate) fn set_device_id(&mut self, id: Option<u32>) {
        self.device_id = id;
    }

    /// Install a reference tap (`Some`) or remove it (`None`), returning the
    /// one it replaces so the caller drops it (never the audio thread). An
    /// installed tap is told this stream's rate and starts a new epoch.
    /// Realtime-safe handoff: see [`TapSlot`].
    pub fn set_tap(&mut self, tap: Option<TapWriter>) -> Option<TapWriter> {
        // Rate and epoch first, so no frame of this stream is read as the
        // previous one's.
        if let Some(t) = &tap {
            t.begin_stream(self.rate);
        }
        self.shared.tap.replace(tap)
    }

    /// Whether a reference tap is installed.
    #[allow(dead_code)] // tests; the TTS actor tracks its own hold
    pub fn has_tap(&self) -> bool {
        self.shared.tap.is_installed()
    }

    /// Timeline position just after the last frame accepted so far.
    pub fn enqueued(&self) -> u64 {
        self.written + self.overflow.len() as u64
    }

    /// Timeline position the callback has consumed up to.
    pub fn played(&self) -> u64 {
        self.shared.played.load(Ordering::Acquire)
    }

    /// Everything accepted has played.
    pub fn drained(&self) -> bool {
        self.played() >= self.enqueued()
    }

    /// Queue mono device-rate samples. Never blocks: what doesn't fit in the
    /// ring waits in the overflow queue for [`pump`](Self::pump).
    pub fn push(&mut self, samples: &[f32]) {
        if samples.is_empty() {
            return;
        }
        if self.overflow.is_empty() {
            let n = self.prod.push_slice(samples);
            self.written += n as u64;
            self.overflow.extend(&samples[n..]);
        } else {
            self.pump();
            self.overflow.extend(samples);
        }
    }

    /// Move overflow into the ring as space allows.
    pub fn pump(&mut self) {
        while !self.overflow.is_empty() {
            let (front, _) = self.overflow.as_slices();
            let n = self.prod.push_slice(front);
            self.written += n as u64;
            self.overflow.drain(..n);
            if n == 0 {
                break;
            }
        }
    }

    /// Drop everything queued so far: overflow now, and the ring's contents
    /// on the callback's next run.
    pub fn flush(&mut self) {
        self.overflow.clear();
        self.shared.discard_until.store(self.written, Ordering::Release);
    }

    /// A device error reported since the last call, if any.
    pub fn take_error(&self) -> Option<String> {
        if !self.shared.errored.swap(false, Ordering::AcqRel) {
            return None;
        }
        let message = self.shared.error.lock().ok().and_then(|mut e| e.take());
        Some(message.unwrap_or_else(|| "output device error".into()))
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        // Silence the callback before the stream itself is torn down.
        self.shared.retired.store(true, Ordering::Relaxed);
        if self.stream.take().is_some() {
            crate::log_to_file("[tts] output stream closed");
        }
    }
}

/// An output device to open: by name (cpal 0.15's only open key), and by
/// AudioObjectID among several with that name (as the input side does,
/// `input_devices::InputTarget`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputTarget {
    pub name: String,
    pub object_id: Option<u32>,
}

/// Open the system default output device (see [`open_output`]).
#[allow(dead_code)] // the TTS tests' real-speakers run; the app opens through audio::speech_output
pub fn open_default_output(gate: Arc<CancelGate>) -> Result<Player, String> {
    open_output(None, "the system default", gate)
}

/// The present output device `target` names: by name, then by AudioObjectID
/// among those with that name (else the first of that name).
fn find_output(host: &cpal::Host, target: &OutputTarget) -> Result<cpal::Device, String> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let mut named: Vec<cpal::Device> = host
        .output_devices()
        .map_err(|e| format!("could not list output devices: {e}"))?
        .filter(|d| d.name().ok().as_deref() == Some(target.name.as_str()))
        .collect();
    if named.is_empty() {
        return Err(format!("output device \"{}\" not found", target.name));
    }
    if let Some(id) = target.object_id {
        if let Some(i) = named.iter().position(|d| super::input_devices::cpal_object_id(d) == Some(id)) {
            return Ok(named.swap_remove(i));
        }
        if named.len() > 1 {
            crate::log_to_file(&format!(
                "[tts] no output {:?} with AudioObjectID {id}; opening the first of that name",
                target.name
            ));
        }
    }
    Ok(named.swap_remove(0))
}

/// Open `target` (None: the system default output) at its default config
/// and start a stream fed by a new ring. `why` says how the device was
/// chosen, for the log line. Blocking (CoreAudio): call it on a blocking
/// thread.
pub fn open_output(target: Option<&OutputTarget>, why: &str, gate: Arc<CancelGate>) -> Result<Player, String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::SampleFormat;

    let host = cpal::default_host();
    let device = match target {
        Some(t) => find_output(&host, t)?,
        None => host.default_output_device().ok_or_else(|| "no default output device".to_string())?,
    };
    let name = device.name().unwrap_or_else(|_| "<unnamed>".into());
    let supported = device
        .default_output_config()
        .map_err(|e| format!("no output config on \"{name}\": {e}"))?;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let rate = config.sample_rate.0;
    let channels = config.channels as usize;

    let (mut player, renderer) = Player::new(rate, gate);
    player.device_id = super::input_devices::cpal_object_id(&device);
    let shared = player.shared.clone();
    let stream = match format {
        SampleFormat::F32 => build::<f32>(&device, &config, renderer, channels, shared),
        SampleFormat::I16 => build::<i16>(&device, &config, renderer, channels, shared),
        SampleFormat::I32 => build::<i32>(&device, &config, renderer, channels, shared),
        SampleFormat::U16 => build::<u16>(&device, &config, renderer, channels, shared),
        other => return Err(format!("unsupported output sample format {other:?} on \"{name}\"")),
    }
    .map_err(|e| format!("could not open \"{name}\": {e}"))?;
    stream.play().map_err(|e| format!("could not start \"{name}\": {e}"))?;
    player.stream = Some(OutputStream(stream));
    crate::log_to_file(&format!(
        "[tts] output opened on \"{}\" ({}): {} Hz, {} ch, {:?}",
        name, why, rate, channels, format
    ));
    Ok(player)
}

fn build<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    mut renderer: Renderer,
    channels: usize,
    shared: Arc<StreamShared>,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: SizedSample + FromSample<f32>,
{
    use cpal::traits::DeviceTrait;
    device.build_output_stream::<T, _, _>(
        config,
        move |data: &mut [T], _: &cpal::OutputCallbackInfo| renderer.render(data, channels),
        move |err| {
            // Not the IO thread: CoreAudio reports these from its notification
            // thread, so logging and a mutex are fine here.
            crate::log_to_file(&format!("[tts] output device error: {err}"));
            if let Ok(mut slot) = shared.error.lock() {
                *slot = Some(err.to_string());
            }
            shared.errored.store(true, Ordering::Release);
        },
        None,
    )
}

/// Streaming 24 kHz → device-rate conversion, one utterance at a time.
///
/// Fixed 1920-frame input chunks through rubato's FFT resampler. Each
/// utterance starts from a clean filter ([`begin`](Self::begin)); its leading
/// filter delay is trimmed and [`finish`](Self::finish) flushes the tail, so
/// an utterance of `n` input frames yields exactly `round(n × out/in)` output
/// frames, aligned with the input. That keeps the per-utterance position
/// marks exact.
pub struct SpeechResampler {
    in_rate: u32,
    out_rate: u32,
    /// `None` when the rates match (passthrough).
    fft: Option<FftFixedIn<f32>>,
    pending: Vec<f32>,
    out_buf: Vec<Vec<f32>>,
    delay: usize,
    /// Leading delay frames still to drop.
    skip: usize,
    in_total: u64,
    out_total: u64,
}

impl SpeechResampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Result<Self, String> {
        if in_rate == 0 || out_rate == 0 {
            return Err(format!("invalid sample rates {in_rate} → {out_rate}"));
        }
        let fft = if in_rate == out_rate {
            None
        } else {
            Some(
                FftFixedIn::<f32>::new(in_rate as usize, out_rate as usize, CHUNK_FRAMES, 1, 1)
                    .map_err(|e| format!("resampler {in_rate} → {out_rate}: {e}"))?,
            )
        };
        let (out_buf, delay) = match &fft {
            Some(r) => (r.output_buffer_allocate(true), r.output_delay()),
            None => (Vec::new(), 0),
        };
        Ok(Self {
            in_rate,
            out_rate,
            fft,
            pending: Vec::with_capacity(CHUNK_FRAMES * 2),
            out_buf,
            delay,
            skip: delay,
            in_total: 0,
            out_total: 0,
        })
    }

    pub fn rates(&self) -> (u32, u32) {
        (self.in_rate, self.out_rate)
    }

    /// Start a new utterance from a clean filter state.
    pub fn begin(&mut self) {
        if let Some(fft) = self.fft.as_mut() {
            fft.reset();
        }
        self.pending.clear();
        self.skip = self.delay;
        self.in_total = 0;
        self.out_total = 0;
    }

    /// Resample `input`, appending whatever output is ready to `out`.
    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        self.in_total += input.len() as u64;
        let Some(fft) = self.fft.as_mut() else {
            out.extend_from_slice(input);
            self.out_total += input.len() as u64;
            return;
        };
        self.pending.extend_from_slice(input);
        let mut consumed = 0;
        while self.pending.len() - consumed >= CHUNK_FRAMES {
            let chunk = &self.pending[consumed..consumed + CHUNK_FRAMES];
            match fft.process_into_buffer(&[chunk], &mut self.out_buf, None) {
                Ok((_, n)) => emit_trimmed(&self.out_buf[0][..n], &mut self.skip, &mut self.out_total, out),
                Err(e) => {
                    crate::log_to_file(&format!("[tts] resampler error: {e}"));
                    break;
                }
            }
            consumed += CHUNK_FRAMES;
        }
        self.pending.drain(..consumed);
    }

    /// End of the utterance: flush the partial chunk and the filter tail so
    /// the output is exactly as long as the input, in device frames.
    pub fn finish(&mut self, out: &mut Vec<f32>) {
        let Some(fft) = self.fft.as_mut() else { return };
        let expected = (self.in_total * self.out_rate as u64 + self.in_rate as u64 / 2) / self.in_rate as u64;
        let start = out.len();
        if !self.pending.is_empty() {
            let input: &[f32] = &self.pending;
            match fft.process_partial_into_buffer(Some(&[input]), &mut self.out_buf, None) {
                Ok((_, n)) => emit_trimmed(&self.out_buf[0][..n], &mut self.skip, &mut self.out_total, out),
                Err(e) => crate::log_to_file(&format!("[tts] resampler flush error: {e}")),
            }
            self.pending.clear();
        }
        // The filter delay is at most one chunk, so this runs once or twice.
        let mut guard = 0;
        while self.out_total < expected && guard < 4 {
            match fft.process_partial_into_buffer(None::<&[&[f32]]>, &mut self.out_buf, None) {
                Ok((_, n)) => emit_trimmed(&self.out_buf[0][..n], &mut self.skip, &mut self.out_total, out),
                Err(e) => {
                    crate::log_to_file(&format!("[tts] resampler flush error: {e}"));
                    break;
                }
            }
            guard += 1;
        }
        if self.out_total > expected {
            let excess = ((self.out_total - expected) as usize).min(out.len() - start);
            out.truncate(out.len() - excess);
            self.out_total -= excess as u64;
        }
    }
}

fn emit_trimmed(src: &[f32], skip: &mut usize, out_total: &mut u64, out: &mut Vec<f32>) {
    let dropped = (*skip).min(src.len());
    *skip -= dropped;
    let kept = &src[dropped..];
    out.extend_from_slice(kept);
    *out_total += kept.len() as u64;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resample_all(in_rate: u32, out_rate: u32, input: &[f32], piece: usize) -> Vec<f32> {
        let mut rs = SpeechResampler::new(in_rate, out_rate).unwrap();
        rs.begin();
        let mut out = Vec::new();
        for chunk in input.chunks(piece) {
            rs.push(chunk, &mut out);
        }
        rs.finish(&mut out);
        out
    }

    fn sine(rate: u32, freq: f32, frames: usize, amp: f32) -> Vec<f32> {
        (0..frames)
            .map(|i| amp * (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin())
            .collect()
    }

    /// Frequency estimate from rising zero crossings over the middle half.
    fn estimate_freq(samples: &[f32], rate: u32) -> f32 {
        let lo = samples.len() / 4;
        let hi = samples.len() * 3 / 4;
        let crossings = samples[lo..hi].windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count();
        crossings as f32 * rate as f32 / (hi - lo) as f32
    }

    #[test]
    fn output_length_is_exact_for_common_device_rates() {
        for &(out_rate, frames) in &[(48_000u32, 24_000usize), (44_100, 24_000), (44_100, 1_000), (48_000, 1_921), (16_000, 5_000), (96_000, 3_840)] {
            // Odd piece sizes, like real sidecar frames (80 ms first, then up to 1.2 s).
            let out = resample_all(SPEECH_RATE, out_rate, &vec![0.1; frames], 777);
            let expected = (frames as u64 * out_rate as u64 + SPEECH_RATE as u64 / 2) / SPEECH_RATE as u64;
            assert_eq!(out.len() as u64, expected, "{frames} frames → {out_rate} Hz");
        }
    }

    #[test]
    fn passthrough_when_rates_match() {
        let input: Vec<f32> = (0..5000).map(|i| (i as f32 * 0.001).sin()).collect();
        assert_eq!(resample_all(SPEECH_RATE, SPEECH_RATE, &input, 1920), input);
    }

    #[test]
    fn sine_keeps_its_pitch_and_level() {
        let input = sine(SPEECH_RATE, 440.0, SPEECH_RATE as usize, 0.5);
        for out_rate in [44_100u32, 48_000] {
            let out = resample_all(SPEECH_RATE, out_rate, &input, 1920);
            let f = estimate_freq(&out, out_rate);
            assert!((f - 440.0).abs() < 3.0, "{out_rate}: {f} Hz");
            let mid = &out[out.len() / 4..out.len() * 3 / 4];
            let rms = (mid.iter().map(|s| s * s).sum::<f32>() / mid.len() as f32).sqrt();
            assert!((rms - 0.5 / 2f32.sqrt()).abs() < 0.01, "{out_rate}: rms {rms}");
        }
    }

    #[test]
    fn delay_is_compensated_so_audio_lines_up() {
        // An impulse at input frame k must peak at output frame k × ratio,
        // i.e. the utterance's samples start where its mark says they do.
        let mut input = vec![0.0; 6000];
        input[3000] = 1.0;
        let out = resample_all(SPEECH_RATE, 48_000, &input, 1000);
        let peak = out
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.abs().partial_cmp(&b.1.abs()).unwrap())
            .unwrap()
            .0;
        assert!((peak as i64 - 6000).abs() <= 1, "peak at {peak}");
    }

    #[test]
    fn begin_resets_between_utterances() {
        let mut rs = SpeechResampler::new(SPEECH_RATE, 44_100).unwrap();
        let mut a = Vec::new();
        rs.begin();
        rs.push(&vec![0.3; 2500], &mut a);
        rs.finish(&mut a);
        let mut b = Vec::new();
        rs.begin();
        rs.push(&vec![0.3; 2500], &mut b);
        rs.finish(&mut b);
        assert_eq!(a.len(), b.len());
        assert!(a.iter().zip(&b).all(|(x, y)| (x - y).abs() < 1e-6), "same input, same output");
    }

    fn render_f32(r: &mut Renderer, frames: usize, channels: usize) -> Vec<f32> {
        let mut buf = vec![9.0f32; frames * channels];
        r.render(&mut buf, channels);
        buf
    }

    #[test]
    fn ring_maps_mono_to_every_channel_and_underruns_to_silence() {
        let gate = Arc::new(CancelGate::new());
        let (mut p, mut r) = Player::with_capacity(48_000, 64, gate);
        p.push(&[0.1, 0.2, 0.3]);
        let out = render_f32(&mut r, 5, 2);
        assert_eq!(out, vec![0.1, 0.1, 0.2, 0.2, 0.3, 0.3, 0.0, 0.0, 0.0, 0.0]);
        assert_eq!(p.played(), 3);
        assert!(p.drained());
    }

    #[test]
    fn overflow_waits_for_room_and_keeps_the_timeline() {
        let gate = Arc::new(CancelGate::new());
        let (mut p, mut r) = Player::with_capacity(48_000, 8, gate);
        let input: Vec<f32> = (0..20).map(|i| i as f32 / 100.0).collect();
        p.push(&input);
        assert_eq!(p.enqueued(), 20);
        let mut heard = Vec::new();
        for _ in 0..5 {
            heard.extend(render_f32(&mut r, 4, 1));
            p.pump();
        }
        assert_eq!(&heard[..20], &input[..], "order preserved across the overflow");
        assert_eq!(p.played(), 20);
        assert!(p.drained());
    }

    #[test]
    fn flush_discards_queued_audio_and_the_gate_silences_until_acked() {
        let gate = Arc::new(CancelGate::new());
        let (mut p, mut r) = Player::with_capacity(48_000, 8, gate.clone());
        p.push(&[0.5; 20]); // 8 in the ring, 12 in overflow
        assert_eq!(render_f32(&mut r, 2, 1), vec![0.5, 0.5]);

        // Cancel from another thread: silent at once, before the actor acts.
        gate.request();
        assert!(gate.silenced());
        assert_eq!(render_f32(&mut r, 3, 1), vec![0.0; 3]);

        // Stale audio the actor pushes before it sees the cancel is covered by
        // the flush too.
        p.push(&[0.7; 3]);
        p.flush();
        gate.ack();
        assert!(!gate.silenced());
        assert_eq!(render_f32(&mut r, 3, 1), vec![0.0; 3], "nothing stale plays");

        // New audio after the flush plays normally, on the same timeline.
        p.push(&[0.25; 2]);
        let before = p.enqueued();
        assert_eq!(render_f32(&mut r, 3, 1), vec![0.25, 0.25, 0.0]);
        assert_eq!(p.played(), before);
    }

    #[test]
    fn integer_formats_are_scaled() {
        let gate = Arc::new(CancelGate::new());
        let (mut p, mut r) = Player::with_capacity(48_000, 8, gate);
        p.push(&[0.5, -1.0, 2.0]);
        let mut out = [0i16; 4];
        r.render(&mut out, 1);
        assert!((out[0] as i32 - 16384).abs() <= 1, "{}", out[0]);
        assert_eq!(out[1], i16::MIN);
        assert_eq!(out[2], i16::MAX, "clamped");
        assert_eq!(out[3], 0);
    }

    fn drain(r: &mut crate::audio::tap::TapReader) -> Vec<f32> {
        let mut out = vec![0.0; r.available()];
        let n = r.pop_slice(&mut out);
        out.truncate(n);
        out
    }

    #[test]
    fn reference_tap_gets_every_rendered_sample_post_clamp_with_silence() {
        let gate = Arc::new(CancelGate::new());
        let (mut p, mut r) = Player::with_capacity(44_100, 64, gate);
        let (w, mut tap) = crate::audio::tap::tap_channel(64);
        assert!(p.set_tap(Some(w)).is_none());
        assert!(p.has_tap());
        assert_eq!((tap.rate(), tap.epoch()), (44_100, 1), "the device rate comes with it");

        p.push(&[0.25, 1.5, -2.0]);
        let out = render_f32(&mut r, 5, 2);
        assert_eq!(out, vec![0.25, 0.25, 1.0, 1.0, -1.0, -1.0, 0.0, 0.0, 0.0, 0.0]);
        // One mono sample per frame: what was played, clamped, and the
        // underrun as silence.
        assert_eq!(drain(&mut tap), vec![0.25, 1.0, -1.0, 0.0, 0.0]);
    }

    #[test]
    fn reference_tap_sees_the_silence_of_a_cancel() {
        let gate = Arc::new(CancelGate::new());
        let (mut p, mut r) = Player::with_capacity(48_000, 64, gate.clone());
        let (w, mut tap) = crate::audio::tap::tap_channel(64);
        p.set_tap(Some(w));
        p.push(&[0.5; 8]);
        gate.request();
        assert_eq!(render_f32(&mut r, 4, 2), vec![0.0; 8]);
        assert_eq!(drain(&mut tap), vec![0.0; 4], "the device output silence, so does the reference");
    }

    #[test]
    fn reference_tap_drops_on_a_full_ring_without_touching_the_output() {
        let gate = Arc::new(CancelGate::new());
        let (mut p, mut r) = Player::with_capacity(48_000, 64, gate);
        let (w, mut tap) = crate::audio::tap::tap_channel(3);
        p.set_tap(Some(w));
        p.push(&[0.1, 0.2, 0.3, 0.4, 0.5]);
        assert_eq!(render_f32(&mut r, 5, 1), vec![0.1, 0.2, 0.3, 0.4, 0.5], "playback unaffected");
        assert_eq!(drain(&mut tap), vec![0.1, 0.2, 0.3]);
        assert_eq!(tap.dropped(), 2);
        assert_eq!(p.played(), 5);
    }

    #[test]
    fn output_is_identical_with_and_without_a_tap_and_removal_stops_it() {
        let input: Vec<f32> = (0..200).map(|i| ((i as f32) * 0.1).sin() * 1.2).collect();
        let render_all = |with_tap: bool| {
            let gate = Arc::new(CancelGate::new());
            let (mut p, mut r) = Player::with_capacity(48_000, 256, gate);
            let tap = with_tap.then(|| {
                let (w, reader) = crate::audio::tap::tap_channel(1024);
                p.set_tap(Some(w));
                reader
            });
            p.push(&input);
            let mut heard = Vec::new();
            for _ in 0..30 {
                heard.extend(render_f32(&mut r, 7, 2));
            }
            (heard, tap, p, r)
        };
        let (plain, _, _p0, _r0) = render_all(false);
        let (tapped, tap, mut p, mut r) = render_all(true);
        assert_eq!(plain, tapped, "the tap never changes what the device gets");
        let mut tap = tap.unwrap();
        let mono: Vec<f32> = tapped.chunks(2).map(|f| f[0]).collect();
        assert_eq!(drain(&mut tap), mono);

        let old = p.set_tap(None);
        assert!(old.is_some() && !p.has_tap(), "the writer comes back to be dropped off the audio thread");
        p.push(&[0.3; 4]);
        render_f32(&mut r, 4, 2);
        assert!(drain(&mut tap).is_empty(), "nothing after removal");
    }

    #[test]
    fn moving_the_tap_to_a_new_stream_announces_the_new_rate() {
        let gate = Arc::new(CancelGate::new());
        let (mut a, _ra) = Player::with_capacity(48_000, 8, gate.clone());
        let (mut b, _rb) = Player::with_capacity(44_100, 8, gate);
        let (w, tap) = crate::audio::tap::tap_channel(8);
        a.set_tap(Some(w));
        let w = a.set_tap(None).unwrap();
        b.set_tap(Some(w));
        assert_eq!((tap.rate(), tap.epoch()), (44_100, 2));
    }

    #[test]
    fn dropped_player_retires_the_callback() {
        let gate = Arc::new(CancelGate::new());
        let (mut p, mut r) = Player::with_capacity(48_000, 8, gate);
        p.push(&[0.5; 4]);
        drop(p);
        assert!(r.is_retired());
        assert_eq!(render_f32(&mut r, 2, 1), vec![0.0, 0.0]);
    }
}
