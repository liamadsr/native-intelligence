//
//  iOSNotesHomeView.swift
//  Native Intelligence
//
//  Primary home screen for iOS.
//
//  LAYOUT (both regions live in ONE ScrollView so they scroll together):
//
//    ┌ header region ────────────────── slightly lighter than the list
//    │  [search]                                  [avatar]  ← glass controls
//    │  Good morning, Liam                                  ← serif greeting
//    │  Coming up
//    │  ┌──────────────────────────────────────────────┐
//    │  │ [SEP/11]  Standup                            │    ← date tile + event
//    │  │           11:00 · 7 attendees                │
//    │  └──────────────────────────────────────────────┘
//    ├ list region ─────────────────────  straight edge, no rounding/shadow
//    │  Action items                        See all ›
//    │  ○ Ship the thing                 Due today
//    │  Today
//    │  [icon] Discovery call            9:09 PM
//    └ …
//    [ Ask anything            🎤 ]  ( + )                  ← safeAreaInset
//
//  The custom header owns the top in normal mode (the navigation bar is hidden);
//  search mode restores the bar so the principal search field and Cancel work as
//  they always did.
//

import SwiftUI

struct iOSNotesHomeView: View {
    @Binding var showingRecordingSheet: Bool
    @Binding var showingChat: Bool

    @StateObject private var notesService = NotesService.shared
    @StateObject private var actionsService = ActionsService.shared
    @StateObject private var searchService = SearchService.shared
    @StateObject private var recordingService = iOSRecordingService.shared
    @StateObject private var calendarService = CalendarAPIService.shared
    @StateObject private var workspaceService = WorkspaceService.shared
    @StateObject private var watchIngestService = WatchCaptureIngestService.shared
    @State private var isSearchActive = false
    @FocusState private var isSearchFieldFocused: Bool
    @State private var showingAccountSheet = false
    @ObservedObject private var teamChatRouter = TeamChatRouter.shared
    @ObservedObject private var teamChat = TeamChatStore.shared

    /// Surfaced when a completion write fails (tapping before workspace
    /// bootstrap resolves, an expired token, a 0-row match…). Same treatment as
    /// the Todo tab, which this screen links to via "See all".
    @State private var actionErrorMessage: String? = nil

    /// Whether the workspace context (workspace + team + default column) has
    /// resolved. Every action write needs it.
    private var isWorkspaceReady: Bool {
        workspaceService.isReady
    }

    // MARK: - Palette
    //
    // Two flat regions, the header a step lighter than the list. Every value is
    // a dynamic UIColor so light mode gets the inverse relationship (a white
    // list under a grouped-grey header) instead of a hard-coded dark value.

