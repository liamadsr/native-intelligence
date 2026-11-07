/// Platform-specific system audio capture.
///
/// - macOS: Uses a Swift sidecar process that captures via Core Audio Taps
///   and streams 16kHz mono PCM float32 to stdout.
/// - Windows: WASAPI process loopback of everything playing EXCEPT Dial8's
///   own process tree (the Mac tap leaves out its own PID the same way, so
///   read-aloud never lands in a recording), 48 kHz stereo from the engine,
///   downmixed and resampled to 16 kHz mono here ([`windows_loopback`]).

use crate::sidecar::NoConsole;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use super::types::{TARGET_CHANNELS, TARGET_SAMPLE_RATE};
use super::wav_writer::WavWriter;

pub type SampleCallback = Arc<Mutex<Option<Box<dyn Fn(&[f32]) + Send>>>>;

pub struct SystemCapture {
    is_capturing: Arc<AtomicBool>,
    /// The sidecar's stream is being read: cleared by the reader thread when
    /// it ends (EOF: the sidecar exited, or a read error), which
    /// `is_capturing` alone never shows.
    alive: Arc<AtomicBool>,
    output_path: Option<PathBuf>,
    level: Arc<Mutex<f32>>,
    #[cfg(target_os = "macos")]
    sidecar_process: Option<Child>,
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    reader_thread: Option<thread::JoinHandle<()>>,
    #[cfg(target_os = "macos")]
    tap_id: u32,
    #[cfg(target_os = "macos")]
    aggregate_device_id: u32,
    wav_writer: Arc<Mutex<Option<WavWriter>>>,
    sample_callback: SampleCallback,
}

// FFI bindings to the Objective-C tap helper compiled via build.rs
#[cfg(target_os = "macos")]
extern "C" {
    fn tap_helper_is_available() -> bool;
    fn tap_helper_create(tap_id_out: *mut u32, device_uid_out: *mut *mut std::os::raw::c_char) -> u32;
    fn tap_helper_destroy(tap_id: u32, aggregate_device_id: u32);
}

impl SystemCapture {
    pub fn new() -> Self {
        Self {
            is_capturing: Arc::new(AtomicBool::new(false)),
            alive: Arc::new(AtomicBool::new(false)),
            output_path: None,
            level: Arc::new(Mutex::new(0.0)),
            #[cfg(target_os = "macos")]
            sidecar_process: None,
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            reader_thread: None,
            #[cfg(target_os = "macos")]
            tap_id: 0,
            #[cfg(target_os = "macos")]
            aggregate_device_id: 0,
            wav_writer: Arc::new(Mutex::new(None)),
            sample_callback: Arc::new(Mutex::new(None)),
        }
    }

    pub fn is_available() -> bool {
        if cfg!(target_os = "macos") {
            // Check if sidecar binary exists
            Self::sidecar_path().is_some()
        } else {
            // Process loopback needs Windows 10 2004 (build 19041) or later:
            // older ones record mic-only (Unavailable, not a failed start).
            #[cfg(target_os = "windows")]
            return crate::commands::system::windows_build().is_none_or(|build| build >= 19041);
            #[cfg(not(target_os = "windows"))]
            false
        }
    }

    pub fn start(&mut self, output_path: PathBuf) -> Result<(), String> {
        if self.is_capturing.load(Ordering::SeqCst) {
            return Err("Already capturing".into());
        }

        self.output_path = Some(output_path.clone());

        #[cfg(target_os = "macos")]
        {
            if let Err(e) = self.start_macos(Some(output_path)) {
                // Undo what it got to: stop() only runs for a capture that
                // started, so a tap created before the failure (a system-wide
                // mixdown coreaudiod keeps feeding) used to outlive it.
                self.cleanup_failed_start_macos();
                return Err(e);
            }
        }

        #[cfg(target_os = "windows")]
        {
            if let Err(e) = self.start_windows(Some(output_path)) {
                *self.wav_writer.lock().unwrap() = None;
                return Err(e);
            }
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            return Err("System audio capture not supported on this platform".into());
        }

        #[allow(unreachable_code)]
        {
            self.is_capturing.store(true, Ordering::SeqCst);
            Ok(())
        }
    }

