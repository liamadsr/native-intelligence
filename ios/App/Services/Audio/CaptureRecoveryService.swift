//
//  CaptureRecoveryService.swift
//  dial8
//
//  Finishes captures the app was killed in the middle of.
//
//  THE BUG THIS EXISTS FOR
//  -----------------------
//  The recorder creates the server-side capture row at START
//  (`POST /api/account/captures`) so the transcript can stream into a row that
//  already exists — see iOSRecordingService.createServerCapture. Everything that
//  turns that row into a note happens at STOP: the finalizing PATCH (ended_at),
//  the batch extraction (summary + actions), the title pass.
//
//  If the app dies in between — force-quit, crash, jetsam while backgrounded —
//  the row is stranded: `ended_at` NULL, possibly a perfectly good transcript,
//  and nothing on any device that will ever finish it. Observed in production.
//  On Home it showed as "Processing…" for fifteen minutes and then as a
//  permanently empty note.
//
//  THE FIX
//  -------
//  The recorder writes a breadcrumb to UserDefaults the moment the row exists
//  and removes it once the capture is confirmed ended (or deleted). At launch
//  and on every foreground, this service reads the breadcrumb and finishes what
//  the recorder could not:
//
//    row is gone            → clear the record, nothing to do
//    ended_at already set   → if the batch never ran, run it; then clear
//    transcript non-empty   → end it, then run the SAME post-capture pass the
//                             normal stop path runs (batch → title → refresh)
//    transcript empty       → nothing was ever said; delete the row rather than
//                             leave an empty note behind
//
//  The breadcrumb survives until the WHOLE pass is done — end AND batch AND
//  title — not merely until `ended_at` lands. A kill during the batch leaves a
//  row that is ended but summary-less, which `Note.isInterrupted` cannot see
//  (it requires `ended_at == nil`); without the breadcrumb nothing would ever
//  look at that row again.
//
//  The server transcript is the only source of truth here. Whatever the dead
//  process had buffered in memory is gone, and reconstructing it is not
//  possible — appends were flushed on a 15s cadence, so a recovered capture may
//  be missing its last few seconds. That is the honest outcome, and it is
//  strictly better than the alternative of losing everything.
//

import Foundation
import UIKit

// MARK: - The breadcrumb

/// The record written at capture-create and removed at capture-end. Codable and
/// deliberately tiny — it is read by a process that knows nothing else about the
/// session that wrote it.
struct InFlightCapture: Codable, Equatable {
    let captureId: UUID
    /// When recording began. Recovery derives `duration_seconds` from it, since
    /// the elapsed counter died with the process.
    let startedAt: Date
    /// The workspace the capture belongs to. Recovery refuses to finish a
    /// capture belonging to a workspace the user has since switched away from:
    /// every write goes through `CaptureAPIService`, whose `x-workspace-id`
    /// header is stamped from the workspace active RIGHT NOW, and the website's
    /// PATCH filters on `workspace_id` — so a cross-workspace attempt is a
    /// guaranteed 500, forever, on every launch.
    let workspaceId: UUID?
    /// How many times recovery has tried and failed for this capture. Bounded so
    /// a permanently failing capture stops burning a request on every foreground.
    var failureCount: Int?
    /// The user discarded this recording and the server DELETE did not land.
    /// Recovery must finish the deletion, never salvage it — summarizing a
    /// recording somebody explicitly threw away is worse than losing it.
    var discarded: Bool?

    init(
        captureId: UUID,
        startedAt: Date,
        workspaceId: UUID?,
        failureCount: Int? = nil,
        discarded: Bool? = nil
    ) {
        self.captureId = captureId
        self.startedAt = startedAt
        self.workspaceId = workspaceId
        self.failureCount = failureCount
        self.discarded = discarded
    }
}

/// UserDefaults-backed store for the in-flight record. A single slot: iOS records
/// one capture at a time.
final class InFlightCaptureStore {
    static let shared = InFlightCaptureStore()

