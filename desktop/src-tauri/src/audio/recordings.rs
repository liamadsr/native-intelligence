//! The WAVs each capture leaves in the temp dir.
//!
//! A capture writes `<temp>/dial8/<session uuid>/{mic,system}.wav`
//! (16 kHz mono 32-bit float: ~460 MB per hour of capture for the two) and
//! nothing reads them back. They are only the raw audio a crashed capture
//! could still be recovered from, so the latest few are worth keeping. macOS
//! clears the temp dir at a restart, and until then they used to pile up
//! (macOS filed "disk writes" reports against Dial8 for it). Now the newest
//! [`KEEP_NEWEST`] from the last [`KEEP_FOR`] are kept and the rest go, at
//! launch and after each capture stops, on a thread of their own.
//!
//! Only a capture's own folder is ever removed: a UUID-named directory
//! holding nothing but `mic.wav` / `system.wav`. The same parent also holds
//! the modules fallback (`modules/`) and dev voice captures
//! (`voice-captures/`), which never match.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// The most capture recordings kept.
pub const KEEP_NEWEST: usize = 5;
/// The oldest a kept recording may be.
pub const KEEP_FOR: Duration = Duration::from_secs(3 * 24 * 60 * 60);

/// The files a capture writes into its folder.
const CAPTURE_FILES: [&str; 2] = ["mic.wav", "system.wav"];

/// Where captures write their recordings (commands/recording.rs).
pub fn base_dir() -> PathBuf {
    std::env::temp_dir().join("dial8")
}

/// Delete the old recordings on a thread of its own; `when` names the
/// moment for the log. Never blocks, never fails the caller.
pub fn prune_in_background(when: &'static str) {
    let spawned = std::thread::Builder::new().name("recordings-prune".into()).spawn(move || {
        let removed = prune(&base_dir(), KEEP_NEWEST, KEEP_FOR, SystemTime::now());
        if !removed.is_empty() {
            let bytes: u64 = removed.iter().map(|r| r.bytes).sum();
            crate::log_to_file(&format!(
                "[recordings] {when}: removed {} old capture recording(s), {} MB",
                removed.len(),
                bytes / 1_000_000
            ));
        }
    });
    if let Err(e) = spawned {
        crate::log_to_file(&format!("[recordings] {when}: couldn't start the prune: {e}"));
    }
}

/// A removed capture folder and the bytes it held.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Removed {
    pub dir: PathBuf,
    pub bytes: u64,
}

/// A capture folder under the base: when it was last written and its size.
struct Recording {
    dir: PathBuf,
    written: SystemTime,
    bytes: u64,
}

/// Remove the capture folders under `base` past the newest `keep_newest` or
/// last written before `now - keep_for`. Returns what it removed; anything it
/// can't read or remove is left as it is.
pub fn prune(base: &Path, keep_newest: usize, keep_for: Duration, now: SystemTime) -> Vec<Removed> {
    let Ok(entries) = std::fs::read_dir(base) else { return Vec::new() };
    let mut recordings: Vec<Recording> = entries.filter_map(|e| recording(&e.ok()?.path())).collect();
    // Newest first.
    recordings.sort_by(|a, b| b.written.cmp(&a.written));
    let oldest_kept = now.checked_sub(keep_for).unwrap_or(SystemTime::UNIX_EPOCH);
    recordings
        .into_iter()
        .enumerate()
        .filter(|(i, r)| *i >= keep_newest || r.written < oldest_kept)
        .filter_map(|(_, r)| std::fs::remove_dir_all(&r.dir).ok().map(|()| Removed { dir: r.dir, bytes: r.bytes }))
        .collect()
}

