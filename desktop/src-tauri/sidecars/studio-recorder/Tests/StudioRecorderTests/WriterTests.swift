import AVFoundation
import CoreMedia
import CoreVideo
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
