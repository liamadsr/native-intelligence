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
//!   `studio-recorder://upload` { sessionId, role, uploadedBytes, totalBytes, partsDone, partsTotal },
//!   `studio-recorder://segment` { sessionId, role, index, kind, offset, length, endSeconds, startPts }.
//!
//! Uploads while recording: the sidecar writes each file in segments and says
//! so (`segment`). The page, which holds the person's session, asks the Studio
//! for a link per piece (live-takes.ts); the bytes go from here, never through
//! the web view: the page first plans its pieces as byte ranges of the file
//! ([`studio_recorder_plan_pieces`], kept in the take's folder before any is
//! declared, so a take resumed after a crash cuts them the same), then has a
//! planned piece sent to its link ([`studio_recorder_put_piece`]). A piece is
//! only ever whole segments the index lists, and goes only to the app's own
//! storage. The take's id on the Studio is kept beside it (`live.json`), so a
//! take cut short by a quit or a crash is found again
//! ([`studio_recorder_unfinished_takes`]) and its missing pieces sent.
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

use serde::{Deserialize, Serialize};
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
pub const SEGMENT_EVENT: &str = "studio-recorder://segment";
pub const WORDS_EVENT: &str = "studio-recorder://words";
/// Written into a take folder the page let go of, before it is removed (the sweep finishes a removal cut short).
const RELEASED_FILE: &str = "released";
/// The stop payload (without the trace), kept beside the take: what files a take no page has again (after a restart).
const STOPPED_FILE: &str = "stopped.json";
/// The on-device words of a stopped take, beside its files.
const WORDS_FILE: &str = "words.json";
/// The editor's draft of a take opened before the Studio filed it, beside its files (record/provisional.ts).
const DRAFT_FILE: &str = "draft.json";
/// The most a draft may hold (an edit with its media records and words is far smaller).
const DRAFT_MAX_BYTES: usize = 8 * 1024 * 1024;
/// How long a page's hold on a take lasts without being renewed (the page renews it every few seconds).
const LEASE_FOR: Duration = Duration::from_secs(20);

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
    /// The account signed in when it started (the `sub` of the session the page handed the app): only that account
    /// may send it anywhere.
    owner: Option<String>,
    /// The take was recorded without the system cursor.
    hide_cursor: bool,
    /// The `stopped` payload once stopped (stop is idempotent).
    stopped: Option<Value>,
    stt: Option<SttTap>,
    /// The on-device words once heard (they arrive after Stop: `studio-recorder://words`), and whether still awaited.
    words: Option<Value>,
    words_pending: bool,
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
    /// Serializes writes to the take folders' piece plans.
    plans: StdMutex<()>,
    /// Which page holds which take ([`Leases`]): a take a live page holds is never listed to be sent on by another.
    leases: StdMutex<Leases>,
    /// This run's key to the take files' scheme (studio-take://): minted once, handed only to the app's own pages.
    take_token: std::sync::OnceLock<String>,
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
        Some("segment") => {
            let _ = app.emit(
                SEGMENT_EVENT,
                json!({
                    "sessionId": value.get("sessionId"),
                    "role": value.get("role"),
                    "index": value.get("index"),
                    "kind": value.get("kind"),
                    "offset": value.get("offset"),
                    "length": value.get("length"),
                    "endSeconds": value.get("endSeconds"),
                    "startPts": value.get("startPts"),
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

/// Finish removing take folders the page let go of ([`RELEASED_FILE`]: the Studio holds every byte of the take, or
/// the person discarded it) and remove folders older than [`KEEP_TAKES_FOR`] that hold no recording at all. A folder
/// with a recording in it is never removed by age: a take that is not settled (a draft, a lost track, a failed
/// filing, never sent) stays until the person files or discards it, and the Record dialog lists it (the page's
/// local takes, from [`studio_recorder_unfinished_takes`]). Only UUID-named folders directly under `base` are touched.
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
        let released = path.join(RELEASED_FILE).exists();
        let recorded = ["screen", "camera", "microphone", "system-audio"]
            .iter()
            .filter_map(|role| role_file(role))
            .any(|name| std::fs::metadata(path.join(name)).is_ok_and(|m| m.len() > 0));
        let written = meta.modified().unwrap_or(now);
        if (released || (!recorded && written < oldest)) && std::fs::remove_dir_all(&path).is_ok() {
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
    // Whose take it is, beside it: a take is only ever sent for the account that recorded it, in any later run too.
    let owner = signed_in_user(&app);
    if let Some(owner) = &owner {
        let _ = std::fs::write(dir.join(ACCOUNT_FILE), owner);
    }
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
    recorder.takes.lock().unwrap().insert(session_id.clone(), Take { dir, owner, hide_cursor: options.hide_cursor, stopped: None, stt, words: None, words_pending: false });
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

    // The on-device words: Stop waits for none of them. The tail reads the (now complete) file to its end behind the
    // editor; the words are kept beside the take (`words.json`, for a page that missed them, or a restart) and sent to
    // the page as `studio-recorder://words` { sessionId, transcript } (transcript null when none came).
    let offset_ms = stopped.pointer("/transcriptionPcm/offsetMs").and_then(Value::as_f64);
    let words_pending = match (stt, offset_ms) {
        (Some(tap), Some(offset)) => {
            tap.done.store(true, Ordering::SeqCst);
            let (app, session_id) = (app.clone(), session_id.clone());
            tauri::async_runtime::spawn(async move {
                let transcript = match tokio::time::timeout(TRANSCRIPT_TIMEOUT + Duration::from_secs(30), tap.task).await {
                    Ok(Ok(Some(words))) => transcript_json(&words, offset),
                    _ => Value::Null,
                };
                let dir = {
                    let recorder = app.state::<StudioRecorder>();
                    let mut takes = recorder.takes.lock().unwrap();
                    takes.get_mut(&session_id).map(|take| {
                        take.words = Some(transcript.clone());
                        take.words_pending = false;
                        take.dir.clone()
                    })
                };
                if let Some(dir) = dir {
                    let _ = write_atomic(&dir.join(WORDS_FILE), transcript.to_string().as_bytes());
                }
                let _ = app.emit(WORDS_EVENT, json!({ "sessionId": session_id, "transcript": transcript }));
            });
            true
        }
        (Some(tap), None) => {
            tap.done.store(true, Ordering::SeqCst);
            tap.task.abort();
            false
        }
        _ => false,
    };
    stopped["transcript"] = Value::Null;
    stopped["wordsPending"] = json!(words_pending);
    stopped["sourceCursorHidden"] = json!(hide_cursor);
    stopped["sessionId"] = json!(session_id);
    if let Some(map) = stopped.as_object_mut() {
        map.remove("transcriptionPcm");
    }

    if let Some(take) = recorder.takes.lock().unwrap().get_mut(&session_id) {
        take.stopped = Some(stopped.clone());
        take.words_pending = words_pending;
        let mut kept = stopped.clone();
        if let Some(map) = kept.as_object_mut() {
            map.remove("trace");
        }
        let _ = write_atomic(&take.dir.join(STOPPED_FILE), kept.to_string().as_bytes());
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
        // Marked first: a removal cut short (a file held open, a quit) is finished by the next sweep, never kept.
        let _ = std::fs::write(dir.join(RELEASED_FILE), b"");
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
    let (take_dir, in_run) = sendable_take(&app, &session_id, Need::Any)?;
    let mut fix_place: Option<(PathBuf, LiveLink, String)> = None;
    let path = if in_run {
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
    } else {
        // A take of an earlier run (a track the Studio refused, or a take that never reached it while it recorded,
        // sent whole after a restart): the signed-in account's, its file whole on disk, and only into the place its
        // files already went to (an offline take: the place its first whole file goes, then every other).
        let link = read_link(&take_dir).unwrap_or_default();
        let mut place = None;
        for part in &parts {
            let Some(at) = upload_place(&link, &part.url) else {
                return Err(refusal("forbidden", format!("part {} goes somewhere else than the take's workspace", part.index)));
            };
            if place.as_ref().is_some_and(|p| *p != at) {
                return Err(refusal("forbidden", "the parts go to two places"));
            }
            place = Some(at);
        }
        if let (None, Some(at)) = (link.place(), place) {
            fix_place = Some((take_dir.clone(), link, at));
        }
        let name = role_file(&role).ok_or_else(|| refusal("bad-request", format!("no such role {role}")))?;
        take_dir.join(name)
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

    let client = upload_client()?;
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
    // An offline take's first whole file fixes where every later one goes.
    if let Some((dir, link, at)) = fix_place {
        write_link(&dir, &LiveLink { workspace: Some(at), ..link })?;
    }
    Ok(json!({
        "bytes": file_len,
        "sha256": sha256,
        "parts": etags.into_iter().map(|(index, etag)| json!({ "index": index, "etag": etag })).collect::<Vec<_>>(),
    }))
}

// ---- uploads while recording ------------------------------------------------------------

/// The longest piece the Studio takes (web/src/lib/studio/server/live-takes.ts `PIECE_MAX_BYTES`).
const PIECE_MAX_BYTES: u64 = 16 * 1024 * 1024;
/// The least a piece but a track's last holds (live-takes.ts `PIECE_MIN_BYTES`).
const PIECE_MIN_BYTES: u64 = 1024;
/// The most pieces one track may have (live-takes.ts `TRACK_MAX_PIECES`).
const TRACK_MAX_PIECES: usize = 10_000;
/// The take's id on the Studio and where its pieces go, beside its files ([`LiveLink`]).
const LIVE_FILE: &str = "live.json";
/// The account that recorded the take (its user id), beside its files.
const ACCOUNT_FILE: &str = "account";

/// The account this app is signed into now: the `sub` of the session the page handed over. Read, not verified: it
/// is only ever compared with the one a take was recorded under.
fn signed_in_user(app: &AppHandle) -> Option<String> {
    let token = app.state::<crate::state::AppState>().auth_token.lock().unwrap().clone()?;
    crate::browser_exit::session_user(&token)
}

/// What the page is told when a take belongs to another account (shown as it is).
pub const OTHER_ACCOUNT: &str = "This recording was made while another account was signed in to Native Intelligence, so it can't be sent or opened from this one.";

/// A take recorded under `owner` while `signed_in` is signed in: refused only when both are known and differ; when
/// only the person signed in now is known, the take becomes theirs (`Some(bind)`: a take started before the app had a
/// session, or while a window had just signed out). Pure.
pub fn account_check(owner: Option<&str>, signed_in: Option<&str>) -> Result<Option<String>, String> {
    match (owner.filter(|o| !o.is_empty()), signed_in.filter(|s| !s.is_empty())) {
        (Some(a), Some(b)) if a != b => Err(refusal("forbidden", OTHER_ACCOUNT)),
        (None, Some(b)) => Ok(Some(b.to_string())),
        _ => Ok(None),
    }
}

/// What `live.json` holds: the take's id on the Studio, and (from its first piece stored) the exact place its pieces
/// go, `<bucket>/<workspace>/live/<take>`: every later piece, in this run or any other, goes there or nowhere. A take
/// that never reached the Studio while it recorded (offline) has no id; its first whole file fixes `workspace`
/// (`<bucket>/<workspace>`), and every later one goes there.
#[derive(Debug, Clone, PartialEq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveLink {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub take_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
}

impl LiveLink {
    /// `<bucket>/<workspace>` its files go to, once known.
    fn place(&self) -> Option<String> {
        self.workspace.clone().or_else(|| self.prefix.as_ref().map(|p| p.splitn(3, '/').take(2).collect::<Vec<_>>().join("/")))
    }
}

fn read_link(dir: &Path) -> Option<LiveLink> {
    serde_json::from_str::<LiveLink>(&std::fs::read_to_string(dir.join(LIVE_FILE)).ok()?).ok()
}
fn write_link(dir: &Path, link: &LiveLink) -> Result<(), String> {
    write_atomic(&dir.join(LIVE_FILE), serde_json::to_string(link).unwrap_or_default().as_bytes())
}
/// Replace a file with `bytes`, on disk before it is renamed into place (a reader never sees half; a crash leaves the old).
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    // A temporary name of its own for each write: two writers never share one (each rename is whole).
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut file = std::fs::File::create(&tmp).map_err(|e| refusal("io", e))?;
    file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|e| refusal("io", e))?;
    std::fs::rename(&tmp, path).map_err(|e| refusal("io", e))
}
fn read_owner(dir: &Path) -> Option<String> {
    std::fs::read_to_string(dir.join(ACCOUNT_FILE)).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// The Studio's name for a role (live-takes.ts LIVE_ROLES).
fn studio_role(role: &str) -> &str {
    if role == "system-audio" { "systemAudio" } else { role }
}

/// Where a signed upload link writes in the app's storage: `<bucket>`, `<workspace>` and the rest of the object's
/// path (`/storage/v1/object/upload/sign/<bucket>/<workspace>/...`). None for any other link. Pure.
pub fn upload_destination(url: &str) -> Option<Vec<String>> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let segments: Vec<String> = parsed.path_segments()?.map(str::to_string).collect();
    let at = segments.windows(3).position(|w| w[0] == "object" && w[1] == "upload" && w[2] == "sign")?;
    let rest = segments[at + 3..].to_vec();
    if rest.len() < 3 || rest.iter().any(|s| s.is_empty() || s == "." || s == ".." || s.contains('%')) {
        return None;
    }
    Some(rest)
}

/// Where piece `index` of `role` may go for a take linked as `link`: exactly
/// `<bucket>/<workspace>/live/<take>/<role>/<index>`, the take its own, and (once its first piece was stored) the
/// bucket and workspace its pieces went to. Answers the place to remember. Pure.
pub fn piece_destination(link: &LiveLink, url: &str, role: &str, index: u64) -> Result<String, String> {
    let refuse = || Err(refusal("forbidden", "a link to somewhere else than this take's place on the Studio"));
    let Some(rest) = upload_destination(url) else { return refuse() };
    let [bucket, workspace, live, take, piece_role, n] = rest.as_slice() else { return refuse() };
    if live != "live" || Some(take) != link.take_id.as_ref() || piece_role != studio_role(role) || *n != index.to_string() {
        return refuse();
    }
    let prefix = format!("{bucket}/{workspace}/live/{take}");
    if link.prefix.as_ref().is_some_and(|p| *p != prefix) {
        return refuse();
    }
    Ok(prefix)
}

/// Where a whole-file upload link for a take as `link` writes, `<bucket>/<workspace>`, when it may: an upload's part
/// (`<bucket>/<workspace>/uploads/<id>/<part>`) in the place the take's files already went to; or, for a take whose
/// files never went anywhere (offline while it recorded), any upload of the person's, its place then fixed. Pure.
pub fn upload_place(link: &LiveLink, url: &str) -> Option<String> {
    let rest = upload_destination(url)?;
    let [bucket, workspace, uploads, _, _] = rest.as_slice() else { return None };
    if uploads != "uploads" {
        return None;
    }
    let place = format!("{bucket}/{workspace}");
    match link.place() {
        Some(known) if known != place => None,
        Some(_) => Some(place),
        // Linked to a take but never placed: its first piece fixes the place, never a whole file.
        None if link.take_id.is_some() => None,
        None => Some(place),
    }
}

/// What a command needs of an earlier run's take besides its account: nothing more (`Any`: its draft, its words, its
/// whole files), linked to its take on the Studio (`Linked`), or linked with its pieces' place known (`Placed`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Need {
    Any,
    Linked,
    Placed,
}

/// Whether a take may be acted on, and the account it becomes when its own is not known yet: this run's take
/// (`in_run`: its owner as it started) or an earlier run's (its `account` file, and `need` of its `live.json`). Pure but
/// for reading the take's folder.
pub fn take_access(dir: &Path, in_run: Option<Option<&str>>, signed_in: Option<&str>, need: Need) -> Result<Option<String>, String> {
    let owner = match in_run {
        Some(owner) => owner.map(str::to_string).or_else(|| read_owner(dir)),
        None => read_owner(dir),
    };
    let bind = account_check(owner.as_deref(), signed_in)?;
    if in_run.is_none() {
        let link = read_link(dir);
        let linked = link.as_ref().is_some_and(|l| l.take_id.is_some());
        if need == Need::Linked && !linked {
            return Err(refusal("forbidden", "the take is not linked to a recording"));
        }
        if need == Need::Placed && !(linked && link.as_ref().is_some_and(|l| l.prefix.is_some())) {
            return Err(refusal("forbidden", "the take never reached the Studio in the run that recorded it"));
        }
    }
    Ok(bind)
}

/// A take the page may act on (`need`), and whether it is this run's; an unknown owner becomes the account signed in
/// now (written beside the take). Refused: another account's take, a folder this module did not make, an earlier
/// run's take without what `need` asks.
fn sendable_take(app: &AppHandle, session_id: &str, need: Need) -> Result<(PathBuf, bool), String> {
    if !valid_session_id(session_id) {
        return Err(refusal("not-found", "no such take"));
    }
    let me = signed_in_user(app);
    let in_run = app.state::<StudioRecorder>().takes.lock().unwrap().get(session_id).map(|t| (t.dir.clone(), t.owner.clone()));
    let (dir, this_run) = match &in_run {
        Some((dir, _)) => (dir.clone(), true),
        None => (take_folder(app, session_id)?, false),
    };
    let run_owner = in_run.as_ref().map(|(_, owner)| owner.as_deref());
    if let Some(bind) = take_access(&dir, run_owner, me.as_deref(), need)? {
        let _ = std::fs::write(dir.join(ACCOUNT_FILE), &bind);
        if let Some(take) = app.state::<StudioRecorder>().takes.lock().unwrap().get_mut(session_id) {
            take.owner = Some(bind);
        }
    }
    Ok((dir, this_run))
}

/// Which page holds which take: a page holds the take it records, sends or plays (renewing its hold every few
/// seconds), and lets go when it unloads; a page that stops renewing (a reloaded or crashed web view, a closed window)
/// loses it after [`LEASE_FOR`]. A take a live page holds is that page's alone: never listed for another to send on,
/// never opened as a draft by another window.
#[derive(Debug, Default)]
pub struct Leases {
    held: HashMap<String, (String, std::time::Instant)>,
}

impl Leases {
    /// Hold (or renew) `session` for `holder` at `now`: false when another live page holds it.
    pub fn hold(&mut self, session: &str, holder: &str, now: std::time::Instant) -> bool {
        if let Some((by, until)) = self.held.get(session) {
            if by != holder && *until > now {
                return false;
            }
        }
        self.held.insert(session.to_string(), (holder.to_string(), now + LEASE_FOR));
        true
    }
    /// Let go of `session`, when `holder` holds it.
    pub fn release(&mut self, session: &str, holder: &str) {
        if self.held.get(session).is_some_and(|(by, _)| by == holder) {
            self.held.remove(session);
        }
    }
    /// The takes a live page holds at `now`.
    pub fn active(&self, now: std::time::Instant) -> std::collections::HashSet<String> {
        self.active_for_others(now, None)
    }
    /// The takes a live page other than `holder` holds at `now` (a page sends on its own takes itself).
    pub fn active_for_others(&self, now: std::time::Instant, holder: Option<&str>) -> std::collections::HashSet<String> {
        self.held.iter().filter(|(_, (by, until))| *until > now && Some(by.as_str()) != holder).map(|(session, _)| session.clone()).collect()
    }
}

/// A take's file for a role: the sidecar's own names (Recorder.swift); none for any other role.
fn role_file(role: &str) -> Option<&'static str> {
    match role {
        "screen" => Some("screen.mp4"),
        "camera" => Some("camera.mp4"),
        "microphone" => Some("microphone.m4a"),
        "system-audio" => Some("system-audio.m4a"),
        _ => None,
    }
}

/// One whole segment of a take's file, as its index (`<file>.segments`) lists it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub index: usize,
    pub kind: String,
    pub offset: u64,
    pub length: u64,
    pub end_seconds: Option<f64>,
}

