//
//  iOSTeamChatPreview.swift
//  Native Intelligence
//
//  DEBUG only: team chat's screens over made-up people and messages, with no
//  sign-in and no network, so they can be looked at and screenshotted in the
//  Simulator:
//
//    xcrun simctl launch <device> com.dial8-iOS-26 -previewTeamChat YES \
//      -previewTeamChatScreen list|conversation|focus|thread|mention
//

#if DEBUG
import SwiftUI

struct iOSTeamChatPreview: View {
    private let screen = UserDefaults.standard.string(forKey: "previewTeamChatScreen") ?? "list"
    @StateObject private var conversation = TeamChatFixture.conversation(mentioning: false)
    @StateObject private var focused = TeamChatFixture.conversation(mentioning: false, focus: true)
    @StateObject private var mentioning = TeamChatFixture.conversation(mentioning: true)
    @StateObject private var thread = TeamChatFixture.thread()

    init() {
        TeamChatFixture.fillStore()
    }

    var body: some View {
        NavigationStack {
            switch screen {
            case "conversation": iOSTeamChatConversationView(model: conversation)
            case "focus": iOSTeamChatConversationView(model: focused)
            case "mention": iOSTeamChatConversationView(model: mentioning)
            case "thread": iOSTeamChatThreadView(model: thread)
            default: iOSTeamChatListView()
            }
        }
    }
}

@MainActor
enum TeamChatFixture {
    static let me = "f0000000-0000-4000-8000-000000000001"
    static let ana = "f0000000-0000-4000-8000-000000000002"
    static let mara = "f0000000-0000-4000-8000-000000000003"
    static let ben = "f0000000-0000-4000-8000-000000000004"
    static let launch = "c0000000-0000-4000-8000-000000000001"
    static let root = "e0000000-0000-4000-8000-000000000003"

    static let members = [
        TeamChatMember(id: ana, userId: nil, displayName: "Ana Ruiz", avatarUrl: nil),
        TeamChatMember(id: ben, userId: nil, displayName: "Ben Okafor", avatarUrl: nil),
        TeamChatMember(id: mara, userId: nil, displayName: "Mara Chen", avatarUrl: nil),
        TeamChatMember(id: me, userId: nil, displayName: "Theo Park", avatarUrl: nil),
    ]

    static func ago(_ minutes: Double) -> String { TeamChatTime.now(Date().addingTimeInterval(-minutes * 60)) }

    static func channel(_ id: String, _ name: String?, kind: TeamChatChannelKind = .channel, dm: String? = nil, topic: String? = nil, last: Double,
                        unread: Int = 0, mentions: Int = 0, threadUnread: Int = 0, notify: TeamChatNotifyLevel? = nil) -> TeamChatChannel {
        TeamChatChannel(id: id, kind: kind, name: name, topic: topic, teamId: nil, dmMemberId: dm, lastMessageAt: ago(last), archivedAt: nil,
                        unread: unread, mentions: mentions, threadUnread: threadUnread, threadMentions: 0,
                        notify: notify ?? TeamChatNotifyLevel.defaultLevel(for: kind))
    }

    static func fillStore() {
        TeamChatStore.shared.loadFixture(channels: [
            channel(launch, "launch", topic: "Spring catalogue, ships 14 March", last: 4, unread: 3, mentions: 1),
            channel("c0000000-0000-4000-8000-000000000002", "design", last: 38, unread: 5),
            channel("c0000000-0000-4000-8000-000000000003", "general", last: 70, unread: 12, notify: .muted),
            channel("c0000000-0000-4000-8000-000000000004", "ops", topic: "Shipping, stock, the studio", last: 60 * 26),
            channel("d0000000-0000-4000-8000-000000000001", nil, kind: .dm, dm: ana, last: 12, unread: 2),
            channel("d0000000-0000-4000-8000-000000000002", nil, kind: .dm, dm: mara, last: 60 * 5, threadUnread: 1),
            channel("d0000000-0000-4000-8000-000000000003", nil, kind: .dm, dm: me, last: 60 * 50),
        ], members: members, me: me, agentName: "Juniper")
    }

    static func msg(_ n: Int, by: String?, _ body: String, at: Double, agentFor: String? = nil, thread: String? = nil, mentions: [String] = [],
                    files: [TeamChatAttachment] = [], preview: TeamChatLinkPreview? = nil, edited: Bool = false, deleted: Bool = false) -> TeamChatMessage {
        TeamChatMessage(
            id: String(format: "e0000000-0000-4000-8000-%012d", n), channelId: launch,
            authorKind: agentFor == nil ? "member" : "agent", authorMemberId: agentFor == nil ? by : nil,
            agentForMemberId: agentFor, agentName: agentFor == nil ? nil : "Juniper", threadRootId: thread,
            body: deleted ? "" : body, mentions: mentions, attachments: files, linkPreview: preview,
            createdAt: ago(at), editedAt: edited ? ago(at - 1) : nil, deletedAt: deleted ? ago(at - 2) : nil
        )
    }

