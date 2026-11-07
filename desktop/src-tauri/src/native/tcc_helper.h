#pragma once

/// System-audio ("Audio Capture", kTCCServiceAudioCapture) permission status
/// and request, via the PRIVATE TCC framework (dlopen'd at first use — there
/// is no public API for this service, and no link-time dependency on it).
///
/// Shared result codes — mirrored in src/permissions.rs, the only Rust code
/// that interprets them:
///    1 = granted
///    0 = denied
///    2 = not determined
///   -1 = private TCC API unavailable (dlopen or dlsym failed)
///   -2 = timed out waiting for the user (request only)

/// Current status via TCCAccessPreflight. Never prompts, never shows UI.
int audio_capture_permission_status(void);

/// Shows the real OS prompt via TCCAccessRequest (macOS only ever shows it
/// while the status is not determined; once denied it answers "no" at once and
/// never re-prompts) and blocks until the user responds, up to 120s. Returns 1
/// immediately when already granted.
int audio_capture_permission_request(void);
