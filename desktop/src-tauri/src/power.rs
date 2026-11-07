//! System sleep/wake epoch.
//!
//! A monotonically increasing counter bumped on every system will-sleep AND
//! did-wake notification. The mic capture stamps each cpal stream with the
//! epoch it was opened in and refuses to reuse a (paused) stream from an
//! earlier epoch: a CoreAudio input unit paused across a sleep comes back
//! "playable" — play() returns Ok — but produces no frames, which is the
//! overnight "laptop closed, app left open" dead-mic report.
//!
//! Bumping on BOTH edges (not just wake) means a stream opened in the
//! seconds between will-sleep and the actual sleep is still treated as
//! pre-sleep, and a missed wake notification can't leave a stale epoch.

use std::sync::atomic::{AtomicU64, Ordering};

static SLEEP_WAKE_EPOCH: AtomicU64 = AtomicU64::new(0);

/// The current sleep/wake epoch. Cheap (one atomic load); safe from any thread.
pub fn epoch() -> u64 {
    SLEEP_WAKE_EPOCH.load(Ordering::SeqCst)
}

#[cfg(target_os = "macos")]
extern "C" {
    // power_helper.m — NSWorkspace will-sleep / did-wake observers. Idempotent;
    // must be called on the main thread.
    fn power_helper_register(cb: extern "C" fn(std::os::raw::c_int));
}

/// Start observing system sleep/wake. Call once, early, on the main thread
/// (lib.rs setup()). macOS: NSWorkspace's notifications; Windows: the
/// suspend/resume callback. Elsewhere a no-op, and the epoch stays 0.
pub fn install() {
    #[cfg(target_os = "macos")]
    unsafe {
        power_helper_register(on_power_event);
    }
    #[cfg(target_os = "windows")]
    windows_power::register();
}

/// Called by power_helper.m on the main thread.
#[cfg(target_os = "macos")]
extern "C" fn on_power_event(kind: std::os::raw::c_int) {
    on_power(kind);
}

/// A power event: 0 = will sleep, 1 = did wake. Must stay trivial: an atomic
/// bump and a log line. Any power event bumps the epoch — an unexpected `kind`
/// included — because a spurious bump only costs one stream reopen, while a
/// missed one costs a dead mic.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn on_power(kind: i32) {
    let epoch = SLEEP_WAKE_EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
    let msg = match kind {
        0 => format!("[power] system will sleep (epoch {})", epoch),
        1 => format!("[power] system did wake (epoch {})", epoch),
        other => format!("[power] unknown power event kind={} (epoch {})", other, epoch),
    };
    crate::log_to_file(&msg);
    // A wake: the input supervisor re-reads the lid and the devices (the lid
    // may have opened or closed while asleep). A channel send.
    if kind == 1 {
        crate::audio::input_devices::poke();
    }
}

/// Windows: `PowerRegisterSuspendResumeNotification`'s callback, for the
/// process's life. Resume raises both RESUMEAUTOMATIC and (when someone's
/// there) RESUMESUSPEND: two bumps, which only cost a reopen.
#[cfg(target_os = "windows")]
mod windows_power {
    use std::ffi::c_void;
    use std::sync::Once;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Power::{PowerRegisterSuspendResumeNotification, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS};
    use windows::Win32::UI::WindowsAndMessaging::DEVICE_NOTIFY_CALLBACK;

    const PBT_APMSUSPEND: u32 = 4;
    const PBT_APMRESUMESUSPEND: u32 = 7;
    const PBT_APMRESUMEAUTOMATIC: u32 = 18;

    static ONCE: Once = Once::new();

    pub fn register() {
        ONCE.call_once(|| {
            // Leaked: Windows keeps the pointer for the registration's life,
            // which is the process's.
            let params: &'static mut DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS = Box::leak(Box::new(
                DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS { Callback: Some(on_suspend_resume), Context: std::ptr::null_mut() },
            ));
            let mut registration: *mut c_void = std::ptr::null_mut();
            // SAFETY: `params` lives for the process; the handle out-pointer
            // is a live local.
            let rc = unsafe {
                PowerRegisterSuspendResumeNotification(
                    DEVICE_NOTIFY_CALLBACK,
                    HANDLE(params as *mut DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS as *mut c_void),
                    &mut registration,
                )
            };
            crate::log_to_file(&format!("[power] suspend/resume notifications registered (rc={})", rc.0));
        });
    }

    unsafe extern "system" fn on_suspend_resume(_context: *const c_void, kind: u32, _setting: *const c_void) -> u32 {
        match kind {
            PBT_APMSUSPEND => super::on_power(0),
            PBT_APMRESUMESUSPEND | PBT_APMRESUMEAUTOMATIC => super::on_power(1),
            _ => {}
        }
        0 // ERROR_SUCCESS
    }
}
