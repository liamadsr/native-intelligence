import AppKit
import CoreGraphics
import Foundation

/// The take's input trace: where the pointer was, the clicks, the scrolling,
/// when the person was typing, and which app and window were in front, every
/// time on the host clock (the screen's). The editor draws zooms, click
/// feedback and keyboard markers from it.
///
/// Privacy: no typed character and no key code is ever read or kept. Typing
/// is recorded only as intervals ("the person was typing from t to end"),
/// split by pauses longer than 0.6 s.
///
/// How it listens, best first (the take never depends on it):
///   events          a listen-only event tap for the pointer and the keyboard
///                   (needs Input Monitoring or Accessibility);
///   events-pointer  the tap for the pointer only; typing from polled
///                   "seconds since the last key press" (no key is read);
///   polled          60 Hz polling of the pointer position, the button state
///                   and the last-event clocks: no permission at all.
/// A tap macOS disables mid-take (a slow callback) is re-enabled.
final class InputTrace: @unchecked Sendable {
    enum Surface {
        case display(frame: CGRect)
        case window(id: CGWindowID, pid: pid_t, frame: CGRect)
    }

    private let lock = NSLock()
    private let surface: Surface
    private let scale: Double
    /// The window's current bounds (window surfaces follow a moving window).
    private var bounds: CGRect
    private let jsonl: FileHandle?
    private var pendingLines: [Data] = []

    private var cursor: [(Double, Double, Double)] = []
    private var actions: [[String: Any]] = []
    private var focus: [[String: Any]] = []
    private var warnings: [String] = []
    private var lastCursorT = 0.0
    private var lastCursor: CGPoint?
    private var typingStart: Double?
    private var typingEnd = 0.0
    private var scrollStart: (t: Double, p: CGPoint)?
    private var scrollEnd = 0.0
    private var pressed: [Int: (t: Double, p: CGPoint)] = [:]
    private var frontPid: pid_t = 0
    private var lastFocusKey = ""

    private(set) var mode = "polled"
    private var tap: CFMachPort?
    private var tapLoop: CFRunLoop?
    private var tapHasKeys = false
    private var tapHasPointer = false
    private let tapDone = DispatchSemaphore(value: 0)
    private var tapThreadRunning = false
    private var poll: DispatchSourceTimer?
    private let pollQueue = DispatchQueue(label: "studio-recorder.trace-poll", qos: .userInitiated)
    private var pollTick = 0
    private var lastKeyEvent: Double = 0
    private var lastScrollEvent: Double = 0
    private var lastButtons: [Bool] = [false, false, false]
    private var flushTimer: DispatchSourceTimer?

    init(surface: Surface, scale: Double, jsonlPath: String) {
        self.surface = surface
        self.scale = scale
        switch surface {
        case .display(let frame): bounds = frame
        case .window(_, _, let frame): bounds = frame
        }
        FileManager.default.createFile(atPath: jsonlPath, contents: nil)
        jsonl = FileHandle(forWritingAtPath: jsonlPath)
    }

    var viewport: CGRect {
        switch surface {
        case .display(let frame): return frame
        case .window(_, _, let frame): return frame
        }
    }

    // MARK: recording rows (lock held by callers)

