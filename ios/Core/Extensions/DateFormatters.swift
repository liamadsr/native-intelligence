import Foundation

// MARK: - Date Parsing Utility

/// Unified date parsing utility for consistent date handling across the app.
/// Handles ISO8601, date-only strings, natural language, and Supabase date formats.
struct DateParsingUtility {
    // MARK: - Static Formatters (cached for performance)

    private static let iso8601WithFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let iso8601Standard: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let dateTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone.current
        return formatter
    }()

    private static let dateOnlyFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone.current
        return formatter
    }()

    // MARK: - Main Parsing Method

    /// Parse a date string in various formats.
    /// Tries formats in order: ISO8601 with fractional seconds, ISO8601, datetime without timezone, date only, natural language.
    /// - Parameter string: The date string to parse
    /// - Returns: Parsed Date or nil if parsing failed
    static func parse(_ string: String) -> Date? {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        // 1. Try ISO8601 with fractional seconds (e.g., "2025-01-14T22:50:00.000Z")
        if let date = iso8601WithFractionalSeconds.date(from: trimmed) {
            return date
        }

        // 2. Try ISO8601 without fractional seconds (e.g., "2025-01-14T22:50:00Z")
        if let date = iso8601Standard.date(from: trimmed) {
            return date
        }

        // 3. Try datetime without timezone (e.g., "2025-01-14T22:50:00")
        if let date = dateTimeFormatter.date(from: trimmed) {
            return date
        }

        // 4. Try date only (e.g., "2025-01-14")
        if let date = dateOnlyFormatter.date(from: trimmed) {
            return date
        }

        // 5. Try natural language parsing (e.g., "today at 3pm", "tomorrow", "next Monday")
        if let date = parseNaturalLanguage(trimmed) {
            return date
        }

        return nil
    }

    // MARK: - Natural Language Parsing

    /// Parse natural language date strings like "today at 11:00 PM", "tomorrow at 3pm", "next Monday"
    static func parseNaturalLanguage(_ string: String) -> Date? {
        let calendar = Calendar.current
        let now = Date()
        let lowercased = string.lowercased()

        // Parse "today at X"
        if lowercased.contains("today") {
            if let time = extractTime(from: lowercased) {
                var components = calendar.dateComponents([.year, .month, .day], from: now)
                components.hour = time.hour
                components.minute = time.minute
                components.second = 0
                return calendar.date(from: components)
            }
            return now
        }

        // Parse "tomorrow at X"
        if lowercased.contains("tomorrow") {
            guard let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) else { return nil }
            if let time = extractTime(from: lowercased) {
                var components = calendar.dateComponents([.year, .month, .day], from: tomorrow)
                components.hour = time.hour
                components.minute = time.minute
                components.second = 0
                return calendar.date(from: components)
            }
            return tomorrow
        }

        // Parse "next week", "next month"
        if lowercased.contains("next week") {
            return calendar.date(byAdding: .weekOfYear, value: 1, to: now)
        }
        if lowercased.contains("next month") {
            return calendar.date(byAdding: .month, value: 1, to: now)
        }

        // Parse weekday names like "Monday at 3pm", "next Monday"
        let weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
        for (index, weekday) in weekdays.enumerated() {
            if lowercased.contains(weekday) {
                let targetWeekday = index + 1 // Calendar weekday is 1-indexed
                let currentWeekday = calendar.component(.weekday, from: now)
                var daysToAdd = targetWeekday - currentWeekday
                if daysToAdd <= 0 { daysToAdd += 7 } // Next week if today or past

                guard let targetDate = calendar.date(byAdding: .day, value: daysToAdd, to: now) else { return nil }
                if let time = extractTime(from: lowercased) {
                    var components = calendar.dateComponents([.year, .month, .day], from: targetDate)
                    components.hour = time.hour
                    components.minute = time.minute
                    components.second = 0
                    return calendar.date(from: components)
                }
                return targetDate
            }
        }

        // Try NSDataDetector as a fallback
        if let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.date.rawValue) {
            let range = NSRange(string.startIndex..., in: string)
            if let match = detector.firstMatch(in: string, options: [], range: range), let date = match.date {
                return date
            }
        }

        return nil
    }

    /// Extract time component from a string (e.g., "11:00 PM", "3pm")
    private static func extractTime(from str: String) -> (hour: Int, minute: Int)? {
        let patterns = [
            "([0-9]{1,2}):([0-9]{2})\\s*(am|pm)",  // 11:00 PM
            "([0-9]{1,2})\\s*(am|pm)",              // 3pm, 3 pm
        ]

        for pattern in patterns {
            if let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) {
                let range = NSRange(str.startIndex..., in: str)
                if let match = regex.firstMatch(in: str, options: [], range: range) {
                    var hour = 0
                    var minute = 0

                    if match.numberOfRanges >= 3 {
                        if let hourRange = Range(match.range(at: 1), in: str) {
                            hour = Int(str[hourRange]) ?? 0
                        }

                        // Check if we have minutes (3-group match: hour, minute, am/pm)
                        if match.numberOfRanges >= 4, let minuteRange = Range(match.range(at: 2), in: str) {
                            minute = Int(str[minuteRange]) ?? 0
                            if let ampmRange = Range(match.range(at: 3), in: str) {
                                let ampm = String(str[ampmRange]).lowercased()
                                if ampm == "pm" && hour != 12 { hour += 12 }
                                if ampm == "am" && hour == 12 { hour = 0 }
                            }
                        } else {
                            // 2-group match (hour + am/pm)
                            if let ampmRange = Range(match.range(at: 2), in: str) {
                                let ampm = String(str[ampmRange]).lowercased()
                                if ampm == "pm" && hour != 12 { hour += 12 }
                                if ampm == "am" && hour == 12 { hour = 0 }
                            }
                        }
                    }

                    return (hour, minute)
                }
            }
        }
        return nil
    }

    // MARK: - Formatting Methods

    /// Format a date for human-readable display (e.g., "tomorrow at 3:00 PM", "Dec 15 at 9:00 AM")
    static func formatForDisplay(_ date: Date) -> String {
        let calendar = Calendar.current
        let now = Date()

        let timeFormatter = DateFormatter()
        timeFormatter.timeStyle = .short
        let timeString = timeFormatter.string(from: date)

        if calendar.isDateInToday(date) {
            return "today at \(timeString)"
        } else if calendar.isDateInTomorrow(date) {
            return "tomorrow at \(timeString)"
        } else if calendar.isDateInYesterday(date) {
            return "yesterday at \(timeString)"
        } else {
            let daysFromNow = calendar.dateComponents([.day], from: now, to: date).day ?? 0
            if daysFromNow > 0 && daysFromNow < 7 {
                let weekdayFormatter = DateFormatter()
                weekdayFormatter.dateFormat = "EEEE"
                return "\(weekdayFormatter.string(from: date)) at \(timeString)"
            } else {
                let fullFormatter = DateFormatter()
                fullFormatter.dateFormat = "MMM d"
                return "\(fullFormatter.string(from: date)) at \(timeString)"
            }
        }
    }

    /// Format a date as date-only string (yyyy-MM-dd)
    static func formatDateOnly(_ date: Date) -> String {
        return dateOnlyFormatter.string(from: date)
    }

    /// Format a date as ISO8601 string
    static func formatISO8601(_ date: Date) -> String {
        return iso8601Standard.string(from: date)
    }
}

// MARK: - Codable Date Decoding Extension

/// Extension to decode dates flexibly from Supabase/API responses
extension KeyedDecodingContainer {
    /// Decode a date that might be in various formats (ISO8601 with/without time, date-only)
    func decodeFlexibleDate(forKey key: Key) throws -> Date {
        let dateString = try decode(String.self, forKey: key)
        guard let date = DateParsingUtility.parse(dateString) else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(
                    codingPath: codingPath + [key],
                    debugDescription: "Invalid date format: \(dateString)"
                )
            )
        }
        return date
    }

    /// Decode an optional date that might be in various formats
    func decodeFlexibleDateIfPresent(forKey key: Key) throws -> Date? {
        guard let dateString = try decodeIfPresent(String.self, forKey: key) else {
            return nil
        }
        return DateParsingUtility.parse(dateString)
    }
}
