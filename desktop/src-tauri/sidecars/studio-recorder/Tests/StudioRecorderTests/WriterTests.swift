import AVFoundation
import CoreMedia
import CoreVideo
import CryptoKit
import XCTest
@testable import studio_recorder

/// The writers fed made-up pictures and sound, the way the capture queues feed
/// them (uneven arrival, a still stretch, two pictures in one frame step, a
/// display's own colours), then the files probed with ffprobe: what the Studio's
/// import checks before it keeps a recording as it is
/// (studio-worker/src/recorder-files.ts). Set STUDIO_RECORDER_OUT to keep the
/// files (the worker's tests import them: studio-worker/test/fixtures/recorder).
final class WriterTests: XCTestCase {
    var dir: URL!

    override func setUpWithError() throws {
        if let out = ProcessInfo.processInfo.environment["STUDIO_RECORDER_OUT"], !out.isEmpty {
            dir = URL(fileURLWithPath: out)
        } else {
            dir = FileManager.default.temporaryDirectory.appendingPathComponent("studio-recorder-tests-\(UUID().uuidString)")
        }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    // MARK: made-up input

    /// A BGRA picture (as ScreenCaptureKit gives) with a bar at `n`, optionally tagged Display P3.
    func bgra(_ width: Int, _ height: Int, _ n: Int, p3: Bool = false) -> CVPixelBuffer {
        var out: CVPixelBuffer?
        let attrs = [kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any]()] as CFDictionary
        XCTAssertEqual(CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, attrs, &out), kCVReturnSuccess)
        let pixel = out!
        CVPixelBufferLockBaseAddress(pixel, [])
        let base = CVPixelBufferGetBaseAddress(pixel)!.assumingMemoryBound(to: UInt8.self)
        let stride = CVPixelBufferGetBytesPerRow(pixel)
        let bar = (n * 7) % width
        for y in 0..<height {
            let row = base + y * stride
            for x in 0..<width {
                let on = abs(x - bar) < 12
                row[x * 4] = on ? 255 : UInt8(x % 256)
                row[x * 4 + 1] = on ? 255 : UInt8(y % 256)
                row[x * 4 + 2] = on ? 255 : 90
                row[x * 4 + 3] = 255
            }
        }
        CVPixelBufferUnlockBaseAddress(pixel, [])
        if p3 {
            CVBufferSetAttachment(pixel, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_P3_D65, .shouldPropagate)
            CVBufferSetAttachment(pixel, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_sRGB, .shouldPropagate)
        }
        return pixel
    }

    /// A 4:2:0 limited-range picture (as the camera is asked for) with a bar at `n`.
    func yuv(_ width: Int, _ height: Int, _ n: Int) -> CVPixelBuffer {
        var out: CVPixelBuffer?
        let attrs = [kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any]()] as CFDictionary
        XCTAssertEqual(CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, attrs, &out), kCVReturnSuccess)
        let pixel = out!
        CVPixelBufferLockBaseAddress(pixel, [])
        let luma = CVPixelBufferGetBaseAddressOfPlane(pixel, 0)!.assumingMemoryBound(to: UInt8.self)
        let lumaStride = CVPixelBufferGetBytesPerRowOfPlane(pixel, 0)
        let bar = (n * 11) % width
        for y in 0..<height { for x in 0..<width { luma[y * lumaStride + x] = abs(x - bar) < 16 ? 235 : UInt8(16 + (x + y) % 200) } }
        let chroma = CVPixelBufferGetBaseAddressOfPlane(pixel, 1)!.assumingMemoryBound(to: UInt8.self)
        let chromaStride = CVPixelBufferGetBytesPerRowOfPlane(pixel, 1)
        for y in 0..<(height / 2) { for x in 0..<(width / 2) { chroma[y * chromaStride + 2 * x] = 128; chroma[y * chromaStride + 2 * x + 1] = UInt8(100 + y % 50) } }
        CVPixelBufferUnlockBaseAddress(pixel, [])
        return pixel
    }

    /// A rising tone (200 Hz, then 100 Hz higher each second): no two stretches of it alike, so where it lands in a
    /// decoded file says exactly how it was moved.
    static func chirp(_ n: Int) -> Double {
        let t = Double(n) / 48_000
        return 0.3 * sin(2 * Double.pi * (200 * t + 50 * t * t))
    }

    /// 48 kHz mono float PCM (as the microphone is asked for): a tone, `count` samples starting at sample `first`, stamped `seconds`.
    func pcm(first: Int, count: Int, seconds: Double) -> CMSampleBuffer {
        var asbd = AudioStreamBasicDescription(mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM,
                                               mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
                                               mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 1,
                                               mBitsPerChannel: 32, mReserved: 0)
        var format: CMAudioFormatDescription?
        XCTAssertEqual(CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0,
                                                      magicCookie: nil, extensions: nil, formatDescriptionOut: &format), noErr)
        let samples = (0..<count).map { Float(Self.chirp(first + $0)) }
        var block: CMBlockBuffer?
        XCTAssertEqual(CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: count * 4, blockAllocator: nil,
                                                          customBlockSource: nil, offsetToData: 0, dataLength: count * 4, flags: 0,
                                                          blockBufferOut: &block), noErr)
        samples.withUnsafeBytes { raw in _ = CMBlockBufferReplaceDataBytes(with: raw.baseAddress!, blockBuffer: block!, offsetIntoDestination: 0, dataLength: count * 4) }
        var sample: CMSampleBuffer?
        XCTAssertEqual(CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block!, formatDescription: format!,
                                                                            sampleCount: count, presentationTimeStamp: CMTime(seconds: seconds, preferredTimescale: 48_000),
                                                                            packetDescriptions: nil, sampleBufferOut: &sample), noErr)
        return sample!
    }

    // MARK: ffprobe

    static let ffprobe = ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "/usr/bin/ffprobe"].first { FileManager.default.isExecutableFile(atPath: $0) }

    func probe(_ path: String, _ args: [String]) throws -> String {
        guard let tool = Self.ffprobe else { throw XCTSkip("ffprobe is not installed") }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = ["-v", "error"] + args + [path]
        let pipe = Pipe()
        process.standardOutput = pipe
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0, "ffprobe \(args)")
        return String(decoding: data, as: UTF8.self)
    }

    func json(_ text: String) -> [String: Any] { (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] ?? [:] }

    /// The picture's packets (time, key) in file order.
    func packets(_ path: String) throws -> [(t: Double, key: Bool)] {
        try probe(path, ["-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0"])
            .split(separator: "\n").map { line in
                let parts = line.split(separator: ",")
                return (Double(parts[0])!, parts.count > 1 && parts[1].contains("K"))
            }
    }

    /// The checks the import makes on a picture (recorder-files.ts), here on the writer's own output.
    func assertEditorReady(_ path: String, fps: Int, frames: Int64, width: Int, height: Int, file: StaticString = #filePath, line: UInt = #line) throws {
        let info = json(try probe(path, ["-count_packets", "-show_streams", "-show_format", "-of", "json"]))
        let streams = info["streams"] as? [[String: Any]] ?? []
        XCTAssertEqual(streams.count, 1, "one stream", file: file, line: line)
        let v = streams.first ?? [:]
        XCTAssertEqual(v["codec_name"] as? String, "h264", file: file, line: line)
        XCTAssertEqual(v["pix_fmt"] as? String, "yuv420p", file: file, line: line)
        XCTAssertEqual(v["color_range"] as? String, "tv", file: file, line: line)
        XCTAssertEqual(v["color_space"] as? String, "bt709", file: file, line: line)
        XCTAssertEqual(v["color_primaries"] as? String, "bt709", file: file, line: line)
        XCTAssertEqual(v["color_transfer"] as? String, "bt709", file: file, line: line)
        XCTAssertEqual(v["width"] as? Int, width, file: file, line: line)
        XCTAssertEqual(v["height"] as? Int, height, file: file, line: line)
        XCTAssertEqual(v["avg_frame_rate"] as? String, "\(fps)/1", file: file, line: line)
        XCTAssertEqual(v["r_frame_rate"] as? String, "\(fps)/1", file: file, line: line)
        XCTAssertEqual(v["nb_read_packets"] as? String, String(frames), file: file, line: line)
        XCTAssertEqual(Double(v["start_time"] as? String ?? "") ?? -1, 0, accuracy: 1e-9, file: file, line: line)
        XCTAssertEqual(Double(v["duration"] as? String ?? "") ?? -1, Double(frames) / Double(fps), accuracy: 0.5 / Double(fps), file: file, line: line)
        let list = try packets(path)
        XCTAssertEqual(list.count, Int(frames), file: file, line: line)
        XCTAssertTrue(list.first?.key == true, "starts on a key frame", file: file, line: line)
        var sinceKey = 0
        for (i, p) in list.enumerated() {
            XCTAssertEqual(p.t, Double(i) / Double(fps), accuracy: 0.00025, "frame \(i) keeps its time", file: file, line: line)
            sinceKey = p.key ? 0 : sinceKey + 1
            XCTAssertLessThanOrEqual(sinceKey, 2 * fps, "a key frame at least every two seconds", file: file, line: line)
        }
    }

    // MARK: tests

    /// The screen at 60 fps: pictures arrive unevenly, two in one step, then a still second (the grid timer's work is
    /// done here by the next picture), with a display's P3 colours.
    func testScreenOnTheGrid() async throws {
        let path = dir.appendingPathComponent("screen.mp4").path
        let grid = try GridVideo(path: path, width: 320, height: 180, fps: 60, screen: true)
        grid.patience = 20_000
        var segments: [SegmentRecord] = []
        grid.file.onSegment = { segments.append($0) }
        var times: [Double] = []
        var t = 0.0
        for n in 0..<240 {
            times.append(t)
            t += n == 50 ? 0.004 : n == 120 ? 1.0 : (1.0 / 60 + (n % 3 == 0 ? 0.003 : -0.002))
        }
        var last: CVPixelBuffer?
        for (n, seconds) in times.enumerated() {
            let pixel = bgra(320, 180, n, p3: true)
            grid.place(pixel, at: grid.slot(at: seconds), after: last)
            last = pixel
        }
        let problem = await grid.finish()
        XCTAssertNil(problem)
        XCTAssertEqual(grid.misses, 0)
        let frames = grid.next
        XCTAssertEqual(frames, grid.slot(at: times.last!) + 1)
        try assertEditorReady(path, fps: 60, frames: frames, width: 320, height: 180)
        // The file is its segments, end to end, as the index says.
        XCTAssertEqual(segments.first?.kind, "init")
        XCTAssertGreaterThan(segments.count, 3)
        XCTAssertEqual(segments.reduce(0) { $0 + Int64($1.length) }, fileSize(path))
        let index = try String(contentsOfFile: path + ".segments", encoding: .utf8).split(separator: "\n")
        XCTAssertEqual(index.count, segments.count)
        XCTAssertEqual(segments.last?.endSeconds ?? 0, Double(frames) / 60, accuracy: 0.001)
        // The hash kept as the segments were written is the file's own (the Studio refuses other bytes).
        let whole = try Data(contentsOf: URL(fileURLWithPath: path))
        XCTAssertEqual(grid.file.sha256, SHA256.hash(data: whole).map { String(format: "%02x", $0) }.joined())
    }

    /// A 16-inch MacBook Pro's full screen (3472x2266) at 60 fps is H.264 (level 5.2) and passes every check; past 4096
    /// pixels a side the writer picks HEVC, which the import conforms.
    func testLargeScreenStaysH264() async throws {
        XCTAssertEqual(videoSettings(width: 4096, height: 2560, fps: 60, screen: true).codec, "h264")
        XCTAssertEqual(videoSettings(width: 4112, height: 2658, fps: 60, screen: true).codec, "hevc")
        XCTAssertEqual(videoSettings(width: 5120, height: 2880, fps: 60, screen: true).codec, "hevc")
        let path = dir.appendingPathComponent("screen-3472x2266.mp4").path
        let grid = try GridVideo(path: path, width: 3472, height: 2266, fps: 60, screen: true)
        grid.patience = 20_000
        XCTAssertEqual(grid.codec, "h264")
        let pictures = [bgra(3472, 2266, 0, p3: true), bgra(3472, 2266, 40, p3: true)]
        for n in 0..<90 { grid.put(pictures[n % 2]) }
        let problem = await grid.finish()
        XCTAssertNil(problem)
        try assertEditorReady(path, fps: 60, frames: 90, width: 3472, height: 2266)
        try? FileManager.default.removeItem(atPath: path)
        try? FileManager.default.removeItem(atPath: path + ".segments")
    }

    /// A 5K screen (5120x2880) is HEVC: the Studio conforms it, but the editor opens it at Stop from this file. WebKit's
    /// `<video>` on the Mac plays through AVFoundation, so the file must open there and every frame decode, from a
    /// file:// URL as the recorder leaves it (fragmented, as it grows) and by its timestamps.
    func testHEVCScreenPlaysInAVFoundation() async throws {
        let path = dir.appendingPathComponent("screen-5k.mp4").path
        let grid = try GridVideo(path: path, width: 5120, height: 2880, fps: 60, screen: true)
        grid.patience = 20_000
        XCTAssertEqual(grid.codec, "hevc")
        let pictures = [bgra(5120, 2880, 0), bgra(5120, 2880, 30)]
        for n in 0..<60 { grid.put(pictures[n % 2]) }
        let problem = await grid.finish()
        XCTAssertNil(problem)
        let asset = AVURLAsset(url: URL(fileURLWithPath: path))
        let playable = try await asset.load(.isPlayable)
        XCTAssertTrue(playable, "AVFoundation plays the HEVC take")
        let track = try await asset.loadTracks(withMediaType: .video).first
        let video = try XCTUnwrap(track)
        let size = try await video.load(.naturalSize)
        XCTAssertEqual(size, CGSize(width: 5120, height: 2880))
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: video, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange])
        reader.add(output)
        XCTAssertTrue(reader.startReading())
        var decoded: [Double] = []
        while let sample = output.copyNextSampleBuffer() {
            if CMSampleBufferGetImageBuffer(sample) != nil { decoded.append(CMSampleBufferGetPresentationTimeStamp(sample).seconds) }
        }
        XCTAssertEqual(reader.status, .completed)
        XCTAssertEqual(decoded.count, 60, "every frame decodes")
        for (i, t) in decoded.enumerated() { XCTAssertEqual(t, Double(i) / 60, accuracy: 0.0005) }
        try? FileManager.default.removeItem(atPath: path)
        try? FileManager.default.removeItem(atPath: path + ".segments")
    }

    /// A camera through its TrackWriter: 4:2:0 pictures at an uneven ~24 fps, one held from before the take, written at 30.
    func testCameraOnTheGrid() async throws {
        let path = dir.appendingPathComponent("camera.mp4").path
        let gate = CaptureGate()
        let track = TrackWriter(role: "camera", kind: "camera", sourceID: "made-up", name: "Made-up Camera", path: path, gate: gate)
        let t0 = 5000.0
        track.append(yuv(480, 270, 0), hostSeconds: t0 - 0.02)
        gate.begin(t0)
        var seconds = t0 + 0.031
        for n in 1..<75 {
            track.append(yuv(480, 270, n), hostSeconds: seconds)
            seconds += n % 4 == 0 ? 0.05 : 0.038
            if n % 10 == 0 { try await Task.sleep(nanoseconds: 5_000_000) }
        }
        let row = await track.finish(holdUntil: nil)
        XCTAssertNil(row["error"], "\(row)")
        XCTAssertEqual(row["firstPts"] as? Double, t0, "the held picture starts it at t0")
        let frames = Int64(row["frames"] as! Int64)
        try assertEditorReady(path, fps: 30, frames: frames, width: 480, height: 270)
    }

    /// The microphone: AAC at 48 kHz, its first sample at 0, in segments.
    func testMicrophoneInSegments() async throws {
        let path = dir.appendingPathComponent("microphone.m4a").path
        let gate = CaptureGate()
        let writer = AudioFileWriter(role: "microphone", path: path, channels: 1, gate: gate)
        let t0 = 7000.0
        gate.begin(t0)
        var first = 0
        while first < 48_000 * 5 {
            let sample = pcm(first: first, count: 1024, seconds: t0 + 0.01 + Double(first) / 48_000)
            var tries = 0
            while !writer.append(sample, hostSeconds: t0 + 0.01 + Double(first) / 48_000) && tries < 200 { try await Task.sleep(nanoseconds: 1_000_000); tries += 1 }
            first += 1024
        }
        let row = await writer.finish()
        XCTAssertNil(row["error"], "\(row)")
        // The file's time 0 is before the first sample captured by the encoder's priming.
        XCTAssertEqual(row["capturedPts"] as? Double ?? 0, t0 + 0.01, accuracy: 1e-9)
        XCTAssertEqual(row["firstPts"] as? Double ?? 0, t0 + 0.01 - 2112.0 / 48_000, accuracy: 1e-9)
        XCTAssertGreaterThan(row["segments"] as? Int ?? 0, 2)
        XCTAssertEqual(row["sha256"] as? String, SHA256.hash(data: try Data(contentsOf: URL(fileURLWithPath: path))).map { String(format: "%02x", $0) }.joined())
        XCTAssertEqual(row["silenceFilledSeconds"] as? Double, 0, "nothing was missing")
        let info = json(try probe(path, ["-show_streams", "-show_format", "-of", "json"]))
        let a = (info["streams"] as? [[String: Any]])?.first ?? [:]
        XCTAssertEqual(a["codec_name"] as? String, "aac")
        XCTAssertEqual(a["sample_rate"] as? String, "48000")
        XCTAssertEqual(a["channels"] as? Int, 1)
        let duration = Double((info["format"] as? [String: Any])?["duration"] as? String ?? "") ?? 0
        XCTAssertEqual(duration, row["durationSeconds"] as? Double ?? 0, accuracy: 1024.0 / 48_000)
        // Decoded as the Studio decodes it (FFmpeg), the sound is where firstPts says: sample m of the file is the
        // captured sample m - 2112.
        let decoded = try decode(path)
        XCTAssertEqual(decoded.count, Int((duration * 48_000).rounded()))
        var error = 0.0
        for m in 100_000..<104_000 { error += pow(Double(decoded[m]) - Self.chirp(m - 2112), 2) }
        XCTAssertLessThan(error / 4000, 1e-6, "the sound is 2112 samples into the file")
    }

    /// Feed one buffer until the writer takes it (a busy encoder answers false; the test waits, outside the writer).
    func feed(_ writer: AudioFileWriter, _ sample: CMSampleBuffer, at seconds: Double) async throws {
        var tries = 0
        while !writer.append(sample, hostSeconds: seconds) && tries < 2000 && writer.ended == nil { try await Task.sleep(nanoseconds: 500_000); tries += 1 }
    }

    /// A microphone writer started at host second `t0`, and the decoded file once finished.
    func microphone(_ name: String, t0: Double = 9000) -> (AudioFileWriter, String) {
        let path = dir.appendingPathComponent(name).path
        let gate = CaptureGate()
        gate.begin(t0)
        return (AudioFileWriter(role: "microphone", path: path, channels: 1, gate: gate), path)
    }

    /// Buffers the microphone never delivered (or the encoder was too busy for): the sound after the gap stays at its
    /// time, the gap is silence. One buffer missing (21 ms) too.
    func testMicrophoneKeepsTimeAcrossMissingBuffers() async throws {
        for (name, from, to) in [("gap", 48_000, 72_000), ("one", 48_128, 49_152)] {
            let (writer, path) = microphone("microphone-\(name).m4a")
            var first = 0, skipped = 0
            while first < 48_000 * 4 {
                if first >= from && first < to { skipped += 1 }
                if !(first >= from && first < to) { try await feed(writer, pcm(first: first, count: 1024, seconds: 9000 + Double(first) / 48_000), at: 9000 + Double(first) / 48_000) }
                first += 1024
            }
            let row = await writer.finish()
            XCTAssertNil(row["error"], "\(row)")
            let decoded = try decode(path)
            var error = 0.0
            for m in 100_000..<104_000 { error += pow(Double(decoded[m]) - Self.chirp(m - 2112), 2) }
            XCTAssertLessThan(error / 4000, 1e-6, "\(name): the sound after the gap kept its time")
            XCTAssertEqual(row["silenceFilledSeconds"] as? Double ?? 0, Double(skipped * 1024) / 48_000, accuracy: 0.0005, "\(name): exactly what was missing")
        }
    }

    /// Timestamps that wobble by up to 3 ms either way, over thousands of buffers: no silence put in.
    func testJitterFillsNothing() async throws {
        let (writer, _) = microphone("microphone-jitter.m4a")
        var generator = SystemRandomNumberGenerator()
        for i in 0..<3000 {
            let at = 9000 + Double(i * 1024) / 48_000 + Double.random(in: -0.003...0.003, using: &generator)
            try await feed(writer, pcm(first: i * 1024, count: 1024, seconds: at), at: at)
        }
        let row = await writer.finish()
        XCTAssertNil(row["error"], "\(row)")
        XCTAssertEqual(row["silenceFilledSeconds"] as? Double, 0)
    }

    /// A microphone clock 30 ppm slow against the host's, for ten minutes: drift, never silence.
    func testClockDriftFillsNothing() async throws {
        let (writer, path) = microphone("microphone-drift.m4a")
        let buffers = 48_000 * 600 / 1024
        for i in 0..<buffers {
            let at = 9000 + Double(i * 1024) / 48_000 * (1 + 30e-6)
            try await feed(writer, pcm(first: i * 1024, count: 1024, seconds: at), at: at)
        }
        let row = await writer.finish()
        XCTAssertNil(row["error"], "\(row)")
        XCTAssertEqual(row["silenceFilledSeconds"] as? Double, 0)
        XCTAssertEqual(row["buffers"] as? Int, buffers)
        try? FileManager.default.removeItem(atPath: path)
    }

    /// A clock that jumps an hour ahead, then time that goes back 50 ms: nothing filled, the sound goes on.
    func testClockJumpsAndBackwardsFillNothing() async throws {
        let (writer, path) = microphone("microphone-jump.m4a")
        var at = 9000.0
        for i in 0..<200 {
            if i == 100 { at += 3600 }
            if i == 150 { at -= 0.05 }
            try await feed(writer, pcm(first: i * 1024, count: 1024, seconds: at), at: at)
            at += 1024.0 / 48_000
        }
        let row = await writer.finish()
        XCTAssertNil(row["error"], "\(row)")
        XCTAssertEqual(row["silenceFilledSeconds"] as? Double, 0)
        XCTAssertEqual(row["durationSeconds"] as? Double ?? 0, 200 * 1024 / 48_000 + 2112.0 / 48_000, accuracy: 0.001, "the file holds the sound, not the hour")
        let decoded = try decode(path)
        var error = 0.0
        for m in 150_000..<152_000 { error += pow(Double(decoded[m]) - Self.chirp(m - 2112), 2) }
        XCTAssertLessThan(error / 2000, 1e-6, "the sound after the jump follows on")
    }

    /// The microphone switches to 24 kHz mid-take (earbuds): AVAssetWriter would encode it as 48 kHz, at twice the speed,
    /// with no error. The track ends there, cleanly, and says so; what came before plays as it was recorded.
    func testFormatChangeEndsTheTrackCleanly() async throws {
        let (writer, path) = microphone("microphone-rate.m4a")
        var first = 0
        while first < 48_000 * 2 {
            try await feed(writer, pcm(first: first, count: 1024, seconds: 9000 + Double(first) / 48_000), at: 9000 + Double(first) / 48_000)
            first += 1024
        }
        var asbd = AudioStreamBasicDescription(mSampleRate: 24_000, mFormatID: kAudioFormatLinearPCM, mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
                                               mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
        var format: CMAudioFormatDescription?
        CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format)
        var block: CMBlockBuffer?
        CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: 2048, blockAllocator: nil, customBlockSource: nil, offsetToData: 0, dataLength: 2048, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
        var sample: CMSampleBuffer?
        CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block!, formatDescription: format!, sampleCount: 512, presentationTimeStamp: CMTime(seconds: 9002, preferredTimescale: 24_000), packetDescriptions: nil, sampleBufferOut: &sample)
        XCTAssertFalse(writer.append(sample!, hostSeconds: 9000 + Double(first) / 48_000))
        XCTAssertFalse(writer.append(pcm(first: first, count: 1024, seconds: 9002.05), hostSeconds: 9002.05), "ended: nothing more goes in")
        let row = await writer.finish()
        XCTAssertNil(row["error"], "\(row)")
        XCTAssertEqual(row["endedEarly"] as? String, "The microphone changed its format mid-take (48000 Hz to 24000 Hz): its recording ends there.")
        let decoded = try decode(path)
        var error = 0.0
        for m in 50_000..<52_000 { error += pow(Double(decoded[m]) - Self.chirp(m - 2112), 2) }
        XCTAssertLessThan(error / 2000, 1e-6)
    }

    func decode(_ path: String) throws -> [Float] {
        guard let probeTool = Self.ffprobe else { throw XCTSkip("FFmpeg is not installed") }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: (probeTool as NSString).deletingLastPathComponent + "/ffmpeg")
        process.arguments = ["-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-"]
        let pipe = Pipe()
        process.standardOutput = pipe
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    }
}
