//
//  CaptureAPIService.swift
//  Native Intelligence
//
//  HTTP client for the website's capture pipeline (/api/account/captures/* and
//  /api/ai/live-agent).
//
//  WHY THIS EXISTS
//  ---------------
//  iOS used to persist a finished voice note by INSERTing straight into the
//  `captures` table through the Supabase Swift SDK. The row landed, but nothing
//  downstream ever processed it: no title, no summary, no extracted actions.
//  None of that is a DB trigger — the WEB CLIENT drives the pipeline by hand
//  (src/hooks/recording-context.tsx). A bare INSERT is therefore invisible to it.
//
//  THE SEQUENCE THE WEB CLIENT PERFORMS (mirrored here, verbatim):
//
//    on start   POST   /api/account/captures
//                      { id, title, started_at, live_mode, capture_mode }
//                      → the row exists WHILE recording, status 'active'
//
//    while live POST   /api/account/captures/{id}/transcript-append
//                      { append_text, base_length }
//                      → server-side CAS append (append_capture_transcript RPC).
//                        base_length is the char count the client believes the
//                        server holds; a mismatch 409s instead of clobbering.
//
//    on stop    PATCH  /api/account/captures/{id}
//                      { ended_at, duration_seconds, ai_processed: true }
//                      → the DB trigger `lock_transcript_on_end` sets
//                        is_transcript_locked itself, so the web client does NOT
//                        send that field and neither do we (sending it is
//                        harmless but redundant — see `endCapture`).
//
//    then       POST   /api/ai/live-agent
//                      { capture_id, mode: "batch", allow_auto_archive: true }
//                      → ** THIS is what actually produces the summary and the
//                        extracted actions/decisions. ** The PATCH above triggers
//                        nothing on its own (the route says so in its own
//                        comments). Without this call a capture stays a raw
//                        transcript forever.
//
//    finally    POST   /api/account/captures/{id}/generate-title
//                      → reads ai_summary and renames the capture. MUST run
//                        after the batch, or it finds no summary and skips.
//
//  Auth is identical to AIBackendService: Bearer <supabase access token> plus
//  the x-workspace-id header, base URL localhost:3000 under DEBUG.
//

import Foundation

// MARK: - Errors

enum CaptureAPIError: LocalizedError {
    case invalidURL(String)
    case notAuthenticated
    case usageLimitExceeded
    case httpError(statusCode: Int, message: String)
    case invalidResponse
    /// The transcript is locked (capture ended). Terminal — stop appending.
    case transcriptLocked
    /// base_length diverged from the server. Caller should re-sync via a full PATCH.
    case baseLengthMismatch(serverLength: Int)

    var errorDescription: String? {
        switch self {
        case .invalidURL(let path):
            return "Invalid capture API URL: \(path)"
        case .notAuthenticated:
            return "Sign in required to record a capture."
        case .usageLimitExceeded:
            return "AI usage limit reached. Please upgrade your plan or wait until your limit resets."
        case .httpError(let code, let message):
            return "Capture API error (\(code)): \(message)"
        case .invalidResponse:
            return "Invalid response from the capture API."
        case .transcriptLocked:
            return "This capture has ended and its transcript is locked."
        case .baseLengthMismatch(let len):
            return "Transcript out of sync (server holds \(len) characters)."
        }
    }
}

// MARK: - Capture API Service

/// Thin HTTP client mirroring the web recorder's capture lifecycle.
/// Plain class with async funcs (not an actor / not @MainActor) — matches the
/// AIBackendService pattern; @MainActor state is read with `await MainActor.run`.
final class CaptureAPIService {
    static let shared = CaptureAPIService()

    /// Audio topology reported to the server. iOS records a SINGLE mic channel
    /// shared by everyone in the room — exactly the web recorder's topology — so
    /// `web_mic_only` is the honest value. It is also the only safe one: the
    /// route accepts ONLY `desktop_dual` | `web_mic_only`, and `desktop_dual`
    /// additionally makes a capture eligible for position-based speaker
    /// self-binding (lib/live-agent/self-binding.ts), which would mis-attribute
    /// utterances on a single-channel recording.
    static let captureMode = "web_mic_only"

    /// Base URL for the Next.js backend. Same switch as AIBackendService.
    private var baseURL: String {
        #if DEBUG
        return "http://localhost:3000"
        #else
        return "https://dial8.ai"
        #endif
    }

