use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::audio::dual_stream::DualStreamManager;
use crate::audio::mic_capture::MicCapture;
use crate::audio::session::RecordingSession;
use crate::audio::system_capture::SystemCapture;
use crate::meeting_detection::MeetingDetector;
use crate::sleep_guard::SleepGuard;

// MARK: - Calendar Types

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub title: String,
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub is_all_day: bool,
    pub calendar_name: Option<String>,
    pub location: Option<String>,
    pub description: Option<String>,
    pub conference_url: Option<String>,
    pub html_link: Option<String>,
    #[serde(default)]
    pub attendees: Vec<String>,
    pub organizer: Option<String>,
    #[serde(default)]
    pub has_recurrence: bool,
    /// Event source: "server" for OAuth-fetched, "local_exchange" for EventKit
    #[serde(default)]
    pub source: Option<String>,
}

pub struct CalendarCache {
    pub today_events: Vec<CalendarEvent>,
    pub tomorrow_events: Vec<CalendarEvent>,
    pub last_refresh: Option<Instant>,
}

impl CalendarCache {
    pub fn new() -> Self {
        Self {
            today_events: Vec::new(),
            tomorrow_events: Vec::new(),
            last_refresh: None,
        }
    }
}

// MARK: - App State

/// Global application state managed by Tauri.
pub struct AppState {
    pub mic_capture: Mutex<MicCapture>,
    pub system_capture: Mutex<SystemCapture>,
    pub dual_stream: Mutex<DualStreamManager>,
    pub meeting_detector: Mutex<MeetingDetector>,
    pub current_session: Mutex<Option<String>>,
    pub session: Mutex<Option<RecordingSession>>,
    pub auth_token: Mutex<Option<String>>,
    pub auth_token_changed: Mutex<bool>,
    pub calendar_cache: Mutex<CalendarCache>,
    /// Held while recording to prevent macOS idle sleep.
    pub sleep_guard: Mutex<Option<SleepGuard>>,
    /// Label of the window that owns the active recording (None = no recording).
    /// Used to prevent multiple windows from recording simultaneously.
    pub recording_window: Mutex<Option<String>>,
    /// Mirror of AppSettings.close_to_tray_enabled, seeded at setup and updated
    /// by set_close_to_tray. An atomic (not a Mutex) because the CloseRequested
    /// handler in on_window_event runs on the Tauri event thread and must read
    /// it synchronously without any chance of blocking on a held lock or doing
    /// an async store round-trip.
    pub close_to_tray_enabled: AtomicBool,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            mic_capture: Mutex::new(MicCapture::new()),
            system_capture: Mutex::new(SystemCapture::new()),
            dual_stream: Mutex::new(DualStreamManager::new()),
            meeting_detector: Mutex::new(MeetingDetector::new()),
            current_session: Mutex::new(None),
            session: Mutex::new(None),
            auth_token: Mutex::new(None),
            auth_token_changed: Mutex::new(false),
            calendar_cache: Mutex::new(CalendarCache::new()),
            sleep_guard: Mutex::new(None),
            recording_window: Mutex::new(None),
            // Seeded from the persisted setting in lib.rs setup(); this default
            // matches AppSettings::default() so the window that exists before
            // setup runs still behaves correctly.
            close_to_tray_enabled: AtomicBool::new(true),
        }
    }
}
