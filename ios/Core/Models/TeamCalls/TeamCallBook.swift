//
//  TeamCallBook.swift
//  Native Intelligence
//
//  The calls the phone knows of, and what each thing that happens to them
//  means for the system's call screen (CallKit) and the server, as plain
//  values: App/Services/TeamCalls feeds it pushes, ring rows, the system's
//  actions and the call's own events, and carries out the effects it returns.
//  The CallKit and PushKit code stays thin; every decision is here, where
//  Scripts/test-team-calls.sh checks it.
//
//  Apple's rule shapes it: on iOS 13 and later every VoIP push must become an
//  incoming call (reported to CallKit) before its handler returns, or iOS
//  ends the app and may stop delivering VoIP pushes. iOS 26.4 says per push
//  whether that is owed (`mustReport`: not while the app is in the foreground
//  or already on a call); before it, every push owes one. So:
//
//    - a ring rings (reported) unless it is known settled or out of time, or
//      the person is in a call: then it is declined as busy, and the report
//      owed goes onto the call they are in (a duplicate report, refused
//      harmlessly, as Apple's engineers advise);
//    - a cancel ends the ring's call when it is ringing here; owed a report
//      with no call to put it on, it reports one and ends it at once;
//    - the phone never trusts the push alone: a ring reported is checked
//      against its row (Realtime, else a fetch), and a ring settled by then
//      ends at once; its own clock ends it when its time is up.
//

import Foundation

/// One call the phone knows of: an incoming ring, or a call the person started or joined here.
struct TeamCallEntry: Equatable {
    enum Phase: Equatable {
        /// The system's incoming-call screen is up.
        case ringing
        /// Answered here: the server is asked (team_call_answer) for the call's join.
        case answering
        /// Joining the call's room (answered, started or joined here).
        case connecting
        case active
    }

    /// The system's id for it (CallKit).
    let uuid: UUID
    /// The ring (an incoming call).
    let ringId: String?
    /// The call: known for a ring and a join; a call being started learns it from the server.
    var callId: String?
    let channelId: String
    var phase: Phase
    /// When an incoming ring stops ringing by the phone's own clock.
    var deadline: Date?
    let update: TeamCallKitUpdate

    var isIncoming: Bool { ringId != nil }
}

/// What the app does for one thing that happened, in order.
enum TeamCallEffect: Equatable {
    /// Show the system's incoming-call screen (reportNewIncomingCall).
    case report(UUID, TeamCallKitUpdate)
    /// A report owed for a push that is no call to ring: report it, then end it at once.
    case reportAndEnd(UUID, TeamCallKitUpdate, TeamCallEndReason)
    /// A report owed while a call is already up: report onto that call's id (refused as a
    /// duplicate, which is fine: the system sees a call, and nothing else shows).
    case reportOnExisting(UUID, TeamCallKitUpdate)
    /// Tell the system a call it shows has ended (reportCall(with:endedAt:reason:)).
    case ended(UUID, TeamCallEndReason)
    /// Answer the ring on the server (the same function the web uses), then join.
    case acceptOnServer(ringId: String)
    /// Decline the ring on the server (declined here, or busy in another call).
    case declineOnServer(ringId: String)
    /// Read the ring's row: settled already, it ends here.
    case checkRing(ringId: String)
    /// Join the call's room (the answer's join is in hand).
    case join(UUID)
    /// Leave the call's room, and tell the server (a DM's hang-up ends it).
    case leave(UUID, callId: String?)
    /// Ask the system to start an outgoing call (CXStartCallAction): it shows, and survives the lock screen.
    case startOnSystem(UUID, TeamCallKitUpdate)
}

/// How an answer on the server went.
enum TeamCallAnswerOutcome: Equatable {
    /// Accepted, with the call's join: in we go.
    case joined
    /// Settled before this answer landed (another device answered or declined, it ran out).
    case settled(TeamCallRingState)
    /// Accepted, but the call ended meanwhile.
    case callEnded
    /// The server could not be reached.
    case failed
}

struct TeamCallBook: Equatable {
    private(set) var entries: [TeamCallEntry] = []
    /// Rings known settled, and how (a late or repeated push never rings one again).
    private(set) var settled: [String: TeamCallRingState] = [:]
    private var settledOrder: [String] = []

    /// How many settled rings the phone remembers.
    static let settledMemory = 200
    /// A ring row that reads missed this close to the phone's own deadline ran out (no one hung up).
    static let deadlineSlack: TimeInterval = 2

    /// The call the person is in (answering, joining or in it), if any.
    var current: TeamCallEntry? { entries.first { $0.phase != .ringing } }
    /// The ring on screen, if any.
    var ringing: TeamCallEntry? { entries.first { $0.phase == .ringing } }
    /// When the next ring runs out (one timer for all).
    var nextDeadline: Date? { entries.compactMap(\.deadline).min() }