    /// Start the tap as an echo reference only (a voice session on
    /// speakers, `voice::system_ref`): the samples reach the sample callback
    /// and nothing else, no WAV and no file. A failed start leaves nothing
    /// behind (the tap and the sidecar are torn down). Meeting captures use
    /// [`Self::start`], unchanged.
    pub fn start_reference_only(&mut self) -> Result<(), String> {
        if self.is_capturing.load(Ordering::SeqCst) {
            return Err("Already capturing".into());
        }
        self.output_path = None;

        #[cfg(target_os = "macos")]
        {
            if let Err(e) = self.start_macos(None) {
                self.cleanup_failed_start_macos();
                return Err(e);
            }
        }

        #[cfg(target_os = "windows")]
        {
            self.start_windows(None)?;
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            return Err("System audio capture as an echo reference is macOS and Windows only".into());
        }

        #[allow(unreachable_code)]
        {
            self.is_capturing.store(true, Ordering::SeqCst);
            Ok(())
        }
    }

    /// Undo what a failed [`Self::start_macos`] got to (either start).
    #[cfg(target_os = "macos")]
    fn cleanup_failed_start_macos(&mut self) {
        self.is_capturing.store(false, Ordering::SeqCst);
        *self.wav_writer.lock().unwrap() = None;
        if let Some(mut child) = self.sidecar_process.take() {
            let _ = Self::terminate_sidecar(&mut child);
        }
        if let Some(thread) = self.reader_thread.take() {
            let _ = thread.join();
        }
        if self.tap_id != 0 || self.aggregate_device_id != 0 {
            unsafe { tap_helper_destroy(self.tap_id, self.aggregate_device_id) };
            self.tap_id = 0;
            self.aggregate_device_id = 0;
        }
    }

    pub fn stop(&mut self) -> Result<Option<PathBuf>, String> {
        if !self.is_capturing.load(Ordering::SeqCst) {
            return Ok(None);
        }

        self.is_capturing.store(false, Ordering::SeqCst);

        #[cfg(target_os = "macos")]
        {
            self.stop_macos()?;
        }

        #[cfg(target_os = "windows")]
        {
            self.stop_windows()?;
        }

        // Finalize WAV file
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

        *self.level.lock().unwrap() = 0.0;

        Ok(path.or(self.output_path.take()))
    }

    pub fn pause(&self) {
        // Pausing is handled by ignoring samples in the reader thread
        // The sidecar continues streaming but we stop writing
    }

    pub fn resume(&self) {
        // Resume writing samples
    }

    pub fn current_level(&self) -> f32 {
        *self.level.lock().unwrap()
    }

    pub fn is_capturing(&self) -> bool {
        self.is_capturing.load(Ordering::SeqCst)
    }

