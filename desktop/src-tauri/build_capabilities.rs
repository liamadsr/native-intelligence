//! Which capability files a build reads. A module of build.rs, and of
//! tests/capability_policy.rs, which calls it directly.

/// The capability files a build reads, as tauri-build's glob, for Cargo's
/// `PROFILE`. A release build reads `default.json` alone (exactly
/// https://dial8.ai); a debug build adds `dev.json`, the same grants for the
/// local dev server (http://localhost:3000, where dev.sh's build points the
/// main window). So no released app grants a native command to whatever
/// listens on localhost (security review 2026-10-31).
pub fn capabilities_pattern(profile: &str) -> &'static str {
    if profile == "release" {
        "./capabilities/default.json"
    } else {
        "./capabilities/*.json"
    }
}