    func entry(_ uuid: UUID) -> TeamCallEntry? { entries.first { $0.uuid == uuid } }
    func entry(ringId: String) -> TeamCallEntry? { entries.first { $0.ringId == ringId.lowercased() } }
    func entry(callId: String) -> TeamCallEntry? { entries.first { $0.callId == callId.lowercased() } }

    // MARK: - Rings

    /// A ring's VoIP push. `mustReport`: the system wants a call reported for this push (always, before
    /// iOS 26.4). `newID` is the id a new report gets.
    mutating func ringPushed(_ r: TeamCallIncoming, now: Date, mustReport: Bool, newID: UUID) -> [TeamCallEffect] {
        ring(r, now: now, mustReport: mustReport, newID: newID)
    }

    /// A ring heard while the app is open (Realtime, or the fetch on coming back): rung the same way,
    /// with no report owed. A ring the push already rang is that one.
    mutating func ringHeard(_ r: TeamCallIncoming, now: Date, newID: UUID) -> [TeamCallEffect] {
        ring(r, now: now, mustReport: false, newID: newID)
    }

    private mutating func ring(_ r: TeamCallIncoming, now: Date, mustReport: Bool, newID: UUID) -> [TeamCallEffect] {
        let update = TeamCallKitUpdate.incoming(r)
        if entry(ringId: r.ringId) != nil {
            // Rung already (the push after Realtime, or a repeat).
            return owedOnExisting(mustReport) ?? []
        }
        if let state = settled[r.ringId] {
            return mustReport ? (owedOnExisting(true) ?? [.reportAndEnd(newID, update, .of(settled: state))]) : []
        }
        if r.secondsLeft <= 0 {
            remember(r.ringId, .missed)
            return mustReport ? (owedOnExisting(true) ?? [.reportAndEnd(newID, update, .unanswered)]) : []
        }
        if current != nil || ringing != nil {
            // In a call (or another ring is up): this one is declined as busy, quietly. The report owed
            // goes onto the call that is up.
            if ringing != nil && current == nil {
                // Two rings at once: the second stays the other devices' (the web rings it); not declined.
                return owedOnExisting(mustReport) ?? []
            }
            remember(r.ringId, .declined)
            return (owedOnExisting(mustReport) ?? []) + [.declineOnServer(ringId: r.ringId)]
        }
        entries.append(TeamCallEntry(uuid: newID, ringId: r.ringId, callId: r.callId, channelId: r.channelId, phase: .ringing,
                                     deadline: now.addingTimeInterval(TimeInterval(r.secondsLeft)), update: update))
        return [.report(newID, update), .checkRing(ringId: r.ringId)]
    }

    /// A cancel's VoIP push: the ring was settled elsewhere, or the caller gave up.
    mutating func cancelPushed(ringId: String, state: TeamCallRingState, mustReport: Bool, newID: UUID) -> [TeamCallEffect] {
        let id = ringId.lowercased()
        let settledState: TeamCallRingState = state.isOpen ? .cancelled : state
        remember(id, settledState)
        if let e = entry(ringId: id) {
            if e.phase == .ringing {
                entries.removeAll { $0.uuid == e.uuid }
                // The report owed is this very call (it is up until this returns).
                return [.ended(e.uuid, .of(settled: settledState))]
            }
            // Answered here: the answer's own reply decides.
            return owedOnExisting(mustReport) ?? []
        }
        return mustReport ? (owedOnExisting(true) ?? [.reportAndEnd(newID, .placeholder, .of(settled: settledState))]) : []
    }

    /// A VoIP push that is no team call's (malformed, or from a newer server): owed, reported and ended.
    mutating func unknownPushed(mustReport: Bool, newID: UUID) -> [TeamCallEffect] {
        mustReport ? (owedOnExisting(true) ?? [.reportAndEnd(newID, .placeholder, .failed)]) : []
    }

    /// A ring's row as Realtime or a fetch says it. Settled: the ring here ends at once.
    mutating func ringRow(id: String, state: TeamCallRingState, now: Date) -> [TeamCallEffect] {
        guard !state.isOpen else { return [] }
        let ringId = id.lowercased()
        remember(ringId, state)
        guard let e = entry(ringId: ringId), e.phase == .ringing else { return [] }
        entries.removeAll { $0.uuid == e.uuid }
        let ranOut = state == .missed && (e.deadline.map { now >= $0.addingTimeInterval(-Self.deadlineSlack) } ?? false)
        return [.ended(e.uuid, ranOut ? .unanswered : .of(settled: state))]
    }