/// The segments an index lists, in order: whole lines only, the init segment
/// first, each starting where the one before ended, none past `file_len`. A
/// torn last line, or bytes the index does not count yet (a crash between the
/// sidecar's two writes), are left out. Pure.
pub fn parse_segments(text: &str, file_len: u64) -> Vec<Segment> {
    let whole = text.rfind('\n').map_or("", |i| &text[..=i]);
    let mut out: Vec<Segment> = Vec::new();
    let mut end = 0u64;
    for line in whole.lines() {
        let fields: Vec<&str> = line.split(' ').collect();
        if fields.len() < 3 || (fields[0] == "init") != out.is_empty() || !matches!(fields[0], "init" | "media") {
            break;
        }
        let (Ok(offset), Ok(length)) = (fields[1].parse::<u64>(), fields[2].parse::<u64>()) else { break };
        if offset != end || length == 0 || offset.checked_add(length).map_or(true, |e| e > file_len) {
            break;
        }
        let end_seconds = fields.get(3).and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite());
        out.push(Segment { index: out.len(), kind: fields[0].to_string(), offset, length, end_seconds });
        end = offset + length;
    }
    out
}

/// A piece of a track as the page planned it: bytes `[offset, offset + length)`
/// of the file, `seconds` recorded at its end, the track's offset on the screen's clock.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedPiece {
    pub index: u64,
    pub offset: u64,
    pub length: u64,
    #[serde(default)]
    pub seconds: f64,
    #[serde(default)]
    pub offset_seconds: Option<f64>,
}

