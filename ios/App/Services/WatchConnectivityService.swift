//
//  WatchConnectivityService.swift
//  dial8
//
//  The phone end of the Watch → iPhone capture handoff.
//
//  The watch records a meeting to a local `.m4a` and hands it to WatchConnectivity
//  with `transferFile`. The system delivers it here, on a background thread, with a
//  temp URL that is VALID ONLY FOR THE DURATION OF THE DELEGATE CALL — Apple deletes
//  it the moment `session(_:didReceive:)` returns. So the move is synchronous, with
//  no `await`, no `DispatchQueue.async`, and no `Task {}` between receipt and
//  `moveItem`. Getting that wrong loses every recording silently: the transfer
//  reports success on the watch and the file simply never exists on the phone.
//
//  A RECORDING IS A SESSION OF ORDERED CHUNKS. The watch rotates its recorder
//  every 15 minutes of recorded time and hands each closed chunk over while the
//  meeting is still running, so a one-hour meeting arrives as four files. What
//  lands on disk is a TRIPLE per chunk, flat in Application Support:
//
//      pending-watch-captures/<recordingId>.m4a     the chunk's audio
//      pending-watch-captures/<recordingId>.json    the chunk's sidecar
//      pending-watch-captures/<recordingId>.txt     the chunk's transcript, once
//                                                   it has been transcribed
//
//  Flat, not a directory per session, for two reasons: the synchronous move in
//  `didReceive` stays a single `moveItem` into a directory that already exists
//  (one `createDirectory` call in the delegate is one more way to lose a file),
//  and a schema-≤2 single-file record already sitting on a user's phone keeps
//  working untouched — it simply reads as a one-chunk session.
//
//  The sidecar is the crash-safety record: it carries the watch's own metadata
//  (which session, which index, whether it is the last, when the recording
//  started, how long this chunk ran) plus the server `captureId` once
//  `WatchCaptureIngestService` has created one, plus an attempt counter.
//  Persisting the capture id on EVERY chunk the instant the row exists is what
//  stops a crash mid-finalize from creating a second capture row for the same
//  recording on the next launch.
//
//  Enumerating a partially-arrived session is a directory listing plus a
//  group-by: `PendingWatchCaptures.sessions()`.
//
//  Ingest itself is not this file's job — it posts `.watchCaptureFileReceived` and
//  `WatchCaptureIngestService` takes it from there.
//

import Foundation
import Combine
import WatchConnectivity

extension Notification.Name {
    /// A watch recording has landed in the pending directory and is ready to ingest.
    static let watchCaptureFileReceived = Notification.Name("watchCaptureFileReceived")
}

// MARK: - Sidecar

/// The JSON record written next to every pending `.m4a`.
///
/// ONE RECORD PER CHUNK, NOT PER RECORDING. Since the watch learned to rotate
/// its recorder, a watch recording is a SESSION made of ordered chunks: the
/// watch closes a chunk every 15 minutes of recorded time and hands it over
/// while the meeting is still running, so the phone holds N of these per
/// recording, all sharing one `sessionId`.
///
/// `captureId` is the important field: nil until the server row exists, then
/// written to EVERY chunk of the session immediately, so a resumed finalize
/// adopts the same capture instead of creating a duplicate.
struct PendingWatchCapture: Codable, Equatable {
    /// THIS CHUNK's id (the watch's `recordingId`). Names both of its files and
    /// keys the dedupe. Unique per chunk — `sessionId` is what groups a
    /// recording.
    let recordingId: UUID
    /// When THIS CHUNK's audio starts, wall clock, from the watch. NOT the
    /// capture's start — that is `sessionStartedAt`, which is identical across
    /// the session.
    let startedAt: Date
    /// THIS CHUNK's audio length in seconds, as measured on the watch. The
    /// capture's duration is the SUM across the session.
    let durationSeconds: Double
    /// "watch". Kept for forward compatibility if other senders appear.
    let source: String
    /// Metadata schema version from the watch. 4 since the workspace selector
    /// (adds `workspaceId`); 3 since chunking; 1–2 are single-file recordings and
    /// are read as one-chunk sessions.
    let schema: Int
    /// The server capture row for the whole SESSION, once created. Persisted to
    /// every chunk the instant `createCapture` returns — see the file header.
    var captureId: UUID?
    /// How many times work on this chunk has failed. Given up on after 3.
    var attempts: Int
    /// The name the watch chose for this recording: the calendar meeting it fell
    /// inside, or the watch's own fallback. Identical on every chunk.
    var title: String?
    /// True only when `title` is a real calendar meeting name.
    var hasMeetingTitle: Bool
    /// THE WORKSPACE THE USER SELECTED ON THE WATCH for this recording (watch
    /// metadata schema 4). Identical on every chunk of a session. `nil` on a
    /// schema-≤3 sidecar, or when the watch had no workspace list — the phone
    /// then files the capture into its own active workspace.
    let workspaceId: UUID?

    // ── Session identity (watch metadata schema 3) ──────────────────────────

    /// Identical on every chunk of one recording. Group by this.
    let sessionId: UUID
    /// 0-based, contiguous within the session.
    let chunkIndex: Int
    /// True on the LAST chunk only.
    let isFinal: Bool
    /// Sent only on the final chunk: how many chunks the session has. A session
    /// is COMPLETE when the final chunk is here and every index 0..<totalChunks
    /// is present.
    let totalChunks: Int?
    /// Identical on every chunk: the moment RECORDING started. This is what is
    /// sent to the server as the capture's `started_at`, and it is the
    /// session-identity anchor every chunk agrees on. (`recorded_at` — what Home
    /// actually orders by — is assigned by the server at row creation.)
    let sessionStartedAt: Date
    /// Seconds of RECORDED session time before this chunk's first sample
    /// (paused time excluded). Chunk 0 is always 0. Reported by the watch from
    /// its real session clock — do NOT recompute it as index × chunkDuration,
    /// the rotation timer takes run-loop leeway and chunks run slightly long.
    let chunkStartOffset: Double

    // ── Phone-side bookkeeping ─────────────────────────────────────────────

    /// When the PHONE took delivery. Drives the bounded waits for a session
    /// whose final chunk (or a middle chunk) never arrives: the watch's clock
    /// can't be trusted for that, and a `Date()` computed at read time would
    /// never expire.
    let receivedAt: Date
    /// True once this chunk's on-device transcript has been written to its
    /// `.txt`. An EMPTY transcript is a legitimate final outcome (silence), so
    /// this flag — not the file's length — is what says the work is done.
    var transcribed: Bool
    /// Phase-2 (finalize) attempts, counted SEPARATELY from `attempts`, which is
    /// phase 1's per-chunk transcription budget. One shared counter meant a
    /// single transient network error could exhaust a session whose chunks had
    /// merely retried transcription twice — and it gave a session whose capture
    /// row already exists no way back to completion.
    var finalizeAttempts: Int
    /// When the last finalize attempt failed. The retry backs off from here, so
    /// the scheduler's cadence can't burn the whole budget in three minutes.
    var finalizeAttemptedAt: Date?

