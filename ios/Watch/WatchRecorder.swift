import Foundation
import AVFoundation
import WatchKit
import Combine

@MainActor
final class WatchRecorder: NSObject, ObservableObject {

    enum State: Equatable {
        case idle
        case recording(since: Date)
        case paused(since: Date)
        case stopped(sentToPhone: Bool)
    }

    @Published private(set) var state: State = .idle
    /// SESSION elapsed — recorded time across every chunk, never reset by a
    /// rotation. The count-up on screen is this.
    @Published private(set) var elapsed: TimeInterval = 0
    @Published private(set) var pendingCount: Int = 0
    /// Waiting RECORDINGS, for the UI. `pendingCount` counts chunks, which is
    /// the right number for the transfer machinery and the wrong one to show a
    /// person — one long meeting is four chunks but one recording.
    @Published private(set) var pendingSessionCount: Int = 0
    @Published private(set) var permissionDenied: Bool = false
    /// Set when the system cut the recording short (a call, Siri, another audio
    /// app). The UI says so instead of silently showing a finished recording.
    @Published private(set) var wasInterrupted: Bool = false
    /// 0…1 mic loudness, driven by `AVAudioRecorder.averagePower` at ~10 Hz while
    /// recording. The level meter reads this; nothing else does.
    @Published private(set) var level: Double = 0
    /// The calendar meeting this recording belongs to, chosen at start from the
    /// application context the phone pushed. `nil` outside a meeting window.
    @Published private(set) var meetingTitle: String?
    /// The workspace this recording will be filed into, resolved ONCE at
    /// `start()` from the watch's own selection. Held for the length of the
    /// session and stamped on every chunk, so a selection changed after the user
    /// hit record cannot move a capture that is already being made.
    @Published private(set) var sessionWorkspaceId: UUID?

    /// What the phone will use as the capture's provisional title, and what the
    /// recording screen shows under the count-up.
    static let fallbackTitle = "New recording"

    var displayTitle: String { meetingTitle ?? Self.fallbackTitle }

    // MARK: - Chunking

    /// How much RECORDED time goes into one chunk before the recorder rotates to
    /// a fresh file. A one-hour meeting therefore arrives on the phone as four
    /// files that transferred WHILE it was still being recorded, so a crash or a
    /// dead battery at minute 50 costs the current chunk, not the meeting.
    ///
    /// Paused time does not count: the clock is recorded time, so a recording
    /// paused for twenty minutes neither rotates during the pause nor rotates the
    /// instant it resumes.
    static let defaultChunkDuration: TimeInterval = 15 * 60

    /// DEBUG override so rotation is testable in a run measured in seconds
    /// instead of an hour. Pass it to the WATCH app:
    ///
    ///   xcrun simctl launch --console-pty <watch-udid> com.dial8-iOS-26.watchkitapp \
    ///     -autoStartRecording YES -chunkSeconds 20 -autoStopAfterSeconds 70
    ///
    /// Values below 1 second are ignored (that is also what an absent argument
    /// reads as), so a typo cannot turn every tick into a rotation.
    static var chunkDuration: TimeInterval {
        #if DEBUG
        let override = UserDefaults.standard.double(forKey: "chunkSeconds")
        if override >= 1 { return override }
        #endif
        return defaultChunkDuration
    }

    private var recorder: AVAudioRecorder?
    /// The CURRENT chunk's id / file / wall-clock start.
    private var currentID: UUID?
    private var currentURL: URL?
    private var startedAt: Date?
    /// Session identity, shared by every chunk of this recording.
    private var sessionID: UUID?
    private var sessionStartedAt: Date?
    private var chunkIndex: Int = 0
    /// Recorded session seconds before the current chunk's first sample.
    private var chunkStartOffset: TimeInterval = 0
    /// Sum of the durations actually written to the closed chunks — used only to
    /// report the real audio lost at each rotation boundary.
    private var closedChunkDuration: TimeInterval = 0

    private var ticker: AnyCancellable?
    private var meterTicker: AnyCancellable?
    private var rotationWork: DispatchWorkItem?
    private var interruptionObserver: NSObjectProtocol?
    private var queueObserver: NSObjectProtocol?
    private var backgroundObserver: NSObjectProtocol?
    private var foregroundObserver: NSObjectProtocol?

