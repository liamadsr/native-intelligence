/// Tauri commands for reading Exchange calendar events from macOS Calendar.app
/// via the Swift sidecar's EventKit integration.

use crate::sidecar::NoConsole;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

/// A hung EventKit/Exchange query must not hold a command forever; the
/// sidecar is killed on expiry (kill_on_drop).
const SIDECAR_TIMEOUT: Duration = Duration::from_secs(30);

// MARK: - Types

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeCalendarInfo {
    pub id: String,
    pub title: String,
    pub account_name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarStatusResult {
    pub has_access: bool,
    pub exchange_calendars: Vec<ExchangeCalendarInfo>,
}

// MARK: - Sidecar Helper

fn sidecar_path() -> Option<PathBuf> {
    crate::sidecar::path(crate::sidecar::SYSTEM_AUDIO_CAPTURE)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarWriteResult {
    pub success: bool,
    pub event_id: Option<String>,
    pub error: Option<String>,
}

async fn run_sidecar(args: &[&str]) -> Result<String, String> {
    let path = sidecar_path()
        .ok_or_else(|| "Calendar sidecar not found. Build with: cd sidecars/system-audio-capture && swift build".to_string())?;

    let mut cmd = tokio::process::Command::new(&path);
    cmd.no_console();
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(SIDECAR_TIMEOUT, cmd.output())
        .await
        .map_err(|_| format!("Sidecar command {:?} timed out after {:?}", args, SIDECAR_TIMEOUT))?
        .map_err(|e| format!("Failed to run sidecar at {:?}: {}", path, e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Sidecar command {:?} failed: {}", args, stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// MARK: - Tauri Commands

// FFI: calendar_helper.m compiled into the main binary via build.rs (macOS
// only). Elsewhere there is no local calendar store to read: the web app's
// Google / Microsoft calendars cover it, so access is simply never granted.
#[cfg(target_os = "macos")]
mod ffi {
    extern "C" {
        pub fn calendar_request_access() -> bool;
        pub fn calendar_check_access() -> bool;
    }
}

#[cfg(target_os = "macos")]
unsafe fn calendar_request_access() -> bool {
    ffi::calendar_request_access()
}
#[cfg(target_os = "macos")]
unsafe fn calendar_check_access() -> bool {
    ffi::calendar_check_access()
}
#[cfg(not(target_os = "macos"))]
unsafe fn calendar_request_access() -> bool {
    false
}
#[cfg(not(target_os = "macos"))]
unsafe fn calendar_check_access() -> bool {
    false
}

/// Request EventKit calendar access.
/// If access is already granted, reads calendar data via sidecar.
/// Otherwise triggers the native macOS TCC permission dialog and blocks
/// until the user responds (up to 60s). Falls back to opening System Settings
/// only if the user previously denied access (macOS won't re-prompt).
///
/// The calendar commands are async: a sync command runs on the main thread,
/// and these wait on a sidecar (and here on the permission dialog).
#[tauri::command]
pub async fn request_calendar_access() -> Result<CalendarStatusResult, String> {
    let has_access = unsafe { calendar_check_access() };

    if has_access {
        let stdout = run_sidecar(&["calendar-check"]).await?;
        serde_json::from_str(&stdout)
            .map_err(|e| format!("Failed to parse calendar-check output: {} (raw: {})", e, stdout))
    } else {
        // Request access — blocks until user responds to the dialog, so off
        // the async workers (the helper dispatches the prompt to main itself).
        let granted = tauri::async_runtime::spawn_blocking(|| unsafe { calendar_request_access() })
            .await
            .unwrap_or(false);

        if granted {
            let stdout = run_sidecar(&["calendar-check"]).await?;
            serde_json::from_str(&stdout)
                .map_err(|e| format!("Failed to parse calendar-check output: {} (raw: {})", e, stdout))
        } else {
            // Previously denied or timed out — open System Settings for manual grant
            #[cfg(target_os = "macos")]
            let _ = Command::new("open")
                .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars")
                .spawn();

            Ok(CalendarStatusResult {
                has_access: false,
                exchange_calendars: vec![],
            })
        }
    }
}

/// Check current EventKit authorization status without triggering the permission dialog.
/// Uses the native helper (main process) for the access check, then reads
/// calendar data via the sidecar if access is granted.
#[tauri::command]
pub async fn get_local_calendar_status() -> Result<CalendarStatusResult, String> {
    let has_access = unsafe { calendar_check_access() };

    if has_access {
        let stdout = run_sidecar(&["calendar-check"]).await?;
        serde_json::from_str(&stdout)
            .map_err(|e| format!("Failed to parse calendar-check output: {} (raw: {})", e, stdout))
    } else {
        Ok(CalendarStatusResult {
            has_access: false,
            exchange_calendars: vec![],
        })
    }
}

/// Fetch Exchange calendar events from macOS Calendar.app for the given date range.
/// Returns events from Exchange-type calendar sources only.
#[tauri::command]
pub async fn get_local_exchange_events(
    time_min: String,
    time_max: String,
) -> Result<Vec<crate::state::CalendarEvent>, String> {
    let stdout = run_sidecar(&[
        "calendar-events",
        "--time-min", &time_min,
        "--time-max", &time_max,
    ])
    .await?;
    serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse calendar-events output: {} (raw: {})", e, stdout))
}

/// Run a sidecar command that reads JSON from stdin and returns JSON on stdout.
async fn run_sidecar_with_stdin(args: &[&str], stdin_json: &str) -> Result<String, String> {
    let path = sidecar_path()
        .ok_or_else(|| "Calendar sidecar not found".to_string())?;

    let mut child = tokio::process::Command::new(&path)
        .no_console()
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

    let run = async move {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(stdin_json.as_bytes()).await
                .map_err(|e| format!("Failed to write stdin: {}", e))?;
            // Dropping stdin closes the pipe so the child can read EOF
        }
        child.wait_with_output().await
            .map_err(|e| format!("Failed to wait for sidecar: {}", e))
    };
    let output = tokio::time::timeout(SIDECAR_TIMEOUT, run)
        .await
        .map_err(|_| format!("Sidecar command {:?} timed out after {:?}", args, SIDECAR_TIMEOUT))??;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Sidecar command {:?} failed: {}", args, stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Create a new event in a local Exchange calendar via EventKit.
#[tauri::command]
pub async fn create_local_exchange_event(
    calendar_id: String,
    title: String,
    start: String,
    end: String,
    is_all_day: Option<bool>,
    location: Option<String>,
    notes: Option<String>,
) -> Result<CalendarWriteResult, String> {
    let input = serde_json::json!({
        "calendarId": calendar_id,
        "title": title,
        "start": start,
        "end": end,
        "isAllDay": is_all_day,
        "location": location,
        "notes": notes,
    });

    let stdout = run_sidecar_with_stdin(&["calendar-create-event"], &input.to_string()).await?;
    serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse create result: {} (raw: {})", e, stdout))
}

/// Update an existing event in a local Exchange calendar via EventKit.
#[tauri::command]
pub async fn update_local_exchange_event(
    event_id: String,
    title: Option<String>,
    start: Option<String>,
    end: Option<String>,
    location: Option<String>,
    notes: Option<String>,
) -> Result<CalendarWriteResult, String> {
    let input = serde_json::json!({
        "eventId": event_id,
        "title": title,
        "start": start,
        "end": end,
        "location": location,
        "notes": notes,
    });

    let stdout = run_sidecar_with_stdin(&["calendar-update-event"], &input.to_string()).await?;
    serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse update result: {} (raw: {})", e, stdout))
}

/// Delete an event from a local Exchange calendar via EventKit.
#[tauri::command]
pub async fn delete_local_exchange_event(
    event_id: String,
) -> Result<CalendarWriteResult, String> {
    let stdout = run_sidecar(&["calendar-delete-event", "--event-id", &event_id]).await?;
    serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse delete result: {} (raw: {})", e, stdout))
}