/// A plan file's pieces: whole lines, numbered from 0, end to end from byte 0. Pure.
pub fn parse_plan(text: &str) -> Vec<PlannedPiece> {
    plan_and_length(text).0
}

/// A plan file's pieces and how many bytes of the file hold them: anything after (a line torn by a crash, a line
/// that breaks the run) is not part of the plan, and is cut away before the plan grows. Pure.
pub fn plan_and_length(text: &str) -> (Vec<PlannedPiece>, usize) {
    let mut out: Vec<PlannedPiece> = Vec::new();
    let mut end = 0u64;
    let mut length = 0usize;
    for line in text.split_inclusive('\n') {
        if !line.ends_with('\n') {
            break;
        }
        let Ok(piece) = serde_json::from_str::<PlannedPiece>(line.trim_end()) else { break };
        if piece.index != out.len() as u64 || piece.offset != end {
            break;
        }
        end = piece.offset + piece.length;
        length += line.len();
        out.push(piece);
    }
    (out, length)
}

/// The pieces of `new` that extend `plan` (one already planned must be planned
/// the same), as the page cuts them (record/live.ts piecesOf): one run of
/// whole segments, from where the plan ends to the end of a segment the index
/// lists, as one piece, or in equal parts when it is longer than
/// [`PIECE_MAX_BYTES`]. Each is the next one and starts where the one before
/// ended; a piece under [`PIECE_MIN_BYTES`] is only ever a track's last (no
/// piece follows it); a track has at most [`TRACK_MAX_PIECES`]. Pure.
pub fn extend_plan(plan: &[PlannedPiece], new: &[PlannedPiece], segments: &[Segment]) -> Result<Vec<PlannedPiece>, String> {
    let indexed = indexed_end(segments);
    let mut next = plan.len() as u64;
    let mut end = plan.last().map_or(0, |p| p.offset + p.length);
    let mut added: Vec<PlannedPiece> = Vec::new();
    for piece in new {
        if piece.index < plan.len() as u64 {
            if plan[piece.index as usize] != *piece {
                return Err(refusal("conflict", format!("piece {} was planned otherwise", piece.index)));
            }
            continue;
        }
        if piece.index != next || piece.offset != end {
            return Err(refusal("conflict", format!("piece {} does not follow the plan", piece.index)));
        }
        if piece.length == 0 || piece.length > PIECE_MAX_BYTES {
            return Err(refusal("bad-request", format!("piece {} must hold 1 byte to 16 MB", piece.index)));
        }
        if piece.offset + piece.length > indexed {
            return Err(refusal("bad-request", format!("piece {} reaches past what the recorder has written", piece.index)));
        }
        if !piece.seconds.is_finite() || piece.seconds < 0.0 || piece.offset_seconds.is_some_and(|o| !o.is_finite() || o.abs() > 3600.0) {
            return Err(refusal("bad-request", format!("piece {} has a bad time", piece.index)));
        }
        end = piece.offset + piece.length;
        next += 1;
        added.push(piece.clone());
    }
    let (Some(first), Some(last)) = (added.first(), added.last()) else { return Ok(added) };
    if plan.len() + added.len() > TRACK_MAX_PIECES {
        return Err(refusal("bad-request", format!("a track holds at most {TRACK_MAX_PIECES} pieces")));
    }
    if plan.last().is_some_and(|p| p.length < PIECE_MIN_BYTES) {
        return Err(refusal("bad-request", "only a track's last piece holds fewer than 1024 bytes"));
    }
    let (start, stop) = (first.offset, last.offset + last.length);
    if !segments.iter().any(|s| s.offset + s.length == stop) {
        return Err(refusal("bad-request", "a piece ends where a segment ends"));
    }
    let total = stop - start;
    let count = total.div_ceil(PIECE_MAX_BYTES).max(1);
    let size = total.div_ceil(count);
    let equal = added.len() as u64 == count
        && added.iter().enumerate().all(|(i, p)| p.length == if i + 1 == added.len() { total - size * (count - 1) } else { size });
    if !equal {
        return Err(refusal("bad-request", "pieces are whole segments, or equal parts of a run longer than 16 MB"));
    }
    Ok(added)
}

/// A take's folder by its session id: this run's, or one left by an earlier run
/// (only a UUID-named folder directly under the takes dir).
fn take_folder(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    if !valid_session_id(session_id) {
        return Err(refusal("not-found", "no such take"));
    }
    if let Some(take) = app.state::<StudioRecorder>().takes.lock().unwrap().get(session_id) {
        return Ok(take.dir.clone());
    }
    let dir = takes_dir(app)?.join(session_id);
    if dir.is_dir() {
        Ok(dir)
    } else {
        Err(refusal("not-found", "no such take"))
    }
}

/// A role's file in a take folder and its whole segments.
fn segments_of(dir: &Path, role: &str) -> Result<(PathBuf, Vec<Segment>), String> {
    let name = role_file(role).ok_or_else(|| refusal("bad-request", format!("no such role {role}")))?;
    let file = dir.join(name);
    let len = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
    let index = std::fs::read_to_string(dir.join(format!("{name}.segments"))).unwrap_or_default();
    Ok((file, parse_segments(&index, len)))
}

fn indexed_end(segments: &[Segment]) -> u64 {
    segments.last().map_or(0, |s| s.offset + s.length)
}

fn plan_of(dir: &Path, role: &str) -> Vec<PlannedPiece> {
    parse_plan(&std::fs::read_to_string(dir.join(format!("pieces-{role}.jsonl"))).unwrap_or_default())
}

/// Where a role's file's time 0 sits on the take's clock (host seconds), as the recorder kept it (`<file>.start`).
fn start_of(dir: &Path, role: &str) -> Option<f64> {
    let name = role_file(role)?;
    std::fs::read_to_string(dir.join(format!("{name}.start"))).ok()?.trim().parse::<f64>().ok().filter(|v| v.is_finite())
}

/// The whole segments of a take's file so far: `{segments, bytes, startPts}` (bytes: where the last one ends;
/// startPts: the file's time 0 on the take's clock, once the recorder has said).
#[tauri::command]
pub async fn studio_recorder_segments(app: AppHandle, session_id: String, role: String) -> Result<Value, String> {
    let dir = take_folder(&app, &session_id)?;
    let (_, segments) = segments_of(&dir, &role)?;
    Ok(json!({ "bytes": indexed_end(&segments), "segments": segments, "startPts": start_of(&dir, &role) }))
}

/// Remember the take's id on the Studio beside its files: only for a take of this run, recorded under the account
/// signed in now, and once (another id is refused).
#[tauri::command]
pub async fn studio_recorder_link_live(app: AppHandle, session_id: String, take_id: String) -> Result<(), String> {
    let (dir, this_run) = sendable_take(&app, &session_id, Need::Any)?;
    if !this_run {
        return Err(refusal("forbidden", "only a take of this run is linked"));
    }
    if uuid::Uuid::parse_str(&take_id).is_err() {
        return Err(refusal("bad-request", "not a take id"));
    }
    if let Some(known) = read_link(&dir).filter(|l| l.take_id.is_some()) {
        return if known.take_id.as_deref() == Some(take_id.as_str()) { Ok(()) } else { Err(refusal("conflict", "the take is linked to another recording")) };
    }
    write_link(&dir, &LiveLink { take_id: Some(take_id), ..LiveLink::default() })
}