    init(recordingId: UUID,
         startedAt: Date,
         durationSeconds: Double,
         source: String,
         schema: Int,
         captureId: UUID? = nil,
         attempts: Int = 0,
         title: String? = nil,
         hasMeetingTitle: Bool = false,
         workspaceId: UUID? = nil,
         sessionId: UUID? = nil,
         chunkIndex: Int = 0,
         isFinal: Bool = true,
         totalChunks: Int? = 1,
         sessionStartedAt: Date? = nil,
         chunkStartOffset: Double = 0,
         receivedAt: Date? = nil,
         transcribed: Bool = false,
         finalizeAttempts: Int = 0,
         finalizeAttemptedAt: Date? = nil) {
        self.recordingId = recordingId
        self.startedAt = startedAt
        self.durationSeconds = durationSeconds
        self.source = source
        self.schema = schema
        self.captureId = captureId
        self.attempts = attempts
        self.title = title
        self.hasMeetingTitle = hasMeetingTitle
        self.workspaceId = workspaceId
        self.sessionId = sessionId ?? recordingId
        self.chunkIndex = chunkIndex
        self.isFinal = isFinal
        self.totalChunks = totalChunks
        self.sessionStartedAt = sessionStartedAt ?? startedAt
        self.chunkStartOffset = chunkStartOffset
        self.receivedAt = receivedAt ?? startedAt
        self.transcribed = transcribed
        self.finalizeAttempts = finalizeAttempts
        self.finalizeAttemptedAt = finalizeAttemptedAt
    }

    /// Sidecars written by an earlier build have none of the session fields (and
    /// pre-schema-2 ones have neither title field). Decoding must tolerate that
    /// — a throw here would strand a real recording on disk.
    ///
    /// THE LEGACY DEFAULTS ARE THE BACKWARD-COMPATIBILITY RULE (design point
    /// 10), and they are the same ones the watch's own `QueuedRecording` decoder
    /// uses: a single-file record IS a one-chunk session.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        recordingId = try c.decode(UUID.self, forKey: .recordingId)
        startedAt = try c.decode(Date.self, forKey: .startedAt)
        durationSeconds = try c.decode(Double.self, forKey: .durationSeconds)
        source = try c.decodeIfPresent(String.self, forKey: .source) ?? "watch"
        schema = try c.decodeIfPresent(Int.self, forKey: .schema) ?? 1
        captureId = try c.decodeIfPresent(UUID.self, forKey: .captureId)
        attempts = try c.decodeIfPresent(Int.self, forKey: .attempts) ?? 0
        title = try c.decodeIfPresent(String.self, forKey: .title)
        hasMeetingTitle = try c.decodeIfPresent(Bool.self, forKey: .hasMeetingTitle) ?? false
        // Absent on every sidecar written before schema 4 — including ones
        // already sitting on a user's phone. nil IS the legacy rule: no selection
        // recorded, so ingest uses the phone's active workspace.
        workspaceId = try c.decodeIfPresent(UUID.self, forKey: .workspaceId)
        sessionId = try c.decodeIfPresent(UUID.self, forKey: .sessionId) ?? recordingId
        chunkIndex = try c.decodeIfPresent(Int.self, forKey: .chunkIndex) ?? 0
        isFinal = try c.decodeIfPresent(Bool.self, forKey: .isFinal) ?? true
        // Absent on a legacy record AND on every non-final chunk. `nil` here
        // means "the session hasn't declared its length yet", which is exactly
        // what an incomplete session should look like — except for a legacy
        // record, where `isFinal` defaulted true and the length is 1.
        if let declared = try c.decodeIfPresent(Int.self, forKey: .totalChunks) {
            totalChunks = declared
        } else {
            totalChunks = (try c.decodeIfPresent(Bool.self, forKey: .isFinal) == nil) ? 1 : nil
        }
        sessionStartedAt = try c.decodeIfPresent(Date.self, forKey: .sessionStartedAt) ?? startedAt
        chunkStartOffset = try c.decodeIfPresent(Double.self, forKey: .chunkStartOffset) ?? 0
        receivedAt = try c.decodeIfPresent(Date.self, forKey: .receivedAt) ?? startedAt
        transcribed = try c.decodeIfPresent(Bool.self, forKey: .transcribed) ?? false
        finalizeAttempts = try c.decodeIfPresent(Int.self, forKey: .finalizeAttempts) ?? 0
        finalizeAttemptedAt = try c.decodeIfPresent(Date.self, forKey: .finalizeAttemptedAt)
    }
}

// MARK: - Sessions

/// How long the phone waits on a session that has stopped arriving before it
/// finishes with what it has. EVERY WAIT IS BOUNDED (design point 9): a watch
/// that died mid-meeting, or a chunk that WCSession never delivered, must not
/// leave a recording invisible forever.
enum WatchSessionGrace {
    /// The final chunk IS here but a middle one isn't. Measured from the final
    /// chunk's arrival: everything that is ever coming has had its chance by
    /// then, because the watch queued the missing chunk BEFORE the final one.
    static var missingChunk: TimeInterval { debugOverride ?? 10 * 60 }

    /// No final chunk ever arrived. Measured from the NEWEST chunk's arrival, so
    /// a still-running meeting (a fresh chunk every 15 minutes) keeps pushing
    /// the deadline out and only a genuinely dead sender expires.
    static var noFinalChunk: TimeInterval { debugOverride ?? 45 * 60 }

    /// A COMPLETE session that still can't finalize — a chunk whose on-device
    /// transcription keeps failing, or a `SpeechModelManager` wedged in
    /// `.failed`/`.checking`. NOTHING ELSE BOUNDS THAT WAIT: the model gate
    /// burns no attempts by design, so without this cap a speech model that
    /// never resolves leaves every watch recording reading "syncing…" forever.
    /// Measured from the newest chunk's arrival.
    static var completeStall: TimeInterval { debugOverride ?? 10 * 60 }

    /// The cadence at which a session whose deadline has ALREADY passed is
    /// looked at again. A past deadline is not a reason to stop waking: it is
    /// the attempt machinery's only way to reach its give-up once chunks stop
    /// arriving.
    static var retry: TimeInterval { min(debugOverride ?? 60, 60) }

    /// How long after LAUNCH (or WCSession activation) an already-expired
    /// `noFinalChunk` deadline is ignored. Transfers the system queued while the
    /// phone was off are redelivered seconds after activation; finalizing a
    /// session in a race against its own remaining chunks is how one meeting
    /// becomes two captures.
    static var activationSettle: TimeInterval { min(debugOverride ?? 90, 90) }

    /// Backoff before retrying a finalize that failed. 1, 2, 4, 8, 16 minutes —
    /// so an offline phone gets roughly half an hour of retries rather than
    /// spending its whole budget inside three cadence ticks.
    static func finalizeBackoff(for attempts: Int) -> TimeInterval {
        let step = min(max(attempts, 1), 5)
        return min(retry * pow(2, Double(step - 1)), 30 * 60)
    }

