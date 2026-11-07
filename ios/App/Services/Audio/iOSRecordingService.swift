//
//  iOSRecordingService.swift
//  dial8
//
//  Active recording service for iOS with LIVE ON-DEVICE transcription.
//
//  Audio path: AVAudioEngine mic tap → AppleSpeechLiveTranscriber (iOS 26
//  SpeechAnalyzer + SpeechTranscriber) → volatile/final results. Nothing leaves
//  the phone: no streaming socket, no token mint, no usage metering, and no
//  cloud fallback of any kind. A device where SpeechTranscriber is unavailable,
//  or whose language Apple ships no model for, simply cannot record —
//  `SpeechModelManager` gates that and the UI explains it.
//
//  There is no speaker diarization (SpeechTranscriber has none), so every
//  transcript line carries the single mic label, exactly as before.
//
//  The backend contract is UNCHANGED: one "[Me] sentence" line per finalized
//  result, joined with "\n", through the same CaptureAPIService append/replace
//  calls.
//
//  Uses shared models: TranscriptSegment, RecordingState, AudioSource
//  from Core/Models/RecordingModels.swift
//

import Foundation
import AVFoundation
import Combine
import QuartzCore
import UIKit

// MARK: - iOS Recording Service

@MainActor
class iOSRecordingService: ObservableObject {
    static let shared = iOSRecordingService()

    // MARK: - Published State

    @Published private(set) var state: RecordingState = .idle
    @Published private(set) var segments: [TranscriptSegment] = []
    @Published private(set) var elapsedSeconds: TimeInterval = 0
    @Published private(set) var isTranscribingChunk = false
    @Published var errorMessage: String?
    @Published var liveUserNotes: String = ""

    /// Session-scoped composer state for the recording sheet. These live here —
    /// not as `@State` on iOSActiveRecordingView — because the sheet is rebuilt
    /// from scratch on every presentation: collapsing it with the chevron (which
    /// deliberately keeps recording) and reopening it would otherwise throw away
    /// the user's typed title and chosen project. `liveUserNotes` already
    /// survived for exactly this reason; these now do too.
    @Published var liveNoteTitle: String = ""
    @Published var liveSelectedProjectId: UUID?
    @Published var liveShowTranscript = false
    /// Live health of the on-device transcriber (drives a status pill / banner).
    @Published private(set) var transcriptionStatus: LiveTranscriptionStatus = .starting

    /// Normalized mic input level, 0…1, driving the level meter in the recording
    /// sheet. Derived from the same buffers already being fed to the transcriber
    /// (see the input tap in `startRecording`), throttled to ~10 Hz so the
    /// publisher doesn't redraw the UI at audio rate. 0 while paused or idle.
    @Published private(set) var inputLevel: Float = 0

    /// The wall-clock moment the current recording began — the chip under the
    /// title shows it ("Today 3:18 PM"). nil when idle.
    @Published private(set) var recordingStartedAt: Date?

    /// The server-side capture row backing this session, created via
    /// `POST /api/account/captures` the moment recording starts (mirroring the
    /// web recorder). nil when the API create failed and we're on the offline
    /// fallback path — see `captureCreateFailed`.
    @Published private(set) var activeCaptureId: UUID?

    /// True when the API-backed create failed and the session will fall back to
    /// a direct Supabase INSERT on save. Surfaced so the UI can explain that the
    /// note won't be auto-summarized.
    @Published private(set) var captureCreateFailed = false

    var isRecording: Bool { state == .recording }
    var isPaused: Bool { state == .paused }

    /// Whether there is an active recording session (recording, paused, or stopping)
    var hasActiveSession: Bool {
        state == .recording || state == .paused || state == .stopping
    }

    // MARK: - Private State

    private var audioEngine: AVAudioEngine?
    private var transcriber: AppleSpeechLiveTranscriber?
    private var recordingStartTime: Date?
    private var durationTimer: DispatchSourceTimer?
    private var pauseAccumulatedTime: TimeInterval = 0
    private var pauseStartTime: Date?
    private let timerQueue = DispatchQueue(label: "com.dial8.recording.timers", qos: .userInitiated)

    /// The stop-time drain of the on-device analyzer. Created by `stopRecording()`
    /// and awaited by `finalizeCaptureOnServer()` before a single byte of
    /// transcript is written to the server.
    ///
    /// This exists because on-device final results are delivered only AFTER
    /// `finalizeAndFinishThroughEndOfInput()` — with a socket the server had
    /// already seen every final, but here the tail of the transcript is still
    /// inside the analyzer when the user taps Done. Saving without awaiting this
    /// silently truncates every recording.
    private var finalization: Task<Void, Never>?

    // MARK: - Transcript assembly

    /// Finalized utterances, in arrival order. Each finalized on-device result
    /// becomes one committed segment.
    private var finalizedSegments: [TranscriptSegment] = []
    /// The current in-flight (volatile) segment, replaced as volatile results
    /// arrive and committed when a matching final arrives. nil when no utterance
    /// is in progress.
    private var interimSegment: TranscriptSegment?
    private var segmentCounter = 0
    /// End time of the last committed final, on the fed-audio timeline.
    /// `TranscriptSegment` only carries a start, and `commitInterimIfPresent()`
    /// needs the end to tell a genuinely uncommitted tail from a stale
    /// hypothesis of words a final already covered.
    private var lastFinalEndTime: TimeInterval = 0

    // MARK: - Server transcript sync (delta append)

