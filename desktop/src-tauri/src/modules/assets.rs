//! Model assets for local modules: resumable HTTPS downloads, SHA-256
//! verification, disk-space checks, and version GC.
//!
//! Layout: `<app data>/modules/<module id>/<assets version>/<file>`, plus a
//! `verified.json` recording each file's checked hash and its [`Stamp`], so
//! a check is a few `stat`s. In-flight downloads live next to their target
//! as `<file>.part` and resume with an HTTP Range request.
//!
//! A file counts as verified only while its stamp is the one it had when it
//! was hashed, so a same-size swap (a new inode, or a write in place, which
//! moves ctime) is caught at the next check (security review 2026-10-31).
//! The record on disk is the user's to rewrite, so it only says the files
//! are there: each app run hashes every file once ([`recheck`], or the job
//! when one runs; ~0.35 s for the 806 MB STT model on an M2 Max) before a
//! sidecar may use it ([`checked_this_run`]), and from then on the stamp kept
//! in memory, which no other process can touch, decides.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use super::registry::AssetSpec;

const VERIFIED_FILE: &str = "verified.json";
/// Free space to leave on the volume after a download completes.
const DISK_HEADROOM_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum AssetError {
    #[error("not enough disk space: {needed_mb} MB needed, {available_mb} MB free")]
    DiskFull { needed_mb: u64, available_mb: u64 },
    #[error("download of {file} failed: {message}")]
    Http { file: String, message: String },
    #[error("{file} failed its checksum — the download was discarded")]
    Checksum { file: String },
    #[error("cancelled")]
    Cancelled,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// What identifies a file's bytes without reading them: replacing the file
/// changes its inode, and writing to it moves its ctime, which nothing short
/// of root can set back. A symlink is never the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Stamp {
    size: u64,
    dev: u64,
    ino: u64,
    mtime: [i64; 2],
    ctime: [i64; 2],
}

fn stamp_of(path: &Path) -> Option<Stamp> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(Stamp {
            size: meta.size(),
            dev: meta.dev(),
            ino: meta.ino(),
            mtime: [meta.mtime(), meta.mtime_nsec()],
            ctime: [meta.ctime(), meta.ctime_nsec()],
        })
    }
    #[cfg(not(unix))]
    {
        let modified = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
        let mtime = [modified.as_secs() as i64, modified.subsec_nanos() as i64];
        Some(Stamp { size: meta.len(), dev: 0, ino: 0, mtime, ctime: mtime })
    }
}

/// One file's line in verified.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Record {
    sha256: String,
    stamp: Stamp,
}

/// Files hashed in this app run, by path, with the stamp they had then.
static CHECKED: Mutex<BTreeMap<PathBuf, Stamp>> = Mutex::new(BTreeMap::new());

fn checked() -> std::sync::MutexGuard<'static, BTreeMap<PathBuf, Stamp>> {
    CHECKED.lock().unwrap_or_else(|p| p.into_inner())
}