    /// Started and the sidecar still delivering: its reader hasn't hit the
    /// end of its stream and the process hasn't exited (a coreaudiod
    /// restart, a crash). Used by the voice system tap to restart a dead one.
    pub fn sidecar_alive(&mut self) -> bool {
        if !self.is_capturing() || !self.alive.load(Ordering::SeqCst) {
            return false;
        }
        #[cfg(target_os = "macos")]
        {
            match self.sidecar_process.as_mut().map(|c| c.try_wait()) {
                Some(Ok(None)) => true,
                // Exited, or can't be asked.
                _ => false,
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            true
        }
    }

    /// Get an Arc handle to the current audio level, for reading from other threads.
    pub fn level_handle(&self) -> Arc<Mutex<f32>> {
        Arc::clone(&self.level)
    }

    /// Get an Arc handle to the WAV writer, for segment splitting from other threads.
    pub fn writer_handle(&self) -> Arc<Mutex<Option<WavWriter>>> {
        Arc::clone(&self.wav_writer)
    }

    /// Set a callback to observe audio samples as they arrive.
    /// Used by RecordingSession for silence detection and segmentation.
    pub fn set_sample_callback(&self, cb: Option<Box<dyn Fn(&[f32]) + Send>>) {
        *self.sample_callback.lock().unwrap() = cb;
    }

    /// Atomically swap the WAV writer to a new file path.
    /// Finalizes the current file and returns its path.
    /// The sidecar stream continues uninterrupted — only the output file changes.
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

    /// Get the path to the sidecar binary (shared resolver — bundled first).
    fn sidecar_path() -> Option<PathBuf> {
        crate::sidecar::path(crate::sidecar::SYSTEM_AUDIO_CAPTURE)
    }

    // --- macOS implementation (Swift sidecar) ---

    /// `output_path`: where the WAV goes (a meeting capture); `None` for an
    /// echo reference, which writes nothing.
    #[cfg(target_os = "macos")]
    fn start_macos(&mut self, output_path: Option<PathBuf>) -> Result<(), String> {
        // Ask TCC before creating anything. Tap creation can't tell us: it
        // succeeds even when kTCCServiceAudioCapture is denied, and the capture
        // then silently records zero-filled buffers — a "system audio" track of
        // pure silence reported as Capturing. A denied permission instead fails
        // fast here with a message containing "permission", which dual_stream
        // maps to SystemAudioStatus::PermissionDenied (the "Grant permission"
        // warning). NotDetermined / Unavailable / Granted proceed exactly as
        // before: for NotDetermined macOS prompts when the sidecar starts IO
        // (the frontend normally asks first, so that is only a fallback), and
        // Unavailable means we can't know, so we don't block on a guess.
        let perm = crate::permissions::system_audio_permission();
        crate::log_to_file(&format!(
            "[SystemCapture] system audio permission at start: {}",
            perm.as_str()
        ));
        if perm == crate::permissions::SystemAudioPermission::Denied {
            return Err("System audio permission denied — enable Dial8 under System Settings → Privacy & Security → Screen & System Audio Recording".into());
        }

        let sidecar_path = Self::sidecar_path()
            .ok_or("System audio capture sidecar not found. Build it with: cd sidecars/system-audio-capture && swift build")?;

        // Create the Core Audio Tap from the MAIN PROCESS (which has permission).
        // The sidecar can then read from the aggregate device without needing its own permission.
        let mut tap_id: u32 = 0;
        let mut device_uid_ptr: *mut std::os::raw::c_char = std::ptr::null_mut();

        let tap_result = unsafe {
            tap_helper_create(&mut tap_id, &mut device_uid_ptr)
        };

        if tap_result == 0 {
            return Err("Failed to create Core Audio Tap. Grant 'Screen & System Audio Recording' permission in System Settings.".into());
        }
        // Recorded at once, so a failure from here on can destroy it.
        self.tap_id = tap_id;

        let tap_uuid = if !device_uid_ptr.is_null() {
            let uid = unsafe { std::ffi::CStr::from_ptr(device_uid_ptr) }
                .to_string_lossy()
                .into_owned();
            unsafe { libc::free(device_uid_ptr as *mut _) };
            uid
        } else {
            return Err("Tap created but no UUID returned".into());
        };

        self.aggregate_device_id = 0; // Sidecar will create the aggregate device

        crate::log_to_file(&format!(
            "[SystemCapture] Tap created from main process: tap_id={}, uuid={}",
            tap_id, tap_uuid
        ));

        // Create WAV writer (not for an echo reference: it writes nothing)
        if let Some(output_path) = output_path.as_ref() {
            let writer = WavWriter::new(output_path, TARGET_SAMPLE_RATE, TARGET_CHANNELS)
                .map_err(|e| format!("Failed to create WAV writer: {}", e))?;
            *self.wav_writer.lock().unwrap() = Some(writer);
        }

        // Spawn sidecar process — it creates an aggregate device from the tap UUID
        // The tap was created by the main process (which has permission).
        // The sidecar can create an aggregate device from an existing tap.
        let mut child = Command::new(&sidecar_path)
            .no_console()
            .arg("capture-from-tap")
            .arg("--tap-uuid")
            .arg(&tap_uuid)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

        let stdout = child
            .stdout
            .take()
            .ok_or("Failed to get sidecar stdout")?;

        // Read sidecar stderr on a separate thread for diagnostics
        if let Some(stderr) = child.stderr.take() {
            thread::spawn(move || {
                use std::io::BufRead;
                let reader = std::io::BufReader::new(stderr);
                for line in reader.lines() {
                    match line {
                        Ok(l) => {
                            let msg = format!("[SystemCapture sidecar] {}", l);
                            eprintln!("{}", msg);
                            crate::log_to_file(&msg);
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        let is_capturing = Arc::clone(&self.is_capturing);
        let wav_writer = Arc::clone(&self.wav_writer);
        let level = Arc::clone(&self.level);
        let sample_callback = Arc::clone(&self.sample_callback);
        let alive = Arc::clone(&self.alive);
        alive.store(true, Ordering::SeqCst);
        // Set before the reader starts: its loop exits at once on false, and
        // start()/start_reference_only() only set it after this returns.
        self.is_capturing.store(true, Ordering::SeqCst);

        // Spawn reader thread to read PCM from sidecar stdout
        let reader_thread = thread::spawn(move || {
            Self::read_pcm_stream(stdout, is_capturing, wav_writer, level, sample_callback);
            alive.store(false, Ordering::SeqCst);
        });

        self.sidecar_process = Some(child);
        self.reader_thread = Some(reader_thread);

        let msg = format!("[SystemCapture] macOS system audio capture started via sidecar: {:?}", sidecar_path);
        eprintln!("{}", msg);
        crate::log_to_file(&msg);
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn stop_macos(&mut self) -> Result<(), String> {
        // Send SIGTERM to sidecar for graceful shutdown
        if let Some(ref mut child) = self.sidecar_process {
            match Self::terminate_sidecar(child) {
                Ok(status) => eprintln!("Sidecar exited with: {}", status),
                Err(e) => eprintln!("Failed to wait for sidecar: {}", e),
            }
        }
        self.sidecar_process = None;

        // Wait for reader thread to finish
        if let Some(thread) = self.reader_thread.take() {
            let _ = thread.join();
        }

        // Clean up the tap and aggregate device created by the main process
        if self.tap_id != 0 || self.aggregate_device_id != 0 {
            unsafe { tap_helper_destroy(self.tap_id, self.aggregate_device_id) };
            self.tap_id = 0;
            self.aggregate_device_id = 0;
        }

        let msg = "macOS system audio capture stopped";
        eprintln!("{}", msg);
        crate::log_to_file(msg);
        Ok(())
    }

    /// SIGTERM the sidecar and wait up to 3 s for it to exit, then SIGKILL.
    /// A sidecar that never exits would otherwise hang stop forever (and the
    /// reader thread with it, blocked on a pipe that never closes).
    #[cfg(target_os = "macos")]
    fn terminate_sidecar(
        child: &mut std::process::Child,
    ) -> std::io::Result<std::process::ExitStatus> {
        // Already reaped (sidecar_alive's try_wait): its pid may be reused,
        // so it must not be signalled.
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        unsafe {
            libc::kill(child.id() as i32, libc::SIGTERM);
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            if let Some(status) = child.try_wait()? {
                return Ok(status);
            }
            thread::sleep(std::time::Duration::from_millis(50));
        }
        crate::log_to_file("[SystemCapture] sidecar ignored SIGTERM for 3 s, killing it");
        let _ = child.kill();
        child.wait()
    }

    /// Read raw PCM float32 bytes from the sidecar stdout pipe
    /// and write them to the WAV file.
    #[cfg(target_os = "macos")]
    fn read_pcm_stream(
        mut stdout: std::process::ChildStdout,
        is_capturing: Arc<AtomicBool>,
        wav_writer: Arc<Mutex<Option<WavWriter>>>,
        level: Arc<Mutex<f32>>,
        sample_callback: SampleCallback,
    ) {
        // 4096 bytes = 1024 float32 samples = ~64ms at 16kHz
        let mut buf = [0u8; 4096];
        // Bytes of a float split across two reads, kept at the front of buf.
        // The sidecar's writes are bigger than PIPE_BUF, so a read can end
        // mid-sample; dropping those bytes would misalign every later sample.
        let mut carry: usize = 0;
        let mut sample_count: u64 = 0;
        let mut total_bytes: u64 = 0;

        crate::log_to_file("[SystemCapture] PCM reader thread started, waiting for data...");

        loop {
            if !is_capturing.load(Ordering::SeqCst) {
                crate::log_to_file("[SystemCapture] PCM reader: is_capturing=false, exiting");
                break;
            }

            match stdout.read(&mut buf[carry..]) {
                Ok(0) => {
                    // EOF - sidecar exited
                    crate::log_to_file(&format!(
                        "[SystemCapture] PCM reader: EOF (sidecar exited). Total bytes read: {}",
                        total_bytes
                    ));
                    break;
                }
                Ok(n) => {
                    total_bytes += n as u64;
                    if total_bytes == n as u64 {
                        crate::log_to_file(&format!(
                            "[SystemCapture] First PCM data received: {} bytes",
                            n
                        ));
                    }
                    // Convert bytes to f32 samples
                    let (samples, left) = take_f32le(&mut buf, carry + n);
                    carry = left;
                    if samples.is_empty() {
                        continue;
                    }

                    // Calculate RMS level (~20Hz update rate)
                    sample_count += samples.len() as u64;
                    // Log every ~5 seconds (16000 samples/sec * 5 = 80000)
                    if sample_count % 80000 < samples.len() as u64 {
                        let rms_log: f32 = if samples.is_empty() { 0.0 } else {
                            let sum: f32 = samples.iter().map(|s| s * s).sum();
                            (sum / samples.len() as f32).sqrt()
                        };
                        crate::log_to_file(&format!(
                            "[SystemCapture] samples={}, total_bytes={}, rms={:.6}",
                            sample_count, total_bytes, rms_log
                        ));
                    }
                    if sample_count % 800 < samples.len() as u64 {
                        // ~20Hz at 16kHz
                        let rms = if samples.is_empty() {
                            0.0
                        } else {
                            let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
                            (sum_sq / samples.len() as f32).sqrt()
                        };
                        *level.lock().unwrap() = rms;
                    }

                    // Write to WAV
                    if let Ok(mut guard) = wav_writer.lock() {
                        if let Some(ref mut writer) = *guard {
                            let _ = writer.write_samples(&samples);
                        }
                    }

                    // Notify sample observer (for silence detection / segmentation)
                    if let Ok(guard) = sample_callback.lock() {
                        if let Some(ref cb) = *guard {
                            cb(&samples);
                        }
                    }
                }
                Err(e) => {
                    if e.kind() != std::io::ErrorKind::Interrupted {
                        eprintln!("Error reading sidecar stdout: {}", e);
                        break;
                    }
                }
            }
        }

        eprintln!("PCM reader thread exiting");
    }

    // --- Windows implementation (WASAPI process loopback) ---

    /// `output_path`: where the WAV goes (a meeting capture); `None` for an
    /// echo reference, which writes nothing. Returns once the stream runs, or
    /// with why it couldn't start (nothing left behind).
    #[cfg(target_os = "windows")]
    fn start_windows(&mut self, output_path: Option<PathBuf>) -> Result<(), String> {
        if let Some(output_path) = output_path.as_ref() {
            let writer = WavWriter::new(output_path, TARGET_SAMPLE_RATE, TARGET_CHANNELS)
                .map_err(|e| format!("Failed to create WAV writer: {}", e))?;
            *self.wav_writer.lock().unwrap() = Some(writer);
        }
        let is_capturing = Arc::clone(&self.is_capturing);
        let wav_writer = Arc::clone(&self.wav_writer);
        let level = Arc::clone(&self.level);
        let sample_callback = Arc::clone(&self.sample_callback);
        let alive = Arc::clone(&self.alive);
        alive.store(true, Ordering::SeqCst);
        // Set before the loop starts: it exits at once on false.
        self.is_capturing.store(true, Ordering::SeqCst);

        // This start's own token: a start that timed out is cancelled, so if
        // its activation completes later it never runs beside a newer capture
        // (the same writer, callback and `alive`).
        let live = Arc::new(AtomicBool::new(true));
        let thread_live = Arc::clone(&live);
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let spawned = thread::Builder::new().name("system-audio".into()).spawn(move || {
            windows_loopback::run(&is_capturing, &thread_live, &wav_writer, &level, &sample_callback, ready_tx);
            if thread_live.load(Ordering::SeqCst) {
                alive.store(false, Ordering::SeqCst);
            }
        });
        let thread = match spawned {
            Ok(t) => t,
            Err(e) => {
                self.is_capturing.store(false, Ordering::SeqCst);
                self.alive.store(false, Ordering::SeqCst);
                return Err(format!("Failed to start the system audio thread: {e}"));
            }
        };
        let started = ready_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap_or_else(|_| Err("System audio capture didn't start within 5 s".into()));
        if let Err(e) = started {
            // Cancelled: a thread stuck in activation is left to finish on its
            // own rather than block this start, and ends without capturing.
            live.store(false, Ordering::SeqCst);
            self.is_capturing.store(false, Ordering::SeqCst);
            self.alive.store(false, Ordering::SeqCst);
            let msg = format!("[SystemCapture] Windows loopback failed to start: {e}");
            eprintln!("{}", msg);
            crate::log_to_file(&msg);
            return Err(e);
        }
        self.reader_thread = Some(thread);
        crate::log_to_file("[SystemCapture] Windows system audio capture started (process loopback, Dial8 excluded)");
        Ok(())
    }

    #[cfg(target_os = "windows")]
    fn stop_windows(&mut self) -> Result<(), String> {
        // is_capturing is already false (stop()); the loop wakes at least
        // every WAIT_MS and ends.
        if let Some(thread) = self.reader_thread.take() {
            let _ = thread.join();
        }
        crate::log_to_file("[SystemCapture] Windows system audio capture stopped");
        Ok(())
    }
}

/// Interleaved little-endian f32 frames of `channels` → mono (their mean),
/// appended to `out`. A trailing partial frame is ignored.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn downmix_f32le(bytes: &[u8], channels: usize, out: &mut Vec<f32>) {
    let channels = channels.max(1);
    for frame in bytes.chunks_exact(4 * channels) {
        let sum: f32 = frame.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).sum();
        out.push(sum / channels as f32);
    }
}

/// Frames of silence to write when no packets came: the track's frames
/// `emitted` are behind the wall clock's `due` by more than `gap` (Windows
/// delivers nothing while nothing plays, and the system track must keep time
/// with the mic's). Zero otherwise.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn silence_owed(due: u64, emitted: u64, gap: u64) -> u64 {
    match due.checked_sub(emitted) {
        Some(behind) if behind > gap => behind,
        _ => 0,
    }
}

/// RMS of `samples` (0 for none).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

#[cfg(target_os = "windows")]
mod windows_loopback {
    use super::*;
    use crate::audio::resample::StreamResampler;
    use std::collections::VecDeque;
    use std::time::Instant;

    /// What the engine is asked for (autoconvert): its mix rate on most PCs.
    const RATE: usize = 48_000;
    const CHANNELS: usize = 2;
    /// The longest wait for a packet before checking `is_capturing` again.
    pub(super) const WAIT_MS: u32 = 100;
    /// Behind the clock by more than this with no packets: silence is owed.
    const GAP_FRAMES: u64 = TARGET_SAMPLE_RATE as u64 / 5; // 200 ms

    pub(super) fn run(
        is_capturing: &AtomicBool,
        live: &AtomicBool,
        wav_writer: &Mutex<Option<WavWriter>>,
        level: &Mutex<f32>,
        sample_callback: &SampleCallback,
        ready: std::sync::mpsc::Sender<Result<(), String>>,
    ) {
        let setup = (|| -> Result<_, String> {
            wasapi::initialize_mta().ok().map_err(|e| format!("COM: {e}"))?;
            let format = wasapi::WaveFormat::new(32, 32, &wasapi::SampleType::Float, RATE, CHANNELS, None);
            // Everything playing but this process tree.
            let mut client = wasapi::AudioClient::new_application_loopback_client(std::process::id(), false)
                .map_err(|e| format!("process loopback: {e}"))?;
            let mode = wasapi::StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 };
            client
                .initialize_client(&format, &wasapi::Direction::Capture, &mode)
                .map_err(|e| format!("process loopback init: {e}"))?;
            let event = client.set_get_eventhandle().map_err(|e| format!("event: {e}"))?;
            let capture = client.get_audiocaptureclient().map_err(|e| format!("capture client: {e}"))?;
            let resampler = StreamResampler::new(RATE as u32, TARGET_SAMPLE_RATE)?;
            client.start_stream().map_err(|e| format!("start: {e}"))?;
            Ok((client, event, capture, resampler, format.get_blockalign() as usize))
        })();
        let (client, event, capture, mut resampler, block_align) = match setup {
            // Its start gave up waiting (cancelled): stop without capturing.
            Ok((client, ..)) if !live.load(Ordering::SeqCst) => {
                let _ = client.stop_stream();
                return;
            }
            Ok(parts) => {
                let _ = ready.send(Ok(()));
                parts
            }
            Err(e) => {
                let _ = ready.send(Err(e));
                return;
            }
        };

        let mut queue: VecDeque<u8> = VecDeque::new();
        let mut bytes: Vec<u8> = Vec::new();
        let mut mono: Vec<f32> = Vec::new();
        let mut out: Vec<f32> = Vec::new();
        let started = Instant::now();
        let mut emitted: u64 = 0;
        let mut since_level: u64 = 0;

        'capture: while is_capturing.load(Ordering::SeqCst) && live.load(Ordering::SeqCst) {
            let signalled = event.wait_for_event(WAIT_MS).is_ok();
            loop {
                match capture.get_next_packet_size() {
                    Ok(Some(n)) if n > 0 => {}
                    Ok(_) => break,
                    Err(e) => {
                        crate::log_to_file(&format!("[SystemCapture] loopback packet size failed: {e}"));
                        break 'capture;
                    }
                }
                let before = queue.len();
                match capture.read_from_device_to_deque(&mut queue) {
                    // A silent packet's bytes are undefined: zeros.
                    Ok(info) if info.flags.silent => queue.range_mut(before..).for_each(|b| *b = 0),
                    Ok(_) => {}
                    Err(e) => {
                        crate::log_to_file(&format!("[SystemCapture] loopback read failed: {e}"));
                        break 'capture;
                    }
                }
            }

            out.clear();
            let whole = queue.len() / block_align * block_align;
            if whole > 0 {
                bytes.clear();
                bytes.extend(queue.drain(..whole));
                mono.clear();
                downmix_f32le(&bytes, CHANNELS, &mut mono);
                resampler.process(&mono, &mut out);
            } else if !signalled {
                let due = (started.elapsed().as_secs_f64() * TARGET_SAMPLE_RATE as f64) as u64;
                let owed = silence_owed(due, emitted, GAP_FRAMES);
                out.resize(owed as usize, 0.0);
            }
            if out.is_empty() {
                continue;
            }
            emitted += out.len() as u64;
            since_level += out.len() as u64;
            if since_level >= 800 {
                // ~20 Hz at 16 kHz, as the Mac reader
                since_level = 0;
                *level.lock().unwrap() = rms(&out);
            }
            if let Ok(mut guard) = wav_writer.lock() {
                if let Some(ref mut writer) = *guard {
                    let _ = writer.write_samples(&out);
                }
            }
            if let Ok(guard) = sample_callback.lock() {
                if let Some(ref cb) = *guard {
                    cb(&out);
                }
            }
        }
        let _ = client.stop_stream();
    }
}

/// Decode the whole little-endian f32s in `buf[..filled]` and move the 0–3
/// bytes of a trailing partial sample to the front of `buf`, returning the
/// samples and how many bytes were kept.
fn take_f32le(buf: &mut [u8], filled: usize) -> (Vec<f32>, usize) {
    let whole = filled / 4 * 4;
    let samples = buf[..whole]
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    let left = filled - whole;
    buf.copy_within(whole..filled, 0);
    (samples, left)
}

#[cfg(test)]
mod tests {
    use super::{downmix_f32le, silence_owed, take_f32le};

    /// A sidecar that exits ends its reader (EOF), which is what clears
    /// `alive` for the voice tap's restart; a new capture reports dead.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_reader_ends_when_the_sidecar_exits_and_a_fresh_capture_is_not_alive() {
        use super::*;
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg("printf '\\000\\000\\200\\077'")
            .stdout(Stdio::piped())
            .spawn()
            .expect("sh runs");
        let stdout = child.stdout.take().unwrap();
        let got = Arc::new(Mutex::new(Vec::<f32>::new()));
        let cb: SampleCallback = Arc::new(Mutex::new(None));
        let g = got.clone();
        *cb.lock().unwrap() = Some(Box::new(move |s: &[f32]| g.lock().unwrap().extend_from_slice(s)));
        SystemCapture::read_pcm_stream(
            stdout,
            Arc::new(AtomicBool::new(true)),
            Arc::new(Mutex::new(None)),
            Arc::new(Mutex::new(0.0)),
            cb,
        );
        let _ = child.wait();
        assert_eq!(*got.lock().unwrap(), vec![1.0], "read to the end, then returned");
        assert!(!SystemCapture::new().sidecar_alive());
    }

    #[test]
    fn stereo_frames_downmix_to_their_mean_and_a_partial_frame_waits() {
        let mut bytes = Vec::new();
        for v in [0.5f32, -0.5, 1.0, 0.0, 0.25, 0.75] {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        bytes.extend_from_slice(&[0, 0]); // half a sample: not a frame
        let mut out = Vec::new();
        downmix_f32le(&bytes, 2, &mut out);
        assert_eq!(out, vec![0.0, 0.5, 0.5]);
    }

    #[test]
    fn silence_is_owed_only_past_the_gap() {
        assert_eq!(silence_owed(16_000, 16_000, 3_200), 0, "on time");
        assert_eq!(silence_owed(16_000, 14_000, 3_200), 0, "a small lag is the resampler's, not silence");
        assert_eq!(silence_owed(32_000, 16_000, 3_200), 16_000, "a second with no packets");
        assert_eq!(silence_owed(10_000, 16_000, 3_200), 0, "ahead of the clock");
    }

    #[test]
    fn a_sample_split_across_reads_is_kept_not_dropped() {
        let want: Vec<f32> = (0..300).map(|i| i as f32 * 0.25 - 7.0).collect();
        let bytes: Vec<u8> = want.iter().flat_map(|s| s.to_le_bytes()).collect();
        // Reads that end mid-sample (sizes not a multiple of 4), like a pipe
        // delivering part of a write larger than PIPE_BUF.
        let mut buf = [0u8; 64];
        let (mut carry, mut at, mut got) = (0usize, 0usize, Vec::new());
        for (i, &size) in [5usize, 3, 13, 1, 22, 7, 30].iter().cycle().enumerate() {
            if at >= bytes.len() {
                break;
            }
            let n = size.min(bytes.len() - at).min(buf.len() - carry);
            buf[carry..carry + n].copy_from_slice(&bytes[at..at + n]);
            at += n;
            let (samples, left) = take_f32le(&mut buf, carry + n);
            assert!(left < 4, "read {i} kept {left} bytes");
            carry = left;
            got.extend(samples);
        }
        assert_eq!(carry, 0);
        assert_eq!(got, want);
    }
}