/// Plan pieces of a track before the page declares them to the Studio: kept
/// in the take's folder (`pieces-<role>.jsonl`), so pieces sent after a crash
/// are the very ones declared before it. Answers how many are planned.
#[tauri::command]
pub async fn studio_recorder_plan_pieces(app: AppHandle, session_id: String, role: String, pieces: Vec<PlannedPiece>) -> Result<Value, String> {
    let (dir, _) = sendable_take(&app, &session_id, Need::Linked)?;
    let (_, segments) = segments_of(&dir, &role)?;
    let recorder = app.state::<StudioRecorder>();
    let _plans = recorder.plans.lock().unwrap();
    let path = dir.join(format!("pieces-{role}.jsonl"));
    let (plan, whole) = plan_and_length(&std::fs::read_to_string(&path).unwrap_or_default());
    let added = extend_plan(&plan, &pieces, &segments)?;
    if !added.is_empty() {
        use std::io::Write;
        let lines: String = added.iter().map(|p| format!("{}\n", serde_json::to_string(p).unwrap_or_default())).collect();
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| refusal("io", e))?;
        // A line torn by a crash (or anything past the plan) is cut away first, so the new lines follow the plan.
        file.set_len(whole as u64).map_err(|e| refusal("io", e))?;
        file.write_all(lines.as_bytes()).and_then(|_| file.sync_data()).map_err(|e| refusal("io", e))?;
    }
    Ok(json!({ "planned": plan.len() + added.len() }))
}

/// Send planned piece `index` of a track to its signed link (the app's own
/// storage only, no redirect, the storage headers only). `{bytes}`.
#[tauri::command]
pub async fn studio_recorder_put_piece(
    app: AppHandle,
    session_id: String,
    role: String,
    index: u64,
    url: String,
    headers: HashMap<String, String>,
) -> Result<Value, String> {
    let (dir, this_run) = sendable_take(&app, &session_id, Need::Linked)?;
    let mut link = read_link(&dir).filter(|l| l.take_id.is_some()).ok_or_else(|| refusal("forbidden", "the take is not linked to a recording"))?;
    if !this_run && link.prefix.is_none() {
        return Err(refusal("forbidden", "the take never reached the Studio in the run that recorded it"));
    }
    let place = piece_destination(&link, &url, &role, index)?;
    let (file, segments) = segments_of(&dir, &role)?;
    let piece = plan_of(&dir, &role)
        .into_iter()
        .nth(index as usize)
        .ok_or_else(|| refusal("not-found", format!("piece {index} was not planned")))?;
    if piece.offset + piece.length > indexed_end(&segments) {
        return Err(refusal("bad-request", format!("piece {index} reaches past what the recorder has written")));
    }
    if !allowed_upload_url(&url) {
        return Err(refusal("bad-request", "a URL the app won't upload to"));
    }
    let body = read_range(&file, piece.offset, piece.length).await.map_err(|e| refusal("io", e))?;
    let client = upload_client()?;
    let part = UploadPart { index, bytes: piece.length, url, headers };
    put_part(&client, &part, body).await?;
    // The first piece stored fixes where every later one goes.
    if link.prefix.is_none() {
        link.prefix = Some(place);
        write_link(&dir, &link)?;
    }
    Ok(json!({ "bytes": piece.length }))
}

/// Takes on this computer that are not being recorded or sent by a live page: what a quit, a crash or a reload left to
/// send. Only the signed-in account's (a take whose account is not known yet is listed too: sending it makes it
/// theirs); another account's stays on disk, untouched, until its own sweep. A take that never reached the Studio
/// while it recorded (offline: no take id) is listed too, to be filed whole.
/// `{takes: [{sessionId, takeId, state, tracks: [{role, bytes, seconds, startPts, plan}]}]}`.
#[tauri::command]
pub async fn studio_recorder_unfinished_takes(app: AppHandle, holder: Option<String>) -> Result<Value, String> {
    let base = takes_dir(&app)?;
    // The takes the asking page holds are its own to send on: listed for it, never for another page.
    let mut busy = app.state::<StudioRecorder>().leases.lock().unwrap().active_for_others(std::time::Instant::now(), holder.as_deref());
    // A take still recording is its page's whatever its lease says.
    busy.extend(app.state::<StudioRecorder>().takes.lock().unwrap().iter().filter(|(_, t)| t.stopped.is_none()).map(|(id, _)| id.clone()));
    Ok(json!({ "takes": unfinished_in(&base, &busy, signed_in_user(&app).as_deref()) }))
}

/// [`studio_recorder_unfinished_takes`] over a takes folder: every UUID-named take folder with a file, not in `busy`,
/// whose account is the one signed in (or not known yet). Pure but for reading the folder.
pub fn unfinished_in(base: &Path, busy: &std::collections::HashSet<String>, signed_in: Option<&str>) -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(base) else { return out };
    for entry in entries.flatten() {
        let dir = entry.path();
        let Some(session_id) = dir.file_name().and_then(|n| n.to_str()).filter(|n| valid_session_id(n)).map(str::to_string) else { continue };
        if busy.contains(&session_id) || !entry.file_type().is_ok_and(|t| t.is_dir()) || account_check(read_owner(&dir).as_deref(), signed_in).is_err() || signed_in.is_none() {
            continue;
        }
        let link = read_link(&dir).unwrap_or_default();
        let take = std::fs::read_to_string(dir.join("take.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
        let state = take.as_ref().and_then(|v| v.get("state").and_then(Value::as_str)).unwrap_or("recording").to_string();
        let mut tracks = Vec::new();
        for role in ["screen", "camera", "microphone", "system-audio"] {
            let Ok((file, segments)) = segments_of(&dir, role) else { continue };
            if !file.exists() || segments.is_empty() {
                continue;
            }
            tracks.push(json!({ "role": role, "bytes": indexed_end(&segments), "seconds": segments.last().and_then(|s| s.end_seconds),
                                "startPts": start_of(&dir, role), "plan": plan_of(&dir, role) }));
        }
        if !tracks.iter().any(|t| t["role"] == "screen") {
            continue;
        }
        // A draft is the page's only when it reads as one: a torn or unreadable draft never hides the take.
        let draft = std::fs::read_to_string(dir.join(DRAFT_FILE)).ok();
        let draft_ok = draft.as_deref().and_then(|t| serde_json::from_str::<Value>(t).ok()).is_some_and(|v| v.is_object());
        let stop = std::fs::read_to_string(dir.join(STOPPED_FILE)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(Value::Null);
        let modified = std::fs::metadata(&dir).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64);
        out.push(json!({ "sessionId": session_id, "takeId": link.take_id, "state": state, "tracks": tracks,
                         "hasDraft": draft_ok, "draftUnreadable": draft.is_some() && !draft_ok, "stop": stop, "modifiedMs": modified }));
    }
    out
}

/// Hold a take for this page (renewed every few seconds while it records, sends or plays it), or let go of it
/// (`release`): `{held}`, false when another live page holds it (another window has the take open).
#[tauri::command]
pub async fn studio_recorder_hold(app: AppHandle, session_id: String, holder: String, release: bool) -> Result<Value, String> {
    if holder.is_empty() || holder.len() > 64 || !holder.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err(refusal("bad-request", "not a holder"));
    }
    sendable_take(&app, &session_id, Need::Any)?;
    let recorder = app.state::<StudioRecorder>();
    let mut leases = recorder.leases.lock().unwrap();
    if release {
        leases.release(&session_id, &holder);
        return Ok(json!({ "held": false }));
    }
    Ok(json!({ "held": leases.hold(&session_id, &holder, std::time::Instant::now()) }))
}

/// The editor's draft of a take opened before the Studio filed it (record/provisional.ts), kept beside the take: one
/// copy for every window, as long as the take. `{draft}` (null when there is none).
#[tauri::command]
pub async fn studio_recorder_draft_get(app: AppHandle, session_id: String) -> Result<Value, String> {
    let (dir, _) = sendable_take(&app, &session_id, Need::Any)?;
    Ok(json!({ "draft": std::fs::read_to_string(dir.join(DRAFT_FILE)).ok() }))
}

/// Keep the editor's draft of a take beside it (replacing the one before; at most [`DRAFT_MAX_BYTES`]), on disk before
/// it answers: a failure is an error the page shows ("Not saved").
#[tauri::command]
pub async fn studio_recorder_draft_put(app: AppHandle, session_id: String, draft: String) -> Result<(), String> {
    if draft.len() > DRAFT_MAX_BYTES {
        return Err(refusal("too-large", "the edit is too large to keep on this computer"));
    }
    if serde_json::from_str::<Value>(&draft).map(|v| !v.is_object()).unwrap_or(true) {
        return Err(refusal("bad-request", "not an edit"));
    }
    let (dir, _) = sendable_take(&app, &session_id, Need::Any)?;
    write_atomic(&dir.join(DRAFT_FILE), draft.as_bytes())
}

/// The drafts on this computer of the signed-in account's takes: `{drafts: [{sessionId, draft}]}`.
#[tauri::command]
pub async fn studio_recorder_drafts(app: AppHandle) -> Result<Value, String> {
    let base = takes_dir(&app)?;
    let me = signed_in_user(&app);
    let mut out = Vec::new();
    if let (Ok(entries), Some(me)) = (std::fs::read_dir(&base), me) {
        for entry in entries.flatten() {
            let dir = entry.path();
            let Some(session_id) = dir.file_name().and_then(|n| n.to_str()).filter(|n| valid_session_id(n)).map(str::to_string) else { continue };
            if account_check(read_owner(&dir).as_deref(), Some(&me)).is_err() {
                continue;
            }
            if let Ok(draft) = std::fs::read_to_string(dir.join(DRAFT_FILE)) {
                out.push(json!({ "sessionId": session_id, "draft": draft }));
            }
        }
    }
    Ok(json!({ "drafts": out }))
}

/// A stopped take's on-device words: `{transcript, pending}` (the words the event carried, kept beside the take;
/// `pending` while the model is still reading).
#[tauri::command]
pub async fn studio_recorder_words(app: AppHandle, session_id: String) -> Result<Value, String> {
    let (dir, _) = sendable_take(&app, &session_id, Need::Any)?;
    let in_run = app.state::<StudioRecorder>().takes.lock().unwrap().get(&session_id).map(|t| (t.words.clone(), t.words_pending));
    if let Some((words, pending)) = in_run {
        if pending || words.is_some() {
            return Ok(json!({ "transcript": words.unwrap_or(Value::Null), "pending": pending }));
        }
    }
    let kept = std::fs::read_to_string(dir.join(WORDS_FILE)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
    Ok(json!({ "transcript": kept.unwrap_or(Value::Null), "pending": false }))
}

/// This run's key to the take files' scheme: every URL of it names the key ([`take_file_response`]).
#[tauri::command]
pub async fn studio_recorder_take_token(app: AppHandle) -> Result<String, String> {
    Ok(app.state::<StudioRecorder>().token().to_string())
}

impl StudioRecorder {
    /// This run's key to the take files' scheme, minted on first use.
    pub fn token(&self) -> &str {
        self.take_token.get_or_init(|| format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()))
    }
}

