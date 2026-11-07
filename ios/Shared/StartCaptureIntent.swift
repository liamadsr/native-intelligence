//
//  StartCaptureIntent.swift
//  Shared
//
//  One intent behind every "start a capture" entry point the system offers:
//  the iPhone Action Button, the Control Center / Lock Screen control, the
//  Shortcuts app, Siri and Spotlight.
//
//  It lives in Shared/ because it needs membership of TWO targets — the app
//  (which performs it) and the widget extension (which only needs the type to
//  build its ControlWidgetButton). See the `Exceptions for "Shared" folder in
//  "dial8WidgetsExtension" target` membership exception in project.pbxproj.
//
//  Everything here compiles in the widget-extension process too, so this file
//  must not reference a single app-only type. The one thing the intent needs
//  from the app — "is a capture already running?" — arrives through
//  `CaptureIntentBridge`, which the app fills in at launch.
//

import AppIntents
import Foundation

// MARK: - Notification

extension Notification.Name {
    /// "Show the recorder." Posted by the intent, by the widget deep link
    /// (`dial8://capture`), and by the DEBUG launch automation; observed by
    /// `iOSMainTabView`, which owns the recording sheet.
    static let openRecordingSheet = Notification.Name("openRecordingSheet")
}

// MARK: - App bridge

/// The one-way door between this file and the app target.
///
/// The widget extension compiles this file but has no recorder, no audio
/// session and no `iOSRecordingService`; the app registers the real answer in
/// its `init()`. A nil handler therefore means "we are not the app process",
/// and the safe reading of that is "nothing is recording".
@MainActor
enum CaptureIntentBridge {
    /// Set by `dial8_iOSApp.init()` to `{ iOSRecordingService.shared.hasActiveSession }`.
    static var isCaptureActive: (@MainActor () -> Bool)?
}

// MARK: - Pending-start handoff

/// Carries "the user asked to start a capture" across the gap between the
/// intent firing and the recording surface existing.
///
/// A press of the Action Button while the app is dead launches it, and
/// `perform()` can run long before `iOSMainTabView` has subscribed to
/// `.openRecordingSheet` — the notification would land in an empty room and the
/// press would do nothing. So the intent ALSO parks the request here, and the
/// view consumes it on appear. Whichever path runs first clears it; the other
/// then finds nothing to do. This mirrors
/// `ChatSessionStore.pendingDictationStart`, which solves the same race for the
/// chat sheet's dictation.
///
/// Two things stop it going stale and opening the recorder out of nowhere on
/// some unrelated later launch:
///   • it is in-memory only, so it dies with the process; and
///   • it records WHEN it was set, and `consume()` refuses anything older than
///     `staleAfter`.
@MainActor
enum PendingCaptureStart {
    /// A cold launch has to clear the auth bootstrap before `iOSMainTabView`
    /// even exists, so the window cannot be tight. It only has to be shorter
    /// than "the user has moved on", and a request older than this is answered
    /// by doing nothing rather than by ambushing them with the recorder.
    static let staleAfter: TimeInterval = 45

    private static var requestedAt: Date?

    /// Record that a capture was asked for.
    static func request() {
        requestedAt = Date()
    }

    /// Returns true at most once per `request()`, and only inside the window.
    static func consume() -> Bool {
        guard let requestedAt else { return false }
        Self.requestedAt = nil
        return Date().timeIntervalSince(requestedAt) <= staleAfter
    }

    /// Drop a request without acting on it — used by the notification path, so
    /// the later `.onAppear` does not open the sheet a second time.
    static func clear() {
        requestedAt = nil
    }
}

// MARK: - Intent

/// Opens Dial8 and starts a capture.
///
/// `openAppWhenRun` is true and non-negotiable: recording needs the microphone,
/// the on-device speech model, the capture pipeline and a Live Activity, all of
/// which live in the app. A widget extension cannot hold any of them.
struct StartCaptureIntent: AppIntent {
    static var title: LocalizedStringResource = "Start Capture"

    static var description = IntentDescription(
        "Opens Dial8 and starts capturing.",
        categoryName: "Capture",
        searchKeywords: ["capture", "record", "recording", "note", "meeting", "transcribe"]
    )

    static var openAppWhenRun: Bool { true }

    @MainActor
    func perform() async throws -> some IntentResult {
        // A nil handler means "we are not the app process" — nothing of ours is
        // recording there either way, so nil and false take the same branch.
        let alreadyCapturing = CaptureIntentBridge.isCaptureActive?() ?? false

        // Either way the answer is "show the recorder" — a session that is
        // already running gets SURFACED, never restarted. Starting is the
        // sheet's own `startRecordingIfNeeded`, which refuses unless the service
        // is idle with no segments, so a second press mid-capture cannot open a
        // second session.
        //
        // The parked fallback is only for the cold-launch race, and a live
        // capture proves we lost no race: the app is running, the recording
        // surface exists, and the notification below is observed synchronously.
        // Parking anyway would leave a request that could re-open the recorder
        // later, after the user had deliberately collapsed it.
        if alreadyCapturing {
            print("[StartCaptureIntent] capture already active — surfacing it, not starting another")
        } else {
            PendingCaptureStart.request()
        }

        NotificationCenter.default.post(name: .openRecordingSheet, object: nil)

        return .result()
    }
}
