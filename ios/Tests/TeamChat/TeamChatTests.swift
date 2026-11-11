import Foundation

// Team chat's rules on the phone (Core/Models/TeamChat), built and run on the Mac by
// Scripts/test-team-chat.sh. Made-up people only.

@main struct TeamChatTests {
    static var failures = 0
    static var checks = 0

    static func check(_ ok: Bool, _ message: String, file: StaticString = #file, line: UInt = #line) {
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

    static let me = "aaaaaaaa-0000-4000-8000-000000000001"
    static let ana = "aaaaaaaa-0000-4000-8000-000000000002"
    static let ch = "cccccccc-0000-4000-8000-000000000001"

    static func channel(_ id: String = ch, kind: TeamChatChannelKind = .channel, unread: Int = 0, mentions: Int = 0,
                        threadUnread: Int = 0, threadMentions: Int = 0, notify: TeamChatNotifyLevel = .mentions,
                        last: String? = "2026-11-11T10:00:00.000Z") -> TeamChatChannel {
        TeamChatChannel(id: id, kind: kind, name: kind == .channel ? "launch" : nil, topic: nil, teamId: nil,
                        dmMemberId: kind == .dm ? ana : nil, lastMessageAt: last, archivedAt: nil, unread: unread,
                        mentions: mentions, threadUnread: threadUnread, threadMentions: threadMentions, notify: notify)
    }

    static func row(_ id: String, at: String, by author: String? = ana, client: String? = nil, thread: String? = nil, body: String = "hi") -> TeamChatMessage {
        TeamChatMessage(id: id, channelId: ch, authorMemberId: author, threadRootId: thread, clientId: client, body: body, createdAt: at)
    }

    static func send(_ client: String, at: String, body: String = "on my way", thread: String? = nil) -> TeamChatPendingSend {
        TeamChatPendingSend(clientId: client, channelId: ch, threadRootId: thread, body: body, mentions: [], mentionsAgent: false, attachments: [], createdAt: at)
    }

    static func page(_ messages: [TeamChatMessage], reactions: [TeamChatReaction] = [], threads: [TeamChatThreadSummary] = [], root: TeamChatMessage? = nil) -> TeamChatMessagesResponse {
        TeamChatMessagesResponse(messages: messages, threads: threads, reactions: reactions, root: root)
    }

    static func main() {
        times()
        decoding()
        unread()
        optimisticSends()
        conversation()
        reactions()
        mentions()
        typing()
        files()
        pushPayloads()
        pushTaps()
        presentation()
        permission()
        links()
        if failures > 0 {
            print("\(failures) of \(checks) checks failed")
            exit(1)
        }
        print("team chat: all \(checks) checks passed")
    }

    // MARK: -

    static func times() {
        let micro = TeamChatTime.date("2026-11-11T20:00:00.123456+00:00")
        let milli = TeamChatTime.date("2026-11-11T20:00:00.123Z")
        check(micro != nil && micro == milli, "Postgres's microseconds read as the same instant (to the millisecond)")
        check(TeamChatTime.date("2026-11-11 20:00:00+00") == nil || TeamChatTime.date("2026-11-11 20:00:00+00:00") != nil, "a space for the T reads")
        check(TeamChatTime.date("2026-11-11T20:00:00Z") != nil, "no fraction reads")
        check(TeamChatTime.date("yesterday") == nil, "words are no time")
    }

    static func decoding() {
        let json = """
        {"id":"m1","channel_id":"\(ch)","author_kind":"member","author_member_id":"\(ana)","body":"Ship it","created_at":"2026-11-11T20:00:00.5+00:00"}
        """
        let m = try? JSONDecoder().decode(TeamChatMessage.self, from: Data(json.utf8))
        check(m != nil, "a realtime row without the newer columns decodes")
        equal(m?.attachments ?? [TeamChatAttachment(path: "x", name: "x", size: 1, type: "x")], [], "… with no files")
        equal(m?.threadRootId, nil, "… in the channel itself")
        let list = """
        {"channels":[{"id":"\(ch)","kind":"channel","name":"launch","topic":null,"team_id":null,"dm_member_id":null,"last_message_at":"2026-11-11T20:00:00+00:00","archived_at":null,"unread":2,"mentions":1,"thread_unread":3,"thread_mentions":0,"notify":"mentions"}],"threads":[{"root_id":"r1","channel_id":"\(ch)","unread":3,"mentions":0}],"memberId":"\(me)"}
        """
        let decoded = try? JSONDecoder().decode(TeamChatChannelsResponse.self, from: Data(list.utf8))
        equal(decoded?.channels.first?.threadUnread, 3, "the list's counts decode")
        equal(decoded?.memberId, me, "… and who the person is")
    }

    static func unread() {
        equal(TeamChatUnread.rowBadge(channel(unread: 2, threadUnread: 1)), .unread(3), "a row counts its own and its threads' unread")
        equal(TeamChatUnread.rowBadge(channel(unread: 2, mentions: 1)), .mentions(1), "a mention shows louder")
        equal(TeamChatUnread.rowBadge(channel(notify: .muted)), .none, "muted: nothing")
        equal(TeamChatUnread.rowBadge(channel(mentions: 1, notify: .muted)), .mentions(1), "muted: a mention still shows")
        let list = [channel(unread: 2, threadUnread: 1), channel("d1", kind: .dm, unread: 4, notify: .all), channel("m1", mentions: 1, threadMentions: 1, notify: .muted)]
        equal(TeamChatUnread.badge(list), 3 + 4 + 2, "the icon's badge: every channel's unread, a muted one's mentions only (563's rule)")
        let read = TeamChatUnread.markingRead(list, channelId: ch)
        equal(read[0].unread, 0, "reading a channel zeroes its own count at once")
        equal(read[0].threadUnread, 1, "… but not its threads'")
        let threads = [TeamChatThreadUnread(rootId: "r1", channelId: ch, unread: 1, mentions: 0)]
        let afterThread = TeamChatUnread.markingThreadRead(read, threads: threads, rootId: "r1")
        equal(afterThread.channels[0].threadUnread, 0, "reading a thread takes its replies off its channel")
        equal(afterThread.threads, [], "… and it is no longer unread")
        let ordered = TeamChatUnread.sorted([channel("a", last: "2026-11-11T09:00:00Z"), channel("b", unread: 1, last: "2026-11-10T09:00:00Z"), channel("c", mentions: 1, last: "2026-11-09T09:00:00Z"), channel("d", last: "2026-11-11T12:00:00Z")])
        equal(ordered.map(\.id), ["c", "b", "d", "a"], "the list: mentions, unread, then the newest")
    }

    static func optimisticSends() {
        let rows = [row("m1", at: "2026-11-11T10:00:00.000Z"), row("m2", at: "2026-11-11T10:02:00.000Z")]
        let pending = [send("k1", at: "2026-11-11T10:01:00.000Z")]
        let shown = TeamChatTimeline.shown(rows: rows, pending: pending, me: me)
        equal(shown.map(\.message.id), ["m1", "pending:k1", "m2"], "a send shows at once, in its place")
        check(shown[1].isSending && shown[1].message.authorMemberId == me, "… as the person's, sending")
        // The row comes back (by the route, or live first): one bubble, the row's.
        let arrived = TeamChatTimeline.upsert(rows, row("m9", at: "2026-11-11T10:01:00.300Z", by: me, client: "k1", body: "on my way"))
        let after = TeamChatTimeline.shown(rows: arrived, pending: pending, me: me)
        equal(after.map(\.message.id), ["m1", "m9", "m2"], "the row replaces the bubble, never beside it")
        equal(after[1].id, "c:k1", "… keeping the bubble's identity, so the list doesn't jump")
        equal(TeamChatTimeline.settle(pending, with: arrived), [], "the send is done")
        // The same row twice (the route's answer and Realtime's insert): still one.
        equal(TeamChatTimeline.upsert(arrived, row("m9", at: "2026-11-11T10:01:00.300Z", by: me, client: "k1")).count, 3, "a row twice is one")
    }

    static func conversation() {
        var state = TeamChatConversationState(channelId: ch)
        state.loaded(page([row("m1", at: "2026-11-11T10:00:00Z"), row("t1", at: "2026-11-11T10:00:30Z", thread: "m1")]))
        equal(state.rows.map(\.id), ["m1"], "a thread's reply is never in the channel's list")
        check(!state.hasOlder, "a short page: nothing older")
        state.beginSend(send("k1", at: "2026-11-11T10:05:00Z"))
        state.sendFailed(clientId: "k1")
        check(state.shown(me: me).last?.failed == true, "a refused send stays, marked")
        let again = state.retry(clientId: "k1")
        equal(again?.clientId, "k1", "a retry sends the same client id (the route answers a replay with its row)")
        check(state.shown(me: me).last?.isSending == true, "… and shows sending again")
        state.sent(row("m2", at: "2026-11-11T10:05:00.2Z", by: me, client: "k1"))
        equal(state.shown(me: me).map(\.message.id), ["m1", "m2"], "the answer settles it")
        state.receive(row("x1", at: "2026-11-11T10:06:00Z").withChannel("cccccccc-0000-4000-8000-0000000000ff"))
        equal(state.rows.count, 2, "another channel's row is not this one's")
        state.deleted(messageId: "m2")
        check(state.rows[1].isDeleted && state.rows[1].body.isEmpty, "a delete clears the words at once")

        var thread = TeamChatConversationState(channelId: ch, threadRootId: "m1")
        thread.loaded(page([row("t1", at: "2026-11-11T10:00:30Z", thread: "m1")], root: row("m1", at: "2026-11-11T10:00:00Z")))
        equal(thread.rows.map(\.id), ["t1"], "a thread holds its replies")
        equal(thread.root?.id, "m1", "… and its root")
        var edited = row("m1", at: "2026-11-11T10:00:00Z", body: "edited")
        edited.editedAt = "2026-11-11T10:09:00Z"
        thread.receive(edited)
        equal(thread.root?.body, "edited", "an edit of the root reaches the thread")
        thread.receive(row("m3", at: "2026-11-11T10:10:00Z"))
        equal(thread.rows.count, 1, "the channel's own messages are not the thread's")

        var paged = TeamChatConversationState(channelId: ch)
        let full = (0..<50).map { row("p\($0)", at: String(format: "2026-11-11T11:%02d:00Z", $0)) }
        paged.loaded(page(full))
        check(paged.hasOlder, "a full page: there may be older")
        equal(paged.oldestCursor, "2026-11-11T11:00:00Z", "the next page is before the oldest row's own time")
        paged.loadedOlder(page([row("o1", at: "2026-11-11T09:00:00Z"), full[0]]))
        equal(paged.rows.first?.id, "o1", "an older page goes in front")
        equal(paged.rows.count, 51, "… the overlap once")
        check(!paged.hasOlder, "… and a short one ends it")

        // Opened around an older message (a push): the page says what lies on either side.
        var around = TeamChatConversationState(channelId: ch)
        var aroundPage = page([row("a1", at: "2026-11-01T10:00:00Z"), row("a2", at: "2026-11-01T10:01:00Z")])
        aroundPage.hasOlder = true
        aroundPage.hasNewer = true
        around.loaded(aroundPage)
        check(around.hasOlder && around.hasNewer, "the page around a message knows there is more both ways")
        around.receive(row("live", at: "2026-11-11T12:00:00Z"))
        equal(around.rows.map(\.id), ["a1", "a2"], "a live message past a page that stops short waits for Newest")
        var edit = row("a2", at: "2026-11-01T10:01:00Z", body: "fixed")
        edit.editedAt = "2026-11-11T12:00:00Z"
        around.receive(edit)
        equal(around.rows.last?.body, "fixed", "… but an edit of a row on it lands")
        around.loaded(page([row("n1", at: "2026-11-11T12:00:00Z")]))
        check(!around.hasNewer, "the newest page runs to now")
    }

    static func reactions() {
        var state = TeamChatConversationState(channelId: ch)
        state.loaded(page([row("m1", at: "2026-11-11T10:00:00Z")], reactions: [
            TeamChatReaction(messageId: "m1", memberId: ana, emoji: "👍", active: true),
            TeamChatReaction(messageId: "m1", memberId: me, emoji: "🎉", active: false),
        ]))
        var chips = TeamChatReactions.chips(state.reactions, messageId: "m1", me: me)
        equal(chips.map(\.emoji), ["👍"], "a reaction taken back is no chip")
        let on = state.toggleReaction(messageId: "m1", emoji: "👍", me: me)
        check(on, "tapping a chip the person isn't in turns theirs on")
        chips = TeamChatReactions.chips(state.reactions, messageId: "m1", me: me)
        equal(chips.first, TeamChatReactionChip(emoji: "👍", count: 2, mine: true, memberIds: [ana, me]), "… at once: two, theirs")
        let off = state.toggleReaction(messageId: "m1", emoji: "👍", me: me)
        check(!off, "tapping it again takes it back")
        state.reactionRefused(messageId: "m1", emoji: "👍", me: me, wasOn: true)
        equal(TeamChatReactions.chips(state.reactions, messageId: "m1", me: me).first?.count, 2, "a refused change goes back")
        state.receive(TeamChatReaction(messageId: "m1", memberId: ana, emoji: "👍", active: false))
        equal(TeamChatReactions.chips(state.reactions, messageId: "m1", me: me).first?.count, 1, "someone else's, live")
        check(TeamChatReactions.isEmoji("👍🏽") && TeamChatReactions.isEmoji("❤️") && !TeamChatReactions.isEmoji("ok") && !TeamChatReactions.isEmoji("👍👍"), "one emoji, never words")
    }

    static func mentions() {
        equal(TeamChatMentions.query(in: "hey @an")?.query, "an", "the @word at the end is the query")
        equal(TeamChatMentions.query(in: "mail me@ana")?.query, nil, "an address is not a mention")
        equal(TeamChatMentions.query(in: "@ana done")?.query, nil, "a space ends it")
        equal(TeamChatMentions.inserting("Ana Ruiz", into: "thanks @an"), "thanks @Ana Ruiz ", "the pick replaces the query")
        let members = [TeamChatMember(id: ana, userId: nil, displayName: "Ana Ruiz", avatarUrl: nil), TeamChatMember(id: me, userId: nil, displayName: "Theo Park", avatarUrl: nil)]
        equal(TeamChatMentions.candidates(members, query: "ru", agentName: "Juniper").map(\.label), ["Ana Ruiz"], "a name's later word matches")
        equal(TeamChatMentions.candidates(members, query: "ju", agentName: "Juniper").first, TeamChatPickedMention(memberId: nil, label: "Juniper"), "the person's agent is pickable")
        let picked = [TeamChatPickedMention(memberId: ana, label: "Ana Ruiz"), TeamChatPickedMention(memberId: nil, label: "Juniper")]
        let still = TeamChatMentions.stillIn("@Ana Ruiz can you look", picked: picked)
        equal(still.memberIds, [ana], "a mention taken out of the words is dropped")
        check(!still.agent, "… the agent too")
        check(TeamChatMentions.has("ask @juniper.", label: "Juniper"), "any case, punctuation after")
        check(!TeamChatMentions.has("@Juniperberry", label: "Juniper"), "a longer word is not the mention")
        let segs = TeamChatMentions.segments("hi @Ana Ruiz and @Ana", labels: ["Ana", "Ana Ruiz"])
        equal(segs.map(\.text), ["hi ", "@Ana Ruiz", " and ", "@Ana"], "the longest label wins")
        equal(segs.map(\.mention), [false, true, false, true], "… and each is a mention")
    }

    static func typing() {
        var board = TeamChatTypingBoard()
        let t0 = Date(timeIntervalSince1970: 1_000)
        board.hear(TeamChatTypingSignal(memberId: ana, thread: nil, typing: true), me: me, now: t0)
        board.hear(TeamChatTypingSignal(memberId: me, thread: nil, typing: true), me: me, now: t0)
        equal(board.typers(thread: nil, now: t0), [ana], "others typing, never the person")
        equal(board.typers(thread: "r1", now: t0), [], "a channel's typing is not a thread's")
        equal(board.typers(thread: nil, now: t0.addingTimeInterval(5)), [], "gone after 4.5 s without a word")
        board.hear(TeamChatTypingSignal(memberId: ana, thread: nil, typing: false), me: me, now: t0)
        equal(board.typers(thread: nil, now: t0), [], "a stop drops them at once")
        equal(TeamChatTypingSignal.parse(["member_id": ana, "thread": NSNull(), "typing": true]), TeamChatTypingSignal(memberId: ana, thread: nil, typing: true), "the web's payload reads")
        equal(TeamChatTypingSignal.parse(["member_id": ana, "thread": 4]), nil, "a bad thread is no signal")
        equal(TeamChatTypingSignal.parse(["name": "Ana"]), nil, "no member, no signal")
        equal(TeamChatTypingSignal.topic(channelId: ch), "team-chat-typing:\(ch)", "the web's private topic")
        check(!TeamChatTypingBoard.shouldSend(last: (nil, t0), thread: nil, now: t0.addingTimeInterval(1)), "throttled")
        check(TeamChatTypingBoard.shouldSend(last: (nil, t0), thread: "r1", now: t0.addingTimeInterval(1)), "… unless the place changed")
        equal(TeamChatTypingBoard.line(["Ana", "Ben"]), "Ana and Ben are typing…", "the line")
    }

    static func files() {
        equal(TeamChatFiles.refusal(name: "deck.pdf", size: 2_000), nil, "a PDF goes")
        equal(TeamChatFiles.refusal(name: "page.html", size: 2_000), "That kind of file can’t be shared here", "HTML never")
        equal(TeamChatFiles.refusal(name: "big.png", size: 11 * 1024 * 1024), "Files are 10 MB at most", "the cap")
        let path = TeamChatFiles.path(channelId: ch.uppercased(), userId: "BBBBBBBB-0000-4000-8000-000000000009", fileName: "Photo.HEIC", id: UUID(uuidString: "DDDDDDDD-0000-4000-8000-000000000001")!)
        equal(path, "\(ch)/bbbbbbbb-0000-4000-8000-000000000009/dddddddd-0000-4000-8000-000000000001.heic", "the channel's folder, the person's sub-folder, lower-cased (555's guard)")
        check(TeamChatFiles.isInlineImage(path: "a/b/c.jpg") && !TeamChatFiles.isInlineImage(path: "a/b/c.heic"), "inline images as the web draws them")
        equal(TeamChatFiles.size(3_400_000), "3.2 MB", "sizes")
        equal(TeamChatChannelName.tidy("  ##launch   plans "), "launch plans", "a name as typed, tidied")
        equal(TeamChatChannelName.tidy("#"), nil, "no name")
        equal(PushToken.hex(Data([0x0a, 0xff, 0x00])), "0aff00", "the device token as hex")
    }

    static func pushPayloads() {
        let team: [AnyHashable: Any] = ["aps": ["alert": ["title": "Ana Ruiz in #launch", "body": "Ready"]], "kind": "team_chat", "workspace_id": "W1", "channel_id": ch, "message_id": "M1", "thread_root_id": NSNull()]
        equal(PushRoute.parse(team), .teamChat(workspaceId: "w1", channelId: ch, messageId: "m1", threadRootId: nil), "a team chat push opens its channel at the message")
        var reply = team
        reply["thread_root_id"] = "R1"
        equal(PushRoute.parse(reply), .teamChat(workspaceId: "w1", channelId: ch, messageId: "m1", threadRootId: "r1"), "a reply's opens its thread")
        equal(PushRoute.parse(["kind": "home_message", "workspace_id": "w1", "conversation_id": "h1"]), .homeMessage(workspaceId: "w1", conversationId: "h1"), "the agent's opens the chat")
        equal(PushRoute.parse(["kind": "team_chat", "channel_id": ch]), nil, "no message, no route")
        equal(PushRoute.parse(["aps": ["alert": "x"]]), nil, "someone else's push is not ours")
    }

    static func pushTaps() {
        let route = PushRoute.teamChat(workspaceId: "w2", channelId: ch, messageId: "m1", threadRootId: "r1")
        equal(PushTap.steps(for: route, currentWorkspaceId: "W1", memberOf: ["w1", "w2"]), [.switchWorkspace("w2"), .openTeamChat(channelId: ch, messageId: "m1", threadRootId: "r1")], "another workspace's push switches to it first")
        equal(PushTap.steps(for: route, currentWorkspaceId: "w2", memberOf: ["w1", "w2"]), [.openTeamChat(channelId: ch, messageId: "m1", threadRootId: "r1")], "this workspace's opens at once")
        equal(PushTap.steps(for: route, currentWorkspaceId: "w1", memberOf: ["w1"]), [.openTeamChat(channelId: ch, messageId: "m1", threadRootId: "r1")], "a workspace they left is never switched to")
        equal(PushTap.steps(for: .homeMessage(workspaceId: nil, conversationId: "h1"), currentWorkspaceId: "w1", memberOf: ["w1"]), [.openChat], "the agent's opens the chat")
    }

    static func presentation() {
        let channelPush = PushRoute.teamChat(workspaceId: nil, channelId: ch, messageId: "m1", threadRootId: nil)
        let threadPush = PushRoute.teamChat(workspaceId: nil, channelId: ch, messageId: "m1", threadRootId: "r1")
        check(!PushPresentation.showsBanner(channelPush, onScreen: TeamChatOnScreen(channelId: ch, threadRootId: nil)), "no banner for the channel on screen")
        check(PushPresentation.showsBanner(channelPush, onScreen: TeamChatOnScreen(channelId: ch, threadRootId: "r1")), "a thread open over it: the channel's message banners")
        check(!PushPresentation.showsBanner(threadPush, onScreen: TeamChatOnScreen(channelId: ch, threadRootId: "r1")), "no banner for the thread on screen")
        check(PushPresentation.showsBanner(threadPush, onScreen: TeamChatOnScreen(channelId: ch, threadRootId: nil)), "the channel on screen: its thread's reply banners")
        check(PushPresentation.showsBanner(channelPush, onScreen: nil), "nothing open: a banner")
        check(!PushPresentation.showsBanner(.homeMessage(workspaceId: nil, conversationId: "h1"), onScreen: nil, chatOpen: true), "the chat open: no banner for the agent's message")
    }
}

extension TeamChatTests {
    static func permission() {
        equal(PushSync.action(.allowed, alertsVisible: true, signedIn: true, registered: false), .register, "allowed: register (the server's last-seen moves)")
        equal(PushSync.action(.allowed, alertsVisible: true, signedIn: true, registered: true), .register, "allowed and registered: register again every launch and return")
        equal(PushSync.action(.denied, alertsVisible: false, signedIn: true, registered: true), .remove, "turned off in Settings: the install comes off, so the text, Slack or email goes instead")
        equal(PushSync.action(.allowed, alertsVisible: false, signedIn: true, registered: true), .remove, "allowed but nothing shows (alerts, lock screen, centre all off): off too")
        equal(PushSync.action(.denied, alertsVisible: false, signedIn: true, registered: false), .wait, "nothing registered: nothing to take off")
        equal(PushSync.action(.notDetermined, alertsVisible: false, signedIn: true, registered: false), .wait, "not asked yet: wait for team chat to open")
        equal(PushSync.action(.allowed, alertsVisible: true, signedIn: false, registered: true), .wait, "signed out: the session's end took it off already")
    }

    static func links() {
        equal(TeamChatLinks.safeURL("https://printshop.example/specs")?.host, "printshop.example", "https opens")
        check(TeamChatLinks.safeURL("http://example.test") != nil, "http opens")
        for bad in ["javascript:alert(1)", "tel:5550100", "sms:5550100", "file:///etc/hosts", "dial8://capture", "https://", "not a link"] {
            check(TeamChatLinks.safeURL(bad) == nil, "\(bad) never opens")
        }
    }
}

extension TeamChatMessage {
    func withChannel(_ id: String) -> TeamChatMessage {
        TeamChatMessage(id: self.id, channelId: id, authorMemberId: authorMemberId, threadRootId: threadRootId, clientId: clientId, body: body, createdAt: createdAt)
    }
}
