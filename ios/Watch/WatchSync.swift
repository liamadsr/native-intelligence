import Foundation
import WatchConnectivity

/// One calendar meeting, as the phone described it in the application context.
struct WatchMeeting: Codable, Equatable {
    let title: String
    let start: Date
    let end: Date

    /// The window in which a recording is considered to belong to this meeting.
    /// A quarter hour either side: people hit record while walking in, and keep
    /// recording through the overrun.
    static let slack: TimeInterval = 15 * 60

    func contains(_ date: Date) -> Bool {
        date >= start.addingTimeInterval(-Self.slack) && date <= end.addingTimeInterval(Self.slack)
    }
}

/// One workspace the signed-in user belongs to, as the phone described it in the
/// application context. The watch never talks to the network, so this list is
/// the only thing it can know about workspaces.
struct WatchWorkspace: Codable, Equatable, Identifiable, Hashable {
    let id: UUID
    let name: String
    /// Unique, short, and the ONLY thing that separates two workspaces the signup
    /// trigger named after the same person. Shown by the selector only when the
    /// names actually collide.
    ///
    /// Optional and decoded with `decodeIfPresent` so a `watch.workspaces.v1` blob
    /// persisted before the slug existed still decodes instead of throwing the
    /// whole list away.
    let slug: String?

    init(id: UUID, name: String, slug: String?) {
        self.id = id
        self.name = name
        self.slug = slug
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        slug = try container.decodeIfPresent(String.self, forKey: .slug)
    }
}

/// WCSession owner on the watch. Queues finished recordings to the iPhone via
/// `transferFile`, and receives the phone's MERGED application context —
/// calendar meetings AND the workspace list — persisting both so a watch that
/// has not heard from its phone since launch still names meetings and still
/// knows which workspace it is recording into.
final class WatchSync: NSObject, ObservableObject {
    static let shared = WatchSync()

    /// Schema version of the metadata dictionary sent alongside each file.
    /// 4 adds `workspaceId`: the workspace SELECTED ON THE WATCH when the
    /// recording was made, on EVERY chunk. Per-chunk rather than per-session
    /// because it is the workspace that was chosen for THAT recording, and
    /// because a lost chunk 0 must not cost the routing. Absent (schema ≤3) means
    /// "no selection" and the phone falls back to its own active workspace.
    /// 2 added `title` / `hasMeetingTitle`.
    /// 3 makes every file ONE CHUNK of a session: `sessionId`, `chunkIndex`,
    /// `isFinal`, `totalChunks` (final chunk only), `sessionStartedAt` and
    /// `chunkStartOffset`. `recordingId`, `startedAt` and `duration` keep their
    /// names but are now per-CHUNK, and `title` / `hasMeetingTitle` ride on every
    /// chunk so losing chunk 0 never costs the meeting name.
    static let metadataSchema = 4

    @Published private(set) var isReachable: Bool = false
    @Published private(set) var isActivated: Bool = false
    /// The phone's next-24h calendar, newest push wins. Persisted so a watch app
    /// relaunched out of range still names the meeting correctly.
    ///
    /// ⚠️ THIS IS A MAIN-THREAD MIRROR FOR THE UI ONLY. `applyContext` runs on
    /// WCSession's background delegate queue and can only assign it
    /// asynchronously, so a `start()` in that window would read the PREVIOUS
    /// value. Title resolution therefore reads `storedMeetings` (below), which is
    /// updated synchronously in the same step that persists.
    @Published private(set) var meetings: [WatchMeeting] = []

    /// The authoritative meeting list, written synchronously inside `applyContext`
    /// and read by `meetingTitle(at:)` from whatever thread asks. `meetings` is
    /// the main-thread mirror of this.
    private let meetingsLock = NSLock()
    private var storedMeetings: [WatchMeeting] = []

    private static let meetingsDefaultsKey = "watch.meetings.v1"

    // MARK: - Workspaces

