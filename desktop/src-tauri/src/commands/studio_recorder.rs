//! Studio recorder: screen, window, camera and microphone takes for Studio
//! (making videos and ads), recorded natively by the `studio-recorder` Swift
//! sidecar (src-tauri/sidecars/studio-recorder) and handed to the web as local
//! files it uploads with [`studio_recorder_upload`].
//!
//! The sidecar is a long-lived child process spoken to in JSON lines over
//! stdin/stdout (`{"id", "cmd", ...}` → `{"id", "ok", ...}`; events carry
//! `event` instead of `id`). It starts on the first command and exits when its
//! stdin closes, so it can never outlive the app; a take still recording then
//! is finalized first and stays on disk for the launch sweep.
//!
//! Bridge contract (web/src/lib/tauri-bridge.ts `studioRecorder`, types in
//! web/src/lib/studio/recorder-bridge-types.ts):
//! - commands `studio_recorder_{permissions, request_permissions, targets,
//!   start, stop, cancel, upload, discard, show_control, hide_control}`;
//! - events `studio-recorder://status` { sessionId, elapsedMs, bytes, levels },
//!   `studio-recorder://stopped` (the stop payload, or { sessionId, cancelled }),
//!   `studio-recorder://error` { sessionId?, message, fatal },
//!   `studio-recorder://upload` { sessionId, role, uploadedBytes, totalBytes, partsDone, partsTotal }.
//!
//! What the page can choose is deliberately narrow: what to record (a display
//! or window id, device ids, flags). It never names a path: each take's files
//! live in a folder this module picks (`<app cache>/studio-takes/<session>`),
//! and upload/discard address a take by its session id and a file by its role.
//! Takes older than three days are swept at launch.
//!
//! Local transcription: while a take records with a microphone, the sidecar
//! also writes that microphone as 16 kHz mono PCM (`mic-16k.f32`); when the
//! local-stt module is ready, a task tails that file into an on-device
//! transcription session (the same sidecar and adapter chat voice uses,
//! modules::stt::start_voice) as it grows, so the words are ready moments
//! after Stop. Their times are moved onto the screen's clock. Not ready (or
//! it fails): `transcript: null` and the web asks the server instead. The
//! app's own capture microphone (cpal) is never touched.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

use crate::log_to_file;
use crate::modules::stt;
use crate::sidecar::NoConsole;

/// The sidecar's executable name (scripts/sidecars.sh stages it into Contents/MacOS).
pub const SIDECAR: &str = "studio-recorder";
/// The floating recording control's window label.
pub const CONTROL_LABEL: &str = "studio-recorder";

pub const STATUS_EVENT: &str = "studio-recorder://status";
pub const STOPPED_EVENT: &str = "studio-recorder://stopped";
pub const ERROR_EVENT: &str = "studio-recorder://error";
pub const UPLOAD_EVENT: &str = "studio-recorder://upload";

/// A take's folder under the app's cache dir.
const TAKES_DIR: &str = "studio-takes";
/// The launch sweep removes takes older than this.
const KEEP_TAKES_FOR: Duration = Duration::from_secs(3 * 24 * 60 * 60);
/// Most answers are immediate; a stop finalizes files (seconds).
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
/// A permission request waits on the person.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
/// How long Stop waits for the on-device words once the audio is in.
const TRANSCRIPT_TIMEOUT: Duration = Duration::from_secs(90);
/// Parts sent at once.
const UPLOAD_CONCURRENCY: usize = 3;
/// Tries per part (the first and three retries, backing off 1, 2, 4 s).
const UPLOAD_TRIES: u32 = 4;
/// One part is read into memory to send (and resend): bound it.
const MAX_PART_BYTES: u64 = 512 * 1024 * 1024;

/// The privacy services `studio_recorder_request_permissions` may ask for.
const SERVICES: [&str; 5] = ["screenRecording", "accessibility", "inputMonitoring", "camera", "microphone"];

// ---- managed state ------------------------------------------------------------

/// The running sidecar: its stdin and whether its stdout is still open.
struct Proc {
    stdin: ChildStdin,
    alive: Arc<AtomicBool>,
}

/// One take, from start to discard.
struct Take {
    dir: PathBuf,
    /// The take was recorded without the system cursor.
    hide_cursor: bool,
    /// The `stopped` payload once stopped (stop is idempotent).
    stopped: Option<Value>,
    stt: Option<SttTap>,
}

#[derive(Default)]
pub struct StudioRecorder {
    proc: Mutex<Option<Proc>>,
    pending: Arc<StdMutex<HashMap<u64, oneshot::Sender<Value>>>>,
    next_id: AtomicU64,
    takes: StdMutex<HashMap<String, Take>>,
    /// Serializes start/stop/cancel/discard, so a Stop from the control and
    /// one from the Studio page settle on one result.
    lifecycle: Mutex<()>,
}

impl StudioRecorder {
    pub fn new() -> Self {
        Self::default()
    }
}

/// `code: message` for a refusal the web can tell apart (tauri-bridge reads the code).
fn refusal(code: &str, message: impl std::fmt::Display) -> String {
    format!("{code}: {message}")
}

// ---- the sidecar link -----------------------------------------------------------

