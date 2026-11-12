// swift-tools-version: 5.9
import PackageDescription

// The Studio recorder: screen, window, camera and microphone recording for
// Studio takes, driven by the app over stdin/stdout JSON lines
// (src-tauri/src/commands/studio_recorder.rs). No package dependencies: only
// macOS's own frameworks (build.sh checks that before writing its notices).
let package = Package(
    name: "studio-recorder",
    platforms: [.macOS("14.4")],
    targets: [
        .executableTarget(
            name: "studio-recorder",
            path: "Sources/StudioRecorder",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("IOKit"),
                .linkedFramework("ScreenCaptureKit"),
            ]
        ),
    ]
)