/// Files already verified on disk: file name → its record. A verified.json
/// in an older format reads as empty: every file is hashed again.
fn read_verified(dir: &Path) -> BTreeMap<String, Record> {
    std::fs::read(dir.join(VERIFIED_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_verified(dir: &Path, map: &BTreeMap<String, Record>) -> std::io::Result<()> {
    let tmp = dir.join(format!("{VERIFIED_FILE}.tmp"));
    std::fs::write(&tmp, serde_json::to_vec_pretty(map).unwrap_or_default())?;
    std::fs::rename(tmp, dir.join(VERIFIED_FILE))
}

/// The file was hashed to its pinned SHA-256 in this app run and is still
/// that file: what a sidecar may load.
fn checked_now(dir: &Path, asset: &AssetSpec) -> bool {
    let path = dir.join(&asset.file);
    stamp_of(&path).filter(|s| s.size == asset.size).is_some_and(|now| checked().get(&path) == Some(&now))
}

/// Every asset was hashed in this app run and is still that file
/// ([`checked_now`]). A record on disk alone never passes.
pub fn checked_this_run(dir: &Path, assets: &[AssetSpec]) -> bool {
    assets.iter().all(|a| checked_now(dir, a))
}

/// The file is the right size and still the one that hashed to the pinned
/// SHA-256: in this run if it was hashed in this run, else per its record
/// (which says only that it's there: [`checked_this_run`] gates a launch).
fn is_asset_verified(dir: &Path, asset: &AssetSpec, verified: &BTreeMap<String, Record>) -> bool {
    let path = dir.join(&asset.file);
    let Some(now) = stamp_of(&path).filter(|s| s.size == asset.size) else {
        return false;
    };
    if let Some(then) = checked().get(&path) {
        return *then == now;
    }
    verified
        .get(&asset.file)
        .is_some_and(|r| r.sha256.eq_ignore_ascii_case(&asset.sha256) && r.stamp == now)
}

/// `path` hashed to its pinned SHA-256 with `stamp`: remember it for this
/// run, and in `verified`.
fn record_verified(verified: &mut BTreeMap<String, Record>, asset: &AssetSpec, path: &Path, stamp: Stamp) {
    checked().insert(path.to_path_buf(), stamp.clone());
    verified.insert(asset.file.clone(), Record { sha256: asset.sha256.to_lowercase(), stamp });
}

/// `path`'s stamp if it holds the bytes pinned as `sha256` and didn't change
/// while it was read. Blocking.
fn pinned_stamp(path: &Path, sha256: &str) -> Option<Stamp> {
    let before = stamp_of(path)?;
    let digest = sha256_file(path).ok()?;
    (digest.eq_ignore_ascii_case(sha256) && stamp_of(path).as_ref() == Some(&before)).then_some(before)
}

/// [`pinned_stamp`] off the async runtime.
async fn pinned_stamp_async(path: &Path, sha256: &str) -> std::io::Result<Option<Stamp>> {
    let (path, sha256) = (path.to_path_buf(), sha256.to_string());
    tokio::task::spawn_blocking(move || pinned_stamp(&path, &sha256))
        .await
        .map_err(|e| std::io::Error::other(e.to_string()))
}

/// Hash every asset in `dir` that wasn't hashed in this app run, and keep
/// each one that matches its pinned SHA-256 and didn't change while it was
/// read. False when any is missing, the wrong size or the wrong bytes: its
/// record is dropped, so the module's job hashes it again (and downloads it
/// again if it fails). Blocking: call off the main thread.
pub fn recheck(dir: &Path, assets: &[AssetSpec]) -> bool {
    let mut verified = read_verified(dir);
    let mut all_good = true;
    for asset in assets {
        let path = dir.join(&asset.file);
        let before = stamp_of(&path).filter(|s| s.size == asset.size);
        if before.is_some() && checked().get(&path) == before.as_ref() {
            continue;
        }
        match before.and_then(|_| pinned_stamp(&path, &asset.sha256)) {
            Some(stamp) => record_verified(&mut verified, asset, &path, stamp),
            None => {
                crate::log_to_file(&format!("[modules] {}: {} failed its re-check", dir_label(dir), asset.file));
                checked().remove(&path);
                verified.remove(&asset.file);
                all_good = false;
            }
        }
    }
    let _ = write_verified(dir, &verified);
    all_good
}

/// True when every asset is present, the right size, and was hash-verified,
/// in this run or per its record: the files are there. A launch needs
/// [`checked_this_run`].
pub fn all_verified(dir: &Path, assets: &[AssetSpec]) -> bool {
    let verified = read_verified(dir);
    assets.iter().all(|a| is_asset_verified(dir, a, &verified))
}

/// Total bytes of an asset set.
pub fn total_bytes(assets: &[AssetSpec]) -> u64 {
    assets.iter().map(|a| a.size).sum()
}

/// Bytes still to fetch: none for a file already at its size (it's hashed
/// where it is, and one that fails frees its own size before it's fetched
/// again), and partial `.part` files count as progress.
fn remaining_bytes(dir: &Path, assets: &[AssetSpec]) -> u64 {
    assets
        .iter()
        .filter(|a| !checked_now(dir, a))
        .map(|a| {
            if stamp_of(&dir.join(&a.file)).is_some_and(|s| s.size == a.size) {
                return 0;
            }
            let part = std::fs::metadata(part_path(dir, a)).map(|m| m.len()).unwrap_or(0);
            a.size.saturating_sub(part)
        })
        .sum()
}

fn part_path(dir: &Path, asset: &AssetSpec) -> PathBuf {
    dir.join(format!("{}.part", asset.file))
}

/// Free bytes on the volume holding `path` (or its nearest existing parent).
pub fn available_space(path: &Path) -> Option<u64> {
    let mut probe = path.to_path_buf();
    while !probe.exists() {
        if !probe.pop() {
            return None;
        }
    }
    #[cfg(unix)]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let c = CString::new(probe.as_os_str().as_bytes()).ok()?;
        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
        let rc = unsafe { libc::statvfs(c.as_ptr(), &mut stat) };
        if rc != 0 {
            return None;
        }
        Some(stat.f_bavail as u64 * stat.f_frsize as u64)
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let wide: Vec<u16> = probe.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let mut free: u64 = 0;
        // SAFETY: a NUL-terminated path, and one out-pointer to a live u64.
        unsafe { GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut free), None, None) }.ok()?;
        Some(free)
    }
    #[cfg(not(any(unix, windows)))]
    {
        None
    }
}

