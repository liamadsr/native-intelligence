//
//  iOSTeamChatComponents.swift
//  Native Intelligence
//
//  The small pieces team chat's screens share: the palette (Home's), avatars,
//  times, a file's signed image, the notification menu.
//

import SwiftUI

enum TeamChatStyle {
    /// Home's list surface: #1A1A1A dark / white light.
    static let background = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0.102, green: 0.102, blue: 0.102, alpha: 1) : .white })
    /// Home's tile fill: #2C2C2E dark / #F2F2F7 light.
    static let tile = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0.173, green: 0.173, blue: 0.180, alpha: 1) : UIColor(red: 0.949, green: 0.949, blue: 0.969, alpha: 1) })
    /// A card on the list (link previews, files): a step off the background.
    static let card = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0.141, green: 0.141, blue: 0.149, alpha: 1) : UIColor(red: 0.965, green: 0.965, blue: 0.976, alpha: 1) })
    /// The one accent team chat uses: a mention (the person's own name, a mention badge).
    static let mention = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 1.0, green: 0.78, blue: 0.35, alpha: 1) : UIColor(red: 0.72, green: 0.45, blue: 0.0, alpha: 1) })
    static let mentionFill = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 1.0, green: 0.78, blue: 0.35, alpha: 0.16) : UIColor(red: 1.0, green: 0.8, blue: 0.3, alpha: 0.22) })
}

enum TeamChatFormat {
    private static let time: DateFormatter = {
        let f = DateFormatter()
        f.timeStyle = .short
        f.dateStyle = .none
        return f
    }()

    private static let day: DateFormatter = {
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("EEE d MMM")
        return f
    }()

    /// "9:41 AM" today, "Yesterday", "Mon 4 Nov" before.
    static func listTime(_ raw: String?) -> String {
        guard let date = TeamChatTime.date(raw) else { return "" }
        let cal = Calendar.current
        if cal.isDateInToday(date) { return time.string(from: date) }
        if cal.isDateInYesterday(date) { return "Yesterday" }
        return day.string(from: date)
    }

    /// A message's time beside its author: "9:41 AM".
    static func messageTime(_ raw: String) -> String {
        guard let date = TeamChatTime.date(raw) else { return "" }
        return time.string(from: date)
    }

    /// The day a run of messages is on: "Today", "Yesterday", "Mon 4 Nov".
    static func dayTitle(_ raw: String) -> String {
        guard let date = TeamChatTime.date(raw) else { return "" }
        let cal = Calendar.current
        if cal.isDateInToday(date) { return "Today" }
        if cal.isDateInYesterday(date) { return "Yesterday" }
        return day.string(from: date)
    }

    static func sameDay(_ a: String, _ b: String) -> Bool {
        guard let x = TeamChatTime.date(a), let y = TeamChatTime.date(b) else { return true }
        return Calendar.current.isDate(x, inSameDayAs: y)
    }

    /// "Last reply 5 min ago".
    static func lastReply(_ raw: String?) -> String? {
        guard let date = TeamChatTime.date(raw) else { return nil }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return "Last reply \(f.localizedString(for: date, relativeTo: Date()))"
    }
}

/// A member's avatar: their picture, else their initials on a tile.
struct TeamChatAvatar: View {
    let member: TeamChatMember?
    var agent = false
    var size: CGFloat = 36

    var body: some View {
        Group {
            if agent {
                Image(systemName: "sparkle")
                    .font(.system(size: size * 0.42, weight: .medium))
                    .foregroundStyle(.primary)
                    .frame(width: size, height: size)
                    .background(TeamChatStyle.tile, in: Circle())
            } else if let url = member?.avatarUrl.flatMap(URL.init(string:)) {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    initials
                }
                .frame(width: size, height: size)
                .clipShape(Circle())
            } else {
                initials
            }
        }
        .accessibilityHidden(true)
    }

    private var initials: some View {
        let words = (member?.name ?? "?").split(separator: " ")
        let letters = words.prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
        return Text(letters.isEmpty ? "?" : letters)
            .font(.system(size: size * 0.38, weight: .semibold))
            .foregroundStyle(.secondary)
            .frame(width: size, height: size)
            .background(TeamChatStyle.tile, in: Circle())
    }
}

