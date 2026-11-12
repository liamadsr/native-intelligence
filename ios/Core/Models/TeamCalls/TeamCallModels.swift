//
//  TeamCallModels.swift
//  Native Intelligence
//
//  Team calls' data (audio and video calls in a team chat channel or DM, over
//  the self-hosted LiveKit server), as the web app's routes, Supabase and the
//  VoIP push hand it over. web/src/lib/team-calls/types.ts and ring-push.ts
//  are the other side. Foundation only, so the rules beside it build and run
//  on the Mac in Scripts/test-team-calls.sh.
//

import Foundation

/// One ring's state (migration 564): ringing, a quiet notice (they were in another call), or settled.
enum TeamCallRingState: String, Codable, Equatable {
    case ringing, busy, accepted, declined, missed, cancelled

    var isOpen: Bool { self == .ringing || self == .busy }
}

/// One person's incoming call, as its own row says it (their own rows only, by RLS).
struct TeamCallRing: Codable, Identifiable, Equatable {
    let id: String
    let callId: String
    let workspaceId: String
    let channelId: String
    let memberId: String
    let callerMemberId: String?
    let callerName: String
    let channelKind: TeamChatChannelKind
    let channelName: String?
    var state: TeamCallRingState
    let createdAt: String
    let expiresAt: String

    enum CodingKeys: String, CodingKey {
        case id, state
        case callId = "call_id"
        case workspaceId = "workspace_id"
        case channelId = "channel_id"
        case memberId = "member_id"
        case callerMemberId = "caller_member_id"
        case callerName = "caller_name"
        case channelKind = "channel_kind"
        case channelName = "channel_name"
        case createdAt = "created_at"
        case expiresAt = "expires_at"
    }

    /// The columns a ring is read with (web TEAM_CALL_RING_COLUMNS).
    static let columns = "id, call_id, workspace_id, channel_id, member_id, caller_member_id, caller_name, channel_kind, channel_name, state, created_at, expires_at"
}

enum TeamCallStatus: String, Codable, Equatable {
    case live, ended
}

/// A call, as a conversation's message draws it.
struct TeamCall: Codable, Identifiable, Equatable {
    let id: String
    let channelId: String
    let messageId: String?
    let startedBy: String?
    var status: TeamCallStatus
    let startedAt: String
    var endedAt: String?
    var durationSeconds: Int?
    var participantCount: Int
    var peakParticipants: Int
    var ringing: [String]
    var declined: [String]
    /// Notes are taken in this call, or it is recorded (the call-notes work; a row without them: off).
    var notes: Bool = false
    var recording: Bool = false

    enum CodingKeys: String, CodingKey {
        case id, status, ringing, declined, notes, recording
        case channelId = "channel_id"
        case messageId = "message_id"
        case startedBy = "started_by"
        case startedAt = "started_at"
        case endedAt = "ended_at"
        case durationSeconds = "duration_seconds"
        case participantCount = "participant_count"
        case peakParticipants = "peak_participants"
    }

    init(id: String, channelId: String, messageId: String?, startedBy: String?, status: TeamCallStatus, startedAt: String,
         endedAt: String? = nil, durationSeconds: Int? = nil, participantCount: Int = 0, peakParticipants: Int = 0,
         ringing: [String] = [], declined: [String] = []) {
        self.id = id
        self.channelId = channelId
        self.messageId = messageId
        self.startedBy = startedBy
        self.status = status
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.durationSeconds = durationSeconds
        self.participantCount = participantCount
        self.peakParticipants = peakParticipants
        self.ringing = ringing
        self.declined = declined
    }

