//! The dashboard window's backdrop: Preferences → Background → Glass in the
//! web app makes the window see-through, so the chat and every page float over
//! the desktop.
//!
//! The page makes its own surfaces transparent; [`set_window_backdrop`] changes
//! what is behind them at the native layer (window_helper.m,
//! `window_set_backdrop`): the opaque surface setup paints (Off), or a
//! transparent window the window server blurs behind by `blur` points (Glass),
//! at the strength the web app asks for (its Opacity slider changes only the
//! page's tint on top).
//!
//! The live agent's HUD (`agent-hud`, a transparent rounded panel) takes Glass
//! too, its own way: a vibrancy layer masked to its corners
//! (`window_set_glass_panel`), since the window server blur covers the whole
//! window rectangle and would show past the panel's curve.
//!
//! Each dashboard window's choice is kept here so the ThemeChanged handler in
//! lib.rs re-asserts it instead of painting the opaque surface back on top
//! (the HUD's layer survives that handler's clear_window_background).
//!
//! Command (in build.rs `APP_COMMANDS` and lib.rs `generate_handler!`):
//! `set_window_backdrop { mode: "off" | "glass", blur?: number, dark?: bool }`.
use std::collections::HashMap;
use std::sync::Mutex;

use tauri::WebviewWindow;

/// What sits behind the page in one dashboard window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Backdrop {
    Off,
    /// See-through, blurred behind by `blur` points (0: unblurred).
    Glass { blur: u8 },
}

/// Strongest blur the page may ask for, in points.
const MAX_BLUR: f64 = 64.0;
/// Glass without a `blur`: about the frosted look of the system's materials.
const DEFAULT_BLUR: u8 = 30;

impl Backdrop {
    pub(crate) fn parse(mode: &str, blur: Option<f64>) -> Result<Self, String> {
        match mode {
            "off" => Ok(Backdrop::Off),
            "glass" => {
                let blur = blur
                    .filter(|b| b.is_finite())
                    .map(|b| b.clamp(0.0, MAX_BLUR).round() as u8)
                    .unwrap_or(DEFAULT_BLUR);
                Ok(Backdrop::Glass { blur })
            }
            other => Err(format!("Unknown window backdrop: {other}")),
        }
    }

    /// window_helper.h DIAL8_BACKDROP_MODE_*, blur radius.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn native_args(self) -> (i32, i32) {
        match self {
            Backdrop::Off => (0, 0),
            Backdrop::Glass { blur } => (1, i32::from(blur)),
        }
    }
}

/// The one overlay that takes Glass: the live agent's HUD.
pub(crate) const GLASS_PANEL_LABEL: &str = "agent-hud";
/// The HUD sheet's corner radius (GlassBackdrop's rounded-[28px] in the web app).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const GLASS_PANEL_CORNER_RADIUS: f64 = 28.0;

/// Whether a window with this label may set its backdrop: dashboard windows,
/// and the agent HUD. The other overlays own their look.
fn may_set_backdrop(label: &str) -> bool {
    label == GLASS_PANEL_LABEL || !crate::is_hud_label(label)
}

/// Each dashboard window's Glass backdrop, by label. Off windows aren't kept.
static BACKDROPS: Mutex<Option<HashMap<String, Backdrop>>> = Mutex::new(None);

fn remember(label: &str, backdrop: Backdrop) {
    if let Ok(mut guard) = BACKDROPS.lock() {
        let map = guard.get_or_insert_with(HashMap::new);
        if backdrop == Backdrop::Off {
            map.remove(label);
        } else {
            map.insert(label.to_string(), backdrop);
        }
    }
}

fn remembered(label: &str) -> Option<Backdrop> {
    BACKDROPS.lock().ok()?.as_ref()?.get(label).copied()
}

/// Drop a destroyed window's backdrop: a window recreated under the same label
/// starts opaque, as setup paints it, until its page asks again.
pub(crate) fn forget(label: &str) {
    remember(label, Backdrop::Off);
}

#[cfg(target_os = "macos")]
extern "C" {
    // window_helper.m
    fn window_set_backdrop(ns_window: *mut std::ffi::c_void, mode: i32, blur_radius: i32) -> i32;
    fn window_set_glass_panel(ns_window: *mut std::ffi::c_void, on: i32, appearance: i32, corner_radius: f64) -> i32;
}

/// window_helper.h DIAL8_BACKDROP_APPEARANCE_*.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn appearance_arg(dark: Option<bool>) -> i32 {
    match dark {
        None => 0,
        Some(false) => 1,
        Some(true) => 2,
    }
}

#[cfg(target_os = "macos")]
fn apply_native_panel(ns_window: *mut std::ffi::c_void, backdrop: Backdrop, dark: Option<bool>) -> i32 {
    let on = i32::from(backdrop != Backdrop::Off);
    unsafe { window_set_glass_panel(ns_window, on, appearance_arg(dark), GLASS_PANEL_CORNER_RADIUS) }
}

