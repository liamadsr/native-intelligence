//! `system_info`: the Mac the app runs on, for the web's diagnostics
//! (dial8-website src/lib/speech-diagnostics.ts). The web registers it on
//! every PostHog event, so failures can be broken down by macOS version and
//! chip; the webview's user agent can't tell, because WebKit freezes the
//! macOS version it reports at 10.15.7.
//!
//! `presence_state`: whether the person is at this Mac right now, so the
//! always-on agent can text them when they're away instead of writing into
//! an app nobody is looking at.

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    /// e.g. "15.6.1".
    pub macos_version: Option<String>,
    /// e.g. "10.0.26100" (Windows 11 24H2 is build 26100). Left out on macOS.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub windows_version: Option<String>,
    /// e.g. "Apple M2 Max".
    pub chip: Option<String>,
    /// The architecture this build runs as: "aarch64" or "x86_64".
    pub arch: &'static str,
    /// Physical memory in bytes.
    pub memory_bytes: Option<u64>,
    /// Running translated by Rosetta 2.
    pub rosetta: bool,
}

#[cfg(not(target_os = "windows"))]
pub fn system_info_now() -> SystemInfo {
    SystemInfo {
        macos_version: crate::sysctl::string(c"kern.osproductversion"),
        windows_version: None,
        chip: crate::sysctl::string(c"machdep.cpu.brand_string"),
        arch: std::env::consts::ARCH,
        memory_bytes: crate::sysctl::u64(c"hw.memsize"),
        rosetta: crate::sysctl::i32(c"sysctl.proc_translated") == Some(1),
    }
}

#[cfg(target_os = "windows")]
pub fn system_info_now() -> SystemInfo {
    SystemInfo {
        macos_version: None,
        windows_version: windows_info::version(),
        chip: windows_info::cpu_name(),
        arch: std::env::consts::ARCH,
        memory_bytes: windows_info::memory_bytes(),
        rosetta: false,
    }
}

/// Windows' build number (19041 is 2004, 22000 the first Windows 11).
#[cfg(target_os = "windows")]
pub fn windows_build() -> Option<u32> {
    windows_info::version_parts().map(|(_, _, build)| build)
}

#[cfg(target_os = "windows")]
mod windows_info {
    use windows::core::w;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX, OSVERSIONINFOW};

    /// The real version (RtlGetVersion: GetVersionEx answers what the
    /// manifest says it supports): major, minor, build.
    pub fn version_parts() -> Option<(u32, u32, u32)> {
        let mut info = OSVERSIONINFOW { dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32, ..Default::default() };
        // SAFETY: a sized OSVERSIONINFOW out-parameter.
        let status = unsafe { windows::Wdk::System::SystemServices::RtlGetVersion(&mut info) };
        status.is_ok().then_some((info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber))
    }

    pub fn version() -> Option<String> {
        version_parts().map(|(major, minor, build)| format!("{major}.{minor}.{build}"))
    }

    pub fn cpu_name() -> Option<String> {
        let mut buf = [0u16; 256];
        let mut size = std::mem::size_of_val(&buf) as u32;
        // SAFETY: `buf` is `size` bytes, and RegGetValueW NUL-terminates REG_SZ.
        let rc = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                w!("HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0"),
                w!("ProcessorNameString"),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        if rc.is_err() {
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let name = String::from_utf16_lossy(&buf[..len]).trim().to_string();
        (!name.is_empty()).then_some(name)
    }

    pub fn memory_bytes() -> Option<u64> {
        let mut status = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        // SAFETY: a sized MEMORYSTATUSEX out-parameter.
        unsafe { GlobalMemoryStatusEx(&mut status) }.ok().map(|_| status.ullTotalPhys)
    }
}

#[tauri::command]
pub fn system_info() -> SystemInfo {
    system_info_now()
}

