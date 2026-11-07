/// Canonical resolver for sidecar executables (see scripts/sidecars.sh for the
/// build convention: every folder in src-tauri/sidecars/ builds into
/// `.out/bin/<executable>`, which release/dev scripts stage into
/// `Dial8.app/Contents/MacOS/`).
///
/// Every caller must use this so dev and production resolve sidecars the same
/// way. The bundled copy is always preferred: macOS associates a sidecar's TCC
/// permissions with the parent app's code signature, and the bundled copy is
/// the one signed alongside the app. Build outputs in the repo are a dev-only
/// fallback.

use std::path::PathBuf;

/// The Swift sidecar that owns meeting detection, system-audio capture and the
/// local calendar.
pub const SYSTEM_AUDIO_CAPTURE: &str = "system-audio-capture";

/// Resolve the sidecar executable called `name` (`name.exe` on Windows).
pub fn path(name: &str) -> Option<PathBuf> {
    let name = &exe_name(name);
    // Inside the app bundle, next to the main binary. Both the release bundle
    // and the dev bundle (build.sh/dev.sh stage sidecars there) use this
    // layout, so dev exercises the same resolution path that ships. On
    // Windows the installer puts them next to Dial8.exe the same way.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join(name);
            if bundled.exists() {
                return Some(bundled);
            }
        }
    }

    // Repo build outputs are a dev convenience only: a release binary must
    // never find a sidecar in the build machine's checkout (that would hide a
    // bundle that shipped without it).
    if cfg!(debug_assertions) {
        return dev_candidates(name).into_iter().find(|p| p.exists());
    }
    None
}

/// The file name of the executable `name` on this platform.
fn exe_name(name: &str) -> String {
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}

/// `CREATE_NO_WINDOW`: the child gets no console of its own.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Every child process the app starts runs without a console window. On
/// Windows Dial8 is a GUI-subsystem exe with no console to share, so a
/// console program it spawns (a sidecar, node, git) would otherwise flash a
/// terminal window of its own. Elsewhere this does nothing.
pub trait NoConsole {
    fn no_console(&mut self) -> &mut Self;
}

impl NoConsole for std::process::Command {
    fn no_console(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

impl NoConsole for tokio::process::Command {
    fn no_console(&mut self) -> &mut Self {
        #[cfg(windows)]
        self.creation_flags(CREATE_NO_WINDOW);
        self
    }
}

/// Repo build outputs, for a bare `cargo run` outside the app bundle.
fn dev_candidates(name: &str) -> Vec<PathBuf> {
    let sidecars = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sidecars");
    let mut candidates = Vec::new();

    // Any sidecar folder's `.out/bin/` (the folder name need not match the
    // executable name).
    if let Ok(entries) = std::fs::read_dir(&sidecars) {
        for entry in entries.flatten() {
            candidates.push(entry.path().join(".out").join("bin").join(name));
        }
    }

    // A SwiftPM sidecar built by hand with `swift build`: the binary lands
    // under an arch-triple directory (e.g. .build/arm64-apple-macosx/debug/)
    // and SwiftPM exposes the active config via .build/{debug,release}.
    let build_dir = sidecars.join(name).join(".build");
    for sub in [
        "debug",
        "release",
        "arm64-apple-macosx/debug",
        "arm64-apple-macosx/release",
        "x86_64-apple-macosx/debug",
        "x86_64-apple-macosx/release",
    ] {
        candidates.push(build_dir.join(sub).join(name));
    }

    candidates
}
