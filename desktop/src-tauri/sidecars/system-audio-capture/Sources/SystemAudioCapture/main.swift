import Foundation
import Speech
import ScreenCaptureKit
import CATapHelperLib
import EventKit

/// system-audio-capture sidecar for Native Intelligence Tauri desktop app.
///
/// Commands:
///   detect             — One-shot meeting detection (returns JSON to stdout)
///   detect-stream      — Resident meeting detection: JSON line per evaluation
///                        (timer + CoreAudio change listeners, purely passive
///                        HAL reads; exits on SIGTERM or stdin EOF)
///   list-processes     — List all audio processes (returns JSON to stdout)
///   capture            — Capture system audio, stream 16kHz mono PCM float32 to stdout (runs until SIGTERM)
///   speech-detect      — Detect speech/silence via Apple SFSpeechRecognizer, emit JSON events to stdout
///   calendar-status    — Check EventKit access + list Exchange calendars (returns JSON to stdout)
///   calendar-events    — Fetch Exchange calendar events (returns JSON array to stdout)

let args = CommandLine.arguments.dropFirst()

guard let command = args.first else {
    fputs("Usage: system-audio-capture <detect|list-processes|capture>\n", stderr)
    exit(1)
}

guard #available(macOS 14.4, *) else {
    fputs("system-audio-capture requires macOS 14.4+\n", stderr)
    exit(1)
}

switch command {
case "detect":
    let result = detectMeetings()
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    if let data = try? encoder.encode(result),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    } else {
        fputs("Failed to encode detection result\n", stderr)
        exit(1)
    }

case "detect-stream":
    DetectionStreamer().run()

case "list-processes":
    let processes = listAudioProcesses()
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    if let data = try? encoder.encode(processes),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    } else {
        fputs("Failed to encode process list\n", stderr)
        exit(1)
    }

case "capture-from-tap":
    // Capture audio from a tap created by the parent process.
    // The parent creates the tap (needs permission), we create the aggregate device from it.
    // Usage: capture-from-tap --tap-uuid <UUID>
    let captureArgs = Array(args.dropFirst())
    guard let uuidIdx = captureArgs.firstIndex(of: "--tap-uuid"),
          uuidIdx + 1 < captureArgs.count else {
        fputs("Usage: capture-from-tap --tap-uuid <UUID>\n", stderr)
        exit(1)
    }
    let tapUUID = captureArgs[uuidIdx + 1]

    let tapCapture = TapAudioCapture(tapUUID: tapUUID)

    let stopSemaphore = DispatchSemaphore(value: 0)
    // Signal handlers run on their own queue: the main thread blocks in
    // stopSemaphore.wait() and never drains .main, so handlers there never ran.
    let signalQueue = DispatchQueue(label: "com.dial8.sidecar.signals")
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)

    let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: signalQueue)
    termSource.setEventHandler {
        fputs("Received SIGTERM, stopping tap capture...\n", stderr)
        tapCapture.stop()
        stopSemaphore.signal()
    }
    termSource.resume()

    let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: signalQueue)
    intSource.setEventHandler {
        fputs("Received SIGINT, stopping tap capture...\n", stderr)
        tapCapture.stop()
        stopSemaphore.signal()
    }
    intSource.resume()

    do {
        try tapCapture.start()
        fputs("Tap capture started for UUID: \(tapUUID). Send SIGTERM to stop.\n", stderr)
        stopSemaphore.wait()
    } catch {
        fputs("CAPTURE_FAILED: \(error.localizedDescription)\n", stderr)
        fflush(stderr)
        exit(1)
    }

