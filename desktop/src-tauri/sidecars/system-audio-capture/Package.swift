// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "system-audio-capture",
    platforms: [.macOS("14.4")],
    targets: [
        // ObjC target for Core Audio Taps API
        .target(
            name: "CATapHelperLib",
            path: "Sources/CATapHelperLib",
            publicHeadersPath: "include",
            linkerSettings: [
                .linkedFramework("CoreAudio"),
                .linkedFramework("AppKit"),
            ]
        ),
        // Swift executable that depends on the ObjC library
        .executableTarget(
            name: "system-audio-capture",
            dependencies: ["CATapHelperLib"],
            path: "Sources/SystemAudioCapture",
            linkerSettings: [
                .linkedFramework("CoreAudio"),
                .linkedFramework("AudioToolbox"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("AppKit"),
                .linkedFramework("Speech"),
                .linkedFramework("EventKit"),
            ]
        ),
    ]
)
