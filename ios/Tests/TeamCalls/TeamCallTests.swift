import Foundation

// Team calls' rules on the phone (Core/Models/TeamCalls), built and run on the Mac by
// Scripts/test-team-calls.sh: the push's payload, the ring's state machine against CallKit
// (a push after the ring was settled, a cancel, the ring's own clock, busy), the session's
// states, the call screen's tiles and the call's message. Made-up people only.

@main struct TeamCallTests {
    static var failures = 0
    static var checks = 0

    static func check(_ ok: Bool, _ message: String, line: UInt = #line) {
        checks += 1
        if !ok {
            failures += 1
            print("FAIL \(message) (line \(line))")
        }
    }

    static func equal<T: Equatable>(_ got: T, _ wanted: T, _ message: String, line: UInt = #line) {
        checks += 1
        if got != wanted {
            failures += 1
            print("FAIL \(message) (line \(line))\n  wanted: \(wanted)\n  got:    \(got)")
        }
    }

    static let ring1 = "aaaaaaaa-0000-4000-8000-000000000001"
    static let ring2 = "aaaaaaaa-0000-4000-8000-000000000002"
    static let call1 = "bbbbbbbb-0000-4000-8000-000000000001"
    static let call2 = "bbbbbbbb-0000-4000-8000-000000000002"
    static let dm = "cccccccc-0000-4000-8000-000000000001"
    static let launch = "cccccccc-0000-4000-8000-000000000002"
    static let ws = "dddddddd-0000-4000-8000-000000000001"
    static let ana = "eeeeeeee-0000-4000-8000-000000000001"
    static let ben = "eeeeeeee-0000-4000-8000-000000000002"
    static let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    static func ringPayload(_ ring: String = ring1, call: String = call1, seconds: Any = 38, kind: String = "dm", name: Any = NSNull()) -> [AnyHashable: Any] {
        ["kind": "team_call_ring", "ring_id": ring, "call_id": call, "channel_id": kind == "dm" ? dm : launch, "workspace_id": ws,
         "caller_name": "Ana Ruiz", "channel_kind": kind, "channel_name": name, "video": false, "seconds_left": seconds]
    }

    static func incoming(_ ring: String = ring1, call: String = call1, seconds: Int = 38) -> TeamCallIncoming {
        guard case let .ring(r)? = TeamCallPush.parse(ringPayload(ring, call: call, seconds: seconds)) else { fatalError("ring payload") }
        return r
    }

