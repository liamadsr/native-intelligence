#import "app_nap_helper.h"
#import <Foundation/Foundation.h>

// Hold the activity token for the process lifetime. NSProcessInfo releases the
// activity (re-enabling App Nap) only when this object is deallocated, so we
// keep a strong reference in a static and never release it.
static id<NSObject> gActivityToken = nil;

bool app_nap_disable(void) {
    @autoreleasepool {
        if (gActivityToken != nil) {
            // Already holding the assertion — idempotent.
            return true;
        }

        NSProcessInfo *processInfo = [NSProcessInfo processInfo];
        if (![processInfo respondsToSelector:@selector(beginActivityWithOptions:reason:)]) {
            NSLog(@"[app_nap_helper] beginActivityWithOptions: unavailable on this OS");
            return false;
        }

        // NSActivityUserInitiated (0x00FFFFFF) keeps the app fully scheduled
        // (no App Nap) but, because we mask OFF NSActivityIdleSystemSleepDisabled
        // (1 << 20), we do NOT prevent the system from sleeping. The Mac can
        // still sleep on its own; we only stop *our app* from being napped.
        NSActivityOptions options =
            (NSActivityOptions)(0x00FFFFFFULL & ~(1ULL << 20));

        gActivityToken = [processInfo
            beginActivityWithOptions:options
                              reason:@"Native Intelligence keeps live meeting connections and timers responsive in the background"];

        if (gActivityToken != nil) {
            // Retain across autorelease pool drain for the process lifetime.
            gActivityToken = (__bridge id)CFRetain((__bridge CFTypeRef)gActivityToken);
            NSLog(@"[app_nap_helper] App Nap disabled (activity token held)");
            return true;
        }

        NSLog(@"[app_nap_helper] beginActivityWithOptions returned nil");
        return false;
    }
}
