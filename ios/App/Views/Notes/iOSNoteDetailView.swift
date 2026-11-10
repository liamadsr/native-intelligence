//
//  iOSNoteDetailView.swift
//  Native Intelligence
//
//  Rich note detail view for iOS — displays AI-generated sections
//  (summary, decisions, open questions, action items) with a
//  "Chat with meeting" floating button.
//
//  Inspired by Granola's iOS note detail UX.
//

import SwiftUI
import MarkdownUI

struct iOSNoteDetailView: View {
    /// Seeded from the initializer, then kept live. The summary for an iOS
    /// capture is written by the SERVER a minute or so after the recording stops,
    /// so a `let note` froze the view on the placeholder row forever.
    @State private var note: Note
    @State private var showingChat = false
    @State private var showTranscript = false
    @State private var isPollingForSummary = false
    /// True while the user's "Finish processing" tap is running.
    @State private var isFinishingRecording = false
    /// Why the last "Finish processing" tap didn't work, shown inline on the
    /// card. Without it a failed attempt looked exactly like a no-op — the
    /// spinner stopped, nothing changed, and the user tapped again forever.
    @State private var finishError: String?

    init(note: Note) {
        self._note = State(initialValue: note)
    }

    /// Poll cadence + ceiling for the post-capture summary. The batch run usually
    /// lands well inside a minute; 3 minutes is a generous ceiling before we stop
    /// spending requests on a capture whose extraction probably failed.
    private static let summaryPollInterval: UInt64 = 5_000_000_000  // 5s
    private static let summaryPollDeadline: TimeInterval = 180      // 3 min
    /// How recent a note has to be for a missing summary to mean "still coming"
    /// rather than "this capture never had one".
    private static let recentWindow: TimeInterval = 15 * 60

    private var parsedSections: MeetingSummarySections {
        MeetingSummarySections.parse(from: note.aiSummary ?? note.content ?? note.summary ?? "")
    }

    /// True while the note has no summary of any kind and is recent enough that
    /// the server-side batch run is plausibly still working on it.
    ///
    /// Requires `endedAt`: a capture whose recording never finished has no batch
    /// run in flight and never will — it is `isInterrupted`, below, and gets a
    /// row that says so and a button that fixes it. Saying "Generating summary…"
    /// under one was the lie this replaces.
    private var isAwaitingSummary: Bool {
        guard !hasSummary else { return false }
        if note.startedAt != nil && note.endedAt == nil { return false }
        // A recording that ended long enough ago that its batch is not "still
        // working" — it is stalled, and gets a button rather than a spinner.
        if isStalled { return false }
        let reference = note.recordedAt ?? note.createdAt
        return Date().timeIntervalSince(reference) < Self.recentWindow
    }

    private var hasSummary: Bool {
        !(note.aiSummary?.isEmpty ?? true) || !(note.summary?.isEmpty ?? true)
    }

    /// The recording was started and never finished — see `Note.isInterrupted`.
    /// Suppressed while this capture is the one being recorded right now.
    private var isInterrupted: Bool {
        guard note.isInterrupted else { return false }
        return iOSRecordingService.shared.activeCaptureId != note.id
    }

    /// The recording DID finish but the summary never arrived: `ended_at` is set,
    /// there is a transcript, and no batch ever wrote anything. That happens when
    /// the app is killed during the detached batch run — a state `isInterrupted`
    /// cannot see, because it requires `ended_at == nil`.
    ///
    /// Same remedy as an interrupted recording (`CaptureRecoveryService.recover`
    /// runs the batch for exactly this case), so it gets the same card rather
    /// than a spinner that never resolves.
    private var isStalled: Bool {
        guard note.endedAt != nil, !hasSummary else { return false }
        guard note.batchProcessedAt == nil else { return false }
        guard !(note.transcript?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) else { return false }
        guard iOSRecordingService.shared.activeCaptureId != note.id else { return false }
        // Give the normal batch its window before calling it stalled.
        let reference = note.endedAt ?? note.recordedAt ?? note.createdAt
        return Date().timeIntervalSince(reference) > Self.summaryPollDeadline
    }

    /// Either failure mode: the capture needs a finishing pass the user can start.
    private var needsFinishing: Bool { isInterrupted || isStalled }

