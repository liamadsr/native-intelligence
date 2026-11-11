//
//  iOSTeamChatConversationView.swift
//  Native Intelligence
//
//  A channel or a DM: its messages (older ones load as you scroll up), live,
//  read while on screen; opened at a message from a push, scrolled there and
//  marked for a moment. The composer sits at the bottom; the toolbar's bell
//  sets how loud it is.
//
//  The thread view is the same list for one thread: its root on top, then
//  its replies, and a composer that replies there.
//

import SwiftUI

struct iOSTeamChatConversationView: View {
    @StateObject private var model: TeamChatConversationModel
    @ObservedObject private var store: TeamChatStore

    init(channelId: String, focus: String? = nil, store: TeamChatStore? = nil) {
        let store = store ?? .shared
        _model = StateObject(wrappedValue: TeamChatConversationModel(channelId: channelId, focusMessageId: focus, store: store))
        self.store = store
    }

    #if DEBUG
    /// The DEBUG preview's: a model already filled.
    init(model: TeamChatConversationModel) {
        _model = StateObject(wrappedValue: model)
        store = model.store
    }
    #endif

    private var channel: TeamChatChannel? { store.channel(model.channelId) }

    var body: some View {
        TeamChatMessageList(model: model, header: { EmptyView() }) { message in
            TeamChatRouter.shared.path.append(.thread(channelId: model.channelId, rootId: message.id, focus: nil))
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 0) {
                if model.state.hasNewer {
                    Button {
                        Task { await model.jumpToNewest() }
                    } label: {
                        Label("Newest messages", systemImage: "arrow.down")
                            .font(.system(size: 14, weight: .semibold))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .glassEffect(.regular.interactive(), in: .capsule)
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 6)
                }
                iOSTeamChatComposer(model: model, placeholder: placeholder)
            }
        }
        .navigationTitle(channel.map(store.title(of:)) ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let channel {
                ToolbarItem(placement: .topBarTrailing) {
                    TeamChatNotifyMenu(channel: channel, store: store) {
                        Image(systemName: channel.notify == .muted ? "bell.slash" : channel.notify == .all ? "bell.badge" : "bell")
                    }
                    .accessibilityLabel("Notifications: \(channel.notify.label)")
                }
            }
        }
    }

    private var placeholder: String {
        guard let channel else { return "Message" }
        return "Message \(store.title(of: channel))"
    }
}

struct iOSTeamChatThreadView: View {
    @StateObject private var model: TeamChatConversationModel
    @ObservedObject private var store: TeamChatStore

    init(channelId: String, rootId: String, focus: String? = nil, store: TeamChatStore? = nil) {
        let store = store ?? .shared
        _model = StateObject(wrappedValue: TeamChatConversationModel(channelId: channelId, threadRootId: rootId, focusMessageId: focus, store: store))
        self.store = store
    }

    #if DEBUG
    init(model: TeamChatConversationModel) {
        _model = StateObject(wrappedValue: model)
        store = model.store
    }
    #endif

    var body: some View {
        TeamChatMessageList(model: model, header: { rootHeader }, openThread: nil)
            .safeAreaInset(edge: .bottom) {
                iOSTeamChatComposer(model: model, placeholder: "Reply…")
            }
            .navigationTitle("Thread")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let channel = store.channel(model.channelId) {
                    ToolbarItem(placement: .principal) {
                        VStack(spacing: 0) {
                            Text("Thread").font(.system(size: 16, weight: .semibold))
                            Text(store.title(of: channel)).font(.system(size: 12)).foregroundStyle(.secondary)
                        }
                    }
                }
            }
    }

    @ViewBuilder
    private var rootHeader: some View {
        if let root = model.state.root {
            VStack(alignment: .leading, spacing: 0) {
                iOSTeamChatMessageRow(
                    shown: TeamChatShownMessage(message: root, isSending: false, failed: false),
                    continues: false, model: model, openThread: nil, showsThreadActions: false
                )
                HStack(spacing: 10) {
                    let n = model.state.rows.count
                    Text(n == 1 ? "1 reply" : "\(n) replies").font(.system(size: 13)).foregroundStyle(.secondary)
                    Rectangle().fill(Color(.separator)).frame(height: 0.5)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }
        }
    }
}

