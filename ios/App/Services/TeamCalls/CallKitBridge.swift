//
//  CallKitBridge.swift
//  Native Intelligence
//
//  The system's call screen (CallKit), kept thin: it shows what TeamCallCenter
//  tells it (an incoming call, an outgoing one, a call ended and why) and
//  hands the person's actions back (answer, decline or end, mute, hold) with
//  the audio session's activation. What each means is TeamCallBook's (Core).
//
//  Calls stay out of the system's Recents (includesCallsInRecents false): a
//  call there would open the app through a Start Call intent, which this app
//  doesn't take. One call at a time (one group of one): a second ring while
//  in a call is declined as busy before it reaches here.
//

import AVFoundation
import CallKit
import UIKit

@MainActor
protocol CallKitBridgeDelegate: AnyObject {
    func callKitAnswer(_ uuid: UUID, action: CXAnswerCallAction)
    func callKitEnd(_ uuid: UUID, action: CXEndCallAction)
    func callKitStart(_ uuid: UUID, action: CXStartCallAction)
    func callKitMute(_ uuid: UUID, muted: Bool)
    func callKitHold(_ uuid: UUID, held: Bool)
    func callKitAudio(active: Bool, session: AVAudioSession)
    func callKitReset()
}

final class CallKitBridge: NSObject, CXProviderDelegate {
    private let provider: CXProvider
    private let controller = CXCallController()
    @MainActor weak var delegate: CallKitBridgeDelegate?

    override init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = true
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        config.includesCallsInRecents = false
        config.iconTemplateImageData = UIImage(systemName: "person.2.fill")?.withRenderingMode(.alwaysTemplate).pngData()
        provider = CXProvider(configuration: config)
        super.init()
        // The main queue: PushKit's handler reports on it too, and the center is the main actor's.
        provider.setDelegate(self, queue: .main)
    }

    static func callUpdate(_ u: TeamCallKitUpdate) -> CXCallUpdate {
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: u.handle)
        update.localizedCallerName = u.callerName
        update.hasVideo = u.hasVideo
        update.supportsHolding = true
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        return update
    }

    static func reason(_ r: TeamCallEndReason) -> CXCallEndedReason {
        switch r {
        case .failed: return .failed
        case .remoteEnded: return .remoteEnded
        case .unanswered: return .unanswered
        case .answeredElsewhere: return .answeredElsewhere
        case .declinedElsewhere: return .declinedElsewhere
        }
    }

    // MARK: - Telling the system

    /// An incoming call. `done` gets the system's refusal, if any (Do Not Disturb, a duplicate id).
    func reportIncoming(_ uuid: UUID, _ u: TeamCallKitUpdate, done: @escaping (Error?) -> Void) {
        provider.reportNewIncomingCall(with: uuid, update: Self.callUpdate(u), completion: done)
    }

    func reportEnded(_ uuid: UUID, _ r: TeamCallEndReason) {
        provider.reportCall(with: uuid, endedAt: Date(), reason: Self.reason(r))
    }

    func reportConnecting(_ uuid: UUID) {
        provider.reportOutgoingCall(with: uuid, startedConnectingAt: Date())
    }

    func reportConnected(_ uuid: UUID) {
        provider.reportOutgoingCall(with: uuid, connectedAt: Date())
    }

    // MARK: - Asking the system (the app's own buttons go through it, so its screen agrees)

    func requestStart(_ uuid: UUID, _ u: TeamCallKitUpdate) async throws {
        let start = CXStartCallAction(call: uuid, handle: CXHandle(type: .generic, value: u.handle))
        start.contactIdentifier = u.callerName
        start.isVideo = u.hasVideo
        try await controller.request(CXTransaction(action: start))
        provider.reportCall(with: uuid, updated: Self.callUpdate(u))
    }

    func requestEnd(_ uuid: UUID) async throws {
        try await controller.request(CXTransaction(action: CXEndCallAction(call: uuid)))
    }

    func requestMute(_ uuid: UUID, muted: Bool) async throws {
        try await controller.request(CXTransaction(action: CXSetMutedCallAction(call: uuid, muted: muted)))
    }

    /// Whether the system shows this call.
    func knows(_ uuid: UUID) -> Bool {
        controller.callObserver.calls.contains { $0.uuid == uuid && !$0.hasEnded }
    }

    // MARK: - CXProviderDelegate (the main queue)

    func providerDidReset(_ provider: CXProvider) {
        MainActor.assumeIsolated { delegate?.callKitReset() }
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        MainActor.assumeIsolated { delegate?.callKitAnswer(action.callUUID, action: action) }
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        MainActor.assumeIsolated { delegate?.callKitEnd(action.callUUID, action: action) }
    }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        MainActor.assumeIsolated { delegate?.callKitStart(action.callUUID, action: action) }
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        MainActor.assumeIsolated { delegate?.callKitMute(action.callUUID, muted: action.isMuted) }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
        MainActor.assumeIsolated { delegate?.callKitHold(action.callUUID, held: action.isOnHold) }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        MainActor.assumeIsolated { delegate?.callKitAudio(active: true, session: audioSession) }
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        MainActor.assumeIsolated { delegate?.callKitAudio(active: false, session: audioSession) }
    }
}