    var body: some View {
        ZStack(alignment: .bottom) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    // Header
                    headerSection

                    // Metadata chips
                    metadataChips
                        .padding(.top, 12)

                    Divider()
                        .padding(.vertical, 16)
                        .padding(.horizontal, 20)

                    // AI Content sections
                    contentSections

                    // Participants (for meetings)
                    if note.type == .meeting && !note.participants.isEmpty {
                        participantsSection
                    }

                    // Private notes
                    if let userNotes = note.userNotes, !userNotes.isEmpty {
                        privateNotesSection(userNotes)
                    }

                    // Transcript (collapsed by default)
                    if let transcript = note.transcript, !transcript.isEmpty {
                        transcriptSection(transcript)
                    }

                    // Bottom spacing for floating button
                    Color.clear.frame(height: 80)
                }
            }

            // Floating "Chat with meeting" button
            chatButton
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: 4) {
                    ShareLink(item: note.title) {
                        Image(systemName: "square.and.arrow.up")
                    }
                    Menu {
                        if note.type == .meeting, let url = note.meetingUrl, let meetingURL = URL(string: url) {
                            Link(destination: meetingURL) {
                                Label("Open Meeting Link", systemImage: "video")
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
        }
        // Sheet, not fullScreenCover — the note stays visible (blurred) behind
        // the chat. Matches the Home-screen presentation in iOSMainTabView.
        .sheet(isPresented: $showingChat) {
            iOSAIChatView(note: note)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
                .presentationBackground(.ultraThinMaterial)
        }
        .onReceive(NotificationCenter.default.publisher(for: .noteUpdated)) { notification in
            // .noteUpdated carries the updated Note itself (NotesService.updateNote
            // and refreshNoteAndNotify both post it that way).
            guard let updated = notification.object as? Note, updated.id == note.id else { return }
            note = updated
        }
        .task(id: note.id) {
            await pollForSummaryIfNeeded()
        }
    }

    // MARK: - Summary polling

    /// While the batch extraction is still running server-side, re-read the
    /// capture every few seconds so the summary appears without the user having
    /// to back out and reopen. Stops the instant a summary lands, at the 3-minute
    /// ceiling, or when the view goes away (.task cancellation).
    private func pollForSummaryIfNeeded() async {
        guard isAwaitingSummary, !isPollingForSummary else { return }
        isPollingForSummary = true
        defer { isPollingForSummary = false }

        let deadline = Date().addingTimeInterval(Self.summaryPollDeadline)
        while !Task.isCancelled && Date() < deadline {
            try? await Task.sleep(nanoseconds: Self.summaryPollInterval)
            if Task.isCancelled { return }

            guard let refreshed = try? await NotesService.shared.fetchNote(by: note.id) else { continue }
            note = refreshed
            if !isAwaitingSummary {
                print("✨ [NoteDetail] Summary arrived for \(note.id.uuidString.prefix(8))…")
                return
            }
        }
    }

    // MARK: - Header

    private var headerSection: some View {
        Text(note.title)
            .font(.title.bold())
            .padding(.horizontal, 20)
            .padding(.top, 8)
    }

    // MARK: - Metadata Chips

    private var metadataChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                // Date chip
                HStack(spacing: 6) {
                    Image(systemName: "calendar")
                        .font(.caption)
                    Text(formatNoteDate(note.recordedAt ?? note.createdAt))
                        .font(.subheadline)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color(.secondarySystemBackground))
                .clipShape(Capsule())

                // Participants/author chip
                if !note.participants.isEmpty {
                    HStack(spacing: 6) {
                        Image(systemName: "person.2")
                            .font(.caption)
                        Text(participantsSummary)
                            .font(.subheadline)
                            .lineLimit(1)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Color(.secondarySystemBackground))
                    .clipShape(Capsule())
                }

                // Duration chip
                if let duration = note.durationSeconds, duration > 0 {
                    HStack(spacing: 6) {
                        Image(systemName: "clock")
                            .font(.caption)
                        Text(formatDuration(duration))
                            .font(.subheadline)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Color(.secondarySystemBackground))
                    .clipShape(Capsule())
                }

                // Type badge
                HStack(spacing: 6) {
                    Image(systemName: note.type.icon)
                        .font(.caption)
                    Text(note.type.displayName)
                        .font(.subheadline)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color(.secondarySystemBackground))
                .clipShape(Capsule())
            }
            .padding(.horizontal, 20)
        }
        .scrollBounceBehavior(.basedOnSize)
    }

    // MARK: - Content Sections

    @ViewBuilder
    private var contentSections: some View {
        VStack(alignment: .leading, spacing: 20) {
            // The recording never finished — offer to finish it rather than
            // pretending a summary is on its way.
            if needsFinishing {
                interruptedRow
            }

            // The server writes ai_summary a minute or so after the recording
            // stops. Say so instead of showing a blank body.
            if isAwaitingSummary {
                generatingSummaryRow
            }

            // Main summary/content. `strippingHTMLComments` again on the way to
            // the renderer: `parsedSections.summary` is already clean, but
            // `note.content` goes straight from the row to Markdown.
            if let summary = parsedSections.summary, !summary.isEmpty {
                Markdown(summary)
                    .font(.body)
                    .padding(.horizontal, 20)
            } else if let content = note.content, !content.isEmpty {
                let cleaned = MeetingSummarySections.strippingHTMLComments(content)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !cleaned.isEmpty {
                    Markdown(cleaned)
                        .font(.body)
                        .padding(.horizontal, 20)
                }
            }

            // Decisions
            if let decisions = parsedSections.decisions, !decisions.isEmpty {
                sectionView(
                    title: "Decisions",
                    icon: "checkmark.seal.fill",
                    color: .blue,
                    items: decisions
                )
            }

            // Open Questions
            if let questions = parsedSections.openQuestions, !questions.isEmpty {
                sectionView(
                    title: "Open Questions",
                    icon: "questionmark.circle.fill",
                    color: .orange,
                    items: questions
                )
            }

            // Next Steps
            if let nextSteps = parsedSections.nextSteps, !nextSteps.isEmpty {
                sectionView(
                    title: "Next Steps",
                    icon: "arrow.right.circle.fill",
                    color: .green,
                    items: nextSteps
                )
            }

            // Action Items from metadata
            if let actionItems = extractActionItems(), !actionItems.isEmpty {
                actionItemsSection(actionItems)
            }
        }
    }

    /// Shown for a capture whose recording was cut short. Neutral, not alarming:
    /// the transcript is usually intact and one tap finishes the job.
    private var interruptedRow: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.circle")
                    .foregroundStyle(.secondary)
                Text(isStalled ? "This recording wasn't summarized" : "This recording didn't finish")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
            }

            Text(isStalled
                 ? "The app closed before the summary was generated. Finish processing to generate one from the transcript."
                 : "The app closed before the recording was saved. Finish processing to generate a summary from what was captured.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            // A failed attempt used to look exactly like a no-op: the spinner
            // stopped, the card was unchanged, and the user tapped again forever.
            if let finishError {
                Text(finishError)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button {
                Task { await finishInterruptedRecording() }
            } label: {
                HStack(spacing: 8) {
                    if isFinishingRecording {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Text(isFinishingRecording ? "Finishing…" : "Finish processing")
                        .font(.subheadline.weight(.medium))
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Color(.secondarySystemBackground), in: Capsule())
            }
            .buttonStyle(.plain)
            .disabled(isFinishingRecording)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground).opacity(0.6), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .padding(.horizontal, 20)
    }

    /// End + batch + title this specific capture, through the same service the
    /// automatic launch-time recovery uses, then show the result.
    private func finishInterruptedRecording() async {
        guard !isFinishingRecording else { return }
        isFinishingRecording = true
        finishError = nil
        defer { isFinishingRecording = false }

        let outcome = await CaptureRecoveryService.shared.recover(
            captureId: note.id,
            startedAt: note.startedAt
        )

        switch outcome {
        case .processed:
            // Re-read so the arriving summary and ended_at land on screen.
            if let refreshed = try? await NotesService.shared.fetchNote(by: note.id) {
                note = refreshed
            }
        case .deletedEmpty:
            // Nothing was ever captured and the row is gone. Re-reading a deleted
            // capture would throw; leave the stale note on screen and let the
            // pop-back happen naturally when the user goes Home.
            break
        case .wrongWorkspace:
            finishError = "This recording belongs to another workspace. Switch to it to finish processing."
        case .failed(let message):
            finishError = message ?? "Couldn't finish processing. Try again in a moment."
        }
    }

    private var generatingSummaryRow: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
            Text("Generating summary…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 20)
    }

    private func sectionView(title: String, icon: String, color: Color, items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .foregroundStyle(color)
                Text(title)
                    .font(.subheadline.bold())
            }

            VStack(alignment: .leading, spacing: 6) {
                ForEach(items, id: \.self) { item in
                    HStack(alignment: .top, spacing: 8) {
                        Text("•")
                            .foregroundStyle(.secondary)
                        Text(item)
                            .font(.subheadline)
                    }
                }
            }
        }
        .padding(.horizontal, 20)
    }

    // MARK: - Action Items

    private func extractActionItems() -> [[String: AnyCodableValue]]? {
        guard let metadata = note.metadata,
              case .array(let items) = metadata["actionItems"] else { return nil }

        let dicts = items.compactMap { item -> [String: AnyCodableValue]? in
            if case .dictionary(let dict) = item { return dict }
            return nil
        }
        return dicts.isEmpty ? nil : dicts
    }

    private func actionItemsSection(_ items: [[String: AnyCodableValue]]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "checklist")
                    .foregroundStyle(.purple)
                Text("Action Items")
                    .font(.subheadline.bold())
                Text("\(items.count)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    if case .string(let action) = item["action"] {
                        HStack(alignment: .top, spacing: 10) {
                            Circle()
                                .stroke(Color.secondary.opacity(0.5), lineWidth: 1.5)
                                .frame(width: 20, height: 20)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(action)
                                    .font(.subheadline)
                                if case .string(let owner) = item["owner"], !owner.isEmpty, owner != "user" {
                                    Text(owner)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 20)
    }

    // MARK: - Participants

    private var participantsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
                .padding(.horizontal, 20)
                .padding(.top, 8)

            HStack(spacing: 6) {
                Image(systemName: "person.2.fill")
                    .foregroundStyle(.secondary)
                Text("Participants")
                    .font(.subheadline.bold())
            }
            .padding(.horizontal, 20)

            VStack(alignment: .leading, spacing: 4) {
                ForEach(note.participants) { participant in
                    Text(participant.displayName)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 20)
        }
    }

    // MARK: - Private Notes

    private func privateNotesSection(_ notes: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
                .padding(.horizontal, 20)
                .padding(.top, 8)

            HStack(spacing: 6) {
                Image(systemName: "note.text")
                    .foregroundStyle(.secondary)
                Text("Private Notes")
                    .font(.subheadline.bold())
            }
            .padding(.horizontal, 20)

            Text(notes)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 20)
        }
    }

    // MARK: - Transcript

    private func transcriptSection(_ transcript: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
                .padding(.horizontal, 20)
                .padding(.top, 8)

            Button {
                withAnimation { showTranscript.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "mic.fill")
                        .foregroundStyle(.secondary)
                    Text("Transcript")
                        .font(.subheadline.bold())
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(showTranscript ? 90 : 0))
                }
                .foregroundStyle(.primary)
                .padding(.horizontal, 20)
            }
            .buttonStyle(.plain)

            if showTranscript {
                Text(transcript)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 20)
            }
        }
    }

    // MARK: - Chat Button

    private var chatButton: some View {
        Button {
            showingChat = true
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "bubble.left.fill")
                    .font(.system(size: 16))
                Text("Chat with meeting")
                    .font(.subheadline.weight(.medium))
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, 24)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 20)
        .padding(.bottom, 8)
    }

    // MARK: - Helpers

    private var participantsSummary: String {
        let names = note.participants.prefix(3).map { $0.displayName }
        if note.participants.count > 3 {
            return names.joined(separator: ", ") + " +\(note.participants.count - 3)"
        }
        return names.joined(separator: ", ")
    }

    private func formatNoteDate(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return "Today, " + date.formatted(date: .omitted, time: .shortened)
        } else if calendar.isDateInYesterday(date) {
            return "Yesterday, " + date.formatted(date: .omitted, time: .shortened)
        }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    private func formatDuration(_ seconds: Int) -> String {
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        if hours > 0 {
            return "\(hours)h \(minutes)m"
        }
        return "\(minutes)m"
    }
}
