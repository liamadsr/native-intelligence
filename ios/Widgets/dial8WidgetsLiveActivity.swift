//
//  dial8WidgetsLiveActivity.swift
//  dial8Widgets
//
//  Live Activity and Dynamic Island for active recording sessions.
//  Shows elapsed duration, recording state, and segment count.
//

import ActivityKit
import WidgetKit
import SwiftUI

struct dial8WidgetsLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RecordingActivityAttributes.self) { context in
            // Lock screen / banner UI
            lockScreenView(context: context)
        } dynamicIsland: { context in
            DynamicIsland {
                // Expanded Dynamic Island
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 6) {
                        appLogoCircle

                        Text(context.state.isPaused ? "Paused" : "Capturing")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(context.state.isPaused ? .secondary : .primary)
                    }
                }

                DynamicIslandExpandedRegion(.trailing) {
                    Text(formatDuration(context.state.elapsedSeconds))
                        .font(.system(.title3, design: .rounded).monospacedDigit().weight(.medium))
                        .foregroundStyle(.primary)
                        .contentTransition(.numericText())
                }

                DynamicIslandExpandedRegion(.bottom) {
                    HStack {
                        Spacer()

                        Text("Tap to open")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.top, 4)
                }
            } compactLeading: {
                appLogoCircle
                    .padding(.leading, 2)
            } compactTrailing: {
                Image(systemName: "mic.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white)
                    .opacity(context.state.isPaused ? 0.5 : 1.0)
                    .padding(.trailing, 2)
            } minimal: {
                appLogoCircle
            }
            .widgetURL(URL(string: "dial8://recording"))
        }
    }

    // MARK: - Lock Screen View

    @ViewBuilder
    private func lockScreenView(context: ActivityViewContext<RecordingActivityAttributes>) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "mic.circle.fill")
                .font(.system(size: 24))
                .symbolRenderingMode(.monochrome)
                .foregroundColor(.white)
                .opacity(context.state.isPaused ? 0.5 : 1.0)

            VStack(alignment: .leading, spacing: 2) {
                Text(context.state.isPaused ? "Capture Paused" : "Capturing")
                    .font(.subheadline.weight(.medium))
            }

            Spacer()

            Text(formatDuration(context.state.elapsedSeconds))
                .font(.system(.title2, design: .rounded).monospacedDigit().weight(.light))
                .contentTransition(.numericText())
        }
        .padding(16)
        .activityBackgroundTint(.black.opacity(0.7))
        .activitySystemActionForegroundColor(.white)
    }

    // MARK: - Helpers

    private var appLogoCircle: some View {
        Image("AppLogo")
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(width: 16, height: 16)
            .padding(4)
            .background(Circle().fill(.white))
    }

    private func formatDuration(_ totalSeconds: Int) -> String {
        let minutes = totalSeconds / 60
        let seconds = totalSeconds % 60
        return String(format: "%d:%02d", minutes, seconds)
    }
}

#Preview("Notification", as: .content, using: RecordingActivityAttributes()) {
    dial8WidgetsLiveActivity()
} contentStates: {
    RecordingActivityAttributes.ContentState(
        elapsedSeconds: 125,
        isRecording: true,
        isPaused: false,
        segmentCount: 3
    )
    RecordingActivityAttributes.ContentState(
        elapsedSeconds: 45,
        isRecording: false,
        isPaused: true,
        segmentCount: 1
    )
}
