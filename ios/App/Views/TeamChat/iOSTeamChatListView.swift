//
//  iOSTeamChatListView.swift
//  Native Intelligence
//
//  Team chat's list: the channels and DMs the person may read here, unread
//  first, each with its badge (a mention louder; a muted channel shows only
//  its mentions). A long press sets how loud a channel is. "+" starts a DM or
//  makes a channel.
//

import SwiftUI

struct iOSTeamChatListView: View {
    @ObservedObject var store: TeamChatStore = .shared
    @State private var showingNewChannel = false
    @State private var showingNewDM = false
    @State private var creationError: String?

    private var channels: [TeamChatChannel] { store.channels.filter { $0.kind == .channel } }
    private var dms: [TeamChatChannel] { store.channels.filter { $0.kind == .dm } }

    var body: some View {
        List {
            if let error = store.errorMessage, !store.hasLoaded {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .listRowBackground(TeamChatStyle.background)
            }
            if !channels.isEmpty {
                Section {
                    ForEach(channels) { row($0) }
                } header: {
                    sectionHeader("Channels")
                }
            }
            if !dms.isEmpty {
                Section {
                    ForEach(dms) { row($0) }
                } header: {
                    sectionHeader("Direct messages")
                }
            }
            if store.hasLoaded && store.channels.isEmpty {
                Text("No conversations yet.")
                    .font(.system(size: 15))
                    .foregroundStyle(.secondary)
                    .listRowBackground(TeamChatStyle.background)
                    .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(TeamChatStyle.background)
        .navigationTitle("Team chat")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { showingNewDM = true } label: { Label("New message", systemImage: "square.and.pencil") }
                    Button { showingNewChannel = true } label: { Label("New channel", systemImage: "number") }
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("New conversation")
            }
        }
        .overlay {
            if !store.hasLoaded && store.isLoading { ProgressView() }
        }
        .refreshable { await store.refresh() }
        .task {
            guard !store.isFixture else { return }
            await store.refresh()
            // The moment notifications mean something: the first time team chat opens.
            await PushNotificationService.shared.askIfUndecided()
        }
        .sheet(isPresented: $showingNewChannel) {
            iOSTeamChatNewChannelSheet(store: store) { id in
                TeamChatRouter.shared.path.append(.channel(id: id, focus: nil))
            }
        }
        .sheet(isPresented: $showingNewDM) {
            iOSTeamChatNewDMSheet(store: store) { id in
                TeamChatRouter.shared.path.append(.channel(id: id, focus: nil))
            }
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 15))
            .foregroundStyle(.secondary)
            .textCase(nil)
    }

    private func row(_ c: TeamChatChannel) -> some View {
        NavigationLink(value: TeamChatRoute.channel(id: c.id, focus: nil)) {
            iOSTeamChatChannelRow(channel: c, store: store)
        }
        .listRowBackground(TeamChatStyle.background)
        .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
        .contextMenu {
            TeamChatNotifyLevelButtons(channel: c, store: store)
        }
    }
}

/// The three levels as plain buttons (a context menu's section).
struct TeamChatNotifyLevelButtons: View {
    let channel: TeamChatChannel
    @ObservedObject var store: TeamChatStore

    var body: some View {
        Section("Notify me about") {
            ForEach(TeamChatNotifyLevel.allCases, id: \.self) { level in
                Button {
                    Task { await store.setNotify(channelId: channel.id, level: level) }
                } label: {
                    if channel.notify == level { Label(level.label, systemImage: "checkmark") } else { Text(level.label) }
                }
            }
        }
    }
}

struct iOSTeamChatChannelRow: View {
    let channel: TeamChatChannel
    @ObservedObject var store: TeamChatStore

    private var badge: TeamChatRowBadge { TeamChatUnread.rowBadge(channel) }
    private var isUnread: Bool { badge != .none }

