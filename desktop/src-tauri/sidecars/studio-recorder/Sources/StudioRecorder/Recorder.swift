import AppKit
@preconcurrency import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

/// What `start` asks for.
struct StartOptions {
    enum Screen { case display(CGDirectDisplayID?), window(CGWindowID) }
    let sessionId: String
    let outputDir: String
    let screen: Screen
    let hideCursor: Bool
    let camera: String?
    let microphone: String?
    let systemAudio: Bool
    let extraWindows: [CGWindowID]
    let extraCameras: [String]
    let fps: Int
    /// Windows the app wants left out of a display recording (its own
    /// recording control), besides the app's floating windows found here.
    let excludeWindowIds: [CGWindowID]
    /// Also write the microphone as 16 kHz mono float32 PCM for on-device
    /// transcription (`mic-16k.f32`).
    let transcriptionPcm: Bool

    init(_ msg: [String: Any]) throws {
        guard let sessionId = msg["sessionId"] as? String, !sessionId.isEmpty,
              sessionId.range(of: "^[A-Za-z0-9_-]{1,100}$", options: .regularExpression) != nil else {
            throw Fail("start needs a sessionId", code: "bad-request")
        }
        guard let outputDir = msg["outputDir"] as? String, outputDir.hasPrefix("/") else {
            throw Fail("start needs an absolute outputDir", code: "bad-request")
        }
        self.sessionId = sessionId
        self.outputDir = outputDir
        let screen = msg["screen"] as? [String: Any] ?? ["kind": "display"]
        switch screen["kind"] as? String {
        case "window":
            guard let id = (screen["windowId"] as? NSNumber)?.uint32Value else { throw Fail("screen.windowId is missing", code: "bad-request") }
            self.screen = .window(id)
        case "display", nil:
            self.screen = .display((screen["displayId"] as? NSNumber)?.uint32Value)
        default:
            throw Fail("screen.kind must be display or window", code: "bad-request")
        }
        hideCursor = msg["hideCursor"] as? Bool ?? false
        camera = (msg["camera"] as? [String: Any]).map { ($0["deviceId"] as? String) ?? "default" }
        microphone = (msg["microphone"] as? [String: Any]).map { ($0["deviceId"] as? String) ?? "default" }
        systemAudio = msg["systemAudio"] as? Bool ?? false
        extraWindows = ((msg["extraWindows"] as? [[String: Any]]) ?? []).compactMap { ($0["windowId"] as? NSNumber)?.uint32Value }
        extraCameras = ((msg["extraCameras"] as? [[String: Any]]) ?? []).compactMap { $0["deviceId"] as? String }
        if extraWindows.count + extraCameras.count > 6 { throw Fail("at most 6 extra windows and cameras", code: "bad-request") }
        let fps = (msg["fps"] as? NSNumber)?.intValue ?? 60
        guard fps == 60 || fps == 30 else { throw Fail("fps must be 60 or 30", code: "bad-request") }
        self.fps = fps
        excludeWindowIds = ((msg["excludeWindowIds"] as? [NSNumber]) ?? []).map { $0.uint32Value }
        transcriptionPcm = msg["transcriptionPcm"] as? Bool ?? true
    }
}

// MARK: - the screen

