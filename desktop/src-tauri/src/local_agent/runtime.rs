//! The Node the packaged local agent runs on (web
//! docs/plans/local-agents.md, Packaging).
//!
//! The agent's JS ships inside the signed app; Node doesn't (~120 MB, and
//! most people never share a folder). It is downloaded on first use from
//! nodejs.org, pinned in `runtime.json` (compiled in, so the app only ever
//! runs the Node it was released with), into
//! `<app_data>/local-agent/runtime/<version>/`:
//! - the tarball comes through the local modules' downloader
//!   ([`assets::download_all`]: resumable, checked against the pinned
//!   SHA-256, disk space checked first);
//! - only `<prefix>/bin/node` and `<prefix>/LICENSE` are unpacked from it
//!   (`/usr/bin/tar`), into `node.tmp/`;
//! - the binary is checked against its own pinned size and SHA-256, made
//!   executable, and `node.tmp/` becomes `node/` in one rename; then the
//!   tarball goes, and so does every other version.
//!
//! Any failure leaves no `node/` (and no tarball: a retry starts clean, but
//! an interrupted download's `.part` is kept to resume), so a half-made
//! runtime is never run. [`Runtime::ready_node`] re-checks the binary before
//! every use: its size always, its hash once per app run, or again when its
//! size or mtime changed. Concurrent [`Runtime::ensure`] calls share one
//! download.
//!
//! The folder is under the app's data, which [`super::folder`] never lets
//! anyone grant, and under ~/Library, which the agent's Seatbelt profile
//! can't read: the launcher runs it by absolute path, and the agent's tools
//! never find it on their PATH.

use crate::sidecar::NoConsole;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::modules::assets::{self, Progress};
use crate::modules::registry::AssetSpec;

/// The pinned Node, compiled in.
pub const RUNTIME_JSON: &str = include_str!("runtime.json");
/// The version folder's runnable Node (`bin/node`, `LICENSE`).
const NODE_DIR: &str = "node";
/// Where it is unpacked first, so `node/` only ever holds a checked binary.
const NODE_TMP: &str = "node.tmp";
const TAR: &str = "/usr/bin/tar";
/// Unpacking 27 MB of xz takes a second or two.
const UNPACK_TIMEOUT: Duration = Duration::from_secs(120);
/// The downloader's own bookkeeping, removed with the tarball.
const VERIFIED_FILE: &str = "verified.json";

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RuntimeSpec {
    /// `v24.22.1`: also the folder name.
    pub version: String,
    pub tarball: TarballSpec,
    pub binary: BinarySpec,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TarballSpec {
    pub file: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    /// The folder every entry in the tarball is under.
    pub prefix: String,
}

/// `<prefix>/bin/node` inside the tarball.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BinarySpec {
    pub sha256: String,
    pub size: u64,
}

impl RuntimeSpec {
    /// `runtime.json`. A test pins that it parses.
    pub fn pinned() -> Self {
        serde_json::from_str(RUNTIME_JSON).unwrap_or_else(|e| panic!("local_agent/runtime.json is invalid: {e}"))
    }

