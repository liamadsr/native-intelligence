//! The Studio's exports on the person's own computer (macOS on Apple
//! silicon, Windows x64), and saving any export to a place they pick.
//!
//! The export itself is the Studio's local runner (studio-worker
//! src/local-main.ts, src/local.ts), Node code shipped inside the signed app
//! (`Resources/studio-runner`, staged by desktop/scripts/studio-runner.sh),
//! run on:
//! - Node: the local agent's pinned runtime, shared ([`crate::local_agent::runtime`]);
//! - Chrome's headless shell and our FFmpeg with ffprobe: pinned per
//!   computer, downloaded on first use ([`components`]);
//!
//! started by the app for ONE job with the token the Studio minted for it
//! ([`runner`]: arguments and environment from here, the token on standard
//! input only), held on a leash ([`procs`]: a process group and its
//! descendants on macOS, a Job Object on Windows), its output turned into
//! `studio-local://progress` events ([`events`]), its video moved to the
//! place the person picked ([`destinations`]). One export at a time; while
//! it runs the computer does not idle-sleep and the app does not install an
//! update ([`holds_updates`]).
//!
//! No command takes a path or a URL from the page: a destination is an id
//! from the native save panel, the app's origin is Rust's own, every
//! download is pinned, and a server export's part links are held to the
//! app's storage host ([`save_parts`]).
//!
//! Not fenced yet: the runner, Chrome and FFmpeg run with the person's own
//! rights (no Seatbelt profile on macOS; Windows has no equivalent). See the
//! report in desktop/README.md, "Studio exports on this computer".

pub mod commands;
pub mod components;
pub mod destinations;
pub mod events;
pub mod procs;
pub mod run_state;
pub mod runner;
pub mod save_parts;
pub mod unzip;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Notify;

use crate::local_agent::runtime::{self, Runtime, RuntimeState};
use crate::sidecar::NoConsole;
use components::{Component, ComponentSpec, State};
use destinations::{Claim, Destinations};
use events::{EventLog, ExportEvent, Kind};
use run_state::RunState;
use runner::{RunnerEvent, RunnerFiles, Scrub};

pub const PROGRESS_EVENT: &str = "studio-local://progress";
pub const PREPARE_EVENT: &str = "studio-local://prepare";
/// A server export being saved: `{ destinationId, receivedBytes, totalBytes }`.
pub const SAVE_EVENT: &str = "studio-local://save";

/// The runner bundle's folder in the app's resources.
const RUNNER_RESOURCE: &str = "studio-runner";
/// The debug-build override for the runner bundle: a folder built by
/// studio-worker's `scripts/build-local-runner.ts`. Read only in a debug build.
pub const DEV_RUNNER_ENV: &str = "NI_STUDIO_RUNNER_DIR";
/// The render bundle's manifest (studio-worker src/bundle-dir.ts BUNDLE_MANIFEST).
const BUNDLE_MANIFEST: &str = "studio-render.json";
/// Free space an export wants beyond the downloads (scratch, cache, the video).
const EXPORT_DISK_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// How long a cancelled runner has to stop by itself (it tells the Studio).
const CANCEL_GRACE: Duration = Duration::from_secs(10);
/// The page hears about a live export at least this often.
const HEARTBEAT: Duration = Duration::from_secs(10);
/// Progress events at most this often.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);
/// The encoder probe's limit.
const PROBE_TIMEOUT: Duration = Duration::from_secs(120);
/// A finished export that could not be put in place is kept this long.
const KEEP_FOR: Duration = Duration::from_secs(3 * 24 * 60 * 60);

/// An export is running: no update installs meanwhile (app_update.rs).
static EXPORT_RUNNING: AtomicBool = AtomicBool::new(false);