/// SHA-256 of a file as lowercase hex. Blocking — call via spawn_blocking.
/// ring's, which uses the CPU's SHA instructions: ~2.3 GB/s on an M2 Max,
/// where sha2's portable code does ~330 MB/s.
pub(crate) fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finish().as_ref().iter().map(|b| format!("{b:02x}")).collect())
}

/// What `download_all` is doing, for progress UI. Byte counts cover the whole
/// asset set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Progress {
    Downloading { done: u64, total: u64 },
    /// Hashing a finished file (can take a few seconds for hundreds of MB).
    Verifying { done: u64, total: u64 },
}

/// Download and verify every missing asset into `dir`. `progress` is called
/// as bytes arrive and when each file's hash check starts (throttle in the
/// caller if needed). Setting `cancel` stops at the next chunk; the `.part`
/// file is kept for resume.
pub async fn download_all(
    client: &reqwest::Client,
    dir: &Path,
    assets: &[AssetSpec],
    cancel: Arc<AtomicBool>,
    progress: impl Fn(Progress),
) -> Result<(), AssetError> {
    download_within(client, dir, assets, cancel, progress, available_space).await
}

/// [`download_all`], with the free space on `dir`'s volume from `free_space`.
async fn download_within(
    client: &reqwest::Client,
    dir: &Path,
    assets: &[AssetSpec],
    cancel: Arc<AtomicBool>,
    progress: impl Fn(Progress),
    free_space: impl Fn(&Path) -> Option<u64>,
) -> Result<(), AssetError> {
    tokio::fs::create_dir_all(dir).await?;

    let needed = remaining_bytes(dir, assets);
    if needed > 0 {
        if let Some(available) = free_space(dir) {
            if available < needed + DISK_HEADROOM_BYTES {
                return Err(AssetError::DiskFull {
                    needed_mb: (needed + DISK_HEADROOM_BYTES) / 1_000_000,
                    available_mb: available / 1_000_000,
                });
            }
        }
    }

    let total = total_bytes(assets);
    let label = dir_label(dir);
    let mut verified = read_verified(dir);
    let mut done_before: u64 = assets
        .iter()
        .filter(|a| checked_now(dir, a))
        .map(|a| a.size)
        .sum();
    progress(Progress::Downloading { done: done_before, total });

    for asset in assets {
        // What this run hashed is done; the rest is hashed (or fetched) here,
        // whatever its record says.
        if checked_now(dir, asset) {
            continue;
        }
        let final_path = dir.join(&asset.file);
        let part = part_path(dir, asset);

        // A file at its size without a current record (an older build's
        // verified.json, a crash between rename and record, a stamp that
        // moved, such as its volume's device number after an OS update) is
        // hashed where it is. Only one that fails is fetched again.
        if stamp_of(&final_path).is_some_and(|s| s.size == asset.size) {
            progress(Progress::Verifying { done: done_before + asset.size, total });
            if let Some(stamp) = pinned_stamp_async(&final_path, &asset.sha256).await? {
                let _ = tokio::fs::remove_file(&part).await;
                crate::log_to_file(&format!("[modules] {label}: {} verified in place", asset.file));
                record_verified(&mut verified, asset, &final_path, stamp);
                write_verified(dir, &verified)?;
                done_before += asset.size;
                continue;
            }
            crate::log_to_file(&format!("[modules] {label}: {} failed its checksum: downloading it again", asset.file));
            tokio::fs::remove_file(&final_path).await?;
        }
        // A partial file where the download lands resumes as the part.
        if final_path.exists() && !part.exists() {
            let _ = tokio::fs::rename(&final_path, &part).await;
        }

        let resume_at = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        crate::log_to_file(&format!(
            "[modules] {label}: downloading {} ({} MB{})",
            asset.file,
            asset.size / 1_000_000,
            if resume_at > 0 { format!(", resuming at {} MB", resume_at / 1_000_000) } else { String::new() }
        ));
        let started = std::time::Instant::now();
        fetch_resumable(client, asset, &part, cancel.clone(), |bytes| {
            progress(Progress::Downloading { done: done_before + bytes, total })
        })
        .await?;
        if cancel.load(Ordering::SeqCst) {
            return Err(AssetError::Cancelled);
        }

        progress(Progress::Verifying { done: done_before + asset.size, total });
        // A file written to while it was read isn't the file that hashed.
        if pinned_stamp_async(&part, &asset.sha256).await?.is_none() {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(AssetError::Checksum { file: asset.file.clone() });
        }
        tokio::fs::rename(&part, &final_path).await?;
        crate::log_to_file(&format!(
            "[modules] {label}: {} verified ({:.1}s)",
            asset.file,
            started.elapsed().as_secs_f64()
        ));
        // Stamped after the rename, which moves ctime.
        let stamp = stamp_of(&final_path)
            .ok_or_else(|| std::io::Error::other(format!("{} is gone after verifying", asset.file)))?;
        record_verified(&mut verified, asset, &final_path, stamp);
        write_verified(dir, &verified)?;
        done_before += asset.size;
    }
    Ok(())
}