    var body: some View {
        HStack(spacing: 14) {
            leading
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(store.title(of: channel))
                        .font(.system(size: 17, weight: isUnread ? .semibold : .regular))
                        .lineLimit(1)
                        .foregroundStyle(channel.notify == .muted && !isUnread ? .secondary : .primary)
                    if channel.notify == .muted {
                        Image(systemName: "bell.slash")
                            .font(.system(size: 12))
                            .foregroundStyle(.tertiary)
                            .accessibilityLabel("Muted")
                    }
                }
                if let topic = channel.topic, !topic.isEmpty {
                    Text(topic).font(.system(size: 14)).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 4) {
                Text(TeamChatFormat.listTime(channel.lastMessageAt))
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                badgeView
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var leading: some View {
        if channel.kind == .dm {
            TeamChatAvatar(member: channel.dmMemberId.flatMap { store.members[$0] }, size: 40)
        } else {
            Image(systemName: "number")
                .font(.system(size: 17, weight: .regular))
                .foregroundStyle(.primary)
                .frame(width: 40, height: 40)
                .background(TeamChatStyle.tile, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        }
    }

    @ViewBuilder
    private var badgeView: some View {
        switch badge {
        case .none:
            Color.clear.frame(width: 1, height: 18)
        case let .unread(n):
            Text(n > 99 ? "99+" : "\(n)")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color(.systemBackground))
                .padding(.horizontal, 6)
                .frame(minWidth: 20, minHeight: 20)
                .background(Capsule().fill(Color.primary))
                .accessibilityLabel("\(n) unread")
        case let .mentions(n):
            Text("@\(n > 99 ? "99+" : "\(n)")")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(.black)
                .padding(.horizontal, 6)
                .frame(minWidth: 20, minHeight: 20)
                .background(Capsule().fill(TeamChatStyle.mention))
                .accessibilityLabel("\(n) mentioning you")
        }
    }
}

// MARK: - New channel

struct iOSTeamChatNewChannelSheet: View {
    @ObservedObject var store: TeamChatStore
    let onCreated: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var topic = ""
    @State private var working = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Topic (optional)", text: $topic, axis: .vertical)
                        .lineLimit(1...3)
                } footer: {
                    Text(error ?? "Everyone in the workspace can find and join it.")
                        .foregroundStyle(error == nil ? Color.secondary : Color(.systemRed))
                }
            }
            .navigationTitle("New channel")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { create() }
                        .disabled(TeamChatChannelName.tidy(name) == nil || topic.count > 250 || working)
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func create() {
        guard let tidy = TeamChatChannelName.tidy(name) else { return }
        working = true
        Task {
            defer { working = false }
            do {
                let id = try await store.createChannel(name: tidy, topic: topic.trimmingCharacters(in: .whitespacesAndNewlines))
                dismiss()
                onCreated(id)
            } catch let TeamChatAPIError.http(status, message) {
                error = status == 409 ? "A channel called #\(tidy) already exists." : message
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

// MARK: - New DM

struct iOSTeamChatNewDMSheet: View {
    @ObservedObject var store: TeamChatStore
    let onOpened: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var error: String?

    private var people: [TeamChatMember] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let named = store.memberList.filter { $0.displayName != nil }
        guard !q.isEmpty else { return named }
        return named.filter { $0.name.lowercased().contains(q) }
    }

    var body: some View {
        NavigationStack {
            List {
                if let error {
                    Text(error).font(.footnote).foregroundStyle(Color(.systemRed))
                }
                ForEach(people) { person in
                    Button {
                        open(person)
                    } label: {
                        HStack(spacing: 12) {
                            TeamChatAvatar(member: person, size: 34)
                            Text(person.id == store.me ? "\(person.name) (you)" : person.name)
                                .font(.system(size: 17))
                                .foregroundStyle(.primary)
                            Spacer()
                        }
                    }
                }
            }
            .listStyle(.plain)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Find someone")
            .navigationTitle("New message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }

    private func open(_ person: TeamChatMember) {
        Task {
            do {
                let id = try await store.openDM(with: person.id)
                dismiss()
                onOpened(id)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
