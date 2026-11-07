import SwiftUI
import WatchKit

@main
struct Dial8WatchApp: App {
    @WKApplicationDelegateAdaptor(WatchAppDelegate.self) private var appDelegate
    @StateObject private var recorder = WatchRecorder()

    var body: some Scene {
        WindowGroup {
            RecordingView()
                .environmentObject(recorder)
                .task {
                    WatchAppDelegate.debugAutomation(recorder: recorder)
                }
        }
    }
}

final class WatchAppDelegate: NSObject, WKApplicationDelegate {
    func applicationDidFinishLaunching() {
        print("[Dial8Watch] applicationDidFinishLaunching")
        WatchSync.shared.activate()
        RecordingQueue.shared.flush()
    }

    func applicationDidBecomeActive() {
        RecordingQueue.shared.flush()
        // Covers the common case even if a queue notification was missed while
        // the app was suspended.
        NotificationCenter.default.post(name: .watchRecordingQueueChanged, object: nil)
    }

    /// DEBUG-only launch-argument automation so the recorder can be driven from
    /// `xcrun simctl launch <watch> com.dial8-iOS-26.watchkitapp -autoStartRecording YES -autoStopAfterSeconds 8`
    /// on simulators that cannot be tapped.
    ///
    /// `-chunkSeconds N` (read by `WatchRecorder.chunkDuration`, not here) shrinks
    /// the 15-minute rotation interval so chunking can be exercised in a run that
    /// lasts seconds. Four chunks — three rotations and a final — in 70 seconds:
    ///
    ///   xcrun simctl launch --console-pty <watch> com.dial8-iOS-26.watchkitapp \
    ///     -autoStartRecording YES -chunkSeconds 20 -autoStopAfterSeconds 70
    ///
    /// `-autoPauseAfterSeconds P -autoResumeAfterSeconds R` (both wall-clock from
    /// start) drive a pause straight across a rotation boundary, which is the case
    /// that proves paused time does not advance the chunk clock:
    ///
    ///   … -chunkSeconds 20 -autoPauseAfterSeconds 10 \
    ///     -autoResumeAfterSeconds 35 -autoStopAfterSeconds 60
    @MainActor
    static func debugAutomation(recorder: WatchRecorder) {
        #if DEBUG
        let defaults = UserDefaults.standard
        guard defaults.bool(forKey: "autoStartRecording") else { return }
        let seconds = defaults.double(forKey: "autoStopAfterSeconds")
        let pauseAt = defaults.double(forKey: "autoPauseAfterSeconds")
        let resumeAt = defaults.double(forKey: "autoResumeAfterSeconds")
        print("[Dial8Watch] DEBUG autoStartRecording=YES autoStopAfterSeconds=\(seconds) autoPauseAfterSeconds=\(pauseAt) autoResumeAfterSeconds=\(resumeAt) chunkDuration=\(WatchRecorder.chunkDuration)s")
        Task { @MainActor in
            let launchedAt = Date()
            await recorder.start()
            // Each step sleeps until its own wall-clock offset from start, so the
            // offsets read as a timeline rather than as deltas that have to be
            // added up by hand.
            func waitUntil(_ offset: Double) async {
                let remaining = offset - Date().timeIntervalSince(launchedAt)
                guard remaining > 0 else { return }
                try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
            }
            if pauseAt > 0 {
                await waitUntil(pauseAt)
                recorder.pause()
            }
            if resumeAt > 0 {
                await waitUntil(resumeAt)
                recorder.resume()
            }
            guard seconds > 0 else { return }
            await waitUntil(seconds)
            recorder.stop()
        }
        #endif
    }
}
