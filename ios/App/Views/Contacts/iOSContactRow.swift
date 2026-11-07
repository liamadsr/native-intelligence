import SwiftUI

struct iOSContactRow: View {
    let contact: Contact

    var body: some View {
        HStack(spacing: 12) {
            // Avatar
            ZStack {
                Circle()
                    .fill(Color(hex: contact.avatarColor).opacity(0.2))
                Text(contact.initials)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color(hex: contact.avatarColor))
            }
            .frame(width: 40, height: 40)

            VStack(alignment: .leading, spacing: 2) {
                Text(contact.displayName)
                    .font(.body.weight(.medium))
                    .lineLimit(1)

                if let company = contact.company, !company.isEmpty {
                    Text(contact.jobTitle != nil ? "\(contact.jobTitle!) at \(company)" : company)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            Spacer()

            if contact.isFavorite {
                Image(systemName: "star.fill")
                    .foregroundStyle(.yellow)
                    .font(.caption)
            }
        }
        .padding(.vertical, 2)
    }
}

private extension Contact {
    var avatarColor: String {
        // Generate a consistent color based on the contact's name
        let hash = displayName.hashValue
        let colors = ["#4A90D9", "#7B61FF", "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", "#FFEAA7", "#DDA0DD"]
        return colors[abs(hash) % colors.count]
    }
}
