#ifndef TAP_HELPER_H
#define TAP_HELPER_H

#include <stdint.h>
#include <stdbool.h>

/// Create a system audio process tap and aggregate device.
/// Returns the aggregate device ID on success, or 0 on failure.
/// The tap captures all system audio except the calling process.
/// `tap_id_out` receives the tap object ID for later cleanup.
/// `device_uid_out` receives the aggregate device UID string (caller must free).
uint32_t tap_helper_create(uint32_t *tap_id_out, char **device_uid_out);

/// Destroy a previously created tap and aggregate device.
void tap_helper_destroy(uint32_t tap_id, uint32_t aggregate_device_id);

/// Check if CATapDescription is available (macOS 14.4+).
bool tap_helper_is_available(void);

/// LEGACY — this is NOT a permission check. Creates a process tap and
/// immediately destroys it. Tap creation succeeds even when the "Audio
/// Capture" TCC permission is denied or was never granted (macOS enforces it
/// only when IO starts on the tap-backed aggregate device), so this can never
/// detect a denial. The truthful status/request is tcc_helper.h; this survives
/// only as request_screen_capture_permission's fallback for a macOS where the
/// private TCC API is missing.
/// Returns: 1 = tap created (NOT proof of permission), 0 = tap creation
/// failed, -1 = unavailable (pre-14.4 / CATapDescription missing).
int tap_helper_probe_permission(void);

#endif
