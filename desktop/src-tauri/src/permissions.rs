//! Audio permission state — the ONLY place that knows the TCC result codes
//! returned by `native/tcc_helper.m`, and the owner of the System Settings
//! deep links for the two audio permissions.
//!
//! Why system audio needs its own check: Core Audio process taps are gated by
//! the `kTCCServiceAudioCapture` service, but macOS enforces it only when IO
//! starts on the tap-backed aggregate device (inside the sidecar). Creating the
//! tap succeeds even when the permission is denied or was never granted, and a
//! denied capture just delivers zero-filled buffers — so the old tap probe
//! (create + destroy a tap) always said "granted", even minutes after the user
//! turned the permission off. The private TCC framework's preflight/request is
//! the only status/request API for the service. See docs/PERMISSIONS.md.

/// The system-audio permission state (TCC service `kTCCServiceAudioCapture`,
/// shown under System Settings → Privacy & Security → Screen & System Audio
/// Recording).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemAudioPermission {
    Granted,
    Denied,
    NotDetermined,
    /// The private TCC API is missing (dlopen/dlsym failed) — status unknowable.
    Unavailable,
    /// No Core Audio process taps on this OS (< macOS 14.4) — nothing to grant.
    Unsupported,
    /// Not macOS. Only constructed off macOS.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    NotApplicable,
}

impl SystemAudioPermission {
    /// Wire vocabulary shared with the web app (tauri-bridge.ts). Mirrors
    /// check_mic_permission's spelling: "not-determined" (hyphen) but
    /// "not_applicable" (underscore).
    pub fn as_str(&self) -> &'static str {
        match self {
            SystemAudioPermission::Granted => "granted",
            SystemAudioPermission::Denied => "denied",
            SystemAudioPermission::NotDetermined => "not-determined",
            SystemAudioPermission::Unavailable => "unavailable",
            SystemAudioPermission::Unsupported => "unsupported",
            SystemAudioPermission::NotApplicable => "not_applicable",
        }
    }
}

/// Map `audio_capture_permission_status()`'s code (tcc_helper.h) to the enum.
///
/// An unknown code maps to NotDetermined, never Granted: "not determined"
/// sends the request flow back to macOS, which answers truthfully (a prompt,
/// or an immediate "no" once denied) — a code we can't read must never let a
/// capture start as if it were permitted.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn map_status_code(code: i32) -> SystemAudioPermission {
    match code {
        1 => SystemAudioPermission::Granted,
        0 => SystemAudioPermission::Denied,
        2 => SystemAudioPermission::NotDetermined,
        -1 => SystemAudioPermission::Unavailable,
        _ => SystemAudioPermission::NotDetermined,
    }
}

/// Outcome of the blocking system-audio prompt
/// (`audio_capture_permission_request()`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemAudioPromptResult {
    Granted,
    Denied,
    /// The user left the prompt unanswered for the full 120s wait.
    TimedOut,
    /// The private TCC API is missing (dlopen/dlsym failed).
    Unavailable,
}

/// Map `audio_capture_permission_request()`'s code (tcc_helper.h) to the enum.
/// An unknown code reads as Denied — never claim a grant we can't confirm.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn map_request_code(code: i32) -> SystemAudioPromptResult {
    match code {
        1 => SystemAudioPromptResult::Granted,
        0 => SystemAudioPromptResult::Denied,
        -2 => SystemAudioPromptResult::TimedOut,
        -1 => SystemAudioPromptResult::Unavailable,
        _ => SystemAudioPromptResult::Denied,
    }
}

#[cfg(target_os = "macos")]
extern "C" {
    // tap_helper.m — CATapDescription present (macOS 14.4+).
    fn tap_helper_is_available() -> bool;
    // tcc_helper.m — see tcc_helper.h for the shared result codes.
    fn audio_capture_permission_status() -> i32;
    fn audio_capture_permission_request() -> i32;
}

/// Current system-audio permission. Passive: never prompts, never shows UI,
/// cheap enough for the frontend to poll every 1.5s (one TCC preflight).
///
/// Logs `[permissions] system audio TCC status=<str>` on the first call and
/// on every CHANGE rather than on every call: the web app polls this every
/// 1.5s while a permissions surface is visible, and a line per poll would
/// bury the capture diagnostics in dial8-debug.log. Capture start
/// (system_capture.rs) logs the status it acted on unconditionally.
pub fn system_audio_permission() -> SystemAudioPermission {
    let perm = query_system_audio_permission();
    log_status_if_changed(perm);
    perm
}

