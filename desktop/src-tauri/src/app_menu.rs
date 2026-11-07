//! macOS app menu: Tauri's default menu plus Help → "Open Source Licenses".
//!
//! With no menu set, Tauri installs `Menu::default` on macOS. Setting our own
//! replaces that, so this builds the very same default and only appends to its
//! Help submenu — About, Hide, Quit ⌘Q, Edit (copy/paste/select all), View,
//! Window all stay exactly as Tauri makes them. If the item can't be added,
//! the app still starts, with the default menu.
//!
//! The item shows THIRD_PARTY_NOTICES.txt, the self-contained file
//! scripts/licenses.sh stages into the bundle (Contents/Resources/Licenses/).
//! It opens a copy in the app's cache folder, never the file inside the
//! bundle: it opens in the user's default text app, and an edit or autosave
//! there must not touch a resource the code signature seals. If the copy
//! can't be made or opened, it reveals the bundled file in Finder instead, so
//! a click always does something. A build without the notices (bare
//! `cargo run`, a dev bundle whose licenses step failed) shows the item
//! disabled.

use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use tauri::menu::{Menu, MenuEvent, MenuItem, HELP_SUBMENU_ID};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::log_to_file;

/// Id of Help → "Open Source Licenses". Menu events are global (the tray's
/// handler sees this id too and ignores it), so it must not collide with the
/// tray's ids.
pub const OPEN_SOURCE_LICENSES_ID: &str = "open-source-licenses";

/// Where licenses_stage puts the notices, relative to Contents/.
const LICENSES_IN_CONTENTS: &str = "Resources/Licenses";
/// The self-contained file in that folder — the one the item opens, and the
/// name of its copy in the app cache dir.
const NOTICES_FILE: &str = "THIRD_PARTY_NOTICES.txt";

/// One copy at a time: two quick clicks share the temp file.
static COPY_LOCK: Mutex<()> = Mutex::new(());

/// Builder::menu callback: the default menu with our Help item appended.
/// Only a failure to build the default menu itself fails startup.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    if let Err(e) = append_licenses_item(app, &menu) {
        log_to_file(&format!("[menu] Open Source Licenses item not added: {}", e));
    }
    Ok(menu)
}

fn append_licenses_item<R: Runtime>(app: &AppHandle<R>, menu: &Menu<R>) -> tauri::Result<()> {
    let Some(help) = menu.get(HELP_SUBMENU_ID).and_then(|item| item.as_submenu().cloned()) else {
        // Only if a Tauri upgrade reshapes the default menu: keep the menu,
        // lose just the item.
        log_to_file("[menu] default menu has no Help submenu — licenses item not added");
        return Ok(());
    };
    let available = bundled_notices().is_some_and(|file| file.is_file());
    let item = MenuItem::with_id(
        app,
        OPEN_SOURCE_LICENSES_ID,
        "Open Source Licenses",
        available,
        None::<&str>,
    )?;
    help.append(&item)
}

/// Builder::on_menu_event callback. Acts on our id only; every other menu
/// event (the tray's included) passes straight through.
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if event.id().as_ref() != OPEN_SOURCE_LICENSES_ID {
        return;
    }
    let Some(bundled) = bundled_notices() else {
        log_to_file("[menu] open source licenses: can't resolve the app bundle");
        return;
    };
    let copy = app
        .path()
        .app_cache_dir()
        .map(|dir| dir.join(NOTICES_FILE))
        .map_err(|e| format!("no app cache dir: {}", e));
    // A ~1.5 MB file: quick, but not for the main thread.
    let app = app.clone();
    std::thread::spawn(move || {
        let opened = copy.and_then(|copy| {
            {
                let _one_at_a_time = COPY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
                refresh_copy(&bundled, &copy)
                    .map_err(|e| format!("copy to {} failed: {}", copy.display(), e))?;
            }
            app.opener()
                .open_path(copy.to_string_lossy(), None::<&str>)
                .map_err(|e| format!("open {} failed: {}", copy.display(), e))
        });
        if let Err(e) = opened {
            log_to_file(&format!(
                "[menu] open source licenses: {} — revealing {} instead",
                e,
                bundled.display()
            ));
            if let Err(e) = app.opener().reveal_item_in_dir(&bundled) {
                log_to_file(&format!(
                    "[menu] open source licenses: reveal {} failed: {}",
                    bundled.display(),
                    e
                ));
            }
        }
    });
}

/// Contents/Resources/Licenses/THIRD_PARTY_NOTICES.txt of the running app bundle.
fn bundled_notices() -> Option<PathBuf> {
    notices_file(&std::env::current_exe().ok()?)
}

/// The notices file for the bundle whose main executable is `exe`
/// (Dial8.app/Contents/MacOS/dial8-desktop →
/// Dial8.app/Contents/Resources/Licenses/THIRD_PARTY_NOTICES.txt).
fn notices_file(exe: &Path) -> Option<PathBuf> {
    let contents = exe.parent()?.parent()?;
    Some(contents.join(LICENSES_IN_CONTENTS).join(NOTICES_FILE))
}