    /// Timestamp the capture row was created with (the PATCH on stop pairs
    /// ended_at with this to derive duration).
    private var captureStartedAt: Date?
    /// How many FINALIZED segments the server has acknowledged. Advances ONLY on
    /// a confirmed 2xx, so a failed append re-sends the identical delta next tick
    /// and never leaves a hole in the stored transcript.
    private var ackedFinalCount = 0
    /// Char length of the transcript the server holds, per the last ack. This is
    /// the `base_length` CAS token for the next append.
    private var ackedTextLength = 0
    /// Serializes appends — the periodic timer and the post-segment debounce can
    /// fire together, and overlapping appends would race the server's
    /// read-modify-write on base_length.
    private var appendInFlight = false
    /// Set once the server reports TRANSCRIPT_LOCKED. Terminal: stop appending.
    private var transcriptLocked = false
    /// Periodic transcript flush timer.
    private var transcriptSyncTimer: DispatchSourceTimer?

    /// How often to flush new final segments to the server while recording.
    /// The web recorder uses 30s; iOS sessions are typically short voice notes,
    /// so 15s keeps the server copy fresh without hammering the endpoint (one
    /// request per interval, carrying every segment finalized since the last ack
    /// — never one request per word).
    private static let transcriptSyncInterval: TimeInterval = 15

