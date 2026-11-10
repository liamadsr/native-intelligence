//
//  iOSActiveRecordingView.swift
//  Native Intelligence
//
//  Full-height active-recording sheet. A serif title field, metadata chips, a
//  notes editor (or the live transcript), and one floating control bar.
//  Dismissing the sheet does NOT stop the recording — the chevron collapses it.
//
//  Uses shared models: TranscriptSegment, RecordingState, AudioSource
//

import SwiftUI
import PhotosUI

struct iOSActiveRecordingView: View {
    @StateObject private var recordingService = iOSRecordingService.shared
    @StateObject private var notesService = NotesService.shared
    @StateObject private var projectsService = ProjectsService.shared
    @StateObject private var sttManager = STTProviderManager.shared
    /// Gates recording: iOS transcribes entirely on-device, so an unready model
    /// means no session at all (see `startRecordingIfNeeded`).
    @StateObject private var speechModel = SpeechModelManager.shared
    @Environment(\.dismiss) private var dismiss

    @State private var saveError: String?
    @State private var isSaving = false
    @State private var showDiscardConfirmation = false
    /// Non-blocking notice shown when the API create failed and the recording was
    /// written straight to the DB instead — that note gets no server-side summary,
    /// and silently swallowing that left the user waiting for one that never came.
    @State private var offlineNotice: String?
    @State private var photoSelection: PhotosPickerItem?
    @State private var showingFileImporter = false
    @State private var attachmentNotice: String?
    @FocusState private var isNotesEditorFocused: Bool
    @FocusState private var isTitleFocused: Bool

    // MARK: - Session composer state
    //
    // SwiftUI rebuilds the sheet's content on every presentation, so anything the
    // user types here has to live on the service, not in @State. The chevron is
    // the documented way to collapse the sheet while recording continues, and
    // reopening it used to come back with the title and project blanked.

    /// User-typed note title. Applied on save via `updateNote`.
    private var noteTitle: String { recordingService.liveNoteTitle }
    /// Project chosen from the folder chip. Applied on save via `updateNote`
    /// (UpdateNoteDTO carries `project_id`), right after the title.
    private var selectedProjectId: UUID? { recordingService.liveSelectedProjectId }
    private var showTranscript: Bool { recordingService.liveShowTranscript }

    // MARK: - Palette
    //
    // Mirrors iOSNotesHomeView: every value is a dynamic UIColor so light mode
    // gets the inverse, not a hard-coded dark one. Neutral only — no accent.