    #if DEBUG
    /// `-watchSessionGraceSeconds N` on the PHONE app, so both waits can be
    /// exercised in a short run instead of 45 minutes. Values < 1 are ignored.
    private static var debugOverride: TimeInterval? {
        let seconds = UserDefaults.standard.double(forKey: "watchSessionGraceSeconds")
        return seconds >= 1 ? seconds : nil
    }
    #else
    private static var debugOverride: TimeInterval? { nil }
    #endif
}

/// A recording's chunks, grouped. Built by `PendingWatchCaptures.sessions()`.
struct WatchCaptureSession {
    let sessionId: UUID
    /// The chunks actually on disk, in `chunkIndex` order. May have holes.
    let chunks: [PendingWatchCapture]

    /// The moment recording started — identical across chunks, so chunk 0 is not
    /// needed to know it.
    var sessionStartedAt: Date { chunks.first?.sessionStartedAt ?? .distantPast }

    var finalChunk: PendingWatchCapture? { chunks.first { $0.isFinal } }

    /// How many chunks the session has, once the final chunk has declared it.
    /// nil while the recording is still arriving.
    var declaredTotal: Int? {
        guard let final = finalChunk else { return nil }
        // A final chunk that somehow lost its `totalChunks` still bounds the
        // session: it is the last index, so the count is index + 1.
        return final.totalChunks ?? (final.chunkIndex + 1)
    }

    var presentIndices: Set<Int> { Set(chunks.map(\.chunkIndex)) }

    var missingIndices: [Int] {
        guard let total = declaredTotal else { return [] }
        return (0..<total).filter { !presentIndices.contains($0) }
    }

    /// COMPLETE = the final chunk has arrived AND every index 0..<totalChunks is
    /// present. Nothing server-side may happen before this is true (design
    /// point 6) unless a bounded wait has expired.
    var isComplete: Bool { declaredTotal != nil && missingIndices.isEmpty }

    /// Phase-2 attempts, which every chunk of the session carries identically.
    var finalizeAttempts: Int { chunks.map(\.finalizeAttempts).max() ?? 0 }

    var lastFinalizeAttempt: Date? { chunks.compactMap(\.finalizeAttemptedAt).max() }

    /// Given up on. Two ways, deliberately distinct:
    ///
    ///  • nothing this session could still produce text — every chunk is out of
    ///    TRANSCRIPTION attempts and not one of them ever transcribed, so a
    ///    finalize would have nothing to save; or
    ///  • finalize itself used up its OWN budget.
    ///
    /// A session that already owns a `captureId` gets the larger budget, because
    /// a created row that is never ended is worse than one more retry — see
    /// `PendingWatchCaptures.maxFinalizeAttempts(hasCapture:)`.
    var isExhausted: Bool {
        guard !chunks.isEmpty else { return false }
        if transcribable.isEmpty && !chunks.contains(where: { $0.transcribed }) { return true }
        return finalizeAttempts >= PendingWatchCaptures.maxFinalizeAttempts(hasCapture: captureId != nil)
    }

    /// The provisional title and meeting flag ride on every chunk, so a lost
    /// chunk 0 is not fatal.
    var title: String? { chunks.compactMap(\.title).first }
    var hasMeetingTitle: Bool { chunks.contains { $0.hasMeetingTitle } }

    /// The capture row, from whichever chunk's sidecar recorded it.
    var captureId: UUID? { chunks.compactMap(\.captureId).first }

    /// Where this recording should be filed. CHUNK 0'S ANSWER WINS: the watch
    /// resolves the workspace once, at `start()`, so every chunk of a session
    /// should carry the same id and a disagreement is impossible by construction
    /// — which is exactly why it is worth logging if it ever happens rather than
    /// silently picking one. `chunks` is index-ordered, so `first` is the lowest
    /// index present.
    var workspaceId: UUID? {
        let distinct = Set(chunks.compactMap(\.workspaceId))
        if distinct.count > 1 {
            print("⚠️ [WatchSession] session \(sessionId.uuidString.prefix(8))… chunks disagree on workspace (\(distinct.map { $0.uuidString.prefix(8) + "…" }.sorted().joined(separator: ", "))) — using chunk \(chunks.first?.chunkIndex ?? 0)'s")
        }
        return chunks.compactMap(\.workspaceId).first
    }

    /// The capture's duration: the SUM of the chunks we hold.
    var totalDuration: Double { chunks.reduce(0) { $0 + $1.durationSeconds } }

    var newestArrival: Date { chunks.map(\.receivedAt).max() ?? .distantPast }

    /// When this session may be finished with whatever is on disk, however
    /// incomplete. NEVER OPTIONAL: a complete session has a deadline too, because
    /// "complete" does not mean "finishable" — a chunk can still be untranscribed
    /// behind a wedged speech model, and that wait needs a bound like every other
    /// one (design point 9).
    var graceDeadline: Date {
        if isComplete {
            return newestArrival.addingTimeInterval(WatchSessionGrace.completeStall)
        }
        if let final = finalChunk {
            return final.receivedAt.addingTimeInterval(WatchSessionGrace.missingChunk)
        }
        return newestArrival.addingTimeInterval(WatchSessionGrace.noFinalChunk)
    }

    /// When the drain should look at this session again. NEVER nil while the
    /// session is live — a wait nothing wakes is not a bounded wait, and neither
    /// a `.watchCaptureFileReceived` (no chunk is coming) nor a
    /// `SpeechModelManager` change (a settled device publishes nothing) is
    /// guaranteed to fire again.
    func wakeDeadline(now: Date) -> Date? {
        guard !isExhausted else { return nil }
        var candidates: [Date] = [graceDeadline]
        if finalizeAttempts > 0, let last = lastFinalizeAttempt {
            candidates.append(last.addingTimeInterval(WatchSessionGrace.finalizeBackoff(for: finalizeAttempts)))
        }
        // Still owed work with no external trigger left: a complete session
        // waiting on one chunk's transcription, or a chunk whose arrival
        // notification was swallowed by a drain already in flight.
        if !transcribable.isEmpty || isComplete {
            candidates.append(now.addingTimeInterval(WatchSessionGrace.retry))
        }
        return candidates.filter { $0 > now }.min()
            ?? now.addingTimeInterval(WatchSessionGrace.retry)
    }

    /// Chunks still owed on-device transcription: not yet transcribed and not
    /// past their attempt limit.
    var transcribable: [PendingWatchCapture] {
        chunks.filter(PendingWatchCaptures.isTranscribable)
    }

