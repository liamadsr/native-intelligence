//
//  TeamChatStore.swift
//  Native Intelligence
//
//  Team chat for the signed-in person's active workspace: the channel list
//  with its unread counts, the workspace's members (names, avatars, the
//  mention picker), one Realtime channel that carries every message,
//  reaction, thread summary and channel change the person may read (RLS
//  filters what arrives, as on the web), the typing topics, signed links to
//  files, and the app icon's badge.
//
//  Live: Realtime while the app is open; coming back to the foreground the
//  list and every open conversation are fetched again (a socket asleep in
//  the background misses what was said), and the channel is joined again if
//  it dropped.
//

import Combine
import Foundation
import Supabase
import UIKit
import UserNotifications

/// What Realtime said, handed to the open conversations.
enum TeamChatLiveEvent {
    case message(TeamChatMessage, isInsert: Bool)
    case reaction(TeamChatReaction)
    case thread(TeamChatThreadSummary)
    /// A team call's row, or one of its people's (migration 564): a call's message redraws.
    case call(TeamCall)
    case callParticipant(TeamCallParticipant)
    /// Coming back: fetch again.
    case refetch
}

@MainActor
final class TeamChatStore: ObservableObject {
    static let shared = TeamChatStore()

    @Published private(set) var channels: [TeamChatChannel] = []
    @Published private(set) var threads: [TeamChatThreadUnread] = []
    @Published private(set) var members: [String: TeamChatMember] = [:]
    @Published private(set) var memberList: [TeamChatMember] = []
    /// The person's member id in this workspace.
    @Published private(set) var me: String?
    @Published private(set) var hasLoaded = false
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?
    /// The conversation on screen (no banner for its pushes; a live message there is read at once).
    @Published var onScreen: TeamChatOnScreen?

    let events = PassthroughSubject<TeamChatLiveEvent, Never>()

    private let api = TeamChatAPI.shared
    private var client: SupabaseClient { SupabaseManager.shared.client }
    private var workspaceId: String?
    private var live: RealtimeChannelV2?
    private var liveSubscriptions: [RealtimeSubscription] = []
    private var cancellables = Set<AnyCancellable>()
    private var listRefresh: Task<Void, Never>?
    private var badgeRefresh: Task<Void, Never>?
    private var signedURLs: [String: (url: URL, until: Date)] = [:]
    private var typing: [String: TypingTopic] = [:]

    /// The fixture build's screens (DEBUG `-previewTeamChat`): nothing goes to the network.
    private(set) var isFixture = false