/// "local-stt/2026-09-25" for `…/modules/local-stt/2026-09-25`: the module
/// and assets version, for log lines (and module_log_tail), without the
/// user's home path.
fn dir_label(dir: &Path) -> String {
    let parts: Vec<_> = dir.iter().rev().take(2).map(|p| p.to_string_lossy()).collect();
    parts.into_iter().rev().collect::<Vec<_>>().join("/")
}

/// Fetch one asset into `part`, resuming from its current length.
async fn fetch_resumable(
    client: &reqwest::Client,
    asset: &AssetSpec,
    part: &Path,
    cancel: Arc<AtomicBool>,
    on_bytes: impl Fn(u64),
) -> Result<(), AssetError> {
    let http_err = |message: String| AssetError::Http { file: asset.file.clone(), message };

    let mut have = tokio::fs::metadata(part).await.map(|m| m.len()).unwrap_or(0);
    if have > asset.size {
        tokio::fs::remove_file(part).await?;
        have = 0;
    }
    if have == asset.size {
        on_bytes(have);
        return Ok(());
    }

    let mut request = client.get(&asset.url);
    if have > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let mut response = request.send().await.map_err(|e| http_err(e.to_string()))?;

    let mut file = match response.status().as_u16() {
        206 => tokio::fs::OpenOptions::new().append(true).open(part).await?,
        200 => {
            // Server ignored the Range: start over.
            have = 0;
            tokio::fs::File::create(part).await?
        }
        416 if have > 0 => {
            // Range starts at/after the end: the part file is already whole.
            on_bytes(have);
            return Ok(());
        }
        status => return Err(http_err(format!("HTTP {status}"))),
    };

    on_bytes(have);
    while let Some(chunk) = response.chunk().await.map_err(|e| http_err(e.to_string()))? {
        if cancel.load(Ordering::SeqCst) {
            file.flush().await?;
            return Err(AssetError::Cancelled);
        }
        file.write_all(&chunk).await?;
        have += chunk.len() as u64;
        on_bytes(have);
    }
    file.flush().await?;

    if have != asset.size {
        return Err(http_err(format!("expected {} bytes, got {}", asset.size, have)));
    }
    Ok(())
}

