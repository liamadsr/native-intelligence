import EventKit
import Foundation

// MARK: - Types

struct ExchangeCalendarInfo: Codable {
    let id: String
    let title: String
    let accountName: String
    let color: String
}

struct CalendarStatusResult: Codable {
    let hasAccess: Bool
    let exchangeCalendars: [ExchangeCalendarInfo]
}

struct CalendarEventJSON: Codable {
    let id: String
    let title: String
    let start: String
    let end: String
    let isAllDay: Bool
    let calendarId: String
    let calendarName: String?
    let location: String?
    let attendees: [String]
    let organizer: String?
    let conferenceUrl: String?
    let hasRecurrence: Bool
    let source: String
}

// MARK: - Calendar Reader

/// Reads Exchange calendar events from macOS Calendar.app via EventKit.
/// Filters to only Exchange and Exchange-like (CalDAV with Exchange/Office 365) sources.
class CalendarReader {
    private let store = EKEventStore()
    private static let iso8601Formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    // MARK: - Permission & Status

    /// Request calendar access and return status + discovered Exchange calendars.
    func requestAccessAndStatus() -> CalendarStatusResult {
        let semaphore = DispatchSemaphore(value: 0)
        var granted = false

        if #available(macOS 14.0, *) {
            store.requestFullAccessToEvents { ok, error in
                granted = ok
                if let error = error {
                    fputs("[calendar-reader] requestFullAccessToEvents error: \(error.localizedDescription)\n", stderr)
                }
                semaphore.signal()
            }
        } else {
            store.requestAccess(to: .event) { ok, error in
                granted = ok
                if let error = error {
                    fputs("[calendar-reader] requestAccess error: \(error.localizedDescription)\n", stderr)
                }
                semaphore.signal()
            }
        }

        semaphore.wait()

