#pragma once

/// System sleep/wake notifications for the Rust side (src/power.rs).
///
/// Why: a persistent cpal input stream that was PAUSED across a system sleep
/// comes back "playable" but dead — play() returns Ok and no frames ever
/// arrive. The mic capture tags each stream with a sleep/wake epoch and never
/// reuses one opened before a sleep; this helper is what bumps that epoch.

/// Invoked on the main thread (NSWorkspace posts these there).
/// kind: 0 = NSWorkspaceWillSleepNotification, 1 = NSWorkspaceDidWakeNotification.
typedef void (*power_event_cb)(int kind);

/// Register `cb` for system will-sleep / did-wake. Idempotent: only the first
/// call registers (later calls are ignored). The observers live for the process
/// lifetime. Call from the main thread (lib.rs setup() does).
void power_helper_register(power_event_cb cb);