    /// The clock: rings past their time stop here (the server's timer marks them missed).
    mutating func tick(now: Date) -> [TeamCallEffect] {
        let gone = entries.filter { $0.phase == .ringing && ($0.deadline.map { $0 <= now } ?? false) }
        for e in gone {
            entries.removeAll { $0.uuid == e.uuid }
            if let ring = e.ringId { remember(ring, .missed) }
        }
        return gone.map { .ended($0.uuid, .unanswered) }
    }

    // MARK: - The system's actions

    /// The person answered on the system's screen. Nil: no such ring (the action fails).
    mutating func answer(_ uuid: UUID) -> [TeamCallEffect]? {
        guard let i = entries.firstIndex(where: { $0.uuid == uuid }), entries[i].phase == .ringing, let ring = entries[i].ringId else { return nil }
        entries[i].phase = .answering
        entries[i].deadline = nil
        return [.acceptOnServer(ringId: ring)]
    }

    /// The server's answer to an accept.
    mutating func answered(ringId: String, _ outcome: TeamCallAnswerOutcome) -> [TeamCallEffect] {
        guard let i = entries.firstIndex(where: { $0.ringId == ringId.lowercased() }), entries[i].phase == .answering else { return [] }
        if outcome == .joined {
            entries[i].phase = .connecting
            return [.join(entries[i].uuid)]
        }
        let e = entries.remove(at: i)
        switch outcome {
        case let .settled(state):
            remember(e.ringId ?? "", state)
            return [.ended(e.uuid, state == .accepted ? .answeredElsewhere : .of(settled: state))]
        case .callEnded:
            return [.ended(e.uuid, .remoteEnded)]
        case .failed, .joined:
            return [.ended(e.uuid, .failed)]
        }
    }

    /// The person ended a call on the system's screen (or the app's): a ring is declined, a call left.
    /// The system knows it ended (its action is fulfilled), so no `.ended`.
    mutating func end(_ uuid: UUID) -> [TeamCallEffect] {
        guard let i = entries.firstIndex(where: { $0.uuid == uuid }) else { return [] }
        let e = entries.remove(at: i)
        if e.phase == .ringing, let ring = e.ringId {
            remember(ring, .declined)
            return [.declineOnServer(ringId: ring)]
        }
        return [.leave(e.uuid, callId: e.callId)]
    }

    // MARK: - Calls started here

    /// The person starts a call in a conversation, or joins one live there (`callId`). Already in that
    /// call: nothing. The app leaves any other call first.
    mutating func start(channelId: String, callId: String?, label: String, newID: UUID) -> [TeamCallEffect] {
        if let callId, let e = entry(callId: callId), e.phase != .ringing { return [] }
        if let e = current, e.channelId == channelId.lowercased() { return [] }
        let update = TeamCallKitUpdate.outgoing(channelId: channelId.lowercased(), label: label)
        entries.append(TeamCallEntry(uuid: newID, ringId: nil, callId: callId?.lowercased(), channelId: channelId.lowercased(),
                                     phase: .connecting, deadline: nil, update: update))
        return [.startOnSystem(newID, update)]
    }

    /// The server named the call a start made.
    mutating func learned(_ uuid: UUID, callId: String) {
        guard let i = entries.firstIndex(where: { $0.uuid == uuid }) else { return }
        entries[i].callId = callId.lowercased()
    }

    /// In the call's room.
    mutating func connected(_ uuid: UUID) {
        guard let i = entries.firstIndex(where: { $0.uuid == uuid }), entries[i].phase == .connecting else { return }
        entries[i].phase = .active
    }

    /// The call ended without the person ending it (the room closed, the other person in a DM hung
    /// up, it was lost, a start failed): the system is told.
    mutating func callEnded(_ uuid: UUID, reason: TeamCallEndReason) -> [TeamCallEffect] {
        guard let i = entries.firstIndex(where: { $0.uuid == uuid }) else { return [] }
        let e = entries.remove(at: i)
        return [.ended(e.uuid, reason)]
    }

    /// Signed out: every call goes (the app tells the system each ended).
    mutating func clear() -> [TeamCallEffect] {
        let all = entries
        entries = []
        return all.map { .ended($0.uuid, .failed) }
    }

    // MARK: -

    /// A report owed while a call is up goes onto that call; nil when none is up (or none is owed: []).
    private func owedOnExisting(_ mustReport: Bool) -> [TeamCallEffect]? {
        guard mustReport else { return [] }
        guard let up = current ?? ringing else { return nil }
        return [.reportOnExisting(up.uuid, up.update)]
    }

    private mutating func remember(_ ringId: String, _ state: TeamCallRingState) {
        guard !ringId.isEmpty else { return }
        if settled[ringId] == nil { settledOrder.append(ringId) }
        settled[ringId] = state
        if settledOrder.count > Self.settledMemory {
            let drop = settledOrder.removeFirst()
            settled[drop] = nil
        }
    }
}
