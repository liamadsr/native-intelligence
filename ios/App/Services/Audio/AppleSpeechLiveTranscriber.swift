//
//  AppleSpeechLiveTranscriber.swift
//  dial8
//
//  Live on-device transcription with iOS 26's SpeechAnalyzer + SpeechTranscriber.
//  One instance per recording session.
//
//  Shape of the thing:
//
//    mic tap (real-time audio thread)
//        → feed(buffer)            nonisolated, lock-guarded, never blocks
//        → AVAudioConverter        (primeMethod = .none, Apple's sample pattern)
//        → AsyncStream<AnalyzerInput>
//        → SpeechAnalyzer          (actor, on-device)
//        → transcriber.results     volatile (interim) + final results
//        → onSegment(...)          called SYNCHRONOUSLY on the main actor
//                                  from inside the results consumer, so
//                                  finish() is a real ordering barrier
//
//  The interim/final semantics are deliberately identical to the streaming
//  client this replaces: a volatile result REPLACES the in-flight hypothesis, a final
//  result COMMITS it. iOSRecordingService's assembly logic is unchanged.
//
//  There is no diarization — SpeechTranscriber has none — so `speaker` is always
//  nil and every transcript line carries the single existing mic label.
//

import Foundation
import AVFoundation
import Speech
import os

// MARK: - Segment

/// One interim or final utterance from the on-device transcriber. The streaming
/// segment type this replaces had the same shape; `speaker` is retained as a
/// nil-today hook so a later diarization bolt-on doesn't churn call sites.
struct LiveTranscriptSegment {
    let text: String
    /// Seconds on the fed-audio timeline, monotonic across an internal restart.
    let startTime: TimeInterval
    let endTime: TimeInterval
    let isFinal: Bool
    /// Mean `.transcriptionConfidence` across the runs that carry one, or nil.
    let confidence: Double?
    /// Always nil today (SpeechTranscriber does not diarize).
    let speaker: Int?
}

enum LiveTranscriptionStatus {
    case starting
    case listening
    /// The analyzer threw mid-session and is being rebuilt once.
    case restarting
    case failed(String)
}

// MARK: - Live Transcriber

@MainActor
final class AppleSpeechLiveTranscriber {
    // MARK: Callbacks (main-actor isolated, invoked synchronously by the consumer)
    //
    // These are called from INSIDE the consumer task, not dispatched to it, which
    // is what makes `finish()` a real ordering barrier: when `await consumer.value`
    // returns, every drained final has already run through `onSegment`. A
    // fire-and-forget hop here (DispatchQueue.main.async, or a `Task {}` at the
    // call site) would let the tail of a recording land after the save path had
    // already read the transcript.

    var onSegment: ((LiveTranscriptSegment) -> Void)?
    var onStatus: ((LiveTranscriptionStatus) -> Void)?

    // MARK: Configuration

    private let locale: Locale
    /// Format the analyzer wants. Cached by SpeechModelManager; re-queried lazily
    /// when it wasn't available at construction time.
    private let initialAnalyzerFormat: AVAudioFormat?

    // MARK: Audio-thread state
    //
    // `feed` runs on a real-time audio thread. Everything it touches lives behind
    // this lock — never main-actor state, never an await.

    private struct AudioState {
        var continuation: AsyncStream<AnalyzerInput>.Continuation?
        var analyzerFormat: AVAudioFormat?
        var converter: AVAudioConverter?
        /// Buffers captured before the analyzer format resolved. Converting needs
        /// the format, so they are held raw and converted the moment it lands —
        /// dropping them would silently clip the opening words of the first
        /// recording after a cold launch (the format is queried asynchronously,
        /// but the mic tap is installed immediately).
        var pending: [AVAudioPCMBuffer] = []
        /// Set by finish()/cancel(): feed() drops silently from then on.
        var closed = false
    }

    /// Cap on buffers held while waiting for the format. 4096 frames at 48 kHz is
    /// ~85 ms, so this is a couple of seconds of speech — far more than the
    /// format query needs, and bounded so a stuck resolve can't grow without end.
    nonisolated private static let maxPendingBuffers = 32

    private let audioState = OSAllocatedUnfairLock(initialState: AudioState())

    // MARK: Session state (MAIN-ACTOR owned)

