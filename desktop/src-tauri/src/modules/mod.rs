//! Local Modules — on-device capabilities, each backed by a supervised sidecar
//! process and downloadable model assets. Design and bridge contract:
//! dial8-website/docs/plans/local-modules.md.
//!
//! - `registry`   which modules this build knows (+ their module.json)
//! - `protocol`   protocol-v1 framing every sidecar speaks
//! - `supervisor` spawn / handshake / pump / reap, shared by all modules
//! - `assets`     resumable, SHA-verified model downloads
//! - `manager`    per-module state machine, settings, `module://status`
//! - `commands`   generic Tauri commands
//! - `log_tail`   each module's last log lines, for `module_log_tail`
//! - `stt`        the local-stt adapter (recording → sidecar → `stt://…`)
//! - `tts`        the local-tts service (read-aloud → sidecar → speakers, `tts://…`)

pub mod assets;
pub mod commands;
pub mod log_tail;
pub mod manager;
pub mod protocol;
pub mod registry;
pub mod stt;
pub mod supervisor;
pub mod tts;

pub use manager::ModuleManager;
