/// Recording session orchestrator — captures mic + system audio, writes WAV files,
/// and streams raw PCM (16-bit linear16) to the frontend via Tauri events for
/// real-time Deepgram transcription.
///
/// The frontend handles all Deepgram WebSocket communication. The backend's job
/// is to capture audio, write WAV files for archival, and forward PCM chunks.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;

use tauri::{AppHandle, Emitter};

use super::aec::{self, AecTuning};
use super::capture_aec::{AecFeed, CaptureAecWorker, CleanedSink, WorkerConfig};
use super::mic_capture::{frame_age, MicCapture};
use crate::modules::stt::{SttSink, STREAM_MIC, STREAM_SYSTEM};
use super::system_capture::SystemCapture;
use super::types::*;

fn slog(msg: &str) {
    eprintln!("{}", msg);
    crate::log_to_file(msg);
}

/// How long after arming the mic stream we wait for the first frame before
/// treating the device as dead. `build_input_stream` + `play()` return Ok even
/// when macOS hasn't released the mic from a just-killed process (quit
/// mid-recording, reopen seconds later, resume) — the CoreAudio IO proc then
/// never fires and zero frames arrive from t=0. Frames flow even for a silent
/// room (near-zero samples), so no-frames-at-all is a dead device, not a quiet
/// user. 3s is comfortably longer than a healthy stream's first-callback
/// latency (tens of ms) while still recovering fast.
const MIC_FIRST_FRAME_TIMEOUT_SECS: u64 = 3;

/// Pure watchdog decision: should we flag a "no first mic frame" fault?
///
/// Flag only when the device has produced no frame at all AND we're past the
/// timeout since the watchdog was (re)armed AND we haven't already flagged this
/// episode. Gating on `already_flagged` makes this one-shot per arm — the caller
/// re-arms (resetting the clock and the latch) when a recovery clears the
/// fault, so a dead recovery re-fires after another full timeout rather than
/// every tick. Extracted as a pure fn so the boundary logic is unit-testable
/// without mocking cpal.
fn should_flag_no_first_frame(
    got_first_frame: bool,
    paused: bool,
    already_flagged: bool,
    elapsed_since_arm: std::time::Duration,
) -> bool {
    !got_first_frame
        && !paused
        && !already_flagged
        && elapsed_since_arm.as_secs() >= MIC_FIRST_FRAME_TIMEOUT_SECS
}

/// How long the mic may go without a single data callback, mid-recording,
/// before we treat the device as dead. The first-frame watchdog disarms once
/// frames flow, and cpal's error callback doesn't fire for every death (a
/// Bluetooth headset switched away: prod logged "mic PCM stalled" for 77
/// minutes of a 2-hour capture while system audio kept flowing, and nothing
/// recovered it). Frames flow even in a silent room and even while paused, so
/// 10s of none is a dead device — long enough to ride out a HAL
/// reconfiguration, short enough that a meeting doesn't lose much.
const MIC_STALL_FAULT_SECS: u64 = 10;

/// Pure watchdog decision: should we flag a mid-recording mic stall?
///
/// Only after the current stream has produced its first frame (before that,
/// "no frames" is the first-frame watchdog's call), once the newest frame is
/// at least MIC_STALL_FAULT_SECS old, and at most once per
/// MIC_STALL_FAULT_SECS while an episode persists. No pause gate: pause only
/// gates emission, the device keeps calling back. Extracted as a pure fn so
/// the boundaries are unit-testable without mocking cpal.
fn should_flag_stall(
    got_first_frame: bool,
    frame_age: Option<std::time::Duration>,
    last_flag: Option<Instant>,
) -> bool {
    let threshold = std::time::Duration::from_secs(MIC_STALL_FAULT_SECS);
    got_first_frame
        && frame_age.is_some_and(|age| age >= threshold)
        && last_flag.map_or(true, |flagged_at| flagged_at.elapsed() >= threshold)
}

/// How often the level thread re-emits `audio://mic-fault` while a fault
/// persists. The WebView's recovery coordinator ignores a request that lands
/// within MIC_RECOVER_MIN_SPACING_MS (6s) of its last rebuild ("throttled")
/// and relies on the requester to fire again — so one emit per episode left a
/// rebuilt-but-still-dead stream (re-flagged ~3s after its rebuild, hence
/// throttled) with one rebuild, no retries and no give-up toast, and a lost
/// emit (listener not registered yet) stranded the recording the same way.
/// 7s is past the 6s window, so a re-emit is never throttled by the rebuild
/// the previous emit caused.
const MIC_FAULT_REEMIT_SECS: u64 = 7;

/// Cap on `audio://mic-fault` emits per fault episode. The WebView budget is 3
/// rebuilds per dead episode, then one give-up toast on the next request; 5
/// covers that plus a throttled or lost emit of margin, and bounds the
/// telemetry a dead device keeps generating after the WebView has given up
/// (each later request is logged there as "suppressed").
const MIC_FAULT_MAX_EMITS_PER_EPISODE: u32 = 5;

/// Pure: emit the recovery signal now? First emit immediately; then every
/// MIC_FAULT_REEMIT_SECS while the fault persists, at most
/// MIC_FAULT_MAX_EMITS_PER_EPISODE times per episode. The caller resets
/// `emits_so_far` / `last_emit` when the fault clears (a new episode).
/// Extracted as a pure fn so the cadence and cap are unit-testable without an
/// AppHandle.
fn should_emit_fault(fault: bool, emits_so_far: u32, last_emit: Option<Instant>) -> bool {
    let spacing = std::time::Duration::from_secs(MIC_FAULT_REEMIT_SECS);
    fault
        && emits_so_far < MIC_FAULT_MAX_EMITS_PER_EPISODE
        && last_emit.map_or(true, |emitted_at| emitted_at.elapsed() >= spacing)
}

/// Cadence of the mic diagnostics breadcrumb (rms + frame age), matching the
/// system-audio `rms=` line so a mic report is diagnosable from the log alone.
const MIC_DIAG_LOG_SECS: u64 = 5;

