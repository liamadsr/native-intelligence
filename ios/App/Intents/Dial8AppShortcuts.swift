//
//  Dial8AppShortcuts.swift
//  dial8 iOS
//
//  Publishes StartCaptureIntent as an App Shortcut. This is what puts "Start
//  Capture" in the Shortcuts app, in Siri and in Spotlight without the user
//  building anything — and it is also the route to the Apple Watch Action
//  Button (Settings → Action Button → Shortcut), since Apple reserves the
//  watch's native app list for workout and dive intents. So the phrasing here
//  is user-facing surface, not boilerplate.
//
//  App-target only, deliberately: the shortcut list is read from the app
//  bundle, and a second provider inside the widget extension would be noise.
//

import AppIntents

struct Dial8AppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartCaptureIntent(),
            phrases: [
                "Start a capture in \(.applicationName)",
                "Start capturing with \(.applicationName)",
                "New \(.applicationName) capture",
                "Capture with \(.applicationName)",
                "Record with \(.applicationName)"
            ],
            shortTitle: "Start Capture",
            systemImageName: "waveform"
        )
    }
}
