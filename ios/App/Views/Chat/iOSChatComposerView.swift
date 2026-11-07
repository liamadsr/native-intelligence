//
//  iOSChatComposerView.swift
//  dial8
//
//  The chat composer card: a near-black rounded card holding attached-capture
//  chips, a growing multiline text field, and a control row (paperclip → attach
//  a meeting, model pill, and a mic that flips to send once there's text).
//

import SwiftUI

struct iOSChatComposerView: View {
    @Binding var text: String
    let isProcessing: Bool
    let placeholder: String
    let onSend: () -> Void

    /// Captures currently attached as chat context (resolved Notes, newest first).
    let attachedNotes: [Note]
    /// The 6 most recent captures offered in the paperclip menu.
    let recentNotes: [Note]
    let onAttach: (Note) -> Void
    let onDetach: (Note) -> Void

    /// Live dictation. Owned by the chat view so it can be stopped on dismiss.
    @ObservedObject var dictation: ChatDictationService
    let onToggleDictation: () -> Void
    /// A capture already owns the mic — the dictation button is inert.
    let micDisabled: Bool

    @ObservedObject private var config = ClaudeConfiguration.shared

    @Environment(\.colorScheme) private var colorScheme

    // MARK: - Derived state

    private var trimmedText: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var hasText: Bool { !trimmedText.isEmpty }

    private var canSend: Bool { hasText && !isProcessing }

    private var cardFill: Color {
        // Dark: near-black, a touch lifted off the sheet's glass.
        // Light: the standard grouped-secondary surface.
        colorScheme == .dark ? Color(.systemBackground).opacity(0.85) : Color(.secondarySystemBackground)
    }

    // MARK: - Body

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !attachedNotes.isEmpty {
                attachmentChips
            }

            TextField(placeholder, text: $text, axis: .vertical)
                .font(.body)
                .lineLimit(1...6)
                .textFieldStyle(.plain)
                .submitLabel(.send)
                .onSubmit {
                    guard canSend else { return }
                    onSend()
                }
                .padding(.horizontal, 16)
                .padding(.top, attachedNotes.isEmpty ? 14 : 6)
                .padding(.bottom, 4)

