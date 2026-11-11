//
//  iOSTeamChatMessageRow.swift
//  Native Intelligence
//
//  One team chat message: who and when (a run of one person's messages
//  draws the name once), the words with their @-mentions, edited and deleted
//  marks, images and files, the link's preview card, reactions as chips, and
//  the thread's summary bar. A long press reacts, replies in a thread,
//  copies, edits or deletes (the person's own; their agent's reply can only
//  be deleted).
//

import SwiftUI

struct iOSTeamChatMessageRow: View {
    let shown: TeamChatShownMessage
    let continues: Bool
    @ObservedObject var model: TeamChatConversationModel
    var highlighted = false
    /// The thread's summary under this message (the channel's own messages).
    var summary: TeamChatThreadSummary?
    /// Open the thread (nil inside a thread).
    var openThread: ((TeamChatMessage) -> Void)?
    var showsThreadActions = true

    @State private var choosingEmoji = false
    @State private var confirmingDelete = false

    private var m: TeamChatMessage { shown.message }
    private var store: TeamChatStore { model.store }
    private var isMine: Bool { m.authorKind == "member" && m.authorMemberId == model.me }
    private var isMyAgent: Bool { m.isAgent && m.agentForMemberId == model.me }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if continues {
                Color.clear.frame(width: 36, height: 1)
            } else {
                TeamChatAvatar(member: m.authorMemberId.flatMap { store.members[$0] }, agent: m.isAgent, size: 36)
            }
            VStack(alignment: .leading, spacing: 6) {
                if !continues { header }
                content
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.top, continues ? 2 : 10)
        .padding(.bottom, 2)
        .background(highlighted ? TeamChatStyle.mentionFill : Color.clear)
        .opacity(shown.isSending ? 0.55 : 1)
        .contentShape(Rectangle())
        .contextMenu { if !m.isDeleted && !shown.isSending && !shown.failed { menu } }
        .sheet(isPresented: $choosingEmoji) {
            TeamChatEmojiPicker { emoji in
                model.toggleReaction(messageId: m.id, emoji: emoji)
            }
            .presentationDetents([.height(320)])
        }
        .confirmationDialog("Delete this message?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { model.delete(m) }
        } message: {
            Text("It is removed for everyone in the conversation.")
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(TeamChatNames.author(of: m, members: store.members, me: model.me))
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)
            Text(TeamChatFormat.messageTime(m.createdAt))
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var content: some View {
        if m.isDeleted {
            Text("This message was deleted.")
                .font(.system(size: 16).italic())
                .foregroundStyle(.secondary)
        } else {
            if !m.body.isEmpty {
                Text("\(bodyText)\(editedMark)")
                    .font(.system(size: 16))
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !m.attachments.isEmpty { files }
            if let preview = m.linkPreview { linkCard(preview) }
            if shown.failed { failedLine }
            if shown.isSending { Text("Sending…").font(.system(size: 12)).foregroundStyle(.secondary) }
            let chips = model.chips(for: m.id)
            if !chips.isEmpty { reactions(chips) }
            if let summary, summary.replyCount > 0, let openThread { threadBar(summary, open: { openThread(m) }) }
        }
    }

    // MARK: Words

    private var bodyText: Text {
        let labels = TeamChatNames.mentionLabels(of: m, members: store.members, agentName: store.agentName, me: model.me)
        let myName = model.me.flatMap { store.members[$0]?.displayName }
        var out = Text("")
        for seg in TeamChatMentions.segments(m.body, labels: labels) {
            if seg.mention {
                let isMe = myName.map { seg.text.dropFirst().lowercased() == $0.lowercased() } ?? false
                out = Text("\(out)\(Text(seg.text).fontWeight(.semibold).foregroundColor(isMe ? TeamChatStyle.mention : .primary))")
            } else {
                out = Text("\(out)\(Text(Self.linked(seg.text)))")
            }
        }
        return out
    }

    private var editedMark: Text {
        m.editedAt == nil ? Text("") : Text(" (edited)").font(.system(size: 13)).foregroundColor(.secondary)
    }

    /// Links in the words tappable.
    private static func linked(_ text: String) -> AttributedString {
        var out = AttributedString(text)
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return out }
        for match in detector.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let url = match.url, let r = Range(match.range, in: text), let ar = Range(r, in: out) else { continue }
            out[ar].link = url
            out[ar].underlineStyle = .single
        }
        return out
    }

    // MARK: Files, preview

    private var files: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(m.attachments, id: \.path) { a in
                if a.isImage {
                    TeamChatFileImage(attachment: a, store: store)
                } else {
                    TeamChatFileChip(attachment: a, store: store)
                }
            }
        }
    }

    private func linkCard(_ p: TeamChatLinkPreview) -> some View {
        Link(destination: URL(string: p.url) ?? URL(string: "about:blank")!) {
            HStack(alignment: .top, spacing: 0) {
                Rectangle().fill(Color(.separator)).frame(width: 3)
                VStack(alignment: .leading, spacing: 3) {
                    Text(p.site).font(.system(size: 13)).foregroundStyle(.secondary).lineLimit(1)
                    if let title = p.title { Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(.primary).lineLimit(2) }
                    if let d = p.description { Text(d).font(.system(size: 14)).foregroundStyle(.secondary).lineLimit(3) }
                    if let image = p.image.flatMap(URL.init(string:)), !store.isFixture {
                        AsyncImage(url: image) { img in img.resizable().scaledToFill() } placeholder: { Color.clear }
                            .frame(maxWidth: 240, maxHeight: 130)
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .padding(.top, 4)
                    }
                }
                .multilineTextAlignment(.leading)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: 300, alignment: .leading)
            .background(TeamChatStyle.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var failedLine: some View {
        HStack(spacing: 12) {
            Label("Not sent", systemImage: "exclamationmark.circle")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Color(.systemRed))
            Button("Try again") { if let id = m.clientId { model.retry(clientId: id) } }
                .font(.system(size: 13, weight: .semibold))
            Button("Delete") { if let id = m.clientId { model.discard(clientId: id) } }
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
    }

    // MARK: Reactions, thread

    private func reactions(_ chips: [TeamChatReactionChip]) -> some View {
        TeamChatFlow(spacing: 6) {
            ForEach(chips) { chip in
                Button {
                    model.toggleReaction(messageId: m.id, emoji: chip.emoji)
                } label: {
                    HStack(spacing: 4) {
                        Text(chip.emoji).font(.system(size: 14))
                        Text("\(chip.count)").font(.system(size: 13, weight: chip.mine ? .semibold : .regular)).foregroundStyle(.primary)
                    }
                    .padding(.horizontal, 8)
                    .frame(height: 28)
                    .background(Capsule().fill(chip.mine ? Color.primary.opacity(0.12) : TeamChatStyle.tile))
                    .overlay(Capsule().strokeBorder(chip.mine ? Color.primary.opacity(0.35) : .clear, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(chip.emoji) \(chip.count)\(chip.mine ? ", yours" : "")")
            }
            if model.canPost {
                Button { choosingEmoji = true } label: {
                    Image(systemName: "face.smiling")
                        .font(.system(size: 14))
                        .foregroundStyle(.secondary)
                        .frame(width: 34, height: 28)
                        .background(Capsule().fill(TeamChatStyle.tile))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Add a reaction")
            }
        }
    }

    private func threadBar(_ s: TeamChatThreadSummary, open: @escaping () -> Void) -> some View {
        Button(action: open) {
            HStack(spacing: 8) {
                HStack(spacing: -6) {
                    ForEach(s.participantIds.prefix(3), id: \.self) { id in
                        TeamChatAvatar(member: store.members[id], size: 20)
                            .overlay(Circle().strokeBorder(TeamChatStyle.background, lineWidth: 1.5))
                    }
                }
                Text(s.replyCount == 1 ? "1 reply" : "\(s.replyCount) replies")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.primary)
                if let last = TeamChatFormat.lastReply(s.lastReplyAt) {
                    Text(last).font(.system(size: 13)).foregroundStyle(.secondary).lineLimit(1)
                }
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(.tertiary)
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 8)
            .background(TeamChatStyle.card, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    // MARK: Menu

    @ViewBuilder
    private var menu: some View {
        if model.canPost {
            ControlGroup {
                ForEach(TeamChatReactions.quick.prefix(4), id: \.self) { emoji in
                    Button(emoji) { model.toggleReaction(messageId: m.id, emoji: emoji) }
                }
            }
            Button { choosingEmoji = true } label: { Label("Add reaction", systemImage: "face.smiling") }
        }
        if showsThreadActions, let openThread {
            Button { openThread(m) } label: { Label("Reply in thread", systemImage: "bubble.left.and.bubble.right") }
        }
        if !m.body.isEmpty {
            Button { UIPasteboard.general.string = m.body } label: { Label("Copy", systemImage: "doc.on.doc") }
        }
        if isMine, !m.body.isEmpty {
            Button { model.beginEdit(m) } label: { Label("Edit", systemImage: "pencil") }
        }
        if isMine || isMyAgent {
            Button(role: .destructive) { confirmingDelete = true } label: { Label("Delete", systemImage: "trash") }
        }
    }
}

/// A few dozen emoji to react with (any one emoji works; these are the reach of one tap).
struct TeamChatEmojiPicker: View {
    let pick: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    private static let emoji = [
        "👍", "❤️", "😂", "🎉", "👀", "✅", "🙏", "🔥", "💯", "😊", "😮", "😢",
        "👏", "🙌", "💪", "🤔", "😅", "🚀", "⭐️", "💡", "📌", "⚡️", "☕️", "🍕",
        "👌", "🤝", "🫡", "😍", "🥳", "😬", "❌", "➕", "⏰", "📈", "🧠", "🌱",
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 6), spacing: 8) {
                    ForEach(Self.emoji, id: \.self) { e in
                        Button {
                            pick(e)
                            dismiss()
                        } label: {
                            Text(e).font(.system(size: 30)).frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(16)
            }
            .navigationTitle("React")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}

/// Chips that wrap onto the next line.
struct TeamChatFlow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, widest: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width {
                y += row + spacing
                x = 0
                row = 0
            }
            x += size.width + spacing
            row = max(row, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, width), height: y + row)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, row: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                y += row + spacing
                x = bounds.minX
                row = 0
            }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            row = max(row, size.height)
        }
    }
}