// ---- the take on this computer, for the editor (studio-take://) -------------------------------------------------

/// The URI scheme the Studio's page plays a take's files from at Stop, while the Studio files them:
/// `studio-take://localhost/<key>/<session>/<role>` (the recorder is macOS only). The builder registers it on every
/// web view the app makes, so it answers only with this run's key in the URL (minted in Rust, handed out only by a
/// command the capability files grant to the app's own pages), never on what a request's headers say. Read-only, the
/// four role files of the signed-in account's takes, byte ranges: [`take_file_response`].
pub const TAKE_SCHEME: &str = "studio-take";
/// The most one answer carries: a player asks again for the next stretch (it reads with ranges).
const TAKE_RANGE_MAX: u64 = 8 * 1024 * 1024;

/// The origins whose pages may read a take's files: the app's own domains over https, and (a debug build) the dev
/// servers on this machine, ports 3000 and 3001. `null` is none of them.
pub fn take_origin_allowed(origin: &str, debug: bool) -> bool {
    let Ok(url) = reqwest::Url::parse(origin) else { return false };
    let Some(host) = url.host_str() else { return false };
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if url.scheme() == "https" && url.port().is_none() && crate::nav_guard::APP_DOMAINS.contains(&host) {
        return true;
    }
    debug && url.scheme() == "http" && host == "localhost" && matches!(url.port(), Some(3000) | Some(3001))
}

/// A single byte range of a `len`-byte file, at most [`TAKE_RANGE_MAX`] long: `bytes=a-b`, `bytes=a-` or
/// `bytes=-n`. None when it cannot be served (416). Pure.
pub fn take_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') || len == 0 {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        if n == 0 {
            return None;
        }
        (len.saturating_sub(n), len - 1)
    } else {
        let start: u64 = a.parse().ok()?;
        let end = if b.is_empty() { len - 1 } else { b.parse::<u64>().ok()?.min(len - 1) };
        (start, end)
    };
    if start >= len || end < start {
        return None;
    }
    Some((start, end.min(start + TAKE_RANGE_MAX - 1)))
}

/// What the scheme answers a request for `path` (`/<key>/<session>/<role>`) of a take under `base` (the takes folder).
/// Only with this run's `key` (any other, or none, is not found); never for a page that says it is someone else's (an
/// `Origin` header that is not one of the app's own, `null` included, is refused); only GET, HEAD and a CORS
/// preflight; only one of the four role files ([`role_file`]) of a UUID-named take folder that is truly directly under
/// `base` (a folder or file that is a link is refused) and belongs to the account signed in now (or to nobody known
/// yet). The page names no path: a key, a session id and a role. Bytes in ranges; a HEAD answers the length.
#[allow(clippy::too_many_arguments)]
pub fn take_file_response(
    base: &Path,
    method: &str,
    path: &str,
    range: Option<&str>,
    origin: Option<&str>,
    key: &str,
    signed_in: Option<&str>,
    debug: bool,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};
    let plain = |status: StatusCode, text: &str| {
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "text/plain")
            .body(text.as_bytes().to_vec())
            .unwrap()
    };
    if let Some(origin) = origin {
        if !take_origin_allowed(origin, debug) {
            return plain(StatusCode::FORBIDDEN, "not for this page");
        }
    }
    let cors = |builder: tauri::http::response::Builder| match origin {
        Some(o) => builder
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, o)
            .header(header::VARY, "Origin")
            .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Range, Content-Length, Accept-Ranges"),
        None => builder,
    };
    let mut parts = path.trim_start_matches('/').split('/');
    let (Some(asked_key), Some(session), Some(role), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return plain(StatusCode::NOT_FOUND, "no such file");
    };
    // The key compared in full whatever it holds, so its length or first bytes are never learnt from the time taken.
    let same_key = asked_key.len() == key.len() && asked_key.bytes().zip(key.bytes()).fold(0u8, |d, (a, b)| d | (a ^ b)) == 0;
    if key.is_empty() || !same_key {
        return plain(StatusCode::NOT_FOUND, "no such file");
    }
    if method == "OPTIONS" {
        return cors(Response::builder().status(StatusCode::NO_CONTENT))
            .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD")
            .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range")
            .body(Vec::new())
            .unwrap();
    }
    if method != "GET" && method != "HEAD" {
        return plain(StatusCode::METHOD_NOT_ALLOWED, "read only");
    }
    let Some(name) = role_file(role).filter(|_| valid_session_id(session)) else {
        return plain(StatusCode::NOT_FOUND, "no such file");
    };
    // The take folder, the real one, directly under the takes folder.
    let folder = base.join(session);
    let real = |p: &Path| std::fs::canonicalize(p).ok();
    let linked = std::fs::symlink_metadata(&folder).map(|m| m.file_type().is_symlink()).unwrap_or(true);
    let (Some(root), Some(at)) = (real(base), real(&folder)) else { return plain(StatusCode::NOT_FOUND, "no such file") };
    if linked || at.parent() != Some(root.as_path()) {
        return plain(StatusCode::NOT_FOUND, "no such file");
    }
    if signed_in.is_none() || account_check(read_owner(&at).as_deref(), signed_in).is_err() {
        return plain(StatusCode::FORBIDDEN, "not this account's recording");
    }
    let file = at.join(name);
    let Ok(meta) = std::fs::symlink_metadata(&file) else { return plain(StatusCode::NOT_FOUND, "no such file") };
    if !meta.file_type().is_file() {
        return plain(StatusCode::NOT_FOUND, "no such file");
    }
    let len = meta.len();
    let content_type = if name.ends_with(".m4a") { "audio/mp4" } else { "video/mp4" };
    let head = method == "HEAD";
    let (status, start, end) = match range {
        Some(range) => match take_range(range, len) {
            Some((start, end)) => (StatusCode::PARTIAL_CONTENT, start, end),
            None => {
                return cors(Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE))
                    .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                    .body(Vec::new())
                    .unwrap()
            }
        },
        // A whole file only when small (a player asks for ranges); a HEAD is always answered with the length.
        None if head || len <= TAKE_RANGE_MAX => (StatusCode::OK, 0, len.saturating_sub(1)),
        None => return plain(StatusCode::RANGE_NOT_SATISFIABLE, "ask for a range"),
    };
    let body = if head || len == 0 {
        Vec::new()
    } else {
        use std::io::{Read, Seek, SeekFrom};
        let mut buf = vec![0u8; (end - start + 1) as usize];
        let read = std::fs::File::open(&file).and_then(|mut f| {
            f.seek(SeekFrom::Start(start))?;
            f.read_exact(&mut buf)
        });
        if read.is_err() {
            return plain(StatusCode::NOT_FOUND, "no such file");
        }
        buf
    };
    let mut builder = cors(Response::builder().status(status))
        .header(header::CONTENT_TYPE, content_type)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_LENGTH, if len == 0 { 0 } else if status == StatusCode::OK { len } else { end - start + 1 });
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
    }
    builder.body(body).unwrap()
}

/// The scheme's handler (registered in lib.rs, on every web view the app makes): [`take_file_response`] with this
/// run's key and the account signed in now, off the main thread.
pub fn serve_take_file<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let base = app.path().app_cache_dir().map(|dir| dir.join(TAKES_DIR));
    let key = app.state::<StudioRecorder>().token().to_string();
    let signed_in = app.try_state::<crate::state::AppState>().and_then(|s| s.auth_token.lock().unwrap().clone()).and_then(|t| crate::browser_exit::session_user(&t));
    let header = |name: tauri::http::HeaderName| request.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
    let (method, path) = (request.method().as_str().to_string(), request.uri().path().to_string());
    let (range, origin) = (header(tauri::http::header::RANGE), header(tauri::http::header::ORIGIN));
    tauri::async_runtime::spawn_blocking(move || {
        let response = match base {
            Ok(base) => take_file_response(&base, &method, &path, range.as_deref(), origin.as_deref(), &key, signed_in.as_deref(), cfg!(debug_assertions)),
            Err(_) => tauri::http::Response::builder().status(404).body(Vec::new()).unwrap(),
        };
        responder.respond(response);
    });
}

/// What the editor needs to open a stopped take at once, from this computer: each role file's SHA-256 and size (its
/// identity until the Studio has filed it), and the microphone's waveform (600 peaks, 0 to 1, from the 16 kHz copy
/// the recorder keeps for the on-device words). `{tracks: [{role, sha256, bytes}], waveform}`.
#[tauri::command]
pub async fn studio_recorder_take_media(app: AppHandle, session_id: String) -> Result<Value, String> {
    // Another account's take on this Mac: not even its hashes or its waveform.
    let (dir, _) = sendable_take(&app, &session_id, Need::Any)?;
    // The hashes the recorder kept as it wrote each file (its stop payload): Stop never reads a file again for them.
    let known: HashMap<String, String> = app
        .state::<StudioRecorder>()
        .takes
        .lock()
        .unwrap()
        .get(&session_id)
        .and_then(|t| t.stopped.as_ref())
        .and_then(|v| v.get("files"))
        .and_then(Value::as_array)
        .map(|files| {
            files
                .iter()
                .filter_map(|f| Some((f.get("role")?.as_str()?.to_string(), f.get("sha256")?.as_str()?.to_string())))
                .filter(|(_, h)| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()))
                .collect()
        })
        .unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let mut tracks = Vec::new();
        for role in ["screen", "camera", "microphone", "system-audio"] {
            let file = dir.join(role_file(role).unwrap_or_default());
            let Ok(meta) = std::fs::symlink_metadata(&file) else { continue };
            if !meta.file_type().is_file() || meta.len() == 0 {
                continue;
            }
            let sha256 = match known.get(role) {
                Some(hash) => hash.clone(),
                None => crate::modules::assets::sha256_file(&file).map_err(|e| refusal("io", e))?,
            };
            tracks.push(json!({ "role": role, "sha256": sha256, "bytes": meta.len() }));
        }
        let waveform = std::fs::File::open(dir.join("mic-16k.f32")).ok().and_then(|f| pcm_peaks(f, 600));
        Ok(json!({ "tracks": tracks, "waveform": waveform }))
    })
    .await
    .map_err(|e| refusal("io", e))?
}

