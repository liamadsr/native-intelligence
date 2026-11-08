//! Per-module state machine and orchestration: persisted on/off setting,
//! model download → verify → warm-up, and the `module://status` event the web
//! renders from. One manager (Tauri-managed state) owns every module.
//!
//! ```text
//! off ──enable──▶ downloading ──▶ verifying ──▶ warming ──▶ ready
//!  ▲                 │ (error / cancelled)          │
//!  └──disable────────┴──────────── error ◀──────────┘
//! unavailable = this build has no sidecar binary for the module
//! at launch, assets on disk and warm: verifying (this run's hash) ──▶ ready
//! ```

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use super::assets;
use super::registry::{self, ModuleManifest, ModuleSpec};
use super::supervisor::Sidecar;

/// Warm-up compiles Metal kernels the first time a sidecar binary runs on a
/// machine — ~15 s measured on an M2 Max; allow plenty for slower Macs.
const WARMUP_TIMEOUT: Duration = Duration::from_secs(180);
const WARM_MARKER: &str = "warm.json";
/// Progress events per second, at most.
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModuleState {
    Off,
    Downloading,
    Verifying,
    Warming,
    Ready,
    Error,
    Unavailable,
}

/// The bridge-contract shape (`LocalModuleInfo` on the web side).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleInfo {
    pub id: String,
    pub version: String,
    pub enabled: bool,
    pub state: ModuleState,
    pub progress: Option<f64>,
    pub download_bytes: u64,
    pub assets_present: bool,
    pub error: Option<String>,
}

/// Everything a module adapter needs to launch its sidecar.
#[derive(Debug, Clone)]
pub struct LaunchConfig {
    pub exe: PathBuf,
    /// Asset name (from module.json) → absolute path.
    pub assets: HashMap<String, PathBuf>,
}

impl LaunchConfig {
    /// The `assets` object every module's `configure` message carries.
    pub fn assets_json(&self) -> serde_json::Value {
        let map: serde_json::Map<String, serde_json::Value> = self
            .assets
            .iter()
            .map(|(k, v)| (k.clone(), json!(v.to_string_lossy())))
            .collect();
        serde_json::Value::Object(map)
    }
}

struct Runtime {
    spec: &'static ModuleSpec,
    manifest: ModuleManifest,
    enabled: bool,
    state: ModuleState,
    progress: Option<f64>,
    error: Option<String>,
    /// Cancel flag of the in-flight download/warm-up job, if any.
    job: Option<Arc<AtomicBool>>,
}

pub struct ModuleManager {
    modules: Mutex<HashMap<&'static str, Runtime>>,
    client: reqwest::Client,
}

