//
//  iOSVoiceNoteRecordingView.swift
//  Native Intelligence
//
//  Voice note recording view for iOS. Captures audio and transcribes live via
//  on-device transcription through iOSRecordingService — the same live
//  path as the main recorder. Transcript appears in real time; on stop it is
//  saved as a note.
//

import SwiftUI

struct iOSVoiceNoteRecordingView: View {
    @StateObject private var recordingService = iOSRecordingService.shared
    /// Observed DIRECTLY: `STTProviderManager.isReady` forwards to this object
    /// but never republishes when it settles, so binding to the forwarder alone
    /// would leave the Record button greyed out after the model finished
    /// downloading until the user left the screen and came back.
    @StateObject private var speechModel = SpeechModelManager.shared
    @StateObject private var notesService = NotesService.shared
    @Environment(\.dismiss) private var dismiss

    @State private var isSaving = false
    @State private var errorMessage: String?
    /// Non-blocking notice for the offline fallback path — that note is saved but
    /// never gets a server-side summary, and silently swallowing that left the
    /// user waiting for one that was never coming.
    @State private var offlineNotice: String?
    @State private var noteTitle = ""
    @State private var selectedNoteType: NoteType = .meeting

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Spacer()

                recordingIndicator
                statusText
                recordButton

                Spacer()

                // Live transcript preview
                if !recordingService.segments.isEmpty {
                    transcriptResultView(recordingService.plainTranscript)
                }

