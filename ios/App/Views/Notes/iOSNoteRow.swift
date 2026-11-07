import SwiftUI

struct iOSNoteRow: View {
    let note: Note

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: noteTypeIcon)
                    .foregroundStyle(.secondary)
                    .font(.caption)

                Text(note.title)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
            }

            if let summary = note.summary ?? note.content, !summary.isEmpty {
                Text(summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            HStack(spacing: 8) {
                Text(note.createdAt.formatted(.relative(presentation: .named)))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)

                if note.isPinned {
                    Image(systemName: "pin.fill")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }

                if !note.tags.isEmpty {
                    Text(note.tags.prefix(3).joined(separator: ", "))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var noteTypeIcon: String {
        switch note.type {
        case .meeting: return "person.2.fill"
        case .journal: return "book.fill"
        case .idea: return "lightbulb.fill"
        case .webpage: return "globe"
        }
    }
}