    /// Every workspace the phone says the user belongs to, name-ordered as the
    /// phone ordered them. Main-thread mirror of `storedWorkspaces`, exactly like
    /// `meetings` mirrors `storedMeetings` and for the same reason.
    @Published private(set) var workspaces: [WatchWorkspace] = []

    /// The workspace the USER picked on the watch, if they have picked one.
    /// `nil` means "never chosen" — which is not the same as "none": the
    /// effective choice then falls back to the phone's own active workspace.
    @Published private(set) var selectedWorkspaceId: UUID?

    /// The authoritative copies, written synchronously inside `applyContext` and
    /// readable from any thread — `WatchRecorder.start()` resolves the recording's
    /// workspace from here at the instant the user hits record, and a push that
    /// landed milliseconds ago must already be visible (same rule as
    /// `storedMeetings`).
    private let workspaceLock = NSLock()
    private var storedWorkspaces: [WatchWorkspace] = []
    private var storedSelection: UUID?
    /// The workspace that is active ON THE PHONE, pushed alongside the list. Used
    /// only as the default before the user has chosen on the watch, so a fresh
    /// watch records into the same place the phone would. Not published: nothing
    /// renders it, and a second mirror to keep in sync would earn nothing.
    private var storedPhoneActive: UUID?

    private static let workspacesDefaultsKey = "watch.workspaces.v1"
    private static let selectionDefaultsKey = "watch.workspace.selectedId.v1"
    private static let phoneActiveDefaultsKey = "watch.workspace.phoneActiveId.v1"

    /// Recording ids with a transferFile already handed to WCSession and not yet finished.
    /// Without this, every flush() (activation, reachability change, stop) queues a duplicate
    /// transfer of the same file and `outstandingFileTransfers` grows without bound.
    private let inFlightLock = NSLock()
    private var inFlight: Set<UUID> = []

    private override init() {
        super.init()
        let restored = Self.loadPersistedMeetings()
        storedMeetings = restored
        meetings = restored
        if !restored.isEmpty {
            print("[WatchSync] restored \(restored.count) meeting(s) from UserDefaults")
        }

        // The workspace list AND the selection are persisted, so a relaunch —
        // or a watch that has not heard from the phone since — still shows and
        // records into the right workspace (design point 6).
        let restoredWorkspaces = Self.loadPersistedWorkspaces()
        storedWorkspaces = restoredWorkspaces
        workspaces = restoredWorkspaces
        storedSelection = Self.loadPersistedUUID(Self.selectionDefaultsKey)
        selectedWorkspaceId = storedSelection
        storedPhoneActive = Self.loadPersistedUUID(Self.phoneActiveDefaultsKey)
        if !restoredWorkspaces.isEmpty || storedSelection != nil {
            print("[WatchSync] restored \(restoredWorkspaces.count) workspace(s), selection=\(storedSelection?.uuidString ?? "—") phoneActive=\(storedPhoneActive?.uuidString ?? "—")")
        }
    }

    // MARK: - Calendar context

    /// The meeting whose padded window contains `date`, or nil.
    ///
    /// A meeting the user is ACTUALLY IN wins outright: back-to-back meetings
    /// overlap once the ±15-minute slack is applied, and 25 minutes into a
    /// 2:00–2:30 the user is in that one, not in the 2:30 that has not started.
    /// Only when no real (unpadded) window contains `date` — the user recorded in
    /// the slack either side — does the nearest start win.
    ///
    /// Reads `storedMeetings`, not the `@Published` mirror: a push that landed
    /// milliseconds ago is already here, while `meetings` is still a main-queue
    /// hop behind.
    func meetingTitle(at date: Date) -> String? {
        meetingsLock.lock()
        let snapshot = storedMeetings
        meetingsLock.unlock()

        let candidates = snapshot.filter { $0.contains(date) }
        guard !candidates.isEmpty else { return nil }

        // In progress right now, unpadded — the strongest signal there is.
        let inProgress = candidates.filter { date >= $0.start && date <= $0.end }
        let pool = inProgress.isEmpty ? candidates : inProgress

        let best = pool.min { lhs, rhs in
            abs(lhs.start.timeIntervalSince(date)) < abs(rhs.start.timeIntervalSince(date))
        }
        return best?.title
    }

