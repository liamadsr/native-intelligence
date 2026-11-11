//
//  iOSTeamCallPreview.swift
//  Native Intelligence
//
//  DEBUG only: team calls' screens over made-up people, with no sign-in, no
//  network and no LiveKit room, so they can be looked at and screenshotted
//  in the Simulator (where CallKit and PushKit don't deliver):
//
//    xcrun simctl launch <device> com.dial8-iOS-26 -previewTeamCall YES \
//      -previewTeamCallScreen incoming|pair|call|screen|listening|minimized|ended
//

#if DEBUG
import SwiftUI

struct iOSTeamCallPreview: View {
    private let screen = UserDefaults.standard.string(forKey: "previewTeamCallScreen") ?? "call"
    @ObservedObject private var center = TeamCallCenter.shared
    @StateObject private var conversation: TeamChatConversationModel

    init() {
        TeamChatFixture.fillStore()
        let screen = UserDefaults.standard.string(forKey: "previewTeamCallScreen") ?? "call"
        _conversation = StateObject(wrappedValue: TeamCallFixture.conversation(screen == "minimized" ? .inIt : screen == "ended" ? .ended : .live))
        TeamCallFixture.load(screen)
    }

    var body: some View {
        switch screen {
        case "incoming":
            if let ring = center.inAppRing { iOSIncomingCallView(center: center, ring: ring) }
        case "minimized", "ended":
            NavigationStack {
                iOSTeamChatConversationView(model: conversation)
            }
            .teamCallChrome(center)
        default:
            if let session = center.session { iOSTeamCallScreen(center: center, session: session) }
        }
    }
}

@MainActor
enum TeamCallFixture {
    static let liveCall = "b0000000-0000-4000-8000-000000000001"
    static let endedCall = "b0000000-0000-4000-8000-000000000002"
    static let t0 = Date().addingTimeInterval(-(12 * 60 + 41))

    static func peer(_ id: String, _ name: String, local: Bool = false, speaking: Bool = false, mic: Bool = true, camera: Bool = false, screen: Bool = false, at: Double) -> TeamCallPeer {
        TeamCallPeer(identity: id, name: name, isLocal: local, isSpeaking: speaking, micOn: mic, cameraOn: camera, sharingScreen: screen, joinedAt: t0.addingTimeInterval(at))
    }

    static func load(_ screen: String) {
        let me = peer(TeamChatFixture.me, "Theo Park", local: true, mic: screen != "listening", camera: screen != "listening", at: 0)
        let ana = peer(TeamChatFixture.ana, "Ana Ruiz", speaking: true, camera: true, at: 5)
        let ben = peer(TeamChatFixture.ben, "Ben Okafor", mic: false, screen: screen == "screen", at: 20)
        let mara = peer(TeamChatFixture.mara, "Mara Chen", camera: true, at: 40)
        switch screen {
        case "incoming":
            let ring = TeamCallIncoming(ringId: "a0000000-0000-4000-8000-000000000001", callId: liveCall, channelId: TeamChatFixture.launch,
                                        workspaceId: "w", callerName: "Ana Ruiz", channelKind: .channel, channelName: "launch", video: false, secondsLeft: 40)
            TeamCallCenter.shared.loadFixture(session: nil, expanded: false, ring: ring)
        case "pair":
            TeamCallCenter.shared.loadFixture(session: session("Ana Ruiz", kind: .dm, peers: [me, ana]), expanded: true)
        case "screen":
            TeamCallCenter.shared.loadFixture(session: session("#launch", kind: .channel, peers: [me, ana, ben, mara]), expanded: true)
        case "listening":
            TeamCallCenter.shared.loadFixture(session: session("#launch", kind: .channel, peers: [me, ana, ben], mic: .denied, reconnecting: true), expanded: true)
        case "minimized":
            TeamCallCenter.shared.loadFixture(session: session("#launch", kind: .channel, peers: [me, ana, ben, mara]), expanded: false)
        case "ended":
            TeamCallCenter.shared.loadFixture(session: nil, expanded: false)
        default:
            TeamCallCenter.shared.loadFixture(session: session("#launch", kind: .channel, peers: [me, ana, ben, mara]), expanded: true)
        }
    }

