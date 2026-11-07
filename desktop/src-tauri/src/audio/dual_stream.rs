/// Dual-stream recording manager — coordinates mic + system audio capture.
///
/// Mirrors DualStreamRecordingService.swift from the native app.

use std::path::PathBuf;
use std::time::Instant;

use super::input_devices::InputTarget;
use super::mic_capture::MicCapture;
use super::system_capture::SystemCapture;
use super::types::SystemAudioStatus;

#[derive(Debug, Clone, PartialEq)]
pub enum DualStreamState {
    Inactive,
    Starting,
    Recording,
    Stopping,
}

pub struct DualStreamManager {
    pub state: DualStreamState,
    pub recording_start_time: Option<Instant>,
    session_dir: Option<PathBuf>,
}

impl DualStreamManager {
    pub fn new() -> Self {
        Self {
            state: DualStreamState::Inactive,
            recording_start_time: None,
            session_dir: None,
        }
    }

    /// Start dual-stream recording.
    ///
    /// Returns the actual system-audio outcome so the caller can tell the user
    /// when a requested system stream didn't engage (no permission, no backend,
    /// or a runtime failure) instead of silently recording mic-only. The mic
    /// stream is always required; only its failure aborts the start.
    ///
    /// A failed start leaves the manager Inactive, never Starting. Nothing
    /// else ever moves the state out of Starting — stop() acts only on
    /// Recording, and the reclaim / reset_recording_state teardowns call it only
    /// while recording — and the guard below rejects every start that isn't
    /// from Inactive, so a start that failed half-way used to wedge every later
    /// capture ("Cannot start: state is Starting") until the app restarted.
    /// That failure is on the common path now that a stale mic stream is
    /// reopened instead of replayed: a named device that went away while idle,
    /// no input device at all, a default device that fails to open.
    pub fn start(
        &mut self,
        mic: &mut MicCapture,
        system: &mut SystemCapture,
        session_dir: PathBuf,
        mic_device: Option<&InputTarget>,
        capture_system_audio: bool,
    ) -> Result<SystemAudioStatus, String> {
        if self.state != DualStreamState::Inactive {
            return Err(format!("Cannot start: state is {:?}", self.state));
        }

        self.state = DualStreamState::Starting;
        match self.start_inner(mic, system, session_dir, mic_device, capture_system_audio) {
            Ok(system_status) => {
                self.state = DualStreamState::Recording;
                Ok(system_status)
            }
            Err(e) => {
                // Undo everything start_inner may have set before it failed,
                // so the next start begins from a clean Inactive.
                self.state = DualStreamState::Inactive;
                self.recording_start_time = None;
                self.session_dir = None;
                Err(e)
            }
        }
    }