/// Makes `dest` a copy of `bundled` and says whether it had to copy. A copy
/// with the bundled file's size and modification time is left alone; any
/// other (missing, edited in a text app, from an older version) is replaced
/// atomically: written to a temp file next to it, given the bundled file's
/// modification time, then renamed over it. Leaves `dest` alone if `bundled`
/// can't be read.
fn refresh_copy(bundled: &Path, dest: &Path) -> io::Result<bool> {
    let source = File::open(bundled)?;
    let meta = source.metadata()?;
    if !meta.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} is not a file", bundled.display()),
        ));
    }
    let modified = meta.modified()?;
    if let Ok(existing) = fs::metadata(dest) {
        if existing.is_file()
            && existing.len() == meta.len()
            && existing.modified().ok() == Some(modified)
        {
            return Ok(false);
        }
    }

    let dir = dest.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, format!("{} has no folder", dest.display()))
    })?;
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".{}.tmp", NOTICES_FILE));
    match write_file(&source, &tmp, modified).and_then(|()| fs::rename(&tmp, dest)) {
        Ok(()) => Ok(true),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Writes everything `source` holds to `path`, stamped with `modified`.
fn write_file(mut source: &File, path: &Path, modified: SystemTime) -> io::Result<()> {
    let mut out = File::create(path)?;
    io::copy(&mut source, &mut out)?;
    out.set_modified(modified)?;
    out.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn set_mtime(path: &Path, time: SystemTime) {
        File::options().write(true).open(path).unwrap().set_modified(time).unwrap();
    }

    fn mtime(path: &Path) -> SystemTime {
        fs::metadata(path).unwrap().modified().unwrap()
    }

    #[test]
    fn notices_file_is_in_the_bundle_resources() {
        assert_eq!(
            notices_file(Path::new("/Applications/Dial8.app/Contents/MacOS/dial8-desktop")),
            Some(PathBuf::from(
                "/Applications/Dial8.app/Contents/Resources/Licenses/THIRD_PARTY_NOTICES.txt"
            ))
        );
    }

    #[test]
    fn notices_file_needs_two_parent_directories() {
        assert_eq!(notices_file(Path::new("dial8-desktop")), None);
    }

    #[test]
    fn refresh_copy_makes_a_missing_copy_with_the_bundled_mtime() {
        let tmp = tempfile::tempdir().unwrap();
        let bundled = tmp.path().join("bundle").join(NOTICES_FILE);
        fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        fs::write(&bundled, "all notices").unwrap();
        let dest = tmp.path().join("cache").join(NOTICES_FILE);

        assert!(refresh_copy(&bundled, &dest).unwrap());

        assert_eq!(fs::read_to_string(&dest).unwrap(), "all notices");
        assert_eq!(mtime(&dest), mtime(&bundled));
        // Only the file itself: no temp file left next to it.
        let names: Vec<_> = fs::read_dir(dest.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from(NOTICES_FILE)]);
    }

    #[test]
    fn refresh_copy_leaves_a_copy_with_the_same_size_and_mtime() {
        let tmp = tempfile::tempdir().unwrap();
        let bundled = tmp.path().join(NOTICES_FILE);
        fs::write(&bundled, "all notices").unwrap();
        let dest = tmp.path().join("cache").join(NOTICES_FILE);
        assert!(refresh_copy(&bundled, &dest).unwrap());

        // Same size and mtime as the bundled file: not copied again (the
        // marker content survives).
        fs::write(&dest, "ALL NOTICES").unwrap();
        set_mtime(&dest, mtime(&bundled));
        assert!(!refresh_copy(&bundled, &dest).unwrap());
        assert_eq!(fs::read_to_string(&dest).unwrap(), "ALL NOTICES");
    }

    #[test]
    fn refresh_copy_replaces_an_edited_or_outdated_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let bundled = tmp.path().join(NOTICES_FILE);
        fs::write(&bundled, "all notices").unwrap();
        let dest = tmp.path().join("cache").join(NOTICES_FILE);
        assert!(refresh_copy(&bundled, &dest).unwrap());

        // Edited in a text app: different size.
        fs::write(&dest, "all notices, and my notes").unwrap();
        assert!(refresh_copy(&bundled, &dest).unwrap());
        assert_eq!(fs::read_to_string(&dest).unwrap(), "all notices");

        // Same size, different mtime (a newer app version's notices).
        fs::write(&bundled, "new notices").unwrap();
        set_mtime(&bundled, mtime(&dest) + Duration::from_secs(60));
        assert!(refresh_copy(&bundled, &dest).unwrap());
        assert_eq!(fs::read_to_string(&dest).unwrap(), "new notices");
        assert_eq!(mtime(&dest), mtime(&bundled));
    }

    #[test]
    fn refresh_copy_without_bundled_notices_keeps_the_old_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let bundled = tmp.path().join("bundle").join(NOTICES_FILE);
        let dest = tmp.path().join("cache").join(NOTICES_FILE);
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        fs::write(&dest, "previous").unwrap();

        let err = refresh_copy(&bundled, &dest).unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        assert_eq!(fs::read_to_string(&dest).unwrap(), "previous");
    }
}
