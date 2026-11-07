import Foundation
import CoreAudio
import CATapHelperLib

/// Resident meeting-detection stream (`detect-stream` subcommand).
///
/// Emits one `DetectionResult` JSON line to stdout immediately, then keeps
/// re-evaluating for the life of the process:
///   - on an internal timer (2s while meeting apps are running, 5s otherwise),
///     which always emits — the parent's call-start/call-end state machine is
///     driven by elapsed time and needs periodic samples even when nothing
///     changed;
///   - immediately when CoreAudio reports a relevant change (process list,
///     device list, default input device), debounced, emitting only if the
///     result actually differs — these listeners fire in bursts (9+/sec has
///     been observed during a call join), so unconditional emission here would
///     spam the parent.
///
/// Everything this class does is a passive HAL property read — the same
/// `detectMeetings()` used by the one-shot `detect` command. It never creates
/// a tap, aggregate device, or IO stream, so it can never light the macOS
/// mic-in-use indicator or perturb another app's audio. The win over
/// spawn-per-poll `detect` is one long-lived HAL client instead of a fresh
/// process (and HAL client init/teardown) every few seconds.
///
/// Lifecycle: exits on SIGTERM/SIGINT, and also when stdin hits EOF — the
/// parent holds our stdin pipe, so if the parent dies without cleaning up we
/// notice the closed pipe and exit instead of running orphaned forever.
@available(macOS 14.4, *)
final class DetectionStreamer {
    /// Everything runs on the MAIN queue, drained by the main CFRunLoop (see
    /// run()): NSWorkspace.runningApplications only refreshes while the main
    /// run loop pumps — LaunchServices delivers app launch/quit updates
    /// through it. On a plain dispatch queue + dispatchMain() the list is
    /// frozen at first read, and a meeting app launched after the stream
    /// started is NEVER seen (verified 2026-08-05 by launching FaceTime
    /// mid-stream: meetingAppsRunning never updated).
    private let queue = DispatchQueue.main
    private var timer: DispatchSourceTimer?
    private var stdinSource: DispatchSourceRead?
    private var signalSources: [DispatchSourceSignal] = []
    private var listenerBlocks: [(AudioObjectPropertyAddress, AudioObjectPropertyListenerBlock)] = []

    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = .sortedKeys
        return e
    }()

    private var lastPayload: Data?
    private var currentInterval: TimeInterval = DetectionStreamer.idleInterval
    private var listenerEvalPending = false

    private static let activeInterval: TimeInterval = 2.0
    private static let idleInterval: TimeInterval = 5.0
    /// Debounce for listener-triggered evaluations, so a burst of property
    /// callbacks collapses into a single re-evaluation.
    private static let listenerDebounce: TimeInterval = 0.3

    func run() -> Never {
        queue.async { [self] in
            watchStdin()
            trapSignals()
            registerCoreAudioListeners()
            evaluate(forceEmit: true)
        }
        // Run the real main CFRunLoop, NOT dispatchMain(): the run loop both
        // drains the main GCD queue (our timer/listeners/stdin sources) and
        // lets LaunchServices keep NSWorkspace.runningApplications fresh.
        while true {
            let ranSource = RunLoop.main.run(mode: .default, before: .distantFuture)
            if !ranSource {
                // No input sources at all (shouldn't happen — the main-queue
                // drain source always exists): avoid a tight spin.
                Thread.sleep(forTimeInterval: 0.1)
            }
        }
    }

    // MARK: - Evaluation & emission

    private func evaluate(forceEmit: Bool) {
        let result = detectMeetings()

        // Retune the timer cadence to match call activity.
        let wantedInterval = result.meetingAppsRunning.isEmpty
            ? DetectionStreamer.idleInterval
            : DetectionStreamer.activeInterval
        if timer == nil || wantedInterval != currentInterval {
            scheduleTimer(interval: wantedInterval)
        }

        guard let payload = try? encoder.encode(result) else {
            fputs("detect-stream: failed to encode detection result\n", stderr)
            return
        }

        if forceEmit || payload != lastPayload {
            lastPayload = payload
            if let line = String(data: payload, encoding: .utf8) {
                print(line)
                // stdout is a pipe (block-buffered) — flush or the parent
                // sees nothing until the buffer fills.
                fflush(stdout)
            }
        }
    }

    private func scheduleTimer(interval: TimeInterval) {
        currentInterval = interval
        timer?.cancel()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + interval, repeating: interval, leeway: .milliseconds(200))
        t.setEventHandler { [weak self] in
            self?.evaluate(forceEmit: true)
        }
        t.resume()
        timer = t
    }

    // MARK: - CoreAudio change listeners (passive — registration only)

    private func registerCoreAudioListeners() {
        let properties: [AudioObjectPropertySelector] = [
            kAudioHardwarePropertyProcessObjectList,
            kAudioHardwarePropertyDevices,
            kAudioHardwarePropertyDefaultInputDevice,
        ]
        for selector in properties {
            var address = AudioObjectPropertyAddress(
                mSelector: selector,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
                self?.scheduleListenerEvaluation()
            }
            let status = AudioObjectAddPropertyListenerBlock(
                AudioObjectID(kAudioObjectSystemObject), &address, queue, block
            )
            if status != noErr {
                // Non-fatal: the timer still samples every 2-5s; listeners
                // only buy responsiveness.
                fputs("detect-stream: listener \(selector) failed (\(status))\n", stderr)
            } else {
                listenerBlocks.append((address, block))
            }
        }
    }

    /// Already runs on `queue` (listeners are registered with it).
    private func scheduleListenerEvaluation() {
        guard !listenerEvalPending else { return }
        listenerEvalPending = true
        queue.asyncAfter(deadline: .now() + DetectionStreamer.listenerDebounce) { [weak self] in
            guard let self else { return }
            self.listenerEvalPending = false
            self.evaluate(forceEmit: false)
        }
    }

    // MARK: - Lifecycle

    private func watchStdin() {
        let source = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: queue)
        source.setEventHandler {
            var buf = [UInt8](repeating: 0, count: 256)
            let n = read(STDIN_FILENO, &buf, buf.count)
            if n <= 0 {
                fputs("detect-stream: stdin closed, exiting\n", stderr)
                exit(0)
            }
            // Any actual input is ignored — stdin exists purely as a parent
            // liveness signal.
        }
        source.resume()
        stdinSource = source
    }

    private func trapSignals() {
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: queue)
            source.setEventHandler {
                fputs("detect-stream: received signal, exiting\n", stderr)
                exit(0)
            }
            source.resume()
            signalSources.append(source)
        }
    }
}
