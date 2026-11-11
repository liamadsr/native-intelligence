//
//  TeamCallCenter.swift
//  Native Intelligence
//
//  Team calls on the phone, one place: the person's rings (the VoIP push,
//  Realtime while the app is open, a fetch coming back), the system's call
//  screen (CallKit), and the call they are in (TeamCallSession), shown full
//  screen or as a bar while they move around the app.
//
//  TeamCallBook (Core) decides what each thing that happens means; this
//  carries out its effects: reports to CallKit, the web's own ring functions
//  through the team call routes (answer, decline, hang up), the LiveKit room.
//
//    - Truth is the database's: a ring the push rang is checked against its
//      row at once (and live over Realtime), and stops when the row says it
//      was settled; the phone never trusts the push alone.
//    - Answering asks the server first (team_call_answer), and only then
//      joins; a ring settled meanwhile ends with the right reason.
//    - The audio session is CallKit's: LiveKit's engine runs only between
//      didActivate and didDeactivate. Where CallKit can't show a call (the
//      Simulator), the call runs in the app alone, with the audio session
//      set by hand, and an incoming ring shows in the app while it is open.
//    - Calling off on the server (GET /api/account/team-calls says so): no
//      call button, no ring listened for.
//

import AVFoundation
import CallKit
import Combine
import Foundation
import LiveKit
import Supabase
import UIKit

@MainActor
final class TeamCallCenter: ObservableObject {
    static let shared = TeamCallCenter()

    /// Calling is on here (the LiveKit settings set on the server).
    @Published private(set) var available = false
    /// The call the person is in (connecting, in it, or reconnecting).
    @Published private(set) var session: TeamCallSession?
    /// Its screen is up (false: the bar).
    @Published var expanded = false
    /// A ring the system's screen couldn't show (the Simulator), shown in the app while it is open.
    @Published private(set) var inAppRing: TeamCallIncoming?
    /// A short line after a call ended without the person ending it ("The call ended.").
    @Published var endedLine: String?
    /// A call to join that takes notes or is recorded: the person is told first, and joins on "Join".
    @Published var confirming: TeamCallConfirm?

    private(set) var book = TeamCallBook()
    private let api = TeamCallAPI.shared
    private let callKit = CallKitBridge()
    /// Calls the system doesn't show (CallKit refused them): their audio session is the app's.
    private var appOnly: Set<UUID> = []
    /// Answers waiting on the server, and outgoing starts waiting on their join.
    private var answerActions: [UUID: CXAnswerCallAction] = [:]
    private var joins: [UUID: TeamCallJoin] = [:]
    private var tick: Task<Void, Never>?
    private var rings: RealtimeChannelV2?
    private var ringSubscription: RealtimeSubscription?
    private var audioPrepared = false
    private var cancellables = Set<AnyCancellable>()

    private var client: SupabaseClient { SupabaseManager.shared.client }
    #if DEBUG
    private(set) var isFixture = false
    #endif

    private init() {
        callKit.delegate = self
    }

