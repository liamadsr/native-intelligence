use serde::{Deserialize, Serialize};

/// Audio format: 16kHz mono — matches Deepgram's expected input for linear16 streaming.
pub const TARGET_SAMPLE_RATE: u32 = 16000;
pub const TARGET_CHANNELS: u16 = 1;

/// Why system audio is or isn't being captured for a session. Lets the UI
/// tell the user when a meeting is recording mic-only (so it can prompt for
/// permission) instead of silently dropping the other participants' audio.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SystemAudioStatus {
    /// System audio is capturing normally.
    Capturing,
    /// User chose mic-only — system audio was not requested.
    Disabled,
    /// Requested, but the macOS System Audio Recording permission (TCC
    /// "Audio Capture", kTCCServiceAudioCapture — listed under Privacy &
    /// Security → Screen & System Audio Recording; not Screen Recording) is
    /// denied, or the Core Audio tap could not be created.
    PermissionDenied,
    /// Requested, but the capture backend is unavailable (missing/stale
    /// sidecar binary, or an unsupported OS).
    Unavailable,
    /// Requested and available, but the capture failed to start at runtime.
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSessionInfo {
    pub session_id: String,
    pub started_at: String,
    pub mic_device: Option<String>,
    pub capturing_system_audio: bool,
    /// Detailed system-audio outcome so the UI can warn / prompt when a
    /// requested system stream didn't actually engage.
    pub system_audio_status: SystemAudioStatus,
    /// Which engine transcribes this session: "local" (on-device local-stt
    /// sidecar, results arrive as `stt://message`) or "deepgram" (the web
    /// opens Deepgram as before).
    #[serde(default = "default_transcription_engine")]
    pub transcription_engine: String,
    /// Why a session that asked for local transcription got Deepgram instead.
    #[serde(default)]
    pub transcription_fallback_reason: Option<String>,
}

fn default_transcription_engine() -> String {
    "deepgram".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingResult {
    pub session_id: String,
    pub mic_file: Option<String>,
    pub system_file: Option<String>,
    pub duration_seconds: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioSource {
    Mic,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLevelPayload {
    pub mic_level: f32,
    pub system_level: f32,
    pub timestamp: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecordingStatus {
    Inactive,
    Recording,
    Paused,
}
