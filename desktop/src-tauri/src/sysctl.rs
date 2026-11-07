//! Reading macOS `sysctl` values by name: the macOS version, the chip, the
//! memory size. Every reader answers `None` off macOS or when the name is
//! unknown, never panics.

use std::ffi::CStr;

/// A string value, e.g. `kern.osproductversion` → "15.6.1".
#[cfg(target_os = "macos")]
pub fn string(name: &CStr) -> Option<String> {
    let mut buf = [0u8; 256];
    let mut len = buf.len();
    // SAFETY: `buf` is writable for `len` bytes; the kernel writes at most
    // `len` bytes and stores the length it wrote.
    let rc = unsafe { libc::sysctlbyname(name.as_ptr(), buf.as_mut_ptr().cast(), &mut len, std::ptr::null_mut(), 0) };
    if rc != 0 {
        return None;
    }
    let bytes = &buf[..len.min(buf.len())];
    let bytes = bytes.split(|&b| b == 0).next().unwrap_or_default();
    std::str::from_utf8(bytes).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// A 64-bit integer value, e.g. `hw.memsize` → bytes of memory.
#[cfg(target_os = "macos")]
pub fn u64(name: &CStr) -> Option<u64> {
    let mut value: u64 = 0;
    let mut len = std::mem::size_of::<u64>();
    // SAFETY: `value` is writable for `len` bytes.
    let rc = unsafe { libc::sysctlbyname(name.as_ptr(), (&mut value as *mut u64).cast(), &mut len, std::ptr::null_mut(), 0) };
    (rc == 0 && len == std::mem::size_of::<u64>()).then_some(value)
}

/// A 32-bit integer value, e.g. `sysctl.proc_translated` → 1 under Rosetta.
#[cfg(target_os = "macos")]
pub fn i32(name: &CStr) -> Option<i32> {
    let mut value: i32 = 0;
    let mut len = std::mem::size_of::<i32>();
    // SAFETY: `value` is writable for `len` bytes.
    let rc = unsafe { libc::sysctlbyname(name.as_ptr(), (&mut value as *mut i32).cast(), &mut len, std::ptr::null_mut(), 0) };
    (rc == 0 && len == std::mem::size_of::<i32>()).then_some(value)
}

#[cfg(not(target_os = "macos"))]
pub fn string(_name: &CStr) -> Option<String> {
    None
}

#[cfg(not(target_os = "macos"))]
pub fn u64(_name: &CStr) -> Option<u64> {
    None
}

#[cfg(not(target_os = "macos"))]
pub fn i32(_name: &CStr) -> Option<i32> {
    None
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn reads_the_running_mac() {
        let version = super::string(c"kern.osproductversion").expect("macOS version");
        assert!(version.split('.').next().unwrap().parse::<u32>().unwrap() >= 13, "{version}");
        assert!(super::u64(c"hw.memsize").unwrap() >= 4 * 1024 * 1024 * 1024);
        assert!(super::string(c"machdep.cpu.brand_string").is_some());
        assert_eq!(super::string(c"no.such.name"), None);
        assert_eq!(super::u64(c"no.such.name"), None);
    }
}