/// Convert f32 samples (-1.0..1.0) to 16-bit signed PCM bytes (little-endian).
fn f32_to_linear16_bytes(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        let clamped = s.clamp(-1.0, 1.0);
        let i16_val = (clamped * 32767.0) as i16;
        bytes.extend_from_slice(&i16_val.to_le_bytes());
    }
    bytes
}

/// PCM emit batching. Every `app.emit` JSON-serializes its payload and runs an
/// evaluateJavaScript dispatch on the WebView main thread, so emitting each
/// chunk individually (~94 mic + ~16 system chunks/sec) costs ~110 main-thread
/// IPC dispatches/sec of pure overhead. The emitter threads instead coalesce
/// chunks and flush every ~120ms — or as soon as the accumulator crosses 16KB,
/// whichever comes first — cutting dispatches 5-8x while keeping live-caption
/// latency imperceptible. The event consumers (Deepgram forwarder, voice-ID
/// feed) are chunk-size agnostic, so payload shape is the only thing batching
/// changes: same event names, same `Vec<u8>`, just bigger. (WAV archival rides
/// its own native channel and never sees these events.)
const PCM_EMIT_INTERVAL_MS: u64 = 120;
const PCM_EMIT_MAX_BYTES: usize = 16 * 1024;

/// Pure flush decision for PCM emit batching: flush once the accumulator
/// crosses the size threshold or the oldest pending chunk has waited a full
/// interval, whichever comes first. Extracted as a pure fn so the boundary
/// logic is unit-testable without a live channel.
fn should_flush_pcm(pending_bytes: usize, elapsed_since_first: std::time::Duration) -> bool {
    pending_bytes >= PCM_EMIT_MAX_BYTES
        || elapsed_since_first.as_millis() as u64 >= PCM_EMIT_INTERVAL_MS
}

/// Drain everything currently buffered on `rx` into `pending`, emitting a
/// batch whenever the accumulator reaches PCM_EMIT_MAX_BYTES.
///
/// The size cap is enforced INSIDE the drain, not just after it: a process
/// suspension (SIGSTOP, debugger pause, severe memory pressure) can leave
/// seconds of PCM queued while CoreAudio/the sidecar keep producing, and
/// accumulating the whole backlog before the flush check would ship one
/// multi-MB emit — a several-hundred-ms JSON-parse task on the WebView main
/// thread. Flushing at the cap mid-drain slices the backlog into bounded
/// payloads instead (each overshoots the cap by at most one chunk). Order is
/// preserved; any sub-cap residue stays in `pending` for the caller's normal
/// should_flush_pcm handling. `pending_since` is stamped on every
/// empty→non-empty transition, mirroring the recv arm, so the oldest-pending
/// age stays truthful across mid-drain emits. Shared by the mic and system
/// emitter loops; extracted so the cap boundary is unit-testable without a
/// live AppHandle.
fn drain_backlog_capped(
    rx: &std::sync::mpsc::Receiver<Vec<f32>>,
    pending: &mut Vec<u8>,
    pending_since: &mut Instant,
    mut emit: impl FnMut(Vec<u8>),
) {
    while let Ok(more) = rx.try_recv() {
        if pending.is_empty() {
            *pending_since = Instant::now();
        }
        pending.extend_from_slice(&f32_to_linear16_bytes(&more));
        if pending.len() >= PCM_EMIT_MAX_BYTES {
            emit(std::mem::take(pending));
        }
    }
}

/// Where the capture echo canceller's output goes: exactly where the raw mic
/// went before (the local-stt sink and the `audio://mic` emitter).
struct CleanedMicSink {
    stt: Option<Arc<SttSink>>,
    mic_tx: std::sync::mpsc::Sender<Vec<f32>>,
}

impl CleanedSink for CleanedMicSink {
    fn push(&mut self, samples: &[f32]) {
        if let Some(sink) = &self.stt {
            sink.push(STREAM_MIC, samples);
        }
        let _ = self.mic_tx.send(samples.to_vec());
    }
}

/// Whether a capture runs the echo canceller: the setting is on AND system
/// audio is really being captured (it is the reference; there is nothing to
/// cancel against otherwise).
pub fn capture_echo_cancellation(setting_on: bool, system_audio: SystemAudioStatus) -> bool {
    setting_on && system_audio == SystemAudioStatus::Capturing
}

/// The canceller's feed and the mic's stream generation (to tag each chunk).
type MicAecFeed = (AecFeed, Arc<std::sync::atomic::AtomicU64>);
/// What `MicCapture::set_sample_callback` takes.
type MicCallback = Box<dyn Fn(&[f32]) + Send>;

/// The mic sample callback. Without echo cancellation it is exactly the one
/// captures always had: the raw 16 kHz mic to local-stt and the
/// `audio://mic` emitter. With it, the mic goes to the canceller's worker
/// instead (stamped, with its stream generation), which sends the cleaned mic
/// on to the same two places.
fn mic_sample_callback(
    stt: Option<Arc<SttSink>>,
    mic_tx: std::sync::mpsc::Sender<Vec<f32>>,
    aec: Option<MicAecFeed>,
) -> MicCallback {
    match aec {
        None => Box::new(move |samples: &[f32]| {
            if samples.is_empty() {
                return;
            }
            if let Some(sink) = &stt {
                sink.push(STREAM_MIC, samples);
            }
            let _ = mic_tx.send(samples.to_vec());
        }),
        Some((feed, generation)) => {
            // The worker's sink owns the STT clone and the emitter sender.
            drop((stt, mic_tx));
            Box::new(move |samples: &[f32]| {
                if samples.is_empty() {
                    return;
                }
                feed.mic(samples, generation.load(Ordering::Relaxed));
            })
        }
    }
}

pub struct RecordingSession {
    pub session_id: String,
    started_at: Instant,

    // Tauri app handle for event emission
    app_handle: AppHandle,

    // Audio level emitter control
    level_emitter_stop: Arc<AtomicBool>,
    level_emitter_handle: Option<thread::JoinHandle<()>>,

    // PCM emitter threads — drain the sample channels and do the Tauri event
    // emission OFF the audio threads. They exit when the sample callbacks are
    // cleared (dropping the channel senders).
    mic_emitter_handle: Option<thread::JoinHandle<()>>,
    system_emitter_handle: Option<thread::JoinHandle<()>>,