    private init() {
        // Monitor audio interruptions (calls, other apps) — pause on interrupt.
        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let info = notification.userInfo,
                  let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }
            print("[RecordingService] Audio interruption: \(type == .began ? "BEGAN" : "ENDED")")
            if type == .began {
                // Delivered on .main (see queue:) — safe to assume main-actor.
                MainActor.assumeIsolated { self?.pauseRecording() }
            } else if type == .ended {
                // iOS deactivated our session for the duration of the call. When
                // it says we may resume, do — otherwise the user is left with a
                // paused recording they have to notice and restart by hand, and
                // the rest of the meeting is simply never transcribed.
                let options = (info[AVAudioSessionInterruptionOptionKey] as? UInt).map {
                    AVAudioSession.InterruptionOptions(rawValue: $0)
                } ?? []
                if options.contains(.shouldResume) {
                    MainActor.assumeIsolated { self?.resumeRecording() }
                }
            }
        }

        NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { _ in
            print("[RecordingService] App entered background")
        }

        NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification,
            object: nil,
            queue: .main
        ) { _ in
            print("[RecordingService] App entering foreground")
        }
    }

    // MARK: - Full Transcript

    var fullTranscript: String {
        allSegmentsSorted
            .map { "[\($0.source.displayLabel)]: \($0.text)" }
            .joined(separator: "\n\n")
    }

    var plainTranscript: String {
        allSegmentsSorted
            .map { $0.text }
            .joined(separator: " ")
    }

    private var allSegmentsSorted: [TranscriptSegment] {
        segments.sorted { $0.segmentIndex < $1.segmentIndex }
    }

    // MARK: - Recording Lifecycle

    func startRecording() throws {
        guard state == .idle else { return }

        // On-device transcription is the ONLY path. Without an installed model
        // this session would record audio and produce nothing, so refuse up
        // front and hand the caller the message the sheet already knows how to
        // show.
        let speechModel = SpeechModelManager.shared
        guard speechModel.isReady, let speechLocale = speechModel.locale else {
            Task { await speechModel.prewarm() }
            throw RecordingUnavailableError(
                message: speechModel.userFacingMessage ?? "On-device transcription isn't ready yet."
            )
        }

        try activateCaptureAudioSession()
        print("[RecordingService] Audio session active, category: \(AVAudioSession.sharedInstance().category.rawValue)")

        // Reset state
        segments = []
        finalizedSegments = []
        interimSegment = nil
        segmentCounter = 0
        lastFinalEndTime = 0
        pauseAccumulatedTime = 0
        pauseStartTime = nil
        errorMessage = nil
        liveUserNotes = ""
        liveNoteTitle = ""
        liveSelectedProjectId = nil
        liveShowTranscript = false
        recordingStartTime = Date()
        recordingStartedAt = recordingStartTime
        elapsedSeconds = 0
        inputLevel = 0
        transcriptionStatus = .starting
        finalization = nil

        // Reset server-sync bookkeeping for the new session.
        activeCaptureId = nil
        captureCreateFailed = false
        captureStartedAt = recordingStartTime
        ackedFinalCount = 0
        ackedTextLength = 0
        appendInFlight = false
        transcriptLocked = false

        // 1. Build the on-device transcriber. Its input stream exists from this
        //    moment, so audio fed before `start()` finishes is QUEUED, not lost.
        let liveTranscriber = AppleSpeechLiveTranscriber(
            locale: speechLocale,
            analyzerFormat: speechModel.analyzerFormat
        )
        // Called SYNCHRONOUSLY on the main actor from inside the transcriber's
        // results consumer. Do not wrap these in a Task: `finish()` awaits that
        // consumer, so a deferred hop here would let the last drained final land
        // after the save path had already read the transcript, truncating the
        // tail of every recording.
        liveTranscriber.onSegment = { [weak self] segment in
            self?.handleLiveSegment(segment)
        }
        liveTranscriber.onStatus = { [weak self] status in
            self?.handleTranscriptionStatus(status)
        }
        self.transcriber = liveTranscriber

        // 2. Set up the audio engine + tap BEFORE the socket resolves so no
        //    speech is missed. We connect the socket asynchronously; audio sent
        //    before it's open is simply dropped by the client (rare, sub-second).
        let engine = AVAudioEngine()
        self.audioEngine = engine
        let inputNode = engine.inputNode
        let inputFormat = inputNode.inputFormat(forBus: 0)

        // The tap fires on a real-time audio thread (nonisolated). `feed` is
        // lock-guarded and nonisolated, so the closure never touches main-actor
        // state. Level metering rides along on the same buffers, deliberately
        // computed AFTER the hand-off — a meter must not be able to cost us audio.
        let feedTarget = liveTranscriber
        let meter = InputLevelMeter()
        inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            feedTarget.feed(buffer)
            if let level = meter.level(for: buffer) {
                Task { @MainActor [weak self] in
                    guard let self, self.state == .recording else { return }
                    self.inputLevel = level
                }
            }
        }

        #if DEBUG
        // A launch-arg audio fixture replaces the mic entirely: the same buffers,
        // the same `feed` path, the same capture pipeline — just sourced from a
        // file so the simulator (which has no mic) can be driven end to end.
        if let fixturePath = DebugRecordingAutomation.liveAudioFixturePath {
            inputNode.removeTap(onBus: 0)
            DebugRecordingAutomation.startFixtureFeed(path: fixturePath, into: liveTranscriber) { [weak self] level in
                Task { @MainActor [weak self] in
                    guard let self, self.state == .recording else { return }
                    self.inputLevel = level
                }
            }
        } else {
            engine.prepare()
            try engine.start()
        }
        #else
        engine.prepare()
        try engine.start()
        #endif

        state = .recording
        startDurationTimer()
        LiveActivityManager.shared.startActivity()

        // 3. Create the server-side capture row, in parallel with the mic + socket
        //    startup — exactly like the web recorder, which POSTs /api/account/captures
        //    at start so the row EXISTS while recording and the transcript can be
        //    streamed into it. A bare INSERT at save time (the old iOS behaviour)
        //    is invisible to the post-capture pipeline.
        let startedAt = recordingStartTime ?? Date()
        Task { @MainActor in
            await self.createServerCapture(startedAt: startedAt)
        }

        // 4. Periodically flush newly finalized segments to the server.
        startTranscriptSyncTimer()

        // 5. Start the analyzer. Buffers captured while this resolves are already
        //    queued in the transcriber's input stream, so nothing is missed.
        Task { @MainActor in
            do {
                try await liveTranscriber.start()
                print("[RecordingService] On-device transcriber listening")
            } catch {
                print("[RecordingService] Failed to start on-device transcriber: \(error.localizedDescription)")
                let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                self.errorMessage = message
                self.transcriptionStatus = .failed(message)
            }
        }
    }

    func pauseRecording() {
        guard state == .recording else { return }
        audioEngine?.pause()
        pauseStartTime = Date()
        state = .paused
        inputLevel = 0
        updateLiveActivity()
    }

    func resumeRecording() {
        guard state == .paused else { return }

        do {
            // An interruption (a phone call, most obviously) DEACTIVATES our
            // session. Starting the engine against a dead session either throws
            // or — worse — succeeds and delivers silence, so the rest of the
            // recording would be transcribed as nothing while the UI happily
            // showed "recording". Reactivate first.
            try activateCaptureAudioSession()
            try audioEngine?.start()
        } catch {
            print("[RecordingService] Failed to resume engine: \(error)")
            errorMessage = "Failed to resume recording: \(error.localizedDescription)"
            // Stay PAUSED. Flipping to .recording here would show a live
            // recording that captures nothing.
            return
        }

        if let pauseStart = pauseStartTime {
            pauseAccumulatedTime += Date().timeIntervalSince(pauseStart)
        }
        pauseStartTime = nil

        state = .recording
        updateLiveActivity()
    }

    // MARK: - Audio session

    /// Category, mode and options for a capture. Applied at start and again on
    /// resume, because an interruption deactivates the session.
    ///
    /// Mode `.default`, never `.voiceChat`: voice processing isolates the nearest
    /// voice and suppresses the rest of the room, which is exactly the audio a
    /// meeting capture is for. Bluetooth stays allowed on purpose: with AirPods
    /// connected iOS routes the mic to them (wanted for dictating on the go);
    /// without them the iPhone's own mics are used, set to omnidirectional below
    /// so every side of the table is heard equally.
    private func activateCaptureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true)
        Self.preferOmnidirectionalBuiltInMic(session)
    }

    /// When the iPhone's built-in mic is the active input, select a data source
    /// that supports the omnidirectional polar pattern and switch it to omni. A
    /// no-op for any other route (AirPods, a wired headset): those are the user's
    /// choice and are left exactly as iOS routed them.
    private static func preferOmnidirectionalBuiltInMic(_ session: AVAudioSession) {
        guard let active = session.currentRoute.inputs.first, active.portType == .builtInMic,
              let builtIn = session.availableInputs?.first(where: { $0.portType == .builtInMic }),
              let sources = builtIn.dataSources, !sources.isEmpty else { return }

        // Prefer the source iOS already chose for this orientation when it can
        // go omni; otherwise any source that can.
        let ordered = [builtIn.selectedDataSource].compactMap { $0 } + sources
        guard let source = ordered.first(where: { $0.supportedPolarPatterns?.contains(.omnidirectional) == true }) else {
            print("[RecordingService] Built-in mic has no omnidirectional data source")
            return
        }
        do {
            try source.setPreferredPolarPattern(.omnidirectional)
            try builtIn.setPreferredDataSource(source)
            print("[RecordingService] Built-in mic \"\(source.dataSourceName)\" set to omnidirectional")
        } catch {
            print("[RecordingService] Could not set the omnidirectional mic pattern: \(error.localizedDescription)")
        }
    }

    /// Stop capturing audio and begin draining the on-device analyzer.
    ///
    /// Stays synchronous so every existing caller is unchanged, but the real work
    /// now happens in the `finalization` task it creates. NOTHING may read the
    /// transcript until that task completes — `awaitFinalization()` is how the
    /// save path waits, and `finalizeCaptureOnServer()` calls it first thing.
    func stopRecording() {
        guard state == .recording || state == .paused else { return }
        state = .stopping

        durationTimer?.cancel()
        durationTimer = nil
        transcriptSyncTimer?.cancel()
        transcriptSyncTimer = nil

        // Stop the engine first: no more audio into the analyzer.
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = nil
        #if DEBUG
        DebugRecordingAutomation.stopFixtureFeed()
        #endif

        inputLevel = 0

        let liveTranscriber = transcriber
        transcriber = nil

        // Drain, THEN commit. `finish()` is what makes the analyzer emit its
        // remaining finals (they arrive through handleLiveSegment as usual), so
        // committing the in-flight volatile before it would both duplicate the
        // tail and lose whatever the analyzer still held.
        finalization = Task { @MainActor [weak self] in
            await liveTranscriber?.finish()
            guard let self else { return }
            self.commitInterimIfPresent()
            LiveActivityManager.shared.endActivity()
            if self.state == .stopping {
                self.state = .idle
            }
            try? AVAudioSession.sharedInstance().setActive(false)
        }
    }

    /// Block until the stop-time analyzer drain has delivered every final result.
    /// Safe to call when no stop is in flight (returns immediately) and safe to
    /// call more than once.
    func awaitFinalization() async {
        await finalization?.value
    }

    /// Tear down the session WITHOUT finalizing. Two very different callers:
    ///  - the user discarding a recording (the capture row, if created, is
    ///    deleted so no empty orphan is left behind), and
    ///  - the save paths, which call this AFTER the capture has been finalized
    ///    through the API. Those pass `deleteServerCapture: false`.
    ///
    /// Returns the in-flight server DELETE when one was issued, so a caller that
    /// is about to refresh the notes list can await it first — otherwise the
    /// refetch outruns the DELETE and the discarded capture reappears on Home.
    @discardableResult
    func cancelRecording(deleteServerCapture: Bool = true) -> Task<Void, Never>? {
        durationTimer?.cancel()
        durationTimer = nil
        transcriptSyncTimer?.cancel()
        transcriptSyncTimer = nil

        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = nil
        #if DEBUG
        DebugRecordingAutomation.stopFixtureFeed()
        #endif

        // Discard: drop whatever the analyzer still holds rather than waiting for
        // it. The save paths call this only AFTER finalize, so nothing is lost.
        transcriber?.cancel()
        transcriber = nil
        finalization?.cancel()
        finalization = nil

        // The breadcrumb is deliberately NOT cleared here for either caller.
        //
        //  - Post-finalize teardown (`deleteServerCapture: false`): the row is
        //    ended but the batch that writes its summary is still running,
        //    detached, and can take minutes. `runPostCaptureProcessing` clears
        //    the record when that pass actually finishes; clearing it here would
        //    strand a capture killed mid-batch with no way back.
        //  - Discard (`deleteServerCapture: true`): the DELETE below is
        //    best-effort and can fail (offline, most obviously). Clearing first
        //    would leave exactly the orphan this feature exists to clean up — an
        //    un-ended row that shows "Interrupted" on Home forever and offers to
        //    summarize a recording the user explicitly threw away. The record is
        //    cleared inside the task, only once the DELETE has succeeded.
        var deleteTask: Task<Void, Never>?
        if deleteServerCapture, let captureId = activeCaptureId {
            // Record the INTENT before the attempt. If the DELETE fails and the
            // app dies, recovery must delete this row rather than summarize it —
            // it has a transcript, and step 3 of recover() would otherwise
            // helpfully finish a recording the user threw away.
            InFlightCaptureStore.shared.markDiscarded(captureId: captureId)
            // Best-effort orphan cleanup — same as the web recorder's
            // discardRecording(), which DELETEs the row it optimistically created.
            deleteTask = Task.detached {
                do {
                    try await NotesService.shared.deleteNote(id: captureId)
                    await MainActor.run {
                        InFlightCaptureStore.shared.clear(captureId: captureId)
                    }
                    print("🗑️ [RecordingService] Discarded capture \(captureId.uuidString.prefix(8))…")
                } catch {
                    // Keep the breadcrumb: the next launch finds the row, sees no
                    // transcript (or an abandoned one) and cleans it up properly.
                    print("⚠️ [RecordingService] Discard DELETE failed for \(captureId.uuidString.prefix(8))… (\(error.localizedDescription)) — leaving the in-flight record so recovery can clean it up")
                }
            }
        }

        segments = []
        finalizedSegments = []
        interimSegment = nil
        segmentCounter = 0
        elapsedSeconds = 0
        inputLevel = 0
        recordingStartedAt = nil
        transcriptionStatus = .starting
        errorMessage = nil
        liveUserNotes = ""
        liveNoteTitle = ""
        liveSelectedProjectId = nil
        liveShowTranscript = false
        activeCaptureId = nil
        captureCreateFailed = false
        captureStartedAt = nil
        ackedFinalCount = 0
        ackedTextLength = 0
        appendInFlight = false
        transcriptLocked = false
        LiveActivityManager.shared.endActivity()
        state = .idle
        try? AVAudioSession.sharedInstance().setActive(false)
        return deleteTask
    }

    // MARK: - Transcript assembly from the on-device transcriber

    /// Handle a volatile/final result. Volatile results replace the single
    /// in-flight segment; final results commit it and start fresh — identical
    /// semantics to the streaming path this replaces.
    @MainActor
    private func handleLiveSegment(_ dg: LiveTranscriptSegment) {
        let text = dg.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        if dg.isFinal {
            // Commit as a finalized segment.
            let index = segmentCounter
            segmentCounter += 1
            let segment = TranscriptSegment(
                text: text,
                segmentIndex: index,
                source: .microphone,
                recordingOffsetSeconds: dg.startTime
            )
            finalizedSegments.append(segment)
            lastFinalEndTime = max(lastFinalEndTime, dg.endTime)
            interimSegment = nil
            print("[RecordingService] 📝 Final segment \(index): \"\(text.prefix(80))\"")
        } else {
            // Update the in-flight interim. Reuse the same segmentIndex slot
            // (one past the last finalized) so it always sorts last and the UI
            // updates in place rather than appending duplicates.
            let interimIndex = segmentCounter
            interimSegment = TranscriptSegment(
                text: text,
                segmentIndex: interimIndex,
                source: .microphone,
                recordingOffsetSeconds: dg.startTime
            )
        }

        rebuildSegments()
    }

    /// Mirror the transcriber's health onto the published state, and surface a
    /// hard failure in the sheet's existing error banner. A `.restarting` is
    /// deliberately NOT an error — it self-heals and the user keeps talking.
    @MainActor
    private func handleTranscriptionStatus(_ status: LiveTranscriptionStatus) {
        transcriptionStatus = status
        if case .failed(let message) = status {
            errorMessage = message
        }
    }

    /// If a volatile utterance is still in progress when we stop, promote it to a
    /// finalized segment so it isn't dropped.
    @MainActor
    private func commitInterimIfPresent() {
        guard let interim = interimSegment else { return }

        // The drain delivers finals synchronously, so a final that superseded
        // this hypothesis has already niled it. A survivor that nonetheless
        // starts before the last committed final ended describes words we
        // already have — committing it would duplicate the tail of the
        // recording, and the batch extractor would read the same sentence twice.
        if !finalizedSegments.isEmpty, interim.recordingOffsetSeconds < lastFinalEndTime {
            interimSegment = nil
            rebuildSegments()
            return
        }

        let index = segmentCounter
        segmentCounter += 1
        finalizedSegments.append(TranscriptSegment(
            text: interim.text,
            segmentIndex: index,
            source: .microphone,
            recordingOffsetSeconds: interim.recordingOffsetSeconds
        ))
        interimSegment = nil
        rebuildSegments()
    }

    /// Recompute the published `segments` array = finalized + optional interim.
    @MainActor
    private func rebuildSegments() {
        var combined = finalizedSegments
        if let interim = interimSegment {
            combined.append(interim)
        }
        segments = combined
        isTranscribingChunk = interimSegment != nil
    }

    // MARK: - Server capture pipeline
    //
    // Mirrors the web recorder (dial8-website/src/hooks/recording-context.tsx).
    // A bare Supabase INSERT into `captures` produces a row nothing downstream
    // ever touches — no title, no summary, no extracted actions, because the
    // post-capture pipeline is driven by the CLIENT, not by a DB trigger.

    /// Transcript line format the server pipeline expects, byte-for-byte the
    /// same as the web recorder's `buildFullTranscript`: `[Speaker] text`,
    /// segments joined with a single newline.
    private func transcriptLine(for segment: TranscriptSegment) -> String {
        "[\(segment.source.displayLabel)] \(segment.text)"
    }

    /// The full server-format transcript for every FINALIZED segment.
    private var serverTranscript: String {
        finalizedSegments
            .sorted { $0.segmentIndex < $1.segmentIndex }
            .map { transcriptLine(for: $0) }
            .joined(separator: "\n")
    }

    /// POST /api/account/captures — create the row at recording start.
    /// On failure we keep recording and mark `captureCreateFailed`, so the save
    /// path falls back to the legacy direct INSERT (offline-tolerant, but the
    /// note will not be auto-processed). Logged loudly either way.
    @MainActor
    private func createServerCapture(startedAt: Date) async {
        let id = UUID()
        // The auto-title placeholder is load-bearing: generate-title only renames
        // a capture whose title still matches its `Capture Mon D H:MM AM/PM`
        // pattern. Any other string reads as a user-chosen title and is kept.
        let title = CaptureAPIService.autoTitle(for: startedAt)

        do {
            let serverId = try await CaptureAPIService.shared.createCapture(
                id: id,
                title: title,
                startedAt: startedAt,
                liveMode: false
            )
            // A stop/cancel may have raced this round trip. Don't bind a capture
            // to a session that is already over — and delete the row we just
            // created, or a discarded session leaves an empty orphan behind.
            guard state == .recording || state == .paused || state == .stopping else {
                print("⚠️ [RecordingService] Capture create resolved after session end — deleting orphan \(serverId.uuidString.prefix(8))…")
                Task.detached { try? await NotesService.shared.deleteNote(id: serverId) }
                return
            }
            activeCaptureId = serverId
            captureCreateFailed = false
            // Write the crash breadcrumb the MOMENT the row exists. From here
            // until the finalizing PATCH lands, a kill leaves a capture on the
            // server that nothing would ever finish — this record is what lets
            // the next launch find and finish it.
            InFlightCaptureStore.shared.save(
                InFlightCapture(
                    captureId: serverId,
                    startedAt: startedAt,
                    workspaceId: WorkspaceService.shared.workspaceId
                )
            )
            print("✅ [RecordingService] API path: capture row \(serverId.uuidString.prefix(8))… created at start")
        } catch {
            captureCreateFailed = true
            print("❌ [RecordingService] API capture create FAILED (\(error.localizedDescription)) — falling back to direct DB insert on save. This note will NOT be auto-summarized.")
        }
    }

    private func startTranscriptSyncTimer() {
        let timer = DispatchSource.makeTimerSource(queue: timerQueue)
        timer.schedule(
            deadline: .now() + Self.transcriptSyncInterval,
            repeating: Self.transcriptSyncInterval
        )
        timer.setEventHandler { [weak self] in
            Task { @MainActor [weak self] in
                await self?.flushTranscriptToServer()
            }
        }
        timer.resume()
        transcriptSyncTimer = timer
    }

    /// Send every final segment the server hasn't acknowledged yet as ONE delta
    /// append. Coalescing is deliberate: one request per interval carrying all
    /// new segments, never one per word.
    ///
    /// Acked counters advance only on a confirmed 2xx, so a failed append re-sends
    /// the identical delta on the next tick and never leaves a hole. On a
    /// base-length divergence we re-establish ground truth with a full-text PATCH
    /// through the no-shrink route, exactly like the web client.
    @MainActor
    private func flushTranscriptToServer() async {
        guard let captureId = activeCaptureId, !transcriptLocked else { return }
        guard !appendInFlight else { return }

        let sorted = finalizedSegments.sorted { $0.segmentIndex < $1.segmentIndex }
        guard sorted.count > ackedFinalCount else { return }

        appendInFlight = true
        defer { appendInFlight = false }

        let baseLength = ackedTextLength
        let chunk = sorted[ackedFinalCount...]
            .map { transcriptLine(for: $0) }
            .joined(separator: "\n")
        // Prefix the join separator when the server already holds text, so the
        // concatenation matches a full save byte-for-byte.
        let appendText = baseLength > 0 ? "\n" + chunk : chunk
        let pendingCount = sorted.count

        do {
            let newLength = try await CaptureAPIService.shared.appendTranscript(
                captureId: captureId,
                appendText: appendText,
                baseLength: baseLength
            )
            // unicodeScalars.count, NOT String.count: `new_length` comes from the
            // server's char_length(), which counts Unicode CODE POINTS. Swift's
            // String.count counts grapheme clusters, so one emoji or a combining
            // accent makes the two disagree and sends us into a pointless
            // full-text re-sync on every append.
            let expected = baseLength + appendText.unicodeScalars.count
            if newLength == expected {
                ackedFinalCount = pendingCount
                ackedTextLength = newLength
                return
            }
            // Length divergence — fall through to the full-text re-sync.
            print("⚠️ [RecordingService] transcript-append length divergence (\(newLength) vs \(expected)) — re-syncing")
        } catch CaptureAPIError.transcriptLocked {
            transcriptLocked = true
            print("⚠️ [RecordingService] Transcript locked — stopping appends for \(captureId.uuidString.prefix(8))…")
            return
        } catch CaptureAPIError.baseLengthMismatch(let serverLength) {
            print("⚠️ [RecordingService] transcript-append base mismatch (server holds \(serverLength)) — re-syncing via full PATCH")
        } catch {
            // Transient failure: leave the acked counters untouched so the next
            // tick re-sends the identical delta.
            print("⚠️ [RecordingService] transcript-append failed: \(error.localizedDescription)")
            return
        }

        // ── Re-sync: full-text PATCH through the no-shrink route ──
        let fullText = serverTranscript
        do {
            let accepted = try await CaptureAPIService.shared.replaceTranscript(
                captureId: captureId,
                transcript: fullText
            )
            if accepted {
                ackedFinalCount = pendingCount
                // Code points — matches the server's char_length() (see above).
                ackedTextLength = fullText.unicodeScalars.count
            } else {
                print("⚠️ [RecordingService] Full-PATCH re-sync no-shrink-skipped — leaving counters for the next tick")
            }
        } catch {
            print("⚠️ [RecordingService] Full-PATCH re-sync failed: \(error.localizedDescription)")
        }
    }

    /// Finalize the capture through the website pipeline, in the web recorder's
    /// exact order:
    ///
    ///   1. final transcript flush (delta, then full-text PATCH as the
    ///      authoritative save — it must win even if the delta path is wedged)
    ///   2. PATCH ended_at + duration_seconds + ai_processed
    ///   3. POST /api/ai/live-agent mode:batch  ← summary + extracted actions
    ///   4. POST generate-title                 ← reads the summary written in 3
    ///
    /// Steps 3 and 4 are where titles/summaries/actions actually come from; the
    /// PATCH in step 2 triggers nothing on its own.
    ///
    /// - Returns: the finalized capture id, or nil when there is no server-side
    ///   capture (create failed → the caller must use the direct-insert fallback).
    @MainActor
    @discardableResult
    func finalizeCaptureOnServer(userNotes: String? = nil) async -> UUID? {
        // 0. THE ordering rule of the on-device path: the analyzer only emits its
        //    last final results during `finish()`, so every byte below would be
        //    written from a truncated transcript if we didn't wait here. Bounded
        //    inside the transcriber (15s), so a wedged analyzer delays the save
        //    rather than hanging it.
        await awaitFinalization()

        guard let captureId = activeCaptureId else {
            print("⚠️ [RecordingService] No server capture to finalize — fallback path will run")
            return nil
        }

        // 1. Authoritative final transcript save. Try the delta first (cheap when
        //    it's just the tail), then force ground truth with the full text —
        //    the web recorder's `saveTranscript(force: true)`.
        await flushTranscriptToServer()
        let fullText = serverTranscript
        if !fullText.isEmpty {
            do {
                _ = try await CaptureAPIService.shared.replaceTranscript(
                    captureId: captureId,
                    transcript: fullText
                )
                ackedFinalCount = finalizedSegments.count
                // Code points — matches the server's char_length() (see above).
                ackedTextLength = fullText.unicodeScalars.count
            } catch {
                print("⚠️ [RecordingService] Final transcript save failed: \(error.localizedDescription)")
            }
        }

        // 1b. Persist the user's live notes, if any. user_notes is a plain
        //     column on the same PATCH route and feeds the batch prompt
        //     (BATCH_USER_NOTES_GUIDANCE), so it must land BEFORE extraction.
        if let userNotes, !userNotes.isEmpty {
            do {
                var dto = UpdateNoteDTO()
                dto.userNotes = userNotes
                _ = try await NotesService.shared.updateNote(id: captureId, dto: dto, silent: true)
            } catch {
                print("⚠️ [RecordingService] Failed to save user notes: \(error.localizedDescription)")
            }
        }

        // 2. End the capture (ended_at + duration + ai_processed). The DB trigger
        //    lock_transcript_on_end locks the transcript from here on.
        let endedAt = Date()
        let duration = max(0, Int(elapsedSeconds))
        do {
            try await CaptureAPIService.shared.endCapture(
                captureId: captureId,
                endedAt: endedAt,
                durationSeconds: duration
            )
            transcriptLocked = true
            // NOT cleared here. `ended_at` landing is only half the job: the
            // summary comes from the batch below, which runs detached and can
            // take minutes. A kill in that window leaves a row that is ended,
            // transcript-bearing and summary-less — a state `Note.isInterrupted`
            // cannot see (it requires ended_at == nil), so without the breadcrumb
            // nothing would ever finish it. The clear happens after the batch.
        } catch {
            print("❌ [RecordingService] endCapture failed: \(error.localizedDescription) — leaving the in-flight record so recovery can finish this capture")
        }

        // 2b. Pull the freshly finalized row into the local cache RIGHT NOW and
        //     announce it. The capture row is created server-side by the capture
        //     API, so nothing local knows about it: without this, a just-saved
        //     recording was missing from Home until a pull-to-refresh. The
        //     placeholder title and empty summary are fine — the row shows as
        //     "Processing…" and is replaced when the batch lands.
        await NotesService.shared.refreshNoteAndNotify(id: captureId)

        // 3 + 4 run in the background: the user shouldn't wait on a batch that can
        // take minutes on a long meeting. The capture row already exists and is
        // durable; the summary/title stream in afterwards.
        Task.detached {
            await Self.runPostCaptureProcessing(captureId: captureId)
        }

        return captureId
    }

    /// The batch extraction + title pass. Explicitly `nonisolated`: the class is
    /// @MainActor, and a batch run can take minutes — hopping back onto the main
    /// actor for it would block the UI. Nothing here touches recording state.
    ///
    /// Not private: `CaptureRecoveryService` runs the identical pass for a capture
    /// it just ended on the user's behalf. One implementation, so a recovered
    /// capture cannot drift from a normally-saved one.
    ///
    /// - Returns: true when the batch actually produced a summary. Recovery uses
    ///   this to decide whether the capture is finished — it must not drop its
    ///   breadcrumb for a capture whose batch just failed.
    @discardableResult
    nonisolated static func runPostCaptureProcessing(captureId: UUID) async -> Bool {
        // The batch run is a network call that can take minutes. Without an
        // explicit background-task assertion, iOS suspends the app a few seconds
        // after the user leaves it (which they DO — they stop the recording and
        // switch away) and the request dies half-finished: no summary, no title,
        // no extracted actions. The assertion buys us the OS's background window;
        // `defer` ends it on every exit path, including a thrown error, because a
        // leaked assertion gets the app killed.
        let backgroundTaskId = await MainActor.run {
            UIApplication.shared.beginBackgroundTask(withName: "dial8.capture.batch") {
                print("⚠️ [RecordingService] Background time expired during post-capture processing for \(captureId.uuidString.prefix(8))…")
            }
        }
        defer {
            if backgroundTaskId != .invalid {
                Task { @MainActor in
                    UIApplication.shared.endBackgroundTask(backgroundTaskId)
                }
            }
        }

        do {
            // THE call that generates the summary and extracts actions/decisions.
            _ = try await CaptureAPIService.shared.runBatchExtraction(captureId: captureId)
        } catch {
            print("❌ [RecordingService] Batch extraction failed for \(captureId.uuidString.prefix(8))…: \(error.localizedDescription). The capture is saved — reprocess it from the web app.")
            // Still refresh the row so the raw transcript shows up in the list.
            await refreshCaptureLocally(captureId)
            return false
        }

        // Title generation reads ai_summary, so it MUST follow the batch.
        do {
            try await CaptureAPIService.shared.generateTitle(captureId: captureId)
        } catch {
            print("⚠️ [RecordingService] generate-title failed: \(error.localizedDescription)")
        }

        await refreshCaptureLocally(captureId)

        // NOW the capture is genuinely finished: ended, summarized, titled. This
        // is the only place the breadcrumb may be dropped on the happy path — the
        // end PATCH alone is not enough, because a kill between it and here
        // leaves an ended, summary-less row that `Note.isInterrupted` cannot see.
        await MainActor.run {
            InFlightCaptureStore.shared.clear(captureId: captureId)
        }
        return true
    }

    /// Re-read the capture from Supabase so the list/detail views show the
    /// server-written title, summary and transcript. `nonisolated` for the same
    /// reason as `runPostCaptureProcessing` — only the notification post hops to
    /// the main actor.
    private nonisolated static func refreshCaptureLocally(_ captureId: UUID) async {
        // refreshNoteAndNotify does the fetch, the cache write (insert-at-0 for a
        // row we've never seen, replace-in-place otherwise) and the .noteUpdated
        // post — the detail view listens for that to swap in the arriving summary.
        if let note = await NotesService.shared.refreshNoteAndNotify(id: captureId) {
            print("🔄 [RecordingService] Refreshed capture \(captureId.uuidString.prefix(8))… → \"\(note.title)\"")
        }
    }

    // MARK: - Timers

    private func startDurationTimer() {
        let timer = DispatchSource.makeTimerSource(queue: timerQueue)
        timer.schedule(deadline: .now() + 1, repeating: 1.0)
        timer.setEventHandler { [weak self] in
            // Hop to the main actor — all state here (elapsedSeconds, offset,
            // LiveActivity) is main-actor isolated.
            Task { @MainActor [weak self] in
                guard let self = self else { return }
                self.elapsedSeconds = self.currentRecordingOffset
                self.updateLiveActivity()
            }
        }
        timer.resume()
        durationTimer = timer
    }

    // MARK: - Helpers

    private var currentRecordingOffset: TimeInterval {
        guard let start = recordingStartTime else { return 0 }
        let total = Date().timeIntervalSince(start)
        let pauseTime = pauseAccumulatedTime + (pauseStartTime.map { Date().timeIntervalSince($0) } ?? 0)
        return max(0, total - pauseTime)
    }

    private func updateLiveActivity() {
        LiveActivityManager.shared.updateActivity(
            elapsedSeconds: Int(elapsedSeconds),
            isRecording: isRecording,
            isPaused: isPaused,
            segmentCount: segments.count
        )
    }

    /// Zero-padded elapsed time: `mm:ss` under an hour, `h:mm:ss` past it.
    /// The leading zero matters — the recording bar uses monospaced digits and a
    /// `0:03 → 10:03` jump in width made the whole bar twitch.
    var formattedDuration: String {
        let totalSeconds = Int(elapsedSeconds)
        let hours = totalSeconds / 3600
        let minutes = (totalSeconds % 3600) / 60
        let seconds = totalSeconds % 60
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, seconds)
        }
        return String(format: "%02d:%02d", minutes, seconds)
    }
}