/// The peak of each of `bins` equal stretches of little-endian f32 samples (as the Studio's waveform: 0 to 1), read
/// as a stream. None for an empty stream. Pure but for the reading.
pub fn pcm_peaks(mut reader: impl std::io::Read, bins: usize) -> Option<Vec<f64>> {
    let mut samples: Vec<f32> = Vec::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut carry: Vec<u8> = Vec::new();
    // Keep one peak per 64 samples while reading (a long take would be hundreds of MB), then bin those.
    let mut block_peak = 0f32;
    let mut in_block = 0usize;
    loop {
        let n = reader.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        carry.extend_from_slice(&buf[..n]);
        let whole = carry.len() / 4 * 4;
        for chunk in carry[..whole].chunks_exact(4) {
            let v = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]).abs();
            if v.is_finite() && v > block_peak {
                block_peak = v;
            }
            in_block += 1;
            if in_block == 64 {
                samples.push(block_peak);
                block_peak = 0.0;
                in_block = 0;
            }
        }
        carry.drain(..whole);
    }
    if in_block > 0 {
        samples.push(block_peak);
    }
    if samples.is_empty() {
        return None;
    }
    let n = bins.min(samples.len());
    Some(
        (0..n)
            .map(|bin| {
                let (from, to) = (bin * samples.len() / n, (bin + 1) * samples.len() / n);
                samples[from..to.max(from + 1)].iter().copied().fold(0f32, f32::max).min(1.0) as f64
            })
            .collect(),
    )
}

