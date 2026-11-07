//
//  ChatDictationService.swift
//  dial8
//
//  Push-to-talk dictation for the chat composer.
//
//  Audio path is deliberately identical to iOSRecordingService's: AVAudioEngine
//  mic tap → AppleSpeechLiveTranscriber (iOS 26 on-device SpeechAnalyzer). It
//  does NOT create a capture — nothing is persisted, no capture row, no
//  transcript sync. The only output is text handed back to the composer.
//
//  ON-DEVICE ONLY. There is no cloud path: `start()` refuses unless
//  `SpeechModelManager.shared.isReady`, and surfaces that manager's own
//  user-facing sentence verbatim when it isn't.
//
//  THE STOP ORDERING (the thing to not break)
//  ------------------------------------------
//  On-device FINAL results are emitted only while the analyzer drains inside
//  `finish()`. The last utterance a user speaks before tapping stop is therefore
//  still volatile at that moment, and cancelling would throw it away — the
//  composer would silently lose the end of every dictation.
//
//  So `stop()` drains: the mic engine is torn down immediately (the red button
//  must go quiet the instant it is tapped), but `isListening` stays true until
//  `transcriber.finish()` has delivered its last final through `onFinalText`.
//  The wait is bounded by the transcriber's own 15s cap, and `stop()` itself
//  stays synchronous so every existing call site (onDisappear, send, new chat,
//  the mic button) is unchanged.
//
//  Mutually exclusive with a real capture: `start()` refuses while
//  iOSRecordingService.shared.hasActiveSession is true, because both would fight
//  over the same AVAudioSession + input node.
//

import Foundation
import AVFoundation
import Combine

// MARK: - Chat Dictation Service

@MainActor
final class ChatDictationService: ObservableObject {

    // MARK: - Published State

    /// True from the moment the mic engine starts until the final drain after
    /// `stop()` completes. Deliberately NOT cleared the instant stop is tapped:
    /// the composer's indicator staying lit for the sub-second drain is what
    /// tells the user their last sentence is still arriving.
    @Published private(set) var isListening = false

    /// The in-flight (non-final) hypothesis, for a faint inline preview. Cleared
    /// whenever the matching final arrives.
    @Published private(set) var interimText: String = ""

    /// Surfaced verbatim in the composer when the mic can't start.
    @Published var errorMessage: String?

    // MARK: - Callbacks

    /// Invoked on the main actor for every FINALIZED utterance. The composer
    /// appends it to the draft (space-separated).
    var onFinalText: ((String) -> Void)?

    // MARK: - Private State

    private var audioEngine: AVAudioEngine?
    private var transcriber: AppleSpeechLiveTranscriber?

    /// Guards against a double-tap starting two engines before the async
    /// analyzer start resolves.
    private var isStarting = false

    /// The bounded drain spawned by `stop()`. Held so a second `stop()` (or a
    /// `start()` racing the drain) joins it rather than starting a second one.
    private var stopTask: Task<Void, Never>?

    // MARK: - Lifecycle

    /// Open the mic and begin streaming. No-op when already listening, still
    /// starting, or when a capture owns the mic.
    func start() {
        guard !isListening, !isStarting else { return }

        // A tap that lands while the previous session is still draining must not
        // be swallowed — the mic button would simply do nothing. Wait for the
        // drain (sub-second in practice), then start, as long as the user hasn't
        // changed their mind in the meantime.
        if let draining = stopTask {
            Task { @MainActor [weak self] in
                await draining.value
                guard let self, !self.isListening, !self.isStarting else { return }
                self.start()
            }
            return
        }

        guard !iOSRecordingService.shared.hasActiveSession else {
            print("🎙️ ChatDictation: refused — a capture is already recording")
            errorMessage = "Stop the recording to dictate here."
            return
        }

        // On-device only: without an installed model there is nothing to dictate
        // with, and no cloud path to fall back to.
        let speechModel = SpeechModelManager.shared
        guard speechModel.isReady, let locale = speechModel.locale else {
            errorMessage = speechModel.userFacingMessage ?? "On-device transcription isn't ready yet."
            // Kick a prewarm so a "still downloading" state resolves itself and
            // the next tap succeeds.
            Task { await speechModel.prewarm() }
            return
        }

        isStarting = true
        errorMessage = nil
        interimText = ""

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true)

