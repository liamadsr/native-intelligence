//
//  TeamCallSessionState.swift
//  Native Intelligence
//
//  One call the person is in, as plain values: its connection (connecting,
//  in it, reconnecting, ended and why), the microphone and camera (on, off,
//  refused by iOS, or none there), hold; the tiles the call screen draws from
//  who is in the room; a call's message in the conversation; where a call
//  takes the person. App/Services/TeamCalls/TeamCallSession.swift feeds it
//  what LiveKit says; the decisions are here, where
//  Scripts/test-team-calls.sh checks them.
//

import Foundation

/// How the call ended for the person.
enum TeamCallSessionEnd: Equatable {
    /// They left.
    case left
    /// The call ended (its room closed: the last person left, or a DM's other person hung up).
    case ended
    /// They joined the same call on another device.
    case elsewhere
    case removed
    /// The connection was lost for good, or the call could not be joined.
    case failed

    /// What the call screen says as it goes (nothing when the person left themselves).
    var line: String? {
        switch self {
        case .left: return nil
        case .ended: return "The call ended."
        case .elsewhere: return "You joined this call on another device."
        case .removed: return "You were removed from the call."
        case .failed: return "The call was lost. Join it again from the conversation."
        }
    }

    /// How the system's call screen is told (a call the person left is told by its own action).
    var systemReason: TeamCallEndReason {
        switch self {
        case .left, .ended: return .remoteEnded
        case .elsewhere: return .answeredElsewhere
        case .removed: return .remoteEnded
        case .failed: return .failed
        }
    }
}

enum TeamCallConnection: Equatable {
    case connecting
    case connected
    case reconnecting
    case ended(TeamCallSessionEnd)

    var isEnded: Bool {
        if case .ended = self { return true }
        return false
    }
}

/// A microphone or camera.
enum TeamCallDevice: Equatable {
    case on
    case off
    /// iOS refuses it (Settings → Native Intelligence).
    case denied
    /// None there (a camera on a device without one; the Simulator).
    case missing
}

/// iOS's answer for the microphone or the camera, as plain values.
enum TeamCallPermission: Equatable {
    case granted, denied, undetermined
}

struct TeamCallSessionState: Equatable {
    private(set) var connection: TeamCallConnection = .connecting
    private(set) var mic: TeamCallDevice = .off
    private(set) var camera: TeamCallDevice = .off
    private(set) var held = false
    /// When the room was first joined (the call screen's clock).
    private(set) var connectedAt: Date?

    enum Event: Equatable {
        case connected(at: Date)
        case reconnecting
        case reconnected
        case ended(TeamCallSessionEnd)
        case mic(TeamCallDevice)
        case camera(TeamCallDevice)
        case held(Bool)
    }

    /// How a call joins: the microphone on (asked first when iOS hasn't), listening only when iOS
    /// refuses it; the camera off.
    static func joiningMic(_ permission: TeamCallPermission) -> TeamCallDevice {
        permission == .denied ? .denied : .on
    }

    /// One thing that happened. An ended call takes nothing more.
    mutating func apply(_ event: Event) {
        guard !connection.isEnded else { return }
        switch event {
        case let .connected(at):
            if connection == .connecting { connectedAt = at }
            connection = .connected
        case .reconnecting:
            if connection == .connected { connection = .reconnecting }
        case .reconnected:
            if connection == .reconnecting { connection = .connected }
        case let .ended(why):
            connection = .ended(why)
        case let .mic(d):
            mic = d
        case let .camera(d):
            camera = d
        case let .held(on):
            held = on
        }
    }

    /// Seconds in the call, for its clock.
    func elapsed(now: Date) -> Int {
        guard let connectedAt else { return 0 }
        return max(0, Int(now.timeIntervalSince(connectedAt)))
    }

    /// The call screen's explanations: why the person is listening only, why the camera is off.
    var notices: [String] {
        var out: [String] = []
        if mic == .denied { out.append("Native Intelligence can’t use the microphone, so you’re listening only. Turn it on in Settings → Native Intelligence → Microphone.") }
        if mic == .missing { out.append("No microphone was found, so you’re listening only.") }
        if camera == .denied { out.append("Native Intelligence can’t use the camera. To be seen, turn it on in Settings → Native Intelligence → Camera.") }
        return out
    }

    /// The status line under the call's name.
    func statusLine(now: Date) -> String {
        switch connection {
        case .connecting: return "Connecting…"
        case .reconnecting: return "Reconnecting…"
        case .connected: return held ? "On hold" : TeamCallWords.clock(elapsed(now: now))
        case let .ended(why): return why.line ?? "Call ended"
        }
    }
}

// MARK: - Tiles