/// `dir` as a capture's recording: a UUID-named directory whose entries are
/// all capture WAVs (at least one). `None` for anything else.
fn recording(dir: &Path) -> Option<Recording> {
    let name = dir.file_name()?.to_str()?;
    uuid::Uuid::parse_str(name).ok()?;
    if !std::fs::symlink_metadata(dir).ok()?.is_dir() {
        return None;
    }
    let mut written = None::<SystemTime>;
    let mut bytes = 0;
    let mut files = 0;
    for entry in std::fs::read_dir(dir).ok()? {
        let entry = entry.ok()?;
        let meta = entry.metadata().ok()?;
        let file_name = entry.file_name();
        if !meta.is_file() || !CAPTURE_FILES.iter().any(|f| file_name == *f) {
            return None;
        }
        let modified = meta.modified().ok()?;
        written = Some(written.map_or(modified, |w| w.max(modified)));
        bytes += meta.len();
        files += 1;
    }
    let written = written?;
    (files > 0).then(|| Recording { dir: dir.to_path_buf(), written, bytes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

    const HOUR: Duration = Duration::from_secs(60 * 60);

    /// A capture folder with `files`, last written `ago` before `now`.
    fn capture(base: &Path, files: &[&str], now: SystemTime, ago: Duration) -> PathBuf {
        let dir = base.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).unwrap();
        for name in files {
            let file = File::create(dir.join(name)).unwrap();
            file.set_len(1_000).unwrap();
            file.set_modified(now - ago).unwrap();
        }
        dir
    }

    #[test]
    fn keeps_the_newest_and_removes_the_rest() {
        let tmp = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        let dirs: Vec<PathBuf> =
            (0..7u32).map(|i| capture(tmp.path(), &CAPTURE_FILES, now, HOUR * (i + 1))).collect();

        let removed = prune(tmp.path(), 5, KEEP_FOR, now);

        let removed_dirs: Vec<&PathBuf> = removed.iter().map(|r| &r.dir).collect();
        assert_eq!(removed_dirs, vec![&dirs[5], &dirs[6]], "the two oldest go");
        assert!(dirs[..5].iter().all(|d| d.exists()), "the newest five stay");
        assert_eq!(removed[0].bytes, 2_000);
    }

    #[test]
    fn removes_anything_older_than_keep_for() {
        let tmp = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        let fresh = capture(tmp.path(), &["mic.wav"], now, HOUR);
        let stale = capture(tmp.path(), &["mic.wav"], now, KEEP_FOR + HOUR);

        let removed = prune(tmp.path(), 5, KEEP_FOR, now);

        assert_eq!(removed.len(), 1);
        assert!(fresh.exists() && !stale.exists());
    }

    #[test]
    fn a_folder_still_being_written_counts_as_new() {
        // An old mic.wav beside a system.wav written a minute ago: the newest
        // file decides.
        let tmp = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        let dir = capture(tmp.path(), &["mic.wav"], now, KEEP_FOR + HOUR);
        let system = File::create(dir.join("system.wav")).unwrap();
        system.set_modified(now - Duration::from_secs(60)).unwrap();

        assert!(prune(tmp.path(), 5, KEEP_FOR, now).is_empty());
        assert!(dir.exists());
    }

    #[test]
    fn never_touches_anything_but_a_capture_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        let old = KEEP_FOR * 10;
        // The modules fallback and dev voice captures share the parent.
        let modules = tmp.path().join("modules").join("local-stt");
        std::fs::create_dir_all(&modules).unwrap();
        File::create(modules.join("model.bin")).unwrap().set_modified(now - old).unwrap();
        let voice = tmp.path().join("voice-captures");
        std::fs::create_dir_all(&voice).unwrap();
        File::create(voice.join("mic.wav")).unwrap().set_modified(now - old).unwrap();
        // A UUID folder holding something a capture doesn't write.
        let other = capture(tmp.path(), &["mic.wav", "notes.txt"], now, old);
        // An empty UUID folder: a capture that is just starting.
        let starting = tmp.path().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&starting).unwrap();
        // A plain file with a UUID name.
        let file = tmp.path().join(uuid::Uuid::new_v4().to_string());
        File::create(&file).unwrap().set_modified(now - old).unwrap();

        assert!(prune(tmp.path(), 0, Duration::ZERO, now).is_empty());
        assert!(modules.exists() && voice.exists() && other.exists() && starting.exists() && file.exists());
    }

    #[test]
    fn a_missing_base_is_nothing_to_do() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(prune(&tmp.path().join("absent"), 5, KEEP_FOR, SystemTime::now()).is_empty());
    }
}