    fn asset(&self) -> AssetSpec {
        AssetSpec {
            name: "node".into(),
            file: self.tarball.file.clone(),
            url: self.tarball.url.clone(),
            sha256: self.tarball.sha256.clone(),
            size: self.tarball.size,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeState {
    Missing,
    Downloading,
    Verifying,
    Ready,
    Error,
}

/// `local_agent_status`'s `runtime`, in packaged mode.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub version: String,
    pub state: RuntimeState,
    /// 0..1 while downloading.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
    /// The last setup's failure, until one succeeds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What [`Runtime::ensure`] is doing; `Idle` between setups.
#[derive(Debug, Clone, PartialEq)]
enum Phase {
    Idle,
    Downloading(f64),
    Verifying,
    Failed(String),
}

/// The binary's size and mtime: when they're what they were when it last
/// hashed right, it isn't hashed again.
type Stamp = (u64, SystemTime);

enum Check {
    /// Hashed right this run, unchanged since.
    Ready(PathBuf),
    /// The pinned size and executable, not hashed since it last changed.
    Hash(PathBuf, Stamp),
    Missing,
}

pub struct Runtime {
    spec: RuntimeSpec,
    /// `<app_data>/local-agent/runtime`: one folder per version.
    root: PathBuf,
    client: reqwest::Client,
    /// Held for a whole setup: a second caller waits for the first one's.
    flight: tokio::sync::Mutex<()>,
    phase: Mutex<Phase>,
    verified: Mutex<Option<Stamp>>,
}

/// The binary's [`Stamp`] if it is a plain executable file of `size` bytes
/// (a symlink isn't followed).
fn stamp_of(node: &Path, size: u64) -> Option<Stamp> {
    let meta = std::fs::symlink_metadata(node).ok()?;
    if !meta.is_file() || meta.len() != size {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some((meta.len(), meta.modified().ok()?))
}

/// Blocking: ~120 MB.
fn hash_matches(path: &Path, sha256: &str) -> bool {
    assets::sha256_file(path).is_ok_and(|h| h.eq_ignore_ascii_case(sha256))
}

async fn remove_dir_if_any(dir: &Path) -> std::io::Result<()> {
    match tokio::fs::remove_dir_all(dir).await {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// The client the runtime downloads with: the modules' user agent and
/// connect timeout, plus a read timeout, so a stalled download fails the
/// start instead of holding it for ever.
pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!("NativeIntelligence-Desktop/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .build()
        .unwrap_or_default()
}

impl Runtime {
    /// `root`: `<app_data>/local-agent/runtime`.
    pub fn new(spec: RuntimeSpec, root: PathBuf, client: reqwest::Client) -> Self {
        Self {
            spec,
            root,
            client,
            flight: tokio::sync::Mutex::new(()),
            phase: Mutex::new(Phase::Idle),
            verified: Mutex::new(None),
        }
    }

    fn dir(&self) -> PathBuf {
        self.root.join(&self.spec.version)
    }

    /// `<root>/<version>/node/bin/node` (its LICENSE: `node/LICENSE`).
    pub fn node_path(&self) -> PathBuf {
        self.dir().join(NODE_DIR).join("bin/node")
    }

    fn check(&self) -> Check {
        let node = self.node_path();
        let Some(stamp) = stamp_of(&node, self.spec.binary.size) else {
            return Check::Missing;
        };
        if *self.verified.lock().unwrap() == Some(stamp) {
            Check::Ready(node)
        } else {
            Check::Hash(node, stamp)
        }
    }

    fn record(&self, node: PathBuf, stamp: Stamp, ok: bool) -> Option<PathBuf> {
        let mut verified = self.verified.lock().unwrap();
        *verified = ok.then_some(stamp);
        ok.then_some(node)
    }

    /// The binary, if it is the pinned one. Hashes it (on a blocking thread:
    /// ~120 MB) at most once per app run unless its size or mtime changed.
    pub async fn ready_node(&self) -> Option<PathBuf> {
        match self.check() {
            Check::Ready(node) => Some(node),
            Check::Missing => None,
            Check::Hash(node, stamp) => {
                let (path, want) = (node.clone(), self.spec.binary.sha256.clone());
                let ok = tokio::task::spawn_blocking(move || hash_matches(&path, &want))
                    .await
                    .unwrap_or(false);
                self.record(node, stamp, ok)
            }
        }
    }

    /// Without hashing: `ready` only once [`Runtime::ready_node`] has checked
    /// the binary this run (`local_agent_status` resolves first).
    pub fn status(&self) -> RuntimeStatus {
        let phase = self.phase.lock().unwrap().clone();
        let ready = matches!(self.check(), Check::Ready(_));
        let (state, progress, error) = match phase {
            Phase::Downloading(p) => (RuntimeState::Downloading, Some(p), None),
            Phase::Verifying => (RuntimeState::Verifying, None, None),
            _ if ready => (RuntimeState::Ready, None, None),
            Phase::Failed(e) => (RuntimeState::Error, None, Some(e)),
            Phase::Idle => (RuntimeState::Missing, None, None),
        };
        RuntimeStatus {
            version: self.spec.version.clone(),
            state,
            progress,
            error,
        }
    }

    fn set_phase(&self, phase: Phase) {
        *self.phase.lock().unwrap() = phase;
    }

    /// The pinned Node, downloading and unpacking it first if need be. One
    /// setup at a time: concurrent callers share it.
    pub async fn ensure(&self) -> Result<PathBuf, String> {
        if let Some(node) = self.ready_node().await {
            return Ok(node);
        }
        let _flight = self.flight.lock().await;
        // Whoever held the flight may have just set it up.
        if let Some(node) = self.ready_node().await {
            return Ok(node);
        }
        let version = self.spec.version.clone();
        crate::log_to_file(&format!("[local-agent] runtime {version}: setting up"));
        let started = std::time::Instant::now();
        self.set_phase(Phase::Downloading(0.0));
        match self.install().await {
            Ok(node) => {
                crate::log_to_file(&format!(
                    "[local-agent] runtime {version}: ready ({:.1}s)",
                    started.elapsed().as_secs_f64()
                ));
                self.set_phase(Phase::Idle);
                Ok(node)
            }
            Err(e) => {
                self.discard().await;
                crate::log_to_file(&format!("[local-agent] runtime {version}: setup failed: {e}"));
                let message = format!("couldn't set up the local agent runtime: {e}");
                self.set_phase(Phase::Failed(message.clone()));
                Err(message)
            }
        }
    }

    /// [`Runtime::ensure`] in the background (a folder was just shared), so
    /// the first start doesn't wait for the download. A failure is logged by
    /// `ensure`, and the start that needs it tries again.
    pub fn prewarm(self: &Arc<Self>) {
        let runtime = self.clone();
        tauri::async_runtime::spawn(async move {
            let _ = runtime.ensure().await;
        });
    }

    async fn install(&self) -> Result<PathBuf, String> {
        let dir = self.dir();
        let asset = self.spec.asset();
        let total = asset.size.max(1) as f64;
        assets::download_all(
            &self.client,
            &dir,
            std::slice::from_ref(&asset),
            Arc::new(AtomicBool::new(false)),
            |p| {
                self.set_phase(match p {
                    Progress::Downloading { done, .. } => Phase::Downloading((done as f64 / total).min(1.0)),
                    Progress::Verifying { .. } => Phase::Verifying,
                })
            },
        )
        .await
        .map_err(|e| e.to_string())?;
        self.set_phase(Phase::Verifying);

        let tmp = dir.join(NODE_TMP);
        remove_dir_if_any(&tmp)
            .await
            .map_err(|e| format!("can't clear {NODE_TMP}: {e}"))?;
        tokio::fs::create_dir_all(&tmp)
            .await
            .map_err(|e| format!("can't create {NODE_TMP}: {e}"))?;
        unpack(&dir.join(&asset.file), &tmp, &self.spec.tarball.prefix).await?;

        let unpacked = tmp.join("bin/node");
        let meta = std::fs::symlink_metadata(&unpacked).map_err(|_| "the tarball had no bin/node".to_string())?;
        if !meta.is_file() || meta.len() != self.spec.binary.size {
            return Err(format!(
                "bin/node is {} bytes, not the pinned {}",
                meta.len(),
                self.spec.binary.size
            ));
        }
        let (path, want) = (unpacked.clone(), self.spec.binary.sha256.clone());
        let ok = tokio::task::spawn_blocking(move || hash_matches(&path, &want))
            .await
            .unwrap_or(false);
        if !ok {
            return Err("bin/node failed its checksum".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&unpacked, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("can't make node executable: {e}"))?;
        }

        // A `node/` that failed its check (tampered, truncated) makes way.
        let node_dir = dir.join(NODE_DIR);
        remove_dir_if_any(&node_dir)
            .await
            .map_err(|e| format!("can't replace the old node: {e}"))?;
        tokio::fs::rename(&tmp, &node_dir)
            .await
            .map_err(|e| format!("can't move node into place: {e}"))?;
        self.remove_tarball().await;
        assets::gc_other_versions(&self.root, &self.spec.version);

        let node = self.node_path();
        let stamp = stamp_of(&node, self.spec.binary.size).ok_or("node is gone after setup")?;
        *self.verified.lock().unwrap() = Some(stamp);
        Ok(node)
    }

    /// The tarball and the downloader's record of it; an interrupted
    /// download's `.part` too, once it is no longer needed.
    async fn remove_tarball(&self) {
        let dir = self.dir();
        let file = &self.spec.tarball.file;
        for name in [file.clone(), format!("{file}.part"), VERIFIED_FILE.to_string()] {
            let _ = tokio::fs::remove_file(dir.join(name)).await;
        }
    }

    /// After a failed setup: no `node/`, no `node.tmp/`, no tarball (a
    /// tarball that unpacked wrong is fetched again). A `.part` stays, so an
    /// interrupted download resumes.
    async fn discard(&self) {
        let dir = self.dir();
        let _ = remove_dir_if_any(&dir.join(NODE_TMP)).await;
        let _ = remove_dir_if_any(&dir.join(NODE_DIR)).await;
        let _ = tokio::fs::remove_file(dir.join(&self.spec.tarball.file)).await;
        let _ = tokio::fs::remove_file(dir.join(VERIFIED_FILE)).await;
        *self.verified.lock().unwrap() = None;
    }
}

/// Unpack only `<prefix>/bin/node` and `<prefix>/LICENSE` into `into`.
async fn unpack(tarball: &Path, into: &Path, prefix: &str) -> Result<(), String> {
    let mut cmd = tokio::process::Command::new(TAR);
    cmd.no_console();
    cmd.arg("-xJf")
        .arg(tarball)
        .arg("-C")
        .arg(into)
        .args(["--strip-components", "1"])
        .arg(format!("{prefix}/bin/node"))
        .arg(format!("{prefix}/LICENSE"))
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let out = match tokio::time::timeout(UNPACK_TIMEOUT, cmd.output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(format!("can't run tar: {e}")),
        Err(_) => return Err(format!("unpacking took over {}s", UNPACK_TIMEOUT.as_secs())),
    };
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let first = stderr
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("no output");
        // tar names the tarball by its full path; its name says enough.
        let name = tarball.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();
        let first: String = first
            .replace(&tarball.display().to_string(), &name)
            .chars()
            .take(200)
            .collect();
        return Err(format!("unpacking failed ({}): {first}", out.status));
    }
    Ok(())
}

/// A runtime over a temp tree, for the module's tests: a tar.xz made on the
/// spot with `/usr/bin/tar` and a server that counts its requests.
// The local agent runs on macOS only so far (its jobs, shells and
// sandbox are POSIX): its tests are too.
#[cfg(all(test, unix))]
pub(crate) mod fixture {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    pub const PREFIX: &str = "node-v0.0.1-test";
    pub const VERSION: &str = "v0.0.1";
    /// The stand-in for node: a shell script, so it runs like one.
    pub const NODE: &[u8] = b"#!/bin/sh\necho fake node \"$@\"\n";

    pub fn sha(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    /// `<prefix>/bin/node` (`node`), `<prefix>/LICENSE` and a file that must
    /// not be unpacked, as tar.xz bytes.
    pub fn tarball(dir: &Path, node: &[u8]) -> Vec<u8> {
        let src = dir.join("tar-src");
        let top = src.join(PREFIX);
        std::fs::create_dir_all(top.join("bin")).unwrap();
        std::fs::create_dir_all(top.join("include")).unwrap();
        std::fs::write(top.join("bin/node"), node).unwrap();
        std::fs::write(top.join("LICENSE"), "MIT, for the test\n").unwrap();
        std::fs::write(top.join("include/node.h"), "// not unpacked\n").unwrap();
        let out = dir.join("fixture.tar.xz");
        let status = std::process::Command::new(TAR)
            .env("COPYFILE_DISABLE", "1")
            .arg("-cJf")
            .arg(&out)
            .arg("-C")
            .arg(&src)
            .arg(PREFIX)
            .status()
            .unwrap();
        assert!(status.success(), "tar -cJf failed");
        std::fs::read(&out).unwrap()
    }

    pub fn spec(base_url: &str, tarball: &[u8], node: &[u8]) -> RuntimeSpec {
        let file = format!("{PREFIX}.tar.xz");
        RuntimeSpec {
            version: VERSION.into(),
            tarball: TarballSpec {
                url: format!("{base_url}/{file}"),
                file,
                sha256: sha(tarball),
                size: tarball.len() as u64,
                prefix: PREFIX.into(),
            },
            binary: BinarySpec {
                sha256: sha(node),
                size: node.len() as u64,
            },
        }
    }

    /// Serves `body` for any request; returns the base URL and the number of
    /// requests so far.
    pub async fn serve(body: Vec<u8>) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let (body, counter) = (Arc::new(body), hits.clone());
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                counter.fetch_add(1, Ordering::SeqCst);
                let body = body.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let _ = sock.read(&mut buf).await;
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = sock.write_all(head.as_bytes()).await;
                    let _ = sock.write_all(&body).await;
                });
            }
        });
        (format!("http://{addr}"), hits)
    }