    /// At launch (the app delegate): ready for a push before anything else.
    func start() {
        NotificationCenter.default.publisher(for: .authenticationComplete)
            .merge(with: NotificationCenter.default.publisher(for: .userSignedIn))
            .merge(with: NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification))
            .sink { [weak self] _ in Task { await self?.comeBack() } }
            .store(in: &cancellables)
        NotificationCenter.default.publisher(for: .userSignedOut)
            .sink { [weak self] _ in Task { await self?.signedOut() } }
            .store(in: &cancellables)
        Task { await comeBack() }
    }

    // MARK: - Rings

    /// A VoIP push. The call it owes is reported before `completion` (and this) returns to PushKit.
    func voipPush(_ payload: [AnyHashable: Any], mustReport: Bool, completion: @escaping () -> Void) {
        prepareAudio()
        let effects: [TeamCallEffect]
        // Nobody signed in here (a sign-out's removal still owed, or the session known gone): no names
        // of anyone's calls on this phone, only the report Apple requires, ended at once.
        let signedOut = VoIPPushService.shared.forgetPending
            || (SupabaseManager.shared.hasCheckedInitialSession && !SupabaseManager.shared.isAuthenticated)
        switch signedOut ? nil : TeamCallPush.parse(payload) {
        case _ where signedOut:
            effects = book.signedOutPushed(mustReport: mustReport, newID: UUID())
        case let .ring(r)?:
            effects = book.ringPushed(r, now: Date(), mustReport: mustReport, newID: UUID())
            print("📞 Team call: ring pushed ring=\(r.ringId) report=\(mustReport)")
        case let .cancel(ringId, _, state)?:
            effects = book.cancelPushed(ringId: ringId, state: state, mustReport: mustReport, newID: UUID())
            print("📞 Team call: cancel pushed ring=\(ringId) state=\(state.rawValue)")
        case nil:
            effects = book.unknownPushed(mustReport: mustReport, newID: UUID())
        }
        run(effects, completion: completion)
    }

    /// Coming back (launch, sign-in, the foreground): is calling on, and the person's rings now.
    func comeBack() async {
        #if DEBUG
        if isFixture { return }
        #endif
        guard SupabaseManager.shared.isAuthenticated else { return }
        do {
            let out = try await api.availability()
            available = out.available
            guard available else { return }
            for ring in out.rings { heard(ring) }
            // Rings ringing here that the server no longer lists: their rows say how they ended.
            for e in book.entries where e.phase == .ringing {
                if let id = e.ringId, !out.rings.contains(where: { $0.id.lowercased() == id }) { Task { await checkRing(id) } }
            }
            await joinRings()
        } catch {
            print("⚠️ Team call: availability not read: \(error.localizedDescription)")
        }
    }

    /// A ring row, from Realtime or a read.
    private func heard(_ ring: TeamCallRing) {
        if ring.state == .ringing, let r = TeamCallIncoming(ring: ring, now: Date()) {
            prepareAudio()
            run(book.ringHeard(r, now: Date(), newID: UUID()))
        } else {
            run(book.ringRow(id: ring.id, state: ring.state, now: Date()))
        }
    }

    private func checkRing(_ ringId: String) async {
        do {
            let row: TeamCallRing = try await client.from("team_call_ring").select(TeamCallRing.columns).eq("id", value: ringId).single().execute().value
            heard(row)
        } catch {
            print("⚠️ Team call: ring \(ringId) not read: \(error.localizedDescription)")
        }
    }

    /// The person's own rings, live (RLS: theirs only); a channel that dropped is joined again.
    /// Not signed in yet (a push launched the app): later, when the session is restored.
    private func joinRings() async {
        guard let uid = SupabaseManager.shared.currentUser?.id.uuidString.lowercased() else { return }
        if let existing = rings {
            guard existing.status != .subscribed else { return }
            ringSubscription?.cancel()
            ringSubscription = nil
            rings = nil
            await client.removeChannel(existing)
        }
        let channel = client.channel("team-call-rings:\(uid):\(UUID().uuidString.prefix(8).lowercased())")
        let decoder = JSONDecoder()
        ringSubscription = channel.onPostgresChange(AnyAction.self, schema: "public", table: "team_call_ring", filter: "user_id=eq.\(uid)") { [weak self] action in
            let record: JSONObject? = {
                switch action {
                case let .insert(a): return a.record
                case let .update(a): return a.record
                case .delete: return nil
                }
            }()
            guard let record, let row = try? record.decode(as: TeamCallRing.self, decoder: decoder) else { return }
            Task { @MainActor in self?.heard(row) }
        }
        rings = channel
        do {
            try await channel.subscribeWithError()
        } catch {
            print("⚠️ Team call: rings channel not joined: \(error.localizedDescription)")
        }
    }

    private func signedOut() async {
        await session?.leave()
        run(book.clear())
        session = nil
        inAppRing = nil
        available = false
        ringSubscription?.cancel()
        ringSubscription = nil
        if let rings { await client.removeChannel(rings) }
        rings = nil
    }

    // MARK: - The person's buttons

    /// Start a call in a conversation, or join the one live there (`callId`, a call message's Join).
    /// A call that takes notes or is recorded is said so first; the person joins on "Join".
    func call(channelId: String, callId: String? = nil, kind: TeamChatChannelKind, label: String, noticeSeen: Bool = false) async {
        switch TeamCallRouting.join(callId: callId, channelId: channelId, current: book.current) {
        case .show:
            expanded = true
            return
        case .switchCalls, .join:
            break
        }
        if let callId, !noticeSeen, let line = await api.callRow(callId)?.notice {
            confirming = TeamCallConfirm(channelId: channelId, callId: callId, kind: kind, label: label, line: line)
            return
        }
        if book.current != nil { await hangUp() }
        if let ringing = book.ringing { await end(ringing.uuid) }
        prepareAudio()
        let uuid = UUID()
        pendingKinds[uuid] = (kind, label)
        if noticeSeen { noticesSeen.insert(uuid) }
        run(book.start(channelId: channelId, callId: callId, label: label, newID: uuid))
    }

    /// The notice's "Join".
    func confirmJoin() async {
        guard let c = confirming else { return }
        confirming = nil
        await call(channelId: c.channelId, callId: c.callId, kind: c.kind, label: c.label, noticeSeen: true)
    }

    /// The notice's "Unmute" in a call joined listening (answered on a locked phone): a join that
    /// says they saw it, then the microphone.
    func continueAfterNotice() async {
        guard let s = session, let callId = s.callId else { return }
        do {
            let joined = try await api.join(callId: callId, noticeSeen: true)
            noticesSeen.insert(s.uuid)
            await s.continueAfterNotice(joined.join)
        } catch {
            endedLine = (error as? TeamCallAPIError)?.errorDescription ?? "Couldn’t unmute. Try again."
        }
    }

    private var pendingKinds: [UUID: (TeamChatChannelKind, String)] = [:]
    /// Calls joined with a join that says the person saw the notes or recording notice.
    private var noticesSeen: Set<UUID> = []

    /// Leave the call (the system's screen agrees: its end action does the leaving).
    func hangUp() async {
        guard let current = book.current else { return }
        await end(current.uuid)
    }

    func setMuted(_ muted: Bool) async {
        guard let s = session else { return }
        if !appOnly.contains(s.uuid), (try? await callKit.requestMute(s.uuid, muted: muted)) != nil { return }
        await s.setMicrophone(on: !muted)
    }

    /// The in-app ring's buttons (where the system's screen couldn't show it).
    func answerInApp() {
        guard let r = inAppRing, let e = book.entry(ringId: r.ringId), let fx = book.answer(e.uuid) else { return }
        inAppRing = nil
        run(fx)
    }

    func declineInApp() {
        guard let r = inAppRing, let e = book.entry(ringId: r.ringId) else { return }
        inAppRing = nil
        run(book.end(e.uuid))
    }

    /// Ring people into the call (a channel's call rings nobody by itself).
    func ring(memberIds: [String]) async -> Int? {
        guard let callId = session?.callId else { return nil }
        return try? await api.ring(callId: callId, memberIds: memberIds)
    }

    private func end(_ uuid: UUID) async {
        if !appOnly.contains(uuid), callKit.knows(uuid), (try? await callKit.requestEnd(uuid)) != nil { return }
        run(book.end(uuid))
    }

    // MARK: - Effects

    private func run(_ effects: [TeamCallEffect], completion: (() -> Void)? = nil) {
        let group = DispatchGroup()
        for fx in effects {
            switch fx {
            case let .report(uuid, update):
                group.enter()
                callKit.reportIncoming(uuid, update) { [weak self] error in
                    Task { @MainActor in
                        self?.reported(uuid, error: error)
                        group.leave()
                    }
                }
            case let .reportAndEnd(uuid, update, reason):
                group.enter()
                callKit.reportIncoming(uuid, update) { [weak self] _ in
                    Task { @MainActor in
                        self?.callKit.reportEnded(uuid, reason)
                        group.leave()
                    }
                }
            case let .reportOnExisting(uuid, update) where appOnly.contains(uuid):
                // The system never saw this call (it refused it): a report onto its id would start a
                // call nothing ends. A fresh one instead, ended at once.
                reportFreshAndEnd(update, reason: .failed, group: group)
            case let .reportOnExisting(uuid, update):
                group.enter()
                callKit.reportIncoming(uuid, update) { _ in group.leave() }
            case let .reportOnExistingThenEnd(uuid, update, reason) where appOnly.contains(uuid):
                ended(uuid, reason: reason)
                reportFreshAndEnd(update, reason: reason, group: group)
            case let .reportOnExistingThenEnd(uuid, update, reason):
                group.enter()
                callKit.reportIncoming(uuid, update) { [weak self] _ in
                    Task { @MainActor in
                        self?.ended(uuid, reason: reason)
                        group.leave()
                    }
                }
            case let .ended(uuid, reason):
                ended(uuid, reason: reason)
            case let .acceptOnServer(ringId):
                Task { await accept(ringId) }
            case let .declineOnServer(ringId):
                Task { _ = try? await api.answer(ringId: ringId, accept: false, voipToken: VoIPPushService.shared.token) }
            case let .checkRing(ringId):
                Task {
                    await joinRings()
                    await checkRing(ringId)
                }
            case let .join(uuid):
                Task { await join(uuid) }
            case let .leave(uuid, callId):
                Task { await leave(uuid, callId: callId) }
            case let .startOnSystem(uuid, update):
                Task { await startOnSystem(uuid, update) }
            }
        }
        scheduleTick()
        if let completion {
            group.notify(queue: .main, execute: completion)
        }
    }

    private func reportFreshAndEnd(_ update: TeamCallKitUpdate, reason: TeamCallEndReason, group: DispatchGroup) {
        let fresh = UUID()
        group.enter()
        callKit.reportIncoming(fresh, update) { [weak self] _ in
            Task { @MainActor in
                self?.callKit.reportEnded(fresh, reason)
                group.leave()
            }
        }
    }

    private func reported(_ uuid: UUID, error: Error?) {
        guard let error else { return }
        let code = (error as NSError).code
        let filtered = (error as NSError).domain == CXErrorDomainIncomingCall
            && (code == CXErrorCodeIncomingCallError.filteredByDoNotDisturb.rawValue || code == CXErrorCodeIncomingCallError.filteredByBlockList.rawValue)
        guard let e = book.entry(uuid), e.phase == .ringing else { return }
        if filtered {
            // Focus or Do Not Disturb: silent here, and not rung here again; the ring stays the other devices'.
            book.refused(uuid)
            return
        }
        // The system can't show calls here (the Simulator): the app shows the ring while it is open.
        print("⚠️ Team call: CallKit refused the ring (\(error.localizedDescription)); shown in the app")
        appOnly.insert(uuid)
        if let ringId = e.ringId { inAppRing = incoming(for: e, ringId: ringId) }
    }

    private func incoming(for e: TeamCallEntry, ringId: String) -> TeamCallIncoming {
        TeamCallIncoming(ringId: ringId, callId: e.callId ?? "", channelId: e.channelId, workspaceId: "", callerName: e.update.callerName,
                         channelKind: .dm, channelName: nil, video: e.update.hasVideo,
                         secondsLeft: max(0, Int(e.deadline?.timeIntervalSinceNow ?? 0)))
    }

    /// A call the system shows has ended: it is told, and the room left if the person was in it.
    private func ended(_ uuid: UUID, reason: TeamCallEndReason) {
        if let action = answerActions.removeValue(forKey: uuid) { action.fail() }
        if !appOnly.contains(uuid) { callKit.reportEnded(uuid, reason) }
        appOnly.remove(uuid)
        joins[uuid] = nil
        if inAppRing != nil, book.ringing == nil { inAppRing = nil }
        if let s = session, s.uuid == uuid {
            Task { await s.leave() }
            session = nil
            deactivateAppAudio(uuid)
        }
    }

    private func scheduleTick() {
        tick?.cancel()
        guard let next = book.nextDeadline else { return }
        tick = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(0, next.timeIntervalSinceNow) * 1_000_000_000) + 50_000_000)
            guard !Task.isCancelled, let self else { return }
            self.run(self.book.tick(now: Date()))
        }
    }

    // MARK: - Answering, starting, joining

    private func accept(_ ringId: String) async {
        do {
            let answer: TeamCallAnswer
            do {
                answer = try await api.answer(ringId: ringId, accept: true, voipToken: VoIPPushService.shared.token)
            } catch TeamCallAPIError.unreachable {
                // Once more: a ring this person accepted already answers with its join.
                guard book.entry(ringId: ringId) != nil else { return }
                answer = try await api.answer(ringId: ringId, accept: true, voipToken: VoIPPushService.shared.token)
            }
            if answer.elsewhere == true {
                // Accepted (or settled) on another device before this answer: ends here as that.
                run(book.answered(ringId: ringId, .settled(answer.state)))
            } else if answer.state == .accepted, let join = answer.join, let place = answer.call {
                guard let e = book.entry(ringId: ringId) else { return }
                joins[e.uuid] = join
                pendingKinds[e.uuid] = (place.channelKind, e.update.callerName)
                run(book.answered(ringId: ringId, .joined))
            } else {
                run(book.answered(ringId: ringId, .settled(answer.state)))
            }
        } catch TeamCallAPIError.ended {
            run(book.answered(ringId: ringId, .callEnded))
        } catch {
            print("❌ Team call: answer failed: \(error.localizedDescription)")
            run(book.answered(ringId: ringId, .failed))
        }
    }

    private func startOnSystem(_ uuid: UUID, _ update: TeamCallKitUpdate) async {
        do {
            try await callKit.requestStart(uuid, update)
        } catch {
            // The system can't show calls here (the Simulator): the call runs in the app alone.
            print("⚠️ Team call: CallKit refused the start (\(error.localizedDescription)); in the app alone")
            appOnly.insert(uuid)
            await performStart(uuid, action: nil)
        }
    }

    /// The system's start (or the app's own): the server starts or joins the call, then the room.
    private func performStart(_ uuid: UUID, action: CXStartCallAction?) async {
        guard let e = book.entry(uuid) else {
            action?.fail()
            return
        }
        do {
            let joined: TeamCallJoined
            if let callId = e.callId {
                joined = try await api.join(callId: callId, noticeSeen: noticesSeen.contains(uuid))
            } else {
                joined = try await api.start(channelId: e.channelId)
            }
            guard book.entry(uuid) != nil else {
                // Hung up while the server was starting it: out of the call there too.
                action?.fail()
                pendingKinds[uuid] = nil
                await api.leave(callId: joined.call.id)
                return
            }
            book.learned(uuid, callId: joined.call.id)
            joins[uuid] = joined.join
            action?.fulfill()
            if !appOnly.contains(uuid) { callKit.reportConnecting(uuid) }
            await join(uuid)
        } catch {
            action?.fail()
            endedLine = (error as? TeamCallAPIError)?.errorDescription ?? "The call couldn’t start. Try again."
            run(book.callEnded(uuid, reason: .failed))
            pendingKinds[uuid] = nil
        }
    }

    /// Into the call's room (its join in hand).
    private func join(_ uuid: UUID) async {
        guard let e = book.entry(uuid), let joinInfo = joins.removeValue(forKey: uuid) else { return }
        let (kind, label) = pendingKinds.removeValue(forKey: uuid) ?? (.channel, e.update.callerName)
        let s = TeamCallSession(uuid: uuid, callId: joinInfo.callId, channelId: e.channelId, channelKind: kind, label: label)
        s.refreshJoin = { [weak self] in
            guard let self, let callId = s.callId else { return nil }
            return try? await self.api.join(callId: callId).join
        }
        s.onEnded = { [weak self] why in self?.sessionEnded(uuid, why: why) }
        session = s
        expanded = TeamCallRouting.opensExpanded
        if let action = answerActions.removeValue(forKey: uuid) { action.fulfill() }
        if appOnly.contains(uuid) { activateAppAudio() }
        await s.connect(joinInfo)
        if case .connected = s.state.connection {
            book.connected(uuid)
            if !appOnly.contains(uuid), e.ringId == nil { callKit.reportConnected(uuid) }
            // Joined without saying they saw a notes or recording notice (answered on a locked phone,
            // a call started where notes were on): listening, told why, until they unmute.
            if !noticesSeen.contains(uuid), let callId = s.callId, let line = await api.callRow(callId)?.notice {
                await s.holdForNotice(line)
            }
        }
    }

    private func sessionEnded(_ uuid: UUID, why: TeamCallSessionEnd) {
        guard session?.uuid == uuid else { return }
        endedLine = why.line
        if why == .left { return }
        session = nil
        noticesSeen.remove(uuid)
        deactivateAppAudio(uuid)
        run(book.callEnded(uuid, reason: why.systemReason))
    }

    private func leave(_ uuid: UUID, callId: String?) async {
        if let s = session, s.uuid == uuid {
            session = nil
            await s.leave()
        }
        if let id = callId ?? joins[uuid]?.callId { await api.leave(callId: id) }
        deactivateAppAudio(uuid)
        appOnly.remove(uuid)
        noticesSeen.remove(uuid)
    }

    // MARK: - Audio

    /// LiveKit's own audio session handling off, its engine off until CallKit activates the session
    /// (LiveKit's CallKit guide): once, before any call.
    private func prepareAudio() {
        guard !audioPrepared else { return }
        audioPrepared = true
        AudioManager.shared.audioSession.isAutomaticConfigurationEnabled = false
        try? AudioManager.shared.setEngineAvailability(.none)
    }

    private static func configure(_ session: AVAudioSession) throws {
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP, .allowBluetoothA2DP])
    }

    /// A call the system doesn't show: the app sets the audio session itself.
    private func activateAppAudio() {
        let s = AVAudioSession.sharedInstance()
        do {
            try Self.configure(s)
            try s.setActive(true)
            try AudioManager.shared.setEngineAvailability(.default)
        } catch {
            print("⚠️ Team call: audio session not started: \(error.localizedDescription)")
        }
    }

    private func deactivateAppAudio(_ uuid: UUID) {
        guard appOnly.contains(uuid) else { return }
        try? AudioManager.shared.setEngineAvailability(.none)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: - Fixture

    #if DEBUG
    /// The DEBUG preview's: a call that never connects, its people and state made up.
    func loadFixture(session s: TeamCallSession?, expanded: Bool, ring: TeamCallIncoming? = nil) {
        isFixture = true
        available = true
        session = s
        self.expanded = expanded
        inAppRing = ring
    }
    #endif
}

