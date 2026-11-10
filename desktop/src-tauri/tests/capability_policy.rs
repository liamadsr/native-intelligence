//! Pins what `capabilities/default.json` may grant (security review
//! 2026-10-31, P0-3).
//!
//! WHY: every Native Intelligence webview runs code the server sends, so every permission in
//! the capability is reachable by whoever controls that server (or any XSS on
//! a granted origin). Three grants turned that into native power:
//!   - `core:menu` / `core:tray` (inside `core:default`): the tray's
//!     `on_menu_event` is a GLOBAL listener, so a menu the web built with a
//!     native-only tray item's id (the coding-agent opt-in, the model, the
//!     Local Agents switch) acted as that tray item on one click;
//!   - `updater:*`: the web could call `check({ allowDowngrades: true })` and
//!     reinstall any older signed build;
//!   - `https://*.dial8.ai/*`: any subdomain (a dangling CNAME, a third-party
//!     host) got all of the above.
//! This test fails the build if any comes back.
//!
//! And `http://localhost:3000/*` is a debug build's alone: build.rs reads
//! `capabilities/dev.json` (the same grants, for the local dev server) only
//! when the profile isn't release, so whatever listens on a released app's
//! localhost gets nothing.

use std::fs;
use std::path::Path;

#[path = "../build_capabilities.rs"]
mod build_capabilities;

fn read_capability(file: &str) -> serde_json::Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities").join(file);
    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read capabilities/{file}: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse capabilities/{file}: {e}"))
}

/// The release capability.
fn capability() -> serde_json::Value {
    read_capability("default.json")
}

/// The debug builds' extra capability.
fn dev_capability() -> serde_json::Value {
    read_capability("dev.json")
}

fn remote_urls(cap: &serde_json::Value) -> Vec<String> {
    cap["remote"]["urls"]
        .as_array()
        .expect("remote.urls")
        .iter()
        .map(|u| u.as_str().expect("url string").to_string())
        .collect()
}

fn permissions(cap: &serde_json::Value) -> Vec<String> {
    cap["permissions"]
        .as_array()
        .expect("permissions array")
        .iter()
        .map(|p| match p {
            serde_json::Value::String(s) => s.clone(),
            // An object permission is `{ "identifier": ..., "allow": [...] }`.
            other => other["identifier"].as_str().expect("permission identifier").to_string(),
        })
        .collect()
}

#[test]
fn no_menu_tray_resources_or_core_default() {
    for p in permissions(&capability()) {
        assert_ne!(p, "core:default", "core:default bundles core:menu and core:tray");
        for banned in ["core:menu:", "core:tray:", "core:resources:", "core:image:", "core:path:"] {
            assert!(!p.starts_with(banned), "{p}: the web must not get {banned}*");
        }
    }
}

#[test]
fn no_updater_or_shell_permission() {
    for p in permissions(&capability()) {
        assert!(!p.starts_with("updater:"), "{p}: updates are decided in Rust (app_update.rs)");
        assert!(!p.starts_with("shell:"), "{p}: the web never runs or opens through the shell plugin");
    }
}

#[test]
fn the_update_commands_are_granted() {
    let perms = permissions(&capability());
    for p in ["allow-app-update-check", "allow-app-update-install"] {
        assert!(perms.iter().any(|x| x == p), "{p} missing: the web couldn't update the app");
    }
}

#[test]
fn remote_origins_are_exact_hosts() {
    for cap in [capability(), dev_capability()] {
        for u in &remote_urls(&cap) {
            assert!(!u.contains('*') || u.ends_with("/*"), "{u}: a wildcard may only be the path");
            let host = u.split("://").nth(1).and_then(|r| r.split(['/', ':']).next()).unwrap_or("");
            assert!(!host.contains('*'), "{u}: no wildcard hosts");
        }
    }
}

