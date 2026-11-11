//
//  TeamChatModels.swift
//  Native Intelligence
//
//  Team chat's data, as the web app's routes and Supabase hand it over
//  (web/src/lib/team-chat/types.ts is the other side). Foundation only, so
//  the logic beside it builds and runs on the Mac in Scripts/test-team-chat.sh.
//
//  Times stay the server's strings: a page of history is asked for "before"
//  the oldest message's own created_at, and a string round-trips exactly
//  where a Date would lose its microseconds. `TeamChatTime.date(_:)` reads
//  one for display and ordering.
//

import Foundation

enum TeamChatChannelKind: String, Codable, Equatable {
    case channel
    case dm
}

/// How loud a channel is for the person (migration 560).
enum TeamChatNotifyLevel: String, Codable, CaseIterable, Equatable {
    case all
    case mentions
    case muted

    var label: String {
        switch self {
        case .all: return "All messages"
        case .mentions: return "Mentions only"
        case .muted: return "Muted"
        }
    }

    /// A channel's level when the person chose none: mentions for a channel, every message in a DM.
    static func defaultLevel(for kind: TeamChatChannelKind) -> TeamChatNotifyLevel {
        kind == .dm ? .all : .mentions
    }
}

/// A channel or DM as the list shows it (GET /api/account/team-chat/channels).
struct TeamChatChannel: Codable, Identifiable, Equatable {
    let id: String
    let kind: TeamChatChannelKind
    /// A channel's name, no leading #. Nil for a DM.
    var name: String?
    var topic: String?
    let teamId: String?
    /// A DM's other member (themselves for a note to self).
    let dmMemberId: String?
    var lastMessageAt: String?
    var archivedAt: String?
    /// Messages from others since the person last read it (0 when muted).
    var unread: Int
    /// How many of those mention them (counted even when muted).
    var mentions: Int
    var threadUnread: Int
    var threadMentions: Int
    var notify: TeamChatNotifyLevel

    enum CodingKeys: String, CodingKey {
        case id, kind, name, topic, unread, mentions, notify
        case teamId = "team_id"
        case dmMemberId = "dm_member_id"
        case lastMessageAt = "last_message_at"
        case archivedAt = "archived_at"
        case threadUnread = "thread_unread"
        case threadMentions = "thread_mentions"
    }
}

/// A file or image on a message (migration 555).
struct TeamChatAttachment: Codable, Equatable, Hashable {
    /// Its object in the team-chat-files bucket: `<channel id>/<user id>/<uuid>.<ext>`.
    let path: String
    let name: String
    let size: Int
    let type: String
    var width: Int?
    var height: Int?

    var isImage: Bool { TeamChatFiles.isInlineImage(path: path) }
}

/// A message's first link, as the server read it once.
struct TeamChatLinkPreview: Codable, Equatable {
    let url: String
    let site: String
    let title: String?
    let description: String?
    let image: String?
}

/// A record a message @-mentions (migration 480): drawn like a member's mention.
struct TeamChatRecordMention: Codable, Equatable {
    let type: String
    let id: String
    let label: String
}

/// A message as a screen shows it.
struct TeamChatMessage: Codable, Identifiable, Equatable {
    let id: String
    let channelId: String
    let authorKind: String
    let authorMemberId: String?
    let agentForMemberId: String?
    let agentName: String?
    let inReplyTo: String?
    let threadRootId: String?
    let clientId: String?
    var body: String
    var mentions: [String]
    var mentionsAgent: Bool
    var recordMentions: [TeamChatRecordMention]
    var attachments: [TeamChatAttachment]
    var linkPreview: TeamChatLinkPreview?
    let createdAt: String
    var editedAt: String?
    var deletedAt: String?

    var isAgent: Bool { authorKind == "agent" }
    var isDeleted: Bool { deletedAt != nil }