                if let error = errorMessage ?? recordingService.errorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }

                if let notice = offlineNotice {
                    HStack(spacing: 8) {
                        Image(systemName: "wifi.slash")
                            .font(.caption)
                        Text(notice)
                            .font(.caption)
                    }
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color(.tertiarySystemFill), in: Capsule())
                    .transition(.opacity)
                }
            }
            .padding()
            .navigationTitle("Voice Note")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        recordingService.cancelRecording()
                        dismiss()
                    }
                }

                if !recordingService.segments.isEmpty && !recordingService.isRecording {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            saveNote()
                        }
                        .fontWeight(.semibold)
                        .disabled(isSaving)
                    }
                }
            }
            .onChange(of: recordingService.captureCreateFailed) { _, failed in
                // Fires while still recording, the moment the create round-trip
                // fails — the user learns about it before they finish.
                guard failed else { return }
                showOfflineNotice()
            }
        }
    }

    /// Show the offline notice for a few seconds, then let it fade. Non-blocking:
    /// the recording is safe either way, this only explains the missing summary.
    private func showOfflineNotice() {
        let message = "Saved offline — this note won't get a summary"
        print("⚠️ [VoiceNote] \(message) (capture API create failed)")
        withAnimation { offlineNotice = message }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            withAnimation { offlineNotice = nil }
        }
    }

    // MARK: - Components

    private var recordingIndicator: some View {
        ZStack {
            if recordingService.isRecording {
                Circle()
                    .fill(.red.opacity(0.15))
                    .frame(width: 120, height: 120)
                    .scaleEffect(1.2)
                    .animation(.easeInOut(duration: 1.0).repeatForever(autoreverses: true), value: recordingService.isRecording)
            }

            Circle()
                .fill(recordingService.isRecording ? .red.opacity(0.3) : .gray.opacity(0.1))
                .frame(width: 100, height: 100)

            Image(systemName: recordingService.isRecording ? "waveform" : "mic.fill")
                .font(.system(size: 36))
                .foregroundStyle(recordingService.isRecording ? .red : .secondary)
        }
    }

    private var statusText: some View {
        Group {
            if isSaving {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Saving...")
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
            } else if recordingService.isRecording {
                Text(recordingService.formattedDuration)
                    .font(.title2.monospacedDigit())
                    .foregroundStyle(.primary)
            } else if !recordingService.segments.isEmpty {
                Text("Recording complete")
                    .font(.subheadline)
                    .foregroundStyle(.green)
            } else if let unavailable = speechModel.userFacingMessage {
                // On-device transcription, not auth: this is "still downloading",
                // "this iPhone can't", or "no model for this language" — telling
                // an already-signed-in user to sign in was simply wrong.
                Text(unavailable)
                    .font(.subheadline)
                    .foregroundStyle(.orange)
                    .multilineTextAlignment(.center)
            } else {
                Text("Tap to start recording")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var recordButton: some View {
        Button {
            if recordingService.isRecording {
                recordingService.stopRecording()
            } else {
                startRecording()
            }
        } label: {
            Text(recordingService.isRecording ? "Stop" : "Record")
                .font(.headline)
                .frame(width: 140, height: 44)
        }
        .buttonStyle(.borderedProminent)
        .tint(recordingService.isRecording ? .red : .blue)
        .disabled(isSaving || !speechModel.isReady || recordingService.state == .stopping)
    }

    private func transcriptResultView(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Transcript")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)

            ScrollView {
                Text(text.isEmpty ? "Listening..." : text)
                    .font(.body)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 200)
        }
        .padding()
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Actions

    private func startRecording() {
        errorMessage = nil
        guard recordingService.state == .idle else { return }
        guard SpeechModelManager.shared.isReady else {
            errorMessage = SpeechModelManager.shared.userFacingMessage
            Task { await SpeechModelManager.shared.prewarm() }
            return
        }
        do {
            try recordingService.startRecording()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Finalize the voice note.
    ///
    /// PRIMARY PATH: the capture row already exists (created via
    /// `POST /api/account/captures` at record start) with the transcript streamed
    /// into it, so we just run the rest of the website's pipeline —
    /// final transcript save → ended_at PATCH → batch extraction → title.
    /// Extraction is what produces the summary and the actions; nothing happens
    /// without it.
    ///
    /// FALLBACK PATH: direct Supabase INSERT, used only when the API create
    /// failed (offline). The note is saved but gets no AI processing.
    private func saveNote() {
        isSaving = true
        Task { @MainActor in await saveNoteAwaitingFinalization() }
    }

    /// The on-device analyzer delivers its last final results only while it
    /// drains, so EVERY read of the transcript below — the emptiness guard and
    /// the fallback DTO alike — has to happen after this await. Reading first
    /// (as the old synchronous body did) truncated the tail of every recording.
    @MainActor
    private func saveNoteAwaitingFinalization() async {
        await recordingService.awaitFinalization()

        let transcript = recordingService.fullTranscript
        let plain = recordingService.plainTranscript
        guard !plain.isEmpty else {
            errorMessage = "No transcript to save"
            isSaving = false
            return
        }

        if recordingService.activeCaptureId != nil {
            print("💾 [VoiceNote] Saving via API capture pipeline")
            let captureId = await recordingService.finalizeCaptureOnServer()

            // A user-typed title wins over the auto-generated one: any
            // non-placeholder title makes the server's generate-title skip.
            if let captureId, !noteTitle.isEmpty {
                var dto = UpdateNoteDTO()
                dto.title = noteTitle
                _ = try? await notesService.updateNote(id: captureId, dto: dto)
            }

            // Finalized server-side — don't delete the row on teardown.
            recordingService.cancelRecording(deleteServerCapture: false)
            isSaving = false
            dismiss()
            return
        }

        // ── Offline fallback: direct DB insert, no downstream processing ──
        print("⚠️ [VoiceNote] API capture unavailable — saving via direct DB insert (no AI processing)")
        showOfflineNotice()
        let dto = CreateNoteDTO(
            type: selectedNoteType,
            title: noteTitle.isEmpty ? "Voice Note" : noteTitle,
            content: plain,
            transcript: transcript,
            durationSeconds: Int(recordingService.elapsedSeconds),
            recordedAt: Date()
        )

        do {
            _ = try await notesService.createNote(dto)
            recordingService.cancelRecording(deleteServerCapture: false)
            isSaving = false
            // Hold the sheet briefly so the offline notice is read before it
            // disappears with the sheet.
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            dismiss()
        } catch {
            errorMessage = "Failed to save note: \(error.localizedDescription)"
            isSaving = false
        }
    }
}
