//
//  CATapHelper.h
//  system-audio-capture sidecar
//
//  Objective-C helper for Core Audio Taps API (macOS 14.4+)
//

#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>

NS_ASSUME_NONNULL_BEGIN

API_AVAILABLE(macos(14.4))
@interface CATapHelper : NSObject

/// Create a stereo global tap excluding specified processes
+ (nullable id)createStereoGlobalTapExcludingProcesses:(nullable NSArray<NSNumber *> *)excludedPIDs
                                               tapUUID:(NSString * _Nullable * _Nullable)tapUUID;

/// Check if Core Audio Taps API is available
+ (BOOL)isAvailable;

/// Get list of audio processes with their status
/// Returns array of dicts: { pid, bundleID, isRunning, isPlaying, isUsingInput }
+ (NSArray<NSDictionary *> *)getAudioPlayingProcesses;

/// Check if a specific process (by PID) is currently using microphone input.
/// Uses PID-to-AudioObjectID translation which gives accurate real-time state.
+ (BOOL)isProcessUsingInput:(pid_t)pid;

/// Resolve the PID of the app RESPONSIBLE for a (helper) process — e.g. the
/// com.apple.WebKit.GPU XPC service that actually runs a WKWebView app's
/// audio resolves to its host app (new Teams, Safari, Dial8 itself, ...).
/// Returns 0 on failure.
+ (pid_t)responsiblePidForPid:(pid_t)pid;

@end

NS_ASSUME_NONNULL_END