/// The scrolling list both share: day dividers, runs of one author, older pages on the way up,
/// the newest at the bottom, a focused message scrolled to.
struct TeamChatMessageList<Header: View>: View {
    @ObservedObject var model: TeamChatConversationModel
    @ViewBuilder var header: () -> Header
    var openThread: ((TeamChatMessage) -> Void)?

    @State private var highlighted: String?
    @State private var scrolledToFocus = false

    var body: some View {
        let items = model.shown
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    header()
                    if model.threadRootId == nil {
                        if model.state.hasOlder && model.hasLoaded {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                                .onAppear { Task { await model.loadOlder() } }
                        } else if model.hasLoaded {
                            beginning
                        }
                    }
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                        let previous = index > 0 ? items[index - 1].message : nil
                        if previous == nil || !TeamChatFormat.sameDay(previous!.createdAt, item.message.createdAt) {
                            dayDivider(item.message.createdAt)
                        }
                        iOSTeamChatMessageRow(
                            shown: item,
                            continues: TeamChatTimeline.continues(previous, item.message) && !(previous.map { !TeamChatFormat.sameDay($0.createdAt, item.message.createdAt) } ?? false),
                            model: model,
                            highlighted: highlighted == item.message.id,
                            summary: model.state.threads[item.message.id],
                            openThread: openThread
                        )
                        .id(item.id)
                    }
                    Color.clear.frame(height: 8).id("bottom")
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .background(TeamChatStyle.background)
            .overlay {
                if !model.hasLoaded && model.isLoading { ProgressView() }
                if let error = model.errorMessage, !model.hasLoaded {
                    Text(error).font(.footnote).foregroundStyle(.secondary).padding()
                }
            }
            .onChange(of: items.last?.id) { _, _ in
                guard model.focusMessageId == nil || scrolledToFocus else { return }
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: model.hasLoaded) { _, loaded in
                guard loaded else { return }
                scrollToFocus(proxy, items: model.shown)
            }
            .onAppear {
                model.appeared()
                if model.hasLoaded { scrollToFocus(proxy, items: items) }
            }
            .onDisappear { model.disappeared() }
            .alert("Team chat", isPresented: Binding(get: { model.hasLoaded && model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })) {
                Button("OK", role: .cancel) { model.errorMessage = nil }
            } message: {
                Text(model.errorMessage ?? "")
            }
        }
    }

    private func scrollToFocus(_ proxy: ScrollViewProxy, items: [TeamChatShownMessage]) {
        guard let focus = model.focusMessageId, !scrolledToFocus, let item = items.first(where: { $0.message.id == focus }) else { return }
        scrolledToFocus = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            proxy.scrollTo(item.id, anchor: .center)
            highlighted = focus
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                withAnimation(.easeOut(duration: 0.6)) { highlighted = nil }
            }
        }
    }

    private func dayDivider(_ raw: String) -> some View {
        HStack(spacing: 10) {
            Rectangle().fill(Color(.separator)).frame(height: 0.5)
            Text(TeamChatFormat.dayTitle(raw)).font(.system(size: 13, weight: .medium)).foregroundStyle(.secondary).fixedSize()
            Rectangle().fill(Color(.separator)).frame(height: 0.5)
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 2)
    }

    @ViewBuilder
    private var beginning: some View {
        if let channel = model.channel {
            VStack(alignment: .leading, spacing: 4) {
                Text(model.store.title(of: channel))
                    .font(.system(size: 26, weight: .regular, design: .serif))
                if let topic = channel.topic, !topic.isEmpty {
                    Text(topic).font(.system(size: 15)).foregroundStyle(.secondary)
                }
                Text("Type @\(model.store.agentName) to ask your agent; it answers here.")
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 6)
        }
    }
}
