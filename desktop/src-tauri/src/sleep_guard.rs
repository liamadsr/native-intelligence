//! Prevents idle system sleep while a recording is active.
//!
//! macOS: IOPMAssertionCreateWithName / IOPMAssertionRelease from IOKit hold
//! a "PreventUserIdleSystemSleep" assertion. Windows: a power request
//! (PowerCreateRequest + PowerSetRequest(SystemRequired)), a handle that any
//! thread may clear, unlike SetThreadExecutionState. Either is released when
//! the guard is dropped. The display may still sleep, as on the Mac.

use std::sync::atomic::{AtomicU32, Ordering};

#[cfg(target_os = "macos")]
mod ffi {
    use std::ffi::c_void;

    pub type IOPMAssertionID = u32;
    pub type CFStringRef = *const c_void;

    extern "C" {
        pub fn IOPMAssertionCreateWithName(
            assertion_type: CFStringRef,
            assertion_level: u32,
            reason_for_activity: CFStringRef,
            assertion_id: *mut IOPMAssertionID,
        ) -> i32;

        pub fn IOPMAssertionRelease(assertion_id: IOPMAssertionID) -> i32;

        pub fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const u8,
            encoding: u32,
        ) -> CFStringRef;
        pub fn CFRelease(cf: *const c_void);
    }

    pub const K_CF_STRING_ENCODING_UTF8: u32 = 0x08000100;
    pub const K_IOPM_ASSERTION_LEVEL_ON: u32 = 255;
}

/// RAII guard — holds the sleep assertion while alive.
pub struct SleepGuard {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    assertion_id: AtomicU32,
    /// Windows: the power request's HANDLE, as an integer so the guard
    /// stays Send.
    #[cfg(target_os = "windows")]
    request: isize,
}

impl SleepGuard {
    /// Create a new sleep guard that prevents idle system sleep.
    /// Returns `None` if the assertion could not be created (non-macOS or IOKit error).
    pub fn new() -> Option<Self> {
        #[cfg(target_os = "macos")]
        {
            use ffi::*;
            use std::ffi::CString;

            // The well-known string value of kIOPMAssertionTypePreventUserIdleSystemSleep
            let assertion_type_str = CString::new("PreventUserIdleSystemSleep").ok()?;
            let cf_assertion_type = unsafe {
                CFStringCreateWithCString(
                    std::ptr::null(),
                    assertion_type_str.as_ptr() as *const u8,
                    K_CF_STRING_ENCODING_UTF8,
                )
            };
            if cf_assertion_type.is_null() {
                return None;
            }

            let reason = CString::new("Native Intelligence is recording audio").ok()?;
            let cf_reason = unsafe {
                CFStringCreateWithCString(
                    std::ptr::null(),
                    reason.as_ptr() as *const u8,
                    K_CF_STRING_ENCODING_UTF8,
                )
            };
            if cf_reason.is_null() {
                unsafe { CFRelease(cf_assertion_type) };
                return None;
            }

            let mut assertion_id: IOPMAssertionID = 0;
            let result = unsafe {
                IOPMAssertionCreateWithName(
                    cf_assertion_type,
                    K_IOPM_ASSERTION_LEVEL_ON,
                    cf_reason,
                    &mut assertion_id,
                )
            };

            unsafe {
                CFRelease(cf_assertion_type);
                CFRelease(cf_reason);
            };

            if result == 0 {
                // kIOReturnSuccess
                crate::log_to_file(&format!(
                    "[sleep_guard] Asserted PreventUserIdleSystemSleep (id={})",
                    assertion_id
                ));
                Some(Self {
                    assertion_id: AtomicU32::new(assertion_id),
                })
            } else {
                crate::log_to_file(&format!(
                    "[sleep_guard] IOPMAssertionCreateWithName failed: {}",
                    result
                ));
                None
            }
        }

        #[cfg(target_os = "windows")]
        {
            use windows::core::PWSTR;
            use windows::Win32::Foundation::CloseHandle;
            use windows::Win32::System::Power::{PowerCreateRequest, PowerRequestSystemRequired, PowerSetRequest};
            use windows::Win32::System::Threading::{POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0};

            let mut reason: Vec<u16> = "Native Intelligence is recording audio".encode_utf16().chain(std::iter::once(0)).collect();
            let context = REASON_CONTEXT {
                Version: 0, // POWER_REQUEST_CONTEXT_VERSION
                Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
                Reason: REASON_CONTEXT_0 { SimpleReasonString: PWSTR(reason.as_mut_ptr()) },
            };
            // SAFETY: a context whose reason string outlives the call (the
            // system copies it); the handle is closed on failure or in Drop.
            let request = match unsafe { PowerCreateRequest(&context) } {
                Ok(h) => h,
                Err(e) => {
                    crate::log_to_file(&format!("[sleep_guard] PowerCreateRequest failed: {e}"));
                    return None;
                }
            };
            if let Err(e) = unsafe { PowerSetRequest(request, PowerRequestSystemRequired) } {
                crate::log_to_file(&format!("[sleep_guard] PowerSetRequest failed: {e}"));
                let _ = unsafe { CloseHandle(request) };
                return None;
            }
            crate::log_to_file("[sleep_guard] Power request set (SystemRequired)");
            Some(Self { assertion_id: AtomicU32::new(0), request: request.0 as isize })
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            None
        }
    }
}

impl Drop for SleepGuard {
    fn drop(&mut self) {
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::Foundation::{CloseHandle, HANDLE};
            use windows::Win32::System::Power::{PowerClearRequest, PowerRequestSystemRequired};
            let request = HANDLE(self.request as *mut std::ffi::c_void);
            // SAFETY: the handle PowerCreateRequest gave this guard, released once.
            unsafe {
                let _ = PowerClearRequest(request, PowerRequestSystemRequired);
                let _ = CloseHandle(request);
            }
            crate::log_to_file("[sleep_guard] Power request cleared");
        }
        #[cfg(target_os = "macos")]
        {
            let id = self.assertion_id.load(Ordering::Relaxed);
            if id != 0 {
                let result = unsafe { ffi::IOPMAssertionRelease(id) };
                crate::log_to_file(&format!(
                    "[sleep_guard] Released assertion (id={}, result={})",
                    id, result
                ));
            }
        }
    }
}
