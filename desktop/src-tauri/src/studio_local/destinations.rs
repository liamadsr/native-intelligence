//! Where an export is saved: a place the person picked in the native save
//! panel, known to the page only by a random id and its file name.
//!
//! - The id is single-use for writing: one save (or one export) claims it;
//!   a failed write gives it back, a finished one uses it up. A picked id
//!   lasts until the app quits, or 24 hours, in memory only. A WRITTEN one is
//!   also kept on disk ([`Destinations::with_store`]: id, folder, name, when;
//!   owner-only, at most 200, 90 days, dropped once the file is gone), so
//!   "Show in Finder / Explorer" works for a video saved in an earlier run.
//! - The folder is resolved to its real path when picked, and checked again
//!   before anything is written: a folder swapped for a link in between is
//!   refused.
//! - A write goes to a new hidden file beside the destination (`create_new`,
//!   so it never follows a link; the hidden attribute on Windows), marked as
//!   downloaded before any byte lands (`com.apple.quarantine` on macOS,
//!   Mark-of-the-Web on Windows, as `save_file` marks a file), then renamed
//!   over the name the person chose (a few tries on Windows, where a player
//!   or a virus scanner may hold a file a moment). A link or a folder at
//!   that name is refused rather than written through. A failed or
//!   cancelled write leaves nothing under the chosen name, and a failed move
//!   of a finished export leaves the video where it was ([`place_file`]).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// How long a picked destination can be written.
pub const DESTINATION_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// At most this many picked places are remembered (the oldest go first).
const MAX_DESTINATIONS: usize = 64;
/// The longest file name kept from a suggestion, in characters, before `.mp4`.
const MAX_STEM: usize = 120;
/// Saved places kept on disk for revealing, at most, and for how long.
const MAX_SAVED: usize = 200;
const SAVED_FOR_SECS: u64 = 90 * 24 * 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Use {
    Free,
    Busy,
    Written,
}

#[derive(Debug, Clone)]
struct Dest {
    /// The folder's real path when it was picked.
    dir: PathBuf,
    name: String,
    picked: Instant,
    state: Use,
}

/// A destination claimed for one write.
#[derive(Debug, Clone, PartialEq)]
pub struct Claim {
    pub id: String,
    pub dir: PathBuf,
    pub name: String,
}

/// A written destination, as kept on disk.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct SavedPlace {
    id: String,
    dir: PathBuf,
    name: String,
    /// Seconds since 1970.
    at: u64,
}

#[derive(Default)]
pub struct Destinations {
    map: Mutex<HashMap<String, Dest>>,
    /// The file written destinations are kept in, if any.
    store: Option<PathBuf>,
    store_lock: Mutex<()>,
}

