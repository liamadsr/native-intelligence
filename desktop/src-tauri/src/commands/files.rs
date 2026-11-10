use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri_plugin_dialog::DialogExt;

/// Save bytes to a user-chosen location via the native save panel.
///
/// The WKWebView has no download handler, so anchor `download` clicks and
/// `Content-Disposition: attachment` navigations are silently dropped. The
/// website fetches the bytes in-page and hands them here instead.
///
/// The bytes come from the web, so the file is saved the way a browser saves
/// a download ([`write_download`]): Gatekeeper (macOS) or SmartScreen
/// (Windows) checks it the first time it's opened.
///
/// Must stay an async command: `blocking_save_file` round-trips through the
/// main run loop and deadlocks if called on the main thread.
///
/// Returns the chosen path, or None if the user cancelled the dialog.
#[tauri::command]
pub async fn save_file(
    app: tauri::AppHandle,
    file_name: String,
    contents: Vec<u8>,
) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .set_file_name(&file_name)
        .blocking_save_file();

    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path = file_path.into_path().map_err(|e| e.to_string())?;
    write_download(&path, &contents).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// The extended attribute macOS keeps on a file from the internet.
#[cfg(target_os = "macos")]
const QUARANTINE_XATTR: &std::ffi::CStr = c"com.apple.quarantine";

/// Write `contents` to `path` marked as downloaded (`com.apple.quarantine`
/// on macOS, the `Zone.Identifier` Mark-of-the-Web on Windows), so an app,
/// script or disk image saved here gets the same first-open check as one
/// from a browser (security review 2026-10-31).
fn write_download(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    let mark = |file: &std::fs::File, _: &Path| quarantine(file, &quarantine_value(SystemTime::now(), uuid::Uuid::new_v4()));
    #[cfg(windows)]
    let mark = |_: &std::fs::File, at: &Path| mark_of_the_web(at);
    #[cfg(not(any(target_os = "macos", windows)))]
    let mark = |_: &std::fs::File, _: &Path| Ok(());
    write_marked(path, contents, mark)
}

