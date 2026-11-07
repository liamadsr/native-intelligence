use tauri::{AppHandle, State, WebviewWindow};

use crate::audio::input_devices;
use crate::audio::session::RecordingSession;
use crate::audio::types::*;
use crate::state::AppState;

/// Run an input-device command off the main thread. They read CoreAudio's
/// device list, which blocks forever while coreaudiod is stuck
/// (audio::health), and a sync command runs on the main thread: one stuck
/// read there freezes every window. While the daemon is known to be stuck
/// they fail at once instead.
async fn input_devices_off_main<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    crate::audio::health::ensure_responsive()?;
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("input-devices task failed: {e}"))?
}

/// Every input device Dial8 has seen, in priority order (Settings →
/// Recording → Microphone). Takes no AppState lock.
#[tauri::command]
pub async fn list_input_devices(app_handle: AppHandle) -> Result<input_devices::Snapshot, String> {
    input_devices_off_main(move || Ok(input_devices::list(&app_handle))).await
}

/// Save a new priority order (device ids = CoreAudio UIDs, highest first)
/// and mark the list customised. Unknown ids are ignored; known ones left
/// out keep their relative order after the given ones.
#[tauri::command]
pub async fn set_input_priority(app_handle: AppHandle, ids: Vec<String>) -> Result<input_devices::Snapshot, String> {
    input_devices_off_main(move || Ok(input_devices::set_order(&app_handle, &ids))).await
}

/// Back to the system default input; the list is kept.
#[tauri::command]
pub async fn reset_input_priority(app_handle: AppHandle) -> Result<input_devices::Snapshot, String> {
    input_devices_off_main(move || Ok(input_devices::reset(&app_handle))).await
}

/// Remove a disconnected device from the list (an error for a connected one).
#[tauri::command]
pub async fn forget_input_device(app_handle: AppHandle, id: String) -> Result<input_devices::Snapshot, String> {
    input_devices_off_main(move || input_devices::forget_device(&app_handle, &id)).await
}

/// Use this mic "for now" (`id`, a CoreAudio UID; null clears it) without
/// reordering the saved list. Never saved: cleared by null, by the mic
/// disconnecting, or by quitting. An unknown or disconnected id is an
/// error; the mic the order would open anyway clears it. A running meeting
/// capture switches at once; a running voice session keeps its mic. Takes
/// no AppState lock.
#[tauri::command]
pub async fn set_input_override(app_handle: AppHandle, id: Option<String>) -> Result<input_devices::Snapshot, String> {
    input_devices_off_main(move || input_devices::set_override(&app_handle, id)).await
}

/// The recording commands below used to be sync, so they ran on the main
/// thread, one at a time. They open and close the mic and the system-audio
/// tap, which blocks forever while coreaudiod is stuck (audio::health), so
/// they run on the blocking pool now; this keeps them one at a time.
static RECORDING_OPS: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Run a recording command's body off the main thread, one at a time. With
/// `touches_devices`, ask coreaudiod first (health::ensure_answering): a
/// stuck daemon fails the command in seconds instead of hanging it with the
/// recording locks held.
async fn recording_op<T: Send + 'static>(
    touches_devices: bool,
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if touches_devices {
            crate::audio::health::ensure_answering()?;
        }
        let _one_at_a_time = RECORDING_OPS.lock().unwrap_or_else(|p| p.into_inner());
        f()
    })
    .await
    .map_err(|e| format!("recording task failed: {e}"))?
}

#[tauri::command]
pub async fn start_recording(
    app_handle: AppHandle,
    window: WebviewWindow,
    capture_system_audio: bool,
    // "local" asks for on-device transcription (local-stt module); anything
    // else, or an older frontend that doesn't send it, means Deepgram.
    transcription: Option<String>,
) -> Result<RecordingSessionInfo, String> {
    let window_label = window.label().to_string();
    let tray = app_handle.clone();
    let started = recording_op(true, move || {
        use tauri::Manager;
        let state = app_handle.state::<AppState>();
        start_recording_blocking(&state, app_handle.clone(), &window_label, capture_system_audio, transcription)
    })
    .await;
    // The menu bar's "● Rec" shows now, not at the next tick (after the
    // recording_window guard is dropped, or the check sees it busy).
    crate::tray::refresh_mic(&tray);
    started
}