    enum CodingKeys: String, CodingKey {
        case id, body, mentions, attachments
        case channelId = "channel_id"
        case authorKind = "author_kind"
        case authorMemberId = "author_member_id"
        case agentForMemberId = "agent_for_member_id"
        case agentName = "agent_name"
        case inReplyTo = "in_reply_to"
        case threadRootId = "thread_root_id"
        case clientId = "client_id"
        case mentionsAgent = "mentions_agent"
        case recordMentions = "record_mentions"
        case linkPreview = "link_preview"
        case createdAt = "created_at"
        case editedAt = "edited_at"
        case deletedAt = "deleted_at"
    }

    init(
        id: String, channelId: String, authorKind: String = "member", authorMemberId: String?,
        agentForMemberId: String? = nil, agentName: String? = nil, inReplyTo: String? = nil,
        threadRootId: String? = nil, clientId: String? = nil, body: String, mentions: [String] = [],
        mentionsAgent: Bool = false, recordMentions: [TeamChatRecordMention] = [],
        attachments: [TeamChatAttachment] = [], linkPreview: TeamChatLinkPreview? = nil,
        createdAt: String, editedAt: String? = nil, deletedAt: String? = nil
    ) {
        self.id = id
        self.channelId = channelId
        self.authorKind = authorKind
        self.authorMemberId = authorMemberId
        self.agentForMemberId = agentForMemberId
        self.agentName = agentName
        self.inReplyTo = inReplyTo
        self.threadRootId = threadRootId
        self.clientId = clientId
        self.body = body
        self.mentions = mentions
        self.mentionsAgent = mentionsAgent
        self.recordMentions = recordMentions
        self.attachments = attachments
        self.linkPreview = linkPreview
        self.createdAt = createdAt
        self.editedAt = editedAt
        self.deletedAt = deletedAt
    }

    /// Lenient: a realtime row, or one from before a column existed, may leave any of the
    /// newer columns out (the web reads them the same way).
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        channelId = try c.decode(String.self, forKey: .channelId)
        authorKind = (try? c.decode(String.self, forKey: .authorKind)) ?? "member"
        authorMemberId = try c.decodeIfPresent(String.self, forKey: .authorMemberId)
        agentForMemberId = try c.decodeIfPresent(String.self, forKey: .agentForMemberId)
        agentName = try c.decodeIfPresent(String.self, forKey: .agentName)
        inReplyTo = try c.decodeIfPresent(String.self, forKey: .inReplyTo)
        threadRootId = try c.decodeIfPresent(String.self, forKey: .threadRootId)
        clientId = try c.decodeIfPresent(String.self, forKey: .clientId)
        body = (try? c.decode(String.self, forKey: .body)) ?? ""
        mentions = (try? c.decode([String].self, forKey: .mentions)) ?? []
        mentionsAgent = (try? c.decode(Bool.self, forKey: .mentionsAgent)) ?? false
        recordMentions = (try? c.decode([TeamChatRecordMention].self, forKey: .recordMentions)) ?? []
        attachments = (try? c.decode([TeamChatAttachment].self, forKey: .attachments)) ?? []
        linkPreview = try? c.decodeIfPresent(TeamChatLinkPreview.self, forKey: .linkPreview)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        editedAt = try c.decodeIfPresent(String.self, forKey: .editedAt)
        deletedAt = try c.decodeIfPresent(String.self, forKey: .deletedAt)
    }
}

/// A thread's summary under its root (migration 556).
struct TeamChatThreadSummary: Codable, Equatable {
    let rootId: String
    let channelId: String
    var replyCount: Int
    var lastReplyAt: String?
    var participantIds: [String]

    enum CodingKeys: String, CodingKey {
        case rootId = "root_id"
        case channelId = "channel_id"
        case replyCount = "reply_count"
        case lastReplyAt = "last_reply_at"
        case participantIds = "participant_ids"
    }