#[cfg(target_os = "macos")]
fn query_system_audio_permission() -> SystemAudioPermission {
    if !unsafe { tap_helper_is_available() } {
        return SystemAudioPermission::Unsupported;
    }
    map_status_code(unsafe { audio_capture_permission_status() })
}

#[cfg(not(target_os = "macos"))]
fn query_system_audio_permission() -> SystemAudioPermission {
    SystemAudioPermission::NotApplicable
}

/// Last status logged by system_audio_permission(), as `perm as u8`
/// (u8::MAX = nothing logged yet). A racy double-log of one transition from
/// two concurrent callers is harmless, so a plain swap is enough.
static LAST_LOGGED_STATUS: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(u8::MAX);

fn log_status_if_changed(perm: SystemAudioPermission) {
    let code = perm as u8;
    if LAST_LOGGED_STATUS.swap(code, std::sync::atomic::Ordering::Relaxed) != code {
        crate::log_to_file(&format!(
            "[permissions] system audio TCC status={}",
            perm.as_str()
        ));
    }
}

/// Show the real OS system-audio prompt (only ever shown while the status is
/// not determined) and BLOCK until the user answers, up to 120s. Never call
/// this on the main thread — use spawn_blocking (a sync Tauri command runs on
/// the main thread, and the wait would freeze every window and the tray).
pub fn request_system_audio_access_blocking() -> SystemAudioPromptResult {
    #[cfg(target_os = "macos")]
    {
        map_request_code(unsafe { audio_capture_permission_request() })
    }

    #[cfg(not(target_os = "macos"))]
    {
        SystemAudioPromptResult::Unavailable
    }
}

/// System Settings → Privacy & Security → Screen & System Audio Recording.
/// `Privacy_AudioCapture` is the Audio Capture service's own anchor (verified
/// present in SecurityPrivacyExtension.appex; search title "Allow applications
/// to record your system audio") — not `Privacy_ScreenCapture`, which is the
/// screen-recording permission this app never uses.
const SYSTEM_AUDIO_SETTINGS_URL: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture";
/// System Settings → Privacy & Security → Microphone (Windows: Settings →
/// Privacy & security → Microphone).
#[cfg(not(target_os = "windows"))]
const MICROPHONE_SETTINGS_URL: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
#[cfg(target_os = "windows")]
const MICROPHONE_SETTINGS_URL: &str = "ms-settings:privacy-microphone";

/// System Settings → Privacy & Security → Accessibility (read selection aloud).
const ACCESSIBILITY_SETTINGS_URL: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

/// Open the System Settings pane for the system-audio permission — the only
/// recourse once macOS has recorded a denial (it never re-prompts).
pub fn open_system_audio_settings() {
    open_settings_pane(SYSTEM_AUDIO_SETTINGS_URL);
}

/// Open the System Settings pane for the microphone permission — the only
/// recourse once macOS has recorded a denial (it never re-prompts).
pub fn open_microphone_settings() {
    open_settings_pane(MICROPHONE_SETTINGS_URL);
}

/// Open the Accessibility pane — where the read-selection hotkey's grant
/// lives once macOS has shown its one prompt.
pub fn open_accessibility_settings() {
    open_settings_pane(ACCESSIBILITY_SETTINGS_URL);
}

