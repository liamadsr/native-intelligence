/// C-callable wrappers for the microphone TCC status/request via AVFoundation.
/// Runs in the main app process so the grant is charged to ai.dial8.desktop.
///
/// Why this exists: the mic prompt used to be triggered only implicitly by
/// cpal opening the input device — and a *denied* mic is invisible on that
/// path (build_input_stream + play() return Ok and CoreAudio delivers
/// zero-filled buffers, so captures "succeed" and record silence). These
/// wrappers let the app see the real TCC state and drive the prompt
/// deliberately. requestAccessForMediaType requires NSMicrophoneUsageDescription
/// in Info.plist (present in src-tauri/Info.plist for all builds) — without it
/// macOS kills the process instead of prompting.

#import "mic_helper.h"
#import <AVFoundation/AVFoundation.h>
#import <dispatch/dispatch.h>

int mic_permission_status(void) {
    return (int)[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
}

int mic_permission_request(void) {
    // Semaphore pattern mirrors calendar_helper.m: the completion handler is
    // invoked on an arbitrary (non-main) queue, so blocking here is safe even
    // when called from the main thread — the signal always arrives.
    __block BOOL granted = NO;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);

    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                             completionHandler:^(BOOL ok) {
        NSLog(@"[mic_helper] requestAccess result: granted=%d", ok);
        granted = ok;
        dispatch_semaphore_signal(sem);
    }];

    dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, 120 * NSEC_PER_SEC);
    if (dispatch_semaphore_wait(sem, timeout) != 0) {
        NSLog(@"[mic_helper] timed out waiting for user response");
        return -1;
    }
    return granted ? 1 : 0;
}

// Voice Isolation / Wide Spectrum make macOS reconfigure audio processing on
// every device each time a Dial8 process starts CoreAudio (the 2026-09-28
// coreaudiod deadlock), and Voice Isolation strips other voices in the room
// out of a meeting recording. An app can't change its own Mic Mode, only
// read it and open the menu for the user.
int mic_mode_preferred(void) {
    if (@available(macOS 12.0, *)) {
        return (int)AVCaptureDevice.preferredMicrophoneMode;
    }
    return -1;
}

void mic_mode_show_picker(void) {
    if (@available(macOS 12.0, *)) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [AVCaptureDevice showSystemUserInterface:AVCaptureSystemUserInterfaceMicrophoneModes];
        });
    }
}
