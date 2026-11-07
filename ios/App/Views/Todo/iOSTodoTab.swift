import SwiftUI

struct iOSTodoTab: View {
    @Binding var showingRecordingSheet: Bool

    @StateObject private var recordingService = iOSRecordingService.shared
    @StateObject private var actionsService = ActionsService.shared
    @StateObject private var searchService = SearchService.shared
    @StateObject private var workspaceService = WorkspaceService.shared
    @State private var collapsedSections: Set<String> = []
    @State private var isSearchActive = false
    @State private var showingAccountSheet = false
    @FocusState private var isSearchFieldFocused: Bool

    // Filter state
    @State private var showTracking = false
    @State private var selectedStatuses: Set<ActionStatus> = [.confirmed, .inProgress]

    // Inline editing state
    @State private var editingActionId: UUID? = nil
    @State private var editingTitle: String = ""
    @FocusState private var focusedActionId: UUID?
    @State private var detailAction: Action? = nil
    @State private var showingDetail = false

    // New action creation
    @State private var newActionTitle: String = ""
    @State private var newActionPriority: ActionPriority = .none
    @State private var newActionDueAt: Date? = nil
    @State private var newActionAllDay: Bool = true
    @FocusState private var isNewActionFocused: Bool
    @State private var showingCustomDatePicker = false
    @State private var hasFinishedInitialLoad = false

    // AI suggestions (confirmation = 'suggested')
    @State private var suggestionsCollapsed = false
    @State private var busySuggestionIds: Set<UUID> = []

    // Surfaced when a write fails (creating before bootstrap, a 0-row match…)
    @State private var actionErrorMessage: String? = nil

    private var showCaptureButton: Bool {
        !isSearchActive && editingActionId == nil && !isNewActionFocused && hasFinishedInitialLoad
    }


