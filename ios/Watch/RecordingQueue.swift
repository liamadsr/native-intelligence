import Foundation

extension Notification.Name {
    /// The set of recordings waiting to reach the iPhone changed: one was
    /// enqueued, delivered, or dropped. `WatchRecorder` listens so the
    /// "N waiting to sync" footnote can't keep claiming a recording is pending
    /// after it has actually arrived — the queue only ever shrank on a delegate
    /// callback that notified nothing, so the count went stale until relaunch.
    static let watchRecordingQueueChanged = Notification.Name("watchRecordingQueueChanged")
}

/// One CHUNK of a watch recording, waiting to reach the iPhone.
///
/// A recording is a SESSION made of ordered chunks: the recorder rotates to a new
/// file every `WatchRecorder.chunkDuration` of RECORDED time, so a one-hour
/// meeting arrives as four 15-minute files that transfer while the meeting is
/// still running. A recording shorter than one chunk is simply a one-chunk
/// session (index 0, final, totalChunks 1) — there is no second code path.
struct QueuedRecording: Codable, Identifiable, Equatable {
    /// This CHUNK's id. It names the file and is the transfer's `recordingId`.
    let id: UUID
    /// Path relative to the recordings directory, e.g. "<uuid>.m4a".
    let relativePath: String
    /// When this CHUNK started recording (wall clock).
    let startedAt: Date
    /// This CHUNK's audio length, not the session's.
    var durationSeconds: Double
    var transferred: Bool
    /// What the phone should call this capture: the calendar meeting's name when
    /// the recording started inside one, otherwise `WatchRecorder.fallbackTitle`.
    /// Carried on EVERY chunk so losing chunk 0 does not cost the meeting name.
    var title: String?
    /// True only when `title` came from a real calendar meeting. The phone uses it
    /// to decide whether to let generate-title overwrite the name.
    var hasMeetingTitle: Bool
    /// The workspace SELECTED ON THE WATCH when this recording started — where
    /// the phone should file the capture. Identical on every chunk of a session
    /// (it is resolved once, at `start()`), and carried per-chunk so a lost chunk
    /// 0 does not cost the routing. `nil` when the watch had no workspace list,
    /// which the phone reads as "use your own active workspace".
    var workspaceId: UUID?

    // MARK: Session identity

    /// Identical on every chunk of one recording. This is what the phone groups by.
    var sessionId: UUID
    /// 0-based and contiguous within the session.
    var chunkIndex: Int
    /// True only on the last chunk of the session.
    var isFinal: Bool
    /// Set on the FINAL chunk only (nil elsewhere), so the phone can tell whether
    /// it holds every chunk before doing any server work.
    var totalChunks: Int?
    /// When the SESSION started recording — identical on every chunk. The phone
    /// uses it as the capture's `startedAt` and orders Home by it.
    var sessionStartedAt: Date
    /// Seconds of RECORDED session time before this chunk's first sample (paused
    /// time excluded). Chunk 0 is always 0.
    var chunkStartOffset: Double

    init(id: UUID = UUID(),
         relativePath: String,
         startedAt: Date,
         durationSeconds: Double,
         transferred: Bool = false,
         title: String? = nil,
         hasMeetingTitle: Bool = false,
         workspaceId: UUID? = nil,
         sessionId: UUID? = nil,
         chunkIndex: Int = 0,
         isFinal: Bool = true,
         totalChunks: Int? = 1,
         sessionStartedAt: Date? = nil,
         chunkStartOffset: Double = 0) {
        self.id = id
        self.relativePath = relativePath
        self.startedAt = startedAt
        self.durationSeconds = durationSeconds
        self.transferred = transferred
        self.title = title
        self.hasMeetingTitle = hasMeetingTitle
        self.workspaceId = workspaceId
        self.sessionId = sessionId ?? id
        self.chunkIndex = chunkIndex
        self.isFinal = isFinal
        self.totalChunks = totalChunks
        self.sessionStartedAt = sessionStartedAt ?? startedAt
        self.chunkStartOffset = chunkStartOffset
    }

    // Entries written by an older build have none of the newer fields; decoding
    // must not throw on them or the whole queue (and every recording in it) is
    // lost. A pre-chunking entry IS a one-chunk session, so that is exactly what
    // the defaults describe.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        relativePath = try c.decode(String.self, forKey: .relativePath)
        startedAt = try c.decode(Date.self, forKey: .startedAt)
        durationSeconds = try c.decode(Double.self, forKey: .durationSeconds)
        transferred = try c.decodeIfPresent(Bool.self, forKey: .transferred) ?? false
        title = try c.decodeIfPresent(String.self, forKey: .title)
        hasMeetingTitle = try c.decodeIfPresent(Bool.self, forKey: .hasMeetingTitle) ?? false
        // Queued by a build that had no workspace selector: no selection, so the
        // phone files it wherever it is currently pointed.
        workspaceId = try c.decodeIfPresent(UUID.self, forKey: .workspaceId)
        sessionId = try c.decodeIfPresent(UUID.self, forKey: .sessionId) ?? id
        chunkIndex = try c.decodeIfPresent(Int.self, forKey: .chunkIndex) ?? 0
        isFinal = try c.decodeIfPresent(Bool.self, forKey: .isFinal) ?? true
        // A legacy entry is final AND complete: one chunk.
        totalChunks = try c.decodeIfPresent(Int.self, forKey: .totalChunks) ?? (isFinal ? 1 : nil)
        sessionStartedAt = try c.decodeIfPresent(Date.self, forKey: .sessionStartedAt) ?? startedAt
        chunkStartOffset = try c.decodeIfPresent(Double.self, forKey: .chunkStartOffset) ?? 0
    }
}