impl ModuleManager {
    pub fn new() -> Self {
        let modules = registry::MODULES
            .iter()
            .map(|spec| {
                (
                    spec.id,
                    Runtime {
                        spec,
                        manifest: spec.manifest(),
                        enabled: false,
                        state: ModuleState::Off,
                        progress: None,
                        error: None,
                        job: None,
                    },
                )
            })
            .collect();
        let client = reqwest::Client::builder()
            .user_agent(concat!("Dial8-Desktop/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_default();
        Self { modules: Mutex::new(modules), client }
    }

    /// Load persisted settings and bring enabled modules back up: straight to
    /// ready when assets + warm-up are current, otherwise resume the job (e.g.
    /// an app update bumped the assets version).
    pub fn init(&self, app: &AppHandle) {
        let ids: Vec<&'static str> = registry::MODULES.iter().map(|m| m.id).collect();
        for id in ids {
            let enabled = crate::settings::module_enabled(app, id);
            let needs_job = {
                let mut modules = self.modules.lock().unwrap();
                let rt = modules.get_mut(id).unwrap();
                rt.enabled = enabled;
                if rt.manifest.protocol != super::protocol::PROTOCOL_MAJOR {
                    // A module.json from a future protocol: never launch it.
                    rt.state = ModuleState::Unavailable;
                    rt.error = Some(format!("module protocol {} unsupported", rt.manifest.protocol));
                    false
                } else if let Some(min) = rt.manifest.min_macos.as_deref().filter(|m| !macos_at_least(m)) {
                    // e.g. ONNX Runtime (local-tts) needs 13.4; the app runs on
                    // 13.0. Never download or launch what can't load here.
                    rt.state = ModuleState::Unavailable;
                    rt.error = Some(format!("Needs macOS {min} or later"));
                    false
                } else if crate::sidecar::path(&rt.manifest.sidecar).is_none() {
                    rt.state = ModuleState::Unavailable;
                    crate::log_to_file(&format!(
                        "[modules] {} unavailable: sidecar {} missing from this build",
                        id, rt.manifest.sidecar
                    ));
                    false
                } else if !enabled {
                    rt.state = ModuleState::Off;
                    false
                } else if assets::all_verified(&assets_dir(app, &rt.manifest), &rt.manifest.assets)
                    && is_warm(app, &rt.manifest)
                {
                    // On disk and warm: ready once this run has hashed the
                    // files (recheck_in_background).
                    rt.state = ModuleState::Verifying;
                    false
                } else {
                    true
                }
            };
            // The state it starts in, and why when it can't run (module_log_tail).
            let (state, error) = {
                let modules = self.modules.lock().unwrap();
                let rt = modules.get(id).unwrap();
                (rt.state, rt.error.clone())
            };
            crate::log_to_file(&format!(
                "[modules] init {} enabled={} state={:?} needs_job={}{}",
                id,
                enabled,
                state,
                needs_job,
                error.map(|e| format!(" error={e}")).unwrap_or_default()
            ));
            if needs_job {
                self.start_job(app, id);
            } else if state == ModuleState::Verifying {
                self.recheck_in_background(app, id);
            }
        }
    }

    /// Hash a module's assets once this app run, off the main thread
    /// ([`assets::recheck`]), before it's ready: its verified.json is the
    /// user's to rewrite, so a file swapped while Native Intelligence was closed passes the
    /// stamp check. A mismatch runs the job, which hashes the files where
    /// they are and downloads again only one that fails. ~0.35 s for
    /// local-stt; auto-record waits far longer (the main page's load, then
    /// the HUD's countdown), and a use meanwhile finds the module not ready.
    fn recheck_in_background(&self, app: &AppHandle, id: &'static str) {
        let manifest = self.modules.lock().unwrap().get(id).unwrap().manifest.clone();
        let dir = assets_dir(app, &manifest);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let started = Instant::now();
            let ok = tokio::task::spawn_blocking(move || assets::recheck(&dir, &manifest.assets)).await.unwrap_or(false);
            crate::log_to_file(&format!(
                "[modules] {id} assets re-checked: {} ({:.2}s)",
                if ok { "ok" } else { "changed" },
                started.elapsed().as_secs_f64()
            ));
            app.state::<ModuleManager>().finish_recheck(&app, id, ok);
        });
    }

    /// The re-check came back: ready, or the job.
    fn finish_recheck(&self, app: &AppHandle, id: &'static str, ok: bool) {
        let next = {
            let mut modules = self.modules.lock().unwrap();
            let Some(rt) = modules.get_mut(id) else { return };
            let next = after_recheck(rt.enabled, rt.state, rt.job.is_some(), ok);
            if next == Some(AfterRecheck::Ready) {
                rt.state = ModuleState::Ready;
            }
            next
        };
        match next {
            Some(AfterRecheck::Ready) => self.emit(app, id),
            Some(AfterRecheck::Job) => self.start_job(app, id),
            None => {}
        }
    }

    /// Run the job again for a module that is ready (not one a person
    /// turned off meanwhile, or whose job is already running).
    fn restart_if_ready(&self, app: &AppHandle, id: &'static str) {
        let ready = self.modules.lock().unwrap().get(id).is_some_and(|rt| rt.enabled && rt.state == ModuleState::Ready);
        if ready {
            self.start_job(app, id);
        }
    }

