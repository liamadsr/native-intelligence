//
//  WatchCaptureIngestService.swift
//  dial8
//
//  Turns a finished Watch recording into a Native Intelligence capture.
//
//  A RECORDING IS A SESSION OF CHUNKS
//  ----------------------------------
//  The watch rotates its recorder every 15 minutes of recorded time and hands
//  each closed chunk to WCSession the moment it closes, while the meeting is
//  still running. So a one-hour meeting reaches this service as four separate
//  files, possibly out of order, possibly minutes apart, possibly straddling an
//  app relaunch. `WatchCaptureSession` (in WatchConnectivityService.swift) is
//  the grouping; everything here is written in terms of it.
//
//  THE TWO PHASES, AND WHY THEY ARE SEPARATE
//  -----------------------------------------
//  1. TRANSCRIBE EACH CHUNK AS IT LANDS. On-device, local-only, invisible: no
//     network, no server row, nothing the user or the backend can observe. It
//     spreads an hour of analysis across the hour it was recorded in, so the
//     final step is a few HTTP calls rather than a multi-minute job that has to
//     survive an iOS background window. Each chunk's text is persisted next to
//     its audio (`<recordingId>.txt`), so a relaunch never re-analyses it.
//
//  2. WHEN — AND ONLY WHEN — THE SESSION IS COMPLETE, DO THE SERVER WORK ONCE.
//     No capture row, no append, no endCapture, no batch extraction, no
//     generate-title may happen while chunks are still arriving. That is an
//     explicit product requirement, so it is enforced STRUCTURALLY rather than
//     by discipline: every one of those calls lives inside `finalizeSession`,
//     which takes a `FinalizableWatchSession` — a type whose initializer is
//     `fileprivate` to WatchConnectivityService.swift and can therefore only be
//     produced by `WatchCaptureSession.finalizable(now:)`, which is where the
//     completeness rule lives. This file cannot manufacture one.
//
//     (`grep -n "CaptureAPIService" WatchCaptureIngestService.swift` should only
//     ever hit `finalizeSession` and `finalizeEmpty`. `recordSessionFailure`
//     ends a given-up capture THROUGH `finalizeEmpty` for exactly that reason.)
//
//  COMPLETE means: the chunk marked `isFinal` has arrived AND every index
//  0..<totalChunks is present. A session that never completes is not allowed to
//  hang forever either — see BOUNDED WAITS below.
//
//  HOW A CHUNK IS TRANSCRIBED
//  --------------------------
//  Not through the live path. `AppleSpeechLiveTranscriber` is tuned for real
//  speech cadence: replaying a finished file through it means either firehosing
//  the analyzer or pacing it at real time, which makes a 45-minute meeting take
//  45 minutes to ingest and requires the phone app to stay open for it.
//
//  `AppleSpeechFileTranscriber` exists for exactly this shape of work: hand
//  `SpeechAnalyzer` the whole `AVAudioFile` and it reads it as fast as the
//  device allows, emitting final results only.
//
//  Everything is on-device: no upload, no API key, no TTL, no per-minute cost,
//  and the audio never leaves the phone.
//
//  READINESS GATING
//  ----------------
//  The on-device model is the only transcriber there is, so PHASE 1 is gated on
//  `SpeechModelManager`:
//
//    .ready                          → transcribe now
//    .checking / .downloading        → LEAVE THE CHUNKS PENDING. Nothing is
//                                      attempted, no attempt is burned, and the
//                                      queue re-drains automatically the moment
//                                      the manager publishes .ready.
//    .unsupportedDevice / Language   → recordChunkFailure with the manager's own
//                                      user-facing sentence.
//
//  Burning attempts against a model that is merely still downloading would use
//  up all three on a first launch over cellular and strand a real recording.
//
//  PHASE 2 is NOT gated on the model: a session whose chunks were all
//  transcribed hours ago must still be able to finish while the model happens to
//  be re-checking itself.
//
//  BOUNDED WAITS
//  -------------
//  Two ways a session can stop arriving, both bounded (`WatchSessionGrace`):
//
//    • the final chunk is here but a middle one never came → after 10 minutes,
//      assemble what we have and log the gap; the transcript misses that span.
//    • no final chunk ever came (the watch died, was unpaired, ran out of
//      battery) → after 45 minutes with no new chunk, finish with what is on
//      disk.
//
//    • a chunk never transcribes because the on-device model never becomes
//      ready (`.failed` asset download, a `.checking` that never settles) → the
//      model gate burns no attempts by design, so a third wait bounds IT: past
//      a complete session's stall cap, a session with no transcript at all
//      burns an attempt per pass until it settles into a visible `.failed`,
//      and a session that has SOME text finalizes with what it has.
//
//  ⚠️ EVERY ONE OF THOSE WAITS NEEDS A TIMER, because a drain only runs when
//  something wakes it — and once the chunks stop arriving, nothing does. The
//  app being foregrounded is not a mechanism; it is a user habit. So:
//
//    • a drain that leaves ANY live session on disk arms exactly one wake-up,
//      for the earliest thing that session is waiting on (`wakeDeadline`),
//      never nil while the session is live;
//    • a wake-up that arrives while a drain is already running is remembered
//      (`needsRedrain`) and re-entered at the end instead of being swallowed —
//      out of range, WCSession delivers a whole meeting within seconds and
//      every chunk after the first posts into a drain already in flight;
//    • phase 1 re-reads the queue each time round, so a chunk that lands
//      mid-drain is picked up by the drain already running.
//
//  NO DIARIZATION. SpeechTranscriber does not diarize, so a watch transcript is
//  a single mic channel, labelled exactly like the live iOS path. The
//  `TranscriptLine`/`stitch` pair keeps the speaker plumbing so a diarizing
//  backend could slot back in without reshaping the output.
//

import Foundation
import AVFoundation
import CoreMedia
import Combine
import UIKit

@MainActor
final class WatchCaptureIngestService: ObservableObject {
    static let shared = WatchCaptureIngestService()

    // MARK: - State

    enum State: Equatable {
        case idle
        /// Chunks are still arriving for at least one recording. NOTHING exists
        /// server-side yet and nothing will until the session completes.
        case syncing(Int)
        case transcribing
        case finalizing
        case failed(String)
    }

    @Published private(set) var state: State = .idle

    /// True while any watch recording is mid-flight — i.e. whether the Home row
    /// should show a spinner.
    var isBusy: Bool {
        switch state {
        case .syncing, .transcribing, .finalizing: return true
        case .idle, .failed: return false
        }
    }

