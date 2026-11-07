//! The MacBook's lid (clamshell) and its built-in microphone.
//!
//! On Apple silicon and T2 Macs closing the lid disconnects the built-in mic
//! in hardware, yet CoreAudio still lists "MacBook Pro Microphone", opens it,
//! and delivers exact digital zeros: a session on it hears nothing. So while
//! the lid is closed that mic (UID [`BUILT_IN_MIC_UID`], NOT any
//! `Transport::BuiltIn` input: a mic on the headphone jack is built-in too)
//! is unavailable to every pick (`input_devices::lid_unavailable`).
//!
//! - [`closed`]: the cached state, one atomic load, what every pick reads;
//! - [`sync`]: re-read `AppleClamshellState` off `IOPMrootDomain` (absent:
//!   no lid, a desktop Mac: open), update the cache, log once per change. The
//!   input supervisor calls it on every refresh, and the resolvers before a
//!   mic start, so a missed notification costs nothing worse than staleness
//!   until the next one;
//! - [`watch`]: an IOKit general-interest notification on `IOPMrootDomain`
//!   (`kIOPMMessageClamshellStateChange`) whose callback only calls
//!   `on_change` (the supervisor's poke). A wake pokes it too (`crate::power`).

use std::sync::atomic::{AtomicU8, Ordering};

/// The built-in microphone's CoreAudio device UID on every MacBook.
pub const BUILT_IN_MIC_UID: &str = "BuiltInMicrophoneDevice";

/// `SnapshotDevice::unavailable_reason` for that mic while the lid is closed
/// (also the `voice_start` refusal's detail: `unavailable: lid_closed`).
pub const LID_CLOSED: &str = "lid_closed";

/// 0: never read (taken as open), 1: open (or no lid), 2: closed.
static STATE: AtomicU8 = AtomicU8::new(0);
const UNREAD: u8 = 0;
const OPEN: u8 = 1;
const CLOSED: u8 = 2;

/// The lid is closed, as last read ([`sync`]). False until read, and always
/// off macOS or on a Mac without a lid.
pub fn closed() -> bool {
    STATE.load(Ordering::SeqCst) == CLOSED
}

/// What a read means for the cache: the new state, and the line to log when
/// it is a change. The first read logs only a closed lid (an open one is the
/// unremarkable default).
pub fn transition(prev: u8, closed: bool) -> (u8, Option<&'static str>) {
    let next = if closed { CLOSED } else { OPEN };
    let line = match (prev, next) {
        (p, n) if p == n => None,
        (UNREAD, OPEN) => None,
        (_, CLOSED) => Some("[input-devices] lid closed: the MacBook microphone is unavailable"),
        _ => Some("[input-devices] lid open: the MacBook microphone is available again"),
    };
    (next, line)
}

/// Re-read the lid and update [`closed`]; returns it. Logs once per change.
/// One IOKit registry read (no device IO): safe from any thread, cheap
/// enough for every refresh and mic start. Never fails: an unreadable lid
/// keeps the last state.
pub fn sync() -> bool {
    let Some(now) = read() else { return closed() };
    let prev = STATE.load(Ordering::SeqCst);
    let (next, line) = transition(prev, now);
    if STATE.compare_exchange(prev, next, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
        if let Some(line) = line {
            crate::log_to_file(line);
        }
    }
    now
}

/// `AppleClamshellState` right now: Some(true) closed, Some(false) open or no
/// lid at all (the property is absent on a desktop Mac), None when the root
/// domain can't be read.
#[cfg(target_os = "macos")]
pub fn read() -> Option<bool> {
    ffi::clamshell_closed()
}

#[cfg(not(target_os = "macos"))]
pub fn read() -> Option<bool> {
    Some(false)
}

