import SwiftUI

// MARK: - iOS Task Checkbox

/// Animated circular checkbox following Apple Reminders pattern
/// Optimistic UI: visual update happens instantly, backend syncs async
struct iOSTaskCheckbox: View {
    let isComplete: Bool
    let priority: ActionPriority
    /// False while the workspace context is still resolving — a toggle then
    /// would throw server-side and leave the checkbox lying about its state.
    var isEnabled: Bool = true
    var onToggle: (() -> Void)?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visuallyComplete: Bool = false
    @State private var scale: CGFloat = 1.0

    var body: some View {
        ZStack {
            Circle()
                .stroke(visuallyComplete ? Color.clear : borderColor, lineWidth: 1.5)

            Circle()
                .fill(visuallyComplete ? Color.accentColor : Color.clear)
                .scaleEffect(scale)

            if visuallyComplete {
                Image(systemName: "checkmark")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.white)
                    .transition(reduceMotion ? .opacity : .scale.combined(with: .opacity))
            }
        }
        .frame(width: 24, height: 24)
        .contentShape(Circle())
        .opacity(isEnabled ? 1 : 0.4)
        .allowsHitTesting(isEnabled)
        .onTapGesture {
            let animation: Animation = reduceMotion
                ? .easeInOut(duration: 0.15)
                : .spring(response: 0.3, dampingFraction: 0.6)

            withAnimation(animation) {
                visuallyComplete.toggle()
                scale = 1.2
            }

            let settleAnimation: Animation = reduceMotion
                ? .easeInOut(duration: 0.1)
                : .spring(response: 0.2, dampingFraction: 0.8)
            withAnimation(settleAnimation.delay(0.15)) {
                scale = 1.0
            }

            onToggle?()
        }
        .onAppear { visuallyComplete = isComplete }
        .onChange(of: isComplete) { _, newValue in
            if newValue != visuallyComplete {
                withAnimation(reduceMotion ? .none : .easeInOut(duration: 0.2)) {
                    visuallyComplete = newValue
                }
            }
        }
        .accessibilityLabel(visuallyComplete ? "Completed" : "Not completed")
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Double tap to \(visuallyComplete ? "mark as incomplete" : "complete")")
    }

    private var borderColor: Color {
        .secondary.opacity(0.5)
    }
}

// MARK: - iOS Action Row

struct iOSActionRow: View {
    let action: Action
    @Binding var editingTitle: String
    var isEditing: Bool = false
    var focusedActionId: FocusState<UUID?>.Binding
    var isCompletionEnabled: Bool = true
    var onToggleComplete: (() -> Void)?
    var onInfoTap: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            iOSTaskCheckbox(
                isComplete: action.status == .completed,
                priority: action.priority,
                isEnabled: isCompletionEnabled,
                onToggle: onToggleComplete
            )
            .padding(.top, 2)

            VStack(alignment: .leading, spacing: 4) {
                if isEditing {
                    TextField("", text: $editingTitle, axis: .vertical)
                        .font(.body)
                        .lineLimit(1...4)
                        .focused(focusedActionId, equals: action.id)
                        .submitLabel(.done)
                } else {
                    Text(action.title)
                        .font(.body)
                        .lineLimit(2)
                        .strikethrough(action.status == .completed)
                        .foregroundStyle(action.status == .completed ? .secondary : .primary)
                }

                if hasMetadata {
                    HStack(spacing: 6) {
                        if let dueAt = action.dueAt {
                            dueDateChip(dueAt)
                        }

                        if action.priority >= .medium {
                            priorityChip
                        }

                        if let description = action.description, !description.isEmpty {
                            Image(systemName: "text.alignleft")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }

            Spacer(minLength: 0)

            Button {
                onInfoTap?()
            } label: {
                Image(systemName: "info.circle")
                    .font(.body)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .padding(.top, 2)
        }
        .padding(.vertical, 8)
    }

    private var hasMetadata: Bool {
        action.dueAt != nil ||
        action.priority >= .medium ||
        (action.description != nil && !action.description!.isEmpty)
    }

    @ViewBuilder
    private func dueDateChip(_ date: Date) -> some View {
        let isOverdue = date < Date() && action.status != .completed
        let isToday = Calendar.current.isDateInToday(date)

        HStack(spacing: 3) {
            Image(systemName: isOverdue ? "exclamationmark.circle.fill" : "calendar")
                .font(.caption2)
            Text(formattedDueDate(date))
                .font(.caption)
        }
        .foregroundStyle(isOverdue ? .red : isToday ? .orange : .secondary)
    }

    /// `.urgent` used to fall through this ternary and render as "Medium" in
    /// yellow — switch exhaustively so the top priority reads as urgent.
    private var priorityChip: some View {
        HStack(spacing: 2) {
            Image(systemName: priorityIcon)
                .font(.caption2)
            Text(action.priority.displayName)
                .font(.caption)
        }
        .foregroundStyle(priorityColor)
    }

    private var priorityIcon: String {
        switch action.priority {
        case .urgent: return "exclamationmark.2"
        case .high, .medium, .low, .none: return "flag.fill"
        }
    }

    private var priorityColor: Color {
        switch action.priority {
        case .urgent: return .red
        case .high: return .orange
        case .medium: return .yellow
        case .low: return .blue
        case .none: return .secondary
        }
    }

    private func formattedDueDate(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return action.allDay ? "Today" : "Today \(date.formatted(date: .omitted, time: .shortened))"
        } else if calendar.isDateInTomorrow(date) {
            return "Tomorrow"
        } else if calendar.isDateInYesterday(date) {
            return "Yesterday"
        } else {
            return date.formatted(.dateTime.month(.abbreviated).day())
        }
    }
}