fn start_recording_blocking(
    state: &AppState,
    app_handle: AppHandle,
    window_label: &str,
    capture_system_audio: bool,
    transcription: Option<String>,
) -> Result<RecordingSessionInfo, String> {
    use tauri::Manager;

    // Never read aloud over a meeting: every recording start silences
    // local-tts first (tts_speak refuses while a recording is live).
    crate::modules::tts::cancel_for_recording(&app_handle);

    // Ownership decision. Only one window can record at a time (mic + system
    // audio are shared devices). BUT a stale owner is common: after a WebView
    // freeze/reload the Rust process survives with recording_window still set,
    // and the resumed page's fresh start_recording would be rejected forever,
    // leaving live transcription dead. So we RECLAIM instead of blanket-reject
    // when the owner is stale — meaning either the SAME window is re-requesting
    // (label is stable across a WebView reload) or the prior owner window no
    // longer exists. We only reject when a DIFFERENT, still-live window owns it
    // (the genuine "two windows fighting over the mic" case the guard protects).
    let mut reclaim_stale = false;
    {
        let recording_window = state.recording_window.lock().unwrap();
        if let Some(ref owner) = *recording_window {
            let same_window = owner == window_label;
            let owner_alive = app_handle.get_webview_window(owner).is_some();
            let dual_recording = state.dual_stream.lock().unwrap().is_recording();
            let current_session = state.current_session.lock().unwrap().clone();
            crate::log_to_file(&format!(
                "[start_recording] window_guard owner={:?} requester={} same={} owner_alive={} dual_recording={} current_session={:?}",
                owner, window_label, same_window, owner_alive, dual_recording, current_session
            ));
            if same_window || !owner_alive {
                crate::log_to_file(&format!(
                    "[start_recording] reclaiming stale recording_window owner={} (same={}, owner_alive={})",
                    owner, same_window, owner_alive
                ));
                reclaim_stale = true;
            } else {
                crate::log_to_file(
                    "[start_recording] REJECTED — capture owned by a different live window",
                );
                return Err(format!(
                    "A capture is already active in window \"{}\". Stop it before starting a new one.",
                    owner
                ));
            }
        }
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    let started_at = chrono::Utc::now().to_rfc3339();

    // The mic, from the Input Device Priority list (None = the system
    // default). Resolved before any AppState lock below: it reads the
    // plugin store, which has its own mutex.
    let mic_device = input_devices::resolve(&app_handle);

    crate::log_to_file(&format!(
        "[start_recording] mic={:?}, system={}, window={}",
        mic_device.as_ref().map(|t| &t.name), capture_system_audio, window_label
    ));

    // Persist audio preferences for next session
    crate::settings::set_capture_system_audio(&app_handle, capture_system_audio);

    // Create temp directory for this recording session
    let session_dir = std::env::temp_dir().join("dial8").join(&session_id);

    // Use dual-stream manager for coordinated start
    let mut dual = state.dual_stream.lock().unwrap();
    // Meeting capture wins over chat voice: end any voice session and free
    // the mic before taking it. Under the dual-stream lock (voice_start holds
    // it while it checks for a capture and starts the mic), so no voice
    // session can start between this and dual.start below.
    crate::voice::end_for_recording(&app_handle);
    let mut mic = state.mic_capture.lock().unwrap();
    let mut system = state.system_capture.lock().unwrap();

    // Reclaiming a stale owner: tear down the prior in-memory session FIRST so
    // dual.start (which rejects unless state == Inactive) can proceed. Done here,
    // under the same dual/mic/system guards we already hold, so there is no
    // re-locking and no deadlock. Best-effort: dual.stop finalizes any prior WAV
    // and a failure is logged but never aborts the fresh start.
    if reclaim_stale {
        let prior_session = state.session.lock().unwrap().take();
        if let Some(mut session) = prior_session {
            session.stop(&mic, &system);
        }
        if dual.is_recording() {
            if let Err(e) = dual.stop(&mut mic, &mut system) {
                crate::log_to_file(&format!(
                    "[start_recording] reclaim: dual.stop on stale session failed (continuing): {}",
                    e
                ));
            }
        }
        *state.current_session.lock().unwrap() = None;
        *state.recording_window.lock().unwrap() = None;
        *state.sleep_guard.lock().unwrap() = None;
        crate::log_to_file("[start_recording] reclaim: stale session torn down");
    }

    let system_audio_status = dual
        .start(
            &mut mic,
            &mut system,
            session_dir,
            mic_device.as_ref(),
            capture_system_audio,
        )
        .map_err(|e| {
            crate::log_to_file(&format!("[start_recording] dual.start failed: {}", e));
            e
        })?;

    crate::log_to_file(&format!(
        "[start_recording] dual.start OK (system_audio={:?}), creating session...",
        system_audio_status
    ));

    // Local transcription: only when the module is enabled and ready. The
    // sidecar loads in the background while audio queues; if it fails later
    // the module emits `stt://engine-changed` and the web falls back.
    let (stt_sink, transcription_engine, transcription_fallback_reason) = match transcription.as_deref() {
        Some("local") => {
            let modules = app_handle.state::<crate::modules::ModuleManager>();
            match modules.launch_config(&app_handle, crate::modules::stt::MODULE_ID) {
                Some(launch) => (
                    Some(crate::modules::stt::start(&app_handle, launch, session_id.clone())),
                    "local",
                    None,
                ),
                None => (
                    None,
                    "deepgram",
                    Some("Local transcription isn't ready on this Mac".to_string()),
                ),
            }
        }
        _ => (None, "deepgram", None),
    };
    crate::log_to_file(&format!(
        "[start_recording] transcription requested={:?} engine={} reason={:?}",
        transcription, transcription_engine, transcription_fallback_reason
    ));

    // Echo cancellation (chat-voice.md §3.5): read at capture start, and only
    // when the system audio it cancels against is really being captured.
    let echo_setting = crate::settings::echo_cancellation_in_captures(&app_handle);
    let echo_cancellation =
        crate::audio::session::capture_echo_cancellation(echo_setting, system_audio_status);
    crate::log_to_file(&format!(
        "[start_recording] echo cancellation: setting={} system_audio={:?} → {}",
        echo_setting,
        system_audio_status,
        if echo_cancellation { "on" } else { "off" }
    ));

    // Create and start the recording session orchestrator
    let session = RecordingSession::start(
        app_handle,
        session_id.clone(),
        &mic,
        &system,
        stt_sink,
        echo_cancellation,
    )
    .map_err(|e| {
        crate::log_to_file(&format!("[start_recording] session.start failed: {}", e));
        e
    })?;

    crate::log_to_file("[start_recording] session started OK");
    *state.session.lock().unwrap() = Some(session);

    // Update state
    *state.current_session.lock().unwrap() = Some(session_id.clone());

    // Update meeting detector
    state.meeting_detector.lock().unwrap().recording_started();

    // Prevent idle sleep while recording
    *state.sleep_guard.lock().unwrap() = crate::sleep_guard::SleepGuard::new();

    // Track which window owns this recording
    *state.recording_window.lock().unwrap() = Some(window_label.to_string());

    Ok(RecordingSessionInfo {
        session_id,
        started_at,
        mic_device: mic_device.map(|t| t.name),
        capturing_system_audio: capture_system_audio,
        system_audio_status,
        transcription_engine: transcription_engine.to_string(),
        transcription_fallback_reason,
    })
}

/// Rebuild the mic input stream after a fault (device disconnect), on the
/// device the Input Device Priority list picks now (a vanished one is passed
/// over, and so is one that faults again right after being reopened; not
/// customised = the system default). Invoked by the frontend in
/// response to the `audio://mic-fault` event. Runs on the command thread
/// with the mic lock held — the controlled
/// context the persistent stream is meant to be mutated from — never from the
/// cpal error callback. Idempotent: a no-op if there is no active fault.
///
/// Only honored while a recording is live: recover_after_fault builds AND
/// PLAYS a fresh stream, so a fault latched on the idle paused stream (the
/// cpal error callback can fire any time the stream object exists) plus a
/// late recover call would otherwise open a live mic outside any recording —
/// with nothing to ever stop it.
#[tauri::command]
pub async fn recover_mic(app_handle: AppHandle) -> Result<(), String> {
    let tray = app_handle.clone();
    let recovered = recording_op(true, move || {
        use tauri::Manager;
        let state = app_handle.state::<AppState>();
        recover_mic_blocking(&state, &app_handle)
    })
    .await;
    crate::tray::refresh_mic(&tray);
    recovered
}

fn recover_mic_blocking(state: &AppState, app_handle: &AppHandle) -> Result<(), String> {
    let recording = state.dual_stream.lock().unwrap().is_recording();
    if !recording {
        crate::meeting_detection::mlog("recover_mic ignored — no active recording");
        return Ok(());
    }
    // Only a real fault counts against the device in use (a late or repeated
    // call must not mark a working mic as silent).
    let faulted = state.mic_capture.lock().unwrap().fault_handle().load(std::sync::atomic::Ordering::SeqCst);
    if !faulted {
        return Ok(());
    }
    // Resolved with no AppState lock held (the guards above are temporaries,
    // already dropped). A device that faults again right after being
    // reopened is passed over (input_devices::Suspects): a listed-but-silent
    // mic can't hold recovery in a loop.
    let target = input_devices::resolve_for_recovery(app_handle);
    let mut mic = state.mic_capture.lock().unwrap();
    mic.recover_after_fault(target.as_ref())
}

/// Best-effort teardown of any active recording, safe to call from outside the
/// normal stop path (e.g. when the recording-owner window is destroyed). Uses
/// `try_lock` throughout so it can NEVER block or deadlock the Tauri event
/// thread against an in-flight start_recording/stop_recording — if a lock is
/// held, that step is skipped. Finalizes the WAV via dual.stop when reachable.
pub(crate) fn reset_recording_state(state: &AppState) {
    // While coreaudiod is stuck (audio::health) the stops below never return,
    // and this runs on the event thread (a window closing, or quit): clear
    // the bookkeeping and leave the dead streams alone.
    if crate::audio::health::current() == crate::audio::health::Health::Unresponsive {
        crate::log_to_file(
            "[reset_recording_state] coreaudiod is stuck: skipping the audio teardown (it would never return)",
        );
    } else {
        let had_session = {
            if let Ok(mut guard) = state.session.try_lock() {
                guard.take()
            } else {
                None
            }
        };

        // try_lock only, so it can't deadlock whatever the order; still taken in
        // the app-wide order (dual stream → mic → system, voice/mod.rs).
        let dual = state.dual_stream.try_lock();
        if let (Ok(mut mic), Ok(mut system)) =
            (state.mic_capture.try_lock(), state.system_capture.try_lock())
        {
            if let Some(mut session) = had_session {
                session.stop(&mic, &system);
            }
            if let Ok(mut dual) = dual {
                if dual.is_recording() {
                    let _ = dual.stop(&mut mic, &mut system);
                }
            }
        }
    }

    if let Ok(mut g) = state.current_session.try_lock() {
        *g = None;
    }
    if let Ok(mut g) = state.recording_window.try_lock() {
        *g = None;
    }
    if let Ok(mut g) = state.sleep_guard.try_lock() {
        *g = None;
    }
    if let Ok(mut g) = state.meeting_detector.try_lock() {
        g.recording_stopped();
    }
    crate::log_to_file("[reset_recording_state] cleared recording state (best-effort)");
}

#[tauri::command]
pub async fn stop_recording(app_handle: AppHandle, window: WebviewWindow) -> Result<RecordingResult, String> {
    let window_label = window.label().to_string();
    let tray = app_handle.clone();
    let stopped = recording_op(true, move || {
        use tauri::Manager;
        let state = app_handle.state::<AppState>();
        stop_recording_blocking(&state, &window_label)
    })
    .await;
    crate::tray::refresh_mic(&tray);
    stopped
}

fn stop_recording_blocking(state: &AppState, window_label: &str) -> Result<RecordingResult, String> {
    // Only the window that started the recording can stop it
    {
        let recording_window = state.recording_window.lock().unwrap();
        if let Some(ref owner) = *recording_window {
            if owner != window_label {
                return Err(format!(
                    "Recording is owned by another window. Stop it from that window."
                ));
            }
        }
    }

    let session_id = state
        .current_session
        .lock()
        .unwrap()
        .take()
        .ok_or("No active recording session")?;

    // The app-wide lock order (voice/mod.rs): dual stream, then mic, then
    // system, then the session — the same as start_recording and the voice
    // start. Taking the mic first here could deadlock against a voice start
    // holding the dual stream and waiting for the mic.
    let mut dual = state.dual_stream.lock().unwrap();
    let mut mic = state.mic_capture.lock().unwrap();
    let mut system = state.system_capture.lock().unwrap();

    // Stop the session FIRST — this clears the sample callbacks so the
    // mic processor thread won't block on Tauri event emission during
    // shutdown. Without this, mic.stop() joins the processor thread
    // which may be stuck emitting events via the callback.
    let elapsed = {
        let mut session_guard = state.session.lock().unwrap();
        if let Some(mut session) = session_guard.take() {
            session.stop(&mic, &system)
        } else {
            0.0
        }
    };

    // No `?` yet: a failed stop (a WAV finalize on a full disk) has already
    // ended the capture and taken the session, so the cleanup below must
    // still run, or the sleep guard, window ownership and detector state
    // outlive it. The error is returned after.
    let stopped = dual.stop(&mut mic, &mut system);
    let elapsed = if elapsed > 0.0 { elapsed } else { dual.elapsed_seconds() };

    // Update meeting detector
    state.meeting_detector.lock().unwrap().recording_stopped();

    // Release sleep prevention assertion
    *state.sleep_guard.lock().unwrap() = None;

    // Clear recording window ownership
    *state.recording_window.lock().unwrap() = None;

    // This capture's WAVs are now the newest: older ones past the few kept go
    // (audio/recordings.rs), off this thread.
    crate::audio::recordings::prune_in_background("capture stopped");

    let (mic_file, system_file) = stopped?;

    Ok(RecordingResult {
        session_id,
        mic_file: mic_file.map(|p| p.to_string_lossy().into_owned()),
        system_file: system_file.map(|p| p.to_string_lossy().into_owned()),
        duration_seconds: elapsed,
    })
}

#[tauri::command]
pub async fn pause_recording(app_handle: AppHandle) -> Result<(), String> {
    // Pausing flips flags only (no device call), but it takes the locks a
    // start or stop holds while it does open and close devices.
    recording_op(false, move || {
        use tauri::Manager;
        let state = app_handle.state::<AppState>();
        let dual = state.dual_stream.lock().unwrap();
        let mic = state.mic_capture.lock().unwrap();
        let system = state.system_capture.lock().unwrap();
        dual.pause(&mic, &system);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn resume_recording(app_handle: AppHandle) -> Result<(), String> {
    recording_op(true, move || {
        use tauri::Manager;
        // A capture resuming takes the mic back (voice_start refuses while one
        // is live, so this only matters if that ever changes).
        crate::voice::end_for_recording(&app_handle);
        let state = app_handle.state::<AppState>();
        let dual = state.dual_stream.lock().unwrap();
        let mic = state.mic_capture.lock().unwrap();
        let system = state.system_capture.lock().unwrap();
        dual.resume(&mic, &system);
        Ok(())
    })
    .await
}

/// Off the main thread: the dual-stream lock is held by a start or stop
/// while it opens or closes devices. Not one of the recording ops, so it
/// never queues behind one.
#[tauri::command]
pub async fn get_recording_status(app_handle: AppHandle) -> Result<RecordingStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app_handle.state::<AppState>();
        let dual = state.dual_stream.lock().unwrap();
        if dual.is_recording() {
            RecordingStatus::Recording
        } else {
            RecordingStatus::Inactive
        }
    })
    .await
    .map_err(|e| format!("status task failed: {e}"))
}

/// try_lock throughout: a sync command runs on the main thread, and a start
/// or stop holds these locks while it opens or closes devices (which blocks
/// while coreaudiod is stuck). Busy reads as silence, not a frozen app.
#[tauri::command]
pub fn get_audio_levels(state: State<'_, AppState>) -> AudioLevelPayload {
    let (Ok(mic), Ok(system), Ok(session_guard)) =
        (state.mic_capture.try_lock(), state.system_capture.try_lock(), state.session.try_lock())
    else {
        return AudioLevelPayload { mic_level: 0.0, system_level: 0.0, timestamp: 0.0 };
    };

    AudioLevelPayload {
        mic_level: mic.current_level(),
        system_level: system.current_level(),
        timestamp: session_guard
            .as_ref()
            .map(|s| s.elapsed_seconds())
            .unwrap_or(0.0),
    }
}

/// Last AVAuthorizationStatus that check_mic_permission logged (i32::MIN =
/// nothing logged yet). The permissions surfaces poll check_mic_permission
/// every 1.5s, and a line per poll would bury the capture diagnostics in
/// dial8-debug.log, so it logs on change only (first call included) — like
/// permissions::log_status_if_changed. The capture-start gate calls it too, so
/// the status a capture started under is always the last one logged. A racy
/// double-log of one transition from two concurrent callers is harmless.
#[cfg(target_os = "macos")]
static LAST_LOGGED_MIC_STATUS: std::sync::atomic::AtomicI32 =
    std::sync::atomic::AtomicI32::new(i32::MIN);

/// Current microphone TCC status, without prompting.
///
/// The mic prompt has historically only been triggered implicitly by cpal
/// opening the input device — and a *denied* mic is invisible on that path:
/// build_input_stream + play() return Ok and CoreAudio delivers zero-filled
/// buffers, so captures "succeed" and record silence (see docs/PERMISSIONS.md,
/// "The dev auto-update poisoning"). This command lets the frontend see the
/// real TCC state before starting a capture.
///
/// Returns "granted" | "not-determined" | "denied" | "restricted" |
/// "not_applicable".
#[tauri::command]
pub fn check_mic_permission() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn mic_permission_status() -> i32;
        }

        let status = unsafe { mic_permission_status() };
        if LAST_LOGGED_MIC_STATUS.swap(status, std::sync::atomic::Ordering::Relaxed) != status {
            crate::log_to_file(&format!(
                "[check_mic_permission] AVAuthorizationStatus={}",
                status
            ));
        }
        Ok(match status {
            3 => "granted",
            2 => "denied",
            1 => "restricted",
            _ => "not-determined",
        }
        .to_string())
    }

    // Windows asks nobody: a Settings switch allows or denies every desktop
    // app (permissions::windows_microphone_denied).
    #[cfg(target_os = "windows")]
    return Ok(if crate::permissions::windows_microphone_denied() { "denied" } else { "granted" }.to_string());

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Ok("not_applicable".to_string())
}