    static let defaultsKey = "dial8.capture.inflight"

    private let defaults: UserDefaults
    private init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load() -> InFlightCapture? {
        guard let data = defaults.data(forKey: Self.defaultsKey) else { return nil }
        guard let record = try? JSONDecoder().decode(InFlightCapture.self, from: data) else {
            // Unreadable (a shape change across versions) — drop it rather than
            // trip over it on every launch forever.
            defaults.removeObject(forKey: Self.defaultsKey)
            return nil
        }
        return record
    }

    func save(_ record: InFlightCapture) {
        guard let data = try? JSONEncoder().encode(record) else { return }
        defaults.set(data, forKey: Self.defaultsKey)
        print("📌 [CaptureRecovery] Tracking in-flight capture \(record.captureId.uuidString.prefix(8))…")
    }

    /// Remove the record — but only if it is still the one named. A stale clear
    /// from a previous session must never wipe the breadcrumb of the recording
    /// that is happening right now.
    func clear(captureId: UUID) {
        guard let current = load() else { return }
        guard current.captureId == captureId else { return }
        defaults.removeObject(forKey: Self.defaultsKey)
    }

    func clearAll() {
        defaults.removeObject(forKey: Self.defaultsKey)
    }

    /// Mark the record as a discard whose server DELETE has not landed yet, so
    /// the next recovery pass removes the row instead of summarizing it.
    func markDiscarded(captureId: UUID) {
        guard var current = load(), current.captureId == captureId else { return }
        current.discarded = true
        if let data = try? JSONEncoder().encode(current) {
            defaults.set(data, forKey: Self.defaultsKey)
            print("🗑️ [CaptureRecovery] \(captureId.uuidString.prefix(8))… marked discarded — recovery will delete it")
        }
    }

    /// Bump the failure counter for a capture and return the new total. A record
    /// that has failed too many times is dropped rather than retried on every
    /// foreground for the rest of the install's life — the note still shows its
    /// Interrupted row, so the user keeps a manual way in.
    @discardableResult
    func recordFailure(captureId: UUID, limit: Int) -> Int {
        guard var current = load(), current.captureId == captureId else { return 0 }
        let next = (current.failureCount ?? 0) + 1
        if next >= limit {
            print("♻️ [CaptureRecovery] \(captureId.uuidString.prefix(8))… failed \(next)× — giving up on automatic recovery")
            defaults.removeObject(forKey: Self.defaultsKey)
            return next
        }
        current.failureCount = next
        if let data = try? JSONEncoder().encode(current) {
            defaults.set(data, forKey: Self.defaultsKey)
        }
        return next
    }
}

// MARK: - The outcome

/// What one recovery attempt actually did. The manual "Finish processing" button
/// renders all four differently — a bare Bool collapsed "deleted the row",
/// "couldn't reach the server" and "wrong workspace" into the same silent no-op.
enum CaptureRecoveryOutcome: Equatable {
    /// Ended and/or batched — the note now has (or is getting) a summary.
    case processed
    /// Nothing was ever said; the empty row was removed from the server.
    case deletedEmpty
    /// The capture belongs to a workspace other than the active one. Nothing was
    /// attempted: every write would be scoped to the wrong workspace and fail.
    case wrongWorkspace
    /// The attempt failed. `message` is the server's own words where there are any.
    case failed(message: String?)

    var didProcess: Bool { self == .processed }
}

// MARK: - The recovery service

@MainActor
final class CaptureRecoveryService: ObservableObject {
    static let shared = CaptureRecoveryService()

    /// Serializes recovery. Launch and the first foreground can arrive within
    /// milliseconds of each other, and two passes over the same record would end
    /// the same capture twice and run the batch twice.
    private var isRecovering = false

    /// Ids currently being recovered, so the manual "Finish processing" button
    /// and the automatic pass cannot double up on one capture.
    private var inProgressIds: Set<UUID> = []