    /// ⚠️ THE ONLY DOOR TO SERVER WORK. Returns a `FinalizableWatchSession` —
    /// whose initializer is `fileprivate`, so `WatchCaptureIngestService` (a
    /// different file) CANNOT manufacture one — and only when:
    ///
    ///   • at least one chunk actually produced a transcript (a session whose
    ///     every chunk exhausted its attempts stays failed rather than creating
    ///     an empty capture), and
    ///   • the session is complete AND every chunk that could still be
    ///     transcribed HAS been, OR its bounded wait has expired — past the
    ///     deadline we finish with the chunks that did transcribe rather than
    ///     waiting on a gate that may never open, and
    ///   • a previous finalize failure has served its backoff.
    ///
    /// That is design point 6 made structural: no capture row, append, end,
    /// batch or title can exist without this value.
    func finalizable(now: Date) -> FinalizableWatchSession? {
        guard !isExhausted else { return nil }
        let expired = now >= graceDeadline
        if !expired {
            guard isComplete else { return nil }
            guard transcribable.isEmpty else { return nil }
        }
        guard chunks.contains(where: { $0.transcribed }) else { return nil }
        if finalizeAttempts > 0, let last = lastFinalizeAttempt {
            let next = last.addingTimeInterval(WatchSessionGrace.finalizeBackoff(for: finalizeAttempts))
            guard now >= next else { return nil }
        }
        return FinalizableWatchSession(
            sessionId: sessionId,
            chunks: chunks,
            workspaceId: workspaceId,
            missingIndices: missingIndices,
            wasComplete: isComplete,
            sawFinalChunk: finalChunk != nil,
            untranscribedIndices: chunks.filter { !$0.transcribed }.map(\.chunkIndex)
        )
    }
}

/// Proof that a session may talk to the server. Constructible ONLY by
/// `WatchCaptureSession.finalizable(now:)` — see the warning there.
struct FinalizableWatchSession {
    let sessionId: UUID
    /// Present chunks in `chunkIndex` order. The transcript is assembled in this
    /// order regardless of the order the chunks arrived in.
    let chunks: [PendingWatchCapture]
    /// The workspace the WATCH selected for this recording, chunk 0's answer.
    /// nil for a legacy (schema ≤3) recording or one made before the watch had a
    /// list — ingest then uses the phone's active workspace.
    let workspaceId: UUID?
    /// Indices the session declared but never delivered. Non-empty only when a
    /// bounded wait expired; the transcript simply misses that span.
    let missingIndices: [Int]
    /// False when a bounded wait expired instead of the session completing.
    let wasComplete: Bool
    /// False when the chunk marked `isFinal` never arrived — i.e. the SENDER may
    /// still have chunks queued. The drain refuses to finalize one of these
    /// inside the settling window after launch, when the system is about to
    /// redeliver exactly those transfers.
    let sawFinalChunk: Bool
    /// Chunks that ARE on disk but produced no transcript — out of attempts, or
    /// the wait expired before the analyzer got to them. Their span is missing
    /// from the transcript, so their audio is the only copy of it and must not
    /// be deleted with the rest of the session.
    let untranscribedIndices: [Int]

    fileprivate init(sessionId: UUID,
                     chunks: [PendingWatchCapture],
                     workspaceId: UUID?,
                     missingIndices: [Int],
                     wasComplete: Bool,
                     sawFinalChunk: Bool,
                     untranscribedIndices: [Int]) {
        self.sessionId = sessionId
        self.chunks = chunks
        self.workspaceId = workspaceId
        self.missingIndices = missingIndices
        self.wasComplete = wasComplete
        self.sawFinalChunk = sawFinalChunk
        self.untranscribedIndices = untranscribedIndices
    }

    var sessionStartedAt: Date { chunks.first?.sessionStartedAt ?? Date() }
    var totalDuration: Double { chunks.reduce(0) { $0 + $1.durationSeconds } }
    var title: String? { chunks.compactMap(\.title).first }
    var hasMeetingTitle: Bool { chunks.contains { $0.hasMeetingTitle } }
    var captureId: UUID? { chunks.compactMap(\.captureId).first }
}

// MARK: - Pending store

/// Owns the `pending-watch-captures/` directory: where it is, what is in it, and
/// the sidecar read/write. Deliberately free of async — every write here happens
/// either inside the synchronous WCSession callback or at a point in ingest where
/// losing the write to a crash would mean a duplicate capture.
final class PendingWatchCaptures {
    static let shared = PendingWatchCaptures()

    private init() {}