/// The screen (a display or one window) on an exact frame-rate grid: the last
/// picture repeats while nothing changes, so the take is constant-rate when
/// Stop is pressed. Also takes the stream's system audio.
final class ScreenRecorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "studio-recorder.screen", qos: .userInteractive)
    let path: String
    let width: Int, height: Int, fps: Int64
    let codec: String
    private let writer: AVAssetWriter
    private let adaptor: AVAssetWriterInputPixelBufferAdaptor
    var systemAudio: AudioFileWriter?
    var onFailure: ((String) -> Void)?
    private(set) var firstPTS: Double?
    private var gridStart: CMTime?
    private var nextTick: Int64 = 0
    private var lastPixel: CVPixelBuffer?
    private var tickTimer: DispatchSourceTimer?
    private(set) var gridMisses = 0
    private var gridStopping = false
    private(set) var frames = 0
    private(set) var failure: String?
    let systemLevel = Locked<Float>(0)

    init(path: String, width: Int, height: Int, fps: Int) throws {
        self.path = path; self.width = width; self.height = height; self.fps = Int64(fps)
        try? FileManager.default.removeItem(atPath: path)
        writer = try AVAssetWriter(outputURL: URL(fileURLWithPath: path), fileType: .mov)
        writer.movieFragmentInterval = fragmentInterval
        let (settings, codec) = videoSettings(width: width, height: height, fps: fps, screen: true)
        self.codec = codec
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { throw Fail("the screen encoder refused \(width)×\(height)") }
        writer.add(input)
        adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        super.init()
        guard writer.startWriting() else { throw Fail("can't start the screen file: \(writer.error?.localizedDescription ?? "?")") }
    }

    private func gridTime(_ tick: Int64) -> CMTime { CMTimeAdd(gridStart!, CMTime(value: tick, timescale: CMTimeScale(fps))) }

    /// Repeat the last picture for every grid slot before `tick` (on `queue`).
    private func fillGrid(upTo tick: Int64) {
        guard let pixel = lastPixel, gridStart != nil else { return }
        while nextTick < tick && !gridStopping {
            // Wait a moment for the hardware encoder rather than leave a hole in the grid.
            var waits = 0
            while !adaptor.assetWriterInput.isReadyForMoreMediaData && waits < 200 && !gridStopping { usleep(500); waits += 1 }
            // A busy encoder keeps the slot open for the next pass: the grid may lag a moment but never gets a hole.
            guard adaptor.assetWriterInput.isReadyForMoreMediaData, adaptor.append(pixel, withPresentationTime: gridTime(nextTick)) else { gridMisses += 1; return }
            frames += 1; nextTick += 1
        }
    }

    func startGridTimer() {
        // Keep the grid filled while nothing on screen changes; stay 100 ms
        // behind live so real frames win their slot.
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(8))
        timer.setEventHandler { [weak self] in
            guard let self, let start = self.gridStart else { return }
            self.fillGrid(upTo: Int64(((hostNow() - start.seconds - 0.1) * Double(self.fps)).rounded(.down)))
        }
        timer.resume(); tickTimer = timer
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        if type == .audio {
            guard let systemAudio, sb.isValid else { return }
            let pts = CMSampleBufferGetPresentationTimeStamp(sb).seconds
            if systemAudio.append(sb, hostSeconds: pts) {
                let rms = audioRMS(sb).rms
                systemLevel.update { $0 = max($0, rms) }
            }
            return
        }
        guard type == .screen,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
              let pixel = CMSampleBufferGetImageBuffer(sb) else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        if firstPTS == nil {
            writer.startSession(atSourceTime: pts)
            firstPTS = pts.seconds
            gridStart = pts
        }
        let tick = Int64(((pts - gridStart!).seconds * Double(fps)).rounded())
        fillGrid(upTo: tick)
        lastPixel = pixel
        // Its slot is already written (two frames landed in one grid step):
        // keep it as the newest picture for the next slot.
        if tick < nextTick { return }
        var waits = 0
        while !adaptor.assetWriterInput.isReadyForMoreMediaData && waits < 200 && !gridStopping { usleep(500); waits += 1 }
        if adaptor.assetWriterInput.isReadyForMoreMediaData, adaptor.append(pixel, withPresentationTime: gridTime(nextTick)) { frames += 1; nextTick += 1 }
        else { gridMisses += 1 }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let message = "Screen capture stopped: \(error.localizedDescription)"
        queue.async { self.failure = message }
        onFailure?(message)
    }

    /// Wait (up to `timeout`) for the first frame; its time is the take's t0.
    func waitForFirstFrame(timeout: Double) async -> Double? {
        let deadline = hostNow() + timeout
        while hostNow() < deadline {
            if let t0 = queue.sync(execute: { firstPTS }) { return t0 }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return queue.sync { firstPTS }
    }

    /// Stop the grid (the stream must already be stopped) and finalize.
    func finish() async -> [String: Any] {
        gridStopping = true
        let gridEnd = queue.sync { () -> CMTime? in
            tickTimer?.cancel(); tickTimer = nil
            // End on the last frame already on the grid: pushing the final
            // ~100 ms of repeated frames through a real-time encoder after
            // capture stops is what makes Stop slow.
            guard gridStart != nil else { return nil }
            adaptor.assetWriterInput.markAsFinished()
            return gridTime(nextTick)
        }
        if let gridEnd { writer.endSession(atSourceTime: gridEnd) } else { writer.cancelWriting() }
        lastPixel = nil
        if gridEnd != nil { await writer.finishWriting() }
        let finalized = writer.status == .completed && frames > 0
        var row: [String: Any] = ["role": "screen", "path": path, "finalized": finalized, "width": width, "height": height,
                                  "fps": Double(fps), "frames": frames, "gridMisses": gridMisses, "codec": codec,
                                  "firstPts": jsonNumber(firstPTS), "lastPts": jsonNumber(gridEnd?.seconds)]
        if let first = firstPTS, let last = gridEnd?.seconds { row["durationSeconds"] = last - first }
        if let error = failure ?? (finalized ? nil : (writer.error?.localizedDescription ?? "The screen recording did not finalize")) { row["error"] = error }
        return row
    }
}