    /// Decode the phone's `["meetings": [[title, start, end], …], "loaded": Bool]`
    /// payload. The values are plain property-list types, which is all
    /// `updateApplicationContext` accepts.
    ///
    /// An empty list is only believed when the phone says it actually looked
    /// (`loaded == true`). The phone blanks `CalendarAPIService.upcoming` the
    /// instant the workspace changes and only refills it after a network round
    /// trip that can fail; persisting that transient `[]` over a good list would
    /// permanently wipe the watch's offline calendar.
    ///
    /// ⚠️ THE CALENDAR AND THE WORKSPACE LIST TRAVEL IN ONE PAYLOAD.
    /// `updateApplicationContext` REPLACES the whole dictionary, so the phone
    /// assembles both halves in a single `pushContext()`; this end mirrors that by
    /// applying each half independently — a push that legitimately carries only
    /// one believable half must not discard the other.
    private func applyContext(_ context: [String: Any]) {
        applyWorkspaces(context)
        guard let raw = context["meetings"] as? [[String: Any]] else {
            print("[WatchSync] application context had no meetings key: \(context.keys.sorted())")
            return
        }
        let parsed: [WatchMeeting] = raw.compactMap { item in
            guard let title = item["title"] as? String,
                  let start = item["start"] as? TimeInterval,
                  let end = item["end"] as? TimeInterval,
                  !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { return nil }
            return WatchMeeting(title: title,
                                start: Date(timeIntervalSince1970: start),
                                end: Date(timeIntervalSince1970: end))
        }

        // Older phone builds send no flag; treat their empty pushes as authoritative
        // only if we have nothing stored, which is the same as today's behaviour.
        let phoneSaysLoaded = context["loaded"] as? Bool ?? true

        meetingsLock.lock()
        let hadMeetings = !storedMeetings.isEmpty
        if parsed.isEmpty && hadMeetings && !phoneSaysLoaded {
            meetingsLock.unlock()
            print("[WatchSync] ignored empty calendar context — phone has not loaded yet; keeping \(hadMeetings ? "stored" : "empty") list")
            return
        }
        storedMeetings = parsed
        meetingsLock.unlock()

        persist(parsed)
        DispatchQueue.main.async { self.meetings = parsed }
        print("[WatchSync] received calendar context — \(parsed.count) meeting(s) (loaded=\(phoneSaysLoaded))")
    }

