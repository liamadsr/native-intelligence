//! What the computer export downloads on first use besides Node: Chrome's
//! headless shell and our FFmpeg with ffprobe, pinned per computer in
//! `components.json` (compiled in). Each is a zip:
//! - downloaded by the local modules' downloader ([`assets::download_all`]:
//!   resumable, checked against the pinned SHA-256, disk space checked first)
//!   into `<root>/<version>/`;
//! - unpacked by [`super::unzip`] into `files.tmp/` (entry names checked, no
//!   links, bytes capped at about the pinned unpacked size);
//! - each named binary checked against its own size and SHA-256, then
//!   `files.tmp/` becomes `files/` in one rename; the zip goes, and so does
//!   every other version.
//!
//! [`Component::ready`] re-checks the binaries before a run: their size
//! always, their hash once per app run, or again when size or mtime changed.
//!
//! A target whose url or hashes are null is a placeholder (FFmpeg until its
//! build exists): never downloaded, always `missing`. A debug build may point
//! FFmpeg at a local pair instead ([`dev_ffmpeg`]).

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use serde::Deserialize;

use crate::modules::assets::{self, Progress};
use crate::modules::registry::AssetSpec;

pub const COMPONENTS_JSON: &str = include_str!("components.json");

/// Where pinned downloads may come from: https on these hosts only. FFmpeg's
/// host is added when its build is hosted (a test holds every pin to this).
pub const DOWNLOAD_HOSTS: [&str; 3] = ["nodejs.org", "remotion.media", "storage.googleapis.com"];

/// The debug-build override for FFmpeg: a folder holding `ffmpeg` and
/// `ffprobe` (Homebrew's `/opt/homebrew/bin`, say). Read only in a debug build.
pub const DEV_FFMPEG_ENV: &str = "NI_STUDIO_FFMPEG_DIR";

#[derive(Debug, Clone, Deserialize)]
struct ComponentsFile {
    chrome: ComponentEntry,
    ffmpeg: ComponentEntry,
}