/// Request microphone permission the only ways macOS allows:
/// - not-determined → show the real system prompt (blocks until the user
///   responds, like request_calendar_access does);
/// - denied/restricted → macOS never re-prompts, so open the Settings mic
///   pane — the sole remaining recourse;
/// - already granted → no-op.
///
/// Returns "granted" | "denied" | "opened-settings" | "not_applicable".
///
/// async + spawn_blocking: sync Tauri commands run on the MAIN thread, and the
/// not-determined path blocks on a semaphore until the user answers the system
/// prompt (up to 120s) — inline that would freeze every window and the tray
/// for the whole prompt. The blocking wait must happen off the main thread.
#[tauri::command]
pub async fn request_mic_permission() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn mic_permission_status() -> i32;
            fn mic_permission_request() -> i32;
        }

        let status = unsafe { mic_permission_status() };
        match status {
            3 => Ok("granted".to_string()),
            0 => {
                crate::log_to_file("[request_mic_permission] not determined — showing system prompt");
                let result =
                    tauri::async_runtime::spawn_blocking(|| unsafe { mic_permission_request() })
                        .await
                        .map_err(|e| format!("mic permission task failed: {}", e))?;
                crate::log_to_file(&format!("[request_mic_permission] prompt result={}", result));
                Ok(if result == 1 { "granted" } else { "denied" }.to_string())
            }
            _ => {
                crate::log_to_file(&format!(
                    "[request_mic_permission] status={} — opening System Settings mic pane",
                    status
                ));
                crate::permissions::open_microphone_settings();
                Ok("opened-settings".to_string())
            }
        }
    }

    // Windows has no prompt: a denied switch is turned on in Settings.
    #[cfg(target_os = "windows")]
    {
        if crate::permissions::windows_microphone_denied() {
            crate::permissions::open_microphone_settings();
            return Ok("opened-settings".to_string());
        }
        return Ok("granted".to_string());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Ok("not_applicable".to_string())
}

