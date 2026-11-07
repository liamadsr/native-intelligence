import SwiftUI

struct iOSProjectRow: View {
    let project: KBProject

    var body: some View {
        HStack(spacing: 12) {
            // Project icon
            ZStack {
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color(hex: project.color).opacity(0.15))
                Text(project.icon)
                    .font(.system(size: 20))
            }
            .frame(width: 40, height: 40)

            VStack(alignment: .leading, spacing: 2) {
                Text(project.name)
                    .font(.body.weight(.medium))
                    .lineLimit(1)

                if let description = project.description, !description.isEmpty {
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            Spacer()

            if project.isPinned {
                Image(systemName: "pin.fill")
                    .foregroundStyle(.orange)
                    .font(.caption)
            }

            if project.isArchived {
                Image(systemName: "archivebox.fill")
                    .foregroundStyle(.secondary)
                    .font(.caption)
            }
        }
        .padding(.vertical, 2)
    }
}