            if dictation.isListening, !dictation.interimText.isEmpty {
                Text(dictation.interimText)
                    .font(.body)
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 4)
                    .transition(.opacity)
            }

            // Why the mic did nothing. Under the on-device stack this is a
            // COMMON state, not a rare failure: on a fresh install the speech
            // model is still downloading, and on an unsupported iPhone it never
            // arrives. Without this the mic button is simply dead with no
            // explanation, over and over.
            if let dictationError = dictation.errorMessage {
                Text(dictationError)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 4)
                    .transition(.opacity)
            }

            controlRow
        }
        .background(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(cardFill)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .strokeBorder(Color(.separator).opacity(0.35), lineWidth: 0.5)
        )
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    // MARK: - Attachment Chips

    private var attachmentChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(attachedNotes) { note in
                    HStack(spacing: 5) {
                        Image(systemName: note.type.icon)
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)

                        Text(note.title)
                            .font(.caption)
                            .lineLimit(1)
                            .foregroundStyle(.primary)

                        Button {
                            onDetach(note)
                        } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundStyle(.secondary)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Remove \(note.title)")
                    }
                    .padding(.horizontal, 9)
                    .padding(.vertical, 6)
                    .background(Color(.tertiarySystemFill), in: Capsule())
                }
            }
            .padding(.horizontal, 14)
        }
        .scrollBounceBehavior(.basedOnSize)
        .padding(.top, 12)
        .padding(.bottom, 2)
    }

    // MARK: - Control Row

    private var controlRow: some View {
        HStack(spacing: 8) {
            attachMenu
            modelPill

            Spacer(minLength: 8)

            trailingControl
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 10)
        .padding(.top, 2)
    }

    // MARK: - Attach Menu

    private var attachMenu: some View {
        Menu {
            Section("Attach a meeting") {
                if recentNotes.isEmpty {
                    Text("No recent captures")
                } else {
                    ForEach(recentNotes) { note in
                        Button {
                            onAttach(note)
                        } label: {
                            Label(
                                "\(note.title) · \(Self.relativeDate(for: note))",
                                systemImage: note.type.icon
                            )
                        }
                    }
                }
            }
        } label: {
            Image(systemName: "paperclip")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Color.primary)
                .frame(width: 44, height: 44)
                .background(Color(.tertiarySystemFill), in: Circle())
                .contentShape(Circle())
        }
        // A Menu label inherits the accent tint, which rendered the glyph blue.
        // The composer is neutral: tint the control itself to .primary.
        .menuStyle(.automatic)
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
        .tint(Color.primary)
        .accessibilityLabel("Attach a meeting")
    }

    /// Relative date for the menu row ("2 days ago"). Uses the recording time
    /// when there is one, otherwise the row's creation time.
    private static func relativeDate(for note: Note) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: note.recordedAt ?? note.createdAt, relativeTo: Date())
    }

    // MARK: - Model Pill

    private var modelPill: some View {
        Menu {
            // "Auto" leads — it's the default and it defers model choice to the
            // backend rather than pinning one here.
            ForEach(Self.orderedModels, id: \.self) { model in
                Button {
                    config.selectedModel = model
                } label: {
                    modelRowLabel(for: model)
                }
            }
        } label: {
            HStack(spacing: 5) {
                Text(config.selectedModel.displayName)
                    .font(.subheadline)
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)

                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Color.secondary)
            }
            .padding(.horizontal, 14)
            .frame(height: 34)
            .background(Color(.tertiarySystemFill), in: Capsule())
            .contentShape(Capsule())
        }
        // Same accent-tint inheritance as the attach menu — keep the pill neutral.
        .menuStyle(.automatic)
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
        .tint(Color.primary)
        .accessibilityLabel("Model: \(config.selectedModel.displayName)")
    }

    /// `.auto` first, then the concrete models in declaration order.
    private static var orderedModels: [ClaudeModel] {
        [.auto] + ClaudeModel.allCases.filter { $0 != .auto }
    }

    @ViewBuilder
    private func modelRowLabel(for model: ClaudeModel) -> some View {
        let isSelected = config.selectedModel == model
        let title = model.isPremium ? "\(model.displayName) (Pro)" : model.displayName

        if isSelected {
            Label(title, systemImage: "checkmark")
        } else {
            Label(title, systemImage: model.icon)
        }
    }

    // MARK: - Trailing Control (mic / send / spinner)

    @ViewBuilder
    private var trailingControl: some View {
        if isProcessing {
            ZStack {
                Circle()
                    .fill(Color(.tertiarySystemFill))
                    .frame(width: 44, height: 44)
                ProgressView()
                    .controlSize(.small)
            }
            .accessibilityLabel("Sending")
        } else if hasText {
            sendButton
        } else {
            micButton
        }
    }

    private var sendButton: some View {
        Button {
            guard canSend else { return }
            onSend()
        } label: {
            ZStack {
                Circle()
                    .fill(canSend ? Color.primary : Color(.tertiarySystemFill))
                    .frame(width: 44, height: 44)

                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(canSend ? Color(.systemBackground) : Color(.tertiaryLabel))
            }
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .accessibilityLabel("Send message")
    }

    private var micButton: some View {
        Button {
            guard !micDisabled else { return }
            onToggleDictation()
        } label: {
            ZStack {
                // Neutral, same weight as the send button (primary fill,
                // background-colored glyph); red only while listening.
                Circle()
                    .fill(dictation.isListening ? Color.red : Color.primary)
                    .frame(width: 44, height: 44)
                    .opacity(micDisabled ? 0.35 : 1)

                Image(systemName: dictation.isListening ? "stop.fill" : "mic.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(dictation.isListening ? Color.white : Color(.systemBackground))
                    .opacity(micDisabled ? 0.5 : 1)
            }
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(micDisabled)
        // Pulse while listening so "we're recording you" is unmistakable.
        .scaleEffect(dictation.isListening ? 1.06 : 1.0)
        .animation(
            dictation.isListening
                ? .easeInOut(duration: 0.7).repeatForever(autoreverses: true)
                : .default,
            value: dictation.isListening
        )
        .accessibilityLabel(
            micDisabled
                ? "Dictation unavailable while recording"
                : (dictation.isListening ? "Stop dictation" : "Dictate a message")
        )
    }
}

// MARK: - Suggestion Chips

/// Compact capsule chips that sit directly above the composer card while the
/// conversation is still empty.
struct iOSChatSuggestionChips: View {
    let suggestions: [String]
    let onSelect: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(suggestions, id: \.self) { suggestion in
                    Button {
                        onSelect(suggestion)
                    } label: {
                        Text(suggestion)
                            .font(.subheadline)
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .background(Color(.secondarySystemFill), in: Capsule())
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
        }
        .scrollBounceBehavior(.basedOnSize)
        .padding(.bottom, 8)
    }
}
