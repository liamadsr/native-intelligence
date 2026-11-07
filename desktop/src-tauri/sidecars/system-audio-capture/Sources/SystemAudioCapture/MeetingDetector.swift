import Foundation
import AppKit
import CATapHelperLib

/// Known meeting app bundle IDs
let knownMeetingApps: Set<String> = [
    "us.zoom.xos",
    "com.microsoft.teams",
    "com.microsoft.teams2",
    "com.tinyspeck.slackmacgap",
    "com.bluejeans.BlueJeans",
    "com.cisco.webexmeetingsapp",
    "com.hnc.Discord",
    "com.google.Chrome",
    "com.apple.Safari",
    "com.apple.FaceTime"
]

/// Maps helper process bundle IDs to their parent app. This is only a static
/// FALLBACK — the primary attribution is the responsibility API (see
/// detectMeetings), which resolves any helper to its true host app.
/// com.apple.WebKit.GPU is deliberately NOT here: that XPC service hosts
/// audio for EVERY WKWebView app (new Teams, Safari, Outlook, Dial8 itself),
/// so a static mapping to Safari mis-attributed everyone else — it made
/// Teams calls (which run their audio in WebKit.GPU) completely undetectable.
let helperToParentApp: [String: String] = [
    "com.tinyspeck.slackmacgap.helper": "com.tinyspeck.slackmacgap",
    "com.google.Chrome.helper": "com.google.Chrome",
    "com.apple.avconferenced": "com.apple.FaceTime"
]

struct DetectedMeetingApp: Codable {
    let bundleID: String
    let displayName: String
    let pid: Int32
    let isUsingMic: Bool
}

struct DetectionResult: Codable {
    let meetingAppsRunning: [String]
    let appsUsingMic: [DetectedMeetingApp]
    /// Bundle IDs of running meeting apps with an OUTPUT stream running.
    /// A meeting app keeps its output stream alive for the whole call even
    /// while the user is muted (Zoom releases the mic input on mute), so
    /// this is the liveness signal for call-end detection.
    let appsPlayingAudio: [String]
}

/// One-shot detection: find meeting apps and check mic usage
@available(macOS 14.4, *)
func detectMeetings() -> DetectionResult {
    // Find running meeting apps
    var runningMeetingApps: [String: NSRunningApplication] = [:]
    for app in NSWorkspace.shared.runningApplications {
        guard let bundleID = app.bundleIdentifier else { continue }
        if knownMeetingApps.contains(bundleID) {
            runningMeetingApps[bundleID] = app
        }
    }

    guard CATapHelper.isAvailable() else {
        return DetectionResult(
            meetingAppsRunning: Array(runningMeetingApps.keys),
            appsUsingMic: [],
            appsPlayingAudio: []
        )
    }

    // Read mic state via the HAL process-object LIST, never via
    // kAudioHardwarePropertyTranslatePIDToProcessObject: while our own
    // tap/aggregate device is active, the translate path reads
    // input-running as false for apps that are live on the mic (verified
    // against Zoom 2026-06-10 — it read "inactive" for 30s straight while
    // the list path showed Zoom's input running continuously). Those false
    // negatives caused call-end misfires that auto-stopped captures
    // mid-meeting. The list path stays accurate with taps active.
    //
    // Attribution: each active HAL client is credited to every plausible
    // OWNER — its own bundle, the static helper map, and (primarily) the app
    // the responsibility API says spawned it. The last one is what makes new
    // Teams detectable at all: Teams runs its call audio inside the shared
    // com.apple.WebKit.GPU XPC service, whose bundle ID identifies nobody.
    // (Everything here is still passive: property reads + one syscall per
    // active audio client. No audio IO.)
    var micBundles: Set<String> = []
    var playingBundles: Set<String> = []
    for dict in CATapHelper.getAudioPlayingProcesses() {
        guard let bundleID = dict["bundleID"] as? String else { continue }
        let usingInput = (dict["isUsingInput"] as? NSNumber)?.boolValue == true
        let playing = (dict["isPlaying"] as? NSNumber)?.boolValue == true
        guard usingInput || playing else { continue }

        var owners: Set<String> = [bundleID]
        if let mappedParent = helperToParentApp[bundleID] {
            owners.insert(mappedParent)
        }
        if let pid = (dict["pid"] as? NSNumber)?.int32Value, pid > 0 {
            let rpid = CATapHelper.responsiblePid(forPid: pid)
            if rpid > 0, rpid != pid,
               let app = NSRunningApplication(processIdentifier: rpid),
               let responsibleBundle = app.bundleIdentifier {
                owners.insert(responsibleBundle)
            }
        }

        if usingInput { micBundles.formUnion(owners) }
        if playing { playingBundles.formUnion(owners) }
    }

    // Every running meeting app credited with mic use — directly or via a
    // helper it is responsible for. Never gated on "no direct hits": a native
    // app on the mic must not hide a concurrent browser/webview call, or the
    // Rust side's app-scoped call-end would truncate the hidden call's capture.
    var appsUsingMic: [DetectedMeetingApp] = []
    for (bundleID, app) in runningMeetingApps where micBundles.contains(bundleID) {
        appsUsingMic.append(DetectedMeetingApp(
            bundleID: bundleID,
            displayName: app.localizedName ?? bundleID,
            pid: app.processIdentifier,
            isUsingMic: true
        ))
    }

    // Meeting apps with output running, directly or via an owned helper
    let appsPlayingAudio = runningMeetingApps.keys.filter { playingBundles.contains($0) }

    return DetectionResult(
        meetingAppsRunning: Array(runningMeetingApps.keys),
        appsUsingMic: appsUsingMic,
        appsPlayingAudio: appsPlayingAudio
    )
}

/// List all audio processes with their status
struct AudioProcessInfo: Codable {
    let pid: Int32
    let bundleID: String
    let isRunning: Bool
    let isPlaying: Bool
    let isUsingInput: Bool
}

@available(macOS 14.4, *)
func listAudioProcesses() -> [AudioProcessInfo] {
    guard CATapHelper.isAvailable() else { return [] }

    let rawProcesses = CATapHelper.getAudioPlayingProcesses()
    return rawProcesses.compactMap { dict -> AudioProcessInfo? in
        guard let pid = dict["pid"] as? NSNumber,
              let bundleID = dict["bundleID"] as? String else { return nil }

        return AudioProcessInfo(
            pid: pid.int32Value,
            bundleID: bundleID,
            isRunning: (dict["isRunning"] as? NSNumber)?.boolValue ?? false,
            isPlaying: (dict["isPlaying"] as? NSNumber)?.boolValue ?? false,
            isUsingInput: (dict["isUsingInput"] as? NSNumber)?.boolValue ?? false
        )
    }
}