fn open_settings_pane(url: &str) {
    #[cfg(target_os = "macos")]
    {
        if let Err(e) = std::process::Command::new("open").arg(url).spawn() {
            crate::log_to_file(&format!(
                "[permissions] failed to open System Settings ({}): {}",
                url, e
            ));
        }
    }

    // ms-settings: links open through the shell, like a Run box would.
    #[cfg(target_os = "windows")]
    {
        use crate::sidecar::NoConsole;
        if !url.starts_with("ms-settings:") {
            return;
        }
        if let Err(e) = std::process::Command::new("explorer.exe").no_console().arg(url).spawn() {
            crate::log_to_file(&format!("[permissions] failed to open Settings ({}): {}", url, e));
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = url;
    }
}

/// Windows: whether a Settings switch keeps this app off the microphone.
/// Windows has no prompt for desktop apps; three switches decide: the
/// device-wide one (HKLM, an admin's), "Microphone access" (HKCU) and "Let
/// desktop apps access your microphone" (HKCU NonPackaged). Each is "Allow"
/// or "Deny"; a missing one allows. Desktop apps are only ever denied
/// silently, with an open mic that records nothing, so this is the only way
/// to tell the person why.
#[cfg(target_os = "windows")]
pub fn windows_microphone_denied() -> bool {
    use windows::core::{w, PCWSTR};
    use windows::Win32::System::Registry::{RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    const STORE: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone");
    const NON_PACKAGED: PCWSTR =
        w!("Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged");
    let read = |root: HKEY, key: PCWSTR| -> Option<String> {
        let mut buf = [0u16; 32];
        let mut size = std::mem::size_of_val(&buf) as u32;
        // SAFETY: `buf` is `size` bytes; REG_SZ comes back NUL-terminated.
        let rc = unsafe { RegGetValueW(root, key, w!("Value"), RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr().cast()), Some(&mut size)) };
        if rc.is_err() {
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..len]))
    };
    // An administrator's policy: LetAppsAccessMicrophone 2 = force deny.
    let policy_denies = {
        use windows::Win32::System::Registry::RRF_RT_REG_DWORD;
        let mut value: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: a u32 out-parameter of `size` bytes.
        let rc = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                w!("SOFTWARE\\Policies\\Microsoft\\Windows\\AppPrivacy"),
                w!("LetAppsAccessMicrophone"),
                RRF_RT_REG_DWORD,
                None,
                Some((&mut value as *mut u32).cast()),
                Some(&mut size),
            )
        };
        rc.is_ok() && value == 2
    };
    policy_denies
        || [(HKEY_LOCAL_MACHINE, STORE), (HKEY_CURRENT_USER, STORE), (HKEY_CURRENT_USER, NON_PACKAGED)]
            .into_iter()
            .any(|(root, key)| read(root, key).is_some_and(|v| v.eq_ignore_ascii_case("Deny")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_code_1_is_granted() {
        assert_eq!(map_status_code(1), SystemAudioPermission::Granted);
    }

    #[test]
    fn status_code_0_is_denied() {
        assert_eq!(map_status_code(0), SystemAudioPermission::Denied);
    }

    #[test]
    fn status_code_2_is_not_determined() {
        assert_eq!(map_status_code(2), SystemAudioPermission::NotDetermined);
    }

    #[test]
    fn status_code_minus_1_is_unavailable() {
        assert_eq!(map_status_code(-1), SystemAudioPermission::Unavailable);
    }

    #[test]
    fn unknown_status_codes_are_not_determined_never_granted() {
        // -2 is a request-only code; the rest are simply unknown. None of them
        // may read as a grant.
        for code in [-2, 3, 42, i32::MIN, i32::MAX] {
            assert_eq!(
                map_status_code(code),
                SystemAudioPermission::NotDetermined,
                "code {}",
                code
            );
        }
    }

    #[test]
    fn as_str_matches_the_web_vocabulary() {
        assert_eq!(SystemAudioPermission::Granted.as_str(), "granted");
        assert_eq!(SystemAudioPermission::Denied.as_str(), "denied");
        assert_eq!(SystemAudioPermission::NotDetermined.as_str(), "not-determined");
        assert_eq!(SystemAudioPermission::Unavailable.as_str(), "unavailable");
        assert_eq!(SystemAudioPermission::Unsupported.as_str(), "unsupported");
        assert_eq!(SystemAudioPermission::NotApplicable.as_str(), "not_applicable");
    }

    #[test]
    fn request_codes_map_to_prompt_results() {
        assert_eq!(map_request_code(1), SystemAudioPromptResult::Granted);
        assert_eq!(map_request_code(0), SystemAudioPromptResult::Denied);
        assert_eq!(map_request_code(-2), SystemAudioPromptResult::TimedOut);
        assert_eq!(map_request_code(-1), SystemAudioPromptResult::Unavailable);
    }

    #[test]
    fn unknown_request_codes_are_denied_never_granted() {
        for code in [2, 3, -3, i32::MIN, i32::MAX] {
            assert_eq!(map_request_code(code), SystemAudioPromptResult::Denied, "code {}", code);
        }
    }
}