/// Request speech recognition permission by opening System Settings.
#[tauri::command]
pub fn request_speech_permission() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    use std::process::Command;

    crate::log_to_file("[request_speech_permission] opening System Settings > Speech Recognition");

    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition")
            .spawn()
            .map_err(|e| format!("Failed to open System Settings: {}", e))?;
        Ok("opened".to_string())
    }
    // Speech recognition is a macOS permission; nothing to open elsewhere.
    #[cfg(not(target_os = "macos"))]
    Ok("not_applicable".to_string())
}

/// Current system-audio ("Audio Capture", kTCCServiceAudioCapture) status,
/// without prompting.
///
/// The truthful replacement for inferring the permission from tap creation,
/// which succeeds even when the permission is denied (see crate::permissions).
/// Passive — one TCC preflight, never any UI — so the frontend can poll it
/// every 1.5s and reflect a toggle flipped in System Settings without a click.
///
/// Returns "granted" | "denied" | "not-determined" | "unavailable" (private
/// TCC API missing) | "unsupported" (macOS < 14.4, no Core Audio taps) |
/// "not_applicable".
#[tauri::command]
pub fn check_system_audio_permission() -> Result<String, String> {
    Ok(crate::permissions::system_audio_permission().as_str().to_string())
}

/// Is coreaudiod answering: "unknown" | "responsive" | "unresponsive"
/// (audio::health). An atomic read, safe on the main thread; changes arrive
/// as the `audio://health` event.
#[tauri::command]
pub fn get_audio_health() -> crate::audio::health::Health {
    crate::audio::health::current()
}

