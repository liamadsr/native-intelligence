import AppKit
import AVFoundation
import CoreGraphics
import Foundation

/// Global display geometry, top-left origin (the space CGWindowList, CGEvent
/// and ScreenCaptureKit use), in points.
func screenFrameTopLeft(_ screen: NSScreen) -> CGRect {
    let primaryHeight = NSScreen.screens.first?.frame.height ?? screen.frame.height
    return CGRect(x: screen.frame.minX, y: primaryHeight - screen.frame.maxY, width: screen.frame.width, height: screen.frame.height)
}

func displayID(of screen: NSScreen) -> CGDirectDisplayID? {
    (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
}

func screen(forDisplay id: CGDirectDisplayID) -> NSScreen? {
    NSScreen.screens.first { displayID(of: $0) == id }
}

/// Bounds of an on-screen window by id (global top-left points), or nil.
func windowInfo(_ id: CGWindowID) -> [String: Any]? {
    let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]]) ?? []
    return info.first { ($0[kCGWindowNumber as String] as? UInt32) == id }
}

func windowBounds(_ row: [String: Any]) -> CGRect? {
    guard let b = row[kCGWindowBounds as String] as? [String: CGFloat],
          let x = b["X"], let y = b["Y"], let w = b["Width"], let h = b["Height"] else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
}

/// What can be recorded. Metadata only: listing never opens a device, never
/// activates an app, and never prompts (no ScreenCaptureKit here; window
/// titles are empty until Screen Recording is granted).
enum Targets {
    static func list() async throws -> [String: Any] {
        let (displays, windows) = await MainActor.run { (Self.displays(), Self.windowsByApp()) }
        return ["displays": displays, "apps": windows, "cameras": devices(.video), "microphones": devices(.audio)]
    }

    @MainActor static func displays() -> [[String: Any]] {
        let main = CGMainDisplayID()
        return NSScreen.screens.compactMap { screen in
            guard let id = displayID(of: screen) else { return nil }
            let mode = CGDisplayCopyDisplayMode(id)
            return [
                "displayId": Int(id),
                "name": screen.localizedName,
                "frame": rectJSON(screenFrameTopLeft(screen)),
                "scale": Double(screen.backingScaleFactor),
                "pixelWidth": mode?.pixelWidth ?? Int(screen.frame.width * screen.backingScaleFactor),
                "pixelHeight": mode?.pixelHeight ?? Int(screen.frame.height * screen.backingScaleFactor),
                "isMain": id == main,
            ]
        }
    }

    /// On-screen app windows (layer 0, at least 64 pt), grouped by app.
    @MainActor static func windowsByApp() -> [[String: Any]] {
        let info = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
        var apps: [Int: [String: Any]] = [:]
        var order: [Int] = []
        for window in info {
            guard let pid = window[kCGWindowOwnerPID as String] as? Int, pid != Int(getpid()),
                  let id = window[kCGWindowNumber as String] as? UInt32,
                  let layer = window[kCGWindowLayer as String] as? Int, layer == 0,
                  let frame = windowBounds(window), frame.width >= 64, frame.height >= 64,
                  let app = NSRunningApplication(processIdentifier: pid_t(pid)), !app.isTerminated else { continue }
            let center = CGPoint(x: frame.midX, y: frame.midY)
            let screen = NSScreen.screens.first { screenFrameTopLeft($0).contains(center) }
            let row: [String: Any] = [
                "windowId": Int(id),
                "title": String((window[kCGWindowName as String] as? String ?? "").prefix(250)),
                "frame": rectJSON(frame),
                "displayId": screen.flatMap(displayID).map { Int($0) } ?? NSNull(),
                "scale": Double(screen?.backingScaleFactor ?? 2),
            ]
            if apps[pid] == nil {
                order.append(pid)
                apps[pid] = [
                    "pid": pid,
                    "bundleId": app.bundleIdentifier ?? NSNull(),
                    "name": app.localizedName ?? app.bundleIdentifier ?? "App",
                    "windows": [[String: Any]](),
                ]
            }
            var rows = apps[pid]!["windows"] as! [[String: Any]]
            rows.append(row)
            apps[pid]!["windows"] = rows
        }
        // Front-to-back order of each app's first window, which is the order
        // a person sees them in.
        return order.compactMap { apps[$0] }
    }

    static func devices(_ type: AVMediaType) -> [[String: Any]] {
        let kinds: [AVCaptureDevice.DeviceType] = type == .audio
            ? [.microphone, .external]
            : [.builtInWideAngleCamera, .external, .continuityCamera, .deskViewCamera]
        let preferred = AVCaptureDevice.default(for: type)?.uniqueID
        return AVCaptureDevice.DiscoverySession(deviceTypes: kinds, mediaType: type, position: .unspecified).devices.map {
            ["id": $0.uniqueID, "name": $0.localizedName, "isDefault": $0.uniqueID == preferred]
        }
    }
}