    /// A runtime whose pinned binary is already in place (nothing to fetch:
    /// its URL goes nowhere).
    pub fn installed(root: &Path) -> Runtime {
        let spec = spec("http://127.0.0.1:9", b"no tarball", NODE);
        let runtime = Runtime::new(spec, root.to_path_buf(), reqwest::Client::new());
        let node = runtime.node_path();
        std::fs::create_dir_all(node.parent().unwrap()).unwrap();
        std::fs::write(&node, NODE).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        runtime
    }
}

// The local agent runs on macOS only so far (its jobs, shells and
// sandbox are POSIX): its tests are too.
#[cfg(all(test, unix))]
mod tests {
    use super::fixture::*;
    use super::*;
    use std::sync::atomic::Ordering;

    fn is_hex64(s: &str) -> bool {
        s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    }

    #[test]
    fn the_pinned_runtime_is_self_consistent() {
        let spec = RuntimeSpec::pinned();
        let t = &spec.tarball;
        assert!(spec.version.starts_with("v24."), "{}", spec.version);
        assert!(t.url.starts_with("https://nodejs.org/dist/"), "{}", t.url);
        assert!(t.url.ends_with(&format!("/{}", t.file)), "the url names another file");
        assert!(
            t.url.contains(&format!("/{}/", spec.version)),
            "the url is another version"
        );
        assert!(t.file.starts_with(&t.prefix), "the prefix isn't the file's");
        assert!(t.prefix.contains(&spec.version) && t.prefix.ends_with("-darwin-arm64"));
        assert!(t.file.ends_with(".tar.xz"));
        assert!(is_hex64(&t.sha256) && is_hex64(&spec.binary.sha256));
        assert!(
            t.size > 0 && spec.binary.size > t.size,
            "node unpacks bigger than its tarball"
        );
        assert!(is_safe_folder_name(&spec.version));
    }

