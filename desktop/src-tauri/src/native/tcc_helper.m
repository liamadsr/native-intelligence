/// C-callable wrappers for the system-audio TCC permission
/// (kTCCServiceAudioCapture). Runs in the main app process so the grant is
/// charged to ai.dial8.desktop.
///
/// Why this exists: Core Audio process taps are gated by kTCCServiceAudioCapture,
/// but macOS enforces it ONLY when IO starts on the tap-backed aggregate device
/// (the sidecar's AudioDeviceStart). AudioHardwareCreateProcessTap returns noErr
/// and a valid tap even when the permission is denied or was never granted —
/// a denied capture just delivers zero-filled buffers. So creating a tap (the
/// old tap_helper_probe_permission) can never detect a denial. The only
/// status/request API for this service is the private TCC framework, the same
/// approach insidegui/AudioCap uses; Native Intelligence ships Developer ID + notarized (not
/// the App Store), so private API use is acceptable here.
///
/// The framework is loaded with dlopen + dlsym (no link-time dependency), so a
/// future macOS that drops or renames these symbols degrades to -1
/// ("unavailable") instead of failing to launch. TCCAccessRequest's prompt
/// needs NSAudioCaptureUsageDescription in Info.plist (present in
/// src-tauri/Info.plist for all builds).

#import "tcc_helper.h"
#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>
#import <dlfcn.h>

// Raw TCCAccessPreflight results. VERIFIED on macOS 27.0 against tccd's own
// AUTHREQ_RESULT log lines — do not "fix" these to match a guess:
//   0 = granted, 1 = denied, 2 = not determined.
enum {
    kDial8PreflightGranted = 0,
    kDial8PreflightDenied = 1,
    kDial8PreflightNotDetermined = 2,
};

typedef int (*TCCAccessPreflightFn)(CFStringRef service, CFDictionaryRef options);
typedef void (*TCCAccessRequestFn)(CFStringRef service,
                                   CFDictionaryRef options,
                                   void (^callback)(BOOL granted));

static TCCAccessPreflightFn gTCCAccessPreflight = NULL;
static TCCAccessRequestFn gTCCAccessRequest = NULL;

/// dlopen/dlsym exactly once per process. Both symbols are required: a
/// half-present API would let us see a status we could never act on, so either
/// missing makes the whole API "unavailable" (-1).
static BOOL tcc_api_loaded(void) {
    static dispatch_once_t once;
    static BOOL loaded = NO;
    dispatch_once(&once, ^{
        void *handle = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC",
                              RTLD_NOW | RTLD_LOCAL);
        if (!handle) {
            const char *err = dlerror();
            NSLog(@"[tcc_helper] dlopen(TCC.framework) failed: %s — system audio permission API unavailable",
                  err ? err : "unknown error");
            return;
        }
        void *preflight = dlsym(handle, "TCCAccessPreflight");
        void *request = dlsym(handle, "TCCAccessRequest");
        if (!preflight || !request) {
            NSLog(@"[tcc_helper] TCC symbol lookup failed (TCCAccessPreflight=%p, TCCAccessRequest=%p) — system audio permission API unavailable",
                  preflight, request);
            return;
        }
        gTCCAccessPreflight = (TCCAccessPreflightFn)preflight;
        gTCCAccessRequest = (TCCAccessRequestFn)request;
        loaded = YES;
    });
    return loaded;
}

int audio_capture_permission_status(void) {
    if (!tcc_api_loaded()) {
        return -1;
    }
    int raw = gTCCAccessPreflight(CFSTR("kTCCServiceAudioCapture"), NULL);
    switch (raw) {
        case kDial8PreflightGranted:
            return 1;
        case kDial8PreflightDenied:
            return 0;
        case kDial8PreflightNotDetermined:
            return 2;
        default:
            // Unknown value from a future macOS: "not determined" is the safe
            // reading — the request path then asks macOS, which answers
            // truthfully (prompt, or an immediate "no" once denied).
            NSLog(@"[tcc_helper] unexpected TCCAccessPreflight result %d — treating as not determined", raw);
            return 2;
    }
}

int audio_capture_permission_request(void) {
    if (!tcc_api_loaded()) {
        return -1;
    }
    int status = audio_capture_permission_status();
    if (status == 1) {
        NSLog(@"[tcc_helper] audio capture already granted — no prompt needed");
        return 1;
    }

    // Semaphore pattern mirrors mic_helper.m: the callback is invoked on an
    // arbitrary (non-main) queue, so blocking here is safe even on the main
    // thread — the signal always arrives. On timeout the block still owns the
    // (heap-moved) __block storage and the semaphore, so a late answer after we
    // returned is harmless.
    __block BOOL granted = NO;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);

    NSLog(@"[tcc_helper] requesting audio capture access (status=%d)", status);
    // NULL options, exactly as insidegui/AudioCap calls it
    // (TCCAccessRequest("kTCCServiceAudioCapture", nil, callback)) — the only
    // call shape verified in the wild for this service. An empty dictionary is
    // probably equivalent, but nothing has verified that.
    gTCCAccessRequest(CFSTR("kTCCServiceAudioCapture"), NULL, ^(BOOL ok) {
        NSLog(@"[tcc_helper] TCCAccessRequest result: granted=%d", ok);
        granted = ok;
        dispatch_semaphore_signal(sem);
    });

    dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, 120 * NSEC_PER_SEC);
    if (dispatch_semaphore_wait(sem, timeout) != 0) {
        NSLog(@"[tcc_helper] timed out waiting for the user to answer the audio capture prompt");
        return -2;
    }
    return granted ? 1 : 0;
}