/// Restart a stuck coreaudiod: macOS asks for an administrator's password,
/// then launchd starts a fresh daemon. Resolves once it's done and a new
/// probe has been asked for; rejects with "cancelled" when the user
/// dismisses the prompt. The page can't use it to put up password prompts
/// at will ([`RestartGate`]).
#[tauri::command]
pub async fn restart_core_audio() -> Result<(), String> {
    let gate = || RESTART_GATE.lock().unwrap_or_else(|p| p.into_inner());
    gate().begin(crate::audio::health::current(), std::time::Instant::now())?;
    let restarted = tauri::async_runtime::spawn_blocking(crate::audio::health::restart_daemon)
        .await
        .map_err(|e| format!("restart task failed: {e}"))
        .and_then(|r| r);
    gate().end(restarted.is_ok(), std::time::Instant::now());
    restarted?;
    // launchd needs a moment to start the new daemon.
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    crate::audio::health::check_now();
    Ok(())
}

/// How long after a dismissed (or failed) password prompt another one may
/// be asked for.
const RESTART_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(15);

static RESTART_GATE: std::sync::Mutex<RestartGate> =
    std::sync::Mutex::new(RestartGate { in_flight: false, refused_at: None });

/// When `restart_core_audio` may put up macOS's administrator prompt (security
/// review 2026-10-31): only while coreaudiod is stuck (the only time the web
/// offers it: core-audio-health-toast.tsx), one prompt at a time, and not
/// again within [`RESTART_COOLDOWN`] of one the person dismissed or that
/// failed.
struct RestartGate {
    in_flight: bool,
    refused_at: Option<std::time::Instant>,
}