/// A destination id as this app makes them (a v4 uuid, hyphenated). Pure.
pub fn valid_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|u| u.hyphenated().to_string() == id)
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl Destinations {
    /// Destinations whose written ones are kept in `store` too.
    pub fn with_store(store: PathBuf) -> Self {
        Self { store: Some(store), ..Default::default() }
    }

    /// Remember a picked place; its id.
    pub fn add(&self, dir: PathBuf, name: String) -> String {
        self.add_at(dir, name, Instant::now())
    }

    fn add_at(&self, dir: PathBuf, name: String, now: Instant) -> String {
        let id = uuid::Uuid::new_v4().hyphenated().to_string();
        let mut map = self.map.lock().unwrap();
        map.retain(|_, d| now.duration_since(d.picked) < DESTINATION_TTL || d.state == Use::Busy);
        while map.len() >= MAX_DESTINATIONS {
            let Some(oldest) = map.iter().filter(|(_, d)| d.state != Use::Busy).min_by_key(|(_, d)| d.picked).map(|(k, _)| k.clone()) else {
                break;
            };
            map.remove(&oldest);
        }
        map.insert(id.clone(), Dest { dir, name, picked: now, state: Use::Free });
        id
    }

    /// Claim `id` for one write.
    pub fn claim(&self, id: &str) -> Result<Claim, String> {
        self.claim_at(id, Instant::now())
    }

    fn claim_at(&self, id: &str, now: Instant) -> Result<Claim, String> {
        if !valid_id(id) {
            return Err("bad-request: That is not a place to save the app knows.".into());
        }
        let mut map = self.map.lock().unwrap();
        let Some(d) = map.get_mut(id) else {
            if self.saved(id).is_some() {
                return Err("used: A file was already saved there. Pick a place again to save another.".into());
            }
            return Err("unknown-destination: That place to save is not known to the app any more. Pick it again.".into());
        };
        if now.duration_since(d.picked) >= DESTINATION_TTL {
            map.remove(id);
            return Err("unknown-destination: That place to save is not known to the app any more. Pick it again.".into());
        }
        match d.state {
            Use::Busy => Err("busy: Something is already being saved there.".into()),
            Use::Written => Err("used: A file was already saved there. Pick a place again to save another.".into()),
            Use::Free => {
                d.state = Use::Busy;
                Ok(Claim { id: id.to_string(), dir: d.dir.clone(), name: d.name.clone() })
            }
        }
    }

    /// End a claim: `written` uses the destination up (and keeps it on disk
    /// for revealing); otherwise it can be claimed again.
    pub fn release(&self, id: &str, written: bool) {
        let place = {
            let mut map = self.map.lock().unwrap();
            let Some(d) = map.get_mut(id) else { return };
            d.state = if written { Use::Written } else { Use::Free };
            written.then(|| SavedPlace { id: id.to_string(), dir: d.dir.clone(), name: d.name.clone(), at: now_secs() })
        };
        if let Some(place) = place {
            if let Err(e) = self.keep(place) {
                crate::log_to_file(&format!("[studio-local] could not keep a saved place: {e}"));
            }
        }
    }

    /// The saved file of a destination written by this app (this run, or one
    /// kept on disk from an earlier run), for revealing it.
    pub fn written_file(&self, id: &str) -> Option<PathBuf> {
        if let Some(d) = self.map.lock().unwrap().get(id).filter(|d| d.state == Use::Written) {
            return Some(d.dir.join(&d.name));
        }
        self.saved(id).map(|p| p.dir.join(&p.name))
    }

    fn read_store(&self) -> Vec<SavedPlace> {
        let Some(path) = &self.store else { return Vec::new() };
        let Ok(meta) = std::fs::symlink_metadata(path) else { return Vec::new() };
        if !meta.is_file() || meta.len() > 1024 * 1024 {
            return Vec::new();
        }
        std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    /// The places still worth keeping: young enough, their file still there.
    fn live(list: Vec<SavedPlace>, now: u64) -> Vec<SavedPlace> {
        let mut kept: Vec<SavedPlace> = list
            .into_iter()
            .filter(|p| valid_id(&p.id) && now.saturating_sub(p.at) < SAVED_FOR_SECS)
            .filter(|p| std::fs::symlink_metadata(p.dir.join(&p.name)).is_ok_and(|m| m.is_file()))
            .collect();
        let excess = kept.len().saturating_sub(MAX_SAVED);
        kept.drain(..excess);
        kept
    }

    fn saved(&self, id: &str) -> Option<SavedPlace> {
        let _one = self.store_lock.lock().unwrap();
        Self::live(self.read_store(), now_secs()).into_iter().find(|p| p.id == id)
    }

    fn keep(&self, place: SavedPlace) -> std::io::Result<()> {
        let Some(path) = &self.store else { return Ok(()) };
        let _one = self.store_lock.lock().unwrap();
        let mut list = self.read_store();
        list.retain(|p| p.id != place.id);
        list.push(place);
        let list = Self::live(list, now_secs());
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        let written = (|| {
            let mut f = o.open(&tmp)?;
            f.write_all(&serde_json::to_vec(&list).map_err(std::io::Error::other)?)?;
            f.sync_all()?;
            std::fs::rename(&tmp, path)
        })();
        if written.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        written
    }
}

/// Windows' reserved device names, refused as file names on every computer
/// (an export may be copied there): with the digit 0 and the superscript
/// digits Windows also reserves, and the console names.
const RESERVED: [&str; 32] = [
    "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "COM¹",
    "COM²", "COM³", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "LPT¹", "LPT²", "LPT³",
];

/// A file name from the page's suggestion: no folders, no characters either
/// system refuses, no reserved device name, no leading dot, at most
/// [`MAX_STEM`] characters, ending in `.mp4`. Never empty. Pure.
pub fn sanitize_name(suggested: &str) -> String {
    // The last path component only, whichever separator.
    let last = suggested.rsplit(['/', '\\']).next().unwrap_or("");
    let mut stem: String = last
        .chars()
        .map(|c| if c.is_control() || "<>:\"|?*".contains(c) { ' ' } else { c })
        .collect();
    // Its own extension goes: the export is an MP4.
    if let Some(dot) = stem.rfind('.') {
        if dot > 0 {
            stem.truncate(dot);
        }
    }
    let collapsed = stem.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut stem: String = collapsed.trim_start_matches(['.', ' ']).trim_end_matches(['.', ' ']).chars().take(MAX_STEM).collect();
    stem = stem.trim_end_matches(['.', ' ']).to_string();
    if stem.is_empty() {
        stem = "Video".into();
    }
    let base = stem.split('.').next().unwrap_or("").to_uppercase();
    if RESERVED.contains(&base.trim()) {
        stem = format!("{stem} video");
    }
    format!("{stem}.mp4")
}

/// The name the person picked with `.mp4` forced: a picked name that ends
/// otherwise gets `.mp4` added (or put in place of `.mov` and the like).
/// Pure.
pub fn force_mp4(name: &str) -> String {
    if name.to_ascii_lowercase().ends_with(".mp4") {
        return name.to_string();
    }
    let stem = match name.rfind('.') {
        Some(dot) if dot > 0 && name.len() - dot <= 5 => &name[..dot],
        _ => name,
    };
    format!("{stem}.mp4")
}

/// The final path of a claim, after checking the folder is still the one
/// picked (its real path unchanged) and nothing but a plain file is at the
/// name.
pub fn checked_target(c: &Claim) -> Result<PathBuf, String> {
    let real = std::fs::canonicalize(&c.dir).map_err(|_| "gone: The folder you picked is not there any more.".to_string())?;
    if real != c.dir {
        return Err("moved: The folder you picked has changed since. Pick the place again.".into());
    }
    let target = real.join(&c.name);
    match std::fs::symlink_metadata(&target) {
        Ok(m) if !m.is_file() => Err("not-a-file: Something other than a file is at that name. Pick another name.".into()),
        _ => Ok(target),
    }
}

/// A hidden file beside the destination, marked as downloaded, open for
/// writing. Nothing at the chosen name changes until [`finish`].
pub struct TempFile {
    pub path: PathBuf,
    pub file: std::fs::File,
}

/// A temp file's name beside a destination.
fn temp_name(dir: &Path) -> PathBuf {
    dir.join(format!(".ni-{}.download", uuid::Uuid::new_v4().simple()))
}

pub fn temp_beside(dir: &Path) -> std::io::Result<TempFile> {
    let path = temp_name(dir);
    let mut o = std::fs::OpenOptions::new();
    o.write(true).read(true).create_new(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_ATTRIBUTE_HIDDEN: the dot hides nothing on Windows.
        o.attributes(0x2);
    }
    let file = o.open(&path)?;
    if let Err(e) = crate::commands::files::mark_downloaded(&file, &path) {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err(std::io::Error::new(e.kind(), format!("couldn't mark the file as downloaded: {e}")));
    }
    Ok(TempFile { path, file })
}

/// Windows: clear the hidden attribute (the saved video must not stay hidden).
#[cfg(windows)]
fn unhide(path: &Path) {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::{GetFileAttributesW, SetFileAttributesW, FILE_FLAGS_AND_ATTRIBUTES};
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let name = windows::core::PCWSTR(wide.as_ptr());
    // SAFETY: a NUL-terminated wide path that outlives both calls.
    unsafe {
        let attrs = GetFileAttributesW(name);
        if attrs != u32::MAX && attrs & 0x2 != 0 {
            let _ = SetFileAttributesW(name, FILE_FLAGS_AND_ATTRIBUTES(attrs & !0x2));
        }
    }
}

/// Rename `from` over `to`. On Windows a player or a virus scanner may hold
/// either file a moment: a few tries, a little apart.
fn rename_into_place(from: &Path, to: &Path) -> std::io::Result<()> {
    let tries = if cfg!(windows) { 6 } else { 1 };
    let mut last = None;
    for i in 0..tries {
        if i > 0 {
            std::thread::sleep(Duration::from_millis(250 * i as u64));
        }
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(e),
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("rename failed")))
}