/// Receives frames for one extra source from AVFoundation or ScreenCaptureKit.
final class SourceSink: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let track: TrackWriter
    weak var session: AVCaptureSession?
    init(_ track: TrackWriter, session: AVCaptureSession? = nil) { self.track = track; self.session = session }
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        track.append(sampleBuffer, hostSeconds: hostTime(CMSampleBufferGetPresentationTimeStamp(sampleBuffer), from: session?.synchronizationClock))
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete else { return }
        track.append(sampleBuffer, hostSeconds: CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds)
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) { track.failure = "Window capture stopped: \(error.localizedDescription)" }
}

/// The microphone: an AAC file, the level, and (optionally) 16 kHz PCM for
/// the on-device transcription, all from the same buffers.
final class MicSink: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate, @unchecked Sendable {
    let writer: AudioFileWriter
    weak var session: AVCaptureSession?
    let level = Locked<Float>(0)
    private let pcm: FileHandle?
    let pcmPath: String?
    private let decimator = Decimator()
    private(set) var pcmSamples: Int64 = 0
    /// Host time of the first 16 kHz sample (the first buffer written).
    private(set) var pcmFirstPTS: Double?
    init(writer: AudioFileWriter, pcmPath: String?) {
        self.writer = writer
        self.pcmPath = pcmPath
        if let pcmPath {
            FileManager.default.createFile(atPath: pcmPath, contents: nil)
            pcm = FileHandle(forWritingAtPath: pcmPath)
        } else { pcm = nil }
    }
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        let seconds = hostTime(CMSampleBufferGetPresentationTimeStamp(sampleBuffer), from: session?.synchronizationClock)
        guard writer.append(sampleBuffer, hostSeconds: seconds) else { return }
        let (rms, mono) = audioRMS(sampleBuffer, collectFirstChannel: pcm != nil)
        level.update { $0 = max($0, rms) }
        guard let pcm, !mono.isEmpty else { return }
        if pcmFirstPTS == nil { pcmFirstPTS = seconds }
        let out = decimator.process(mono)
        pcmSamples += Int64(out.count)
        out.withUnsafeBufferPointer { pcm.write(Data(buffer: $0)) }
    }
    func close() { try? pcm?.close() }
}

// MARK: - the take