    private var analyzer: SpeechAnalyzer?
    private var transcriber: SpeechTranscriber?
    private var inputSequence: AsyncStream<AnalyzerInput>?
    private var consumerTask: Task<Void, Never>?

    /// Seconds to add to every result time so the timeline stays monotonic after
    /// a mid-session restart (a fresh analyzer counts from 0 again).
    private var timelineOffset: TimeInterval = 0
    /// Latest end time seen, used to compute the offset if we have to restart.
    private var lastObservedEnd: TimeInterval = 0
    /// The restart is allowed exactly once per session.
    private var hasRestarted = false

    /// Where the session is in its life. The restart path keys off this: a
    /// results-stream throw means "rebuild" ONLY while `.running`. During a
    /// finish() or cancel() the throw IS the teardown — treating it as a failure
    /// would build and start a second analyzer that nobody owns or ever finishes,
    /// holding the on-device recognizer until the process exits.
    private enum SessionPhase {
        case running
        case finishing
        case cancelled
    }

    private var phase: SessionPhase = .running

    /// How long stop() will wait for the analyzer to drain its final results
    /// before giving up. A wedged analyzer must never hang the save path.
    private static let finishTimeout: TimeInterval = 15

    // MARK: - Init

    /// Builds the transcriber, analyzer and input stream synchronously, so audio
    /// fed between construction and `start()` is QUEUED rather than lost — the
    /// mic tap is installed before the analyzer has finished starting.
    init(locale: Locale, analyzerFormat: AVAudioFormat?) {
        self.locale = locale
        self.initialAnalyzerFormat = analyzerFormat

        let transcriber = SpeechModelManager.makeTranscriber(locale: locale)
        self.transcriber = transcriber
        self.analyzer = SpeechAnalyzer(modules: [transcriber])

        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        self.inputSequence = stream
        audioState.withLock { state in
            state.continuation = continuation
            state.analyzerFormat = analyzerFormat
        }
    }

    // MARK: - Lifecycle

    /// Start consuming results, then start the analyzer.
    ///
    /// Order matters: the consumer Task must be live before `analyzer.start`, or
    /// results produced during startup have nowhere to go.
    func start() async throws {
        // A stop or discard that landed before this ran (a tap within the first
        // fraction of a second) already tore the session down. That is not an
        // error to surface — there is simply nothing left to start.
        guard phase == .running, let transcriber else { return }
        emit(.starting)

        // The format may not have been cached yet (assets installed late). Ask
        // now, before any buffer needs converting.
        if initialAnalyzerFormat == nil {
            let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
            audioState.withLock { state in
                state.analyzerFormat = format
                Self.drainPendingLocked(&state)
            }
        }

        // That await is a suspension point: finish()/cancel() may have run.
        guard phase == .running, let analyzer, let inputSequence else { return }

        consumerTask = makeConsumerTask(for: transcriber)
        try await analyzer.start(inputSequence: inputSequence)
        guard phase == .running else { return }
        emit(.listening)
    }

    /// Feed one mic buffer. Called on a real-time audio thread.
    ///
    /// Safe before `start()` (buffers queue in the AsyncStream) and after
    /// `finish()`/`cancel()` (dropped silently). Never blocks on anything but
    /// the short-held lock, never touches the main actor.
    nonisolated func feed(_ buffer: AVAudioPCMBuffer) {
        audioState.withLock { state in
            guard !state.closed, let continuation = state.continuation else { return }

            // No format resolved yet — converting is impossible, but DROPPING is
            // not an option either: the mic tap is live before `start()` has
            // finished asking for the format, and those buffers are the first
            // words of the recording. Hold them raw (bounded) and convert them
            // the instant the format lands.
            guard let targetFormat = state.analyzerFormat else {
                if state.pending.count < Self.maxPendingBuffers {
                    state.pending.append(buffer)
                }
                return
            }

            guard let converted = Self.convert(buffer, to: targetFormat, using: &state.converter) else { return }
            continuation.yield(AnalyzerInput(buffer: converted))
        }
    }