/// One person in the room, as the call screen reads them.
struct TeamCallPeer: Equatable {
    /// LiveKit's identity: the person's member id.
    let identity: String
    let name: String
    let isLocal: Bool
    var isSpeaking = false
    var micOn = true
    var cameraOn = false
    var sharingScreen = false
    /// When they joined (the order tiles keep).
    var joinedAt: Date = .distantPast
}

/// One tile: a person (their camera, or their initials), or a shared screen.
struct TeamCallTile: Equatable, Identifiable {
    enum Kind: Equatable { case person, screen }

    var id: String { "\(identity):\(kind == .screen ? "screen" : "camera")" }
    let identity: String
    let name: String
    let kind: Kind
    let isLocal: Bool
    let speaking: Bool
    let micOn: Bool
    let hasVideo: Bool
}

enum TeamCallLayout: Equatable {
    /// Only the person is in it: their tile, and a waiting line.
    case waiting
    /// One other person: theirs fills the screen, the person's own in a corner.
    case pair
    /// Three or more: a grid of this many columns.
    case grid(columns: Int)
    /// A shared screen: it fills the top, the people in a row under it.
    case screen
}

enum TeamCallTiles {
    /// The tiles, in order: shared screens first, then the others in the order they joined, the person last.
    static func tiles(_ peers: [TeamCallPeer]) -> [TeamCallTile] {
        let ordered = peers.sorted { a, b in
            if a.isLocal != b.isLocal { return !a.isLocal }
            if a.joinedAt != b.joinedAt { return a.joinedAt < b.joinedAt }
            return a.identity < b.identity
        }
        let screens = ordered.filter(\.sharingScreen).map {
            TeamCallTile(identity: $0.identity, name: $0.name, kind: .screen, isLocal: $0.isLocal, speaking: false, micOn: $0.micOn, hasVideo: true)
        }
        let people = ordered.map {
            TeamCallTile(identity: $0.identity, name: $0.name, kind: .person, isLocal: $0.isLocal, speaking: $0.isSpeaking && $0.micOn, micOn: $0.micOn, hasVideo: $0.cameraOn)
        }
        return screens + people
    }

    static func layout(_ tiles: [TeamCallTile]) -> TeamCallLayout {
        if tiles.contains(where: { $0.kind == .screen }) { return .screen }
        let people = tiles.filter { $0.kind == .person }.count
        switch people {
        case 0, 1: return .waiting
        case 2: return .pair
        default: return .grid(columns: 2)
        }
    }

    /// Initials for a tile with no video: "AR" for Ana Ruiz.
    static func initials(_ name: String) -> String {
        let letters = name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
        return letters.isEmpty ? "?" : letters
    }
}

// MARK: - A call's message in the conversation

/// What a call's message shows: a live call with who is in it and Join, or how it ended.
enum TeamCallCard: Equatable {
    /// `people`: the members in it now (ids, in the order they joined); `here`: the person is in it on this phone.
    case live(people: [String], here: Bool)
    case ended(String)

    static func of(message body: String, view: TeamCallView?, channelKind: TeamChatChannelKind, inCallId: String?) -> TeamCallCard {
        guard let view else {
            // The call isn't read yet (a live row that arrived first): its message's words say what happened.
            return body == "Started a call" ? .live(people: [], here: false) : .ended(body)
        }
        if view.call.status == .ended {
            return .ended(TeamCallWords.summary(kind: channelKind, seconds: view.call.durationSeconds, peak: view.call.peakParticipants))
        }
        return .live(people: view.inNow.map(\.memberId), here: inCallId == view.call.id)
    }

    /// Who is in a live call, under its "Call in progress": "Ana Ruiz", "Ana Ruiz and Ben Okafor",
    /// "Ana Ruiz and 2 others"; "Nobody yet" before anyone is in.
    static func peopleLine(_ names: [String]) -> String {
        switch names.count {
        case 0: return "Nobody yet"
        case 1: return names[0]
        case 2: return "\(names[0]) and \(names[1])"
        default: return "\(names[0]) and \(names.count - 1) others"
        }
    }
}

// MARK: - Where a call takes the person

enum TeamCallRouting {
    /// What a tap on a call's Join (or the call button) does, given the call the person is in.
    enum Join: Equatable {
        /// Already in it: open its screen.
        case show
        /// Leave the one they are in, then join this.
        case switchCalls
        case join
    }

    static func join(callId: String?, channelId: String, current: TeamCallEntry?) -> Join {
        guard let current else { return .join }
        if let callId, current.callId == callId.lowercased() { return .show }
        if callId == nil, current.channelId == channelId.lowercased() { return .show }
        return .switchCalls
    }

    /// A call answered or started shows its screen; it shrinks to the bar only when the person says.
    static let opensExpanded = true
}