final class Take: @unchecked Sendable {
    let options: StartOptions
    let gate = CaptureGate()
    var t0: Double = 0
    var stream: SCStream?
    var screen: ScreenRecorder?
    var micSession: AVCaptureSession?
    var mic: MicSink?
    var cameraSessions: [AVCaptureSession] = []
    var tracks: [TrackWriter] = []
    var sinks: [SourceSink] = []
    var extraStreams: [SCStream] = []
    var trace: InputTrace?
    var statusTimer: DispatchSourceTimer?
    var exclusionTimer: DispatchSourceTimer?
    var display: SCDisplay?
    var excludedIds: Set<CGWindowID> = []
    var refreshing = false
    var viewport = CGRect.zero
    var scale = 2.0
    var warnings: [String] = []
    var startedPayload: [String: Any] = [:]
    let cameraQueue = DispatchQueue(label: "studio-recorder.camera")
    let micQueue = DispatchQueue(label: "studio-recorder.microphone", qos: .userInteractive)
    init(options: StartOptions) { self.options = options }
    func file(_ name: String) -> String { (options.outputDir as NSString).appendingPathComponent(name) }
    var knownPaths: [String] {
        var paths = [file("screen.mov"), file("microphone.m4a"), file("system-audio.m4a"), file("trace.jsonl"), file("mic-16k.f32")]
        paths += tracks.map(\.path)
        return paths
    }
}

final class Recorder: @unchecked Sendable {
    private var take: Take?

    /// Left out of a display recording: the app's floating windows (the
    /// recording control, the agent HUD: on screen at a level above normal
    /// windows, and content-protected besides) and any window the app names.
    /// Its main window stays in, so a take can show the app itself.
    static func floatingWindowIds(_ options: StartOptions) -> Set<CGWindowID> {
        let parent = Int(getppid())
        let info = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
        var ids = Set(options.excludeWindowIds)
        for w in info where (w[kCGWindowOwnerPID as String] as? Int) == parent && (w[kCGWindowLayer as String] as? Int ?? 0) != 0 {
            if let id = w[kCGWindowNumber as String] as? UInt32 { ids.insert(id) }
        }
        return ids
    }

    static func excludedWindows(_ content: SCShareableContent, _ options: StartOptions) -> [SCWindow] {
        let parent = getppid()
        return content.windows.filter { w in
            options.excludeWindowIds.contains(w.windowID) || (w.owningApplication?.processID == parent && w.windowLayer != 0)
        }
    }

