//
//  StartCaptureControl.swift
//  dial8Widgets
//
//  The Control Center / Lock Screen / Action Button control. One press runs
//  StartCaptureIntent, which opens the app and shows the recorder.
//
//  The intent itself lives in Shared/StartCaptureIntent.swift and is
//  granted membership of this target through the Shared-folder membership
//  exception in project.pbxproj — the extension needs the TYPE to build the
//  button; the app is what actually performs it.
//

import AppIntents
import SwiftUI
import WidgetKit

struct StartCaptureControl: ControlWidget {
    /// The control's persistent identity. iOS keys a user's placement — in
    /// Control Center, on the Lock Screen, on the Action Button — to this
    /// string, so changing it silently removes the control everyone added.
    /// It never changes.
    static let kind = "com.dial8-iOS-26.StartCaptureControl"

    /// Neutral by design: the app's palette is charcoal, and Control Center
    /// tints the whole button with this. No accent colour.
    private static let neutralTint = Color(white: 0.36)

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: StartCaptureIntent()) {
                // The hint is read out after the app name on the Action Button
                // ("NI — Start capture"), so it leads with a verb.
                Label("Capture", systemImage: "waveform")
                    .controlWidgetActionHint("Start capture")
            }
            .tint(Self.neutralTint)
        }
        .displayName("Start Capture")
        .description("Open Native Intelligence and start capturing.")
    }
}