            // 1. On-device transcriber. Its input stream exists immediately, so
            //    audio captured before `start()` resolves is queued, not clipped.
            let liveTranscriber = AppleSpeechLiveTranscriber(
                locale: locale,
                analyzerFormat: speechModel.analyzerFormat
            )
            // Called SYNCHRONOUSLY on the main actor from inside the transcriber's
            // results consumer. No Task wrapper: `stop()` awaits `finish()`, which
            // awaits that consumer, so a deferred hop would let the last
            // utterance reach the composer after dictation had already reported
            // itself finished.
            liveTranscriber.onSegment = { [weak self] segment in
                self?.handleSegment(segment)
            }
            liveTranscriber.onStatus = { [weak self] status in
                self?.handleStatus(status)
            }
            self.transcriber = liveTranscriber

            // 2. Mic tap → feed. `feed` is nonisolated and lock-guarded, so the
            //    real-time audio thread never touches main-actor state.
            let engine = AVAudioEngine()
            self.audioEngine = engine
            let inputNode = engine.inputNode
            let inputFormat = inputNode.inputFormat(forBus: 0)

            #if DEBUG
            // A simulator has no mic. With -dictationAudioFixture the same
            // feed() path is driven from a file instead, so the whole
            // volatile → final → composer chain can be exercised headlessly.
            if let fixture = DebugDictationAutomation.fixturePath {
                DebugDictationAutomation.startFixtureFeed(path: fixture, into: liveTranscriber)
            } else {
                inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { buffer, _ in
                    liveTranscriber.feed(buffer)
                }
                engine.prepare()
                try engine.start()
            }
            #else
            inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { buffer, _ in
                liveTranscriber.feed(buffer)
            }
            engine.prepare()
            try engine.start()
            #endif

            isListening = true
            isStarting = false
            print("🎙️ ChatDictation: mic engine started")

            // 3. Start the analyzer.
            Task { @MainActor in
                do {
                    // The user may have tapped stop while this was in flight.
                    guard self.isListening, self.stopTask == nil else { return }
                    try await liveTranscriber.start()
                    print("🎙️ ChatDictation: on-device transcriber listening")
                } catch {
                    print("❌ ChatDictation: transcriber start failed — \(error.localizedDescription)")
                    self.errorMessage = (error as? LocalizedError)?.errorDescription
                        ?? error.localizedDescription
                    self.stop()
                }
            }
        } catch {
            print("❌ ChatDictation: failed to start mic — \(error.localizedDescription)")
            errorMessage = "Couldn't start the microphone."
            isStarting = false
            closeMic()
            transcriber?.cancel()
            transcriber = nil
            releaseSessionIfFree()
        }
    }

    /// Close the mic and drain the last utterance into the composer.
    ///
    /// Synchronous by design — every call site (onDisappear, send, new chat, the
    /// mic button) is a plain SwiftUI action. The drain happens in a task; see
    /// the file header for why it must happen at all.
    func stop() {
        guard isListening || isStarting || audioEngine != nil || transcriber != nil else { return }
        guard stopTask == nil else { return }

        print("🎙️ ChatDictation: stopping — draining final results")
        isStarting = false
        interimText = ""

        // The mic closes NOW: a stop tap must silence the input immediately even
        // though the analyzer still has a sentence to hand back.
        closeMic()

        let draining = transcriber
        transcriber = nil

        stopTask = Task { @MainActor [weak self] in
            // Bounded internally by AppleSpeechLiveTranscriber.finishTimeout (15s),
            // and every final it drains reaches onFinalText through the same
            // handleSegment path a live segment does.
            await draining?.finish()
            guard let self else { return }
            self.isListening = false
            self.interimText = ""
            self.stopTask = nil
            self.releaseSessionIfFree()
            print("🎙️ ChatDictation: stopped")
        }
    }

    // MARK: - Segments

    private func handleSegment(_ segment: LiveTranscriptSegment) {
        let text = segment.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        if segment.isFinal {
            interimText = ""
            onFinalText?(text)
        } else {
            // A volatile result after stop() was tapped is a hypothesis that will
            // never be committed — don't flash it back into the preview.
            guard stopTask == nil else { return }
            interimText = text
        }
    }

    private func handleStatus(_ status: LiveTranscriptionStatus) {
        guard case .failed(let message) = status else { return }
        print("❌ ChatDictation: \(message)")
        errorMessage = message
        stop()
    }

    // MARK: - Teardown

    /// Tear down the mic engine only. The transcriber outlives this so `stop()`
    /// can drain it.
    private func closeMic() {
        #if DEBUG
        DebugDictationAutomation.stopFixtureFeed()
        #endif
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = nil
    }

    /// Only release the session if a capture isn't holding it — deactivating
    /// under a live recording would kill the capture's mic.
    private func releaseSessionIfFree() {
        guard !iOSRecordingService.shared.hasActiveSession else { return }
        try? AVAudioSession.sharedInstance().setActive(false)
    }
}

