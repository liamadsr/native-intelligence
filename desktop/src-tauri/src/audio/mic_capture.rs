use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleRate, StreamConfig};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use super::resample::StreamResampler;
use super::tap::{TapSlot, TapWriter};
use super::input_devices::{InUse, InUseHandle, InputTarget};
use super::types::{TARGET_CHANNELS, TARGET_SAMPLE_RATE};
use super::wav_writer::WavWriter;

/// How long start() waits for a REUSED persistent stream (paused by the last
/// stop(), resumed with play()) to prove it is alive before abandoning it for
/// a fresh one. play() returning Ok proves nothing: after long idle gaps prod
/// logs show 6/6 reused streams producing NO frames at all. A built-in or
/// wired mic's first callback lands within tens of ms, but a Bluetooth headset
/// can take 1–2s to switch profiles and deliver its first frame after
/// AudioOutputUnitStart — a shorter wait risks reopening a healthy stream,
/// which then pays the same switch again. The wait ends at the first frame, so
/// it only costs time in the slow/dead case, and a dead stream costs this
/// instead of the old 3s first-frame watchdog + recover_mic round trip + an
/// 8–21s blocking rebuild.
const REUSE_FIRST_FRAME_WAIT_MS: u64 = 2500;

/// Device frames per callback the capture callback's scratch buffers are
/// sized for up front (macOS delivers 512 by default; Bluetooth and
/// aggregate devices go higher). A bigger callback grows them once.
const CALLBACK_PREALLOC_FRAMES: usize = 8192;

/// Wrapper to allow cpal::Stream in Mutex across threads.
/// cpal::Stream is !Send because of platform internals, but we only
/// access it from controlled contexts: start/stop/recover on the command
/// thread while the MicCapture lock is held, and — once retired — pause +
/// drop on a disposal thread that owns it exclusively (drop_stream_async).
/// The stream's shared internals are an Arc<Mutex<..>> and CoreAudio calls
/// are thread-safe, so the disposal thread is just another controlled context.
struct StreamHandle {
    stream: cpal::Stream,
    /// Set once this stream is replaced (drop_stream_async). Checked FIRST in
    /// both cpal callbacks, so a retired stream can never touch the state its
    /// replacement now owns (see drop_stream_async for why it can still fire).
    retired: Arc<AtomicBool>,
}
unsafe impl Send for StreamHandle {}

pub type SampleCallback = Arc<Mutex<Option<Box<dyn Fn(&[f32]) + Send>>>>;

/// Persistent mic capture that keeps the cpal stream alive across recordings.
///
/// On macOS, rapidly cycling CoreAudio input streams causes hardware-level
/// degradation — the mic becomes sluggish on subsequent recordings.
/// To avoid this, the cpal stream is opened once and kept alive. Only the
/// WAV writer and `is_recording` flag are toggled between sessions.
///
/// A paused stream is only REUSED while that is provably safe: same device
/// (including the system default not having moved), no system sleep since it
/// was opened, and a first frame within REUSE_FIRST_FRAME_WAIT_MS of play().
/// Anything else reopens (see reuse_verdict) — a paused unit carried across a
/// sleep or a long idle gap comes back "playable" but produces nothing.
pub struct MicCapture {
    stream: Option<StreamHandle>,
    wav_writer: Arc<Mutex<Option<WavWriter>>>,
    is_recording: Arc<AtomicBool>,
    is_paused: Arc<AtomicBool>,
    /// Set by the cpal error callback when the input stream faults (e.g. a
    /// disconnected device / yanked headset). Realtime-safe to set from the
    /// callback; a supervisor reads it to drive recovery off the audio thread.
    stream_faulted: Arc<AtomicBool>,
    /// Set from the top of the cpal data callback the first time the CoreAudio
    /// IO proc fires. This is the ONLY positive proof that the input device is
    /// actually alive: `build_input_stream` + `play()` both return Ok even when
    /// macOS hasn't released the mic from a just-killed process (e.g. quit
    /// mid-recording, reopen seconds later, resume) — the IO proc then never
    /// fires and zero frames arrive from t=0. A silent room still produces
    /// frames (near-zero samples), so "no frames at all" means a dead device,
    /// NOT a quiet user. A supervisor reads this off the audio thread to flag a
    /// fault if the first frame never lands within a short window of start,
    /// and start() polls it to verify a reused stream before trusting it.
    got_first_frame: Arc<AtomicBool>,
    /// Mid-recording liveness: when the data callback last ran, stored as
    /// `clock.elapsed()` in ms + 1 so that 0 means "no frame yet on this
    /// stream" (open_stream resets it). The first-frame flag can't see a
    /// device that dies AFTER its first frame — e.g. a Bluetooth headset
    /// switched away, where cpal fires no error callback at all — so the
    /// session's stall watchdog reads this instead. Callbacks keep firing while
    /// a recording is paused (pause only gates emission), so it is a pure
    /// device-liveness signal with no pause hole.
    last_frame_ms: Arc<AtomicU64>,
    /// Digital-silence watch (input_devices::SilenceWatch): when the current
    /// stream first delivered a non-zero sample, in last_frame_ms's encoding
    /// (0 = not yet). Cleared when a stream is opened and when a start reuses
    /// one; set once, before the pause gate, like last_frame_ms. Only a
    /// stream that has never made a sound is warned about: a mic with a
    /// hardware noise gate sends exact zeros between utterances.
    last_sound_ms: Arc<AtomicU64>,
    /// ...and when that stream was opened or (re)started, the reference for
    /// how long it has been silent.
    stream_opened_ms: Arc<AtomicU64>,
    /// Monotonic origin for last_frame_ms, fixed at construction.
    clock: Instant,
    level: Arc<Mutex<f32>>,
    sample_callback: SampleCallback,
    /// Handle for the WAV writer thread — joined on stop.
    writer_thread: Option<thread::JoinHandle<()>>,
    /// Channel sender swapped per-session so the persistent callback can
    /// route samples to the current writer thread.
    wav_writer_tx: Arc<Mutex<Option<std::sync::mpsc::Sender<Vec<f32>>>>>,
    /// Persistent stream config for reuse across recordings.
    /// If set, the stream is already open and we just need to swap the writer.
    /// The device the stream was REQUESTED for (None = "the default");
    /// reuse_verdict compares its UID.
    stream_target: Option<InputTarget>,
    stream_native_rate: u32,
    stream_native_channels: u16,
    /// The device's ACTUAL name when the stream was opened (`device.name()`),
    /// as opposed to stream_target, which is what was REQUESTED (None =
    /// "the default"). cpal binds a stream to a concrete device, so a
    /// default-device stream reused after the system default input moved
    /// would keep recording the old device; comparing this against the
    /// current default catches that.
    stream_opened_name: Option<String>,
    /// crate::power sleep/wake epoch when the stream was opened. A stream from
    /// an earlier epoch is never reused (see reuse_verdict).
    stream_epoch: u64,
    /// Raw mic tap (mono, device rate, before resampling) for the voice
    /// session's echo canceller. Persistent across stream reopens: each new
    /// stream announces its rate on it (see install_raw_tap).
    raw_tap: Arc<TapSlot>,
    /// Asks the capture callback to reset its resampler before the next
    /// recorded frame, so a reused stream never carries the previous
    /// recording's tail into a new one. Set by start().
    resampler_reset: Arc<AtomicBool>,
    /// Bumped each time a new cpal stream is opened (first open, device
    /// switch, fault recovery), before the stream can call back. The capture
    /// echo canceller reads it per chunk to reset on a new stream: another
    /// device is another echo path and another latency.
    stream_generation: Arc<AtomicU64>,
    /// The device the current stream is open on (set by open_stream, cleared
    /// by retire_stream), for the input-device list's "in use" dot and the
    /// supervisor. An internal leaf mutex like wav_writer_tx: never held
    /// while taking another lock.
    in_use: Arc<Mutex<Option<InUse>>>,
    /// The running start writes a WAV (a meeting capture, not a voice
    /// session): only those switch mics live.
    capturing_to_file: Arc<AtomicBool>,
    /// Bumped around a live device switch (switch_device). The session
    /// watchdog re-arms its first-frame clock when it changes, as it does
    /// when a recovery clears a fault; otherwise the switched stream's
    /// cleared first-frame flag reads as a dead device.
    switch_epoch: Arc<AtomicU64>,
}

