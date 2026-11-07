//
//  SpeechModelManager.swift
//  dial8
//
//  Readiness gate for Apple's on-device speech stack (iOS 26 SpeechAnalyzer +
//  SpeechTranscriber). iOS transcription is ENTIRELY on-device: there is no
//  cloud fallback, so a device that cannot run SpeechTranscriber, or a language
//  Apple does not ship a model for, simply cannot record — and the UI says so
//  plainly rather than starting a session that would produce nothing.
//
//  Responsibilities:
//    • resolve the user's "selectedLanguage" preference to a locale the
//      transcriber actually supports,
//    • download and install the on-device model assets (publishing progress),
//    • cache `SpeechAnalyzer.bestAvailableAudioFormat` so the live recorder can
//      build its AVAudioConverter without an extra async hop at record time.
//
//  Everything is funnelled through `prewarm()`, which is idempotent and
//  coalesces concurrent callers. It re-runs when the language preference
//  changes, and on foreground when the last attempt failed.
//

import Foundation
import AVFoundation
import Combine
import Speech
import os
import UIKit

@MainActor
final class SpeechModelManager: ObservableObject {
    static let shared = SpeechModelManager()

    // MARK: - State

    enum State {
        /// `SpeechTranscriber.isAvailable` is false — the silicon can't do it
        /// (iPhone 11 / SE 2nd gen and older), or we're in a Simulator.
        case unsupportedDevice
        /// The device is capable, but Apple ships no model for this language.
        case unsupportedLanguage(requested: String)
        /// Resolving locale / querying asset inventory.
        case checking
        /// Model assets are downloading. The Progress is Apple's, observed live.
        case downloading(Progress)
        /// Assets installed, analyzer format cached — recording may start.
        case ready
        /// Something failed; the message is user-facing.
        case failed(String)
    }

    @Published private(set) var state: State = .checking {
        didSet {
            let ready: Bool
            if case .ready = state { ready = true } else { ready = false }
            Self.readyMirror.withLock { $0 = ready }
        }
    }

    /// Nonisolated mirror of `isReady`, for readers that are not on the main
    /// actor. `STTProvider.isReady` is a nonisolated protocol requirement, and
    /// reaching the @MainActor state from there with `MainActor.assumeIsolated`
    /// would TRAP if it were ever read off-main. This can be read from anywhere.
    nonisolated private static let readyMirror = OSAllocatedUnfairLock(initialState: false)

    nonisolated static var isReadyNonisolated: Bool {
        readyMirror.withLock { $0 }
    }

    /// The locale the transcriber will actually be built with. nil until a
    /// successful resolve — `AppleSpeechLiveTranscriber` requires it.
    private(set) var locale: Locale?

    /// The format `SpeechAnalyzer` wants to be fed, cached once the assets are
    /// installed. nil before that. The live transcriber converts mic buffers to
    /// this; a nil here is not fatal (the transcriber re-queries), it just costs
    /// an async hop on the first buffer.
    private(set) var analyzerFormat: AVAudioFormat?

    var isReady: Bool {
        if case .ready = state { return true }
        return false
    }

    /// Short, neutral sentence explaining why recording is unavailable. nil when
    /// ready. The recording sheet shows this in its existing banner surface.
    var userFacingMessage: String? {
        switch state {
        case .ready:
            return nil
        case .unsupportedDevice:
            return "This iPhone can't transcribe on-device. Dial8 needs iPhone 12 or later."
        case .unsupportedLanguage(let requested):
            let name = Self.languageDisplayName(requested)
            return "On-device transcription isn't available for \(name) yet."
        case .checking:
            return "Preparing on-device transcription…"
        case .downloading(let progress):
            let percent = Int((progress.fractionCompleted * 100).rounded())
            return "Downloading on-device speech model (\(percent)%)"
        case .failed(let message):
            return message
        }
    }

    // MARK: - Private

    /// The in-flight prewarm, so concurrent callers coalesce onto one run
    /// instead of racing two asset-installation requests.
    private var prewarmTask: Task<Void, Never>?
    /// Bumped on every invalidate. `Task` is a struct with no identity, so this
    /// is how a finishing run tells "my registration is still the current one"
    /// from "a language change already replaced me".
    private var prewarmGeneration = 0
    /// Drives @Published republishing while an Apple Progress advances — Progress
    /// is KVO, not Combine, so nothing would redraw the percentage without this.
    private var progressTimer: Timer?
    private var observers: [NSObjectProtocol] = []

