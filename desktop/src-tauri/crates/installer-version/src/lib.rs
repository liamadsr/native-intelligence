//! The product version inside a Windows installer: its VERSIONINFO's fixed
//! `ProductVersion`, which the Tauri NSIS bundler writes as the app's
//! `X.Y.Z.0` (`VIProductVersion`). The app installs an update only when this
//! equals the manifest's version and is newer than itself (app_update.rs), the
//! counterpart of the Mac's Info.plist read. NSIS stubs are 32-bit PEs;
//! 64-bit ones read the same.

/// `X.Y.Z` from the installer's bytes, or why there is none.
pub fn installer_version(exe: &[u8]) -> Result<String, String> {
    let file = pelite::PeFile::from_bytes(exe).map_err(|e| format!("the update isn't an installer: {e}"))?;
    let resources = file.resources().map_err(|e| format!("the update's installer has no resources: {e}"))?;
    let info = resources.version_info().map_err(|e| format!("the update's installer has no version: {e}"))?;
    let fixed = info.fixed().ok_or("the update's installer has no version")?;
    let v = fixed.dwProductVersion;
    if v.Build != 0 {
        return Err(format!("the update's installer version {v} isn't one the bundler writes"));
    }
    Ok(format!("{}.{}.{}", v.Major, v.Minor, v.Patch))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_that_arent_a_pe_are_refused() {
        assert!(installer_version(b"MZ, not really a PE").unwrap_err().contains("isn't an installer"));
        assert!(installer_version(&[]).is_err());
        assert!(installer_version(&[0u8; 4096]).is_err());
    }

    /// Real Windows binaries, 64-bit (System32) and 32-bit (SysWOW64, the
    /// kind an NSIS stub is): their VERSIONINFO reads. Their fourth part isn't
    /// 0, so each is either refused for that alone or reads as 10.x.
    #[cfg(windows)]
    #[test]
    fn reads_real_32_and_64_bit_binaries() {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        for dir in ["System32", "SysWOW64"] {
            let bytes = std::fs::read(format!(r"{root}\{dir}\kernel32.dll")).unwrap();
            match installer_version(&bytes) {
                Ok(v) => assert!(v.starts_with("10."), "{dir}: {v}"),
                Err(e) => assert!(e.contains("isn't one the bundler writes"), "{dir}: {e}"),
            }
        }
    }
}
