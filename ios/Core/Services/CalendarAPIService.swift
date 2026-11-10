//
//  CalendarAPIService.swift
//  Native Intelligence
//
//  Reads the website's upcoming-captures endpoint so Home can show the next
//  scheduled meeting.
//
//  GET /api/account/calendar/upcoming-captures
//    → { "captures": [ { id, title, scheduled_start, scheduled_end, meeting_url,
//                        participant_count, minutes_until_start, … } ] }
//
//  Only captures whose `auto_capture_status` is pending|ready and whose
//  scheduled_start falls in the next 24h come back, already sorted soonest-first
//  (see lib/integrations/calendar-sync.ts → getUpcomingCaptures).
//
//  Auth mirrors CaptureAPIService exactly: Bearer <supabase access token> from
//  AIProxyConfig.getAccessToken(), plus the x-workspace-id header (lowercased —
//  Postgres stores UUIDs lowercase while Swift's uuidString is uppercase), base
//  URL localhost:3000 under DEBUG and dial8.ai in Release. CaptureAPIService
//  keeps its request builder private, so the pattern is reproduced here rather
//  than shared.
//

import Foundation
import Combine

// MARK: - Model

/// One scheduled-but-not-yet-recorded capture.
///
/// Dates arrive as ISO-8601 strings whose fractional-seconds component is
/// optional (Postgres renders a variable number of digits), so they are decoded
/// through a tolerant parser rather than `.iso8601`.
struct UpcomingCapture: Identifiable, Equatable {
    let id: UUID
    let title: String
    let scheduledStart: Date?
    let scheduledEnd: Date?
    let meetingUrl: String?
    let participantCount: Int
    let minutesUntilStart: Int?
}

extension UpcomingCapture: Decodable {
    enum CodingKeys: String, CodingKey {
        case id
        case title
        case scheduledStart = "scheduled_start"
        case scheduledEnd = "scheduled_end"
        case meetingUrl = "meeting_url"
        case participantCount = "participant_count"
        case minutesUntilStart = "minutes_until_start"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        title = (try c.decodeIfPresent(String.self, forKey: .title)) ?? "Untitled meeting"
        scheduledStart = CalendarAPIService.parseDate(
            try c.decodeIfPresent(String.self, forKey: .scheduledStart)
        )
        scheduledEnd = CalendarAPIService.parseDate(
            try c.decodeIfPresent(String.self, forKey: .scheduledEnd)
        )
        meetingUrl = try c.decodeIfPresent(String.self, forKey: .meetingUrl)
        participantCount = (try c.decodeIfPresent(Int.self, forKey: .participantCount)) ?? 0
        minutesUntilStart = try c.decodeIfPresent(Int.self, forKey: .minutesUntilStart)
    }
}

private struct UpcomingCapturesEnvelope: Decodable {
    let captures: [UpcomingCapture]
}

// MARK: - Service

@MainActor
final class CalendarAPIService: ObservableObject {
    static let shared = CalendarAPIService()

    /// Soonest-first. Home renders `first`.
    @Published private(set) var upcoming: [UpcomingCapture] = []
    /// True only while the FIRST load is in flight — a pull-to-refresh over
    /// existing data must not blank the card into its placeholder.
    @Published private(set) var isLoading = false
    /// Set once a fetch has completed (successfully or not), so the card can tell
    /// "nothing scheduled" apart from "haven't looked yet".
    @Published private(set) var hasLoaded = false

    private let session: URLSession
    private var cancellables = Set<AnyCancellable>()

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 30
        self.session = URLSession(configuration: config)
        setupWorkspaceObserver()
    }

    /// `refresh()` sends the active workspace as `x-workspace-id`, so the list on
    /// screen belongs to the workspace we just left. Blank it AND reset
    /// `hasLoaded` — otherwise Home would keep showing the old meetings until the
    /// refetch lands, and "nothing scheduled" would be indistinguishable from
    /// "still loading".
    private func setupWorkspaceObserver() {
        NotificationCenter.default.publisher(for: .workspaceDidChange)
            .sink { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.upcoming = []
                    self.hasLoaded = false
                    print("📅 CalendarAPI: cleared upcoming for workspace switch")
                    await self.refresh()
                }
            }
            .store(in: &cancellables)
    }

    private var baseURL: String {
        #if DEBUG
        return "http://localhost:3000"
        #else
        return "https://dial8.ai"
        #endif
    }

    // MARK: - Refresh

    /// Fetch the next 24h of scheduled captures. Never throws: Home treats a
    /// failure exactly like "nothing upcoming", and the previous list is kept so
    /// a transient error doesn't blank a card that was already correct.
    func refresh() async {
        if !hasLoaded { isLoading = true }
        defer {
            isLoading = false
            hasLoaded = true
        }

        guard let url = URL(string: baseURL + "/api/account/calendar/upcoming-captures") else {
            return
        }
        guard let token = await AIProxyConfig.getAccessToken() else {
            print("📅 CalendarAPI: skipped — not authenticated")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let workspaceId = WorkspaceService.shared.workspaceId {
            request.setValue(workspaceId.uuidString.lowercased(), forHTTPHeaderField: "x-workspace-id")
        }

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                let code = (response as? HTTPURLResponse)?.statusCode ?? -1
                print("📅 CalendarAPI: upcoming-captures failed (\(code))")
                return
            }
            let envelope = try JSONDecoder().decode(UpcomingCapturesEnvelope.self, from: data)
            upcoming = envelope.captures.sorted {
                ($0.scheduledStart ?? .distantFuture) < ($1.scheduledStart ?? .distantFuture)
            }
            print("📅 CalendarAPI: \(upcoming.count) upcoming capture(s)")
        } catch {
            print("📅 CalendarAPI: upcoming-captures error — \(error.localizedDescription)")
        }
    }

    // MARK: - Date parsing

    /// ISO-8601 with OR without fractional seconds.
    nonisolated static func parseDate(_ raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        if let date = fractionalFormatter.date(from: raw) { return date }
        return plainFormatter.date(from: raw)
    }

    private nonisolated static let fractionalFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private nonisolated static let plainFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}