case "capture-from-device":
    // Legacy: Capture audio from a pre-created aggregate device.
    let captureArgs = Array(args.dropFirst())
    guard let uidIdx = captureArgs.firstIndex(of: "--device-uid"),
          uidIdx + 1 < captureArgs.count else {
        fputs("Usage: capture-from-device --device-uid <UID>\n", stderr)
        exit(1)
    }
    let deviceUID = captureArgs[uidIdx + 1]

    let deviceCapture = DeviceAudioCapture(deviceUID: deviceUID)

    let stopSemaphore = DispatchSemaphore(value: 0)
    // Signal handlers run on their own queue: the main thread blocks in
    // stopSemaphore.wait() and never drains .main, so handlers there never ran.
    let signalQueue = DispatchQueue(label: "com.dial8.sidecar.signals")
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)

    let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: signalQueue)
    termSource.setEventHandler {
        fputs("Received SIGTERM, stopping device capture...\n", stderr)
        deviceCapture.stop()
        stopSemaphore.signal()
    }
    termSource.resume()

    let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: signalQueue)
    intSource.setEventHandler {
        fputs("Received SIGINT, stopping device capture...\n", stderr)
        deviceCapture.stop()
        stopSemaphore.signal()
    }
    intSource.resume()

    do {
        try deviceCapture.start()
        fputs("Device capture started for UID: \(deviceUID). Send SIGTERM to stop.\n", stderr)
        stopSemaphore.wait()
    } catch {
        fputs("Failed to start device capture: \(error.localizedDescription)\n", stderr)
        exit(1)
    }

case "capture":
    let capture = SystemAudioCapture()

    // Handle SIGTERM/SIGINT for graceful shutdown
    let stopSemaphore = DispatchSemaphore(value: 0)
    // Signal handlers run on their own queue: the main thread blocks in
    // stopSemaphore.wait() and never drains .main, so handlers there never ran.
    let signalQueue = DispatchQueue(label: "com.dial8.sidecar.signals")

    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)

    let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: signalQueue)
    termSource.setEventHandler {
        fputs("Received SIGTERM, stopping capture...\n", stderr)
        capture.stop()
        stopSemaphore.signal()
    }
    termSource.resume()

    let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: signalQueue)
    intSource.setEventHandler {
        fputs("Received SIGINT, stopping capture...\n", stderr)
        capture.stop()
        stopSemaphore.signal()
    }
    intSource.resume()

    do {
        try capture.start()
        fputs("System audio capture started. Send SIGTERM to stop.\n", stderr)

        // Run until signal received
        stopSemaphore.wait()
    } catch {
        fputs("Failed to start capture: \(error.localizedDescription)\n", stderr)
        exit(1)
    }

case "request-screen-capture-auth":
    // Request Screen & System Audio Recording permission using ScreenCaptureKit.
    // SCShareableContent triggers the macOS permission dialog the first time
    // it's called, which registers the app in System Settings.
    let semaphore = DispatchSemaphore(value: 0)
    var authResult = "unknown"

    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
        if let error = error {
            let nsError = error as NSError
            authResult = "denied"
            fputs("[request-screen-capture-auth] error: \(error.localizedDescription) (code: \(nsError.code))\n", stderr)
        } else if content != nil {
            authResult = "granted"
            fputs("[request-screen-capture-auth] access granted\n", stderr)
        }
        semaphore.signal()
    }

    semaphore.wait()
    print("{\"status\":\"\(authResult)\"}")
    fflush(stdout)

