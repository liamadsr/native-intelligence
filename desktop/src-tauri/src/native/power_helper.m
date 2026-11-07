/// NSWorkspace sleep/wake observers forwarding to a C callback (see
/// power_helper.h for why the mic capture needs them).

#import "power_helper.h"
#import <AppKit/AppKit.h>
#import <dispatch/dispatch.h>

// The observer tokens must stay strongly referenced: NSNotificationCenter's
// block-based observers are removed when the token is deallocated, so they are
// held in statics for the process lifetime and never released.
static power_event_cb gPowerCallback = NULL;
static id<NSObject> gWillSleepObserver = nil;
static id<NSObject> gDidWakeObserver = nil;

void power_helper_register(power_event_cb cb) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        if (![NSThread isMainThread]) {
            // Registration itself is thread-safe and delivery happens on the
            // posting (main) thread regardless — but setup() is the intended
            // caller, so flag an unexpected context.
            NSLog(@"[power_helper] power_helper_register called off the main thread");
        }
        gPowerCallback = cb;
        NSNotificationCenter *center = [[NSWorkspace sharedWorkspace] notificationCenter];
        // queue:nil — run the block synchronously on the posting thread. The
        // Rust callback only bumps an atomic and appends a log line, so there
        // is nothing worth deferring (and will-sleep handling must be prompt).
        gWillSleepObserver = [center addObserverForName:NSWorkspaceWillSleepNotification
                                                 object:nil
                                                  queue:nil
                                             usingBlock:^(NSNotification *note) {
            (void)note;
            if (gPowerCallback) {
                gPowerCallback(0);
            }
        }];
        gDidWakeObserver = [center addObserverForName:NSWorkspaceDidWakeNotification
                                               object:nil
                                                queue:nil
                                           usingBlock:^(NSNotification *note) {
            (void)note;
            if (gPowerCallback) {
                gPowerCallback(1);
            }
        }];
        NSLog(@"[power_helper] observing system sleep/wake");
    });
}
