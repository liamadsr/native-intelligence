#pragma once

/// Raw AVAuthorizationStatus for audio capture:
/// 0 = not determined, 1 = restricted, 2 = denied, 3 = authorized.
int mic_permission_status(void);

/// Shows the system microphone prompt (macOS only ever shows it while the
/// status is not-determined) and blocks until the user responds (up to 120s).
/// Returns 1 = granted, 0 = denied, -1 = timed out.
int mic_permission_request(void);

/// Native Intelligence's Mic Mode (Control Center → Mic Mode), which macOS applies to this
/// app's microphone input: 0 = Standard, 1 = Wide Spectrum, 2 = Voice
/// Isolation (AVCaptureMicrophoneMode); -1 = unknown. A preference read: it
/// opens no device, never the microphone.
int mic_mode_preferred(void);

/// Open Control Center's Mic Mode menu. macOS lists an app there only while
/// it is using the microphone. Returns immediately (the UI is shown on the
/// main queue).
void mic_mode_show_picker(void);