    /// `Application Support/pending-watch-captures`. Application Support (not
    /// Caches) because the OS may evict Caches under pressure and a recording that
    /// has not been transcribed yet is not reproducible.
    var directory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("pending-watch-captures", isDirectory: true)
    }

    func ensureDirectory() {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    func audioURL(for recordingId: UUID) -> URL {
        directory.appendingPathComponent("\(recordingId.uuidString).m4a")
    }

    func sidecarURL(for recordingId: UUID) -> URL {
        directory.appendingPathComponent("\(recordingId.uuidString).json")
    }

    /// Where a chunk's on-device transcript lives once it has been produced.
    /// Plain UTF-8, already in the server's `[Me] sentence` line format, so
    /// assembling a session is a read-and-join with no re-encoding.
    func transcriptURL(for recordingId: UUID) -> URL {
        directory.appendingPathComponent("\(recordingId.uuidString).txt")
    }

    /// Persist a chunk's transcript. An EMPTY string is a real result (silence)
    /// and is written as an empty file, so the caller can mark the chunk done.
    @discardableResult
    func writeTranscript(_ text: String, for recordingId: UUID) -> Bool {
        ensureDirectory()
        do {
            try Data(text.utf8).write(to: transcriptURL(for: recordingId), options: .atomic)
            return true
        } catch {
            print("❌ [PendingWatchCaptures] Failed to write transcript for \(recordingId): \(error.localizedDescription)")
            return false
        }
    }

    /// nil only when the file is missing or unreadable — "" means transcribed
    /// silence. Callers must not conflate the two.
    func readTranscript(for recordingId: UUID) -> String? {
        guard let data = try? Data(contentsOf: transcriptURL(for: recordingId)) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }()

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    /// Synchronous sidecar write. Returns false on failure so the caller can log
    /// loudly — a sidecar that didn't land means the next launch can't resume.
    @discardableResult
    func write(_ record: PendingWatchCapture) -> Bool {
        ensureDirectory()
        do {
            let data = try Self.encoder.encode(record)
            try data.write(to: sidecarURL(for: record.recordingId), options: .atomic)
            return true
        } catch {
            print("❌ [PendingWatchCaptures] Failed to write sidecar for \(record.recordingId): \(error.localizedDescription)")
            return false
        }
    }

    func read(_ recordingId: UUID) -> PendingWatchCapture? {
        guard let data = try? Data(contentsOf: sidecarURL(for: recordingId)) else { return nil }
        return try? Self.decoder.decode(PendingWatchCapture.self, from: data)
    }

    /// Give up on TRANSCRIBING a chunk after this many failed attempts, so a
    /// permanently-bad recording can't spin forever on every foreground.
    static let maxAttempts = 3

    /// Give up on FINALIZING a session after this many failed attempts — its own
    /// budget, separate from `maxAttempts`, so one offline finalize doesn't eat
    /// the transcription allowance (and vice versa).
    ///
    /// A session whose capture row ALREADY EXISTS gets a bigger budget: giving
    /// up there leaves a row on the server with no transcript and no `ended_at`,
    /// which is strictly worse than retrying. With `WatchSessionGrace`'s doubling
    /// backoff, six attempts is roughly half an hour of trying.
    static func maxFinalizeAttempts(hasCapture: Bool) -> Int { hasCapture ? 6 : 3 }

    /// The tombstone ledger lives in the same directory but is NOT a sidecar —
    /// `all()` must skip it by name.
    static let tombstoneFileName = "finalized-sessions.json"

    /// How long a finalized session is remembered. Long enough for a watch that
    /// has been out of range for days to come back and be recognised.
    static let tombstoneLifetime: TimeInterval = 7 * 24 * 60 * 60

    /// How long audio with no sidecar is kept before the space is reclaimed:
    /// the untranscribed span of a finalized session, or a chunk that arrived
    /// after its session had already become a capture. Deliberately generous —
    /// it is the user's only copy of that audio.
    static let orphanAudioLifetime: TimeInterval = 7 * 24 * 60 * 60

    private var tombstoneURL: URL { directory.appendingPathComponent(Self.tombstoneFileName) }

    /// A recording that has already become a capture.
    ///
    /// ⚠️ WITHOUT THIS THE ONLY MEMORY OF A FINALIZED SESSION IS ITS FILES, AND
    /// THOSE ARE DELETED BY DEFINITION. A chunk that lands afterwards — a
    /// WCSession retransmit, or the tail of a recording the phone stopped waiting
    /// for — then looks like a brand-new session and becomes a SECOND capture for
    /// the same meeting.
    struct FinalizedSession: Codable, Equatable {
        let sessionId: UUID
        let captureId: UUID?
        let finalizedAt: Date
    }

    /// Every remembered session, expired entries dropped.
    func finalizedSessions() -> [UUID: FinalizedSession] {
        guard let data = try? Data(contentsOf: tombstoneURL),
              let rows = try? Self.decoder.decode([FinalizedSession].self, from: data)
        else { return [:] }
        let cutoff = Date().addingTimeInterval(-Self.tombstoneLifetime)
        return Dictionary(uniqueKeysWithValues: rows.filter { $0.finalizedAt >= cutoff }.map { ($0.sessionId, $0) })
    }

    func finalized(_ sessionId: UUID) -> FinalizedSession? {
        finalizedSessions()[sessionId]
    }

    /// Remember that this session became a capture. Written BEFORE the files are
    /// removed: a crash between the two costs a redundant sweep, the other order
    /// costs a duplicate capture.
    func markFinalized(sessionId: UUID, captureId: UUID?) {
        ensureDirectory()
        var rows = finalizedSessions()
        rows[sessionId] = FinalizedSession(sessionId: sessionId, captureId: captureId, finalizedAt: Date())
        guard let data = try? Self.encoder.encode(Array(rows.values).sorted(by: { $0.finalizedAt < $1.finalizedAt })) else { return }
        do {
            try data.write(to: tombstoneURL, options: .atomic)
        } catch {
            print("❌ [PendingWatchCaptures] Failed to write finalized-session tombstone for \(sessionId): \(error.localizedDescription)")
        }
    }

    /// Every recording on disk with BOTH a sidecar and its audio, oldest first —
    /// INCLUDING ones that have exhausted their attempts. Callers that want only
    /// the ingestable ones want `pending()`.
    func all() -> [PendingWatchCapture] {
        ensureDirectory()
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else {
            return []
        }
        pruneOrphanAudio(in: entries)
        return entries
            .filter { $0.pathExtension == "json" && $0.lastPathComponent != Self.tombstoneFileName }
            .compactMap { url -> PendingWatchCapture? in
                guard let data = try? Data(contentsOf: url),
                      let record = try? Self.decoder.decode(PendingWatchCapture.self, from: data)
                else { return nil }
                guard fm.fileExists(atPath: audioURL(for: record.recordingId).path) else {
                    // Sidecar without audio: nothing to transcribe, drop it so the
                    // queue doesn't wedge on a file we can never process.
                    print("⚠️ [PendingWatchCaptures] Orphan sidecar with no audio — removing \(record.recordingId)")
                    try? fm.removeItem(at: url)
                    try? fm.removeItem(at: transcriptURL(for: record.recordingId))
                    return nil
                }
                return record
            }
            .sorted {
                // Recording order first, then chunk order — the order everything
                // downstream wants, and the order a backlog should ingest in.
                $0.sessionStartedAt == $1.sessionStartedAt
                    ? $0.chunkIndex < $1.chunkIndex
                    : $0.sessionStartedAt < $1.sessionStartedAt
            }
    }

    /// The single definition of "this chunk is still worth working on": it has
    /// no transcript yet and it has not used up its attempts.
    ///
    /// ⚠️ THE `attempts` HALF IS LOAD-BEARING. Without it the give-up in
    /// `WatchCaptureIngestService.recordFailure` is cosmetic: the counter climbs
    /// and logs "Giving up", but the drain loop reads this list on every
    /// foreground and picks the same doomed file up again forever — re-running
    /// the on-device analyzer over it (burning battery) on every pass, and
    /// wiping the `.failed` state before anyone can see it.
    ///
    /// ⚠️ THE `transcribed` HALF IS EQUALLY LOAD-BEARING now that a chunk is
    /// transcribed the moment it lands and its session may sit for another hour
    /// waiting for the final chunk: without it every drain in that hour would
    /// re-analyse every chunk already done.
    ///
    /// The files stay on disk deliberately: they are the user's only copy, and a
    /// future "retry" affordance needs them. They are simply no longer worked on
    /// automatically.
    static func isTranscribable(_ record: PendingWatchCapture) -> Bool {
        !record.transcribed && record.attempts < maxAttempts
    }

    /// Every chunk still owed on-device transcription, oldest recording first
    /// and in chunk order within a recording, so a backlog is worked through in
    /// the order it was recorded.
    func pending() -> [PendingWatchCapture] {
        let (workable, exhausted) = all().reduce(into: ([PendingWatchCapture](), [PendingWatchCapture]())) {
            $1.attempts >= Self.maxAttempts ? $0.1.append($1) : $0.0.append($1)
        }
        if !exhausted.isEmpty {
            print("⛔️ [PendingWatchCaptures] \(exhausted.count) chunk(s) past \(Self.maxAttempts) attempts — kept on disk, not retried")
        }
        return workable.filter { !$0.transcribed }
    }

    /// Audio whose sidecar is gone is audio nothing will ever process again: the
    /// untranscribed span of a finalized session, or a chunk that arrived after
    /// its session had already become a capture. It is KEPT (it is the only copy
    /// of that span) but not forever — otherwise the app leaks storage that no
    /// screen ever shows.
    private func pruneOrphanAudio(in entries: [URL]) {
        let fm = FileManager.default
        let cutoff = Date().addingTimeInterval(-Self.orphanAudioLifetime)
        for url in entries where url.pathExtension == "m4a" {
            let sidecar = url.deletingPathExtension().appendingPathExtension("json")
            guard !fm.fileExists(atPath: sidecar.path) else { continue }
            let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
            guard let modified, modified < cutoff else { continue }
            print("🧹 [PendingWatchCaptures] Reclaiming orphan audio \(url.lastPathComponent) — no sidecar, older than \(Int(Self.orphanAudioLifetime / 86_400)) days")
            try? fm.removeItem(at: url)
        }
    }

    /// Recordings that have exhausted their attempts and will not be retried.
    /// Session-level on purpose: one dead chunk out of four is a gap to work
    /// around, not a lost recording — only a session with NO chunk left under
    /// the limit has actually been given up on.
    func stuckSessions() -> [WatchCaptureSession] {
        sessions().filter(\.isExhausted)
    }

    /// Remove all three files for one chunk. Called only after its whole
    /// session has been successfully turned into a capture AND this chunk's text
    /// is part of it.
    func remove(_ recordingId: UUID) {
        try? FileManager.default.removeItem(at: audioURL(for: recordingId))
        removeBookkeeping(recordingId)
    }

    /// Take a chunk out of the queue but LEAVE ITS AUDIO. For a chunk that
    /// contributed nothing to the capture — its transcription ran out of
    /// attempts, or a bounded wait expired before the analyzer reached it — the
    /// `.m4a` is the only surviving copy of that span: the watch deletes its own
    /// the moment WCSession reports the transfer. Dropping the sidecar is what
    /// stops the drain from working on it again (and stops Home from calling the
    /// whole recording failed); `pruneOrphanAudio` reclaims the audio later.
    func removeBookkeeping(_ recordingId: UUID) {
        try? FileManager.default.removeItem(at: sidecarURL(for: recordingId))
        try? FileManager.default.removeItem(at: transcriptURL(for: recordingId))
    }

    // MARK: - Sessions

    /// Every chunk on disk grouped into recordings, oldest RECORDING first and
    /// chunks in index order inside each — so a session that arrived 2, 0, 1
    /// still assembles 0, 1, 2. Includes sessions whose chunks have exhausted
    /// their attempts; callers decide what that means.
    func sessions() -> [WatchCaptureSession] {
        Dictionary(grouping: all(), by: \.sessionId)
            .map { WatchCaptureSession(sessionId: $0.key, chunks: $0.value.sorted { $0.chunkIndex < $1.chunkIndex }) }
            .sorted { $0.sessionStartedAt < $1.sessionStartedAt }
    }
}