    /// Convert and yield everything `feed()` held while the format was unknown.
    /// Must be called with the audio lock held, right after `analyzerFormat` is set.
    nonisolated private static func drainPendingLocked(_ state: inout AudioState) {
        guard !state.pending.isEmpty else { return }
        defer { state.pending.removeAll() }
        guard !state.closed,
              let continuation = state.continuation,
              let targetFormat = state.analyzerFormat else { return }
        for buffer in state.pending {
            guard let converted = Self.convert(buffer, to: targetFormat, using: &state.converter) else { continue }
            continuation.yield(AnalyzerInput(buffer: converted))
        }
    }

    /// Finish the session and wait, bounded, for every remaining final result to
    /// be delivered through `onSegment`.
    ///
    /// The save path depends on this: on-device final results arrive only after
    /// `finalizeAndFinishThroughEndOfInput()`, so returning early would drop the
    /// tail of the transcript.
    func finish() async {
        guard phase == .running else { return }
        phase = .finishing

        // Stop accepting audio and close the stream so the analyzer sees EOF.
        // Anything still queued for want of a format is real captured speech —
        // push it through first (a no-op if the format never resolved), THEN
        // close, so the EOF the analyzer sees is genuinely the end of the audio.
        audioState.withLock { state in
            Self.drainPendingLocked(&state)
            state.closed = true
            state.continuation?.finish()
            state.continuation = nil
        }

        let analyzer = self.analyzer
        let consumer = self.consumerTask

        // The drain must be bounded from the OUTSIDE. `finalizeAndFinishThrough-
        // EndOfInput()` is not documented to respond to cancellation, and
        // `await someTask.value` ignores the awaiting task's cancellation
        // entirely — so a structured group that merely cancels its children
        // would still sit here until a wedged analyzer freed itself. A watchdog
        // that calls `cancelAndFinishNow()` breaks the wait from outside, which
        // is the only thing that actually terminates the results stream.
        let drain = Task { @MainActor in
            do {
                try await analyzer?.finalizeAndFinishThroughEndOfInput()
            } catch {
                print("[AppleSpeech] finalizeAndFinishThroughEndOfInput failed: \(error.localizedDescription)")
            }
            // Every final result has now been pushed into the results stream;
            // the consumer applies each one synchronously through onSegment, so
            // awaiting it means they have actually reached the transcript.
            await consumer?.value
        }

        let watchdog = Task { @MainActor in
            try await Task.sleep(nanoseconds: UInt64(Self.finishTimeout * 1_000_000_000))
            print("[AppleSpeech] ⚠️ finish() timed out after \(Int(Self.finishTimeout))s — cancelling the analyzer")
            await analyzer?.cancelAndFinishNow()
            consumer?.cancel()
        }

        await drain.value
        watchdog.cancel()

        teardown()
    }

    /// Abandon the session immediately, dropping anything not yet delivered.
    func cancel() {
        guard phase != .cancelled else { return }
        // Set BEFORE tearing anything down: `cancelAndFinishNow()` makes the
        // results stream throw, and the consumer's catch must read this as
        // "the session is over", not "the analyzer failed, rebuild it".
        phase = .cancelled

        audioState.withLock { state in
            state.closed = true
            state.pending.removeAll()
            state.continuation?.finish()
            state.continuation = nil
        }
        let analyzer = self.analyzer
        consumerTask?.cancel()
        Task { await analyzer?.cancelAndFinishNow() }
        teardown()
    }

    private func teardown() {
        consumerTask = nil
        analyzer = nil
        transcriber = nil
        inputSequence = nil
    }

    // MARK: - Results consumer

    private func makeConsumerTask(for transcriber: SpeechTranscriber) -> Task<Void, Never> {
        // @MainActor: session state is main-actor owned, and — critically —
        // `handle` calls `onSegment` synchronously here, so the task does not
        // complete until every segment has been applied. `finish()` awaits this
        // task, which is what makes the stop → save ordering real.
        Task { @MainActor [weak self] in
            do {
                for try await result in transcriber.results {
                    guard let self else { return }
                    self.handle(result)
                }
            } catch {
                guard let self, self.phase == .running else { return }
                print("[AppleSpeech] results stream failed: \(error.localizedDescription)")
                await self.handleStreamFailure(error)
            }
        }
    }

