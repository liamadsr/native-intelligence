//! The list of local modules this build knows about. Adding a module = a
//! sidecar folder (with `build.sh` + `module.json`) and one entry here.

use std::time::Duration;

use serde::Deserialize;

/// When a module's sidecar process runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lifecycle {
    /// Started for a recording session, exits when it ends (local-stt).
    PerSession,
    /// Started on first use, kept for later requests, stopped after this long
    /// without any (local-tts).
    IdleTimeout(Duration),
}

pub struct ModuleSpec {
    pub id: &'static str,
    /// The module's `module.json`, compiled in so the pinned assets ship with
    /// the binary that knows how to use them.
    pub manifest_json: &'static str,
    pub lifecycle: Lifecycle,
}

pub static MODULES: &[ModuleSpec] = &[
    ModuleSpec {
        id: "local-stt",
        manifest_json: include_str!("../../sidecars/local-stt/module.json"),
        lifecycle: Lifecycle::PerSession,
    },
    ModuleSpec {
        id: "local-tts",
        manifest_json: include_str!("../../sidecars/local-tts/module.json"),
        lifecycle: Lifecycle::IdleTimeout(Duration::from_secs(5 * 60)),
    },
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleManifest {
    pub id: String,
    /// Executable name in Contents/MacOS/ (resolved via crate::sidecar).
    pub sidecar: String,
    pub protocol: u32,
    /// Oldest macOS the sidecar runs on ("13.4"), when above the app's own
    /// floor. Older systems show the module as unavailable.
    #[serde(default)]
    pub min_macos: Option<String>,
    /// Directory name for this asset set; bump when any asset changes.
    pub assets_version: String,
    pub assets: Vec<AssetSpec>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AssetSpec {
    /// Logical name the sidecar is configured with (e.g. "asr").
    pub name: String,
    pub file: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

impl ModuleSpec {
    pub fn manifest(&self) -> ModuleManifest {
        serde_json::from_str(self.manifest_json)
            .unwrap_or_else(|e| panic!("module.json for {} is invalid: {e}", self.id))
    }
}

pub fn find(id: &str) -> Option<&'static ModuleSpec> {
    MODULES.iter().find(|m| m.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_manifest_parses_and_matches_its_id() {
        for spec in MODULES {
            let m = spec.manifest();
            assert_eq!(m.id, spec.id);
            assert_eq!(m.protocol, super::super::protocol::PROTOCOL_MAJOR);
            assert!(!m.sidecar.is_empty());
            assert!(!m.assets_version.is_empty());
            assert!(!m.assets.is_empty());
            for a in &m.assets {
                assert_eq!(a.sha256.len(), 64, "{} sha256", a.file);
                assert!(a.sha256.chars().all(|c| c.is_ascii_hexdigit()), "{} sha256", a.file);
                assert!(a.url.starts_with("https://"), "{} url", a.file);
                assert!(a.url.ends_with(&a.file), "{} url names another file", a.file);
                assert!(a.size > 0);
            }
            // The configure message keys assets by name, and each lands in
            // its own file: both must be unique.
            let mut names: Vec<_> = m.assets.iter().map(|a| a.name.as_str()).collect();
            let mut files: Vec<_> = m.assets.iter().map(|a| a.file.as_str()).collect();
            names.sort();
            names.dedup();
            files.sort();
            files.dedup();
            assert_eq!(names.len(), m.assets.len(), "{}: duplicate asset name", spec.id);
            assert_eq!(files.len(), m.assets.len(), "{}: duplicate asset file", spec.id);
        }
    }

    #[test]
    fn module_ids_and_sidecars_are_unique() {
        let mut ids: Vec<_> = MODULES.iter().map(|m| m.id).collect();
        let mut sidecars: Vec<_> = MODULES.iter().map(|m| m.manifest().sidecar).collect();
        ids.sort();
        ids.dedup();
        sidecars.sort();
        sidecars.dedup();
        assert_eq!(ids.len(), MODULES.len());
        assert_eq!(sidecars.len(), MODULES.len());
    }

    #[test]
    fn lifecycles() {
        assert_eq!(find("local-stt").unwrap().lifecycle, Lifecycle::PerSession);
        let tts = find("local-tts").unwrap();
        assert_eq!(tts.lifecycle, Lifecycle::IdleTimeout(Duration::from_secs(300)));
        assert_eq!(tts.manifest().sidecar, "dial8-local-tts");
        // ONNX Runtime's floor; the app itself supports 13.0.
        assert_eq!(tts.manifest().min_macos.as_deref(), Some("13.4"));
        assert_eq!(find("local-stt").unwrap().manifest().min_macos, None);
        assert!(find("nope").is_none());
    }
}
