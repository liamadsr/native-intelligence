//! App updates, driven from Rust (security review 2026-10-31, P0-3).
//!
//! The webview runs code our server sends, so it must not be able to choose
//! what gets installed. Before this, the capability granted `updater:default`
//! to the remote origin: the web called the updater plugin's `check` itself,
//! and could pass `allowDowngrades: true`. A compromised server could then
//! serve any OLDER signed build and the Mac would reinstall it, with whatever
//! bugs later builds fixed.
//!
//! Now the web has two commands and no updater permission:
//!   - [`app_update_check`]: is there a newer build? The plugin's default
//!     comparator, run here, accepts only a strictly newer version, and no
//!     caller can change it.
//!   - [`app_update_install`]: download, verify, install. The minisign
//!     signature covers only the bundle's BYTES, and the manifest's `version`
//!     is unsigned: a server could label an old signed bundle "99.0.0". So
//!     after the plugin verifies the signature, this reads the version INSIDE
//!     the bundle (macOS: `Contents/Info.plist`, `CFBundleShortVersionString`;
//!     Windows: the NSIS installer's VERSIONINFO, [`installer_version`]) and
//!     installs only when it equals the manifest's version AND is newer than
//!     the running app ([`check_bundle_version`]).
//!   - [`app_update_apply`]: the person's "Restart now". On macOS the install
//!     already replaced the app, so this restarts it. On Windows installing
//!     means running the installer, which ends the app at once, so the
//!     install only STAGES the verified installer (a scheduled check must
//!     never close the app mid-meeting) and this runs it: quit cleanup first
//!     (the plugin's `on_before_exit`), then the installer, which reopens
//!     Dial8 when it's done.
//!
//! In debug builds the updater plugin isn't registered (lib.rs), so both
//! commands answer an error, which the web treats as "no update".

use std::io::{Cursor, Read};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// An Info.plist larger than this is not one the bundler wrote.
const MAX_INFO_PLIST_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub available: bool,
    /// The newer version, when one is available.
    pub version: Option<String>,
    pub current_version: String,
}

/// The updater, or why there is none. In debug builds the plugin isn't
/// registered (lib.rs), and the plugin's `updater()` PANICS without its state,
/// so this refuses before reaching it. On Windows the plugin's install exits
/// the process (`std::process::exit`), which raises no `ExitRequested` or
/// `Exit`: the quit cleanup (finalize a recording, stop the sidecars) runs
/// from its `on_before_exit` hook instead.
fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    if cfg!(debug_assertions) {
        return Err("updates are off in debug builds".into());
    }
    #[cfg(windows)]
    {
        let handle = app.clone();
        app.updater_builder()
            // Replaces the plugin's own hook, so its cleanup runs here too
            // (tray icon removed, windows hidden), after ours.
            .on_before_exit(move || {
                crate::quit::run(&handle, "update install");
                handle.cleanup_before_exit();
            })
            .build()
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    app.updater().map_err(|e| e.to_string())
}

/// Is a strictly newer signed build published? Never installs anything.
#[tauri::command]
pub async fn app_update_check(app: AppHandle) -> Result<UpdateCheck, String> {
    let updater = updater(&app)?;
    let current_version = app.package_info().version.to_string();
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => Ok(UpdateCheck { available: true, version: Some(update.version.clone()), current_version }),
        None => Ok(UpdateCheck { available: false, version: None, current_version }),
    }
}

/// One install at a time: the plugin's macOS install renames the running
/// `.app` aside and moves the new one in, so two at once (a manual check over a
/// scheduled one, or a page calling twice) could leave a broken bundle.
static INSTALLING: AtomicBool = AtomicBool::new(false);

/// Clears [`INSTALLING`] however the install ends.
struct InstallSlot;

impl InstallSlot {
    fn take() -> Option<Self> {
        INSTALLING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).ok().map(|_| InstallSlot)
    }
}

impl Drop for InstallSlot {
    fn drop(&mut self) {
        INSTALLING.store(false, Ordering::Release);
    }
}

/// Windows: the verified installer, waiting for the person's restart.
#[cfg(windows)]
struct Staged {
    update: tauri_plugin_updater::Update,
    bytes: Vec<u8>,
}

#[cfg(windows)]
static STAGED: std::sync::Mutex<Option<Staged>> = std::sync::Mutex::new(None);

