use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

use crate::log_to_file;

const STORE_FILE: &str = "settings.json";

/// Store key of [`AppSettings::echo_cancellation_in_captures`].
const ECHO_CANCELLATION_KEY: &str = "echo_cancellation_in_captures";

/// Store key of the Input Device Priority list (audio::input_devices).
const INPUT_DEVICES_KEY: &str = "input_devices";

/// Store key of the user's speech level per input device UID (voice::levels).
const VOICE_SPEECH_LEVELS_KEY: &str = "voice_speech_levels";

/// Store key of the read-selection hotkey's settings (read_selection).
const READ_SELECTION_KEY: &str = "read_selection";
const DICTATE_KEY: &str = "dictate_anywhere";
/// Store key of the speech Speed setting (modules::tts).
const TTS_RATE_KEY: &str = "tts_rate";

/// Bump when a stored value needs a one-time migration (see [`migrate`]).
/// v2: auto_record used to default to true and got persisted on machines
/// where the user never chose it — reset it to the new opt-in default.
/// v3: the single `preferred_mic_device` (a name) gives way to the
/// `input_devices` priority list.
const SETTINGS_VERSION: u64 = 4;

/// User-facing settings that persist across app restarts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    /// Whether automatic meeting detection is enabled.
    pub meeting_detection_enabled: bool,
    /// Whether detected meetings auto-start recording (vs. showing a prompt).
    pub auto_record: bool,
    /// Whether to capture system audio alongside mic.
    pub capture_system_audio: bool,
    /// Whether closing the MAIN window hides it (app keeps running in the tray)
    /// instead of really closing it. Only affects the "main" label.
    pub close_to_tray_enabled: bool,
    /// Whether meeting captures clean the other participants' voices (played
    /// on the speakers, picked up by the mic) out of the mic before it is
    /// transcribed. Only acts when system audio is captured (it is the
    /// reference); the mic WAV is always the raw mic. Read at capture start.
    pub echo_cancellation_in_captures: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            meeting_detection_enabled: true,
            // Off by default: auto-record silently starts captures (mic +
            // system-audio tap) the moment a call is detected, with no user
            // action. That must be an explicit opt-in.
            auto_record: false,
            capture_system_audio: true,
            // On by default: the whole point of the desktop app is that
            // notifications, realtime, and in-progress recordings keep running
            // after the user clicks the red button. Quit is still one Cmd+Q or
            // one tray "Quit Dial8" away.
            close_to_tray_enabled: true,
            // On by default (chat-voice.md §3.5): on speakers, 80–90% of the
            // remote words are otherwise transcribed a second time as the user.
            echo_cancellation_in_captures: true,
        }
    }
}