    private let session: URLSession

    private init() {
        let config = URLSessionConfiguration.default
        // The lifecycle calls are small writes; the batch extraction is NOT made
        // through this session (it gets its own longer-timeout request below).
        config.timeoutIntervalForRequest = 45
        config.timeoutIntervalForResource = 90
        self.session = URLSession(configuration: config)
    }

    // MARK: - 1. Create

    /// POST /api/account/captures — create the capture row at recording START.
    ///
    /// The id is client-minted (like the web recorder's `crypto.randomUUID()`)
    /// so the caller can bind the session before the round trip resolves; the
    /// route is idempotent for a repeated id owned by the same user.
    ///
    /// - Returns: the server's canonical capture id.
    @discardableResult
    func createCapture(
        id: UUID,
        title: String,
        startedAt: Date,
        projectId: UUID? = nil,
        liveMode: Bool = false,
        workspaceId: UUID? = nil
    ) async throws -> UUID {
        var body: [String: Any] = [
            "id": id.uuidString.lowercased(),
            "title": title,
            "started_at": Self.iso8601(startedAt),
            // OFF = nothing is processed during the meeting; one batch run over
            // the whole transcript at the end. iOS has no live-agent UI, so the
            // batch path is the right (and cheaper) one.
            "live_mode": liveMode,
            "capture_mode": Self.captureMode,
        ]
        if let projectId {
            body["project_id"] = projectId.uuidString.lowercased()
        }

        let request = try await makeRequest(path: "/api/account/captures",
                                            method: "POST",
                                            body: body,
                                            workspaceOverride: workspaceId)
        let data = try await perform(request, label: "createCapture")

        guard
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let capture = json["capture"] as? [String: Any],
            let idString = capture["id"] as? String,
            let serverId = UUID(uuidString: idString)
        else {
            throw CaptureAPIError.invalidResponse
        }

        print("🎙️ CaptureAPI: created capture \(serverId.uuidString.prefix(8))… via API (mode=\(Self.captureMode))")
        return serverId
    }

    // MARK: - 2. Transcript append