    pub fn list(&self, app: &AppHandle) -> Vec<ModuleInfo> {
        let modules = self.modules.lock().unwrap();
        registry::MODULES
            .iter()
            .filter_map(|spec| modules.get(spec.id).map(|rt| info_of(app, rt)))
            .collect()
    }

    pub fn info(&self, app: &AppHandle, id: &str) -> Option<ModuleInfo> {
        self.modules.lock().unwrap().get(id).map(|rt| info_of(app, rt))
    }

    pub fn enable(&self, app: &AppHandle, id: &str) -> Result<ModuleInfo, String> {
        let id = registry::find(id).ok_or_else(|| format!("unknown module {id}"))?.id;
        let start = {
            let mut modules = self.modules.lock().unwrap();
            let rt = modules.get_mut(id).ok_or_else(|| format!("unknown module {id}"))?;
            rt.enabled = true;
            crate::settings::set_module_enabled(app, id, true);
            matches!(rt.state, ModuleState::Off | ModuleState::Error)
        };
        if start {
            self.start_job(app, id);
        }
        self.emit(app, id);
        Ok(self.info(app, id).unwrap())
    }

    pub fn disable(&self, app: &AppHandle, id: &str) -> Result<ModuleInfo, String> {
        {
            let mut modules = self.modules.lock().unwrap();
            let rt = modules.get_mut(id).ok_or_else(|| format!("unknown module {id}"))?;
            rt.enabled = false;
            crate::settings::set_module_enabled(app, id, false);
            if let Some(cancel) = rt.job.take() {
                cancel.store(true, Ordering::SeqCst);
            }
            rt.progress = None;
            // Unavailable keeps its reason (e.g. "Needs macOS 13.4 or later").
            if rt.state != ModuleState::Unavailable {
                rt.state = ModuleState::Off;
                rt.error = None;
            }
        }
        // A long-lived sidecar (local-tts) must not outlive its module; this
        // also covers remove_assets, which disables first.
        if id == super::tts::MODULE_ID {
            if let Some(tts) = app.try_state::<super::tts::TtsService>() {
                tts.stop();
            }
        }
        self.emit(app, id);
        Ok(self.info(app, id).unwrap())
    }

    pub fn remove_assets(&self, app: &AppHandle, id: &str) -> Result<ModuleInfo, String> {
        self.disable(app, id)?;
        let root = module_root(app, id);
        if root.exists() {
            std::fs::remove_dir_all(&root).map_err(|e| format!("could not remove {}: {e}", root.display()))?;
            crate::log_to_file(&format!("[modules] removed assets for {}", id));
        }
        self.emit(app, id);
        Ok(self.info(app, id).unwrap())
    }

    /// The module's current state (cheap: no disk access), `None` if unknown.
    pub fn state(&self, id: &str) -> Option<ModuleState> {
        self.modules.lock().unwrap().get(id).map(|rt| rt.state)
    }

    /// Launch parameters when the module is ready to serve, else `None`.
    /// Its assets must be the files this run hashed (a few `stat`s,
    /// [`assets::checked_this_run`]): one that changed on disk since makes it
    /// not ready, and runs the job, which hashes it where it is (and
    /// downloads it again if it fails).
    pub fn launch_config(&self, app: &AppHandle, id: &str) -> Option<LaunchConfig> {
        let changed = {
            let modules = self.modules.lock().unwrap();
            let rt = modules.get(id)?;
            let dir = assets_dir(app, &rt.manifest);
            match launch_decision(rt.enabled, rt.state, || assets::checked_this_run(&dir, &rt.manifest.assets)) {
                Launch::Go => return launch_config_of(app, &rt.manifest),
                Launch::NotReady => return None,
                Launch::Changed => rt.spec.id,
            }
        };
        crate::log_to_file(&format!("[modules] {changed} assets changed on disk: checking them again"));
        self.restart_if_ready(app, changed);
        None
    }