impl StudioRecorder {
    /// Send `cmd` and wait for its answer (minus `id`/`ok`). A refusal comes
    /// back as `Err("<code>: <message>")`.
    async fn call(&self, app: &AppHandle, cmd: &str, args: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let mut line = args;
        if !line.is_object() {
            line = json!({});
        }
        line["id"] = json!(id);
        line["cmd"] = json!(cmd);
        let mut text = line.to_string();
        text.push('\n');

        {
            let mut guard = self.proc.lock().await;
            let needs_spawn = guard.as_ref().map_or(true, |p| !p.alive.load(Ordering::SeqCst));
            if needs_spawn {
                *guard = Some(self.spawn(app)?);
            }
            let proc = guard.as_mut().expect("spawned above");
            if let Err(e) = proc.stdin.write_all(text.as_bytes()).await {
                proc.alive.store(false, Ordering::SeqCst);
                self.pending.lock().unwrap().remove(&id);
                return Err(refusal("unavailable", format!("the recorder is not running: {e}")));
            }
            let _ = proc.stdin.flush().await;
        }

        let reply = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => return Err(refusal("unavailable", "the recorder stopped before answering")),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                return Err(refusal("timeout", format!("the recorder did not answer {cmd} in time")));
            }
        };
        if reply.get("ok").and_then(Value::as_bool) == Some(true) {
            let mut out = reply;
            if let Some(map) = out.as_object_mut() {
                map.remove("id");
                map.remove("ok");
            }
            Ok(out)
        } else {
            let code = reply.get("code").and_then(Value::as_str).unwrap_or("failed");
            let message = reply.get("error").and_then(Value::as_str).unwrap_or("the recorder refused");
            Err(refusal(code, message))
        }
    }

    fn spawn(&self, app: &AppHandle) -> Result<Proc, String> {
        let exe = crate::sidecar::path(SIDECAR)
            .ok_or_else(|| refusal("unavailable", "this build has no studio recorder"))?;
        // Not kill_on_drop: at quit the sidecar sees its stdin close and
        // finalizes a take that is still recording before it exits.
        let mut child = Command::new(&exe)
            .no_console()
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| refusal("unavailable", format!("could not start the recorder: {e}")))?;
        log_to_file(&format!("[studio-recorder] spawned {} (pid {:?})", exe.display(), child.id()));
        let stdin = child.stdin.take().ok_or_else(|| refusal("unavailable", "no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| refusal("unavailable", "no stdout"))?;
        if let Some(stderr) = child.stderr.take() {
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log_to_file(&line);
                }
            });
        }
        let alive = Arc::new(AtomicBool::new(true));
        let pending = self.pending.clone();
        let app = app.clone();
        let reader_alive = alive.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    log_to_file(&format!("[studio-recorder] not JSON: {line}"));
                    continue;
                };
                if let Some(id) = value.get("id").and_then(Value::as_u64) {
                    if let Some(tx) = pending.lock().unwrap().remove(&id) {
                        let _ = tx.send(value);
                    }
                } else {
                    on_event(&app, value);
                }
            }
            reader_alive.store(false, Ordering::SeqCst);
            // Everyone still waiting learns the recorder is gone.
            pending.lock().unwrap().clear();
            let _ = child.wait().await;
            log_to_file("[studio-recorder] sidecar exited");
            let _ = app.emit(ERROR_EVENT, json!({ "sessionId": Value::Null, "message": "The recorder stopped.", "fatal": true }));
        });
        Ok(Proc { stdin, alive })
    }
}

/// An event line from the sidecar → the matching webview event.
fn on_event(app: &AppHandle, value: Value) {
    match value.get("event").and_then(Value::as_str) {
        Some("status") => {
            let _ = app.emit(
                STATUS_EVENT,
                json!({
                    "sessionId": value.get("sessionId"),
                    "elapsedMs": value.get("elapsedMs"),
                    "bytes": value.get("bytes"),
                    "levels": value.get("levels"),
                    "level": value.pointer("/levels/mic").and_then(Value::as_f64).unwrap_or(0.0),
                }),
            );
        }
        Some("error") => {
            log_to_file(&format!("[studio-recorder] error: {value}"));
            let _ = app.emit(
                ERROR_EVENT,
                json!({
                    "sessionId": value.get("sessionId"),
                    "message": value.get("message"),
                    "fatal": value.get("fatal").and_then(Value::as_bool).unwrap_or(false),
                }),
            );
        }
        Some("hello") => log_to_file(&format!("[studio-recorder] hello {value}")),
        _ => log_to_file(&format!("[studio-recorder] unknown event {value}")),
    }
}

// ---- takes on disk ----------------------------------------------------------------

/// `<app cache>/studio-takes`.
fn takes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|dir| dir.join(TAKES_DIR))
        .map_err(|e| refusal("unavailable", format!("no cache folder: {e}")))
}

/// A session id this module minted (a UUID): the only names a take folder has.
fn valid_session_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok()
}