    private func persist(_ meetings: [WatchMeeting]) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(meetings) else { return }
        UserDefaults.standard.set(data, forKey: Self.meetingsDefaultsKey)
    }

    private static func loadPersistedMeetings() -> [WatchMeeting] {
        guard let data = UserDefaults.standard.data(forKey: meetingsDefaultsKey) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode([WatchMeeting].self, from: data)) ?? []
    }

    // MARK: - Workspace selection

    /// The workspace this watch would record into right now.
    ///
    /// The user's own choice wins while it is still a workspace they belong to —
    /// a membership removed on the phone must not strand the watch on a dead
    /// selection (design point 6). Otherwise the phone's active workspace, then
    /// the first workspace in the list. `nil` only when the watch has no list at
    /// all, which the phone reads as "use whatever is active there".
    var effectiveWorkspaceId: UUID? {
        workspaceLock.lock(); defer { workspaceLock.unlock() }
        return Self.resolve(selection: storedSelection,
                            phoneActive: storedPhoneActive,
                            in: storedWorkspaces)
    }

    private static func resolve(selection: UUID?,
                                phoneActive: UUID?,
                                in list: [WatchWorkspace]) -> UUID? {
        if let selection, list.contains(where: { $0.id == selection }) { return selection }
        if let phoneActive, list.contains(where: { $0.id == phoneActive }) { return phoneActive }
        return list.first?.id
    }

    /// Record the user's pick. Persisted immediately — the next launch, and the
    /// next recording, must both see it.
    func selectWorkspace(_ id: UUID) {
        workspaceLock.lock()
        guard storedWorkspaces.contains(where: { $0.id == id }) else {
            workspaceLock.unlock()
            print("[WatchSync] ignored selection of unknown workspace \(id)")
            return
        }
        storedSelection = id
        let name = storedWorkspaces.first { $0.id == id }?.name ?? "?"
        workspaceLock.unlock()

        UserDefaults.standard.set(id.uuidString, forKey: Self.selectionDefaultsKey)
        DispatchQueue.main.async { self.selectedWorkspaceId = id }
        print("[WatchSync] workspace selected: \"\(name)\" \(id)")
    }

    private func persistWorkspaces(_ list: [WatchWorkspace]) {
        guard let data = try? JSONEncoder().encode(list) else { return }
        UserDefaults.standard.set(data, forKey: Self.workspacesDefaultsKey)
    }

    private static func loadPersistedWorkspaces() -> [WatchWorkspace] {
        guard let data = UserDefaults.standard.data(forKey: workspacesDefaultsKey) else { return [] }
        return (try? JSONDecoder().decode([WatchWorkspace].self, from: data)) ?? []
    }

    private static func loadPersistedUUID(_ key: String) -> UUID? {
        UserDefaults.standard.string(forKey: key).flatMap(UUID.init(uuidString:))
    }

    /// The workspace half of a merged context push. Independent of the calendar
    /// half on purpose: one key missing or unbelievable must never discard the
    /// other (design point 5).
    private func applyWorkspaces(_ context: [String: Any]) {
        guard let raw = context["workspaces"] as? [[String: Any]] else { return }

        let parsed: [WatchWorkspace] = raw.compactMap { item in
            guard let idString = item["id"] as? String,
                  let id = UUID(uuidString: idString),
                  let name = (item["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !name.isEmpty
            else { return nil }
            let slug = (item["slug"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            return WatchWorkspace(id: id, name: name, slug: (slug?.isEmpty == false) ? slug : nil)
        }

        // Same rule the calendar half uses: an empty list is only believed when
        // the phone says it actually looked. The phone's `workspaces` is empty
        // before bootstrap and is blanked on sign-out, and the watch persists
        // what it receives — one unbelieved empty push would wipe the offline
        // list and leave the user with a placeholder and no way to choose.
        let phoneSaysLoaded = context["workspacesLoaded"] as? Bool ?? true
        let activeId = (context["activeWorkspaceId"] as? String).flatMap(UUID.init(uuidString:))

        workspaceLock.lock()
        if parsed.isEmpty && !storedWorkspaces.isEmpty && !phoneSaysLoaded {
            workspaceLock.unlock()
            print("[WatchSync] ignored empty workspace context — phone has not bootstrapped yet; keeping stored list")
            return
        }
        storedWorkspaces = parsed
        storedPhoneActive = activeId
        // A selection the user is no longer a member of is dropped rather than
        // kept as a dead pointer: `resolve` would ignore it anyway, and leaving it
        // stored means it silently comes back if that workspace ever reappears.
        //
        // ⚠️ ONLY WHEN THE INCOMING LIST HAS SOMETHING IN IT. An empty list is not
        // evidence that a membership is gone — it is evidence that the phone could
        // not tell us, and deleting the persisted choice on that is permanent even
        // though the next successful push restores the list. Belt-and-braces
        // behind the `workspacesLoaded` flag, which is the first line of defence.
        var droppedSelection: UUID?
        if !parsed.isEmpty,
           let selection = storedSelection,
           !parsed.contains(where: { $0.id == selection }) {
            droppedSelection = selection
            storedSelection = nil
        }
        let resolved = Self.resolve(selection: storedSelection,
                                    phoneActive: storedPhoneActive,
                                    in: storedWorkspaces)
        let selectionNow = storedSelection
        workspaceLock.unlock()

        persistWorkspaces(parsed)
        if let activeId {
            UserDefaults.standard.set(activeId.uuidString, forKey: Self.phoneActiveDefaultsKey)
        } else {
            UserDefaults.standard.removeObject(forKey: Self.phoneActiveDefaultsKey)
        }
        if let droppedSelection {
            UserDefaults.standard.removeObject(forKey: Self.selectionDefaultsKey)
            print("[WatchSync] selected workspace \(droppedSelection) is gone from the phone's list — falling back to \(resolved?.uuidString ?? "none")")
        }

        DispatchQueue.main.async {
            self.workspaces = parsed
            self.selectedWorkspaceId = selectionNow
        }
        print("[WatchSync] received workspace context — \(parsed.count) workspace(s) (loaded=\(phoneSaysLoaded)) active=\(activeId?.uuidString.prefix(8).description ?? "—")… effective=\(resolved?.uuidString.prefix(8).description ?? "—")…")
    }

    private func beginTransfer(_ id: UUID) -> Bool {
        inFlightLock.lock(); defer { inFlightLock.unlock() }
        return inFlight.insert(id).inserted
    }

    private func endTransfer(_ id: UUID) {
        inFlightLock.lock(); defer { inFlightLock.unlock() }
        inFlight.remove(id)
    }

    /// Transfers WCSession carried over from a previous launch are still live; mark them
    /// in flight so they are not queued again.
    private func adoptOutstandingTransfers(_ session: WCSession) {
        let ids = session.outstandingFileTransfers.compactMap { transfer -> UUID? in
            guard let s = transfer.file.metadata?["recordingId"] as? String else { return nil }
            return UUID(uuidString: s)
        }
        guard !ids.isEmpty else { return }
        inFlightLock.lock()
        inFlight.formUnion(ids)
        inFlightLock.unlock()
        print("[WatchSync] adopted \(ids.count) outstanding transfer(s) from a previous launch")
    }

    func activate() {
        guard WCSession.isSupported() else {
            print("[WatchSync] WCSession not supported on this device")
            return
        }
        let session = WCSession.default
        session.delegate = self
        session.activate()
        print("[WatchSync] activate() called")
        applyDebugContextIfPresent()
    }

    /// DEBUG-only: feed a context payload in on the command line, exactly as if
    /// the phone had pushed it. Two paired simulators do not reliably deliver
    /// `updateApplicationContext` between them, so this is the only way to
    /// exercise the REAL parse-and-persist path on a simulator:
    ///
    ///   JSON, base64-encoded, as -debugContextBase64. BASE64 and not raw JSON
    ///   because `NSArgumentDomain` runs every `-key value` through the
    ///   property-list parser, so a value starting with `{` comes back as a
    ///   failed plist parse rather than as the string that was typed:
    ///
    ///     xcrun simctl launch <watch> com.dial8-iOS-26.watchkitapp \
    ///       -debugContextBase64 "$(printf %s "$JSON" | base64)"
    ///
    /// It goes through `applyContext`, so whatever it plants is persisted by the
    /// production code and survives the next launch WITHOUT the argument — which
    /// is what makes "the selection survives a relaunch" a real test rather than
    /// a restatement of the argument.
    private func applyDebugContextIfPresent() {
        #if DEBUG
        guard let encoded = UserDefaults.standard.string(forKey: "debugContextBase64"),
              let data = Data(base64Encoded: encoded),
              let context = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return }
        print("[WatchSync] DEBUG -debugContextBase64 supplied: keys \(context.keys.sorted())")
        applyContext(context)
        #endif
    }

    /// Queued, guaranteed-delivery file transfer. Survives app termination on both sides.
    func transfer(_ entry: QueuedRecording) {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated else {
            print("[WatchSync] transfer deferred — session not activated (state \(session.activationState.rawValue))")
            return
        }
        guard beginTransfer(entry.id) else {
            print("[WatchSync] transfer already in flight for \(entry.id) — skipping duplicate")
            return
        }

        let url = RecordingQueue.shared.fileURL(for: entry)
        // Every value here must be a property-list type — WCSession rejects the
        // whole transfer otherwise, which would strand the audio silently.
        var metadata: [String: Any] = [
            "recordingId": entry.id.uuidString,           // this CHUNK's id
            "startedAt": entry.startedAt.timeIntervalSince1970,  // this CHUNK's start
            "duration": entry.durationSeconds,            // this CHUNK's length
            "source": "watch",
            "schema": WatchSync.metadataSchema,
            "sessionId": entry.sessionId.uuidString,
            "chunkIndex": entry.chunkIndex,
            "isFinal": entry.isFinal,
            "sessionStartedAt": entry.sessionStartedAt.timeIntervalSince1970,
            "chunkStartOffset": entry.chunkStartOffset
        ]
        // Present on the FINAL chunk only: it is the phone's completeness check.
        if entry.isFinal, let total = entry.totalChunks {
            metadata["totalChunks"] = total
        }
        if let title = entry.title, !title.isEmpty {
            metadata["title"] = title
        }
        // The phone only suppresses generate-title for a REAL meeting name; the
        // fallback must still be auto-titled from the transcript. Sent on every
        // chunk, title or not, so the flag never has to be inferred.
        metadata["hasMeetingTitle"] = entry.hasMeetingTitle
        // The workspace the user had selected when this recording started, on
        // EVERY chunk (schema 4). UUIDs are not property-list types, so it goes
        // as a string. Absent when the watch has no workspace list at all — the
        // phone then uses its own active workspace.
        if let workspaceId = entry.workspaceId {
            metadata["workspaceId"] = workspaceId.uuidString
        }
        session.transferFile(url, metadata: metadata)
        print("[WatchSync] transferFile queued ws=\(entry.workspaceId?.uuidString.prefix(8).description ?? "—")… for session \(entry.sessionId) chunk \(entry.chunkIndex)\(entry.isFinal ? " (final of \(entry.totalChunks.map(String.init) ?? "?"))" : "") id=\(entry.id) — outstanding \(session.outstandingFileTransfers.count)")
    }
}

extension WatchSync: WCSessionDelegate {
    func session(_ session: WCSession,
                 activationDidCompleteWith activationState: WCSessionActivationState,
                 error: Error?) {
        if let error {
            print("[WatchSync] activation error: \(error.localizedDescription)")
        }
        print("[WatchSync] activated state=\(activationState.rawValue) reachable=\(session.isReachable)")
        DispatchQueue.main.async {
            self.isActivated = (activationState == .activated)
            self.isReachable = session.isReachable
        }
        if activationState == .activated {
            // WCSession resumes transfers queued by a previous launch of this app.
            // Adopt them so flush() does not queue the same file a second time.
            adoptOutstandingTransfers(session)
            RecordingQueue.shared.flush()
            // The last context the phone pushed is held by the system and is
            // available immediately on activation — no round trip needed, and it
            // works even when the phone app is not running.
            let context = session.receivedApplicationContext
            if !context.isEmpty { applyContext(context) }
        }
    }

    /// A fresh push from the phone (its calendar changed, or it just activated).
    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        applyContext(applicationContext)
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        print("[WatchSync] reachability -> \(session.isReachable)")
        DispatchQueue.main.async { self.isReachable = session.isReachable }
        if session.isReachable {
            RecordingQueue.shared.flush()
        }
    }

    func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?) {
        let idString = fileTransfer.file.metadata?["recordingId"] as? String
        let id = idString.flatMap { UUID(uuidString: $0) }
        if let id { endTransfer(id) }
        if let error {
            if let id { RecordingQueue.shared.markFailed(id: id, error: error) }
            else { print("[WatchSync] transfer failed (no id): \(error.localizedDescription)") }
            return
        }
        if let id {
            RecordingQueue.shared.markTransferred(id: id)
        } else {
            print("[WatchSync] transfer finished but metadata had no recordingId")
        }
    }
}