    fn start_job(&self, app: &AppHandle, id: &'static str) {
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut modules = self.modules.lock().unwrap();
            let rt = modules.get_mut(id).unwrap();
            if let Some(previous) = rt.job.replace(cancel.clone()) {
                previous.store(true, Ordering::SeqCst);
            }
            rt.state = ModuleState::Downloading;
            rt.progress = Some(0.0);
            rt.error = None;
        }
        self.emit(app, id);

        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let result = run_job(&app, id, cancel.clone()).await;
            let manager = app.state::<ModuleManager>();
            {
                let mut modules = manager.modules.lock().unwrap();
                let rt = modules.get_mut(id).unwrap();
                // A newer job or a disable superseded this one: leave state alone.
                let current = rt.job.as_ref().map(|j| Arc::ptr_eq(j, &cancel)).unwrap_or(false);
                if !current {
                    return;
                }
                rt.job = None;
                rt.progress = None;
                match result {
                    Ok(()) => {
                        rt.state = ModuleState::Ready;
                        rt.error = None;
                    }
                    Err(e) => {
                        crate::log_to_file(&format!("[modules] {} job failed: {}", id, e));
                        rt.state = ModuleState::Error;
                        rt.error = Some(e);
                    }
                }
            }
            manager.emit(&app, id);
        });
    }

    /// Update the phase of job `job`. A superseded or cancelled job (disable
    /// takes `rt.job` under this same lock) is ignored, so a late progress
    /// callback can never overwrite `off`.
    fn set_phase(&self, app: &AppHandle, id: &str, job: &Arc<AtomicBool>, state: ModuleState, progress: Option<f64>) {
        {
            let mut modules = self.modules.lock().unwrap();
            let Some(rt) = modules.get_mut(id) else { return };
            if !rt.job.as_ref().map(|j| Arc::ptr_eq(j, job)).unwrap_or(false) {
                return;
            }
            rt.state = state;
            rt.progress = progress;
        }
        self.emit(app, id);
    }

    fn emit(&self, app: &AppHandle, id: &str) {
        if let Some(info) = self.info(app, id) {
            let _ = app.emit("module://status", info);
        }
    }
}