    /// Header region — #2A2A2A dark / #F2F2F7 light.
    private static let headerBackground = Color(UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.164, green: 0.164, blue: 0.164, alpha: 1)   // #2A2A2A
            : UIColor(red: 0.949, green: 0.949, blue: 0.969, alpha: 1)   // #F2F2F7
    })

    /// List region — #1A1A1A dark / #FFFFFF light.
    private static let listBackground = Color(UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.102, green: 0.102, blue: 0.102, alpha: 1)   // #1A1A1A
            : UIColor.white
    })

    /// Coming-up card fill — #1C1C1E dark / #FFFFFF light.
    private static let cardBackground = Color(UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.110, green: 0.110, blue: 0.118, alpha: 1)   // #1C1C1E
            : UIColor.white
    })

    /// Icon / date tile fill — #2C2C2E dark / #F2F2F7 light.
    private static let tileBackground = Color(UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.173, green: 0.173, blue: 0.180, alpha: 1)   // #2C2C2E
            : UIColor(red: 0.949, green: 0.949, blue: 0.969, alpha: 1)   // #F2F2F7
    })

    /// The card needs an edge in light mode (white on white); in dark the fill
    /// already separates it from the header, so the border resolves to clear.
    private static let cardBorder = Color(UIColor { traits in
        traits.userInterfaceStyle == .dark ? .clear : UIColor.separator
    })

    /// Active actions (confirmed + in progress), limited for the home view.
    /// AI suggestions are deliberately NOT here — they are proposals, and get
    /// their own hint line below.
    private var activeActions: [Action] {
        actionsService.actions
            .filter { ($0.status == .confirmed || $0.status == .inProgress) && !$0.isDismissed }
            .sorted { ($0.dueAt ?? .distantFuture) < ($1.dueAt ?? .distantFuture) }
    }

    /// Pending AI suggestions (`confirmation = 'suggested'`, not dismissed).
    /// Reviewed on the Todo tab, counted here.
    private var suggestedActionCount: Int {
        actionsService.actions
            .filter { $0.status == .suggested && !$0.isDismissed }
            .count
    }

    var body: some View {
        NavigationStack(path: $teamChatRouter.path) {
            VStack(spacing: 0) {
                // Search filter chips (when search is active)
                if isSearchActive {
                    searchFilterBar
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                }

                if isSearchActive {
                    searchContentArea
                } else {
                    notesContentArea
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            // The custom header owns the top in normal mode; search mode needs the
            // real bar back for the principal field and Cancel.
            .toolbar(isSearchActive ? .visible : .hidden, for: .navigationBar)
            .toolbar {
                if isSearchActive {
                    ToolbarItem(placement: .principal) {
                        HStack(spacing: 6) {
                            Image(systemName: "magnifyingglass")
                                .foregroundStyle(.secondary)
                            TextField("Search projects, meetings, actions...", text: $searchService.searchText)
                                .focused($isSearchFieldFocused)
                            if !searchService.searchText.isEmpty {
                                Button {
                                    searchService.searchText = ""
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .padding(8)
                        .background(Color(.systemGray6))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Cancel") {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                isSearchActive = false
                                isSearchFieldFocused = false
                                searchService.clearSearch()
                            }
                        }
                        .font(.body)
                    }
                }
            }
            .task {
                if notesService.allNotesForSearch.isEmpty {
                    await notesService.fetchAllNotesForSearch()
                }
                if actionsService.actions.isEmpty {
                    _ = try? await actionsService.fetchActions()
                }
                await calendarService.refresh()
                Task.detached {
                    await searchService.ensureDataLoaded()
                }
            }
            .navigationDestination(for: TeamChatRoute.self) { route in
                switch route {
                case .list:
                    iOSTeamChatListView()
                case let .channel(id, focus):
                    iOSTeamChatConversationView(channelId: id, focus: focus)
                        .id("\(id):\(focus ?? "")")
                case let .thread(channelId, rootId, focus):
                    iOSTeamChatThreadView(channelId: channelId, rootId: rootId, focus: focus)
                        .id("\(rootId):\(focus ?? "")")
                }
            }
            .sheet(isPresented: $showingAccountSheet) {
                NavigationStack {
                    iOSSettingsTab()
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                Button("Done") { showingAccountSheet = false }
                            }
                        }
                }
            }
        }
    }

    // MARK: - Notes Content Area

    private var notesContentArea: some View {
        ScrollView {
            VStack(spacing: 0) {
                headerRegion

                listRegion
            }
        }
        // Two static layers behind the scroll view. The list colour owns
        // everything from the safe-area top edge down (behind short content and
        // under the bottom bar); the charcoal underneath is only ever visible
        // above that edge — the status bar / Dynamic Island band — so the header
        // block reads as one uninterrupted charcoal surface up to the very top.
        // Scrolled list content still paints its own colour under the status bar.
        .background(Self.listBackground, ignoresSafeAreaEdges: [.horizontal, .bottom])
        .background(Self.headerBackground)
        .scrollIndicators(.hidden)
        .refreshable {
            await notesService.fetchAllNotesForSearch()
            _ = try? await actionsService.fetchActions()
            await calendarService.refresh()
        }
        .safeAreaInset(edge: .bottom) {
            bottomActionBar
        }
    }

    // MARK: - Header Region

    private var headerRegion: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerControls
                .padding(.horizontal, 16)
                .padding(.top, 8)

            Text(greeting)
                .font(.system(size: 36, weight: .regular, design: .serif))
                .foregroundStyle(.primary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 24)
                .padding(.top, 28)

            Text("Coming up")
                .font(.system(size: 17))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 24)
                .padding(.top, 40)
                .padding(.bottom, 10)

            comingUpCard
                .padding(.horizontal, 16)
        }
        .padding(.bottom, 20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Self.headerBackground)
    }

    /// Left: a glass circle for search. Right: a glass circle with the avatar.
    /// Projects and contacts are reached through search results, so they don't
    /// get dedicated buttons; the phone button went with the decision to do
    /// virtual-meeting capture through bots rather than in-app calling.
    private var headerControls: some View {
        HStack(spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isSearchActive = true
                    isSearchFieldFocused = true
                }
            } label: {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 20, weight: .regular))
                    .foregroundStyle(.primary)
                    .frame(width: 44, height: 44)
                    .contentShape(Circle())
                    .glassEffect(.regular.interactive(), in: .circle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Search")

            Spacer()

            teamChatButton
                .padding(.trailing, 10)

            Button {
                showingAccountSheet = true
            } label: {
                UserAvatarView(size: 30)
                    .frame(width: 30, height: 30)
                    .clipShape(Circle())
                    .frame(width: 44, height: 44)
                    .contentShape(Circle())
                    .glassEffect(.regular.interactive(), in: .circle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Account")
        }
    }

    /// Team chat: a glass circle like its neighbours, with the unread count on it.
    private var teamChatButton: some View {
        let unread = TeamChatUnread.badge(teamChat.channels)
        let mentioned = teamChat.channels.contains { $0.mentions + $0.threadMentions > 0 }
        return Button {
            teamChatRouter.openList()
        } label: {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 18, weight: .regular))
                .foregroundStyle(.primary)
                .frame(width: 44, height: 44)
                .contentShape(Circle())
                .glassEffect(.regular.interactive(), in: .circle)
                .overlay(alignment: .topTrailing) {
                    if unread > 0 {
                        Text(unread > 99 ? "99+" : "\(unread)")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(mentioned ? .black : Color(.systemBackground))
                            .padding(.horizontal, 5)
                            .frame(minWidth: 18, minHeight: 18)
                            .background(Capsule().fill(mentioned ? TeamChatStyle.mention : Color.primary))
                            .offset(x: 4, y: -2)
                    }
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(unread > 0 ? "Team chat, \(unread) unread" : "Team chat")
    }

    // MARK: - Greeting

    /// "Hi Liam" — instead of Granola's "My notes", which would have read as a
    /// straight copy. Liam asked for just "Hi": time-of-day greetings were too
    /// long for a 36pt serif title.
    private var greeting: String {
        if let name = firstName {
            return "Hi \(name)"
        }
        return "Hi"
    }

    /// First word of the workspace member's display name, falling back to the
    /// Supabase profile name. Nil when neither is known — the greeting then
    /// stands on its own rather than saying "Hi there".
    private var firstName: String? {
        var candidates: [String] = []
        if let member = workspaceService.activeMember?.displayName {
            candidates.append(member)
        }
        let metadata = SupabaseManager.shared.currentUser?.userMetadata ?? [:]
        for key in ["full_name", "name"] {
            if let value = metadata[key], case let .string(text) = value {
                candidates.append(text)
            }
        }
        for candidate in candidates {
            let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
            if let first = trimmed.split(separator: " ").first, !first.isEmpty {
                return String(first)
            }
        }
        return nil
    }

    // MARK: - Coming Up Card

    /// The first upcoming capture, or a neutral empty/loading state. Tapping
    /// opens the capture's note when we already hold it locally; otherwise the
    /// card is inert (there is nothing to navigate to for a meeting that hasn't
    /// been recorded yet).
    @ViewBuilder
    private var comingUpCard: some View {
        if let capture = calendarService.upcoming.first {
            if let note = notesService.allNotesForSearch.first(where: { $0.id == capture.id }) {
                NavigationLink {
                    iOSNoteDetailView(note: note)
                } label: {
                    comingUpCardBody(capture)
                }
                .buttonStyle(.plain)
            } else {
                comingUpCardBody(capture)
            }
        } else if calendarService.isLoading {
            comingUpPlaceholder
        } else {
            comingUpEmpty
        }
    }

    private func comingUpCardBody(_ capture: UpcomingCapture) -> some View {
        cardShell {
            HStack(spacing: 16) {
                dateTile(for: capture.scheduledStart)

                VStack(alignment: .leading, spacing: 4) {
                    Text(capture.title)
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    Text(subtitle(for: capture))
                        .font(.system(size: 17))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 0)
            }
        }
    }

    /// "11:00 · 7 attendees" — the attendee clause is dropped entirely at 0.
    private func subtitle(for capture: UpcomingCapture) -> String {
        var parts: [String] = []
        if let start = capture.scheduledStart {
            parts.append(start.formatted(date: .omitted, time: .shortened))
        }
        if capture.participantCount > 0 {
            parts.append("\(capture.participantCount) attendee\(capture.participantCount == 1 ? "" : "s")")
        }
        return parts.joined(separator: " · ")
    }

    /// 66×66 tile: uppercase month abbreviation in red over a serif day number.
    private func dateTile(for date: Date?) -> some View {
        VStack(spacing: 2) {
            Text(date.map { Self.monthFormatter.string(from: $0).uppercased() } ?? "—")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Color(.systemRed))

            Text(date.map { Self.dayFormatter.string(from: $0) } ?? "–")
                .font(.system(size: 26, weight: .regular, design: .serif))
                .foregroundStyle(.primary)
        }
        .frame(width: 66, height: 66)
        .background(Self.tileBackground, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var comingUpEmpty: some View {
        cardShell {
            HStack(spacing: 16) {
                Image(systemName: "calendar")
                    .font(.system(size: 24, weight: .regular))
                    .foregroundStyle(.secondary)
                    .frame(width: 66, height: 66)
                    .background(Self.tileBackground, in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                Text("No upcoming meetings")
                    .font(.system(size: 17))
                    .foregroundStyle(.secondary)

                Spacer(minLength: 0)
            }
        }
    }

    /// Shape-identical to the real card so nothing jumps when data lands.
    private var comingUpPlaceholder: some View {
        cardShell {
            HStack(spacing: 16) {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Self.tileBackground)
                    .frame(width: 66, height: 66)

                VStack(alignment: .leading, spacing: 8) {
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .fill(Self.tileBackground)
                        .frame(width: 160, height: 18)
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .fill(Self.tileBackground)
                        .frame(width: 110, height: 14)
                }

                Spacer(minLength: 0)
            }
        }
        .redacted(reason: .placeholder)
    }

    private func cardShell<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Self.cardBackground, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .strokeBorder(Self.cardBorder, lineWidth: 0.5)
            )
    }

    private static let monthFormatter: DateFormatter = {
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("MMM")
        return f
    }()

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("d")
        return f
    }()

    // MARK: - List Region

    private var listRegion: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let actionErrorMessage {
                Text(actionErrorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 24)
                    .padding(.top, 16)
            }

            actionItemsSection

            // A Watch recording is still arriving, or has arrived and is being
            // turned into a capture. Its capture row deliberately doesn't exist
            // yet — nothing is created server-side until every chunk is here —
            // so without this the app looks idle for the whole handoff.
            if let status = watchIngestService.statusText {
                // Shown for a FAILED recording too, without the spinner: a
                // give-up the user never sees reads as a recording that silently
                // disappeared.
                watchIngestRow(status, isWorking: watchIngestService.isBusy)
            }

            ForEach(groupedNotes, id: \.day) { group in
                noteGroup(group)
            }

            if notesService.allNotesForSearch.isEmpty && !notesService.isLoading {
                ContentUnavailableView(
                    "No notes yet",
                    systemImage: "note.text",
                    description: Text("Record a meeting or voice note to get started")
                )
                .padding(.top, 40)
            }

            // Clearance for the bottom bar.
            Color.clear.frame(height: 110)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Self.listBackground)
    }

    /// Deliberately shaped like `noteRow`: same 44pt leading tile, same text
    /// metrics, same padding — it reads as the row the capture is about to
    /// become, not as a banner bolted on top of the list.
    ///
    /// `status` rather than a fixed string: a recording whose chunks are still
    /// landing says "syncing", and only a complete one says "processing". Same
    /// neutral `.secondary` treatment either way — no accent colour marks the
    /// difference, because it is a phase of one quiet operation, not a state the
    /// user has to act on.
    private func watchIngestRow(_ status: String, isWorking: Bool) -> some View {
        HStack(spacing: 16) {
            Image(systemName: "applewatch")
                .font(.system(size: 18, weight: .regular))
                .foregroundStyle(.secondary)
                .frame(width: 44, height: 44)
                .background(Self.tileBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            Text(status)
                .font(.system(size: 17, weight: .semibold))
                .lineLimit(1)
                .foregroundStyle(.secondary)

            Spacer(minLength: 0)

            if isWorking {
                ProgressView()
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .padding(.top, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Search Filter Bar

    private var searchFilterBar: some View {
        HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(SearchFilter.allCases, id: \.self) { filter in
                        iOSFilterChip(
                            filter: filter,
                            isActive: searchService.isFilterActive(filter),
                            onTap: { searchService.toggleFilter(filter) }
                        )
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize)

            if searchService.activeFilters.count > 1 {
                Button {
                    searchService.clearSearch()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 20))
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(.primary)
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - Search Content Area

    @ViewBuilder
    private var searchContentArea: some View {
        if searchService.isSearching {
            VStack(spacing: 12) {
                ProgressView()
                Text("Searching...")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if searchService.hasResults {
            searchResultsView
        } else if !searchService.searchText.isEmpty {
            ContentUnavailableView(
                "No Results",
                systemImage: "magnifyingglass",
                description: Text("No matches for \"\(searchService.searchText)\"")
            )
        } else if searchService.hasActiveFilters {
            let filterNames = searchService.activeFilters.map { $0.displayName }.joined(separator: ", ")
            ContentUnavailableView(
                "No Items",
                systemImage: "line.3.horizontal.decrease.circle",
                description: Text("No \(filterNames.lowercased()) found")
            )
        } else if !searchService.recentSearches.isEmpty {
            recentSearchesView
        } else {
            ContentUnavailableView(
                "Search Everything",
                systemImage: "magnifyingglass",
                description: Text("Find projects, meetings, actions, and contacts")
            )
        }
    }

    private var searchResultsView: some View {
        List {
            ForEach(SearchResultType.allCases, id: \.self) { type in
                if let typeResults = searchService.results[type], !typeResults.isEmpty {
                    Section {
                        ForEach(typeResults) { result in
                            NavigationLink {
                                iOSSearchResultDestination(result: result)
                            } label: {
                                iOSSearchResultRow(result: result)
                            }
                        }
                    } header: {
                        HStack(spacing: 6) {
                            if type == .knowledge {
                                Text("SEMANTIC RESULTS")
                                    .foregroundStyle(Color(hex: SearchMode.semantic.color))
                                Text("\(typeResults.count) match\(typeResults.count == 1 ? "" : "es")")
                                    .foregroundStyle(.secondary)
                            } else {
                                Text(type.displayName.uppercased())
                                Text("\(typeResults.count)")
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .font(.caption.weight(.semibold))
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private var recentSearchesView: some View {
        List {
            Section {
                ForEach(searchService.recentSearches, id: \.self) { query in
                    Button {
                        searchService.searchText = query
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "clock")
                                .foregroundStyle(.secondary)
                                .frame(width: 20)
                            Text(query)
                                .foregroundStyle(.primary)
                            Spacer()
                            Image(systemName: "arrow.up.left")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
            } header: {
                HStack {
                    Text("RECENT")
                    Spacer()
                    Button("Clear") {
                        searchService.clearRecentSearches()
                    }
                    .font(.caption)
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    // MARK: - Action Items Section

    private var actionItemsSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Action items")
                    .font(.system(size: 17))
                    .foregroundStyle(.secondary)
                Spacer()
                NavigationLink {
                    iOSTodoTab(showingRecordingSheet: $showingRecordingSheet)
                } label: {
                    HStack(spacing: 4) {
                        Text("See all")
                            .font(.system(size: 15))
                        Image(systemName: "chevron.right")
                            .font(.caption2)
                    }
                    .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 24)
            .padding(.top, 24)
            .padding(.bottom, 8)

            // Suggestions never count as active work, but they shouldn't be
            // invisible either — link into the Todo tab where they're reviewed.
            if suggestedActionCount > 0 {
                NavigationLink {
                    iOSTodoTab(showingRecordingSheet: $showingRecordingSheet)
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "sparkles")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("\(suggestedActionCount) suggestion\(suggestedActionCount == 1 ? "" : "s") to review")
                            .font(.system(size: 15))
                            .foregroundStyle(.secondary)
                        Image(systemName: "chevron.right")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 24)
                .padding(.bottom, 4)
            }

            if activeActions.isEmpty && suggestedActionCount == 0 {
                Text("No open action items")
                    .font(.system(size: 17))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 8)
            } else {
                ForEach(activeActions.prefix(5)) { action in
                    actionRow(action)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Same geometry as a note row — a 44pt leading slot, then title over a
    /// secondary line — with the checkbox standing in for the icon tile.
    private func actionRow(_ action: Action) -> some View {
        HStack(spacing: 16) {
            Button {
                toggleActionCompletion(action)
            } label: {
                Image(systemName: action.status == .completed ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 22))
                    .foregroundStyle(action.status == .completed ? Color.primary : Color.secondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!isWorkspaceReady)

            VStack(alignment: .leading, spacing: 3) {
                Text(action.title)
                    .font(.system(size: 17))
                    .lineLimit(1)
                    .foregroundStyle(.primary)

                if let dueAt = action.dueAt {
                    Text(formatActionDue(dueAt))
                        .font(.system(size: 15))
                        .foregroundStyle(dueAt < Date() ? Color(.systemRed) : Color.secondary)
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func toggleActionCompletion(_ action: Action) {
        guard isWorkspaceReady else {
            actionErrorMessage = "Still loading your workspace — try again in a moment."
            return
        }
        Task {
            do {
                // Completion is a board-column move plus a completed_at stamp —
                // there is no `status` column to flip.
                if action.status == .completed {
                    _ = try await actionsService.uncompleteAction(id: action.id)
                } else {
                    _ = try await actionsService.completeAction(id: action.id)
                }
                actionErrorMessage = nil
            } catch {
                actionErrorMessage = "Couldn't update that action: \(error.localizedDescription)"
                print("❌ iOSNotesHomeView: Failed to toggle action completion: \(error)")
            }
        }
    }

    private func formatActionDue(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return "Due today"
        } else if calendar.isDateInTomorrow(date) {
            return "Due tomorrow"
        } else if date < Date() {
            return "Overdue"
        }
        return "Due " + date.formatted(date: .abbreviated, time: .omitted)
    }

    // MARK: - Note Groups

    private struct NoteGroup {
        /// The calendar day this group covers. The identity for `ForEach` —
        /// the rendered title omits the year, so 11 Sep in two different years
        /// would collide on title alone.
        let day: Date
        let title: String
        let notes: [Note]
    }

    /// Today, Yesterday, then ONE dated group per calendar day, newest first.
    /// (The old "Earlier today" / "This week" buckets are gone — a week's worth
    /// of meetings collapsed into a single undated heading.)
    private var groupedNotes: [NoteGroup] {
        let calendar = Calendar.current

        var byDay: [Date: [Note]] = [:]
        for note in notesService.allNotesForSearch {
            let date = note.recordedAt ?? note.createdAt
            byDay[calendar.startOfDay(for: date), default: []].append(note)
        }

        return byDay.keys.sorted(by: >).map { day in
            let title: String
            if calendar.isDateInToday(day) {
                title = "Today"
            } else if calendar.isDateInYesterday(day) {
                title = "Yesterday"
            } else {
                title = Self.groupDateFormatter.string(from: day)
            }
            let notes = (byDay[day] ?? []).sorted {
                ($0.recordedAt ?? $0.createdAt) > ($1.recordedAt ?? $1.createdAt)
            }
            return NoteGroup(day: day, title: title, notes: notes)
        }
    }

    /// "Wed 5 Aug" — template-based so a non-en locale reorders it properly.
    private static let groupDateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("EEE d MMM")
        return f
    }()

    private func noteGroup(_ group: NoteGroup) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(group.title)
                .font(.system(size: 17))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 24)
                .padding(.top, 24)
                .padding(.bottom, 8)

            ForEach(group.notes) { note in
                NavigationLink {
                    iOSNoteDetailView(note: note)
                } label: {
                    noteRow(note)
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// No card, no colour — a monochrome glyph in a neutral tile, the title, and
    /// the time.
    private func noteRow(_ note: Note) -> some View {
        HStack(spacing: 16) {
            Image(systemName: Self.icon(for: note))
                .font(.system(size: 18, weight: .regular))
                .foregroundStyle(.primary)
                .frame(width: 44, height: 44)
                .background(Self.tileBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            VStack(alignment: .leading, spacing: 3) {
                Text(note.title)
                    .font(.system(size: 17, weight: .semibold))
                    .lineLimit(1)
                    .foregroundStyle(.primary)

                HStack(spacing: 6) {
                    Text((note.recordedAt ?? note.createdAt).formatted(date: .omitted, time: .shortened))
                        .font(.system(size: 15))
                        .foregroundStyle(.secondary)

                    // Two different states, and telling them apart is the point.
                    // "Processing…" means the server is working on it and a
                    // summary is coming. "Interrupted" means the recording was
                    // never finished — nothing is coming until the user opens
                    // the note and taps Finish processing.
                    if notesService.isInterrupted(note) {
                        Text("· Interrupted")
                            .font(.system(size: 15))
                            .foregroundStyle(.tertiary)
                    } else if notesService.isProcessing(note) {
                        Text("· Processing…")
                            .font(.system(size: 15))
                            .foregroundStyle(.tertiary)
                    }
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Without an explicit shape the row is only hit-testable where it draws;
        // the gaps between the tile, the title and the trailing space swallowed
        // taps and the push never happened.
        .contentShape(Rectangle())
    }

    /// Outline glyphs only — NoteType.icon is the filled, colour-paired set used
    /// elsewhere and reads wrong in a monochrome tile.
    ///
    /// A phone call is not a NoteType (the `captures` table has no type column at
    /// all — `Note.type` is derived on decode), so it is recognised from the
    /// title prefix the phone-call pipeline writes, or from a capture_mode /
    /// source value parked in `metadata`.
    private static func icon(for note: Note) -> String {
        if isPhoneCall(note) { return "iphone" }
        switch note.type {
        case .meeting: return "person.2"
        case .journal: return "text.book.closed"
        case .idea: return "lightbulb"
        case .webpage: return "globe"
        }
    }

    private static func isPhoneCall(_ note: Note) -> Bool {
        if note.title.lowercased().hasPrefix("phone call") { return true }
        guard let metadata = note.metadata else { return false }
        for key in ["capture_mode", "captureMode", "source", "capture_source"] {
            if case .string(let value)? = metadata[key],
               value.lowercased().contains("phone") {
                return true
            }
        }
        return false
    }

    // MARK: - Bottom Action Bar

    private var bottomActionBar: some View {
        HStack(spacing: 12) {
            askAnythingBar

            Button {
                showingRecordingSheet = true
            } label: {
                Group {
                    if recordingService.hasActiveSession {
                        Image(systemName: "waveform")
                            .font(.system(size: 26, weight: .regular))
                            .foregroundStyle(.white)
                            .frame(width: 60, height: 60)
                            .background(Circle().fill(Color(.systemRed)))
                    } else {
                        Image(systemName: "plus")
                            .font(.system(size: 26, weight: .regular))
                            .foregroundStyle(Color(.systemBackground))
                            .frame(width: 60, height: 60)
                            .background(Circle().fill(Color.primary))
                    }
                }
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(recordingService.hasActiveSession ? "Recording in progress" : "New capture")
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 12)
    }

    /// One capsule, two targets: the body opens the chat, the mic opens it AND
    /// starts dictating. The mic is a Button layered over the capsule's own tap
    /// gesture rather than inside it, so it wins the hit test.
    private var askAnythingBar: some View {
        HStack(spacing: 0) {
            Text("Ask anything")
                .font(.system(size: 20))
                .foregroundStyle(.secondary)
                .padding(.leading, 24)

            Spacer(minLength: 8)

            Button {
                openChatWithDictation()
            } label: {
                Image(systemName: "mic")
                    .font(.system(size: 20, weight: .regular))
                    .foregroundStyle(.primary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Ask by voice")
            // 44pt touch target, 20pt of visual clearance to the capsule edge.
            .padding(.trailing, 20 - 12)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 60)
        .contentShape(Capsule())
        .glassEffect(.regular.interactive(), in: .capsule)
        .onTapGesture {
            showingChat = true
        }
    }

    /// Present the chat, then ask it to start listening. The sheet's content may
    /// not be mounted when the notification fires, so the same intent is parked
    /// on ChatSessionStore for the surface's `.onAppear` to pick up — whichever
    /// arrives first clears the flag.
    private func openChatWithDictation() {
        ChatSessionStore.shared.pendingDictationStart = true
        showingChat = true
        NotificationCenter.default.post(name: .startChatDictation, object: nil)
    }
}