/// What `presence_state` answers, serialized as
/// `{ "idleSeconds": number, "locked": boolean }` and nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceState {
    /// Seconds since the last keyboard, mouse or trackpad input anywhere on
    /// the Mac (not just in Native Intelligence). Always finite and >= 0.
    pub idle_seconds: f64,
    /// The screen is locked, or this user's session isn't the one on the
    /// console (fast user switching put someone else in front of it).
    pub locked: bool,
}

/// `invoke('presence_state')` → `{ idleSeconds: number, locked: boolean }`.
///
/// Whether the person is at this Mac: the web app (dial8-website) reads it so
/// the always-on agent texts them when they're away. Takes nothing from the
/// page and answers only these two values. No permission prompt: idle time
/// comes from the HID system event state, the lock from the Quartz session
/// dictionary.
///
/// The lid is deliberately NOT read (audio/lid.rs): a closed lid with an
/// external display still means they're there.
///
/// On Windows it reads the same two answers (presence_state_now); elsewhere
/// it fails with `"unsupported"`, and the web falls back to window focus.
#[tauri::command]
pub fn presence_state() -> Result<PresenceState, String> {
    presence_state_now()
}

#[cfg(target_os = "macos")]
pub fn presence_state_now() -> Result<PresenceState, String> {
    let idle = presence::seconds_since_last_input();
    if !idle.is_finite() {
        return Err(format!("idle time unavailable ({idle})"));
    }
    Ok(PresenceState { idle_seconds: idle.max(0.0), locked: presence::session_locked() })
}

/// Windows: idle time from the last input anywhere in the session
/// (GetLastInputInfo); locked when this session can't open the input
/// desktop, which is Winlogon's while the PC is locked, and another
/// session's after a user switch.
#[cfg(target_os = "windows")]
pub fn presence_state_now() -> Result<PresenceState, String> {
    use windows::Win32::Foundation::BOOL;
    use windows::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS};
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    let mut last = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    // SAFETY: a sized LASTINPUTINFO out-parameter; plain queries.
    let (ok, now) = unsafe { (GetLastInputInfo(&mut last).as_bool(), GetTickCount()) };
    if !ok {
        return Err("idle time unavailable".into());
    }
    // Both are the 32-bit tick count, which wraps every ~49.7 days.
    let idle_ms = now.wrapping_sub(last.dwTime);
    // SAFETY: a desktop handle closed at once; failure is the answer.
    let locked = match unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), BOOL(0), DESKTOP_READOBJECTS) } {
        Ok(desktop) => {
            let _ = unsafe { CloseDesktop(desktop) };
            false
        }
        Err(_) => true,
    };
    Ok(PresenceState { idle_seconds: idle_ms as f64 / 1000.0, locked })
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn presence_state_now() -> Result<PresenceState, String> {
    Err("unsupported".into())
}

/// Locked = the screen-lock flag is set, OR the session says it's not on the
/// console (fast user switch). A key that's missing (the lock flag is absent
/// while unlocked) or isn't a boolean says nothing either way.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn is_locked(screen_is_locked: Option<bool>, on_console: Option<bool>) -> bool {
    screen_is_locked == Some(true) || on_console == Some(false)
}

#[cfg(target_os = "macos")]
mod presence {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;

    /// `kCGEventSourceStateHIDSystemState` (CGEventTypes.h, int32_t enum).
    const HID_SYSTEM_STATE: i32 = 1;
    /// `kCGAnyInputEventType`, `((CGEventType)(~0))` (CGEventTypes.h).
    const ANY_INPUT_EVENT_TYPE: u32 = !0;
    /// Present (true) only while the screen is locked. Undocumented, but the
    /// key every lock check on macOS reads.
    const SCREEN_IS_LOCKED_KEY: &str = "CGSSessionScreenIsLocked";
    /// `kCGSessionOnConsoleKey` (CGSession.h): note the string's extra S.
    const ON_CONSOLE_KEY: &str = "kCGSSessionOnConsoleKey";