/// Rename a finished file beside the destination over the claim's name
/// (checked again first). On an error the file is left where it is: the
/// caller decides (a download is removed, a finished export put back).
fn finish_at(path: &Path, file: std::fs::File, c: &Claim) -> Result<PathBuf, String> {
    let synced = file.sync_all();
    drop(file);
    synced.map_err(|e| format!("write: {e}"))?;
    let target = checked_target(c)?;
    #[cfg(windows)]
    unhide(path);
    rename_into_place(path, &target).map_err(|e| format!("write: {e}"))?;
    Ok(target)
}

/// Rename a finished temp file over the claim's name; a failure removes it.
pub fn finish(temp: TempFile, c: &Claim) -> Result<PathBuf, String> {
    let TempFile { path, file } = temp;
    let result = finish_at(&path, file, c);
    if result.is_err() {
        let _ = std::fs::remove_file(&path);
    }
    result
}

/// Open a file for reading without following a link at its name.
fn open_no_follow(path: &Path, write: bool) -> std::io::Result<std::fs::File> {
    let mut o = std::fs::OpenOptions::new();
    o.read(true).write(write);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT: the link itself, never its target.
        o.custom_flags(0x0020_0000);
    }
    let file = o.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::other("not a plain file"));
    }
    Ok(file)
}

