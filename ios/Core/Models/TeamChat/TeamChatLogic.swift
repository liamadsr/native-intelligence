//
//  TeamChatLogic.swift
//  Native Intelligence
//
//  Team chat's rules on the phone, pure: the list's badges, a send's
//  optimistic bubble reconciled with its row, reactions as chips, @-mentions
//  in the composer and in the words, the typing line, the files a message may
//  carry, and where a push opens. The same rules as the web page's
//  (web/src/lib/team-chat/compose.ts, files.ts, store.ts listChannels); the
//  database and the routes hold the real ones, these only draw them.
//  Foundation only: Scripts/test-team-chat.sh builds and runs it on the Mac.
//

import Foundation

// MARK: - Unread

/// What a channel's row shows on its right.
enum TeamChatRowBadge: Equatable {
    case none
    /// Messages from others, unread (the channel's and its threads' they are in).
    case unread(Int)
    /// Some of them mention the person: shown louder.
    case mentions(Int)
}

enum TeamChatUnread {
    /// The row's badge: a mention first; a muted channel shows nothing but its mentions.
    static func rowBadge(_ c: TeamChatChannel) -> TeamChatRowBadge {
        let mentioned = c.mentions + c.threadMentions
        if mentioned > 0 { return .mentions(mentioned) }
        if c.notify == .muted { return .none }
        let unread = c.unread + c.threadUnread
        return unread > 0 ? .unread(unread) : .none
    }

    /// What one channel adds to the app icon's badge (migration 563's team_chat_badge, per channel).
    static func badgeCount(_ c: TeamChatChannel) -> Int {
        c.notify == .muted ? c.mentions + c.threadMentions : c.unread + c.threadUnread
    }

    /// The badge for the whole list.
    static func badge(_ channels: [TeamChatChannel]) -> Int {
        channels.reduce(0) { $0 + badgeCount($1) }
    }

    /// The channel read (its own messages): its counts go to zero at once, its threads' stay.
    static func markingRead(_ channels: [TeamChatChannel], channelId: String) -> [TeamChatChannel] {
        channels.map { c in
            guard c.id == channelId else { return c }
            var read = c
            read.unread = 0
            read.mentions = 0
            return read
        }
    }

    /// A thread read: its unread replies come off its channel's thread counts.
    static func markingThreadRead(
        _ channels: [TeamChatChannel], threads: [TeamChatThreadUnread], rootId: String
    ) -> (channels: [TeamChatChannel], threads: [TeamChatThreadUnread]) {
        guard let t = threads.first(where: { $0.rootId == rootId }) else { return (channels, threads) }
        let next = channels.map { c -> TeamChatChannel in
            guard c.id == t.channelId else { return c }
            var read = c
            read.threadUnread = max(0, c.threadUnread - (c.notify == .muted ? 0 : t.unread))
            read.threadMentions = max(0, c.threadMentions - t.mentions)
            return read
        }
        return (next, threads.filter { $0.rootId != rootId })
    }

    /// The list's order: unread first (mentions, then the rest), then the newest message first.
    static func sorted(_ channels: [TeamChatChannel]) -> [TeamChatChannel] {
        channels.enumerated().sorted { a, b in
            let ra = rank(a.element), rb = rank(b.element)
            if ra != rb { return ra < rb }
            let ta = TeamChatTime.date(a.element.lastMessageAt) ?? .distantPast
            let tb = TeamChatTime.date(b.element.lastMessageAt) ?? .distantPast
            if ta != tb { return ta > tb }
            return a.offset < b.offset
        }.map(\.element)
    }

    private static func rank(_ c: TeamChatChannel) -> Int {
        switch rowBadge(c) {
        case .mentions: return 0
        case .unread: return 1
        case .none: return 2
        }
    }
}

// MARK: - The timeline: rows, and sends on their way

/// A send the person made that the server hasn't answered yet (or refused).
struct TeamChatPendingSend: Identifiable, Equatable {
    /// The uuid minted for the send: the route's `clientId`, and the row's `client_id`.
    let clientId: String
    let channelId: String
    let threadRootId: String?
    let body: String
    let mentions: [String]
    let mentionsAgent: Bool
    let attachments: [TeamChatAttachment]
    /// When it was sent here: its place in the list until the row comes back.
    let createdAt: String
    var failed: Bool = false

