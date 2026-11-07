import SwiftUI

struct iOSActionDetailView: View {
    @StateObject private var actionsService = ActionsService.shared
    let action: Action

    /// Surfaced when a write fails (a 0-row match, a team with no Done column…).
    /// Same inline red-text pattern `iOSTodoTab` uses — a failed toggle used to
    /// only print, so the checkbox silently snapped back with no explanation.
    @State private var actionErrorMessage: String? = nil

    /// Live-updating action from the service (reflects backend changes)
    private var liveAction: Action {
        actionsService.actions.first { $0.id == action.id } ?? action
    }

    var body: some View {
        List {
            if let actionErrorMessage {
                Section {
                    Text(actionErrorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .listRowSeparator(.hidden)
                }
            }

            // Title & completion toggle
            Section {
                HStack(alignment: .top, spacing: 14) {
                    iOSTaskCheckbox(
                        isComplete: liveAction.status == .completed,
                        priority: liveAction.priority,
                        onToggle: { toggleCompletion() }
                    )
                    .padding(.top, 4)

                    VStack(alignment: .leading, spacing: 6) {
                        Text(liveAction.title)
                            .font(.title3.weight(.semibold))
                            .strikethrough(liveAction.status == .completed)
                            .foregroundStyle(liveAction.status == .completed ? .secondary : .primary)

                        HStack(spacing: 10) {
                            // The board column's own name ("Todo", "In Review")
                            // when the workflow state was embedded; the derived
                            // lifecycle label otherwise.
                            Label(liveAction.statusDisplayName, systemImage: statusIcon)
                                .font(.subheadline)
                                .foregroundStyle(statusColor)

                            if liveAction.priority != .none {
                                Label(liveAction.priority.displayName, systemImage: "flag.fill")
                                    .font(.subheadline)
                                    .foregroundStyle(priorityColor)
                            }
                        }
                    }
                }
            }

            // Description
            if let description = liveAction.description, !description.isEmpty {
                Section("Description") {
                    Text(description)
                        .font(.body)
                }
            }

            // Due date
            if let dueAt = liveAction.dueAt {
                Section("Due Date") {
                    Label(
                        dueAt.formatted(date: .long, time: liveAction.allDay ? .omitted : .shortened),
                        systemImage: "calendar"
                    )
                }
            }

            // Links
            if !liveAction.links.isEmpty {
                Section("Links") {
                    ForEach(liveAction.links, id: \.id) { link in
                        if let url = URL(string: link.url) {
                            Link(destination: url) {
                                Label(link.name ?? link.url, systemImage: "link")
                            }
                        }
                    }
                }
            }

            // Metadata
            Section("Details") {
                if let identifier = liveAction.identifier, !identifier.isEmpty {
                    LabeledContent("Identifier", value: identifier)
                }
                LabeledContent("Created", value: liveAction.createdAt.formatted(date: .abbreviated, time: .shortened))
                if let completedAt = liveAction.completedAt {
                    LabeledContent("Completed", value: completedAt.formatted(date: .abbreviated, time: .shortened))
                }
                if liveAction.aiConfidence > 0 {
                    LabeledContent("AI Confidence", value: "\(Int(liveAction.aiConfidence * 100))%")
                }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
    }

    private func toggleCompletion() {
        Task {
            do {
                if liveAction.status == .completed {
                    _ = try await actionsService.uncompleteAction(id: liveAction.id)
                } else {
                    _ = try await actionsService.completeAction(id: liveAction.id)
                }
                actionErrorMessage = nil
            } catch {
                actionErrorMessage = "Couldn't update that action: \(error.localizedDescription)"
                print("❌ iOSActionDetailView: Failed to toggle action completion: \(error)")
            }
        }
    }

    private var statusIcon: String {
        switch liveAction.status {
        case .completed: return "checkmark.circle.fill"
        case .inProgress: return "circle.dotted.circle"
        case .confirmed: return "circle"
        case .suggested: return "sparkle"
        case .cancelled: return "xmark.circle"
        }
    }

    private var statusColor: Color {
        switch liveAction.status {
        case .completed: return .green
        case .inProgress: return .blue
        case .confirmed: return .primary
        case .suggested: return .purple
        case .cancelled: return .secondary
        }
    }

    private var priorityColor: Color {
        switch liveAction.priority {
        case .urgent: return .red
        case .high: return .orange
        case .medium: return .yellow
        case .low, .none: return .secondary
        }
    }
}

// Simple flow layout for tags
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = arrange(proposal: proposal, subviews: subviews)
        return result.size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrange(proposal: proposal, subviews: subviews)
        for (index, position) in result.positions.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + position.x, y: bounds.minY + position.y),
                                  proposal: .unspecified)
        }
    }

    private func arrange(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, positions: [CGPoint]) {
        let maxWidth = proposal.width ?? .infinity
        var positions: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > maxWidth && x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            positions.append(CGPoint(x: x, y: y))
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
        }

        return (CGSize(width: maxWidth, height: y + rowHeight), positions)
    }
}
