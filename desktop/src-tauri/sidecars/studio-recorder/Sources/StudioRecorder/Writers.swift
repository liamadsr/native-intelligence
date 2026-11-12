import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

/// Every writer flushes a movie fragment this often, so a take interrupted by
/// a crash or a power cut is still playable up to the last fragment.
let fragmentInterval = CMTime(seconds: 2, preferredTimescale: 600)

/// The take's start (the screen's first frame, host seconds) and its end,
/// shared with the capture queues of every other source. Before `begin`, they
/// hold their newest picture and drop audio; after `halt` they drop everything.
final class CaptureGate: @unchecked Sendable {
    private let lock = NSLock()
    private var origin: Double?
    private var halted = false
    func begin(_ t0: Double) { lock.lock(); origin = t0; lock.unlock() }
    func halt() { lock.lock(); halted = true; lock.unlock() }
    var state: (t0: Double?, halted: Bool) { lock.lock(); defer { lock.unlock() }; return (origin, halted) }
}

/// A copy of `sample` shifted by `delta` seconds (every timing entry).
func shifted(_ sample: CMSampleBuffer, by delta: Double) -> CMSampleBuffer? {
    if abs(delta) < 1e-6 { return sample }
    var count: CMItemCount = 0
    guard CMSampleBufferGetSampleTimingInfoArray(sample, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count) == noErr, count > 0 else { return nil }
    var timing = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: count)
    guard CMSampleBufferGetSampleTimingInfoArray(sample, entryCount: count, arrayToFill: &timing, entriesNeededOut: &count) == noErr else { return nil }
    let d = CMTime(seconds: delta, preferredTimescale: 1_000_000_000)
    for i in timing.indices {
        if timing[i].presentationTimeStamp.isValid { timing[i].presentationTimeStamp = CMTimeAdd(timing[i].presentationTimeStamp, d) }
        if timing[i].decodeTimeStamp.isValid { timing[i].decodeTimeStamp = CMTimeAdd(timing[i].decodeTimeStamp, d) }
    }
    var copy: CMSampleBuffer?
    return CMSampleBufferCreateCopyWithNewTiming(allocator: nil, sampleBuffer: sample, sampleTimingEntryCount: count,
                                                 sampleTimingArray: &timing, sampleBufferOut: &copy) == noErr ? copy : nil
}

/// A copy of a one-picture `sample` stamped at `seconds`.
func retimed(_ sample: CMSampleBuffer, to seconds: Double) -> CMSampleBuffer? {
    var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: CMTime(seconds: seconds, preferredTimescale: 1_000_000_000), decodeTimeStamp: .invalid)
    var copy: CMSampleBuffer?
    return CMSampleBufferCreateCopyWithNewTiming(allocator: nil, sampleBuffer: sample, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleBufferOut: &copy) == noErr ? copy : nil
}

/// Encoder settings for a picture of `width`×`height` at `fps`. H.264 tops out
/// at 4096 px a side; larger screens (5K, 6K) are written as HEVC.
func videoSettings(width: Int, height: Int, fps: Int, screen: Bool) -> (settings: [String: Any], codec: String) {
    let hevc = max(width, height) > 4096
    // Screen content is mostly still text: an average budget of ~0.12 bits per
    // pixel per frame keeps text crisp through the edit; capped so an hour of
    // a large display stays uploadable. HEVC needs about two thirds of it.
    let pixelsPerSecond = Double(width * height * fps)
    var bitrate = min(screen ? 60_000_000 : 16_000_000, max(screen ? 8_000_000 : 4_000_000, pixelsPerSecond * (screen ? 0.12 : 0.08)))
    if hevc { bitrate *= 0.66 }
    var compression: [String: Any] = [
        AVVideoAverageBitRateKey: Int(bitrate),
        AVVideoExpectedSourceFrameRateKey: fps,
        // A key frame every 2 s: each 2 s movie fragment starts decodable.
        AVVideoMaxKeyFrameIntervalKey: fps * 2,
    ]
    compression[AVVideoProfileLevelKey] = hevc ? "HEVC_Main_AutoLevel" : AVVideoProfileLevelH264HighAutoLevel
    return ([
        AVVideoCodecKey: hevc ? AVVideoCodecType.hevc : AVVideoCodecType.h264,
        AVVideoWidthKey: width,
        AVVideoHeightKey: height,
        AVVideoCompressionPropertiesKey: compression,
    ], hevc ? "hevc" : "h264")
}