    var id: String { clientId }

    /// The bubble it draws as, until its row arrives.
    func asMessage(authorMemberId: String?) -> TeamChatMessage {
        TeamChatMessage(
            id: "pending:\(clientId)", channelId: channelId, authorMemberId: authorMemberId,
            threadRootId: threadRootId, clientId: clientId, body: body, mentions: mentions,
            mentionsAgent: mentionsAgent, attachments: attachments, createdAt: createdAt
        )
    }
}

/// One line of a conversation as drawn: a row, or a send still on its way.
struct TeamChatShownMessage: Identifiable, Equatable {
    let message: TeamChatMessage
    /// Sent, not yet answered.
    let isSending: Bool
    /// Refused or lost: tap to try again.
    let failed: Bool

    var id: String { message.clientId.map { "c:\($0)" } ?? message.id }
}

enum TeamChatTimeline {
    /// A row in, by its id: replaced where it was, else placed by its time (oldest first).
    static func upsert(_ list: [TeamChatMessage], _ row: TeamChatMessage) -> [TeamChatMessage] {
        if let i = list.firstIndex(where: { $0.id == row.id }) {
            var next = list
            next[i] = row
            return next
        }
        var next = list
        let at = TeamChatTime.date(row.createdAt) ?? .distantFuture
        let index = next.firstIndex { (TeamChatTime.date($0.createdAt) ?? .distantFuture) > at } ?? next.count
        next.insert(row, at: index)
        return next
    }

    /// An older page in front of what is shown (the overlap, if any, once).
    static func prepending(_ older: [TeamChatMessage], to list: [TeamChatMessage]) -> [TeamChatMessage] {
        older.reduce(list) { upsert($0, $1) }
    }

    /// The sends whose rows have arrived are done: their bubbles become the rows.
    static func settle(_ pending: [TeamChatPendingSend], with rows: [TeamChatMessage]) -> [TeamChatPendingSend] {
        let arrived = Set(rows.compactMap(\.clientId))
        return pending.filter { !arrived.contains($0.clientId) }
    }

    /// The conversation as drawn: the rows, and each send still on its way after them in time order.
    static func shown(rows: [TeamChatMessage], pending: [TeamChatPendingSend], me: String?) -> [TeamChatShownMessage] {
        let open = settle(pending, with: rows)
        var out = rows.map { TeamChatShownMessage(message: $0, isSending: false, failed: false) }
        for send in open {
            let bubble = send.asMessage(authorMemberId: me)
            let at = TeamChatTime.date(bubble.createdAt) ?? .distantFuture
            let index = out.firstIndex { (TeamChatTime.date($0.message.createdAt) ?? .distantPast) > at } ?? out.count
            out.insert(TeamChatShownMessage(message: bubble, isSending: !send.failed, failed: send.failed), at: index)
        }
        return out
    }

    /// Whether two messages in a row are one run (same author, close together): the second draws no name.
    static func continues(_ previous: TeamChatMessage?, _ message: TeamChatMessage, within seconds: TimeInterval = 5 * 60) -> Bool {
        guard let previous, !previous.isDeleted else { return false }
        guard previous.authorKind == message.authorKind,
              previous.authorMemberId == message.authorMemberId,
              previous.agentForMemberId == message.agentForMemberId else { return false }
        guard let a = TeamChatTime.date(previous.createdAt), let b = TeamChatTime.date(message.createdAt) else { return false }
        return b.timeIntervalSince(a) < seconds && Calendar.current.isDate(a, inSameDayAs: b)
    }
}

// MARK: - Reactions

struct TeamChatReactionChip: Equatable, Identifiable {
    let emoji: String
    let count: Int
    let mine: Bool
    let memberIds: [String]

    var id: String { emoji }
}

enum TeamChatReactions {
    /// The quick picks under a message's long-press menu.
    static let quick = ["👍", "❤️", "😂", "🎉", "👀", "✅"]

    /// A reaction in (from the server, or the person's own tap): its row replaced.
    static func applying(_ list: [TeamChatReaction], _ r: TeamChatReaction) -> [TeamChatReaction] {
        var next = list.filter { !($0.messageId == r.messageId && $0.memberId == r.memberId && $0.emoji == r.emoji) }
        next.append(r)
        return next
    }