    static func session(_ label: String, kind: TeamChatChannelKind, peers: [TeamCallPeer], mic: TeamCallDevice = .on, reconnecting: Bool = false) -> TeamCallSession {
        let s = TeamCallSession(uuid: UUID(), callId: liveCall, channelId: TeamChatFixture.launch, channelKind: kind, label: label)
        var events: [TeamCallSessionState.Event] = [.connected(at: t0), .mic(mic), .camera(peers.first { $0.isLocal }?.cameraOn == true ? .on : .off)]
        if reconnecting { events.append(.reconnecting) }
        s.loadFixture(peers: peers, events: events)
        return s
    }

    enum LatestCall { case live, inIt, ended }

    /// #launch with a call's message: live (Join; "Open" while the person is in it) or ended, and, earlier, one that ended.
    static func conversation(_ latest: LatestCall) -> TeamChatConversationModel {
        let model = TeamChatConversationModel(channelId: TeamChatFixture.launch, store: .shared)
        let launch = TeamChatFixture.launch
        func msg(_ n: Int, by: String, _ body: String, at: Double, call: String? = nil) -> TeamChatMessage {
            TeamChatMessage(id: String(format: "e0000000-0000-4000-8000-%012d", n), channelId: launch, authorMemberId: by, body: body,
                            createdAt: TeamChatFixture.ago(at), kind: call == nil ? "message" : "call", callId: call)
        }
        let messages = [
            msg(1, by: TeamChatFixture.mara, "Can we go over the cover options before lunch?", at: 95),
            msg(2, by: TeamChatFixture.ana, "Call ended · 12 min · 3 people", at: 90, call: endedCall),
            msg(3, by: TeamChatFixture.ben, "Thanks all. I'll send the printer the second option.", at: 76),
            msg(4, by: TeamChatFixture.ana, "Quick one on the proofs?", at: 14),
            msg(5, by: TeamChatFixture.ana, latest == .ended ? "Call ended · 9 min · 3 people" : "Started a call", at: 13, call: liveCall),
        ]
        func joined(_ id: String, _ m: String, at: Double) -> TeamCallParticipant {
            TeamCallParticipant(callId: id, memberId: m, state: "joined", joinedAt: TeamChatFixture.ago(at), leftAt: nil)
        }
        var people = [joined(liveCall, TeamChatFixture.ana, at: 13), joined(liveCall, TeamChatFixture.ben, at: 12)]
        if latest == .inIt { people.append(joined(liveCall, TeamChatFixture.me, at: 12.5)) }
        let page = TeamChatMessagesResponse(
            messages: messages, threads: [], reactions: [TeamChatReaction(messageId: messages[1].id, memberId: TeamChatFixture.mara, emoji: "🙏", active: true)], root: nil,
            calls: [
                TeamCallView(call: TeamCall(id: endedCall, channelId: launch, messageId: messages[1].id, startedBy: TeamChatFixture.ana, status: .ended,
                                            startedAt: TeamChatFixture.ago(90), endedAt: TeamChatFixture.ago(78), durationSeconds: 754, participantCount: 0, peakParticipants: 3),
                             participants: []),
                latest == .ended
                    ? TeamCallView(call: TeamCall(id: liveCall, channelId: launch, messageId: messages[4].id, startedBy: TeamChatFixture.ana, status: .ended,
                                                  startedAt: TeamChatFixture.ago(13), endedAt: TeamChatFixture.ago(4), durationSeconds: 548, participantCount: 0, peakParticipants: 3),
                                   participants: [])
                    : TeamCallView(call: TeamCall(id: liveCall, channelId: launch, messageId: messages[4].id, startedBy: TeamChatFixture.ana, status: .live,
                                                  startedAt: TeamChatFixture.ago(13), participantCount: people.count, peakParticipants: people.count),
                                   participants: people),
            ]
        )
        model.loadFixture(page)
        return model
    }
}
#endif