/// The client every upload uses: no redirect (a redirect could carry the bytes
/// to a host the allowlist never saw).
fn upload_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| refusal("upload", e))
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
    fn segments_are_whole_lines_end_to_end_within_the_file() {
        let index = "init 0 600\nmedia 600 1000 2.000000\nmedia 1600 900 4.000000\nmedia 2500 70";
        let got = parse_segments(index, 2500);
        assert_eq!(got.len(), 3, "the torn last line is left out");
        assert_eq!(got[1], Segment { index: 1, kind: "media".into(), offset: 600, length: 1000, end_seconds: Some(2.0) });
        // Bytes the file does not hold yet, a gap, a media segment first: the list stops there.
        assert_eq!(parse_segments(index, 2000).len(), 2);
        assert_eq!(parse_segments("init 0 600\nmedia 601 10 1\n", 10_000).len(), 1);
        assert!(parse_segments("media 0 600 1\n", 10_000).is_empty());
        assert!(parse_segments("init 0 600\ninit 600 10\n", 10_000).len() == 1);
        assert!(parse_segments("", 10).is_empty());
    }

    /// The index the recorder's own writer made for a test take (studio-worker/test/fixtures/recorder, made by
    /// the sidecar's WriterTests): every segment read, end to end, to the file's last byte.
    #[test]
    fn the_recorders_own_index_reads_to_the_end_of_its_file() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../studio-worker/test/fixtures/recorder");
        let index = std::fs::read_to_string(dir.join("screen.mp4.segments")).unwrap();
        let len = std::fs::metadata(dir.join("screen.mp4")).unwrap().len();
        let segments = parse_segments(&index, len);
        assert_eq!(segments.len(), index.lines().count());
        assert_eq!(segments[0].kind, "init");
        assert_eq!(indexed_end(&segments), len);
        assert!(segments.iter().skip(1).all(|s| s.end_seconds.is_some()));
    }

    fn planned(index: u64, offset: u64, length: u64) -> PlannedPiece {
        PlannedPiece { index, offset, length, seconds: index as f64 * 4.0, offset_seconds: Some(0.25) }
    }

    fn segs(lengths: &[u64]) -> Vec<Segment> {
        let mut at = 0;
        lengths.iter().enumerate().map(|(index, &length)| {
            let s = Segment { index, kind: if index == 0 { "init" } else { "media" }.into(), offset: at, length, end_seconds: Some(index as f64 * 2.0) };
            at += length;
            s
        }).collect()
    }

    #[test]
    fn a_plan_grows_by_whole_segments_or_equal_parts_of_a_long_run_and_no_further() {
        // init 600, then segments of 2000, 3000, 1000 and one of 40 MB.
        let segments = segs(&[600, 2000, 3000, 1000, 40 * 1024 * 1024]);
        let plan = vec![planned(0, 0, 2600)];
        assert_eq!(extend_plan(&plan, &[planned(1, 2600, 3000)], &segments).unwrap(), vec![planned(1, 2600, 3000)]);
        assert_eq!(extend_plan(&plan, &[planned(1, 2600, 4000)], &segments).unwrap().len(), 1, "two segments as one piece");
        // The same piece planned again changes nothing; planned otherwise, it is refused.
        assert!(extend_plan(&plan, &[planned(0, 0, 2600)], &segments).unwrap().is_empty());
        assert!(extend_plan(&plan, &[planned(0, 0, 2599)], &segments).is_err());
        // Not ending on a segment end; a gap; a skipped index; past the written segments; empty.
        assert!(extend_plan(&plan, &[planned(1, 2600, 1)], &segments).is_err(), "a one-byte piece");
        assert!(extend_plan(&plan, &[planned(1, 2600, 2999)], &segments).is_err());
        assert!(extend_plan(&plan, &[planned(1, 2601, 2999)], &segments).is_err());
        assert!(extend_plan(&plan, &[planned(2, 2600, 3000)], &segments).is_err());
        assert!(extend_plan(&plan, &[planned(1, 2600, 0)], &segments).is_err());
        // A run past 16 MB: equal parts only, as the page cuts it (three of 40 MB + 1000 bytes).
        let run_start: u64 = 2600 + 3000;
        let total: u64 = 1000 + 40 * 1024 * 1024;
        let size = total.div_ceil(3u64);
        let plan2 = vec![planned(0, 0, 2600), planned(1, 2600, 3000)];
        let parts = vec![planned(2, run_start, size), planned(3, run_start + size, size), planned(4, run_start + 2 * size, total - 2 * size)];
        assert_eq!(extend_plan(&plan2, &parts, &segments).unwrap().len(), 3);
        let uneven = vec![planned(2, run_start, size + 1), planned(3, run_start + size + 1, size - 1), planned(4, run_start + 2 * size, total - 2 * size)];
        assert!(extend_plan(&plan2, &uneven, &segments).is_err());
        assert!(extend_plan(&plan2, &[planned(2, run_start, 16 * 1024 * 1024)], &segments).is_err(), "a run cut short of a segment end");
        // A piece under 1024 bytes is only ever a track's last.
        let small = segs(&[600, 100, 3000]);
        let after_small = vec![planned(0, 0, 700)];
        assert!(extend_plan(&after_small, &[planned(1, 700, 3000)], &small).is_err());
        // At most 10,000 pieces a track.
        let many: Vec<Segment> = segs(&vec![2000; TRACK_MAX_PIECES + 2]);
        let full: Vec<PlannedPiece> = (0..TRACK_MAX_PIECES as u64).map(|i| planned(i, i * 2000, 2000)).collect();
        assert!(extend_plan(&full, &[planned(TRACK_MAX_PIECES as u64, TRACK_MAX_PIECES as u64 * 2000, 2000)], &many).is_err());
    }

    #[test]
    fn a_torn_plan_line_is_cut_away_before_the_plan_grows() {
        let text: String = [planned(0, 0, 10), planned(1, 10, 5), planned(3, 15, 5)].iter().map(|p| serde_json::to_string(p).unwrap() + "\n").collect();
        let first_two: String = [planned(0, 0, 10), planned(1, 10, 5)].iter().map(|p| serde_json::to_string(p).unwrap() + "\n").collect();
        assert_eq!(plan_and_length(&text), (vec![planned(0, 0, 10), planned(1, 10, 5)], first_two.len()), "a plan read back stops at a break");
        let torn = first_two.clone() + "{\"index\":2,\"off";
        assert_eq!(plan_and_length(&torn), (vec![planned(0, 0, 10), planned(1, 10, 5)], first_two.len()), "a torn last line is not a piece");
        // Cut back to the plan, then appended: the plan reads whole again.
        let mended = torn[..plan_and_length(&torn).1].to_string() + &serde_json::to_string(&planned(2, 15, 5)).unwrap() + "\n";
        assert_eq!(parse_plan(&mended).len(), 3);
    }

    const TAKE: &str = "5a5a5a5a-1111-4222-8333-999999999999";
    const SESSION: &str = "0f0f0f0f-1111-4222-8333-444444444444";

    #[test]
    fn a_piece_goes_only_to_its_own_takes_place() {
        let url = |path: &str| format!("https://sb.nativeintelligence.dev/storage/v1/object/upload/sign/{path}?token=t");
        let link = LiveLink { take_id: Some(TAKE.into()), ..LiveLink::default() };
        let place = piece_destination(&link, &url(&format!("studio/ws-1/live/{TAKE}/screen/3")), "screen", 3).unwrap();
        assert_eq!(place, format!("studio/ws-1/live/{TAKE}"));
        // Another take (a link minted in another workspace for a take id of its own), another role or index, not live.
        for bad in [
            "studio/ws-1/live/6b6b6b6b-1111-4222-8333-999999999999/screen/3".to_string(),
            format!("studio/ws-1/live/{TAKE}/camera/3"),
            format!("studio/ws-1/live/{TAKE}/screen/4"),
            format!("studio/ws-1/uploads/{TAKE}/0"),
            format!("studio/ws-1/live/{TAKE}/screen/3/x"),
            format!("studio/ws-1/live/{TAKE}/screen/%2e%2e"),
        ] {
            assert!(piece_destination(&link, &url(&bad), "screen", 3).is_err(), "{bad}");
        }
        assert!(piece_destination(&LiveLink::default(), &url(&format!("studio/ws-1/live/{TAKE}/screen/3")), "screen", 3).is_err(), "an unlinked take sends no piece");
        assert_eq!(piece_destination(&link, &url(&format!("studio/ws-1/live/{TAKE}/systemAudio/0")), "system-audio", 0).unwrap(), place);
        // Once placed, the same take id in another workspace is refused.
        let placed = LiveLink { take_id: Some(TAKE.into()), prefix: Some(place.clone()), ..LiveLink::default() };
        assert!(piece_destination(&placed, &url(&format!("studio/ws-2/live/{TAKE}/screen/3")), "screen", 3).is_err());
        // A whole file: its own workspace's uploads once placed; never before (a linked take's first piece places it);
        // an offline take's first whole file places it, every later one follows.
        let upload = |ws: &str| url(&format!("studio/{ws}/uploads/0e0e0e0e-1111-4222-8333-000000000001/0"));
        assert_eq!(upload_place(&placed, &upload("ws-1")).as_deref(), Some("studio/ws-1"));
        assert!(upload_place(&placed, &upload("ws-2")).is_none());
        assert!(upload_place(&link, &upload("ws-1")).is_none());
        assert_eq!(upload_place(&LiveLink::default(), &upload("ws-9")).as_deref(), Some("studio/ws-9"));
        let offline = LiveLink { workspace: Some("studio/ws-9".into()), ..LiveLink::default() };
        assert!(upload_place(&offline, &upload("ws-1")).is_none());
        assert!(upload_place(&offline, &url(&format!("studio/ws-9/live/{TAKE}/screen/0"))).is_none());
    }

    #[test]
    fn a_take_is_refused_only_when_two_known_accounts_differ_and_otherwise_becomes_the_signed_in_ones() {
        assert_eq!(account_check(Some("user-1"), Some("user-1")), Ok(None));
        assert_eq!(account_check(None, Some("user-1")), Ok(Some("user-1".into())), "started with no session: becomes theirs");
        assert_eq!(account_check(Some("user-1"), None), Ok(None));
        assert_eq!(account_check(None, None), Ok(None));
        assert_eq!(account_check(Some(""), Some("user-2")), Ok(Some("user-2".into())));
        let refused = account_check(Some("user-1"), Some("user-2")).unwrap_err();
        assert!(refused.starts_with("forbidden: ") && refused.contains("another account"), "a plain sentence: {refused}");
    }

    /// A take folder as the recorder and this module leave it.
    fn take_dir(base: &Path, session: &str, owner: Option<&str>, link: Option<LiveLink>) -> PathBuf {
        let dir = base.join(session);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("screen.mp4"), vec![1u8; 1600]).unwrap();
        std::fs::write(dir.join("screen.mp4.segments"), "init 0 600\nmedia 600 1000 2.000000\n").unwrap();
        if let Some(owner) = owner {
            std::fs::write(dir.join(ACCOUNT_FILE), owner).unwrap();
        }
        if let Some(link) = link {
            write_link(&dir, &link).unwrap();
        }
        dir
    }

    #[test]
    fn what_a_page_may_do_with_a_take_of_this_run_or_an_earlier_one() {
        let base = tempfile::tempdir().unwrap();
        let mine = take_dir(base.path(), SESSION, Some("user-1"), Some(LiveLink { take_id: Some(TAKE.into()), ..LiveLink::default() }));
        // This run's take: its account only; a take that started with no session becomes the signed-in one's.
        assert_eq!(take_access(&mine, Some(Some("user-1")), Some("user-1"), Need::Linked), Ok(None));
        assert!(take_access(&mine, Some(Some("user-1")), Some("user-2"), Need::Any).is_err());
        assert_eq!(take_access(&mine, Some(None), Some("user-1"), Need::Any), Ok(None), "its account file says whose it is");
        let fresh = take_dir(base.path(), "1f1f1f1f-1111-4222-8333-444444444444", None, None);
        assert_eq!(take_access(&fresh, Some(None), Some("user-3"), Need::Any), Ok(Some("user-3".into())));
        // An earlier run's take: its account, and what the command needs of its link.
        assert_eq!(take_access(&mine, None, Some("user-1"), Need::Linked), Ok(None));
        assert!(take_access(&mine, None, Some("user-1"), Need::Placed).is_err(), "never placed");
        assert!(take_access(&mine, None, Some("user-2"), Need::Any).is_err(), "another account's");
        assert!(take_access(&fresh, None, Some("user-1"), Need::Linked).is_err(), "never linked");
        assert_eq!(take_access(&fresh, None, Some("user-1"), Need::Any), Ok(Some("user-1".into())), "an offline take: its whole files, for whoever is signed in");
        let placed = take_dir(base.path(), "2f2f2f2f-1111-4222-8333-444444444444", Some("user-1"), Some(LiveLink { take_id: Some(TAKE.into()), prefix: Some(format!("studio/ws/live/{TAKE}")), ..LiveLink::default() }));
        assert_eq!(take_access(&placed, None, Some("user-1"), Need::Placed), Ok(None));
    }

    #[test]
    fn a_page_holds_a_take_until_it_lets_go_or_stops_renewing() {
        let mut leases = Leases::default();
        let t0 = std::time::Instant::now();
        assert!(leases.hold(SESSION, "page-a", t0));
        assert!(!leases.hold(SESSION, "page-b", t0 + Duration::from_secs(5)), "another window: open elsewhere");
        assert!(leases.hold(SESSION, "page-a", t0 + Duration::from_secs(15)), "renewed");
        assert!(leases.active(t0 + Duration::from_secs(30)).contains(SESSION), "renewed at 15 s, held until 35 s");
        assert!(!leases.active(t0 + Duration::from_secs(36)).contains(SESSION), "a page that stopped renewing (reloaded, crashed) lets go");
        assert!(leases.hold(SESSION, "page-b", t0 + Duration::from_secs(36)));
        leases.release(SESSION, "page-a");
        assert!(leases.active(t0 + Duration::from_secs(37)).contains(SESSION), "only its holder lets go");
        assert!(leases.active_for_others(t0 + Duration::from_secs(37), Some("page-b")).is_empty(), "a page's own takes are not busy for it");
        assert!(leases.active_for_others(t0 + Duration::from_secs(37), Some("page-a")).contains(SESSION));
        leases.release(SESSION, "page-b");
        assert!(leases.active(t0 + Duration::from_secs(37)).is_empty());
    }

    #[test]
    fn what_is_left_to_send_is_the_signed_in_accounts_takes_no_live_page_holds_offline_ones_too() {
        let base = tempfile::tempdir().unwrap();
        let linked = LiveLink { take_id: Some(TAKE.into()), ..LiveLink::default() };
        take_dir(base.path(), SESSION, Some("user-1"), Some(linked.clone()));
        take_dir(base.path(), "1f1f1f1f-1111-4222-8333-444444444444", Some("user-2"), Some(linked.clone()));
        take_dir(base.path(), "2f2f2f2f-1111-4222-8333-444444444444", None, Some(linked));
        take_dir(base.path(), "3f3f3f3f-1111-4222-8333-444444444444", Some("user-1"), None);
        std::fs::create_dir_all(base.path().join("not-a-take")).unwrap();
        let none = std::collections::HashSet::new();
        let listed = |busy: &std::collections::HashSet<String>, me: Option<&str>| {
            let mut ids: Vec<(String, Value)> = unfinished_in(base.path(), busy, me).into_iter().map(|t| (t["sessionId"].as_str().unwrap().to_string(), t["takeId"].clone())).collect();
            ids.sort_by(|a, b| a.0.cmp(&b.0));
            ids
        };
        assert_eq!(listed(&none, Some("user-1")), vec![
            (SESSION.to_string(), json!(TAKE)),
            ("2f2f2f2f-1111-4222-8333-444444444444".to_string(), json!(TAKE)),
            ("3f3f3f3f-1111-4222-8333-444444444444".to_string(), Value::Null),
        ], "another account's take is left alone; one with no account yet and an offline one are listed");
        let busy: std::collections::HashSet<String> = [SESSION.to_string()].into();
        assert!(!listed(&busy, Some("user-1")).iter().any(|(id, _)| id == SESSION), "a take a live page holds is that page's");
        assert!(listed(&none, None).is_empty(), "nobody signed in: nothing to send");
        // A draft that reads as one is the page's; a torn one never hides the take (it is said, and the take goes on).
        let row = |session: &str| unfinished_in(base.path(), &none, Some("user-1")).into_iter().find(|t| t["sessionId"] == session).unwrap();
        std::fs::write(base.path().join(SESSION).join(DRAFT_FILE), br#"{"v":2}"#).unwrap();
        assert_eq!((row(SESSION)["hasDraft"].clone(), row(SESSION)["draftUnreadable"].clone()), (json!(true), json!(false)));
        std::fs::write(base.path().join(SESSION).join(DRAFT_FILE), br#"{"v":2,"draft":{"cli"#).unwrap();
        assert_eq!((row(SESSION)["hasDraft"].clone(), row(SESSION)["draftUnreadable"].clone()), (json!(false), json!(true)));
        // The stop payload kept beside it files a take no page has again.
        std::fs::write(base.path().join("3f3f3f3f-1111-4222-8333-444444444444").join(STOPPED_FILE), br#"{"files":[]}"#).unwrap();
        assert_eq!(row("3f3f3f3f-1111-4222-8333-444444444444")["stop"], json!({ "files": [] }));
    }

    #[test]
    fn two_writers_of_a_draft_never_tear_it() {
        let base = tempfile::tempdir().unwrap();
        let path = base.path().join(DRAFT_FILE);
        let a = "{\"v\":2,\"who\":\"a\",\"pad\":\"".to_string() + &"a".repeat(200_000) + "\"}";
        let b = "{\"v\":2,\"who\":\"b\",\"pad\":\"".to_string() + &"b".repeat(200_000) + "\"}";
        std::thread::scope(|scope| {
            for text in [&a, &b] {
                let path = &path;
                scope.spawn(move || for _ in 0..50 { write_atomic(path, text.as_bytes()).unwrap(); });
            }
        });
        let kept = std::fs::read_to_string(&path).unwrap();
        assert!(kept == a || kept == b, "whole, one writer's or the other's");
        assert_eq!(std::fs::read_dir(base.path()).unwrap().count(), 1, "no temporary file left behind");
    }

    #[test]
    fn a_take_file_is_served_only_with_this_runs_key_to_the_apps_own_pages_for_its_own_account() {
        use tauri::http::StatusCode;
        let base = tempfile::tempdir().unwrap();
        let dir = take_dir(base.path(), SESSION, Some("user-1"), None);
        let bytes: Vec<u8> = (0..100u32).map(|i| i as u8).collect();
        std::fs::write(dir.join("screen.mp4"), &bytes).unwrap();
        std::fs::write(dir.join("trace.json"), b"{}").unwrap();
        let key = "k".repeat(64);
        let app = Some("https://nativeintelligence.dev");
        let ask = |method: &str, path: &str, range: Option<&str>, origin: Option<&str>, me: Option<&str>, debug: bool| take_file_response(base.path(), method, path, range, origin, &key, me, debug);
        let get = |path: &str, range: Option<&str>, origin: Option<&str>| ask("GET", path, range, origin, Some("user-1"), false);
        let at = format!("/{key}/{SESSION}/screen");
        let ok = get(&at, Some("bytes=10-19"), app);
        assert_eq!(ok.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(ok.body(), &bytes[10..20]);
        assert_eq!(ok.headers()["content-range"], "bytes 10-19/100");
        assert_eq!(ok.headers()["access-control-allow-origin"], "https://nativeintelligence.dev");
        assert_eq!(get(&at, Some("bytes=-5"), None).body(), &bytes[95..], "no Origin header (a media element): the key is enough");
        assert_eq!(get(&at, Some("bytes=90-"), app).body(), &bytes[90..]);
        assert_eq!(get(&at, Some("bytes=100-"), app).status(), StatusCode::RANGE_NOT_SATISFIABLE);
        // No key, a wrong key, an earlier run's key.
        assert_eq!(get(&format!("/{SESSION}/screen"), None, app).status(), StatusCode::NOT_FOUND);
        assert_eq!(get(&format!("/{}/{SESSION}/screen", "x".repeat(64)), None, app).status(), StatusCode::NOT_FOUND);
        assert_eq!(take_file_response(base.path(), "GET", &at, None, app, &"e".repeat(64), Some("user-1"), false).status(), StatusCode::NOT_FOUND);
        assert_eq!(take_file_response(base.path(), "GET", &format!("//{SESSION}/screen"), None, app, "", Some("user-1"), false).status(), StatusCode::NOT_FOUND);
        // A page that is not ours: a foreign origin, `null`, a dev port in a release build, an unlisted dev port.
        for origin in ["https://example.com", "null", "https://evil.nativeintelligence.dev", "http://nativeintelligence.dev", "http://localhost:3000"] {
            assert_eq!(get(&at, Some("bytes=0-1"), Some(origin)).status(), StatusCode::FORBIDDEN, "{origin}");
        }
        assert_eq!(ask("GET", &at, Some("bytes=0-1"), Some("http://localhost:3001"), Some("user-1"), true).status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(ask("GET", &at, Some("bytes=0-1"), Some("http://localhost:4000"), Some("user-1"), true).status(), StatusCode::FORBIDDEN);
        // Another account's take, or nobody signed in.
        assert_eq!(ask("GET", &at, Some("bytes=0-1"), app, Some("user-2"), false).status(), StatusCode::FORBIDDEN);
        assert_eq!(ask("GET", &at, Some("bytes=0-1"), app, None, false).status(), StatusCode::FORBIDDEN);
        // Only the four role files of a UUID-named take folder that is truly under the takes folder.
        for path in [format!("/{key}/{SESSION}/trace"), format!("/{key}/{SESSION}/../{SESSION}/screen"), format!("/{key}/not-a-take/screen"), format!("/{key}/{SESSION}/screen/x"), format!("/{key}/{SESSION}")] {
            assert_eq!(get(&path, Some("bytes=0-1"), app).status(), StatusCode::NOT_FOUND, "{path}");
        }
        assert_eq!(get(&format!("/{key}/{SESSION}/camera"), Some("bytes=0-1"), app).status(), StatusCode::NOT_FOUND);
        let elsewhere = tempfile::tempdir().unwrap();
        let outside = take_dir(elsewhere.path(), "4f4f4f4f-1111-4222-8333-444444444444", Some("user-1"), None);
        std::os::unix::fs::symlink(&outside, base.path().join("4f4f4f4f-1111-4222-8333-444444444444")).unwrap();
        assert_eq!(get(&format!("/{key}/4f4f4f4f-1111-4222-8333-444444444444/screen"), Some("bytes=0-1"), app).status(), StatusCode::NOT_FOUND, "a linked folder");
        // Read only; a HEAD with no range answers the length, also for a file past what one answer carries.
        assert_eq!(ask("PUT", &at, None, app, Some("user-1"), false).status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(ask("OPTIONS", &at, None, app, Some("user-1"), false).status(), StatusCode::NO_CONTENT);
        let big = std::fs::File::create(dir.join("microphone.m4a")).unwrap();
        big.set_len(TAKE_RANGE_MAX * 2).unwrap();
        let head = ask("HEAD", &format!("/{key}/{SESSION}/microphone"), None, app, Some("user-1"), false);
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(head.headers()["content-length"], (TAKE_RANGE_MAX * 2).to_string().as_str());
        assert!(head.body().is_empty());
        assert_eq!(ask("GET", &format!("/{key}/{SESSION}/microphone"), None, app, Some("user-1"), false).status(), StatusCode::RANGE_NOT_SATISFIABLE);
    }

    #[test]
    fn a_range_is_one_stretch_and_never_past_the_most_one_answer_carries() {
        assert_eq!(take_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(take_range("bytes=0-", TAKE_RANGE_MAX * 3), Some((0, TAKE_RANGE_MAX - 1)));
        assert_eq!(take_range("bytes=5-1", 100), None);
        assert_eq!(take_range("bytes=-0", 100), None);
        assert_eq!(take_range("items=0-1", 100), None);
        assert_eq!(take_range("bytes=0-1", 0), None);
    }

    #[test]
    fn the_waveform_is_the_peak_of_each_stretch() {
        // 600 stretches of 128 samples: stretch k peaks at (k + 1) / 601, once, everything else quieter.
        let samples: Vec<u8> = (0..600 * 128).flat_map(|i| {
            let k = i / 128;
            (if i % 128 == 37 { (k as f32 + 1.0) / 601.0 } else { 0.5 * (k as f32 + 1.0) / 601.0 }).to_le_bytes()
        }).collect();
        let peaks = pcm_peaks(std::io::Cursor::new(samples), 600).unwrap();
        assert_eq!(peaks.len(), 600);
        for (k, peak) in peaks.iter().enumerate() {
            assert!((peak - (k as f64 + 1.0) / 601.0).abs() < 1e-6, "stretch {k}: {peak}");
        }
        // Louder than full scale is held at 1; fewer samples than stretches: one peak each.
        let loud: Vec<u8> = (0..64).flat_map(|_| 3.0f32.to_le_bytes()).collect();
        assert_eq!(pcm_peaks(std::io::Cursor::new(loud), 600).unwrap(), vec![1.0]);
        assert!(pcm_peaks(std::io::Cursor::new(Vec::<u8>::new()), 600).is_none());
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
        // Old takes with a recording in them: one with a draft, one with nothing else (never filed, a lost track, a
        // failed filing: the folder cannot tell, and none of them is the Studio's yet). Kept, however old.
        let drafted = base.path().join(uuid::Uuid::new_v4().to_string());
        let unsettled = base.path().join(uuid::Uuid::new_v4().to_string());
        for dir in [&drafted, &unsettled] {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join("screen.mp4"), b"recorded").unwrap();
        }
        std::fs::write(drafted.join(DRAFT_FILE), b"{}").unwrap();
        // Let go of by the page (the Studio holds every byte, or the person discarded it), its removal cut short.
        let released = base.path().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&released).unwrap();
        std::fs::write(released.join("microphone.m4a"), b"recorded").unwrap();
        std::fs::write(released.join(RELEASED_FILE), b"").unwrap();
        let later = SystemTime::now() + Duration::from_secs(400 * 24 * 60 * 60);
        assert_eq!(sweep(base.path(), KEEP_TAKES_FOR, later), 2);
        assert!(!old.exists(), "an old folder with no recording in it");
        assert!(!released.exists(), "a take let go of");
        assert!(drafted.exists() && unsettled.exists(), "a take with a recording is never removed by its age");
        assert!(other.exists(), "only UUID-named take folders are ever removed");
        let fresh = base.path().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&fresh).unwrap();
        assert_eq!(sweep(base.path(), KEEP_TAKES_FOR, SystemTime::now()), 0);
        assert!(fresh.exists());
    }
}
