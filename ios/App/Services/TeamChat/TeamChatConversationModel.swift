//
//  TeamChatConversationModel.swift
//  Native Intelligence
//
//  One open conversation (a channel, or a thread in it): its messages from
//  the routes, what Realtime says, the person's sends with their optimistic
//  bubbles, reactions, edits and deletes, the composer's files, and the
//  typing line. The decisions are TeamChatConversationState's (Core); this
//  feeds it and does the talking.
//

import Combine
import Foundation
import UIKit

@MainActor
final class TeamChatConversationModel: ObservableObject {
    let channelId: String
    let threadRootId: String?

    @Published private(set) var state: TeamChatConversationState
    @Published private(set) var isLoading = false
    @Published private(set) var isLoadingOlder = false
    @Published private(set) var hasLoaded = false
    @Published var errorMessage: String?
    /// The message to scroll to and mark (a push, a search hit), once it is in the list.
    @Published var focusMessageId: String?
    @Published private(set) var typingLine: String?
    /// The calls this conversation's call messages show, with who is in them (live over Realtime).
    @Published private(set) var calls: [String: TeamCallView] = [:]

    // The composer.
    @Published var draft = "" {
        didSet { draftChanged() }
    }
    @Published private(set) var picked: [TeamChatPickedMention] = []
    @Published private(set) var attachments: [TeamChatAttachment] = []
    @Published private(set) var uploading = 0
    /// A message being edited in the composer.
    @Published private(set) var editing: TeamChatMessage?

    let store: TeamChatStore
    private let api = TeamChatAPI.shared
    private var cancellables = Set<AnyCancellable>()
    private var typingToken: UUID?
    private var board = TeamChatTypingBoard()
    private var typingTimer: Task<Void, Never>?
    private var lastTyping: (thread: String?, at: Date)?

    init(channelId: String, threadRootId: String? = nil, focusMessageId: String? = nil, store: TeamChatStore? = nil) {
        let store = store ?? .shared
        self.channelId = channelId
        self.threadRootId = threadRootId
        self.focusMessageId = focusMessageId
        self.store = store
        state = TeamChatConversationState(channelId: channelId, threadRootId: threadRootId)
        store.events
            .receive(on: RunLoop.main)
            .sink { [weak self] event in self?.handle(event) }
            .store(in: &cancellables)
    }

    var me: String? { store.me }
    var shown: [TeamChatShownMessage] { state.shown(me: me) }
    var channel: TeamChatChannel? { store.channel(channelId) }
    var canPost: Bool { channel?.archivedAt == nil }

    // MARK: - On screen

    func appeared() {
        store.onScreen = TeamChatOnScreen(channelId: channelId, threadRootId: threadRootId)
        if typingToken == nil {
            typingToken = store.joinTyping(channelId: channelId) { [weak self] signal in self?.heard(signal) }
        }
        if !hasLoaded { Task { await load() } }
        markRead()
    }

    func disappeared() {
        if store.onScreen == TeamChatOnScreen(channelId: channelId, threadRootId: threadRootId) {
            // Back to the channel under a thread, or out of team chat.
            store.onScreen = threadRootId == nil ? nil : TeamChatOnScreen(channelId: channelId, threadRootId: nil)
        }
        stopTyping()
        if let typingToken { store.leaveTyping(channelId: channelId, token: typingToken) }
        typingToken = nil
    }

    private func markRead() {
        if let threadRootId { store.markThreadRead(rootId: threadRootId) } else { store.markRead(channelId: channelId) }
    }

    // MARK: - Loading