#[cfg(target_os = "macos")]
fn apply_native(ns_window: *mut std::ffi::c_void, backdrop: Backdrop) -> i32 {
    let (mode, blur) = backdrop.native_args();
    unsafe { window_set_backdrop(ns_window, mode, blur) }
}

/// For lib.rs's ThemeChanged arm: re-assert this window's Glass backdrop (main
/// thread). False when it has none, so the caller paints the opaque surface as
/// before.
#[cfg(target_os = "macos")]
pub(crate) fn reapply(label: &str, ns_window: *mut std::ffi::c_void) -> bool {
    match remembered(label) {
        Some(backdrop) => {
            apply_native(ns_window, backdrop);
            true
        }
        None => false,
    }
}

/// Set the CALLING window's backdrop: a dashboard window, or the agent HUD
/// (its panel Glass; `dark` picks the vibrancy's appearance, which the
/// dashboard's window blur doesn't have). The target is always the invoking
/// window (`WebviewWindow` is injected by tauri, never sent by the page); the
/// other overlays, which own their transparency, are refused.
///
/// Errs on anything but macOS, so the web app knows Glass can't work here and
/// keeps its surfaces opaque.
#[tauri::command]
pub fn set_window_backdrop(
    window: WebviewWindow,
    mode: String,
    blur: Option<f64>,
    dark: Option<bool>,
) -> Result<(), String> {
    if !may_set_backdrop(window.label()) {
        return Err("Only a dashboard window or the agent HUD can change its backdrop".into());
    }
    let backdrop = Backdrop::parse(&mode, blur)?;

    #[cfg(target_os = "macos")]
    {
        let panel = window.label() == GLASS_PANEL_LABEL;
        if !panel {
            remember(window.label(), backdrop);
        }
        // AppKit only on the main thread. Not waited on: a sync command may
        // already be ON the main thread, where blocking on it would deadlock.
        let target = window.clone();
        window
            .run_on_main_thread(move || {
                let Ok(ns_window) = target.ns_window() else { return };
                let code = if panel {
                    apply_native_panel(ns_window, backdrop, dark)
                } else {
                    apply_native(ns_window, backdrop)
                };
                if code != 0 {
                    crate::log_to_file(&format!(
                        "[window_backdrop] {} {:?}: not applied ({code})",
                        target.label(),
                        backdrop
                    ));
                }
            })
            .map_err(|e| e.to_string())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (backdrop, dark);
        Err("See-through windows need macOS".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_off_and_glass() {
        assert_eq!(Backdrop::parse("off", None), Ok(Backdrop::Off));
        assert_eq!(Backdrop::parse("glass", None), Ok(Backdrop::Glass { blur: DEFAULT_BLUR }));
        assert_eq!(Backdrop::parse("glass", Some(12.4)), Ok(Backdrop::Glass { blur: 12 }));
        assert!(Backdrop::parse("clear", None).is_err());
        assert!(Backdrop::parse("sky", None).is_err());
    }

    #[test]
    fn blur_is_clamped_and_never_nan() {
        assert_eq!(Backdrop::parse("glass", Some(500.0)), Ok(Backdrop::Glass { blur: 64 }));
        assert_eq!(Backdrop::parse("glass", Some(-3.0)), Ok(Backdrop::Glass { blur: 0 }));
        assert_eq!(Backdrop::parse("glass", Some(f64::NAN)), Ok(Backdrop::Glass { blur: DEFAULT_BLUR }));
    }

    #[test]
    fn native_args_match_window_helper_h() {
        assert_eq!(Backdrop::Off.native_args(), (0, 0));
        assert_eq!(Backdrop::Glass { blur: 0 }.native_args(), (1, 0));
        assert_eq!(Backdrop::Glass { blur: 40 }.native_args(), (1, 40));
    }

    #[test]
    fn only_dashboards_and_the_agent_hud_may_set_a_backdrop() {
        assert!(may_set_backdrop("main"));
        assert!(may_set_backdrop("workspace-abc"));
        assert!(may_set_backdrop("agent-hud"));
        assert!(!may_set_backdrop("meeting-hud"));
        assert!(!may_set_backdrop(crate::dictate::PANEL));
    }

    #[test]
    fn appearance_matches_window_helper_h() {
        assert_eq!(appearance_arg(None), 0);
        assert_eq!(appearance_arg(Some(false)), 1);
        assert_eq!(appearance_arg(Some(true)), 2);
    }

    #[test]
    fn off_and_forget_drop_the_window() {
        let glass = Backdrop::Glass { blur: 20 };
        remember("workspace-test", glass);
        assert_eq!(remembered("workspace-test"), Some(glass));
        remember("workspace-test", Backdrop::Off);
        assert_eq!(remembered("workspace-test"), None);
        remember("workspace-test", glass);
        forget("workspace-test");
        assert_eq!(remembered("workspace-test"), None);
    }
}