    /// One message's chips: each emoji with its count and whether the person is in it, first used first.
    static func chips(_ list: [TeamChatReaction], messageId: String, me: String?) -> [TeamChatReactionChip] {
        var order: [String] = []
        var members: [String: [String]] = [:]
        for r in list where r.messageId == messageId && r.active {
            if members[r.emoji] == nil { order.append(r.emoji) }
            members[r.emoji, default: []].append(r.memberId)
        }
        return order.map { emoji in
            let ids = members[emoji] ?? []
            return TeamChatReactionChip(emoji: emoji, count: ids.count, mine: me.map(ids.contains) ?? false, memberIds: ids)
        }
    }

    /// True for one emoji, never words (the route's isReactionEmoji is the real check).
    static func isEmoji(_ text: String) -> Bool {
        guard !text.isEmpty, text.count == 1, text.utf16.count <= 16 else { return false }
        return text.unicodeScalars.contains { $0.properties.isEmojiPresentation || ($0.properties.isEmoji && $0.value > 0x238C) }
    }
}

// MARK: - Mentions

/// A member (or the person's own agent) picked from the @ list: its label is the words' `@label`.
struct TeamChatPickedMention: Equatable {
    /// A member id, or nil for the person's own agent.
    let memberId: String?
    let label: String
}

enum TeamChatMentions {
    /// The `@…` being typed at the end of the words: where its `@` is and what follows (one word).
    static func query(in text: String) -> (start: String.Index, query: String)? {
        guard let at = text.lastIndex(of: "@") else { return nil }
        if at > text.startIndex {
            let before = text[text.index(before: at)]
            guard before.isWhitespace || before.isNewline else { return nil }
        }
        let query = String(text[text.index(after: at)...])
        guard query.allSatisfy({ $0.isLetter || $0.isNumber || "'.-".contains($0) }) else { return nil }
        return (at, query)
    }

    /// The words with the `@…` being typed replaced by `@label ` (the pick).
    static func inserting(_ label: String, into text: String) -> String {
        guard let q = query(in: text) else { return text + "@\(label) " }
        return String(text[..<q.start]) + "@\(label) "
    }

    /// Members whose name starts a word with the query (any case), the person's own agent first when it fits.
    static func candidates(_ members: [TeamChatMember], query: String, agentName: String, limit: Int = 8) -> [TeamChatPickedMention] {
        let q = query.lowercased()
        let fits: (String) -> Bool = { name in
            q.isEmpty || name.lowercased().split(separator: " ").contains { $0.hasPrefix(q) } || name.lowercased().hasPrefix(q)
        }
        var out: [TeamChatPickedMention] = []
        if fits(agentName) { out.append(TeamChatPickedMention(memberId: nil, label: agentName)) }
        for m in members where fits(m.name) && m.displayName != nil {
            out.append(TeamChatPickedMention(memberId: m.id, label: m.name))
        }
        return Array(out.prefix(limit))
    }

    /// True when the words hold `@label` as a whole mention (any case).
    static func has(_ text: String, label: String) -> Bool {
        guard !label.isEmpty else { return false }
        var search = text.startIndex..<text.endIndex
        while let r = text.range(of: "@" + label, options: [.caseInsensitive], range: search) {
            let beforeOK = r.lowerBound == text.startIndex || !isWordChar(text[text.index(before: r.lowerBound)])
            let afterOK = r.upperBound == text.endIndex || !isWordChar(text[r.upperBound])
            if beforeOK && afterOK { return true }
            search = r.upperBound..<text.endIndex
        }
        return false
    }

    /// The picked members still named in the words (an edit may have taken one out), distinct.
    static func stillIn(_ text: String, picked: [TeamChatPickedMention]) -> (memberIds: [String], agent: Bool) {
        var ids: [String] = []
        var agent = false
        for p in picked where has(text, label: p.label) {
            if let id = p.memberId { if !ids.contains(id) { ids.append(id) } } else { agent = true }
        }
        return (ids, agent)
    }

