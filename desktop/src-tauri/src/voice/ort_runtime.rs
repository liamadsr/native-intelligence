//! ONNX Runtime for the Silero VAD, loaded at run time (`ort`'s load-dynamic)
//! from the libonnxruntime the local-tts module already ships — the app never
//! links ONNX Runtime and never downloads it.
//!
//! Where the dylib is looked for, first hit wins:
//! 1. debug builds only: `$DIAL8_ORT_DYLIB`, when set (tests, debugging):
//!    that file and nothing else. A release build never takes a library
//!    path from its environment ([`dylib_override`]);
//! 2. `<exe>/../Frameworks/` — `sidecars_stage` (scripts/sidecars.sh) copies
//!    local-tts's `.out/lib/*.dylib` there, in dev and release bundles alike;
//! 3. debug builds only: `src-tauri/sidecars/local-tts/.out/lib/` (a `cargo
//!    test` or `cargo run` outside a bundle, after local-tts was built).
//!
//! In each folder the file is `libonnxruntime.<ORT_VERSION>.dylib`, the version
//! read from local-tts's build.sh at compile time, so bumping ONNX Runtime
//! there moves this too; if that exact file isn't there, the newest
//! `libonnxruntime.<x.y.z>.dylib` in the folder is used. `ort` itself refuses
//! a runtime older than the C API it was built for (api-23 = ONNX Runtime 1.23).
//!
//! Loading happens once per process ([`init`]); every failure — no dylib, a
//! file that isn't one, a too-old runtime, a panic inside `ort` — comes back as
//! `Err`, so the VAD falls back to earshot.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Overrides where the ONNX Runtime dylib is loaded from.
pub const DYLIB_ENV: &str = "DIAL8_ORT_DYLIB";

/// local-tts's build script: the one place the ONNX Runtime version is set.
const LOCAL_TTS_BUILD_SH: &str = include_str!("../../sidecars/local-tts/build.sh");

/// The ONNX Runtime version local-tts builds and ships (its `ORT_VERSION="x.y.z"`).
pub fn ort_version() -> Option<&'static str> {
    LOCAL_TTS_BUILD_SH.lines().find_map(|line| {
        let v = line.trim().strip_prefix("ORT_VERSION=\"")?.strip_suffix('"')?;
        is_version(v).then_some(v)
    })
}

fn is_version(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// The dylib's file name for `version`.
pub fn dylib_name(version: &str) -> String {
    format!("libonnxruntime.{version}.dylib")
}

/// Folders searched after the override, in order.
pub fn search_dirs(exe: Option<&Path>, dev_manifest_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(macos) = exe.and_then(Path::parent) {
        dirs.push(macos.join("..").join("Frameworks"));
    }
    if let Some(manifest) = dev_manifest_dir {
        dirs.push(manifest.join("sidecars").join("local-tts").join(".out").join("lib"));
    }
    dirs
}

/// The dylib in `dir`: the exact `version` first, else the newest versioned one.
pub fn find_in(dir: &Path, version: Option<&str>) -> Option<PathBuf> {
    if let Some(v) = version {
        let exact = dir.join(dylib_name(v));
        if exact.is_file() {
            return Some(exact);
        }
    }
    let mut found: Vec<(Vec<u64>, PathBuf)> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let v = name.strip_prefix("libonnxruntime.")?.strip_suffix(".dylib")?;
            if !is_version(v) || !e.path().is_file() {
                return None;
            }
            Some((v.split('.').map(|p| p.parse().unwrap_or(0)).collect(), e.path()))
        })
        .collect();
    found.sort();
    found.pop().map(|(_, p)| p)
}

/// Where the dylib is, given the override and the folders to search.
pub fn resolve_from(override_path: Option<OsString>, dirs: &[PathBuf], version: Option<&str>) -> Result<PathBuf, String> {
    if let Some(p) = override_path.filter(|p| !p.is_empty()) {
        let p = PathBuf::from(p);
        return if p.is_file() { Ok(p) } else { Err(format!("${DYLIB_ENV} = {} is not a file", p.display())) };
    }
    dirs.iter().find_map(|d| find_in(d, version)).ok_or_else(|| {
        let looked: Vec<String> = dirs.iter().map(|d| d.display().to_string()).collect();
        format!("no {} in {}", dylib_name(version.unwrap_or("*")), looked.join(", "))
    })
}