    /// Sheet ground — #262626 dark / #F2F2F7 light. Also passed to
    /// `.presentationBackground` in iOSMainTabView so the two agree exactly.
    static let sheetBackground = Color(UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.149, green: 0.149, blue: 0.149, alpha: 1)   // #262626
            : UIColor(red: 0.949, green: 0.949, blue: 0.969, alpha: 1)   // #F2F2F7
    })

    /// Chip outline — a hairline separator, never a fill.
    private static let chipBorder = Color(UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor.white.withAlphaComponent(0.18)
            : UIColor.black.withAlphaComponent(0.14)
    })

    // MARK: - Body

    var body: some View {
        ZStack {
            Self.sheetBackground.ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                topBar
                    .padding(.horizontal, 16)
                    .padding(.top, 12)

                titleField
                    .padding(.horizontal, 20)
                    .padding(.top, 20)

                chipRow
                    .padding(.horizontal, 20)
                    .padding(.top, 14)

                banners

                Group {
                    if showTranscript {
                        transcriptList
                    } else {
                        notesEditor
                    }
                }
                .padding(.top, 14)
            }
            // The bar is a real layout inset, not a floating ZStack sibling. As
            // an overlay it rode up with the keyboard and got sliced in half
            // behind the markdown accessory bar — pause, the timer and
            // Cancel/Done all unreachable while typing notes, which is the whole
            // reason this sheet exists. As a safeAreaInset the content above it
            // shrinks instead, so the capsule always sits whole and tappable
            // above whatever the keyboard brings with it.
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    // The markdown bar lives HERE, not as a keyboard accessory.
                    // As an accessory it was laid over the sheet's keyboard safe
                    // area, which meant it painted across the recording capsule
                    // and cut pause / the timer / Cancel out of reach. Stacked
                    // into the same bottom inset, the two simply sit one above
                    // the other and the editor shrinks to clear both.
                    //
                    // The focus gate also fixes the second half of that bug: as
                    // an accessory on the whole hierarchy it appeared over the
                    // serif title field too, where its buttons — which write
                    // unconditionally into liveUserNotes — silently dropped
                    // `****` into the scrolled-away note body.
                    if isNotesEditorFocused {
                        iOSMarkdownToolbar(text: $recordingService.liveUserNotes)
                    }

                    recordingBar
                        .padding(.horizontal, 16)
                        .padding(.bottom, 10)
                }
            }
        }
        .background(Self.sheetBackground)
        .onAppear {
            startRecordingIfNeeded()
        }
        .onReceive(NotificationCenter.default.publisher(for: .openRecordingSheet)) { _ in
            // A second press (Action Button, control, widget link) while the
            // sheet is ALREADY open cannot re-present it, so without this the
            // press lands nowhere — which matters most when the first attempt
            // was refused and the user is retrying. `startRecordingIfNeeded` is
            // guarded, so this is a no-op during a live session.
            startRecordingIfNeeded()
        }
        .onChange(of: speechModel.isReady) { _, ready in
            // A model that finished downloading while the sheet was open should
            // start the session the user already asked for, not make them tap
            // again. Clears the explanatory banner on the way through.
            guard ready, recordingService.state == .idle, recordingService.segments.isEmpty else { return }
            recordingService.errorMessage = nil
            startRecordingIfNeeded()
        }
        .onChange(of: recordingService.captureCreateFailed) { _, failed in
            // Fires while still recording, the moment the create round-trip fails
            // — so the user learns about it before they finish, not after.
            guard failed else { return }
            showOfflineNotice()
        }
        .onChange(of: photoSelection) { _, item in
            guard let item else { return }
            Task { await attachPickedPhoto(item) }
        }
        .fileImporter(
            isPresented: $showingFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: false
        ) { result in
            switch result {
            case .success(let urls):
                guard let url = urls.first else { return }
                Task { await attachFile(at: url) }
            case .failure(let error):
                attachmentNotice = "Couldn't open that file: \(error.localizedDescription)"
            }
        }
        // An .alert rather than a .confirmationDialog: on iOS 26 the action sheet
        // rendered the destructive button alone — no title, no visible Cancel —
        // leaving a tap outside as the only (undiscoverable) way to back out of
        // destroying a recording. An alert renders both actions reliably.
        .alert("Discard Recording?", isPresented: $showDiscardConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Discard", role: .destructive) {
                discardRecording()
            }
        } message: {
            Text("This will stop the recording and discard all captured audio and transcript.")
        }
    }

    // MARK: - Top Bar

    /// Left: a glass circle that collapses the sheet (recording continues).
    /// Right: one glass capsule holding the attach and overflow controls.
    private var topBar: some View {
        HStack(spacing: 0) {
            Button {
                dismiss()
            } label: {
                Image(systemName: "chevron.down")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.primary)
                    .frame(width: 44, height: 44)
                    .contentShape(Circle())
                    .glassEffect(.regular.interactive(), in: .circle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Collapse")

            Spacer()

            HStack(spacing: 0) {
                Menu {
                    PhotosPicker(selection: $photoSelection, matching: .images) {
                        Label("Photo", systemImage: "photo")
                    }
                    Button {
                        showingFileImporter = true
                    } label: {
                        Label("File", systemImage: "doc")
                    }
                } label: {
                    Image(systemName: "paperclip")
                        .font(.system(size: 16, weight: .regular))
                        .foregroundStyle(.primary)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                // A Menu tints its own label with the accent colour and ignores
                // the .foregroundStyle on it — which rendered these glyphs system
                // blue. Neutral is the whole point of this sheet.
                .tint(.primary)
                .accessibilityLabel("Attach")

                Menu {
                    Button {
                        stopAndSave()
                    } label: {
                        Label("Finish recording", systemImage: "checkmark")
                    }

                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            recordingService.liveShowTranscript.toggle()
                        }
                    } label: {
                        Label(
                            showTranscript ? "Hide transcript" : "Show transcript",
                            systemImage: showTranscript ? "text.alignleft" : "waveform"
                        )
                    }

                    Divider()

                    Button(role: .destructive) {
                        showDiscardConfirmation = true
                    } label: {
                        Label("Discard recording", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.primary)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .tint(.primary)
                .accessibilityLabel("More")
            }
            .glassEffect(.regular.interactive(), in: .capsule)
        }
    }

    // MARK: - Title

    private var titleField: some View {
        TextField("", text: $recordingService.liveNoteTitle)
            .font(.system(size: 34, weight: .regular, design: .serif))
            .foregroundStyle(.primary)
            .tint(.primary)
            .submitLabel(.done)
            .textInputAutocapitalization(.sentences)
            .focused($isTitleFocused)
            // The default placeholder tint is a system grey we don't control;
            // an overlay lets the placeholder sit in our own secondary.
            .overlay(alignment: .leading) {
                if noteTitle.isEmpty {
                    Text("Untitled note")
                        .font(.system(size: 34, weight: .regular, design: .serif))
                        .foregroundStyle(.secondary)
                        .allowsHitTesting(false)
                }
            }
            // Claim the whole row, THEN put the tap-catcher on that row. An
            // empty TextField's own hit region is zero-width and anchored at its
            // leading edge, so a tap on the placeholder missed it entirely and
            // fell through to the notes editor. The catcher is gated to the
            // empty state — over a field with text it would block caret
            // placement.
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .overlay {
                if noteTitle.isEmpty {
                    Color.clear
                        .contentShape(Rectangle())
                        .onTapGesture { isTitleFocused = true }
                }
            }
    }

    // MARK: - Chips

    private var chipRow: some View {
        HStack(spacing: 8) {
            chip {
                HStack(spacing: 6) {
                    Text(startTimeLabel)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.secondary)
                    Image(systemName: "person.2")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                }
            }

            Menu {
                Button {
                    recordingService.liveSelectedProjectId = nil
                } label: {
                    Label("No project", systemImage: selectedProjectId == nil ? "checkmark" : "tray")
                }
                ForEach(projectsService.activeProjects) { project in
                    Button {
                        recordingService.liveSelectedProjectId = project.id
                    } label: {
                        Label(
                            project.name,
                            systemImage: selectedProjectId == project.id ? "checkmark" : "folder"
                        )
                    }
                }
            } label: {
                chip {
                    HStack(spacing: 6) {
                        Image(systemName: selectedProjectName == nil ? "folder.badge.plus" : "folder")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.secondary)
                        if let name = selectedProjectName {
                            Text(name)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .tint(.primary)
            .accessibilityLabel("Project")

            Spacer(minLength: 0)
        }
        .task {
            // The menu is useless with an empty list, and Home doesn't
            // necessarily populate ProjectsService before the sheet opens.
            if projectsService.projects.isEmpty {
                try? await projectsService.fetchProjects()
            }
        }
    }

    private func chip<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .padding(.horizontal, 12)
            .frame(height: 30)
            .overlay(
                Capsule().strokeBorder(Self.chipBorder, lineWidth: 0.5)
            )
    }

    private var selectedProjectName: String? {
        guard let selectedProjectId else { return nil }
        return projectsService.activeProjects.first { $0.id == selectedProjectId }?.name
    }

    /// "Today 3:18 PM" / "Yesterday 3:18 PM" / "Sep 9 3:18 PM".
    private var startTimeLabel: String {
        let start = recordingService.recordingStartedAt ?? Date()
        let time = start.formatted(date: .omitted, time: .shortened)
        let calendar = Calendar.current
        if calendar.isDateInToday(start) { return "Today \(time)" }
        if calendar.isDateInYesterday(start) { return "Yesterday \(time)" }
        return "\(start.formatted(.dateTime.month(.abbreviated).day())) \(time)"
    }

    // MARK: - Banners

    @ViewBuilder
    private var banners: some View {
        if let error = recordingService.errorMessage {
            bannerRow(icon: "exclamationmark.triangle", message: error, dismissable: true)
        }
        if let error = saveError {
            bannerRow(icon: "exclamationmark.triangle", message: error, dismissable: true)
        }
        if let notice = offlineNotice {
            bannerRow(icon: "wifi.slash", message: notice, dismissable: false)
                .transition(.opacity)
        }
        if let notice = attachmentNotice {
            bannerRow(icon: "paperclip", message: notice, dismissable: false)
                .transition(.opacity)
        }
    }

    private func bannerRow(icon: String, message: String, dismissable: Bool) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
            Text(message)
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            if dismissable {
                Button {
                    recordingService.errorMessage = nil
                    saveError = nil
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
    }

    // MARK: - Notes Editor

    private var notesEditor: some View {
        TextEditor(text: $recordingService.liveUserNotes)
            .font(.body)
            .scrollContentBackground(.hidden)
            .focused($isNotesEditorFocused)
            .tint(.primary)
            // The bar is a safeAreaInset now, so the editor already ends above
            // it — this is just breathing room, not the 100pt it needed when the
            // bar floated over the content.
            .contentMargins(.bottom, 12, for: .scrollContent)
            .overlay(alignment: .topLeading) {
                if recordingService.liveUserNotes.isEmpty {
                    Text("Write notes here…")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .padding(.top, 8)
                        .padding(.leading, 5)
                        .allowsHitTesting(false)
                }
            }
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .onChange(of: recordingService.liveUserNotes) { oldValue, newValue in
                if newValue.count > oldValue.count && newValue.hasSuffix("\n") {
                    var text = newValue
                    iOSMarkdownToolbar.continueLists(in: &text, oldText: oldValue)
                    if text != newValue {
                        recordingService.liveUserNotes = text
                    }
                }
            }
            // The markdown bar is attached in the sheet's bottom safeAreaInset
            // (see `body`), not here as a keyboard accessory — see the comment
            // there for why.
    }

    // MARK: - Transcript

    private var transcriptList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                if recordingService.segments.isEmpty {
                    Text(recordingService.isRecording ? "Listening…" : "No transcript yet")
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 32)
                } else {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(sortedSegments) { segment in
                            TranscriptSegmentBubble(segment: segment)
                                .id(segment.id)
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 8)
                }
            }
            .contentMargins(.bottom, 12, for: .scrollContent)
            .onChange(of: recordingService.segments.count) { _, _ in
                guard let last = sortedSegments.last else { return }
                withAnimation(.easeOut(duration: 0.3)) {
                    proxy.scrollTo(last.id, anchor: .bottom)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var sortedSegments: [TranscriptSegment] {
        recordingService.segments.sorted { $0.segmentIndex < $1.segmentIndex }
    }

    // MARK: - Recording Bar

    /// One capsule floating over the content. `Color.primary` ground (white in
    /// dark, black in light) with every child in `Color(.systemBackground)` so
    /// the contrast inverts with the theme instead of being pinned to one.
    private var recordingBar: some View {
        HStack(spacing: 12) {
            Button {
                if recordingService.isPaused {
                    recordingService.resumeRecording()
                } else {
                    recordingService.pauseRecording()
                }
            } label: {
                Image(systemName: recordingService.isPaused ? "play.fill" : "pause.fill")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(Color(.systemBackground))
                    .frame(width: 56, height: 56)
                    .background(Color(.systemBackground).opacity(0.18), in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(!recordingService.hasActiveSession || isSaving)
            .accessibilityLabel(recordingService.isPaused ? "Resume" : "Pause")

            Spacer(minLength: 0)

            HStack(spacing: 10) {
                levelMeter
                Text(recordingService.formattedDuration)
                    .font(.system(size: 20, weight: .semibold, design: .rounded).monospacedDigit())
                    .foregroundStyle(Color(.systemBackground))
            }

            Spacer(minLength: 0)

            Button {
                if recordingService.isPaused {
                    stopAndSave()
                } else {
                    showDiscardConfirmation = true
                }
            } label: {
                Text(recordingService.isPaused ? "Done" : "Cancel")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Color(.systemBackground))
                    .padding(.horizontal, 20)
                    .frame(height: 44)
                    .background(Color(.systemBackground).opacity(0.18), in: Capsule())
            }
            .buttonStyle(.plain)
            .disabled(isSaving)
        }
        .padding(.horizontal, 10)
        .frame(height: 76)
        .background(Color.primary, in: Capsule())
    }

    /// Five bars driven by the live mic level. Each bar reads a different slice
    /// of the level so the group breathes rather than moving as one block; the
    /// 3pt floor keeps the meter visible in silence instead of collapsing to
    /// nothing.
    private var levelMeter: some View {
        HStack(alignment: .center, spacing: 3) {
            ForEach(0..<5, id: \.self) { index in
                Capsule()
                    .fill(Color(.systemBackground))
                    .frame(width: 3, height: barHeight(index))
            }
        }
        .frame(height: 26)
        .animation(.easeOut(duration: 0.12), value: recordingService.inputLevel)
    }

    private func barHeight(_ index: Int) -> CGFloat {
        // Centre bars react most, outer bars least — a fixed weighting, so a
        // steady tone still looks like a meter and not a flat row.
        let weights: [CGFloat] = [0.45, 0.75, 1.0, 0.75, 0.45]
        let level = CGFloat(recordingService.inputLevel)
        return 3 + (level * weights[index] * 23)
    }

    // MARK: - Attachments

    /// Files are attached to the capture row created at recording start. Without
    /// one (offline fallback) there is nothing to attach to, and saying so beats
    /// a silent no-op.
    private func attachPickedPhoto(_ item: PhotosPickerItem) async {
        defer { photoSelection = nil }
        guard let captureId = recordingService.activeCaptureId else {
            showAttachmentNotice("Attachments need a saved capture — try again in a moment")
            return
        }
        guard let data = try? await item.loadTransferable(type: Data.self) else {
            showAttachmentNotice("Couldn't read that photo")
            return
        }
        let name = "photo-\(Int(Date().timeIntervalSince1970)).jpg"
        do {
            _ = try await AttachmentService.shared.uploadAttachmentData(
                data: data,
                fileName: name,
                noteId: captureId,
                projectId: selectedProjectId
            )
            showAttachmentNotice("Attached \(name)")
        } catch {
            showAttachmentNotice("Attach failed: \(error.localizedDescription)")
        }
    }

    private func attachFile(at url: URL) async {
        guard let captureId = recordingService.activeCaptureId else {
            showAttachmentNotice("Attachments need a saved capture — try again in a moment")
            return
        }
        do {
            _ = try await AttachmentService.shared.uploadAttachment(
                fileURL: url,
                noteId: captureId,
                projectId: selectedProjectId
            )
            showAttachmentNotice("Attached \(url.lastPathComponent)")
        } catch {
            showAttachmentNotice("Attach failed: \(error.localizedDescription)")
        }
    }

    private func showAttachmentNotice(_ message: String) {
        withAnimation { attachmentNotice = message }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            withAnimation { attachmentNotice = nil }
        }
    }

    // MARK: - Actions

    /// Show the offline notice for a few seconds, then let it fade. Deliberately
    /// non-blocking — the recording is safe either way, this only explains why no
    /// summary will appear for it.
    private func showOfflineNotice() {
        let message = "Saved offline — this note won't get a summary"
        print("⚠️ [ActiveRecording] \(message) (capture API create failed)")
        withAnimation { offlineNotice = message }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            withAnimation { offlineNotice = nil }
        }
    }

    /// Tear down the session and wait for the server DELETE before letting the
    /// sheet close. `onDismiss` on the presenting sheet kicks off a notes refresh
    /// the moment we dismiss; without the await that refetch outran the DELETE
    /// and the discarded capture came straight back onto Home.
    private func discardRecording() {
        guard !isSaving else { return }
        isSaving = true
        let deleteTask = recordingService.cancelRecording()

        Task { @MainActor in
            await deleteTask?.value
            isSaving = false
            dismiss()
        }
    }

    /// Start only when the on-device model is genuinely ready. When it isn't,
    /// say why in the banner instead of opening a session that can't transcribe —
    /// and kick off a prewarm so a download in progress finishes and the user can
    /// simply tap record again.
    private func startRecordingIfNeeded() {
        guard recordingService.state == .idle else { return }
        // Segments still hanging around with an idle service means the previous
        // capture was never saved or discarded (a save that errored leaves
        // exactly that). Starting here would wipe it — `startRecording()` resets
        // the transcript — so refuse, but SAY SO. This used to return silently,
        // which made every Action Button press after a failed save open a
        // recorder that simply never started.
        guard recordingService.segments.isEmpty else {
            if recordingService.errorMessage == nil && saveError == nil {
                recordingService.errorMessage = "This capture hasn't been saved yet — save or discard it before starting a new one."
            }
            return
        }
        guard speechModel.isReady else {
            recordingService.errorMessage = speechModel.userFacingMessage
            Task { await speechModel.prewarm() }
            return
        }
        do {
            try recordingService.startRecording()
        } catch {
            recordingService.errorMessage = error.localizedDescription
        }
    }

    private func stopAndSave() {
        guard recordingService.hasActiveSession, !isSaving else { return }
        recordingService.stopRecording()
        isSaving = true

        Task {
            // On-device finals land only while the analyzer drains, so the save
            // MUST wait for that rather than for a guessed interval. (This used
            // to be a fixed 1.5s sleep, which with the streaming backend merely
            // let the socket flush; here it would truncate every transcript.)
            await recordingService.awaitFinalization()
            await saveNote()
        }
    }

    /// Finalize the recording.
    ///
    /// PRIMARY PATH: the capture row was already created through
    /// `POST /api/account/captures` when recording started, and the transcript
    /// has been streamed into it. `finalizeCaptureOnServer` runs the rest of the
    /// website's pipeline — final transcript save, the ended_at PATCH, then the
    /// batch extraction and title generation that actually produce a title,
    /// summary and extracted actions.
    ///
    /// FALLBACK PATH: only when the API create failed (offline). We fall back to
    /// the legacy direct Supabase INSERT so the recording is never lost — but
    /// that row gets no AI processing, and the log says so.
    @MainActor
    private func saveNote() async {
        let userNotes = recordingService.liveUserNotes

        if recordingService.activeCaptureId != nil {
            print("💾 [ActiveRecording] Saving via API capture pipeline")
            let captureId = await recordingService.finalizeCaptureOnServer(userNotes: userNotes)

            // Apply a user-typed title AFTER finalize: any non-placeholder title
            // makes the server's generate-title pass skip, which is exactly right
            // when the user named the capture themselves. The project moves on the
            // same PATCH — one round trip, not two.
            if let captureId, !noteTitle.isEmpty || selectedProjectId != nil {
                var dto = UpdateNoteDTO()
                if !noteTitle.isEmpty { dto.title = noteTitle }
                dto.projectId = selectedProjectId
                _ = try? await notesService.updateNote(id: captureId, dto: dto)
            }

            // The capture is finalized server-side — don't delete the row.
            recordingService.cancelRecording(deleteServerCapture: false)
            isSaving = false
            dismiss()
            return
        }

        // ── Offline fallback: direct DB insert, no downstream processing ──
        print("⚠️ [ActiveRecording] API capture unavailable — saving via direct DB insert (no AI processing)")
        showOfflineNotice()
        let transcript = recordingService.fullTranscript
        let plain = recordingService.plainTranscript

        let dto = CreateNoteDTO(
            projectId: selectedProjectId,
            type: .meeting,
            title: noteTitle.isEmpty ? "Voice Note" : noteTitle,
            content: userNotes.isEmpty ? plain : userNotes,
            transcript: transcript,
            durationSeconds: Int(recordingService.elapsedSeconds),
            recordedAt: Date()
        )

        do {
            let note = try await notesService.createNote(dto)

            if !userNotes.isEmpty {
                var update = UpdateNoteDTO()
                update.userNotes = userNotes
                _ = try? await notesService.updateNote(id: note.id, dto: update)
            }

            recordingService.cancelRecording(deleteServerCapture: false)
            isSaving = false
            // Hold the sheet open briefly so the offline notice is actually read
            // before it disappears with the sheet.
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            dismiss()
        } catch {
            saveError = "Failed to save: \(error.localizedDescription)"
            isSaving = false
        }
    }
}