    private func handle(_ result: SpeechTranscriber.Result) {
        let raw = String(result.text.characters)
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        let start = result.range.start.seconds
        let end = result.range.end.seconds
        // CMTime can be invalid/indefinite; treat those as 0 rather than NaN,
        // which would poison the recording offset stored on the segment.
        let safeStart = start.isFinite ? start : 0
        let safeEnd = end.isFinite ? end : safeStart

        if result.isFinal {
            lastObservedEnd = max(lastObservedEnd, timelineOffset + safeEnd)
        }

        let segment = LiveTranscriptSegment(
            text: text,
            startTime: timelineOffset + safeStart,
            endTime: timelineOffset + safeEnd,
            isFinal: result.isFinal,
            confidence: Self.meanConfidence(of: result.text),
            speaker: nil
        )

        // Synchronous, on the main actor, from inside the consumer task. See the
        // note on `onSegment`: any hop here reopens the tail-truncation hole.
        onSegment?(segment)
    }

    /// Mean of the `.transcriptionConfidence` attribute across the runs that
    /// carry one. nil when the attribute is absent everywhere.
    private static func meanConfidence(of text: AttributedString) -> Double? {
        var total = 0.0
        var count = 0
        for run in text.runs {
            if let confidence = run.transcriptionConfidence {
                total += Double(confidence)
                count += 1
            }
        }
        guard count > 0 else { return nil }
        return total / Double(count)
    }

    // MARK: - Resilience

    /// The analyzer can throw mid-session (SFSpeechError.insufficientResources
    /// being the realistic one — another app took the on-device recognizer).
    /// Rebuild the whole stack ONCE and keep feeding; a second failure is fatal
    /// for the session and surfaces to the user.
    private func handleStreamFailure(_ error: Error) async {
        // A stop or discard that landed while this was in flight ends the
        // session — rebuilding now would start an analyzer nobody owns.
        guard phase == .running else { return }
        guard !hasRestarted else {
            emit(.failed(Self.message(for: error)))
            return
        }
        hasRestarted = true
        emit(.restarting)

        // The new analyzer's timeline restarts at 0 — shift everything it
        // reports past what we already committed so offsets stay monotonic.
        timelineOffset = lastObservedEnd

        let oldAnalyzer = analyzer
        await oldAnalyzer?.cancelAndFinishNow()

        // That await is a real suspension point: finish()/cancel() can have run
        // while we were in it, and teardown() would then be undone below.
        guard phase == .running else { return }

        let transcriber = SpeechModelManager.makeTranscriber(locale: locale)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()

        // Swap the continuation under the lock so the audio thread lands on the
        // new stream without ever seeing a nil-but-open state. A closed session
        // means the swap must not happen AND the replacement must not be
        // started — returning only from the closure would leave an orphaned,
        // never-finished analyzer holding the on-device recognizer.
        let stillOpen = audioState.withLock { state -> Bool in
            guard !state.closed else { return false }
            state.continuation?.finish()
            state.continuation = continuation
            return true
        }

        guard stillOpen else {
            continuation.finish()
            await analyzer.cancelAndFinishNow()
            return
        }

        self.transcriber = transcriber
        self.analyzer = analyzer
        self.inputSequence = stream

        consumerTask = makeConsumerTask(for: transcriber)

        do {
            try await analyzer.start(inputSequence: stream)
            print("[AppleSpeech] restarted analyzer at timeline offset \(String(format: "%.1f", timelineOffset))s")
            emit(.listening)
        } catch {
            print("[AppleSpeech] restart failed: \(error.localizedDescription)")
            emit(.failed(Self.message(for: error)))
        }
    }

    private static func message(for error: Error) -> String {
        "On-device transcription stopped: \(error.localizedDescription)"
    }

    private func emit(_ status: LiveTranscriptionStatus) {
        onStatus?(status)
    }

    // MARK: - Buffer conversion
    //
    // Lifted from Apple's WWDC25 sample (BufferConversion.swift). `primeMethod =
    // .none` is load-bearing: the default primes the converter and shifts every
    // timestamp, which would drift the word time ranges against the recording.