// MARK: - Input Level Meter (nonisolated — runs on the audio thread)

/// Turns raw mic buffers into a 0…1 loudness value for the recording bar's
/// bars. Owned by the tap closure, so it never touches main-actor state.
///
/// RMS → dBFS with a −50 dB floor, then eased with `pow(x, 0.6)`: linear RMS
/// spends almost all of its range in the bottom few percent, so quiet speech
/// rendered as no movement at all. Sampled at ~10 Hz — publishing per buffer
/// (≈10× faster) redrew the meter far more often than a 60 Hz screen can show.
final class InputLevelMeter {
    private static let floorDB: Float = -50
    private static let minInterval: TimeInterval = 0.1

    private var lastEmit: TimeInterval = 0

    /// - Returns: the normalized level, or nil when this buffer falls inside the
    ///   throttle window (the caller then publishes nothing).
    func level(for buffer: AVAudioPCMBuffer) -> Float? {
        let now = CACurrentMediaTime()
        guard now - lastEmit >= Self.minInterval else { return nil }
        lastEmit = now

        guard let channelData = buffer.floatChannelData else { return nil }
        let frameCount = Int(buffer.frameLength)
        guard frameCount > 0 else { return nil }

        let samples = channelData[0]
        var sumSquares: Float = 0
        for i in 0..<frameCount {
            let sample = samples[i]
            sumSquares += sample * sample
        }
        let rms = (sumSquares / Float(frameCount)).squareRoot()
        guard rms > 0 else { return 0 }

        let db = 20 * log10(rms)
        let normalized = max(0, min(1, (db - Self.floorDB) / -Self.floorDB))
        return pow(normalized, 0.6)
    }
}