    /// A display take follows the app's floating windows: one shown after
    /// the take started (the recording control) is left out within a second.
    private func startExclusionRefresh(_ take: Take) {
        guard take.display != nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "studio-recorder.exclusions"))
        timer.schedule(deadline: .now() + 1, repeating: .seconds(1))
        timer.setEventHandler { [weak take] in
            guard let take, let display = take.display, let stream = take.stream, !take.refreshing else { return }
            let ids = Recorder.floatingWindowIds(take.options)
            guard !ids.isSubset(of: take.excludedIds) else { return }
            take.refreshing = true
            Task {
                defer { take.refreshing = false }
                guard let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) else { return }
                let excluded = Recorder.excludedWindows(content, take.options)
                do {
                    try await stream.updateContentFilter(SCContentFilter(display: display, excludingWindows: excluded))
                    take.excludedIds = Set(excluded.map(\.windowID)).union(take.excludedIds)
                    log("take \(take.options.sessionId): now leaving out \(excluded.count) window(s)")
                } catch {
                    log("take \(take.options.sessionId): could not update the exclusions: \(error.localizedDescription)")
                }
            }
        }
        timer.resume()
        take.exclusionTimer = timer
    }
    /// The last finished take's `stopped` payload, so a repeated stop answers the same.
    private var lastStopped: (id: String, payload: [String: Any])?

    func statusSnapshot() -> [String: Any] {
        guard let take else { return ["recording": false] }
        return ["recording": true, "sessionId": take.options.sessionId, "t0HostTime": take.t0,
                "elapsedMs": max(0, (hostNow() - take.t0) * 1000)]
    }

    // MARK: start

    func start(_ options: StartOptions) async throws -> [String: Any] {
        if let take { throw Fail("a take is already recording (\(take.options.sessionId))", code: "busy") }
        // Never prompt from here: the app asks first (requestPermissions).
        var missing: [String] = []
        if Permissions.screenRecording() != "granted" { missing.append("screenRecording") }
        if options.microphone != nil && Permissions.device(.audio) != "granted" { missing.append("microphone") }
        if (options.camera != nil || !options.extraCameras.isEmpty) && Permissions.device(.video) != "granted" { missing.append("camera") }
        if !missing.isEmpty {
            throw Fail("not allowed yet: \(missing.joined(separator: ", "))", code: "permission")
        }
        try FileManager.default.createDirectory(atPath: options.outputDir, withIntermediateDirectories: true)

        let take = Take(options: options)
        do {
            try await open(take)
        } catch {
            await teardown(take)
            throw error
        }
        self.take = take
        lastStopped = nil
        return take.startedPayload
    }

    private func open(_ take: Take) async throws {
        let options = take.options
        let opened = hostNow()
        // 1. The microphone and the cameras first: they hold their samples
        //    until the screen's first frame opens the gate.
        if let micID = options.microphone {
            guard let device = micID == "default" ? AVCaptureDevice.default(for: .audio) : AVCaptureDevice(uniqueID: micID) else {
                throw Fail("The selected microphone is not connected.", code: "device")
            }
            let writer = AudioFileWriter(role: "microphone", path: take.file("microphone.m4a"), channels: 1, gate: take.gate)
            let sink = MicSink(writer: writer, pcmPath: options.transcriptionPcm ? take.file("mic-16k.f32") : nil)
            let session = AVCaptureSession()
            session.beginConfiguration()
            let source = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(source) else { throw Fail("\(device.localizedName) could not be opened.", code: "device") }
            session.addInput(source)
            let output = AVCaptureAudioDataOutput()
            // 48 kHz mono float: the level and the 16 kHz copy read it as is.
            output.audioSettings = [
                AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false, AVLinearPCMIsBigEndianKey: false,
            ]
            output.setSampleBufferDelegate(sink, queue: take.micQueue)
            guard session.canAddOutput(output) else { throw Fail("\(device.localizedName) could not be opened.", code: "device") }
            session.addOutput(output)
            session.commitConfiguration()
            sink.session = session
            take.micSession = session; take.mic = sink
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in take.micQueue.async { session.startRunning(); done.resume() } }
            guard session.isRunning else { throw Fail("\(device.localizedName) did not start.", code: "device") }
        }
        var cameraIDs: [(role: String, id: String)] = []
        if let camera = options.camera { cameraIDs.append(("camera", camera)) }
        for (i, id) in options.extraCameras.enumerated() { cameraIDs.append(("camera-\(i + 1)", id)) }
        for (role, id) in cameraIDs {
            guard let device = id == "default" ? AVCaptureDevice.default(for: .video) : AVCaptureDevice(uniqueID: id) else {
                throw Fail("A selected camera is not connected.", code: "device")
            }
            let track = TrackWriter(role: role, kind: "camera", sourceID: device.uniqueID, name: device.localizedName,
                                    path: take.file("\(role).mov"), gate: take.gate)
            let session = AVCaptureSession()
            session.beginConfiguration()
            session.sessionPreset = .high
            let source = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(source) else { throw Fail("\(device.localizedName) could not be opened. It may be in use by another app.", code: "device") }
            session.addInput(source)
            let output = AVCaptureVideoDataOutput()
            output.alwaysDiscardsLateVideoFrames = true
            let sink = SourceSink(track, session: session)
            output.setSampleBufferDelegate(sink, queue: DispatchQueue(label: "studio-recorder.\(role)"))
            guard session.canAddOutput(output) else { throw Fail("\(device.localizedName) could not be opened.", code: "device") }
            session.addOutput(output)
            session.commitConfiguration()
            take.tracks.append(track); take.sinks.append(sink); take.cameraSessions.append(session)
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in take.cameraQueue.async { session.startRunning(); done.resume() } }
            guard session.isRunning else { throw Fail("\(device.localizedName) did not start. It may be in use by another app.", code: "device") }
        }

        // 2. The screen. Screen Recording is granted (checked above), so this
        //    never prompts.
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let filter: SCContentFilter
        let surface: InputTrace.Surface
        switch options.screen {
        case .display(let wanted):
            let id = wanted ?? CGMainDisplayID()
            guard let display = content.displays.first(where: { $0.displayID == id }) else {
                throw Fail("That display is not connected.", code: "target")
            }
            let excluded = Recorder.excludedWindows(content, options)
            filter = SCContentFilter(display: display, excludingWindows: excluded)
            take.display = display
            take.excludedIds = Set(excluded.map(\.windowID))
            take.viewport = display.frame
            surface = .display(frame: display.frame)
        case .window(let id):
            guard let window = content.windows.first(where: { $0.windowID == id }) else {
                throw Fail("That window is closed or not on screen.", code: "target")
            }
            filter = SCContentFilter(desktopIndependentWindow: window)
            take.viewport = window.frame
            surface = .window(id: id, pid: window.owningApplication?.processID ?? 0, frame: window.frame)
        }
        take.scale = Double(filter.pointPixelScale)
        var width = Int((take.viewport.width * take.scale).rounded()) & ~1
        var height = Int((take.viewport.height * take.scale).rounded()) & ~1
        // HEVC's ceiling: keep the shape, fit 8192.
        let fit = min(1.0, 8192.0 / Double(max(width, height)))
        if fit < 1 { width = Int(Double(width) * fit) & ~1; height = Int(Double(height) * fit) & ~1 }
        guard width >= 2, height >= 2 else { throw Fail("The recorded surface has no size.", code: "target") }

        let screen = try ScreenRecorder(path: take.file("screen.mov"), width: width, height: height, fps: options.fps)
        if options.systemAudio {
            screen.systemAudio = AudioFileWriter(role: "system-audio", path: take.file("system-audio.m4a"), channels: 2, gate: take.gate)
        }
        let sessionId = options.sessionId
        screen.onFailure = { message in
            emit(["event": "error", "sessionId": sessionId, "message": message, "fatal": true])
        }
        take.screen = screen

        let config = SCStreamConfiguration()
        config.width = width
        config.height = height
        config.showsCursor = !options.hideCursor
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(options.fps))
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.queueDepth = 8
        config.scalesToFit = true
        if options.systemAudio {
            config.capturesAudio = true
            config.excludesCurrentProcessAudio = true
            config.sampleRate = 48_000
            config.channelCount = 2
        }
        let stream = SCStream(filter: filter, configuration: config, delegate: screen)
        try stream.addStreamOutput(screen, type: .screen, sampleHandlerQueue: screen.queue)
        if options.systemAudio { try stream.addStreamOutput(screen, type: .audio, sampleHandlerQueue: screen.queue) }

        // 3. Extra windows (their own streams, one file each).
        for (i, id) in options.extraWindows.enumerated() {
            guard let window = content.windows.first(where: { $0.windowID == id }) else {
                throw Fail("A selected window closed before recording.", code: "target")
            }
            let name = [window.owningApplication?.applicationName, window.title].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            let role = "window-\(i + 1)"
            let track = TrackWriter(role: role, kind: "window", sourceID: String(id), name: name.isEmpty ? "Window" : name,
                                    path: take.file("\(role).mov"), gate: take.gate)
            let windowFilter = SCContentFilter(desktopIndependentWindow: window)
            let windowConfig = SCStreamConfiguration()
            let windowScale = Double(windowFilter.pointPixelScale)
            windowConfig.width = max(2, Int(window.frame.width * windowScale))
            windowConfig.height = max(2, Int(window.frame.height * windowScale))
            windowConfig.minimumFrameInterval = CMTime(value: 1, timescale: 30)
            windowConfig.pixelFormat = kCVPixelFormatType_32BGRA
            windowConfig.showsCursor = !options.hideCursor
            windowConfig.queueDepth = 6
            let sink = SourceSink(track)
            let extra = SCStream(filter: windowFilter, configuration: windowConfig, delegate: sink)
            try extra.addStreamOutput(sink, type: .screen, sampleHandlerQueue: DispatchQueue(label: "studio-recorder.\(role)"))
            try await extra.startCapture()
            take.tracks.append(track); take.sinks.append(sink); take.extraStreams.append(extra)
        }

        // 4. The trace listens before the first frame, so it covers t0 (the
        //    build keeps only what falls in the take).
        let trace = InputTrace(surface: surface, scale: take.scale, jsonlPath: take.file("trace.jsonl"))
        trace.start()
        take.trace = trace
        log("take \(options.sessionId): sources ready in \(Int((hostNow() - opened) * 1000)) ms")

        // 5. Go: the screen's first frame is t0 for everything.
        try await stream.startCapture()
        take.stream = stream
        guard let t0 = await screen.waitForFirstFrame(timeout: 3) else {
            throw Fail("No picture came from ScreenCaptureKit.", code: "capture")
        }
        take.t0 = t0
        take.gate.begin(t0)
        screen.queue.async { screen.startGridTimer() }
        log("take \(options.sessionId): first frame \(Int((hostNow() - opened) * 1000)) ms after start")
        if trace.mode != "events" {
            take.warnings.append(trace.mode == "polled"
                ? "Input trace: pointer and clicks polled at 60 Hz; typing from the time of the last key press (no input monitor)."
                : "Input trace: typing from the time of the last key press (no keyboard monitor).")
        }

        var planned: [[String: Any]] = [["role": "screen", "path": screen.path]]
        if take.mic != nil { planned.append(["role": "microphone", "path": take.file("microphone.m4a")]) }
        if options.systemAudio { planned.append(["role": "system-audio", "path": take.file("system-audio.m4a")]) }
        for track in take.tracks { planned.append(["role": track.role, "path": track.path]) }
        take.startedPayload = [
            "sessionId": sessionId,
            "t0HostTime": t0,
            "startedAt": ISO8601DateFormatter().string(from: Date()),
            "viewport": ["x": Double(take.viewport.minX), "y": Double(take.viewport.minY), "width": Double(take.viewport.width),
                         "height": Double(take.viewport.height), "scale": take.scale],
            "screen": ["width": width, "height": height, "fps": options.fps, "codec": screen.codec],
            "files": planned,
            "trace": ["mode": trace.mode, "path": take.file("trace.jsonl")],
            "transcriptionPcm": take.mic?.pcmPath.map { ["path": $0, "sampleRate": 16_000, "format": "f32le"] as [String: Any] } ?? NSNull(),
            "warnings": take.warnings,
        ]
        // The take's clock, saved now so an interrupted take can be recovered.
        writeJSONAtomic(take.file("take.json"), ["sessionId": sessionId, "t0HostTime": t0, "state": "recording",
                                                 "started": take.startedPayload])

        // 5. Progress for the recording control.
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "studio-recorder.status"))
        timer.schedule(deadline: .now() + .milliseconds(500), repeating: .milliseconds(500))
        timer.setEventHandler { [weak take] in
            guard let take else { return }
            let bytes = take.knownPaths.reduce(Int64(0)) { $0 + fileSize($1) }
            let mic = take.mic?.level.update { v -> Float in let x = v; v = 0; return x } ?? 0
            let system = take.screen?.systemLevel.update { v -> Float in let x = v; v = 0; return x } ?? 0
            emit(["event": "status", "sessionId": take.options.sessionId, "elapsedMs": max(0, (hostNow() - take.t0) * 1000),
                  "bytes": bytes, "levels": ["mic": Double(min(1, mic * 2.5)), "system": Double(min(1, system * 2.5))]])
        }
        timer.resume()
        take.statusTimer = timer
        startExclusionRefresh(take)
        log("take \(sessionId) started: \(width)x\(height)@\(options.fps) \(screen.codec), t0 \(t0)")
    }

    /// Stop every source (best effort); writers are left for finish().
    private func stopSources(_ take: Take) async {
        take.statusTimer?.cancel(); take.statusTimer = nil
        take.exclusionTimer?.cancel(); take.exclusionTimer = nil
        take.trace?.stop()
        if let stream = take.stream { try? await stream.stopCapture() }
        take.stream = nil
        for stream in take.extraStreams { try? await stream.stopCapture() }
        take.gate.halt()
        if let session = take.micSession {
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in take.micQueue.async { session.stopRunning(); done.resume() } }
        }
        for session in take.cameraSessions {
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in take.cameraQueue.async { session.stopRunning(); done.resume() } }
        }
        take.mic?.close()
    }

    /// A start that failed halfway: release what it opened.
    private func teardown(_ take: Take) async {
        await stopSources(take)
        _ = await take.screen?.finish()
        _ = await take.screen?.systemAudio?.finish()
        _ = await take.mic?.writer.finish()
        for track in take.tracks { _ = await track.finish(holdUntil: nil) }
    }

    // MARK: stop

    func stop(sessionId: String?) async throws -> [String: Any] {
        guard let take else {
            if let last = lastStopped, sessionId == nil || last.id == sessionId { return last.payload }
            throw Fail("nothing is recording", code: "not-recording")
        }
        if let sessionId, sessionId != take.options.sessionId { throw Fail("that take is not recording", code: "not-recording") }
        self.take = nil
        let end = hostNow()
        await stopSources(take)
        var files: [[String: Any]] = []
        var warnings = take.warnings
        func collect(_ row: [String: Any]) {
            guard let path = row["path"] as? String else { return }
            if let error = row["error"] as? String { warnings.append("\(row["role"] as? String ?? "file"): \(error)") }
            guard row["finalized"] as? Bool == true else { return }
            var out = row
            out["bytes"] = fileSize(path)
            out.removeValue(forKey: "finalized")
            out.removeValue(forKey: "error")
            if let first = row["firstPts"] as? Double { out["offsetMs"] = ((first - take.t0) * 1000).rounded() }
            files.append(out)
        }
        if let screen = take.screen { collect(await screen.finish()) }
        if let system = take.screen?.systemAudio { collect(await system.finish()) }
        if let mic = take.mic { collect(await mic.writer.finish()) }
        for track in take.tracks { collect(await track.finish(holdUntil: track.kind == "window" ? end : nil)) }

        let screenEnd = (files.first { $0["role"] as? String == "screen" }?["lastPts"] as? Double) ?? end
        let trace = take.trace?.build(t0: take.t0, end: screenEnd) ?? [:]
        let tracePath = take.file("trace.json")
        writeJSONAtomic(tracePath, trace)

        var payload: [String: Any] = [
            "sessionId": take.options.sessionId,
            "t0": take.t0,
            "endedAt": screenEnd,
            "durationMs": max(0, (screenEnd - take.t0) * 1000).rounded(),
            "files": files,
            "tracePath": tracePath,
            "traceMode": take.trace?.mode ?? NSNull(),
            "warnings": warnings,
        ]
        if let mic = take.mic, let pcmPath = mic.pcmPath, let first = mic.pcmFirstPTS {
            payload["transcriptionPcm"] = ["path": pcmPath, "sampleRate": 16_000, "format": "f32le", "samples": mic.pcmSamples,
                                           "firstPts": first, "offsetMs": ((first - take.t0) * 1000)]
        } else {
            payload["transcriptionPcm"] = NSNull()
        }
        writeJSONAtomic(take.file("take.json"), ["sessionId": take.options.sessionId, "t0HostTime": take.t0, "state": "stopped",
                                                 "started": take.startedPayload, "stopped": payload])
        lastStopped = (take.options.sessionId, payload)
        log("take \(take.options.sessionId) stopped: \(files.count) file(s), \(warnings.count) warning(s)")
        return payload
    }

    // MARK: cancel / exit

    func cancel(sessionId: String?) async throws -> [String: Any] {
        guard let take else { return ["cancelled": false] }
        if let sessionId, sessionId != take.options.sessionId { throw Fail("that take is not recording", code: "not-recording") }
        self.take = nil
        await teardown(take)
        try? FileManager.default.removeItem(atPath: take.options.outputDir)
        log("take \(take.options.sessionId) cancelled")
        return ["cancelled": true, "sessionId": take.options.sessionId]
    }

    /// The app went away mid-take: finalize so the files stay playable.
    func finalizeForExit() async -> Bool {
        guard take != nil else { return false }
        _ = try? await stop(sessionId: nil)
        return true
    }
}