#[derive(Debug, Clone, Deserialize)]
struct ComponentEntry {
    version: String,
    targets: BTreeMap<String, ArchiveTarget>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveTarget {
    pub file: String,
    pub url: Option<String>,
    pub sha256: Option<String>,
    pub size: u64,
    /// The folder every entry is under.
    pub prefix: String,
    /// What it unpacks to (caps the unpack, and the disk-space estimate).
    pub unpacked_bytes: u64,
    pub binaries: Vec<PinnedBinary>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct PinnedBinary {
    /// What the runner is given it as: `chrome`, `ffmpeg`, `ffprobe`.
    pub role: String,
    /// `/`-separated, under the prefix.
    pub path: String,
    pub sha256: Option<String>,
    pub size: u64,
}

impl ArchiveTarget {
    /// Not built or not hosted yet: nothing to download.
    pub fn is_placeholder(&self) -> bool {
        self.url.is_none() || self.sha256.is_none() || self.binaries.iter().any(|b| b.sha256.is_none())
    }
}

/// A component's pin for one computer.
#[derive(Debug, Clone, PartialEq)]
pub struct ComponentSpec {
    pub name: &'static str,
    pub version: String,
    /// None: nothing pinned for this computer.
    pub target: Option<ArchiveTarget>,
}

impl ComponentSpec {
    /// `components.json`'s `name` (`chrome` or `ffmpeg`) for `target`.
    pub fn pinned(name: &'static str, target: Option<&str>) -> Self {
        let file: ComponentsFile = serde_json::from_str(COMPONENTS_JSON).unwrap_or_else(|e| panic!("studio_local/components.json is invalid: {e}"));
        let entry = match name {
            "chrome" => file.chrome,
            "ffmpeg" => file.ffmpeg,
            other => panic!("no component {other}"),
        };
        Self {
            name,
            version: entry.version,
            target: target.and_then(|t| entry.targets.get(t).cloned()),
        }
    }

    pub fn is_placeholder(&self) -> bool {
        self.target.as_ref().is_none_or(ArchiveTarget::is_placeholder)
    }
}

/// `components.json` and `runtime.json`'s urls: https on [`DOWNLOAD_HOSTS`],
/// default port, no credentials. Pure.
pub fn pinned_url_allowed(url: &str) -> bool {
    let Ok(u) = reqwest::Url::parse(url) else { return false };
    u.scheme() == "https"
        && u.port().is_none()
        && u.username().is_empty()
        && u.password().is_none()
        && u.host_str().is_some_and(|h| DOWNLOAD_HOSTS.contains(&h))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Ready,
    Missing,
    Downloading,
    Failed,
}

#[derive(Debug, Clone, PartialEq)]
enum Phase {
    Idle,
    Downloading,
    Failed(String),
}

type Stamp = (u64, SystemTime);

fn stamp_of(path: &Path, size: u64) -> Option<Stamp> {
    let meta = std::fs::symlink_metadata(path).ok()?;
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

fn rel_join(base: &Path, rel: &str) -> PathBuf {
    rel.split('/').filter(|c| !c.is_empty()).fold(base.to_path_buf(), |p, c| p.join(c))
}

/// One downloadable component, on this computer.
pub struct Component {
    spec: ComponentSpec,
    /// `<app local data>/studio-local/<name>`: one folder per version.
    root: PathBuf,
    client: reqwest::Client,
    /// A debug build's local binaries, by role (FFmpeg only).
    dev: Option<HashMap<String, PathBuf>>,
    flight: tokio::sync::Mutex<()>,
    phase: Mutex<Phase>,
    verified: Mutex<HashMap<String, Stamp>>,
}

impl Component {
    pub fn new(spec: ComponentSpec, root: PathBuf, client: reqwest::Client, dev: Option<HashMap<String, PathBuf>>) -> Self {
        Self {
            spec,
            root,
            client,
            dev,
            flight: tokio::sync::Mutex::new(()),
            phase: Mutex::new(Phase::Idle),
            verified: Mutex::new(HashMap::new()),
        }
    }

    /// Nothing to download: a placeholder pin and no debug override.
    pub fn unavailable(&self) -> bool {
        self.dev.is_none() && self.spec.is_placeholder()
    }

    pub fn is_dev_override(&self) -> bool {
        self.dev.is_some()
    }

    fn files_dir(&self) -> PathBuf {
        self.root.join(&self.spec.version).join("files")
    }

    /// Bytes still to download (0 when ready, a placeholder, or overridden).
    pub fn download_bytes(&self, ready: bool) -> u64 {
        match (&self.spec.target, ready || self.dev.is_some()) {
            (Some(t), false) if !t.is_placeholder() => t.size,
            _ => 0,
        }
    }

    /// Room the download and its unpacking take while setting up.
    pub fn setup_bytes(&self, ready: bool) -> u64 {
        match (&self.spec.target, ready || self.dev.is_some()) {
            (Some(t), false) if !t.is_placeholder() => t.size + t.unpacked_bytes,
            _ => 0,
        }
    }

    /// The binaries by role, if they are the pinned ones. Hashes each (off
    /// the async runtime) at most once per app run unless it changed.
    pub async fn ready(&self) -> Option<HashMap<String, PathBuf>> {
        if let Some(dev) = &self.dev {
            return Some(dev.clone());
        }
        let target = self.spec.target.as_ref().filter(|t| !t.is_placeholder())?;
        let dir = self.files_dir();
        let mut out = HashMap::new();
        for b in &target.binaries {
            let path = rel_join(&dir, &b.path);
            let stamp = stamp_of(&path, b.size)?;
            let known = self.verified.lock().unwrap().get(&b.path) == Some(&stamp);
            if !known {
                let (p, want) = (path.clone(), b.sha256.clone().unwrap_or_default());
                let ok = tokio::task::spawn_blocking(move || assets::sha256_file(&p).is_ok_and(|h| h.eq_ignore_ascii_case(&want)))
                    .await
                    .unwrap_or(false);
                let mut verified = self.verified.lock().unwrap();
                if !ok {
                    verified.remove(&b.path);
                    return None;
                }
                verified.insert(b.path.clone(), stamp);
            }
            out.insert(b.role.clone(), path);
        }
        Some(out)
    }

    /// The state, hashing first if need be ([`Component::ready`]).
    pub async fn state(&self) -> State {
        if matches!(*self.phase.lock().unwrap(), Phase::Downloading) {
            return State::Downloading;
        }
        if self.ready().await.is_some() {
            return State::Ready;
        }
        match &*self.phase.lock().unwrap() {
            Phase::Downloading => State::Downloading,
            Phase::Failed(_) => State::Failed,
            Phase::Idle => State::Missing,
        }
    }

    /// The binaries, downloading and unpacking them first if need be. One
    /// setup at a time: concurrent callers share it. `progress(received, total)`.
    pub async fn ensure(&self, progress: impl Fn(u64, u64)) -> Result<HashMap<String, PathBuf>, String> {
        if let Some(ready) = self.ready().await {
            return Ok(ready);
        }
        let Some(target) = self.spec.target.clone().filter(|t| !t.is_placeholder()) else {
            return Err(format!("{} is not available for this version yet", self.label()));
        };
        let _flight = self.flight.lock().await;
        if let Some(ready) = self.ready().await {
            return Ok(ready);
        }
        *self.phase.lock().unwrap() = Phase::Downloading;
        let started = std::time::Instant::now();
        match self.install(&target, &progress).await {
            Ok(()) => match self.ready().await {
                Some(ready) => {
                    crate::log_to_file(&format!(
                        "[studio-local] {} {}: ready ({:.1}s)",
                        self.spec.name,
                        self.spec.version,
                        started.elapsed().as_secs_f64()
                    ));
                    *self.phase.lock().unwrap() = Phase::Idle;
                    Ok(ready)
                }
                None => self.failed("it is not the pinned build after unpacking".into()).await,
            },
            Err(e) => self.failed(e).await,
        }
    }

    fn label(&self) -> &'static str {
        match self.spec.name {
            "chrome" => "The headless browser",
            "ffmpeg" => "FFmpeg",
            _ => "A component",
        }
    }

    async fn failed(&self, e: String) -> Result<HashMap<String, PathBuf>, String> {
        let dir = self.root.join(&self.spec.version);
        let _ = remove_dir_if_any(&dir.join("files.tmp")).await;
        let _ = remove_dir_if_any(&dir.join("files")).await;
        if let Some(t) = &self.spec.target {
            let _ = tokio::fs::remove_file(dir.join(&t.file)).await;
        }
        let _ = tokio::fs::remove_file(dir.join("verified.json")).await;
        self.verified.lock().unwrap().clear();
        crate::log_to_file(&format!("[studio-local] {} setup failed: {e}", self.spec.name));
        let message = format!("{} could not be set up: {e}", self.label());
        *self.phase.lock().unwrap() = Phase::Failed(message.clone());
        Err(message)
    }

    async fn install(&self, target: &ArchiveTarget, progress: &impl Fn(u64, u64)) -> Result<(), String> {
        let url = target.url.clone().unwrap_or_default();
        if !pinned_url_allowed(&url) && !cfg!(test) {
            return Err("its pinned address is not allowed".into());
        }
        let dir = self.root.join(&self.spec.version);
        let asset = AssetSpec {
            name: self.spec.name.into(),
            file: target.file.clone(),
            url,
            sha256: target.sha256.clone().unwrap_or_default(),
            size: target.size,
        };
        assets::download_all(&self.client, &dir, std::slice::from_ref(&asset), Arc::new(AtomicBool::new(false)), |p| {
            if let Progress::Downloading { done, total } = p {
                progress(done, total)
            }
        })
        .await
        .map_err(|e| e.to_string())?;
        progress(target.size, target.size);

        let tmp = dir.join("files.tmp");
        remove_dir_if_any(&tmp).await.map_err(|e| format!("can't clear files.tmp: {e}"))?;
        tokio::fs::create_dir_all(&tmp).await.map_err(|e| format!("can't create files.tmp: {e}"))?;
        let (zip, into, prefix) = (dir.join(&target.file), tmp.clone(), target.prefix.clone());
        // A little over the pinned size: the cap is against a bad pin, not a tight fit.
        let cap = target.unpacked_bytes + target.unpacked_bytes / 50 + (1 << 20);
        tokio::task::spawn_blocking(move || super::unzip::extract(&zip, &into, &prefix, None, cap))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("unpacking failed: {e}"))?;
        for b in &target.binaries {
            let path = rel_join(&tmp, &b.path);
            let meta = std::fs::symlink_metadata(&path).map_err(|_| format!("the archive had no {}", b.path))?;
            if !meta.is_file() || meta.len() != b.size {
                return Err(format!("{} is {} bytes, not the pinned {}", b.path, meta.len(), b.size));
            }
            let (p, want) = (path.clone(), b.sha256.clone().unwrap_or_default());
            let ok = tokio::task::spawn_blocking(move || assets::sha256_file(&p).is_ok_and(|h| h.eq_ignore_ascii_case(&want)))
                .await
                .unwrap_or(false);
            if !ok {
                return Err(format!("{} failed its checksum", b.path));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                    .map_err(|e| format!("can't make {} executable: {e}", b.path))?;
            }
        }
        let files = self.files_dir();
        remove_dir_if_any(&files).await.map_err(|e| format!("can't replace the old files: {e}"))?;
        tokio::fs::rename(&tmp, &files).await.map_err(|e| format!("can't move the files into place: {e}"))?;
        for name in [target.file.clone(), format!("{}.part", target.file), "verified.json".to_string()] {
            let _ = tokio::fs::remove_file(dir.join(name)).await;
        }
        assets::gc_other_versions(&self.root, &self.spec.version);
        Ok(())
    }
}

async fn remove_dir_if_any(dir: &Path) -> std::io::Result<()> {
    match tokio::fs::remove_dir_all(dir).await {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// A debug build's FFmpeg and ffprobe from [`DEV_FFMPEG_ENV`]: both must be
/// executables there (followed to their real paths: Homebrew's are links).
/// None in a release build, whatever the environment says.
pub fn dev_ffmpeg() -> Option<HashMap<String, PathBuf>> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let dir = PathBuf::from(std::env::var_os(DEV_FFMPEG_ENV)?);
    dev_pair(&dir)
}

/// `ffmpeg` and `ffprobe` (`.exe` on Windows) in `dir`, by real path. Pure but for the file system.
pub fn dev_pair(dir: &Path) -> Option<HashMap<String, PathBuf>> {
    if !dir.is_absolute() {
        return None;
    }
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let mut out = HashMap::new();
    for role in ["ffmpeg", "ffprobe"] {
        let real = std::fs::canonicalize(dir.join(format!("{role}{ext}"))).ok()?;
        let meta = std::fs::metadata(&real).ok()?;
        if !meta.is_file() {
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if meta.permissions().mode() & 0o111 == 0 {
                return None;
            }
        }
        out.insert(role.to_string(), real);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::io::Write;

    fn is_hex64(s: &str) -> bool {
        s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    }

    #[test]
    fn the_pins_parse_and_hold_together() {
        for target in ["darwin-arm64", "win32-x64"] {
            let chrome = ComponentSpec::pinned("chrome", Some(target));
            let t = chrome.target.as_ref().unwrap_or_else(|| panic!("chrome has no {target}"));
            assert!(!t.is_placeholder(), "chrome {target} is pinned");
            assert!(pinned_url_allowed(t.url.as_deref().unwrap()), "{:?}", t.url);
            assert!(t.url.as_deref().unwrap().contains(&chrome.version), "the url is another version");
            assert!(is_hex64(t.sha256.as_deref().unwrap()));
            assert!(t.size > 0 && t.unpacked_bytes > t.size);
            assert_eq!(t.binaries.len(), 1);
            let b = &t.binaries[0];
            assert_eq!(b.role, "chrome");
            assert!(is_hex64(b.sha256.as_deref().unwrap()) && b.size > 0 && b.size < t.unpacked_bytes);
            assert!(super::super::unzip::entry_parts(&format!("{}/{}", t.prefix, b.path), &t.prefix).is_ok());
            assert_eq!(b.path.ends_with(".exe"), target.starts_with("win"));

            let ffmpeg = ComponentSpec::pinned("ffmpeg", Some(target));
            let f = ffmpeg.target.as_ref().unwrap();
            let roles: Vec<&str> = f.binaries.iter().map(|b| b.role.as_str()).collect();
            assert_eq!(roles, ["ffmpeg", "ffprobe"]);
            // A placeholder until our build is hosted; once filled, held like Chrome.
            if !f.is_placeholder() {
                assert!(f.url.as_deref().unwrap().starts_with("https://"));
                assert!(is_hex64(f.sha256.as_deref().unwrap()));
            }
        }
        let version_ok = |v: &str| !v.is_empty() && v != ".." && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
        assert!(version_ok(&ComponentSpec::pinned("chrome", None).version));
        assert!(version_ok(&ComponentSpec::pinned("ffmpeg", None).version));
        assert!(ComponentSpec::pinned("chrome", Some("linux-x64")).target.is_none());
        assert!(ComponentSpec::pinned("chrome", None).is_placeholder());
    }

    #[test]
    fn the_node_pins_are_on_the_allowed_hosts_too() {
        for t in ["darwin-arm64", "win32-x64"] {
            let spec = crate::local_agent::runtime::RuntimeSpec::for_target(t).unwrap();
            assert!(pinned_url_allowed(&spec.tarball.url), "{}", spec.tarball.url);
        }
    }

    #[test]
    fn download_urls_are_held_to_https_on_the_pinned_hosts() {
        assert!(pinned_url_allowed("https://nodejs.org/dist/x.zip"));
        assert!(pinned_url_allowed("https://remotion.media/a.zip?clear"));
        for bad in [
            "http://nodejs.org/x",
            "https://nodejs.org:8443/x",
            "https://user@nodejs.org/x",
            "https://nodejs.org.evil.example/x",
            "https://evil.example/nodejs.org",
            "file:///etc/passwd",
            "not a url",
        ] {
            assert!(!pinned_url_allowed(bad), "{bad}");
        }
    }

    #[cfg(unix)]
    fn sha(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    // The runtime's test server is built for unix tests only.
    #[cfg(unix)]
    /// A zip with `p/tool` (the binary) and `p/data.txt`, its pin, served locally.
    async fn rig(dir: &Path, tool: &[u8]) -> (ComponentSpec, Arc<std::sync::atomic::AtomicUsize>) {
        let path = dir.join("c.zip");
        let mut w = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let o = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        w.start_file("p/tool", o.unix_permissions(0o755)).unwrap();
        w.write_all(tool).unwrap();
        w.start_file("p/data.txt", o.unix_permissions(0o644)).unwrap();
        w.write_all(b"data").unwrap();
        w.finish().unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let (url, hits) = crate::local_agent::runtime::fixture::serve(bytes.clone()).await;
        let spec = ComponentSpec {
            name: "chrome",
            version: "1.0.0".into(),
            target: Some(ArchiveTarget {
                file: "c.zip".into(),
                url: Some(format!("{url}/c.zip")),
                sha256: Some(sha(&bytes)),
                size: bytes.len() as u64,
                prefix: "p".into(),
                unpacked_bytes: (tool.len() + 4) as u64,
                binaries: vec![PinnedBinary { role: "chrome".into(), path: "tool".into(), sha256: Some(sha(tool)), size: tool.len() as u64 }],
            }),
        };
        (spec, hits)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ensure_downloads_unpacks_checks_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let (spec, hits) = rig(dir.path(), b"#!/bin/sh\necho tool\n").await;
        let root = dir.path().join("chrome");
        std::fs::create_dir_all(root.join("0.9/files")).unwrap();
        let c = Component::new(spec, root.clone(), reqwest::Client::new(), None);
        assert_eq!(c.state().await, State::Missing);
        assert!(c.download_bytes(false) > 0);
        let seen = Mutex::new(0u64);
        let got = c.ensure(|done, _| *seen.lock().unwrap() = done).await.unwrap();
        let tool = got.get("chrome").unwrap();
        assert_eq!(tool, &root.join("1.0.0/files/tool"));
        assert!(root.join("1.0.0/files/data.txt").is_file());
        assert!(!root.join("1.0.0/c.zip").exists() && !root.join("1.0.0/files.tmp").exists());
        assert!(!root.join("0.9").exists(), "other versions go");
        assert!(*seen.lock().unwrap() > 0);
        assert_eq!(c.state().await, State::Ready);
        // Tampered: not ready, and ensure puts it right.
        std::fs::write(tool, b"#!/bin/sh\necho evil\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(c.ready().await.is_none());
        c.ensure(|_, _| {}).await.unwrap();
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_binary_that_is_not_the_pinned_one_leaves_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (mut spec, _) = rig(dir.path(), b"tool").await;
        spec.target.as_mut().unwrap().binaries[0].sha256 = Some("00".repeat(32));
        let root = dir.path().join("chrome");
        let c = Component::new(spec, root.clone(), reqwest::Client::new(), None);
        let err = c.ensure(|_, _| {}).await.unwrap_err();
        assert!(err.contains("failed its checksum"), "{err}");
        assert!(!root.join("1.0.0/files").exists());
        assert_eq!(c.state().await, State::Failed);
    }

    #[tokio::test]
    async fn a_placeholder_is_never_downloaded() {
        let spec = ComponentSpec::pinned("ffmpeg", Some("darwin-arm64"));
        if !spec.is_placeholder() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let c = Component::new(spec, dir.path().to_path_buf(), reqwest::Client::new(), None);
        assert!(c.unavailable());
        assert_eq!(c.download_bytes(false), 0);
        assert_eq!(c.state().await, State::Missing);
        let err = c.ensure(|_, _| {}).await.unwrap_err();
        assert_eq!(err, "FFmpeg is not available for this version yet");
    }

    #[cfg(unix)]
    #[test]
    fn the_dev_override_wants_both_executables() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        assert!(dev_pair(dir.path()).is_none());
        for n in ["ffmpeg", "ffprobe"] {
            std::fs::write(dir.path().join(n), b"#!/bin/sh\n").unwrap();
        }
        assert!(dev_pair(dir.path()).is_none(), "not executable");
        for n in ["ffmpeg", "ffprobe"] {
            std::fs::set_permissions(dir.path().join(n), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let pair = dev_pair(dir.path()).unwrap();
        assert_eq!(pair.len(), 2);
        assert!(dev_pair(Path::new("relative")).is_none());
    }

    /// A pinned download that answers with a redirect is not followed, to any host.
    #[tokio::test]
    async fn a_redirect_is_not_followed() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let h = hits.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = vec![0u8; 4096];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                if String::from_utf8_lossy(&buf[..n]).contains("/elsewhere") {
                    h.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
                let reply = format!("HTTP/1.1 302 Found\r\nLocation: http://{addr}/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                let _ = sock.write_all(reply.as_bytes()).await;
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let spec = ComponentSpec {
            name: "chrome",
            version: "1.0.0".into(),
            target: Some(ArchiveTarget {
                file: "c.zip".into(),
                url: Some(format!("http://{addr}/c.zip")),
                sha256: Some("00".repeat(32)),
                size: 10,
                prefix: "p".into(),
                unpacked_bytes: 10,
                binaries: vec![PinnedBinary { role: "chrome".into(), path: "tool".into(), sha256: Some("00".repeat(32)), size: 1 }],
            }),
        };
        let c = Component::new(spec, dir.path().to_path_buf(), crate::local_agent::runtime::http_client(), None);
        assert!(c.ensure(|_, _| {}).await.is_err());
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0, "the redirect was not followed");
    }
}