// MARK: - Start-time refusal

/// Thrown by `startRecording()` when the on-device model isn't ready. The
/// message is `SpeechModelManager.userFacingMessage` verbatim, and the recording
/// sheet already renders a thrown error's `localizedDescription` in its banner.
struct RecordingUnavailableError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

#if DEBUG

// MARK: - DEBUG launch-argument automation
//
// Mirrors the watch app's -autoStartRecording / -autoStopAfterSeconds hooks so
// the iOS recorder can be driven on a simulator that has no mic and cannot be
// tapped:
//
//   xcrun simctl launch <device> com.dial8-iOS-26 \
//     -autoStartRecording YES \
//     -liveAudioFixture /path/to/speech.aiff \
//     -autoStopAfterSeconds 45
//
// `-liveAudioFixture` replaces the mic tap with the file's own buffers, fed
// through the SAME `AppleSpeechLiveTranscriber.feed` path and paced in real
// time, so everything downstream — capture creation, transcript sync, save — is
// exercised exactly as in a live session.

enum DebugRecordingAutomation {
    /// `-autoStartRecording YES`
    static var autoStartRecording: Bool {
        UserDefaults.standard.bool(forKey: "autoStartRecording")
    }

    /// `-autoStopAfterSeconds N` (0 = never auto-stop)
    static var autoStopAfterSeconds: TimeInterval {
        UserDefaults.standard.double(forKey: "autoStopAfterSeconds")
    }