    /// Lenient: a Realtime row may leave the arrays out.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        channelId = try c.decode(String.self, forKey: .channelId)
        messageId = try c.decodeIfPresent(String.self, forKey: .messageId)
        startedBy = try c.decodeIfPresent(String.self, forKey: .startedBy)
        status = (try? c.decode(TeamCallStatus.self, forKey: .status)) ?? .live
        startedAt = try c.decode(String.self, forKey: .startedAt)
        endedAt = try c.decodeIfPresent(String.self, forKey: .endedAt)
        durationSeconds = try? c.decodeIfPresent(Int.self, forKey: .durationSeconds)
        participantCount = (try? c.decode(Int.self, forKey: .participantCount)) ?? 0
        peakParticipants = (try? c.decode(Int.self, forKey: .peakParticipants)) ?? 0
        ringing = (try? c.decode([String].self, forKey: .ringing)) ?? []
        declined = (try? c.decode([String].self, forKey: .declined)) ?? []
        notes = (try? c.decode(Bool.self, forKey: .notes)) ?? false
        recording = (try? c.decode(Bool.self, forKey: .recording)) ?? false
    }

    /// What the person is told before they talk in it, or nil (TeamCallNotice).
    var notice: String? { TeamCallNotice.line(notes: notes, recording: recording) }

    /// The same, where the server says who takes the notes: the call recorder's notes (`liveNotes`)
    /// hold no member back (every call takes them; the "Notes are on" badge says so), a recording
    /// still does. Egress's notes are said first, as before.
    func notice(liveNotes: Bool) -> String? {
        TeamCallNotice.line(notes: notes && !liveNotes, recording: recording)
    }
}

/// One member in (or once in) a call.
struct TeamCallParticipant: Codable, Equatable {
    let callId: String
    let memberId: String
    var state: String
    var joinedAt: String
    var leftAt: String?

    var isIn: Bool { state == "joined" }

    enum CodingKeys: String, CodingKey {
        case state
        case callId = "call_id"
        case memberId = "member_id"
        case joinedAt = "joined_at"
        case leftAt = "left_at"
    }
}

/// A call and who is in it, as the conversation's message draws it (the messages route's `calls`).
struct TeamCallView: Codable, Equatable {
    var call: TeamCall
    var participants: [TeamCallParticipant]

    /// The members in it now, in the order they joined.
    var inNow: [TeamCallParticipant] {
        participants.filter(\.isIn).sorted { $0.joinedAt < $1.joinedAt }
    }

    /// A participant row in (replacing that member's), as Realtime hands it over.
    mutating func upsert(_ row: TeamCallParticipant) {
        participants.removeAll { $0.memberId == row.memberId }
        participants.append(row)
    }
}

/// What a client needs to join a call's room: the address and a short-lived token (never in a push).
struct TeamCallJoin: Codable, Equatable {
    let url: String
    let token: String
    let room: String
    let callId: String
}

/// What the server offers a call (web TeamCallFeatures): only what the app reads.
struct TeamCallFeatures: Codable, Equatable {
    /// The call recorder takes the notes: no member is held, or told first, for them.
    let liveNotes: Bool?
}

/// Where the call is, as the routes describe it.
struct TeamCallPlace: Codable, Equatable {
    let id: String
    let channelId: String
    let workspaceId: String
    let messageId: String?
    let channelKind: TeamChatChannelKind
    /// What the server offers this call (every start, join and ring answer says so).
    let features: TeamCallFeatures?
}

// MARK: - Words

enum TeamCallWords {
    /// "#launch", or nil for a DM (web teamCallPlace).
    static func place(kind: TeamChatChannelKind, name: String?) -> String? {
        kind == .channel ? "#\(name ?? "channel")" : nil
    }

    /// What the incoming call says: "Ana Ruiz", or "Ana Ruiz · #launch".
    static func callerLine(name: String, kind: TeamChatChannelKind, channelName: String?) -> String {
        let who = name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "A teammate" : name
        guard let place = place(kind: kind, name: channelName) else { return who }
        return "\(who) · \(place)"
    }