    /// The words cut into plain runs and `@label` mentions, longest label first.
    static func segments(_ body: String, labels: [String]) -> [(text: String, mention: Bool)] {
        let sorted = Array(Set(labels.filter { !$0.isEmpty })).sorted { $0.count > $1.count }
        guard !sorted.isEmpty, body.contains("@") else { return body.isEmpty ? [] : [(body, false)] }
        var out: [(String, Bool)] = []
        var plain = ""
        var i = body.startIndex
        while i < body.endIndex {
            if body[i] == "@", i == body.startIndex || !isWordChar(body[body.index(before: i)]) {
                let rest = body[body.index(after: i)...]
                if let label = sorted.first(where: { label in
                    guard rest.lowercased().hasPrefix(label.lowercased()) else { return false }
                    let end = rest.index(rest.startIndex, offsetBy: label.count)
                    return end == body.endIndex || !isWordChar(body[end])
                }) {
                    if !plain.isEmpty { out.append((plain, false)); plain = "" }
                    let end = body.index(i, offsetBy: label.count + 1)
                    out.append((String(body[i..<end]), true))
                    i = end
                    continue
                }
            }
            plain.append(body[i])
            i = body.index(after: i)
        }
        if !plain.isEmpty { out.append((plain, false)) }
        return out
    }

    private static func isWordChar(_ c: Character) -> Bool {
        c.isLetter || c.isNumber || c == "_"
    }
}

// MARK: - Names

enum TeamChatNames {
    /// Who wrote it, as its line says: a member's name, or an agent as the web shows it.
    static func author(of m: TeamChatMessage, members: [String: TeamChatMember], me: String?) -> String {
        if m.isAgent {
            let name = m.agentName?.trimmingCharacters(in: .whitespaces).nilIfEmpty ?? "Agent"
            if let owner = m.agentForMemberId, owner == me { return "\(name) (your agent)" }
            if let owner = m.agentForMemberId, let member = members[owner] { return "\(name) (\(member.name)'s agent)" }
            return name
        }
        guard let id = m.authorMemberId else { return "Someone" }
        return members[id]?.name ?? "A teammate"
    }

    /// A channel's title: "#name", a DM's other person, or "You" for a note to self.
    static func title(of c: TeamChatChannel, members: [String: TeamChatMember], me: String?) -> String {
        if c.kind == .channel { return "#\(c.name ?? "channel")" }
        guard let other = c.dmMemberId else { return "Direct message" }
        if other == me { return "\(members[other]?.name ?? "You") (you)" }
        return members[other]?.name ?? "A teammate"
    }

    /// The labels a message's words draw as mentions: the members it names, its records, the author's agent.
    static func mentionLabels(of m: TeamChatMessage, members: [String: TeamChatMember], agentName: String?, me: String?) -> [String] {
        var labels = m.mentions.compactMap { members[$0]?.displayName }
        labels += m.recordMentions.map(\.label)
        if m.mentionsAgent, m.authorMemberId == me, let agentName { labels.append(agentName) }
        return labels
    }
}

// MARK: - Typing

/// One "X is typing" signal (web/src/lib/team-chat/typing.ts): a member id and the thread, never a name or a word.
struct TeamChatTypingSignal: Equatable {
    static let event = "typing"
    /// At most one "typing" the person sends in this long.
    static let throttle: TimeInterval = 2.5
    /// How long someone is shown after their last word arrives.
    static let show: TimeInterval = 4.5

    let memberId: String
    let thread: String?
    let typing: Bool

    /// The private topic a channel's typing goes over (migration 559's policies read it).
    static func topic(channelId: String) -> String { "team-chat-typing:\(channelId)" }

    /// A payload as a signal, or nil (anyone on the topic can send anything).
    static func parse(_ payload: [String: Any]) -> TeamChatTypingSignal? {
        guard let member = payload["member_id"] as? String, !member.isEmpty else { return nil }
        let rawThread = payload["thread"]
        if let rawThread, !(rawThread is String), !(rawThread is NSNull) { return nil }
        let typing = (payload["typing"] as? Bool) ?? true
        return TeamChatTypingSignal(memberId: member, thread: rawThread as? String, typing: typing)
    }

    var payload: [String: Any] {
        ["member_id": memberId, "thread": thread as Any? ?? NSNull(), "typing": typing]
    }
}

/// Who is typing where, and until when.
struct TeamChatTypingBoard: Equatable {
    private(set) var until: [String: (thread: String?, at: Date)] = [:]

