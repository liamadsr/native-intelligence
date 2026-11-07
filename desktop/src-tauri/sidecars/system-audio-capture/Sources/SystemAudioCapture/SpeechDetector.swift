/// Speech detection using Apple's SFSpeechRecognizer.
///
/// Listens to the default microphone input and outputs JSON events to stdout
/// when speech starts or silence is detected. Uses the same approach as the
/// macOS app's SpeechActivityDetector: actual transcription results = speech,
/// no results for N seconds = silence.
///
/// Output format (JSON lines to stdout):
///   {"event":"speech","timestamp":1234.56}
///   {"event":"silence","timestamp":1237.89}

import Foundation
import Speech
import AVFoundation

@available(macOS 14.4, *)
class SpeechDetector {
    private let speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var audioEngine: AVAudioEngine?

    private var silenceTimer: Timer?
    private let silenceThreshold: TimeInterval
    private var isSpeechDetected = false
    private let startTime: Date

    /// Generation counter to ignore stale recognition callbacks.
    private var recognitionGeneration: Int = 0

    init(silenceThreshold: TimeInterval = 0.75) {
        self.silenceThreshold = silenceThreshold
        self.startTime = Date()
        self.speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    }

    func start() throws {
        guard let speechRecognizer = self.speechRecognizer, speechRecognizer.isAvailable else {
            throw SpeechDetectorError.recognizerNotAvailable
        }

        // Check authorization synchronously for the sidecar
        let authStatus = SFSpeechRecognizer.authorizationStatus()
        if authStatus != .authorized {
            // Request authorization and wait
            let semaphore = DispatchSemaphore(value: 0)
            var granted = false
            SFSpeechRecognizer.requestAuthorization { status in
                granted = status == .authorized
                semaphore.signal()
            }
            semaphore.wait()

            guard granted else {
                throw SpeechDetectorError.notAuthorized
            }
        }

        // Set up audio engine with default input (microphone)
        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let inputFormat = inputNode.inputFormat(forBus: 0)

        guard inputFormat.sampleRate > 0 else {
            throw SpeechDetectorError.noInputDevice
        }

        // Create recognition request
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        self.recognitionRequest = request

        // Install tap to feed audio to recognizer
        let bufferSize: AVAudioFrameCount = 1024
        inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: inputFormat) { [weak self] buffer, _ in
            self?.recognitionRequest?.append(buffer)
        }

        try engine.start()
        self.audioEngine = engine

        startRecognitionTask()

        fputs("SPEECH_DETECT_STARTED\n", stderr)
        fputs("[SpeechDetector] Listening with threshold: \(silenceThreshold)s, format: \(inputFormat)\n", stderr)
    }

    func stop() {
        silenceTimer?.invalidate()
        silenceTimer = nil

        if let engine = audioEngine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        audioEngine = nil

        recognitionRequest?.endAudio()
        recognitionRequest = nil

        recognitionTask?.finish()
        recognitionTask?.cancel()
        recognitionTask = nil

        fputs("SPEECH_DETECT_STOPPED\n", stderr)
    }

    // MARK: - Private

    private func startRecognitionTask() {
        guard let speechRecognizer = self.speechRecognizer,
              let request = self.recognitionRequest else { return }

        recognitionGeneration += 1
        let currentGeneration = recognitionGeneration

        recognitionTask = speechRecognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self = self else { return }

            // Ignore stale callbacks from previous recognition sessions
            guard self.recognitionGeneration == currentGeneration else { return }

            if let result = result, !result.bestTranscription.segments.isEmpty {
                self.resetSilenceTimer()
                if !self.isSpeechDetected {
                    self.isSpeechDetected = true
                    self.emitEvent("speech")
                }
            }

            if let error = error {
                fputs("[SpeechDetector] Recognition error: \(error.localizedDescription)\n", stderr)
                // Restart recognition on non-fatal errors
                if (error as NSError).domain != "kAFAssistantErrorDomain" {
                    self.restartRecognition()
                }
            }
        }
    }

    /// Restart recognition (Apple limits continuous recognition to ~60s).
    private func restartRecognition() {
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()

        guard let engine = audioEngine, engine.isRunning else { return }

        // Small delay before restarting
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            guard let self = self else { return }

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            request.taskHint = .dictation
            self.recognitionRequest = request

            // Reinstall tap with new request
            let inputNode = engine.inputNode
            let inputFormat = inputNode.inputFormat(forBus: 0)

            inputNode.removeTap(onBus: 0)
            let bufferSize: AVAudioFrameCount = 1024
            inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: inputFormat) { [weak self] buffer, _ in
                self?.recognitionRequest?.append(buffer)
            }

            self.startRecognitionTask()
            fputs("[SpeechDetector] Recognition restarted\n", stderr)
        }
    }

    private func resetSilenceTimer() {
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: silenceThreshold, repeats: false) { [weak self] _ in
            guard let self = self, self.isSpeechDetected else { return }
            self.isSpeechDetected = false
            self.emitEvent("silence")
        }
    }

    private func emitEvent(_ event: String) {
        let timestamp = Date().timeIntervalSince(startTime)
        let json = "{\"event\":\"\(event)\",\"timestamp\":\(String(format: "%.3f", timestamp))}"
        // Write to stdout as JSON line
        print(json)
        fflush(stdout)
    }
}

enum SpeechDetectorError: LocalizedError {
    case recognizerNotAvailable
    case notAuthorized
    case noInputDevice

    var errorDescription: String? {
        switch self {
        case .recognizerNotAvailable:
            return "Speech recognizer not available on this system"
        case .notAuthorized:
            return "Speech recognition not authorized. Grant permission in System Settings > Privacy & Security > Speech Recognition"
        case .noInputDevice:
            return "No audio input device available"
        }
    }
}