/// The runner's output is a plain file of its own, not a link.
fn plain_source(src: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(src) {
        Ok(m) if m.is_file() => Ok(()),
        Ok(_) => Err("not-a-file: The exporter's file is not a plain file.".into()),
        Err(e) => Err(format!("gone: The exporter's file is not there ({e}).")),
    }
}

/// Put a finished file (the runner's, in its work folder) at a claim:
/// renamed beside the destination when on the same volume, copied there
/// otherwise (stopping when `cancel` is set); marked; then renamed over the
/// chosen name. On any failure the video stays at `src` (put back there if
/// it had been moved) and nothing is under the chosen name.
pub fn place_file(src: &Path, c: &Claim, cancel: &AtomicBool) -> Result<PathBuf, String> {
    place_file_with(src, c, cancel, || {})
}

/// [`place_file`], with `before_finish` run just before the final rename
/// (a test makes the destination change there).
fn place_file_with(src: &Path, c: &Claim, cancel: &AtomicBool, before_finish: impl FnOnce()) -> Result<PathBuf, String> {
    plain_source(src)?;
    let _ = checked_target(c)?;
    // Same volume: renamed beside the destination (a random name), then marked.
    let beside = temp_name(&c.dir);
    if std::fs::rename(src, &beside).is_ok() {
        before_finish();
        let marked = open_no_follow(&beside, true).and_then(|file| crate::commands::files::mark_downloaded(&file, &beside).map(|_| file));
        let placed = match marked {
            Ok(file) => finish_at(&beside, file, c),
            Err(e) => Err(format!("write: couldn't mark the file as downloaded: {e}")),
        };
        if placed.is_err() {
            // Back where it was: the video is not lost.
            if std::fs::rename(&beside, src).is_err() {
                crate::log_to_file("[studio-local] a finished export could not be put back in the work folder; it is beside the destination");
            }
        }
        return placed;
    }
    copy_into(src, c, cancel)
}