impl AppSettings {
    /// Load settings from the Tauri store, falling back to defaults for missing keys.
    pub fn load(app: &AppHandle) -> Self {
        let store = match app.store(STORE_FILE) {
            Ok(s) => s,
            Err(e) => {
                log_to_file(&format!("[settings] failed to open store: {}", e));
                return Self::default();
            }
        };

        let defaults = Self::default();

        if let Some(done) = migrate(&*store, &defaults) {
            log_to_file(&format!("[settings] {done}"));
        }

        let meeting_detection_enabled = store
            .get("meeting_detection_enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(defaults.meeting_detection_enabled);

        let auto_record = store
            .get("auto_record")
            .and_then(|v| v.as_bool())
            .unwrap_or(defaults.auto_record);

        let capture_system_audio = store
            .get("capture_system_audio")
            .and_then(|v| v.as_bool())
            .unwrap_or(defaults.capture_system_audio);

        let close_to_tray_enabled = store
            .get("close_to_tray_enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(defaults.close_to_tray_enabled);

        let echo_cancellation_in_captures = store
            .get(ECHO_CANCELLATION_KEY)
            .and_then(|v| v.as_bool())
            .unwrap_or(defaults.echo_cancellation_in_captures);

        let settings = Self {
            meeting_detection_enabled,
            auto_record,
            capture_system_audio,
            close_to_tray_enabled,
            echo_cancellation_in_captures,
        };

        log_to_file(&format!("[settings] loaded: detection={}, auto_record={}, sys_audio={}, close_to_tray={}, echo_cancellation={}",
            settings.meeting_detection_enabled,
            settings.auto_record,
            settings.capture_system_audio,
            settings.close_to_tray_enabled,
            settings.echo_cancellation_in_captures,
        ));

        settings
    }
}

/// The few store operations [`migrate`] needs, so it can run against a plain
/// map in tests.
trait Kv {
    fn get(&self, key: &str) -> Option<serde_json::Value>;
    fn set(&self, key: &str, value: serde_json::Value);
    fn delete(&self, key: &str) -> bool;
}

impl<R: tauri::Runtime> Kv for tauri_plugin_store::Store<R> {
    fn get(&self, key: &str) -> Option<serde_json::Value> {
        tauri_plugin_store::Store::get(self, key)
    }
    fn set(&self, key: &str, value: serde_json::Value) {
        tauri_plugin_store::Store::set(self, key, value)
    }
    fn delete(&self, key: &str) -> bool {
        tauri_plugin_store::Store::delete(self, key)
    }
}

/// One-time migrations up to [`SETTINGS_VERSION`]; what was done, or None
/// when the store is current.
/// - v1 → v2: reset auto_record to its default (opt-in).
/// - v2 → v3: delete `preferred_mic_device` and seed `input_devices` as not
///   customised (the system default, which is what production used: the
///   only picker that ever set a name was a lower-environment test UI). The
///   device list itself fills in at the input-device supervisor's first
///   pass at startup, and at every device change after.
fn migrate(store: &impl Kv, defaults: &AppSettings) -> Option<String> {
    let from = store.get("settings_version").and_then(|v| v.as_u64()).unwrap_or(1);
    if from >= SETTINGS_VERSION {
        return None;
    }
    let mut done = Vec::new();
    if from < 2 {
        store.set("auto_record", json!(defaults.auto_record));
        done.push(format!("auto_record reset to {}", defaults.auto_record));
    }
    if from < 3 {
        if store.delete("preferred_mic_device") {
            done.push("preferred_mic_device removed".to_string());
        }
        if store.get(INPUT_DEVICES_KEY).is_none() {
            store.set(INPUT_DEVICES_KEY, json!(crate::audio::input_devices::StoredInputs::default()));
            done.push("input_devices seeded (not customised)".to_string());
        }
    }
    if from < 4 {
        // The cloud browser's Mac exit asked and had a switch until 0.2.99; now it is always on.
        for key in ["browser_exit_allowed", "browser_exit_accounts"] {
            if store.delete(key) {
                done.push(format!("{key} removed"));
            }
        }
    }
    store.set("settings_version", json!(SETTINGS_VERSION));
    Some(format!("migrated v{from}→v{SETTINGS_VERSION}: {}", done.join(", ")))
}

// Individual setters — each writes a single key and saves immediately.

pub fn set_meeting_detection_enabled(app: &AppHandle, enabled: bool) {
    if let Ok(store) = app.store(STORE_FILE) {
        store.set("meeting_detection_enabled", json!(enabled));
        log_to_file(&format!("[settings] saved meeting_detection_enabled={}", enabled));
    }
}

pub fn set_auto_record(app: &AppHandle, enabled: bool) {
    if let Ok(store) = app.store(STORE_FILE) {
        store.set("auto_record", json!(enabled));
        log_to_file(&format!("[settings] saved auto_record={}", enabled));
    }
}

pub fn set_capture_system_audio(app: &AppHandle, enabled: bool) {
    if let Ok(store) = app.store(STORE_FILE) {
        store.set("capture_system_audio", json!(enabled));
        log_to_file(&format!("[settings] saved capture_system_audio={}", enabled));
    }
}

pub fn set_close_to_tray_enabled(app: &AppHandle, enabled: bool) {
    if let Ok(store) = app.store(STORE_FILE) {
        store.set("close_to_tray_enabled", json!(enabled));
        log_to_file(&format!("[settings] saved close_to_tray_enabled={}", enabled));
    }
}

/// The echo-cancellation-in-captures setting alone (read at every capture
/// start, so it skips the full load and its log line). Missing or unreadable
/// store → the default (on).
pub fn echo_cancellation_in_captures(app: &AppHandle) -> bool {
    app.store(STORE_FILE)
        .ok()
        .and_then(|store| store.get(ECHO_CANCELLATION_KEY))
        .and_then(|v| v.as_bool())
        .unwrap_or(AppSettings::default().echo_cancellation_in_captures)
}

pub fn set_echo_cancellation_in_captures(app: &AppHandle, enabled: bool) {
    if let Ok(store) = app.store(STORE_FILE) {
        store.set(ECHO_CANCELLATION_KEY, json!(enabled));
        log_to_file(&format!("[settings] saved {}={}", ECHO_CANCELLATION_KEY, enabled));
    }
}

/// The speech Speed setting, 0.5×–4×. Missing or unreadable → 1×.
pub fn tts_rate(app: &AppHandle) -> f32 {
    app.store(STORE_FILE)
        .ok()
        .and_then(|store| store.get(TTS_RATE_KEY))
        .and_then(|v| v.as_f64())
        .map(|rate| crate::audio::time_stretch::clamp_rate(rate as f32))
        .unwrap_or(1.0)
}

pub fn set_tts_rate(app: &AppHandle, rate: f32) {
    if let Ok(store) = app.store(STORE_FILE) {
        store.set(TTS_RATE_KEY, json!(rate));
        log_to_file(&format!("[settings] saved {}={}", TTS_RATE_KEY, rate));
    }
}

/// The Input Device Priority list. Missing or unreadable → not customised,
/// no devices (the system default).
pub fn input_devices(app: &AppHandle) -> crate::audio::input_devices::StoredInputs {
    app.store(STORE_FILE)
        .ok()
        .and_then(|store| store.get(INPUT_DEVICES_KEY))
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

pub fn set_input_devices(app: &AppHandle, value: &crate::audio::input_devices::StoredInputs) {
    if let Ok(store) = app.store(STORE_FILE) {
        store.set(INPUT_DEVICES_KEY, json!(value));
    }
}

/// The chat voice's remembered speech level per input device UID
/// (voice::levels). Missing or unreadable → none.
pub fn voice_speech_levels(app: &AppHandle) -> crate::voice::levels::Levels {
    app.store(STORE_FILE)
        .ok()
        .and_then(|store| store.get(VOICE_SPEECH_LEVELS_KEY))
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

pub fn set_voice_speech_levels(app: &AppHandle, value: &crate::voice::levels::Levels) {
    if let Ok(store) = app.store(STORE_FILE) {
        store.set(VOICE_SPEECH_LEVELS_KEY, json!(value));
    }
}

/// Read selection aloud (read_selection): off until the user turns it on in
/// Settings → Read aloud, since it needs the Accessibility permission.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ReadSelectionSettings {
    pub enabled: bool,
    /// A `read_selection::HOTKEYS` id, or `"custom"` for `custom_hotkey`.
    pub hotkey: String,
    /// The shortcut the user recorded, kept when they pick a preset again.
    pub custom_hotkey: Option<crate::read_selection::keys::CustomHotkey>,
    /// A `tts_voices` id; `None` is the catalogue default.
    pub voice: Option<String>,
}

impl Default for ReadSelectionSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            hotkey: crate::read_selection::DEFAULT_HOTKEY.to_string(),
            custom_hotkey: None,
            voice: None,
        }
    }
}