    /// "under a minute", "12 min", "1 h 5 min", "2 h" (web teamCallDuration).
    static func duration(_ seconds: Int?) -> String {
        let s = max(0, seconds ?? 0)
        if s < 60 { return "under a minute" }
        if s < 3600 { return "\(s / 60) min" }
        let h = s / 3600, m = (s % 3600) / 60
        return m > 0 ? "\(h) h \(m) min" : "\(h) h"
    }

    /// An ended call's line, the same words 565's team_call_summary writes onto its message.
    static func summary(kind: TeamChatChannelKind, seconds: Int?, peak: Int?) -> String {
        let people = max(0, peak ?? 0)
        if kind == .dm && people <= 1 { return "Missed call" }
        if people == 0 { return "Call ended" }
        return "Call ended · \(duration(seconds)) · \(people) \(people == 1 ? "person" : "people")"
    }

    /// The call screen's clock: "0:42", "12:05", "1:02:09".
    static func clock(_ seconds: Int) -> String {
        let s = max(0, seconds)
        let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
    }
}

// MARK: - The VoIP push

/// A team call's VoIP push (web/src/lib/team-calls/ring-push.ts): a ring, or its cancel.
enum TeamCallPush: Equatable {
    case ring(TeamCallIncoming)
    /// Stop ringing: the ring was settled elsewhere (accepted, declined) or the caller gave up (missed).
    case cancel(ringId: String, callId: String?, state: TeamCallRingState)

    var ringId: String {
        switch self {
        case let .ring(r): return r.ringId
        case let .cancel(id, _, _): return id
        }
    }

    /// The push's keys, or nil for something that is not a team call's push (it is still reported and ended).
    static func parse(_ payload: [AnyHashable: Any]) -> TeamCallPush? {
        func str(_ key: String) -> String? {
            guard let v = payload[key] as? String else { return nil }
            let t = v.trimmingCharacters(in: .whitespaces)
            return t.isEmpty ? nil : t
        }
        func uuid(_ key: String) -> String? {
            guard let v = str(key), UUID(uuidString: v) != nil else { return nil }
            return v.lowercased()
        }
        switch str("kind") {
        case "team_call_ring":
            guard let ring = uuid("ring_id"), let call = uuid("call_id"), let channel = uuid("channel_id"), let ws = uuid("workspace_id") else { return nil }
            let kind = TeamChatChannelKind(rawValue: str("channel_kind") ?? "") ?? .dm
            let seconds: Int = {
                if let n = payload["seconds_left"] as? Int { return n }
                if let n = payload["seconds_left"] as? NSNumber { return n.intValue }
                if let s = str("seconds_left"), let n = Int(s) { return n }
                return 0
            }()
            let video = (payload["video"] as? Bool) ?? ((payload["video"] as? NSNumber)?.boolValue ?? false)
            var incoming = TeamCallIncoming(
                ringId: ring, callId: call, channelId: channel, workspaceId: ws,
                callerName: String((str("caller_name") ?? "A teammate").prefix(120)),
                channelKind: kind, channelName: str("channel_name"),
                video: video, secondsLeft: max(0, min(seconds, TeamCallIncoming.maxRingSeconds))
            )
            incoming.expiresAt = TeamChatTime.date(str("expires_at"))
            return .ring(incoming)
        case "team_call_cancel":
            guard let ring = uuid("ring_id") else { return nil }
            let state = TeamCallRingState(rawValue: str("state") ?? "") ?? .cancelled
            return .cancel(ringId: ring, callId: uuid("call_id"), state: state)
        default:
            return nil
        }
    }
}

/// An incoming call: what the phone's ringing screen says, and the ids it answers with.
struct TeamCallIncoming: Equatable {
    let ringId: String
    let callId: String
    let channelId: String
    let workspaceId: String
    let callerName: String
    let channelKind: TeamChatChannelKind
    let channelName: String?
    let video: Bool
    /// The ring's time left as the server sent it: the phone's own clock stops it after this long.
    let secondsLeft: Int
    /// When the ring stops, as the server wrote it: a push delivered late never rings past it.
    var expiresAt: Date? = nil