/// Whether an export on this computer holds updates back (the macOS install
/// replaces the app the runner is reading from; a Windows install quits the
/// app and with it the export).
pub fn holds_updates() -> bool {
    EXPORT_RUNNING.load(Ordering::SeqCst)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Components {
    pub runtime: State,
    pub chrome: State,
    pub ffmpeg: State,
}

/// `studio_local_status`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub platform: String,
    pub arch: String,
    pub components: Components,
    pub download_bytes: u64,
    pub render_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoder: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Stop {
    Cancel,
    Quit,
    TakenBack,
}

struct Running {
    job_id: String,
    tree: Arc<procs::Tree>,
    stop: Arc<Notify>,
    reason: Arc<Mutex<Option<Stop>>>,
    finished: Arc<Notify>,
}

pub struct StudioLocal {
    app: AppHandle,
    target: Option<&'static str>,
    runtime: Arc<Runtime>,
    chrome: Component,
    ffmpeg: Component,
    runner_dir: Option<PathBuf>,
    /// `<app cache>/studio-local` (`\sl` on Windows: paths stay short there).
    work_root: PathBuf,
    data_root: PathBuf,
    pub destinations: Destinations,
    prepare_lock: tokio::sync::Mutex<()>,
    runtime_failed: Mutex<Option<String>>,
    runtime_setting_up: AtomicBool,
    events: Mutex<EventLog>,
    current: Mutex<Option<Running>>,
    /// The encoder settled on (label), and whether it works.
    encoder: Mutex<Option<(String, bool)>>,
    probing: AtomicBool,
    picking: AtomicBool,
    /// Saves of part links running now, by destination id: their stop flag
    /// and temp file (a quit stops them and removes it).
    saves: Mutex<HashMap<String, SaveRun>>,
}

#[derive(Clone)]
pub(crate) struct SaveRun {
    pub cancel: Arc<AtomicBool>,
    pub temp: Arc<Mutex<Option<PathBuf>>>,
}

/// The runner bundle at `dir`, if it is one: `runner/runner.cjs` and the
/// render bundle's manifest.
fn runner_bundle(dir: &Path) -> Option<PathBuf> {
    (dir.join("runner").join("runner.cjs").is_file() && dir.join("render-bundle").join(BUNDLE_MANIFEST).is_file()).then(|| dir.to_path_buf())
}

/// The render version the shipped bundle was built from.
fn render_version(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("render-bundle").join(BUNDLE_MANIFEST)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("renderVersion").and_then(|v| v.as_str()).map(str::to_string)
}

/// The sentence for a computer that cannot export. Pure.
pub fn unsupported_reason(os: &str, arch: &str) -> String {
    match (os, arch) {
        ("macos", _) => "Exporting on this computer needs a Mac with Apple silicon, so this video exports on our server.".into(),
        ("windows", _) => "Exporting on this computer needs a Windows computer with an x64 processor, so this video exports on our server.".into(),
        _ => "This computer can't export videos itself, so this video exports on our server.".into(),
    }
}

impl StudioLocal {
    pub fn new(app: AppHandle, runtime: Arc<Runtime>) -> Arc<Self> {
        let target = runtime::current_target();
        let path = app.path();
        let data_root = path
            .app_local_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir().join("ni"))
            .join("studio-local");
        let cache = path.app_cache_dir().unwrap_or_else(|_| std::env::temp_dir().join("ni"));
        let work_root = if cfg!(windows) { cache.join("sl") } else { cache.join("studio-local") };
        let dev_runner = cfg!(debug_assertions)
            .then(|| std::env::var_os(DEV_RUNNER_ENV).map(PathBuf::from))
            .flatten()
            .filter(|p| p.is_absolute())
            .and_then(|p| std::fs::canonicalize(p).ok());
        let runner_dir = dev_runner
            .or_else(|| path.resource_dir().ok().map(|d| d.join(RUNNER_RESOURCE)))
            .and_then(|d| runner_bundle(&d));
        let client = runtime::http_client();
        let chrome = Component::new(ComponentSpec::pinned("chrome", target), data_root.join("chrome"), client.clone(), None);
        let ffmpeg = Component::new(ComponentSpec::pinned("ffmpeg", target), data_root.join("ffmpeg"), client, components::dev_ffmpeg());
        let destinations = Destinations::with_store(data_root.join("saved.json"));
        Arc::new(Self {
            app,
            target,
            runtime,
            chrome,
            ffmpeg,
            runner_dir,
            work_root,
            data_root,
            destinations,
            prepare_lock: tokio::sync::Mutex::new(()),
            runtime_failed: Mutex::new(None),
            runtime_setting_up: AtomicBool::new(false),
            events: Mutex::new(EventLog::default()),
            current: Mutex::new(None),
            encoder: Mutex::new(None),
            probing: AtomicBool::new(false),
            picking: AtomicBool::new(false),
            saves: Mutex::new(HashMap::new()),
        })
    }

    /// Where a finished export that could not be put in place is kept.
    fn kept(&self, job_id: &str) -> PathBuf {
        self.work().join("kept").join(format!("{job_id}.mp4"))
    }

    // ---- saves of part links ------------------------------------------------------------------

    /// Register a save to `destination_id` (stopped by [`Self::cancel_save`] or a quit).
    pub(crate) fn begin_save(&self, destination_id: &str) -> SaveRun {
        let run = SaveRun { cancel: Arc::new(AtomicBool::new(false)), temp: Arc::new(Mutex::new(None)) };
        self.saves.lock().unwrap().insert(destination_id.to_string(), run.clone());
        run
    }

    pub(crate) fn end_save(&self, destination_id: &str) {
        self.saves.lock().unwrap().remove(destination_id);
    }

    /// Stop the save to `destination_id`, if one runs (idempotent).
    pub fn cancel_save(&self, destination_id: &str) {
        if let Some(run) = self.saves.lock().unwrap().get(destination_id) {
            run.cancel.store(true, Ordering::SeqCst);
        }
    }

    fn work(&self) -> PathBuf {
        self.work_root.join("w")
    }

    fn scrub(&self, secret: Option<String>) -> Scrub {
        let home = self.app.path().home_dir().unwrap_or_default();
        let mut folders: Vec<(&Path, &'static str)> = vec![(&self.work_root, "<work folder>"), (&self.data_root, "<app data>")];
        if let Some(r) = &self.runner_dir {
            folders.push((r, "<app>"));
        }
        let home_ref: &Path = &home;
        folders.push((home_ref, "~"));
        Scrub::new(&folders, secret)
    }

    // ---- status -----------------------------------------------------------------------------

    async fn runtime_state(&self) -> State {
        if self.runtime_setting_up.load(Ordering::SeqCst) {
            return State::Downloading;
        }
        if self.target.is_some() && self.runtime.ready_node().await.is_some() {
            return State::Ready;
        }
        if self.runtime_failed.lock().unwrap().is_some() {
            return State::Failed;
        }
        match self.runtime.status().state {
            RuntimeState::Downloading | RuntimeState::Verifying => State::Downloading,
            RuntimeState::Error => State::Failed,
            _ => State::Missing,
        }
    }

    pub async fn status(self: &Arc<Self>) -> Status {
        let platform = std::env::consts::OS.to_string();
        let arch = std::env::consts::ARCH.to_string();
        let render_version = self.runner_dir.as_deref().and_then(render_version);
        let (runtime, chrome, ffmpeg) = if self.target.is_some() {
            (self.runtime_state().await, self.chrome.state().await, self.ffmpeg.state().await)
        } else {
            (State::Missing, State::Missing, State::Missing)
        };
        let ready = |s: State| s == State::Ready;
        let download_bytes = if self.target.is_some() {
            (if ready(runtime) { 0 } else { self.runtime.download_bytes() }) + self.chrome.download_bytes(ready(chrome)) + self.ffmpeg.download_bytes(ready(ffmpeg))
        } else {
            0
        };
        let setup_bytes = (if ready(runtime) { 0 } else { self.runtime.download_bytes() + self.runtime.unpacked_bytes() })
            + self.chrome.setup_bytes(ready(chrome))
            + self.ffmpeg.setup_bytes(ready(ffmpeg));
        let encoder = self.encoder.lock().unwrap().clone();
        let reason = if self.target.is_none() {
            Some(unsupported_reason(&platform, &arch))
        } else if self.runner_dir.is_none() || render_version.is_none() {
            Some("This copy of the app does not include the Studio's exporter, so this video exports on our server.".into())
        } else if self.ffmpeg.unavailable() {
            Some("FFmpeg is not available for this version yet, so this video exports on our server.".into())
        } else if crate::modules::assets::available_space(&self.work_root).is_some_and(|free| free < setup_bytes + EXPORT_DISK_BYTES) {
            let gb = (setup_bytes + EXPORT_DISK_BYTES).div_ceil(1024 * 1024 * 1024);
            Some(format!("This computer is low on disk space: an export here needs about {gb} GB free, so this video exports on our server."))
        } else if encoder.as_ref().is_some_and(|(_, works)| !works) {
            Some("This computer's video encoder did not work in a test, so this video exports on our server.".into())
        } else {
            None
        };
        // The encoder is tried once per app run, in the background, once everything is here.
        if reason.is_none() && encoder.is_none() && ready(runtime) && ready(chrome) && ready(ffmpeg) {
            self.probe_in_background();
        }
        Status {
            available: reason.is_none(),
            reason,
            platform,
            arch,
            components: Components { runtime, chrome, ffmpeg },
            download_bytes,
            render_version,
            encoder: encoder.map(|(label, _)| label),
        }
    }

    // ---- prepare ----------------------------------------------------------------------------

    fn emit_prepare(&self, component: &str, received: u64, total: u64) {
        let _ = self.app.emit(PREPARE_EVENT, serde_json::json!({ "component": component, "receivedBytes": received, "totalBytes": total }));
    }

    /// A progress callback that emits at most a few times a second.
    fn prepare_progress<'a>(&'a self, component: &'a str) -> impl Fn(u64, u64) + 'a {
        let last = Mutex::new(Instant::now() - PROGRESS_EVERY);
        move |received, total| {
            let mut l = last.lock().unwrap();
            if l.elapsed() >= PROGRESS_EVERY || received >= total {
                *l = Instant::now();
                self.emit_prepare(component, received, total);
            }
        }
    }

    pub async fn prepare(&self) -> Result<(), String> {
        let Some(_) = self.target else {
            return Err(format!("unsupported: {}", unsupported_reason(std::env::consts::OS, std::env::consts::ARCH)));
        };
        let _one = self.prepare_lock.lock().await;
        // Node.
        if self.runtime.ready_node().await.is_none() {
            self.runtime_setting_up.store(true, Ordering::SeqCst);
            *self.runtime_failed.lock().unwrap() = None;
            let total = self.runtime.download_bytes();
            let rt = self.runtime.clone();
            let task = tokio::spawn(async move { rt.ensure().await });
            let progress = self.prepare_progress("runtime");
            while !task.is_finished() {
                let p = self.runtime.status().progress.unwrap_or(0.0);
                progress((p * total as f64) as u64, total);
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            let result = task.await.map_err(|e| e.to_string()).and_then(|r| r);
            self.runtime_setting_up.store(false, Ordering::SeqCst);
            match result {
                Ok(_) => self.emit_prepare("runtime", total, total),
                Err(e) => {
                    let message = format!("Node could not be set up: {}", e.trim_start_matches("couldn't set up the local agent runtime: "));
                    *self.runtime_failed.lock().unwrap() = Some(message.clone());
                    return Err(format!("download: {message}"));
                }
            }
        }
        // Chrome.
        self.chrome.ensure(self.prepare_progress("chrome")).await.map_err(|e| format!("download: {e}"))?;
        // FFmpeg.
        if self.ffmpeg.unavailable() {
            return Err("ffmpeg-unavailable: FFmpeg is not available for this version yet.".into());
        }
        if !self.ffmpeg.is_dev_override() {
            self.ffmpeg.ensure(self.prepare_progress("ffmpeg")).await.map_err(|e| format!("download: {e}"))?;
        }
        Ok(())
    }

    // ---- the runner ---------------------------------------------------------------------------

    /// Everything the runner needs, if it is all here and checked.
    async fn files(&self) -> Result<RunnerFiles, String> {
        if self.target.is_none() {
            return Err(format!("unsupported: {}", unsupported_reason(std::env::consts::OS, std::env::consts::ARCH)));
        }
        let dir = self.runner_dir.clone().ok_or("not-ready: This copy of the app does not include the Studio's exporter.")?;
        let node = self.runtime.ready_node().await.ok_or("not-ready: Node is not set up yet.")?;
        let chrome = self.chrome.ready().await.ok_or("not-ready: The headless browser is not set up yet.")?;
        let ffmpeg = self.ffmpeg.ready().await.ok_or("not-ready: FFmpeg is not set up yet.")?;
        let get = |m: &HashMap<String, PathBuf>, k: &str| m.get(k).cloned().ok_or_else(|| format!("not-ready: {k} is missing"));
        Ok(RunnerFiles {
            node,
            runner: dir.join("runner").join("runner.cjs"),
            bundle: dir.join("render-bundle"),
            chrome: get(&chrome, "chrome")?,
            ffmpeg: get(&ffmpeg, "ffmpeg")?,
            ffprobe: get(&ffmpeg, "ffprobe")?,
        })
    }

    /// A runner process in its work folder, its environment from nothing,
    /// on its leash; standard input piped when `stdin`.
    fn spawn(&self, node: &Path, args: Vec<std::ffi::OsString>, cwd: &Path, stdin: bool) -> Result<(tokio::process::Child, Arc<procs::Tree>), String> {
        let tmp = cwd.join("tmp");
        std::fs::create_dir_all(&tmp).map_err(|e| format!("work: can't create the work folder ({e})"))?;
        let env = runner::runner_env(std::env::consts::OS, |k| std::env::var(k).ok(), &tmp);
        let mut cmd = tokio::process::Command::new(node);
        cmd.no_console();
        cmd.args(args)
            .current_dir(cwd)
            .env_clear()
            .envs(env)
            .stdin(if stdin { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        cmd.process_group(0);
        #[cfg(windows)]
        let job = procs::job::Job::new().map_err(|e| format!("start: can't make a job object ({e})"))?;
        #[cfg_attr(not(windows), allow(unused_mut))]
        let mut child = cmd.spawn().map_err(|e| format!("start: can't start the exporter ({e})"))?;
        let pid = child.id().ok_or("start: the exporter exited at once")?;
        #[cfg(windows)]
        {
            let handle = child.raw_handle().ok_or("start: the exporter exited at once")?;
            if let Err(e) = job.assign(handle) {
                let _ = child.start_kill();
                return Err(format!("start: can't hold the exporter in a job object ({e})"));
            }
            Ok((child, Arc::new(procs::Tree::new(pid, Some(job)))))
        }
        #[cfg(not(windows))]
        Ok((child, Arc::new(procs::Tree::new(pid))))
    }

    fn probe_in_background(self: &Arc<Self>) {
        // Not beside an export (it probes for itself), and one at a time.
        if holds_updates() || self.probing.swap(true, Ordering::SeqCst) {
            return;
        }
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = me.probe().await;
            match result {
                Ok(found) => *me.encoder.lock().unwrap() = Some(found),
                Err(e) => {
                    crate::log_to_file(&format!("[studio-local] encoder probe: {}", me.scrub(None).apply(&e)));
                    // Tried again at the next status.
                    me.probing.store(false, Ordering::SeqCst);
                }
            }
        });
    }

    /// Which encoder works here (the runner's `--probe`): (label, works).
    async fn probe(&self) -> Result<(String, bool), String> {
        let files = self.files().await?;
        let work = self.work().join("probe");
        let (mut child, tree) = self.spawn(&files.node, runner::probe_args(std::env::consts::OS, &files, &work), &self.work(), false)?;
        let stdout = child.stdout.take().ok_or("no output")?;
        let read = async {
            let mut lines = BufReader::new(stdout).lines();
            let mut found = None;
            while let Ok(Some(line)) = lines.next_line().await {
                match runner::parse_line(&line) {
                    Some(RunnerEvent::Encoder { profile, rung }) => found = Some((runner::encoder_label(&profile, rung.as_deref()), rung.is_some())),
                    Some(RunnerEvent::Failed { error, .. }) => return Err(error),
                    _ => {}
                }
            }
            found.ok_or_else(|| "the probe said nothing".to_string())
        };
        let result = match tokio::time::timeout(PROBE_TIMEOUT, read).await {
            Ok(r) => r,
            Err(_) => Err("the probe took too long".into()),
        };
        tree.kill();
        let _ = child.wait().await;
        tree.sweep();
        result
    }

    /// Start an export of `job_id` into the claimed destination.
    pub async fn start(self: &Arc<Self>, job_id: String, token: String, claim: Claim, upload: bool) -> Result<(), String> {
        let files = self.files().await?;
        // The slot is taken before anything slow: one export at a time.
        if self.current.lock().unwrap().is_some() || EXPORT_RUNNING.swap(true, Ordering::SeqCst) {
            return Err("busy: An export is already running on this computer.".into());
        }
        // Set before this check, as an install sets its own before checking ours.
        if crate::app_update::replacing() {
            EXPORT_RUNNING.store(false, Ordering::SeqCst);
            return Err("updating: The app is installing an update. Export once it has restarted.".into());
        }
        let started = self.launch(&job_id, &token, &files, &claim, upload).await;
        match started {
            Ok((child, tree)) => {
                let running = Running {
                    job_id: job_id.clone(),
                    tree: tree.clone(),
                    stop: Arc::new(Notify::new()),
                    reason: Arc::new(Mutex::new(None)),
                    finished: Arc::new(Notify::new()),
                };
                let (stop, reason, finished) = (running.stop.clone(), running.reason.clone(), running.finished.clone());
                *self.current.lock().unwrap() = Some(running);
                let me = self.clone();
                let scrub = self.scrub(Some(token.clone()));
                let log_scrub = self.scrub(Some(token));
                tauri::async_runtime::spawn(async move {
                    me.own(job_id, child, tree, claim, upload, scrub, log_scrub, stop, reason).await;
                    finished.notify_waiters();
                });
                Ok(())
            }
            Err(e) => {
                EXPORT_RUNNING.store(false, Ordering::SeqCst);
                Err(e)
            }
        }
    }

    async fn launch(&self, job_id: &str, token: &str, files: &RunnerFiles, claim: &Claim, upload: bool) -> Result<(tokio::process::Child, Arc<procs::Tree>), String> {
        destinations::checked_target(claim)?;
        let work = self.work();
        let out_dir = work.join("out");
        // What an earlier export left here goes (each export's own file only lives here).
        let _ = std::fs::remove_dir_all(&out_dir);
        sweep_kept(&work.join("kept"), KEEP_FOR);
        std::fs::create_dir_all(&out_dir).map_err(|e| format!("work: can't create the work folder ({e})"))?;
        let out = out_dir.join(format!("{job_id}.mp4"));
        let args = runner::export_args(std::env::consts::OS, files, crate::tray::api_base_url(), job_id, &out, &work, upload);
        let (mut child, tree) = self.spawn(&files.node, args, &work, true)?;
        // The token, on standard input only; then it closes.
        let written = async {
            let mut stdin = child.stdin.take().ok_or("no standard input")?;
            stdin.write_all(format!("{token}\n").as_bytes()).await.map_err(|e| e.to_string())?;
            stdin.shutdown().await.map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        }
        .await;
        if let Err(e) = written {
            tree.kill();
            let _ = child.wait().await;
            return Err(format!("start: the exporter did not take its token ({e})"));
        }
        crate::log_to_file(&format!("[studio-local] export {job_id}: started (pid {})", tree.pid));
        Ok((child, tree))
    }

    fn event(&self, job_id: &str, kind: Kind, progress: Option<f64>, message: Option<String>, saved_name: Option<String>) -> ExportEvent {
        let e = self.events.lock().unwrap().push(job_id, kind, progress, message, saved_name);
        let _ = self.app.emit(PROGRESS_EVENT, &e);
        e
    }

    pub fn events_since(&self, job_id: &str, since: u64) -> Vec<ExportEvent> {
        self.events.lock().unwrap().since(job_id, since)
    }

    /// The export's owner: reads its output, keeps the page told, stops it
    /// when asked, puts the video in place (its own task, so the page keeps
    /// hearing and a stop is served while a big copy runs), and cleans up
    /// however it ends. What is said is [`RunState`]'s.
    #[allow(clippy::too_many_arguments)]
    async fn own(
        self: Arc<Self>,
        job_id: String,
        mut child: tokio::process::Child,
        tree: Arc<procs::Tree>,
        claim: Claim,
        upload: bool,
        scrub: Scrub,
        log_scrub: Scrub,
        stop: Arc<Notify>,
        reason: Arc<Mutex<Option<Stop>>>,
    ) {
        let _awake = crate::sleep_guard::SleepGuard::new();
        let out = self.work().join("out").join(format!("{job_id}.mp4"));
        let stderr = child.stderr.take();
        let tag = job_id.clone();
        let stderr_task = tauri::async_runtime::spawn(async move {
            let Some(stderr) = stderr else { return };
            let mut lines = BufReader::new(stderr).lines();
            let mut n = 0u32;
            while let Ok(Some(line)) = lines.next_line().await {
                n += 1;
                if n <= 400 {
                    crate::log_to_file(&format!("[studio-local:{tag}] {}", log_scrub.apply(&line)));
                }
            }
        });
        let mut lines = child.stdout.take().map(|s| BufReader::new(s).lines());
        let mut lines_done = lines.is_none();
        let mut state = RunState::new(upload);
        let mut last_progress = 0.0f64;
        let mut last_emit = Instant::now();
        let mut last_refresh = Instant::now();
        let mut kill_at: Option<Instant> = None;
        let mut exited = false;
        let place_cancel = Arc::new(AtomicBool::new(false));
        let mut placing: Option<tokio::task::JoinHandle<Result<PathBuf, String>>> = None;
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        let started = self.events.lock().unwrap().begin(&job_id);
        let _ = self.app.emit(PROGRESS_EVENT, &started);

        let start_placing = |placing: &mut Option<tokio::task::JoinHandle<Result<PathBuf, String>>>| {
            let (src, c, flag) = (out.clone(), claim.clone(), place_cancel.clone());
            *placing = Some(tokio::task::spawn_blocking(move || destinations::place_file(&src, &c, &flag)));
        };

        loop {
            if lines_done && placing.is_none() {
                break;
            }
            tokio::select! {
                line = async { match lines.as_mut() { Some(l) => l.next_line().await, None => Ok(None) } }, if !lines_done => {
                    let Ok(Some(line)) = line else { lines_done = true; continue };
                    let Some(ev) = runner::parse_line(&line) else { continue };
                    match ev {
                        RunnerEvent::Taken { .. } => {}
                        RunnerEvent::Progress { progress } => {
                            let p = if progress.is_finite() { progress.clamp(0.0, 1.0) } else { last_progress };
                            last_progress = p;
                            if state.saved.is_none() && (last_emit.elapsed() >= PROGRESS_EVERY || p >= 1.0) {
                                last_emit = Instant::now();
                                self.event(&job_id, Kind::Progress, Some(p), None, None);
                            }
                        }
                        RunnerEvent::Log { line } => {
                            let line = scrub.apply(&line);
                            if state.on_log(&line) {
                                last_emit = Instant::now();
                                self.event(&job_id, Kind::Log, None, Some(line), None);
                            }
                        }
                        RunnerEvent::Encoder { profile, rung } => {
                            let label = runner::encoder_label(&scrub.apply(&profile), rung.as_deref().map(|r| scrub.apply(r)).as_deref());
                            *self.encoder.lock().unwrap() = Some((label.clone(), rung.is_some()));
                            last_emit = Instant::now();
                            self.event(&job_id, Kind::Encoder, None, Some(label), None);
                        }
                        RunnerEvent::Saved { file, .. } => {
                            if state.saved.is_none() && placing.is_none() && state.place_failed.is_none() && Path::new(&file) == out {
                                start_placing(&mut placing);
                            }
                        }
                        RunnerEvent::Done { uploaded } => {
                            for (k, m, n) in state.on_done(uploaded) {
                                self.event(&job_id, k, None, m, n);
                            }
                            // A runner from before its `saved` event: the file is in place now.
                            if state.saved.is_none() && placing.is_none() && state.place_failed.is_none() && out.is_file() {
                                start_placing(&mut placing);
                            }
                            last_emit = Instant::now();
                        }
                        RunnerEvent::Failed { error, cancelled, code } => {
                            if state.on_failed(&scrub.apply(&error), cancelled, code.as_deref()) {
                                // Finished on the server, or elsewhere: stop now, quietly, the move too.
                                *reason.lock().unwrap() = Some(Stop::TakenBack);
                                place_cancel.store(true, Ordering::SeqCst);
                                tree.kill();
                            }
                        }
                    }
                }
                placed = async { placing.as_mut().expect("guarded").await }, if placing.is_some() => {
                    placing = None;
                    match placed.unwrap_or_else(|e| Err(format!("write: {e}"))) {
                        Ok(path) => {
                            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| claim.name.clone());
                            self.destinations.release(&claim.id, true);
                            for (k, m, n) in state.on_saved(&name) {
                                self.event(&job_id, k, Some(1.0).filter(|_| k == Kind::Done), m, n);
                            }
                        }
                        // Stopped while copying: the stop's own word ends the run.
                        Err(e) if e.starts_with("cancelled:") => {}
                        Err(e) => {
                            let why = e.split_once(": ").map(|(_, m)| m.to_string()).unwrap_or(e);
                            state.on_place_failed(&claim.name, &why);
                        }
                    }
                    last_emit = Instant::now();
                }
                _ = stop.notified() => {
                    place_cancel.store(true, Ordering::SeqCst);
                    match *reason.lock().unwrap() {
                        Some(Stop::TakenBack) => tree.kill(),
                        Some(Stop::Quit) => { tree.terminate(); kill_at = Some(Instant::now() + Duration::from_secs(2)); }
                        _ => { tree.terminate(); kill_at.get_or_insert(Instant::now() + CANCEL_GRACE); }
                    }
                }
                _ = tick.tick() => {
                    if !exited && matches!(child.try_wait(), Ok(Some(_))) {
                        exited = true;
                    }
                    if !exited && last_refresh.elapsed() >= Duration::from_secs(2) {
                        last_refresh = Instant::now();
                        tree.refresh();
                    }
                    if kill_at.is_some_and(|t| Instant::now() >= t) {
                        kill_at = None;
                        tree.kill();
                    }
                    // Still working (the runner, or the move): say so, even with nothing new to say.
                    if last_emit.elapsed() >= HEARTBEAT && (!exited || placing.is_some()) {
                        last_emit = Instant::now();
                        self.event(&job_id, Kind::Progress, Some(if state.saved.is_some() { 1.0 } else { last_progress }), None, None);
                    }
                }
            }
        }

        // Its output closed and the move settled: it is ending, or ended.
        let code = match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
            Ok(Ok(status)) => status.code(),
            _ => {
                tree.kill();
                child.wait().await.ok().and_then(|s| s.code())
            }
        };
        tree.sweep();
        let _ = stderr_task.await;
        let stopped = reason.lock().unwrap().is_some();
        // A finished video not in place yet is kept, never removed before the person has it: moved to its kept place
        // before the last word is said, so "save it again" (`save_again`) finds it the moment the page hears.
        if state.saved.is_none() && out.is_file() && (state.runner_done || state.place_failed.is_some()) {
            let kept = self.kept(&job_id);
            let _ = std::fs::create_dir_all(kept.parent().unwrap_or(&kept));
            if let Err(e) = std::fs::rename(&out, &kept) {
                crate::log_to_file(&format!("[studio-local] export {job_id}: could not keep the video ({e}); it stays in the work folder"));
            }
        }
        if let Some((kind, message)) = state.final_event(stopped, code) {
            self.event(&job_id, kind, None, Some(message), None);
        }
        crate::log_to_file(&format!("[studio-local] export {job_id}: ended (exit {code:?}, saved {})", state.saved.is_some()));
        if state.saved.is_none() {
            self.destinations.release(&claim.id, false);
        }
        if !out.is_file() {
            let _ = std::fs::remove_dir_all(self.work().join("out"));
        }
        *self.current.lock().unwrap() = None;
        EXPORT_RUNNING.store(false, Ordering::SeqCst);
    }

    /// Save a finished export kept on this computer (its move into place
    /// failed) into a newly picked destination.
    pub async fn save_again(&self, job_id: &str, claim: Claim) -> Result<String, String> {
        let kept = self.kept(job_id);
        if !std::fs::symlink_metadata(&kept).is_ok_and(|m| m.is_file()) {
            return Err("gone: That video is not kept on this computer any more. Export it again.".into());
        }
        let c = claim.clone();
        let placed = tokio::task::spawn_blocking(move || destinations::place_file(&kept, &c, &AtomicBool::new(false)))
            .await
            .unwrap_or_else(|e| Err(format!("write: {e}")))?;
        let name = placed.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(claim.name);
        // Said as `done`, after the run's `save-failed`: a page that reloads then reads the export as saved.
        self.event(job_id, Kind::Done, None, Some(format!("Saved to {name}")), Some(name.clone()));
        Ok(name)
    }

    /// Stop `job_id` if it is the export running (else nothing: idempotent).
    pub fn cancel(&self, job_id: &str) {
        if let Some(r) = self.current.lock().unwrap().as_ref().filter(|r| r.job_id == job_id) {
            r.reason.lock().unwrap().get_or_insert(Stop::Cancel);
            r.stop.notify_one();
        }
    }

    /// App quit: the export stops, its whole tree with it, within ~3 s; saves
    /// of part links stop and their temp files go.
    pub async fn shutdown(&self) {
        let saves: Vec<SaveRun> = self.saves.lock().unwrap().values().cloned().collect();
        for run in &saves {
            run.cancel.store(true, Ordering::SeqCst);
        }
        let saves_done = async {
            for _ in 0..30 {
                if self.saves.lock().unwrap().is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            for run in &saves {
                if let Some(temp) = run.temp.lock().unwrap().take() {
                    let _ = std::fs::remove_file(temp);
                }
            }
        };
        tokio::join!(saves_done, self.shutdown_export());
    }

    async fn shutdown_export(&self) {
        let (tree, finished, stop) = {
            let current = self.current.lock().unwrap();
            let Some(r) = current.as_ref() else { return };
            *r.reason.lock().unwrap() = Some(Stop::Quit);
            (r.tree.clone(), r.finished.clone(), r.stop.clone())
        };
        let done = finished.notified();
        tokio::pin!(done);
        done.as_mut().enable();
        stop.notify_one();
        if tokio::time::timeout(Duration::from_millis(2500), done).await.is_err() {
            tree.kill();
        }
        tree.sweep();
    }

    /// Show a saved file in Finder or Explorer.
    pub fn reveal(&self, destination_id: &str) -> Result<(), String> {
        if !destinations::valid_id(destination_id) {
            return Err("bad-request: not a destination id".into());
        }
        let path = self
            .destinations
            .written_file(destination_id)
            .ok_or("unknown-destination: The app did not save a file there.")?;
        if !path.is_file() {
            return Err("gone: The saved file is not there any more.".into());
        }
        tauri_plugin_opener::reveal_item_in_dir(plain_path(&path)).map_err(|e| format!("reveal: {e}"))
    }

    /// `studio_export_pick_destination`'s dialog flag.
    pub(crate) fn begin_pick(&self) -> Option<PickGuard<'_>> {
        (!self.picking.swap(true, Ordering::SeqCst)).then_some(PickGuard(&self.picking))
    }

}