/// Delete every assets version of a module except `keep`.
pub fn gc_other_versions(module_root: &Path, keep: &str) {
    let Ok(entries) = std::fs::read_dir(module_root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && entry.file_name() != keep {
            match std::fs::remove_dir_all(&path) {
                Ok(()) => crate::log_to_file(&format!("[modules] removed old assets {}", path.display())),
                Err(e) => crate::log_to_file(&format!("[modules] could not remove {}: {}", path.display(), e)),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// What a later app run starts with: nothing hashed yet under `dir`.
    fn new_run(dir: &Path) {
        checked().retain(|path, _| !path.starts_with(dir));
    }

    /// `path`'s bytes replaced with as many others, in place (same inode).
    fn swap_in_place(path: &Path) {
        let mut bytes = std::fs::read(path).unwrap();
        bytes[0] ^= 0xff;
        std::fs::write(path, bytes).unwrap();
    }

    /// What a process of the same user could write: a record for the file
    /// as it is now, claiming the pinned hash.
    fn forge_record(dir: &Path, asset: &AssetSpec) {
        let stamp = stamp_of(&dir.join(&asset.file)).unwrap();
        let forged = BTreeMap::from([(asset.file.clone(), Record { sha256: asset.sha256.clone(), stamp })]);
        write_verified(dir, &forged).unwrap();
    }

    async fn downloaded(body: &[u8]) -> (tempfile::TempDir, Vec<AssetSpec>) {
        let url = serve(body.to_vec(), true).await;
        let dir = tempfile::tempdir().unwrap();
        let assets = vec![spec(&url, body)];
        download_all(&reqwest::Client::new(), dir.path(), &assets, Arc::new(AtomicBool::new(false)), |_| {})
            .await
            .unwrap();
        assert!(all_verified(dir.path(), &assets));
        (dir, assets)
    }

    #[test]
    fn ring_hashes_like_sha2() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f");
        for len in [0usize, 1, 63, 64, 65, 1024 * 1024 + 7] {
            let bytes: Vec<u8> = (0..len).map(|i| (i * 31 % 251) as u8).collect();
            std::fs::write(&path, &bytes).unwrap();
            let want: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
            assert_eq!(sha256_file(&path).unwrap(), want, "{len} bytes");
        }
    }

    #[tokio::test]
    async fn a_same_size_swap_is_caught() {
        let body = body();
        // In place: ctime and mtime move.
        let (dir, assets) = downloaded(&body).await;
        swap_in_place(&dir.path().join("model.bin"));
        assert!(!all_verified(dir.path(), &assets));
        // A new file renamed over it: a new inode.
        let (dir, assets) = downloaded(&body).await;
        let mut other = body.clone();
        other[0] ^= 0xff;
        std::fs::write(dir.path().join("other"), &other).unwrap();
        std::fs::rename(dir.path().join("other"), dir.path().join("model.bin")).unwrap();
        assert!(!all_verified(dir.path(), &assets));
        // A symlink to a copy of the right bytes isn't the file either
        // (Windows needs Developer Mode or admin to make one: unix only).
        #[cfg(unix)]
        {
            let (dir, assets) = downloaded(&body).await;
            let copy = dir.path().join("copy");
            std::fs::copy(dir.path().join("model.bin"), &copy).unwrap();
            std::fs::remove_file(dir.path().join("model.bin")).unwrap();
            std::os::unix::fs::symlink(&copy, dir.path().join("model.bin")).unwrap();
            assert!(!all_verified(dir.path(), &assets));
        }
    }

    /// A record on disk says the files are there, never that a sidecar may
    /// load them: only a hash in this run does (the re-check, or the job).
    #[tokio::test]
    async fn only_this_runs_hash_lets_a_file_launch() {
        let (dir, assets) = downloaded(&body()).await;
        assert!(checked_this_run(dir.path(), &assets), "the download hashed it");
        new_run(dir.path());
        assert!(all_verified(dir.path(), &assets), "on disk");
        assert!(!checked_this_run(dir.path(), &assets), "but not hashed in this run");
        assert!(recheck(dir.path(), &assets));
        assert!(checked_this_run(dir.path(), &assets));

        // The job hashes a file its record vouches for too, where it is.
        new_run(dir.path());
        hash_in_place(dir.path(), &assets, TINY_DISK).await.unwrap();
        assert!(checked_this_run(dir.path(), &assets));

        // And a file changed since this run hashed it no longer launches.
        swap_in_place(&dir.path().join("model.bin"));
        assert!(!checked_this_run(dir.path(), &assets));
    }

    #[tokio::test]
    async fn a_rewritten_record_cannot_hide_a_swap_in_this_run() {
        let (dir, assets) = downloaded(&body()).await;
        swap_in_place(&dir.path().join("model.bin"));
        forge_record(dir.path(), &assets[0]);
        assert!(!all_verified(dir.path(), &assets), "the stamp hashed in this run decides");
    }

    #[tokio::test]
    async fn each_run_hashes_again_what_the_record_claims() {
        let (dir, assets) = downloaded(&body()).await;
        // A later run, the file intact: the re-check keeps it.
        new_run(dir.path());
        assert!(all_verified(dir.path(), &assets));
        assert!(recheck(dir.path(), &assets));
        assert!(all_verified(dir.path(), &assets));

        // Swapped while Native Intelligence was closed, and the record rewritten to match.
        new_run(dir.path());
        swap_in_place(&dir.path().join("model.bin"));
        forge_record(dir.path(), &assets[0]);
        assert!(all_verified(dir.path(), &assets), "only a hash can tell");
        assert!(!recheck(dir.path(), &assets));
        assert!(!all_verified(dir.path(), &assets), "the record is dropped");
        assert!(read_verified(dir.path()).is_empty());

        // A missing file fails the re-check too.
        std::fs::remove_file(dir.path().join("model.bin")).unwrap();
        assert!(!recheck(dir.path(), &assets));
    }

    /// Free space on a nearly full Mac: less than one model plus the
    /// headroom.
    const TINY_DISK: Option<u64> = Some(64 * 1024);

    /// Run the job's download with `free` bytes free and a URL that goes
    /// nowhere: it passes only if nothing needs fetching.
    async fn hash_in_place(dir: &Path, assets: &[AssetSpec], free: Option<u64>) -> Result<(), AssetError> {
        let client = reqwest::Client::new();
        download_within(&client, dir, assets, Arc::new(AtomicBool::new(false)), |_| {}, |_| free).await
    }

    /// The first launch after this update: the models are on disk and
    /// verified.json is the older `{file: sha256}`, which reads as no record.
    /// They're hashed where they are: no download, so no disk-space refusal.
    #[tokio::test]
    async fn an_old_record_rehashes_in_place_on_a_full_disk() {
        let body = body();
        let dir = tempfile::tempdir().unwrap();
        let assets = vec![spec("http://127.0.0.1:9", &body)];
        std::fs::write(dir.path().join("model.bin"), &body).unwrap();
        std::fs::write(
            dir.path().join(VERIFIED_FILE),
            serde_json::to_vec(&BTreeMap::from([("model.bin", assets[0].sha256.clone())])).unwrap(),
        )
        .unwrap();
        assert!(!all_verified(dir.path(), &assets));
        assert_eq!(remaining_bytes(dir.path(), &assets), 0);
        hash_in_place(dir.path(), &assets, TINY_DISK).await.unwrap();
        assert!(all_verified(dir.path(), &assets));
        new_run(dir.path());
        assert!(all_verified(dir.path(), &assets), "the new record holds across runs");
    }

    /// A stamp that moved without the bytes changing (an OS update can renumber
    /// the volume's st_dev) only costs a hash.
    #[tokio::test]
    async fn a_moved_stamp_rehashes_and_never_downloads() {
        let (dir, assets) = downloaded(&body()).await;
        new_run(dir.path());
        let mut stamp = stamp_of(&dir.path().join("model.bin")).unwrap();
        stamp.dev += 1;
        let record = Record { sha256: assets[0].sha256.clone(), stamp };
        write_verified(dir.path(), &BTreeMap::from([(assets[0].file.clone(), record)])).unwrap();
        assert!(!all_verified(dir.path(), &assets));
        assert_eq!(remaining_bytes(dir.path(), &assets), 0);
        let nowhere: Vec<AssetSpec> =
            assets.iter().map(|a| AssetSpec { url: "http://127.0.0.1:9/model.bin".into(), ..a.clone() }).collect();
        hash_in_place(dir.path(), &nowhere, TINY_DISK).await.unwrap();
        assert!(all_verified(dir.path(), &assets));
    }

    /// A file at its size with the wrong bytes is fetched again (into the
    /// space it frees), not reported as an error.
    #[tokio::test]
    async fn a_bad_file_in_place_is_downloaded_again() {
        let (dir, assets) = downloaded(&body()).await;
        new_run(dir.path());
        swap_in_place(&dir.path().join("model.bin"));
        assert!(!all_verified(dir.path(), &assets));
        download_all(&reqwest::Client::new(), dir.path(), &assets, Arc::new(AtomicBool::new(false)), |_| {})
            .await
            .unwrap();
        assert!(all_verified(dir.path(), &assets));
        assert_eq!(std::fs::read(dir.path().join("model.bin")).unwrap(), body());
    }

    /// A real download still needs room for itself.
    #[tokio::test]
    async fn a_missing_file_still_needs_the_space() {
        let body = body();
        let dir = tempfile::tempdir().unwrap();
        let assets = vec![spec("http://127.0.0.1:9", &body)];
        let err = hash_in_place(dir.path(), &assets, TINY_DISK).await.unwrap_err();
        assert!(matches!(err, AssetError::DiskFull { .. }), "{err}");
    }

    #[test]
    fn dir_label_is_module_and_version_without_the_home_path() {
        let dir = Path::new("/Users/pat/Library/Application Support/ai.dial8.desktop/modules/local-stt/2026-09-25");
        assert_eq!(dir_label(dir), "local-stt/2026-09-25");
    }

    /// Minimal HTTP/1.1 file server with Range support, one request per
    /// connection. Returns the base URL.
    async fn serve(body: Vec<u8>, honor_range: bool) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let body = Arc::new(body);
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let body = body.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_lowercase();
                    let start = req
                        .lines()
                        .find_map(|l| l.strip_prefix("range: bytes="))
                        .and_then(|r| r.trim_end_matches('-').trim().trim_end_matches('-').parse::<usize>().ok());
                    let (status, slice) = match start {
                        Some(s) if honor_range && s >= body.len() => ("416 Range Not Satisfiable", &body[0..0]),
                        Some(s) if honor_range => ("206 Partial Content", &body[s..]),
                        _ => ("200 OK", &body[..]),
                    };
                    let head = format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        slice.len()
                    );
                    let _ = sock.write_all(head.as_bytes()).await;
                    let _ = sock.write_all(slice).await;
                });
            }
        });
        format!("http://{addr}")
    }

    fn spec(url: &str, body: &[u8]) -> AssetSpec {
        AssetSpec {
            name: "model".into(),
            file: "model.bin".into(),
            url: format!("{url}/model.bin"),
            sha256: Sha256::digest(body).iter().map(|b| format!("{b:02x}")).collect(),
            size: body.len() as u64,
        }
    }

    fn body() -> Vec<u8> {
        (0..200_000u32).map(|i| (i % 251) as u8).collect()
    }

    #[tokio::test]
    async fn downloads_verifies_and_records() {
        let body = body();
        let url = serve(body.clone(), true).await;
        let dir = tempfile::tempdir().unwrap();
        let assets = vec![spec(&url, &body)];
        let seen = std::sync::Mutex::new(Vec::new());
        download_all(&reqwest::Client::new(), dir.path(), &assets, Arc::new(AtomicBool::new(false)), |p| {
            seen.lock().unwrap().push(p);
        })
        .await
        .unwrap();
        assert!(all_verified(dir.path(), &assets));
        assert_eq!(std::fs::read(dir.path().join("model.bin")).unwrap(), body);
        assert!(!dir.path().join("model.bin.part").exists());
        let seen = seen.into_inner().unwrap();
        let n = body.len() as u64;
        assert_eq!(seen.last(), Some(&Progress::Verifying { done: n, total: n }));
        assert!(seen.contains(&Progress::Downloading { done: n, total: n }));
    }

    #[tokio::test]
    async fn resumes_from_part_file() {
        let body = body();
        let url = serve(body.clone(), true).await;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("model.bin.part"), &body[..50_000]).unwrap();
        let assets = vec![spec(&url, &body)];
        download_all(&reqwest::Client::new(), dir.path(), &assets, Arc::new(AtomicBool::new(false)), |_| {})
            .await
            .unwrap();
        assert_eq!(std::fs::read(dir.path().join("model.bin")).unwrap(), body);
    }

    #[tokio::test]
    async fn restarts_when_server_ignores_range() {
        let body = body();
        let url = serve(body.clone(), false).await;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("model.bin.part"), &body[..50_000]).unwrap();
        let assets = vec![spec(&url, &body)];
        download_all(&reqwest::Client::new(), dir.path(), &assets, Arc::new(AtomicBool::new(false)), |_| {})
            .await
            .unwrap();
        assert_eq!(std::fs::read(dir.path().join("model.bin")).unwrap(), body);
    }

    #[tokio::test]
    async fn checksum_mismatch_discards_download() {
        let body = body();
        let url = serve(body.clone(), true).await;
        let dir = tempfile::tempdir().unwrap();
        let mut asset = spec(&url, &body);
        asset.sha256 = "00".repeat(32);
        let err = download_all(&reqwest::Client::new(), dir.path(), &[asset.clone()], Arc::new(AtomicBool::new(false)), |_| {})
            .await
            .unwrap_err();
        assert!(matches!(err, AssetError::Checksum { .. }), "{err}");
        assert!(!dir.path().join("model.bin").exists());
        assert!(!dir.path().join("model.bin.part").exists());
        assert!(!all_verified(dir.path(), &[asset]));
    }

    #[tokio::test]
    async fn cancel_keeps_part_for_resume() {
        let body = body();
        let url = serve(body.clone(), true).await;
        let dir = tempfile::tempdir().unwrap();
        let assets = vec![spec(&url, &body)];
        let err = download_all(&reqwest::Client::new(), dir.path(), &assets, Arc::new(AtomicBool::new(true)), |_| {})
            .await
            .unwrap_err();
        assert!(matches!(err, AssetError::Cancelled), "{err}");
        assert!(!all_verified(dir.path(), &assets));
    }

    #[tokio::test]
    async fn verified_record_short_circuits_and_detects_tampering() {
        let body = body();
        let url = serve(body.clone(), true).await;
        let dir = tempfile::tempdir().unwrap();
        let assets = vec![spec(&url, &body)];
        download_all(&reqwest::Client::new(), dir.path(), &assets, Arc::new(AtomicBool::new(false)), |_| {})
            .await
            .unwrap();
        // Truncated file no longer counts as verified (size check).
        std::fs::write(dir.path().join("model.bin"), &body[..10]).unwrap();
        assert!(!all_verified(dir.path(), &assets));
        // Neither does the right size again, written since it was hashed.
        std::fs::write(dir.path().join("model.bin"), &body).unwrap();
        assert!(!all_verified(dir.path(), &assets));
    }

    #[test]
    fn gc_keeps_only_current_version() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("v1")).unwrap();
        std::fs::create_dir_all(root.path().join("v2")).unwrap();
        gc_other_versions(root.path(), "v2");
        assert!(!root.path().join("v1").exists());
        assert!(root.path().join("v2").exists());
    }

    #[test]
    fn available_space_reports_for_existing_parent() {
        let dir = tempfile::tempdir().unwrap();
        assert!(available_space(&dir.path().join("does/not/exist")).unwrap() > 0);
    }
}