    static func == (a: TeamChatTypingBoard, b: TeamChatTypingBoard) -> Bool {
        a.until.keys.sorted() == b.until.keys.sorted()
            && a.until.allSatisfy { k, v in b.until[k]?.thread == v.thread && b.until[k]?.at == v.at }
    }

    /// A signal heard (never the person's own).
    mutating func hear(_ s: TeamChatTypingSignal, me: String?, now: Date = Date()) {
        guard s.memberId != me else { return }
        if s.typing { until[s.memberId] = (s.thread, now.addingTimeInterval(TeamChatTypingSignal.show)) } else { until[s.memberId] = nil }
    }

    /// Everyone past their time drops off.
    mutating func expire(now: Date = Date()) {
        until = until.filter { $0.value.at > now }
    }

    /// The members typing in this place (the channel itself, or one thread), as of now.
    func typers(thread: String?, now: Date = Date()) -> [String] {
        until.filter { $0.value.thread == thread && $0.value.at > now }.map(\.key).sorted()
    }

    /// The soonest someone drops off (one timer, no loop).
    var nextExpiry: Date? { until.values.map(\.at).min() }

    /// "Rosa is typing…", "Rosa and Ben are typing…", "Several people are typing…"; nil for nobody.
    static func line(_ names: [String]) -> String? {
        switch names.count {
        case 0: return nil
        case 1: return "\(names[0]) is typing…"
        case 2: return "\(names[0]) and \(names[1]) are typing…"
        default: return "Several people are typing…"
        }
    }

    /// Whether a "typing" goes now: not more often than the throttle, or at once in a new place.
    static func shouldSend(last: (thread: String?, at: Date)?, thread: String?, now: Date = Date()) -> Bool {
        guard let last else { return true }
        return last.thread != thread || now.timeIntervalSince(last.at) >= TeamChatTypingSignal.throttle
    }
}

// MARK: - Files

enum TeamChatFiles {
    static let bucket = "team-chat-files"
    /// The most bytes one file holds (558's bucket limit).
    static let maxBytes = 10 * 1024 * 1024
    /// The most files one message carries (555's check).
    static let maxFiles = 10

    /// Each extension a file may have, and the type storage keeps it under (web files.ts).
    static let types: [String: String] = [
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
        "webp": "image/webp", "heic": "image/heic", "pdf": "application/pdf", "txt": "text/plain",
        "md": "text/markdown", "csv": "text/csv", "json": "application/json",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "doc": "application/msword", "xls": "application/vnd.ms-excel",
        "ppt": "application/vnd.ms-powerpoint", "zip": "application/zip",
    ]

    /// Drawn inline; the rest are a chip with their name and size.
    static let inlineImages: Set<String> = ["png", "jpg", "jpeg", "gif", "webp"]

    static func ext(_ name: String) -> String {
        let last = name.split(separator: "/").last.map(String.init) ?? name
        guard let dot = last.lastIndex(of: "."), dot != last.startIndex else { return "" }
        return String(last[last.index(after: dot)...]).lowercased()
    }

    static func type(of name: String) -> String? { types[ext(name)] }

    static func isInlineImage(path: String) -> Bool { inlineImages.contains(ext(path)) }

    /// Can this file go on a message? The reason is the person's to read.
    static func refusal(name: String, size: Int) -> String? {
        if type(of: name) == nil { return "That kind of file can’t be shared here" }
        if size > maxBytes { return "Files are 10 MB at most" }
        if size <= 0 { return "That file is empty" }
        return nil
    }

    /// Where a new upload goes: the channel's folder, the person's sub-folder, a fresh name.
    /// Lower-cased, as the insert guard (555) and the bucket's policy (558) compare it.
    static func path(channelId: String, userId: String, fileName: String, id: UUID = UUID()) -> String {
        "\(channelId.lowercased())/\(userId.lowercased())/\(id.uuidString.lowercased()).\(ext(fileName))"
    }

    /// "820 B", "14 KB", "3.2 MB".
    static func size(_ bytes: Int) -> String {
        if bytes < 0 { return "" }
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1024 * 1024 { return "\(Int((Double(bytes) / 1024).rounded())) KB" }
        let mb = Double(bytes) / (1024 * 1024)
        return mb < 10 ? String(format: "%.1f MB", mb) : "\(Int(mb.rounded())) MB"
    }
}