    static func uuid(_ n: Int) -> UUID { UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", n))! }

    static func main() {
        payloads()
        rings()
        settledFirst()
        cancels()
        clock()
        busy()
        answering()
        ending()
        outgoing()
        session()
        tiles()
        cards()
        routing()
        words()
        if failures > 0 {
            print("\(failures) of \(checks) checks failed")
            exit(1)
        }
        print("team calls: all \(checks) checks passed")
    }

    // MARK: - The push

    static func payloads() {
        guard case let .ring(r)? = TeamCallPush.parse(ringPayload(kind: "channel", name: "launch")) else {
            check(false, "a ring's push parses")
            return
        }
        equal(r.ringId, ring1, "the ring's id")
        equal(r.callId, call1, "the call's id")
        equal(r.workspaceId, ws, "the workspace's id")
        equal(r.callerLine, "Ana Ruiz · #launch", "a channel's ring says who and where")
        equal(r.secondsLeft, 38, "the ring's time left")
        check(!r.video, "no video offered: an audio call")
        equal(TeamCallKitUpdate.incoming(r), TeamCallKitUpdate(handle: "team-chat:\(launch)", callerName: "Ana Ruiz · #launch", hasVideo: false),
              "the system's call screen: the conversation as the handle, who and where, audio")
        guard case let .ring(d)? = TeamCallPush.parse(ringPayload()) else { return }
        equal(d.callerLine, "Ana Ruiz", "a DM's ring: just who")
        if case let .ring(n)? = TeamCallPush.parse(ringPayload(seconds: NSNumber(value: 12))) { equal(n.secondsLeft, 12, "seconds as a number from JSON") }
        if case let .ring(n)? = TeamCallPush.parse(ringPayload(seconds: 9999)) { equal(n.secondsLeft, TeamCallIncoming.maxRingSeconds, "a push never rings past a minute") }
        if case let .ring(n)? = TeamCallPush.parse(ringPayload(ring1.uppercased())) { equal(n.ringId, ring1, "ids are lower case") }
        equal(TeamCallPush.parse(["kind": "team_call_cancel", "ring_id": ring1, "call_id": call1, "state": "accepted"]),
              .cancel(ringId: ring1, callId: call1, state: .accepted), "a cancel says the ring and how it was settled")
        equal(TeamCallPush.parse(["kind": "team_call_cancel", "ring_id": ring1, "state": "who knows"]),
              .cancel(ringId: ring1, callId: nil, state: .cancelled), "a cancel with a state it doesn't know is still a cancel")
        check(TeamCallPush.parse(["kind": "team_call_ring", "ring_id": "not-an-id"]) == nil, "a ring with no ids is no push")
        check(TeamCallPush.parse(["aps": ["alert": "x"]]) == nil, "an alert is no call's push")
        check(TeamCallPush.parse(ringPayload()).map { "\($0)" }?.contains("token") == false, "nothing in the push is a token")
    }

    // MARK: - Rings

    static func rings() {
        var book = TeamCallBook()
        let fx = book.ringPushed(incoming(), now: t0, mustReport: true, newID: uuid(1))
        equal(fx, [.report(uuid(1), TeamCallKitUpdate.incoming(incoming())), .checkRing(ringId: ring1)],
              "a ring's push: the incoming-call screen, then the ring's row is read (never the push alone)")
        equal(book.ringing?.deadline, t0.addingTimeInterval(38), "it rings until its time is up, by the phone's own clock")
        equal(book.ringPushed(incoming(), now: t0, mustReport: true, newID: uuid(2)), [.reportOnExisting(uuid(1), TeamCallKitUpdate.incoming(incoming()))],
              "the same ring again (a repeat): the report owed goes onto its own call, nothing new rings")
        equal(book.ringHeard(incoming(), now: t0, newID: uuid(3)), [], "the same ring heard over Realtime: it is the one ringing")
        equal(book.entries.count, 1, "one call")

        var heardFirst = TeamCallBook()
        equal(heardFirst.ringHeard(incoming(), now: t0, newID: uuid(4)).first, .report(uuid(4), TeamCallKitUpdate.incoming(incoming())),
              "a ring heard over Realtime while the app is open rings on the system's screen too")
        equal(heardFirst.ringPushed(incoming(), now: t0, mustReport: false, newID: uuid(5)), [], "its push after (iOS 26.4 says no report owed): nothing more")

        equal(heardFirst.ringRow(id: ring1, state: .ringing, now: t0), [], "its row still ringing: nothing")
    }

    static func settledFirst() {
        // The ring was answered on the web before the push arrived.
        var book = TeamCallBook()
        _ = book.ringPushed(incoming(), now: t0, mustReport: true, newID: uuid(1))
        equal(book.ringRow(id: ring1, state: .accepted, now: t0.addingTimeInterval(1)), [.ended(uuid(1), .answeredElsewhere)],
              "reported, then its row says it was answered elsewhere: ended at once")
        check(book.entries.isEmpty, "no call left")
        equal(book.ringPushed(incoming(), now: t0.addingTimeInterval(2), mustReport: true, newID: uuid(2)),
              [.reportAndEnd(uuid(2), TeamCallKitUpdate.incoming(incoming()), .answeredElsewhere)],
              "a late push of a ring known settled: reported (owed) and ended at once")
        equal(book.ringPushed(incoming(), now: t0.addingTimeInterval(2), mustReport: false, newID: uuid(3)), [],
              "… and with no report owed (iOS 26.4: foreground), nothing at all")

        var declined = TeamCallBook()
        _ = declined.ringPushed(incoming(), now: t0, mustReport: true, newID: uuid(1))
        equal(declined.ringRow(id: ring1, state: .declined, now: t0), [.ended(uuid(1), .declinedElsewhere)], "declined on the web: ended here")

        var hungUp = TeamCallBook()
        _ = hungUp.ringPushed(incoming(), now: t0, mustReport: true, newID: uuid(1))
        equal(hungUp.ringRow(id: ring1, state: .missed, now: t0.addingTimeInterval(5)), [.ended(uuid(1), .remoteEnded)],
              "missed well before its time: the caller hung up")
        var ranOut = TeamCallBook()
        _ = ranOut.ringPushed(incoming(), now: t0, mustReport: true, newID: uuid(1))
        equal(ranOut.ringRow(id: ring1, state: .missed, now: t0.addingTimeInterval(37)), [.ended(uuid(1), .unanswered)],
              "missed at its time: nobody answered")

        var late = TeamCallBook()
        equal(late.ringPushed(incoming(seconds: 0), now: t0, mustReport: true, newID: uuid(9)),
              [.reportAndEnd(uuid(9), TeamCallKitUpdate.incoming(incoming(seconds: 0)), .unanswered)],
              "a push that arrives with no time left: reported and ended, never rung")
        check(late.entries.isEmpty, "… and nothing rings")
    }

    static func cancels() {
        var book = TeamCallBook()
        _ = book.ringPushed(incoming(), now: t0, mustReport: true, newID: uuid(1))
        equal(book.cancelPushed(ringId: ring1, state: .accepted, mustReport: true, newID: uuid(2)), [.ended(uuid(1), .answeredElsewhere)],
              "a cancel ends the ringing call (the call it is is the report owed)")
        equal(book.ringRow(id: ring1, state: .accepted, now: t0), [], "its row after: nothing more")
        equal(book.ringPushed(incoming(), now: t0, mustReport: true, newID: uuid(3)),
              [.reportAndEnd(uuid(3), TeamCallKitUpdate.incoming(incoming()), .answeredElsewhere)],
              "the ring's push arriving after its cancel: reported and ended, never rung")

        var unknown = TeamCallBook()
        equal(unknown.cancelPushed(ringId: ring2, state: .declined, mustReport: true, newID: uuid(4)),
              [.reportAndEnd(uuid(4), .placeholder, .declinedElsewhere)],
              "a cancel for a ring this phone never rang, owed a report: reported and ended at once")
        equal(unknown.cancelPushed(ringId: ring2, state: .declined, mustReport: false, newID: uuid(5)), [], "… not owed one: nothing")
        equal(unknown.unknownPushed(mustReport: true, newID: uuid(6)), [.reportAndEnd(uuid(6), .placeholder, .failed)],
              "a push that is no call's, owed a report: reported and ended")

        // Answered here: the cancel the server sends everyone else never reaches this phone, but if one did...
        var answering = TeamCallBook()
        _ = answering.ringPushed(incoming(), now: t0, mustReport: true, newID: uuid(7))
        _ = answering.answer(uuid(7))
        equal(answering.cancelPushed(ringId: ring1, state: .accepted, mustReport: true, newID: uuid(8)),
              [.reportOnExisting(uuid(7), TeamCallKitUpdate.incoming(incoming()))],
              "a cancel while answering here leaves the call alone (the report owed goes onto it)")
        equal(answering.entries.count, 1, "… still answering")
    }

    static func clock() {
        var book = TeamCallBook()
        _ = book.ringPushed(incoming(seconds: 30), now: t0, mustReport: true, newID: uuid(1))
        equal(book.nextDeadline, t0.addingTimeInterval(30), "one timer: the ring's deadline")
        equal(book.tick(now: t0.addingTimeInterval(29)), [], "before its time: nothing")
        equal(book.tick(now: t0.addingTimeInterval(30)), [.ended(uuid(1), .unanswered)], "its time is up: unanswered, by the phone's clock")
        check(book.nextDeadline == nil, "no timer left")
        equal(book.ringRow(id: ring1, state: .missed, now: t0.addingTimeInterval(31)), [], "the server's missed after: nothing more")
    }

    static func busy() {
        var book = TeamCallBook()
        _ = book.start(channelId: launch, callId: call2, label: "#launch", newID: uuid(1))
        book.connected(uuid(1))
        let fx = book.ringPushed(incoming(), now: t0, mustReport: true, newID: uuid(2))
        equal(fx, [.reportOnExisting(uuid(1), TeamCallKitUpdate.outgoing(channelId: launch, label: "#launch")), .declineOnServer(ringId: ring1)],
              "a second call while in one: the report owed goes onto the call they're in, and it is declined as busy")
        equal(book.entries.count, 1, "… only the call they're in")
        equal(book.ringPushed(incoming(), now: t0, mustReport: false, newID: uuid(3)), [], "its repeat: already declined, nothing")
        var quiet = TeamCallBook()
        _ = quiet.start(channelId: launch, callId: call2, label: "#launch", newID: uuid(1))
        equal(quiet.ringHeard(incoming(), now: t0, newID: uuid(2)), [.declineOnServer(ringId: ring1)], "heard over Realtime while in a call: declined as busy")

        var two = TeamCallBook()
        _ = two.ringPushed(incoming(), now: t0, mustReport: true, newID: uuid(1))
        equal(two.ringPushed(incoming(ring2, call: call2), now: t0, mustReport: true, newID: uuid(2)),
              [.reportOnExisting(uuid(1), TeamCallKitUpdate.incoming(incoming()))],
              "two rings at once: the first rings here; the second is left to the other devices, not declined")
    }

    static func answering() {
        var book = TeamCallBook()
        _ = book.ringPushed(incoming(), now: t0, mustReport: true, newID: uuid(1))
        equal(book.answer(uuid(1)), [.acceptOnServer(ringId: ring1)], "answered on the system's screen: the server is asked (the web's function)")
        check(book.answer(uuid(1)) == nil, "answering twice: no such ring (the action fails)")
        check(book.nextDeadline == nil, "answered: its clock stops")
        equal(book.answered(ringId: ring1, .joined), [.join(uuid(1))], "accepted with a join: into the room")
        equal(book.current?.phase, .connecting, "connecting")
        book.connected(uuid(1))
        equal(book.current?.phase, .active, "in the call")

        var raced = TeamCallBook()
        _ = raced.ringPushed(incoming(), now: t0, mustReport: true, newID: uuid(2))
        _ = raced.answer(uuid(2))
        equal(raced.answered(ringId: ring1, .settled(.declined)), [.ended(uuid(2), .declinedElsewhere)], "declined elsewhere a moment before: ended")
        var tookElsewhere = TeamCallBook()
        _ = tookElsewhere.ringPushed(incoming(), now: t0, mustReport: true, newID: uuid(3))
        _ = tookElsewhere.answer(uuid(3))
        equal(tookElsewhere.answered(ringId: ring1, .settled(.accepted)), [.ended(uuid(3), .answeredElsewhere)], "answered on the web a moment before: ended")
        var gone = TeamCallBook()
        _ = gone.ringPushed(incoming(), now: t0, mustReport: true, newID: uuid(4))
        _ = gone.answer(uuid(4))
        equal(gone.answered(ringId: ring1, .callEnded), [.ended(uuid(4), .remoteEnded)], "the call ended meanwhile")
        var offline = TeamCallBook()
        _ = offline.ringPushed(incoming(), now: t0, mustReport: true, newID: uuid(5))
        _ = offline.answer(uuid(5))
        equal(offline.answered(ringId: ring1, .failed), [.ended(uuid(5), .failed)], "the server unreachable: failed")
        equal(offline.ringRow(id: ring1, state: .accepted, now: t0), [], "a row after the call went: nothing")
    }

    static func ending() {
        var book = TeamCallBook()
        _ = book.ringPushed(incoming(), now: t0, mustReport: true, newID: uuid(1))
        equal(book.end(uuid(1)), [.declineOnServer(ringId: ring1)], "declined on the system's screen: the server is told (the web stops ringing)")
        equal(book.ringPushed(incoming(), now: t0, mustReport: false, newID: uuid(2)), [], "its push again: declined, nothing")

        var inCall = TeamCallBook()
        _ = inCall.ringPushed(incoming(), now: t0, mustReport: true, newID: uuid(3))
        _ = inCall.answer(uuid(3))
        _ = inCall.answered(ringId: ring1, .joined)
        inCall.connected(uuid(3))
        equal(inCall.end(uuid(3)), [.leave(uuid(3), callId: call1)], "ended on the system's screen while in it: the room is left, the server told")
        check(inCall.entries.isEmpty, "gone")
        equal(inCall.end(uuid(3)), [], "ending again: nothing")

        var dropped = TeamCallBook()
        _ = dropped.start(channelId: dm, callId: nil, label: "Ana Ruiz", newID: uuid(4))
        equal(dropped.callEnded(uuid(4), reason: .remoteEnded), [.ended(uuid(4), .remoteEnded)], "the other person hung up: the system is told")
        var two = TeamCallBook()
        _ = two.start(channelId: dm, callId: nil, label: "Ana Ruiz", newID: uuid(5))
        equal(two.clear(), [.ended(uuid(5), .failed)], "signed out: every call goes")
    }

    static func outgoing() {
        var book = TeamCallBook()
        let label = "#launch"
        equal(book.start(channelId: launch, callId: nil, label: label, newID: uuid(1)),
              [.startOnSystem(uuid(1), TeamCallKitUpdate.outgoing(channelId: launch, label: label))],
              "a call started here is the system's too: it shows, and survives the lock screen")
        equal(book.start(channelId: launch, callId: nil, label: label, newID: uuid(2)), [], "starting again in the same conversation: it is that call")
        book.learned(uuid(1), callId: call2)
        equal(book.entry(callId: call2)?.uuid, uuid(1), "the server named the call")
        equal(book.start(channelId: launch, callId: call2, label: label, newID: uuid(3)), [], "Join on its message: already in it")
    }

    // MARK: - The session

    static func session() {
        var s = TeamCallSessionState()
        equal(s.statusLine(now: t0), "Connecting…", "connecting")
        s.apply(.mic(TeamCallSessionState.joiningMic(.denied)))
        equal(s.mic, .denied, "the microphone refused by iOS: listening only")
        check(s.notices.first?.contains("listening only") == true, "… and the screen says why")
        equal(TeamCallSessionState.joiningMic(.undetermined), .on, "not asked yet: asked, and on")
        equal(TeamCallSessionState.joiningMic(.granted), .on, "allowed: on")
        s.apply(.reconnecting)
        equal(s.connection, .connecting, "no reconnecting before connecting")
        s.apply(.connected(at: t0))
        equal(s.statusLine(now: t0.addingTimeInterval(65)), "1:05", "in the call: its clock")
        s.apply(.reconnecting)
        equal(s.statusLine(now: t0), "Reconnecting…", "the network dropped: reconnecting")
        s.apply(.connected(at: t0.addingTimeInterval(100)))
        equal(s.elapsed(now: t0.addingTimeInterval(120)), 120, "a reconnect keeps the clock")
        s.apply(.held(true))
        equal(s.statusLine(now: t0), "On hold", "held by the system (a phone call came in)")
        s.apply(.held(false))
        s.apply(.camera(.denied))
        check(s.notices.contains { $0.contains("Camera") }, "the camera refused: the screen says where to turn it on")
        s.apply(.ended(.elsewhere))
        equal(s.connection, .ended(.elsewhere), "joined on another device: ended here")
        s.apply(.connected(at: t0))
        equal(s.connection, .ended(.elsewhere), "an ended call takes nothing more")
        equal(TeamCallSessionEnd.left.line, nil, "leaving says nothing")
        equal(TeamCallSessionEnd.ended.systemReason, .remoteEnded, "the room closed: the system hears the other side ended it")
        equal(TeamCallSessionEnd.failed.line, "The call was lost. Join it again from the conversation.", "lost: what to do")
    }

    static func tiles() {
        let me = TeamCallPeer(identity: "m0", name: "Theo Park", isLocal: true, joinedAt: t0)
        equal(TeamCallTiles.layout(TeamCallTiles.tiles([me])), .waiting, "only the person: waiting for the others")
        let ana = TeamCallPeer(identity: "m1", name: "Ana Ruiz", isLocal: false, isSpeaking: true, cameraOn: true, joinedAt: t0.addingTimeInterval(5))
        let ben = TeamCallPeer(identity: "m2", name: "Ben Okafor", isLocal: false, micOn: false, joinedAt: t0.addingTimeInterval(2))
        let pair = TeamCallTiles.tiles([me, ana])
        equal(TeamCallTiles.layout(pair), .pair, "one other: theirs large, the person's in a corner")
        equal(pair.map(\.identity), ["m1", "m0"], "the other first, the person last")
        let three = TeamCallTiles.tiles([me, ana, ben])
        equal(three.map(\.identity), ["m2", "m1", "m0"], "the others in the order they joined, the person last")
        equal(TeamCallTiles.layout(three), .grid(columns: 2), "three or more: a grid")
        equal(three.first { $0.identity == "m1" }?.speaking, true, "the one speaking is marked")
        equal(three.first { $0.identity == "m1" }?.hasVideo, true, "a camera on: video")
        equal(three.first { $0.identity == "m2" }?.micOn, false, "a muted microphone shows")
        var muted = ana
        muted.micOn = false
        equal(TeamCallTiles.tiles([muted]).first?.speaking, false, "a muted person is never marked speaking")
        var sharing = ben
        sharing.sharingScreen = true
        let shared = TeamCallTiles.tiles([me, ana, sharing])
        equal(shared.first?.kind, .screen, "someone's shared screen (just a video) comes first")
        equal(shared.first?.id, "m2:screen", "… as its own tile")
        equal(TeamCallTiles.layout(shared), .screen, "a shared screen fills the top")
        equal(TeamCallTiles.initials("Ana Ruiz"), "AR", "initials")
        equal(TeamCallTiles.initials(""), "?", "no name: a mark")
    }

    static func cards() {
        let live = TeamCallView(
            call: TeamCall(id: call1, channelId: launch, messageId: "m", startedBy: ana, status: .live, startedAt: "2026-11-11T10:00:00Z", participantCount: 2, peakParticipants: 2),
            participants: [
                TeamCallParticipant(callId: call1, memberId: ben, state: "joined", joinedAt: "2026-11-11T10:01:00Z", leftAt: nil),
                TeamCallParticipant(callId: call1, memberId: ana, state: "joined", joinedAt: "2026-11-11T10:00:00Z", leftAt: nil),
            ]
        )
        equal(TeamCallCard.of(message: "Started a call", view: live, channelKind: .channel, inCallId: nil), .live(people: [ana, ben], here: false),
              "a live call: who is in it, in the order they joined, and Join")
        equal(TeamCallCard.of(message: "Started a call", view: live, channelKind: .channel, inCallId: call1), .live(people: [ana, ben], here: true),
              "the person is in it here: it says so")
        var ended = live
        ended.call.status = .ended
        ended.call.durationSeconds = 754
        ended.call.peakParticipants = 3
        equal(TeamCallCard.of(message: "Started a call", view: ended, channelKind: .channel, inCallId: nil), .ended("Call ended · 12 min · 3 people"),
              "an ended call: how it went (565's words)")
        equal(TeamCallCard.of(message: "Missed call", view: nil, channelKind: .dm, inCallId: nil), .ended("Missed call"), "no call read yet: its message's words")
        var update = live
        update.upsert(TeamCallParticipant(callId: call1, memberId: ben, state: "left", joinedAt: "2026-11-11T10:01:00Z", leftAt: "2026-11-11T10:05:00Z"))
        equal(update.inNow.map(\.memberId), [ana], "a participant row from Realtime replaces that member's")
        equal(TeamCallCard.peopleLine(["Ana Ruiz", "Ben Okafor", "Mara Chen"]), "In the call: Ana Ruiz and 2 others", "the live card's line")
        equal(TeamCallCard.peopleLine([]), "Started a call", "nobody in it yet")
    }

    static func routing() {
        let inCall = TeamCallEntry(uuid: uuid(1), ringId: nil, callId: call1, channelId: launch, phase: .active, deadline: nil,
                                   update: TeamCallKitUpdate.outgoing(channelId: launch, label: "#launch"))
        equal(TeamCallRouting.join(callId: call1, channelId: launch, current: inCall), .show, "Join on the call they're in: its screen")
        equal(TeamCallRouting.join(callId: nil, channelId: launch, current: inCall), .show, "the call button where they're in a call: its screen")
        equal(TeamCallRouting.join(callId: call2, channelId: dm, current: inCall), .switchCalls, "another call: leave this one first")
        equal(TeamCallRouting.join(callId: call2, channelId: dm, current: nil), .join, "no call: join")
        check(TeamCallRouting.opensExpanded, "an answered call opens its screen")
    }

    static func words() {
        equal(TeamCallWords.summary(kind: .dm, seconds: 30, peak: 1), "Missed call", "a DM nobody answered")
        equal(TeamCallWords.summary(kind: .channel, seconds: 0, peak: 0), "Call ended", "nobody joined")
        equal(TeamCallWords.summary(kind: .dm, seconds: 3900, peak: 2), "Call ended · 1 h 5 min · 2 people", "over an hour")
        equal(TeamCallWords.summary(kind: .channel, seconds: 45, peak: 1), "Call ended · under a minute · 1 person", "one person")
        equal(TeamCallWords.clock(3729), "1:02:09", "the clock past an hour")
        equal(TeamCallEndReason.of(settled: .cancelled), .remoteEnded, "cancelled: the other side ended it")
        let row = TeamCallRing(id: ring1.uppercased(), callId: call1, workspaceId: ws, channelId: dm, memberId: ben, callerMemberId: ana, callerName: "Ana Ruiz",
                               channelKind: .dm, channelName: nil, state: .ringing, createdAt: "2026-11-11T10:00:00Z", expiresAt: "2026-11-11T10:00:40Z")
        let now = TeamChatTime.date("2026-11-11T10:00:10Z")!
        equal(TeamCallIncoming(ring: row, now: now)?.secondsLeft, 30, "a ring row heard live rings for what is left of it")
        equal(TeamCallIncoming(ring: row, now: now)?.ringId, ring1, "… by its id, lower case")
        check(TeamCallIncoming(ring: row, now: TeamChatTime.date("2026-11-11T10:00:41Z")!) == nil, "a ring row past its time never rings")
        var busy = row
        busy.state = .busy
        check(TeamCallIncoming(ring: busy, now: now) == nil, "a busy ring (a quiet notice) never rings")
        let decoded = try? JSONDecoder().decode(TeamCallRing.self, from: Data(#"{"id":"r","call_id":"c","workspace_id":"w","channel_id":"ch","member_id":"m","caller_member_id":null,"caller_name":"Ana Ruiz","channel_kind":"channel","channel_name":"launch","state":"declined","created_at":"t","expires_at":"t"}"#.utf8))
        equal(decoded?.state, .declined, "a ring row decodes")
        let call = try? JSONDecoder().decode(TeamCall.self, from: Data(#"{"id":"c","channel_id":"ch","status":"ended","started_at":"t","duration_seconds":12,"peak_participants":2}"#.utf8))
        equal(call?.ringing, [], "a call row from Realtime without its arrays decodes")
        equal(call?.status, .ended, "… with its status")
        let message = try? JSONDecoder().decode(TeamChatMessage.self, from: Data(#"{"id":"m","channel_id":"ch","author_kind":"member","author_member_id":"a","body":"Started a call","created_at":"t","kind":"call","call_id":"BBBBBBBB-0000-4000-8000-000000000001"}"#.utf8))
        check(message?.isCall == true && message?.callId == call1, "a call's message decodes as the call's")
        let plain = try? JSONDecoder().decode(TeamChatMessage.self, from: Data(#"{"id":"m","channel_id":"ch","body":"hi","created_at":"t"}"#.utf8))
        check(plain?.isCall == false && plain?.kind == "message", "an old row without a kind is a message")
    }
}