    /// A recording nothing will be tried on again. Surfaced on Home rather than
    /// only in the log: a give-up that no screen ever shows is indistinguishable
    /// from a recording that quietly vanished.
    var isFailed: Bool {
        if case .failed = state { return true }
        return false
    }

    /// The Home row's copy. `syncing` is deliberately distinct from processing:
    /// while chunks are landing there is nothing to process yet, and telling the
    /// user we are "processing" a meeting that is still being recorded would be
    /// a lie that lasts the length of the meeting.
    var statusText: String? {
        switch state {
        case .idle:
            return nil
        case .syncing(let count):
            return count > 1
                ? "\(count) Watch recordings syncing…"
                : "Watch recording syncing…"
        case .transcribing, .finalizing:
            return "Processing a Watch recording…"
        case .failed(let message):
            return message
        }
    }

    /// Give up on a chunk after this many failed attempts, so a permanently-bad
    /// recording can't spin forever on every foreground.
    /// `PendingWatchCaptures.isTranscribable` enforces it for phase 1 and
    /// `WatchCaptureSession.isExhausted` for phase 2; this is the same constant
    /// so the logs and the filters can't drift apart.
    static var maxAttempts: Int { PendingWatchCaptures.maxAttempts }

    /// Serializes the queue — the notification, the timer and the foreground
    /// observer can fire together, and two finalizes of one session would create
    /// two captures.
    private var isDraining = false

    /// A wake-up that arrived while a drain was running. ⚠️ NOT COSMETIC: when
    /// the watch comes back into range WCSession delivers a whole meeting's
    /// chunks within seconds, so chunk 0 starts the drain and chunks 1..n all
    /// post into it. Swallowing those left a session complete but untranscribed,
    /// with nothing scheduled to look at it again.
    private var needsRedrain = false

    /// When this process started caring about watch sessions. For
    /// `WatchSessionGrace.activationSettle` after it, an ALREADY-EXPIRED
    /// `noFinalChunk` deadline is not honoured: the transfers the system queued
    /// while the phone was off are redelivered within seconds of activation, and
    /// finalizing a session in a race against its own remaining chunks is how one
    /// meeting becomes two captures.
    private let launchedAt = Date()

    /// The single scheduled wake-up for the earliest bounded-wait deadline.
    private var stuckSessionWake: DispatchWorkItem?

    /// Live subscription to the on-device model's readiness. Chunks parked
    /// behind `.checking`/`.downloading` have no other wake-up: the files
    /// already arrived, so `.watchCaptureFileReceived` won't fire again, and
    /// without this they would sit there until the next foreground.
    private var modelReadinessObserver: AnyCancellable?

    private init() {
        NotificationCenter.default.addObserver(
            forName: .watchCaptureFileReceived,
            object: nil,
            queue: .main
        ) { _ in
            MainActor.assumeIsolated { WatchCaptureIngestService.shared.drain() }
        }

        NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification,
            object: nil,
            queue: .main
        ) { _ in
            MainActor.assumeIsolated { WatchCaptureIngestService.shared.drain() }
        }

