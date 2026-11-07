//
//  MeetingSummarySections.swift
//  dial8
//
//  Parses AI-generated note content (markdown) into structured sections
//  for display in note detail views.
//

import Foundation

struct MeetingSummarySections {
    var summary: String?
    var decisions: [String]?
    var nextSteps: [String]?
    var openQuestions: [String]?

    // MARK: - HTML comment stripping

    /// The AI summary carries machine-readable markers as HTML comments —
    /// `<!-- proposal:0f3c…-->` after a decision or next step, linking the bullet
    /// back to the proposed change it produced. The web app renders the summary
    /// as HTML, where comments are invisible by definition. iOS renders it as
    /// Markdown text, where they are not: the bullets showed up reading
    /// "Ship the beta <!-- proposal:0f3c… -->".
    ///
    /// `.dotMatchesLineSeparators` is load-bearing — a comment may wrap across
    /// lines, and a line-bounded match would leave half of it on screen.
    private static let htmlCommentPattern = try? NSRegularExpression(
        pattern: "<!--.*?-->",
        options: [.dotMatchesLineSeparators]
    )

    /// Remove every HTML comment from AI-generated text. Applied before parsing
    /// AND before rendering, so neither the section splitter nor the Markdown
    /// view ever sees one.
    static func strippingHTMLComments(_ text: String) -> String {
        guard let regex = htmlCommentPattern, text.contains("<!--") else { return text }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return regex.stringByReplacingMatches(in: text, options: [], range: range, withTemplate: "")
    }

    // Known section headers that should be extracted separately (not included in summary)
    private static let extractedSectionHeaders = [
        "decisions", "decisions made", "key decisions",
        "next steps", "nextsteps",
        "open questions", "questions", "outstanding questions",
        "action items"  // These go to the Actions tab, so exclude from summary
    ]

    /// Parse the AI summary/content into structured sections
    /// The summary includes ALL content except for Decisions, Next Steps, and Open Questions
    /// which are extracted into their own collapsible sections
    static func parse(from rawContent: String) -> MeetingSummarySections {
        var result = MeetingSummarySections()

        guard !rawContent.isEmpty else { return result }

        // Strip BEFORE splitting into lines: a comment spanning a newline would
        // otherwise survive as two half-comments on two separate lines.
        let content = strippingHTMLComments(rawContent)
        let lines = content.components(separatedBy: "\n")
        var summaryLines: [String] = []
        var currentExtractedSection: String? = nil
        var currentExtractedContent: [String] = []

        for line in lines {
            let trimmedLine = line.trimmingCharacters(in: .whitespaces)

            // Check if this is a section header we want to extract separately
            if let sectionName = extractSectionHeader(from: trimmedLine) {
                let lowerName = sectionName.lowercased()

                // Check if this is a section we should extract (Decisions, Next Steps, Open Questions)
                if isExtractedSection(lowerName) {
                    // Save any previous extracted section
                    saveExtractedSection(section: currentExtractedSection, content: currentExtractedContent, to: &result)

                    currentExtractedSection = lowerName
                    currentExtractedContent = []
                } else {
                    // This is a regular section header (like "Workshop Schedule") - include in summary
                    if currentExtractedSection != nil {
                        // We were in an extracted section, save it
                        saveExtractedSection(section: currentExtractedSection, content: currentExtractedContent, to: &result)
                        currentExtractedSection = nil
                        currentExtractedContent = []
                    }
                    summaryLines.append(line)
                }
            } else if currentExtractedSection != nil {
                // We're inside an extracted section - collect its content
                if !trimmedLine.isEmpty || !currentExtractedContent.isEmpty {
                    currentExtractedContent.append(line)
                }
            } else {
                // Regular content - add to summary
                summaryLines.append(line)
            }
        }

        // Save any remaining extracted section
        saveExtractedSection(section: currentExtractedSection, content: currentExtractedContent, to: &result)

        // Clean up summary (remove trailing empty lines)
        let summaryText = summaryLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        if !summaryText.isEmpty {
            result.summary = summaryText
        }

        return result
    }

    /// Check if this section name should be extracted separately
    private static func isExtractedSection(_ name: String) -> Bool {
        return extractedSectionHeaders.contains { name.contains($0) || $0.contains(name) }
    }

    /// Extract section header name from markdown bold headers like **Decisions:** or ## Decisions
    private static func extractSectionHeader(from line: String) -> String? {
        // Match **Section:** or **Section**
        if line.hasPrefix("**") && (line.contains(":**") || line.hasSuffix("**")) {
            var name = line.replacingOccurrences(of: "**", with: "")
            name = name.replacingOccurrences(of: ":", with: "")
            return name.trimmingCharacters(in: .whitespaces)
        }

        // Match ## Section or ### Section
        if line.hasPrefix("##") {
            var name = line.replacingOccurrences(of: "#", with: "")
            name = name.replacingOccurrences(of: ":", with: "")
            return name.trimmingCharacters(in: .whitespaces)
        }

        return nil
    }

    /// Save extracted section content to the appropriate field
    private static func saveExtractedSection(section: String?, content: [String], to result: inout MeetingSummarySections) {
        guard let section = section, !content.isEmpty else { return }

        let items = parseListItems(from: content)
        guard !items.isEmpty else { return }

        if section.contains("decision") {
            result.decisions = items
        } else if section.contains("next") || section.contains("step") {
            result.nextSteps = items
        } else if section.contains("question") {
            result.openQuestions = items
        }
        // Note: "action items" are handled by the Actions tab, so we don't extract them here
    }

    /// Parse bullet list items from lines (removes the - or * prefix).
    ///
    /// Items that are empty once HTML comments are stripped are dropped: a
    /// decision bullet whose entire body was a `<!-- proposal:… -->` marker is
    /// not a decision, and rendering it left a bullet point with nothing beside
    /// it. `- ` / `* ` / a bare `-` with the text gone all collapse to nothing
    /// and fall out in the filter below.
    private static func parseListItems(from lines: [String]) -> [String] {
        return lines.compactMap { line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            // A marker-only bullet loses even its trailing space when the comment
            // is removed, leaving a bare "-" or "*" that no prefix check catches.
            if trimmed == "-" || trimmed == "*" { return nil }
            if trimmed.hasPrefix("- ") {
                return String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespaces)
            } else if trimmed.hasPrefix("* ") {
                return String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespaces)
            } else if let match = trimmed.firstMatch(of: /^\d+\.\s+(.+)/) {
                // Numbered list item
                return String(match.1).trimmingCharacters(in: .whitespaces)
            } else if !trimmed.isEmpty {
                return trimmed
            }
            return nil
        }.filter { !$0.isEmpty }
    }
}