    // The core-graphics 0.24 crate binds neither function.
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
        fn CGSessionCopyCurrentDictionary() -> CFDictionaryRef;
    }

    pub fn seconds_since_last_input() -> f64 {
        // SAFETY: a pure query with plain-value arguments.
        unsafe { CGEventSourceSecondsSinceLastEventType(HID_SYSTEM_STATE, ANY_INPUT_EVENT_TYPE) }
    }

    pub fn session_locked() -> bool {
        // SAFETY: a +1 CFDictionaryRef (or NULL outside a GUI session) we own,
        // wrapped under the create rule so it's released on drop.
        let raw = unsafe { CGSessionCopyCurrentDictionary() };
        if raw.is_null() {
            return false;
        }
        let session: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_create_rule(raw) };
        let flag = |key: &'static str| session.find(CFString::from_static_string(key)).and_then(|v| as_bool(&v));
        super::is_locked(flag(SCREEN_IS_LOCKED_KEY), flag(ON_CONSOLE_KEY))
    }

    /// A CFBoolean, or a CFNumber read as nonzero = true.
    fn as_bool(value: &CFType) -> Option<bool> {
        if let Some(b) = value.downcast::<CFBoolean>() {
            return Some(b.into());
        }
        value.downcast::<CFNumber>().and_then(|n| n.to_i64()).map(|n| n != 0)
    }
}

#[cfg(test)]
mod presence_tests {
    use super::{is_locked, PresenceState};

    #[test]
    fn locked_when_the_screen_is_locked_or_the_session_is_off_the_console() {
        assert!(!is_locked(None, None), "no keys (or no session) → not locked");
        assert!(!is_locked(None, Some(true)), "unlocked, on console");
        assert!(!is_locked(Some(false), Some(true)));
        assert!(is_locked(Some(true), Some(true)), "screen locked");
        assert!(is_locked(Some(true), None));
        assert!(is_locked(None, Some(false)), "fast user switch");
        assert!(is_locked(Some(false), Some(false)));
    }

    #[test]
    fn serializes_only_idle_seconds_and_locked_in_camel_case() {
        let json = serde_json::to_value(PresenceState { idle_seconds: 12.5, locked: true }).unwrap();
        assert_eq!(json, serde_json::json!({ "idleSeconds": 12.5, "locked": true }));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reads_this_macs_presence() {
        let state = super::presence_state().expect("presence_state on macOS");
        assert!(state.idle_seconds >= 0.0 && state.idle_seconds.is_finite(), "{state:?}");
        let json = serde_json::to_value(state).unwrap();
        let keys: Vec<_> = json.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["idleSeconds", "locked"], "{json}");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn reads_this_pcs_presence() {
        let state = super::presence_state().expect("presence_state on Windows");
        assert!(state.idle_seconds >= 0.0 && state.idle_seconds.is_finite(), "{state:?}");
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    #[test]
    fn unsupported_elsewhere() {
        assert_eq!(super::presence_state(), Err("unsupported".to_string()));
    }
}

#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    #[test]
    fn describes_this_pc_in_camel_case() {
        let json = serde_json::to_value(super::system_info_now()).unwrap();
        assert!(json["windowsVersion"].as_str().is_some_and(|v| v.starts_with("10.")), "{json}");
        assert!(json["macosVersion"].is_null(), "{json}");
        assert!(json["chip"].as_str().is_some(), "{json}");
        assert!(json["memoryBytes"].as_u64().unwrap() > 0, "{json}");
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn describes_this_mac_in_camel_case() {
        let json = serde_json::to_value(super::system_info_now()).unwrap();
        assert!(json["macosVersion"].as_str().is_some(), "{json}");
        assert!(json["windowsVersion"].is_null(), "{json}");
        assert!(json["chip"].as_str().is_some(), "{json}");
        assert!(json["memoryBytes"].as_u64().unwrap() > 0, "{json}");
        assert!(matches!(json["arch"].as_str(), Some("aarch64") | Some("x86_64")), "{json}");
        assert!(json["rosetta"].is_boolean(), "{json}");
    }
}