/// src-tauri/ of the checkout a debug build was built from. Release builds
/// have none (and don't carry the build machine's path).
#[cfg(debug_assertions)]
fn dev_manifest_dir() -> Option<&'static Path> {
    Some(Path::new(env!("CARGO_MANIFEST_DIR")))
}
#[cfg(not(debug_assertions))]
fn dev_manifest_dir() -> Option<&'static Path> {
    None
}

/// `$DIAL8_ORT_DYLIB`, in a debug build. A release build ignores it: any
/// process of the same user can set it for every app it starts (`launchctl
/// setenv`), and the dylib would load into the process that holds the mic,
/// screen and Accessibility grants (security review 2026-10-31).
fn dylib_override(debug_build: bool, env: Option<OsString>) -> Option<OsString> {
    env.filter(|_| debug_build)
}

/// Where this process loads the dylib from.
pub fn resolve() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().ok();
    let override_path = dylib_override(cfg!(debug_assertions), std::env::var_os(DYLIB_ENV));
    resolve_from(override_path, &search_dirs(exe.as_deref(), dev_manifest_dir()), ort_version())
}

/// A Mach-O image (thin 64-bit or universal), by its first four bytes. `ort`
/// would find out too, but only while no runtime is loaded yet (see [`load`]).
fn looks_like_macho(path: &Path) -> bool {
    use std::io::Read;
    let mut magic = [0u8; 4];
    let read = std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut magic));
    read.is_ok() && matches!(magic, [0xcf, 0xfa, 0xed, 0xfe] | [0xca, 0xfe, 0xba, 0xbe])
}

/// A Windows DLL (a PE image), by its `MZ` header: the same early check as
/// [`looks_like_macho`]. Garbage handed to `ort` makes it panic while it
/// holds its global lock, and the poisoned lock then aborts the process when
/// it exits.
fn looks_like_pe(path: &Path) -> bool {
    use std::io::Read;
    let mut magic = [0u8; 2];
    let read = std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut magic));
    read.is_ok() && magic == *b"MZ"
}

/// Loads ONNX Runtime from `path` into this process and sets up `ort`'s
/// environment. Once a runtime is loaded, `ort` keeps it: a later call that
/// names another (real) dylib succeeds without loading it. A failed load
/// leaves nothing behind, so a later call may still succeed.
pub fn load(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    if cfg!(target_os = "macos") && !looks_like_macho(path) {
        return Err(format!("{} is not a dylib (no Mach-O header), so not ONNX Runtime", path.display()));
    }
    if cfg!(windows) && !looks_like_pe(path) {
        return Err(format!("{} is not a DLL (no PE header), so not ONNX Runtime", path.display()));
    }
    let loaded = std::panic::catch_unwind(|| ort::init_from(path).map(|env| env.with_name("dial8-vad").commit()));
    match loaded {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(format!("ONNX Runtime: {e}")),
        Err(_) => Err(format!("ONNX Runtime panicked while loading {}", path.display())),
    }
}

static INIT: OnceLock<Result<PathBuf, String>> = OnceLock::new();