/// Write `contents` to a new file beside `path`, `mark` it before any byte
/// lands, then rename it over `path`. Nothing at `path` changes before the
/// rename, so a volume that can't take the mark (NFS, some FUSE file
/// systems) refuses the save and leaves the person's file as it was. A file
/// it replaces keeps its read and write permissions (a 0600 file stays
/// 0600); none of its execute bits, so bytes from the web never become
/// runnable by landing on a script.
fn write_marked(
    path: &Path,
    contents: &[u8],
    mark: impl FnOnce(&std::fs::File, &Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let tmp = dir.join(format!(".ni-{}.download", uuid::Uuid::new_v4().simple()));
    let written = (|| {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        #[cfg(unix)]
        if let Some(mode) = replaced_mode(path) {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(mode))?;
        }
        mark(&file, &tmp).map_err(|e| std::io::Error::new(e.kind(), format!("couldn't mark the file as downloaded: {e}")))?;
        file.write_all(contents)?;
        drop(file);
        std::fs::rename(&tmp, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// The read and write bits of the file at `path` (followed through a
/// symlink), if one is there to replace.
#[cfg(unix)]
fn replaced_mode(path: &Path) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).ok().filter(|m| m.is_file()).map(|m| m.permissions().mode() & 0o666)
}

/// The quarantine value a non-sandboxed app writes for a download, as Chrome
/// does: `0081;<seconds since 1970, hex>;<agent>;<event id>`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn quarantine_value(now: SystemTime, event: uuid::Uuid) -> String {
    let secs = now.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("0081;{secs:08x};Native Intelligence;{}", event.hyphenated().to_string().to_uppercase())
}

/// The Mark-of-the-Web a browser writes on Windows: an NTFS alternate data
/// stream naming the Internet zone. It follows the file through the rename.
#[cfg(windows)]
const ZONE_IDENTIFIER: &str = "[ZoneTransfer]\r\nZoneId=3\r\n";

/// Mark `file` as from the internet. A volume with no alternate streams at all
/// (a FAT or exFAT stick or card, some network shares) can hold no mark: the
/// file is saved unmarked there, as Edge and Chrome save a download to one
/// (Windows has no other place for it, unlike a Mac's AppleDouble files). Any
/// other failure refuses the save.
#[cfg(windows)]
fn mark_of_the_web(file: &Path) -> std::io::Result<()> {
    let mut stream = file.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    match std::fs::write(stream, ZONE_IDENTIFIER) {
        Err(e) if no_streams_here(&e) => {
            crate::log_to_file(&format!("[save_file] no Mark-of-the-Web on this volume ({e}): saved unmarked"));
            Ok(())
        }
        other => other,
    }
}

/// What writing an alternate stream fails with on a volume that has none:
/// FAT/exFAT reject the `:` (ERROR_INVALID_NAME), a share may answer
/// ERROR_NOT_SUPPORTED.
#[cfg(windows)]
fn no_streams_here(e: &std::io::Error) -> bool {
    const ERROR_NOT_SUPPORTED: i32 = 50;
    const ERROR_INVALID_NAME: i32 = 123;
    e.kind() == std::io::ErrorKind::Unsupported || matches!(e.raw_os_error(), Some(ERROR_NOT_SUPPORTED | ERROR_INVALID_NAME))
}

#[cfg(target_os = "macos")]
fn quarantine(file: &std::fs::File, value: &str) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    // SAFETY: a live fd, a NUL-terminated name, and `value`'s own bytes.
    let rc = unsafe {
        libc::fsetxattr(file.as_raw_fd(), QUARANTINE_XATTR.as_ptr(), value.as_ptr().cast(), value.len(), 0, 0)
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mark_is_what_a_browser_writes() {
        let event = uuid::Uuid::parse_str("0f6e4a1c-2b3d-4e5f-8a9b-0c1d2e3f4a5b").unwrap();
        let at = UNIX_EPOCH + std::time::Duration::from_secs(0x6543_21ab);
        assert_eq!(quarantine_value(at, event), "0081;654321ab;Native Intelligence;0F6E4A1C-2B3D-4E5F-8A9B-0C1D2E3F4A5B");
    }

    #[cfg(target_os = "macos")]
    fn xattr(path: &Path) -> Option<String> {
        use std::os::unix::ffi::OsStrExt;
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        let mut buf = vec![0u8; 256];
        // SAFETY: a NUL-terminated path and name, and `buf`'s own length.
        let n = unsafe {
            libc::getxattr(c_path.as_ptr(), QUARANTINE_XATTR.as_ptr(), buf.as_mut_ptr().cast(), buf.len(), 0, 0)
        };
        (n >= 0).then(|| String::from_utf8_lossy(&buf[..n as usize]).into_owned())
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_saved_file_is_quarantined_like_a_download() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("report.pdf");
        write_download(&path, b"%PDF-1.7 bytes from the web").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"%PDF-1.7 bytes from the web");
        let value = xattr(&path).expect("com.apple.quarantine set");
        let fields: Vec<&str> = value.split(';').collect();
        assert_eq!(fields.len(), 4, "{value}");
        assert_eq!((fields[0], fields[2]), ("0081", "Native Intelligence"));
        assert_eq!(fields[3].len(), 36);

        // Replacing an unmarked file the person picked marks it.
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, b"old").unwrap();
        assert!(xattr(&path).is_none());
        write_download(&path, b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert!(xattr(&path).is_some());
        assert_eq!(names(dir.path()), ["report.pdf"], "no temp file left");
    }

    #[cfg(windows)]
    #[test]
    fn a_saved_file_carries_the_mark_of_the_web() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("report.pdf");
        write_download(&path, b"%PDF-1.7 bytes from the web").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"%PDF-1.7 bytes from the web");
        let mut stream = path.as_os_str().to_owned();
        stream.push(":Zone.Identifier");
        assert_eq!(std::fs::read_to_string(stream).unwrap(), ZONE_IDENTIFIER);
        assert_eq!(names(dir.path()), ["report.pdf"], "no temp file left");
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> =
            std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    /// A volume that can't take the mark: the save fails, and the file the
    /// person picked to replace is untouched.
    #[test]
    fn an_unmarkable_volume_leaves_the_existing_file_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.txt");
        std::fs::write(&path, b"the person's notes").unwrap();
        let unsupported = |_: &std::fs::File, _: &Path| Err(std::io::Error::from(std::io::ErrorKind::Unsupported));
        let err = write_marked(&path, b"from the web", unsupported).unwrap_err();
        assert!(err.to_string().contains("couldn't mark the file as downloaded"), "{err}");
        assert_eq!(std::fs::read(&path).unwrap(), b"the person's notes");
        assert_eq!(names(dir.path()), ["notes.txt"], "no temp file left");
    }

    #[cfg(unix)]
    #[test]
    fn a_replaced_file_keeps_its_permissions_but_never_execute() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o7777;
        for (before, after) in [(0o600, 0o600), (0o644, 0o644), (0o640, 0o640), (0o755, 0o644), (0o4755, 0o644)] {
            let path = dir.path().join(format!("f{before:o}"));
            std::fs::write(&path, b"old").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(before)).unwrap();
            write_marked(&path, b"new", |_, _| Ok(())).unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), b"new");
            assert_eq!(mode(&path), after, "{before:o}");
        }
    }

    #[test]
    fn a_new_file_is_written_whole() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("export.csv");
        write_marked(&path, b"a,b\n1,2\n", |_, _| Ok(())).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"a,b\n1,2\n");
        assert_eq!(names(dir.path()), ["export.csv"]);
    }
}
