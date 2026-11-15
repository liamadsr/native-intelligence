//! Unpacking a pinned zip (Node on Windows, Chrome's headless shell, our
//! FFmpeg) without trusting its entry names: the archive's own SHA-256 was
//! checked before this runs, but a mistake in a pin must still never write
//! outside the folder it unpacks into.
//!
//! - every entry must be under `<prefix>/`; its name is checked component by
//!   component (no `..`, `.`, empty, absolute, drive or backslash parts), so
//!   nothing lands outside `into`;
//! - symbolic links are refused (none of the pinned archives has one);
//! - files are created new (`create_new`): a second entry of the same name
//!   fails the unpack;
//! - the bytes written are capped (`max_total`), whatever the headers claim;
//! - on macOS an entry's execute bits are kept (0o755) and everything else is
//!   0o644; Windows has no bits to keep.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// An entry name's parts after `<prefix>/`, or why it is refused. A trailing
/// `/` (a folder) leaves an empty last part out. Pure.
pub fn entry_parts<'a>(name: &'a str, prefix: &str) -> Result<Vec<&'a str>, String> {
    if name.contains('\\') || name.contains('\0') {
        return Err(format!("the archive names {name:?}"));
    }
    let mut parts: Vec<&str> = name.split('/').collect();
    if parts.last() == Some(&"") {
        parts.pop();
    }
    if parts.first() != Some(&prefix) {
        return Err(format!("{name:?} is outside {prefix}/"));
    }
    let rest = parts.split_off(1);
    for p in &rest {
        if p.is_empty() || *p == "." || *p == ".." || p.contains(':') {
            return Err(format!("the archive names {name:?}"));
        }
    }
    Ok(rest)
}

