//
//  iOSAIChatView.swift
//  dial8
//
//  The chat surface, presented as a large sheet over a blurred Home screen.
//  Supports general chat (no context) and note-bound chat (note pre-attached).
//
//  Layout, top to bottom:
//    ✕ (top-left) … [new chat | history] (top-right, one glass capsule)
//    [note context bar, when note-bound]
//    "Hi {First}, ask anything"             — serif greeting, centered, empty only
//    [suggestion chips]                     — empty only
//    [error banner]
//    [composer card]
//

import SwiftUI
import MarkdownUI
// For AnyJSON's `stringValue` on User.userMetadata (the greeting's name fallback).
import Supabase

extension Notification.Name {
    /// Posted by Home's bottom-bar mic right after it presents the chat sheet:
    /// "open the chat AND start listening". The sheet may not be mounted yet when
    /// this fires, so `ChatSessionStore.shared.pendingDictationStart` carries the
    /// same intent for the `.onAppear` path — see `iOSChatSurface`.
    static let startChatDictation = Notification.Name("dial8.chat.startDictation")
}

/// Presentation-facing wrapper. Its only job is to decide WHO owns the view
/// model before handing it to `iOSChatSurface` as an `@ObservedObject`:
///
///   • general chat → `ChatSessionStore.shared.general`, a process-wide
///     singleton, so dismissing and re-presenting the sheet returns to the SAME
///     conversation instead of constructing a fresh one every time;
///   • note-bound chat → a `@StateObject` scoped to this view, as before.
struct iOSAIChatView: View {
    @Environment(\.dismiss) private var dismiss
    private enum Backing {
        /// An externally owned model (the shared general chat).
        case external(iOSEveChatViewModel)
        /// Owned here, created once per presentation, bound to a note.
        case note(Note)
    }

    private let backing: Backing

    /// Only constructed for the `.note` case — a `@StateObject` initialized with
    /// an autoclosure is not evaluated until first access, so the general path
    /// never builds a throwaway view model.
    @StateObject private var ownedViewModel: iOSEveChatViewModel

    /// General chat driven by an externally owned view model.
    init(viewModel: iOSEveChatViewModel) {
        self.backing = .external(viewModel)
        // Never read on this path (see `resolvedViewModel`), and never
        // constructed either: StateObject's autoclosure stays unevaluated.
        self._ownedViewModel = StateObject(wrappedValue: viewModel)
    }

    /// Note-bound chat, owning its own view model.
    init(note: Note) {
        self.backing = .note(note)
        self._ownedViewModel = StateObject(wrappedValue: iOSEveChatViewModel(note: note))
    }

    private var resolvedViewModel: iOSEveChatViewModel {
        switch backing {
        case .external(let model): return model
        case .note: return ownedViewModel
        }
    }

    private var contextNote: Note? {
        if case .note(let note) = backing { return note }
        return nil
    }

    var body: some View {
        iOSChatSurface(viewModel: resolvedViewModel, contextNote: contextNote)
            .onReceive(NotificationCenter.default.publisher(for: .workspaceDidChange)) { _ in
                if contextNote != nil { resolvedViewModel.resetForAccountChange(); dismiss() }
            }
            .onReceive(NotificationCenter.default.publisher(for: .userSignedOut)) { _ in
                if contextNote != nil { resolvedViewModel.resetForAccountChange(); dismiss() }
            }
    }
}

/// The chat sheet itself. Everything here observes a view model it does NOT own,
/// which is what lets the general conversation outlive the sheet.
struct iOSChatSurface: View {
    @ObservedObject var viewModel: iOSEveChatViewModel

    /// Whether this chat was opened with a specific note as context
    let contextNote: Note?

    @StateObject private var dictation = ChatDictationService()
    @StateObject private var notesService = NotesService.shared
    @StateObject private var recordingService = iOSRecordingService.shared
    @StateObject private var workspaceService = WorkspaceService.shared
    @Environment(\.dismiss) private var dismiss

    @State private var showingHistory = false
    @State private var showingAgents = false
    @State private var showingAgentProfile = false
    /// Captures attached through the paperclip, newest attachment last. Held here
    /// (rather than read back out of ProjectsService) so the chips render without
    /// depending on a non-observable service mutation.
    @State private var attachedNoteIds: [UUID] = []
    /// Chosen once per presentation so the composer's prompt varies between opens.
    @State private var placeholder: String = ""