// MARK: - Watch window constants

/// The slack the WATCH applies either side of a meeting when deciding which one a
/// recording belongs to (`WatchMeeting.slack` in the watch target — the two
/// targets share no code, so the value is mirrored here deliberately). The phone
/// uses it to decide which finished meetings are still worth sending.
enum WatchMeetingWindow {
    static let slack: TimeInterval = 15 * 60
}

// MARK: - WatchConnectivityService

/// Activates `WCSession` on the phone and receives files from the watch.
final class WatchConnectivityService: NSObject {
    static let shared = WatchConnectivityService()

    private var cancellables = Set<AnyCancellable>()

    private override init() { super.init() }

    /// Called once at app launch. Safe to call again — `activate()` on an already
    /// activated session is a no-op.
    func activate() {
        guard WCSession.isSupported() else {
            print("[WatchConnectivity] WCSession not supported on this device")
            return
        }
        PendingWatchCaptures.shared.ensureDirectory()
        let session = WCSession.default
        session.delegate = self
        session.activate()
        observeCalendar()
        print("[WatchConnectivity] activate() called")
    }

    // MARK: - Calendar → watch

    /// The watch has no network and no session of its own, so it cannot know what
    /// is on the calendar. The phone pushes the next 24h as an APPLICATION
    /// CONTEXT — a single latest-value slot the system holds and delivers even
    /// when the watch app is not running, which is exactly the shape of "here is
    /// the current calendar". (A message would need both apps awake; a file
    /// transfer would queue every update forever.)
    ///
    /// ⚠️ EVERY SINK HOPS THE MAIN QUEUE FIRST. `@Published` delivers to
    /// subscribers in `willSet` — BEFORE the property holds its new value — so a
    /// `pushContext()` called straight from the sink would assemble the payload
    /// out of the state as it was a moment ago and push the PREVIOUS workspace
    /// list (or calendar) to the watch, with nothing after it to correct the
    /// mistake. `.receive(on: DispatchQueue.main)` defers to the next turn, by
    /// which time the write has landed.
    private func observeCalendar() {
        Task { @MainActor in
            CalendarAPIService.shared.$upcoming
                .removeDuplicates()
                .receive(on: DispatchQueue.main)
                .sink { [weak self] _ in
                    self?.pushContext()
                }
                .store(in: &self.cancellables)

            // The workspace half of the SAME payload. It has its own triggers —
            // bootstrap filling the list, a switch changing the active one — and
            // each of them pushes the WHOLE context, never a workspace-only one.
            // Dedupe on WHAT THE WATCH ACTUALLY CONSUMES, not on ids: a rename (or
            // a slug change) leaves the id list identical, so an id-only
            // `removeDuplicates` would swallow it and the watch would show the old
            // name for ever.
            WorkspaceService.shared.$workspaces
                .map { $0.map { "\($0.id.uuidString)|\($0.name)|\($0.slug)" } }
                .removeDuplicates()
                .receive(on: DispatchQueue.main)
                .sink { [weak self] _ in
                    self?.pushContext()
                }
                .store(in: &self.cancellables)

            WorkspaceService.shared.$workspaceId
                .removeDuplicates()
                .receive(on: DispatchQueue.main)
                .sink { [weak self] _ in
                    self?.pushContext()
                }
                .store(in: &self.cancellables)

            // `hasLoadedWorkspaces` is what tells the watch an EMPTY list is real
            // rather than "we haven't looked". It can flip without `$workspaces`
            // changing (a re-bootstrap that refills an identical list), so it gets
            // its own trigger.
            WorkspaceService.shared.$hasLoadedWorkspaces
                .removeDuplicates()
                .receive(on: DispatchQueue.main)
                .sink { [weak self] _ in
                    self?.pushContext()
                }
                .store(in: &self.cancellables)
        }
    }