/// Unpack the entries of `zip` under `<prefix>/` into `into` (which must
/// exist), without the prefix. `only`: just these `/`-separated paths (the
/// rest skipped). Returns the bytes written.
pub fn extract(zip: &Path, into: &Path, prefix: &str, only: Option<&[String]>, max_total: u64) -> Result<u64, String> {
    let file = std::fs::File::open(zip).map_err(|e| format!("can't open the archive: {e}"))?;
    let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|e| format!("not a readable zip: {e}"))?;
    let mut total: u64 = 0;
    let mut found = 0usize;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("not a readable zip: {e}"))?;
        let name = entry.name().to_string();
        let parts = entry_parts(&name, prefix)?;
        if parts.is_empty() {
            continue;
        }
        let rel = parts.join("/");
        if let Some(only) = only {
            if !only.iter().any(|o| o == &rel) {
                continue;
            }
        }
        let mode = entry.unix_mode();
        if mode.is_some_and(|m| m & 0o170000 == 0o120000) {
            return Err(format!("{rel} is a symbolic link"));
        }
        let dest: PathBuf = parts.iter().fold(into.to_path_buf(), |p, c| p.join(c));
        if entry.is_dir() {
            std::fs::create_dir_all(&dest).map_err(|e| format!("can't create {rel}: {e}"))?;
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("can't create the folder of {rel}: {e}"))?;
        }
        let mut out = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&dest)
            .map_err(|e| format!("can't write {rel}: {e}"))?;
        let left = max_total.saturating_sub(total);
        let mut limited = (&mut entry).take(left.saturating_add(1));
        let n = std::io::copy(&mut limited, &mut out).map_err(|e| format!("can't unpack {rel}: {e}"))?;
        if n > left {
            return Err(format!("the archive unpacks to more than {max_total} bytes"));
        }
        out.flush().map_err(|e| format!("can't write {rel}: {e}"))?;
        total += n;
        found += 1;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let exec = mode.is_some_and(|m| m & 0o111 != 0);
            std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(if exec { 0o755 } else { 0o644 }))
                .map_err(|e| format!("can't set the permissions of {rel}: {e}"))?;
        }
        #[cfg(not(unix))]
        let _ = mode;
    }
    if let Some(only) = only {
        if found < only.len() {
            return Err(format!("the archive lacks some of {}", only.join(", ")));
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;

    fn make(dir: &Path, entries: &[(&str, &[u8], u32)]) -> PathBuf {
        let path = dir.join("a.zip");
        let mut w = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        for (name, body, mode) in entries {
            let o = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored)
                .unix_permissions(*mode);
            if name.ends_with('/') {
                w.add_directory(*name, o).unwrap();
            } else {
                w.start_file(*name, o).unwrap();
                w.write_all(body).unwrap();
            }
        }
        w.finish().unwrap();
        path
    }

    #[test]
    fn entry_names_stay_under_the_prefix() {
        assert_eq!(entry_parts("p/a/b.txt", "p").unwrap(), ["a", "b.txt"]);
        assert_eq!(entry_parts("p/dir/", "p").unwrap(), ["dir"]);
        assert!(entry_parts("p/", "p").unwrap().is_empty());
        for bad in ["q/a", "p/../a", "p/./a", "p//a", "/p/a", "p/a\\..\\b", "p/C:x", "a", "p/a/../../b"] {
            assert!(entry_parts(bad, "p").is_err(), "{bad}");
        }
    }

    #[test]
    fn unpacks_under_the_prefix_keeping_execute_bits() {
        let dir = tempfile::tempdir().unwrap();
        let zip = make(dir.path(), &[("p/", b"", 0o755), ("p/bin/tool", b"#!/bin/sh\n", 0o755), ("p/data.txt", b"hello", 0o644)]);
        let into = dir.path().join("out");
        std::fs::create_dir(&into).unwrap();
        let n = extract(&zip, &into, "p", None, 1000).unwrap();
        assert_eq!(n, 15);
        assert_eq!(std::fs::read(into.join("data.txt")).unwrap(), b"hello");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&into.join("bin/tool")), 0o755);
            assert_eq!(mode(&into.join("data.txt")), 0o644);
        }
    }

    #[test]
    fn only_the_named_files() {
        let dir = tempfile::tempdir().unwrap();
        let zip = make(dir.path(), &[("p/node.exe", b"MZ", 0o644), ("p/LICENSE", b"MIT", 0o644), ("p/npm.cmd", b"x", 0o644)]);
        let into = dir.path().join("out");
        std::fs::create_dir(&into).unwrap();
        let only = vec!["node.exe".to_string(), "LICENSE".to_string()];
        extract(&zip, &into, "p", Some(&only), 100).unwrap();
        assert!(into.join("node.exe").is_file() && into.join("LICENSE").is_file());
        assert!(!into.join("npm.cmd").exists());
        let missing = vec!["node.exe".to_string(), "nope".to_string()];
        let into2 = dir.path().join("out2");
        std::fs::create_dir(&into2).unwrap();
        assert!(extract(&zip, &into2, "p", Some(&missing), 100).unwrap_err().contains("lacks"));
    }

    #[test]
    fn refuses_escapes_links_and_bombs() {
        let dir = tempfile::tempdir().unwrap();
        let into = dir.path().join("out");
        std::fs::create_dir(&into).unwrap();
        let other = make(dir.path(), &[("q/x", b"x", 0o644)]);
        assert!(extract(&other, &into, "p", None, 100).unwrap_err().contains("outside"));
        let up = make(dir.path(), &[("p/../escape", b"x", 0o644)]);
        assert!(extract(&up, &into, "p", None, 100).is_err());
        assert!(!dir.path().join("escape").exists());
        let big = make(dir.path(), &[("p/big", &[0u8; 64], 0o644)]);
        assert!(extract(&big, &into, "p", None, 10).unwrap_err().contains("more than"));

        let path = dir.path().join("link.zip");
        let mut w = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        w.add_symlink("p/link", "/etc/passwd", SimpleFileOptions::default()).unwrap();
        w.finish().unwrap();
        let into3 = dir.path().join("out3");
        std::fs::create_dir(&into3).unwrap();
        assert!(extract(&path, &into3, "p", None, 100).unwrap_err().contains("symbolic link"));
    }
}