/// Remove take folders older than [`KEEP_TAKES_FOR`] (by their last write).
/// Only UUID-named folders directly under `base` are touched.
pub fn sweep(base: &Path, keep_for: Duration, now: SystemTime) -> usize {
    let Ok(entries) = std::fs::read_dir(base) else { return 0 };
    let oldest = now.checked_sub(keep_for).unwrap_or(SystemTime::UNIX_EPOCH);
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let named = path.file_name().and_then(|n| n.to_str()).is_some_and(valid_session_id);
        let Ok(meta) = entry.metadata() else { continue };
        if !named || !meta.is_dir() {
            continue;
        }
        let written = meta.modified().unwrap_or(now);
        if written < oldest && std::fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// The launch sweep, on a thread of its own.
pub fn sweep_in_background(app: &AppHandle) {
    let Ok(base) = takes_dir(app) else { return };
    let _ = std::thread::Builder::new().name("studio-takes-sweep".into()).spawn(move || {
        let removed = sweep(&base, KEEP_TAKES_FOR, SystemTime::now());
        if removed > 0 {
            log_to_file(&format!("[studio-recorder] removed {removed} take(s) older than three days"));
        }
    });
}

// ---- start options ---------------------------------------------------------------

/// What to record. Deliberately no path, folder or window to exclude: the
/// app decides where files go (tests/app_commands.rs pins this).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioRecorderStartOptions {
    pub screen: ScreenTarget,
    #[serde(default)]
    pub hide_cursor: bool,
    #[serde(default)]
    pub camera: Option<DeviceRef>,
    #[serde(default)]
    pub microphone: Option<DeviceRef>,
    #[serde(default)]
    pub system_audio: bool,
    #[serde(default)]
    pub extra_windows: Vec<WindowRef>,
    #[serde(default)]
    pub extra_cameras: Vec<DeviceRef>,
    #[serde(default)]
    pub fps: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScreenTarget {
    Display {
        #[serde(default, rename = "displayId")]
        display_id: Option<u32>,
    },
    Window {
        #[serde(rename = "windowId")]
        window_id: u32,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRef {
    /// A device id from `studio_recorder_targets`; absent = the system default.
    #[serde(default)]
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRef {
    pub window_id: u32,
}

impl StudioRecorderStartOptions {
    /// The sidecar's `start` message for a take in `dir`.
    fn to_sidecar(&self, session_id: &str, dir: &Path) -> Result<Value, String> {
        let fps = self.fps.unwrap_or(60);
        if fps != 60 && fps != 30 {
            return Err(refusal("bad-request", "fps must be 60 or 30"));
        }
        if self.extra_windows.len() + self.extra_cameras.len() > 6 {
            return Err(refusal("bad-request", "at most 6 extra windows and cameras"));
        }
        let device = |d: &DeviceRef| json!({ "deviceId": d.device_id.clone().unwrap_or_else(|| "default".into()) });
        let screen = match &self.screen {
            ScreenTarget::Display { display_id } => json!({ "kind": "display", "displayId": display_id }),
            ScreenTarget::Window { window_id } => json!({ "kind": "window", "windowId": window_id }),
        };
        Ok(json!({
            "sessionId": session_id,
            "outputDir": dir.to_string_lossy(),
            "screen": screen,
            "hideCursor": self.hide_cursor,
            "camera": self.camera.as_ref().map(device),
            "microphone": self.microphone.as_ref().map(device),
            "systemAudio": self.system_audio,
            "extraWindows": self.extra_windows.iter().map(|w| json!({ "windowId": w.window_id })).collect::<Vec<_>>(),
            "extraCameras": self.extra_cameras.iter().map(device).collect::<Vec<_>>(),
            "fps": fps,
            "transcriptionPcm": self.microphone.is_some(),
        }))
    }
}

// ---- on-device transcription of the take's microphone ------------------------------------

/// The tail task feeding a take's 16 kHz microphone file to local-stt.
struct SttTap {
    /// Set once the sidecar has finished the file: read to its end, then finish.
    done: Arc<AtomicBool>,
    task: tauri::async_runtime::JoinHandle<Option<Vec<stt::SttWord>>>,
}

impl SttTap {
    fn start(launch: crate::modules::manager::LaunchConfig, path: PathBuf) -> SttTap {
        let done = Arc::new(AtomicBool::new(false));
        let flag = done.clone();
        let task = tauri::async_runtime::spawn(async move { tail(launch, path, flag).await });
        SttTap { done, task }
    }
}

/// Feed `path` (growing f32le PCM) to a local-stt session until `done` and
/// the end of the file; the final words in order, or None if the engine
/// failed.
async fn tail(launch: crate::modules::manager::LaunchConfig, path: PathBuf, done: Arc<AtomicBool>) -> Option<Vec<stt::SttWord>> {
    let (sink, mut handle) = stt::start_voice(launch);
    let mut words: Vec<stt::SttWord> = Vec::new();
    let mut failed = false;
    // Final words are kept; a failure ends the transcript (the web falls back).
    fn collect(event: stt::VoiceSttEvent, words: &mut Vec<stt::SttWord>, failed: &mut bool) {
        match event {
            stt::VoiceSttEvent::Results(r) if r.is_final => words.extend(r.words),
            stt::VoiceSttEvent::Failed { reason } => {
                log_to_file(&format!("[studio-recorder] local transcription failed: {reason}"));
                *failed = true;
            }
            _ => {}
        }
    }

    let mut file = loop {
        match tokio::fs::File::open(&path).await {
            Ok(f) => break Some(f),
            Err(_) if !done.load(Ordering::SeqCst) => tokio::time::sleep(Duration::from_millis(200)).await,
            Err(_) => break None,
        }
    };
    let mut buf = vec![0u8; 64 * 1024];
    let mut carry: Vec<u8> = Vec::new();
    while let Some(f) = file.as_mut() {
        while let Ok(event) = handle.events.try_recv() {
            collect(event, &mut words, &mut failed);
        }
        if failed {
            return None;
        }
        // Read the flag before reading: EOF after it was set is the real end.
        let finished = done.load(Ordering::SeqCst);
        let n = match f.read(&mut buf).await {
            Ok(n) => n,
            Err(e) => {
                log_to_file(&format!("[studio-recorder] transcription read failed: {e}"));
                break;
            }
        };
        if n == 0 {
            if finished {
                break;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
            continue;
        }
        carry.extend_from_slice(&buf[..n]);
        let whole = carry.len() / 4 * 4;
        let samples: Vec<f32> = carry[..whole].chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
        carry.drain(..whole);
        if !sink.push_wait(stt::STREAM_MIC, &samples).await {
            break;
        }
    }
    handle.close();
    let flushed = tokio::time::timeout(TRANSCRIPT_TIMEOUT, async {
        while let Some(event) = handle.events.recv().await {
            let end = matches!(event, stt::VoiceSttEvent::Finished | stt::VoiceSttEvent::Failed { .. });
            collect(event, &mut words, &mut failed);
            if end {
                break;
            }
        }
    })
    .await
    .is_ok();
    if failed || !flushed {
        return None;
    }
    Some(words)
}

/// The words on the screen's clock: `offset_ms` is where the PCM's first
/// sample falls after the screen's first frame.
fn transcript_json(words: &[stt::SttWord], offset_ms: f64) -> Value {
    let words: Vec<Value> = words
        .iter()
        .filter(|w| !w.word.trim().is_empty())
        .map(|w| {
            let start = (offset_ms + w.start * 1000.0).round().max(0.0);
            let end = (offset_ms + w.end * 1000.0).round().max(start);
            json!({ "text": w.word, "startMs": start, "endMs": end, "confidence": w.confidence })
        })
        .collect();
    json!({ "engine": "local", "words": words })
}

// ---- commands ------------------------------------------------------------------------

/// `{screenRecording, accessibility, inputMonitoring, camera, microphone}`,
/// each `granted | denied | undetermined`, plus `trace: {level, reason}`
/// (what the input trace can record with these grants). Never prompts.
#[tauri::command]
pub async fn studio_recorder_permissions(app: AppHandle) -> Result<Value, String> {
    let recorder = app.state::<StudioRecorder>();
    recorder.call(&app, "permissions", json!({}), CALL_TIMEOUT).await
}

/// Ask macOS for `which` (any of [`SERVICES`]): the system prompt when not
/// yet determined, System Settings when denied. `{results: {service:
/// granted|denied|prompted|opened-settings}, permissions}`.
#[tauri::command]
pub async fn studio_recorder_request_permissions(app: AppHandle, which: Vec<String>) -> Result<Value, String> {
    if let Some(unknown) = which.iter().find(|w| !SERVICES.contains(&w.as_str())) {
        return Err(refusal("bad-request", format!("unknown service {unknown}")));
    }
    let recorder = app.state::<StudioRecorder>();
    recorder.call(&app, "requestPermissions", json!({ "which": which }), REQUEST_TIMEOUT).await
}

/// `{displays, apps: [{pid, bundleId, name, windows}], cameras, microphones}`.
#[tauri::command]
pub async fn studio_recorder_targets(app: AppHandle) -> Result<Value, String> {
    let recorder = app.state::<StudioRecorder>();
    recorder.call(&app, "targets", json!({}), CALL_TIMEOUT).await
}

/// Start a take and show the floating recording control for it. Answers the
/// sidecar's `started` payload with `sessionId` and `transcription: "local" | "none"`.
#[tauri::command]
pub async fn studio_recorder_start(app: AppHandle, options: StudioRecorderStartOptions) -> Result<Value, String> {
    let recorder = app.state::<StudioRecorder>();
    let _lifecycle = recorder.lifecycle.lock().await;
    let session_id = uuid::Uuid::new_v4().to_string();
    let dir = takes_dir(&app)?.join(&session_id);
    std::fs::create_dir_all(&dir).map_err(|e| refusal("io", format!("could not make the take's folder: {e}")))?;
    let message = options.to_sidecar(&session_id, &dir)?;
    let mut started = match recorder.call(&app, "start", message, CALL_TIMEOUT).await {
        Ok(v) => v,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
    };

    // On-device words for the take, when the module is ready.
    let pcm = started
        .pointer("/transcriptionPcm/path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .filter(|p| p.starts_with(&dir));
    let launch = pcm.as_ref().and_then(|_| app.state::<crate::modules::ModuleManager>().launch_config(&app, stt::MODULE_ID));
    let stt = match (pcm, launch) {
        (Some(path), Some(launch)) => Some(SttTap::start(launch, path)),
        _ => None,
    };

    // The control is shown here, not left to the page: a take never records
    // with nothing on screen saying so. No control, no take.
    if let Err(e) = show_control_from_async(&app, &session_id).await {
        log_to_file(&format!("[studio-recorder] take {session_id} cancelled: the control could not be shown: {e}"));
        let _ = recorder.call(&app, "cancel", json!({ "sessionId": session_id }), CALL_TIMEOUT).await;
        if let Some(tap) = stt {
            tap.done.store(true, Ordering::SeqCst);
            tap.task.abort();
        }
        remove_take_dir(&app, &dir);
        return Err(e);
    }

    started["sessionId"] = json!(session_id);
    started["transcription"] = json!(if stt.is_some() { "local" } else { "none" });
    if let Some(map) = started.as_object_mut() {
        // Internal: the page never needs the raw paths of these.
        map.remove("transcriptionPcm");
        map.remove("trace");
    }
    recorder.takes.lock().unwrap().insert(session_id.clone(), Take { dir, hide_cursor: options.hide_cursor, stopped: None, stt });
    log_to_file(&format!("[studio-recorder] take {session_id} started"));
    Ok(started)
}

/// Stop the take: `{sessionId, t0, endedAt, durationMs, files, trace,
/// tracePath, traceMode, transcript, sourceCursorHidden, warnings}`. Idempotent: a second stop answers the
/// first one's payload. Also emitted as `studio-recorder://stopped`.
#[tauri::command]
pub async fn studio_recorder_stop(app: AppHandle, session_id: String) -> Result<Value, String> {
    let recorder = app.state::<StudioRecorder>();
    let _lifecycle = recorder.lifecycle.lock().await;
    let (stt, hide_cursor) = {
        let mut takes = recorder.takes.lock().unwrap();
        let take = takes.get_mut(&session_id).ok_or_else(|| refusal("not-found", "no such take"))?;
        if let Some(stopped) = &take.stopped {
            return Ok(stopped.clone());
        }
        (take.stt.take(), take.hide_cursor)
    };
    let mut stopped = match recorder.call(&app, "stop", json!({ "sessionId": session_id }), CALL_TIMEOUT).await {
        Ok(v) => v,
        Err(e) => {
            if let Some(tap) = stt {
                tap.done.store(true, Ordering::SeqCst);
                tap.task.abort();
            }
            return Err(e);
        }
    };

    // The trace, inlined (the editor reads it as is).
    let trace = stopped
        .get("tracePath")
        .and_then(Value::as_str)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or(Value::Null);
    stopped["trace"] = trace;

    // The on-device words: the file is complete now, so the tail reads to its end.
    let offset_ms = stopped.pointer("/transcriptionPcm/offsetMs").and_then(Value::as_f64);
    let transcript = match (stt, offset_ms) {
        (Some(tap), Some(offset)) => {
            tap.done.store(true, Ordering::SeqCst);
            match tokio::time::timeout(TRANSCRIPT_TIMEOUT + Duration::from_secs(30), tap.task).await {
                Ok(Ok(Some(words))) => transcript_json(&words, offset),
                _ => Value::Null,
            }
        }
        (Some(tap), None) => {
            tap.done.store(true, Ordering::SeqCst);
            tap.task.abort();
            Value::Null
        }
        _ => Value::Null,
    };
    stopped["transcript"] = transcript;
    stopped["sourceCursorHidden"] = json!(hide_cursor);
    stopped["sessionId"] = json!(session_id);
    if let Some(map) = stopped.as_object_mut() {
        map.remove("transcriptionPcm");
    }

    if let Some(take) = recorder.takes.lock().unwrap().get_mut(&session_id) {
        take.stopped = Some(stopped.clone());
    }
    let _ = app.emit(STOPPED_EVENT, &stopped);
    log_to_file(&format!("[studio-recorder] take {session_id} stopped"));
    Ok(stopped)
}

/// Stop the take and delete its files. Emits `studio-recorder://stopped`
/// with `{sessionId, cancelled: true}`.
#[tauri::command]
pub async fn studio_recorder_cancel(app: AppHandle, session_id: String) -> Result<Value, String> {
    let recorder = app.state::<StudioRecorder>();
    let _lifecycle = recorder.lifecycle.lock().await;
    let take = recorder.takes.lock().unwrap().remove(&session_id);
    let Some(mut take) = take else {
        return Err(refusal("not-found", "no such take"));
    };
    if take.stopped.is_none() {
        let _ = recorder.call(&app, "cancel", json!({ "sessionId": session_id }), CALL_TIMEOUT).await;
    }
    if let Some(tap) = take.stt.take() {
        tap.done.store(true, Ordering::SeqCst);
        tap.task.abort();
    }
    remove_take_dir(&app, &take.dir);
    let payload = json!({ "sessionId": session_id, "cancelled": true });
    let _ = app.emit(STOPPED_EVENT, &payload);
    Ok(payload)
}

/// Delete a stopped take's files (after its uploads committed). A take still
/// recording is cancelled.
#[tauri::command]
pub async fn studio_recorder_discard(app: AppHandle, session_id: String) -> Result<(), String> {
    let recording = {
        let recorder = app.state::<StudioRecorder>();
        let takes = recorder.takes.lock().unwrap();
        match takes.get(&session_id) {
            None => None,
            Some(take) => Some(take.stopped.is_none()),
        }
    };
    match recording {
        Some(true) => studio_recorder_cancel(app, session_id).await.map(|_| ()),
        Some(false) => {
            let recorder = app.state::<StudioRecorder>();
            let _lifecycle = recorder.lifecycle.lock().await;
            if let Some(take) = recorder.takes.lock().unwrap().remove(&session_id) {
                remove_take_dir(&app, &take.dir);
            }
            Ok(())
        }
        // A take from an earlier run (or already gone): remove its folder if
        // it is one of ours.
        None => {
            if valid_session_id(&session_id) {
                if let Ok(base) = takes_dir(&app) {
                    remove_take_dir(&app, &base.join(&session_id));
                }
            }
            Ok(())
        }
    }
}

/// Remove a take folder, only ever one directly under the takes dir.
fn remove_take_dir(app: &AppHandle, dir: &Path) {
    let Ok(base) = takes_dir(app) else { return };
    let ours = dir.parent() == Some(base.as_path())
        && dir.file_name().and_then(|n| n.to_str()).is_some_and(valid_session_id);
    if ours {
        let _ = std::fs::remove_dir_all(dir);
    }
}

// ---- upload ----------------------------------------------------------------------------

/// One signed part of an upload: bytes `[index × partBytes, + bytes)` of the
/// file go to `url` with `headers` (partBytes = the first part's `bytes`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadPart {
    pub index: u64,
    pub bytes: u64,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
}

/// The hosts the app's own storage is served from: `sb.<app domain>` for each
/// app domain (web/src/lib/app-url.ts `APP_DOMAINS`). A take's files go
/// nowhere else.
const UPLOAD_HOSTS: [&str; 2] = ["sb.nativeintelligence.dev", "sb.dial8.ai"];
/// The only request headers a part may carry from the page; any other is dropped.
const UPLOAD_HEADERS: [&str; 3] = ["content-type", "x-upsert", "cache-control"];

/// Where a part may be sent: https to one of [`UPLOAD_HOSTS`] on the default
/// port. A debug build also allows https to any `*.supabase.co` project and
/// http or https to this machine (the local dev stack).
fn allowed_upload_url(url: &str) -> bool {
    upload_url_allowed(url, cfg!(debug_assertions))
}

/// [`allowed_upload_url`] with the build kind passed in (so tests cover both).
/// Hosts compare exactly: the parser lowercases them, and a trailing dot,
/// credentials before the host or a port other than the default are refused.
fn upload_url_allowed(url: &str, debug: bool) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else { return false };
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return false;
    }
    // Lowercased (and IPs normalized, IPv6 in brackets) by the parser.
    let Some(host) = parsed.host_str().map(str::to_ascii_lowercase) else { return false };
    let loopback = host == "localhost"
        || host
            .strip_prefix('[')
            .and_then(|h| h.strip_suffix(']'))
            .unwrap_or(&host)
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if debug && loopback {
        return matches!(parsed.scheme(), "https" | "http");
    }
    if parsed.scheme() != "https" || parsed.port().is_some() {
        return false;
    }
    if UPLOAD_HOSTS.contains(&host.as_str()) {
        return true;
    }
    // `<project>.supabase.co`: the dot is part of the suffix, so `evilsupabase.co` fails.
    debug && host.strip_suffix(".supabase.co").is_some_and(|project| !project.is_empty() && !project.ends_with('.'))
}

/// The headers of `headers` a part may carry ([`UPLOAD_HEADERS`], any case),
/// by name; the rest are dropped without a word.
fn upload_headers(headers: &HashMap<String, String>) -> Vec<(&str, &str)> {
    let mut kept: Vec<(&str, &str)> = headers
        .iter()
        .filter(|(name, _)| UPLOAD_HEADERS.iter().any(|allowed| name.eq_ignore_ascii_case(allowed)))
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect();
    kept.sort();
    kept
}

/// The byte range of each part: `(offset, len)`, checked against the file.
fn part_ranges(parts: &[UploadPart], file_len: u64) -> Result<Vec<(u64, u64)>, String> {
    let part_bytes = parts.first().map(|p| p.bytes).ok_or_else(|| refusal("bad-request", "no parts"))?;
    if part_bytes == 0 || part_bytes > MAX_PART_BYTES {
        return Err(refusal("bad-request", format!("a part must be 1 byte to {} MB", MAX_PART_BYTES / 1024 / 1024)));
    }
    parts
        .iter()
        .map(|p| {
            let offset = p.index.checked_mul(part_bytes).ok_or_else(|| refusal("bad-request", "part offset overflows"))?;
            if p.bytes == 0 || p.bytes > part_bytes || offset.checked_add(p.bytes).map_or(true, |end| end > file_len) {
                return Err(refusal("bad-request", format!("part {} is outside the file", p.index)));
            }
            Ok((offset, p.bytes))
        })
        .collect()
}

async fn read_range(path: &Path, offset: u64, len: u64) -> std::io::Result<bytes::Bytes> {
    use tokio::io::AsyncSeekExt;
    let mut file = tokio::fs::File::open(path).await?;
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    let mut buf = vec![0u8; len as usize];
    file.read_exact(&mut buf).await?;
    Ok(bytes::Bytes::from(buf))
}

/// PUT one part, retrying network errors, 429 and 5xx. Its ETag (S3-style
/// multipart completion needs it), if the store sent one.
async fn put_part(client: &reqwest::Client, part: &UploadPart, body: bytes::Bytes) -> Result<Option<String>, String> {
    let mut last = String::new();
    for attempt in 0..UPLOAD_TRIES {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_secs(1 << (attempt - 1))).await;
        }
        let mut request = client.put(&part.url).body(body.clone());
        for (name, value) in upload_headers(&part.headers) {
            request = request.header(name, value);
        }
        // Long enough for a slow link: 60 s plus 4 s per MB.
        let timeout = Duration::from_secs(60 + 4 * (body.len() as u64 / (1024 * 1024)));
        match request.timeout(timeout).send().await {
            Ok(response) if response.status().is_success() => {
                return Ok(response.headers().get("etag").and_then(|v| v.to_str().ok()).map(str::to_string));
            }
            Ok(response) if response.status().is_redirection() => {
                // The client follows no redirect: a part goes to the URL checked, or nowhere.
                last = format!("part {} answered {}: the app does not follow redirects", part.index, response.status());
                break;
            }
            Ok(response) => {
                let status = response.status();
                last = format!("part {} answered {}", part.index, status);
                if !(status.is_server_error() || status.as_u16() == 429 || status.as_u16() == 408) {
                    break;
                }
            }
            Err(e) => last = format!("part {} failed: {}", part.index, e),
        }
    }
    Err(refusal("upload", last))
}

/// Upload a stopped take's file `role` to signed part URLs, straight from
/// disk (never through the web view), three parts at a time, emitting
/// `studio-recorder://upload` as parts land. `{bytes, sha256, parts: [{index, etag}]}`.
#[tauri::command]
pub async fn studio_recorder_upload(app: AppHandle, session_id: String, role: String, parts: Vec<UploadPart>) -> Result<Value, String> {
    let path = {
        let recorder = app.state::<StudioRecorder>();
        let takes = recorder.takes.lock().unwrap();
        let take = takes.get(&session_id).ok_or_else(|| refusal("not-found", "no such take"))?;
        let stopped = take.stopped.as_ref().ok_or_else(|| refusal("recording", "stop the take before uploading it"))?;
        let file = stopped
            .get("files")
            .and_then(Value::as_array)
            .and_then(|files| files.iter().find(|f| f.get("role").and_then(Value::as_str) == Some(role.as_str())))
            .ok_or_else(|| refusal("not-found", format!("the take has no {role} file")))?;
        let path = PathBuf::from(file.get("path").and_then(Value::as_str).unwrap_or_default());
        if !path.starts_with(&take.dir) {
            return Err(refusal("not-found", "the file is not in the take's folder"));
        }
        path
    };
    if let Some(bad) = parts.iter().find(|p| !allowed_upload_url(&p.url)) {
        return Err(refusal("bad-request", format!("part {} has a URL the app won't upload to", bad.index)));
    }
    let file_len = tokio::fs::metadata(&path).await.map_err(|e| refusal("io", e))?.len();
    let ranges = part_ranges(&parts, file_len)?;

    let hash_path = path.clone();
    let sha256 = tauri::async_runtime::spawn_blocking(move || crate::modules::assets::sha256_file(&hash_path))
        .await
        .map_err(|e| refusal("io", e))?
        .map_err(|e| refusal("io", e))?;

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        // A redirect could carry the bytes to a host the allowlist never saw.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| refusal("upload", e))?;
    let total: u64 = ranges.iter().map(|r| r.1).sum();
    let uploaded = Arc::new(AtomicU64::new(0));
    let done = Arc::new(AtomicU64::new(0));
    let parts_total = parts.len();
    let mut etags: Vec<(u64, Option<String>)> = Vec::with_capacity(parts.len());
    let mut queue = parts.into_iter().zip(ranges).collect::<Vec<_>>().into_iter();
    let mut running = tokio::task::JoinSet::new();
    loop {
        while running.len() < UPLOAD_CONCURRENCY {
            let Some((part, (offset, len))) = queue.next() else { break };
            let (client, path, app, session_id, role) = (client.clone(), path.clone(), app.clone(), session_id.clone(), role.clone());
            let (uploaded, done) = (uploaded.clone(), done.clone());
            running.spawn(async move {
                let body = read_range(&path, offset, len).await.map_err(|e| refusal("io", e))?;
                let etag = put_part(&client, &part, body).await?;
                let sent = uploaded.fetch_add(len, Ordering::SeqCst) + len;
                let parts_done = done.fetch_add(1, Ordering::SeqCst) + 1;
                let _ = app.emit(
                    UPLOAD_EVENT,
                    json!({ "sessionId": session_id, "role": role, "uploadedBytes": sent, "totalBytes": total,
                            "partsDone": parts_done, "partsTotal": parts_total,
                            "fraction": if total > 0 { sent as f64 / total as f64 } else { 1.0 } }),
                );
                Ok::<_, String>((part.index, etag))
            });
        }
        match running.join_next().await {
            None => break,
            Some(Ok(Ok(row))) => etags.push(row),
            Some(Ok(Err(e))) => {
                running.abort_all();
                return Err(e);
            }
            Some(Err(e)) => {
                running.abort_all();
                return Err(refusal("upload", e));
            }
        }
    }
    etags.sort_by_key(|(index, _)| *index);
    Ok(json!({
        "bytes": file_len,
        "sha256": sha256,
        "parts": etags.into_iter().map(|(index, etag)| json!({ "index": index, "etag": etag })).collect::<Vec<_>>(),
    }))
}

// ---- the recording control -------------------------------------------------------------

const CONTROL_W: f64 = 300.0;
const CONTROL_H: f64 = 56.0;

/// Show the floating recording control for `session_id`: always on top, on
/// every Space (full-screen apps included), and content-protected, so it never
/// appears in a recording (the sidecar also leaves the app's floating windows
/// out of a display take). [`studio_recorder_start`] already shows it for
/// every take; calling this again for the same take changes nothing.
#[tauri::command]
pub fn studio_recorder_show_control(app: AppHandle, session_id: String) -> Result<(), String> {
    show_control(&app, &session_id)
}

/// Show the control on the main thread from an async command, and wait for it.
async fn show_control_from_async(app: &AppHandle, session_id: &str) -> Result<(), String> {
    let (tx, rx) = oneshot::channel();
    let (handle, id) = (app.clone(), session_id.to_string());
    // The window is built on the main thread, as the sync show_control command is.
    app.run_on_main_thread(move || {
        let _ = tx.send(show_control(&handle, &id));
    })
    .map_err(|e| refusal("window", format!("the main thread is unavailable: {e}")))?;
    rx.await.unwrap_or_else(|_| Err(refusal("window", "the control was never shown")))
}

/// The control for `session_id`, made or reused. Call on the main thread.
fn show_control(app: &AppHandle, session_id: &str) -> Result<(), String> {
    if !valid_session_id(session_id) {
        return Err(refusal("bad-request", "not a session id"));
    }
    let origin = app
        .get_webview_window("main")
        .and_then(|w| w.url().ok())
        .map(|u| u.origin().ascii_serialization())
        .filter(|o| o.starts_with("http"))
        .unwrap_or_else(|| crate::tray::api_base_url().to_string());
    let url = format!("{origin}/hud/studio-recorder?session={session_id}");

    if let Some(window) = app.get_webview_window(CONTROL_LABEL) {
        // Same window, next take: point it at this one (already there: no reload).
        if let Ok(parsed) = url.parse::<tauri::Url>() {
            if window.url().ok().as_ref() != Some(&parsed) {
                let _ = window.navigate(parsed);
            }
        }
        show_without_focus(&window);
        return Ok(());
    }

    let (x, y) = control_position(app);
    let parsed = url.parse().map_err(|e| refusal("bad-request", format!("bad control URL: {e}")))?;
    let window = WebviewWindowBuilder::new(app, CONTROL_LABEL, WebviewUrl::External(parsed))
        .title("")
        .inner_size(CONTROL_W, CONTROL_H)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        // Stop works on the first click, even while another app is in front.
        .accept_first_mouse(true)
        .visible(false)
        .shadow(false)
        // Never in the recording, in screen sharing or in screenshots.
        .content_protected(true)
        .visible_on_all_workspaces(true)
        // The control's whole job is to stay live while the person works in
        // another app: never let macOS suspend its page.
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .build()
        .map_err(|e| refusal("window", e))?;
    #[cfg(target_os = "macos")]
    {
        if let Ok(ns) = window.ns_window() {
            crate::clear_window_background(ns);
        }
        let w = window.clone();
        let _ = window.run_on_main_thread(move || {
            if let Ok(ns) = w.ns_window() {
                if let Err(why) = crate::make_overlay_panel(ns) {
                    log_to_file(&format!("[studio-recorder] control stays a normal window: {why}"));
                }
            }
        });
        crate::native::webcontent_watchdog::install_default_recovery(&window);
    }
    // Shown once the page has had a moment to paint (the window is transparent).
    let app_clone = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(600));
        if let Some(window) = app_clone.get_webview_window(CONTROL_LABEL) {
            show_without_focus(&window);
        }
    });
    Ok(())
}