// MARK: - Channel names

enum TeamChatChannelName {
    static let max = 80

    /// A name as typed, tidied (a leading # dropped, single spaces), or nil when unusable.
    static func tidy(_ raw: String) -> String? {
        var name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while name.hasPrefix("#") { name.removeFirst() }
        name = name.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard !name.isEmpty, name.count <= max else { return nil }
        return name
    }
}

// MARK: - Where a push opens

/// Where a tapped push takes the person (the payload's keys: web/src/lib/push/compose.ts).
enum PushRoute: Equatable {
    /// A team chat message: its channel, at the message; in its thread when it is a reply.
    case teamChat(workspaceId: String?, channelId: String, messageId: String, threadRootId: String?)
    /// The agent's message in the person's own thread: the chat.
    case homeMessage(workspaceId: String?, conversationId: String)

    static func parse(_ userInfo: [AnyHashable: Any]) -> PushRoute? {
        func str(_ key: String) -> String? {
            guard let v = userInfo[key] as? String else { return nil }
            let t = v.trimmingCharacters(in: .whitespaces)
            return t.isEmpty ? nil : t.lowercased()
        }
        switch userInfo["kind"] as? String {
        case "team_chat":
            guard let channel = str("channel_id"), let message = str("message_id") else { return nil }
            return .teamChat(workspaceId: str("workspace_id"), channelId: channel, messageId: message, threadRootId: str("thread_root_id"))
        case "home_message":
            guard let conversation = str("conversation_id") else { return nil }
            return .homeMessage(workspaceId: str("workspace_id"), conversationId: conversation)
        default:
            return nil
        }
    }

    var workspaceId: String? {
        switch self {
        case let .teamChat(ws, _, _, _): return ws
        case let .homeMessage(ws, _): return ws
        }
    }
}

/// The conversation on screen right now, if any (what a push arriving in the foreground is checked against).
struct TeamChatOnScreen: Equatable {
    let channelId: String
    /// The thread open beside or over it, if any.
    let threadRootId: String?
}

enum PushPresentation {
    /// Whether a push that arrives while the app is open shows its banner: never for the
    /// conversation on screen (the message is right there), always otherwise.
    static func showsBanner(_ route: PushRoute?, onScreen: TeamChatOnScreen?, chatOpen: Bool = false) -> Bool {
        switch route {
        case let .teamChat(_, channel, _, root):
            guard let onScreen else { return true }
            if let root { return onScreen.threadRootId != root }
            return !(onScreen.channelId == channel && onScreen.threadRootId == nil)
        case .homeMessage:
            return !chatOpen
        case nil:
            return true
        }
    }
}

// MARK: - Device token

enum PushToken {
    /// APNs' device token as the hex the server stores (migration 562).
    static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - Push permission, kept in step with the server

/// What iOS says about notifications for the app.
enum PushAuthorization: Equatable {
    case notDetermined
    case denied
    /// Authorized, provisional or ephemeral.
    case allowed
}

enum PushSyncAction: Equatable {
    /// Register with APNs again: the token reaches the server, and its last-seen moves.
    case register
    /// Take this install off the person (push_token_remove): nothing they would see arrives by push,
    /// so the server must fall back to a text, Slack or email.
    case remove
    case wait
}

enum PushSync {
    /// On every launch and return to the foreground. Notifications turned off in Settings (or every
    /// way of showing one turned off) takes the install off; allowed registers it again. Not yet
    /// asked: wait for the first time team chat opens.
    static func action(_ authorization: PushAuthorization, alertsVisible: Bool, signedIn: Bool, registered: Bool) -> PushSyncAction {
        guard signedIn else { return .wait }
        switch authorization {
        case .allowed where alertsVisible:
            return .register
        case .allowed, .denied:
            return registered ? .remove : .wait
        case .notDetermined:
            return .wait
        }
    }
}

// MARK: - Links

enum TeamChatLinks {
    /// A link a message's words or a preview card may open: http or https with a host, nothing else
    /// (no tel:, sms:, file:, app schemes or javascript:).
    static func safeURL(_ raw: String?) -> URL? {
        guard let raw, let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host, !host.isEmpty else { return nil }
        return url
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
