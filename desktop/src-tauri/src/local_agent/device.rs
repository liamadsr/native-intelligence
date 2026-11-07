//! This Mac, as the server's device registry knows it (l1-contract C1):
//! `local_agent_device` → `{ deviceId, name, platform, appVersion }`. The id
//! is a uuid made once and kept in state.json ([`super::state::StateFile`]);
//! the name is the one the person gave the Mac (System Settings → General →
//! Sharing), from `scutil --get ComputerName`, else the hostname.

use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;

/// `scutil` answers in milliseconds; never hold a command up for long.
const SCUTIL_TIMEOUT: Duration = Duration::from_secs(2);
/// Longest name sent, in characters.
const MAX_NAME: usize = 100;
const FALLBACK_NAME: &str = "Mac";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub device_id: String,
    pub name: String,
    pub platform: String,
    pub app_version: String,
}

/// A display name: control characters dropped, trimmed, at most
/// [`MAX_NAME`] characters; `None` when nothing is left.
pub fn clean_name(raw: &str) -> Option<String> {
    let name: String = raw.chars().filter(|c| !c.is_control()).collect();
    let name: String = name.trim().chars().take(MAX_NAME).collect();
    let name = name.trim().to_string();
    (!name.is_empty()).then_some(name)
}

/// The hostname without `.local`.
fn hostname() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let mut buf = [0u8; 256];
        // SAFETY: gethostname writes at most buf.len() bytes into buf.
        let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
        if rc != 0 {
            return None;
        }
        let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
        let host = String::from_utf8_lossy(&buf[..end]).into_owned();
        clean_name(host.strip_suffix(".local").unwrap_or(&host))
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

async fn scutil_computer_name() -> Option<String> {
    let mut cmd = tokio::process::Command::new("/usr/sbin/scutil");
    cmd.args(["--get", "ComputerName"])
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(SCUTIL_TIMEOUT, cmd.output()).await.ok()?.ok()?;
    if !out.status.success() {
        return None;
    }
    clean_name(&String::from_utf8_lossy(&out.stdout))
}

/// The Mac's name for the device list.
pub async fn computer_name() -> String {
    if let Some(name) = scutil_computer_name().await {
        return name;
    }
    hostname().unwrap_or_else(|| FALLBACK_NAME.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_cleaned() {
        assert_eq!(
            clean_name("Liam's MacBook Pro\n").as_deref(),
            Some("Liam's MacBook Pro")
        );
        assert_eq!(clean_name("  a\u{7}b  ").as_deref(), Some("ab"));
        assert_eq!(clean_name(" \n"), None);
        assert_eq!(clean_name(&"x".repeat(300)).unwrap().chars().count(), MAX_NAME);
    }

    #[tokio::test]
    async fn the_computer_has_a_name() {
        let name = computer_name().await;
        assert!(!name.is_empty() && name.chars().count() <= MAX_NAME, "{name:?}");
    }

    #[test]
    fn device_info_is_camel_case() {
        let v = serde_json::to_value(DeviceInfo {
            device_id: "d".into(),
            name: "n".into(),
            platform: "macos".into(),
            app_version: "0.2.86".into(),
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({"deviceId":"d","name":"n","platform":"macos","appVersion":"0.2.86"})
        );
    }
}