impl RestartGate {
    fn begin(&mut self, health: crate::audio::health::Health, now: std::time::Instant) -> Result<(), String> {
        if self.in_flight {
            return Err("a restart is already waiting for the password".into());
        }
        if health != crate::audio::health::Health::Unresponsive {
            return Err("macOS audio is responding".into());
        }
        if let Some(left) = self.refused_at.map(|at| RESTART_COOLDOWN.saturating_sub(now.duration_since(at))) {
            if !left.is_zero() {
                return Err(format!("try again in {} s", left.as_secs().max(1)));
            }
        }
        self.in_flight = true;
        Ok(())
    }

    fn end(&mut self, restarted: bool, now: std::time::Instant) {
        self.in_flight = false;
        self.refused_at = (!restarted).then_some(now);
    }
}

#[cfg(test)]
mod restart_gate_tests {
    use super::*;
    use crate::audio::health::Health;
    use std::time::{Duration, Instant};

    fn gate() -> RestartGate {
        RestartGate { in_flight: false, refused_at: None }
    }

    #[test]
    fn only_while_audio_is_stuck() {
        let now = Instant::now();
        for health in [Health::Unknown, Health::Responsive] {
            assert_eq!(gate().begin(health, now), Err("macOS audio is responding".into()));
        }
        assert_eq!(gate().begin(Health::Unresponsive, now), Ok(()));
    }

    #[test]
    fn one_prompt_at_a_time() {
        let (mut g, now) = (gate(), Instant::now());
        g.begin(Health::Unresponsive, now).unwrap();
        assert!(g.begin(Health::Unresponsive, now).unwrap_err().contains("already waiting"));
        g.end(true, now);
        assert_eq!(g.begin(Health::Unresponsive, now), Ok(()), "a restart that worked leaves no pause");
    }

    #[test]
    fn a_pause_after_a_dismissed_or_failed_prompt() {
        let (mut g, now) = (gate(), Instant::now());
        g.begin(Health::Unresponsive, now).unwrap();
        g.end(false, now);
        assert_eq!(g.begin(Health::Unresponsive, now), Err("try again in 15 s".into()));
        assert_eq!(g.begin(Health::Unresponsive, now + Duration::from_millis(14_500)), Err("try again in 1 s".into()));
        assert_eq!(g.begin(Health::Unresponsive, now + RESTART_COOLDOWN), Ok(()));
    }
}

/// Last Mic Mode get_mic_mode logged (i32::MIN = none yet): the recording UI
/// asks every few seconds, so it logs on change only.
static LAST_LOGGED_MIC_MODE: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(i32::MIN);

/// Dial8's macOS Mic Mode: "standard" | "wide-spectrum" | "voice-isolation"
/// | "unknown". Voice Isolation strips other voices in the room out of a
/// meeting, and either non-standard mode makes macOS reconfigure every
/// device's audio processing whenever a Dial8 process starts CoreAudio (the
/// 2026-09-28 coreaudiod deadlock). A preference read, never the microphone;
/// off the main thread all the same (it goes through AVFoundation).
#[tauri::command]
pub async fn get_mic_mode() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(target_os = "macos")]
        let raw = {
            extern "C" {
                fn mic_mode_preferred() -> i32;
            }
            unsafe { mic_mode_preferred() }
        };
        #[cfg(not(target_os = "macos"))]
        let raw = -1;
        if LAST_LOGGED_MIC_MODE.swap(raw, std::sync::atomic::Ordering::Relaxed) != raw {
            crate::log_to_file(&format!("[mic-mode] Dial8's macOS Mic Mode = {} ({raw})", mic_mode_name(raw)));
        }
        mic_mode_name(raw).to_string()
    })
    .await
    .map_err(|e| format!("mic mode task failed: {e}"))
}

fn mic_mode_name(raw: i32) -> &'static str {
    match raw {
        0 => "standard",
        1 => "wide-spectrum",
        2 => "voice-isolation",
        _ => "unknown",
    }
}

/// Open macOS's Mic Mode menu (Control Center) so the user can pick
/// Standard. macOS lists Dial8 there only while it is using the microphone,
/// so the UI offers this during a recording. Returns at once.
#[tauri::command]
pub fn open_mic_mode_picker() {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn mic_mode_show_picker();
        }
        crate::log_to_file("[mic-mode] opening macOS's Mic Mode menu");
        unsafe { mic_mode_show_picker() };
    }
}

#[cfg(test)]
mod mic_mode_tests {
    use super::mic_mode_name;