    /// start()'s body, run in state Starting. Every Err from here is rolled
    /// back to Inactive by start(), so an early `?` return is always safe.
    fn start_inner(
        &mut self,
        mic: &mut MicCapture,
        system: &mut SystemCapture,
        session_dir: PathBuf,
        mic_device: Option<&InputTarget>,
        capture_system_audio: bool,
    ) -> Result<SystemAudioStatus, String> {
        self.session_dir = Some(session_dir.clone());

        std::fs::create_dir_all(&session_dir)
            .map_err(|e| format!("Failed to create session dir: {}", e))?;

        let start_time = Instant::now();
        self.recording_start_time = Some(start_time);

        // Start mic capture (required — abort the whole start if it fails).
        // A picked device that won't open (gone since it was resolved, or
        // refusing) falls back to the system default, as the voice start
        // does. A failed start leaves no stream open for the device (the
        // reopen path retired it first) and no writer (it is created after
        // the stream), so the retry starts clean.
        let mic_path = session_dir.join("mic.wav");
        if let Err(e) = mic.start(mic_device, Some(mic_path.clone())) {
            let Some(target) = mic_device else { return Err(e) };
            let msg = format!("[DualStream] mic {:?} failed ({}); falling back to the system default", target.name, e);
            eprintln!("{}", msg);
            crate::log_to_file(&msg);
            mic.start(None, Some(mic_path))?;
        }

        // Start system audio capture if requested. Each failure mode maps to a
        // distinct status so the UI can react appropriately (prompt for
        // permission vs. warn that no backend is available).
        //
        // We do NOT preflight with CGPreflightScreenCaptureAccess here: our taps
        // need the "Audio Capture" TCC permission, which is SEPARATE from Screen
        // Recording, so that preflight can wrongly report denied even when the
        // tap would succeed (and vice-versa) — the source of the "randomly lost
        // permission → mic only" reports. The RIGHT service is checked inside
        // system.start() instead (TCCAccessPreflight on kTCCServiceAudioCapture,
        // see crate::permissions): a denied status fails fast with a
        // "permission" error before any tap exists. That check has to exist
        // because tap creation itself succeeds even when the permission is
        // denied — macOS enforces it only when IO starts, and a denied capture
        // just records zero-filled buffers. Both that error and a tap-creation
        // failure (with the sidecar present, on 14.4+) map to PermissionDenied
        // — which surfaces the "Grant access" UI — and Failed is reserved for
        // everything else.
        let system_status = if !capture_system_audio {
            SystemAudioStatus::Disabled
        } else if !SystemCapture::is_available() {
            let msg = "[DualStream] System audio requested but backend unavailable (sidecar missing). Recording mic-only.";
            eprintln!("{}", msg);
            crate::log_to_file(msg);
            SystemAudioStatus::Unavailable
        } else {
            let system_path = session_dir.join("system.wav");
            match system.start(system_path) {
                Ok(()) => SystemAudioStatus::Capturing,
                Err(e) => {
                    // Tap-creation failures carry the "Grant ... permission"
                    // message from start_macos; treat those as PermissionDenied
                    // so the UI offers the grant flow. Anything else is a genuine
                    // post-permission failure.
                    let is_permission = e.contains("Core Audio Tap")
                        || e.to_lowercase().contains("permission");
                    let status = if is_permission {
                        SystemAudioStatus::PermissionDenied
                    } else {
                        SystemAudioStatus::Failed
                    };
                    let msg = format!(
                        "[DualStream] System audio capture failed to start ({:?}, continuing mic-only): {}",
                        status, e
                    );
                    eprintln!("{}", msg);
                    crate::log_to_file(&msg);
                    status
                }
            }
        };

        Ok(system_status)
    }

    /// Stop dual-stream recording
    pub fn stop(
        &mut self,
        mic: &mut MicCapture,
        system: &mut SystemCapture,
    ) -> Result<(Option<PathBuf>, Option<PathBuf>), String> {
        if self.state != DualStreamState::Recording {
            return Err("Not recording".into());
        }

        self.state = DualStreamState::Stopping;

        // Stop BOTH streams before looking at either result, and always land
        // in Inactive. A mic.stop() error (a WAV finalize failure — this is a
        // temp-dir write, and disks do fill up) used to return early with the
        // state stuck at Stopping, so every later start failed "Cannot start:
        // state is Stopping" until the app was relaunched — and system.stop()
        // never ran, leaving the sidecar and its Core Audio tap capturing
        // after the user had pressed stop. The first error is still reported.
        let mic_result = mic.stop();
        let system_result = system.stop();

        self.state = DualStreamState::Inactive;
        self.recording_start_time = None;
        self.session_dir = None;

        let mic_path = mic_result?;
        let system_path = system_result?;

        Ok((mic_path, system_path))
    }

    /// Pause both streams
    pub fn pause(&self, mic: &MicCapture, system: &SystemCapture) {
        mic.pause();
        system.pause();
    }

    /// Resume both streams
    pub fn resume(&self, mic: &MicCapture, system: &SystemCapture) {
        mic.resume();
        system.resume();
    }

    /// Get elapsed recording time in seconds
    pub fn elapsed_seconds(&self) -> f64 {
        self.recording_start_time
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(0.0)
    }

    pub fn is_recording(&self) -> bool {
        self.state == DualStreamState::Recording
    }
}