/// Call `on_change` whenever the lid opens or closes, from a private
/// dispatch queue. Registered once for the app's lifetime (never removed);
/// a second call is a no-op. `on_change` must stay trivial (a channel send).
pub fn watch(on_change: fn()) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return ffi::watch(on_change);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = on_change;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod ffi {
    use std::ffi::{c_char, c_void};
    use std::sync::OnceLock;

    use core_foundation::base::{CFType, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::string::CFString;

    type IoObject = u32;
    type KernReturn = i32;
    type InterestCallback = extern "C" fn(*mut c_void, IoObject, u32, *mut c_void);

    /// `kIOMainPortDefault` is `MACH_PORT_NULL`.
    const MAIN_PORT_DEFAULT: u32 = 0;
    /// `kIOPMMessageClamshellStateChange` (IOKit/pwr_mgt/IOPM.h):
    /// `iokit_family_msg(sub_iokit_powermanagement, 0x100)` =
    /// `err_system(0x38) | err_sub(13) | 0x100`.
    pub const CLAMSHELL_STATE_CHANGE: u32 = ((0x38 & 0x3f) << 26) | ((13 & 0xfff) << 14) | 0x100;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOServiceMatching(name: *const c_char) -> *mut c_void;
        fn IOServiceGetMatchingService(main_port: u32, matching: *mut c_void) -> IoObject;
        fn IORegistryEntryCreateCFProperty(entry: IoObject, key: *const c_void, allocator: *const c_void, options: u32) -> *const c_void;
        fn IOObjectRelease(object: IoObject) -> KernReturn;
        fn IONotificationPortCreate(main_port: u32) -> *mut c_void;
        fn IONotificationPortSetDispatchQueue(port: *mut c_void, queue: *mut c_void);
        fn IOServiceAddInterestNotification(
            port: *mut c_void,
            service: IoObject,
            interest_type: *const c_char,
            callback: InterestCallback,
            refcon: *mut c_void,
            notification: *mut IoObject,
        ) -> KernReturn;
    }

    extern "C" {
        // libdispatch (libSystem).
        fn dispatch_queue_create(label: *const c_char, attr: *const c_void) -> *mut c_void;
    }

    /// `IOPMrootDomain`, retained (release with IOObjectRelease); None when
    /// it isn't found.
    fn root_domain() -> Option<IoObject> {
        // SAFETY: IOServiceMatching returns a +1 dictionary that
        // IOServiceGetMatchingService consumes.
        let service = unsafe { IOServiceGetMatchingService(MAIN_PORT_DEFAULT, IOServiceMatching(c"IOPMrootDomain".as_ptr())) };
        (service != 0).then_some(service)
    }

    pub fn clamshell_closed() -> Option<bool> {
        let root = root_domain()?;
        let key = CFString::from_static_string("AppleClamshellState");
        // SAFETY: a +1 CFTypeRef (or null) we own and wrap under the create
        // rule; the service is released once read.
        let value = unsafe {
            let raw = IORegistryEntryCreateCFProperty(root, key.as_concrete_TypeRef() as *const c_void, std::ptr::null(), 0);
            IOObjectRelease(root);
            if raw.is_null() {
                // No such property: no lid (a desktop Mac).
                return Some(false);
            }
            CFType::wrap_under_create_rule(raw as core_foundation::base::CFTypeRef)
        };
        value.downcast::<CFBoolean>().map(bool::from)
    }

    static ON_CHANGE: OnceLock<fn()> = OnceLock::new();

    /// On the notification queue: nothing but the caller's trivial hook.
    extern "C" fn on_interest(_refcon: *mut c_void, _service: IoObject, message: u32, _argument: *mut c_void) {
        if message == CLAMSHELL_STATE_CHANGE {
            if let Some(f) = ON_CHANGE.get() {
                f();
            }
        }
    }

    pub fn watch(on_change: fn()) -> Result<(), String> {
        if ON_CHANGE.set(on_change).is_err() {
            return Ok(());
        }
        let root = root_domain().ok_or("IOPMrootDomain not found")?;
        // SAFETY: the port, queue and notification object live for the
        // app's lifetime (deliberately never released); `root` is released
        // once the notification holds its own reference.
        unsafe {
            let port = IONotificationPortCreate(MAIN_PORT_DEFAULT);
            if port.is_null() {
                IOObjectRelease(root);
                return Err("IONotificationPortCreate failed".into());
            }
            let queue = dispatch_queue_create(c"ai.dial8.lid".as_ptr(), std::ptr::null());
            IONotificationPortSetDispatchQueue(port, queue);
            let mut notification: IoObject = 0;
            let kr = IOServiceAddInterestNotification(
                port,
                root,
                c"IOGeneralInterest".as_ptr(),
                on_interest,
                std::ptr::null_mut(),
                &mut notification,
            );
            IOObjectRelease(root);
            if kr != 0 {
                return Err(format!("IOServiceAddInterestNotification failed ({kr:#x})"));
            }
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn the_clamshell_message_matches_the_sdk_macro() {
            // iokit_family_msg(sub_iokit_powermanagement, 0x100), worked out
            // from IOReturn.h / mach/error.h.
            assert_eq!(super::CLAMSHELL_STATE_CHANGE, 0xE003_4100);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transitions_log_once_per_change() {
        // First read: a closed lid is worth a line, an open one isn't.
        assert_eq!(transition(UNREAD, false), (OPEN, None));
        assert_eq!(transition(UNREAD, true).0, CLOSED);
        assert!(transition(UNREAD, true).1.unwrap().contains("lid closed"));
        // No change: nothing.
        assert_eq!(transition(OPEN, false), (OPEN, None));
        assert_eq!(transition(CLOSED, true), (CLOSED, None));
        // Each change: one line.
        assert_eq!(transition(OPEN, true).1, Some("[input-devices] lid closed: the MacBook microphone is unavailable"));
        assert_eq!(transition(CLOSED, false).1, Some("[input-devices] lid open: the MacBook microphone is available again"));
    }
}
