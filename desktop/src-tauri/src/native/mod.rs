//! Rust-side native/platform glue.
//!
//! The rest of this directory is Objective-C helpers (`*.m`/`*.h`) compiled
//! into the binary by `build.rs` and reached through the `extern "C"` blocks in
//! `lib.rs`. This module is for native work that is cheaper to do in pure Rust
//! via `objc2` than to add another `.m` file and `build.rs` entry for.

#[cfg(target_os = "macos")]
pub mod retired_browser_stores;
#[cfg(target_os = "macos")]
pub mod web_view;
#[cfg(target_os = "macos")]
pub mod webcontent_watchdog;