    #[test]
    fn mic_modes_map_to_avcapturemicrophonemode() {
        // AVCaptureMicrophoneModeStandard / WideSpectrum / VoiceIsolation.
        assert_eq!(mic_mode_name(0), "standard");
        assert_eq!(mic_mode_name(1), "wide-spectrum");
        assert_eq!(mic_mode_name(2), "voice-isolation");
        assert_eq!(mic_mode_name(-1), "unknown");
        assert_eq!(mic_mode_name(7), "unknown");
    }
}

/// What the shared system-audio request flow concluded, before each request
/// command maps it to its own vocabulary (the legacy command's differs).
enum SystemAudioRequestOutcome {
    /// Already granted, or the user just allowed it at the prompt.
    Granted,
    /// The user just declined the prompt (or left it unanswered for 120s).
    Denied,
    /// Denied BEFORE this request. macOS never re-prompts, so the Settings
    /// pane is the only recourse.
    PreviouslyDenied,
    /// The private TCC API is missing: status unknowable, prompt impossible.
    ApiUnavailable,
    /// No Core Audio process taps on this OS (< macOS 14.4).
    Unsupported,
    /// Not macOS.
    NotApplicable,
}

/// The one system-audio request flow behind both request commands.
///
/// Shows the real OS prompt only while the status is not determined, via
/// TCCAccessRequest on a blocking thread: the wait (up to 120s for the user to
/// answer) must not sit on the main thread — same as request_mic_permission.
/// Never opens System Settings itself; the callers decide that, because the
/// legacy command falls back to the old tap probe instead when the private API
/// is missing. `tag` is the caller's log prefix.
async fn run_system_audio_request(tag: &str) -> Result<SystemAudioRequestOutcome, String> {
    use crate::permissions::{SystemAudioPermission, SystemAudioPromptResult};

    Ok(match crate::permissions::system_audio_permission() {
        SystemAudioPermission::Granted => SystemAudioRequestOutcome::Granted,
        SystemAudioPermission::NotDetermined => {
            crate::log_to_file(&format!("[{}] not determined — showing system prompt", tag));
            let result = tauri::async_runtime::spawn_blocking(
                crate::permissions::request_system_audio_access_blocking,
            )
            .await
            .map_err(|e| format!("system audio permission task failed: {}", e))?;
            crate::log_to_file(&format!("[{}] prompt result={:?}", tag, result));
            match result {
                SystemAudioPromptResult::Granted => SystemAudioRequestOutcome::Granted,
                SystemAudioPromptResult::Denied => SystemAudioRequestOutcome::Denied,
                SystemAudioPromptResult::TimedOut => {
                    crate::log_to_file(&format!(
                        "[{}] prompt unanswered for 120s — reporting denied",
                        tag
                    ));
                    SystemAudioRequestOutcome::Denied
                }
                SystemAudioPromptResult::Unavailable => SystemAudioRequestOutcome::ApiUnavailable,
            }
        }
        SystemAudioPermission::Denied => SystemAudioRequestOutcome::PreviouslyDenied,
        SystemAudioPermission::Unavailable => SystemAudioRequestOutcome::ApiUnavailable,
        SystemAudioPermission::Unsupported => SystemAudioRequestOutcome::Unsupported,
        SystemAudioPermission::NotApplicable => SystemAudioRequestOutcome::NotApplicable,
    })
}

/// Request system-audio ("Audio Capture") permission the only ways macOS
/// allows:
/// - not-determined → show the real system prompt (TCCAccessRequest) and wait
///   for the answer;
/// - denied → macOS never re-prompts, so open the Settings pane (Screen &
///   System Audio Recording) — the sole remaining recourse;
/// - already granted → no-op.
///
/// If the private TCC API is missing (a macOS that dropped the symbols), the
/// status is unknowable and no prompt is possible, so it opens the Settings
/// pane too.
///
/// Returns "granted" | "denied" | "opened-settings" | "unsupported" |
/// "not_applicable".
///
/// async + spawn_blocking (inside run_system_audio_request): sync Tauri
/// commands run on the MAIN thread, and the prompt wait would freeze every
/// window and the tray for as long as the prompt sits unanswered.
#[tauri::command]
pub async fn request_system_audio_permission() -> Result<String, String> {
    const TAG: &str = "request_system_audio_permission";
    let result = match run_system_audio_request(TAG).await? {
        SystemAudioRequestOutcome::Granted => "granted",
        SystemAudioRequestOutcome::Denied => "denied",
        SystemAudioRequestOutcome::PreviouslyDenied => {
            crate::log_to_file(&format!(
                "[{}] denied — opening System Settings audio capture pane",
                TAG
            ));
            crate::permissions::open_system_audio_settings();
            "opened-settings"
        }
        SystemAudioRequestOutcome::ApiUnavailable => {
            crate::log_to_file(&format!(
                "[{}] private TCC API unavailable — opening System Settings audio capture pane",
                TAG
            ));
            crate::permissions::open_system_audio_settings();
            "opened-settings"
        }
        SystemAudioRequestOutcome::Unsupported => "unsupported",
        SystemAudioRequestOutcome::NotApplicable => "not_applicable",
    };
    crate::log_to_file(&format!("[{}] result={}", TAG, result));
    Ok(result.to_string())
}