    // MARK: - Body

    var body: some View {
        VStack(spacing: 0) {
            topBar

            if let agent = viewModel.selectedAgent { agentHeader(agent) }

            if let note = contextNote {
                contextBar(note: note)
            }

            if viewModel.isLoadingThread && viewModel.messages.isEmpty {
                // Opened while ChatSessionStore is still refetching the restored
                // conversation — show the spinner rather than an empty greeting
                // that would flash into a full transcript a moment later.
                loadingState
            } else if isEmptyState {
                greeting
            } else {
                messagesList
            }

            // Error banner — a failed send used to be completely invisible
            if let error = viewModel.lastError {
                errorBanner(error)
            }

            // Suggestion chips sit directly above the composer while empty
            if isEmptyState {
                iOSChatSuggestionChips(suggestions: Self.suggestions) { suggestion in
                    send(suggestion)
                }
            }

            iOSChatComposerView(
                text: $viewModel.userInput,
                isProcessing: viewModel.isProcessing || viewModel.isLoadingThread || viewModel.needsReconnect || !viewModel.inputRequests.isEmpty,
                placeholder: placeholder,
                onSend: {
                    // Dictating straight into a send would keep the mic hot
                    // behind the reply — close it first.
                    dictation.stop()
                    Task { try? await viewModel.sendMessage() }
                },
                attachedNotes: attachedNotes,
                recentNotes: recentNotes,
                onAttach: attach(_:),
                onDetach: detach(_:),
                dictation: dictation,
                onToggleDictation: toggleDictation,
                micDisabled: recordingService.hasActiveSession
            )
        }
        .onAppear {
            // Deliberately does NOT touch conversation state: the general chat is
            // owned by ChatSessionStore and must survive every open/close of the
            // sheet, so there is no reset and no startNewConversation() here.

            // Final segments land as whole utterances; join them with a space so
            // a multi-sentence dictation reads correctly in the field. The view
            // model is retained by its owner (the store, or this view's
            // @StateObject), so a strong capture is safe here.
            let model = viewModel
            dictation.onFinalText = { text in
                let existing = model.userInput.trimmingCharacters(in: .whitespacesAndNewlines)
                model.userInput = existing.isEmpty ? text : existing + " " + text
            }

            if placeholder.isEmpty {
                placeholder = Self.nextPlaceholder(isNoteBound: contextNote != nil)
            }

            // The mic-opened-the-chat race: if the notification was posted before
            // this view existed, the intent is waiting in the store.
            if ChatSessionStore.shared.pendingDictationStart {
                ChatSessionStore.shared.pendingDictationStart = false
                startDictationIfIdle()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .startChatDictation)) { _ in
            // Whichever of this and `.onAppear` runs first wins; the flag makes
            // the other a no-op rather than a double start (which `start()` also
            // guards against internally).
            ChatSessionStore.shared.pendingDictationStart = false
            startDictationIfIdle()
        }
        .task {
            // The paperclip menu reads allNotesForSearch, which is only populated
            // by an explicit fetch — without this the menu is empty on a cold open.
            if notesService.allNotesForSearch.isEmpty {
                await notesService.fetchAllNotesForSearch()
            }
        }
        .onDisappear {
            // A sheet dismissed mid-dictation must not leave the mic open.
            dictation.stop()
            releaseAttachments()
        }
        .sheet(isPresented: $showingAgents) { iOSAgentPicker(viewModel: viewModel) }
        .sheet(isPresented: $showingAgentProfile) {
            if let agent = viewModel.selectedAgent { iOSAgentProfile(agent: agent, working: viewModel.isProcessing) }
        }
        .sheet(isPresented: $showingHistory) {
            historySheet
        }
    }

    private var isEmptyState: Bool {
        viewModel.messages.isEmpty && !viewModel.isProcessing && !viewModel.isLoadingThread
    }

