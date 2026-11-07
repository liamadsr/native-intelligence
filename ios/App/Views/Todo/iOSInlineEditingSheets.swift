import SwiftUI

// MARK: - Inline Priority Picker (sits above keyboard)

struct iOSInlinePriorityPicker: View {
    let currentPriority: ActionPriority
    var onSelect: (ActionPriority) -> Void

    var body: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 4) {
                ForEach(ActionPriority.allCases, id: \.self) { priority in
                    Button {
                        onSelect(priority)
                    } label: {
                        VStack(spacing: 5) {
                            Image(systemName: priority == .none ? "flag.slash" : "flag.fill")
                                .font(.system(size: 20))
                                .foregroundStyle(colorForPriority(priority))
                            Text(priority.displayName)
                                .font(.caption2.weight(priority == currentPriority ? .semibold : .regular))
                                .foregroundStyle(priority == currentPriority ? .primary : .secondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(
                            priority == currentPriority
                                ? Color.accentColor.opacity(0.12)
                                : Color.clear
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
        .background(.ultraThinMaterial)
        .shadow(color: .black.opacity(0.15), radius: 8, y: -2)
    }

    private func colorForPriority(_ priority: ActionPriority) -> Color {
        switch priority {
        case .urgent: return .red
        case .high: return .orange
        case .medium: return .yellow
        case .low: return .blue
        case .none: return .secondary
        }
    }
}

// MARK: - Inline Date Picker (sits above keyboard)

struct iOSInlineDatePicker: View {
    let currentDate: Date?
    let allDay: Bool
    var onSelect: (Date, Bool) -> Void
    var onClear: (() -> Void)?

    @State private var selectedDate: Date
    @State private var isAllDay: Bool
    @State private var showFullCalendar = false

    init(currentDate: Date?, allDay: Bool, onSelect: @escaping (Date, Bool) -> Void, onClear: (() -> Void)? = nil) {
        self.currentDate = currentDate
        self.allDay = allDay
        self.onSelect = onSelect
        self.onClear = onClear
        _selectedDate = State(initialValue: currentDate ?? Date())
        _isAllDay = State(initialValue: allDay)
    }

    var body: some View {
        VStack(spacing: 0) {
            Divider()

            VStack(spacing: 8) {
                // Quick date options
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        quickChip("Today", date: startOfToday, icon: "sun.max")
                        quickChip("Tomorrow", date: startOfTomorrow, icon: "sunrise")
                        quickChip("Next Week", date: startOfNextWeek, icon: "calendar.badge.clock")

                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                showFullCalendar.toggle()
                            }
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "calendar")
                                    .font(.caption)
                                Text("Pick Date")
                                    .font(.subheadline.weight(.medium))
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background(showFullCalendar ? Color.accentColor : Color(.systemGray5))
                            .foregroundStyle(showFullCalendar ? .white : .primary)
                            .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)

                        if currentDate != nil {
                            Button {
                                onClear?()
                            } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: "xmark")
                                        .font(.caption2.weight(.semibold))
                                    Text("Clear")
                                        .font(.subheadline.weight(.medium))
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 7)
                                .background(Color(.systemGray5))
                                .foregroundStyle(.red)
                                .clipShape(Capsule())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 12)
                }

                if showFullCalendar {
                    VStack(spacing: 4) {
                        DatePicker(
                            "Date",
                            selection: $selectedDate,
                            displayedComponents: isAllDay ? [.date] : [.date, .hourAndMinute]
                        )
                        .datePickerStyle(.graphical)
                        .padding(.horizontal, 4)

                        HStack {
                            Toggle("All Day", isOn: $isAllDay)
                                .font(.subheadline)

                            Spacer()

                            Button("Done") {
                                onSelect(selectedDate, isAllDay)
                            }
                            .font(.subheadline.weight(.semibold))
                        }
                        .padding(.horizontal, 16)
                        .padding(.bottom, 4)
                    }
                }
            }
            .padding(.vertical, 10)
        }
        .background(.ultraThinMaterial)
        .shadow(color: .black.opacity(0.15), radius: 8, y: -2)
    }

    private func quickChip(_ title: String, date: Date, icon: String) -> some View {
        let isSelected = currentDate != nil && Calendar.current.isDate(currentDate!, inSameDayAs: date)
        return Button {
            onSelect(date, true)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.caption)
                Text(title)
                    .font(.subheadline.weight(.medium))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(isSelected ? Color.accentColor : Color(.systemGray5))
            .foregroundStyle(isSelected ? .white : .primary)
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private var startOfToday: Date {
        Calendar.current.startOfDay(for: Date())
    }

    private var startOfTomorrow: Date {
        Calendar.current.date(byAdding: .day, value: 1, to: startOfToday) ?? startOfToday
    }

    private var startOfNextWeek: Date {
        Calendar.current.date(byAdding: .weekOfYear, value: 1, to: startOfToday) ?? startOfToday
    }
}

// MARK: - Custom Date Picker Sheet

struct iOSCustomDatePickerSheet: View {
    let currentDate: Date?
    let allDay: Bool
    var onSelect: (Date, Bool) -> Void
    var onClear: (() -> Void)?

    @State private var selectedDate: Date
    @State private var isAllDay: Bool

    init(currentDate: Date?, allDay: Bool, onSelect: @escaping (Date, Bool) -> Void, onClear: (() -> Void)? = nil) {
        self.currentDate = currentDate
        self.allDay = allDay
        self.onSelect = onSelect
        self.onClear = onClear
        _selectedDate = State(initialValue: currentDate ?? Date())
        _isAllDay = State(initialValue: allDay)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                DatePicker(
                    "Date",
                    selection: $selectedDate,
                    displayedComponents: isAllDay ? [.date] : [.date, .hourAndMinute]
                )
                .datePickerStyle(.graphical)
                .padding(.horizontal)

                Toggle("All Day", isOn: $isAllDay)
                    .padding(.horizontal)
                    .padding(.bottom, 8)
            }
            .navigationTitle("Pick a Date")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if currentDate != nil {
                        Button("Clear", role: .destructive) {
                            onClear?()
                        }
                        .foregroundStyle(.red)
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        onSelect(selectedDate, isAllDay)
                    }
                    .fontWeight(.semibold)
                }
            }
        }
    }
}