    /// `-liveAudioFixture <path>` — nil when absent or missing on disk.
    static var liveAudioFixturePath: String? {
        guard let path = UserDefaults.standard.string(forKey: "liveAudioFixture"),
              !path.isEmpty,
              FileManager.default.fileExists(atPath: path) else { return nil }
        return path
    }

    private static let queue = DispatchQueue(label: "com.dial8.debug.fixtureFeed", qos: .userInitiated)
    private nonisolated(unsafe) static var feedSource: DispatchSourceTimer?

    /// Read `path` in ~4096-frame chunks and feed them at wall-clock speed.
    /// Pacing matters: dumping the whole file at once would make the analyzer
    /// produce the entire transcript before the capture row even exists.
    static func startFixtureFeed(
        path: String,
        into transcriber: AppleSpeechLiveTranscriber,
        level: @escaping (Float) -> Void
    ) {
        stopFixtureFeed()

        let url = URL(fileURLWithPath: path)
        guard let file = try? AVAudioFile(forReading: url) else {
            print("[DebugAutomation] ⚠️ could not open fixture \(path)")
            return
        }

        let format = file.processingFormat
        let chunkFrames: AVAudioFrameCount = 4096
        let interval = Double(chunkFrames) / format.sampleRate
        let meter = InputLevelMeter()

        print("[DebugAutomation] feeding fixture \(url.lastPathComponent): \(format.sampleRate) Hz, \(file.length) frames, \(String(format: "%.1f", Double(file.length) / format.sampleRate))s")

        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: interval)
        timer.setEventHandler {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunkFrames) else { return }
            do {
                try file.read(into: buffer, frameCount: chunkFrames)
            } catch {
                print("[DebugAutomation] fixture read failed: \(error.localizedDescription)")
                stopFixtureFeed()
                return
            }
            guard buffer.frameLength > 0 else {
                print("[DebugAutomation] fixture exhausted")
                stopFixtureFeed()
                return
            }
            transcriber.feed(buffer)
            if let value = meter.level(for: buffer) {
                DispatchQueue.main.async { level(value) }
            }
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