    /// When it stops ringing here: its time left from now, never past its own end.
    func deadline(now: Date) -> Date {
        let byClock = now.addingTimeInterval(TimeInterval(secondsLeft))
        guard let expiresAt else { return byClock }
        return min(byClock, expiresAt)
    }

    /// A ring rings 40 seconds (565); a push never asks for longer than this.
    static let maxRingSeconds = 60

    var callerLine: String { TeamCallWords.callerLine(name: callerName, kind: channelKind, channelName: channelName) }

    /// A ring row read while the app is open (Realtime, or a fetch), as an incoming call.
    init?(ring: TeamCallRing, now: Date) {
        guard ring.state == .ringing, let expires = TeamChatTime.date(ring.expiresAt) else { return nil }
        let left = Int(expires.timeIntervalSince(now).rounded(.down))
        guard left > 0 else { return nil }
        self.init(ringId: ring.id.lowercased(), callId: ring.callId.lowercased(), channelId: ring.channelId.lowercased(), workspaceId: ring.workspaceId.lowercased(),
                  callerName: ring.callerName, channelKind: ring.channelKind, channelName: ring.channelName, video: false,
                  secondsLeft: min(left, Self.maxRingSeconds))
        expiresAt = expires
    }

    init(ringId: String, callId: String, channelId: String, workspaceId: String, callerName: String, channelKind: TeamChatChannelKind,
         channelName: String?, video: Bool, secondsLeft: Int) {
        self.ringId = ringId
        self.callId = callId
        self.channelId = channelId
        self.workspaceId = workspaceId
        self.callerName = callerName
        self.channelKind = channelKind
        self.channelName = channelName
        self.video = video
        self.secondsLeft = secondsLeft
    }
}

// MARK: - Notes and recording

/// What a person is told before they talk in a call that takes notes or is recorded (the server lets
/// them talk only once the join request says they saw it: `noticeSeen`).
enum TeamCallNotice {
    static func line(notes: Bool, recording: Bool) -> String? {
        switch (notes, recording) {
        case (true, true): return "Notes are on and this call is being recorded"
        case (true, false): return "Notes are on for this call"
        case (false, true): return "This call is being recorded"
        case (false, false): return nil
        }
    }
}

// MARK: - CallKit, as plain values

/// What the system's call screen shows for a call (CXCallUpdate's fields the app sets).
struct TeamCallKitUpdate: Equatable {
    /// The handle (CXHandle .generic): the conversation, so the system groups a call by it.
    let handle: String
    let callerName: String
    let hasVideo: Bool

    static func incoming(_ r: TeamCallIncoming) -> TeamCallKitUpdate {
        TeamCallKitUpdate(handle: "team-chat:\(r.channelId)", callerName: r.callerLine, hasVideo: r.video)
    }

    static func outgoing(channelId: String, label: String) -> TeamCallKitUpdate {
        TeamCallKitUpdate(handle: "team-chat:\(channelId)", callerName: label, hasVideo: false)
    }

    /// The stand-in the system is told of when a push must be reported but is no call (malformed,
    /// or settled already): ended at once.
    static let placeholder = TeamCallKitUpdate(handle: "team-chat", callerName: "Team call", hasVideo: false)
}

/// Why a call ended, as the system is told (CXCallEndedReason's cases, by name).
enum TeamCallEndReason: Equatable {
    /// Nothing went wrong that the person needs to know: the push was for no call.
    case failed
    /// The other side hung up, or the call ended.
    case remoteEnded
    /// Nobody answered in time.
    case unanswered
    case answeredElsewhere
    case declinedElsewhere

    /// How a ring that was settled elsewhere ends on the phone.
    static func of(settled state: TeamCallRingState) -> TeamCallEndReason {
        switch state {
        case .accepted: return .answeredElsewhere
        case .declined: return .declinedElsewhere
        case .missed, .cancelled: return .remoteEnded
        case .ringing, .busy: return .failed
        }
    }
}