extension TeamCallCenter: CallKitBridgeDelegate {
    func callKitAnswer(_ uuid: UUID, action: CXAnswerCallAction) {
        guard let fx = book.answer(uuid) else {
            action.fail()
            return
        }
        // Fulfilled once the server has answered (the join in hand); a ring settled meanwhile fails it.
        answerActions[uuid] = action
        run(fx)
    }

    func callKitEnd(_ uuid: UUID, action: CXEndCallAction) {
        if let pending = answerActions.removeValue(forKey: uuid) { pending.fail() }
        run(book.end(uuid))
        action.fulfill()
    }

    /// The system gave up waiting on an action (an answer the server was slow to take): the call it
    /// dropped goes here too, so a late answer joins nothing.
    func callKitTimedOut(_ action: CXAction) {
        guard let answer = action as? CXAnswerCallAction, answerActions.removeValue(forKey: answer.callUUID) != nil else { return }
        run(book.end(answer.callUUID))
    }

    func callKitStart(_ uuid: UUID, action: CXStartCallAction) {
        Task { await performStart(uuid, action: action) }
    }

    func callKitMute(_ uuid: UUID, muted: Bool) {
        guard let s = session, s.uuid == uuid else { return }
        Task { await s.setMicrophone(on: !muted) }
    }

    func callKitHold(_ uuid: UUID, held: Bool) {
        guard let s = session, s.uuid == uuid else { return }
        Task { await s.setHeld(held) }
    }

    func callKitAudio(active: Bool, session audioSession: AVAudioSession) {
        do {
            if active {
                try Self.configure(audioSession)
                try AudioManager.shared.setEngineAvailability(.default)
            } else {
                try AudioManager.shared.setEngineAvailability(.none)
            }
        } catch {
            print("⚠️ Team call: audio engine not \(active ? "started" : "stopped"): \(error.localizedDescription)")
        }
    }

    func callKitReset() {
        // The system dropped every call it showed (its daemon restarted). With none, nothing to undo.
        guard !book.entries.isEmpty else { return }
        Task { await session?.leave() }
        session = nil
        for fx in book.clear() {
            if case let .ended(uuid, _) = fx, let action = answerActions.removeValue(forKey: uuid) { action.fail() }
        }
        joins = [:]
    }
}

/// A call the person is about to join that takes notes or is recorded: what they are told first.
struct TeamCallConfirm: Identifiable, Equatable {
    var id: String { callId }
    let channelId: String
    let callId: String
    let kind: TeamChatChannelKind
    let label: String
    let line: String
}