    init(rootId: String, channelId: String, replyCount: Int, lastReplyAt: String?, participantIds: [String]) {
        self.rootId = rootId
        self.channelId = channelId
        self.replyCount = replyCount
        self.lastReplyAt = lastReplyAt
        self.participantIds = participantIds
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rootId = try c.decode(String.self, forKey: .rootId)
        channelId = try c.decode(String.self, forKey: .channelId)
        replyCount = (try? c.decode(Int.self, forKey: .replyCount)) ?? 0
        lastReplyAt = try c.decodeIfPresent(String.self, forKey: .lastReplyAt)
        participantIds = (try? c.decode([String].self, forKey: .participantIds)) ?? []
    }
}

/// A thread the person is in with replies they haven't read.
struct TeamChatThreadUnread: Codable, Equatable {
    let rootId: String
    let channelId: String
    var unread: Int
    var mentions: Int

    enum CodingKeys: String, CodingKey {
        case unread, mentions
        case rootId = "root_id"
        case channelId = "channel_id"
    }
}

/// One member's reaction on a message (migration 557); `active` false: taken back.
struct TeamChatReaction: Codable, Equatable {
    let messageId: String
    let memberId: String
    let emoji: String
    var active: Bool

    enum CodingKeys: String, CodingKey {
        case emoji, active
        case messageId = "message_id"
        case memberId = "member_id"
    }
}

/// A member of the workspace, as names, avatars and the mention picker read them.
struct TeamChatMember: Codable, Identifiable, Equatable {
    let id: String
    let userId: String?
    let displayName: String?
    let avatarUrl: String?

    var name: String {
        let trimmed = displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "A teammate" : trimmed
    }

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case displayName = "display_name"
        case avatarUrl = "avatar_url"
    }
}

// MARK: - Route payloads

struct TeamChatChannelsResponse: Decodable {
    let channels: [TeamChatChannel]
    let threads: [TeamChatThreadUnread]
    let memberId: String?
}

struct TeamChatMessagesResponse: Decodable {
    let messages: [TeamChatMessage]
    let threads: [TeamChatThreadSummary]?
    let reactions: [TeamChatReaction]?
    /// A thread's root (`?thread=`).
    let root: TeamChatMessage?
    /// The page around one message (`?around=`): older ones before it.
    var hasOlder: Bool? = nil
    /// … and newer ones past it than the page holds (it shows alone, with a way to the newest).
    var hasNewer: Bool? = nil
}

struct TeamChatPostResponse: Decodable {
    let message: TeamChatMessage
    let replayed: Bool?
}

struct TeamChatOneMessageResponse: Decodable {
    let message: TeamChatMessage
    let root: TeamChatMessage?
}

// MARK: - Times

enum TeamChatTime {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// A server time ("2026-11-11T20:00:00.123456+00:00", "…Z", with or without a
    /// fraction, a space for the T) as a Date. Fractions past milliseconds are cut,
    /// which ISO8601DateFormatter needs.
    static func date(_ raw: String?) -> Date? {
        guard var text = raw?.trimmingCharacters(in: .whitespaces), !text.isEmpty else { return nil }
        if let space = text.firstIndex(of: " "), text.distance(from: text.startIndex, to: space) == 10 {
            text.replaceSubrange(space...space, with: "T")
        }
        if let dot = text.firstIndex(of: ".") {
            let digitsStart = text.index(after: dot)
            var end = digitsStart
            while end < text.endIndex, text[end].isNumber { end = text.index(after: end) }
            let digits = text[digitsStart..<end]
            let kept = String(digits.prefix(3)).padding(toLength: 3, withPad: "0", startingAt: 0)
            text = String(text[..<digitsStart]) + kept + String(text[end...])
            return withFraction.date(from: text)
        }
        return plain.date(from: text)
    }

    /// Now, as the server writes times (for an optimistic message's place in the list).
    static func now(_ date: Date = Date()) -> String {
        withFraction.string(from: date)
    }
}
