/// Meeting detection service — detects when user joins a video/audio call.
///
/// Detection is driven by the Swift sidecar's resident `detect-stream` mode:
/// one long-lived process that watches CoreAudio passively (HAL property
/// reads + change listeners — never a tap, aggregate device, or IO stream, so
/// it can never light the macOS mic-in-use indicator or disturb another
/// app's audio) and emits a JSON `DetectionResult` line per evaluation
/// (every 2s while meeting apps run, 5s otherwise, plus immediately on
/// CoreAudio changes). This replaced the old spawn-a-process-every-poll
/// design — same signals, one HAL client instead of process churn.
///
/// The Rust side supervises that child (restart with backoff on exit, restart
/// on >30s silence) and runs the call state machine over the received lines.

use crate::sidecar::NoConsole;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Write debug log to dial8-meeting.log (`crate::side_log_path`: /tmp on
/// macOS; 0600, `crate::open_log`)
pub fn mlog(msg: &str) {
    if let Ok(mut f) = crate::open_log(&crate::side_log_path("dial8-meeting.log")) {
        let _ = writeln!(f, "[{}] {}", chrono::Local::now().format("%H:%M:%S"), msg);
    }
    eprintln!("[meeting-detection] {}", msg);
}

// MARK: - Types

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MeetingDetectionState {
    Disabled,
    Monitoring,
    Detected,
    Recording,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedApp {
    pub bundle_id: String,
    pub display_name: String,
    pub pid: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingDetectionStatus {
    pub state: MeetingDetectionState,
    pub detected_app: Option<DetectedApp>,
    pub is_auto_record: bool,
    pub is_enabled: bool,
}

/// One JSON line from the sidecar's `detect-stream` (same shape as the
/// one-shot `detect` output).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarDetectionResult {
    meeting_apps_running: Vec<String>,
    apps_using_mic: Vec<SidecarDetectedApp>,
    /// Meeting apps with an output stream running — alive for the whole
    /// call even while the user is muted (Zoom releases the mic on mute).
    #[serde(default)]
    apps_playing_audio: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarDetectedApp {
    #[serde(alias = "bundleID")]
    bundle_id: String,
    display_name: String,
    pid: i32,
    #[allow(dead_code)]
    is_using_mic: bool,
}

/// Side effects decided by the state machine, executed against Tauri by the
/// supervisor thread. Split out so the transition logic is unit-testable
/// without an AppHandle.
#[derive(Debug, PartialEq)]
enum Effect {
    /// Prompt the user (HUD) — auto-record off.
    MeetingDetected(DetectedApp),
    /// Auto-record on: HUD countdown auto-starts the capture.
    MeetingAutoStart(DetectedApp),
    /// A recorded call ended: emit `meeting-ended` (web auto-stops the
    /// capture) and close the HUD.
    MeetingEnded,
    /// A call ended while we were merely prompting (Detected state, no
    /// capture running): close the HUD quietly. No `meeting-ended` emit (the
    /// web listener only acts on recordings) and no retrigger cooldown
    /// (nothing was recorded).
    DismissHud,
}

// MARK: - Meeting Detector

/// Emergency kill switch for auto start/stop capture. Was `false` from
/// v0.2.14 while we chased the 2026-06 prod mic-indicator flicker (root
/// causes: the auto-record feedback loop plus capture start/stop audio-graph
/// reconfiguration — the passive detector itself was never the toucher).
/// Re-enabled after the detection pipeline moved to the resident passive
/// `detect-stream` sidecar and the HUD re-prompt/auto-end fixes landed.
/// Flipping this to false makes the entire pipeline inert again: no sidecar
/// process, no HUD prompts, no auto-record, no call-end auto-stop.
pub const AUTO_CAPTURE_ENABLED: bool = true;

pub struct MeetingDetector {
    is_enabled: bool,

    // Shared state accessible from both main thread and supervisor thread
    shared_state: Arc<Mutex<PollingState>>,

    /// Stop flag for the CURRENT supervisor generation. start_polling replaces
    /// it with a fresh Arc each time, so a stale supervisor that wakes up late
    /// can only ever observe its own (already-set) flag — it can never clear
    /// or race the flag of a newer generation.
    should_stop: Arc<AtomicBool>,
}

// Thresholds
const MIN_MIC_ACTIVE_TIME: Duration = Duration::from_secs(5);

/// The meeting app's mic must be continuously inactive for this long before we
/// declare the call over. Starting/stopping our own capture reconfigures the
/// CoreAudio graph, which can briefly interrupt the meeting app's input stream
/// — a short threshold misreads that interruption as "call ended", auto-stops
/// the capture, re-triggers detection, and loops, chopping the user's mic for
/// the entire meeting.
const CALL_END_MIC_INACTIVE: Duration = Duration::from_secs(30);
/// If the meeting app has quit entirely, the call is over — end faster.
const CALL_END_APP_QUIT: Duration = Duration::from_secs(5);
/// After any recording stops (auto call-end or manual stop), don't trigger a
/// new detection for this long. Prevents the auto-record loop above, and stops
/// us from re-prompting seconds after the user deliberately stopped a capture.
const RETRIGGER_COOLDOWN: Duration = Duration::from_secs(180);
/// A dismissed app's dismissal expires once its session has been over —
/// app quit, or neither mic nor output running — for this long. Session
/// liveness (not mic-inactivity) is deliberately the yardstick: Zoom releases
/// the mic while merely MUTED, and the old 10s-of-mic-inactivity rule made
/// every long mute clear the dismissal and re-pop the HUD mid-call.
const DISMISS_RESET_AFTER_GONE: Duration = Duration::from_secs(10);

/// Browsers whose OUTPUT stream says nothing about being in a call: a Chrome
/// or Safari tab playing YouTube keeps `apps_playing_audio` lit for hours.
/// For these, only mic use counts as call liveness — which is safe, because
/// browsers hold the mic for the whole call (WebRTC mute disables the track
/// without releasing the device, unlike native Zoom). Without this rule a
/// dismissed browser meeting's dismissal never expires while any tab plays
/// audio (later meetings silently never detected), and a recorded browser
/// call whose tab then plays music never auto-stops.
const BROWSER_BUNDLES: [&str; 4] = ["com.google.Chrome", "com.apple.Safari", "com.microsoft.edgemac", "org.mozilla.firefox"];

fn output_counts_as_call_liveness(bundle_id: &str) -> bool {
    !BROWSER_BUNDLES.contains(&bundle_id)
}

/// Restart the sidecar if it emits nothing for this long (its own cadence is
/// ≤5s, so 30s of silence means it's gone or wedged).
const SIDECAR_SILENCE_TIMEOUT: Duration = Duration::from_secs(30);
const SIDECAR_BACKOFF_INITIAL: Duration = Duration::from_secs(1);
const SIDECAR_BACKOFF_MAX: Duration = Duration::from_secs(300);
/// A session that survives this long is considered healthy — reset backoff.
const SIDECAR_HEALTHY_AFTER: Duration = Duration::from_secs(60);

impl MeetingDetector {
    pub fn new() -> Self {
        Self {
            is_enabled: true,
            shared_state: Arc::new(Mutex::new(PollingState {
                mic_active_start: None,
                last_mic_state: false,
                recording_mic_inactive_since: None,
                last_recording_stop: None,
                dismissed_apps: HashSet::new(),
                dismissed_gone_since: HashMap::new(),
                state: MeetingDetectionState::Monitoring,
                detected_app: None,
                // Off by default — overwritten from persisted settings at
                // startup (lib.rs setup). Must match AppSettings::default().
                auto_record: false,
            })),
            should_stop: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn status(&self) -> MeetingDetectionStatus {
        let s = self.shared_state.lock().unwrap();
        MeetingDetectionStatus {
            state: s.state.clone(),
            detected_app: s.detected_app.clone(),
            is_auto_record: s.auto_record,
            is_enabled: self.is_enabled && AUTO_CAPTURE_ENABLED,
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.is_enabled = enabled;
        if !enabled {
            let mut s = self.shared_state.lock().unwrap();
            // Keep Recording intact so a later re-enable (start_polling's
            // preservation branch) re-arms call-end auto-stop for the live
            // capture instead of re-detecting the call being recorded.
            // recording_stopped() parks the state at Disabled afterwards
            // because is_enabled is false.
            if s.state != MeetingDetectionState::Recording {
                s.state = MeetingDetectionState::Disabled;
            }
            drop(s);
            self.stop_polling();
        }
    }

    pub fn set_auto_record(&mut self, auto_record: bool) {
        self.shared_state.lock().unwrap().auto_record = auto_record;
    }

    pub fn dismiss_detection(&mut self) {
        let mut s = self.shared_state.lock().unwrap();
        // A live capture must not be knocked out of Recording by a stray HUD
        // dismissal — that would disarm call-end auto-stop AND re-open the
        // detector to re-triggering against the call being recorded.
        if s.state == MeetingDetectionState::Recording {
            if let Some(bundle_id) = s.detected_app.as_ref().map(|a| a.bundle_id.clone()) {
                s.dismissed_apps.insert(bundle_id);
            }
            return;
        }
        if let Some(app) = s.detected_app.take() {
            s.dismissed_apps.insert(app.bundle_id);
        }
        s.last_mic_state = false;
        s.mic_active_start = None;
        s.recording_mic_inactive_since = None;
        s.state = MeetingDetectionState::Monitoring;
    }

    pub fn recording_started(&mut self) {
        let mut s = self.shared_state.lock().unwrap();
        s.state = MeetingDetectionState::Recording;
        // Start the call-end tracker from a clean slate: inactivity that
        // accumulated BEFORE the capture (in Detected, or from a previous
        // cycle) must not count toward ending it — a stale
        // recording_mic_inactive_since could auto-stop a fresh capture within
        // seconds. Re-arming requires re-observing the call active first,
        // which also keeps purely manual captures un-stoppable.
        s.last_mic_state = false;
        s.recording_mic_inactive_since = None;
    }

    pub fn recording_stopped(&mut self) {
        let mut s = self.shared_state.lock().unwrap();
        s.mic_active_start = None;
        s.last_mic_state = false;
        s.recording_mic_inactive_since = None;
        s.last_recording_stop = Some(Instant::now());
        // The capture is over: a stale app here would make a later manual
        // capture look auto-detected, and auto-stop it once that app quits.
        s.detected_app = None;

        if self.is_enabled && AUTO_CAPTURE_ENABLED {
            s.state = MeetingDetectionState::Monitoring;
        } else {
            s.state = MeetingDetectionState::Disabled;
        }
    }

    /// Start the resident detection stream (supervisor thread + sidecar child).
    pub fn start_polling(&mut self, app_handle: AppHandle) {
        if !AUTO_CAPTURE_ENABLED {
            mlog("start_polling skipped — auto-capture kill switch is off");
            self.shared_state.lock().unwrap().state = MeetingDetectionState::Disabled;
            return;
        }
        if !self.is_enabled {
            mlog("start_polling called but not enabled, skipping");
            return;
        }
        mlog("Starting detection stream");

        self.stop_polling();

        {
            let mut s = self.shared_state.lock().unwrap();
            // A live capture must survive a mid-session restart (settings
            // toggle, webview-driven re-enable): keep Recording so call-end
            // auto-stop stays armed, and keep the retrigger cooldown so the
            // restart can't immediately re-detect the in-progress call.
            // last_mic_state is reset either way — check_call_end re-arms
            // only after re-observing the call active, which is the safe
            // direction (see recording_started).
            if s.state != MeetingDetectionState::Recording {
                s.state = MeetingDetectionState::Monitoring;
                s.detected_app = None;
            }
            s.mic_active_start = None;
            s.last_mic_state = false;
            s.recording_mic_inactive_since = None;
            s.dismissed_apps.clear();
            s.dismissed_gone_since.clear();
        }

        // Fresh stop flag per supervisor generation (see field docs).
        let should_stop = Arc::new(AtomicBool::new(false));
        self.should_stop = Arc::clone(&should_stop);

        let state_clone = Arc::clone(&self.shared_state);

        // Detached deliberately — see stop_polling. The helper starts
        // CoreAudio, so the first one waits for the launch gate.
        std::thread::spawn(move || {
            crate::audio::launch_gate::wait();
            Self::supervisor_loop(should_stop, state_clone, app_handle);
        });
    }

    /// Signal-then-detach, NEVER join. Tauri sync commands (the settings
    /// toggle) run on the main/event-loop thread, and the supervisor performs
    /// blocking main-thread round-trips inside show_hud (current_monitor,
    /// url()) — a main-thread join here while such a round-trip is in flight
    /// is a permanent whole-app deadlock. The supervisor observes its flag
    /// within ~500ms, kills the child (which also dies on stdin EOF), and
    /// exits on its own; apply_effects re-checks the flag so a stale
    /// generation can't pop UI after being stopped.
    fn stop_polling(&mut self) {
        self.should_stop.store(true, Ordering::SeqCst);
    }

    // MARK: - Sidecar supervision

    /// Keep a `detect-stream` child alive: run a session, and when it dies
    /// (crash, silence, missing binary) restart it with exponential backoff.
    /// Exits promptly when `should_stop` is set.
    fn supervisor_loop(
        should_stop: Arc<AtomicBool>,
        state: Arc<Mutex<PollingState>>,
        app_handle: AppHandle,
    ) {
        let mut backoff = SIDECAR_BACKOFF_INITIAL;
        loop {
            if should_stop.load(Ordering::SeqCst) {
                break;
            }

            let session_start = Instant::now();
            let stopped = Self::run_stream_session(&should_stop, &state, &app_handle);
            if stopped {
                break;
            }

            if session_start.elapsed() >= SIDECAR_HEALTHY_AFTER {
                backoff = SIDECAR_BACKOFF_INITIAL;
            }
            mlog(&format!("detect-stream restarting in {:?}", backoff));

            let deadline = Instant::now() + backoff;
            while Instant::now() < deadline {
                if should_stop.load(Ordering::SeqCst) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            backoff = (backoff * 2).min(SIDECAR_BACKOFF_MAX);
        }
    }

    /// Windows: no sidecar; [`windows_detect`] reads the same picture in
    /// process (running meeting apps, their mic and output sessions) on the
    /// Mac stream's cadence, 2 s while a meeting app runs and 5 s otherwise.
    /// Returns true iff we exited because of `should_stop`.
    #[cfg(target_os = "windows")]
    fn run_stream_session(
        should_stop: &Arc<AtomicBool>,
        state: &Arc<Mutex<PollingState>>,
        app_handle: &AppHandle,
    ) -> bool {
        let detector = match windows_detect::Detector::new() {
            Ok(d) => d,
            Err(e) => {
                mlog(&format!("detect: Windows detection couldn't start: {e}"));
                return false;
            }
        };
        mlog("detect: Windows in-process detection started");
        let mut last_logged: Option<String> = None;
        loop {
            if should_stop.load(Ordering::SeqCst) {
                return true;
            }
            let result = detector.detect();
            if should_stop.load(Ordering::SeqCst) {
                return true;
            }
            let picture = format!(
                "apps running: {:?}, using mic: {:?}, playing: {:?}",
                result.meeting_apps_running,
                result.apps_using_mic.iter().map(|a| &a.bundle_id).collect::<Vec<_>>(),
                result.apps_playing_audio,
            );
            if !result.meeting_apps_running.is_empty() && last_logged.as_deref() != Some(picture.as_str()) {
                mlog(&picture);
            }
            last_logged = Some(picture);
            let effects = Self::process_result(state, &result);
            Self::apply_effects(effects, app_handle);

            let wait = if result.meeting_apps_running.is_empty() { Duration::from_secs(5) } else { Duration::from_secs(2) };
            let until = Instant::now() + wait;
            while Instant::now() < until {
                if should_stop.load(Ordering::SeqCst) {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        }
    }

    /// Run one sidecar session until it dies or `should_stop` is set.
    /// Returns true iff we exited because of `should_stop`.
    #[cfg(not(target_os = "windows"))]
    fn run_stream_session(
        should_stop: &Arc<AtomicBool>,
        state: &Arc<Mutex<PollingState>>,
        app_handle: &AppHandle,
    ) -> bool {
        let Some(sidecar_path) = crate::sidecar::path(crate::sidecar::SYSTEM_AUDIO_CAPTURE) else {
            mlog("detect-stream: sidecar binary not found");
            return false;
        };

        let mut child = match Command::new(&sidecar_path)
            .no_console()
            .arg("detect-stream")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                mlog(&format!("detect-stream: failed to spawn: {}", e));
                return false;
            }
        };

        // Hold the child's stdin open for the session: the sidecar treats
        // stdin EOF as "parent is gone" and exits, so dropping this handle is
        // also our graceful shutdown signal.
        let child_stdin = child.stdin.take();

        let Some(stdout) = child.stdout.take() else {
            mlog("detect-stream: no stdout pipe");
            let _ = child.kill();
            let _ = child.wait();
            return false;
        };

        let (tx, rx) = mpsc::channel::<String>();
        let reader = std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        if tx.send(l).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let mut last_line_at = Instant::now();
        let mut last_logged_line: Option<String> = None;

        let stopped = loop {
            if should_stop.load(Ordering::SeqCst) {
                break true;
            }

            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(line) => {
                    last_line_at = Instant::now();
                    match serde_json::from_str::<SidecarDetectionResult>(&line) {
                        Ok(result) => {
                            // Check the flag BEFORE processing: a stopped
                            // generation must not commit state transitions
                            // (whose effects would then be lost) nor pop UI.
                            if should_stop.load(Ordering::SeqCst) {
                                break true;
                            }
                            // Log only when the picture changed — a healthy
                            // stream re-emits an identical line every 2-5s.
                            if !result.meeting_apps_running.is_empty()
                                && last_logged_line.as_deref() != Some(line.as_str())
                            {
                                mlog(&format!(
                                    "apps running: {:?}, using mic: {:?}, playing: {:?}",
                                    result.meeting_apps_running,
                                    result
                                        .apps_using_mic
                                        .iter()
                                        .map(|a| &a.bundle_id)
                                        .collect::<Vec<_>>(),
                                    result.apps_playing_audio,
                                ));
                            }
                            last_logged_line = Some(line);

                            let effects = Self::process_result(state, &result);
                            Self::apply_effects(effects, app_handle);
                        }
                        Err(e) => {
                            mlog(&format!("detect-stream: unparseable line ({}): {}", e, line));
                        }
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if last_line_at.elapsed() > SIDECAR_SILENCE_TIMEOUT {
                        mlog("detect-stream: silent too long, restarting");
                        break false;
                    }
                    if let Ok(Some(status)) = child.try_wait() {
                        mlog(&format!("detect-stream: exited ({})", status));
                        break false;
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    mlog("detect-stream: stdout closed");
                    break false;
                }
            }
        };

        drop(child_stdin);
        let _ = child.kill();
        let _ = child.wait();
        let _ = reader.join();
        stopped
    }

    // MARK: - State machine

    /// Advance the call state machine with one detection sample. Pure with
    /// respect to Tauri: all side effects are returned for the caller to run.
    fn process_result(
        state: &Arc<Mutex<PollingState>>,
        result: &SidecarDetectionResult,
    ) -> Vec<Effect> {
        let current_state = {
            let s = state.lock().unwrap();
            s.state.clone()
        };

        match current_state {
            // While recording — or while the HUD prompt is up (Detected) —
            // watch for the call ending. The Detected half is what auto-hides
            // a stale HUD when the meeting ends before the user ever clicks.
            MeetingDetectionState::Recording => Self::check_call_end(state, result, true),
            MeetingDetectionState::Detected => Self::check_call_end(state, result, false),
            MeetingDetectionState::Monitoring => Self::check_call_start(state, result),
            MeetingDetectionState::Disabled => Vec::new(),
        }
    }

    fn check_call_start(
        state: &Arc<Mutex<PollingState>>,
        result: &SidecarDetectionResult,
    ) -> Vec<Effect> {
        let mut s = state.lock().unwrap();

        Self::expire_dismissals(&mut s, result);

        let call_is_active = !result.apps_using_mic.is_empty();
        let app_using_mic = result.apps_using_mic.first();

        // Track mic state transitions
        if call_is_active && !s.last_mic_state {
            s.mic_active_start = Some(Instant::now());
        } else if !call_is_active && s.last_mic_state {
            s.mic_active_start = None;
        }
        s.last_mic_state = call_is_active;

        if !call_is_active {
            return Vec::new();
        }

        let Some(app) = app_using_mic else {
            return Vec::new();
        };

        let Some(start_time) = s.mic_active_start else {
            return Vec::new();
        };

        if start_time.elapsed() < MIN_MIC_ACTIVE_TIME {
            return Vec::new();
        }

        if s.dismissed_apps.contains(&app.bundle_id) {
            return Vec::new();
        }

        // Cooldown after any recording stop: a false call-end here would
        // otherwise auto-start a new capture seconds later and loop.
        if let Some(stopped_at) = s.last_recording_stop {
            if stopped_at.elapsed() < RETRIGGER_COOLDOWN {
                return Vec::new();
            }
        }

        // Trigger detection. The app goes on the dismissed list immediately so
        // this session never re-prompts; the dismissal expires only once the
        // session is over (see expire_dismissals).
        s.dismissed_apps.insert(app.bundle_id.clone());
        s.dismissed_gone_since.remove(&app.bundle_id);

        let detected = DetectedApp {
            bundle_id: app.bundle_id.clone(),
            display_name: app.display_name.clone(),
            pid: app.pid,
        };

        let auto_record = s.auto_record;
        s.detected_app = Some(detected.clone());
        // Both paths park in Detected: Recording is entered ONLY via
        // recording_started() when a capture actually begins. In the auto
        // case the HUD countdown still has ~10s to run (and can be
        // cancelled) — treating that window as Recording would let a HUD
        // dismissal or call-end mis-handle a capture that never existed.
        s.state = MeetingDetectionState::Detected;
        if auto_record {
            vec![Effect::MeetingAutoStart(detected)]
        } else {
            vec![Effect::MeetingDetected(detected)]
        }
    }

    /// Expire dismissals whose session has ended. A session is alive while the
    /// app is running AND audibly in a call (mic in use, or output running —
    /// the muted-Zoom case). Only after the session has been continuously gone
    /// for DISMISS_RESET_AFTER_GONE is the app eligible to prompt again.
    fn expire_dismissals(s: &mut PollingState, result: &SidecarDetectionResult) {
        let now = Instant::now();
        let dismissed: Vec<String> = s.dismissed_apps.iter().cloned().collect();
        for bundle_id in dismissed {
            let running = result.meeting_apps_running.contains(&bundle_id);
            let on_mic = result.apps_using_mic.iter().any(|a| a.bundle_id == bundle_id);
            let playing = result.apps_playing_audio.contains(&bundle_id)
                && output_counts_as_call_liveness(&bundle_id);
            let session_alive = running && (on_mic || playing);

            if session_alive {
                s.dismissed_gone_since.remove(&bundle_id);
            } else {
                let gone_since = *s
                    .dismissed_gone_since
                    .entry(bundle_id.clone())
                    .or_insert(now);
                if now.duration_since(gone_since) >= DISMISS_RESET_AFTER_GONE {
                    s.dismissed_apps.remove(&bundle_id);
                    s.dismissed_gone_since.remove(&bundle_id);
                }
            }
        }
    }

    /// Watch for the end of a call we're recording (`was_recording`) or merely
    /// prompting about (Detected state).
    fn check_call_end(
        state: &Arc<Mutex<PollingState>>,
        result: &SidecarDetectionResult,
        was_recording: bool,
    ) -> Vec<Effect> {
        let mut s = state.lock().unwrap();
        // Scope the mic check to the app this detection is ABOUT when we know
        // it: a different app grabbing the mic (dictation, another call app,
        // a website) must not keep a dead call "alive" forever. Manual
        // captures (detected_app=None) keep the any-app semantics.
        let mic_active = match &s.detected_app {
            Some(app) => result
                .apps_using_mic
                .iter()
                .any(|a| a.bundle_id == app.bundle_id),
            None => !result.apps_using_mic.is_empty(),
        };

        if mic_active {
            s.last_mic_state = true;
            s.recording_mic_inactive_since = None;
            return Vec::new();
        }

        let app_quit = match &s.detected_app {
            Some(app) => !result.meeting_apps_running.contains(&app.bundle_id),
            None => result.meeting_apps_running.is_empty(),
        };

        // Un-armed (call not yet observed active in this state): purely
        // manual captures (detected_app=None) must NEVER be auto-stopped.
        // But when we KNOW which app this detection/capture is about and that
        // app has quit entirely, the call is over even though arming never
        // happened — e.g. the user muted during the HUD countdown (Zoom
        // releases the mic on mute), sat through the webinar muted, then quit
        // Zoom: without this, the capture would run forever.
        if !s.last_mic_state {
            if s.detected_app.is_none() || !app_quit {
                return Vec::new();
            }
        } else {
            // Muted-but-still-in-call: the meeting app keeps its OUTPUT
            // stream running for the whole call even when the user mutes
            // (Zoom releases the mic input on mute). Only treat the call as
            // ending once the output is gone too. Browser output is excluded
            // — a tab playing music is not a call (see BROWSER_BUNDLES).
            let audio_alive = match &s.detected_app {
                Some(app) => {
                    result.apps_playing_audio.contains(&app.bundle_id)
                        && output_counts_as_call_liveness(&app.bundle_id)
                }
                None => result
                    .apps_playing_audio
                    .iter()
                    .any(|b| output_counts_as_call_liveness(b)),
            };
            if audio_alive {
                s.recording_mic_inactive_since = None;
                return Vec::new();
            }
        }

        let inactive_since = *s
            .recording_mic_inactive_since
            .get_or_insert_with(Instant::now);

        // If the detected meeting app has quit entirely, the call is over
        // (threshold CALL_END_APP_QUIT). Otherwise require a sustained
        // mic-inactive window: brief input interruptions (our own capture
        // start/stop reconfiguring the audio graph, mute, device switches)
        // must not end the capture.
        let threshold = if app_quit {
            CALL_END_APP_QUIT
        } else {
            CALL_END_MIC_INACTIVE
        };

        let elapsed = inactive_since.elapsed();
        if elapsed < threshold {
            mlog(&format!(
                "Mic inactive for {:.0}s/{}s (app_quit={}, recording={})",
                elapsed.as_secs_f32(),
                threshold.as_secs(),
                app_quit,
                was_recording,
            ));
            return Vec::new();
        }

        mlog(&format!(
            "Call ended (mic inactive {:.0}s, app_quit={}, recording={})",
            elapsed.as_secs_f32(),
            app_quit,
            was_recording,
        ));
        s.last_mic_state = false;
        s.recording_mic_inactive_since = None;
        s.detected_app = None;
        s.state = MeetingDetectionState::Monitoring;

        if was_recording {
            // The web side stops the capture on `meeting-ended`; gate
            // re-triggering so the stop can't cascade into a new detection.
            s.last_recording_stop = Some(Instant::now());
            vec![Effect::MeetingEnded]
        } else {
            // Prompt-only: nothing was recorded, so no cooldown — the app's
            // dismissal (set at trigger time) already prevents an instant
            // re-prompt, and expires via session liveness.
            vec![Effect::DismissHud]
        }
    }

    fn apply_effects(effects: Vec<Effect>, app_handle: &AppHandle) {
        for effect in effects {
            match effect {
                Effect::MeetingDetected(app) => {
                    mlog(&format!("DETECTED (prompt user): {}", app.display_name));
                    let _ = app_handle.emit("meeting-detected", &app);
                    crate::commands::hud::show_hud(
                        app_handle,
                        &app.display_name,
                        &app.bundle_id,
                        false,
                    );
                }
                Effect::MeetingAutoStart(app) => {
                    mlog(&format!("AUTO-START recording: {}", app.display_name));
                    // The capture itself starts from the web after the HUD
                    // countdown (start_recording cancels speech again); stop
                    // any read-aloud now so it doesn't talk over the call.
                    crate::modules::tts::cancel_for_recording(app_handle);
                    // And end any chat voice session: the capture needs the mic.
                    crate::voice::end_for_recording(app_handle);
                    let _ = app_handle.emit("meeting-detected-auto-start", &app);
                    crate::commands::hud::show_hud(
                        app_handle,
                        &app.display_name,
                        &app.bundle_id,
                        true,
                    );
                }
                Effect::MeetingEnded => {
                    let _ = app_handle.emit("meeting-ended", ());
                    crate::commands::hud::hide_hud(app_handle);
                }
                Effect::DismissHud => {
                    mlog("Meeting ended before capture started — dismissing HUD");
                    crate::commands::hud::hide_hud(app_handle);
                }
            }
        }
    }
}

struct PollingState {
    mic_active_start: Option<Instant>,
    last_mic_state: bool,
    /// While recording: when the meeting app's mic was last seen going
    /// inactive after having been active. Cleared whenever the mic is active.
    recording_mic_inactive_since: Option<Instant>,
    /// When the last recording stopped (auto call-end or manual stop).
    /// Gates re-triggering via RETRIGGER_COOLDOWN.
    last_recording_stop: Option<Instant>,
    dismissed_apps: HashSet<String>,
    /// For each dismissed app: since when its session has been continuously
    /// over (not running, or neither mic nor output active). Drives dismissal
    /// expiry — see expire_dismissals.
    dismissed_gone_since: HashMap<String, Instant>,
    state: MeetingDetectionState,
    detected_app: Option<DetectedApp>,
    auto_record: bool,
}

impl Drop for MeetingDetector {
    fn drop(&mut self) {
        self.stop_polling();
    }
}

// MARK: - Windows detection

/// Meeting apps on Windows, by executable (lowercase): their app id and name.
/// The ids are the Mac's bundle ids where the app has one, so the state
/// machine's rules (browsers' output doesn't count) and the names the web
/// shows hold on both.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const WINDOWS_MEETING_APPS: &[(&str, &str, &str)] = &[
    ("zoom.exe", "us.zoom.xos", "Zoom"),
    ("ms-teams.exe", "com.microsoft.teams2", "Microsoft Teams"),
    ("teams.exe", "com.microsoft.teams", "Microsoft Teams (classic)"),
    ("slack.exe", "com.tinyspeck.slackmacgap", "Slack"),
    ("webex.exe", "com.cisco.webexmeetingsapp", "Webex"),
    ("ciscocollabhost.exe", "com.cisco.webexmeetingsapp", "Webex"),
    ("discord.exe", "com.hnc.Discord", "Discord"),
    ("chrome.exe", "com.google.Chrome", "Google Chrome"),
    ("msedge.exe", "com.microsoft.edgemac", "Microsoft Edge"),
    ("firefox.exe", "org.mozilla.firefox", "Firefox"),
];

/// A running process: its parent, its executable's file name (lowercase) and
/// when it started (100 ns ticks; 0 = unknown).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone)]
struct WinProcess {
    parent: u32,
    exe: String,
    created: u64,
}

/// Processes a walk up the tree never passes: the shell and the system
/// start everything, so an app's ancestry is over when it reaches one (and a
/// dead parent's reused pid past them would be anyone's).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const WINDOWS_TREE_ROOTS: &[&str] = &[
    "explorer.exe", "svchost.exe", "services.exe", "wininit.exe", "winlogon.exe", "userinit.exe",
    "sihost.exe", "runtimebroker.exe", "taskhostw.exe", "dllhost.exe",
];

/// The meeting app `pid` belongs to: its own process, or the nearest
/// ancestor that is one. Meeting apps play and record from helpers (Chrome's
/// audio service, the WebView2 children of new Teams), so a session is
/// attributed up the tree as the Mac's responsibility API does. Returns the
/// app's pid, id and name. The walk ends, unattributed, at Dial8 itself
/// (`own_pid`: Dial8 started by a browser's link is Chrome's child, and its
/// own web view's mic isn't Chrome's), at the shell or a system process, and
/// at a parent that started after its child: its pid was reused after the
/// real parent exited. Bounded, and never loops.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn attribute_process(pid: u32, procs: &HashMap<u32, WinProcess>, own_pid: u32) -> Option<(u32, &'static str, &'static str)> {
    let mut at = pid;
    let mut seen = HashSet::new();
    for _ in 0..8 {
        if at == own_pid || !seen.insert(at) {
            return None;
        }
        let proc = procs.get(&at)?;
        if let Some((_, id, name)) = WINDOWS_MEETING_APPS.iter().find(|(exe, _, _)| *exe == proc.exe) {
            return Some((at, id, name));
        }
        if WINDOWS_TREE_ROOTS.contains(&proc.exe.as_str()) || proc.parent == 0 || proc.parent == at {
            return None;
        }
        let parent = procs.get(&proc.parent)?;
        if parent.created != 0 && proc.created != 0 && parent.created > proc.created {
            return None;
        }
        at = proc.parent;
    }
    None
}

/// The detection picture from a process list and the processes with an
/// active capture (mic) and render (output) session, Dial8's own left out.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_detection(
    procs: &HashMap<u32, WinProcess>,
    capture_pids: &[u32],
    render_pids: &[u32],
    own_pid: u32,
) -> SidecarDetectionResult {
    let mut running: Vec<String> = procs
        .values()
        .filter_map(|p| WINDOWS_MEETING_APPS.iter().find(|(exe, _, _)| *exe == p.exe).map(|(_, id, _)| id.to_string()))
        .collect();
    running.sort();
    running.dedup();

    let mut on_mic: Vec<SidecarDetectedApp> = Vec::new();
    for &pid in capture_pids {
        if pid == own_pid {
            continue;
        }
        if let Some((app_pid, id, name)) = attribute_process(pid, procs, own_pid) {
            if !on_mic.iter().any(|a| a.bundle_id == id) {
                on_mic.push(SidecarDetectedApp {
                    bundle_id: id.to_string(),
                    display_name: name.to_string(),
                    pid: app_pid as i32,
                    is_using_mic: true,
                });
            }
        }
    }

    let mut playing: Vec<String> = render_pids
        .iter()
        .filter(|&&pid| pid != own_pid)
        .filter_map(|&pid| attribute_process(pid, procs, own_pid).map(|(_, id, _)| id.to_string()))
        .collect();
    playing.sort();
    playing.dedup();

    SidecarDetectionResult { meeting_apps_running: running, apps_using_mic: on_mic, apps_playing_audio: playing }
}

/// Windows' half: the process list (ToolHelp) and every active audio
/// session's process on the active capture and render endpoints (Core
/// Audio's session manager). Passive reads, like the Mac stream's: it opens
/// no stream, so it can't light the mic-in-use indicator.
#[cfg(target_os = "windows")]
mod windows_detect {
    use super::{windows_detection, SidecarDetectionResult, WinProcess};
    use std::collections::HashMap;
    use windows::core::Interface;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Media::Audio::{
        eCapture, eRender, AudioSessionStateActive, EDataFlow, IAudioSessionControl2, IAudioSessionManager2,
        IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };

    pub struct Detector {
        enumerator: IMMDeviceEnumerator,
    }

    impl Detector {
        /// On the detection thread (it joins the MTA there).
        pub fn new() -> Result<Self, String> {
            // SAFETY: COM init on this thread; S_FALSE (already initialized)
            // is fine, and the thread lives as long as the detector.
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                let enumerator: IMMDeviceEnumerator =
                    CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| format!("device enumerator: {e}"))?;
                Ok(Self { enumerator })
            }
        }

        pub fn detect(&self) -> SidecarDetectionResult {
            let mut procs = processes();
            let capture = active_session_pids(&self.enumerator, eCapture);
            let render = active_session_pids(&self.enumerator, eRender);
            // Start times only along the chains a session walks (a few
            // processes, not all of them, each poll).
            for &pid in capture.iter().chain(&render) {
                let mut at = pid;
                for _ in 0..8 {
                    let Some(p) = procs.get_mut(&at) else { break };
                    if p.created == 0 {
                        p.created = created(at).unwrap_or(0);
                    }
                    if p.parent == 0 || p.parent == at {
                        break;
                    }
                    at = p.parent;
                }
            }
            windows_detection(&procs, &capture, &render, std::process::id())
        }
    }

    fn processes() -> HashMap<u32, WinProcess> {
        let mut out = HashMap::new();
        // SAFETY: a snapshot handle closed below; each entry's dwSize set as
        // ToolHelp requires; szExeFile is NUL-terminated within its array.
        unsafe {
            let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return out;
            };
            let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            if Process32FirstW(snapshot, &mut entry).is_ok() {
                loop {
                    let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                    let exe = String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase();
                    out.insert(entry.th32ProcessID, WinProcess { parent: entry.th32ParentProcessID, exe, created: 0 });
                    if Process32NextW(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snapshot);
        }
        out
    }

    /// When `pid` started (100 ns ticks since 1601), if it can be asked.
    fn created(pid: u32) -> Option<u64> {
        use windows::Win32::Foundation::{BOOL, FILETIME};
        use windows::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        // SAFETY: a query handle closed below; four FILETIME out-parameters.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, BOOL(0), pid).ok()?;
            let (mut created, mut exited, mut kernel, mut user) =
                (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
            let times = GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user);
            let _ = CloseHandle(handle);
            times.ok()?;
            Some(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
        }
    }

    /// Processes with an active session on any active endpoint of `flow`.
    fn active_session_pids(enumerator: &IMMDeviceEnumerator, flow: EDataFlow) -> Vec<u32> {
        let mut pids = Vec::new();
        // SAFETY: COM calls on interfaces this thread holds; every result is
        // checked, and a device or session that fails is skipped.
        unsafe {
            let Ok(devices) = enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE) else {
                return pids;
            };
            for i in 0..devices.GetCount().unwrap_or(0) {
                let Ok(device) = devices.Item(i) else { continue };
                let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
                let Ok(sessions) = manager.GetSessionEnumerator() else { continue };
                for j in 0..sessions.GetCount().unwrap_or(0) {
                    let Ok(session) = sessions.GetSession(j) else { continue };
                    if session.GetState().ok() != Some(AudioSessionStateActive) {
                        continue;
                    }
                    let Ok(session) = session.cast::<IAudioSessionControl2>() else { continue };
                    if let Ok(pid) = session.GetProcessId() {
                        if pid != 0 {
                            pids.push(pid);
                        }
                    }
                }
            }
        }
        pids
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(running: &[&str], on_mic: &[&str], playing: &[&str]) -> SidecarDetectionResult {
        SidecarDetectionResult {
            meeting_apps_running: running.iter().map(|s| s.to_string()).collect(),
            apps_using_mic: on_mic
                .iter()
                .map(|b| SidecarDetectedApp {
                    bundle_id: b.to_string(),
                    display_name: b.to_string(),
                    pid: 42,
                    is_using_mic: true,
                })
                .collect(),
            apps_playing_audio: playing.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn state_of(d: &MeetingDetector) -> MeetingDetectionState {
        d.shared_state.lock().unwrap().state.clone()
    }

    /// Backdate the mic-active start so MIN_MIC_ACTIVE_TIME has elapsed.
    fn backdate_mic_active(d: &MeetingDetector, by: Duration) {
        let mut s = d.shared_state.lock().unwrap();
        s.last_mic_state = true;
        s.mic_active_start = Some(Instant::now() - by);
    }

    const ZOOM: &str = "us.zoom.xos";

    fn zoom_app() -> DetectedApp {
        DetectedApp {
            bundle_id: ZOOM.into(),
            display_name: "Zoom".into(),
            pid: 42,
        }
    }

    #[test]
    fn new_detector_starts_enabled_and_monitoring() {
        let d = MeetingDetector::new();
        assert!(d.is_enabled);
        assert_eq!(state_of(&d), MeetingDetectionState::Monitoring);
    }

    #[test]
    fn no_trigger_before_min_mic_active_time() {
        let d = MeetingDetector::new();
        let effects =
            MeetingDetector::process_result(&d.shared_state, &result(&[ZOOM], &[ZOOM], &[ZOOM]));
        assert!(effects.is_empty());
        assert_eq!(state_of(&d), MeetingDetectionState::Monitoring);
        // The transition was tracked, though.
        assert!(d.shared_state.lock().unwrap().mic_active_start.is_some());
    }

    #[test]
    fn triggers_prompt_after_sustained_mic_activity() {
        let d = MeetingDetector::new();
        backdate_mic_active(&d, Duration::from_secs(6));
        let effects =
            MeetingDetector::process_result(&d.shared_state, &result(&[ZOOM], &[ZOOM], &[ZOOM]));
        assert!(matches!(&effects[..], [Effect::MeetingDetected(app)] if app.bundle_id == ZOOM));
        assert_eq!(state_of(&d), MeetingDetectionState::Detected);
        assert!(d.shared_state.lock().unwrap().dismissed_apps.contains(ZOOM));
    }

    #[test]
    fn auto_record_triggers_auto_start_but_parks_in_detected() {
        let mut d = MeetingDetector::new();
        d.set_auto_record(true);
        backdate_mic_active(&d, Duration::from_secs(6));
        let effects =
            MeetingDetector::process_result(&d.shared_state, &result(&[ZOOM], &[ZOOM], &[ZOOM]));
        assert!(matches!(&effects[..], [Effect::MeetingAutoStart(app)] if app.bundle_id == ZOOM));
        // Recording is entered only when the capture actually starts
        // (recording_started); the HUD countdown window is Detected.
        assert_eq!(state_of(&d), MeetingDetectionState::Detected);
    }

    #[test]
    fn dismissed_app_does_not_retrigger_while_session_alive() {
        let d = MeetingDetector::new();
        d.shared_state
            .lock()
            .unwrap()
            .dismissed_apps
            .insert(ZOOM.into());
        backdate_mic_active(&d, Duration::from_secs(6));
        let effects =
            MeetingDetector::process_result(&d.shared_state, &result(&[ZOOM], &[ZOOM], &[ZOOM]));
        assert!(effects.is_empty());
        assert_eq!(state_of(&d), MeetingDetectionState::Monitoring);
    }

    #[test]
    fn mute_flap_does_not_clear_dismissal_while_output_alive() {
        let d = MeetingDetector::new();
        {
            let mut s = d.shared_state.lock().unwrap();
            s.dismissed_apps.insert(ZOOM.into());
            // Pretend the app has looked "gone" for a while via mic-only
            // silence — but its output is still running (muted-but-in-call).
            s.dismissed_gone_since
                .insert(ZOOM.into(), Instant::now() - Duration::from_secs(60));
        }
        // Output alive → gone-tracker resets, dismissal survives.
        let _ = MeetingDetector::process_result(&d.shared_state, &result(&[ZOOM], &[], &[ZOOM]));
        let s = d.shared_state.lock().unwrap();
        assert!(s.dismissed_apps.contains(ZOOM));
        assert!(!s.dismissed_gone_since.contains_key(ZOOM));
    }

    #[test]
    fn dismissal_expires_after_session_gone() {
        let d = MeetingDetector::new();
        {
            let mut s = d.shared_state.lock().unwrap();
            s.dismissed_apps.insert(ZOOM.into());
            s.dismissed_gone_since
                .insert(ZOOM.into(), Instant::now() - Duration::from_secs(11));
        }
        // App still running but neither mic nor output — session over.
        let _ = MeetingDetector::process_result(&d.shared_state, &result(&[ZOOM], &[], &[]));
        assert!(!d.shared_state.lock().unwrap().dismissed_apps.contains(ZOOM));
    }

    #[test]
    fn retrigger_cooldown_blocks_new_detection() {
        let d = MeetingDetector::new();
        {
            let mut s = d.shared_state.lock().unwrap();
            s.last_recording_stop = Some(Instant::now() - Duration::from_secs(30));
        }
        backdate_mic_active(&d, Duration::from_secs(6));
        let effects =
            MeetingDetector::process_result(&d.shared_state, &result(&[ZOOM], &[ZOOM], &[ZOOM]));
        assert!(effects.is_empty());
        assert_eq!(state_of(&d), MeetingDetectionState::Monitoring);
    }

    #[test]
    fn recording_call_end_emits_meeting_ended_and_sets_cooldown() {
        let d = MeetingDetector::new();
        {
            let mut s = d.shared_state.lock().unwrap();
            s.state = MeetingDetectionState::Recording;
            s.last_mic_state = true;
            s.detected_app = Some(zoom_app());
            // Mic has been inactive past the app-quit threshold.
            s.recording_mic_inactive_since = Some(Instant::now() - Duration::from_secs(6));
        }
        // App quit entirely: not running, no mic, no output.
        let effects = MeetingDetector::process_result(&d.shared_state, &result(&[], &[], &[]));
        assert_eq!(effects, vec![Effect::MeetingEnded]);
        let s = d.shared_state.lock().unwrap();
        assert_eq!(s.state, MeetingDetectionState::Monitoring);
        assert!(s.last_recording_stop.is_some());
    }

    #[test]
    fn detected_call_end_dismisses_hud_without_cooldown() {
        let d = MeetingDetector::new();
        {
            let mut s = d.shared_state.lock().unwrap();
            s.state = MeetingDetectionState::Detected;
            s.last_mic_state = true;
            s.detected_app = Some(zoom_app());
            s.recording_mic_inactive_since = Some(Instant::now() - Duration::from_secs(6));
        }
        let effects = MeetingDetector::process_result(&d.shared_state, &result(&[], &[], &[]));
        assert_eq!(effects, vec![Effect::DismissHud]);
        let s = d.shared_state.lock().unwrap();
        assert_eq!(s.state, MeetingDetectionState::Monitoring);
        // No retrigger cooldown for a call that was never recorded.
        assert!(s.last_recording_stop.is_none());
    }

    #[test]
    fn muted_call_with_output_alive_does_not_end_recording() {
        let d = MeetingDetector::new();
        {
            let mut s = d.shared_state.lock().unwrap();
            s.state = MeetingDetectionState::Recording;
            s.last_mic_state = true;
            s.detected_app = Some(zoom_app());
            s.recording_mic_inactive_since = Some(Instant::now() - Duration::from_secs(120));
        }
        // Mic released (mute) but output still running: call is alive.
        let effects =
            MeetingDetector::process_result(&d.shared_state, &result(&[ZOOM], &[], &[ZOOM]));
        assert!(effects.is_empty());
        let s = d.shared_state.lock().unwrap();
        assert_eq!(s.state, MeetingDetectionState::Recording);
        assert!(s.recording_mic_inactive_since.is_none());
    }

    #[test]
    fn manual_recording_without_observed_call_is_never_autostopped() {
        let d = MeetingDetector::new();
        {
            let mut s = d.shared_state.lock().unwrap();
            s.state = MeetingDetectionState::Recording;
            s.last_mic_state = false; // no meeting app ever seen on mic
        }
        let effects = MeetingDetector::process_result(&d.shared_state, &result(&[], &[], &[]));
        assert!(effects.is_empty());
        assert_eq!(state_of(&d), MeetingDetectionState::Recording);
    }

    #[test]
    fn brief_mic_inactivity_does_not_end_recording() {
        let d = MeetingDetector::new();
        {
            let mut s = d.shared_state.lock().unwrap();
            s.state = MeetingDetectionState::Recording;
            s.last_mic_state = true;
            s.detected_app = Some(zoom_app());
            s.recording_mic_inactive_since = Some(Instant::now() - Duration::from_secs(5));
        }
        // App still running (not quit), mic briefly inactive, no output —
        // 5s < CALL_END_MIC_INACTIVE(30s): keep recording.
        let effects = MeetingDetector::process_result(&d.shared_state, &result(&[ZOOM], &[], &[]));
        assert!(effects.is_empty());
        assert_eq!(state_of(&d), MeetingDetectionState::Recording);
    }

    #[test]
    fn recording_stopped_returns_to_monitoring_and_sets_cooldown() {
        let mut d = MeetingDetector::new();
        d.recording_started();
        assert_eq!(state_of(&d), MeetingDetectionState::Recording);
        d.recording_stopped();
        assert_eq!(state_of(&d), MeetingDetectionState::Monitoring);
        assert!(d.shared_state.lock().unwrap().last_recording_stop.is_some());
    }

    #[test]
    fn recording_stopped_clears_detected_app() {
        let mut d = MeetingDetector::new();
        d.shared_state.lock().unwrap().detected_app = Some(zoom_app());
        d.recording_started();
        d.recording_stopped();
        // A later manual capture must not inherit the old call's app.
        d.recording_started();
        assert!(d.shared_state.lock().unwrap().detected_app.is_none());
    }

    #[test]
    fn set_enabled_false_disables_detector() {
        let mut d = MeetingDetector::new();
        d.set_enabled(false);
        assert!(!d.is_enabled);
        assert_eq!(state_of(&d), MeetingDetectionState::Disabled);
        assert!(!d.status().is_enabled);
    }

    #[test]
    fn dismiss_detection_records_dismissal_and_returns_to_monitoring() {
        let mut d = MeetingDetector::new();
        {
            let mut s = d.shared_state.lock().unwrap();
            s.state = MeetingDetectionState::Detected;
            s.detected_app = Some(zoom_app());
        }
        d.dismiss_detection();
        let s = d.shared_state.lock().unwrap();
        assert_eq!(s.state, MeetingDetectionState::Monitoring);
        assert!(s.dismissed_apps.contains(ZOOM));
        assert!(s.detected_app.is_none());
    }

    #[test]
    fn browser_dismissal_expires_despite_tab_audio() {
        const CHROME: &str = "com.google.Chrome";
        let d = MeetingDetector::new();
        {
            let mut s = d.shared_state.lock().unwrap();
            s.dismissed_apps.insert(CHROME.into());
            s.dismissed_gone_since
                .insert(CHROME.into(), Instant::now() - Duration::from_secs(11));
        }
        // Chrome plays YouTube (output running, no mic): NOT call liveness
        // for a browser — the dismissal must still expire.
        let _ =
            MeetingDetector::process_result(&d.shared_state, &result(&[CHROME], &[], &[CHROME]));
        assert!(!d.shared_state.lock().unwrap().dismissed_apps.contains(CHROME));
    }

    #[test]
    fn recorded_browser_call_ends_despite_tab_audio() {
        const CHROME: &str = "com.google.Chrome";
        let d = MeetingDetector::new();
        {
            let mut s = d.shared_state.lock().unwrap();
            s.state = MeetingDetectionState::Recording;
            s.last_mic_state = true;
            s.detected_app = Some(DetectedApp {
                bundle_id: CHROME.into(),
                display_name: "Chrome".into(),
                pid: 42,
            });
            s.recording_mic_inactive_since = Some(Instant::now() - Duration::from_secs(31));
        }
        // Meet call ended (mic released); a tab now plays music. Browser
        // output must not hold the capture open forever.
        let effects =
            MeetingDetector::process_result(&d.shared_state, &result(&[CHROME], &[], &[CHROME]));
        assert_eq!(effects, vec![Effect::MeetingEnded]);
    }

    #[test]
    fn recording_started_clears_stale_inactivity_tracking() {
        let mut d = MeetingDetector::new();
        {
            let mut s = d.shared_state.lock().unwrap();
            s.state = MeetingDetectionState::Detected;
            s.last_mic_state = true;
            s.detected_app = Some(zoom_app());
            // Inactivity accumulated during the HUD prompt phase…
            s.recording_mic_inactive_since = Some(Instant::now() - Duration::from_secs(29));
        }
        d.recording_started();
        // …must not carry into the fresh capture and end it seconds later.
        let s = d.shared_state.lock().unwrap();
        assert!(s.recording_mic_inactive_since.is_none());
        assert!(!s.last_mic_state);
    }

    #[test]
    fn dismiss_during_live_recording_keeps_recording_state() {
        let mut d = MeetingDetector::new();
        {
            let mut s = d.shared_state.lock().unwrap();
            s.state = MeetingDetectionState::Recording;
            s.detected_app = Some(zoom_app());
        }
        d.dismiss_detection();
        let s = d.shared_state.lock().unwrap();
        // Auto-stop stays armed; the app is still marked dismissed.
        assert_eq!(s.state, MeetingDetectionState::Recording);
        assert!(s.dismissed_apps.contains(ZOOM));
        assert!(s.detected_app.is_some());
    }

    #[test]
    fn other_app_on_mic_does_not_block_detected_apps_call_end() {
        let d = MeetingDetector::new();
        {
            let mut s = d.shared_state.lock().unwrap();
            s.state = MeetingDetectionState::Detected;
            s.last_mic_state = true;
            s.detected_app = Some(zoom_app());
            s.recording_mic_inactive_since = Some(Instant::now() - Duration::from_secs(6));
        }
        // Zoom quit; Teams (a different app) is on the mic. The scoped check
        // must still dismiss the stale Zoom HUD.
        let effects = MeetingDetector::process_result(
            &d.shared_state,
            &result(&["com.microsoft.teams2"], &["com.microsoft.teams2"], &[]),
        );
        assert_eq!(effects, vec![Effect::DismissHud]);
        assert_eq!(state_of(&d), MeetingDetectionState::Monitoring);
    }

    #[test]
    fn unarmed_capture_still_ends_when_detected_app_quits() {
        let d = MeetingDetector::new();
        {
            let mut s = d.shared_state.lock().unwrap();
            s.state = MeetingDetectionState::Recording;
            // Muted through the whole capture: never re-observed on mic.
            s.last_mic_state = false;
            s.detected_app = Some(zoom_app());
            s.recording_mic_inactive_since = Some(Instant::now() - Duration::from_secs(6));
        }
        // Zoom quit entirely → the capture must still auto-stop.
        let effects = MeetingDetector::process_result(&d.shared_state, &result(&[], &[], &[]));
        assert_eq!(effects, vec![Effect::MeetingEnded]);
        assert_eq!(state_of(&d), MeetingDetectionState::Monitoring);
    }

    #[test]
    fn unarmed_capture_with_app_still_running_never_ends() {
        let d = MeetingDetector::new();
        {
            let mut s = d.shared_state.lock().unwrap();
            s.state = MeetingDetectionState::Recording;
            s.last_mic_state = false;
            s.detected_app = Some(zoom_app());
            s.recording_mic_inactive_since = Some(Instant::now() - Duration::from_secs(600));
        }
        // App alive, just never seen on mic — keep recording.
        let effects = MeetingDetector::process_result(&d.shared_state, &result(&[ZOOM], &[], &[]));
        assert!(effects.is_empty());
        assert_eq!(state_of(&d), MeetingDetectionState::Recording);
    }

    #[test]
    fn set_enabled_false_preserves_recording_state() {
        let mut d = MeetingDetector::new();
        d.recording_started();
        d.set_enabled(false);
        // The live capture's Recording state survives the disable so a
        // re-enable can re-arm call-end auto-stop instead of re-detecting
        // the call being recorded; is_enabled still reads false.
        assert_eq!(state_of(&d), MeetingDetectionState::Recording);
        assert!(!d.status().is_enabled);
        // Once the capture stops while disabled, the detector parks Disabled.
        d.recording_stopped();
        assert_eq!(state_of(&d), MeetingDetectionState::Disabled);
    }

    #[test]
    fn disabled_state_processes_nothing() {
        let d = MeetingDetector::new();
        d.shared_state.lock().unwrap().state = MeetingDetectionState::Disabled;
        backdate_mic_active(&d, Duration::from_secs(10));
        let effects =
            MeetingDetector::process_result(&d.shared_state, &result(&[ZOOM], &[ZOOM], &[ZOOM]));
        assert!(effects.is_empty());
        assert_eq!(state_of(&d), MeetingDetectionState::Disabled);
    }

    fn procs(list: &[(u32, u32, &str)]) -> HashMap<u32, WinProcess> {
        list.iter().map(|&(pid, parent, exe)| (pid, WinProcess { parent, exe: exe.to_string(), created: 0 })).collect()
    }

    #[test]
    fn windows_sessions_are_attributed_to_their_meeting_app() {
        // explorer → ms-teams → msedgewebview2 (its audio); chrome → chrome
        // (the audio service); Dial8 → its own WebView2.
        let p = procs(&[
            (4, 0, "explorer.exe"),
            (10, 4, "ms-teams.exe"),
            (11, 10, "msedgewebview2.exe"),
            (20, 4, "chrome.exe"),
            (21, 20, "chrome.exe"),
            (30, 4, "dial8.exe"),
            (31, 30, "msedgewebview2.exe"),
            (40, 4, "spotify.exe"),
        ]);
        let r = windows_detection(&p, &[11, 31], &[11, 21, 40, 30], 30);
        assert_eq!(r.meeting_apps_running, vec!["com.google.Chrome", "com.microsoft.teams2"]);
        assert_eq!(r.apps_using_mic.len(), 1, "Dial8's own web view isn't a meeting");
        assert_eq!((r.apps_using_mic[0].bundle_id.as_str(), r.apps_using_mic[0].pid), ("com.microsoft.teams2", 10));
        assert_eq!(r.apps_playing_audio, vec!["com.google.Chrome", "com.microsoft.teams2"], "Spotify isn't one");
    }

    #[test]
    fn a_reused_parent_pid_cant_loop_the_attribution() {
        let p = procs(&[(5, 6, "msedgewebview2.exe"), (6, 5, "conhost.exe")]);
        assert_eq!(attribute_process(5, &p, 1), None);
        assert_eq!(attribute_process(99, &p, 1), None, "an exited process");
    }

    #[test]
    fn the_walk_stops_at_dial8_the_shell_and_a_reused_parent() {
        // Dial8 opened by a link in Chrome: its web view's mic isn't Chrome's.
        let p = procs(&[(20, 4, "chrome.exe"), (30, 20, "dial8.exe"), (31, 30, "msedgewebview2.exe")]);
        assert_eq!(attribute_process(31, &p, 30), None);
        assert!(windows_detection(&p, &[31], &[], 30).apps_using_mic.is_empty());
        // OBS from the Start menu, explorer's dead parent's pid now Chrome's.
        let p = procs(&[(7, 0, "chrome.exe"), (4, 7, "explorer.exe"), (50, 4, "obs64.exe")]);
        assert_eq!(attribute_process(50, &p, 1), None);
        // A parent that started after its child: a reused pid, not the parent.
        let mut p = procs(&[(8, 0, "zoom.exe"), (60, 8, "helper.exe")]);
        p.get_mut(&8).unwrap().created = 2_000;
        p.get_mut(&60).unwrap().created = 1_000;
        assert_eq!(attribute_process(60, &p, 1), None);
        p.get_mut(&8).unwrap().created = 500;
        assert_eq!(attribute_process(60, &p, 1).map(|a| a.1), Some("us.zoom.xos"));
    }

    #[test]
    fn windows_browsers_count_like_the_macs() {
        assert!(!output_counts_as_call_liveness("com.microsoft.edgemac"));
        assert!(!output_counts_as_call_liveness("org.mozilla.firefox"));
        assert!(output_counts_as_call_liveness("com.microsoft.teams2"));
    }
}
