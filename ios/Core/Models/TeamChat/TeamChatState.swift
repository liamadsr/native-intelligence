//
//  TeamChatState.swift
//  Native Intelligence
//
//  One conversation's state (a channel, or a thread), and where a tapped push
//  goes, as plain values: the view models (App/Services/TeamChat) hold one and
//  feed it what the routes and Realtime say, so what a screen shows is decided
//  here, where Scripts/test-team-chat.sh can check it.
//

import Foundation

/// A channel's own messages, or one thread's replies (with its root), as one screen shows them.
struct TeamChatConversationState: Equatable {
    let channelId: String
    /// Set for a thread: its root message's id.
    let threadRootId: String?

    private(set) var rows: [TeamChatMessage] = []
    private(set) var pending: [TeamChatPendingSend] = []
    private(set) var reactions: [TeamChatReaction] = []
    /// Thread summaries under the channel's messages, by root id.
    private(set) var threads: [String: TeamChatThreadSummary] = [:]
    /// The thread's root (a thread only).
    private(set) var root: TeamChatMessage?
    /// False once a page came back short: nothing older to load.
    private(set) var hasOlder = true
    /// The page opened around an older message stops short of the newest: live rows wait for "Newest".
    private(set) var hasNewer = false

    /// A page of history holds this many (web TEAM_CHAT_PAGE_SIZE).
    static let pageSize = 50

    init(channelId: String, threadRootId: String? = nil) {
        self.channelId = channelId
        self.threadRootId = threadRootId
    }

    /// What the screen draws, oldest first.
    func shown(me: String?) -> [TeamChatShownMessage] {
        TeamChatTimeline.shown(rows: rows, pending: pending, me: me)
    }

    /// The oldest row's own time: the next page is "before" it.
    var oldestCursor: String? { rows.first?.createdAt }

    // MARK: Loading

    /// The newest page (opening it, or coming back to it): what was there is replaced, sends still on their way stay.
    mutating func loaded(_ page: TeamChatMessagesResponse) {
        rows = page.messages.filter { belongs($0) }
        root = page.root ?? root
        reactions = page.reactions ?? []
        threads = Dictionary((page.threads ?? []).map { ($0.rootId, $0) }, uniquingKeysWith: { _, b in b })
        hasOlder = threadRootId == nil && (page.hasOlder ?? (page.messages.count >= Self.pageSize))
        hasNewer = page.hasNewer ?? false
        pending = TeamChatTimeline.settle(pending, with: rows)
    }

    /// An older page, in front.
    mutating func loadedOlder(_ page: TeamChatMessagesResponse) {
        rows = TeamChatTimeline.prepending(page.messages.filter { belongs($0) }, to: rows)
        for r in page.reactions ?? [] { reactions = TeamChatReactions.applying(reactions, r) }
        for t in page.threads ?? [] { threads[t.rootId] = t }
        hasOlder = page.messages.count >= Self.pageSize
    }

    // MARK: Sending

    /// A send begins: its bubble shows at once.
    mutating func beginSend(_ send: TeamChatPendingSend) {
        pending.removeAll { $0.clientId == send.clientId }
        pending.append(send)
    }

    /// The route answered with the row (or the row arrived live first): the bubble becomes it, once.
    mutating func sent(_ row: TeamChatMessage) {
        receive(row)
    }

    /// The route refused it, or the network lost it: the bubble stays, marked, to try again.
    mutating func sendFailed(clientId: String) {
        guard let i = pending.firstIndex(where: { $0.clientId == clientId }) else { return }
        pending[i].failed = true
    }

    /// Try a failed send again, with the same client id (the route answers a replay with the row it made).
    mutating func retry(clientId: String) -> TeamChatPendingSend? {
        guard let i = pending.firstIndex(where: { $0.clientId == clientId }) else { return nil }
        pending[i].failed = false
        return pending[i]
    }

    /// Give up on a failed send.
    mutating func discard(clientId: String) {
        pending.removeAll { $0.clientId == clientId }
    }

    // MARK: Live

    /// A row from Realtime or a route (an insert, an edit, a delete, its link preview arriving).
    /// Rows of another conversation are not this one's.
    mutating func receive(_ row: TeamChatMessage) {
        if let threadRootId, row.id == threadRootId {
            root = row
            return
        }
        guard belongs(row) else { return }
        // A page that stops short of the newest takes edits of its own rows, never new ones past it.
        if hasNewer, !rows.contains(where: { $0.id == row.id }), row.clientId == nil || !pending.contains(where: { $0.clientId == row.clientId }) { return }
        rows = TeamChatTimeline.upsert(rows, row)
        pending = TeamChatTimeline.settle(pending, with: [row])
    }

    mutating func receive(_ reaction: TeamChatReaction) {
        guard rows.contains(where: { $0.id == reaction.messageId }) || root?.id == reaction.messageId else { return }
        reactions = TeamChatReactions.applying(reactions, reaction)
    }

    mutating func receive(_ summary: TeamChatThreadSummary) {
        guard threadRootId == nil, summary.channelId == channelId else { return }
        threads[summary.rootId] = summary
    }

    /// The person's own reaction, flipped at once (the route's answer, or Realtime, confirms it).
    /// Returns whether it is now on.
    mutating func toggleReaction(messageId: String, emoji: String, me: String) -> Bool {
        let on = !reactions.contains { $0.messageId == messageId && $0.memberId == me && $0.emoji == emoji && $0.active }
        reactions = TeamChatReactions.applying(reactions, TeamChatReaction(messageId: messageId, memberId: me, emoji: emoji, active: on))
        return on
    }

    /// The route refused a reaction: put it back as it was.
    mutating func reactionRefused(messageId: String, emoji: String, me: String, wasOn: Bool) {
        reactions = TeamChatReactions.applying(reactions, TeamChatReaction(messageId: messageId, memberId: me, emoji: emoji, active: wasOn))
    }

    /// The person deleted a message: its words, files and preview go at once (the row confirms it).
    mutating func deleted(messageId: String, at: String = TeamChatTime.now()) {
        if let i = rows.firstIndex(where: { $0.id == messageId }) {
            rows[i].body = ""
            rows[i].attachments = []
            rows[i].linkPreview = nil
            rows[i].mentions = []
            rows[i].deletedAt = at
        }
    }

    private func belongs(_ row: TeamChatMessage) -> Bool {
        guard row.channelId == channelId else { return false }
        return row.threadRootId == threadRootId
    }
}

// MARK: - Where a tapped push goes

/// What the app does with a tapped push, given where it is.
enum PushTapStep: Equatable {
    /// The push is for another workspace: switch to it first, then open.
    case switchWorkspace(String)
    /// Open team chat at this channel, scrolled to the message; the thread open over it when it is a reply.
    case openTeamChat(channelId: String, messageId: String, threadRootId: String?)
    /// Open the chat with the agent.
    case openChat
}

enum PushTap {
    /// The steps for a tapped push, in order. A workspace the person isn't in is not switched to
    /// (the open then fails quietly, as a deleted message's would).
    static func steps(for route: PushRoute, currentWorkspaceId: String?, memberOf: Set<String>) -> [PushTapStep] {
        var out: [PushTapStep] = []
        if let ws = route.workspaceId, ws != currentWorkspaceId?.lowercased(), memberOf.contains(ws) {
            out.append(.switchWorkspace(ws))
        }
        switch route {
        case let .teamChat(_, channel, message, root):
            out.append(.openTeamChat(channelId: channel, messageId: message, threadRootId: root))
        case .homeMessage:
            out.append(.openChat)
        }
        return out
    }
}