    private func raw(_ row: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: row) else { return }
        pendingLines.append(data + Data([10]))
    }

    private func local(_ p: CGPoint) -> CGPoint? {
        guard bounds.contains(p) else { return nil }
        return CGPoint(x: p.x - bounds.minX, y: p.y - bounds.minY)
    }

    /// Keyboard activity counts while the recorded surface is what the person
    /// is typing into: anything on a recorded display, or the recorded window's app.
    private var keyboardCounts: Bool {
        switch surface {
        case .display: return true
        case .window(_, let pid, _): return frontPid == pid
        }
    }

    private func addCursor(_ t: Double, _ p: CGPoint, force: Bool = false) {
        guard force || t - lastCursorT >= 1.0 / 60.0 else { return }
        guard let q = local(p) else { return }
        if !force, let last = lastCursor, abs(last.x - q.x) < 0.01, abs(last.y - q.y) < 0.01 { return }
        lastCursorT = t; lastCursor = q
        cursor.append((t, Double(q.x), Double(q.y)))
        raw(["kind": "cursor", "t": t, "x": q.x, "y": q.y])
    }

    private func flushTyping() {
        guard let start = typingStart else { return }
        let row: [String: Any] = ["kind": "type", "t": start, "end": max(start, typingEnd), "label": "Typing"]
        actions.append(row.merging(["box": NSNull()]) { a, _ in a }); raw(row)
        typingStart = nil
    }

    private func keyDown(_ t: Double) {
        guard keyboardCounts else { flushTyping(); return }
        if typingStart != nil && t - typingEnd > 0.6 { flushTyping() }
        if typingStart == nil { typingStart = t }
        typingEnd = max(typingEnd, t)
    }

    private func flushScroll() {
        guard let start = scrollStart else { return }
        let box: [String: Double] = ["x": Double(start.p.x), "y": Double(start.p.y), "w": 0, "h": 0]
        let row: [String: Any] = ["kind": "scroll", "t": start.t, "end": max(start.t, scrollEnd), "label": "Scroll", "box": box]
        actions.append(row); raw(row)
        scrollStart = nil
    }

    private func scroll(_ t: Double, _ p: CGPoint) {
        guard let q = local(p) else { return }
        flushTyping()
        if scrollStart != nil && t - scrollEnd > 0.35 { flushScroll() }
        if scrollStart == nil { scrollStart = (t, q) }
        scrollEnd = max(scrollEnd, t)
    }

    private func buttonDown(_ button: Int, _ t: Double, _ p: CGPoint) {
        flushTyping()
        guard let q = local(p) else { return }
        addCursor(t, p, force: true)
        pressed[button] = (t, q)
    }

    private func buttonUp(_ button: Int, _ t: Double) {
        guard let down = pressed.removeValue(forKey: button) else { return }
        let name = button == 0 ? "left" : button == 1 ? "right" : "other"
        let row: [String: Any] = ["kind": "click", "t": down.t, "end": max(down.t, t), "button": name,
                                  "label": button == 1 ? "Right click" : "Click",
                                  "box": ["x": Double(down.p.x), "y": Double(down.p.y), "w": 0.0, "h": 0.0]]
        actions.append(row); raw(row)
    }

    // MARK: event tap

    private func observe(_ type: CGEventType, _ event: CGEvent) {
        let t = hostNow(), p = event.location
        lock.lock(); defer { lock.unlock() }
        switch type {
        case .keyDown: keyDown(t)
        case .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged: addCursor(t, p)
        case .leftMouseDown: buttonDown(0, t, p)
        case .rightMouseDown: buttonDown(1, t, p)
        case .otherMouseDown: buttonDown(2, t, p)
        case .leftMouseUp: buttonUp(0, t)
        case .rightMouseUp: buttonUp(1, t)
        case .otherMouseUp: buttonUp(2, t)
        case .scrollWheel: scroll(t, p)
        default: break
        }
    }

    private static func mask(_ types: [CGEventType]) -> CGEventMask {
        types.reduce(CGEventMask(0)) { $0 | (1 << $1.rawValue) }
    }
    private static let pointerTypes: [CGEventType] = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
                                                      .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
                                                      .otherMouseDown, .otherMouseUp, .scrollWheel]

    /// Start the tap on a thread of its own; false when macOS refuses both masks.
    private func startTap() -> Bool {
        let ready = DispatchSemaphore(value: 0)
        let retained = Unmanaged.passRetained(self)
        Thread.detachNewThread { [self] in
            let callback: CGEventTapCallBack = { _, type, event, pointer in
                if let pointer {
                    let trace = Unmanaged<InputTrace>.fromOpaque(pointer).takeUnretainedValue()
                    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                        if let port = trace.tap { CGEvent.tapEnable(tap: port, enable: true) }
                        trace.lock.lock(); trace.warnings.append("The input monitor was paused by macOS and resumed at \(hostNow())"); trace.lock.unlock()
                    } else {
                        trace.observe(type, event)
                    }
                }
                return Unmanaged.passUnretained(event)
            }
            var port: CFMachPort?
            for (types, keys) in [(Self.pointerTypes + [.keyDown], true), (Self.pointerTypes, false)] {
                port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly,
                                         eventsOfInterest: Self.mask(types), callback: callback, userInfo: retained.toOpaque())
                if port != nil { self.tapHasKeys = keys; break }
            }
            guard let port else { ready.signal(); retained.release(); return }
            self.tap = port
            self.tapHasPointer = true
            self.tapThreadRunning = true
            let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
            self.tapLoop = CFRunLoopGetCurrent()
            CFRunLoopAddSource(self.tapLoop, source, .commonModes)
            CGEvent.tapEnable(tap: port, enable: true)
            ready.signal()
            CFRunLoopRun()
            CFMachPortInvalidate(port)
            self.tapDone.signal()
            retained.release()
        }
        _ = ready.wait(timeout: .now() + 3)
        return tap != nil
    }

    // MARK: polling (no permission needed)

    private func pollOnce() {
        let t = hostNow()
        pollTick += 1
        lock.lock(); defer { lock.unlock() }
        // Window bounds and the app in front, 4 times a second.
        if pollTick % 15 == 1 { refreshFocusAndBounds(t) }
        if !tapHasPointer {
            if let p = CGEvent(source: nil)?.location { addCursor(t, p) }
            let buttons: [CGMouseButton] = [.left, .right, .center]
            for (i, b) in buttons.enumerated() {
                let down = CGEventSource.buttonState(.combinedSessionState, button: b)
                if down != lastButtons[i] {
                    lastButtons[i] = down
                    if down, let p = CGEvent(source: nil)?.location { buttonDown(i, t, p) } else if !down { buttonUp(i, t) }
                }
            }
            let sinceScroll = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .scrollWheel)
            let scrollAt = t - sinceScroll
            if sinceScroll.isFinite, scrollAt > lastScrollEvent + 0.001 {
                lastScrollEvent = scrollAt
                if let p = CGEvent(source: nil)?.location { scroll(scrollAt, p) }
            }
        }
        if !tapHasKeys {
            let sinceKey = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown)
            let keyAt = t - sinceKey
            if sinceKey.isFinite, keyAt > lastKeyEvent + 0.001 {
                lastKeyEvent = keyAt
                keyDown(keyAt)
            }
        }
        // Close a typing run or a scroll gesture that has gone quiet, so a
        // crash keeps it in the jsonl.
        if let _ = typingStart, t - typingEnd > 0.6 { flushTyping() }
        if scrollStart != nil, t - scrollEnd > 0.35 { flushScroll() }
    }

    private func refreshFocusAndBounds(_ t: Double) {
        if case .window(let id, _, _) = surface, let row = windowInfo(id), let frame = windowBounds(row) { bounds = frame }
        let front = NSWorkspace.shared.frontmostApplication
        let pid = front?.processIdentifier ?? 0
        frontPid = pid
        let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
        let window = windows.first { ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) && ($0[kCGWindowLayer as String] as? Int) == 0 }
        let windowId = window?[kCGWindowNumber as String] as? Int ?? 0
        let title = String((window?[kCGWindowName as String] as? String ?? "").prefix(250))
        let key = "\(pid)|\(windowId)|\(title)"
        guard key != lastFocusKey else { return }
        lastFocusKey = key
        let row: [String: Any] = ["kind": "focus", "t": t, "pid": Int(pid), "bundleId": front?.bundleIdentifier ?? NSNull(),
                                  "app": front?.localizedName ?? NSNull(), "windowId": windowId, "title": title]
        focus.append(row); raw(row)
    }

    private func flushFile() {
        let lines: [Data] = { lock.lock(); defer { lock.unlock() }; let l = pendingLines; pendingLines = []; return l }()
        guard let jsonl, !lines.isEmpty else { return }
        for line in lines { jsonl.write(line) }
    }

    // MARK: lifecycle

    /// Start listening. Never throws: the worst case is the polled mode.
    func start() {
        let tapped = startTap()
        mode = !tapped ? "polled" : tapHasKeys ? "events" : "events-pointer"
        lock.lock()
        // Baselines, so nothing from before the take counts.
        let now = hostNow()
        lastKeyEvent = now - CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown)
        lastScrollEvent = now - CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .scrollWheel)
        lastButtons = [CGMouseButton.left, .right, .center].map { CGEventSource.buttonState(.combinedSessionState, button: $0) }
        refreshFocusAndBounds(now)
        if let p = CGEvent(source: nil)?.location { addCursor(now, p, force: true) }
        lock.unlock()
        let timer = DispatchSource.makeTimerSource(queue: pollQueue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(16), leeway: .milliseconds(2))
        timer.setEventHandler { [weak self] in self?.pollOnce() }
        timer.resume(); poll = timer
        let flush = DispatchSource.makeTimerSource(queue: pollQueue)
        flush.schedule(deadline: .now() + 1, repeating: .seconds(1))
        flush.setEventHandler { [weak self] in self?.flushFile() }
        flush.resume(); flushTimer = flush
        log("trace started (\(mode))")
    }

    func stop() {
        poll?.cancel(); poll = nil
        flushTimer?.cancel(); flushTimer = nil
        if let loop = tapLoop { CFRunLoopStop(loop) }
        if tapThreadRunning { _ = tapDone.wait(timeout: .now() + 2) }
        tapLoop = nil; tap = nil
        pollQueue.sync {}
        lock.lock()
        flushTyping(); flushScroll()
        let t = hostNow()
        for button in Array(pressed.keys) { buttonUp(button, t) }
        lock.unlock()
        flushFile()
        try? jsonl?.close()
    }

    /// The trace in the editor's TraceSchema: times in milliseconds since the
    /// screen's first frame (t0), positions in points from the recorded
    /// surface's top-left corner.
    func build(t0: Double, end: Double) -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let ms: (Double) -> Double = { max(0, (($0 - t0) * 1000).rounded()) }
        let inTake: (Double) -> Bool = { $0.isFinite && $0 >= t0 - 0.05 && $0 <= end + 0.1 }
        var cursorRows: [[Double]] = cursor.filter { inTake($0.0) }.map { [ms($0.0), $0.1, $0.2] }
        // Where the pointer was when the take began: the last sample before t0.
        if let before = cursor.last(where: { $0.0 < t0 - 0.05 }) { cursorRows.insert([0, before.1, before.2], at: 0) }
        let actionRows: [[String: Any]] = actions.compactMap { row in
            guard let t = row["t"] as? Double, inTake(t) else { return nil }
            var out = row
            out["t"] = ms(t)
            out["end"] = max(ms(t), ms((row["end"] as? Double) ?? t))
            if out["box"] == nil { out["box"] = NSNull() }
            return out
        }.sorted { ($0["t"] as? Double ?? 0) < ($1["t"] as? Double ?? 0) }
        let focusRows: [[String: Any]] = focus.compactMap { row in
            guard let t = row["t"] as? Double, t <= end + 0.1 else { return nil }
            var out = row
            out["t"] = ms(t)
            out.removeValue(forKey: "kind")
            return out
        }
        let vp = viewport
        return [
            "version": 1,
            "clock": ["unit": "ms", "origin": "screen-first-frame", "t0HostTime": t0],
            "viewport": ["x": Double(vp.minX), "y": Double(vp.minY), "width": Double(vp.width), "height": Double(vp.height), "scale": scale],
            "cursor": cursorRows,
            "actions": actionRows,
            "focus": focusRows,
            "durationMs": ms(end),
            "mode": mode,
            "warnings": warnings,
        ]
    }
}