async fn run_job(app: &AppHandle, id: &'static str, cancel: Arc<AtomicBool>) -> Result<(), String> {
    let manager = app.state::<ModuleManager>();
    let (manifest, client) = {
        let modules = manager.modules.lock().unwrap();
        (modules.get(id).unwrap().manifest.clone(), manager.client.clone())
    };
    let dir = assets_dir(app, &manifest);

    // 1. Download + verify (each file is hashed as it completes).
    let last_emit = Mutex::new(Instant::now() - PROGRESS_EMIT_INTERVAL);
    assets::download_all(&client, &dir, &manifest.assets, cancel.clone(), |progress| {
        let (state, done, total) = match progress {
            assets::Progress::Downloading { done, total } => (ModuleState::Downloading, done, total),
            assets::Progress::Verifying { done, total } => (ModuleState::Verifying, done, total),
        };
        let fraction = if total == 0 { 1.0 } else { done as f64 / total as f64 };
        let mut last = last_emit.lock().unwrap();
        if state == ModuleState::Verifying || last.elapsed() >= PROGRESS_EMIT_INTERVAL {
            *last = Instant::now();
            manager.set_phase(app, id, &cancel, state, Some(fraction));
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    assets::gc_other_versions(&module_root(app, id), &manifest.assets_version);

    if cancel.load(Ordering::SeqCst) {
        return Err("cancelled".into());
    }

    // 2. Warm up: load the models once so the first real session starts fast
    //    (first run of a sidecar binary compiles its GPU kernels).
    if !is_warm(app, &manifest) {
        manager.set_phase(app, id, &cancel, ModuleState::Warming, None);
        let launch = launch_config_of(app, &manifest).ok_or("sidecar binary missing")?;
        warm_up(id, &launch, &cancel).await?;
        mark_warm(app, &manifest);
    }
    Ok(())
}

/// Start the sidecar in warm-up mode, wait for `ready`, then close its stdin
/// so it exits. A disable (the job's cancel flag) abandons it immediately.
async fn warm_up(id: &str, launch: &LaunchConfig, cancel: &Arc<AtomicBool>) -> Result<(), String> {
    let started = Instant::now();
    let Sidecar { mut link, process } = Sidecar::spawn(id, &launch.exe, &[]).map_err(|e| e.to_string())?;
    let configure = json!({ "assets": launch.assets_json(), "warmup": true });
    let cancelled = async {
        while !cancel.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    };
    let result = tokio::select! {
        r = link.handshake(id, configure, WARMUP_TIMEOUT) => Some(r),
        _ = cancelled => None,
    };
    drop(link); // closes stdin → the sidecar exits
    process.reap(Duration::from_secs(10)).await;
    let hello = match result {
        None => return Err("cancelled".into()),
        Some(r) => r.map_err(|e| e.to_string())?,
    };
    crate::log_to_file(&format!(
        "[modules] {} warmed up in {:.1}s (sidecar {} v{}, protocol {})",
        id,
        started.elapsed().as_secs_f64(),
        hello.module,
        hello.version,
        hello.protocol
    ));
    Ok(())
}

/// What a finished re-check leads to: nothing when a disable or a job came
/// in meanwhile (they decide), else ready, or the job on a mismatch.
#[derive(Debug, PartialEq, Eq)]
enum AfterRecheck {
    Ready,
    Job,
}

fn after_recheck(enabled: bool, state: ModuleState, job_running: bool, ok: bool) -> Option<AfterRecheck> {
    if !enabled || state != ModuleState::Verifying || job_running {
        return None;
    }
    Some(if ok { AfterRecheck::Ready } else { AfterRecheck::Job })
}

#[derive(Debug, PartialEq, Eq)]
enum Launch {
    Go,
    NotReady,
    /// Ready, but an asset isn't the file this run hashed.
    Changed,
}

/// Whether a module launches: enabled, ready (so this run has hashed its
/// assets), and its assets still those files.
fn launch_decision(enabled: bool, state: ModuleState, checked_this_run: impl FnOnce() -> bool) -> Launch {
    if !enabled || state != ModuleState::Ready {
        Launch::NotReady
    } else if checked_this_run() {
        Launch::Go
    } else {
        Launch::Changed
    }
}

/// The running macOS version ("13.4.1"), from `kern.osproductversion`.
fn macos_version() -> Option<String> {
    crate::sysctl::string(c"kern.osproductversion")
}

/// Whether this Mac runs at least macOS `min`. Unknown versions pass: the
/// gate is for known-old systems, not a reason to break an unreadable one.
fn macos_at_least(min: &str) -> bool {
    match macos_version() {
        Some(os) => version_at_least(&os, min),
        None => true,
    }
}

/// Dotted-version comparison: "13.4" ≥ "13.4", "13.10" > "13.4", "13" = "13.0".
/// An unparseable `min` never blocks.
fn version_at_least(version: &str, min: &str) -> bool {
    fn parts(v: &str) -> Option<Vec<u32>> {
        v.trim().split('.').map(|p| p.parse().ok()).collect()
    }
    let (Some(mut have), Some(mut need)) = (parts(version), parts(min)) else {
        return parts(min).is_none();
    };
    let n = have.len().max(need.len());
    have.resize(n, 0);
    need.resize(n, 0);
    have >= need
}

fn info_of(app: &AppHandle, rt: &Runtime) -> ModuleInfo {
    let dir = assets_dir(app, &rt.manifest);
    ModuleInfo {
        id: rt.spec.id.to_string(),
        version: rt.manifest.assets_version.clone(),
        enabled: rt.enabled,
        state: rt.state,
        progress: rt.progress,
        download_bytes: assets::total_bytes(&rt.manifest.assets),
        assets_present: assets::all_verified(&dir, &rt.manifest.assets),
        error: rt.error.clone(),
    }
}

fn launch_config_of(app: &AppHandle, manifest: &ModuleManifest) -> Option<LaunchConfig> {
    let exe = crate::sidecar::path(&manifest.sidecar)?;
    let dir = assets_dir(app, manifest);
    let assets = manifest
        .assets
        .iter()
        .map(|a| (a.name.clone(), dir.join(&a.file)))
        .collect();
    Some(LaunchConfig { exe, assets })
}

fn module_root(app: &AppHandle, id: &str) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("dial8"))
        .join("modules")
        .join(id)
}

fn assets_dir(app: &AppHandle, manifest: &ModuleManifest) -> PathBuf {
    module_root(app, &manifest.id).join(&manifest.assets_version)
}

/// Identity of the sidecar binary that last warmed up against these assets.
/// A new app build ships a new binary → warm up again.
fn binary_fingerprint(manifest: &ModuleManifest) -> Option<serde_json::Value> {
    let exe = crate::sidecar::path(&manifest.sidecar)?;
    let meta = std::fs::metadata(&exe).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some(json!({ "size": meta.len(), "mtime": mtime }))
}

fn is_warm(app: &AppHandle, manifest: &ModuleManifest) -> bool {
    let marker = assets_dir(app, manifest).join(WARM_MARKER);
    let stored: Option<serde_json::Value> =
        std::fs::read(marker).ok().and_then(|b| serde_json::from_slice(&b).ok());
    stored.is_some() && stored == binary_fingerprint(manifest)
}

fn mark_warm(app: &AppHandle, manifest: &ModuleManifest) {
    if let Some(fingerprint) = binary_fingerprint(manifest) {
        let _ = std::fs::write(
            assets_dir(app, manifest).join(WARM_MARKER),
            serde_json::to_vec(&fingerprint).unwrap_or_default(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Until this run's re-check is done the module is Verifying, which never
    /// launches, whatever verified.json says.
    #[test]
    fn nothing_launches_before_this_runs_hash() {
        for state in [ModuleState::Verifying, ModuleState::Downloading, ModuleState::Warming, ModuleState::Off] {
            assert_eq!(launch_decision(true, state, || true), Launch::NotReady, "{state:?}");
        }
        assert_eq!(launch_decision(false, ModuleState::Ready, || true), Launch::NotReady);
        assert_eq!(launch_decision(true, ModuleState::Ready, || true), Launch::Go);
        assert_eq!(launch_decision(true, ModuleState::Ready, || false), Launch::Changed);
    }

    #[test]
    fn a_finished_recheck_makes_it_ready_or_runs_the_job() {
        assert_eq!(after_recheck(true, ModuleState::Verifying, false, true), Some(AfterRecheck::Ready));
        assert_eq!(after_recheck(true, ModuleState::Verifying, false, false), Some(AfterRecheck::Job));
        // Turned off, or turned on again (its job runs), while it hashed.
        assert_eq!(after_recheck(false, ModuleState::Off, false, true), None);
        assert_eq!(after_recheck(true, ModuleState::Downloading, true, true), None);
        assert_eq!(after_recheck(true, ModuleState::Verifying, true, false), None);
    }

    #[test]
    fn version_comparison() {
        assert!(version_at_least("13.4", "13.4"));
        assert!(version_at_least("13.4.1", "13.4"));
        assert!(version_at_least("13.10", "13.4"), "numeric, not lexical");
        assert!(version_at_least("14.0", "13.4"));
        assert!(version_at_least("26.0.1", "13.4"));
        assert!(!version_at_least("13.3.1", "13.4"));
        assert!(!version_at_least("13.0", "13.4"));
        assert!(!version_at_least("13", "13.4"));
        assert!(version_at_least("13", "13.0"), "missing parts are zero");
        assert!(!version_at_least("12.7.6", "13.4"));
        // Unreadable input never blocks a module by accident...
        assert!(version_at_least("13.4", "garbage"));
        // ...but an unreadable OS version against a real floor does not pass
        // (macos_at_least treats an unknown OS as passing before this).
        assert!(!version_at_least("", "13.4"));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn this_mac_reports_its_version() {
        let v = macos_version().expect("kern.osproductversion");
        assert!(v.split('.').all(|p| p.parse::<u32>().is_ok()), "{v:?}");
        // The dev and CI Macs are all newer than local-tts's floor.
        assert!(macos_at_least("13.4"), "{v}");
        assert!(!macos_at_least("999.0"));
    }
}