    /// ⚠️ THE ONE AND ONLY PUSH. `updateApplicationContext` REPLACES the entire
    /// dictionary — it does not merge — so there must never be a second call site
    /// that sends "just the workspaces" or "just the calendar": each such push
    /// would silently wipe the other half, and the bug would present as meeting
    /// titles or the workspace list randomly vanishing on the watch.
    ///
    /// The fix is structural rather than a comment: this function is the only
    /// thing that calls `updateApplicationContext`, and it ASSEMBLES THE WHOLE
    /// CONTEXT from live state every time, whichever trigger woke it. Adding a
    /// third kind of context means adding a key here, not another push.
    ///
    /// Property-list types only — `updateApplicationContext` throws on anything
    /// else. A `Date` is not a plist type in this API's eyes, so times go as epoch
    /// `TimeInterval`s, and a `UUID` is not either, so ids go as strings.
    @MainActor
    func pushContext() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated else {
            print("[WatchConnectivity] context deferred — session not activated")
            return
        }

        var payload: [String: Any] = [:]
        payload.merge(calendarPayload()) { current, _ in current }
        payload.merge(workspacePayload()) { current, _ in current }

        do {
            try session.updateApplicationContext(payload)
            let meetingCount = (payload["meetings"] as? [[String: Any]])?.count ?? 0
            let workspaceCount = (payload["workspaces"] as? [[String: Any]])?.count ?? 0
            print("📅➡️⌚️ [WatchConnectivity] pushed context — keys \(payload.keys.sorted()), \(meetingCount) meeting(s) (loaded=\(payload["loaded"] as? Bool ?? false)), \(workspaceCount) workspace(s) (loaded=\(payload["workspacesLoaded"] as? Bool ?? false)), active=\((payload["activeWorkspaceId"] as? String)?.prefix(8).description ?? "—")…")
        } catch {
            // Not activated, or the watch is unavailable. The next push (or the
            // next activation) carries the same information; nothing is lost.
            print("[WatchConnectivity] context push failed: \(error.localizedDescription)")
        }
    }

    /// Every workspace the user belongs to, plus which one the phone is currently
    /// in. The watch uses the latter only as its default before the user has
    /// chosen; the choice itself lives on the watch.
    @MainActor
    private func workspacePayload() -> [String: Any] {
        let service = WorkspaceService.shared
        let rows: [[String: Any]] = service.workspaces.compactMap { workspace in
            let name = workspace.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { return nil }
            // The slug rides along because two workspaces can legitimately share
            // a name — the signup trigger names them after their owner — and a
            // watch picker of identical rows is unusable. iOS Settings already
            // solved this the same way; the watch must not reintroduce it.
            return [
                "id": workspace.id.uuidString,
                "name": name,
                "slug": workspace.slug
            ]
        }
        // Same honesty flag the calendar half carries: `workspaces` is empty
        // before bootstrap and after sign-out, and the watch persists what it
        // receives.
        //
        // ⚠️ `hasLoadedWorkspaces`, NEVER `hasBootstrapped`. The latter is set in
        // a `defer` that runs when bootstrap THROWS, and is true even when the
        // non-fatal `workspace` query came back empty — so one offline launch
        // would push `{workspaces: [], workspacesLoaded: true}`, the watch would
        // believe it, and the user's persisted workspace choice would be deleted.
        var payload: [String: Any] = [
            "workspaces": rows,
            "workspacesLoaded": service.hasLoadedWorkspaces
        ]
        if let active = service.workspaceId {
            payload["activeWorkspaceId"] = active.uuidString
        }
        return payload
    }

    @MainActor
    private func calendarPayload() -> [String: Any] {
        let loaded = CalendarAPIService.shared.hasLoaded
        let source = CalendarAPIService.shared.upcoming

        // ⚠️ NEVER PUSH AN EMPTY LIST WE DO NOT BELIEVE IN. `upcoming` is blanked
        // synchronously on a workspace switch and is still `[]` on a cold launch
        // before anything has fetched; the `$upcoming` sink fires on exactly that
        // value. The watch persists what it receives, so one such push over a good
        // list — followed by a refresh that fails offline or on an expired token —
        // permanently wipes the watch's offline calendar, and the meeting the user
        // walks into gets named "New recording".
        //
        // With one merged payload the response is to OMIT THE KEY, not to skip
        // the push: the workspace half of the same context still has to reach the
        // watch. A context with no `meetings` key leaves the watch's stored
        // calendar exactly as it was — which is what the old early `return` did.
        guard loaded || !source.isEmpty else {
            print("[WatchConnectivity] calendar half omitted — nothing loaded yet, not clobbering the watch")
            return [:]
        }

        let now = Date()
        let cutoff = now.addingTimeInterval(24 * 60 * 60)
        // The watch pads every window by ±15 minutes and keeps the list across
        // launches, so a meeting that finished hours ago would still be eligible to
        // name a recording — and `hasMeetingTitle` would then suppress
        // generate-title, leaving the capture permanently misnamed. Drop anything
        // already outside that padding.
        let floor = now.addingTimeInterval(-WatchMeetingWindow.slack)
        let meetings: [[String: Any]] = source.compactMap { capture in
            guard let start = capture.scheduledStart, start <= cutoff else { return nil }
            // Missing end: assume the default meeting length rather than dropping
            // the row — a titled meeting with a guessed end still names a capture
            // correctly, and the watch pads the window by 15 minutes anyway.
            let end = capture.scheduledEnd ?? start.addingTimeInterval(30 * 60)
            guard end >= floor else { return nil }
            let title = capture.title.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { return nil }
            return [
                "title": title,
                "start": start.timeIntervalSince1970,
                "end": end.timeIntervalSince1970
            ]
        }

        // `loaded` tells the watch whether an empty list means "nothing
        // scheduled" or "we haven't looked" — it refuses to persist the latter
        // over a good list.
        return ["meetings": meetings, "loaded": loaded]
    }
}

extension WatchConnectivityService: WCSessionDelegate {
    func session(_ session: WCSession,
                 activationDidCompleteWith activationState: WCSessionActivationState,
                 error: Error?) {
        if let error {
            print("❌ [WatchConnectivity] activation failed: \(error.localizedDescription)")
            return
        }
        print("[WatchConnectivity] activated (state \(activationState.rawValue), paired=\(session.isPaired), watchAppInstalled=\(session.isWatchAppInstalled))")
        // Anything that arrived while the app was dead is already on disk; nudge
        // the ingest service so it drains without waiting for a foreground event.
        NotificationCenter.default.post(name: .watchCaptureFileReceived, object: nil)
        // Seed the watch with the calendar. The publisher only fires on CHANGE, so
        // without this a launch with an unchanged calendar would never push
        // anything — and nothing else refreshes on a timer, so `upcoming` is
        // whatever Home last fetched (possibly hours ago, possibly never). Refresh
        // FIRST so the list that reaches the watch is current; `refresh()` never
        // throws and keeps the previous list on failure, and the push below is
        // gated on `hasLoaded` either way.
        Task { @MainActor in
            await CalendarAPIService.shared.refresh()
            WatchConnectivityService.shared.pushContext()
        }
    }