/// Another volume: copied into a new marked file beside the destination,
/// then renamed into place; `src` goes only once the copy is in place.
fn copy_into(src: &Path, c: &Claim, cancel: &AtomicBool) -> Result<PathBuf, String> {
    let mut from = open_no_follow(src, false).map_err(|e| format!("not-a-file: The exporter's file could not be read ({e})."))?;
    let mut temp = temp_beside(&c.dir).map_err(|e| format!("write: {e}"))?;
    let copied = (|| -> Result<(), String> {
        let mut buf = vec![0u8; 1024 * 1024];
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err("cancelled: The save was stopped.".into());
            }
            let n = from.read(&mut buf).map_err(|e| format!("write: {e}"))?;
            if n == 0 {
                break;
            }
            temp.file.write_all(&buf[..n]).map_err(|e| format!("write: {e}"))?;
        }
        temp.file.flush().map_err(|e| format!("write: {e}"))
    })();
    if let Err(e) = copied {
        let _ = std::fs::remove_file(&temp.path);
        return Err(e);
    }
    let target = finish(temp, c)?;
    let _ = std::fs::remove_file(src);
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggested_names_are_made_safe() {
        assert_eq!(sanitize_name("Spring launch.mp4"), "Spring launch.mp4");
        assert_eq!(sanitize_name("Spring launch"), "Spring launch.mp4");
        assert_eq!(sanitize_name("../../etc/passwd"), "passwd.mp4");
        assert_eq!(sanitize_name("C:\\Windows\\evil.exe"), "evil.mp4");
        assert_eq!(sanitize_name("a<b>c:d|e?f*g\"h.mov"), "a b c d e f g h.mp4");
        assert_eq!(sanitize_name(".hidden"), ".hidden".trim_start_matches('.').to_string() + ".mp4");
        assert_eq!(sanitize_name("..."), "Video.mp4");
        assert_eq!(sanitize_name(""), "Video.mp4");
        assert_eq!(sanitize_name("CON"), "CON video.mp4");
        assert_eq!(sanitize_name("nul.txt"), "nul video.mp4");
        for reserved in ["COM0", "lpt0", "COM¹", "lpt³", "CONIN$", "conout$.mov"] {
            assert!(sanitize_name(reserved).ends_with(" video.mp4"), "{reserved}");
        }
        assert_eq!(sanitize_name("COM10"), "COM10.mp4");
        assert_eq!(sanitize_name("line\nbreak\ttab"), "line break tab.mp4");
        assert_eq!(sanitize_name("trailing. . "), "trailing.mp4");
        let long = "x".repeat(400);
        assert_eq!(sanitize_name(&long).chars().count(), MAX_STEM + 4);
    }

    #[test]
    fn picked_names_end_in_mp4() {
        assert_eq!(force_mp4("a.mp4"), "a.mp4");
        assert_eq!(force_mp4("a.MP4"), "a.MP4");
        assert_eq!(force_mp4("a.mov"), "a.mp4");
        assert_eq!(force_mp4("a"), "a.mp4");
        assert_eq!(force_mp4("v1.2 final"), "v1.2 final.mp4");
    }

    #[test]
    fn a_destination_is_written_once() {
        let d = Destinations::default();
        let id = d.add(PathBuf::from("/x"), "a.mp4".into());
        assert!(valid_id(&id));
        assert!(d.written_file(&id).is_none(), "nothing to reveal before it is written");
        let c = d.claim(&id).unwrap();
        assert_eq!((c.dir.as_path(), c.name.as_str()), (Path::new("/x"), "a.mp4"));
        assert!(d.claim(&id).unwrap_err().starts_with("busy"));
        d.release(&id, false);
        d.claim(&id).unwrap();
        d.release(&id, true);
        assert!(d.claim(&id).unwrap_err().starts_with("used"));
        assert_eq!(d.written_file(&id), Some(PathBuf::from("/x/a.mp4")));
        assert!(d.claim("nope").unwrap_err().starts_with("bad-request"));
        assert!(d.claim(&id).unwrap_err().starts_with("used"));
        assert!(d.claim(&uuid::Uuid::new_v4().to_string()).unwrap_err().starts_with("unknown-destination"));
    }

    #[test]
    fn a_destination_expires() {
        let d = Destinations::default();
        let then = Instant::now();
        let id = d.add_at(PathBuf::from("/x"), "a.mp4".into(), then);
        assert!(d.claim_at(&id, then + DESTINATION_TTL).unwrap_err().starts_with("unknown-destination"));
    }

    fn claim_in(dir: &Path, name: &str) -> Claim {
        Claim { id: "x".into(), dir: std::fs::canonicalize(dir).unwrap(), name: name.into() }
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[test]
    fn a_file_is_placed_whole_and_its_source_goes() {
        let dir = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let src = work.path().join("job.mp4");
        std::fs::write(&src, b"video bytes").unwrap();
        let c = claim_in(dir.path(), "My video.mp4");
        let placed = place_file(&src, &c, &AtomicBool::new(false)).unwrap();
        assert_eq!(std::fs::read(&placed).unwrap(), b"video bytes");
        assert!(!src.exists());
        assert_eq!(names(dir.path()), ["My video.mp4"]);
        // Replacing a file the person chose to replace.
        std::fs::write(&src, b"newer").unwrap();
        place_file(&src, &c, &AtomicBool::new(false)).unwrap();
        assert_eq!(std::fs::read(&placed).unwrap(), b"newer");
    }

    #[cfg(unix)]
    #[test]
    fn links_are_refused_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let victim = elsewhere.path().join("victim.txt");
        std::fs::write(&victim, b"keep me").unwrap();
        std::os::unix::fs::symlink(&victim, dir.path().join("a.mp4")).unwrap();
        let c = claim_in(dir.path(), "a.mp4");
        let src = elsewhere.path().join("src.mp4");
        std::fs::write(&src, b"video").unwrap();
        assert!(place_file(&src, &c, &AtomicBool::new(false)).unwrap_err().starts_with("not-a-file"));
        assert_eq!(std::fs::read(&victim).unwrap(), b"keep me");

        // The folder swapped for a link after it was picked.
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let c = claim_in(&real, "b.mp4");
        std::fs::remove_dir(&real).unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), &real).unwrap();
        assert!(place_file(&src, &c, &AtomicBool::new(false)).unwrap_err().starts_with("moved"));
        assert!(!elsewhere.path().join("b.mp4").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_as_the_source_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let secret = dir.path().join("secret.txt");
        std::fs::write(&secret, b"private").unwrap();
        let src = dir.path().join("job.mp4");
        std::os::unix::fs::symlink(&secret, &src).unwrap();
        let out = tempfile::tempdir().unwrap();
        let err = place_file(&src, &claim_in(out.path(), "a.mp4"), &AtomicBool::new(false)).unwrap_err();
        assert!(err.starts_with("not-a-file"), "{err}");
        assert!(names(out.path()).is_empty());
        assert_eq!(std::fs::read(&secret).unwrap(), b"private");
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_move_puts_the_video_back() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("job.mp4");
        std::fs::write(&src, b"the only copy").unwrap();
        let out = dir.path().join("out");
        std::fs::create_dir(&out).unwrap();
        // A folder at the chosen name appears after the move beside it: the final step fails.
        let c = claim_in(&out, "a.mp4");
        let target = out.join("a.mp4");
        let err = place_file_with(&src, &c, &AtomicBool::new(false), || {
            std::fs::create_dir(&target).unwrap();
            std::fs::write(target.join("x"), b"x").unwrap();
        })
        .unwrap_err();
        assert!(err.starts_with("not-a-file"), "{err}");
        assert_eq!(std::fs::read(&src).unwrap(), b"the only copy", "the video is still in the work folder");
        assert_eq!(names(&out), ["a.mp4"], "no temp file left");
        // A folder that refuses the mark (no write permission): put back too.
        let ro = dir.path().join("ro");
        std::fs::create_dir(&ro).unwrap();
        let c = claim_in(&ro, "b.mp4");
        std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o555)).unwrap();
        assert!(place_file(&src, &c, &AtomicBool::new(false)).is_err());
        std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(std::fs::read(&src).unwrap(), b"the only copy");
    }

    #[test]
    fn a_copy_to_another_volume_stops_when_cancelled_and_leaves_nothing() {
        let work = tempfile::tempdir().unwrap();
        let src = work.path().join("job.mp4");
        std::fs::write(&src, vec![7u8; 3 * 1024 * 1024]).unwrap();
        let out = tempfile::tempdir().unwrap();
        let c = claim_in(out.path(), "a.mp4");
        let err = copy_into(&src, &c, &AtomicBool::new(true)).unwrap_err();
        assert!(err.starts_with("cancelled"), "{err}");
        assert!(names(out.path()).is_empty(), "{:?}", names(out.path()));
        assert!(src.is_file(), "the video stays in the work folder");
        let placed = copy_into(&src, &c, &AtomicBool::new(false)).unwrap();
        assert_eq!(std::fs::metadata(&placed).unwrap().len(), 3 * 1024 * 1024);
        assert!(!src.exists());
        assert_eq!(names(out.path()), ["a.mp4"]);
    }

    #[test]
    fn written_places_outlive_the_run() {
        let data = tempfile::tempdir().unwrap();
        let store = data.path().join("saved.json");
        let out = tempfile::tempdir().unwrap();
        let dir = std::fs::canonicalize(out.path()).unwrap();
        std::fs::write(dir.join("a.mp4"), b"v").unwrap();
        let d = Destinations::with_store(store.clone());
        let id = d.add(dir.clone(), "a.mp4".into());
        let unused = d.add(dir.clone(), "b.mp4".into());
        d.claim(&id).unwrap();
        d.release(&id, true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&store).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // The next run: only the written one is known.
        let next = Destinations::with_store(store.clone());
        assert_eq!(next.written_file(&id), Some(dir.join("a.mp4")));
        assert!(next.written_file(&unused).is_none());
        assert!(next.claim(&id).unwrap_err().starts_with("used"));
        // The file gone: so is the place.
        std::fs::remove_file(dir.join("a.mp4")).unwrap();
        assert!(next.written_file(&id).is_none());
        // Old places, and more than the cap, go.
        let now = now_secs();
        let list: Vec<SavedPlace> = (0..(MAX_SAVED + 5))
            .map(|i| {
                let name = format!("{i}.mp4");
                std::fs::write(dir.join(&name), b"v").unwrap();
                SavedPlace { id: uuid::Uuid::new_v4().to_string(), dir: dir.clone(), name, at: if i == 0 { now - SAVED_FOR_SECS - 1 } else { now } }
            })
            .collect();
        assert_eq!(Destinations::live(list, now).len(), MAX_SAVED);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_placed_file_is_marked_as_downloaded() {
        use std::os::unix::ffi::OsStrExt;
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src.bin");
        std::fs::write(&src, b"v").unwrap();
        let out = tempfile::tempdir().unwrap();
        let placed = place_file(&src, &claim_in(out.path(), "a.mp4"), &AtomicBool::new(false)).unwrap();
        let c_path = std::ffi::CString::new(placed.as_os_str().as_bytes()).unwrap();
        let mut buf = vec![0u8; 256];
        // SAFETY: NUL-terminated path and name, `buf`'s own length.
        let n = unsafe { libc::getxattr(c_path.as_ptr(), c"com.apple.quarantine".as_ptr(), buf.as_mut_ptr().cast(), buf.len(), 0, 0) };
        assert!(n > 0, "quarantined");
    }
}