/// One picture source besides the screen: a camera or another app window,
/// written to its own fragmented movie on the screen's clock.
final class TrackWriter: @unchecked Sendable {
    let role: String, kind: String, sourceID: String, name: String, path: String
    private let gate: CaptureGate
    private let lock = NSLock()
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var held: CMSampleBuffer?
    private(set) var samples = 0
    private(set) var firstPTS: Double?
    private(set) var lastPTS: Double?
    private(set) var width = 0, height = 0
    private(set) var codec = "h264"
    var failure: String?
    init(role: String, kind: String, sourceID: String, name: String, path: String, gate: CaptureGate) {
        self.role = role; self.kind = kind; self.sourceID = sourceID; self.name = name; self.path = path; self.gate = gate
    }
    /// `seconds`: the sample's time on the host clock (it may be stamped on
    /// another clock; it is written shifted onto the host clock).
    func append(_ sample: CMSampleBuffer, hostSeconds seconds: Double) {
        let (t0, halted) = gate.state
        guard !halted, CMSampleBufferGetImageBuffer(sample) != nil, seconds.isFinite else { return }
        let stamp = CMSampleBufferGetPresentationTimeStamp(sample).seconds
        guard let onHost = shifted(sample, by: seconds - stamp) else { return }
        lock.lock(); defer { lock.unlock() }
        // Before the take starts keep the newest picture: a window that is not
        // changing still has a picture at t0.
        guard let t0, seconds >= t0 else { held = onHost; return }
        if writer == nil {
            if let held, seconds > t0, let first = retimed(held, to: t0) { open(with: first, at: t0); write(first, at: t0) }
            else { open(with: onHost, at: seconds) }
            held = nil
        }
        write(onHost, at: seconds)
    }
    private func open(with sample: CMSampleBuffer, at seconds: Double) {
        guard let image = CMSampleBufferGetImageBuffer(sample) else { return }
        let w = CVPixelBufferGetWidth(image), h = CVPixelBufferGetHeight(image)
        let fit = min(1.0, 4096.0 / Double(max(w, h)))
        width = max(2, Int(Double(w) * fit) & ~1); height = max(2, Int(Double(h) * fit) & ~1)
        do {
            let newWriter = try AVAssetWriter(outputURL: URL(fileURLWithPath: path), fileType: .mov)
            newWriter.movieFragmentInterval = fragmentInterval
            var (settings, codecName) = videoSettings(width: width, height: height, fps: 30, screen: kind == "window")
            settings[AVVideoScalingModeKey] = AVVideoScalingModeResizeAspect
            codec = codecName
            let newInput = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
            newInput.expectsMediaDataInRealTime = true
            guard newWriter.canAdd(newInput) else { failure = "Could not create the \(kind) track"; return }
            newWriter.add(newInput)
            guard newWriter.startWriting() else { failure = newWriter.error?.localizedDescription ?? "Could not start the \(kind) track"; return }
            newWriter.startSession(atSourceTime: CMTime(seconds: seconds, preferredTimescale: 1_000_000_000))
            writer = newWriter; input = newInput; firstPTS = seconds
        } catch { failure = error.localizedDescription }
    }
    private func write(_ sample: CMSampleBuffer, at seconds: Double) {
        if let input, input.isReadyForMoreMediaData, input.append(sample) { samples += 1; lastPTS = seconds }
    }
    /// Windows only send frames when they change: hold the last picture until
    /// Stop so the track covers the whole take.
    func finish(holdUntil end: Double?) async -> [String: Any] {
        let (activeWriter, activeInput) = { lock.lock(); defer { lock.unlock() }; return (writer, input) }()
        if let activeWriter, let activeInput {
            activeInput.markAsFinished()
            if let end, let last = lastPTS, end > last {
                activeWriter.endSession(atSourceTime: CMTime(seconds: end, preferredTimescale: 1_000_000_000)); lastPTS = end
            }
            await activeWriter.finishWriting()
        }
        let finalized = writer?.status == .completed && samples > 0
        var row: [String: Any] = ["role": role, "kind": kind, "sourceId": sourceID, "name": name, "path": path,
                                  "finalized": finalized, "frames": samples, "width": width, "height": height, "codec": codec,
                                  "firstPts": jsonNumber(firstPTS), "lastPts": jsonNumber(lastPTS)]
        if let first = firstPTS, let last = lastPTS, last > first {
            row["durationSeconds"] = last - first
            row["fps"] = Double(max(0, samples - 1)) / (last - first)
        }
        if let error = failure ?? (finalized ? nil : "No picture was captured from \(name)") { row["error"] = error }
        return row
    }
}