    var body: some View {
        // No NavigationStack of its own: this screen is PUSHED from Home, and a
        // nested stack swallows the back button.
        Group {
            VStack(spacing: 0) {
                // Search filter chips (when search is active)
                if isSearchActive {
                    searchFilterBar
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                }

                // Main content
                if isSearchActive {
                    searchContentArea
                } else {
                    todoContentArea
                }
            }
            .opacity(hasFinishedInitialLoad ? 1 : 0)
            .navigationTitle("Actions")
            .navigationBarTitleDisplayMode(.inline)
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
                } else {
                    // The back button owns topBarLeading now, so the filter
                    // controls move to the trailing side alongside search.
                    ToolbarItem(placement: .topBarTrailing) {
                        HStack(spacing: 4) {
                            ownershipToggle
                            Divider()
                                .frame(height: 16)
                            statusFilterMenu
                            Button {
                                withAnimation(.easeInOut(duration: 0.2)) {
                                    isSearchActive = true
                                    isSearchFieldFocused = true
                                }
                            } label: {
                                Image(systemName: "magnifyingglass")
                                    .font(.body)
                            }
                        }
                    }
                }

            }
            .refreshable {
                _ = try? await actionsService.fetchActions()
            }
            .task {
                if actionsService.actions.isEmpty {
                    _ = try? await actionsService.fetchActions()
                }
                withAnimation(.easeIn(duration: 0.15)) {
                    hasFinishedInitialLoad = true
                }
                // Preload search data in background so search opens instantly
                Task.detached {
                    await searchService.ensureDataLoaded()
                }
            }
            .sheet(isPresented: $showingAccountSheet) {
                NavigationStack {
                    iOSSettingsTab()
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                Button("Done") {
                                    showingAccountSheet = false
                                }
                            }
                        }
                }
            }
            .onChange(of: focusedActionId) { _, newValue in
                if newValue == nil && editingActionId != nil {
                    commitEditing()
                }
            }
            // The inline board-column picker shows the EDITED action's team's
            // columns, so refresh them whenever the edit target changes.
            .task(id: editingTeamId) {
                await loadBoardColumns(for: editingTeamId)
            }
            .overlay(alignment: .bottomTrailing) {
                if showCaptureButton {
                    Button {
                        showingRecordingSheet = true
                    } label: {
                        Group {
                            if recordingService.hasActiveSession {
                                Image(systemName: "mic.fill")
                                    .font(.system(size: 20, weight: .medium))
                                    .foregroundStyle(.white)
                                    .frame(width: 56, height: 56)
                                    .background(Circle().fill(.red))
                            } else {
                                Image(systemName: "mic.fill")
                                    .font(.system(size: 20, weight: .medium))
                                    .foregroundStyle(.primary)
                                    .frame(width: 56, height: 56)
                                    .contentShape(Circle())
                                    .glassEffect(.regular.interactive(), in: .circle)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .padding(.trailing, 20)
                    .padding(.bottom, 24)
                    .transition(.scale.combined(with: .opacity))
                }
            }
            .animation(.easeInOut(duration: 0.2), value: showCaptureButton)
        }
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

    // MARK: - Todo Content Area

    @ViewBuilder
    private var todoContentArea: some View {
        List {
                if let actionErrorMessage {
                    Text(actionErrorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .listRowSeparator(.hidden)
                }

                // AI suggestions sit ABOVE the real work and outside the normal
                // groups: they are proposals, not tasks, until confirmed.
                suggestionsSection

                ForEach(groupedActions) { group in
                    let isCollapsed = collapsedSections.contains(group.id)
                    Section {
                        if !isCollapsed {
                            ForEach(group.actions) { action in
                                let isEditing = editingActionId == action.id
                                iOSActionRow(
                                    action: action,
                                    editingTitle: Binding(
                                        get: { isEditing ? editingTitle : action.title },
                                        set: { editingTitle = $0 }
                                    ),
                                    isEditing: isEditing,
                                    focusedActionId: $focusedActionId,
                                    isCompletionEnabled: isWorkspaceReady,
                                    onToggleComplete: { toggleCompletion(action) },
                                    onInfoTap: {
                                        commitEditing()
                                        detailAction = action
                                        showingDetail = true
                                    }
                                )
                                .contentShape(Rectangle())
                                .onTapGesture {
                                    beginEditing(action)
                                }
                                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                    Button(role: .destructive) {
                                        deleteAction(action)
                                    } label: {
                                        Label("Delete", systemImage: "trash")
                                    }
                                }
                                .listRowSeparator(.hidden)
                            }

                            // Show add row at the bottom of the Today section
                            if group.id == "today" {
                                newActionRow
                            }
                        }
                    } header: {
                        Button {
                            // Commit editing if collapsing the section that contains the editing row
                            if let editingId = editingActionId,
                               group.actions.contains(where: { $0.id == editingId }) {
                                commitEditing()
                            }
                            withAnimation(.snappy(duration: 0.25)) {
                                if isCollapsed {
                                    collapsedSections.remove(group.id)
                                } else {
                                    collapsedSections.insert(group.id)
                                }
                            }
                        } label: {
                            HStack(spacing: 6) {
                                Text(group.title)
                                    .font(.title3.weight(.semibold))
                                Text("\(group.actions.count)")
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(.tertiary)
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(.tertiary)
                                    .rotationEffect(.degrees(isCollapsed ? 0 : 90))
                            }
                            .foregroundStyle(.primary)
                            .textCase(nil)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .listStyle(.plain)
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom) {
                if editingActionId != nil || isNewActionFocused {
                    HStack(spacing: 16) {
                        // Priority menu
                        Menu {
                            ForEach(ActionPriority.allCases, id: \.self) { priority in
                                Button {
                                    applyPriority(priority)
                                } label: {
                                    Label {
                                        Text(priority.displayName)
                                    } icon: {
                                        if priority == currentToolbarPriority {
                                            Image(systemName: "checkmark")
                                        }
                                    }
                                }
                            }
                        } label: {
                            Image(systemName: currentToolbarPriority != .none ? "flag.fill" : "flag")
                                .font(.system(size: 20))
                                .foregroundStyle(currentToolbarPriorityColor)
                                .frame(width: 40, height: 40)
                                .contentShape(Rectangle())
                        }

                        // Due date menu
                        Menu {
                            Button {
                                applyDueDate(Calendar.current.startOfDay(for: Date()), allDay: true)
                            } label: {
                                Label("Today", systemImage: "sun.max")
                            }
                            Button {
                                let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: Date())) ?? Date()
                                applyDueDate(tomorrow, allDay: true)
                            } label: {
                                Label("Tomorrow", systemImage: "sunrise")
                            }
                            Button {
                                applyDueDate(nextSaturday, allDay: true)
                            } label: {
                                Label("This Weekend", systemImage: "sun.horizon")
                            }
                            Button {
                                let nextWeek = Calendar.current.date(byAdding: .weekOfYear, value: 1, to: Calendar.current.startOfDay(for: Date())) ?? Date()
                                applyDueDate(nextWeek, allDay: true)
                            } label: {
                                Label("Next Week", systemImage: "calendar.badge.clock")
                            }
                            Divider()
                            Button {
                                showingCustomDatePicker = true
                            } label: {
                                Label("Custom", systemImage: "ellipsis.circle")
                            }
                            if currentToolbarDueAt != nil {
                                Divider()
                                Button(role: .destructive) {
                                    clearDueDate()
                                } label: {
                                    Label("None", systemImage: "xmark")
                                }
                            }
                        } label: {
                            Image(systemName: currentToolbarDueAt != nil ? "calendar.badge.clock" : "calendar")
                                .font(.system(size: 20))
                                .foregroundStyle(.primary)
                                .frame(width: 40, height: 40)
                                .contentShape(Rectangle())
                        }

                        // Board-column picker (only for existing actions).
                        // These are the team's real workflow states — there is
                        // no free-form status to set.
                        if editingActionId != nil, !boardColumns.isEmpty {
                            Menu {
                                ForEach(boardColumns) { state in
                                    Button {
                                        applyState(state)
                                    } label: {
                                        if currentToolbarStatusId == state.id {
                                            Label(state.name, systemImage: "checkmark")
                                        } else {
                                            Text(state.name)
                                        }
                                    }
                                }
                            } label: {
                                Image(systemName: "arrow.triangle.2.circlepath")
                                    .font(.system(size: 20))
                                    .foregroundStyle(.primary)
                                    .frame(width: 40, height: 40)
                                    .contentShape(Rectangle())
                            }
                        }

                        Spacer()

                        if editingActionId != nil {
                            Button {
                                if let id = editingActionId,
                                   let action = actionsService.actions.first(where: { $0.id == id }) {
                                    commitEditing()
                                    detailAction = action
                                    showingDetail = true
                                }
                            } label: {
                                Image(systemName: "info.circle")
                                    .font(.system(size: 20))
                                    .foregroundStyle(.primary)
                                    .frame(width: 40, height: 40)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 6)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .padding(.horizontal, 12)
                    .padding(.bottom, 6)
                }
            }
            .navigationDestination(isPresented: $showingDetail) {
                if let action = detailAction {
                    iOSActionDetailView(action: action)
                }
            }
            .sheet(isPresented: $showingCustomDatePicker) {
                iOSCustomDatePickerSheet(
                    currentDate: currentToolbarDueAt,
                    allDay: currentToolbarAllDay,
                    onSelect: { date, allDay in
                        applyDueDate(date, allDay: allDay)
                        showingCustomDatePicker = false
                    },
                    onClear: {
                        clearDueDate()
                        showingCustomDatePicker = false
                    }
                )
                .presentationDetents([.medium])
            }
    }

    // MARK: - Ownership Toggle (My Actions / Tracking)

    private var ownershipToggle: some View {
        Menu {
            Button {
                withAnimation { showTracking = false }
            } label: {
                if !showTracking { Label("My Actions", systemImage: "checkmark") }
                else { Text("My Actions") }
            }
            Button {
                withAnimation { showTracking = true }
            } label: {
                HStack {
                    if showTracking { Label("Tracking", systemImage: "checkmark") }
                    else { Text("Tracking") }
                    if trackedItemCount > 0 {
                        Text("(\(trackedItemCount))")
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(showTracking ? "Tracking" : "My Actions")
                    .font(.subheadline.weight(.medium))
                if showTracking && trackedItemCount > 0 {
                    Text("\(trackedItemCount)")
                        .font(.caption2.weight(.medium))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(.secondary.opacity(0.2))
                        .clipShape(Capsule())
                }
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold))
            }
        }
    }

    // MARK: - Board Columns

    /// The DEFAULT team's workflow states, in board order. Empty until
    /// `WorkspaceService.bootstrap()` resolves, which is why the picker that
    /// uses it is conditional.
    ///
    /// Only ever the seed value for `boardColumns` — see below.
    @MainActor
    private var defaultTeamColumns: [WorkflowState] {
        workspaceService.workflowStatesByID.values
            .sorted { $0.sortOrder < $1.sortOrder }
    }

    /// The board columns the inline picker offers: the EDITED action's own
    /// team's, not the default team's.
    ///
    /// `actions` is workspace-scoped, so an action assigned to me can live in
    /// another team entirely. Offering the default team's columns there wrote a
    /// FOREIGN team's `status_id`, which the board then couldn't render. The
    /// default team's states seed it so the picker is never empty while the
    /// fetch is in flight.
    @State private var boardColumns: [WorkflowState] = []

    /// Whose columns `boardColumns` currently holds — so the loader doesn't
    /// refetch on every body pass.
    @State private var loadedColumnsTeamId: UUID? = nil

    /// The team of the action being edited (nil when nothing is being edited).
    private var editingTeamId: UUID? {
        guard let id = editingActionId else { return nil }
        return actionsService.actions.first(where: { $0.id == id })?.teamId
    }

    /// Load the edited action's team's columns, seeding with the default team's
    /// so the picker has something to show immediately.
    ///
    /// `@MainActor` because it touches `@State` and the `@MainActor`
    /// `WorkspaceService` — `.task` inherits the view's actor either way.
    @MainActor
    private func loadBoardColumns(for teamId: UUID?) async {
        guard let teamId else {
            boardColumns = defaultTeamColumns
            loadedColumnsTeamId = nil
            return
        }

        guard loadedColumnsTeamId != teamId else { return }

        if boardColumns.isEmpty {
            boardColumns = defaultTeamColumns
        }

        do {
            let states = try await workspaceService.states(forTeam: teamId)
            boardColumns = states.sorted { $0.sortOrder < $1.sortOrder }
            loadedColumnsTeamId = teamId
        } catch {
            // Keep the seeded default-team columns rather than emptying the
            // picker — a wrong-team column is still better than no picker, and
            // the move itself will surface any failure.
            boardColumns = defaultTeamColumns
            print("❌ iOSTodoTab: Failed to load board columns for team \(teamId): \(error)")
        }
    }

    // MARK: - AI Suggestions

    /// Non-dismissed AI suggestions (`confirmation = 'suggested'`).
    ///
    /// These never appear in `filteredActions` — the normal groups are confirmed
    /// work. Before this section existed they were fetched and then dropped on
    /// the floor, so the capture pipeline's extractions were invisible.
    private var suggestedActions: [Action] {
        actionsService.actions
            .filter { $0.status == .suggested && !$0.isDismissed }
            .sorted { $0.createdAt > $1.createdAt }
    }

    @ViewBuilder
    private var suggestionsSection: some View {
        if !suggestedActions.isEmpty {
            Section {
                if !suggestionsCollapsed {
                    ForEach(suggestedActions) { suggestion in
                        suggestionRow(suggestion)
                            .listRowSeparator(.hidden)
                    }
                }
            } header: {
                Button {
                    withAnimation(.snappy(duration: 0.25)) {
                        suggestionsCollapsed.toggle()
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "sparkles")
                            .font(.subheadline)
                            .foregroundStyle(.purple)
                        Text("Suggestions")
                            .font(.title3.weight(.semibold))
                        Text("\(suggestedActions.count)")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(Color.purple, in: Capsule())
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(suggestionsCollapsed ? 0 : 90))
                    }
                    .foregroundStyle(.primary)
                    .textCase(nil)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func suggestionRow(_ suggestion: Action) -> some View {
        let isBusy = busySuggestionIds.contains(suggestion.id)
        return HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(suggestion.title)
                    .font(.body)
                    .lineLimit(2)
                    .foregroundStyle(.primary)

                Text(suggestionSource(suggestion))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 0)

            if isBusy {
                ProgressView()
                    .controlSize(.small)
            } else {
                HStack(spacing: 14) {
                    Button {
                        confirmSuggestion(suggestion)
                    } label: {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.title3)
                            .foregroundStyle(.green)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Confirm suggestion")

                    Button {
                        dismissSuggestion(suggestion)
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.title3)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss suggestion")
                }
            }
        }
        .padding(.vertical, 8)
    }

    /// Where a suggestion came from — the extraction source, plus the due date
    /// when the AI proposed one.
    private func suggestionSource(_ suggestion: Action) -> String {
        var parts: [String] = [suggestion.sourceType.displayName]
        if let due = suggestion.formattedDueDate {
            parts.append(due)
        }
        return parts.joined(separator: " · ")
    }

    private func confirmSuggestion(_ suggestion: Action) {
        busySuggestionIds.insert(suggestion.id)
        Task {
            defer { busySuggestionIds.remove(suggestion.id) }
            do {
                _ = try await actionsService.confirmAction(suggestion.id)
                actionErrorMessage = nil
            } catch {
                actionErrorMessage = "Couldn't confirm that suggestion: \(error.localizedDescription)"
                print("❌ iOSTodoTab: Failed to confirm suggestion: \(error)")
            }
        }
    }

    private func dismissSuggestion(_ suggestion: Action) {
        busySuggestionIds.insert(suggestion.id)
        Task {
            defer { busySuggestionIds.remove(suggestion.id) }
            do {
                try await actionsService.dismissAction(suggestion.id)
                actionErrorMessage = nil
            } catch {
                actionErrorMessage = "Couldn't dismiss that suggestion: \(error.localizedDescription)"
                print("❌ iOSTodoTab: Failed to dismiss suggestion: \(error)")
            }
        }
    }

    // MARK: - Status Filter

    private var isStatusFilterActive: Bool {
        selectedStatuses != Set([ActionStatus.confirmed, ActionStatus.inProgress])
    }

    private var statusFilterMenu: some View {
        Menu {
            Button {
                withAnimation { selectedStatuses = [.confirmed, .inProgress] }
            } label: {
                let isDefault = selectedStatuses == Set([ActionStatus.confirmed, ActionStatus.inProgress])
                if isDefault { Label("Active (Default)", systemImage: "checkmark") }
                else { Text("Active (Default)") }
            }

            Button {
                withAnimation {
                    selectedStatuses = Set(ActionStatus.allCases.filter { $0 != .suggested })
                }
            } label: {
                Text("All Statuses")
            }

            Divider()

            ForEach(ActionStatus.allCases.filter { $0 != .suggested }, id: \.self) { status in
                Button {
                    withAnimation {
                        if selectedStatuses.contains(status) {
                            if selectedStatuses.count > 1 {
                                selectedStatuses.remove(status)
                            }
                        } else {
                            selectedStatuses.insert(status)
                        }
                    }
                } label: {
                    if selectedStatuses.contains(status) { Label(status.displayName, systemImage: "checkmark") }
                    else { Text(status.displayName) }
                }
            }
        } label: {
            Image(systemName: isStatusFilterActive ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                .font(.body)
        }
    }

    // MARK: - Filtering Logic

    private var filteredActions: [Action] {
        var tasks = actionsService.actions
        tasks = tasks.filter { $0.status != .suggested }
        tasks = tasks.filter { !$0.isDismissed }

        if !selectedStatuses.isEmpty {
            let validStatuses = selectedStatuses.filter { $0 != .suggested }
            if !validStatuses.isEmpty {
                tasks = tasks.filter { validStatuses.contains($0.status) }
            }
        }

        if showTracking {
            tasks = tasks.filter { !$0.assignedToUser }
        } else {
            tasks = tasks.filter { $0.assignedToUser }
        }

        return tasks
    }

    private var trackedItemCount: Int {
        actionsService.actions
            .filter { $0.status != .suggested && !$0.isDismissed && !$0.assignedToUser }
            .count
    }

    private var groupedActions: [ActionGroup] {
        var groups = ActionGroup.groupByDueDate(filteredActions)
        // Ensure a Today section always exists so the add row has a home
        if !groups.contains(where: { $0.id == "today" }) {
            let todayGroup = ActionGroup(id: "today", title: "Today", actions: [], sortOrder: 1)
            // Insert after overdue (sortOrder 0) if present, otherwise at the start
            if let overdueIndex = groups.firstIndex(where: { $0.sortOrder < 1 }) {
                groups.insert(todayGroup, at: overdueIndex + 1)
            } else {
                groups.insert(todayGroup, at: 0)
            }
        }
        return groups
    }

    // MARK: - New Action Row

    private var newActionRow: some View {
        HStack(alignment: .center, spacing: 12) {
            Button {
                commitNewAction()
            } label: {
                Circle()
                    .stroke(Color.secondary.opacity(0.5), lineWidth: 1.5)
                    .frame(width: 24, height: 24)
            }
            .buttonStyle(.plain)
            .disabled(!isWorkspaceReady)

            // Creating before bootstrap throws on requireWorkspaceId/TeamId/
            // StatusId and the typed title vanished — so the row is inert until
            // the workspace context resolves.
            TextField(isWorkspaceReady ? "New action..." : "Loading workspace…", text: $newActionTitle)
                .font(.body)
                .focused($isNewActionFocused)
                .submitLabel(.done)
                .disabled(!isWorkspaceReady)
                .onSubmit {
                    commitNewAction()
                }
        }
        .padding(.vertical, 4)
        .listRowSeparator(.hidden)
        .onChange(of: isNewActionFocused) { _, focused in
            if focused {
                commitEditing()
            }
            if !focused {
                commitNewAction()
            }
        }
    }

    /// Whether the workspace context (workspace + team + default column) has
    /// resolved. Every write needs it.
    private var isWorkspaceReady: Bool {
        workspaceService.isReady
    }

    private func commitNewAction() {
        let trimmed = newActionTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            resetNewActionState()
            return
        }

        guard isWorkspaceReady else {
            actionErrorMessage = "Still loading your workspace — try again in a moment."
            return
        }

        let priority: ActionPriority? = newActionPriority != .none ? newActionPriority : nil
        let dueAt = newActionDueAt ?? Date()
        let allDay = newActionDueAt != nil ? newActionAllDay : true

        newActionTitle = ""
        resetNewActionState()
        isNewActionFocused = false

        let dto = CreateActionDTO(
            title: trimmed,
            dueAt: dueAt,
            allDay: allDay,
            priority: priority
        )
        Task {
            do {
                _ = try await actionsService.createAction(dto)
                actionErrorMessage = nil
            } catch {
                // Put the words back in the field rather than losing them.
                if newActionTitle.isEmpty {
                    newActionTitle = trimmed
                    newActionPriority = priority ?? .none
                    newActionDueAt = dueAt
                    newActionAllDay = allDay
                }
                actionErrorMessage = "Couldn't create that action: \(error.localizedDescription)"
                print("❌ iOSTodoTab: Failed to create action: \(error)")
            }
        }
    }

    private func resetNewActionState() {
        newActionPriority = .none
        newActionDueAt = nil
        newActionAllDay = true
    }

    // MARK: - Toolbar Helpers (unified for editing + new action)

    private var currentToolbarPriority: ActionPriority {
        if let id = editingActionId,
           let action = actionsService.actions.first(where: { $0.id == id }) {
            return action.priority
        }
        if isNewActionFocused {
            return newActionPriority
        }
        return .none
    }

    private var currentToolbarPriorityColor: Color {
        switch currentToolbarPriority {
        case .urgent: return .red
        case .high: return .orange
        case .medium: return .yellow
        case .low: return .blue
        case .none: return .primary
        }
    }

    private var currentToolbarDueAt: Date? {
        if let id = editingActionId,
           let action = actionsService.actions.first(where: { $0.id == id }) {
            return action.dueAt
        }
        if isNewActionFocused {
            return newActionDueAt
        }
        return nil
    }

    private var currentToolbarAllDay: Bool {
        if let id = editingActionId,
           let action = actionsService.actions.first(where: { $0.id == id }) {
            return action.allDay
        }
        if isNewActionFocused {
            return newActionAllDay
        }
        return true
    }

    private func applyPriority(_ priority: ActionPriority) {
        if let id = editingActionId {
            let dto = UpdateActionDTO(priority: priority)
            Task { _ = try? await actionsService.updateAction(id: id, dto) }
        } else if isNewActionFocused {
            newActionPriority = priority
        }
    }

    private func applyDueDate(_ date: Date, allDay: Bool) {
        if let id = editingActionId {
            var dto = UpdateActionDTO()
            dto.dueAt = date
            dto.dueAtWasSet = true
            dto.allDay = allDay
            Task { _ = try? await actionsService.updateAction(id: id, dto) }
        } else if isNewActionFocused {
            newActionDueAt = date
            newActionAllDay = allDay
        }
    }

    private func clearDueDate() {
        if let id = editingActionId {
            var dto = UpdateActionDTO()
            dto.dueAt = nil
            dto.dueAtWasSet = true
            Task { _ = try? await actionsService.updateAction(id: id, dto) }
        } else if isNewActionFocused {
            newActionDueAt = nil
            newActionAllDay = true
        }
    }

    private var nextSaturday: Date {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let weekday = calendar.component(.weekday, from: today)
        // Saturday is weekday 7
        let daysUntilSaturday = (7 - weekday + 7) % 7
        let offset = daysUntilSaturday == 0 ? 7 : daysUntilSaturday
        return calendar.date(byAdding: .day, value: offset, to: today) ?? today
    }

    /// Which board column the action being edited currently sits in.
    private var currentToolbarStatusId: UUID? {
        guard let id = editingActionId,
              let action = actionsService.actions.first(where: { $0.id == id }) else { return nil }
        return action.statusId
    }

    /// Move the edited action to a board column.
    ///
    /// Completing goes through `completeAction` — with the PICKED column, so
    /// choosing a specific Done column lands there rather than the team's first
    /// completed one. Leaving a completed column goes through `uncompleteAction`
    /// so `completed_at` is cleared rather than left stale.
    private func applyState(_ state: WorkflowState) {
        guard let id = editingActionId else { return }
        let wasCompleted = actionsService.actions.first(where: { $0.id == id })?.status == .completed
        Task {
            do {
                if state.category == .completed {
                    _ = try await actionsService.completeAction(id: id, statusId: state.id)
                } else if wasCompleted {
                    // Reopen (clears completed_at), then land in the picked column.
                    _ = try await actionsService.uncompleteAction(id: id)
                    _ = try await actionsService.moveAction(id: id, toStatusId: state.id)
                } else {
                    _ = try await actionsService.moveAction(id: id, toStatusId: state.id)
                }
                actionErrorMessage = nil
            } catch {
                actionErrorMessage = "Couldn't move that action to \(state.name): \(error.localizedDescription)"
                print("❌ iOSTodoTab: Failed to move action to \(state.name): \(error)")
            }
        }
    }

    private func statusIcon(for status: ActionStatus) -> String {
        switch status {
        case .completed: return "checkmark.circle.fill"
        case .inProgress: return "circle.dotted.circle"
        case .confirmed: return "circle"
        case .suggested: return "sparkle"
        case .cancelled: return "xmark.circle"
        }
    }

    // MARK: - Inline Editing

    private func beginEditing(_ action: Action) {
        if editingActionId != nil {
            commitEditing()
        }
        // Dismiss new action field if active
        if isNewActionFocused {
            commitNewAction()
        }
        editingActionId = action.id
        editingTitle = action.title
        focusedActionId = action.id
    }

    private func commitEditing() {
        guard let id = editingActionId else { return }
        let trimmed = editingTitle.trimmingCharacters(in: .whitespacesAndNewlines)

        if let action = actionsService.actions.first(where: { $0.id == id }),
           !trimmed.isEmpty, trimmed != action.title {
            let dto = UpdateActionDTO(title: trimmed)
            Task {
                _ = try? await actionsService.updateAction(id: id, dto)
            }
        }

        editingActionId = nil
        editingTitle = ""
        focusedActionId = nil
    }

    private func deleteAction(_ action: Action) {
        // Dismiss editing if we're deleting the action being edited
        if editingActionId == action.id {
            editingActionId = nil
            focusedActionId = nil
        }
        Task {
            do {
                try await actionsService.deleteAction(id: action.id)
                actionErrorMessage = nil
            } catch {
                actionErrorMessage = "Couldn't delete that action: \(error.localizedDescription)"
                print("❌ iOSTodoTab: Failed to delete action: \(error)")
            }
        }
    }

    private func toggleCompletion(_ action: Action) {
        guard isWorkspaceReady else {
            actionErrorMessage = "Still loading your workspace — try again in a moment."
            return
        }
        Task {
            do {
                if action.status == .completed {
                    _ = try await actionsService.uncompleteAction(id: action.id)
                } else {
                    _ = try await actionsService.completeAction(id: action.id)
                }
                actionErrorMessage = nil
            } catch {
                actionErrorMessage = "Couldn't update that action: \(error.localizedDescription)"
                print("❌ iOSTodoTab: Failed to toggle action completion: \(error)")
            }
        }
    }
}