case "request-speech-auth":
    // Check current authorization status first.
    // If already determined (authorized/denied/restricted), just return it.
    // Only call requestAuthorization if status is notDetermined.
    let currentStatus = SFSpeechRecognizer.authorizationStatus()

    func statusToString(_ s: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch s {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }

    if currentStatus != .notDetermined {
        // Already determined — just report it
        let json = "{\"status\":\"\(statusToString(currentStatus))\"}"
        print(json)
        fflush(stdout)
    } else {
        // Need to request authorization — this triggers the system dialog.
        // SFSpeechRecognizer.requestAuthorization callback fires on an arbitrary queue.
        let semaphore = DispatchSemaphore(value: 0)
        var result: SFSpeechRecognizerAuthorizationStatus = .notDetermined

        SFSpeechRecognizer.requestAuthorization { status in
            result = status
            semaphore.signal()
        }

        // Wait for the callback (the system dialog blocks the user, not the thread)
        semaphore.wait()

        let json = "{\"status\":\"\(statusToString(result))\"}"
        print(json)
        fflush(stdout)
    }

case "speech-detect":
    // Optional: --threshold 0.75 (silence threshold in seconds)
    var threshold: TimeInterval = 0.75
    let remainingArgs = Array(args.dropFirst())
    if let idx = remainingArgs.firstIndex(of: "--threshold"),
       idx + 1 < remainingArgs.count,
       let val = TimeInterval(remainingArgs[idx + 1]) {
        threshold = val
    }

    let detector = SpeechDetector(silenceThreshold: threshold)

    // Handle SIGTERM/SIGINT for graceful shutdown
    let stopSemaphore = DispatchSemaphore(value: 0)

    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)

    let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    termSource.setEventHandler {
        fputs("Received SIGTERM, stopping speech detection...\n", stderr)
        detector.stop()
        stopSemaphore.signal()
    }
    termSource.resume()

    let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    intSource.setEventHandler {
        fputs("Received SIGINT, stopping speech detection...\n", stderr)
        detector.stop()
        stopSemaphore.signal()
    }
    intSource.resume()

    do {
        try detector.start()
        fputs("Speech detection started. Send SIGTERM to stop.\n", stderr)

        // Run until signal received — need RunLoop for Timer-based silence detection
        DispatchQueue.global().async {
            stopSemaphore.wait()
            CFRunLoopStop(CFRunLoopGetMain())
        }
        RunLoop.main.run()
    } catch {
        fputs("SPEECH_DETECT_FAILED: \(error.localizedDescription)\n", stderr)
        // Give the parent process time to read stderr before we exit
        fflush(stderr)
        Thread.sleep(forTimeInterval: 0.1)
        exit(1)
    }

case "calendar-status":
    // Request EventKit access (triggers permission dialog if needed) and return
    // Exchange calendar status as JSON.
    let reader = CalendarReader()
    let result = reader.requestAccessAndStatus()
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    if let data = try? encoder.encode(result),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    } else {
        fputs("Failed to encode calendar status\n", stderr)
        exit(1)
    }

case "calendar-check":
    // Check current EventKit authorization without triggering the permission dialog.
    let reader = CalendarReader()
    let result = reader.checkStatus()
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    if let data = try? encoder.encode(result),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    } else {
        fputs("Failed to encode calendar check\n", stderr)
        exit(1)
    }

case "calendar-events":
    // Fetch Exchange calendar events within a date range.
    // Usage: calendar-events --time-min <ISO8601> --time-max <ISO8601>
    let calArgs = Array(args.dropFirst())
    guard let minIdx = calArgs.firstIndex(of: "--time-min"),
          minIdx + 1 < calArgs.count,
          let maxIdx = calArgs.firstIndex(of: "--time-max"),
          maxIdx + 1 < calArgs.count else {
        fputs("Usage: calendar-events --time-min <ISO8601> --time-max <ISO8601>\n", stderr)
        exit(1)
    }

    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

    let fallbackFormatter = ISO8601DateFormatter()
    fallbackFormatter.formatOptions = [.withInternetDateTime]

    func parseDate(_ str: String) -> Date? {
        formatter.date(from: str) ?? fallbackFormatter.date(from: str)
    }

    guard let timeMin = parseDate(calArgs[minIdx + 1]),
          let timeMax = parseDate(calArgs[maxIdx + 1]) else {
        fputs("Invalid ISO8601 date format. Example: 2025-01-15T00:00:00Z\n", stderr)
        exit(1)
    }

    let reader = CalendarReader()

    // Ensure we have access first (non-interactive check)
    let status = reader.checkStatus()
    guard status.hasAccess else {
        fputs("Calendar access not granted. Run 'calendar-status' first to request permission.\n", stderr)
        // Return empty array rather than failing
        print("[]")
        fflush(stdout)
        break
    }

    let events = reader.fetchExchangeEvents(timeMin: timeMin, timeMax: timeMax)
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    if let data = try? encoder.encode(events),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    } else {
        fputs("Failed to encode calendar events\n", stderr)
        exit(1)
    }