/// LEGACY command name. Older web bundles still call it (onboarding's "Allow",
/// the settings "Request" button, the live system-audio warning), so it stays
/// registered with its old vocabulary: "granted" | "denied" | "unavailable" |
/// "not_applicable".
///
/// It used to create + destroy a real Core Audio tap and report the outcome.
/// That probe CANNOT see a denial: AudioHardwareCreateProcessTap returns noErr
/// and a valid tap even when kTCCServiceAudioCapture is denied or was never
/// granted, because macOS enforces the permission only when IO starts on the
/// tap-backed aggregate device (inside the sidecar) — a denied capture then
/// just delivers zero-filled buffers. So the probe answered "granted" even
/// minutes after the user turned the permission off, which is where "it always
/// says already granted" came from.
///
/// It is now a thin wrapper over request_system_audio_permission's TCC flow,
/// mapped to the old vocabulary: granted → "granted"; denied /
/// opened-settings → "denied"; unsupported → "unavailable". Only when the
/// private TCC API is unavailable does it fall back to the old tap probe,
/// exactly as before, so a macOS without those symbols doesn't regress.
///
/// async + spawn_blocking: see request_system_audio_permission.
#[tauri::command]
pub async fn request_screen_capture_permission() -> Result<String, String> {
    const TAG: &str = "request_screen_capture";
    let result = match run_system_audio_request(TAG).await? {
        SystemAudioRequestOutcome::Granted => "granted",
        SystemAudioRequestOutcome::Denied => "denied",
        SystemAudioRequestOutcome::PreviouslyDenied => {
            crate::log_to_file(&format!(
                "[{}] denied — opening System Settings audio capture pane",
                TAG
            ));
            crate::permissions::open_system_audio_settings();
            "denied"
        }
        SystemAudioRequestOutcome::ApiUnavailable => {
            crate::log_to_file(&format!(
                "[{}] private TCC API unavailable — falling back to the legacy tap probe",
                TAG
            ));
            return legacy_tap_probe_request().await;
        }
        SystemAudioRequestOutcome::Unsupported => "unavailable",
        SystemAudioRequestOutcome::NotApplicable => "not_applicable",
    };
    crate::log_to_file(&format!("[{}] result={}", TAG, result));
    Ok(result.to_string())
}

/// The pre-TCC body of request_screen_capture_permission, kept verbatim as its
/// fallback for a macOS where the private TCC API is missing. It cannot detect
/// a denial (see request_screen_capture_permission), but it is exactly what
/// shipped before, so that hypothetical macOS keeps today's behaviour.
async fn legacy_tap_probe_request() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn tap_helper_probe_permission() -> i32;
        }

        let probe =
            tauri::async_runtime::spawn_blocking(|| unsafe { tap_helper_probe_permission() })
                .await
                .map_err(|e| format!("tap probe task failed: {}", e))?;
        crate::log_to_file(&format!("[request_screen_capture] tap probe result={}", probe));

        match probe {
            1 => Ok("granted".to_string()),
            -1 => Ok("unavailable".to_string()),
            _ => {
                // Tap creation failed. The pre-TCC code read that as a denial
                // and sent the user to the Settings pane (macOS 15 surfaces
                // Core-Audio-tap apps under Screen & System Audio Recording) —
                // kept exactly as it shipped, anchor included.
                let _ = std::process::Command::new("open")
                    .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
                    .spawn();
                Ok("denied".to_string())
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    Ok("not_applicable".to_string())
}

// --- Meeting Detection Commands ---

#[tauri::command]
pub fn enable_meeting_detection(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    enabled: bool,
) -> Result<(), String> {
    crate::meeting_detection::mlog(&format!(
        "enable_meeting_detection called, enabled={}",
        enabled
    ));
    let mut detector = state.meeting_detector.lock().unwrap();
    detector.set_enabled(enabled);
    if enabled {
        detector.start_polling(app_handle.clone());
    } else {
        // A HUD prompt left on screen after disabling would still offer (or
        // count down to) a capture from a pipeline the user just turned off.
        crate::commands::hud::hide_hud(&app_handle);
    }
    // Persist the setting
    crate::settings::set_meeting_detection_enabled(&app_handle, enabled);
    Ok(())
}

#[tauri::command]
pub fn set_auto_record(state: State<'_, AppState>, app_handle: AppHandle, enabled: bool) -> Result<(), String> {
    state
        .meeting_detector
        .lock()
        .unwrap()
        .set_auto_record(enabled);
    // Persist the setting
    crate::settings::set_auto_record(&app_handle, enabled);
    Ok(())
}

/// Whether meeting captures run echo cancellation (Settings → Recording).
/// Takes effect at the next capture start.
#[tauri::command]
pub fn get_echo_cancellation_in_captures(app_handle: AppHandle) -> bool {
    crate::settings::echo_cancellation_in_captures(&app_handle)
}

#[tauri::command]
pub fn set_echo_cancellation_in_captures(app_handle: AppHandle, enabled: bool) {
    crate::settings::set_echo_cancellation_in_captures(&app_handle, enabled);
}

/// Return persisted audio preferences so the frontend can pre-fill the UI.
/// (The microphone is `list_input_devices`.)
#[tauri::command]
pub fn get_audio_preferences(app_handle: AppHandle) -> serde_json::Value {
    let settings = crate::settings::AppSettings::load(&app_handle);
    serde_json::json!({
        "captureSystemAudio": settings.capture_system_audio,
    })
}

#[tauri::command]
pub fn dismiss_meeting_detection(state: State<'_, AppState>) -> Result<(), String> {
    state
        .meeting_detector
        .lock()
        .unwrap()
        .dismiss_detection();
    Ok(())
}

#[tauri::command]
pub fn get_meeting_detection_state(
    state: State<'_, AppState>,
) -> crate::meeting_detection::MeetingDetectionStatus {
    state.meeting_detector.lock().unwrap().status()
}