        // SpeechModelManager publishes on every state change (including the 4 Hz
        // download-progress ticks), so re-check readiness rather than reacting to
        // the change itself; `drain()` is cheap and re-entrancy-guarded.
        //
        // Re-drain on ANY settled verdict, not just .ready. A device that resolves
        // to .unsupportedDevice must also wake the queue — otherwise chunks parked
        // by the first drain's `.checking` sit there invisibly instead of settling
        // into the `.failed` state Home shows.
        modelReadinessObserver = SpeechModelManager.shared.objectWillChange
            // objectWillChange fires BEFORE the property changes, so read the
            // state on the next main-queue turn or it is still the old one.
            .receive(on: DispatchQueue.main)
            .sink { _ in
                MainActor.assumeIsolated {
                    let service = WatchCaptureIngestService.shared
                    guard case .pending = service.modelReadiness() else {
                        service.drain()
                        return
                    }
                    // Still checking or downloading — nothing to do yet.
                }
            }
    }

    /// Called at launch so a backlog that arrived while the app was dead is
    /// worked without waiting for a background→foreground round trip.
    func start() {
        // Surface an already-exhausted backlog even if drain() finds nothing to do.
        settleState()
        drain()
    }

    // MARK: - Queue

    func drain() {
        guard !isDraining else {
            // Remember it instead of dropping it — see `needsRedrain`.
            needsRedrain = true
            return
        }

        // Files of a session already turned into a capture (a crash between the
        // tombstone and the removal, or a chunk that slipped in mid-finalize).
        // Cleared BEFORE anything enumerates them, so the same recording can
        // never be finalized twice.
        sweepFinalizedSessions()

        let sessions = PendingWatchCaptures.shared.sessions()
        guard !sessions.isEmpty else {
            settleState()
            return
        }

        // A live phone recording owns the mic, the on-device analyzer and the
        // "Processing…" state on Home. Defer — but ARM THE TIMER on the way out:
        // nothing posts a notification when the live recording ends, and the app
        // is already foreground so `willEnterForeground` won't fire either.
        guard !iOSRecordingService.shared.hasActiveSession else {
            print("⏸️ [WatchIngest] Live recording in progress — deferring \(sessions.count) watch session(s)")
            settleState()
            scheduleStuckSessionWake()
            return
        }

        isDraining = true
        Task { @MainActor in
            defer {
                isDraining = false
                if needsRedrain {
                    needsRedrain = false
                    // Safe to re-enter: `isDraining` is already false, and the
                    // new drain only schedules a Task before returning.
                    drain()
                }
            }

            // ── PHASE 1: transcribe every chunk that is owed it ──────────────
            // Local-only. No server call is reachable from here.
            await transcribePendingChunks()

            // ── PHASE 2: finish the sessions that are allowed to finish ──────
            // Re-read from disk: phase 1 just changed the sidecars, and a chunk
            // may have arrived while it ran.
            for session in PendingWatchCaptures.shared.sessions() {
                guard !iOSRecordingService.shared.hasActiveSession else {
                    print("⏸️ [WatchIngest] Live recording started mid-drain — stopping")
                    break
                }
                // ⚠️ THE ONLY PATH TO SERVER WORK. `finalizable` returns nil for
                // a session that is still arriving (unless a bounded wait has
                // expired), and its result type cannot be built any other way.
                guard let finalizable = session.finalizable(now: Date()) else { continue }
                // A session whose FINAL chunk never arrived may still have one
                // in flight — the sender is the part we stopped hearing from.
                // Right after launch that is the normal case, not a dead watch:
                // WCSession is redelivering what it queued while the phone was
                // off. Finishing here would summarise a meeting that is still
                // being recorded and make the rest of it a second capture.
                if !finalizable.sawFinalChunk {
                    let sinceLaunch = Date().timeIntervalSince(launchedAt)
                    guard sinceLaunch >= WatchSessionGrace.activationSettle else {
                        print("⏳ [WatchIngest] session \(session.sessionId.uuidString.prefix(8))… has no final chunk and we launched \(Int(sinceLaunch))s ago — letting queued transfers land before giving up on the sender")
                        continue
                    }
                }
                await finalizeSession(finalizable)
            }

            // ── Bound the wait on the MODEL, which no deadline above covers ──
            await failStalledSessions()

            // Settle the resting state from DISK, not from whatever the last
            // step happened to leave behind. A `.failed` set inside a failure
            // path is otherwise erased by the very next drain (which sets
            // `.transcribing` before anyone can read it), so the give-up was
            // invisible.
            settleState()
            scheduleStuckSessionWake()
        }
    }

    /// Leftovers of a session that has ALREADY become a capture. Normally there
    /// are none — `removeSession` clears them — but a crash between the tombstone
    /// and the removal, or a chunk that landed while finalize was on the network,
    /// leaves files behind that carry the finalized session's `captureId`. Left
    /// alone they wait out `noFinalChunk` and re-enter finalize on that same
    /// capture: `endCapture` would overwrite its duration with one chunk's
    /// length and a SECOND batch extraction would run over it.
    private func sweepFinalizedSessions() {
        let store = PendingWatchCaptures.shared
        let tombstones = store.finalizedSessions()
        guard !tombstones.isEmpty else { return }
        for session in store.sessions() {
            guard let tombstone = tombstones[session.sessionId] else { continue }
            print("🪦 [WatchIngest] session \(session.sessionId.uuidString.prefix(8))… is already capture \(tombstone.captureId?.uuidString.prefix(8).description ?? "—")… — clearing \(session.chunks.count) leftover chunk(s)")
            discardChunks(session.chunks, of: session.sessionId)
        }
    }

    /// The third bounded wait. `.pending` model readiness burns no attempt BY
    /// DESIGN — that is what stops a first launch over cellular from eating a
    /// real recording's budget — but it also means `transcribable` can stay
    /// non-empty for ever behind a `SpeechModelManager` wedged in `.failed` or
    /// `.checking`, and a session with NO transcript at all is not finalizable at
    /// any deadline. Past its deadline, burn one attempt per pass so it reaches
    /// the visible `.failed` state instead of reading "syncing…" indefinitely.
    ///
    /// A session that has SOME text needs none of this: `finalizable` finishes it
    /// with the chunks that did transcribe once the deadline passes.
    private func failStalledSessions() async {
        let now = Date()
        for session in PendingWatchCaptures.shared.sessions() {
            guard !session.isExhausted,
                  now >= session.graceDeadline,
                  !session.chunks.contains(where: { $0.transcribed }),
                  !session.transcribable.isEmpty
            else { continue }
            let overdue = Int(now.timeIntervalSince(session.graceDeadline).rounded())
            print("⌛️ [WatchIngest] session \(session.sessionId.uuidString.prefix(8))… has no transcript \(overdue)s past its deadline — burning an attempt so it can settle")
            for chunk in session.transcribable {
                guard let fresh = PendingWatchCaptures.shared.read(chunk.recordingId) else { continue }
                await recordChunkFailure(fresh, reason: "on-device transcription never became available")
            }
        }
    }

    /// Phase 1. Every chunk still owed on-device transcription, gated once per
    /// drain on the model — per-chunk would say the same thing N times and, for
    /// a download in flight, burn N attempts on it.
    private func transcribePendingChunks() async {
        let owed = PendingWatchCaptures.shared.pending()
        guard !owed.isEmpty else { return }

        let locale: Locale
        switch modelReadiness() {
        case .ready(let resolved):
            locale = resolved
        case .pending(let why):
            // Not a failure: no attempt is burned and nothing is written. The
            // objectWillChange subscription re-drains on .ready.
            print("⏳ [WatchIngest] \(why) — leaving \(owed.count) watch chunk(s) untranscribed")
            Task { await SpeechModelManager.shared.prewarm() }
            return
        case .impossible(let message):
            // The model will never become ready on this device/for this
            // language. Burn the attempts so the queue settles into a visible
            // .failed state instead of silently retrying forever.
            print("⛔️ [WatchIngest] \(message) — failing \(owed.count) watch chunk(s)")
            for chunk in owed {
                guard let fresh = PendingWatchCaptures.shared.read(chunk.recordingId) else { continue }
                await recordChunkFailure(fresh, reason: message)
            }
            return
        }

        // ⚠️ RE-READ THE QUEUE EACH TIME ROUND rather than working through the
        // `owed` snapshot. Analysing a 15-minute chunk takes a while, and when
        // the watch comes back into range the rest of the meeting lands during
        // it — those chunks' notifications hit a drain already in flight, so
        // this loop is their only chance to be picked up before the next wake.
        // `handled` keeps the old one-attempt-per-drain bound.
        var handled = Set<UUID>()
        while true {
            guard !iOSRecordingService.shared.hasActiveSession else {
                print("⏸️ [WatchIngest] Live recording started mid-transcribe — stopping")
                return
            }
            guard let next = PendingWatchCaptures.shared.pending()
                .first(where: { !handled.contains($0.recordingId) })
            else { break }
            handled.insert(next.recordingId)
            // Re-read: the sidecar may have been rewritten earlier in this drain.
            guard let fresh = PendingWatchCaptures.shared.read(next.recordingId),
                  PendingWatchCaptures.isTranscribable(fresh)
            else { continue }
            // Recomputed per chunk: a burst arrival can complete the session
            // half way through this very loop.
            let sessionIsComplete = PendingWatchCaptures.shared.sessions()
                .first { $0.sessionId == fresh.sessionId }?.isComplete ?? false
            await transcribeChunk(fresh, locale: locale, sessionIsComplete: sessionIsComplete)
        }
    }

    /// The resting state after a drain, derived from the sidecars so it survives
    /// relaunches and subsequent drains:
    ///
    ///   • a session nothing more will be tried on  → `.failed`
    ///   • a session still receiving chunks         → `.syncing`
    ///   • a complete session still on disk         → `.transcribing` (it is
    ///     mid-flight or waiting on the model; either way it is "processing")
    ///   • nothing on disk                          → `.idle`
    private func settleState() {
        let sessions = PendingWatchCaptures.shared.sessions()

        let stuck = sessions.filter(\.isExhausted)
        if !stuck.isEmpty {
            let plural = stuck.count == 1 ? "recording" : "recordings"
            state = .failed("\(stuck.count) Watch \(plural) couldn't be processed")
            return
        }

        let live = sessions.filter { !$0.isExhausted }
        guard !live.isEmpty else {
            state = .idle
            return
        }

        let arriving = live.filter { !$0.isComplete }
        if arriving.count == live.count {
            state = .syncing(arriving.count)
        } else {
            // At least one session is complete and therefore genuinely being
            // processed; that is the more informative thing to say.
            state = .transcribing
        }
    }

    /// A drain that leaves a session waiting on a bounded deadline schedules the
    /// one wake-up that will make that deadline real. Without it the timeout is
    /// theoretical: nothing else fires once the chunks stop arriving.
    private func scheduleStuckSessionWake() {
        stuckSessionWake?.cancel()
        stuckSessionWake = nil

        let now = Date()
        // ⚠️ EVERY LIVE SESSION, NOT JUST THE ONES STILL ARRIVING. A COMPLETE
        // session gets a timer too: it can be waiting on a chunk's transcription,
        // on a finalize backoff, or on the settling window after launch, and
        // none of those has any other wake-up — a settled device publishes no
        // SpeechModelManager change and no further chunk is coming. Leaving one
        // untimed is what made a whole meeting sit inert until the user next
        // foregrounded the app. `wakeDeadline` is non-nil for every live session.
        let deadlines = PendingWatchCaptures.shared.sessions()
            .compactMap { $0.wakeDeadline(now: now) }
        guard let next = deadlines.min() else { return }

        // Never zero or negative: an immediate re-drain would spin.
        let delay = max(next.timeIntervalSince(now), 1)

        let item = DispatchWorkItem {
            MainActor.assumeIsolated { WatchCaptureIngestService.shared.drain() }
        }
        stuckSessionWake = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
        print("⏲️ [WatchIngest] \(deadlines.count) live watch session(s) — next check in \(Int(delay.rounded()))s")
    }

    // MARK: - Model readiness

    /// What `SpeechModelManager`'s current state means for a queued chunk.
    private enum ModelReadiness {
        /// Transcribe now, with this locale.
        case ready(Locale)
        /// Will resolve on its own — keep the files, burn no attempt.
        case pending(String)
        /// Will never resolve here. The string is user-facing.
        case impossible(String)
    }

    private func modelReadiness() -> ModelReadiness {
        let manager = SpeechModelManager.shared
        switch manager.state {
        case .ready:
            // A locale is guaranteed alongside .ready, but never force it: a nil
            // here would otherwise crash the ingest of a real recording.
            guard let locale = manager.locale else {
                return .pending("on-device model ready but locale unresolved")
            }
            return .ready(locale)
        case .checking:
            return .pending("on-device model still being checked")
        case .downloading(let progress):
            let percent = Int((progress.fractionCompleted * 100).rounded())
            return .pending("on-device speech model downloading (\(percent)%)")
        case .failed(let message):
            // Transient by nature (usually no network for the asset download).
            // SpeechModelManager retries it on foreground, so keep the files.
            return .pending("on-device model unavailable: \(message)")
        case .unsupportedDevice, .unsupportedLanguage:
            return .impossible(manager.userFacingMessage ?? "On-device transcription is unavailable.")
        }
    }

    // MARK: - Phase 1: one chunk, on-device, local only

    /// ⚠️ NOTHING IN THIS FUNCTION OR ANYTHING IT CALLS MAY TOUCH THE SERVER.
    /// A chunk is transcribed the moment it lands, which is typically while the
    /// meeting is still being recorded — the whole point of the design is that
    /// the backend learns nothing about the recording until it is finished.
    private func transcribeChunk(_ record: PendingWatchCapture,
                                 locale: Locale,
                                 sessionIsComplete: Bool) async {
        let store = PendingWatchCaptures.shared
        let audioURL = store.audioURL(for: record.recordingId)
        let shortId = record.recordingId.uuidString.prefix(8)
        let shortSession = record.sessionId.uuidString.prefix(8)

        // A background flip mid-analysis (the user pockets the phone) otherwise
        // suspends us seconds into it. Same assertion pattern iOSRecordingService
        // uses for its post-capture batch.
        let backgroundTaskId = UIApplication.shared.beginBackgroundTask(withName: "dial8.watch.chunk") {
            print("⚠️ [WatchIngest] Background time expired transcribing chunk \(shortId)…")
        }
        defer {
            if backgroundTaskId != .invalid {
                UIApplication.shared.endBackgroundTask(backgroundTaskId)
            }
        }

        print("🎧 [WatchIngest] Transcribing session \(shortSession)… chunk \(record.chunkIndex) (\(shortId)…, \(String(format: "%.1f", record.durationSeconds))s at offset \(String(format: "%.1f", record.chunkStartOffset))s)")
        // ⚠️ ONLY A COMPLETE SESSION IS "PROCESSING". Phase 1 runs on each chunk
        // as it lands, which is normally WHILE THE MEETING IS STILL BEING
        // RECORDED — saying "Processing a Watch recording…" there would be a lie
        // for the length of the meeting, and nothing exists server-side yet
        // anyway. An incomplete session keeps the syncing copy (design point 11).
        if sessionIsComplete {
            state = .transcribing
        } else {
            settleState()
        }

        let transcript: String
        do {
            transcript = try await Self.transcribe(fileURL: audioURL, locale: locale)
        } catch {
            await recordChunkFailure(record, reason: "transcription failed: \(error.localizedDescription)")
            return
        }

        // Persist BEFORE marking the chunk done: a crash between the two costs
        // one re-analysis, the other order would lose the text silently.
        guard store.writeTranscript(transcript, for: record.recordingId) else {
            await recordChunkFailure(record, reason: "could not persist chunk transcript")
            return
        }
        guard var fresh = store.read(record.recordingId) else {
            print("⚠️ [WatchIngest] chunk \(shortId)… vanished mid-transcribe — nothing to mark")
            return
        }
        fresh.transcribed = true
        store.write(fresh)

        if transcript.isEmpty {
            // Silence is a legitimate, FINAL outcome — not a failure to retry.
            print("🤫 [WatchIngest] chunk \(record.chunkIndex) of \(shortSession)… produced no speech")
        } else {
            print("📝 [WatchIngest] chunk \(record.chunkIndex) of \(shortSession)…: \(transcript.unicodeScalars.count) chars")
        }
    }

    /// Keep the files, bump this chunk's attempt counter, surface `.failed` once
    /// we stop retrying it.
    private func recordChunkFailure(_ record: PendingWatchCapture, reason: String) async {
        var updated = record
        updated.attempts += 1
        PendingWatchCaptures.shared.write(updated)

        let shortId = record.recordingId.uuidString.prefix(8)
        if updated.attempts >= Self.maxAttempts {
            // The chunk stays on disk but nothing will transcribe it again. Its
            // session can still finish without it — as a gap — as long as some
            // other chunk produced text.
            print("❌ [WatchIngest] Giving up on chunk \(record.chunkIndex) (\(shortId)…) after \(updated.attempts) attempts — \(reason). Audio kept on disk; it will not be retried automatically.")
        } else {
            print("⚠️ [WatchIngest] Attempt \(updated.attempts)/\(Self.maxAttempts) failed for chunk \(record.chunkIndex) (\(shortId)…) — \(reason)")
        }
    }

    // MARK: - Phase 2: the session, once, on the server

    /// ⚠️ THE ONLY FUNCTION IN THIS FILE THAT TALKS TO THE BACKEND (with
    /// `finalizeEmpty`, which it calls). Reaching it requires a
    /// `FinalizableWatchSession`, which only `WatchCaptureSession.finalizable`
    /// can construct — see the file header.
    ///
    /// The sequence is the single-file one, unchanged, run ONCE for the whole
    /// recording: create → append → end → batch → title. The capture is
    /// indistinguishable downstream from one made out of a single file.
    private func finalizeSession(_ session: FinalizableWatchSession) async {
        let store = PendingWatchCaptures.shared
        let shortId = session.sessionId.uuidString.prefix(8)

        let backgroundTaskId = UIApplication.shared.beginBackgroundTask(withName: "dial8.watch.finalize") {
            print("⚠️ [WatchIngest] Background time expired finalizing session \(shortId)…")
        }
        defer {
            if backgroundTaskId != .invalid {
                UIApplication.shared.endBackgroundTask(backgroundTaskId)
            }
        }

        if !session.wasComplete {
            print("⏱️ [WatchIngest] session \(shortId)… never completed — finishing after the bounded wait with \(session.chunks.count) chunk(s)")
        }
        if !session.missingIndices.isEmpty {
            // Visible on purpose (design point 9): the transcript is missing the
            // span those chunks covered and nobody should have to guess why.
            print("🕳️ [WatchIngest] session \(shortId)… is missing chunk(s) \(session.missingIndices.map(String.init).joined(separator: ", ")) — the transcript skips that span")
        }
        if !session.untranscribedIndices.isEmpty {
            // The audio IS here; only its text is not. Same visible gap, but the
            // recording survives it — `discardChunks` keeps those `.m4a`s.
            print("🕳️ [WatchIngest] session \(shortId)… has chunk(s) \(session.untranscribedIndices.map(String.init).joined(separator: ", ")) with no transcript — the capture skips that span; their audio is KEPT on disk")
        }
        print("🏁 [WatchIngest] Finalizing session \(shortId)… — \(session.chunks.count) chunk(s), \(String(format: "%.1f", session.totalDuration))s total, started \(session.sessionStartedAt)")
        state = .finalizing

        // ⚠️ RESOLVED ONCE, THEN PASSED TO EVERY CALL BELOW. Not re-read per
        // request: the user can switch workspace on their phone at any moment
        // during the minutes this sequence takes, and a capture created in one
        // workspace whose transcript, end and extraction were aimed at another is
        // a half-written capture in the wrong place.
        let workspaceId = resolveWorkspace(for: session)

        // ── 1. The capture row ──────────────────────────────────────────────
        // Adopt an existing id from a crashed run rather than creating a second.
        let captureId: UUID
        if let existing = session.captureId {
            captureId = existing
            print("♻️ [WatchIngest] Resuming existing capture \(existing.uuidString.prefix(8))… for session \(shortId)…")
        } else {
            do {
                let created = try await CaptureAPIService.shared.createCapture(
                    id: UUID(),
                    // Normally the auto-title placeholder is load-bearing:
                    // generate-title only renames a capture whose title still
                    // matches the `Capture Mon D H:MM AM/PM` pattern, and any
                    // other string reads as user-chosen and is kept forever.
                    //
                    // That is exactly the property we want when the watch knew
                    // which meeting this was: the calendar name goes in here and
                    // step 6 skips generate-title, so "Design sync" survives
                    // instead of being replaced by an AI summary of itself.
                    title: provisionalTitle(for: session),
                    // When RECORDING started — identical on every chunk, so a
                    // lost chunk 0 doesn't move it. This is sent as the row's
                    // `started_at`; `recorded_at` — what Home orders by, and what
                    // its "Processing…" window is relative to — is assigned by the
                    // server at row creation.
                    startedAt: session.sessionStartedAt,
                    liveMode: false,
                    workspaceId: workspaceId
                )
                captureId = created
                // Persist IMMEDIATELY, to EVERY chunk — a crash after this point
                // must resume, not duplicate, and any surviving chunk has to be
                // able to tell the next launch which row this recording is.
                for chunk in session.chunks {
                    guard var fresh = store.read(chunk.recordingId) else { continue }
                    fresh.captureId = created
                    store.write(fresh)
                }
                print("✅ [WatchIngest] capture created \(created.uuidString.prefix(8))… for session \(shortId)… (\(session.chunks.count) sidecar(s) updated)")
            } catch {
                await recordSessionFailure(session, reason: "capture create failed: \(error.localizedDescription)")
                return
            }
        }

        // ── 2. Assemble the transcript, in CHUNK-INDEX order ────────────────
        // Not arrival order: chunks can and do arrive out of order.
        let transcript = assembleTranscript(session)

        guard !transcript.isEmpty else {
            // Silence is a legitimate outcome, not a failure to retry. End the
            // capture so it stops showing as "Processing…" forever.
            print("⚠️ [WatchIngest] Empty transcript for session \(shortId)… — finalizing an empty capture")
            await finalizeEmpty(captureId: captureId, session: session, workspaceId: workspaceId)
            removeSession(session, captureId: captureId)
            state = .idle
            return
        }

        print("📝 [WatchIngest] Assembled transcript for session \(shortId)…: \(transcript.unicodeScalars.count) chars from \(session.chunks.count) chunk(s)")

        // ── 3. Server transcript ────────────────────────────────────────────
        // The session is assembled in one shot, so there is exactly one append
        // and base_length is 0 — none of the live path's CAS divergence handling
        // can apply. A failure here still falls through to the full-text PATCH,
        // which is the live path's own authoritative save.
        var appended = false
        do {
            _ = try await CaptureAPIService.shared.appendTranscript(
                captureId: captureId,
                appendText: transcript,
                baseLength: 0,
                workspaceId: workspaceId
            )
            appended = true
            print("📤 [WatchIngest] transcript appended for session \(shortId)…")
        } catch {
            print("⚠️ [WatchIngest] transcript-append failed (\(error.localizedDescription)) — falling back to full PATCH")
        }
        if !appended {
            do {
                // ⚠️ CHECK THE RESULT. `replaceTranscript` returns false when the
                // route's no-shrink guard refused the write (it would have
                // shortened a transcript already stored). Discarding that meant
                // reporting a save the server never made — and then deleting the
                // only copy of the audio at the end of this function.
                let saved = try await CaptureAPIService.shared.replaceTranscript(
                    captureId: captureId,
                    transcript: transcript,
                    workspaceId: workspaceId
                )
                guard saved else {
                    await recordSessionFailure(session, reason: "server refused the transcript PATCH (no-shrink guard) — keeping the local chunks")
                    return
                }
                appended = true
                print("📤 [WatchIngest] transcript saved via full PATCH for session \(shortId)…")
            } catch {
                await recordSessionFailure(session, reason: "transcript save failed: \(error.localizedDescription)")
                return
            }
        }

        // ── 4. End the capture ──────────────────────────────────────────────
        // ended_at = session start + the SUM of the chunks' measured durations,
        // so duration_seconds reflects the recording rather than how long the
        // handoff happened to take. (Paused time is already excluded by the
        // watch: it never lands in a chunk.)
        let duration = max(0, Int(session.totalDuration.rounded()))
        let endedAt = session.sessionStartedAt.addingTimeInterval(TimeInterval(duration))
        do {
            try await CaptureAPIService.shared.endCapture(
                captureId: captureId,
                endedAt: endedAt,
                durationSeconds: duration,
                workspaceId: workspaceId
            )
            print("🏁 [WatchIngest] capture ended for session \(shortId)… (\(duration)s)")
        } catch {
            // Non-fatal: the transcript is saved, the row is real. Keep going —
            // the batch reads the transcript, not ended_at.
            print("⚠️ [WatchIngest] endCapture failed: \(error.localizedDescription)")
        }

        // ── 5. Home shows the row now ───────────────────────────────────────
        // A fresh capture with no ai_summary inside the recordedAt window renders
        // as "Processing…" for free (NotesService.isProcessing).
        //
        // ⚠️ ONLY WHEN IT BELONGS TO THE WORKSPACE ON SCREEN. `fetchNote(by:)`
        // filters on id + user_id and NOT on workspace, and caching inserts the
        // row at the top of both `notes` and `allNotesForSearch` — so refreshing a
        // capture the watch routed elsewhere would show a foreign workspace's
        // capture in this one's Home list and search index until the next refetch.
        await refreshHomeIfLocal(captureId: captureId, workspaceId: workspaceId)

        // ── 6. Batch extraction + title ─────────────────────────────────────
        // THE call that produces the summary and the extracted actions. The PATCH
        // above triggers nothing on its own.
        do {
            _ = try await CaptureAPIService.shared.runBatchExtraction(captureId: captureId,
                                                                      workspaceId: workspaceId)
            print("🤖 [WatchIngest] batch extraction done for session \(shortId)…")
        } catch {
            print("❌ [WatchIngest] batch extraction failed for session \(shortId)…: \(error.localizedDescription). The capture is saved — reprocess it from the web app.")
        }

        // Title generation reads ai_summary, so it MUST follow the batch — but it
        // only runs when there is nothing better to call this capture. A calendar
        // meeting name is better: the user recognises "Design sync" in their list,
        // and it matches what the phone would have named the same meeting.
        if hasUsableMeetingTitle(session) {
            print("🏷️ [WatchIngest] keeping calendar title \"\(session.title ?? "")\" for session \(shortId)… — skipping generate-title")
        } else {
            do {
                try await CaptureAPIService.shared.generateTitle(captureId: captureId,
                                                                workspaceId: workspaceId)
                print("🏷️ [WatchIngest] title generated for session \(shortId)…")
            } catch {
                print("⚠️ [WatchIngest] generate-title failed: \(error.localizedDescription)")
            }
        }

        if let note = await refreshHomeIfLocal(captureId: captureId, workspaceId: workspaceId) {
            print("🔄 [WatchIngest] refreshed \(captureId.uuidString.prefix(8))… → \"\(note.title)\"")
        }

        // ── 7. Done — the local copies of what made it in are redundant ─────
        removeSession(session, captureId: captureId)
        state = .idle
    }

    /// Every chunk's stored text, in index order, joined exactly as the live path
    /// joins its own lines.
    ///
    /// Each `.txt` already holds one `[Me] sentence` per final result separated
    /// by "\n", so joining them with "\n" yields a transcript byte-identical in
    /// shape to a single-file one — which is what makes a chunked capture
    /// indistinguishable downstream.
    private func assembleTranscript(_ session: FinalizableWatchSession) -> String {
        let store = PendingWatchCaptures.shared
        var parts: [String] = []
        for chunk in session.chunks.sorted(by: { $0.chunkIndex < $1.chunkIndex }) {
            guard let text = store.readTranscript(for: chunk.recordingId) else {
                // A chunk that exhausted its attempts, or whose text went missing.
                print("🕳️ [WatchIngest] chunk \(chunk.chunkIndex) has no transcript on disk — skipped")
                continue
            }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            parts.append(trimmed)
        }
        return parts.joined(separator: "\n")
    }

    /// Retire a finished session from disk.
    ///
    /// TWO THINGS THIS MUST GET RIGHT, both of which cost a duplicate or a
    /// destroyed recording when it doesn't:
    ///
    ///  1. TOMBSTONE FIRST. The files are the only memory that this recording was
    ///     ever handled, and they are about to be deleted. A chunk that arrives
    ///     afterwards — a WCSession retransmit, or the tail of a recording whose
    ///     bounded wait expired — would otherwise look like a brand-new session
    ///     and become a SECOND capture of the same meeting.
    ///  2. RE-READ FROM DISK, don't trust the snapshot phase 2 started with.
    ///     Finalize spends seconds to minutes on the network (batch extraction
    ///     most of all); a chunk of this session that landed in that window
    ///     carries the `captureId` stamped in step 1 of `finalizeSession`, so
    ///     left behind it waits out `noFinalChunk` and re-enters finalize on the
    ///     SAME capture — overwriting duration/`ended_at` with one chunk's length
    ///     and running a second batch extraction over it.
    private func removeSession(_ session: FinalizableWatchSession, captureId: UUID?) {
        let store = PendingWatchCaptures.shared
        store.markFinalized(sessionId: session.sessionId, captureId: captureId)
        let onDisk = store.sessions().first { $0.sessionId == session.sessionId }?.chunks ?? session.chunks
        discardChunks(onDisk, of: session.sessionId)
    }

    /// Take chunks out of the queue, KEEPING the audio of any that contributed
    /// nothing.
    ///
    /// ⚠️ A CHUNK WITH NO TRANSCRIPT IS NOT SPARE. Its span is missing from the
    /// capture, and the watch deleted its own copy the moment WCSession reported
    /// the transfer — so this `.m4a` is the only recording of those minutes that
    /// exists anywhere. Its sidecar goes (the queue must stop working on it, and
    /// Home must stop calling the whole recording failed) but the audio stays,
    /// inert, until `PendingWatchCaptures.pruneOrphanAudio` reclaims it.
    private func discardChunks(_ chunks: [PendingWatchCapture], of sessionId: UUID) {
        let store = PendingWatchCaptures.shared
        var removed = 0
        var kept: [Int] = []
        for chunk in chunks {
            if store.readTranscript(for: chunk.recordingId) != nil {
                store.remove(chunk.recordingId)
                removed += 1
            } else {
                store.removeBookkeeping(chunk.recordingId)
                kept.append(chunk.chunkIndex)
            }
        }
        print("🧹 [WatchIngest] Removed \(removed) local chunk(s) for session \(sessionId.uuidString.prefix(8))…")
        if !kept.isEmpty {
            print("💾 [WatchIngest] KEPT the audio of chunk(s) \(kept.sorted().map(String.init).joined(separator: ", ")) — they produced no transcript, so this is the only copy of that span")
        }
    }

    /// Keep the files, bump every chunk's FINALIZE counter and stamp the time.
    ///
    /// ⚠️ THE FINALIZE COUNTER IS NOT THE TRANSCRIPTION COUNTER. Sharing one
    /// meant a chunk that had already retried transcription twice pushed the
    /// whole session over the limit on its FIRST network hiccup. They are
    /// separate budgets now, and the timestamp gives the retry a doubling backoff
    /// (`WatchSessionGrace.finalizeBackoff`) so an offline phone gets roughly half
    /// an hour of tries rather than three inside three cadence ticks.
    ///
    /// A session whose capture ROW ALREADY EXISTS gets the larger budget, and
    /// when even that runs out the row is ENDED rather than left on the server
    /// with no transcript, no `ended_at` and no duration — which reads as
    /// "Processing…" for ever and is the one state nothing can recover from.
    private func recordSessionFailure(_ session: FinalizableWatchSession, reason: String) async {
        let store = PendingWatchCaptures.shared
        var worst = 0
        let now = Date()
        for chunk in session.chunks {
            guard var fresh = store.read(chunk.recordingId) else { continue }
            fresh.finalizeAttempts += 1
            fresh.finalizeAttemptedAt = now
            worst = max(worst, fresh.finalizeAttempts)
            store.write(fresh)
        }

        let shortId = session.sessionId.uuidString.prefix(8)
        let captureId = session.captureId
        let limit = PendingWatchCaptures.maxFinalizeAttempts(hasCapture: captureId != nil)
        if worst >= limit {
            print("❌ [WatchIngest] Giving up on session \(shortId)… after \(worst) finalize attempt(s) — \(reason). Audio and transcripts kept on disk; it will not be retried automatically.")
            if let captureId {
                // Through `finalizeEmpty` deliberately: it is the only other
                // function in this file allowed to touch the backend, and this
                // capture IS empty — the transcript never saved.
                print("🏁 [WatchIngest] ending abandoned capture \(captureId.uuidString.prefix(8))… so it doesn't sit un-ended on the server")
                // The give-up path never ran the sequence, so there is no pinned
                // workspace to inherit — resolve it here, once, and hand it over.
                await finalizeEmpty(captureId: captureId,
                                    session: session,
                                    workspaceId: resolveWorkspace(for: session))
            }
        } else {
            let backoff = Int(WatchSessionGrace.finalizeBackoff(for: worst).rounded())
            print("⚠️ [WatchIngest] Finalize attempt \(worst)/\(limit) failed for session \(shortId)… — \(reason). Retrying in \(backoff)s.")
        }
    }

    // MARK: - Workspace routing

    /// WHICH WORKSPACE THIS RECORDING BELONGS IN, and it is resolved ONCE per
    /// finalize and then pinned to every call in the sequence.
    ///
    /// Returning `nil` means "don't override" — `CaptureAPIService` then uses the
    /// phone's currently active workspace, which is precisely the behaviour every
    /// watch recording had before the watch had a selector. Both fallbacks below
    /// are logged, and neither is a failure: a recording is never stranded over a
    /// workspace question.
    ///
    ///   • no id in the metadata (a legacy schema-≤3 chunk, or a watch that had
    ///     no workspace list when it recorded) → the phone's active workspace;
    ///   • an id the user is no longer a member of (membership removed between
    ///     the recording and the ingest) → the phone's active workspace. Sending
    ///     it anyway would 403 the whole sequence and cost the recording.
    private func resolveWorkspace(for session: FinalizableWatchSession) -> UUID? {
        let shortId = session.sessionId.uuidString.prefix(8)
        guard let wanted = session.workspaceId else {
            print("🏢 [WatchIngest] session \(shortId)… carries no workspace selection — using the phone's active workspace")
            return nil
        }
        let memberships = WorkspaceService.shared.memberships.map(\.workspaceId)
        // An empty membership list means the phone has not bootstrapped, not that
        // the user belongs to nothing. Trusting the watch's id is the right call
        // there: it came from a list the phone itself pushed.
        guard memberships.isEmpty || memberships.contains(wanted) else {
            print("🏢 [WatchIngest] session \(shortId)… selected workspace \(wanted.uuidString.prefix(8))… is no longer a membership — using the phone's active workspace instead")
            return nil
        }
        print("🏢 [WatchIngest] session \(shortId)… routing to workspace \(wanted.uuidString.lowercased())")
        return wanted
    }

    // MARK: - Titles

    /// True when the watch supplied a REAL calendar meeting name. The watch's own
    /// "New recording" fallback deliberately does not count: it says nothing, so
    /// the capture should still be auto-titled from its content.
    private func hasUsableMeetingTitle(_ session: FinalizableWatchSession) -> Bool {
        guard session.hasMeetingTitle,
              let title = session.title?.trimmingCharacters(in: .whitespacesAndNewlines),
              !title.isEmpty
        else { return false }
        return true
    }

    /// What the capture row is called at creation: the meeting name when we have
    /// one, otherwise the `Capture Mon D H:MM AM/PM` placeholder that
    /// generate-title is allowed to replace.
    private func provisionalTitle(for session: FinalizableWatchSession) -> String {
        guard hasUsableMeetingTitle(session),
              let title = session.title?.trimmingCharacters(in: .whitespacesAndNewlines)
        else {
            return CaptureAPIService.autoTitle(for: session.sessionStartedAt)
        }
        return title
    }

    /// A recording whose audio produced no speech: end it so it isn't stuck in
    /// the "Processing…" state, but skip the batch (there is nothing to extract).
    private func finalizeEmpty(captureId: UUID,
                               session: FinalizableWatchSession,
                               workspaceId: UUID?) async {
        let duration = max(0, Int(session.totalDuration.rounded()))
        // Same workspace as the row it is ending — this is reached both from a
        // silent recording and from the give-up path, and in both cases the
        // capture lives wherever the session was routed. PASSED IN rather than
        // re-resolved: the caller already pinned the sequence to one workspace,
        // and resolving again could disagree with it if memberships changed in
        // between.
        try? await CaptureAPIService.shared.endCapture(
            captureId: captureId,
            endedAt: session.sessionStartedAt.addingTimeInterval(TimeInterval(duration)),
            durationSeconds: duration,
            workspaceId: workspaceId
        )
        await refreshHomeIfLocal(captureId: captureId, workspaceId: workspaceId)
    }

    /// Pull the capture into Home's caches — but ONLY when it belongs to the
    /// workspace the phone is currently showing.
    ///
    /// `NotesService.fetchNote(by:)` is scoped by id and user_id alone, and
    /// `cacheNote` inserts an unknown id at position 0 of both `notes` and
    /// `allNotesForSearch`. Since the watch may route a capture to a workspace the
    /// phone is not in, an unguarded refresh is a cross-workspace leak into the
    /// on-screen list — exactly what `fetchAllNotesForSearch` guards against.
    /// A nil `workspaceId` means "the phone's active workspace", which is by
    /// definition the one on screen.
    @discardableResult
    private func refreshHomeIfLocal(captureId: UUID, workspaceId: UUID?) async -> Note? {
        guard let workspaceId else {
            return await NotesService.shared.refreshNoteAndNotify(id: captureId)
        }
        guard workspaceId == WorkspaceService.shared.workspaceId else {
            print("🏢 [WatchIngest] capture \(captureId.uuidString.prefix(8))… belongs to another workspace — not inserting it into this one's Home list")
            return nil
        }
        return await NotesService.shared.refreshNoteAndNotify(id: captureId)
    }

    // MARK: - On-device transcription

    /// The only failure this file can still produce itself. Device- and
    /// language-level unavailability is caught by the readiness gate before a
    /// file is ever opened, so it never reaches here.
    enum IngestError: LocalizedError {
        case transcriptionFailed(String)

        var errorDescription: String? {
            switch self {
            case .transcriptionFailed(let why): return "On-device transcription failed: \(why)"
            }
        }
    }

    /// One labelled utterance. Retained (rather than collapsing straight to
    /// strings) because `stitch` is what guarantees the server-format shape, and
    /// a future diarizing backend would slot back in here unchanged.
    struct TranscriptLine: Equatable {
        /// Diarization speaker index, or nil when the backend does not diarize.
        /// Always nil today: Apple's SpeechTranscriber has no diarization.
        let speaker: Int?
        let text: String
    }

    /// Transcribe ONE CHUNK on-device and return it in the live path's server
    /// format: one `[Me] sentence` line per final result, joined with "\n" —
    /// byte-for-byte what the live iOS path writes.
    ///
    /// `locale` is passed in rather than resolved here: the drain has already
    /// established that `SpeechModelManager` is `.ready`, and re-resolving would
    /// risk analysing with a different configuration than the one whose assets
    /// were verified installed.
    ///
    /// `nonisolated static` deliberately: a 15-minute chunk is a multi-second
    /// analysis and none of it touches main-actor state. `AppleSpeechFile-
    /// Transcriber` streams the file through `analyzeSequence(from:)`, so memory
    /// stays flat regardless of chunk length.
    nonisolated static func transcribe(fileURL: URL, locale: Locale) async throws -> String {
        do {
            let results = try await AppleSpeechFileTranscriber.transcribe(fileURL: fileURL, locale: locale)
            let lines = results
                .map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .map { TranscriptLine(speaker: nil, text: $0) }
            return stitch([lines])
        } catch {
            throw IngestError.transcriptionFailed(error.localizedDescription)
        }
    }

    /// Join per-pass transcripts into one server-format transcript.
    ///
    /// Speaker numbering is preserved for a future diarizing backend: indices are
    /// scoped to their own pass, so they are renumbered GLOBALLY in
    /// first-appearance order rather than assumed to mean the same person across
    /// passes. With today's non-diarizing on-device backend every line takes the
    /// single mic label, matching the live iOS path byte for byte.
    nonisolated static func stitch(_ chunks: [[TranscriptLine]]) -> String {
        var lines: [String] = []
        var nextGlobalSpeaker = 1
        for chunk in chunks {
            var localToGlobal: [Int: Int] = [:]
            for line in chunk {
                guard !line.text.isEmpty else { continue }
                let label: String
                if let speaker = line.speaker {
                    if let mapped = localToGlobal[speaker] {
                        label = "Speaker \(mapped)"
                    } else {
                        localToGlobal[speaker] = nextGlobalSpeaker
                        label = "Speaker \(nextGlobalSpeaker)"
                        nextGlobalSpeaker += 1
                    }
                } else {
                    label = AudioSource.microphone.displayLabel
                }
                lines.append("[\(label)] \(line.text)")
            }
        }
        return lines.joined(separator: "\n")
    }
}