    // Local transcription sink (local-stt module), when this session uses the
    // on-device engine. Dropped at stop — once the capture callbacks' clones
    // are gone too, the module flushes and emits `stt://finished`.
    stt: Option<Arc<SttSink>>,

    // The capture echo canceller (chat-voice.md §3.5), when this session
    // runs it: it feeds the cleaned mic to `stt` and the mic emitter, so stop
    // flushes it before closing either.
    capture_aec: Option<CaptureAecWorker>,
}

impl Drop for RecordingSession {
    /// A session torn down without stop() (e.g. reset_recording_state when it
    /// can't take the capture locks) may leave capture callbacks installed that
    /// still hold sink clones — close the local-stt session explicitly so its
    /// sidecar never outlives the recording.
    fn drop(&mut self) {
        // The canceller's thread stops on its own (no flush, no wait).
        drop(self.capture_aec.take());
        if let Some(stt) = self.stt.take() {
            stt.close();
        }
    }
}

impl RecordingSession {
    /// Create and start a new recording session.
    /// Installs sample callbacks that forward raw PCM to the frontend, and to
    /// the local transcription sink when `stt` is set.
    ///
    /// `echo_cancellation` (see [`capture_echo_cancellation`]): the mic that
    /// goes to transcription (local-stt and `audio://mic`) is cleaned of the
    /// system audio's echo first. The WAVs, the levels and every system-audio
    /// consumer are the same either way.
    pub fn start(
        app_handle: AppHandle,
        session_id: String,
        mic: &MicCapture,
        system: &SystemCapture,
        stt: Option<Arc<SttSink>>,
        echo_cancellation: bool,
    ) -> Result<Self, String> {
        let now = Instant::now();

        // Mic PCM forwarding. The mic sample callback runs on the CoreAudio
        // realtime IO thread — emitting a Tauri event from there (JSON
        // serialization + IPC into the WebView) can stall past the IO
        // deadline, which makes CoreAudio restart the device IO: a ~1s hole
        // in our own capture and an audible dropout for every other app
        // sharing the input device (observed live: Native Intelligence's and Zoom's input
        // streams blipping together during captures). The callback must only
        // copy the chunk into a channel; a dedicated thread converts and
        // emits.
        let (mic_tx, mic_rx) = std::sync::mpsc::channel::<Vec<f32>>();
        let mic_emitter_handle = {
            let app = app_handle.clone();
            thread::spawn(move || {
                let mut logged = false;
                // Track input flow so a silently-dead device (e.g. a yanked
                // headset whose cpal stream stopped calling the callback) becomes
                // observable instead of an invisible transcript stall. recv_timeout
                // keeps the SAME Disconnected->break semantics as recv() (stop()
                // drops the sender → the loop exits and the thread joins promptly).
                let mut last_sample = Instant::now();
                let mut last_stall_log: Option<Instant> = None;
                // Coalesced PCM awaiting emission (see PCM_EMIT_INTERVAL_MS —
                // batching amortizes the per-emit IPC dispatch cost).
                let mut pending: Vec<u8> = Vec::new();
                let mut pending_since = Instant::now();
                loop {
                    // With chunks pending, wait only until the flush deadline;
                    // otherwise keep the 500ms stall-detection cadence.
                    let wait = if pending.is_empty() {
                        std::time::Duration::from_millis(500)
                    } else {
                        std::time::Duration::from_millis(PCM_EMIT_INTERVAL_MS)
                            .saturating_sub(pending_since.elapsed())
                    };
                    match mic_rx.recv_timeout(wait) {
                        Ok(samples) => {
                            last_sample = Instant::now();
                            last_stall_log = None;
                            if !logged {
                                logged = true;
                                slog(&format!(
                                    "[Session] Mic PCM streaming started ({} samples/chunk = {} bytes)",
                                    samples.len(),
                                    samples.len() * 2
                                ));
                            }
                            if pending.is_empty() {
                                pending_since = Instant::now();
                            }
                            pending.extend_from_slice(&f32_to_linear16_bytes(&samples));
                            // Drain any backlog in one pass so a burst becomes
                            // one emit instead of one per chunk (order
                            // preserved), with PCM_EMIT_MAX_BYTES enforced
                            // inside the drain so a post-suspension backlog
                            // never becomes one jumbo emit (see
                            // drain_backlog_capped).
                            drain_backlog_capped(&mic_rx, &mut pending, &mut pending_since, |batch| {
                                let _ = app.emit("audio://mic", batch);
                            });
                            if should_flush_pcm(pending.len(), pending_since.elapsed()) {
                                let _ = app.emit("audio://mic", std::mem::take(&mut pending));
                            }
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                            // A timeout with chunks pending means the flush
                            // deadline passed (wait was capped to it) — emit.
                            if !pending.is_empty() {
                                let _ = app.emit("audio://mic", std::mem::take(&mut pending));
                            }
                            // Only meaningful once audio has actually started; a
                            // silent gap >5s after that signals a dead source.
                            // Debounce to at most one breadcrumb per 5s.
                            if logged && last_sample.elapsed().as_secs() >= 5 {
                                let due = last_stall_log
                                    .map(|t| t.elapsed().as_secs() >= 5)
                                    .unwrap_or(true);
                                if due {
                                    last_stall_log = Some(Instant::now());
                                    slog(&format!(
                                        "[Session] mic PCM stalled {}s — audio source silent (device disconnect?)",
                                        last_sample.elapsed().as_secs()
                                    ));
                                }
                            }
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                            // stop() dropped the sender — flush the tail first so
                            // the final <PCM_EMIT_INTERVAL_MS of audio reaches
                            // Deepgram/voice-ID instead of being dropped. (Only
                            // audible if the frontend stops the native session
                            // BEFORE unlistening — use-recording.ts stop order.)
                            if !pending.is_empty() {
                                let _ = app.emit("audio://mic", std::mem::take(&mut pending));
                            }
                            break;
                        }
                    }
                }
            })
        };
        // Capture echo cancellation: a worker between the mic and its two
        // transcription consumers, fed the system audio as the reference. If
        // the thread can't be spawned the capture goes on without it.
        let (capture_aec, aec_feed) = if echo_cancellation {
            let sink = CleanedMicSink { stt: stt.clone(), mic_tx: mic_tx.clone() };
            match CaptureAecWorker::spawn(
                Box::new(sink),
                || aec::new_echo_canceller_tuned(AecTuning::Capture),
                WorkerConfig::default(),
                slog,
            ) {
                Ok((worker, feed)) => (Some(worker), Some(feed)),
                Err(e) => {
                    slog(&format!("[Session] echo cancellation unavailable ({e}); raw mic to transcription"));
                    (None, None)
                }
            }
        } else {
            (None, None)
        };

        // The local-stt tee is a non-blocking try_send (drops on a full
        // queue), so it keeps the IO-thread callback within its budget.
        mic.set_sample_callback(Some(mic_sample_callback(
            stt.clone(),
            mic_tx,
            aec_feed.clone().map(|feed| (feed, mic.stream_generation_handle())),
        )));

        // System audio PCM forwarding — arrives in ~1024-sample chunks from
        // the sidecar pipe reader thread. A stalled emit there backpressures
        // the pipe and drops system audio, so it gets the same treatment.
        let (sys_tx, sys_rx) = std::sync::mpsc::channel::<Vec<f32>>();
        let system_emitter_handle = {
            let app = app_handle.clone();
            thread::spawn(move || {
                let mut logged = false;
                let mut last_sample = Instant::now();
                let mut last_stall_log: Option<Instant> = None;
                // Same batching as the mic emitter (see PCM_EMIT_INTERVAL_MS).
                let mut pending: Vec<u8> = Vec::new();
                let mut pending_since = Instant::now();
                loop {
                    let wait = if pending.is_empty() {
                        std::time::Duration::from_millis(500)
                    } else {
                        std::time::Duration::from_millis(PCM_EMIT_INTERVAL_MS)
                            .saturating_sub(pending_since.elapsed())
                    };
                    match sys_rx.recv_timeout(wait) {
                        Ok(samples) => {
                            last_sample = Instant::now();
                            last_stall_log = None;
                            if !logged {
                                logged = true;
                                slog(&format!(
                                    "[Session] System PCM streaming started ({} samples/chunk = {} bytes)",
                                    samples.len(),
                                    samples.len() * 2
                                ));
                            }
                            if pending.is_empty() {
                                pending_since = Instant::now();
                            }
                            pending.extend_from_slice(&f32_to_linear16_bytes(&samples));
                            // Cap-inside-drain, same as the mic emitter (see
                            // drain_backlog_capped).
                            drain_backlog_capped(&sys_rx, &mut pending, &mut pending_since, |batch| {
                                let _ = app.emit("audio://system", batch);
                            });
                            if should_flush_pcm(pending.len(), pending_since.elapsed()) {
                                let _ = app.emit("audio://system", std::mem::take(&mut pending));
                            }
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                            if !pending.is_empty() {
                                let _ = app.emit("audio://system", std::mem::take(&mut pending));
                            }
                            if logged && last_sample.elapsed().as_secs() >= 5 {
                                let due = last_stall_log
                                    .map(|t| t.elapsed().as_secs() >= 5)
                                    .unwrap_or(true);
                                if due {
                                    last_stall_log = Some(Instant::now());
                                    slog(&format!(
                                        "[Session] system PCM stalled {}s — audio source silent",
                                        last_sample.elapsed().as_secs()
                                    ));
                                }
                            }
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                            // Flush the tail before exit so stop() doesn't drop it.
                            if !pending.is_empty() {
                                let _ = app.emit("audio://system", std::mem::take(&mut pending));
                            }
                            break;
                        }
                    }
                }
            })
        };
        let system_stt = stt.clone();
        match aec_feed {
            None => system.set_sample_callback(Some(Box::new(move |samples: &[f32]| {
                if samples.is_empty() {
                    return;
                }
                if let Some(sink) = &system_stt {
                    sink.push(STREAM_SYSTEM, samples);
                }
                let _ = sys_tx.send(samples.to_vec());
            }))),
            // The same, plus a copy to the echo canceller as its reference.
            Some(feed) => system.set_sample_callback(Some(Box::new(move |samples: &[f32]| {
                if samples.is_empty() {
                    return;
                }
                if let Some(sink) = &system_stt {
                    sink.push(STREAM_SYSTEM, samples);
                }
                let _ = sys_tx.send(samples.to_vec());
                feed.reference(samples);
            }))),
        }

        // Start audio level emitter thread (10Hz) — reads levels from captures
        // and emits AudioLevelPayload events to the frontend. Doubles as the mic
        // fault watchdog: when the mic stream faults (device disconnect), it
        // emits `audio://mic-fault` so the frontend can invoke the recover_mic
        // command, which rebuilds the stream on the default device off the audio
        // thread. The emit fires at once, then repeats every
        // MIC_FAULT_REEMIT_SECS while the fault persists, at most
        // MIC_FAULT_MAX_EMITS_PER_EPISODE times per episode (should_emit_fault):
        // the WebView ignores a request that lands too soon after its last
        // rebuild and relies on the requester to re-fire. Three detectors feed
        // that one fault flag: cpal's error callback, the first-frame watchdog
        // (stream never came alive) and the stall watchdog (stream died after
        // its first frame).
        let level_stop = Arc::new(AtomicBool::new(false));
        let mic_level = mic.level_handle();
        let sys_level = system.level_handle();
        let mic_fault = mic.fault_handle();
        let mic_first_frame = mic.first_frame_handle();
        let mic_paused = mic.paused_handle();
        let (mic_clock, mic_last_frame) = mic.frame_age_handle();
        let mic_switch_epoch = mic.switch_epoch_handle();
        let level_handle = {
            let stop = Arc::clone(&level_stop);
            let app = app_handle.clone();
            let session_start = now;

            thread::spawn(move || {
                // Recovery-signal state of the current fault episode: how many
                // audio://mic-fault emits went out and when the last one did.
                // Reset whenever the fault is seen cleared.
                let mut fault_emits: u32 = 0;
                let mut last_fault_emit: Option<Instant> = None;
                // The fault flag as of the end of the previous tick — how a
                // recovery that cleared it in between is noticed (below).
                let mut fault_seen_last_tick = false;
                // Stall watchdog: when the current stall episode was last
                // flagged (None = no episode). Spaces re-flags of a persisting
                // stall by MIC_STALL_FAULT_SECS; cleared by fresh frames and by
                // a recovery.
                let mut last_stall_flag: Option<Instant> = None;
                // Last mic diagnostics breadcrumb (see MIC_DIAG_LOG_SECS).
                let mut last_mic_diag = Instant::now();
                // First-frame watchdog arm clock: session start, then re-armed
                // each time a recovery clears the fault (whichever detector
                // raised it), so a rebuilt stream gets a full fresh timeout to
                // produce its first frame. Re-arming only on a recovery is what
                // bounds this against a hot loop when a device stays dead
                // across recovery attempts: at most one flag per rebuild.
                let mut first_frame_armed_at = std::time::Instant::now();
                let mut first_frame_flagged = false;
                // MicCapture::switch_device's epoch as last seen: a live
                // device switch re-arms like a recovery does.
                let mut switch_epoch_seen = mic_switch_epoch.load(Ordering::SeqCst);
                while !stop.load(Ordering::SeqCst) {
                    thread::sleep(std::time::Duration::from_millis(100));
                    let mic_lvl = *mic_level.lock().unwrap();
                    let sys_lvl = *sys_level.lock().unwrap();
                    let payload = AudioLevelPayload {
                        mic_level: mic_lvl,
                        system_level: sys_lvl,
                        timestamp: session_start.elapsed().as_secs_f64(),
                    };
                    let _ = app.emit("audio-level", &payload);

                    // A recovery cleared the fault since the last tick
                    // (open_stream clears it once the rebuilt stream is up):
                    // re-arm both watchdogs and the emit budget for the new
                    // stream. The first-frame clock restarts HERE, whichever
                    // detector raised the fault: recover_after_fault cleared
                    // got_first_frame, so on the old clock (session start, or
                    // the last flag) the watchdog would fire ~100ms after the
                    // rebuild instead of giving the new stream its full
                    // MIC_FIRST_FRAME_TIMEOUT_SECS, however long the WebView
                    // round trip took. The emit budget resets here too — the
                    // moment the clear is seen, not only when a tick ENDS
                    // fault-free: a fault raised again before this tick's
                    // bottom (a detector below, or cpal's error callback) means
                    // the bottom never sees it clear. That is how the old
                    // one-shot latch got stuck: cleared and re-flagged within
                    // one tick, it stayed "already signaled" with the flag
                    // stuck true — swallowing every later fault of the
                    // recording, and leaving a later recover_mic to rebuild a
                    // healthy stream.
                    let fault_before = mic_fault.load(Ordering::SeqCst);
                    if fault_seen_last_tick && !fault_before {
                        first_frame_flagged = false;
                        first_frame_armed_at = std::time::Instant::now();
                        last_stall_flag = None;
                        fault_emits = 0;
                        last_fault_emit = None;
                    }
                    // A live device switch (Input Device Priority) replaced
                    // the stream and cleared got_first_frame: give the new
                    // stream a full first-frame timeout, or the old clock
                    // fires a spurious recovery right after the switch.
                    let switch_epoch = mic_switch_epoch.load(Ordering::SeqCst);
                    if switch_epoch != switch_epoch_seen {
                        switch_epoch_seen = switch_epoch;
                        first_frame_flagged = false;
                        first_frame_armed_at = std::time::Instant::now();
                        last_stall_flag = None;
                    }

                    let got_first = mic_first_frame.load(Ordering::Relaxed);
                    let paused = mic_paused.load(Ordering::SeqCst);
                    let mic_frame_age =
                        frame_age(mic_clock, mic_last_frame.load(Ordering::Relaxed));
                    if mic_frame_age.is_some_and(|age| age < std::time::Duration::from_secs(1)) {
                        // Fresh frames: whatever stall episode there was is over.
                        last_stall_flag = None;
                    }

                    // Both watchdogs stand down while a fault is pending: a
                    // recovery is already in flight (or being re-requested,
                    // below), and a stream that is being torn down and rebuilt
                    // has no frames by definition — flagging it again is noise
                    // (it is what logged "no frames 3s after start" in the
                    // middle of a rebuild). They re-arm on the clear, above.
                    if !fault_before {
                        // First-frame watchdog (MIC ONLY). Catches the CoreAudio
                        // device-release race that the existing fault flag can't
                        // see: build_input_stream + play() return Ok, but the IO
                        // proc never fires, so `stream_faulted` (set only in
                        // cpal's error callback) stays false and no frames ever
                        // arrive. When no first frame lands within the timeout,
                        // set the SAME stream_faulted flag so the emit path below
                        // drives recovery — one source of truth for the fault
                        // signal. Gated on !paused (pause legitimately silences
                        // the callback). Once frames arrive, this watchdog is
                        // done until a recovery re-arms it (a mid-recording death
                        // is the stall watchdog's job, below, alongside cpal's
                        // error callback).
                        if should_flag_no_first_frame(
                            got_first,
                            paused,
                            first_frame_flagged,
                            first_frame_armed_at.elapsed(),
                        ) {
                            first_frame_flagged = true;
                            slog(&format!(
                                "[Session] mic produced no frames {}s after start — flagging fault for auto-recovery (CoreAudio device-release race?)",
                                MIC_FIRST_FRAME_TIMEOUT_SECS
                            ));
                            mic_fault.store(true, Ordering::SeqCst);
                        }

                        // Mid-recording stall watchdog (MIC ONLY). A device can
                        // die AFTER its first frame with no cpal error callback
                        // at all (e.g. a Bluetooth headset switched away): the
                        // first-frame watchdog is satisfied and nothing else
                        // would ever recover it. "No data callback for
                        // MIC_STALL_FAULT_SECS" is a pure device-liveness signal
                        // — callbacks keep firing while paused — so it feeds the
                        // SAME fault flag and therefore the same emit →
                        // recover_mic pipeline. The WebView coordinator bounds
                        // recover_mic per dead episode, so this can't hot-loop.
                        if should_flag_stall(got_first, mic_frame_age, last_stall_flag) {
                            slog(&format!(
                                "[Session] mic produced no frames for {}s mid-recording — flagging fault for auto-recovery",
                                mic_frame_age.map_or(0, |age| age.as_secs())
                            ));
                            mic_fault.store(true, Ordering::SeqCst);
                            last_stall_flag = Some(Instant::now());
                        }
                    }

                    // Mic fault signal: emit at once, then re-emit on
                    // MIC_FAULT_REEMIT_SECS while the fault persists, up to
                    // MIC_FAULT_MAX_EMITS_PER_EPISODE (see MIC_FAULT_REEMIT_SECS
                    // for why one emit per episode was not enough). A tick that
                    // ends fault-free closes the episode, so a later disconnect
                    // signals again with a fresh budget.
                    let fault_after = mic_fault.load(Ordering::SeqCst);
                    if should_emit_fault(fault_after, fault_emits, last_fault_emit) {
                        fault_emits += 1;
                        last_fault_emit = Some(Instant::now());
                        slog(&format!(
                            "[Session] mic stream faulted — emitting audio://mic-fault for recovery (emit {}/{})",
                            fault_emits, MIC_FAULT_MAX_EMITS_PER_EPISODE
                        ));
                        let _ = app.emit("audio://mic-fault", ());
                    }
                    if !fault_after {
                        fault_emits = 0;
                        last_fault_emit = None;
                    }
                    fault_seen_last_tick = fault_after;

                    // Mic diagnostics breadcrumb, mirroring the system-audio
                    // `rms=` line: the level plus how old the newest frame is,
                    // so a dead-mic report is diagnosable from native-intelligence-debug.log
                    // alone. The level only updates while recording and
                    // unpaused — the marker says when it is a held value.
                    if last_mic_diag.elapsed().as_secs() >= MIC_DIAG_LOG_SECS {
                        last_mic_diag = Instant::now();
                        crate::log_to_file(&format!(
                            "[Session] mic rms={:.6} frame_age={}{}",
                            mic_lvl,
                            mic_frame_age.map_or_else(
                                || "none".to_string(),
                                |age| format!("{}ms", age.as_millis())
                            ),
                            if paused { " (paused)" } else { "" }
                        ));
                    }
                }
            })
        };

        slog(&format!(
            "[Session] Started session {} — streaming PCM to frontend",
            session_id
        ));

        Ok(Self {
            session_id,
            started_at: now,
            app_handle,
            level_emitter_stop: level_stop,
            level_emitter_handle: Some(level_handle),
            mic_emitter_handle: Some(mic_emitter_handle),
            system_emitter_handle: Some(system_emitter_handle),
            stt,
            capture_aec,
        })
    }

