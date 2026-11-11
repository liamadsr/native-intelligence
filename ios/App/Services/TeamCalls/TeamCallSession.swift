//
//  TeamCallSession.swift
//  Native Intelligence
//
//  One team call on the phone: the LiveKit room, and what the call screen
//  draws of it (TeamCallSessionState, TeamCallPeer: Core decides, this feeds
//  it what LiveKit says).
//
//    - Audio on, camera off, as a call starts. A microphone iOS refuses joins
//      listening only, and the screen says why; a camera refused says so too.
//    - The audio session is CallKit's: TeamCallCenter turns LiveKit's audio
//      engine on only inside CallKit's didActivate (LiveKit's own session
//      handling is off, as its CallKit guide requires), so nothing plays or
//      records before the system says so.
//    - Adaptive stream and dynacast (a tile off screen gets nothing),
//      simulcast for the camera, as on the web.
//    - LiveKit reconnects by itself (`reconnecting` while it does). A
//      connection lost for good is joined again once with a fresh token from
//      the token route; a call that ended there ends here.
//    - Held by the system (a phone call came in): the microphone goes off and
//      the others' audio stops until it is let go.
//

import AVFoundation
import Combine
import Foundation
import LiveKit

@MainActor
final class TeamCallSession: ObservableObject {
    let uuid: UUID
    private(set) var callId: String?
    let channelId: String
    let channelKind: TeamChatChannelKind
    let label: String

    @Published private(set) var state = TeamCallSessionState()
    @Published private(set) var peers: [TeamCallPeer] = []
    @Published private(set) var cameraPosition: AVCaptureDevice.Position = .front

    /// Ends the call for the person, however it ended (the center tells CallKit and the server).
    var onEnded: ((TeamCallSessionEnd) -> Void)?
    /// A fresh join for a full rejoin (the token route); nil when the call has ended.
    var refreshJoin: (() async -> TeamCallJoin?)?

    private let room: Room
    private let events = RoomEvents()
    private var micWanted = true
    private var rejoined = false
    private var leaving = false

    init(uuid: UUID, callId: String?, channelId: String, channelKind: TeamChatChannelKind, label: String) {
        self.uuid = uuid
        self.callId = callId
        self.channelId = channelId
        self.channelKind = channelKind
        self.label = label
        room = Room(
            roomOptions: RoomOptions(
                defaultCameraCaptureOptions: CameraCaptureOptions(position: .front, dimensions: .h720_169),
                defaultVideoPublishOptions: VideoPublishOptions(simulcast: true),
                adaptiveStream: true,
                dynacast: true
            )
        )
        events.onChange = { [weak self] change in
            Task { @MainActor in self?.heard(change) }
        }
        room.add(delegate: events)
    }

    /// The call's id, once a start learned it.
    func learned(callId: String) {
        self.callId = callId
    }

    /// The video a tile draws, if any (a camera, or a shared screen).
    func videoTrack(for tile: TeamCallTile) -> VideoTrack? {
        guard let p = participant(tile.identity) else { return nil }
        let source: Track.Source = tile.kind == .screen ? .screenShareVideo : .camera
        let pub = p.trackPublications.values.first { $0.source == source && !$0.isMuted }
        return pub?.track as? VideoTrack
    }

    // MARK: - Joining

    /// Join the room: the microphone on (listening only when iOS refuses it), the camera off.
    func connect(_ join: TeamCallJoin) async {
        learned(callId: join.callId)
        let permission = await Self.micPermission()
        let mic = TeamCallSessionState.joiningMic(permission)
        micWanted = mic == .on
        state.apply(.mic(mic))
        do {
            try await room.connect(url: join.url, token: join.token)
            state.apply(.connected(at: Date()))
            if micWanted { await setMicrophone(on: true) }
            refreshPeers()
        } catch {
            print("❌ TeamCall: connect failed: \(error.localizedDescription)")
            finish(.failed)
        }
    }