/// Download, verify and install the newer build, if it is still `expected`
/// (the version the person was shown). Returns the installed version; the
/// person restarts to apply it ([`app_update_apply`]). On Windows "installed"
/// means verified and staged: running the installer waits for that restart.
#[tauri::command]
pub async fn app_update_install(app: AppHandle, expected: String) -> Result<String, String> {
    if !cfg!(any(target_os = "macos", windows)) {
        // Each platform's bundle needs its own version check before it may
        // install: there is none for this one.
        return Err("updates don't install on this platform".into());
    }
    let Some(_slot) = InstallSlot::take() else {
        return Err("an update is already installing".into());
    };
    // Already verified and waiting for its restart (a page reload, or the
    // next scheduled check): not downloaded again.
    #[cfg(windows)]
    if STAGED.lock().map_err(|_| "the update state is poisoned".to_string())?.as_ref().is_some_and(|s| s.update.version == expected) {
        return Ok(expected);
    }
    let updater = updater(&app)?;
    let current = app.package_info().version.to_string();
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err("no update is available".into());
    };
    if update.version != expected {
        return Err(format!("the available update changed ({} → {})", expected, update.version));
    }
    // The plugin verifies the minisign signature before it returns the bytes.
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    let version = update.version.clone();
    #[cfg(target_os = "macos")]
    {
        let bundled = bundle_version(&bytes)?;
        check_bundle_version(&bundled, &version, &current)?;
        update.install(&bytes).map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        let bundled = installer_version(&bytes)?;
        check_bundle_version(&bundled, &version, &current)?;
        *STAGED.lock().map_err(|_| "the update state is poisoned".to_string())? = Some(Staged { update, bytes });
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = (bytes, current);
    Ok(version)
}

/// The person's "Restart now" after an install. macOS: restart (the new app
/// is already in place). Windows: run the staged installer, after the quit
/// cleanup; it closes Dial8 and opens the new one, so this returns only when
/// it couldn't start. One at a time with an install, like installs.
#[tauri::command]
pub async fn app_update_apply(app: AppHandle) -> Result<(), String> {
    let Some(_slot) = InstallSlot::take() else {
        return Err("an update is already installing".into());
    };
    #[cfg(windows)]
    {
        let _ = app;
        let staged = STAGED.lock().map_err(|_| "the update state is poisoned".to_string())?.take();
        let Some(staged) = staged else {
            return Err("no update is ready to install".into());
        };
        // On its own thread, never a tokio one: the quit cleanup it runs first
        // (on_before_exit → quit::run) blocks on the runtime, which panics on
        // a runtime thread. On success the process exits there; an error
        // comes back before the cleanup ran (the plugin fails only while
        // writing the installer out), so the update is staged again for the
        // next click.
        let (tx, rx) = tokio::sync::oneshot::channel();
        std::thread::spawn(move || {
            let result = staged.update.install(&staged.bytes).map_err(|e| e.to_string());
            let _ = tx.send((staged, result));
        });
        let (staged, result) = rx.await.map_err(|_| "the update install stopped".to_string())?;
        if result.is_err() {
            if let Ok(mut slot) = STAGED.lock() {
                *slot = Some(staged);
            }
        }
        result
    }
    #[cfg(not(windows))]
    {
        // request_restart, never restart(): the quit cleanup runs (quit.rs).
        app.request_restart();
        Ok(())
    }
}

/// The product version inside a Windows NSIS installer (its VERSIONINFO; the
/// installer-version crate, which the Windows workflow also runs on every
/// installer it builds).
#[cfg(windows)]
pub use installer_version::installer_version;