    /// `focus`: opened at the thread's root, as a tapped push opens a message (scrolled there, marked a moment).
    static func conversation(mentioning: Bool, focus: Bool = false) -> TeamChatConversationModel {
        let model = TeamChatConversationModel(channelId: launch, focusMessageId: focus ? root : nil, store: .shared)
        let photo = TeamChatAttachment(path: "\(launch)/u/a.jpg", name: "Photo.jpg", size: 412_000, type: "image/jpeg", width: 1600, height: 1000)
        let pdf = TeamChatAttachment(path: "\(launch)/u/b.pdf", name: "Spring catalogue v3.pdf", size: 3_400_000, type: "application/pdf")
        let messages = [
            msg(1, by: ana, "Morning! Proofs for the spring catalogue came back from the printer.", at: 62),
            msg(2, by: ana, "Cover shot from yesterday's session:", at: 61, files: [photo]),
            msg(3, by: mara, "Love the light on that one. Can we push the deadline for the inside pages to Friday?", at: 45),
            msg(4, by: ben, "Here's the layout with the new grid", at: 30, files: [pdf], edited: true),
            msg(5, by: ben, "", at: 29, deleted: true),
            msg(6, by: ana, "Printer's spec sheet, for the paper weights: https://printshop.example/specs", at: 18,
                preview: TeamChatLinkPreview(url: "https://printshop.example/specs", site: "Northgate Print", title: "Paper stocks and finishes", description: "Weights, coatings and lead times for catalogue runs, updated for spring.", image: nil)),
            msg(7, by: mara, "@Theo Park can you sign off on the cover by end of day?", at: 6, mentions: [me]),
            msg(8, by: nil, "Theo, the printer needs the final files by Thursday 5pm to hold the 14 March ship date. Mara's layout is the latest.", at: 4, agentFor: me),
        ]
        let page = TeamChatMessagesResponse(
            messages: messages,
            threads: [TeamChatThreadSummary(rootId: root, channelId: launch, replyCount: 4, lastReplyAt: ago(9), participantIds: [ben, ana, me])],
            reactions: [
                TeamChatReaction(messageId: messages[1].id, memberId: mara, emoji: "😍", active: true),
                TeamChatReaction(messageId: messages[1].id, memberId: ben, emoji: "😍", active: true),
                TeamChatReaction(messageId: messages[1].id, memberId: me, emoji: "🔥", active: true),
                TeamChatReaction(messageId: messages[3].id, memberId: ana, emoji: "👀", active: true),
                TeamChatReaction(messageId: messages[6].id, memberId: ana, emoji: "👍", active: true),
            ],
            root: nil
        )
        let pending = mentioning ? [] : [TeamChatPendingSend(clientId: "k1", channelId: launch, threadRootId: nil, body: "On it, I'll look after lunch", mentions: [], mentionsAgent: false, attachments: [], createdAt: TeamChatTime.now())]
        model.loadFixture(page, pending: pending, typing: mentioning ? nil : "Ana Ruiz is typing…", draft: mentioning ? "Looping in @" : "")
        return model
    }

    static func thread() -> TeamChatConversationModel {
        let model = TeamChatConversationModel(channelId: launch, threadRootId: root, store: .shared)
        let rootMessage = msg(3, by: mara, "Love the light on that one. Can we push the deadline for the inside pages to Friday?", at: 45)
        let replies = [
            msg(11, by: ben, "Friday works for me if the printer can still hold the slot.", at: 40, thread: root),
            msg(12, by: ana, "I'll ask them this morning.", at: 33, thread: root),
            msg(13, by: ana, "They can do Friday noon, not later.", at: 12, thread: root),
            msg(14, by: me, "Friday noon it is. I'll tell the photographer.", at: 9, thread: root),
        ]
        let page = TeamChatMessagesResponse(
            messages: replies, threads: nil,
            reactions: [TeamChatReaction(messageId: replies[2].id, memberId: mara, emoji: "🙏", active: true), TeamChatReaction(messageId: replies[2].id, memberId: me, emoji: "🙏", active: true)],
            root: rootMessage
        )
        model.loadFixture(page, typing: "Mara Chen is typing…")
        return model
    }
}
#endif
