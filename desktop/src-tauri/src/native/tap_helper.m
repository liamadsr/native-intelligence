/// C-callable wrapper around Core Audio Taps API.
/// Creates a process tap from the main Rust process (which has permission).
/// Returns the tap UUID so the sidecar can create an aggregate device from it.

#import "tap_helper.h"
#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#import <objc/runtime.h>

static NSArray<NSNumber *> *translatePIDsToAudioObjectIDs(NSArray<NSNumber *> *pids) {
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

bool tap_helper_is_available(void) {
    if (@available(macOS 14.4, *)) {
        Class tapClass = NSClassFromString(@"CATapDescription");
        return tapClass != nil;
    }
    return false;
}

uint32_t tap_helper_create(uint32_t *tap_id_out, char **device_uid_out) {
    if (@available(macOS 14.4, *)) {
        @try {
            Class CATapDescriptionClass = NSClassFromString(@"CATapDescription");
            if (!CATapDescriptionClass) {
                NSLog(@"[tap_helper] CATapDescription class not found");
                return 0;
            }

            pid_t ownPID = [[NSProcessInfo processInfo] processIdentifier];
            NSArray<NSNumber *> *excludedPIDs = @[@(ownPID)];
            NSArray<NSNumber *> *excludedObjectIDs = translatePIDsToAudioObjectIDs(excludedPIDs);

            id tapDescription = [[CATapDescriptionClass alloc] init];
            if (!tapDescription) {
                NSLog(@"[tap_helper] Failed to create CATapDescription");
                return 0;
            }

            @try { [tapDescription setValue:@"Dial8 System Audio" forKey:@"name"]; } @catch (NSException *e) {}
            @try { [tapDescription setValue:@YES forKey:@"privateTap"]; } @catch (NSException *e) {}
            @try { [tapDescription setValue:@(0) forKey:@"muteBehavior"]; } @catch (NSException *e) {}
            @try { [tapDescription setValue:@YES forKey:@"mixdown"]; } @catch (NSException *e) {}
            @try { [tapDescription setValue:@NO forKey:@"mono"]; } @catch (NSException *e) {}

            // exclusive = YES makes `processes` an exclusion list, so an empty
            // one (our PID has no Core Audio object yet) is the global tap.
            // Left NO, an empty list would tap no process at all: silence.
            @try { [tapDescription setValue:@YES forKey:@"exclusive"]; } @catch (NSException *e) {}
            if (excludedObjectIDs.count > 0) {
                @try { [tapDescription setValue:excludedObjectIDs forKey:@"processes"]; } @catch (NSException *e) {}
            }

            NSString *tapUUID = nil;
            @try {
                NSUUID *uuid = [tapDescription valueForKey:@"UUID"];
                if (uuid) tapUUID = [uuid UUIDString];
            } @catch (NSException *e) {}

            if (!tapUUID) {
                NSLog(@"[tap_helper] Failed to get tap UUID");
                return 0;
            }

            AudioObjectID tapID = kAudioObjectUnknown;
            OSStatus status = AudioHardwareCreateProcessTap(
                (CATapDescription *)tapDescription, &tapID
            );
            if (status != noErr) {
                NSLog(@"[tap_helper] AudioHardwareCreateProcessTap failed: %d", (int)status);
                return 0;
            }

            NSLog(@"[tap_helper] Tap created: ID=%u UUID=%@", tapID, tapUUID);

            // Return tap ID and UUID. The sidecar will create the aggregate device
            // using the UUID (the tap is system-wide and visible to all processes).
            if (tap_id_out) *tap_id_out = tapID;
            if (device_uid_out) {
                const char *uuidStr = [tapUUID UTF8String];
                *device_uid_out = strdup(uuidStr);
            }

            return tapID;
        }
        @catch (NSException *exception) {
            NSLog(@"[tap_helper] Exception: %@ - %@", exception.name, exception.reason);
            return 0;
        }
    }
    return 0;
}

void tap_helper_destroy(uint32_t tap_id, uint32_t aggregate_device_id) {
    if (aggregate_device_id != kAudioObjectUnknown && aggregate_device_id != tap_id) {
        AudioHardwareDestroyAggregateDevice(aggregate_device_id);
    }
    if (tap_id != kAudioObjectUnknown) {
        AudioHardwareDestroyProcessTap(tap_id);
    }
    NSLog(@"[tap_helper] Cleaned up tap=%u device=%u", tap_id, aggregate_device_id);
}

int tap_helper_probe_permission(void) {
    if (@available(macOS 14.4, *)) {
        Class tapClass = NSClassFromString(@"CATapDescription");
        if (!tapClass) {
            return -1; // unavailable — Core Audio Taps API not present
        }
        // Attempt the operation a real capture performs first, then tear the
        // tap down. NOTE: this cannot detect a denied "Audio Capture"
        // permission — tap creation succeeds regardless, because macOS only
        // enforces it when IO starts on the aggregate device. The truthful
        // check is tcc_helper.m; this is kept only as a legacy fallback.
        uint32_t tap_id = 0;
        char *uid = NULL;
        uint32_t created = tap_helper_create(&tap_id, &uid);
        if (uid) {
            free(uid);
        }
        if (created != 0) {
            tap_helper_destroy(tap_id, 0);
            return 1; // tap created — NOT proof the permission is granted
        }
        return 0; // tap creation failed (not a permission verdict either)
    }
    return -1; // unavailable — pre-14.4
}
