import SwiftUI

@main
struct dial8_iOSApp: App {
    init() {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-previewEveChat") { return }
        #endif
        // Initialize shared services
        AnalyticsService.shared.setup()
        AnalyticsService.shared.trackAppLaunched()

        // Watch handoff. Activating the session at launch is what lets the
        // system hand us recordings the watch transferred while we were dead;
        // the ingest service then drains whatever is already on disk.
        WatchConnectivityService.shared.activate()
        Task { @MainActor in WatchCaptureIngestService.shared.start() }

        // Finish any capture the app was killed in the middle of. Must run at
        // launch (not only on foreground) — the common case is exactly the one
        // where the previous process died and this one is its first successor.
        Task { @MainActor in CaptureRecoveryService.shared.start() }

        // Bring Apple's on-device speech model up in the background. iOS
        // transcribes entirely on-device, so this is what stands between a tap
        // on record and a session that actually produces text — starting it at
        // launch means the model is usually installed before the first recording.
        // Deliberately not awaited: a first-run asset download is large and must
        // never block the UI.
        Task { @MainActor in await SpeechModelManager.shared.prewarm() }

        // The Action Button / Control Center / Shortcuts entry point.
        //
        // StartCaptureIntent lives in Shared so the widget extension can build a
        // control out of it, which means it cannot see iOSRecordingService. This
        // hands it the one app-only fact it needs — "is a capture already
        // running?" — so a press mid-capture surfaces that session instead of
        // looking like a fresh start.
        //
        // updateAppShortcutParameters() is documented as an App-init call: it
        // re-reads Dial8AppShortcuts so Siri, Spotlight and the Shortcuts app
        // pick up the current phrases.
        // Registered synchronously, not inside a Task: a launch caused by the
        // intent itself races the hop, and the one run where the answer matters
        // is exactly that one. `App.init()` is already main-actor isolated and
        // the closure captures nothing but a singleton, so a direct assignment
        // is safe here.
        CaptureIntentBridge.isCaptureActive = { iOSRecordingService.shared.hasActiveSession }

        Task { @MainActor in
            Dial8AppShortcuts.updateAppShortcutParameters()
        }
    }

    var body: some Scene {
        WindowGroup {
            Group {
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("-previewEveChat") {
                    iOSEveChatPreview()
                } else { iOSRootView() }
                #else
                iOSRootView()
                #endif
            }
                .task { await Self.runDebugAutomationIfRequested() }
                .onOpenURL { url in
                    // Handle OAuth callback
                    if url.host == "auth-callback" {
                        Task {
                            try? await SupabaseManager.shared.handleOAuthCallback(url)
                        }
                    }
                    // Handle widget deep links
                    if url.scheme == "dial8" && (url.host == "capture" || url.host == "recording") {
                        // Park the request as well as posting it. A tap on the
                        // home-screen widget from a cold start opens this URL
                        // before iOSMainTabView has subscribed, exactly like the
                        // Action Button does — so it gets the same handoff.
                        // Order matters: the post is observed synchronously and
                        // clears the parked request, so only a miss survives.
                        Task { @MainActor in
                            PendingCaptureStart.request()
                            NotificationCenter.default.post(name: .openRecordingSheet, object: nil)
                        }
                    }
                }
        }
    }
}

// MARK: - DEBUG launch-argument automation

extension dial8_iOSApp {
    /// Drive a full record → transcribe → save cycle from launch arguments, so
    /// the recorder can be exercised on a simulator that has no mic and cannot be
    /// tapped. Mirrors the watch app's hooks:
    ///
    ///   xcrun simctl launch <device> com.dial8-iOS-26 \
    ///     -autoStartRecording YES \
    ///     -liveAudioFixture /tmp/speech.aiff \
    ///     -autoStopAfterSeconds 45
    ///
    /// Waits for `SpeechModelManager` to reach a terminal state first: starting
    /// before the model is ready would simply be refused.
    @MainActor
    static func runDebugAutomationIfRequested() async {
        #if DEBUG
        guard DebugRecordingAutomation.autoStartRecording else { return }
        let fixture = DebugRecordingAutomation.liveAudioFixturePath
        let stopAfter = DebugRecordingAutomation.autoStopAfterSeconds
        print("[DebugAutomation] autoStartRecording=YES fixture=\(fixture ?? "none") autoStopAfterSeconds=\(stopAfter)")

        await SpeechModelManager.shared.prewarm()
        guard SpeechModelManager.shared.isReady else {
            print("[DebugAutomation] ❌ speech model not ready: \(SpeechModelManager.shared.userFacingMessage ?? "unknown") — not starting")
            return
        }

        NotificationCenter.default.post(name: .openRecordingSheet, object: nil)
        // Let the sheet mount; it starts the session itself in onAppear.
        try? await Task.sleep(nanoseconds: 1_500_000_000)

        let service = iOSRecordingService.shared
        if service.state == .idle {
            do { try service.startRecording() } catch {
                print("[DebugAutomation] ❌ startRecording threw: \(error.localizedDescription)")
                return
            }
        }
        print("[DebugAutomation] recording state=\(service.state)")

        guard stopAfter > 0 else { return }
        try? await Task.sleep(nanoseconds: UInt64(stopAfter * 1_000_000_000))
        print("[DebugAutomation] auto-stopping after \(stopAfter)s with \(service.segments.count) segment(s)")
        service.stopRecording()
        await service.awaitFinalization()
        print("[DebugAutomation] finalized: \(service.segments.count) segment(s)")
        _ = await service.finalizeCaptureOnServer()
        service.cancelRecording(deleteServerCapture: false)
        print("[DebugAutomation] saved and torn down")
        #endif
    }
}

#if DEBUG
private struct iOSEveChatPreview: View {
    @StateObject private var model = iOSEveChatViewModel.preview()
    @State private var showingPicker = false
    @State private var showingProfile = false
    var body: some View {
        iOSAIChatView(viewModel: model)
            .background(Color(.systemBackground))
            .task {
                showingPicker = ProcessInfo.processInfo.arguments.contains("-previewEveAgentPicker")
                showingProfile = ProcessInfo.processInfo.arguments.contains("-previewEveAgentProfile")
            }
            .sheet(isPresented: $showingPicker) { iOSAgentPicker(viewModel: model) }
            .sheet(isPresented: $showingProfile) {
                if let agent = model.selectedAgent { iOSAgentProfile(agent: agent, working: false) }
            }
    }
}
#endif