/// An AAC audio file written from PCM (or already-encoded-ready) sample
/// buffers on the screen's clock, in fragments.
final class AudioFileWriter: @unchecked Sendable {
    let role: String, path: String, channels: Int
    private let gate: CaptureGate
    private let lock = NSLock()
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private(set) var buffers = 0
    private(set) var drops = 0
    private(set) var firstPTS: Double?
    private(set) var lastPTS: Double?
    var failure: String?
    init(role: String, path: String, channels: Int, gate: CaptureGate) {
        self.role = role; self.path = path; self.channels = channels; self.gate = gate
    }
    /// Append `sample` (stamped `seconds` on the host clock). Returns whether
    /// it was written: false before the take starts, after it ends, or when
    /// the encoder is behind.
    @discardableResult
    func append(_ sample: CMSampleBuffer, hostSeconds seconds: Double) -> Bool {
        let (t0, halted) = gate.state
        guard !halted, let t0, seconds.isFinite, seconds >= t0, CMSampleBufferGetNumSamples(sample) > 0 else { return false }
        guard CMSampleBufferDataIsReady(sample) else { drops += 1; return false }
        let stamp = CMSampleBufferGetPresentationTimeStamp(sample).seconds
        guard let onHost = shifted(sample, by: seconds - stamp) else { drops += 1; return false }
        lock.lock(); defer { lock.unlock() }
        if writer == nil { open(at: seconds) }
        guard let input, input.isReadyForMoreMediaData, input.append(onHost) else { drops += 1; return false }
        buffers += 1
        let duration = CMSampleBufferGetDuration(onHost)
        lastPTS = seconds + (duration.isValid ? duration.seconds : 0)
        return true
    }
    private func open(at seconds: Double) {
        do {
            let newWriter = try AVAssetWriter(outputURL: URL(fileURLWithPath: path), fileType: .m4a)
            newWriter.movieFragmentInterval = fragmentInterval
            let newInput = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: channels,
                AVEncoderBitRateKey: channels == 1 ? 128_000 : 192_000,
            ])
            newInput.expectsMediaDataInRealTime = true
            guard newWriter.canAdd(newInput) else { failure = "Could not create the \(role) track"; return }
            newWriter.add(newInput)
            guard newWriter.startWriting() else { failure = newWriter.error?.localizedDescription ?? "Could not start the \(role) track"; return }
            newWriter.startSession(atSourceTime: CMTime(seconds: seconds, preferredTimescale: 1_000_000_000))
            writer = newWriter; input = newInput; firstPTS = seconds
        } catch { failure = error.localizedDescription }
    }
    func finish() async -> [String: Any] {
        let (activeWriter, activeInput) = { lock.lock(); defer { lock.unlock() }; return (writer, input) }()
        if let activeWriter, let activeInput {
            activeInput.markAsFinished()
            await activeWriter.finishWriting()
        }
        let finalized = writer?.status == .completed && buffers > 0
        var row: [String: Any] = ["role": role, "path": path, "finalized": finalized, "codec": "aac", "sampleRate": 48_000,
                                  "channels": channels, "buffers": buffers, "droppedBuffers": drops,
                                  "firstPts": jsonNumber(firstPTS), "lastPts": jsonNumber(lastPTS)]
        if let first = firstPTS, let last = lastPTS, last > first { row["durationSeconds"] = last - first }
        if let error = failure ?? (finalized ? nil : "No \(role) audio was captured") { row["error"] = error }
        return row
    }
}