/// Durable, crash-surviving queue of recordings awaiting transfer.
/// Writes synchronously on every mutation — the file on disk is always the truth.
final class RecordingQueue {
    static let shared = RecordingQueue()

    private let lock = NSLock()
    private var entries: [QueuedRecording] = []

    private init() {
        load()
    }

    // MARK: - Locations

    /// Application Support/recordings — where the .m4a files live.
    static var recordingsDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("recordings", isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir
    }

    private var queueFileURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        if !FileManager.default.fileExists(atPath: base.path) {
            try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        }
        return base.appendingPathComponent("watch-recording-queue.json")
    }

    func fileURL(for entry: QueuedRecording) -> URL {
        RecordingQueue.recordingsDirectory.appendingPathComponent(entry.relativePath)
    }

    // MARK: - Persistence

    private func load() {
        guard let data = try? Data(contentsOf: queueFileURL) else { return }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        entries = (try? decoder.decode([QueuedRecording].self, from: data)) ?? []
        print("[RecordingQueue] loaded \(entries.count) entr\(entries.count == 1 ? "y" : "ies") from disk")
    }

    /// Synchronous write. Called while `lock` is held.
    private func persistLocked() {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(entries) else { return }
        do {
            try data.write(to: queueFileURL, options: .atomic)
        } catch {
            print("[RecordingQueue] persist failed: \(error)")
        }
    }

    // MARK: - Queue operations

    var pendingCount: Int {
        lock.lock(); defer { lock.unlock() }
        return entries.filter { !$0.transferred }.count
    }

    /// How many RECORDINGS are waiting, not how many chunks. Since a recording
    /// rotates to a new file every 15 minutes, the chunk count is an internal
    /// number: telling the user "4 waiting to sync" after one long meeting reads
    /// as four lost meetings.
    var pendingSessionCount: Int {
        lock.lock(); defer { lock.unlock() }
        return Set(entries.filter { !$0.transferred }.map(\.sessionId)).count
    }

    var pending: [QueuedRecording] {
        lock.lock(); defer { lock.unlock() }
        return entries.filter { !$0.transferred }
    }

    /// Tell any observer (the UI) that the pending count moved. Always posted on
    /// the main queue — mutations here happen on WCSession's delegate threads.
    private func notifyChanged() {
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .watchRecordingQueueChanged, object: nil)
        }
    }

    @discardableResult
    func enqueue(_ entry: QueuedRecording) -> QueuedRecording {
        lock.lock()
        entries.append(entry)
        persistLocked()
        lock.unlock()
        print("[RecordingQueue] enqueued chunk \(entry.chunkIndex)\(entry.isFinal ? "/final total=\(entry.totalChunks.map(String.init) ?? "?")" : "") session=\(entry.sessionId) id=\(entry.id) (\(String(format: "%.1f", entry.durationSeconds))s) — pending \(pendingCount)")
        notifyChanged()
        return entry
    }

    /// Marks an entry transferred, removes it from the queue and deletes the local audio file.
    func markTransferred(id: UUID) {
        lock.lock()
        guard let idx = entries.firstIndex(where: { $0.id == id }) else {
            lock.unlock()
            return
        }
        let entry = entries.remove(at: idx)
        persistLocked()
        lock.unlock()

        let url = fileURL(for: entry)
        try? FileManager.default.removeItem(at: url)
        print("[RecordingQueue] transferred + removed \(id)")
        notifyChanged()
    }

    /// Keeps the entry queued so the next flush retries it.
    func markFailed(id: UUID, error: Error) {
        print("[RecordingQueue] transfer failed for \(id): \(error.localizedDescription) — staying queued")
    }

    /// Retries every untransferred entry. Safe to call repeatedly.
    func flush() {
        let toSend = pending
        guard !toSend.isEmpty else {
            print("[RecordingQueue] flush: nothing pending")
            return
        }
        print("[RecordingQueue] flush: \(toSend.count) pending")
        for entry in toSend {
            let url = fileURL(for: entry)
            guard FileManager.default.fileExists(atPath: url.path) else {
                print("[RecordingQueue] file missing for \(entry.id), dropping entry")
                lock.lock()
                entries.removeAll { $0.id == entry.id }
                persistLocked()
                lock.unlock()
                notifyChanged()
                continue
            }
            WatchSync.shared.transfer(entry)
        }
    }
}
