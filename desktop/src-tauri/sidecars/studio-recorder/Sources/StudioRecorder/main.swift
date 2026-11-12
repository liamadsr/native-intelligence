import AppKit
import Foundation

/// studio-recorder: records a Studio take (a display or one window, the
/// microphone, cameras, system audio, extra windows) and the input trace of the
/// same interval, each source to its own file, every timestamp on the host
/// clock (CMClockGetHostTimeClock), which is the clock ScreenCaptureKit stamps
/// its frames with.
///
/// Protocol: one JSON object per line on stdin and stdout.
///   request  {"id": 7, "cmd": "targets", ...}
///   reply    {"id": 7, "ok": true, ...}   or   {"id": 7, "ok": false, "error": "...", "code": "..."}
///   event    {"event": "status", ...}     (no id: status, error, hello)
/// Commands: permissions, requestPermissions, targets, start, stop, cancel,
/// shutdown. They run one at a time, in order. stderr is human-readable logs.
/// The process exits on stdin EOF (the app quit or crashed); a take still
/// running is finalized first, so its files stay playable.
///
/// It never shows a permission prompt except in `requestPermissions`: `start`
/// refuses (code "permission") when a service it needs is not granted.

setvbuf(stdout, nil, _IOLBF, 0)
log("starting (pid \(getpid()), parent \(getppid()))")

// Connect to the window server on the main thread before anything asks it a
// question from another thread (CoreGraphics asserts otherwise). Prohibited:
// no Dock icon, no menu bar, never activates.
NSApplication.shared.setActivationPolicy(.prohibited)
_ = NSScreen.screens
_ = CGMainDisplayID()

let recorder = Recorder()

func handle(_ msg: [String: Any]) async -> [String: Any] {
    let cmd = msg["cmd"] as? String ?? ""
    do {
        switch cmd {
        case "permissions":
            return Permissions.snapshot()
        case "requestPermissions":
            let which = (msg["which"] as? [String]) ?? []
            return await Permissions.request(which)
        case "targets":
            return try await Targets.list()
        case "start":
            return try await recorder.start(StartOptions(msg))
        case "stop":
            return try await recorder.stop(sessionId: msg["sessionId"] as? String)
        case "cancel":
            return try await recorder.cancel(sessionId: msg["sessionId"] as? String)
        case "status":
            return recorder.statusSnapshot()
        case "now":
            return ["t": hostNow()]
        case "shutdown":
            _ = await recorder.finalizeForExit()
            reply(["id": msg["id"] ?? 0, "ok": true])
            exit(0)
        default:
            throw Fail("unknown command \(cmd)", code: "bad-request")
        }
    } catch let f as Fail {
        var out: [String: Any] = ["error": f.message]
        if let code = f.code { out["code"] = code }
        return out
    } catch {
        return ["error": "\(error.localizedDescription)"]
    }
}

emit(["event": "hello", "protocol": 1, "module": "studio-recorder", "version": "1"])

// Commands run strictly one at a time, in order (a stop never overtakes the
// start before it). The main thread runs the main run loop for AppKit lookups.
let gate = DispatchSemaphore(value: 1)
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
              let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            log("ignoring a line that is not a JSON object")
            continue
        }
        gate.wait()
        Task {
            var out = await handle(msg)
            out["id"] = msg["id"] ?? 0
            out["ok"] = out["error"] == nil
            reply(out)
            gate.signal()
        }
    }
    // stdin closed: the app is gone. Keep what was recorded.
    gate.wait()
    let semaphore = DispatchSemaphore(value: 0)
    Task {
        _ = await recorder.finalizeForExit()
        semaphore.signal()
    }
    _ = semaphore.wait(timeout: .now() + 20)
    log("stdin closed: exiting")
    exit(0)
}

signal(SIGPIPE, SIG_IGN)
RunLoop.main.run()