/// An image on a message, through a signed link (the bucket is private).
struct TeamChatFileImage: View {
    let attachment: TeamChatAttachment
    @ObservedObject var store: TeamChatStore
    @State private var url: URL?

    var body: some View {
        let ratio: CGFloat = {
            guard let w = attachment.width, let h = attachment.height, w > 0, h > 0 else { return 4 / 3 }
            return max(0.6, min(2.2, CGFloat(w) / CGFloat(h)))
        }()
        ZStack {
            RoundedRectangle(cornerRadius: 14, style: .continuous).fill(TeamChatStyle.tile)
            if store.isFixture {
                fixtureArt
            } else if let url {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case let .success(image): image.resizable().scaledToFill()
                    case .failure: Image(systemName: "photo").foregroundStyle(.secondary)
                    default: ProgressView()
                    }
                }
            } else {
                ProgressView()
            }
        }
        .aspectRatio(ratio, contentMode: .fit)
        .frame(maxWidth: 260)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .task(id: attachment.path) {
            guard !store.isFixture else { return }
            url = await store.fileURL(attachment.path)
        }
        .accessibilityLabel(attachment.name)
    }

    /// The DEBUG preview's stand-in for a photo: a dusk sky over two hills.
    private var fixtureArt: some View {
        ZStack(alignment: .bottom) {
            LinearGradient(colors: [Color(red: 0.36, green: 0.42, blue: 0.62), Color(red: 0.93, green: 0.62, blue: 0.45)], startPoint: .top, endPoint: .bottom)
            Ellipse().fill(Color(red: 0.20, green: 0.27, blue: 0.30)).frame(width: 320, height: 120).offset(x: -70, y: 60)
            Ellipse().fill(Color(red: 0.14, green: 0.20, blue: 0.23)).frame(width: 300, height: 110).offset(x: 90, y: 62)
        }
    }
}

/// A file that isn't drawn inline: its name and size, opened through a signed link.
struct TeamChatFileChip: View {
    let attachment: TeamChatAttachment
    @ObservedObject var store: TeamChatStore
    @Environment(\.openURL) private var openURL

    var body: some View {
        Button {
            Task {
                if let url = await store.fileURL(attachment.path) { openURL(url) }
            }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 16))
                    .foregroundStyle(.primary)
                    .frame(width: 34, height: 34)
                    .background(TeamChatStyle.tile, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(attachment.name).font(.system(size: 15, weight: .medium)).lineLimit(1).foregroundStyle(.primary)
                    Text(TeamChatFiles.size(attachment.size)).font(.system(size: 13)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(8)
            .frame(maxWidth: 280, alignment: .leading)
            .background(TeamChatStyle.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(attachment.name), \(TeamChatFiles.size(attachment.size))")
    }

    private var icon: String {
        switch TeamChatFiles.ext(attachment.path) {
        case "pdf": return "doc.richtext"
        case "csv", "xls", "xlsx": return "tablecells"
        case "ppt", "pptx": return "rectangle.on.rectangle"
        case "zip": return "doc.zipper"
        case "png", "jpg", "jpeg", "gif", "webp", "heic": return "photo"
        default: return "doc.text"
        }
    }
}

/// How loud a channel is: All messages / Mentions only / Muted, the current one checked.
struct TeamChatNotifyMenu<Label: View>: View {
    let channel: TeamChatChannel
    @ObservedObject var store: TeamChatStore
    @ViewBuilder let label: () -> Label

    var body: some View {
        Menu {
            Section("Notify me about") {
                ForEach(TeamChatNotifyLevel.allCases, id: \.self) { level in
                    Button {
                        Task { await store.setNotify(channelId: channel.id, level: level) }
                    } label: {
                        if channel.notify == level {
                            SwiftUI.Label(level.label, systemImage: "checkmark")
                        } else {
                            Text(level.label)
                        }
                    }
                }
            }
        } label: {
            label()
        }
    }
}