/// Root-mean-square of the float samples in an audio sample buffer (all
/// channels), and optionally the first channel's samples.
func audioRMS(_ sample: CMSampleBuffer, collectFirstChannel: Bool = false) -> (rms: Float, mono: [Float]) {
    var blockBuffer: CMBlockBuffer?
    var sizeNeeded = 0
    guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, bufferListSizeNeededOut: &sizeNeeded, bufferListOut: nil, bufferListSize: 0,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil) == noErr, sizeNeeded > 0 else { return (0, []) }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: sizeNeeded, alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
    guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, bufferListSizeNeededOut: nil, bufferListOut: list, bufferListSize: sizeNeeded,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer) == noErr else { return (0, []) }
    guard let format = CMSampleBufferGetFormatDescription(sample),
          let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
          asbd.mFormatID == kAudioFormatLinearPCM, asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0, asbd.mBitsPerChannel == 32 else { return (0, []) }
    let buffers = UnsafeMutableAudioBufferListPointer(list)
    var sum: Float = 0, count = 0
    var mono: [Float] = []
    let interleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
    let channels = max(1, Int(asbd.mChannelsPerFrame))
    for (index, buffer) in buffers.enumerated() {
        guard let data = buffer.mData else { continue }
        let n = Int(buffer.mDataByteSize) / 4
        let floats = data.bindMemory(to: Float.self, capacity: n)
        for i in 0..<n { let v = floats[i]; sum += v * v }
        count += n
        if collectFirstChannel && index == 0 {
            if interleaved && channels > 1 {
                mono.reserveCapacity(n / channels)
                var i = 0
                while i < n { mono.append(floats[i]); i += channels }
            } else {
                mono.append(contentsOf: UnsafeBufferPointer(start: floats, count: n))
            }
        }
    }
    return (count > 0 ? (sum / Float(count)).squareRoot() : 0, mono)
}

/// 48 kHz → 16 kHz for the on-device transcription: a 2nd-order low-pass at
/// 7 kHz, then every third sample.
final class Decimator {
    private var x1: Float = 0, x2: Float = 0, y1: Float = 0, y2: Float = 0
    private var phase = 0
    private let b0: Float, b1: Float, b2: Float, a1: Float, a2: Float
    init() {
        let fs = 48_000.0, f0 = 7_000.0, q = 0.7071
        let w0 = 2 * Double.pi * f0 / fs, alpha = sin(w0) / (2 * q), c = cos(w0), a0 = 1 + alpha
        b0 = Float((1 - c) / 2 / a0); b1 = Float((1 - c) / a0); b2 = b0
        a1 = Float(-2 * c / a0); a2 = Float((1 - alpha) / a0)
    }
    func process(_ input: [Float]) -> [Float] {
        var out: [Float] = []
        out.reserveCapacity(input.count / 3 + 1)
        for x in input {
            let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            x2 = x1; x1 = x; y2 = y1; y1 = y
            if phase == 0 { out.append(y) }
            phase = (phase + 1) % 3
        }
        return out
    }
}