pub(crate) struct PickGuard<'a>(&'a AtomicBool);

impl Drop for PickGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Remove kept videos older than `age` from `dir`.
fn sweep_kept(dir: &Path, age: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let old = e.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|d| d > age);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// A canonical Windows path without its `\\?\` prefix (Explorer's selection
/// takes the plain form); unchanged elsewhere.
fn plain_path(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => p.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_computers_get_a_sentence() {
        assert!(unsupported_reason("macos", "x86_64").contains("Apple silicon"));
        assert!(unsupported_reason("windows", "aarch64").contains("x64"));
        assert!(unsupported_reason("linux", "x86_64").contains("our server"));
    }

    #[test]
    fn plain_paths_for_explorer() {
        assert_eq!(plain_path(Path::new(r"\\?\C:\Users\p\a.mp4")), PathBuf::from(r"C:\Users\p\a.mp4"));
        assert_eq!(plain_path(Path::new(r"\\?\UNC\server\share\a.mp4")), PathBuf::from(r"\\?\UNC\server\share\a.mp4"));
        assert_eq!(plain_path(Path::new("/Users/p/a.mp4")), PathBuf::from("/Users/p/a.mp4"));
    }

    #[test]
    fn a_runner_bundle_needs_its_runner_and_manifest() {
        let dir = tempfile::tempdir().unwrap();
        assert!(runner_bundle(dir.path()).is_none());
        std::fs::create_dir_all(dir.path().join("runner")).unwrap();
        std::fs::create_dir_all(dir.path().join("render-bundle")).unwrap();
        std::fs::write(dir.path().join("runner/runner.cjs"), "").unwrap();
        assert!(runner_bundle(dir.path()).is_none());
        std::fs::write(dir.path().join("render-bundle").join(BUNDLE_MANIFEST), r#"{"renderVersion":"r42","remotion":"4.0.534"}"#).unwrap();
        assert!(runner_bundle(dir.path()).is_some());
        assert_eq!(render_version(dir.path()).as_deref(), Some("r42"));
    }

    #[test]
    fn status_serializes_as_the_page_reads_it() {
        let s = Status {
            available: false,
            reason: Some("why".into()),
            platform: "macos".into(),
            arch: "aarch64".into(),
            components: Components { runtime: State::Ready, chrome: State::Missing, ffmpeg: State::Downloading },
            download_bytes: 5,
            render_version: None,
            encoder: None,
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            serde_json::json!({
                "available": false, "reason": "why", "platform": "macos", "arch": "aarch64",
                "components": { "runtime": "ready", "chrome": "missing", "ffmpeg": "downloading" },
                "downloadBytes": 5, "renderVersion": null
            })
        );
    }
}