    /// Recording time banked by earlier run segments of THIS recording, i.e.
    /// everything before the current pause/resume cycle. Elapsed time is this plus
    /// the time since the current segment began — never wall clock since start,
    /// which would keep counting through a pause.
    ///
    /// This is SESSION-wide accounting and rotation must not touch it: it is both
    /// the count-up the user sees and the clock the rotation interval is measured
    /// against.
    private var accumulated: TimeInterval = 0
    /// When the current *running* segment began. nil while paused.
    private var segmentStartedAt: Date?
    #if DEBUG
    private var meterTickCount = 0
    #endif

    private static let recordingSettings: [String: Any] = [
        AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
        AVSampleRateKey: 16_000.0,
        AVNumberOfChannelsKey: 1,
        AVEncoderBitRateKey: 32_000
    ]

    override init() {
        super.init()
        refreshPendingCount()
        observeInterruptions()
        observeQueue()
        observeVisibility()
    }

    deinit {
        for observer in [interruptionObserver, queueObserver, backgroundObserver, foregroundObserver] {
            if let observer { NotificationCenter.default.removeObserver(observer) }
        }
    }

    var isRecording: Bool {
        if case .recording = state { return true }
        return false
    }

    var isPaused: Bool {
        if case .paused = state { return true }
        return false
    }

    /// A recording exists — running or paused. The things that must not happen
    /// twice (start, enqueue) key off this, not `isRecording`.
    var isCapturing: Bool { isRecording || isPaused }

    func refreshPendingCount() {
        pendingCount = RecordingQueue.shared.pendingCount
        pendingSessionCount = RecordingQueue.shared.pendingSessionCount
    }

    /// Recorded session time right now: banked segments plus the running one.
    /// Paused time is excluded by construction.
    private var recordedTime: TimeInterval {
        accumulated + (segmentStartedAt.map { Date().timeIntervalSince($0) } ?? 0)
    }

    // MARK: - Interruptions

