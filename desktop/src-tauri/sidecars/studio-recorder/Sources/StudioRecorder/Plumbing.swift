import CoreMedia
import Foundation

/// A refusal or failure that goes back to the app as `{error, code}`.
struct Fail: Error {
    let message: String
    let code: String?
    init(_ message: String, code: String? = nil) {
        self.message = message
        self.code = code
    }
}

/// Seconds on the host clock: the clock ScreenCaptureKit stamps frames with,
/// and the one every time in a take is expressed on.
func hostNow() -> Double { CMClockGetTime(CMClockGetHostTimeClock()).seconds }

private let outLock = NSLock()

/// Write one JSON line to stdout (replies and events share it).
func writeLine(_ obj: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(obj),
          let data = try? JSONSerialization.data(withJSONObject: obj),
          var line = String(data: data, encoding: .utf8) else {
        log("dropped an unserializable message")
        return
    }
    line += "\n"
    outLock.lock()
    FileHandle.standardOutput.write(line.data(using: .utf8)!)
    outLock.unlock()
}

func reply(_ obj: [String: Any]) { writeLine(obj) }
func emit(_ obj: [String: Any]) { writeLine(obj) }

func log(_ message: String) {
    FileHandle.standardError.write(Data("[studio-recorder] \(message)\n".utf8))
}

/// Replace `path` with `value` as JSON, atomically (a reader never sees half).
func writeJSONAtomic(_ path: String, _ value: Any) {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
    do { try data.write(to: URL(fileURLWithPath: path), options: .atomic) } catch {
        log("could not write \(path): \(error.localizedDescription)")
    }
}

func fileSize(_ path: String) -> Int64 {
    ((try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? NSNumber)?.int64Value ?? 0
}

/// A finite Double or NSNull, for JSON.
func jsonNumber(_ value: Double?) -> Any {
    guard let value, value.isFinite else { return NSNull() }
    return value
}

func rectJSON(_ r: CGRect) -> [String: Double] {
    ["x": Double(r.minX), "y": Double(r.minY), "width": Double(r.width), "height": Double(r.height)]
}

/// A sample's presentation time converted onto the host clock. AVCaptureSession
/// stamps buffers on its synchronization clock, which is usually (not always)
/// the host clock: an audio interface can drive its own.
func hostTime(_ pts: CMTime, from clock: CMClock?) -> Double {
    guard let clock, pts.isValid else { return pts.seconds }
    let host = CMClockGetHostTimeClock()
    if clock === host { return pts.seconds }
    return CMSyncConvertTime(pts, from: clock, to: host).seconds
}

/// Lock-guarded value shared between capture queues.
final class Locked<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T
    init(_ value: T) { self.value = value }
    func get() -> T { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ v: T) { lock.lock(); value = v; lock.unlock() }
    func update<R>(_ body: (inout T) -> R) -> R { lock.lock(); defer { lock.unlock() }; return body(&value) }
}