    private init() {
        let center = NotificationCenter.default

        // The language picker posts this. A new language means new assets, so
        // the whole readiness question re-opens.
        observers.append(center.addObserver(
            forName: NSNotification.Name("SelectedLanguageChanged"),
            object: nil,
            queue: .main
        ) { _ in
            MainActor.assumeIsolated {
                SpeechModelManager.shared.invalidateAndPrewarm()
            }
        })

        // A failure is often transient (no network for the asset download).
        // Retry when the user comes back, but never re-run a healthy state.
        observers.append(center.addObserver(
            forName: UIApplication.willEnterForegroundNotification,
            object: nil,
            queue: .main
        ) { _ in
            MainActor.assumeIsolated {
                let manager = SpeechModelManager.shared
                if case .failed = manager.state {
                    manager.invalidateAndPrewarm()
                }
            }
        })
    }

    // MARK: - Prewarm

    /// Bring the on-device model to `.ready`, or explain why it can't be.
    /// Idempotent: already-ready returns immediately, and concurrent callers
    /// await the same run.
    func prewarm() async {
        if isReady { return }
        if let existing = prewarmTask {
            await existing.value
            return
        }
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.runPrewarm()
        }
        prewarmTask = task
        let generation = prewarmGeneration
        await task.value
        // Only clear our OWN registration. An invalidate (language change) may
        // have cancelled this run and installed a newer one; nilling that here
        // would let the next caller start a third concurrent run racing the same
        // asset-installation request.
        if prewarmGeneration == generation { prewarmTask = nil }
    }

    /// Throw away the cached resolution and start over. Used when the language
    /// preference changes and after a failure.
    private func invalidateAndPrewarm() {
        prewarmGeneration &+= 1
        prewarmTask?.cancel()
        prewarmTask = nil
        stopProgressTimer()
        locale = nil
        analyzerFormat = nil
        state = .checking
        Task { await prewarm() }
    }

    private func runPrewarm() async {
        state = .checking

        // A cancelled run (the language changed mid-flight) must never publish
        // its now-stale locale or readiness over the newer run's state.
        func cancelled() -> Bool { Task.isCancelled }

        // 1. Silicon gate. Everything below is pointless without it.
        guard SpeechTranscriber.isAvailable else {
            print("[SpeechModel] SpeechTranscriber.isAvailable == false — on-device transcription unsupported here")
            state = .unsupportedDevice
            return
        }

        // 2. Resolve the language preference to a supported locale.
        let requested = UserDefaults.standard.string(forKey: "selectedLanguage") ?? "en"
        guard let resolved = await Self.resolveLocale(for: requested) else {
            print("[SpeechModel] No supported locale for '\(requested)'")
            state = .unsupportedLanguage(requested: requested)
            return
        }
        if cancelled() { return }
        locale = resolved
        print("[SpeechModel] Resolved '\(requested)' → \(resolved.identifier(.bcp47))")

        // 3. Ask the asset inventory about a transcriber built with EXACTLY the
        //    options the live path uses — asset requirements are per-configuration.
        let probe = Self.makeTranscriber(locale: resolved)
        let status = await AssetInventory.status(forModules: [probe])
        print("[SpeechModel] Asset status for \(resolved.identifier(.bcp47)): \(status)")

        if status == .unsupported {
            state = .unsupportedLanguage(requested: requested)
            return
        }

        if status != .installed {
            let request: AssetInstallationRequest?
            do {
                request = try await AssetInventory.assetInstallationRequest(supporting: [probe])
            } catch {
                print("[SpeechModel] Asset install request failed: \(error.localizedDescription)")
                state = .failed("Couldn't download the on-device speech model. Check your connection and try again.")
                return
            }

            if let request {
                let progress = request.progress
                state = .downloading(progress)
                startProgressTimer(progress)
                do {
                    try await request.downloadAndInstall()
                    stopProgressTimer()
                    print("[SpeechModel] Model assets installed for \(resolved.identifier(.bcp47))")
                } catch {
                    stopProgressTimer()
                    print("[SpeechModel] Asset install failed: \(error.localizedDescription)")
                    state = .failed("Couldn't download the on-device speech model. Check your connection and try again.")
                    return
                }
            } else if status == .downloading {
                // The assets are system-wide and shared: Notes, Voice Memos or an
                // earlier process of this app may already be pulling the same
                // model, in which case the inventory hands out no request of our
                // own. Wait for that install to land instead of failing.
                print("[SpeechModel] Install already in progress elsewhere for \(resolved.identifier(.bcp47)) — waiting for it")
                let installed = await Self.waitForInstall(of: probe)
                if cancelled() { return }
                guard installed else {
                    state = .failed("The on-device speech model is still installing. Try again in a moment.")
                    return
                }
            } else {
                // A nil request is NOT "nothing to do" — the model is not
                // installed and the inventory has no install to offer right now
                // (the reserved-locale cap is hit, most likely). Falling through
                // would publish .ready for a model that isn't there, and the user
                // would record a whole meeting into an empty transcript with no
                // error anywhere.
                print("[SpeechModel] No installation request available for \(resolved.identifier(.bcp47)) at status \(status)")
                state = .failed("The on-device speech model isn't available yet. Try again in a moment.")
                return
            }

            // Trust the inventory, not the request returning: a partially
            // completed install must not be mistaken for a ready one.
            let postInstall = await AssetInventory.status(forModules: [probe])
            guard postInstall == .installed else {
                print("[SpeechModel] Post-install status is \(postInstall), not .installed")
                state = .failed("The on-device speech model isn't fully installed yet. Try again in a moment.")
                return
            }
        }

        if cancelled() { return }

        // 4. Cache the format the analyzer wants. Only meaningful post-install.
        analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [probe])
        if let format = analyzerFormat {
            print("[SpeechModel] Analyzer format: \(format.sampleRate) Hz, \(format.channelCount) ch")
        } else {
            print("[SpeechModel] ⚠️ bestAvailableAudioFormat returned nil — the transcriber will re-query at start")
        }

        if cancelled() { return }
        state = .ready
    }

    /// Poll the inventory while an install owned by someone else completes.
    /// Bounded: a download that never lands must not spin forever.
    nonisolated private static func waitForInstall(of module: SpeechTranscriber) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(10 * 60)
        while ContinuousClock.now < deadline {
            try? await Task.sleep(for: .seconds(2))
            if Task.isCancelled { return false }
            switch await AssetInventory.status(forModules: [module]) {
            case .installed: return true
            case .downloading: continue
            default: return false
            }
        }
        return false
    }

    // MARK: - Locale resolution

    /// Map a stored "selectedLanguage" value to a locale `SpeechTranscriber`
    /// actually supports.
    ///
    /// Always normalized through `supportedLocale(equivalentTo:)` and compared by
    /// `identifier(.bcp47)`: an arbitrary `Locale` may not match a supported one
    /// even when it names the same language, which is exactly the trap Apple's
    /// own `ensureModel` sample guards against.
    nonisolated static func resolveLocale(for preference: String) async -> Locale? {
        // "auto" → whatever the phone is set to.
        if preference == "auto" {
            return await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current)
        }

        // A bare language code ("en", "de"). Try it directly first.
        if let direct = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: preference)) {
            return direct
        }

        // The device locale, when it already speaks the requested language —
        // an en-GB phone asking for "en" should get en-GB, not en-US.
        if Locale.current.language.languageCode?.identifier == preference,
           let current = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current) {
            return current
        }

        // A sensible region default for the languages Apple ships.
        if let fallback = regionDefaults[preference],
           let resolved = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: fallback)) {
            return resolved
        }

        // Last resort: any supported locale whose language code matches.
        let supported = await SpeechTranscriber.supportedLocales
        return supported.first { $0.language.languageCode?.identifier == preference }
    }

    nonisolated private static let regionDefaults: [String: String] = [
        "en": "en-US",
        "es": "es-ES",
        "pt": "pt-BR",
        "zh": "zh-CN",
        "fr": "fr-FR",
        "de": "de-DE",
        "ja": "ja-JP",
        "ko": "ko-KR",
        "it": "it-IT",
    ]

    /// The transcriber configuration the whole app agrees on. `AppleSpeechLive-
    /// Transcriber` builds an identical one — asset status and
    /// `bestAvailableAudioFormat` are both configuration-dependent, so these two
    /// must not drift.
    nonisolated static func makeTranscriber(locale: Locale) -> SpeechTranscriber {
        SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults],
            attributeOptions: [.audioTimeRange, .transcriptionConfidence]
        )
    }

    /// Human-readable language name for a stored preference code.
    nonisolated static func languageDisplayName(_ code: String) -> String {
        if code == "auto" {
            return Locale.current.localizedString(forLanguageCode: Locale.current.language.languageCode?.identifier ?? "en") ?? "this language"
        }
        return Locale.current.localizedString(forLanguageCode: code) ?? code
    }

    // MARK: - Progress republishing

    /// `Progress.fractionCompleted` is KVO-observable, not a Combine publisher,
    /// so an @Published holding one never republishes as it advances. Ticking the
    /// state object at 4 Hz is enough for a download percentage and costs nothing.
    private func startProgressTimer(_ progress: Progress) {
        stopProgressTimer()
        let timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard case .downloading = self.state else { return }
                self.objectWillChange.send()
            }
        }
        progressTimer = timer
    }

    private func stopProgressTimer() {
        progressTimer?.invalidate()
        progressTimer = nil
    }
}
