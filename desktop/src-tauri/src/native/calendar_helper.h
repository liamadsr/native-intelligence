/// C-callable wrapper for EventKit calendar access.
/// Requests calendar permission from the main app process (which has a GUI),
/// so macOS shows the permission dialog properly.

#ifndef CALENDAR_HELPER_H
#define CALENDAR_HELPER_H

#include <stdbool.h>

/// Request full calendar access. Blocks until the user responds to the dialog.
/// Returns true if access was granted.
bool calendar_request_access(void);

/// Check current calendar authorization status without triggering a dialog.
/// Returns true if full access is already granted.
bool calendar_check_access(void);

#endif