    nonisolated fileprivate static func convert(
        _ buffer: AVAudioPCMBuffer,
        to format: AVAudioFormat,
        using converter: inout AVAudioConverter?
    ) -> AVAudioPCMBuffer? {
        let inputFormat = buffer.format
        if inputFormat == format { return buffer }

        if converter == nil || converter?.outputFormat != format || converter?.inputFormat != inputFormat {
            converter = AVAudioConverter(from: inputFormat, to: format)
            converter?.primeMethod = .none
        }
        guard let converter else { return nil }

        let ratio = converter.outputFormat.sampleRate / converter.inputFormat.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up))
        guard capacity > 0,
              let output = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: capacity) else {
            return nil
        }

        var nsError: NSError?
        var consumed = false
        let status = converter.convert(to: output, error: &nsError) { _, inputStatus in
            defer { consumed = true }
            inputStatus.pointee = consumed ? .noDataNow : .haveData
            return consumed ? nil : buffer
        }

        guard status != .error, output.frameLength > 0 else { return nil }
        return output
    }
}

// MARK: - File transcription

/// One-shot transcription of a recorded audio file with the same on-device
/// stack. Used by the watch-ingest path, which receives a finished `.m4a`
/// rather than a live stream.
enum AppleSpeechFileTranscriber {
    enum TranscribeError: LocalizedError {
        case unsupportedDevice
        case unsupportedLocale(String)
        case assetsUnavailable

        var errorDescription: String? {
            switch self {
            case .unsupportedDevice:
                return "This device can't transcribe on-device."
            case .unsupportedLocale(let identifier):
                return "On-device transcription isn't available for \(identifier)."
            case .assetsUnavailable:
                return "The on-device speech model isn't installed."
            }
        }
    }

    /// Transcribe `fileURL` end to end. One entry per FINAL result, in order.
    ///
    /// No volatile results: for a file there is no UI to update incrementally,
    /// and interim hypotheses would just be noise the caller has to filter.
    static func transcribe(
        fileURL: URL,
        locale: Locale
    ) async throws -> [(text: String, start: TimeInterval, end: TimeInterval)] {
        guard SpeechTranscriber.isAvailable else { throw TranscribeError.unsupportedDevice }

        guard let resolved = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
            throw TranscribeError.unsupportedLocale(locale.identifier(.bcp47))
        }

        // The SAME configuration the readiness gate verified. Asset status and
        // `bestAvailableAudioFormat` are both configuration-dependent, so a
        // hand-rolled transcriber here would ask the inventory a different
        // question than SpeechModelManager did — and a caller that gated on
        // `isReady` would land in the download branch below anyway.
        // Volatile results are filtered out at the consumer (`where result.isFinal`).
        let transcriber = SpeechModelManager.makeTranscriber(locale: resolved)

        // The model must already be on disk. Downloading here is deliberately
        // NOT done: it would be unbounded, invisible (no progress UI), possibly
        // on cellular, and would block the ingest queue behind it. Callers gate
        // on SpeechModelManager readiness and kick a prewarm — that is where a
        // download belongs.
        let status = await AssetInventory.status(forModules: [transcriber])
        if status == .unsupported { throw TranscribeError.unsupportedLocale(resolved.identifier(.bcp47)) }
        guard status == .installed else { throw TranscribeError.assetsUnavailable }

        let analyzer = SpeechAnalyzer(modules: [transcriber])

        // Consumer first, as in the live path: results can land the moment the
        // analyzer starts reading.
        let consumer = Task { () -> [(text: String, start: TimeInterval, end: TimeInterval)] in
            var collected: [(text: String, start: TimeInterval, end: TimeInterval)] = []
            do {
                for try await result in transcriber.results where result.isFinal {
                    let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { continue }
                    let start = result.range.start.seconds
                    let end = result.range.end.seconds
                    collected.append((
                        text: text,
                        start: start.isFinite ? start : 0,
                        end: end.isFinite ? end : (start.isFinite ? start : 0)
                    ))
                }
            } catch {
                print("[AppleSpeechFile] results stream failed: \(error.localizedDescription)")
            }
            return collected
        }

        do {
            let file = try AVAudioFile(forReading: fileURL)
            if let lastSample = try await analyzer.analyzeSequence(from: file) {
                try await analyzer.finalizeAndFinish(through: lastSample)
            } else {
                await analyzer.cancelAndFinishNow()
            }
        } catch {
            await analyzer.cancelAndFinishNow()
            consumer.cancel()
            throw error
        }

        return await consumer.value
    }
}