/// Missing or unreadable → the defaults (off).
pub fn read_selection(app: &AppHandle) -> ReadSelectionSettings {
    app.store(STORE_FILE)
        .ok()
        .and_then(|store| store.get(READ_SELECTION_KEY))
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

pub fn set_read_selection(app: &AppHandle, value: &ReadSelectionSettings) {
    if let Ok(store) = app.store(STORE_FILE) {
        store.set(READ_SELECTION_KEY, json!(value));
        log_to_file(&format!(
            "[settings] saved read_selection enabled={} hotkey={} voice={:?}",
            value.enabled, value.hotkey, value.voice
        ));
    }
}

/// Dictate anywhere (dictate.rs): off until the user turns it on, since it needs
/// the same Accessibility permission as Read aloud.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DictateSettings {
    pub enabled: bool,
}

/// Missing or unreadable → off.
pub fn dictate(app: &AppHandle) -> DictateSettings {
    app.store(STORE_FILE)
        .ok()
        .and_then(|store| store.get(DICTATE_KEY))
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

pub fn set_dictate(app: &AppHandle, value: &DictateSettings) {
    if let Ok(store) = app.store(STORE_FILE) {
        store.set(DICTATE_KEY, json!(value));
        log_to_file(&format!("[settings] saved dictate enabled={}", value.enabled));
    }
}

// Local modules — `modules` is a map of module id → { enabled }. Device-local
// on purpose: it is about this Mac's hardware and downloaded model files, not
// the workspace. See src/modules/.

pub fn module_enabled(app: &AppHandle, id: &str) -> bool {
    app.store(STORE_FILE)
        .ok()
        .and_then(|store| store.get("modules"))
        .and_then(|modules| modules.get(id).and_then(|m| m.get("enabled")).and_then(|v| v.as_bool()))
        .unwrap_or(false)
}

pub fn set_module_enabled(app: &AppHandle, id: &str, enabled: bool) {
    if let Ok(store) = app.store(STORE_FILE) {
        let mut modules = store
            .get("modules")
            .filter(|v| v.is_object())
            .unwrap_or_else(|| json!({}));
        modules[id] = json!({ "enabled": enabled });
        store.set("modules", modules);
        log_to_file(&format!("[settings] saved modules.{}.enabled={}", id, enabled));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::cell::RefCell;
    use std::collections::BTreeMap;

    #[derive(Default)]
    struct Map(RefCell<BTreeMap<String, serde_json::Value>>);

    impl Kv for Map {
        fn get(&self, key: &str) -> Option<serde_json::Value> {
            self.0.borrow().get(key).cloned()
        }
        fn set(&self, key: &str, value: serde_json::Value) {
            self.0.borrow_mut().insert(key.to_string(), value);
        }
        fn delete(&self, key: &str) -> bool {
            self.0.borrow_mut().remove(key).is_some()
        }
    }

    fn map(pairs: &[(&str, serde_json::Value)]) -> Map {
        let m = Map::default();
        for (k, v) in pairs {
            m.set(k, v.clone());
        }
        m
    }

    #[test]
    fn migrates_v3_to_v4_dropping_the_mac_exit_answers() {
        let store = map(&[
            ("settings_version", json!(3)),
            ("browser_exit_allowed", json!(false)),
            ("browser_exit_accounts", json!(["user-1"])),
            ("auto_record", json!(true)),
        ]);
        let done = migrate(&store, &AppSettings::default()).expect("a migration");
        assert!(done.contains("browser_exit_allowed removed") && done.contains("browser_exit_accounts removed"), "{done}");
        assert_eq!(store.get("browser_exit_allowed"), None);
        assert_eq!(store.get("browser_exit_accounts"), None);
        assert_eq!(store.get("auto_record"), Some(json!(true)));
        assert_eq!(store.get("settings_version"), Some(json!(4)));
    }

    #[test]
    fn migrates_v2_to_v3_dropping_the_preferred_mic() {
        let store = map(&[
            ("settings_version", json!(2)),
            ("auto_record", json!(true)),
            ("preferred_mic_device", json!("MacBook Pro Microphone")),
        ]);
        let done = migrate(&store, &AppSettings::default()).expect("a migration");
        assert!(done.contains("v2→v4"), "{done}");
        assert_eq!(store.get("preferred_mic_device"), None);
        assert_eq!(store.get("settings_version"), Some(json!(4)));
        assert_eq!(store.get("input_devices"), Some(json!({"customised": false, "devices": []})));
        // v2 already had its auto_record reset: a choice made since stands.
        assert_eq!(store.get("auto_record"), Some(json!(true)));
        // Current now: nothing more to do.
        assert_eq!(migrate(&store, &AppSettings::default()), None);
    }

    #[test]
    fn migrates_v1_through_both_steps() {
        let store = map(&[("auto_record", json!(true)), ("preferred_mic_device", serde_json::Value::Null)]);
        migrate(&store, &AppSettings::default()).expect("a migration");
        assert_eq!(store.get("auto_record"), Some(json!(false)));
        assert_eq!(store.get("preferred_mic_device"), None);
        assert_eq!(store.get("settings_version"), Some(json!(4)));
    }

    #[test]
    fn migration_keeps_an_existing_priority_list() {
        let list = json!({"customised": true, "devices": [{"uid": "A", "name": "AirPods", "firstSeenAt": "x", "lastSeenAt": "x"}]});
        let store = map(&[("settings_version", json!(2)), ("input_devices", list.clone())]);
        migrate(&store, &AppSettings::default());
        assert_eq!(store.get("input_devices"), Some(list.clone()));
        // And it parses (modelUid and transport default).
        let parsed: crate::audio::input_devices::StoredInputs = serde_json::from_value(list).unwrap();
        assert!(parsed.customised);
        assert_eq!(parsed.devices[0].transport, crate::audio::input_devices::Transport::Other);
    }

    #[test]
    fn echo_cancellation_in_captures_is_on_by_default() {
        assert!(AppSettings::default().echo_cancellation_in_captures);
        assert_eq!(ECHO_CANCELLATION_KEY, "echo_cancellation_in_captures");
    }
}
