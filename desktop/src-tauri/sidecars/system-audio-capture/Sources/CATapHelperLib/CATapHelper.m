//
//  CATapHelper.m
//  system-audio-capture sidecar
//
//  Core Audio Taps API helper — ported from dial8 native app.
//

#import "CATapHelper.h"
#import <objc/runtime.h>
#import <CoreAudio/CoreAudio.h>
#import <AppKit/AppKit.h>

// Private-but-stable libsystem API (used by OverSight and most mic monitors):
// maps a helper/XPC process to the app responsible for it. XPC services are
// children of launchd, so a plain parent-PID walk cannot recover the host app.
extern pid_t responsibility_get_pid_responsible_for_pid(pid_t pid);

@implementation CATapHelper

+ (pid_t)responsiblePidForPid:(pid_t)pid {
    if (pid <= 0) return 0;
    @try {
        pid_t rpid = responsibility_get_pid_responsible_for_pid(pid);
        return rpid > 0 ? rpid : 0;
    } @catch (NSException *e) {
        return 0;
    }
}

+ (BOOL)isAvailable {
    if (@available(macOS 14.4, *)) {
        Class tapClass = NSClassFromString(@"CATapDescription");
        return tapClass != nil;
    }
    return NO;
}

+ (NSArray<NSNumber *> *)translatePIDsToAudioObjectIDs:(NSArray<NSNumber *> *)pids {
    if (!pids || pids.count == 0) return @[];

    NSMutableArray<NSNumber *> *objectIDs = [NSMutableArray array];
    for (NSNumber *pidNumber in pids) {
        pid_t pid = [pidNumber intValue];
        AudioObjectID processObjectID = kAudioObjectUnknown;
        UInt32 size = sizeof(AudioObjectID);

        AudioObjectPropertyAddress address = {
            kAudioHardwarePropertyTranslatePIDToProcessObject,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        OSStatus status = AudioObjectGetPropertyData(
            kAudioObjectSystemObject, &address, sizeof(pid_t), &pid, &size, &processObjectID
        );

        if (status == noErr && processObjectID != kAudioObjectUnknown) {
            [objectIDs addObject:@(processObjectID)];
        }
    }
    return objectIDs;
}

+ (nullable id)createStereoGlobalTapExcludingProcesses:(nullable NSArray<NSNumber *> *)excludedPIDs
                                               tapUUID:(NSString * _Nullable * _Nullable)tapUUID {
    if (@available(macOS 14.4, *)) {
        @try {
            Class CATapDescriptionClass = NSClassFromString(@"CATapDescription");
            if (!CATapDescriptionClass) return nil;

            NSArray<NSNumber *> *excludedObjectIDs = [self translatePIDsToAudioObjectIDs:excludedPIDs];

            id tapDescription = [[CATapDescriptionClass alloc] init];
            if (!tapDescription) return nil;

            @try { [tapDescription setValue:@"Dial8 System Audio" forKey:@"name"]; } @catch (NSException *e) {}
            @try { [tapDescription setValue:@YES forKey:@"privateTap"]; } @catch (NSException *e) {}
            @try { [tapDescription setValue:@(0) forKey:@"muteBehavior"]; } @catch (NSException *e) {}
            @try { [tapDescription setValue:@YES forKey:@"mixdown"]; } @catch (NSException *e) {}
            @try { [tapDescription setValue:@NO forKey:@"mono"]; } @catch (NSException *e) {}

            if (excludedObjectIDs.count > 0) {
                @try { [tapDescription setValue:excludedObjectIDs forKey:@"processes"]; } @catch (NSException *e) {}
                @try { [tapDescription setValue:@YES forKey:@"exclusive"]; } @catch (NSException *e) {}
            }

            if (tapUUID) {
                @try {
                    NSUUID *uuid = [tapDescription valueForKey:@"UUID"];
                    if (uuid) *tapUUID = [uuid UUIDString];
                } @catch (NSException *e) {}
            }

            return tapDescription;
        }
        @catch (NSException *exception) {
            NSLog(@"CATapHelper: Exception: %@ - %@", exception.name, exception.reason);
            return nil;
        }
    }
    return nil;
}

+ (NSArray<NSDictionary *> *)getAudioPlayingProcesses {
    NSMutableArray<NSDictionary *> *results = [NSMutableArray array];

    if (@available(macOS 14.4, *)) {
        AudioObjectPropertyAddress address = {
            kAudioHardwarePropertyProcessObjectList,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        UInt32 dataSize = 0;
        OSStatus status = AudioObjectGetPropertyDataSize(
            kAudioObjectSystemObject, &address, 0, nil, &dataSize
        );
        if (status != noErr) return results;

        UInt32 processCount = dataSize / sizeof(AudioObjectID);
        if (processCount == 0) return results;

        AudioObjectID *processIDs = (AudioObjectID *)malloc(dataSize);
        status = AudioObjectGetPropertyData(
            kAudioObjectSystemObject, &address, 0, nil, &dataSize, processIDs
        );
        if (status != noErr) { free(processIDs); return results; }

        for (UInt32 i = 0; i < processCount; i++) {
            AudioObjectID processObjectID = processIDs[i];

            // Get PID
            pid_t pid = 0;
            UInt32 pidSize = sizeof(pid_t);
            AudioObjectPropertyAddress pidAddress = {
                kAudioProcessPropertyPID,
                kAudioObjectPropertyScopeGlobal,
                kAudioObjectPropertyElementMain
            };
            status = AudioObjectGetPropertyData(processObjectID, &pidAddress, 0, nil, &pidSize, &pid);
            if (status != noErr) continue;

            // Get bundle ID
            CFStringRef bundleID = NULL;
            UInt32 bundleIDSize = sizeof(CFStringRef);
            AudioObjectPropertyAddress bundleAddress = {
                kAudioProcessPropertyBundleID,
                kAudioObjectPropertyScopeGlobal,
                kAudioObjectPropertyElementMain
            };
            AudioObjectGetPropertyData(processObjectID, &bundleAddress, 0, nil, &bundleIDSize, &bundleID);

            // Check isRunning
            UInt32 isRunning = 0;
            UInt32 isRunningSize = sizeof(UInt32);
            AudioObjectPropertyAddress runningAddress = {
                kAudioProcessPropertyIsRunning,
                kAudioObjectPropertyScopeGlobal,
                kAudioObjectPropertyElementMain
            };
            AudioObjectGetPropertyData(processObjectID, &runningAddress, 0, nil, &isRunningSize, &isRunning);

            // Check isPlaying (output)
            UInt32 isPlaying = 0;
            UInt32 isPlayingSize = sizeof(UInt32);
            AudioObjectPropertyAddress playingAddress = {
                0x7069726F,  // 'piro' - kAudioProcessPropertyIsRunningOutput
                kAudioObjectPropertyScopeGlobal,
                kAudioObjectPropertyElementMain
            };
            AudioObjectGetPropertyData(processObjectID, &playingAddress, 0, nil, &isPlayingSize, &isPlaying);

            // Check isUsingInput (microphone)
            UInt32 isUsingInput = 0;
            UInt32 isUsingInputSize = sizeof(UInt32);
            AudioObjectPropertyAddress inputAddress = {
                0x70697269,  // 'piri' - kAudioProcessPropertyIsRunningInput
                kAudioObjectPropertyScopeGlobal,
                kAudioObjectPropertyElementMain
            };
            AudioObjectGetPropertyData(processObjectID, &inputAddress, 0, nil, &isUsingInputSize, &isUsingInput);

            NSString *bundleIDString = bundleID ? (__bridge_transfer NSString *)bundleID : @"unknown";

            [results addObject:@{
                @"pid": @(pid),
                @"bundleID": bundleIDString ?: @"",
                @"isRunning": @(isRunning),
                @"isPlaying": @(isPlaying),
                @"isUsingInput": @(isUsingInput)
            }];
        }

        free(processIDs);
    }

    return results;
}

+ (BOOL)isProcessUsingInput:(pid_t)pid {
    if (@available(macOS 14.4, *)) {
        // Translate PID to AudioObjectID directly — this gives accurate real-time state
        // unlike iterating kAudioHardwarePropertyProcessObjectList which can return stale data.
        AudioObjectID processObjectID = kAudioObjectUnknown;
        UInt32 size = sizeof(AudioObjectID);

        AudioObjectPropertyAddress address = {
            kAudioHardwarePropertyTranslatePIDToProcessObject,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        OSStatus status = AudioObjectGetPropertyData(
            kAudioObjectSystemObject, &address, sizeof(pid_t), &pid, &size, &processObjectID
        );

        if (status != noErr || processObjectID == kAudioObjectUnknown) {
            return NO;
        }

        UInt32 isUsingInput = 0;
        UInt32 isUsingInputSize = sizeof(UInt32);
        AudioObjectPropertyAddress inputAddress = {
            0x70697269,  // 'piri' - kAudioProcessPropertyIsRunningInput
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };

        status = AudioObjectGetPropertyData(
            processObjectID, &inputAddress, 0, nil, &isUsingInputSize, &isUsingInput
        );

        return (status == noErr && isUsingInput != 0);
    }
    return NO;
}

@end