#if DEBUG

// MARK: - DEBUG launch-argument automation
//
// The simulator has no microphone, so dictation cannot be exercised by hand
// there. `-dictationAudioFixture <path>` swaps the mic tap for a file, read in
// 4096-frame chunks and paced at wall-clock speed through the SAME
// `AppleSpeechLiveTranscriber.feed` entry point the tap uses. Everything
// downstream — volatile preview, finals, the stop drain, the composer append —
// runs exactly as it does with a real mic.
//
//   xcrun simctl launch <device> com.dial8-iOS-26 \
//     -dictationAudioFixture /path/to/speech.aiff \
//     -autoStartDictation YES \
//     -autoStopDictationAfterSeconds 20
//
// The auto-start/auto-stop pair is driven from dial8_iOSApp; this type only
// owns the audio feed and the argument reads.

enum DebugDictationAutomation {
    /// `-dictationAudioFixture <path>` — nil when absent or missing on disk.
    static var fixturePath: String? {
        guard let path = UserDefaults.standard.string(forKey: "dictationAudioFixture"),
              !path.isEmpty,
              FileManager.default.fileExists(atPath: path) else { return nil }
        return path
    }

    /// `-autoStartDictation YES`
    static var autoStartDictation: Bool {
        UserDefaults.standard.bool(forKey: "autoStartDictation")
    }

    /// `-autoStopDictationAfterSeconds N` (0 = never auto-stop)
    static var autoStopAfterSeconds: TimeInterval {
        UserDefaults.standard.double(forKey: "autoStopDictationAfterSeconds")
    }

    private static let queue = DispatchQueue(label: "com.dial8.debug.dictationFeed", qos: .userInitiated)
    private nonisolated(unsafe) static var feedSource: DispatchSourceTimer?

    static func startFixtureFeed(path: String, into transcriber: AppleSpeechLiveTranscriber) {
        stopFixtureFeed()

        let url = URL(fileURLWithPath: path)
        guard let file = try? AVAudioFile(forReading: url) else {
            print("[DebugDictation] ⚠️ could not open fixture \(path)")
            return
        }

        let format = file.processingFormat
        let chunkFrames: AVAudioFrameCount = 4096
        let interval = Double(chunkFrames) / format.sampleRate

        print("[DebugDictation] feeding fixture \(url.lastPathComponent): \(String(format: "%.1f", Double(file.length) / format.sampleRate))s")

        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: interval)
        timer.setEventHandler {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunkFrames) else { return }
            do {
                try file.read(into: buffer, frameCount: chunkFrames)
            } catch {
                print("[DebugDictation] fixture read failed: \(error.localizedDescription)")
                stopFixtureFeed()
                return
            }
            guard buffer.frameLength > 0 else {
                print("[DebugDictation] fixture exhausted")
                stopFixtureFeed()
                return
            }
            transcriber.feed(buffer)
        }
        timer.resume()
        feedSource = timer
    }

    static func stopFixtureFeed() {
        feedSource?.cancel()
        feedSource = nil
    }
}

#endif