    private init() {
        WorkspaceService.shared.$workspaceId
            .removeDuplicates()
            .receive(on: RunLoop.main)
            .sink { [weak self] id in
                guard let self, !self.isFixture else { return }
                Task { await self.switchTo(workspaceId: id?.uuidString.lowercased()) }
            }
            .store(in: &cancellables)
        NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)
            .sink { [weak self] _ in
                guard let self, !self.isFixture, self.workspaceId != nil else { return }
                Task { await self.comeBack() }
            }
            .store(in: &cancellables)
        NotificationCenter.default.publisher(for: .userSignedOut)
            .sink { [weak self] _ in Task { await self?.switchTo(workspaceId: nil) } }
            .store(in: &cancellables)
    }

    // MARK: - Names

    /// The person's agent's name ("@Juniper" asks it), as the web reads it: their own, else the default.
    var agentName: String {
        #if DEBUG
        if let fixtureAgentName { return fixtureAgentName }
        #endif
        let meta = SupabaseManager.shared.currentUser?.userMetadata ?? [:]
        if case let .string(name)? = meta["assistant_name"] {
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty && trimmed.count <= 40 { return trimmed }
        }
        return "Joseph"
    }

    var userId: String? { SupabaseManager.shared.currentUser?.id.uuidString.lowercased() }

    func channel(_ id: String) -> TeamChatChannel? { channels.first { $0.id == id } }

    func title(of channel: TeamChatChannel) -> String { TeamChatNames.title(of: channel, members: members, me: me) }

    // MARK: - Loading

    /// The list and its unread counts (and the members, the first time).
    func refresh() async {
        guard !isFixture else { return }
        guard WorkspaceService.shared.workspaceId != nil else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let out = try await api.channels()
            channels = TeamChatUnread.sorted(out.channels)
            threads = out.threads
            if let id = out.memberId?.lowercased() { me = id }
            hasLoaded = true
            errorMessage = nil
            if members.isEmpty { await loadMembers() }
            refreshBadge()
        } catch {
            errorMessage = error.localizedDescription
            print("❌ TeamChatStore: list failed: \(error)")
        }
    }

    /// Many live changes are one list fetch.
    func refreshSoon() {
        listRefresh?.cancel()
        listRefresh = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard !Task.isCancelled else { return }
            await self?.refresh()
        }
    }

    private func loadMembers() async {
        guard let ws = workspaceId else { return }
        do {
            let rows: [TeamChatMember] = try await client
                .from("member")
                .select("id, user_id, display_name, avatar_url")
                .eq("workspace_id", value: ws)
                .order("display_name")
                .execute()
                .value
            let normalized = rows.map { TeamChatMember(id: $0.id.lowercased(), userId: $0.userId?.lowercased(), displayName: $0.displayName, avatarUrl: $0.avatarUrl) }
            memberList = normalized
            members = Dictionary(normalized.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            if me == nil, let uid = userId { me = normalized.first { $0.userId == uid }?.id }
        } catch {
            print("❌ TeamChatStore: members failed: \(error)")
        }
    }

    private func switchTo(workspaceId id: String?) async {
        guard id != workspaceId else { return }
        await leaveLive()
        workspaceId = id
        channels = []
        threads = []
        members = [:]
        memberList = []
        me = nil
        hasLoaded = false
        signedURLs = [:]
        onScreen = nil
        guard id != nil else {
            await setBadge(0)
            return
        }
        await refresh()
        await joinLive()
    }

    private func comeBack() async {
        await refresh()
        if live == nil || live?.status != .subscribed {
            await leaveLive(closingTyping: false)
            await joinLive()
        }
        // The open conversations' typing topics too: same screens listening, a fresh socket.
        for topic in typing.values { await topic.rejoinIfDropped(client) }
        events.send(.refetch)
    }

    // MARK: - Reading

    /// The channel read up to now: its count goes at once, the server's mark follows.
    func markRead(channelId: String) {
        guard !isFixture else { return }
        channels = TeamChatUnread.markingRead(channels, channelId: channelId)
        refreshBadge(local: true)
        Task {
            try? await api.markRead(channelId: channelId)
            refreshBadge()
        }
    }

    func markThreadRead(rootId: String) {
        guard !isFixture else { return }
        let next = TeamChatUnread.markingThreadRead(channels, threads: threads, rootId: rootId)
        channels = next.channels
        threads = next.threads
        refreshBadge(local: true)
        Task {
            try? await api.markThreadRead(rootId: rootId)
            refreshBadge()
        }
    }

    // MARK: - Changing channels

    func setNotify(channelId: String, level: TeamChatNotifyLevel) async {
        let before = channel(channelId)?.notify
        channels = channels.map { c in
            guard c.id == channelId else { return c }
            var next = c
            next.notify = level
            return next
        }
        do {
            _ = try await api.setNotify(channelId: channelId, level: level)
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
            if let before {
                channels = channels.map { c in
                    guard c.id == channelId else { return c }
                    var next = c
                    next.notify = before
                    return next
                }
            }
        }
    }

    func createChannel(name: String, topic: String?) async throws -> String {
        let id = try await api.createChannel(name: name, topic: topic)
        await refresh()
        return id
    }

    func openDM(with memberId: String) async throws -> String {
        let id = try await api.openDM(memberId: memberId)
        await refresh()
        return id
    }

    // MARK: - Live

    private func joinLive() async {
        guard let ws = workspaceId, live == nil else { return }
        let channel = client.channel("team-chat:\(ws):\(UUID().uuidString.prefix(8).lowercased())")
        let filter = "workspace_id=eq.\(ws)"
        let decoder = JSONDecoder()
        liveSubscriptions = [
            channel.onPostgresChange(AnyAction.self, schema: "public", table: "team_chat_message", filter: filter) { [weak self] action in
                let (record, insert): (JSONObject?, Bool) = {
                    switch action {
                    case let .insert(a): return (a.record, true)
                    case let .update(a): return (a.record, false)
                    case .delete: return (nil, false)
                    }
                }()
                guard let record, let row = try? record.decode(as: TeamChatMessage.self, decoder: decoder) else { return }
                Task { @MainActor in self?.heard(row, isInsert: insert) }
            },
            channel.onPostgresChange(AnyAction.self, schema: "public", table: "team_chat_reaction", filter: filter) { [weak self] action in
                guard let record = Self.record(of: action), let r = try? record.decode(as: TeamChatReaction.self, decoder: decoder) else { return }
                Task { @MainActor in self?.events.send(.reaction(r)) }
            },
            channel.onPostgresChange(AnyAction.self, schema: "public", table: "team_chat_thread", filter: filter) { [weak self] action in
                guard let record = Self.record(of: action), let t = try? record.decode(as: TeamChatThreadSummary.self, decoder: decoder) else { return }
                Task { @MainActor in self?.events.send(.thread(t)) }
            },
            channel.onPostgresChange(AnyAction.self, schema: "public", table: "team_chat_channel", filter: filter) { [weak self] _ in
                Task { @MainActor in self?.refreshSoon() }
            },
            channel.onPostgresChange(AnyAction.self, schema: "public", table: "team_call", filter: filter) { [weak self] action in
                guard let record = Self.record(of: action), let c = try? record.decode(as: TeamCall.self, decoder: decoder) else { return }
                Task { @MainActor in self?.events.send(.call(c)) }
            },
            channel.onPostgresChange(AnyAction.self, schema: "public", table: "team_call_participant", filter: filter) { [weak self] action in
                guard let record = Self.record(of: action), let p = try? record.decode(as: TeamCallParticipant.self, decoder: decoder) else { return }
                Task { @MainActor in self?.events.send(.callParticipant(p)) }
            },
        ]
        live = channel
        do {
            try await channel.subscribeWithError()
        } catch {
            print("❌ TeamChatStore: live join failed: \(error)")
        }
    }

    /// Leave the workspace's channel; `closingTyping` (a workspace switch, a sign-out) closes the
    /// typing topics for good, else they stay with their listeners.
    private func leaveLive(closingTyping: Bool = true) async {
        liveSubscriptions.forEach { $0.cancel() }
        liveSubscriptions = []
        if let live { await client.removeChannel(live) }
        live = nil
        guard closingTyping else { return }
        for topic in typing.values { await topic.close(client) }
        typing = [:]
    }

    nonisolated private static func record(of action: AnyAction) -> JSONObject? {
        switch action {
        case let .insert(a): return a.record
        case let .update(a): return a.record
        case .delete: return nil
        }
    }

    private func heard(_ row: TeamChatMessage, isInsert: Bool) {
        events.send(.message(row, isInsert: isInsert))
        guard isInsert else { return }
        let mine = row.authorKind == "member" && row.authorMemberId == me
        if let root = row.threadRootId {
            if onScreen?.threadRootId == root, UIApplication.shared.applicationState == .active {
                markThreadRead(rootId: root)
            } else if !mine {
                refreshSoon()
            }
            return
        }
        if onScreen?.channelId == row.channelId, onScreen?.threadRootId == nil, UIApplication.shared.applicationState == .active {
            markRead(channelId: row.channelId)
        } else if !mine {
            refreshSoon()
        }
        channels = channels.map { c in
            guard c.id == row.channelId else { return c }
            var next = c
            next.lastMessageAt = row.createdAt
            return next
        }
    }

    // MARK: - Typing

    /// Join a channel's typing topic: `hear` gets the others' signals; leave when done.
    func joinTyping(channelId: String, hear: @escaping (TeamChatTypingSignal) -> Void) -> UUID {
        let token = UUID()
        guard !isFixture else { return token }
        let topic = typing[channelId] ?? {
            let t = TypingTopic(channelId: channelId, client: client)
            typing[channelId] = t
            return t
        }()
        topic.listeners[token] = hear
        return token
    }

    func leaveTyping(channelId: String, token: UUID) {
        guard let topic = typing[channelId] else { return }
        topic.listeners[token] = nil
        if topic.listeners.isEmpty {
            typing[channelId] = nil
            Task { await topic.close(client) }
        }
    }

    func sayTyping(channelId: String, thread: String?, typing isTyping: Bool) {
        guard let me, let topic = typing[channelId] else { return }
        topic.say(TeamChatTypingSignal(memberId: me, thread: thread, typing: isTyping))
    }

    // MARK: - Files

    /// A signed link to a file in the team chat bucket (cached until shortly before it runs out).
    func fileURL(_ path: String) async -> URL? {
        if let hit = signedURLs[path], hit.until > Date() { return hit.url }
        do {
            let url = try await client.storage.from(TeamChatFiles.bucket).createSignedURL(path: path, expiresIn: 3600)
            signedURLs[path] = (url, Date().addingTimeInterval(3300))
            return url
        } catch {
            print("❌ TeamChatStore: file link failed: \(error)")
            return nil
        }
    }

    /// Upload one file into the channel's folder, the person's own sub-folder (558's policy), before it is sent.
    func upload(data: Data, name: String, type: String, channelId: String, width: Int? = nil, height: Int? = nil) async throws -> TeamChatAttachment {
        if let refusal = TeamChatFiles.refusal(name: name, size: data.count) {
            throw TeamChatAPIError.http(status: 400, message: refusal)
        }
        guard let userId else { throw TeamChatAPIError.notSignedIn }
        let path = TeamChatFiles.path(channelId: channelId, userId: userId, fileName: name)
        _ = try await client.storage.from(TeamChatFiles.bucket).upload(path, data: data, options: FileOptions(contentType: type, upsert: false))
        return TeamChatAttachment(path: path, name: String(name.prefix(200)), size: data.count, type: type, width: width, height: height)
    }

    // MARK: - Badge

    /// The app icon's badge: the server's count for every workspace (563), else this list's.
    func refreshBadge(local: Bool = false) {
        guard !isFixture else { return }
        let fallback = TeamChatUnread.badge(channels)
        badgeRefresh?.cancel()
        if local {
            Task { await setBadge(fallback) }
            return
        }
        badgeRefresh = Task { [weak self] in
            guard let self else { return }
            let count: Int
            do {
                count = try await client.rpc("team_chat_badge").execute().value
            } catch {
                count = fallback
            }
            guard !Task.isCancelled else { return }
            await setBadge(count)
        }
    }

    private func setBadge(_ count: Int) async {
        try? await UNUserNotificationCenter.current().setBadgeCount(max(0, count))
    }

    // MARK: - Fixture

    #if DEBUG
    private var fixtureAgentName: String?

    /// Fill the store from fixtures (made-up people), for the screens' DEBUG preview build.
    func loadFixture(channels: [TeamChatChannel], members: [TeamChatMember], me: String, agentName: String) {
        isFixture = true
        fixtureAgentName = agentName
        self.channels = TeamChatUnread.sorted(channels)
        self.memberList = members
        self.members = Dictionary(members.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        self.me = me
        hasLoaded = true
    }
    #endif
}

/// One channel's private typing topic (migration 559), shared by every screen showing the channel.
/// Its listeners outlive its socket: a topic that dropped while the app slept is joined again
/// with the same screens listening (`rejoinIfDropped`).
@MainActor
private final class TypingTopic {
    var listeners: [UUID: (TeamChatTypingSignal) -> Void] = [:]
    private let channelId: String
    private var channel: RealtimeChannelV2?
    private var subscription: RealtimeSubscription?

    init(channelId: String, client: SupabaseClient) {
        self.channelId = channelId
        join(client)
    }

    private func join(_ client: SupabaseClient) {
        let channel = client.channel(TeamChatTypingSignal.topic(channelId: channelId)) {
            $0.isPrivate = true
            $0.broadcast.receiveOwnBroadcasts = false
        }
        subscription = channel.onBroadcast(event: TeamChatTypingSignal.event) { [weak self] json in
            guard let payload = json["payload"]?.value as? [String: Any], let signal = TeamChatTypingSignal.parse(payload) else { return }
            Task { @MainActor in
                guard let self else { return }
                for listener in self.listeners.values { listener(signal) }
            }
        }
        self.channel = channel
        Task { try? await channel.subscribeWithError() }
    }

    /// Coming back to the foreground: a socket that dropped is joined again, same listeners.
    func rejoinIfDropped(_ client: SupabaseClient) async {
        guard channel?.status != .subscribed else { return }
        await leave(client)
        join(client)
    }

    func say(_ signal: TeamChatTypingSignal) {
        guard let channel, channel.status == .subscribed else { return }
        let message: JSONObject = [
            "member_id": .string(signal.memberId),
            "thread": signal.thread.map { .string($0) } ?? .null,
            "typing": .bool(signal.typing),
        ]
        Task { await channel.broadcast(event: TeamChatTypingSignal.event, message: message) }
    }

    private func leave(_ client: SupabaseClient) async {
        subscription?.cancel()
        subscription = nil
        if let channel { await client.removeChannel(channel) }
        channel = nil
    }

    func close(_ client: SupabaseClient) async {
        listeners = [:]
        await leave(client)
    }
}