    /// Shown while a restored (or history-picked) thread is being fetched.
    private var loadingState: some View {
        VStack(spacing: 12) {
            Spacer(minLength: 0)
            ProgressView()
            Text("Loading your chat…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Suggestions

    private static let suggestions = [
        "Who have I promised to follow up with?",
        "What needs my attention today?",
        "What topics came up this week?",
        "Summarize my recent meetings"
    ]

    private func send(_ text: String) {
        dictation.stop()
        viewModel.userInput = text
        Task { try? await viewModel.sendMessage() }
    }

    // MARK: - Composer Placeholder

    /// Rotated per presentation so the field doesn't always ask the same thing.
    /// A counter in UserDefaults (rather than a random pick) guarantees the next
    /// open shows a *different* prompt.
    private static let placeholders = [
        "What topics came up?",
        "Summarize my meetings this week",
        "Who have I promised to follow up with?",
        "What needs my attention today?"
    ]

    private static let placeholderIndexKey = "dial8.chat.placeholderIndex"

    private static func nextPlaceholder(isNoteBound: Bool) -> String {
        guard !isNoteBound else { return "Chat with this meeting" }

        let defaults = UserDefaults.standard
        let index = defaults.integer(forKey: placeholderIndexKey)
        defaults.set((index + 1) % placeholders.count, forKey: placeholderIndexKey)

        // `integer(forKey:)` returns 0 for a missing key, and the stored value is
        // always written back in range — but clamp anyway rather than trap.
        let safeIndex = (index >= 0 && index < placeholders.count) ? index : 0
        return placeholders[safeIndex]
    }

    // MARK: - Top Bar

    private var topBar: some View {
        HStack {
            circularGlassButton(systemImage: "xmark", label: "Close chat") {
                dismiss()
            }

            Spacer(minLength: 8)
            Button { showingAgents = true } label: {
                HStack(spacing: 5) {
                    Text(viewModel.selectedAgent?.name ?? "Dial8").font(.subheadline.weight(.semibold)).lineLimit(1)
                    Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
                }
                .foregroundStyle(.primary)
                .padding(.vertical, 12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(viewModel.isProcessing || viewModel.isLoadingThread)
            .accessibilityLabel("Choose agent")
            Spacer(minLength: 8)
            trailingCapsule
        }
        .padding(.horizontal, 16)
        // Clear the sheet's drag indicator — the buttons sat on the edge at 4pt.
        .padding(.top, 20)
        .padding(.bottom, 8)
    }

    /// New chat + history share ONE glass capsule. The pencil owns "new chat"
    /// outright, which is why the history sheet no longer carries that row.
    private var trailingCapsule: some View {
        HStack(spacing: 0) {
            if viewModel.isProcessing {
                capsuleButton(systemImage: "stop.fill", label: "Stop reply") { viewModel.stop() }
            } else if contextNote == nil {
                capsuleButton(systemImage: "square.and.pencil", label: "New chat") {
                    startNewChat()
                }
            }

            capsuleButton(systemImage: "clock.arrow.circlepath", label: "Chat history") {
                Task {
                    await viewModel.loadChatHistory()
                    showingHistory = true
                }
            }
        }
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(
            Capsule().strokeBorder(Color(.separator).opacity(0.3), lineWidth: 0.5)
        )
    }

    private func capsuleButton(
        systemImage: String,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(.primary)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    /// Starts a fresh conversation and empties the composer with it — leaving a
    /// half-typed message (or an attachment) behind would silently carry old
    /// context into the new chat.
    ///
    /// `@MainActor` because `startNewConversation()` is main-actor isolated and
    /// this is called from a Button action rather than from `body` directly.
    @MainActor
    private func startNewChat() {
        dictation.stop()
        releaseAttachments()
        viewModel.userInput = ""
        viewModel.startNewConversation()
        placeholder = Self.nextPlaceholder(isNoteBound: contextNote != nil)
        print("🆕 iOSAIChatView: started a new chat")
    }

    private func circularGlassButton(
        systemImage: String,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(.primary)
                .frame(width: 44, height: 44)
                .background(.ultraThinMaterial, in: Circle())
                .overlay(
                    Circle().strokeBorder(Color(.separator).opacity(0.3), lineWidth: 0.5)
                )
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private func agentHeader(_ agent: iOSChatAgent) -> some View {
        Button { showingAgentProfile = true } label: {
            VStack(spacing: 0) {
                if let character = agent.character {
                    iOSAgentAvatar(character: character, working: viewModel.isProcessing)
                        .frame(width: isEmptyState ? 132 : 76, height: isEmptyState ? 132 : 76)
                        .allowsHitTesting(false)
                } else {
                    iOSAgentThumbnail(agent: agent).frame(width: 56, height: 56).padding(10)
                }
                Text(viewModel.isProcessing ? "Working…" : agent.detail)
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open \(agent.name)'s profile")
    }

    // MARK: - Greeting

    /// New York (`design: .serif`). The website's heading face is Noto Serif but
    /// it ships as a Google-hosted webfont — there is no .ttf/.otf in the repo to
    /// bundle — so the system serif stands in.
    private var greeting: some View {
        VStack {
            Spacer(minLength: 0)

            Text(viewModel.selectedAgent.map { "Talk to \($0.name)" } ?? "Hi \(firstName), ask anything")
                .font(.system(size: 34, weight: .regular, design: .serif))
                .foregroundStyle(.primary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 32)

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
    }

    /// First word of the workspace display name, falling back to the Supabase
    /// user metadata name and finally "there".
    private var firstName: String {
        // `userMetadata` is [String: AnyJSON]; a missing key and a non-string
        // value both collapse to nil here.
        let metadata = SupabaseManager.shared.currentUser?.userMetadata ?? [:]

        let candidates: [String?] = [
            workspaceService.activeMember?.displayName,
            // `?? nil` flattens AnyJSON?.stringValue (String??) down to String?.
            metadata["full_name"]?.stringValue ?? nil,
            metadata["name"]?.stringValue ?? nil,
        ]

        for candidate in candidates {
            guard let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !trimmed.isEmpty,
                  let first = trimmed.split(separator: " ").first else { continue }
            return String(first)
        }
        return "there"
    }

    // MARK: - Context Bar

    private func contextBar(note: Note) -> some View {
        HStack(spacing: 8) {
            Image(systemName: note.type.icon)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(note.title)
                .font(.caption)
                .lineLimit(1)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color(.secondarySystemBackground).opacity(0.6))
    }

    // MARK: - History

    /// Purely a list of past chats — the top bar's pencil owns "new chat" now.
    private var historySheet: some View {
        NavigationStack {
            List {
                Section("Recent") {
                    if viewModel.chatSessions.isEmpty {
                        Text("No previous chats")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(viewModel.chatSessions) { session in
                            Button {
                                let id = session.id
                                showingHistory = false
                                Task { await viewModel.loadSession(id) }
                            } label: {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(session.title ?? "Untitled chat")
                                        .font(.subheadline.weight(.medium))
                                        .foregroundStyle(.primary)
                                        .lineLimit(1)

                                    if let preview = session.preview, !preview.isEmpty {
                                        Text(preview)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(2)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Chats")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { showingHistory = false }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    // MARK: - Dictation

    private func toggleDictation() {
        if dictation.isListening {
            dictation.stop()
        } else {
            dictation.start()
        }
    }

    /// Start listening only when it's safe to: not already listening, not mid-reply,
    /// and not while a capture already owns the mic (the same condition that greys
    /// the composer's own mic button out).
    private func startDictationIfIdle() {
        guard !dictation.isListening,
              !viewModel.isProcessing,
              !recordingService.hasActiveSession else { return }
        dictation.start()

        #if DEBUG
        // `-autoStopDictationAfterSeconds N` closes the mic on a timer, so a
        // fixture-fed dictation run on a device with no mic can be driven end to
        // end from launch arguments. See DebugDictationAutomation.
        let stopAfter = DebugDictationAutomation.autoStopAfterSeconds
        if stopAfter > 0 {
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(stopAfter * 1_000_000_000))
                print("[DebugDictation] auto-stopping after \(Int(stopAfter))s")
                dictation.stop()
            }
        }
        #endif
    }

    // MARK: - Attachments

    /// The attached captures resolved to Notes, in attachment order.
    private var attachedNotes: [Note] {
        attachedNoteIds.compactMap { id in
            notesService.allNotesForSearch.first { $0.id == id }
        }
    }

    /// The 6 most recent captures offered in the paperclip menu, minus anything
    /// already attached (and minus the note this chat is already bound to).
    private var recentNotes: [Note] {
        let excluded = Set(attachedNoteIds + (contextNote.map { [$0.id] } ?? []))
        return notesService.allNotesForSearch
            .filter { !excluded.contains($0.id) }
            .sorted { ($0.recordedAt ?? $0.createdAt) > ($1.recordedAt ?? $1.createdAt) }
            .prefix(6)
            .map { $0 }
    }

    /// Attaching writes into `ProjectsService.aiContextSelection`, which is the
    /// selection iOSEveChatViewModel snapshots (`attachmentsAtStart` /
    /// `attachmentsAtLastMessage`) to build the system prompt and the
    /// mid-conversation prepend. Nothing chat-specific is needed beyond it.
    private func attach(_ note: Note) {
        guard !attachedNoteIds.contains(note.id) else { return }
        attachedNoteIds.append(note.id)
        ProjectsService.shared.addNoteToAIContext(noteId: note.id)
        print("📎 iOSAIChatView: attached capture '\(note.title)'")
    }

    private func detach(_ note: Note) {
        attachedNoteIds.removeAll { $0 == note.id }
        ProjectsService.shared.removeNoteFromAIContext(noteId: note.id)
        print("📎 iOSAIChatView: detached capture '\(note.title)'")
    }

    /// The AI context selection is global (other screens add to it too), so a
    /// closing sheet must remove only what IT added rather than clearing it.
    private func releaseAttachments() {
        for id in attachedNoteIds {
            ProjectsService.shared.removeNoteFromAIContext(noteId: id)
        }
        attachedNoteIds = []
    }

    // MARK: - Error Banner

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 14))
                .foregroundStyle(Color.orange)
                .padding(.top, 1)

            Text(message)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)

            Button("Retry") {
                viewModel.retryLastMessage()
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Color.orange)
            .buttonStyle(.plain)

            Button {
                viewModel.clearError()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss error")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.orange.opacity(0.12))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color.orange.opacity(0.35), lineWidth: 0.5)
        )
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .transition(.opacity)
    }

    // MARK: - Messages List

    private var messagesList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 16) {
                    ForEach(viewModel.messages) { message in
                        iOSChatMessageBubble(message: message)
                            .id(message.id)
                    }

                    // Streaming response
                    if let streaming = viewModel.streamingContent, !streaming.isEmpty {
                        streamingBubble(streaming)
                            .id("streaming")
                    }

                    ForEach(viewModel.inputRequests) { request in
                        iOSEveInputCard(request: request, busy: viewModel.isProcessing) { option, text in
                            Task { await viewModel.respond(to: request, optionID: option, text: text) }
                        }
                        .padding(.horizontal, 16)
                    }

                    // Processing indicator
                    if viewModel.isProcessing && (viewModel.streamingContent ?? "").isEmpty {
                        HStack {
                            ProgressView()
                                .scaleEffect(0.8)
                            Text("Thinking...")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            Spacer()
                        }
                        .padding(.horizontal, 16)
                        .id("processing")
                    }
                }
                .padding(.vertical, 16)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: viewModel.messages.count) { _, _ in
                withAnimation {
                    if let lastId = viewModel.messages.last?.id {
                        proxy.scrollTo(lastId, anchor: .bottom)
                    }
                }
            }
            .onChange(of: viewModel.streamingContent) { _, newValue in
                // Only the streaming bubble that actually exists can be targeted;
                // while it's still empty the "Thinking…" row is the tail.
                if let newValue, !newValue.isEmpty {
                    proxy.scrollTo("streaming", anchor: .bottom)
                } else if viewModel.isProcessing {
                    proxy.scrollTo("processing", anchor: .bottom)
                }
            }
            .onChange(of: viewModel.isProcessing) { _, isProcessing in
                if isProcessing, (viewModel.streamingContent ?? "").isEmpty {
                    withAnimation { proxy.scrollTo("processing", anchor: .bottom) }
                }
            }
        }
    }

    /// Matches the finished-assistant style: bare Markdown, no bubble fill, full
    /// width. Only the tool-call chips keep their own look.
    private func streamingBubble(_ content: String) -> some View {
        HStack(alignment: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                // Tool calls indicator
                if !viewModel.streamingToolCalls.isEmpty {
                    ForEach(viewModel.streamingToolCalls) { toolCall in
                        HStack(spacing: 6) {
                            if toolCall.status == .executing {
                                ProgressView()
                                    .scaleEffect(0.6)
                            } else {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.caption)
                                    .foregroundStyle(.green)
                            }
                            Text(toolCall.toolName.replacingOccurrences(of: "_", with: " "))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Markdown(content)
                    .font(.body)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16)
    }
}