case "calendar-create-event":
    // Create a new event in a local Exchange calendar.
    // Reads JSON from stdin: { calendarId, title, start, end, isAllDay?, location?, notes? }
    guard let inputData = FileHandle.standardInput.readDataToEndOfFile() as Data?,
          !inputData.isEmpty else {
        fputs("Usage: calendar-create-event < JSON on stdin\n", stderr)
        exit(1)
    }

    let reader = CalendarReader()
    let status = reader.checkStatus()
    guard status.hasAccess else {
        fputs("Calendar access not granted\n", stderr)
        let result = CalendarReader.WriteResult(success: false, eventId: nil, error: "Calendar access not granted")
        let data = try! JSONEncoder().encode(result)
        print(String(data: data, encoding: .utf8)!)
        fflush(stdout)
        break
    }

    do {
        let input = try JSONDecoder().decode(CalendarReader.CreateEventInput.self, from: inputData)
        let result = reader.createEvent(input)
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let data = try encoder.encode(result)
        print(String(data: data, encoding: .utf8)!)
    } catch {
        fputs("Failed to parse input: \(error.localizedDescription)\n", stderr)
        exit(1)
    }

case "calendar-update-event":
    // Update an existing event.
    // Reads JSON from stdin: { eventId, title?, start?, end?, location?, notes? }
    guard let inputData = FileHandle.standardInput.readDataToEndOfFile() as Data?,
          !inputData.isEmpty else {
        fputs("Usage: calendar-update-event < JSON on stdin\n", stderr)
        exit(1)
    }

    let reader = CalendarReader()
    let status = reader.checkStatus()
    guard status.hasAccess else {
        let result = CalendarReader.WriteResult(success: false, eventId: nil, error: "Calendar access not granted")
        let data = try! JSONEncoder().encode(result)
        print(String(data: data, encoding: .utf8)!)
        fflush(stdout)
        break
    }

    do {
        let input = try JSONDecoder().decode(CalendarReader.UpdateEventInput.self, from: inputData)
        let result = reader.updateEvent(input)
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let data = try encoder.encode(result)
        print(String(data: data, encoding: .utf8)!)
    } catch {
        fputs("Failed to parse input: \(error.localizedDescription)\n", stderr)
        exit(1)
    }

case "calendar-delete-event":
    // Delete an event by ID.
    // Usage: calendar-delete-event --event-id <ID>
    let delArgs = Array(args.dropFirst())
    guard let idIdx = delArgs.firstIndex(of: "--event-id"),
          idIdx + 1 < delArgs.count else {
        fputs("Usage: calendar-delete-event --event-id <EVENT_ID>\n", stderr)
        exit(1)
    }
    let eventId = delArgs[idIdx + 1]

    let reader = CalendarReader()
    let status = reader.checkStatus()
    guard status.hasAccess else {
        let result = CalendarReader.WriteResult(success: false, eventId: nil, error: "Calendar access not granted")
        let data = try! JSONEncoder().encode(result)
        print(String(data: data, encoding: .utf8)!)
        fflush(stdout)
        break
    }

    let result = reader.deleteEvent(eventId: eventId)
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    if let data = try? encoder.encode(result),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    }

default:
    fputs("Unknown command: \(command)\n", stderr)
    fputs("Usage: system-audio-capture <detect|list-processes|capture|speech-detect|calendar-status|calendar-events|calendar-create-event|calendar-update-event|calendar-delete-event>\n", stderr)
    exit(1)
}