    /// POST /api/account/captures/{id}/transcript-append — CAS delta append.
    ///
    /// - Parameters:
    ///   - appendText: ONLY the new tail. Must be non-empty and ≤256KB.
    ///   - baseLength: char length of the transcript the caller believes the
    ///     server currently holds (0 for the first append).
    /// - Returns: the server's NEW total transcript length, to use as the next
    ///   call's `baseLength`.
    /// - Throws: `.transcriptLocked` (terminal — stop appending),
    ///   `.baseLengthMismatch` (re-sync needed).
    @discardableResult
    func appendTranscript(
        captureId: UUID,
        appendText: String,
        baseLength: Int,
        workspaceId: UUID? = nil
    ) async throws -> Int {
        guard !appendText.isEmpty else { return baseLength }

        let request = try await makeRequest(
            path: "/api/account/captures/\(captureId.uuidString.lowercased())/transcript-append",
            method: "POST",
            body: ["append_text": appendText, "base_length": baseLength],
            workspaceOverride: workspaceId
        )

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw CaptureAPIError.invalidResponse }

        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]

        if http.statusCode == 401 { throw CaptureAPIError.notAuthenticated }
        if http.statusCode == 429 { throw CaptureAPIError.usageLimitExceeded }

        if http.statusCode == 409 {
            let code = json?["code"] as? String
            if code == "TRANSCRIPT_LOCKED" {
                throw CaptureAPIError.transcriptLocked
            }
            let serverLength = json?["server_length"] as? Int ?? 0
            throw CaptureAPIError.baseLengthMismatch(serverLength: serverLength)
        }

        guard (200...299).contains(http.statusCode) else {
            throw CaptureAPIError.httpError(
                statusCode: http.statusCode,
                message: (json?["error"] as? String) ?? "transcript-append failed"
            )
        }

        guard let newLength = json?["new_length"] as? Int else {
            throw CaptureAPIError.invalidResponse
        }
        return newLength
    }

    /// PATCH /api/account/captures/{id} with the WHOLE transcript — the web
    /// client's fallback when a delta append 409s or diverges. The route applies
    /// a no-shrink guard, so this can only ever grow the stored text.
    ///
    /// - Returns: true when the server accepted the text (guard not skipped).
    @discardableResult
    func replaceTranscript(captureId: UUID, transcript: String, workspaceId: UUID? = nil) async throws -> Bool {
        let request = try await makeRequest(
            path: "/api/account/captures/\(captureId.uuidString.lowercased())",
            method: "PATCH",
            body: ["transcript": transcript],
            workspaceOverride: workspaceId
        )
        let data = try await perform(request, label: "replaceTranscript")
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        // The route reports a no-shrink rejection as `transcript_guard_skipped`.
        let skipped = (json?["transcript_guard_skipped"] as? Bool) ?? false
        return !skipped
    }

    // MARK: - 3. End

    /// PATCH /api/account/captures/{id} — finalize the capture on stop.
    ///
    /// Mirrors the web recorder's stop PATCH: `ended_at`, `duration_seconds`,
    /// `ai_processed: true`. `is_transcript_locked` is set by the DB trigger
    /// `lock_transcript_on_end` when ended_at lands, so we don't need to send it
    /// — but the route DOES accept it, and sending `true` explicitly makes the
    /// lock deterministic even if the trigger is ever changed. Harmless either
    /// way (the trigger writes the same value).
    func endCapture(
        captureId: UUID,
        endedAt: Date,
        durationSeconds: Int,
        lockTranscript: Bool = true,
        workspaceId: UUID? = nil
    ) async throws {
        var body: [String: Any] = [
            "ended_at": Self.iso8601(endedAt),
            "duration_seconds": durationSeconds,
            "ai_processed": true,
        ]
        if lockTranscript { body["is_transcript_locked"] = true }

        let request = try await makeRequest(
            path: "/api/account/captures/\(captureId.uuidString.lowercased())",
            method: "PATCH",
            body: body,
            workspaceOverride: workspaceId
        )
        _ = try await perform(request, label: "endCapture")
        print("🎙️ CaptureAPI: ended capture \(captureId.uuidString.prefix(8))… (\(durationSeconds)s)")
    }

    // MARK: - 4. Batch extraction (THE trigger for summary + actions)

    /// POST /api/ai/live-agent — the canonical end-of-meeting batch run.
    ///
    /// This is `runApiBatchExtraction` from the web recorder. It reads
    /// `captures.transcript` server-side (no chunks are sent for batch mode) and
    /// writes the summary + proposed changes (actions, decisions) through the
    /// live-agent tools. `allow_auto_archive: true` marks this as the genuine
    /// end-of-meeting run, the only caller permitted to auto-archive a misfire
    /// capture (GEN-135); a manual Reprocess must never set it.
    ///
    /// Long meetings can take minutes (the route's maxDuration is 600s), so this
    /// request gets its own generous timeout rather than the shared 45s session.
    ///
    /// - Returns: true on success. On failure the caller should leave the capture
    ///   for the user to Reprocess rather than retrying blindly.
    @discardableResult
    func runBatchExtraction(captureId: UUID, recipeId: String? = nil, workspaceId: UUID? = nil) async throws -> Bool {
        var body: [String: Any] = [
            "capture_id": captureId.uuidString.lowercased(),
            "mode": "batch",
            "allow_auto_archive": true,
        ]
        if let recipeId { body["recipe_id"] = recipeId }

        var request = try await makeRequest(path: "/api/ai/live-agent",
                                            method: "POST",
                                            body: body,
                                            workspaceOverride: workspaceId)
        request.timeoutInterval = 600

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw CaptureAPIError.invalidResponse }

        if http.statusCode == 401 { throw CaptureAPIError.notAuthenticated }
        if http.statusCode == 429 { throw CaptureAPIError.usageLimitExceeded }

        guard (200...299).contains(http.statusCode) else {
            let message = Self.errorMessage(from: data) ?? "batch extraction failed"
            throw CaptureAPIError.httpError(statusCode: http.statusCode, message: message)
        }

        print("🤖 CaptureAPI: batch extraction complete for \(captureId.uuidString.prefix(8))…")
        return true
    }

    // MARK: - 5. Title

    /// POST /api/account/captures/{id}/generate-title — rename from ai_summary.
    ///
    /// Server-side no-op unless the title still matches the auto-generated
    /// placeholder pattern AND an ai_summary exists, so it MUST run after the
    /// batch extraction. Fire-and-forget on the web; same here.
    func generateTitle(captureId: UUID, workspaceId: UUID? = nil) async throws {
        let request = try await makeRequest(
            path: "/api/account/captures/\(captureId.uuidString.lowercased())/generate-title",
            method: "POST",
            body: [:],
            workspaceOverride: workspaceId
        )
        _ = try await perform(request, label: "generateTitle")
    }

    // MARK: - Auto title

    /// The placeholder title the server's generate-title route recognizes:
    /// `Capture Mon D H:MM AM/PM` (see its `isAutoTitle` regex). Using this exact
    /// shape at create time is what LETS the title be regenerated later — any
    /// other string is treated as a user-chosen title and left alone.
    static func autoTitle(for date: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "MMM d h:mm a"
        return "Capture " + formatter.string(from: date)
    }

    // MARK: - Request building (mirrors AIBackendService.makeRequest)

    /// - Parameter workspaceOverride: file this request in a SPECIFIC workspace
    ///   instead of the phone's currently active one. `nil` — every caller that
    ///   does not pass it — keeps the previous behaviour byte for byte.
    ///
    ///   ⚠️ WHY AN OVERRIDE EXISTS AT ALL. A watch recording is ingested
    ///   asynchronously, minutes or hours after it was made, as a SEQUENCE of
    ///   calls: create → append → end → batch → title. Reading the active
    ///   workspace afresh on each one means a user who switches workspace on
    ///   their phone mid-ingest gets the capture row in one workspace and its
    ///   transcript, end and extraction aimed at another — a half-written capture
    ///   in the wrong place. The whole sequence must be pinned to one workspace,
    ///   so the workspace is a per-request argument rather than ambient state.
    private func makeRequest(
        path: String,
        method: String,
        body: [String: Any],
        workspaceOverride: UUID? = nil
    ) async throws -> URLRequest {
        guard let url = URL(string: baseURL + path) else {
            throw CaptureAPIError.invalidURL(path)
        }

        guard let token = await AIProxyConfig.getAccessToken() else {
            throw CaptureAPIError.notAuthenticated
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        // Workspace scoping: the routes resolve workspace via x-workspace-id →
        // cookie → first membership. Without the header a multi-workspace user
        // silently lands in their FIRST membership. Lowercased to match the
        // Postgres-normalized UUID form (Swift's uuidString is uppercase).
        // `??` takes its right-hand side as an autoclosure, which cannot carry the
        // `await`, so the fallback is spelled out.
        let workspaceId: UUID?
        if let workspaceOverride {
            workspaceId = workspaceOverride
        } else {
            workspaceId = await MainActor.run(body: { WorkspaceService.shared.workspaceId })
        }
        if let workspaceId {
            request.setValue(workspaceId.uuidString.lowercased(), forHTTPHeaderField: "x-workspace-id")
        }
        #if DEBUG
        // The single place the outgoing workspace can be observed. Worth a line:
        // a capture landing in the wrong workspace is otherwise only visible in
        // the database, long after the run that caused it.
        print("🏢 CaptureAPI: \(method) \(path) x-workspace-id=\(workspaceId?.uuidString.lowercased() ?? "—")\(workspaceOverride != nil ? " (override)" : "")")
        #endif

        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return request
    }

    /// Execute a request and map non-2xx onto CaptureAPIError, preferring the
    /// server's own `{ error }` message.
    @discardableResult
    private func perform(_ request: URLRequest, label: String) async throws -> Data {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw CaptureAPIError.invalidResponse
        }

        if http.statusCode == 401 { throw CaptureAPIError.notAuthenticated }
        if http.statusCode == 429 { throw CaptureAPIError.usageLimitExceeded }

        guard (200...299).contains(http.statusCode) else {
            let message = Self.errorMessage(from: data) ?? "\(label) failed"
            throw CaptureAPIError.httpError(statusCode: http.statusCode, message: message)
        }
        return data
    }

    private static func errorMessage(from data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return json["error"] as? String
    }

    // MARK: - Date formatting

    /// ISO-8601 with fractional seconds, matching JS `toISOString()`.
    private static let iso8601Formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    static func iso8601(_ date: Date) -> String {
        iso8601Formatter.string(from: date)
    }
}