        let calendars = granted ? getExchangeCalendars() : []
        return CalendarStatusResult(hasAccess: granted, exchangeCalendars: calendars)
    }

    /// Check current authorization without triggering the permission dialog.
    func checkStatus() -> CalendarStatusResult {
        let status: EKAuthorizationStatus
        if #available(macOS 14.0, *) {
            status = EKEventStore.authorizationStatus(for: .event)
        } else {
            status = EKEventStore.authorizationStatus(for: .event)
        }

        let hasAccess: Bool
        if #available(macOS 14.0, *) {
            hasAccess = status == .fullAccess
        } else {
            hasAccess = status == .authorized
        }

        let calendars = hasAccess ? getExchangeCalendars() : []
        return CalendarStatusResult(hasAccess: hasAccess, exchangeCalendars: calendars)
    }

    // MARK: - Exchange Calendar Discovery

    /// Find all calendars from Exchange or Exchange-like sources.
    private func getExchangeCalendars() -> [ExchangeCalendarInfo] {
        var results: [ExchangeCalendarInfo] = []

        for source in store.sources {
            let isExchange: Bool
            switch source.sourceType {
            case .exchange:
                isExchange = true
            case .calDAV:
                // Some orgs configure Exchange as CalDAV — check title
                let title = source.title.lowercased()
                isExchange = title.contains("exchange") || title.contains("office 365") || title.contains("outlook")
            default:
                isExchange = false
            }

            guard isExchange else { continue }

            for calendar in source.calendars(for: .event) {
                let color = colorToHex(calendar.cgColor) ?? "#0078d4"
                results.append(ExchangeCalendarInfo(
                    id: calendar.calendarIdentifier,
                    title: calendar.title,
                    accountName: source.title,
                    color: color
                ))
            }
        }

        return results
    }

    // MARK: - Event Fetching

    /// Fetch events from Exchange calendars within the given date range.
    func fetchExchangeEvents(timeMin: Date, timeMax: Date) -> [CalendarEventJSON] {
        let exchangeCalendars = getExchangeCalendars()
        let calendarIds = Set(exchangeCalendars.map { $0.id })

        // Get EKCalendar objects matching our Exchange calendars
        let ekCalendars = store.calendars(for: .event).filter { calendarIds.contains($0.calendarIdentifier) }

        guard !ekCalendars.isEmpty else {
            return []
        }

        let predicate = store.predicateForEvents(withStart: timeMin, end: timeMax, calendars: ekCalendars)
        let events = store.events(matching: predicate)

        return events.map { event in
            // Send real email addresses, never display names. EventKit exposes the
            // attendee's address as a `mailto:` URL on `participant.url`; `.name` is
            // only a display label (e.g. "Sarah Hale (ext)"). Preferring the name —
            // as this used to — wrote labels into the CRM's contact.email column.
            let attendeeEmails = event.attendees?.compactMap { Self.participantEmail($0) } ?? []

            let organizer = event.organizer.flatMap { Self.participantEmail($0) }

            let conferenceUrl = extractConferenceUrl(from: event)

            return CalendarEventJSON(
                id: Self.occurrenceId(event),
                title: event.title ?? "(No title)",
                start: Self.iso8601Formatter.string(from: event.startDate),
                end: Self.iso8601Formatter.string(from: event.endDate),
                isAllDay: event.isAllDay,
                calendarId: event.calendar.calendarIdentifier,
                calendarName: event.calendar.title,
                location: event.location,
                attendees: Array(attendeeEmails.prefix(20)),
                organizer: organizer,
                conferenceUrl: conferenceUrl,
                hasRecurrence: event.hasRecurrenceRules,
                source: "local_exchange"
            )
        }
    }

    // MARK: - Event Writing

    struct CreateEventInput: Codable {
        let calendarId: String
        let title: String
        let start: String
        let end: String
        let isAllDay: Bool?
        let location: String?
        let notes: String?
    }

    struct UpdateEventInput: Codable {
        let eventId: String
        let title: String?
        let start: String?
        let end: String?
        let location: String?
        let notes: String?
    }

    struct WriteResult: Codable {
        let success: Bool
        let eventId: String?
        let error: String?
    }

    /// Create a new event in the specified Exchange calendar.
    func createEvent(_ input: CreateEventInput) -> WriteResult {
        guard let calendar = store.calendar(withIdentifier: input.calendarId) else {
            return WriteResult(success: false, eventId: nil, error: "Calendar not found: \(input.calendarId)")
        }

        let event = EKEvent(eventStore: store)
        event.calendar = calendar
        event.title = input.title
        event.isAllDay = input.isAllDay ?? false

        if let start = Self.parseDate(input.start) {
            event.startDate = start
        } else {
            return WriteResult(success: false, eventId: nil, error: "Invalid start date: \(input.start)")
        }

        if let end = Self.parseDate(input.end) {
            event.endDate = end
        } else {
            return WriteResult(success: false, eventId: nil, error: "Invalid end date: \(input.end)")
        }

        event.location = input.location
        event.notes = input.notes

        do {
            try store.save(event, span: .thisEvent, commit: true)
            return WriteResult(success: true, eventId: event.eventIdentifier, error: nil)
        } catch {
            return WriteResult(success: false, eventId: nil, error: error.localizedDescription)
        }
    }

    /// Update an existing event.
    func updateEvent(_ input: UpdateEventInput) -> WriteResult {
        guard let event = findEvent(input.eventId) else {
            return WriteResult(success: false, eventId: nil, error: "Event not found: \(input.eventId)")
        }

        // An unparsable time fails the update, rather than saving the other
        // fields and reporting a move that never happened.
        var startDate: Date?
        var endDate: Date?
        if let start = input.start {
            guard let date = Self.parseDate(start) else {
                return WriteResult(success: false, eventId: nil, error: "Invalid start date: \(start)")
            }
            startDate = date
        }
        if let end = input.end {
            guard let date = Self.parseDate(end) else {
                return WriteResult(success: false, eventId: nil, error: "Invalid end date: \(end)")
            }
            endDate = date
        }

        if let title = input.title { event.title = title }
        if let date = startDate { event.startDate = date }
        if let date = endDate { event.endDate = date }
        if let location = input.location { event.location = location }
        if let notes = input.notes { event.notes = notes }

        do {
            try store.save(event, span: .thisEvent, commit: true)
            return WriteResult(success: true, eventId: Self.occurrenceId(event), error: nil)
        } catch {
            return WriteResult(success: false, eventId: nil, error: error.localizedDescription)
        }
    }

    /// Delete an event.
    func deleteEvent(eventId: String) -> WriteResult {
        guard let event = findEvent(eventId) else {
            return WriteResult(success: false, eventId: nil, error: "Event not found: \(eventId)")
        }

        do {
            try store.remove(event, span: .thisEvent, commit: true)
            return WriteResult(success: true, eventId: eventId, error: nil)
        } catch {
            return WriteResult(success: false, eventId: nil, error: error.localizedDescription)
        }
    }

    /// The id sent for an event. Every occurrence of a recurring series shares
    /// one `eventIdentifier`, so an occurrence's id adds its original
    /// occurrence date ("<eventIdentifier>|<epoch seconds>"); otherwise the
    /// occurrences collapse into one downstream. `findEvent` reads both forms.
    private static func occurrenceId(_ event: EKEvent) -> String {
        let base: String = event.eventIdentifier ?? ""
        guard event.hasRecurrenceRules, let occurrence = event.occurrenceDate else { return base }
        return "\(base)|\(Int(occurrence.timeIntervalSince1970))"
    }

    /// The event an id from `occurrenceId` names. `event(withIdentifier:)`
    /// alone returns a series' FIRST occurrence, so an occurrence id is
    /// matched by its occurrence date instead.
    private func findEvent(_ id: String) -> EKEvent? {
        guard let bar = id.lastIndex(of: "|"),
              let epoch = Int(id[id.index(after: bar)...]) else {
            return store.event(withIdentifier: id)
        }
        let base = String(id[..<bar])
        guard let series = store.event(withIdentifier: base) else { return nil }
        let occurrence = Date(timeIntervalSince1970: TimeInterval(epoch))
        // A moved occurrence keeps its occurrenceDate but starts elsewhere:
        // search a margin around it.
        let margin: TimeInterval = 31 * 24 * 3600
        let predicate = store.predicateForEvents(
            withStart: occurrence.addingTimeInterval(-margin),
            end: occurrence.addingTimeInterval(margin),
            calendars: [series.calendar]
        )
        return store.events(matching: predicate).first {
            $0.eventIdentifier == base
                && $0.occurrenceDate.map { Int($0.timeIntervalSince1970) } == epoch
        }
    }

    private static func parseDate(_ str: String) -> Date? {
        let f1 = ISO8601DateFormatter()
        f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f1.date(from: str) { return d }

        let f2 = ISO8601DateFormatter()
        f2.formatOptions = [.withInternetDateTime]
        return f2.date(from: str)
    }

    // MARK: - Helpers

    /// The email address of an EventKit participant, or nil if it has none.
    ///
    /// EventKit stores the address as a `mailto:` URL on `participant.url`; the
    /// email is its `resourceSpecifier` (the part after "mailto:"). We deliberately
    /// do NOT fall back to `participant.name` — that is a display label, and using
    /// it as an email corrupted the CRM (names written into contact.email). An
    /// attendee with no resolvable address is dropped rather than mislabelled.
    static func participantEmail(_ participant: EKParticipant) -> String? {
        let absolute = participant.url.absoluteString
        guard absolute.lowercased().hasPrefix("mailto:") else { return nil }
        let email = String(absolute.dropFirst("mailto:".count))
            .removingPercentEncoding?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            ?? ""
        guard email.contains("@") else { return nil }
        return email.lowercased()
    }

    /// Extract a video conference URL from the event's URL or notes.
    private func extractConferenceUrl(from event: EKEvent) -> String? {
        // Check event URL first
        if let url = event.url?.absoluteString, isConferenceUrl(url) {
            return url
        }

        // Search notes for meeting URLs
        guard let notes = event.notes else { return nil }

        let patterns = [
            "https://[a-zA-Z0-9.-]*zoom\\.us/[^\\s\"<>]+",
            "https://teams\\.microsoft\\.com/[^\\s\"<>]+",
            "https://meet\\.google\\.com/[^\\s\"<>]+",
            "https://[a-zA-Z0-9.-]*webex\\.com/[^\\s\"<>]+",
            "https://[a-zA-Z0-9.-]*slack\\.com/[^\\s\"<>]+",
        ]

        for pattern in patterns {
            if let regex = try? NSRegularExpression(pattern: pattern, options: []),
               let match = regex.firstMatch(in: notes, options: [], range: NSRange(notes.startIndex..., in: notes)),
               let range = Range(match.range, in: notes) {
                return String(notes[range])
            }
        }

        return nil
    }

    private func isConferenceUrl(_ url: String) -> Bool {
        let lower = url.lowercased()
        return lower.contains("zoom.us") ||
               lower.contains("teams.microsoft.com") ||
               lower.contains("meet.google.com") ||
               lower.contains("webex.com") ||
               lower.contains("slack.com")
    }

    private func colorToHex(_ cgColor: CGColor?) -> String? {
        guard let color = cgColor,
              let components = color.components,
              components.count >= 3 else { return nil }

        let r = Int(components[0] * 255)
        let g = Int(components[1] * 255)
        let b = Int(components[2] * 255)
        return String(format: "#%02x%02x%02x", r, g, b)
    }
}