    /// The iPhone can be paired to a different watch at runtime. The session must
    /// be deactivated and re-activated for the new pairing, or every subsequent
    /// transfer is dropped.
    func sessionDidBecomeInactive(_ session: WCSession) {
        print("[WatchConnectivity] session became inactive")
    }

    func sessionDidDeactivate(_ session: WCSession) {
        print("[WatchConnectivity] session deactivated — re-activating for the new pairing")
        WCSession.default.activate()
    }

    /// ⚠️ CALLED ON A BACKGROUND THREAD, AND `file.fileURL` DIES WHEN THIS RETURNS.
    /// Everything between here and `moveItem` must be synchronous.
    func session(_ session: WCSession, didReceive file: WCSessionFile) {
        let metadata = file.metadata ?? [:]
        let recordingId = (metadata["recordingId"] as? String).flatMap(UUID.init(uuidString:)) ?? UUID()
        let startedAtEpoch = metadata["startedAt"] as? TimeInterval
        let duration = metadata["duration"] as? Double ?? 0
        let source = metadata["source"] as? String ?? "watch"
        let schema = metadata["schema"] as? Int ?? 1
        let title = (metadata["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasMeetingTitle = metadata["hasMeetingTitle"] as? Bool ?? false

        // ── Session identity (schema 3) ─────────────────────────────────────
        // BACKWARD COMPATIBILITY (design point 10): a schema-≤2 sender has none
        // of these keys, and a file from one may still be in flight from a watch
        // that hasn't updated. The defaults below ARE the compatibility rule —
        // a single file is a one-chunk session — and they are the same defaults
        // the sidecar decoder applies to a record already on disk.
        let sessionId = (metadata["sessionId"] as? String).flatMap(UUID.init(uuidString:)) ?? recordingId
        let chunkIndex = metadata["chunkIndex"] as? Int ?? 0
        let isFinal = metadata["isFinal"] as? Bool ?? true
        // Present ONLY on the final chunk. nil on a mid-session chunk is what
        // makes the session read as "still arriving".
        let declaredTotal = metadata["totalChunks"] as? Int ?? (isFinal ? chunkIndex + 1 : nil)
        let sessionStartedAtEpoch = metadata["sessionStartedAt"] as? TimeInterval ?? startedAtEpoch
        let chunkStartOffset = metadata["chunkStartOffset"] as? Double ?? 0
        // ── Workspace routing (schema 4) ────────────────────────────────────
        // The workspace the user picked ON THE WATCH. Absent from every schema-≤3
        // sender, and from a watch that has no list yet: nil then means "use the
        // phone's active workspace", which is exactly what every recording did
        // before this field existed.
        let workspaceId = (metadata["workspaceId"] as? String).flatMap(UUID.init(uuidString:))

        let store = PendingWatchCaptures.shared
        store.ensureDirectory()
        let destination = store.audioURL(for: recordingId)

        // A retransmit of a recording we already hold: replace it rather than
        // failing the move and losing the newer copy.
        if FileManager.default.fileExists(atPath: destination.path) {
            try? FileManager.default.removeItem(at: destination)
        }

        do {
            try FileManager.default.moveItem(at: file.fileURL, to: destination)
        } catch {
            print("❌ [WatchConnectivity] didReceive: move FAILED for \(recordingId) — \(error.localizedDescription). Recording lost.")
            return
        }

        // ⚠️ ALREADY A CAPTURE. A chunk of a session the phone has finished with
        // must never seed a new one: with no sidecars left to read a captureId
        // from, it would look like a fresh recording and become a SECOND capture
        // for the same meeting (most likely after the `noFinalChunk` wait, whose
        // whole shape — one lone non-final chunk — this reproduces exactly).
        //
        // The audio stays where it was just moved, deliberately: that span is not
        // in the capture and this is the only copy of it. With no sidecar it is
        // inert — nothing enumerates it — and `pruneOrphanAudio` reclaims it
        // after a week.
        if let tombstone = store.finalized(sessionId) {
            print("🪦 [WatchConnectivity] chunk \(chunkIndex) of session \(sessionId.uuidString.prefix(8))… arrived AFTER that session was finalized as capture \(tombstone.captureId?.uuidString.prefix(8).description ?? "—")… — audio kept at \(destination.lastPathComponent), no sidecar written, no second capture")
            return
        }

        let size = ((try? FileManager.default.attributesOfItem(atPath: destination.path))?[.size] as? Int) ?? 0
        print("📥 [WatchConnectivity] didReceive \(recordingId) ws=\(workspaceId?.uuidString.prefix(8).description ?? "—")… — \(size) bytes, \(String(format: "%.1f", duration))s, session \(sessionId.uuidString.prefix(8))… chunk \(chunkIndex)\(isFinal ? " (FINAL of \(declaredTotal.map(String.init) ?? "?"))" : "") schema \(schema)")

        // Preserve a captureId from an earlier partial run of the same session.
        // Adopt it from ANY chunk of the session, not just this chunk's own
        // sidecar: the row is created once for the whole recording, and a
        // retransmitted chunk arriving after finalization started must not look
        // like a brand-new session.
        let existingCaptureId = store.read(recordingId)?.captureId
            ?? store.all().first { $0.sessionId == sessionId && $0.captureId != nil }?.captureId
        let record = PendingWatchCapture(
            recordingId: recordingId,
            startedAt: startedAtEpoch.map { Date(timeIntervalSince1970: $0) } ?? Date(),
            durationSeconds: duration,
            source: source,
            schema: schema,
            captureId: existingCaptureId,
            attempts: 0,
            title: (title?.isEmpty == false) ? title : nil,
            hasMeetingTitle: hasMeetingTitle,
            workspaceId: workspaceId,
            sessionId: sessionId,
            chunkIndex: chunkIndex,
            isFinal: isFinal,
            totalChunks: declaredTotal,
            sessionStartedAt: sessionStartedAtEpoch.map { Date(timeIntervalSince1970: $0) },
            chunkStartOffset: chunkStartOffset,
            // The PHONE's clock, deliberately: this is what the bounded waits in
            // `WatchSessionGrace` are measured from, and a re-delivered chunk
            // legitimately resets its own wait.
            receivedAt: Date(),
            transcribed: false
        )
        // A retransmit replaced the audio above, so any transcript we held for
        // this chunk describes a file that no longer exists. Drop it — the
        // `transcribed: false` on the new record would otherwise be contradicted
        // by a stale `.txt` on the next assembly.
        try? FileManager.default.removeItem(at: store.transcriptURL(for: recordingId))
        store.write(record)
        if let title, !title.isEmpty {
            print("🏷️ [WatchConnectivity] title from watch: \"\(title)\" (meeting=\(hasMeetingTitle))")
        }

        NotificationCenter.default.post(name: .watchCaptureFileReceived, object: nil)
    }

    /// Non-file messages are unused today; implemented so the delegate is complete
    /// and an unexpected send is visible in the log rather than silent.
    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        print("[WatchConnectivity] didReceiveMessage: \(message.keys.sorted())")
    }
}
