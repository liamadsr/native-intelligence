/// C-callable wrapper to suppress macOS App Nap for this process.
///
/// App Nap throttles/suspends background apps — pausing timers, the render
/// loop, and JS execution in the WebView. For Native Intelligence that causes the window to
/// freeze and then "catch up" (draining a backlog of reconnects/timers) when
/// brought back to the foreground. We hold a process-lifetime activity
/// assertion so the app keeps getting scheduled while backgrounded.
///
/// NOTE: This intentionally does NOT keep the *system* awake — the recording
/// path uses a separate IOPMAssertion (sleep_guard.rs) for that. Here we only
/// opt out of App Nap, while still allowing the Mac to sleep normally.

#ifndef APP_NAP_HELPER_H
#define APP_NAP_HELPER_H

#include <stdbool.h>

/// Begin a background activity that disables App Nap for the lifetime of the
/// process. Safe to call once at startup. Idempotent — repeated calls keep the
/// first assertion and return true. Returns true if the assertion is held.
bool app_nap_disable(void);

#endif
