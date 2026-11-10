//
//  iOSMarkdownToolbar.swift
//  Native Intelligence
//
//  Basic markdown formatting toolbar for iOS note-taking.
//  Provides quick-insert buttons for common markdown syntax.
//

import SwiftUI

struct iOSMarkdownToolbar: View {
    @Binding var text: String

    var body: some View {
        HStack(spacing: 2) {
            ForEach(buttons, id: \.id) { button in
                Button(action: button.action) {
                    Group {
                        if let icon = button.icon {
                            Image(systemName: icon)
                                .font(.system(size: 15, weight: .medium))
                        } else if let label = button.label {
                            Text(label)
                                .font(.system(size: 15, weight: .bold))
                        }
                    }
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .frame(height: 36)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if button.hasDivider {
                    RoundedRectangle(cornerRadius: 0.5)
                        .fill(.quaternary)
                        .frame(width: 1, height: 16)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
    }

    private struct ToolbarButtonModel: Identifiable {
        let id: String
        let label: String?
        let icon: String?
        let hasDivider: Bool
        let action: () -> Void
    }

    private var buttons: [ToolbarButtonModel] {
        [
            ToolbarButtonModel(id: "heading", label: "H", icon: nil, hasDivider: false, action: insertHeading),
            ToolbarButtonModel(id: "bold", label: nil, icon: "bold", hasDivider: false, action: insertBold),
            ToolbarButtonModel(id: "italic", label: nil, icon: "italic", hasDivider: true, action: insertItalic),
            ToolbarButtonModel(id: "bullet", label: nil, icon: "list.bullet", hasDivider: false, action: insertBulletList),
            ToolbarButtonModel(id: "numbered", label: nil, icon: "list.number", hasDivider: false, action: insertNumberedList),
        ]
    }

    // MARK: - Formatting Actions

    private func insertHeading() {
        appendToNewLine("# ")
    }

    private func insertBold() {
        appendInline("**", "**")
    }

    private func insertItalic() {
        appendInline("*", "*")
    }

    private func insertBulletList() {
        appendToNewLine("- ")
    }

    private func insertNumberedList() {
        appendToNewLine("1. ")
    }


    // MARK: - Helpers

    private func appendToNewLine(_ prefix: String) {
        if text.isEmpty || text.hasSuffix("\n") {
            text += prefix
        } else {
            text += "\n" + prefix
        }
    }

    private func appendInline(_ before: String, _ after: String) {
        text += before + after
    }

    // MARK: - List Continuation

    /// Call from `.onChange(of: text)` to auto-continue lists when the user presses Enter.
    static func continueLists(in text: inout String, oldText: String) {
        // Only act when a single newline was just added
        guard text.count > oldText.count,
              text.last == "\n" || text.hasSuffix("\n") else { return }

        // Find the line before the newly inserted newline
        let withoutTrailingNewline = String(text.dropLast())
        guard let lastNewlineIndex = withoutTrailingNewline.lastIndex(of: "\n") else {
            // Only one line before the newline
            let previousLine = withoutTrailingNewline
            if let prefix = listPrefix(for: previousLine) {
                text += prefix
            }
            return
        }

        let previousLine = String(withoutTrailingNewline[withoutTrailingNewline.index(after: lastNewlineIndex)...])

        // If the previous line was just an empty list marker, remove it (exit list)
        let trimmed = previousLine.trimmingCharacters(in: .whitespaces)
        if trimmed == "-" || trimmed == "*" || trimmed.wholeMatch(of: /\d+\./) != nil {
            // Remove the empty marker line
            let markerStart = withoutTrailingNewline.index(after: lastNewlineIndex)
            text = String(text[text.startIndex..<markerStart])
            return
        }

        if let prefix = listPrefix(for: previousLine) {
            text += prefix
        }
    }

    private static func listPrefix(for line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let indent = String(line.prefix(while: { $0 == " " }))

        // Bullet list: "- something" or "* something"
        if trimmed.hasPrefix("- ") && trimmed.count > 2 {
            return indent + "- "
        }
        if trimmed.hasPrefix("* ") && trimmed.count > 2 {
            return indent + "* "
        }

        // Numbered list: "1. something", "2. something", etc.
        if let match = trimmed.firstMatch(of: /^(\d+)\.\s(.+)/) {
            let num = Int(match.1) ?? 0
            return indent + "\(num + 1). "
        }

        return nil
    }
}