    /// An incoming call, Siri, or another audio app takes the session away and
    /// `AVAudioRecorder` stops writing — WITHOUT telling the UI. Left unhandled,
    /// the view stays on `.recording` and the ticker keeps counting, so the user
    /// watches 12:34 tick past believing the meeting is being captured while the
    /// file stopped growing minutes ago. That matters far more now that recording
    /// continues in the background: the wrist is down, nobody is looking.
    ///
    /// On `.began` we finalize what was captured — the audio up to the
    /// interruption is real and worth keeping — rather than resuming into the
    /// same file, which `AVAudioRecorder` cannot reliably do after the session is
    /// torn away. Chunks already closed and handed to WCSession are unaffected:
    /// they are on their way to the phone regardless, which is the point of
    /// chunking.
    private func observeInterruptions() {
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            MainActor.assumeIsolated {
                guard let self else { return }
                switch type {
                case .began:
                    // A paused recording is just as much a live recording from
                    // the user's point of view: the session is still ours and the
                    // audio so far is still worth keeping.
                    guard self.isCapturing else { return }
                    print("[WatchRecorder] audio session interrupted — finalizing what was captured")
                    self.wasInterrupted = true
                    self.stop()
                case .ended:
                    // Nothing to resume into: `stop()` already enqueued the audio.
                    print("[WatchRecorder] interruption ended")
                @unknown default:
                    break
                }
            }
        }
    }

    /// The "N waiting to sync" footnote is only true if it refreshes when a
    /// transfer completes. `RecordingQueue` posts on every mutation.
    private func observeQueue() {
        queueObserver = NotificationCenter.default.addObserver(
            forName: .watchRecordingQueueChanged,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshPendingCount() }
        }
    }

    /// Metering exists to drive the on-screen `LevelMeter`, and `UIBackgroundModes
    /// = audio` means the dominant case is the one where there is no screen: the
    /// wrist is down for a 45-minute meeting. Left running, the 10 Hz timer would
    /// sample the mic and publish `objectWillChange` ~27,000 times for a view
    /// nobody can see. Suspend it with the UI and restart it on the way back.
    ///
    /// The RECORDING is untouched — only the meter sampling pauses. Rotation is
    /// untouched too: it runs off its own timer and must keep firing with the
    /// screen dark, which is the whole case chunking exists for.
    private func observeVisibility() {
        backgroundObserver = NotificationCenter.default.addObserver(
            forName: WKApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.meterTicker != nil else { return }
                self.stopMetering()
                // So the bars are correct the instant the screen comes back,
                // rather than frozen at whatever the last sample was.
                self.level = 0
                print("[WatchRecorder] backgrounded — metering suspended")
            }
        }
        foregroundObserver = NotificationCenter.default.addObserver(
            forName: WKApplication.willEnterForegroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.isRecording, self.meterTicker == nil else { return }
                self.startMetering()
                print("[WatchRecorder] foregrounded — metering resumed")
            }
        }
    }

    // MARK: - Permission

    func requestPermissionIfNeeded() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return true
        case .denied:
            permissionDenied = true
            return false
        case .undetermined:
            let granted = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
                AVAudioApplication.requestRecordPermission { ok in
                    continuation.resume(returning: ok)
                }
            }
            permissionDenied = !granted
            return granted
        @unknown default:
            return false
        }
    }

    // MARK: - Start / stop

    func toggle() {
        if isCapturing {
            stop()
        } else {
            Task { await start() }
        }
    }

    func start() async {
        guard !isCapturing else { return }
        guard await requestPermissionIfNeeded() else {
            print("[WatchRecorder] microphone permission denied")
            return
        }
        wasInterrupted = false

        let session = UUID()
        let id = UUID()
        let url = Self.chunkURL(for: id)

        do {
            let audioSession = AVAudioSession.sharedInstance()
            // .record for the whole recording; UIBackgroundModes = audio keeps it alive
            // when the app is no longer frontmost (wrist down / another app launched).
            // Rotation deliberately does NOT touch this session — it stays active
            // from the first chunk to the last, so no boundary costs a session
            // teardown/setup.
            try audioSession.setCategory(.record, mode: .default, options: [])
            try audioSession.setActive(true, options: [])

            let rec = try Self.makeRecorder(url: url)
            rec.delegate = self
            guard rec.record() else {
                print("[WatchRecorder] AVAudioRecorder.record() returned false")
                try? audioSession.setActive(false, options: [.notifyOthersOnDeactivation])
                return
            }

            recorder = rec
            sessionID = session
            currentID = id
            currentURL = url
            chunkIndex = 0
            chunkStartOffset = 0
            closedChunkDuration = 0
            let now = Date()
            startedAt = now
            sessionStartedAt = now
            segmentStartedAt = now
            accumulated = 0
            elapsed = 0
            level = 0
            // Resolved once, at start: the meeting that was on the calendar when
            // the user hit record is the meeting this audio belongs to, even if
            // the recording runs past the end of its window. Every chunk carries
            // it.
            meetingTitle = WatchSync.shared.meetingTitle(at: now)
            // Resolved once, at start, for the same reason as the meeting title:
            // this recording belongs to the workspace that was selected when the
            // user hit record. The idle selector is not reachable while
            // recording, but a push from the phone could still change the list
            // mid-session.
            sessionWorkspaceId = WatchSync.shared.effectiveWorkspaceId
            state = .recording(since: now)
            WKInterfaceDevice.current().play(.start)
            startTicking()
            startMetering()
            scheduleRotation()
            print("[WatchRecorder] started session \(session) chunk 0 \(id) -> \(url.lastPathComponent) title=\"\(displayTitle)\"\(meetingTitle == nil ? " (fallback)" : "") workspace=\(sessionWorkspaceId?.uuidString ?? "—") chunkDuration=\(String(format: "%.0f", Self.chunkDuration))s")
        } catch {
            print("[WatchRecorder] start failed: \(error)")
            try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        }
    }

    // MARK: - Pause / resume

    /// Pauses the file without tearing the session down. `AVAudioRecorder.pause()`
    /// keeps the file open and `record()` appends to it, so the chunk stays one
    /// continuous `.m4a` — which is why the audio session stays ACTIVE here:
    /// deactivating it would end the recording and break background survival.
    ///
    /// The rotation timer is cancelled here and rebuilt on resume from RECORDED
    /// time, so a pause never advances the chunk clock and resuming never rotates
    /// as though it had.
    func pause() {
        guard isRecording, let rec = recorder else { return }
        rec.pause()
        cancelRotation()
        // Bank the segment that just ended; elapsed freezes at this value until
        // resume, so paused wall time never reaches the duration.
        if let segmentStart = segmentStartedAt {
            accumulated += Date().timeIntervalSince(segmentStart)
        }
        segmentStartedAt = nil
        elapsed = accumulated
        stopTicking()
        stopMetering()
        level = 0
        state = .paused(since: Date())
        WKInterfaceDevice.current().play(.click)
        print("[WatchRecorder] paused at \(String(format: "%.1f", accumulated))s (chunk \(chunkIndex) has \(String(format: "%.1f", accumulated - chunkStartOffset))s of \(String(format: "%.0f", Self.chunkDuration))s)")
    }

    func resume() {
        guard isPaused, let rec = recorder else { return }
        guard rec.record() else {
            print("[WatchRecorder] resume failed — record() returned false; finalizing what we have")
            wasInterrupted = true
            stop()
            return
        }
        segmentStartedAt = Date()
        state = .recording(since: sessionStartedAt ?? Date())
        WKInterfaceDevice.current().play(.click)
        startTicking()
        startMetering()
        scheduleRotation()
        print("[WatchRecorder] resumed from \(String(format: "%.1f", accumulated))s — chunk \(chunkIndex) has \(String(format: "%.1f", Self.chunkDuration - (accumulated - chunkStartOffset)))s left")
    }

    func togglePause() {
        if isRecording { pause() } else if isPaused { resume() }
    }

    func stop() {
        guard isCapturing, let rec = recorder else { return }

        cancelRotation()

        // ⚠️ READ `currentTime` BEFORE `stop()` AND BEFORE ANY EARLY RETURN.
        // It returns 0 once the recorder is not recording — which an interruption
        // may ALREADY have caused — so the old `max(rec.currentTime, wallClock)`
        // silently selected wall-clock time and reported a 12:34 recording for
        // 2:10 of audio. Wall clock is now only the last resort.
        let recorderTime = rec.currentTime
        rec.stop()
        recorder = nil
        stopTicking()
        stopMetering()
        level = 0

        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        WKInterfaceDevice.current().play(.stop)

        // The last chunk is the FINAL one, and it is the chunk that tells the
        // phone how many to expect. A recording shorter than one chunk lands here
        // on its first pass: index 0, final, totalChunks 1 — the same code path.
        let total = chunkIndex + 1
        let entry = closeCurrentChunk(isFinal: true, totalChunks: total, recorderTime: recorderTime)

        let reachable = WatchSync.shared.isReachable
        state = .stopped(sentToPhone: reachable)
        if let entry {
            print("[WatchRecorder] stopped session \(entry.sessionId) — \(total) chunk(s), audio \(String(format: "%.1f", closedChunkDuration))s vs recorded \(String(format: "%.1f", recordedTime))s reachable=\(reachable)")
        }

        RecordingQueue.shared.flush()

        sessionID = nil
        sessionStartedAt = nil
        currentID = nil
        currentURL = nil
        startedAt = nil
        segmentStartedAt = nil
        accumulated = 0
        chunkIndex = 0
        chunkStartOffset = 0

        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard let self else { return }
            if case .stopped = self.state {
                self.state = .idle
                self.elapsed = 0
                self.refreshPendingCount()
            }
        }
    }

    // MARK: - Rotation

    private static func chunkURL(for id: UUID) -> URL {
        RecordingQueue.recordingsDirectory.appendingPathComponent("\(id.uuidString).m4a")
    }

    private static func makeRecorder(url: URL) throws -> AVAudioRecorder {
        let rec = try AVAudioRecorder(url: url, settings: recordingSettings)
        // Metering must be enabled BEFORE record(); averagePower returns
        // -160 forever otherwise and the level meter sits flat at the floor.
        rec.isMeteringEnabled = true
        return rec
    }

    /// Arms the next rotation for the RECORDED time still owed by the current
    /// chunk. Rebuilt from scratch on every resume, so pauses are invisible to it.
    ///
    /// `in:` overrides that with an explicit delay, which is only used to back off
    /// after a failed rotation — computing "time owed" there would be negative and
    /// would spin.
    private func scheduleRotation(in explicitDelay: TimeInterval? = nil) {
        cancelRotation()
        guard isRecording else { return }
        let remaining = explicitDelay ?? max(0, Self.chunkDuration - (recordedTime - chunkStartOffset))
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.rotate() }
        }
        rotationWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + remaining, execute: work)
    }

    private func cancelRotation() {
        rotationWork?.cancel()
        rotationWork = nil
    }

    /// Close the current chunk and continue recording into the next one.
    ///
    /// The order is the whole trick: the NEXT recorder is built and
    /// `prepareToRecord()`-ed — file created, encoder configured, buffers
    /// allocated — BEFORE the current one is stopped, so the only thing between
    /// the last sample of chunk N and the first of chunk N+1 is
    /// `stop()` + `record()`. The audio session is never deactivated.
    private func rotate() {
        rotationWork = nil
        guard isRecording, let current = recorder, sessionID != nil else { return }

        let nextID = UUID()
        let nextURL = Self.chunkURL(for: nextID)

        // Everything expensive happens while the current recorder is still
        // capturing: allocation, file creation, encoder setup.
        guard let next = try? Self.makeRecorder(url: nextURL), next.prepareToRecord() else {
            print("[WatchRecorder] rotation: could not prepare the next chunk — continuing in the current file")
            // Recording is unharmed and the chunk simply runs long. Back off a
            // full interval rather than spinning on a failing allocation, and do
            // NOT move `chunkStartOffset` — this chunk's audio still begins where
            // it began.
            scheduleRotation(in: Self.chunkDuration)
            return
        }
        next.delegate = self

        let recorderTime = current.currentTime

        // ── The boundary. Nothing may go between these two calls. ──
        let mark = CFAbsoluteTimeGetCurrent()
        current.stop()
        let stopped = CFAbsoluteTimeGetCurrent()
        let started = next.record()
        let resumed = CFAbsoluteTimeGetCurrent()
        // ───────────────────────────────────────────────────────────

        // Read the session clock HERE, at the boundary — not after the enqueue
        // and the WCSession hand-off below, which would fold their few
        // milliseconds into the next chunk's declared start offset.
        let boundaryRecordedTime = recordedTime

        guard started else {
            // The old file is closed and the new one will not start: finish the
            // session here rather than pretending to still be recording. The
            // closed chunks are already safe.
            print("[WatchRecorder] rotation: record() on the next chunk returned false — finalizing the session")
            recorder = current
            wasInterrupted = true
            stop()
            return
        }

        recorder = next
        let closed = closeCurrentChunk(isFinal: false, totalChunks: nil, recorderTime: recorderTime)

        chunkIndex += 1
        chunkStartOffset = boundaryRecordedTime
        currentID = nextID
        currentURL = nextURL
        startedAt = Date()

        let stopMs = (stopped - mark) * 1000
        let startMs = (resumed - stopped) * 1000
        print(String(format: "[WatchRecorder] ROTATION gap: stop %.1f ms + record %.1f ms = %.1f ms (chunk %d -> %d)",
                     stopMs, startMs, stopMs + startMs, chunkIndex - 1, chunkIndex))
        if let closed {
            // Audio actually written so far vs recorded time so far. This is the
            // honest cumulative drift, and it is NOT all rotation: resuming an
            // `AVAudioRecorder` after a pause drops a fraction of a second too,
            // and that lands in the same number.
            let drift = chunkStartOffset - closedChunkDuration
            print(String(format: "[WatchRecorder] rotated to chunk %d (%@) — closed chunk %d %.2fs, session audio %.2fs vs recorded %.2fs, drift %.0f ms (boundaries + pause resumes)",
                         chunkIndex, nextURL.lastPathComponent, closed.chunkIndex,
                         closed.durationSeconds, closedChunkDuration, chunkStartOffset, drift * 1000))
        }

        scheduleRotation()
    }

    /// Bank the chunk that just closed: read its real length, queue it, and hand
    /// it to WCSession immediately. Called from `rotate()` while the microphone
    /// is already recording the next chunk, and from `stop()` for the last one.
    @discardableResult
    private func closeCurrentChunk(isFinal: Bool, totalChunks: Int?, recorderTime: TimeInterval) -> QueuedRecording? {
        guard let id = currentID, let url = currentURL,
              let started = startedAt, let sessionID, let sessionStart = sessionStartedAt else { return nil }

        // Recorded time inside THIS chunk, excluding every pause: the last-resort
        // fallback, because a chunk paused for five minutes has five minutes less
        // audio in it.
        let chunkRecordedTime = max(0, recordedTime - chunkStartOffset)

        // The written file is the authority: it is exactly the audio that exists,
        // whatever the session did while we were not looking. Fall back to the
        // recorder's own clock, then to the recorded (un-paused) time.
        let fileDuration = Self.durationOfFile(at: url)
        let duration = fileDuration ?? (recorderTime > 0 ? recorderTime : chunkRecordedTime)
        if let fileDuration, abs(fileDuration - chunkRecordedTime) > 2 {
            print("[WatchRecorder] chunk \(chunkIndex) duration from file \(String(format: "%.1f", fileDuration))s vs recorded \(String(format: "%.1f", chunkRecordedTime))s — recording was cut short")
        }
        closedChunkDuration += duration

        let entry = QueuedRecording(id: id,
                                    relativePath: url.lastPathComponent,
                                    startedAt: started,
                                    durationSeconds: duration,
                                    title: displayTitle,
                                    hasMeetingTitle: meetingTitle != nil,
                                    workspaceId: sessionWorkspaceId,
                                    sessionId: sessionID,
                                    chunkIndex: chunkIndex,
                                    isFinal: isFinal,
                                    totalChunks: totalChunks,
                                    sessionStartedAt: sessionStart,
                                    chunkStartOffset: chunkStartOffset)
        RecordingQueue.shared.enqueue(entry)
        refreshPendingCount()
        // The point of chunking: this file leaves for the phone now, while the
        // meeting is still being recorded. `flush()` also retries anything an
        // earlier boundary failed to hand over; WatchSync dedupes per chunk id.
        RecordingQueue.shared.flush()
        return entry
    }

    // MARK: - Timer

    private func startTicking() {
        ticker = Timer.publish(every: 1.0, on: .main, in: .common)
            .autoconnect()
            .sink { [weak self] _ in
                guard let self, let segmentStart = self.segmentStartedAt else { return }
                self.elapsed = self.accumulated + Date().timeIntervalSince(segmentStart)
                // Belt and braces: if the one-shot rotation timer were ever
                // dropped (a missed run-loop wake-up on a sleeping wrist), the
                // second-tick still catches the boundary rather than letting one
                // file grow without bound.
                if self.rotationWork == nil, self.elapsed - self.chunkStartOffset >= Self.chunkDuration {
                    print("[WatchRecorder] rotation timer was missed — rotating from the tick")
                    self.rotate()
                }
            }
    }

    private func stopTicking() {
        ticker?.cancel()
        ticker = nil
    }

    // MARK: - Metering

    /// ~10 Hz is fast enough to read as "live" and slow enough not to matter for
    /// battery. It runs ONLY while recording AND visible: `stopMetering()` on
    /// pause, on stop, and on backgrounding (see `observeVisibility()`).
    ///
    /// It reads `self.recorder` every tick rather than capturing one, so it keeps
    /// metering the LIVE recorder straight through a rotation.
    private func startMetering() {
        meterTicker = Timer.publish(every: 0.1, on: .main, in: .common)
            .autoconnect()
            .sink { [weak self] _ in
                guard let self, let rec = self.recorder, rec.isRecording else { return }
                rec.updateMeters()
                let db = Double(rec.averagePower(forChannel: 0))
                self.level = Self.normalize(db)
                #if DEBUG
                // Every ~2s, so a silent simulator mic is distinguishable from a
                // meter that was never wired up.
                self.meterTickCount += 1
                if self.meterTickCount % 20 == 0 {
                    print("[WatchRecorder] level db=\(String(format: "%.1f", db)) normalized=\(String(format: "%.3f", self.level))")
                }
                #endif
            }
    }

    private func stopMetering() {
        meterTicker?.cancel()
        meterTicker = nil
    }

    /// dBFS (−160…0) → 0…1. Speech on the watch mic lives roughly between −45 dB
    /// and −10 dB, so the floor is clamped at −50 rather than −160: mapping the
    /// full range would leave normal talking pinned in the bottom tenth of the
    /// meter. The curve is then eased so quiet speech still visibly moves bars.
    static func normalize(_ db: Double) -> Double {
        let floorDb: Double = -50
        guard db.isFinite else { return 0 }
        let clamped = min(0, max(floorDb, db))
        let linear = (clamped - floorDb) / (0 - floorDb)   // 0…1
        return pow(linear, 0.6)
    }

    /// H:MM:SS — hours always shown, so the layout never reflows from 59:59 to
    /// 1:00:00 mid-meeting.
    static func format(_ interval: TimeInterval) -> String {
        let total = Int(max(0, interval))
        return String(format: "%d:%02d:%02d", total / 3600, (total % 3600) / 60, total % 60)
    }

    /// The real length of the audio that was written, read back from the file.
    /// `AVAudioFile` is synchronous and cheap here (a header read, no decode),
    /// which matters because neither `stop()` nor the rotation boundary may
    /// become async.
    private static func durationOfFile(at url: URL) -> TimeInterval? {
        guard let file = try? AVAudioFile(forReading: url) else { return nil }
        let rate = file.fileFormat.sampleRate
        guard rate > 0, file.length > 0 else { return nil }
        return Double(file.length) / rate
    }
}

extension WatchRecorder: AVAudioRecorderDelegate {
    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        print("[WatchRecorder] didFinishRecording success=\(flag)")
    }

    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        print("[WatchRecorder] encode error: \(error?.localizedDescription ?? "unknown")")
    }
}