    private init() {
        NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification,
            object: nil,
            queue: .main
        ) { _ in
            MainActor.assumeIsolated {
                CaptureRecoveryService.shared.start()
            }
        }
    }

    /// Called at launch — and again on every foreground — so a capture stranded
    /// while the app was dead is finished without waiting for the user to do
    /// anything. Re-entrant: `recoverIfNeeded` holds the actual guard.
    ///
    /// Waits for the Supabase session to be restored first: every branch of
    /// recovery is an authenticated call, and running before the session lands
    /// would read as "capture not found" and throw away a salvageable recording.
    func start() {
        Task {
            await Self.awaitAuthenticatedSession()
            await recoverIfNeeded()
        }
    }

    /// Poll until the initial session check has completed. Bounded — if there is
    /// no signed-in user, recovery simply has nothing it can do and the record
    /// waits for a launch where there is one.
    private static func awaitAuthenticatedSession() async {
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            // The workspace matters too: the capture routes scope by the
            // x-workspace-id header, and without it a multi-workspace user's
            // recovery would be routed to their FIRST membership rather than the
            // one the capture belongs to.
            let ready = await MainActor.run {
                SupabaseManager.shared.hasCheckedInitialSession
                    && SupabaseManager.shared.currentUser != nil
                    && WorkspaceService.shared.workspaceId != nil
            }
            if ready { return }
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
    }

    // MARK: - Automatic recovery

    /// Finish the capture named by the breadcrumb, if there is one. Idempotent
    /// and safe to call repeatedly.
    func recoverIfNeeded() async {
        #if DEBUG
        // Escape hatch for testing the Interrupted UI: with this argument the
        // automatic pass is skipped, so an abandoned capture stays abandoned and
        // the "This recording didn't finish" row can be exercised by hand.
        if ProcessInfo.processInfo.arguments.contains("-skipCaptureRecovery") {
            print("♻️ [CaptureRecovery] Skipped — launched with -skipCaptureRecovery")
            return
        }
        #endif

        guard !isRecovering else { return }

        // A live recording owns the capture named in the record — that is not an
        // abandoned capture, it is the one being made right now.
        guard !iOSRecordingService.shared.hasActiveSession else {
            print("♻️ [CaptureRecovery] Live recording in progress — skipping")
            return
        }

        guard let record = InFlightCaptureStore.shared.load() else { return }

        isRecovering = true
        defer { isRecovering = false }

        print("♻️ [CaptureRecovery] Found in-flight capture \(record.captureId.uuidString.prefix(8))… started \(Self.describe(record.startedAt))")

        // The recorded workspace is the one every write has to be scoped to. If
        // the user has since switched, leave the breadcrumb alone and wait for a
        // launch in the right workspace — retrying here would 500 forever.
        if let recorded = record.workspaceId,
           let active = WorkspaceService.shared.workspaceId,
           recorded != active {
            print("♻️ [CaptureRecovery] \(record.captureId.uuidString.prefix(8))… belongs to workspace \(recorded.uuidString.prefix(8))… but \(active.uuidString.prefix(8))… is active — skipping until that workspace is selected")
            return
        }

        let outcome = await recover(
            captureId: record.captureId,
            startedAt: record.startedAt,
            discarded: record.discarded == true
        )

        // Bound the retries. A capture that cannot be finished — a server that
        // keeps rejecting it, a row the user can no longer write — must not cost
        // a request on every foreground for the rest of the install's life.
        if case .failed = outcome {
            InFlightCaptureStore.shared.recordFailure(
                captureId: record.captureId,
                limit: Self.maxAutomaticAttempts
            )
        }
    }

    /// Automatic attempts allowed before the breadcrumb is dropped. The note keeps
    /// its Interrupted row either way, so the user still has a manual way in.
    static let maxAutomaticAttempts = 5

    // MARK: - Manual recovery (the "Finish processing" button)

    /// Finish one specific capture, whatever the breadcrumb says. This is the
    /// detail view's "Finish processing" path: the user is looking at a note that
    /// says its recording didn't finish, and the record may well be gone (the
    /// interruption predates this feature, or happened on another device).
    ///
    /// - Returns: what actually happened — see `CaptureRecoveryOutcome`. The
    ///   caller needs the distinction: a deleted row and an unreachable server
    ///   both mean "no summary appeared", but only one of them is worth retrying.
    @discardableResult
    func recover(
        captureId: UUID,
        startedAt: Date? = nil,
        discarded: Bool = false
    ) async -> CaptureRecoveryOutcome {
        guard !inProgressIds.contains(captureId) else {
            print("♻️ [CaptureRecovery] \(captureId.uuidString.prefix(8))… already being recovered — skipping")
            return .failed(message: nil)
        }
        inProgressIds.insert(captureId)
        defer { inProgressIds.remove(captureId) }

        let short = captureId.uuidString.prefix(8)

        // 1. What does the server actually hold?
        let note: Note
        do {
            note = try await NotesService.shared.fetchNote(by: captureId)
        } catch {
            // Gone (deleted elsewhere) or unreachable. Clearing on an unreachable
            // server would lose a recoverable capture, so only clear when the row
            // is genuinely absent.
            if Self.isNotFound(error) {
                print("♻️ [CaptureRecovery] Capture \(short)… no longer exists — clearing record")
                InFlightCaptureStore.shared.clear(captureId: captureId)
                return .deletedEmpty
            }
            print("♻️ [CaptureRecovery] Could not fetch \(short)… (\(error.localizedDescription)) — leaving the record for the next attempt")
            return .failed(message: error.localizedDescription)
        }

        // 1b. The row's OWN workspace is the authoritative check — `fetchNote`
        //     reads by id + user_id with no workspace filter, so it happily
        //     returns a capture from any workspace the user belongs to, while
        //     every write below is stamped with the ACTIVE workspace and would be
        //     rejected server-side. This also guards the manual button, which can
        //     be reached for any note the fetch can read.
        if let rowWorkspace = note.workspaceId,
           let active = WorkspaceService.shared.workspaceId,
           rowWorkspace != active {
            print("♻️ [CaptureRecovery] Capture \(short)… lives in workspace \(rowWorkspace.uuidString.prefix(8))…, active is \(active.uuidString.prefix(8))… — refusing to write cross-workspace")
            return .wrongWorkspace
        }

        // 1c. The user discarded this recording and the DELETE never landed.
        //     Finish the deletion — do NOT salvage it, transcript or not.
        if discarded {
            print("♻️ [CaptureRecovery] Capture \(short)… was discarded by the user — completing the deletion")
            return await deleteRow(captureId: captureId, short: short)
        }

        // 2. Already ended? Either the finalizing PATCH landed and only the local
        //    bookkeeping was lost, or — the case the breadcrumb now outlives —
        //    the app died between the PATCH and the batch.
        if let endedAt = note.endedAt {
            // The batch may never have run (killed between the PATCH and the
            // batch call). If there is a transcript but no summary, finish it.
            if Self.hasTranscript(note) && !Self.hasSummary(note) {
                print("♻️ [CaptureRecovery] Capture \(short)… ended at \(Self.describe(endedAt)) but has no summary — running post-capture processing")
                let batched = await iOSRecordingService.runPostCaptureProcessing(captureId: captureId)
                guard batched else {
                    print("♻️ [CaptureRecovery] Batch failed for \(short)… — leaving the record for the next attempt")
                    return .failed(message: "Summary generation failed")
                }
                // Cleared only now: the pass is genuinely over.
                InFlightCaptureStore.shared.clear(captureId: captureId)
                return .processed
            }
            print("♻️ [CaptureRecovery] Capture \(short)… already ended at \(Self.describe(endedAt)) — clearing record")
            InFlightCaptureStore.shared.clear(captureId: captureId)
            return .processed
        }

        // 3. Un-ended with a transcript: salvage it.
        if Self.hasTranscript(note) {
            let started = startedAt ?? note.startedAt ?? note.recordedAt ?? note.createdAt
            // Clamped: a capture abandoned days ago would otherwise report a
            // duration in the hundreds of thousands of seconds, which is both
            // false and a billing-shaped lie. Six hours is longer than any real
            // recording and short enough to stay sane.
            let duration = Int(max(0, min(Date().timeIntervalSince(started), Self.maxRecoveredDuration)))
            print("♻️ [CaptureRecovery] Capture \(short)… has a transcript — ending it (duration \(duration)s)")

            do {
                try await CaptureAPIService.shared.endCapture(
                    captureId: captureId,
                    endedAt: Date(),
                    durationSeconds: duration
                )
            } catch {
                print("♻️ [CaptureRecovery] endCapture failed for \(short)…: \(error.localizedDescription) — leaving the record for the next attempt")
                return .failed(message: error.localizedDescription)
            }

            print("♻️ [CaptureRecovery] Ended \(short)… — running batch extraction + title")
            // The exact pass the normal stop path runs, so a recovered capture is
            // indistinguishable from a saved one. The breadcrumb stays alive
            // across it: a kill DURING the batch must still be recoverable, and
            // step 2 above is written for exactly that state.
            let batched = await iOSRecordingService.runPostCaptureProcessing(captureId: captureId)
            guard batched else {
                // The row IS ended now, so it will come back through step 2 next
                // time. Keep the breadcrumb — that is the only thing that will
                // bring it back, since an ended row is not `isInterrupted`.
                print("♻️ [CaptureRecovery] Ended \(short)… but the batch failed — leaving the record for the next attempt")
                return .failed(message: "Summary generation failed")
            }
            InFlightCaptureStore.shared.clear(captureId: captureId)
            print("♻️ [CaptureRecovery] Recovery complete for \(short)…")
            return .processed
        }

        // 4. Un-ended with nothing in it: an empty row nobody wants to see.
        print("♻️ [CaptureRecovery] Capture \(short)… has no transcript — deleting the empty row")
        return await deleteRow(captureId: captureId, short: short)
    }

    /// Remove a capture row that should not exist — an empty one, or one the user
    /// discarded whose DELETE never landed. The record is cleared only on success.
    private func deleteRow(captureId: UUID, short: Substring) async -> CaptureRecoveryOutcome {
        do {
            try await NotesService.shared.deleteNote(id: captureId)
            InFlightCaptureStore.shared.clear(captureId: captureId)
            print("♻️ [CaptureRecovery] Deleted capture \(short)…")
            return .deletedEmpty
        } catch {
            print("♻️ [CaptureRecovery] Delete failed for \(short)…: \(error.localizedDescription) — leaving the record for the next attempt")
            return .failed(message: error.localizedDescription)
        }
    }

    // MARK: - Helpers

    /// Ceiling on a derived duration — see the call site.
    private static let maxRecoveredDuration: TimeInterval = 6 * 60 * 60

    private static func hasTranscript(_ note: Note) -> Bool {
        !(note.transcript?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
    }

    private static func hasSummary(_ note: Note) -> Bool {
        !(note.aiSummary?.isEmpty ?? true) || !(note.summary?.isEmpty ?? true)
    }

    /// PostgREST reports "no rows" from `.single()` as PGRST116. That — and only
    /// that — means the capture is genuinely gone; every other error is a reason
    /// to retry later, not to throw the record away.
    private static func isNotFound(_ error: Error) -> Bool {
        String(describing: error).contains("PGRST116")
    }

    private static func describe(_ date: Date) -> String {
        date.formatted(date: .abbreviated, time: .standard)
    }
}