    func load() async {
        guard !store.isFixture else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            if let threadRootId {
                state.loaded(try await api.thread(channelId: channelId, rootId: threadRootId))
            } else if let focus = focusMessageId, !state.rows.contains(where: { $0.id == focus }) {
                // Opened at a message (a push): the page around it; a message gone meanwhile opens the newest.
                do {
                    loaded(try await api.messages(channelId: channelId, around: focus))
                } catch {
                    guard case TeamChatAPIError.http(404, _) = error else { throw error }
                    loaded(try await api.messages(channelId: channelId))
                }
            } else {
                loaded(try await api.messages(channelId: channelId))
            }
            hasLoaded = true
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// From a page around an older message to the newest.
    func jumpToNewest() async {
        guard !store.isFixture else { return }
        focusMessageId = nil
        do {
            loaded(try await api.messages(channelId: channelId))
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadOlder() async {
        guard threadRootId == nil, state.hasOlder, !isLoadingOlder, let cursor = state.oldestCursor, !store.isFixture else { return }
        isLoadingOlder = true
        defer { isLoadingOlder = false }
        do {
            let page = try await api.messages(channelId: channelId, before: cursor)
            state.loadedOlder(page)
            absorbCalls(page)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// A page in, with its calls.
    private func loaded(_ page: TeamChatMessagesResponse) {
        state.loaded(page)
        absorbCalls(page)
    }

    private func absorbCalls(_ page: TeamChatMessagesResponse) {
        for view in page.calls ?? [] { calls[view.call.id.lowercased()] = view }
    }

    private func handle(_ event: TeamChatLiveEvent) {
        switch event {
        case let .call(c):
            guard c.channelId.lowercased() == channelId.lowercased() else { return }
            let id = c.id.lowercased()
            calls[id] = TeamCallView(call: c, participants: calls[id]?.participants ?? [])
        case let .callParticipant(p):
            let id = p.callId.lowercased()
            guard var view = calls[id] else { return }
            view.upsert(p)
            calls[id] = view
        case let .message(row, _):
            state.receive(row)
        case let .reaction(r):
            state.receive(r)
        case let .thread(t):
            state.receive(t)
        case .refetch:
            guard hasLoaded else { return }
            Task {
                await load()
                markRead()
            }
        }
    }

    // MARK: - Composing

    /// The `@…` being typed: who it may be.
    var mentionCandidates: [TeamChatPickedMention] {
        guard let q = TeamChatMentions.query(in: draft) else { return [] }
        return TeamChatMentions.candidates(store.memberList, query: q.query, agentName: store.agentName)
    }

    func pick(_ mention: TeamChatPickedMention) {
        draft = TeamChatMentions.inserting(mention.label, into: draft)
        if !picked.contains(mention) { picked.append(mention) }
    }

    var canSend: Bool {
        let words = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return canPost && uploading == 0 && (!words.isEmpty || (!attachments.isEmpty && editing == nil)) && words.count <= 8000
    }

    func send() {
        guard canSend else { return }
        let words = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let named = TeamChatMentions.stillIn(words, picked: picked)
        // "@Juniper" typed by hand calls the agent too (the route checks the words as well).
        let agent = named.agent || TeamChatMentions.has(words, label: store.agentName)
        if let editing {
            commitEdit(editing, body: words, mentions: named.memberIds)
            return
        }
        let send = TeamChatPendingSend(
            clientId: UUID().uuidString.lowercased(), channelId: channelId, threadRootId: threadRootId,
            body: words, mentions: named.memberIds, mentionsAgent: agent, attachments: attachments,
            createdAt: TeamChatTime.now()
        )
        draft = ""
        picked = []
        attachments = []
        stopTyping()
        state.beginSend(send)
        Task { await deliver(send) }
    }

    private func deliver(_ send: TeamChatPendingSend) async {
        guard !store.isFixture else { return }
        do {
            let row = try await api.post(send)
            state.sent(row)
        } catch {
            state.sendFailed(clientId: send.clientId)
            errorMessage = error.localizedDescription
        }
    }

    /// Try a failed send again: the same client id, so a send that did go through is answered with its row.
    func retry(clientId: String) {
        guard let send = state.retry(clientId: clientId) else { return }
        Task { await deliver(send) }
    }

    func discard(clientId: String) {
        state.discard(clientId: clientId)
    }

    // MARK: - Files

    func attach(data: Data, name: String, type: String, width: Int? = nil, height: Int? = nil) {
        guard attachments.count + uploading < TeamChatFiles.maxFiles else {
            errorMessage = "A message carries \(TeamChatFiles.maxFiles) files at most"
            return
        }
        if let refusal = TeamChatFiles.refusal(name: name, size: data.count) {
            errorMessage = refusal
            return
        }
        uploading += 1
        Task {
            defer { uploading -= 1 }
            do {
                let a = try await store.upload(data: data, name: name, type: type, channelId: channelId, width: width, height: height)
                attachments.append(a)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    func removeAttachment(_ a: TeamChatAttachment) {
        attachments.removeAll { $0 == a }
    }

    // MARK: - Edit, delete, react

    func beginEdit(_ m: TeamChatMessage) {
        guard m.authorMemberId == me, !m.isAgent, !m.isDeleted else { return }
        editing = m
        draft = m.body
        picked = m.mentions.compactMap { id in store.members[id].map { TeamChatPickedMention(memberId: id, label: $0.name) } }
    }

    func cancelEdit() {
        editing = nil
        draft = ""
        picked = []
    }

    private func commitEdit(_ m: TeamChatMessage, body: String, mentions: [String]) {
        editing = nil
        draft = ""
        picked = []
        var optimistic = m
        optimistic.body = body
        optimistic.mentions = mentions
        optimistic.editedAt = TeamChatTime.now()
        state.receive(optimistic)
        Task {
            do {
                state.receive(try await api.edit(messageId: m.id, body: body, mentions: mentions))
            } catch {
                state.receive(m)
                errorMessage = error.localizedDescription
            }
        }
    }

    func delete(_ m: TeamChatMessage) {
        let before = m
        state.deleted(messageId: m.id)
        Task {
            do {
                try await api.delete(messageId: m.id)
            } catch {
                state.receive(before)
                errorMessage = error.localizedDescription
            }
        }
    }

    func toggleReaction(messageId: String, emoji: String) {
        guard let me, canPost else { return }
        let on = state.toggleReaction(messageId: messageId, emoji: emoji, me: me)
        guard !store.isFixture else { return }
        Task {
            do {
                _ = try await api.react(messageId: messageId, emoji: emoji, on: on)
            } catch {
                state.reactionRefused(messageId: messageId, emoji: emoji, me: me, wasOn: !on)
                errorMessage = error.localizedDescription
            }
        }
    }

    func chips(for messageId: String) -> [TeamChatReactionChip] {
        TeamChatReactions.chips(state.reactions, messageId: messageId, me: me)
    }

    // MARK: - Typing

    private func draftChanged() {
        guard editing == nil, !store.isFixture else { return }
        let words = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if words.isEmpty {
            stopTyping()
            return
        }
        let now = Date()
        guard TeamChatTypingBoard.shouldSend(last: lastTyping, thread: threadRootId, now: now) else { return }
        lastTyping = (threadRootId, now)
        store.sayTyping(channelId: channelId, thread: threadRootId, typing: true)
    }

    private func stopTyping() {
        guard lastTyping != nil else { return }
        lastTyping = nil
        store.sayTyping(channelId: channelId, thread: threadRootId, typing: false)
    }

    private func heard(_ signal: TeamChatTypingSignal) {
        board.hear(signal, me: me)
        redrawTyping()
    }

    private func redrawTyping() {
        board.expire()
        let names = board.typers(thread: threadRootId).map { store.members[$0]?.name ?? "Someone" }
        typingLine = TeamChatTypingBoard.line(names)
        typingTimer?.cancel()
        guard let next = board.nextExpiry else { return }
        typingTimer = Task { [weak self] in
            let wait = max(0, next.timeIntervalSinceNow) + 0.05
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.redrawTyping()
        }
    }

    // MARK: - Fixture

    #if DEBUG
    func loadFixture(_ page: TeamChatMessagesResponse, pending: [TeamChatPendingSend] = [], typing: String? = nil, draft: String = "", attachments: [TeamChatAttachment] = []) {
        loaded(page)
        for p in pending { state.beginSend(p) }
        hasLoaded = true
        typingLine = typing
        self.draft = draft
        self.attachments = attachments
    }
    #endif
}