/// `CFBundleShortVersionString` of the `.app` inside an updater `.app.tar.gz`
/// (`<App>.app/Contents/Info.plist`, XML or binary).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn bundle_version(tar_gz: &[u8]) -> Result<String, String> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(Cursor::new(tar_gz)));
    let entries = archive.entries().map_err(|e| format!("the update isn't a readable archive: {e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("the update isn't a readable archive: {e}"))?;
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        // The same layout the plugin installs from: the first component is the .app.
        let inner: std::path::PathBuf = path.iter().skip(1).collect();
        if inner != std::path::Path::new("Contents/Info.plist") {
            continue;
        }
        if entry.size() > MAX_INFO_PLIST_BYTES {
            return Err("the update's Info.plist is too large".into());
        }
        let mut raw = Vec::new();
        entry
            .by_ref()
            .take(MAX_INFO_PLIST_BYTES)
            .read_to_end(&mut raw)
            .map_err(|e| e.to_string())?;
        let value = plist::Value::from_reader(Cursor::new(raw)).map_err(|e| format!("the update's Info.plist is unreadable: {e}"))?;
        return value
            .as_dictionary()
            .and_then(|d| d.get("CFBundleShortVersionString"))
            .and_then(|v| v.as_string())
            .map(str::to_string)
            .ok_or_else(|| "the update's Info.plist names no version".into());
    }
    Err("the update holds no app".into())
}

/// The bundle's own version must equal the manifest's and be strictly newer
/// than the running app's; anything else is refused. Pure.
pub fn check_bundle_version(bundled: &str, manifest: &str, current: &str) -> Result<(), String> {
    let parse = |v: &str, what: &str| semver::Version::parse(v.trim()).map_err(|_| format!("the {what} version {v:?} isn't a version"));
    let bundled_v = parse(bundled, "bundle's")?;
    let manifest_v = parse(manifest, "update's")?;
    let current_v = parse(current, "running app's")?;
    if bundled_v != manifest_v {
        return Err(format!("the update says {manifest} but holds {bundled}: refused"));
    }
    if bundled_v <= current_v {
        return Err(format!("the update ({bundled}) isn't newer than this app ({current}): refused"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;


    fn plist_xml(version: &str) -> Vec<u8> {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>ai.dial8.desktop</string>
<key>CFBundleShortVersionString</key><string>{version}</string>
</dict></plist>"#
        )
        .into_bytes()
    }

    /// An updater archive: `<App>.app/...` entries, gzipped.
    fn archive(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
        for (path, data) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, path, data.as_slice()).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn reads_the_version_from_the_apps_info_plist() {
        let tgz = archive(&[
            ("Dial8.app/Contents/MacOS/Dial8", b"binary".to_vec()),
            ("Dial8.app/Contents/Info.plist", plist_xml("0.3.1")),
        ]);
        assert_eq!(bundle_version(&tgz).unwrap(), "0.3.1");
    }

    #[test]
    fn an_info_plist_anywhere_else_is_not_the_apps() {
        let tgz = archive(&[("Dial8.app/Contents/Resources/Other.app/Contents/Info.plist", plist_xml("99.0.0"))]);
        assert!(bundle_version(&tgz).is_err());
    }

    #[test]
    fn garbage_and_versionless_bundles_are_refused() {
        assert!(bundle_version(b"not a tarball").is_err());
        let no_version = archive(&[("Dial8.app/Contents/Info.plist", b"<plist><dict></dict></plist>".to_vec())]);
        assert!(bundle_version(&no_version).is_err());
    }

    #[test]
    fn a_newer_bundle_matching_its_manifest_installs() {
        assert!(check_bundle_version("0.3.1", "0.3.1", "0.3.0").is_ok());
    }

    #[test]
    fn an_old_signed_bundle_labelled_newer_is_refused() {
        // The rollback: the server serves 0.2.0's bytes (validly signed) under a 99.0.0 manifest.
        let err = check_bundle_version("0.2.0", "99.0.0", "0.3.0").unwrap_err();
        assert!(err.contains("holds 0.2.0"), "{err}");
    }

    #[test]
    fn a_same_or_older_bundle_is_refused_even_when_the_manifest_agrees() {
        assert!(check_bundle_version("0.3.0", "0.3.0", "0.3.0").is_err());
        assert!(check_bundle_version("0.2.9", "0.2.9", "0.3.0").is_err());
    }

    #[test]
    fn only_one_install_slot_at_a_time_and_it_frees_on_drop() {
        let first = InstallSlot::take().expect("the slot starts free");
        assert!(InstallSlot::take().is_none(), "a second install must be refused while one runs");
        drop(first);
        assert!(InstallSlot::take().is_some(), "the slot frees when the install ends, however it ends");
    }

    #[test]
    fn unparseable_versions_are_refused() {
        assert!(check_bundle_version("latest", "latest", "0.3.0").is_err());
        assert!(check_bundle_version("0.3.1", "0.3.1", "").is_err());
    }
}