impl MicCapture {
    pub fn new() -> Self {
        Self {
            stream: None,
            wav_writer: Arc::new(Mutex::new(None)),
            is_recording: Arc::new(AtomicBool::new(false)),
            is_paused: Arc::new(AtomicBool::new(false)),
            stream_faulted: Arc::new(AtomicBool::new(false)),
            got_first_frame: Arc::new(AtomicBool::new(false)),
            last_frame_ms: Arc::new(AtomicU64::new(0)),
            last_sound_ms: Arc::new(AtomicU64::new(0)),
            stream_opened_ms: Arc::new(AtomicU64::new(0)),
            clock: Instant::now(),
            level: Arc::new(Mutex::new(0.0)),
            sample_callback: Arc::new(Mutex::new(None)),
            writer_thread: None,
            wav_writer_tx: Arc::new(Mutex::new(None)),
            stream_target: None,
            stream_native_rate: 0,
            stream_native_channels: 0,
            stream_opened_name: None,
            stream_epoch: 0,
            raw_tap: Arc::new(TapSlot::new()),
            resampler_reset: Arc::new(AtomicBool::new(false)),
            stream_generation: Arc::new(AtomicU64::new(0)),
            in_use: Arc::new(Mutex::new(None)),
            capturing_to_file: Arc::new(AtomicBool::new(false)),
            switch_epoch: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Start capturing from `device` (None = the system default), as picked
    /// by `input_devices::resolve`.
    ///
    /// With `output_path`, the 16 kHz mono mic is written to that WAV (meeting
    /// capture). With `None` nothing is written: the stream runs only for the
    /// sample callback, the level meter and the raw tap (a voice session).
    /// Either way the stream reuse, first-frame proof and fault handling are
    /// the same, and stop() ends it.
    pub fn start(&mut self, device: Option<&InputTarget>, output_path: Option<PathBuf>) -> Result<(), String> {
        // Stop any in-progress recording
        self.capturing_to_file.store(false, Ordering::SeqCst);
        if self.is_recording.load(Ordering::SeqCst) {
            self.is_recording.store(false, Ordering::SeqCst);
            *self.wav_writer_tx.lock().unwrap() = None;
            if let Some(handle) = self.writer_thread.take() {
                let _ = handle.join();
            }
        }

        // Arm the first-frame watchdog for this recording. Cleared BEFORE we
        // play() the stream so the callback's store(true) can only reflect a
        // frame from THIS session. Covers the reused-stream path too: a
        // persistent stream `play()`'d after the app was quit and reopened can
        // hit the same CoreAudio device-release race and never fire its IO proc.
        self.got_first_frame.store(false, Ordering::SeqCst);
        // A fault flagged in the dying moments of the PREVIOUS recording must
        // not leak into this one: stop() pauses rather than drops the stream,
        // so the reuse path below never passes through open_stream's clear —
        // a stale `true` here would make the session watchdog fire a spurious
        // recovery the moment this recording starts.
        self.stream_faulted.store(false, Ordering::SeqCst);
        // The silence watch starts over with every start (a reused stream
        // included): sound or zeros before it belong to no capture.
        self.restart_sound_watch();

        // The current default device's name only matters to reuse_verdict's
        // default-changed rule (a stream exists and the default is
        // requested), so query it only then: this runs on the command thread
        // with the mic lock held, and a sick HAL can make even this slow.
        let current_default_name = if self.stream.is_some() && device.is_none() {
            let queried_at = Instant::now();
            let name = cpal::default_host()
                .default_input_device()
                .and_then(|d| d.name().ok());
            let took = queried_at.elapsed();
            if took > Duration::from_millis(500) {
                crate::log_to_file(&format!(
                    "[MicCapture] default input device query took {}ms",
                    took.as_millis()
                ));
            }
            name
        } else {
            None
        };

        let verdict = reuse_verdict(
            self.stream.is_some(),
            device.map(|t| t.uid.as_str()),
            self.stream_target.as_ref().map(|t| t.uid.as_str()),
            self.stream_opened_name.as_deref(),
            current_default_name.as_deref(),
            self.stream_epoch,
            crate::power::epoch(),
        );

        // A reused stream's resampler still holds the tail of the previous
        // recording: reset it before this one's first frame. Set before the
        // stream is resumed; a freshly opened stream builds a new resampler
        // anyway.
        self.resampler_reset.store(true, Ordering::SeqCst);

        let reused = match verdict {
            // Reuse the persistent stream — resume it, then insist on proof of
            // life. This avoids cycling the CoreAudio device (which causes
            // sluggishness) whenever the stream is actually healthy.
            ReuseVerdict::Reuse => self.resume_persistent_stream(),
            ReuseVerdict::Reopen(reason) => {
                let msg = format!("[MicCapture] reopening mic stream: {}", reason);
                eprintln!("{}", msg);
                crate::log_to_file(&msg);
                false
            }
        };

        if !reused {
            // First start, different device, or a stale/dead persistent
            // stream — open a fresh one. The old stream is disposed OFF this
            // thread (drop_stream_async): tearing down a dead unit is what
            // used to hold the mic mutex for up to ~20s.
            self.retire_stream();
            self.open_stream(device)?;
        }

        // Set up the WAV writer for this recording, if it writes one.
        let to_file = output_path.is_some();
        if let Some(output_path) = output_path {
            self.start_wav_writer(&output_path)?;
        }

        self.capturing_to_file.store(to_file, Ordering::SeqCst);
        self.is_recording.store(true, Ordering::SeqCst);
        self.is_paused.store(false, Ordering::SeqCst);
        super::input_devices::poke();

        Ok(())
    }

    /// The silence watch starts over: no sound yet, counted from now.
    fn restart_sound_watch(&self) {
        self.last_sound_ms.store(0, Ordering::SeqCst);
        self.stream_opened_ms.store(frame_stamp(self.clock), Ordering::SeqCst);
    }

    /// start()'s WAV half: the writer and its thread.
    ///
    /// The stream is already running at this point (resumed or freshly
    /// opened), so a failure here — creating the file in the temp dir, which
    /// a full disk can refuse — must pause it again before bailing out:
    /// otherwise the failed start leaves the mic hot (orange indicator on,
    /// device held) with no recording to ever stop it. The paused stream
    /// stays eligible for the next start() exactly like after a normal stop().
    fn start_wav_writer(&mut self, output_path: &std::path::Path) -> Result<(), String> {
        let writer = match WavWriter::new(output_path, TARGET_SAMPLE_RATE, TARGET_CHANNELS) {
            Ok(writer) => writer,
            Err(e) => {
                if let Some(ref handle) = self.stream {
                    let _ = handle.stream.pause();
                }
                return Err(format!("Failed to create WAV writer: {}", e));
            }
        };
        *self.wav_writer.lock().unwrap() = Some(writer);

        // Spawn a new writer thread for this recording session
        let wav_writer_proc = Arc::clone(&self.wav_writer);
        let writer_is_recording = Arc::clone(&self.is_recording);
        let (tx, rx) = std::sync::mpsc::channel::<Vec<f32>>();

        let writer_handle = thread::spawn(move || {
            loop {
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(samples) => {
                        if let Ok(mut guard) = wav_writer_proc.lock() {
                            if let Some(ref mut writer) = *guard {
                                let _ = writer.write_samples(&samples);
                            }
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        if !writer_is_recording.load(Ordering::SeqCst) {
                            break;
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        break;
                    }
                }
            }
        });
        self.writer_thread = Some(writer_handle);

        // Store the tx in a shared slot so the persistent callback can use it.
        // The callback checks is_recording before sending.
        *self.wav_writer_tx.lock().unwrap() = Some(tx);
        Ok(())
    }

    /// start()'s reuse path: resume the paused persistent stream, then wait
    /// for proof of life. Returns true only once a frame has arrived; false
    /// means the caller must reopen — play() failed (its error used to be
    /// discarded), or the unit resumed but its IO proc never fired (the
    /// long-idle dead stream).
    ///
    /// got_first_frame was cleared at the top of start(), a paused AudioUnit
    /// runs no callbacks, and retired streams can't store it, so a `true` here
    /// can only come from THIS play().
    fn resume_persistent_stream(&self) -> bool {
        let Some(handle) = self.stream.as_ref() else {
            return false;
        };
        let msg = format!(
            "[MicCapture] Reusing persistent stream ({}Hz, {} ch)",
            self.stream_native_rate, self.stream_native_channels
        );
        eprintln!("{}", msg);
        crate::log_to_file(&msg);

        if let Err(e) = handle.stream.play() {
            let msg = format!(
                "[MicCapture] play() on the reused stream failed: {} — reopening",
                e
            );
            eprintln!("{}", msg);
            crate::log_to_file(&msg);
            return false;
        }

        let waiting_since = Instant::now();
        let budget = Duration::from_millis(REUSE_FIRST_FRAME_WAIT_MS);
        loop {
            // Checked before the deadline so a frame landing on the last poll
            // still counts.
            if self.got_first_frame.load(Ordering::SeqCst) {
                crate::log_to_file(&format!(
                    "[MicCapture] reused stream alive (first frame after {}ms)",
                    waiting_since.elapsed().as_millis()
                ));
                return true;
            }
            if waiting_since.elapsed() >= budget {
                let msg = format!(
                    "[MicCapture] reused stream produced no frames within {}ms — reopening",
                    REUSE_FIRST_FRAME_WAIT_MS
                );
                eprintln!("{}", msg);
                crate::log_to_file(&msg);
                return false;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    /// Take the current stream out of service — disposed off-thread by
    /// drop_stream_async — and forget what it was opened for, so a reopen that
    /// then fails leaves a coherent "no stream" state for the next start().
    fn retire_stream(&mut self) {
        if let Some(old) = self.stream.take() {
            drop_stream_async(old);
        }
        self.stream_target = None;
        self.stream_opened_name = None;
        *self.in_use.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// Open a new cpal stream for the given device.
    fn open_stream(&mut self, target: Option<&InputTarget>) -> Result<(), String> {
        // Epoch read BEFORE opening: a sleep that lands mid-open then marks
        // this stream stale (costing one extra reopen later) rather than
        // tagging a pre-sleep stream as post-sleep (a dead reuse).
        let epoch = crate::power::epoch();
        let host = cpal::default_host();

        let device = match target {
            Some(target) => find_input(&host, target)?,
            None => host.default_input_device().ok_or("No default input device available")?,
        };
        // What the input-device list shows as in use: the requested UID, or
        // for a default stream the UID of whatever the default is right now.
        let in_use_uid = match target {
            Some(t) => Some(t.uid.clone()),
            None => super::input_devices::uid_of(&device),
        };

        let default_config = device
            .default_input_config()
            .map_err(|e| format!("Failed to get default input config: {}", e))?;

        let native_sample_rate = default_config.sample_rate().0;
        let native_channels = default_config.channels();
        // The ACTUAL device, which for a default request is whatever the
        // system default is right now — what reuse_verdict compares against.
        let opened_name = device.name().ok();

        let msg = format!(
            "[MicCapture] Opening stream on \"{}\" (requested: {}): {}Hz, {} ch — will resample to {}Hz mono",
            opened_name.as_deref().unwrap_or("<unnamed>"),
            target.map_or("default", |t| t.name.as_str()),
            native_sample_rate,
            native_channels,
            TARGET_SAMPLE_RATE
        );
        eprintln!("{}", msg);
        crate::log_to_file(&msg);

        let config = StreamConfig {
            channels: native_channels,
            sample_rate: SampleRate(native_sample_rate),
            buffer_size: cpal::BufferSize::Default,
        };

        // A fresh stream has no liveness history of its own. Reset BEFORE
        // building: cpal starts the unit inside build_input_stream, so the
        // first callback can land before build even returns.
        self.last_frame_ms.store(0, Ordering::SeqCst);
        self.restart_sound_watch();

        let retired = Arc::new(AtomicBool::new(false));
        let error_retired = Arc::clone(&retired);
        let stream_faulted = Arc::clone(&self.stream_faulted);
        let mut callback = self.capture_callback(Arc::clone(&retired), native_sample_rate, native_channels)?;
        // Tell an installed raw tap that a new stream (maybe at a new rate)
        // starts here — before the build, since cpal starts the unit inside
        // build_input_stream. The retired stream's callback no longer pushes.
        self.raw_tap.begin_stream(native_sample_rate);
        self.stream_generation.fetch_add(1, Ordering::SeqCst);

        let stream = device
            .build_input_stream(
                &config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| callback.on_data(data),
                move |err| {
                    eprintln!("Audio input error: {}", err);
                    // A retired stream's errors belong to a device we already
                    // left: cpal keeps an enumerated device's disconnect
                    // listener alive after the stream is dropped (see
                    // drop_stream_async), so unplugging an OLD device must not
                    // flag a fault on the current stream.
                    if error_retired.load(Ordering::Relaxed) {
                        return;
                    }
                    // Flag the fault so a supervisor (off the audio thread) can
                    // drive recovery. Realtime-safe: just an atomic store. We do
                    // NOT touch the stream here — rebuilding from within a
                    // stream's own error callback is unsound.
                    stream_faulted.store(true, Ordering::SeqCst);
                },
                None,
            )
            .map_err(|e| format!("Failed to build input stream: {}", e))?;

        let handle = StreamHandle { stream, retired };
        if let Err(e) = handle.stream.play() {
            // cpal already started the unit inside build_input_stream, so a
            // stream we won't keep is retired like any other rather than
            // dropped here.
            drop_stream_async(handle);
            return Err(format!("Failed to start stream: {}", e));
        }

        // Clear the fault flag only once the (re)built stream is actually up.
        // Clearing before build/play would mean a FAILED rebuild leaves no
        // stream AND no fault: the session watchdog's latch silently resets
        // and recover_after_fault's contract ("on failure the flag stays set
        // so the supervisor can retry") breaks.
        self.stream_faulted.store(false, Ordering::SeqCst);

        self.stream = Some(handle);
        self.stream_target = target.cloned();
        *self.in_use.lock().unwrap_or_else(|p| p.into_inner()) =
            Some(InUse { uid: in_use_uid, name: opened_name.clone().unwrap_or_default() });
        self.stream_opened_name = opened_name;
        self.stream_epoch = epoch;
        self.stream_native_rate = native_sample_rate;
        self.stream_native_channels = native_channels;

        Ok(())
    }

    /// The per-stream capture callback, wired to this MicCapture's shared
    /// state. Allocates (resampler, scratch buffers): call off the audio
    /// thread, once per stream.
    fn capture_callback(
        &self,
        retired: Arc<AtomicBool>,
        native_rate: u32,
        native_channels: u16,
    ) -> Result<CaptureCallback, String> {
        // One resampler per stream, owned by the callback and run in place:
        // after construction process() never allocates or locks and costs two
        // small FFTs per 10 ms, microseconds against a ~10 ms callback
        // period. A new stream (reopen, device switch, fault recovery, a new
        // device rate) always starts from a fresh one.
        let resampler = StreamResampler::new(native_rate, TARGET_SAMPLE_RATE)?;
        let resampled = Vec::with_capacity(resampler.max_output_frames(2 * CALLBACK_PREALLOC_FRAMES));
        Ok(CaptureCallback {
            retired,
            is_recording: Arc::clone(&self.is_recording),
            is_paused: Arc::clone(&self.is_paused),
            got_first_frame: Arc::clone(&self.got_first_frame),
            last_frame_ms: Arc::clone(&self.last_frame_ms),
            last_sound_ms: Arc::clone(&self.last_sound_ms),
            clock: self.clock,
            level: Arc::clone(&self.level),
            wav_writer_tx: Arc::clone(&self.wav_writer_tx),
            sample_callback: Arc::clone(&self.sample_callback),
            raw_tap: Arc::clone(&self.raw_tap),
            resampler_reset: Arc::clone(&self.resampler_reset),
            native_channels,
            resampler,
            mono: Vec::with_capacity(CALLBACK_PREALLOC_FRAMES),
            resampled,
        })
    }

    pub fn stop(&mut self) -> Result<Option<PathBuf>, String> {
        self.is_recording.store(false, Ordering::SeqCst);
        self.capturing_to_file.store(false, Ordering::SeqCst);
        super::input_devices::poke();

        // Clear the writer channel so the callback stops sending data
        *self.wav_writer_tx.lock().unwrap() = None;

        // Wait for the writer thread to exit
        if let Some(handle) = self.writer_thread.take() {
            let _ = handle.join();
        }

        // Pause the cpal stream instead of dropping it.
        // This tells CoreAudio to suspend the audio unit, which removes the
        // macOS mic-in-use indicator. The stream stays alive so the next
        // recording can resume it with play() — avoiding the CoreAudio device
        // cycling that causes sluggishness on subsequent recordings.
        if let Some(ref handle) = self.stream {
            let _ = handle.stream.pause();
        }

        let path = if let Ok(mut guard) = self.wav_writer.lock() {
            if let Some(writer) = guard.take() {
                Some(
                    writer
                        .finalize()
                        .map_err(|e| format!("Failed to finalize WAV: {}", e))?,
                )
            } else {
                None
            }
        } else {
            None
        };

        Ok(path)
    }

    pub fn pause(&self) {
        self.is_paused.store(true, Ordering::SeqCst);
    }

    pub fn resume(&self) {
        self.is_paused.store(false, Ordering::SeqCst);
    }

    pub fn current_level(&self) -> f32 {
        *self.level.lock().unwrap()
    }

    pub fn is_recording(&self) -> bool {
        self.is_recording.load(Ordering::SeqCst)
    }

    /// A WAV-writing start (a meeting capture) is running.
    pub fn is_capturing_to_file(&self) -> bool {
        self.is_recording() && self.capturing_to_file.load(Ordering::SeqCst)
    }

    /// What the stream is open on, readable without the mic lock (see
    /// input_devices::InUseHandle).
    pub fn in_use_handle(&self) -> InUseHandle {
        InUseHandle {
            device: Arc::clone(&self.in_use),
            recording: Arc::clone(&self.is_recording),
            to_file: Arc::clone(&self.capturing_to_file),
            sound: super::input_devices::SoundHandle {
                clock: self.clock,
                last_frame_ms: Arc::clone(&self.last_frame_ms),
                last_sound_ms: Arc::clone(&self.last_sound_ms),
                stream_opened_ms: Arc::clone(&self.stream_opened_ms),
            },
        }
    }

    /// Changes around every live device switch; the session watchdog re-arms
    /// on a change (see switch_device).
    pub fn switch_epoch_handle(&self) -> Arc<AtomicU64> {
        Arc::clone(&self.switch_epoch)
    }

    /// An `Arc` handle to the stream-fault flag, so a supervisor thread can poll
    /// for a device fault without holding the MicCapture lock.
    pub fn fault_handle(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.stream_faulted)
    }

    /// An `Arc` handle to the first-frame flag, so the first-frame watchdog can
    /// poll whether the IO proc has fired without holding the MicCapture lock.
    /// False until the data callback runs once; `start()` re-arms it (stores
    /// false) at the top of every recording.
    pub fn first_frame_handle(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.got_first_frame)
    }

    /// An `Arc` handle to the pause flag, so the first-frame watchdog can avoid
    /// false-firing while a recording is paused (pause silences the mic data
    /// callback, so no frames flow — that is expected, not a dead device).
    pub fn paused_handle(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.is_paused)
    }

    /// The (clock, last_frame_ms) pair, so the session's stall watchdog can
    /// compute frame_age() without holding the MicCapture lock. The clock is
    /// fixed for this MicCapture's lifetime; last_frame_ms tracks whichever
    /// stream is current (0 until it delivers its first frame).
    pub fn frame_age_handle(&self) -> (Instant, Arc<AtomicU64>) {
        (self.clock, Arc::clone(&self.last_frame_ms))
    }

    /// Rebuild the input stream after a fault (e.g. a disconnected mic) on
    /// `target`: what input_devices::resolve_for_recovery picks now (None =
    /// the system default), so a vanished device, or a listed one that
    /// faults again right after being reopened, is passed over. If
    /// the target won't open either, the default is tried. Called from a
    /// supervisor on a normal thread — never from the cpal error callback.
    /// No-op if there is no active fault. On success the fault flag is
    /// cleared (open_stream clears it); on failure the flag stays set so the
    /// supervisor can retry.
    pub fn recover_after_fault(&mut self, target: Option<&InputTarget>) -> Result<(), String> {
        self.recover_onto(target, false)
    }

    /// [`Self::recover_after_fault`] for a voice session: when `target` won't
    /// open, the default is tried only if it isn't the MacBook mic with the
    /// lid closed (it would open and hear exact zeros); otherwise the
    /// recovery fails, the fault stays, and the session ends. A meeting
    /// capture keeps the plain fallback (it never refuses for want of a mic).
    pub fn recover_after_fault_avoiding_dead_default(&mut self, target: Option<&InputTarget>) -> Result<(), String> {
        self.recover_onto(target, true)
    }

    fn recover_onto(&mut self, target: Option<&InputTarget>, avoid_dead_default: bool) -> Result<(), String> {
        if !self.stream_faulted.load(Ordering::SeqCst) {
            return Ok(());
        }
        crate::log_to_file(&format!(
            "[MicCapture] recovering from stream fault — reopening {}",
            target.map_or_else(|| "the default device".to_string(), |t| format!("{:?}", t.name))
        ));
        // Re-arm the first-frame watchdog for the rebuilt stream. Cleared BEFORE
        // open_stream so (a) a stale `true` from the pre-fault stream can't mask
        // a recovery that ALSO comes up dead, and (b) the fresh callback's
        // store(true) reflects only the rebuilt device. If recovery also fails
        // to produce a first frame, the watchdog re-fires after another timeout;
        // the WebView side caps recover_mic attempts so this cannot hot-loop.
        self.got_first_frame.store(false, Ordering::SeqCst);
        // Retire the faulted stream before building a new one, disposing of it
        // OFF this thread: on a dead device the teardown can block for many
        // seconds, and recover_mic runs on the main thread with the mic lock
        // held. Retiring also silences it, should the device come back.
        self.retire_stream();
        let mut result = self.open_stream(target);
        if let (Err(e), Some(t)) = (&result, target) {
            if falls_back_to_default(avoid_dead_default, super::input_devices::default_unavailable) {
                crate::log_to_file(&format!("[MicCapture] recovery on {:?} failed ({e}); trying the default", t.name));
                result = self.open_stream(None);
            } else {
                crate::log_to_file(&format!(
                    "[MicCapture] recovery on {:?} failed ({e}); not trying the default (the MacBook mic, lid closed)",
                    t.name
                ));
                result = Err(format!("{e}; the default is the MacBook microphone and the lid is closed"));
            }
        }
        super::input_devices::poke();
        result
    }

    /// Move a running capture to another device without stopping it: the
    /// WAV writer, sample callback, raw tap and recording flags carry on;
    /// only the cpal stream is replaced (recover_after_fault without the
    /// fault guard). If `target` won't open, the previous device is reopened
    /// and an Err says so; if that fails too, the fault flag is raised so
    /// the usual recovery takes over.
    pub fn switch_device(&mut self, target: Option<&InputTarget>) -> Result<(), String> {
        if !self.is_recording() {
            return Err("no capture is running".into());
        }
        let previous = self.stream_target.clone();
        crate::log_to_file(&format!(
            "[MicCapture] switching the live stream to {}",
            target.map_or_else(|| "the default device".to_string(), |t| format!("{:?}", t.name))
        ));
        // Bumped before (so the watchdog re-arms for the open, which can take
        // a Bluetooth headset a second or two) and after (a full first-frame
        // timeout from the moment the new stream is up).
        self.switch_epoch.fetch_add(1, Ordering::SeqCst);
        self.got_first_frame.store(false, Ordering::SeqCst);
        self.retire_stream();
        let result = match self.open_stream(target) {
            Ok(()) => Ok(()),
            Err(e) => match self.open_stream(previous.as_ref()) {
                Ok(()) => Err(format!("{e} (stayed on the previous mic)")),
                Err(e2) => {
                    self.stream_faulted.store(true, Ordering::SeqCst);
                    Err(format!("{e}; reopening the previous mic failed too ({e2}) — flagged a fault"))
                }
            },
        };
        self.switch_epoch.fetch_add(1, Ordering::SeqCst);
        super::input_devices::poke();
        result
    }

    /// Install a raw mic tap: every captured frame, downmixed to mono f32 at
    /// the device rate and before any resampling, is pushed into `writer`'s
    /// ring from the capture callback while the mic is capturing (between
    /// start and stop, and not paused). Returns the tap it replaces, if any,
    /// for the caller to drop.
    ///
    /// The ring is lock-free and drops on overflow; the callback never waits
    /// or allocates for it (audio::tap). The tap survives stream reopens
    /// (device switch, fault recovery): each new stream announces its rate
    /// through [`TapReader::rate`](super::tap::TapReader::rate) and bumps
    /// [`TapReader::epoch`](super::tap::TapReader::epoch), and the reader
    /// should clear and rebuild on an epoch change. If a stream is already
    /// open, its rate is announced at once; otherwise at the next start().
    pub fn install_raw_tap(&self, writer: TapWriter) -> Option<TapWriter> {
        if self.stream.is_some() && self.stream_native_rate > 0 {
            writer.begin_stream(self.stream_native_rate);
        }
        self.raw_tap.replace(Some(writer))
    }

    /// Remove the raw mic tap, returning it for the caller to drop (off the
    /// audio thread by construction).
    pub fn remove_raw_tap(&self) -> Option<TapWriter> {
        self.raw_tap.replace(None)
    }

    /// The current stream's device sample rate (what the raw tap carries),
    /// or None before any stream has been opened.
    pub fn device_rate(&self) -> Option<u32> {
        (self.stream.is_some() && self.stream_native_rate > 0).then_some(self.stream_native_rate)
    }

    /// Get an Arc handle to the current audio level, for reading from other threads.
    pub fn level_handle(&self) -> Arc<Mutex<f32>> {
        Arc::clone(&self.level)
    }

    /// Which cpal stream is current: changes whenever a new one is opened
    /// (device switch, fault recovery). Read it from the sample callback to
    /// tell which stream a chunk came from.
    pub fn stream_generation_handle(&self) -> Arc<AtomicU64> {
        Arc::clone(&self.stream_generation)
    }

    /// Get an Arc handle to the WAV writer, for segment splitting from other threads.
    pub fn writer_handle(&self) -> Arc<Mutex<Option<WavWriter>>> {
        Arc::clone(&self.wav_writer)
    }

    /// Set a callback to observe audio samples as they arrive.
    /// Used by RecordingSession for PCM streaming to the frontend.
    pub fn set_sample_callback(&self, cb: Option<Box<dyn Fn(&[f32]) + Send>>) {
        *self.sample_callback.lock().unwrap() = cb;
    }

    /// Atomically swap the WAV writer to a new file path.
    /// Finalizes the current file and returns its path.
    /// The audio stream continues uninterrupted — only the output file changes.
    pub fn swap_writer(&self, new_path: PathBuf) -> Result<Option<PathBuf>, String> {
        let mut guard = self.wav_writer.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        let old_path = if let Some(writer) = guard.take() {
            Some(writer.finalize().map_err(|e| format!("Failed to finalize WAV: {}", e))?)
        } else {
            None
        };
        let new_writer = WavWriter::new(&new_path, TARGET_SAMPLE_RATE, TARGET_CHANNELS)
            .map_err(|e| format!("Failed to create new WAV writer: {}", e))?;
        *guard = Some(new_writer);
        Ok(old_path)
    }
}

/// What one stream's cpal data callback does, as a struct so it can be driven
/// by synthetic buffers in tests. Everything shared is an Arc into the
/// MicCapture; the resampler and scratch buffers are the stream's own.
///
/// Realtime rules for [`on_data`](Self::on_data), which runs on the CoreAudio
/// IO thread: atomics, the lock-free raw tap, the in-place resampler, and the
/// same try_lock / channel send / sample-callback hand-offs as before this
/// struct existed. It allocates only what the old per-callback code already
/// did (the WAV channel's Vec, and whatever the installed sample callback
/// does) — the downmix and resample buffers are reused.
struct CaptureCallback {
    retired: Arc<AtomicBool>,
    is_recording: Arc<AtomicBool>,
    is_paused: Arc<AtomicBool>,
    got_first_frame: Arc<AtomicBool>,
    last_frame_ms: Arc<AtomicU64>,
    last_sound_ms: Arc<AtomicU64>,
    clock: Instant,
    level: Arc<Mutex<f32>>,
    wav_writer_tx: Arc<Mutex<Option<std::sync::mpsc::Sender<Vec<f32>>>>>,
    sample_callback: SampleCallback,
    raw_tap: Arc<TapSlot>,
    resampler_reset: Arc<AtomicBool>,
    native_channels: u16,
    resampler: StreamResampler,
    mono: Vec<f32>,
    resampled: Vec<f32>,
}

impl CaptureCallback {
    fn on_data(&mut self, data: &[f32]) {
        // A retired stream (being replaced — see drop_stream_async) must not
        // touch shared state the replacement now owns: its frames would fake
        // proof of life, and its samples would interleave with the new
        // stream's in the WAV and PCM feed. One Relaxed load; realtime-safe.
        if self.retired.load(Ordering::Relaxed) {
            return;
        }

        // Proof-of-life for the first-frame watchdog: the IO proc fired, so
        // the device is alive. Set BEFORE the recording / pause gate — a
        // live-but-paused stream is still a live device, and the watchdog
        // gates on !paused separately. Unconditional Relaxed store is the
        // cheapest realtime-safe form (single word, no ordering needed vs.
        // the watchdog's Relaxed load; a repeated store every callback is
        // free).
        self.got_first_frame.store(true, Ordering::Relaxed);
        // Liveness timestamp for the mid-recording stall watchdog, also
        // before the gate (a paused recording's device is still expected to
        // deliver). Instant::elapsed reads the monotonic clock without a
        // syscall or lock — realtime-safe.
        let stamp = frame_stamp(self.clock);
        self.last_frame_ms.store(stamp, Ordering::Relaxed);
        // Digital silence (input_devices::SilenceWatch): a live ADC never
        // reads exactly 0.0, so any non-zero sample is sound. Also before
        // the gate; once the stream has made a sound nothing is scanned, and
        // the scan stops at the first non-zero sample.
        if self.last_sound_ms.load(Ordering::Relaxed) == 0 && has_sound(data) {
            self.last_sound_ms.store(stamp, Ordering::Relaxed);
        }

        if !self.is_recording.load(Ordering::SeqCst) || self.is_paused.load(Ordering::SeqCst) {
            return;
        }

        // Mono at the device rate, into a buffer reused across callbacks (no
        // allocation once it has grown to the device's callback size).
        downmix_into(data, self.native_channels, &mut self.mono);

        // Raw tap for the voice session's echo canceller: the mic before any
        // resampling. Lock-free: a relaxed load when none is installed, else
        // one CAS and a ring push that drops on a full ring (audio::tap).
        if let Some(mut tap) = self.raw_tap.acquire() {
            tap.push_slice(&self.mono);
        }

        // To TARGET_SAMPLE_RATE, anti-aliased and continuous across callbacks
        // (audio::resample). A new recording on a reused stream starts from a
        // clean filter.
        if self.resampler_reset.load(Ordering::Relaxed) {
            self.resampler_reset.store(false, Ordering::Relaxed);
            self.resampler.reset();
        }
        self.resampled.clear();
        self.resampler.process(&self.mono, &mut self.resampled);
        // Output comes in whole 10 ms chunks, so a callback shorter than one
        // chunk can yield nothing yet.
        if self.resampled.is_empty() {
            return;
        }
        let resampled = &self.resampled;

        // Calculate RMS level
        let sum_sq: f32 = resampled.iter().map(|s| s * s).sum();
        let rms = (sum_sq / resampled.len() as f32).sqrt();
        if let Ok(mut lvl) = self.level.try_lock() {
            *lvl = rms;
        }

        // Send to WAV writer thread via the current session's channel (none
        // for a WAV-less start).
        if let Ok(guard) = self.wav_writer_tx.try_lock() {
            if let Some(ref tx) = *guard {
                let _ = tx.send(resampled.clone());
            }
        }

        // Call sample observer for PCM streaming to frontend
        if let Ok(guard) = self.sample_callback.try_lock() {
            if let Some(ref cb) = *guard {
                cb(resampled);
            }
        }
    }
}

/// start()'s decision about the paused persistent stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReuseVerdict {
    /// Same device, same sleep/wake epoch: resume it (and still verify it).
    Reuse,
    /// Open a fresh stream; the reason is logged.
    Reopen(&'static str),
}

/// Pure reuse decision for start(), extracted so each rule is unit-testable
/// without cpal. Rules, in order:
/// 1. no stream → nothing to reuse;
/// 2. a different device requested than the stream was opened for;
/// 3. the system slept since the stream was opened (crate::power epoch) — a
///    unit paused across a sleep comes back "playable" but dead;
/// 4. the default is requested and the current system default (when it could
///    be queried) is not the device the stream actually opened — cpal binds
///    the concrete device, so reuse would keep recording the old one. An
///    unknown opened name counts as a mismatch: we can't prove it's the same.
/// Otherwise reuse — start() still demands a first frame before trusting it.
pub(crate) fn reuse_verdict(
    has_stream: bool,
    requested: Option<&str>,
    opened_requested: Option<&str>,
    opened_actual_name: Option<&str>,
    current_default_name: Option<&str>,
    stream_epoch: u64,
    current_epoch: u64,
) -> ReuseVerdict {
    if !has_stream {
        return ReuseVerdict::Reopen("no stream");
    }
    if requested != opened_requested {
        return ReuseVerdict::Reopen("different device requested");
    }
    if stream_epoch != current_epoch {
        return ReuseVerdict::Reopen("system slept since the stream was opened");
    }
    if requested.is_none() {
        if let Some(current_default) = current_default_name {
            if Some(current_default) != opened_actual_name {
                return ReuseVerdict::Reopen("default input device changed");
            }
        }
    }
    ReuseVerdict::Reuse
}

/// last_frame_ms encoding: `clock.elapsed()` in ms, + 1 so 0 can mean "no
/// frame yet". Called from the realtime data callback — a monotonic clock
/// read and arithmetic, nothing that can block.
#[inline]
fn frame_stamp(clock: Instant) -> u64 {
    clock.elapsed().as_millis() as u64 + 1
}

/// A recovery whose target failed may try the system default: always for a
/// meeting capture, and for a voice session (`avoid_dead_default`) only when
/// the default isn't one the lid made unavailable (`default_dead`, asked only
/// then: it reads CoreAudio).
fn falls_back_to_default(avoid_dead_default: bool, default_dead: impl FnOnce() -> bool) -> bool {
    !avoid_dead_default || !default_dead()
}

/// Any sample that isn't exactly zero (NaN counts: it isn't silence either).
#[inline]
fn has_sound(data: &[f32]) -> bool {
    data.iter().any(|&s| s != 0.0)
}

/// How long ago the current stream's newest frame arrived, from the
/// (clock, last_frame_ms) pair of MicCapture::frame_age_handle(). None when
/// the stream has delivered no frame yet (last_frame_ms == 0). Saturates at
/// zero rather than underflowing if a callback stamps between the caller's
/// load and this read.
pub(crate) fn frame_age(clock: Instant, last_frame_ms: u64) -> Option<Duration> {
    if last_frame_ms == 0 {
        return None;
    }
    Some(Duration::from_millis(
        frame_stamp(clock).saturating_sub(last_frame_ms),
    ))
}

/// The present input device a target names: by name (cpal's only open key),
/// and by AudioObjectID among several with that name.
fn find_input(host: &cpal::Host, target: &InputTarget) -> Result<cpal::Device, String> {
    let mut named: Vec<cpal::Device> = host
        .input_devices()
        .map_err(|e| format!("Failed to enumerate devices: {}", e))?
        .filter(|d| d.name().ok().as_deref() == Some(target.name.as_str()))
        .collect();
    if named.is_empty() {
        return Err(format!("Device '{}' not found", target.name));
    }
    if let Some(id) = target.object_id {
        if let Some(i) = named.iter().position(|d| super::input_devices::cpal_object_id(d) == Some(id)) {
            return Ok(named.swap_remove(i));
        }
        crate::log_to_file(&format!(
            "[MicCapture] no {:?} with AudioObjectID {id}; opening the first of that name",
            target.name
        ));
    }
    Ok(named.swap_remove(0))
}

/// Retire a stream and dispose of it OFF the calling thread.
///
/// Why off-thread: tearing down a CoreAudio unit whose device has gone dead
/// can block for many seconds (prod logs: 8–21s between "mic produced no
/// frames" and the rebuild's "Opening stream"), and every caller holds the mic
/// mutex — on the main thread, for start_recording and recover_mic. The dead
/// unit's IO proc isn't delivering, so nothing is lost by finishing the
/// teardown in the background.
///
/// Why `retired` is set first, synchronously: until its stop completes the old
/// unit can still fire callbacks, and a "dead" device can come back (a
/// headset switching back). Those callbacks feed the same sinks as the
/// replacement stream — frame proof-of-life, level, WAV channel, PCM callback,
/// fault flag — so the flag makes them no-ops from this instant on.
///
/// Why pause() before the drop: cpal 0.15 on macOS gives a stream on an
/// enumerated (non-default) device a disconnect listener that holds a clone of
/// the stream's own Arc — a reference cycle, so dropping such a stream never
/// stops or disposes its AudioUnit. The explicit pause() stops it regardless
/// (for default-device streams, where drop() already stops the unit, it is a
/// harmless repeat).
fn drop_stream_async(handle: StreamHandle) {
    handle.retired.store(true, Ordering::SeqCst);
    let spawned = thread::Builder::new()
        .name("mic-stream-dispose".into())
        .spawn(move || {
            let started = Instant::now();
            let paused = handle.stream.pause();
            drop(handle);
            crate::log_to_file(&format!(
                "[MicCapture] retired mic stream stopped and released in {}ms{}",
                started.elapsed().as_millis(),
                match paused {
                    Ok(()) => String::new(),
                    Err(e) => format!(" (pause failed: {})", e),
                }
            ));
        });
    if let Err(e) = spawned {
        // spawn() consumed the closure, so the stream was dropped right here —
        // the old synchronous behaviour — but it is already retired (inert).
        crate::log_to_file(&format!(
            "[MicCapture] could not spawn the stream-dispose thread ({}) — stream dropped inline",
            e
        ));
    }
}

/// Downmix interleaved multi-channel audio to mono by averaging channels,
/// into `out` (cleared first). Allocation-free once `out` has room.
fn downmix_into(data: &[f32], channels: u16, out: &mut Vec<f32>) {
    out.clear();
    if channels <= 1 {
        out.extend_from_slice(data);
        return;
    }
    let ch = channels as usize;
    out.extend(data.chunks_exact(ch).map(|frame| frame.iter().sum::<f32>() / ch as f32));
}

#[cfg(test)]
mod tests {
    use super::*;

    // reuse_verdict(has_stream, requested, opened_requested, opened_actual_name,
    //               current_default_name, stream_epoch, current_epoch)

    const BUILT_IN: &str = "MacBook Pro Microphone";
    const AIRPODS: &str = "AirPods Pro";
    const USB: &str = "USB Audio Device";

    #[test]
    fn a_voice_recovery_never_falls_back_onto_a_dead_default() {
        // A meeting capture: always, without even asking.
        assert!(falls_back_to_default(false, || panic!("not asked")));
        // A voice session: only onto a default that can hear.
        assert!(falls_back_to_default(true, || false));
        assert!(!falls_back_to_default(true, || true));
    }

    #[test]
    fn only_exact_zeros_are_silence() {
        assert!(!has_sound(&[0.0; 512]));
        assert!(!has_sound(&[]));
        assert!(has_sound(&[0.0, 0.0, 0.000_3, 0.0]));
        assert!(has_sound(&[-1e-9]));
    }

    #[test]
    fn reopens_when_there_is_no_stream() {
        assert_eq!(
            reuse_verdict(false, None, None, None, None, 0, 0),
            ReuseVerdict::Reopen("no stream")
        );
        // Rule 1 wins even when everything else would say "reuse".
        assert_eq!(
            reuse_verdict(false, None, None, Some(BUILT_IN), Some(BUILT_IN), 3, 3),
            ReuseVerdict::Reopen("no stream")
        );
    }

    #[test]
    fn reopens_when_a_different_device_is_requested() {
        const WHY: ReuseVerdict = ReuseVerdict::Reopen("different device requested");
        // named → another named
        assert_eq!(reuse_verdict(true, Some(USB), Some(AIRPODS), Some(AIRPODS), None, 0, 0), WHY);
        // default → named (even if the named one IS the current default)
        assert_eq!(reuse_verdict(true, Some(BUILT_IN), None, Some(BUILT_IN), None, 0, 0), WHY);
        // named → default
        assert_eq!(
            reuse_verdict(true, None, Some(USB), Some(USB), Some(USB), 0, 0),
            WHY
        );
        // Checked before the epoch rule.
        assert_eq!(reuse_verdict(true, Some(USB), Some(AIRPODS), Some(AIRPODS), None, 0, 9), WHY);
    }

    #[test]
    fn reopens_after_the_system_slept() {
        const WHY: ReuseVerdict = ReuseVerdict::Reopen("system slept since the stream was opened");
        // Default device, same default — still stale after a sleep/wake.
        assert_eq!(
            reuse_verdict(true, None, None, Some(BUILT_IN), Some(BUILT_IN), 0, 2),
            WHY
        );
        // Named devices are not exempt.
        assert_eq!(reuse_verdict(true, Some(USB), Some(USB), Some(USB), None, 4, 5), WHY);
        // Checked before the default-changed rule.
        assert_eq!(
            reuse_verdict(true, None, None, Some(BUILT_IN), Some(AIRPODS), 0, 1),
            WHY
        );
    }

    #[test]
    fn reopens_when_the_default_input_changed() {
        assert_eq!(
            reuse_verdict(true, None, None, Some(BUILT_IN), Some(AIRPODS), 7, 7),
            ReuseVerdict::Reopen("default input device changed")
        );
        // The opened device's name was unknown: can't prove it's the same one.
        assert_eq!(
            reuse_verdict(true, None, None, None, Some(BUILT_IN), 7, 7),
            ReuseVerdict::Reopen("default input device changed")
        );
    }

    #[test]
    fn reuses_the_same_device_in_the_same_epoch() {
        assert_eq!(
            reuse_verdict(true, None, None, Some(BUILT_IN), Some(BUILT_IN), 7, 7),
            ReuseVerdict::Reuse
        );
        assert_eq!(
            reuse_verdict(true, Some(USB), Some(USB), Some(USB), None, 7, 7),
            ReuseVerdict::Reuse
        );
    }

    #[test]
    fn a_failed_default_query_does_not_force_a_reopen() {
        // Nothing to compare against — the play() + first-frame proof decides.
        assert_eq!(
            reuse_verdict(true, None, None, Some(BUILT_IN), None, 0, 0),
            ReuseVerdict::Reuse
        );
    }

    #[test]
    fn a_named_request_ignores_default_changes() {
        // Rule 4 is about "the default" only; a named device is pinned.
        assert_eq!(
            reuse_verdict(true, Some(USB), Some(USB), Some(USB), Some(AIRPODS), 0, 0),
            ReuseVerdict::Reuse
        );
    }

    #[test]
    fn frame_age_is_none_before_any_frame() {
        assert_eq!(frame_age(Instant::now(), 0), None);
    }

    #[test]
    fn frame_age_measures_time_since_the_newest_frame() {
        let clock = Instant::now()
            .checked_sub(Duration::from_secs(10))
            .expect("machine uptime > 10s");
        // A frame stamped 2s after the clock origin (encoded +1ms).
        let age = frame_age(clock, 2_000 + 1).expect("a frame was stamped");
        assert!(
            age >= Duration::from_secs(8) && age < Duration::from_secs(9),
            "age {:?}",
            age
        );
    }

    #[test]
    fn a_fresh_stamp_reads_as_a_fresh_frame() {
        // The callback's encoding and frame_age's decoding must agree.
        let clock = Instant::now()
            .checked_sub(Duration::from_secs(60))
            .expect("machine uptime > 60s");
        let age = frame_age(clock, frame_stamp(clock)).expect("a frame was stamped");
        assert!(age < Duration::from_secs(1), "age {:?}", age);
    }

    #[test]
    fn frame_age_saturates_instead_of_underflowing() {
        assert_eq!(frame_age(Instant::now(), u64::MAX), Some(Duration::ZERO));
    }

    // ── the capture callback, driven by synthetic buffers (no device) ──────

    use crate::audio::tap::tap_channel;
    use std::sync::mpsc::Receiver;

    /// A MicCapture "recording" with a WAV channel and a sample callback, and
    /// the per-stream callback for a `rate` Hz, `channels`-channel device.
    struct Rig {
        mic: MicCapture,
        cb: CaptureCallback,
        wav: Receiver<Vec<f32>>,
        observed: Arc<Mutex<Vec<f32>>>,
        retired: Arc<AtomicBool>,
    }

    fn rig(rate: u32, channels: u16) -> Rig {
        let mic = MicCapture::new();
        let retired = Arc::new(AtomicBool::new(false));
        let cb = mic.capture_callback(Arc::clone(&retired), rate, channels).unwrap();
        let (tx, wav) = std::sync::mpsc::channel();
        *mic.wav_writer_tx.lock().unwrap() = Some(tx);
        let observed = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&observed);
        mic.set_sample_callback(Some(Box::new(move |s: &[f32]| sink.lock().unwrap().extend_from_slice(s))));
        mic.is_recording.store(true, Ordering::SeqCst);
        Rig { mic, cb, wav, observed, retired }
    }

    impl Rig {
        /// Feed interleaved `input` in callbacks cycling through `sizes`
        /// (frames per callback).
        fn feed(&mut self, input: &[f32], channels: usize, sizes: &[usize]) {
            let mut at = 0;
            let mut k = 0;
            while at < input.len() {
                let n = (sizes[k % sizes.len()] * channels).min(input.len() - at);
                self.cb.on_data(&input[at..at + n]);
                at += n;
                k += 1;
            }
        }

        fn wav_samples(&self) -> Vec<f32> {
            self.wav.try_iter().flatten().collect()
        }
    }

    fn stereo_tone(rate: u32, freq: f32, secs: f32) -> Vec<f32> {
        let frames = (rate as f32 * secs) as usize;
        (0..frames)
            .flat_map(|i| {
                let v = 0.5 * (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin();
                [v, v]
            })
            .collect()
    }

    #[test]
    fn capture_delivers_every_16k_sample_over_minutes_of_512_frame_callbacks() {
        // The old per-callback resampler emitted 170 of the 170.67 samples
        // due per 512-frame callback at 48 kHz: 1.2 s short after five
        // minutes, 14 s after an hour. (Two minutes here: unoptimized test
        // build; the loss is linear: 7,500 samples by then.)
        let mut r = rig(48_000, 1);
        let block = vec![0.001f32; 512];
        let blocks = 48_000usize * 120 / 512;
        let mut total = 0usize;
        for _ in 0..blocks {
            r.cb.on_data(&block);
            total += r.wav.try_iter().map(|v| v.len()).sum::<usize>();
        }
        let due = blocks * 512 / 3;
        assert!(due - total <= r.cb.resampler.latency_frames(), "{total} of {due}");
    }

    #[test]
    fn wav_sample_callback_and_level_all_get_the_same_continuous_16k_audio() {
        let mut r = rig(48_000, 2);
        r.feed(&stereo_tone(48_000, 440.0, 3.0), 2, &[512, 480, 1024, 441, 100]);
        let wav = r.wav_samples();
        let observed = r.observed.lock().unwrap().clone();
        assert_eq!(wav, observed, "the WAV and the STT/PCM feed see identical samples");
        assert!(48_000 - wav.len() <= r.cb.resampler.latency_frames(), "{} samples for 3 s", wav.len());
        // The tone survives, at its pitch and level.
        let mid = &wav[wav.len() / 4..wav.len() * 3 / 4];
        let crossings = mid.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count();
        let f = crossings as f32 * 16_000.0 / mid.len() as f32;
        assert!((f - 440.0).abs() < 5.0, "{f} Hz");
        let level = r.mic.current_level();
        assert!((level - 0.5 / 2f32.sqrt()).abs() < 0.05, "level {level}");
        assert!(r.mic.got_first_frame.load(Ordering::SeqCst));
        assert!(r.mic.last_frame_ms.load(Ordering::SeqCst) > 0);
    }

    #[test]
    fn no_wav_channel_still_feeds_the_sample_callback() {
        // A WAV-less start (voice session): no writer channel is installed.
        let mut r = rig(44_100, 1);
        *r.mic.wav_writer_tx.lock().unwrap() = None;
        r.feed(&vec![0.2; 44_100], 1, &[512]);
        assert!(r.wav_samples().is_empty());
        let n = r.observed.lock().unwrap().len();
        assert!(16_000 - n <= r.cb.resampler.latency_frames(), "{n}");
    }

    #[test]
    fn raw_tap_gets_mono_at_the_device_rate_before_resampling() {
        let mut r = rig(44_100, 2);
        let (w, mut tap) = tap_channel(1 << 16);
        assert!(r.mic.install_raw_tap(w).is_none());
        // No stream is open in a test; open_stream would announce the rate.
        r.mic.raw_tap.begin_stream(44_100);
        assert_eq!(tap.rate(), 44_100);
        let frames = 1_000;
        let input: Vec<f32> = (0..frames).flat_map(|_| [0.2f32, 0.4]).collect();
        r.feed(&input, 2, &[300]);
        let mut got = vec![0.0; tap.available()];
        tap.pop_slice(&mut got);
        assert_eq!(got.len(), frames, "every device frame, not 16 kHz");
        assert!(got.iter().all(|&v| (v - 0.3).abs() < 1e-6), "downmixed to mono, untouched");

        assert!(r.mic.remove_raw_tap().is_some());
        r.feed(&input, 2, &[300]);
        assert_eq!(tap.available(), 0, "nothing after removal");
    }

    #[test]
    fn pause_gates_audio_but_not_liveness() {
        let mut r = rig(48_000, 1);
        let (w, tap) = tap_channel(1 << 16);
        r.mic.install_raw_tap(w);
        r.mic.pause();
        r.feed(&vec![0.3; 48_000], 1, &[512]);
        assert!(r.wav_samples().is_empty() && r.observed.lock().unwrap().is_empty());
        assert_eq!(tap.available(), 0);
        assert!(r.mic.got_first_frame.load(Ordering::SeqCst), "a paused device is still alive");
        assert!(r.mic.last_frame_ms.load(Ordering::SeqCst) > 0);
        r.mic.resume();
        r.feed(&vec![0.3; 4_800], 1, &[512]);
        assert!(!r.wav_samples().is_empty());
    }

    #[test]
    fn not_recording_only_proves_life() {
        let mut r = rig(48_000, 1);
        r.mic.is_recording.store(false, Ordering::SeqCst);
        r.feed(&vec![0.3; 4_800], 1, &[512]);
        assert!(r.wav_samples().is_empty());
        assert!(r.mic.got_first_frame.load(Ordering::SeqCst));
    }

    #[test]
    fn a_retired_stream_touches_nothing() {
        let mut r = rig(48_000, 1);
        let (w, tap) = tap_channel(1 << 16);
        r.mic.install_raw_tap(w);
        r.retired.store(true, Ordering::SeqCst);
        r.feed(&vec![0.3; 4_800], 1, &[512]);
        assert!(r.wav_samples().is_empty() && r.observed.lock().unwrap().is_empty());
        assert_eq!(tap.available(), 0);
        assert!(!r.mic.got_first_frame.load(Ordering::SeqCst), "no fake proof of life");
        assert_eq!(r.mic.last_frame_ms.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_new_recording_on_a_reused_stream_starts_from_a_clean_filter() {
        let tone = stereo_tone(48_000, 1_000.0, 0.5);
        let mut fresh = rig(48_000, 2);
        fresh.feed(&tone, 2, &[512]);
        let want = fresh.wav_samples();

        let mut reused = rig(48_000, 2);
        reused.feed(&vec![0.9; 2 * 1_234], 2, &[512]); // the last recording's tail
        reused.wav_samples();
        reused.mic.resampler_reset.store(true, Ordering::SeqCst); // what start() does
        reused.feed(&tone, 2, &[512]);
        assert_eq!(reused.wav_samples(), want);
        assert!(!reused.mic.resampler_reset.load(Ordering::SeqCst), "consumed by the first recorded callback");
    }

    #[test]
    fn scratch_buffers_do_not_grow_for_normal_callbacks() {
        let mut r = rig(96_000, 2);
        let block = vec![0.1f32; 2 * 4096];
        r.cb.on_data(&block);
        let (mono, out) = ((r.cb.mono.capacity(), r.cb.mono.as_ptr()), (r.cb.resampled.capacity(), r.cb.resampled.as_ptr()));
        for _ in 0..200 {
            r.cb.on_data(&block);
        }
        assert_eq!((r.cb.mono.capacity(), r.cb.mono.as_ptr()), mono);
        assert_eq!((r.cb.resampled.capacity(), r.cb.resampled.as_ptr()), out);
    }

    #[test]
    fn downmix_averages_channels() {
        let mut out = Vec::new();
        downmix_into(&[0.2, 0.4, -1.0, 1.0, 0.5, 0.5], 2, &mut out);
        let want = [0.3f32, 0.0, 0.5];
        assert_eq!(out.len(), 3);
        assert!(out.iter().zip(want).all(|(a, b)| (a - b).abs() < 1e-6), "{out:?}");
        downmix_into(&[0.1, 0.2], 1, &mut out);
        assert_eq!(out, vec![0.1, 0.2]);
    }
}
