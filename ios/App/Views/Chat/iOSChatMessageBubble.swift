//
//  iOSChatMessageBubble.swift
//  dial8
//
//  Displays a single chat message in the iOS chat sheet.
//
//  User messages are a right-aligned gray bubble (no accent colour — the sheet
//  is dark glass and a blue bubble fought with it). Assistant messages have no
//  bubble at all: plain left-aligned Markdown running the full width, with a
//  row of small actions (copy / expand / thumbs) underneath.
//

import SwiftUI
import MarkdownUI

struct iOSChatMessageBubble: View {
    let message: AgentMessage

    /// Local-only reaction. Deliberately not persisted — this is a signal to
    /// analytics, not chat state, so there is no backend write and no
    /// round-trip before the icon fills in.
    @State private var reaction: Reaction?
    @State private var showingExpanded = false

    enum Reaction {
        case up
        case down
    }

    var body: some View {
        if message.role == .user {
            HStack(alignment: .top) {
                Spacer(minLength: 40)
                userBubble
            }
            .padding(.horizontal, 16)
        } else {
            assistantMessage
                .padding(.horizontal, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - User Bubble

    private var userBubble: some View {
        Text(message.content)
            .font(.body)
            .foregroundStyle(.primary)
            .multilineTextAlignment(.leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(Color(.secondarySystemFill))
            )
            // Measure the actual container (the sheet), not the device screen —
            // UIScreen.main is deprecated in iOS 26 and mis-measures inside a sheet.
            .containerRelativeFrame(.horizontal, alignment: .trailing) { width, _ in
                width * 0.75
            }
    }

    // MARK: - Assistant Message

    private var assistantMessage: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Tool calls stay as compact chips above the answer
            if let toolCalls = message.toolCalls, !toolCalls.isEmpty {
                ForEach(Array(toolCalls.enumerated()), id: \.offset) { _, toolCall in
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.green)
                        Text(toolCall.toolName.replacingOccurrences(of: "_", with: " "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if !message.content.isEmpty {
                Markdown(message.content)
                    .font(.body)
                    .frame(maxWidth: .infinity, alignment: .leading)

                actionRow
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .sheet(isPresented: $showingExpanded) {
            expandedSheet
        }
    }

    // MARK: - Action Row

    private var actionRow: some View {
        HStack(spacing: 20) {
            actionButton(systemImage: "doc.on.clipboard", label: "Copy message") {
                UIPasteboard.general.string = message.content
                print("📋 iOSChatMessageBubble: copied message \(message.id.uuidString.prefix(8))")
            }

            actionButton(
                systemImage: "arrow.up.left.and.arrow.down.right",
                label: "Expand message"
            ) {
                showingExpanded = true
            }

            actionButton(
                systemImage: reaction == .up ? "hand.thumbsup.fill" : "hand.thumbsup",
                label: "Good response"
            ) {
                toggle(.up)
            }

            actionButton(
                systemImage: reaction == .down ? "hand.thumbsdown.fill" : "hand.thumbsdown",
                label: "Bad response"
            ) {
                toggle(.down)
            }

            Spacer(minLength: 0)
        }
        .padding(.top, 2)
    }

    private func actionButton(
        systemImage: String,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 18, weight: .regular))
                .foregroundStyle(.secondary)
                .frame(width: 26, height: 26)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    /// Thumbs are mutually exclusive; tapping the active one clears it.
    private func toggle(_ value: Reaction) {
        reaction = (reaction == value) ? nil : value

        let name: String
        switch reaction {
        case .up: name = "up"
        case .down: name = "down"
        case nil: name = "none"
        }

        print("📊 iOSChatMessageBubble: reaction '\(name)' on \(message.id.uuidString.prefix(8))")
        AnalyticsService.shared.trackChatMessageReaction(reaction: name)
    }

    // MARK: - Expanded Sheet

    /// Full-screen read of one answer. `.textSelection` makes the whole thing
    /// copyable by hand, which is why the plain-text fallback is a `Text` rather
    /// than a second Markdown render.
    private var expandedSheet: some View {
        NavigationStack {
            ScrollView {
                Markdown(message.content)
                    .font(.body)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(20)
            }
            .navigationTitle("Response")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { showingExpanded = false }
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }
}