    /// Asked once, when iOS hasn't been: a "no" is the person's, and they listen only.
    static func micPermission() async -> TeamCallPermission {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return .granted
        case .denied: return .denied
        default:
            let granted = await AVAudioApplication.requestRecordPermission()
            return granted ? .granted : .denied
        }
    }

    // MARK: - Controls

    func setMicrophone(on: Bool) async {
        micWanted = on
        guard state.mic != .denied, state.mic != .missing else { return }
        do {
            try await room.localParticipant.setMicrophone(enabled: on && !state.held)
            state.apply(.mic(on ? .on : .off))
        } catch {
            state.apply(.mic(Self.deviceState(of: error)))
        }
        refreshPeers()
    }

    func toggleCamera() async {
        let on = state.camera != .on
        if on {
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .denied, .restricted:
                state.apply(.camera(.denied))
                return
            case .notDetermined:
                guard await AVCaptureDevice.requestAccess(for: .video) else {
                    state.apply(.camera(.denied))
                    return
                }
            default:
                break
            }
        }
        do {
            try await room.localParticipant.setCamera(enabled: on, captureOptions: CameraCaptureOptions(position: cameraPosition))
            state.apply(.camera(on ? .on : .off))
        } catch {
            state.apply(.camera(Self.deviceState(of: error)))
        }
        refreshPeers()
    }

    func flipCamera() async {
        guard let pub = room.localParticipant.trackPublications.values.first(where: { $0.source == .camera }),
              let track = pub.track as? LocalVideoTrack,
              let capturer = track.capturer as? CameraCapturer else { return }
        _ = try? await capturer.switchCameraPosition()
        cameraPosition = capturer.position
    }

    /// The system held the call (another call came in) or let it go.
    func setHeld(_ held: Bool) async {
        state.apply(.held(held))
        if state.mic == .on || (held == false && micWanted) {
            try? await room.localParticipant.setMicrophone(enabled: !held && micWanted)
        }
        for p in room.remoteParticipants.values {
            for pub in p.trackPublications.values where pub.kind == .audio {
                try? await (pub as? RemoteTrackPublication)?.set(enabled: !held)
            }
        }
    }

    /// The person hung up.
    func leave() async {
        leaving = true
        await room.disconnect()
        finish(.left)
    }

    // MARK: - LiveKit

    private func participant(_ identity: String) -> Participant? {
        if room.localParticipant.identity?.stringValue == identity { return room.localParticipant }
        return room.remoteParticipants.values.first { $0.identity?.stringValue == identity }
    }

    private func heard(_ change: RoomEvents.Change) {
        switch change {
        case .reconnecting:
            state.apply(.reconnecting)
        case .reconnected:
            state.apply(.reconnected)
        case let .disconnected(type):
            guard !leaving else { return }
            switch type {
            case .duplicateIdentity?: finish(.elsewhere)
            case .participantRemoved?: finish(.removed)
            case .roomDeleted?: finish(.ended)
            case nil, .cancelled?: finish(.ended)
            default: Task { await rejoin() }
            }
        case .people:
            refreshPeers()
        }
    }

    /// Lost for good: joined again once with a fresh token; a call that ended there ends here.
    private func rejoin() async {
        guard !rejoined, !state.connection.isEnded, let refreshJoin else {
            finish(.failed)
            return
        }
        rejoined = true
        state.apply(.reconnecting)
        guard let join = await refreshJoin() else {
            finish(.ended)
            return
        }
        do {
            try await room.connect(url: join.url, token: join.token)
            state.apply(.reconnected)
            if micWanted && !state.held { await setMicrophone(on: true) }
            refreshPeers()
        } catch {
            finish(.failed)
        }
    }

    private func refreshPeers() {
        var out: [TeamCallPeer] = []
        let me = room.localParticipant
        if let id = me.identity?.stringValue {
            out.append(Self.peer(me, identity: id, isLocal: true))
        }
        for p in room.remoteParticipants.values {
            guard let id = p.identity?.stringValue else { continue }
            out.append(Self.peer(p, identity: id, isLocal: false))
        }
        peers = out
    }

    private static func peer(_ p: Participant, identity: String, isLocal: Bool) -> TeamCallPeer {
        let pubs = Array(p.trackPublications.values)
        let name = (p.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return TeamCallPeer(
            identity: identity,
            name: name.isEmpty ? "A teammate" : name,
            isLocal: isLocal,
            isSpeaking: p.isSpeaking,
            micOn: pubs.contains { $0.source == .microphone && !$0.isMuted },
            cameraOn: pubs.contains { $0.source == .camera && !$0.isMuted && $0.track != nil },
            sharingScreen: pubs.contains { $0.source == .screenShareVideo && !$0.isMuted && $0.track != nil },
            joinedAt: p.joinedAt ?? .distantPast
        )
    }

    // MARK: - Fixture

    #if DEBUG
    /// The DEBUG preview's: a room that never connects, its people and state made up.
    private(set) var isFixture = false

    func loadFixture(peers: [TeamCallPeer], events: [TeamCallSessionState.Event]) {
        isFixture = true
        for e in events { state.apply(e) }
        self.peers = peers
    }
    #endif

    private func finish(_ why: TeamCallSessionEnd) {
        guard !state.connection.isEnded else { return }
        state.apply(.ended(why))
        room.remove(delegate: events)
        if why != .left { Task { await room.disconnect() } }
        onEnded?(why)
    }

    private static func deviceState(of error: Error) -> TeamCallDevice {
        guard let lk = error as? LiveKitError else { return .off }
        switch lk.type {
        case .deviceAccessDenied: return .denied
        case .deviceNotFound: return .missing
        default: return .off
        }
    }
}

/// LiveKit's room events, off the main thread, as a few changes the session cares about.
private final class RoomEvents: NSObject, RoomDelegate, @unchecked Sendable {
    enum Change {
        case reconnecting
        case reconnected
        case disconnected(LiveKitErrorType?)
        /// Who is in it, what they publish, who speaks.
        case people
    }

    var onChange: ((Change) -> Void)?

    func room(_ room: Room, didStartReconnectWithMode reconnectMode: ReconnectMode) { onChange?(.reconnecting) }
    func room(_ room: Room, didCompleteReconnectWithMode reconnectMode: ReconnectMode) { onChange?(.reconnected) }
    func room(_ room: Room, didDisconnectWithError error: LiveKitError?) { onChange?(.disconnected(error?.type)) }
    func room(_ room: Room, participantDidConnect participant: RemoteParticipant) { onChange?(.people) }
    func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) { onChange?(.people) }
    func room(_ room: Room, didUpdateSpeakingParticipants participants: [Participant]) { onChange?(.people) }
    func room(_ room: Room, participant: Participant, didUpdateName name: String) { onChange?(.people) }
    func room(_ room: Room, participant: Participant, trackPublication: TrackPublication, didUpdateIsMuted isMuted: Bool) { onChange?(.people) }
    func room(_ room: Room, participant: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) { onChange?(.people) }
    func room(_ room: Room, participant: RemoteParticipant, didUnsubscribeTrack publication: RemoteTrackPublication) { onChange?(.people) }
    func room(_ room: Room, participant: RemoteParticipant, didUnpublishTrack publication: RemoteTrackPublication) { onChange?(.people) }
    func room(_ room: Room, participant: LocalParticipant, didPublishTrack publication: LocalTrackPublication) { onChange?(.people) }
    func room(_ room: Room, participant: LocalParticipant, didUnpublishTrack publication: LocalTrackPublication) { onChange?(.people) }
}