/// Close the recording control, unless a take is still recording: then the
/// control stays (it is the person's sign that one is), and this does nothing.
#[tauri::command]
pub fn studio_recorder_hide_control(app: AppHandle) {
    let recording = app.state::<StudioRecorder>().takes.lock().unwrap().values().any(|take| take.stopped.is_none());
    if recording {
        log_to_file("[studio-recorder] control kept: a take is still recording");
        return;
    }
    if let Some(window) = app.get_webview_window(CONTROL_LABEL) {
        let _ = window.close();
    }
}

fn show_without_focus(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let w = window.clone();
        let _ = window.run_on_main_thread(move || {
            if let Ok(ns) = w.ns_window() {
                crate::order_front_without_focus(ns);
                crate::clear_window_background(ns);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window.show();
}

/// Top center of the main window's display, below the menu bar.
fn control_position(app: &AppHandle) -> (f64, f64) {
    let monitor = app
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    match monitor {
        Some(m) => {
            let scale = m.scale_factor();
            let w = m.size().width as f64 / scale;
            let x = m.position().x as f64 / scale + (w - CONTROL_W) / 2.0;
            let y = m.position().y as f64 / scale + 44.0;
            (x, y)
        }
        None => (600.0, 44.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn part(index: u64, bytes: u64) -> UploadPart {
        UploadPart { index, bytes, url: "https://sb.nativeintelligence.dev/x".into(), headers: HashMap::new() }
    }

    #[test]
    fn parts_map_to_contiguous_ranges() {
        let parts = vec![part(0, 10), part(1, 10), part(2, 5)];
        assert_eq!(part_ranges(&parts, 25).unwrap(), vec![(0, 10), (10, 10), (20, 5)]);
    }

    #[test]
    fn a_part_past_the_end_or_bigger_than_the_first_is_refused() {
        assert!(part_ranges(&[part(0, 10), part(1, 10)], 15).is_err());
        assert!(part_ranges(&[part(0, 10), part(1, 11)], 100).is_err());
        assert!(part_ranges(&[], 10).is_err());
        assert!(part_ranges(&[part(0, 0)], 10).is_err());
    }

    #[test]
    fn uploads_go_only_to_the_apps_own_storage() {
        let signed = "/storage/v1/upload/resumable/sign/studio/take.mov?token=1";
        for debug in [false, true] {
            for host in UPLOAD_HOSTS {
                assert!(upload_url_allowed(&format!("https://{host}{signed}"), debug), "{host}");
                assert!(upload_url_allowed(&format!("https://{}{signed}", host.to_uppercase()), debug), "{host} in capitals");
                assert!(upload_url_allowed(&format!("https://{host}:443{signed}"), debug), "the default port, spelled out");
            }
            for refused in [
                // Any other host, however close.
                "https://store.example/bucket/key?sig=1",
                "https://nativeintelligence.dev/x",
                "https://sb.nativeintelligence.dev.evil.example/x",
                "https://evil.example/sb.nativeintelligence.dev/x",
                "https://xsb.nativeintelligence.dev/x",
                "https://a.sb.nativeintelligence.dev/x",
                "https://sb.nativeintelligence.dev./x",
                "https://sb.dial8.ai.evil.example/x",
                "https://evilsupabase.co/x",
                // Credentials before the host, or the allowed host as the credentials.
                "https://sb.nativeintelligence.dev@evil.example/x",
                "https://user:pass@sb.nativeintelligence.dev/x",
                "https://user@sb.dial8.ai/x",
                // Another port or scheme.
                "https://sb.nativeintelligence.dev:8443/x",
                "http://sb.nativeintelligence.dev/x",
                "http://sb.dial8.ai/x",
                "ftp://sb.nativeintelligence.dev/x",
                "file:///etc/passwd",
                "not a url",
                // Loopback addresses that are not loopback.
                "https://127.0.0.1.evil.example/x",
                "https://localhost.evil.example/x",
                "http://10.0.0.1/x",
            ] {
                assert!(!upload_url_allowed(refused, debug), "{refused} (debug: {debug})");
            }
        }

        // The development stack: a debug build only.
        for dev in [
            "https://abcdefghijklmnop.supabase.co/storage/v1/object/x",
            "https://ABCDEFGHIJKLMNOP.supabase.co/x",
            "http://localhost:54321/storage/v1/object/x",
            "http://127.0.0.1:54321/x",
            "http://[::1]:54321/x",
            "https://localhost/x",
        ] {
            assert!(upload_url_allowed(dev, true), "{dev} in a debug build");
            assert!(!upload_url_allowed(dev, false), "{dev} in a release build");
        }
        for refused in [
            "https://supabase.co/x",
            "https://.supabase.co/x",
            "https://x.supabase.co:8443/x",
            "http://x.supabase.co/x",
            "https://x.supabase.co.evil.example/x",
            "https://localhost@evil.example/x",
        ] {
            assert!(!upload_url_allowed(refused, true), "{refused}");
        }

        // The build's own rule is the release one in a release build.
        assert!(allowed_upload_url("https://sb.dial8.ai/x"));
        assert!(!allowed_upload_url("https://store.example/x"));
        assert_eq!(allowed_upload_url("http://localhost:3000/x"), cfg!(debug_assertions));
        assert_eq!(allowed_upload_url("https://abc.supabase.co/x"), cfg!(debug_assertions));
    }

    #[test]
    fn a_part_carries_only_the_storage_headers() {
        let headers: HashMap<String, String> = [
            ("Content-Type", "video/quicktime"),
            ("x-upsert", "true"),
            ("CACHE-CONTROL", "max-age=3600"),
            ("Authorization", "Bearer secret"),
            ("Cookie", "a=b"),
            ("Host", "evil.example"),
            ("x-amz-acl", "public-read"),
            ("content-type-x", "text/plain"),
        ]
        .into_iter()
        .map(|(n, v)| (n.to_string(), v.to_string()))
        .collect();
        assert_eq!(
            upload_headers(&headers),
            vec![("CACHE-CONTROL", "max-age=3600"), ("Content-Type", "video/quicktime"), ("x-upsert", "true")]
        );
        assert!(upload_headers(&HashMap::new()).is_empty());
    }

    #[test]
    fn start_options_never_carry_a_path() {
        let options: StudioRecorderStartOptions = serde_json::from_value(json!({
            "screen": { "kind": "window", "windowId": 42 },
            "microphone": {},
            "camera": { "deviceId": "cam" },
            "outputDir": "/etc",
            "excludeWindowIds": [1],
            "fps": 30
        }))
        .unwrap();
        let message = options.to_sidecar("0d7c7f8e-58b4-4a5b-9a43-3f8f5d0ec1a7", Path::new("/takes/x")).unwrap();
        assert_eq!(message["outputDir"], "/takes/x", "the folder is the app's, never the page's");
        assert!(message.get("excludeWindowIds").is_none());
        assert_eq!(message["screen"], json!({ "kind": "window", "windowId": 42 }));
        assert_eq!(message["microphone"], json!({ "deviceId": "default" }));
        assert_eq!(message["transcriptionPcm"], true);
        assert_eq!(message["fps"], 30);
    }

    #[test]
    fn bad_fps_is_refused() {
        let options: StudioRecorderStartOptions =
            serde_json::from_value(json!({ "screen": { "kind": "display" }, "fps": 24 })).unwrap();
        assert!(options.to_sidecar("x", Path::new("/t")).is_err());
    }

    #[test]
    fn words_move_onto_the_screen_clock() {
        let words = vec![
            stt::SttWord { word: "Hello,".into(), start: 0.5, end: 0.9, confidence: 0.9 },
            stt::SttWord { word: " ".into(), start: 1.0, end: 1.0, confidence: 0.0 },
        ];
        let t = transcript_json(&words, 120.0);
        assert_eq!(t["words"], json!([{ "text": "Hello,", "startMs": 620.0, "endMs": 1020.0, "confidence": 0.9 }]));
    }

    #[test]
    fn the_sweep_removes_only_old_take_folders() {
        let base = tempfile::tempdir().unwrap();
        let old = base.path().join(uuid::Uuid::new_v4().to_string());
        let other = base.path().join("not-a-take");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let later = SystemTime::now() + Duration::from_secs(4 * 24 * 60 * 60);
        assert_eq!(sweep(base.path(), KEEP_TAKES_FOR, later), 1);
        assert!(!old.exists());
        assert!(other.exists(), "only UUID-named take folders are ever removed");
        let fresh = base.path().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&fresh).unwrap();
        assert_eq!(sweep(base.path(), KEEP_TAKES_FOR, SystemTime::now()), 0);
        assert!(fresh.exists());
    }
}