    /// Stop the session. Clears callbacks and stops level emitter.
    pub fn stop(
        &mut self,
        mic: &MicCapture,
        system: &SystemCapture,
    ) -> f64 {
        let elapsed = self.started_at.elapsed().as_secs_f64();

        // Clear sample callbacks — this drops the channel senders, which lets
        // the PCM emitter threads drain and exit.
        mic.set_sample_callback(None);
        system.set_sample_callback(None);
        // The echo canceller holds the mic's last ~100 ms (its hold) and the
        // mic emitter's sender: flush that tail into local-stt and
        // audio://mic, and let go of the sender, BEFORE the sink closes.
        if let Some(worker) = self.capture_aec.take() {
            worker.finish();
        }
        // Tell the local-stt session (if any) to flush its tail and end.
        if let Some(stt) = self.stt.take() {
            stt.close();
        }

        if let Some(handle) = self.mic_emitter_handle.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.system_emitter_handle.take() {
            let _ = handle.join();
        }

        // Stop level emitter
        self.level_emitter_stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.level_emitter_handle.take() {
            let _ = handle.join();
        }

        slog(&format!(
            "[Session] Stopped session {} — {:.1}s elapsed",
            self.session_id, elapsed
        ));

        elapsed
    }

    /// Get elapsed recording time in seconds.
    pub fn elapsed_seconds(&self) -> f64 {
        self.started_at.elapsed().as_secs_f64()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const TIMEOUT: u64 = MIC_FIRST_FRAME_TIMEOUT_SECS;

    #[test]
    fn does_not_flag_before_timeout() {
        // No frame yet, but we haven't waited long enough.
        assert!(!should_flag_no_first_frame(
            false,
            false,
            false,
            Duration::from_secs(TIMEOUT - 1),
        ));
    }

    #[test]
    fn flags_at_timeout_with_no_frame() {
        // The dead-device case: no first frame, past the timeout, not paused,
        // not already flagged.
        assert!(should_flag_no_first_frame(
            false,
            false,
            false,
            Duration::from_secs(TIMEOUT),
        ));
    }

    #[test]
    fn does_not_flag_once_a_frame_arrived() {
        // Device is alive — a frame landed — so never flag no matter how long.
        assert!(!should_flag_no_first_frame(
            true,
            false,
            false,
            Duration::from_secs(TIMEOUT + 100),
        ));
    }

    #[test]
    fn does_not_flag_while_paused() {
        // Pause silences the mic callback; missing frames are expected, not a
        // dead device.
        assert!(!should_flag_no_first_frame(
            false,
            true,
            false,
            Duration::from_secs(TIMEOUT + 5),
        ));
    }

    #[test]
    fn does_not_reflag_when_already_flagged() {
        // One-shot per arm: the caller re-arms (resetting the clock and this
        // latch) before the next legitimate flag.
        assert!(!should_flag_no_first_frame(
            false,
            false,
            true,
            Duration::from_secs(TIMEOUT + 5),
        ));
    }

    const STALL: u64 = MIC_STALL_FAULT_SECS;

    #[test]
    fn stall_does_not_flag_below_the_threshold() {
        // Frames are late but not yet dead-device late.
        assert!(!should_flag_stall(
            true,
            Some(Duration::from_millis(STALL * 1000 - 1)),
            None,
        ));
    }

    #[test]
    fn stall_flags_at_the_threshold() {
        // The mid-recording death: the stream had frames, then none for 10s.
        assert!(should_flag_stall(true, Some(Duration::from_secs(STALL)), None));
        assert!(should_flag_stall(true, Some(Duration::from_secs(STALL * 100)), None));
    }

    #[test]
    fn stall_reflags_only_after_the_spacing_elapses() {
        let age = Some(Duration::from_secs(STALL + 30));
        // Flagged a moment ago: a persisting stall must not re-flag every tick.
        assert!(!should_flag_stall(true, age, Some(Instant::now())));
        // Flagged a full interval ago and still stalled: flag again.
        let long_ago = Instant::now()
            .checked_sub(Duration::from_secs(STALL + 1))
            .expect("machine uptime > stall threshold");
        assert!(should_flag_stall(true, age, Some(long_ago)));
    }

    #[test]
    fn stall_never_flags_before_the_first_frame() {
        // Before the first frame, "no frames" is the first-frame watchdog's
        // call — and frame_age is None then anyway.
        assert!(!should_flag_stall(false, Some(Duration::from_secs(STALL + 5)), None));
        assert!(!should_flag_stall(false, None, None));
    }

    #[test]
    fn stall_does_not_flag_without_a_frame_timestamp() {
        // A freshly rebuilt stream whose timestamp was reset but whose first
        // frame flag is somehow still set must not read as stalled.
        assert!(!should_flag_stall(true, None, None));
    }

    const REEMIT: u64 = MIC_FAULT_REEMIT_SECS;
    const MAX_EMITS: u32 = MIC_FAULT_MAX_EMITS_PER_EPISODE;

    /// An Instant `secs` in the past, for pinning the re-emit spacing.
    fn secs_ago(secs: u64) -> Instant {
        Instant::now()
            .checked_sub(Duration::from_secs(secs))
            .expect("machine uptime > re-emit spacing")
    }

    #[test]
    fn fault_emit_never_fires_without_a_fault() {
        // Nothing to signal, whatever the episode counters still say.
        assert!(!should_emit_fault(false, 0, None));
        assert!(!should_emit_fault(false, 2, Some(secs_ago(REEMIT + 1))));
    }

    #[test]
    fn fault_emit_fires_at_once_for_a_new_fault() {
        assert!(should_emit_fault(true, 0, None));
    }

    #[test]
    fn fault_emit_waits_out_the_reemit_spacing() {
        // Emitted a second ago and still faulted: too soon — the WebView
        // throttles a request inside its 6s rebuild spacing.
        assert!(!should_emit_fault(true, 1, Some(secs_ago(1))));
    }

    #[test]
    fn fault_emit_repeats_once_the_spacing_elapsed() {
        // Still faulted a full interval after the last emit: re-fire, so a
        // throttled or lost emit can't strand the recording.
        assert!(should_emit_fault(true, 1, Some(secs_ago(REEMIT))));
        assert!(should_emit_fault(
            true,
            MAX_EMITS - 1,
            Some(secs_ago(REEMIT + 1))
        ));
    }

    #[test]
    fn fault_emit_stops_at_the_episode_cap() {
        // Budget spent (the WebView has long since given up): stay quiet for
        // the rest of this episode.
        assert!(!should_emit_fault(
            true,
            MAX_EMITS,
            Some(secs_ago(REEMIT + 1))
        ));
        assert!(!should_emit_fault(true, MAX_EMITS, None));
    }

    #[test]
    fn pcm_does_not_flush_below_both_thresholds() {
        // Chunks keep accumulating while under both the size and time limits.
        assert!(!should_flush_pcm(
            PCM_EMIT_MAX_BYTES - 1,
            Duration::from_millis(PCM_EMIT_INTERVAL_MS - 1),
        ));
    }

    #[test]
    fn pcm_flushes_at_size_threshold() {
        // A burst crossing the byte ceiling flushes immediately, without
        // waiting out the interval.
        assert!(should_flush_pcm(PCM_EMIT_MAX_BYTES, Duration::from_millis(0)));
    }

    #[test]
    fn pcm_flushes_at_interval() {
        // The oldest pending chunk never waits longer than one interval,
        // regardless of how little has accumulated.
        assert!(should_flush_pcm(1, Duration::from_millis(PCM_EMIT_INTERVAL_MS)));
    }

    /// An Instant comfortably in the past, for pinning pending_since stamping.
    fn stale_instant() -> Instant {
        Instant::now()
            .checked_sub(Duration::from_secs(10))
            .expect("machine uptime > 10s")
    }

    #[test]
    fn drain_slices_a_backlog_into_capped_emits() {
        // The post-suspension case: seconds of PCM queued before the drain
        // runs. 300 samples/chunk = 600 bytes, which does NOT divide the 16KB
        // cap, so each flush overshoots by a partial chunk — the bound is
        // cap + one chunk, never the whole backlog.
        const CHUNK_SAMPLES: usize = 300;
        const CHUNK_BYTES: usize = CHUNK_SAMPLES * 2;
        const CHUNKS: usize = 100; // 60,000 bytes total — several caps' worth
        let (tx, rx) = std::sync::mpsc::channel::<Vec<f32>>();
        for _ in 0..CHUNKS {
            tx.send(vec![0.25_f32; CHUNK_SAMPLES]).unwrap();
        }
        let mut pending: Vec<u8> = Vec::new();
        let mut pending_since = Instant::now();
        let mut batches: Vec<Vec<u8>> = Vec::new();
        drain_backlog_capped(&rx, &mut pending, &mut pending_since, |b| batches.push(b));

        assert!(batches.len() >= 2, "backlog must be sliced, not one jumbo emit");
        for batch in &batches {
            assert!(batch.len() >= PCM_EMIT_MAX_BYTES);
            assert!(batch.len() < PCM_EMIT_MAX_BYTES + CHUNK_BYTES);
        }
        // Sub-cap residue is left for the caller's should_flush_pcm handling.
        assert!(pending.len() < PCM_EMIT_MAX_BYTES);
        let total: usize = batches.iter().map(|b| b.len()).sum::<usize>() + pending.len();
        assert_eq!(total, CHUNKS * CHUNK_BYTES, "no bytes lost or duplicated");
    }

    #[test]
    fn drain_preserves_chunk_order_across_mid_drain_emits() {
        // Fill each chunk with a distinct sample value; the concatenation of
        // emitted batches + residue must equal the input stream byte-for-byte.
        const CHUNK_SAMPLES: usize = 4096; // 8KB/chunk → flush every 2 chunks
        let values = [0.1_f32, 0.2, 0.3, 0.4, 0.5];
        let (tx, rx) = std::sync::mpsc::channel::<Vec<f32>>();
        let mut expected: Vec<u8> = Vec::new();
        for &v in &values {
            let chunk = vec![v; CHUNK_SAMPLES];
            expected.extend_from_slice(&f32_to_linear16_bytes(&chunk));
            tx.send(chunk).unwrap();
        }
        let mut pending: Vec<u8> = Vec::new();
        let mut pending_since = Instant::now();
        let mut received: Vec<u8> = Vec::new();
        drain_backlog_capped(&rx, &mut pending, &mut pending_since, |b| {
            received.extend_from_slice(&b)
        });
        received.extend_from_slice(&pending);
        assert_eq!(received, expected);
    }

    #[test]
    fn drain_below_cap_accumulates_without_emitting() {
        // A normal small burst stays in `pending` — batching (not the cap)
        // decides when it ships, via the caller's should_flush_pcm.
        let (tx, rx) = std::sync::mpsc::channel::<Vec<f32>>();
        tx.send(vec![0.5_f32; 100]).unwrap();
        tx.send(vec![0.5_f32; 100]).unwrap();
        let mut pending: Vec<u8> = Vec::new();
        let mut pending_since = Instant::now();
        let mut emits = 0usize;
        drain_backlog_capped(&rx, &mut pending, &mut pending_since, |_| emits += 1);
        assert_eq!(emits, 0);
        assert_eq!(pending.len(), 2 * 100 * 2);
    }

    #[test]
    fn drain_stamps_pending_since_on_empty_to_nonempty_transition() {
        // After a mid-drain (or earlier) flush empties the accumulator, the
        // next chunk restarts the oldest-pending clock — mirroring the recv
        // arm — so the caller's interval math stays truthful.
        let (tx, rx) = std::sync::mpsc::channel::<Vec<f32>>();
        tx.send(vec![0.5_f32; 100]).unwrap();
        let mut pending: Vec<u8> = Vec::new();
        let mut pending_since = stale_instant();
        drain_backlog_capped(&rx, &mut pending, &mut pending_since, |_| {});
        assert!(pending_since.elapsed() < Duration::from_secs(5), "stamp was reset");
    }

    // ── capture echo cancellation wiring ────────────────────────────────

    #[test]
    fn echo_cancellation_needs_the_setting_and_captured_system_audio() {
        assert!(capture_echo_cancellation(true, SystemAudioStatus::Capturing));
        assert!(!capture_echo_cancellation(false, SystemAudioStatus::Capturing), "the setting is off");
        for no_reference in [
            SystemAudioStatus::Disabled,
            SystemAudioStatus::PermissionDenied,
            SystemAudioStatus::Unavailable,
            SystemAudioStatus::Failed,
        ] {
            assert!(!capture_echo_cancellation(true, no_reference), "{no_reference:?}: nothing to cancel against");
        }
    }

    #[test]
    fn without_echo_cancellation_the_mic_callback_is_the_old_one() {
        // Feature off, or no system audio: the raw 16 kHz chunks go straight
        // to audio://mic's channel, as they are, one send per chunk.
        let (tx, rx) = std::sync::mpsc::channel::<Vec<f32>>();
        let cb = mic_sample_callback(None, tx, None);
        let chunks: Vec<Vec<f32>> = vec![vec![0.1, -0.2, 0.3], vec![], vec![0.25; 160], vec![-1.0; 7]];
        for c in &chunks {
            cb(c);
        }
        let got: Vec<Vec<f32>> = rx.try_iter().collect();
        let want: Vec<Vec<f32>> = chunks.into_iter().filter(|c| !c.is_empty()).collect();
        assert_eq!(got, want);
    }

    #[test]
    fn with_echo_cancellation_the_mic_goes_through_the_worker_and_out_whole() {
        use crate::audio::aec::{EchoCanceller, PassthroughCanceller};
        use crate::audio::capture_aec::{CaptureAecWorker, WorkerConfig};
        let (tx, rx) = std::sync::mpsc::channel::<Vec<f32>>();
        let sink = CleanedMicSink { stt: None, mic_tx: tx.clone() };
        let (worker, feed) = CaptureAecWorker::spawn(
            Box::new(sink),
            || Ok(Box::new(PassthroughCanceller) as Box<dyn EchoCanceller>),
            WorkerConfig::default(),
            |_| {},
        )
        .unwrap();
        let generation = Arc::new(std::sync::atomic::AtomicU64::new(1));
        let cb = mic_sample_callback(None, tx, Some((feed.clone(), generation)));
        let mic: Vec<f32> = (0..5_000).map(|i| (i as f32 * 0.001).sin()).collect();
        for c in mic.chunks(512) {
            cb(c);
            feed.reference(&[0.0; 170]);
        }
        // Nothing reaches audio://mic straight from the callback...
        drop((cb, feed));
        // ...stop's order: callbacks cleared, then the worker flushes.
        worker.finish();
        let got: Vec<f32> = rx.try_iter().flatten().collect();
        assert_eq!(got, mic, "every sample, once, in order, through the worker");
        assert!(matches!(rx.try_recv(), Err(std::sync::mpsc::TryRecvError::Disconnected)), "the worker let go of the emitter");
    }

    #[test]
    fn drain_keeps_pending_since_when_accumulator_already_nonempty() {
        // Chunks joining an in-progress accumulation must NOT push the flush
        // deadline out — the oldest pending byte's age is what bounds latency.
        let (tx, rx) = std::sync::mpsc::channel::<Vec<f32>>();
        tx.send(vec![0.5_f32; 100]).unwrap();
        let mut pending: Vec<u8> = vec![0u8; 64];
        let mut pending_since = stale_instant();
        drain_backlog_capped(&rx, &mut pending, &mut pending_since, |_| {});
        assert!(pending_since.elapsed() >= Duration::from_secs(5), "stamp must not reset");
    }
}