/// Resolves and loads ONNX Runtime once per process; later calls return the
/// first outcome.
pub fn init() -> Result<&'static Path, String> {
    INIT.get_or_init(|| {
        let path = resolve()?;
        load(&path)?;
        eprintln!("[vad] ONNX Runtime loaded from {}", path.display());
        Ok(path)
    })
    .as_ref()
    .map(PathBuf::as_path)
    .map_err(Clone::clone)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A dylib for tests that need ONNX Runtime: `$DIAL8_ORT_DYLIB`, else the
    /// normal lookup (local-tts built in this checkout). None: the caller skips.
    pub(crate) fn test_runtime() -> Option<&'static Path> {
        match init() {
            Ok(p) => Some(p),
            Err(e) => {
                eprintln!("skipping: no ONNX Runtime ({e}); build local-tts or set {DYLIB_ENV}");
                None
            }
        }
    }

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"not a dylib").unwrap();
    }

    #[test]
    fn version_comes_from_local_tts_build_sh() {
        let v = ort_version().expect("local-tts/build.sh sets ORT_VERSION=\"x.y.z\"");
        assert!(is_version(v), "{v}");
        assert_eq!(dylib_name("1.23.2"), "libonnxruntime.1.23.2.dylib");
    }

    #[test]
    fn frameworks_first_then_the_dev_build() {
        let exe = Path::new("/Apps/Dial8.app/Contents/MacOS/dial8-desktop");
        let dirs = search_dirs(Some(exe), Some(Path::new("/src/src-tauri")));
        assert_eq!(
            dirs,
            vec![
                PathBuf::from("/Apps/Dial8.app/Contents/MacOS/../Frameworks"),
                PathBuf::from("/src/src-tauri/sidecars/local-tts/.out/lib"),
            ]
        );
        assert_eq!(search_dirs(Some(exe), None).len(), 1, "release builds never look in the source tree");
    }

    #[test]
    fn resolver_order() {
        let tmp = tempfile::tempdir().unwrap();
        let frameworks = tmp.path().join("Frameworks");
        let dev = tmp.path().join("dev");
        let dirs = vec![frameworks.clone(), dev.clone()];

        // Nothing anywhere.
        assert!(resolve_from(None, &dirs, Some("1.23.2")).is_err());

        // Only the dev build has it.
        touch(&dev.join("libonnxruntime.1.23.2.dylib"));
        assert_eq!(resolve_from(None, &dirs, Some("1.23.2")).unwrap(), dev.join("libonnxruntime.1.23.2.dylib"));

        // The bundle's Frameworks wins over the dev build.
        touch(&frameworks.join("libonnxruntime.1.23.2.dylib"));
        assert_eq!(resolve_from(None, &dirs, Some("1.23.2")).unwrap(), frameworks.join("libonnxruntime.1.23.2.dylib"));

        // The override wins over both, and an empty one is ignored.
        let custom = tmp.path().join("custom.dylib");
        touch(&custom);
        assert_eq!(resolve_from(Some(custom.clone().into()), &dirs, Some("1.23.2")).unwrap(), custom);
        assert_eq!(resolve_from(Some(OsString::new()), &dirs, Some("1.23.2")).unwrap(), frameworks.join("libonnxruntime.1.23.2.dylib"));

        // A bogus override is an error, not a fallback to the other folders.
        let bogus = tmp.path().join("nope/libonnxruntime.dylib");
        assert!(resolve_from(Some(bogus.into()), &dirs, Some("1.23.2")).is_err());
    }

    #[test]
    fn only_a_debug_build_takes_the_override_from_its_environment() {
        let set = Some(OsString::from("/tmp/evil/libonnxruntime.1.23.2.dylib"));
        assert_eq!(dylib_override(true, set.clone()), set);
        assert_eq!(dylib_override(false, set), None, "release: the bundle's Frameworks only");
        assert_eq!(dylib_override(true, None), None);
        assert_eq!(dylib_override(false, None), None);
    }

    #[test]
    fn a_version_bump_without_a_rebuild_still_finds_the_dylib() {
        let tmp = tempfile::tempdir().unwrap();
        touch(&tmp.path().join("libonnxruntime.1.9.0.dylib"));
        touch(&tmp.path().join("libonnxruntime.1.24.1.dylib"));
        touch(&tmp.path().join("libonnxruntime.dylib")); // unversioned: ignored
        touch(&tmp.path().join("libonnxruntime.1.23.2.dylib.bak"));
        let dirs = vec![tmp.path().to_path_buf()];
        // The exact version when it's there...
        touch(&tmp.path().join("libonnxruntime.1.23.2.dylib"));
        assert_eq!(resolve_from(None, &dirs, Some("1.23.2")).unwrap(), tmp.path().join("libonnxruntime.1.23.2.dylib"));
        // ...else the newest versioned one (numerically: 1.24.1 > 1.9.0).
        assert_eq!(resolve_from(None, &dirs, Some("1.30.0")).unwrap(), tmp.path().join("libonnxruntime.1.24.1.dylib"));
    }

    #[test]
    fn loading_garbage_is_an_error_not_a_panic() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = tmp.path().join("libonnxruntime.1.23.2.dylib");
        touch(&fake);
        let err = load(&fake).expect_err("a text file is not ONNX Runtime");
        assert!(err.contains("ONNX Runtime"), "{err}");
        assert!(load(&tmp.path().join("missing.dylib")).is_err());
    }

    #[test]
    fn the_real_runtime_loads() {
        let Some(path) = test_runtime() else { return };
        assert!(path.is_file());
        // Loading again (any path) keeps the runtime that's there.
        assert!(load(path).is_ok());
    }
}
