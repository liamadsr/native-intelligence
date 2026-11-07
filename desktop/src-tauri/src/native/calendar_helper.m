/// C-callable wrapper for EventKit calendar access.
/// Runs in the main app process so macOS can show the permission dialog.

#import "calendar_helper.h"
#import <EventKit/EventKit.h>
#import <dispatch/dispatch.h>

bool calendar_request_access(void) {
    EKAuthorizationStatus currentStatus = [EKEventStore authorizationStatusForEntityType:EKEntityTypeEvent];
    NSLog(@"[calendar_helper] current status: %ld, requesting access...", (long)currentStatus);

    // If previously denied, macOS won't show the dialog again — caller must open System Settings.
    if (currentStatus == EKAuthorizationStatusDenied || currentStatus == EKAuthorizationStatusRestricted) {
        NSLog(@"[calendar_helper] access denied/restricted — must grant via System Settings");
        return false;
    }

    // Use a semaphore to block until the user responds to the dialog.
    // The EventKit request must be dispatched to the main thread for macOS
    // to show the TCC permission dialog, so we use dispatch_async + semaphore
    // when called from a background thread, or dispatch_sync from main.
    __block BOOL granted = NO;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);

    EKEventStore *store = [[EKEventStore alloc] init];

    void (^completionHandler)(BOOL, NSError *) = ^(BOOL ok, NSError *error) {
        NSLog(@"[calendar_helper] requestAccess result: granted=%d error=%@", ok, error);
        granted = ok;
        dispatch_semaphore_signal(sem);
    };

    void (^requestBlock)(void) = ^{
        if (@available(macOS 14.0, *)) {
            [store requestFullAccessToEventsWithCompletion:completionHandler];
        } else {
            [store requestAccessToEntityType:EKEntityTypeEvent completion:completionHandler];
        }
    };

    if ([NSThread isMainThread]) {
        // Already on main thread — call directly, completion fires on a background queue
        requestBlock();
    } else {
        // Dispatch to main thread for TCC dialog
        dispatch_async(dispatch_get_main_queue(), requestBlock);
    }

    // Wait up to 60 seconds for user to respond to dialog
    dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC);
    long result = dispatch_semaphore_wait(sem, timeout);

    if (result != 0) {
        NSLog(@"[calendar_helper] timed out waiting for user response");
        return false;
    }

    return granted;
}

bool calendar_check_access(void) {
    EKAuthorizationStatus status = [EKEventStore authorizationStatusForEntityType:EKEntityTypeEvent];
    if (@available(macOS 14.0, *)) {
        return status == EKAuthorizationStatusFullAccess;
    }
    return status == EKAuthorizationStatusAuthorized;
}