    /// The pin against nodejs.org itself, through the real setup: downloads
    /// the 27 MB tarball. Run it when bumping runtime.json:
    /// `cargo test --manifest-path src-tauri/Cargo.toml the_pin_matches_nodejs_org -- --ignored`
    #[tokio::test]
    #[ignore = "downloads Node from nodejs.org"]
    async fn the_pin_matches_nodejs_org() {
        let dir = tempfile::tempdir().unwrap();
        let spec = RuntimeSpec::pinned();
        let version = spec.version.clone();
        let runtime = Runtime::new(spec, dir.path().join("runtime"), http_client());
        let node = runtime.ensure().await.expect("the pinned Node sets up");
        let out = std::process::Command::new(&node).arg("--version").output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), version);
        assert!(runtime.ready_node().await.is_some());
    }

    fn is_safe_folder_name(s: &str) -> bool {
        !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') && s != ".."
    }

    async fn rig(node: &[u8]) -> (tempfile::TempDir, PathBuf, Runtime, Arc<std::sync::atomic::AtomicUsize>) {
        let dir = tempfile::tempdir().unwrap();
        let tar = tarball(dir.path(), node);
        let (url, hits) = serve(tar.clone()).await;
        let root = dir.path().join("runtime");
        let runtime = Runtime::new(spec(&url, &tar, node), root.clone(), reqwest::Client::new());
        (dir, root, runtime, hits)
    }

    #[tokio::test]
    async fn ensure_downloads_unpacks_checks_and_cleans_up() {
        let (_dir, root, runtime, hits) = rig(NODE).await;
        let status = runtime.status();
        assert_eq!(
            (status.version.as_str(), status.state),
            (VERSION, RuntimeState::Missing)
        );
        assert_eq!(runtime.ready_node().await, None);

        let node = runtime.ensure().await.unwrap();
        assert_eq!(node, root.join(VERSION).join("node/bin/node"));
        assert_eq!(std::fs::read(&node).unwrap(), NODE);
        assert!(super::super::config::is_executable(&node));
        let out = std::process::Command::new(&node).arg("hi").output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "fake node hi\n");
        let v = root.join(VERSION);
        assert!(v.join("node/LICENSE").is_file());
        assert!(
            !v.join("node/include").exists(),
            "only bin/node and LICENSE are unpacked"
        );
        for gone in [
            format!("{PREFIX}.tar.xz"),
            format!("{PREFIX}.tar.xz.part"),
            VERIFIED_FILE.into(),
            NODE_TMP.into(),
        ] {
            assert!(!v.join(&gone).exists(), "{gone} is left behind");
        }
        assert_eq!(runtime.ready_node().await, Some(node.clone()));
        assert_eq!(runtime.status().state, RuntimeState::Ready);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_tarball_that_fails_its_checksum_leaves_no_node() {
        let (_dir, root, mut runtime, _) = rig(NODE).await;
        runtime.spec.tarball.sha256 = "00".repeat(32);
        let err = runtime.ensure().await.unwrap_err();
        assert!(err.starts_with("couldn't set up the local agent runtime: "), "{err}");
        assert!(err.contains("checksum"), "{err}");
        assert!(!root.join(VERSION).join("node").exists());
        let status = runtime.status();
        assert_eq!(status.state, RuntimeState::Error);
        assert_eq!(status.error.as_deref(), Some(err.as_str()));
    }

    #[tokio::test]
    async fn a_binary_that_isnt_the_pinned_one_leaves_no_node() {
        let (_dir, root, mut runtime, _) = rig(NODE).await;
        // The right tarball, a node pin it doesn't match (same size).
        runtime.spec.binary.sha256 = "00".repeat(32);
        let err = runtime.ensure().await.unwrap_err();
        assert!(err.contains("bin/node failed its checksum"), "{err}");
        let v = root.join(VERSION);
        assert!(!v.join("node").exists() && !v.join(NODE_TMP).exists());
        assert!(!v.join(format!("{PREFIX}.tar.xz")).exists(), "a retry fetches it again");
        assert_eq!(runtime.ready_node().await, None);
        // And a size that doesn't match.
        runtime.spec.binary = BinarySpec {
            sha256: sha(NODE),
            size: NODE.len() as u64 + 1,
        };
        let err = runtime.ensure().await.unwrap_err();
        assert!(err.contains("not the pinned"), "{err}");
        assert!(!v.join("node").exists());
    }

    #[tokio::test]
    async fn a_ready_runtime_never_touches_the_network() {
        let (_dir, root, runtime, hits) = rig(NODE).await;
        runtime.ensure().await.unwrap();
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        // The next app run: a fresh process cache, a server that counts.
        let (url, fresh_hits) = serve(Vec::new()).await;
        let mut spec = runtime.spec.clone();
        spec.tarball.url = format!("{url}/{}", spec.tarball.file);
        let next = Runtime::new(spec, root, reqwest::Client::new());
        assert_eq!(next.status().state, RuntimeState::Missing, "not hashed yet this run");
        let node = next.ensure().await.unwrap();
        assert_eq!(next.ensure().await.unwrap(), node);
        assert_eq!(next.status().state, RuntimeState::Ready);
        assert_eq!(fresh_hits.load(Ordering::SeqCst), 0);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_tampered_binary_is_not_ready_and_ensure_puts_it_right() {
        let (_dir, _root, runtime, hits) = rig(NODE).await;
        let node = runtime.ensure().await.unwrap();
        // Same size, other bytes: only the hash can tell.
        let mut evil = NODE.to_vec();
        let last = evil.len() - 2;
        evil[last] = b'X';
        std::fs::write(&node, &evil).unwrap();
        assert_eq!(runtime.ready_node().await, None);
        assert_eq!(runtime.status().state, RuntimeState::Missing);
        assert_eq!(runtime.ensure().await.unwrap(), node);
        assert_eq!(std::fs::read(&node).unwrap(), NODE);
        assert_eq!(hits.load(Ordering::SeqCst), 2);
        // A symlink in its place isn't followed.
        std::fs::remove_file(&node).unwrap();
        let elsewhere = node.with_file_name("real-node");
        std::fs::write(&elsewhere, NODE).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &node).unwrap();
        assert_eq!(runtime.ready_node().await, None);
    }

    #[tokio::test]
    async fn concurrent_ensures_share_one_download() {
        let (_dir, _root, runtime, hits) = rig(NODE).await;
        let runtime = Arc::new(runtime);
        let (a, b, c) = tokio::join!(runtime.ensure(), runtime.ensure(), runtime.ensure());
        let node = a.unwrap();
        assert_eq!((b.unwrap(), c.unwrap()), (node.clone(), node));
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn setting_up_removes_other_versions() {
        let (_dir, root, runtime, _) = rig(NODE).await;
        let old = root.join("v24.0.0/node/bin");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("node"), "old").unwrap();
        runtime.ensure().await.unwrap();
        assert!(!root.join("v24.0.0").exists());
        assert!(root.join(VERSION).join("node/bin/node").is_file());
    }

    #[test]
    fn status_serializes_camel_case_without_empty_fields() {
        let s = RuntimeStatus {
            version: "v24.22.1".into(),
            state: RuntimeState::Downloading,
            progress: Some(0.5),
            error: None,
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            serde_json::json!({ "version": "v24.22.1", "state": "downloading", "progress": 0.5 })
        );
    }
}