/// A released app grants native access to the app's own domains and nothing
/// else: the new one, and dial8.ai while it still serves the app (nav_guard.rs
/// `APP_DOMAINS`, which this list must match). No subdomain, no localhost.
#[test]
fn the_release_capability_allows_exactly_the_apps_domains() {
    assert_eq!(remote_urls(&capability()), ["https://nativeintelligence.dev/*", "https://dial8.ai/*"]);
    let nav_guard = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/nav_guard.rs")).unwrap();
    assert!(
        nav_guard.contains(r#"pub(crate) const APP_DOMAINS: [&str; 2] = ["nativeintelligence.dev", "dial8.ai"];"#),
        "nav_guard.rs APP_DOMAINS and capabilities/default.json remote.urls must list the same domains"
    );
}

/// The address a build loads is the same everywhere it is written: the
/// constant the app calls its API on, the committed `frontendDist` (the
/// Windows build uses it as it is) and release.sh's value for the Mac build.
#[test]
fn the_app_address_is_the_same_in_every_place_it_is_written() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let conf: serde_json::Value = serde_json::from_str(&fs::read_to_string(dir.join("tauri.conf.json")).unwrap()).unwrap();
    let address = conf["build"]["frontendDist"].as_str().unwrap();
    assert_eq!(address, "https://nativeintelligence.dev");
    let nav_guard = fs::read_to_string(dir.join("src/nav_guard.rs")).unwrap();
    assert!(nav_guard.contains(&format!(r#"pub(crate) const APP_URL: &str = "{address}";"#)), "nav_guard.rs APP_URL");
    let release = fs::read_to_string(dir.join("../release.sh")).unwrap();
    assert!(release.contains(&format!(r#"PRODUCTION_URL="{address}""#)), "release.sh PRODUCTION_URL");
    // The updater asks the new address first, then the old one.
    let endpoints: Vec<&str> = conf["plugins"]["updater"]["endpoints"].as_array().unwrap().iter().map(|e| e.as_str().unwrap()).collect();
    assert_eq!(endpoints.len(), 2);
    assert!(endpoints[0].starts_with(&format!("{address}/api/desktop/update/")), "{endpoints:?}");
    assert!(endpoints[1].starts_with("https://dial8.ai/api/desktop/update/"), "{endpoints:?}");
}

/// dev.json is default.json for the local dev server: the same windows and
/// permissions (so a grant added to one can't be missing from the other),
/// and only http://localhost:3000.
#[test]
fn the_dev_capability_mirrors_default_for_localhost_only() {
    let (release, dev) = (capability(), dev_capability());
    assert_eq!(remote_urls(&dev), ["http://localhost:3000/*"]);
    assert_ne!(dev["identifier"], release["identifier"]);
    assert_eq!(dev["windows"], release["windows"]);
    assert_eq!(dev["permissions"], release["permissions"]);
    let keys = |cap: &serde_json::Value| cap.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
    assert_eq!(keys(&dev), keys(&release), "dev.json may differ only in identifier, description and remote");
}

/// A release build reads default.json alone; any other reads every
/// capability file, and those are exactly these two.
#[test]
fn release_builds_read_default_json_only() {
    use build_capabilities::capabilities_pattern;
    assert_eq!(capabilities_pattern("release"), "./capabilities/default.json");
    assert_eq!(capabilities_pattern("debug"), "./capabilities/*.json");

    let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files: Vec<String> = fs::read_dir(dir.join("capabilities"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    files.sort();
    assert_eq!(files, ["default.json", "dev.json"], "a new capability file is read by debug builds only");

    // The one line no test build can exercise: build.rs hands the pattern
    // Cargo's PROFILE (a release build's is "release"). Pinned as text.
    let build_rs = fs::read_to_string(dir.join("build.rs")).expect("read build.rs");
    let call: String = build_rs.split_whitespace().collect();
    assert!(call.contains(r#".capabilities_path_pattern(build_capabilities::capabilities_pattern(&std::env::var("PROFILE").unwrap_or_default(),))"#));
}

/// What tauri-build resolved for this very build ($OUT_DIR/capabilities.json,
/// which the app's ACL is generated from): both files in a debug build,
/// default.json alone in a release one.
#[test]
fn this_build_resolved_the_capabilities_for_its_profile() {
    let raw = fs::read_to_string(Path::new(env!("OUT_DIR")).join("capabilities.json")).expect("tauri-build output");
    let resolved: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let ids: Vec<&String> = resolved.as_object().unwrap().keys().collect();
    let want: &[&str] = if cfg!(debug_assertions) { &["default", "dev-localhost"] } else { &["default"] };
    assert_eq!(ids, want);
    assert_eq!(remote_urls(&resolved["default"]), ["https://nativeintelligence.dev/*", "https://dial8.ai/*"]);
}
