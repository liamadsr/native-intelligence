import AppKit
import ApplicationServices
import AVFoundation
import CoreGraphics
import Foundation
import IOKit.hid

/// The privacy services a take uses, as `granted | denied | undetermined`.
///
/// This process is a child of the app, so macOS attributes every one of these
/// to the app (its "responsible process"): the prompts name Native
/// Intelligence, and a grant to the app is a grant here
/// (desktop/docs/PERMISSIONS.md, "Studio recording").
enum Permissions {
    /// The private TCC framework's preflight: 0 granted, 1 denied, 2 not
    /// determined (the same reading the app's own tcc_helper.m uses). Loaded
    /// at runtime so a macOS without it degrades to the public checks.
    private typealias PreflightFn = @convention(c) (CFString, CFDictionary?) -> Int32
    private static let preflightFn: PreflightFn? = {
        guard let handle = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_LAZY),
              let sym = dlsym(handle, "TCCAccessPreflight") else { return nil }
        return unsafeBitCast(sym, to: PreflightFn.self)
    }()

    private static func preflight(_ service: String) -> String? {
        guard let fn = preflightFn else { return nil }
        switch fn(service as CFString, nil) {
        case 0: return "granted"
        case 1: return "denied"
        case 2: return "undetermined"
        default: return nil
        }
    }

    static func screenRecording() -> String {
        if CGPreflightScreenCaptureAccess() { return "granted" }
        return preflight("kTCCServiceScreenCapture").flatMap { $0 == "granted" ? nil : $0 } ?? "undetermined"
    }

    static func accessibility() -> String {
        if AXIsProcessTrusted() { return "granted" }
        return preflight("kTCCServiceAccessibility").flatMap { $0 == "granted" ? nil : $0 } ?? "undetermined"
    }

    static func inputMonitoring() -> String {
        switch IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) {
        case kIOHIDAccessTypeGranted: return "granted"
        case kIOHIDAccessTypeDenied: return "denied"
        default: return "undetermined"
        }
    }

    static func device(_ type: AVMediaType) -> String {
        switch AVCaptureDevice.authorizationStatus(for: type) {
        case .authorized: return "granted"
        case .notDetermined: return "undetermined"
        default: return "denied"
        }
    }

    /// What the input trace can record with the grants as they are. The take
    /// itself never needs Accessibility or Input Monitoring.
    static func traceCapability(accessibility: String, inputMonitoring: String) -> [String: Any] {
        if inputMonitoring == "granted" || accessibility == "granted" {
            return ["level": "full", "reason": NSNull()]
        }
        return ["level": "pointer",
                "reason": "Without Input Monitoring (or Accessibility), the trace records the pointer, clicks and scrolling, and typing only as times; turn either on in System Settings → Privacy & Security for precise events."]
    }

    static func snapshot() -> [String: Any] {
        let ax = accessibility(), im = inputMonitoring()
        return [
            "screenRecording": screenRecording(),
            "accessibility": ax,
            "inputMonitoring": im,
            "camera": device(.video),
            "microphone": device(.audio),
            "trace": traceCapability(accessibility: ax, inputMonitoring: im),
        ]
    }

    private static let settingsAnchors: [String: String] = [
        "screenRecording": "Privacy_ScreenCapture",
        "accessibility": "Privacy_Accessibility",
        "inputMonitoring": "Privacy_ListenEvent",
        "camera": "Privacy_Camera",
        "microphone": "Privacy_Microphone",
    ]

    @MainActor private static func openSettings(_ which: String) -> String {
        guard let anchor = settingsAnchors[which],
              let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") else { return "denied" }
        NSWorkspace.shared.open(url)
        return "opened-settings"
    }

    /// Ask for each service in `which` the way macOS wants it asked: the real
    /// prompt while not determined, System Settings once denied (macOS never
    /// prompts twice). Answers per service: granted | denied | prompted |
    /// opened-settings | unknown-service, plus the snapshot after.
    static func request(_ which: [String]) async -> [String: Any] {
        var results: [String: String] = [:]
        for name in which {
            switch name {
            case "screenRecording":
                switch screenRecording() {
                case "granted": results[name] = "granted"
                case "denied": results[name] = await openSettings(name)
                default:
                    // Shows the system prompt the first time; answers the
                    // current state at once (the grant takes effect after the
                    // person allows it in System Settings).
                    results[name] = CGRequestScreenCaptureAccess() ? "granted" : "prompted"
                }
            case "accessibility":
                if AXIsProcessTrusted() { results[name] = "granted"; break }
                if accessibility() == "denied" { results[name] = await openSettings(name); break }
                let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                results[name] = AXIsProcessTrustedWithOptions(options) ? "granted" : "prompted"
            case "inputMonitoring":
                switch inputMonitoring() {
                case "granted": results[name] = "granted"
                case "denied": results[name] = await openSettings(name)
                default: results[name] = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent) ? "granted" : "prompted"
                }
            case "camera", "microphone":
                let type: AVMediaType = name == "camera" ? .video : .audio
                switch AVCaptureDevice.authorizationStatus(for: type) {
                case .authorized: results[name] = "granted"
                case .notDetermined:
                    let granted = await AVCaptureDevice.requestAccess(for: type)
                    results[name] = granted ? "granted" : "denied"
                default: results[name] = await openSettings(name)
                }
            default:
                results[name] = "unknown-service"
            }
        }
        return ["results": results, "permissions": snapshot()]
    }
}
